import { MAX_CHAT_MESSAGE_LENGTH, type ChatTokenUsage } from "@/lib/chat-api"
import {
  appendAssistantContent,
  cancelAssistantMessage,
  createMessageAttempt,
  finishAssistantMessage,
  isAssistantMessageStreaming,
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
  disconnected?: AbortSignal
}>

export type StartGenerationResult =
  | Readonly<{
      type: "started"
      events: AsyncIterable<AssistantMessageGenerationEvent>
    }>
  | Readonly<{
      type:
        | "invalid-input"
        | "request-in-progress"
        | "input-too-long"
        | "context-unavailable"
        | "conversation-not-found"
        | "unsupported-mode"
        | "message-creation-failed"
        | "idempotency-replay"
      error: AssistantMessageGenerationError
    }>

export type CancelGenerationResult =
  | Readonly<{ type: "accepted" }>
  | Readonly<{ type: "not-found" }>
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

export class AssistantMessageGenerationModule {
  private readonly activeGenerations = new Map<string, AbortController>()

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
    if (
      request.requestId !== undefined &&
      this.activeGenerations.has(request.requestId)
    ) {
      return {
        type: "request-in-progress",
        error: {
          code: "INVALID_INPUT",
          message: "该请求正在生成中。",
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
      attempt = await createMessageAttempt(
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
    if (attempt.duplicate || attempt.assistantMessageId === null) {
      return {
        type: "idempotency-replay",
        error: {
          code: "IDEMPOTENCY_REPLAY",
          message: "这条消息已经提交过。",
          retryable: false,
        },
      }
    }

    const cancellation = new AbortController()
    const ids = [attempt.assistantMessageId, request.requestId].filter(
      (id): id is string => id !== undefined,
    )
    for (const id of ids) this.activeGenerations.set(id, cancellation)

    return {
      type: "started",
      events: this.generate({
        messages: [...context.messages, { role: "user", content: message }],
        cancellation,
        disconnected: request.disconnected ?? new AbortController().signal,
        userMessageId: attempt.userMessageId,
        assistantMessageId: attempt.assistantMessageId,
        activeIds: ids,
      }),
    }
  }

  async cancel(
    target: Readonly<{ kind: "assistant" | "request"; id: string }>,
  ): Promise<CancelGenerationResult> {
    const cancellation = this.activeGenerations.get(target.id)
    let persistedCancellation = false
    if (target.kind === "assistant") {
      try {
        persistedCancellation = await cancelAssistantMessage(target.id)
      } catch {
        return { type: "unavailable" }
      }
    }
    if (!persistedCancellation && cancellation === undefined) {
      return { type: "not-found" }
    }
    cancellation?.abort()
    return { type: "accepted" }
  }

  private async *generate({
    messages,
    cancellation,
    disconnected,
    userMessageId,
    assistantMessageId,
    activeIds,
  }: Readonly<{
    messages: readonly ChatMessage[]
    cancellation: AbortController
    disconnected: AbortSignal
    userMessageId: string
    assistantMessageId: string
    activeIds: readonly string[]
  }>): AsyncGenerator<AssistantMessageGenerationEvent> {
    const startedAt = performance.now()
    const totalTimeout = new AbortController()
    const totalTimer = setTimeout(
      () => totalTimeout.abort(),
      this.config.totalTimeoutMs,
    )
    let persistedContent = ""

    try {
      yield { type: "message.created", userMessageId, assistantMessageId }
      yield* this.pipeProviderStream({
        messages,
        cancellation: cancellation.signal,
        disconnected,
        totalTimeout: totalTimeout.signal,
        assistantMessageId,
        startedAt,
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
      if (failurePersisted !== false) {
        yield { type: "message.failed", error: failure }
      } else {
        yield { type: "message.cancelled" }
      }
    } finally {
      clearTimeout(totalTimer)
      for (const id of activeIds) this.activeGenerations.delete(id)
    }
  }

  private async *pipeProviderStream({
    messages,
    cancellation,
    disconnected,
    totalTimeout,
    assistantMessageId,
    startedAt,
    onContent,
    onTerminal,
  }: Readonly<{
    messages: readonly ChatMessage[]
    cancellation: AbortSignal
    disconnected: AbortSignal
    totalTimeout: AbortSignal
    assistantMessageId: string
    startedAt: number
    onContent: (content: string) => Promise<boolean>
    onTerminal: (
      status: "completed" | "cancelled",
      errorCode: string | null,
    ) => Promise<boolean>
  }>): AsyncGenerator<AssistantMessageGenerationEvent> {
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
        disconnected,
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
            yield { type: "message.cancelled" }
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
              yield { type: "message.cancelled" }
              return
            }
            yield { type: "content.delta", delta: result.value.delta }
          } else if (result.value.type === "usage.snapshot") {
            usage = result.value.usage
          }
        }

        if (!receivedContent || usage === null) {
          throw new ChatProviderError("invalid_response")
        }
        yield { type: "usage.snapshot", usage }
        if (!(await onTerminal("completed", null))) {
          yield { type: "message.cancelled" }
          return
        }
        yield {
          type: "message.completed",
          latencyMs: Math.round(performance.now() - startedAt),
        }
        return
      } catch (error) {
        if (cancellation.aborted || disconnected.aborted) {
          await onTerminal("cancelled", null)
          yield { type: "message.cancelled" }
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

async function nextWithTimeout<T>(
  iterator: AsyncIterator<T>,
  timeoutMs: number,
  timeoutController: AbortController,
  assistantMessageId: string,
): Promise<IteratorResult<T> | typeof assistantCancelled> {
  const deadline = performance.now() + timeoutMs
  const next = iterator.next()

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
    const result = await Promise.race([next, poll])
    clearTimeout(timer)
    if (result !== null) return result

    if (!(await isAssistantMessageStreaming(assistantMessageId))) {
      timeoutController.abort()
      return assistantCancelled
    }
  }
}

const assistantCancelled = Symbol("assistant-cancelled")

function normalizeProviderError(error: unknown): ChatProviderError {
  return error instanceof ChatProviderError
    ? error
    : new ChatProviderError("unavailable")
}
