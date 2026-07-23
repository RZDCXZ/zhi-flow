import {
  MAX_CHAT_MESSAGE_LENGTH,
  type ChatTokenUsage,
  type ExistingMessageSubmission,
} from "@/lib/chat-api"
import {
  appendAssistantContent,
  cancelAssistantMessage,
  createMessageSubmission,
  failStaleStreamingAssistantMessages,
  finishAssistantMessage,
  readAssistantMessageStatus,
  readChatContext,
} from "@/server/conversations"

import {
  ChatProviderError,
  type ChatMessage,
  type ChatProvider,
  type ChatProviderErrorKind,
} from "./chat-provider"

export type AssistantMessageGenerationError = Readonly<{
  code:
    | "INVALID_INPUT"
    | "INPUT_TOO_LONG"
    | "IDEMPOTENCY_REPLAY"
    | "IDEMPOTENCY_KEY_REUSED"
    | "GENERATION_IN_PROGRESS"
    | "UNSUPPORTED_CONVERSATION_MODE"
    | "PROVIDER_AUTHENTICATION_FAILED"
    | "RATE_LIMITED"
    | "PROVIDER_UNAVAILABLE"
    | "PROVIDER_TIMEOUT"
    | "STREAM_INTERRUPTED"
    | "INTERNAL_ERROR"
  message: string
  retryable: boolean
}>

export type AssistantMessageGenerationEvent =
  | Readonly<{
      type: "message.created"
      userMessageId: string
      assistantMessageId: string
    }>
  | Readonly<{ type: "content.delta"; delta: string }>
  | Readonly<{ type: "usage.snapshot"; usage: ChatTokenUsage }>
  | Readonly<{ type: "message.completed"; latencyMs: number }>
  | Readonly<{ type: "message.cancelled" }>
  | Readonly<{ type: "message.failed"; error: AssistantMessageGenerationError }>

type GenerationConfig = Readonly<{
  firstByteTimeoutMs: number
  idleTimeoutMs: number
  totalTimeoutMs: number
  maxStreamAttempts: number
}>

type StartRequest = Readonly<{
  conversationId: string
  clientIdempotencyKey: string
  message: string
  requestId?: string
}>

export type StartGenerationResult =
  | Readonly<{
      type: "started"
      events: AsyncIterable<AssistantMessageGenerationEvent>
    }>
  | Readonly<{
      type:
        | "invalid-input"
        | "input-too-long"
        | "context-unavailable"
        | "conversation-not-found"
        | "unsupported-mode"
        | "message-creation-failed"
      error: AssistantMessageGenerationError
    }>
  | Readonly<{
      type: "idempotency-replay"
      submission: ExistingMessageSubmission
      error: AssistantMessageGenerationError
    }>
  | Readonly<{
      type: "idempotency-key-reused"
      userMessageId: string
      error: AssistantMessageGenerationError
    }>
  | Readonly<{
      type: "generation-in-progress"
      assistantMessageId: string
      error: AssistantMessageGenerationError
    }>

export type CancelGenerationResult =
  | Readonly<{ type: "accepted"; status: "cancelled" }>
  | Readonly<{ type: "terminal-conflict"; status: "completed" | "failed" }>
  | Readonly<{ type: "not-found" }>
  | Readonly<{ type: "unavailable" }>

export type RecoverStaleGenerationsResult =
  | Readonly<{
      type: "ok"
      recoveredAssistantMessageIds: readonly string[]
    }>
  | Readonly<{ type: "unavailable" }>

const providerUnavailableError = {
  code: "PROVIDER_UNAVAILABLE",
  message: "聊天服务暂时不可用，请稍后重试。",
  retryable: true,
} satisfies AssistantMessageGenerationError

const providerErrors = {
  authentication: {
    code: "PROVIDER_AUTHENTICATION_FAILED",
    message: "聊天服务配置异常，请稍后再试。",
    retryable: false,
  },
  rate_limit: {
    code: "RATE_LIMITED",
    message: "请求过于频繁，请稍后重试。",
    retryable: true,
  },
  unavailable: providerUnavailableError,
  invalid_response: providerUnavailableError,
  timeout: {
    code: "PROVIDER_TIMEOUT",
    message: "聊天服务响应超时，请重试。",
    retryable: true,
  },
  interrupted: {
    code: "STREAM_INTERRUPTED",
    message: "回答传输中断，请重试。",
    retryable: true,
  },
} satisfies Record<ChatProviderErrorKind, AssistantMessageGenerationError>

const internalError = {
  code: "INTERNAL_ERROR",
  message: "聊天服务暂时不可用，请稍后再试。",
  retryable: true,
} satisfies AssistantMessageGenerationError

type ActiveGeneration = Readonly<{
  cancellation: AbortController
  hub: EventHub
}>

export class AssistantMessageGenerationModule {
  private readonly activeGenerations = new Map<string, ActiveGeneration>()

  constructor(
    private readonly provider: ChatProvider,
    private readonly config: GenerationConfig,
  ) {}

  async start(request: StartRequest): Promise<StartGenerationResult> {
    const message = request.message.trim()
    if (!message) {
      return {
        type: "invalid-input",
        error: {
          code: "INVALID_INPUT",
          message: "请输入消息。",
          retryable: false,
        },
      }
    }
    if ([...message].length > MAX_CHAT_MESSAGE_LENGTH) {
      return {
        type: "input-too-long",
        error: {
          code: "INPUT_TOO_LONG",
          message: `消息不能超过 ${MAX_CHAT_MESSAGE_LENGTH} 个字符。`,
          retryable: false,
        },
      }
    }
    let context
    try {
      context = await readChatContext(request.conversationId)
    } catch {
      return {
        type: "context-unavailable",
        error: {
          code: "INTERNAL_ERROR",
          message: "暂时无法读取会话上下文。",
          retryable: true,
        },
      }
    }
    if (context === null) {
      return {
        type: "conversation-not-found",
        error: {
          code: "INVALID_INPUT",
          message: "通用会话不存在或不可用。",
          retryable: false,
        },
      }
    }
    if (context.mode !== "general") {
      return {
        type: "unsupported-mode",
        error: {
          code: "UNSUPPORTED_CONVERSATION_MODE",
          message: "该 Conversation 模式暂不支持生成。",
          retryable: false,
        },
      }
    }

    let attempt
    try {
      attempt = await createMessageSubmission(
        request.conversationId,
        message,
        request.clientIdempotencyKey,
      )
    } catch {
      return {
        type: "message-creation-failed",
        error: {
          code: "INVALID_INPUT",
          message: "会话不存在或暂时不可用。",
          retryable: false,
        },
      }
    }
    if (attempt.outcome === "idempotency-replay") {
      return {
        type: "idempotency-replay",
        submission: {
          userMessageId: attempt.userMessageId,
          assistantMessageId: attempt.assistantMessageId,
          assistantMessageStatus: attempt.assistantMessageStatus,
        },
        error: {
          code: "IDEMPOTENCY_REPLAY",
          message: "这条消息已经提交过。",
          retryable: false,
        },
      }
    }
    if (attempt.outcome === "idempotency-key-reused") {
      return {
        type: "idempotency-key-reused",
        userMessageId: attempt.userMessageId,
        error: {
          code: "IDEMPOTENCY_KEY_REUSED",
          message: "该幂等键已用于另一条消息。",
          retryable: false,
        },
      }
    }
    if (attempt.outcome === "generation-in-progress") {
      return {
        type: "generation-in-progress",
        assistantMessageId: attempt.assistantMessageId,
        error: {
          code: "GENERATION_IN_PROGRESS",
          message: "该 Conversation 已有正在生成的 Assistant Message。",
          retryable: false,
        },
      }
    }

    const cancellation = new AbortController()
    const hub = new EventHub()
    this.activeGenerations.set(attempt.assistantMessageId, {
      cancellation,
      hub,
    })

    void this.runGeneration({
      messages: [...context.messages, { role: "user", content: message }],
      cancellation,
      userMessageId: attempt.userMessageId,
      assistantMessageId: attempt.assistantMessageId,
      hub,
    })

    return {
      type: "started",
      events: hub.asIterable(),
    }
  }

  async cancel(assistantMessageId: string): Promise<CancelGenerationResult> {
    try {
      const result = await cancelAssistantMessage(assistantMessageId)
      this.activeGenerations.get(assistantMessageId)?.cancellation.abort()
      if (
        result.outcome === "cancelled" ||
        result.outcome === "already-cancelled"
      ) {
        return { type: "accepted", status: "cancelled" }
      }
      if (result.outcome === "terminal-conflict") {
        return { type: "terminal-conflict", status: result.status }
      }
      return { type: "not-found" }
    } catch {
      return { type: "unavailable" }
    }
  }

  async recoverStaleGenerations(
    conversationId: string,
  ): Promise<RecoverStaleGenerationsResult> {
    try {
      const staleBefore = new Date(
        Date.now() - this.config.totalTimeoutMs,
      ).toISOString()
      const recoveredAssistantMessageIds =
        await failStaleStreamingAssistantMessages(conversationId, staleBefore)
      for (const assistantMessageId of recoveredAssistantMessageIds) {
        this.activeGenerations.get(assistantMessageId)?.cancellation.abort()
      }
      return { type: "ok", recoveredAssistantMessageIds }
    } catch {
      return { type: "unavailable" }
    }
  }

  private async runGeneration({
    messages,
    cancellation,
    userMessageId,
    assistantMessageId,
    hub,
  }: Readonly<{
    messages: readonly ChatMessage[]
    cancellation: AbortController
    userMessageId: string
    assistantMessageId: string
    hub: EventHub
  }>): Promise<void> {
    const startedAt = performance.now()
    const totalTimeout = new AbortController()
    const totalTimer = setTimeout(
      () => totalTimeout.abort(),
      this.config.totalTimeoutMs,
    )
    let persistedContent = ""
    const emit = (event: AssistantMessageGenerationEvent) => {
      hub.push(event)
    }

    try {
      emit({ type: "message.created", userMessageId, assistantMessageId })
      await this.pipeProviderStream({
        messages,
        cancellation: cancellation.signal,
        totalTimeout: totalTimeout.signal,
        assistantMessageId,
        startedAt,
        emit,
        onContent: async (content) => {
          persistedContent = content
          return appendAssistantContent(assistantMessageId, content)
        },
        onTerminal: async (status, errorCode) =>
          finishAssistantMessage(
            assistantMessageId,
            status,
            persistedContent,
            errorCode,
          ),
      })
    } catch (error) {
      if (await this.isCancelled(assistantMessageId)) {
        emit({ type: "message.cancelled" })
        return
      }
      const failure =
        error instanceof ChatProviderError
          ? providerErrors[error.kind]
          : internalError
      const failurePersisted = await finishAssistantMessage(
        assistantMessageId,
        "failed",
        persistedContent,
        failure.code,
      ).catch(() => null)
      if (failurePersisted === true) {
        emit({ type: "message.failed", error: failure })
      } else if (failurePersisted === false) {
        // Another writer already committed a terminal status.
        if (await this.isCancelled(assistantMessageId)) {
          emit({ type: "message.cancelled" })
        }
      }
    } finally {
      clearTimeout(totalTimer)
      hub.end()
      this.activeGenerations.delete(assistantMessageId)
    }
  }

  private async isCancelled(assistantMessageId: string): Promise<boolean> {
    return (
      (await readAssistantMessageStatus(assistantMessageId)) === "cancelled"
    )
  }

  private async pipeProviderStream({
    messages,
    cancellation,
    totalTimeout,
    assistantMessageId,
    startedAt,
    emit,
    onContent,
    onTerminal,
  }: Readonly<{
    messages: readonly ChatMessage[]
    cancellation: AbortSignal
    totalTimeout: AbortSignal
    assistantMessageId: string
    startedAt: number
    emit: (event: AssistantMessageGenerationEvent) => void
    onContent: (content: string) => Promise<boolean>
    onTerminal: (
      status: "completed" | "cancelled",
      errorCode: string | null,
    ) => Promise<boolean>
  }>): Promise<void> {
    let contentStarted = false
    let completeContent = ""

    for (
      let attempt = 1;
      attempt <= this.config.maxStreamAttempts;
      attempt += 1
    ) {
      const attemptTimeout = new AbortController()
      const signal = AbortSignal.any([
        cancellation,
        totalTimeout,
        attemptTimeout.signal,
      ])
      let usage: ChatTokenUsage | null = null
      let receivedContent = false
      let firstActivity = true
      const iterator = this.provider
        .stream({ messages, signal })
        [Symbol.asyncIterator]()

      try {
        while (true) {
          const result = await nextWithTimeout(
            iterator,
            firstActivity
              ? this.config.firstByteTimeoutMs
              : this.config.idleTimeoutMs,
            attemptTimeout,
            assistantMessageId,
          )
          if (result === assistantCancelled) {
            emit({ type: "message.cancelled" })
            return
          }
          if (result === assistantTerminalTaken) {
            return
          }
          if (result.done) break
          firstActivity = false

          if (result.value.type === "content.delta") {
            if (!result.value.delta) continue
            receivedContent = true
            contentStarted = true
            completeContent += result.value.delta
            if (!(await onContent(completeContent))) {
              if (await this.isCancelled(assistantMessageId)) {
                emit({ type: "message.cancelled" })
              }
              return
            }
            emit({ type: "content.delta", delta: result.value.delta })
          } else if (result.value.type === "usage.snapshot") {
            usage = result.value.usage
          }
        }

        if (!receivedContent || usage === null) {
          throw new ChatProviderError("invalid_response")
        }
        emit({ type: "usage.snapshot", usage })
        if (!(await onTerminal("completed", null))) {
          if (await this.isCancelled(assistantMessageId)) {
            emit({ type: "message.cancelled" })
          }
          return
        }
        emit({
          type: "message.completed",
          latencyMs: Math.round(performance.now() - startedAt),
        })
        return
      } catch (error) {
        // Explicit cancel writes cancelled first then aborts; recovery writes
        // failed first then aborts. Only the DB cancelled status produces events.
        if (cancellation.aborted) {
          if (await this.isCancelled(assistantMessageId)) {
            emit({ type: "message.cancelled" })
          }
          return
        }
        if (await this.isCancelled(assistantMessageId)) {
          emit({ type: "message.cancelled" })
          return
        }
        if (totalTimeout.aborted) throw new ChatProviderError("timeout")

        const providerError = normalizeProviderError(error)
        if (
          !contentStarted &&
          providerError.kind !== "authentication" &&
          providerError.kind !== "invalid_response" &&
          attempt < this.config.maxStreamAttempts
        ) {
          continue
        }
        throw providerError
      } finally {
        await iterator.return?.()
      }
    }
  }
}

class EventHub {
  private readonly queue: AssistantMessageGenerationEvent[] = []
  private readonly waiters: Array<
    (result: IteratorResult<AssistantMessageGenerationEvent>) => void
  > = []
  private closed = false
  private ended = false

  push(event: AssistantMessageGenerationEvent): void {
    if (this.closed || this.ended) return
    const waiter = this.waiters.shift()
    if (waiter) {
      waiter({ done: false, value: event })
      return
    }
    this.queue.push(event)
  }

  end(): void {
    if (this.ended) return
    this.ended = true
    while (this.waiters.length > 0) {
      this.waiters.shift()?.({ done: true, value: undefined })
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.queue.length = 0
    while (this.waiters.length > 0) {
      this.waiters.shift()?.({ done: true, value: undefined })
    }
  }

  asIterable(): AsyncIterable<AssistantMessageGenerationEvent> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: () => this.next(),
        return: async () => {
          this.close()
          return { done: true as const, value: undefined }
        },
      }),
    }
  }

  private next(): Promise<IteratorResult<AssistantMessageGenerationEvent>> {
    if (this.closed) {
      return Promise.resolve({ done: true, value: undefined })
    }
    if (this.queue.length > 0) {
      return Promise.resolve({
        done: false,
        value: this.queue.shift()!,
      })
    }
    if (this.ended) {
      return Promise.resolve({ done: true, value: undefined })
    }
    return new Promise((resolve) => {
      this.waiters.push(resolve)
    })
  }
}

async function nextWithTimeout<T>(
  iterator: AsyncIterator<T>,
  timeoutMs: number,
  timeoutController: AbortController,
  assistantMessageId: string,
): Promise<
  IteratorResult<T> | typeof assistantCancelled | typeof assistantTerminalTaken
> {
  const deadline = performance.now() + timeoutMs
  const next = iterator.next().then(
    (result) => ({ ok: true as const, result }),
    (error: unknown) => ({ ok: false as const, error }),
  )

  while (true) {
    const remainingMs = deadline - performance.now()
    if (remainingMs <= 0) {
      timeoutController.abort()
      throw new ChatProviderError("timeout")
    }

    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = new Promise<null>((resolve) => {
      timer = setTimeout(resolve, Math.min(500, remainingMs), null)
    })
    const raced = await Promise.race([next, poll])
    clearTimeout(timer)

    if (raced !== null) {
      if (!raced.ok) {
        const status = await readAssistantMessageStatus(assistantMessageId)
        if (status === "cancelled") {
          timeoutController.abort()
          return assistantCancelled
        }
        if (status === "completed" || status === "failed") {
          timeoutController.abort()
          return assistantTerminalTaken
        }
        throw raced.error
      }
      return raced.result
    }

    const status = await readAssistantMessageStatus(assistantMessageId)
    if (status === "streaming") continue
    timeoutController.abort()
    if (status === "cancelled") return assistantCancelled
    return assistantTerminalTaken
  }
}

const assistantCancelled = Symbol("assistant-cancelled")
const assistantTerminalTaken = Symbol("assistant-terminal-taken")

function normalizeProviderError(error: unknown): ChatProviderError {
  return error instanceof ChatProviderError
    ? error
    : new ChatProviderError("unavailable")
}
