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
  contentFlushIntervalMs?: number
  contentFlushMaxChars?: number
  retryBackoffBaseMs?: number
  retryBackoffMaxMs?: number
}>

export type GenerationClock = Readonly<{
  now: () => number
  setTimeout: (callback: () => void, ms: number) => () => void
}>

const DEFAULT_CONTENT_FLUSH_INTERVAL_MS = 500
const DEFAULT_CONTENT_FLUSH_MAX_CHARS = 1_024
const DEFAULT_RETRY_BACKOFF_BASE_MS = 250
const DEFAULT_RETRY_BACKOFF_MAX_MS = 2_000
const CANCEL_POLL_INTERVAL_MS = 500

const systemClock: GenerationClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => {
    const handle = setTimeout(callback, ms)
    return () => clearTimeout(handle)
  },
}

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
  private readonly contentFlushIntervalMs: number
  private readonly contentFlushMaxChars: number
  private readonly retryBackoffBaseMs: number
  private readonly retryBackoffMaxMs: number
  private readonly clock: GenerationClock

  constructor(
    private readonly provider: ChatProvider,
    private readonly config: GenerationConfig,
    clock: GenerationClock = systemClock,
  ) {
    this.clock = clock
    this.contentFlushIntervalMs =
      config.contentFlushIntervalMs ?? DEFAULT_CONTENT_FLUSH_INTERVAL_MS
    this.contentFlushMaxChars =
      config.contentFlushMaxChars ?? DEFAULT_CONTENT_FLUSH_MAX_CHARS
    this.retryBackoffBaseMs =
      config.retryBackoffBaseMs ?? DEFAULT_RETRY_BACKOFF_BASE_MS
    this.retryBackoffMaxMs =
      config.retryBackoffMaxMs ?? DEFAULT_RETRY_BACKOFF_MAX_MS
  }

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
      // Wall-clock absolute time: GenerationClock may be relative in tests.
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
    const startedAt = this.clock.now()
    const totalTimeout = new AbortController()
    const clearTotalTimer = this.clock.setTimeout(
      () => totalTimeout.abort(),
      this.config.totalTimeoutMs,
    )
    const contentBuffer = new CoalescedContentBuffer({
      assistantMessageId,
      clock: this.clock,
      flushIntervalMs: this.contentFlushIntervalMs,
      flushMaxChars: this.contentFlushMaxChars,
    })
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
        contentBuffer,
      })
    } catch (error) {
      if (
        await this.emitCancelledIfNeeded(
          assistantMessageId,
          contentBuffer,
          emit,
        )
      ) {
        return
      }
      const failure =
        error instanceof ChatProviderError
          ? providerErrors[error.kind]
          : internalError
      const failurePersisted = await this.commitTerminal(
        assistantMessageId,
        "failed",
        contentBuffer,
        failure.code,
      )
      if (failurePersisted === true) {
        emit({ type: "message.failed", error: failure })
      } else if (failurePersisted === false) {
        // Another writer already committed a terminal status.
        await this.emitCancelledIfNeeded(
          assistantMessageId,
          contentBuffer,
          emit,
        )
      }
      // persistence unavailable → transport interruption, no synthetic terminal
    } finally {
      contentBuffer.dispose()
      clearTotalTimer()
      hub.end()
      this.activeGenerations.delete(assistantMessageId)
    }
  }

  private async isCancelled(assistantMessageId: string): Promise<boolean> {
    return (
      (await readAssistantMessageStatus(assistantMessageId)) === "cancelled"
    )
  }

  private async emitCancelledIfNeeded(
    assistantMessageId: string,
    contentBuffer: CoalescedContentBuffer,
    emit: (event: AssistantMessageGenerationEvent) => void,
  ): Promise<boolean> {
    if (!(await this.isCancelled(assistantMessageId))) return false
    const contentReady = await contentBuffer.forceFlush().catch(() => false)
    if (!contentReady) return true
    emit({ type: "message.cancelled" })
    return true
  }

  private async commitTerminal(
    assistantMessageId: string,
    status: "completed" | "failed",
    contentBuffer: CoalescedContentBuffer,
    errorCode: string | null,
  ): Promise<boolean | null> {
    try {
      const contentReady = await contentBuffer.forceFlush()
      if (!contentReady) return false
      return await finishAssistantMessage(
        assistantMessageId,
        status,
        contentBuffer.content,
        errorCode,
      )
    } catch {
      return null
    }
  }

  private async pipeProviderStream({
    messages,
    cancellation,
    totalTimeout,
    assistantMessageId,
    startedAt,
    emit,
    contentBuffer,
  }: Readonly<{
    messages: readonly ChatMessage[]
    cancellation: AbortSignal
    totalTimeout: AbortSignal
    assistantMessageId: string
    startedAt: number
    emit: (event: AssistantMessageGenerationEvent) => void
    contentBuffer: CoalescedContentBuffer
  }>): Promise<void> {
    let contentStarted = false

    for (
      let attempt = 1;
      attempt <= this.config.maxStreamAttempts;
      attempt += 1
    ) {
      if (totalTimeout.aborted) throw new ChatProviderError("timeout")

      const attemptTimeout = new AbortController()
      const signal = AbortSignal.any([
        cancellation,
        totalTimeout,
        attemptTimeout.signal,
      ])
      let usage: ChatTokenUsage | null = null
      let receivedContent = false
      let awaitingFirstActivity = true
      const iterator = this.provider
        .stream({ messages, signal })
        [Symbol.asyncIterator]()

      try {
        while (true) {
          const result = await nextWithTimeout(
            iterator,
            awaitingFirstActivity
              ? this.config.firstByteTimeoutMs
              : this.config.idleTimeoutMs,
            attemptTimeout,
            assistantMessageId,
            this.clock,
          )
          if (result === assistantCancelled) {
            await this.emitCancelledIfNeeded(
              assistantMessageId,
              contentBuffer,
              emit,
            )
            return
          }
          if (result === assistantTerminalTaken) {
            return
          }
          if (result.done) break
          awaitingFirstActivity = false

          if (result.value.type === "content.delta") {
            if (!result.value.delta) continue
            receivedContent = true
            contentStarted = true
            contentBuffer.append(result.value.delta)
            emit({ type: "content.delta", delta: result.value.delta })
            if (contentBuffer.terminalTaken) {
              await this.emitCancelledIfNeeded(
                assistantMessageId,
                contentBuffer,
                emit,
              )
              return
            }
          } else if (result.value.type === "usage.snapshot") {
            usage = result.value.usage
          }
          // activity events only reset the idle timer via the next wait
        }

        if (!receivedContent || usage === null) {
          throw new ChatProviderError("invalid_response")
        }
        emit({ type: "usage.snapshot", usage })
        const completed = await this.commitTerminal(
          assistantMessageId,
          "completed",
          contentBuffer,
          null,
        )
        if (completed === true) {
          emit({
            type: "message.completed",
            latencyMs: Math.max(0, Math.round(this.clock.now() - startedAt)),
          })
          return
        }
        if (completed === false) {
          await this.emitCancelledIfNeeded(
            assistantMessageId,
            contentBuffer,
            emit,
          )
        }
        // completed === null → transport interruption
        return
      } catch (error) {
        // Explicit cancel writes cancelled first then aborts; recovery writes
        // failed first then aborts. Only the DB cancelled status produces events.
        if (cancellation.aborted) {
          await this.emitCancelledIfNeeded(
            assistantMessageId,
            contentBuffer,
            emit,
          )
          return
        }
        if (await this.isCancelled(assistantMessageId)) {
          await this.emitCancelledIfNeeded(
            assistantMessageId,
            contentBuffer,
            emit,
          )
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
          const delayMs = retryBackoffDelayMs(
            attempt,
            this.retryBackoffBaseMs,
            this.retryBackoffMaxMs,
          )
          const backoff = await sleepForRetryBackoff(this.clock, delayMs, {
            cancellation,
            totalTimeout,
            assistantMessageId,
          })
          if (backoff === "timeout") throw new ChatProviderError("timeout")
          if (backoff === "cancelled") {
            await this.emitCancelledIfNeeded(
              assistantMessageId,
              contentBuffer,
              emit,
            )
            return
          }
          if (backoff === "terminal-taken") return
          continue
        }
        throw providerError
      } finally {
        await iterator.return?.()
      }
    }
  }
}

class CoalescedContentBuffer {
  private completeContent = ""
  private persistedContent = ""
  private clearFlushTimer: (() => void) | null = null
  private flushChain: Promise<void> = Promise.resolve()
  private disposed = false
  terminalTaken = false

  constructor(
    private readonly options: Readonly<{
      assistantMessageId: string
      clock: GenerationClock
      flushIntervalMs: number
      flushMaxChars: number
    }>,
  ) {}

  get content(): string {
    return this.completeContent
  }

  append(delta: string): void {
    this.completeContent += delta
    if (this.terminalTaken || this.disposed) return
    if (this.unpersistedCharCount() >= this.options.flushMaxChars) {
      this.scheduleFlush(true)
      return
    }
    this.scheduleFlush(false)
  }

  async forceFlush(): Promise<boolean> {
    this.clearTimer()
    await this.flushChain
    if (this.terminalTaken) return false
    if (this.completeContent === this.persistedContent) return true
    return this.persistNow()
  }

  dispose(): void {
    this.disposed = true
    this.clearTimer()
  }

  private unpersistedCharCount(): number {
    return [...this.completeContent].length - [...this.persistedContent].length
  }

  private scheduleFlush(immediate: boolean): void {
    if (immediate) {
      this.clearTimer()
      this.enqueueFlush()
      return
    }
    if (this.clearFlushTimer !== null) return
    this.clearFlushTimer = this.options.clock.setTimeout(() => {
      this.clearFlushTimer = null
      this.enqueueFlush()
    }, this.options.flushIntervalMs)
  }

  private clearTimer(): void {
    this.clearFlushTimer?.()
    this.clearFlushTimer = null
  }

  private enqueueFlush(): void {
    this.flushChain = this.flushChain
      .then(async () => {
        if (this.disposed || this.terminalTaken) return
        if (this.completeContent === this.persistedContent) return
        await this.persistNow()
      })
      .catch(() => {
        // Intermediate flush errors are retried by later flushes / forceFlush.
      })
  }

  private async persistNow(): Promise<boolean> {
    const content = this.completeContent
    try {
      const updated = await appendAssistantContent(
        this.options.assistantMessageId,
        content,
      )
      if (!updated) {
        this.terminalTaken = true
        return false
      }
      this.persistedContent = content
      return true
    } catch {
      return false
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
  clock: GenerationClock,
): Promise<
  IteratorResult<T> | typeof assistantCancelled | typeof assistantTerminalTaken
> {
  const deadline = clock.now() + timeoutMs
  type Settled =
    | { ok: true; result: IteratorResult<T> }
    | { ok: false; error: unknown }
  let settled: Settled | null = null
  let notify: (() => void) | null = null
  void iterator.next().then(
    (result) => {
      settled = { ok: true, result }
      notify?.()
    },
    (error: unknown) => {
      settled = { ok: false, error }
      notify?.()
    },
  )
  // Let a synchronous generator throw / immediate yield settle before waiting.
  await Promise.resolve()

  while (true) {
    if (settled !== null) {
      return finalizeIteratorResult(
        settled,
        timeoutController,
        assistantMessageId,
      )
    }

    const remainingMs = deadline - clock.now()
    if (remainingMs <= 0) {
      timeoutController.abort()
      throw new ChatProviderError("timeout")
    }

    let clearPoll: (() => void) | undefined
    await new Promise<void>((resolve) => {
      notify = () => {
        resolve()
      }
      if (settled !== null) {
        resolve()
        return
      }
      clearPoll = clock.setTimeout(
        () => resolve(),
        Math.min(CANCEL_POLL_INTERVAL_MS, remainingMs),
      )
    })
    notify = null
    clearPoll?.()

    if (settled !== null) {
      return finalizeIteratorResult(
        settled,
        timeoutController,
        assistantMessageId,
      )
    }

    if (deadline - clock.now() <= 0) {
      timeoutController.abort()
      throw new ChatProviderError("timeout")
    }

    const status = await readAssistantMessageStatus(assistantMessageId)
    if (status === "streaming") continue
    timeoutController.abort()
    if (status === "cancelled") return assistantCancelled
    return assistantTerminalTaken
  }
}

async function finalizeIteratorResult<T>(
  settled:
    | { ok: true; result: IteratorResult<T> }
    | { ok: false; error: unknown },
  timeoutController: AbortController,
  assistantMessageId: string,
): Promise<
  IteratorResult<T> | typeof assistantCancelled | typeof assistantTerminalTaken
> {
  if (settled.ok) return settled.result
  const status = await readAssistantMessageStatus(assistantMessageId)
  if (status === "cancelled") {
    timeoutController.abort()
    return assistantCancelled
  }
  if (status === "completed" || status === "failed") {
    timeoutController.abort()
    return assistantTerminalTaken
  }
  throw settled.error
}

const assistantCancelled = Symbol("assistant-cancelled")
const assistantTerminalTaken = Symbol("assistant-terminal-taken")

function normalizeProviderError(error: unknown): ChatProviderError {
  return error instanceof ChatProviderError
    ? error
    : new ChatProviderError("unavailable")
}

function retryBackoffDelayMs(
  failedAttempt: number,
  baseMs: number,
  maxMs: number,
): number {
  if (baseMs <= 0 || maxMs <= 0) return 0
  const shift = Math.min(failedAttempt - 1, 30)
  const exponential = baseMs * 2 ** shift
  return Math.min(exponential, maxMs)
}

type RetryBackoffOutcome =
  | "elapsed"
  | "cancelled"
  | "timeout"
  | "terminal-taken"

async function sleepForRetryBackoff(
  clock: GenerationClock,
  ms: number,
  options: Readonly<{
    cancellation: AbortSignal
    totalTimeout: AbortSignal
    assistantMessageId: string
  }>,
): Promise<RetryBackoffOutcome> {
  const interrupted = (): RetryBackoffOutcome | null => {
    if (options.cancellation.aborted) return "cancelled"
    if (options.totalTimeout.aborted) return "timeout"
    return null
  }

  const early = interrupted()
  if (early) return early
  if (ms <= 0) return "elapsed"

  const deadline = clock.now() + ms
  while (true) {
    const signalOutcome = interrupted()
    if (signalOutcome) return signalOutcome

    const status = await readAssistantMessageStatus(options.assistantMessageId)
    if (status === "cancelled") return "cancelled"
    if (status === "completed" || status === "failed") return "terminal-taken"

    const remainingMs = deadline - clock.now()
    if (remainingMs <= 0) return "elapsed"

    const chunkOutcome = await sleepChunk(
      clock,
      Math.min(CANCEL_POLL_INTERVAL_MS, remainingMs),
      options.cancellation,
      options.totalTimeout,
    )
    if (chunkOutcome !== "elapsed") return chunkOutcome
  }
}

function sleepChunk(
  clock: GenerationClock,
  ms: number,
  cancellation: AbortSignal,
  totalTimeout: AbortSignal,
): Promise<RetryBackoffOutcome> {
  if (ms <= 0) return Promise.resolve("elapsed")
  if (cancellation.aborted) return Promise.resolve("cancelled")
  if (totalTimeout.aborted) return Promise.resolve("timeout")

  return new Promise((resolve) => {
    let settled = false
    const finish = (outcome: RetryBackoffOutcome) => {
      if (settled) return
      settled = true
      clearTimer()
      cancellation.removeEventListener("abort", onAbort)
      totalTimeout.removeEventListener("abort", onAbort)
      resolve(outcome)
    }
    const onAbort = () => {
      if (cancellation.aborted) {
        finish("cancelled")
        return
      }
      finish("timeout")
    }
    const clearTimer = clock.setTimeout(() => finish("elapsed"), ms)
    cancellation.addEventListener("abort", onAbort, { once: true })
    totalTimeout.addEventListener("abort", onAbort, { once: true })
  })
}
