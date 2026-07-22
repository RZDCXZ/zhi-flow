import {
  CHAT_STREAM_PROTOCOL_VERSION,
  MAX_CHAT_MESSAGE_LENGTH,
  type ChatErrorResponse,
  type ChatStreamEvent,
  type ChatTokenUsage,
} from "@/lib/chat-api"
import {
  ChatProviderError,
  type ChatProvider,
  type ChatProviderErrorKind,
  type ChatMessage,
} from "@/server/chat/chat-provider"
import { OpenAiCompatibleChatProvider } from "@/server/chat/openai-compatible-chat-provider"
import { serverConfig } from "@/server/config"
import {
  appendAssistantContent,
  cancelAssistantMessage,
  createMessageAttempt,
  finishAssistantMessage,
  isAssistantMessageStreaming,
  readGeneralChatHistory,
} from "@/server/conversations"

export const dynamic = "force-dynamic"

const chatProvider = new OpenAiCompatibleChatProvider(serverConfig.chat)
const activeChats = new Map<string, AbortController>()

type ChatErrorDefinition = ChatErrorResponse["error"] &
  Readonly<{ status: number }>

const invalidInputError = {
  status: 400,
  code: "INVALID_INPUT",
  message: "请输入消息。",
  retryable: false,
} satisfies ChatErrorDefinition

const providerUnavailableError = {
  status: 502,
  code: "PROVIDER_UNAVAILABLE",
  message: "聊天服务暂时不可用，请稍后重试。",
  retryable: true,
} satisfies ChatErrorDefinition

const providerErrors = {
  authentication: {
    status: 502,
    code: "PROVIDER_AUTHENTICATION_FAILED",
    message: "聊天服务配置异常，请稍后再试。",
    retryable: false,
  },
  rate_limit: {
    status: 429,
    code: "RATE_LIMITED",
    message: "请求过于频繁，请稍后重试。",
    retryable: true,
  },
  unavailable: providerUnavailableError,
  invalid_response: providerUnavailableError,
  timeout: {
    status: 504,
    code: "PROVIDER_TIMEOUT",
    message: "聊天服务响应超时，请重试。",
    retryable: true,
  },
  interrupted: {
    status: 502,
    code: "STREAM_INTERRUPTED",
    message: "回答传输中断，请重试。",
    retryable: true,
  },
} satisfies Record<ChatProviderErrorKind, ChatErrorDefinition>

const internalError = {
  status: 500,
  code: "INTERNAL_ERROR",
  message: "聊天服务暂时不可用，请稍后再试。",
  retryable: true,
} satisfies ChatErrorDefinition

export async function POST(request: Request) {
  const body = await readRequestBody(request)
  if (body === null || !body.message.trim()) {
    return chatError(invalidInputError)
  }

  const message = body.message.trim()
  if ([...message].length > MAX_CHAT_MESSAGE_LENGTH) {
    return chatError({
      status: 400,
      code: "INPUT_TOO_LONG",
      message: `消息不能超过 ${MAX_CHAT_MESSAGE_LENGTH} 个字符。`,
      retryable: false,
    })
  }

  const requestId = body.requestId ?? crypto.randomUUID()
  if (activeChats.has(requestId)) {
    return chatError({
      status: 409,
      code: "INVALID_INPUT",
      message: "该请求正在生成中。",
      retryable: false,
    })
  }

  let history
  try {
    history = await readGeneralChatHistory(body.conversationId)
  } catch {
    return chatError({
      status: 503,
      code: "INTERNAL_ERROR",
      message: "暂时无法读取会话上下文。",
      retryable: true,
    })
  }
  if (history === null) {
    return chatError({
      status: 404,
      code: "INVALID_INPUT",
      message: "通用会话不存在或不可用。",
      retryable: false,
    })
  }

  let attempt
  try {
    attempt = await createMessageAttempt(
      body.conversationId,
      message,
      body.clientIdempotencyKey,
    )
  } catch {
    return chatError({
      status: 404,
      code: "INVALID_INPUT",
      message: "会话不存在或暂时不可用。",
      retryable: false,
    })
  }
  if (attempt.duplicate || attempt.assistantMessageId === null) {
    return chatError({
      status: 409,
      code: "IDEMPOTENCY_REPLAY",
      message: "这条消息已经提交过。",
      retryable: false,
    })
  }

  const cancellation = new AbortController()
  activeChats.set(requestId, cancellation)
  activeChats.set(attempt.assistantMessageId, cancellation)
  const stream = createResponseStream({
    request,
    requestId,
    messages: [...history, { role: "user", content: message }],
    cancellation,
    userMessageId: attempt.userMessageId,
    assistantMessageId: attempt.assistantMessageId,
    provider: chatProvider,
  })

  return new Response(stream, {
    headers: {
      "Cache-Control": "no-cache, no-store",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream; charset=utf-8",
      "X-Accel-Buffering": "no",
    },
  })
}

export async function DELETE(request: Request) {
  const target = await readCancellationTarget(request)
  if (target === null) return chatError(invalidInputError)

  const cancellation = activeChats.get(target.id)
  let persistedCancellation = false
  if (target.kind === "assistant") {
    try {
      persistedCancellation = await cancelAssistantMessage(target.id)
    } catch {
      return chatError({
        status: 503,
        code: "INTERNAL_ERROR",
        message: "暂时无法停止本次生成。",
        retryable: true,
      })
    }
  }
  if (!persistedCancellation && cancellation === undefined) {
    return chatError({
      status: 404,
      code: "INVALID_INPUT",
      message: "本次生成已结束。",
      retryable: false,
    })
  }

  cancellation?.abort()
  return new Response(null, {
    status: 202,
    headers: { "Cache-Control": "no-store" },
  })
}

type ResponseStreamOptions = Readonly<{
  request: Request
  requestId: string
  messages: readonly ChatMessage[]
  cancellation: AbortController
  userMessageId: string
  assistantMessageId: string
  provider: ChatProvider
}>

type ChatStreamEventData = ChatStreamEvent extends infer Event
  ? Event extends ChatStreamEvent
    ? Omit<Event, "version" | "requestId" | "sequence" | "timestamp">
    : never
  : never

function createResponseStream({
  request,
  requestId,
  messages,
  cancellation,
  userMessageId,
  assistantMessageId,
  provider,
}: ResponseStreamOptions): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  let consumerCancelled = false

  return new ReadableStream({
    start(controller) {
      let sequence = 0
      let closed = false
      const startedAt = performance.now()
      const totalTimeout = new AbortController()
      const totalTimer = setTimeout(
        () => totalTimeout.abort(),
        serverConfig.chat.totalTimeoutMs,
      )
      const heartbeatTimer = setInterval(() => {
        if (!closed) {
          enqueue(encoder.encode(`: heartbeat ${new Date().toISOString()}\n\n`))
        }
      }, serverConfig.chat.heartbeatIntervalMs)

      const emit = (event: ChatStreamEventData) => {
        sequence += 1
        const data = {
          ...event,
          version: CHAT_STREAM_PROTOCOL_VERSION,
          requestId,
          sequence,
          timestamp: new Date().toISOString(),
        } as ChatStreamEvent
        enqueue(
          encoder.encode(
            `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`,
          ),
        )
      }

      const enqueue = (chunk: Uint8Array) => {
        if (consumerCancelled) return
        try {
          controller.enqueue(chunk)
        } catch {
          consumerCancelled = true
          cancellation.abort()
        }
      }

      void (async () => {
        let persistedContent = ""
        try {
          emit({ type: "message.created", userMessageId, assistantMessageId })
          await pipeProviderStream({
            provider,
            messages,
            cancellation: cancellation.signal,
            disconnected: request.signal,
            totalTimeout: totalTimeout.signal,
            emit,
            onContent: async (content) => {
              persistedContent = content
              return appendAssistantContent(assistantMessageId, content)
            },
            onTerminal: async (status, errorCode) => {
              return finishAssistantMessage(
                assistantMessageId,
                status,
                persistedContent,
                errorCode,
              )
            },
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
            emit({
              type: "message.failed",
              error: withoutStatus(failure),
            })
          } else {
            emit({ type: "message.cancelled" })
          }
        } finally {
          clearTimeout(totalTimer)
          clearInterval(heartbeatTimer)
          activeChats.delete(requestId)
          activeChats.delete(assistantMessageId)
          closed = true
          if (!consumerCancelled) controller.close()
        }
      })()

      async function pipeProviderStream({
        provider,
        messages,
        cancellation,
        disconnected,
        totalTimeout,
        emit,
        onContent,
        onTerminal,
      }: Readonly<{
        provider: ChatProvider
        messages: readonly ChatMessage[]
        cancellation: AbortSignal
        disconnected: AbortSignal
        totalTimeout: AbortSignal
        emit: (event: ChatStreamEventData) => void
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
          attempt <= serverConfig.chat.maxStreamAttempts;
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
          const iterator = provider
            .stream({ messages, signal })
            [Symbol.asyncIterator]()

          try {
            while (true) {
              const result = await nextWithTimeout(
                iterator,
                firstActivity
                  ? serverConfig.chat.firstByteTimeoutMs
                  : serverConfig.chat.idleTimeoutMs,
                attemptTimeout,
                assistantMessageId,
              )
              if (result === assistantCancelled) {
                emit({ type: "message.cancelled" })
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
                  emit({ type: "message.cancelled" })
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
              emit({ type: "message.cancelled" })
              return
            }
            emit({
              type: "message.completed",
              latencyMs: Math.round(performance.now() - startedAt),
            })
            return
          } catch (error) {
            if (cancellation.aborted || disconnected.aborted) {
              await onTerminal("cancelled", null)
              emit({ type: "message.cancelled" })
              return
            }
            if (totalTimeout.aborted) {
              throw new ChatProviderError("timeout")
            }

            const providerError = normalizeProviderError(error)
            if (
              !contentStarted &&
              providerError.kind !== "authentication" &&
              providerError.kind !== "invalid_response" &&
              attempt < serverConfig.chat.maxStreamAttempts
            ) {
              continue
            }
            throw providerError
          } finally {
            await iterator.return?.()
          }
        }
      }
    },
    cancel() {
      consumerCancelled = true
      cancellation.abort()
    },
  })
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

async function readRequestBody(request: Request): Promise<{
  message: string
  conversationId: string
  clientIdempotencyKey: string
  requestId?: string
} | null> {
  try {
    const body: unknown = await request.json()
    if (
      typeof body !== "object" ||
      body === null ||
      !("message" in body) ||
      typeof body.message !== "string" ||
      !("conversationId" in body) ||
      !isNonEmptyBoundedString(body.conversationId) ||
      !("clientIdempotencyKey" in body) ||
      !isNonEmptyBoundedString(body.clientIdempotencyKey)
    ) {
      return null
    }
    const requestId =
      "requestId" in body
        ? isNonEmptyBoundedString(body.requestId)
          ? body.requestId
          : null
        : undefined
    if (requestId === null) return null
    return {
      message: body.message,
      conversationId: body.conversationId,
      clientIdempotencyKey: body.clientIdempotencyKey,
      ...(requestId ? { requestId } : {}),
    }
  } catch {
    return null
  }
}

async function readCancellationTarget(
  request: Request,
): Promise<{ kind: "assistant" | "request"; id: string } | null> {
  try {
    const body: unknown = await request.json()
    if (typeof body !== "object" || body === null) return null
    if (
      "assistantMessageId" in body &&
      isNonEmptyBoundedString(body.assistantMessageId)
    ) {
      return { kind: "assistant", id: body.assistantMessageId }
    }
    return "requestId" in body && isNonEmptyBoundedString(body.requestId)
      ? { kind: "request", id: body.requestId }
      : null
  } catch {
    return null
  }
}

function isNonEmptyBoundedString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128
}

function chatError({ status, ...error }: ChatErrorDefinition) {
  return Response.json(
    { error },
    { status, headers: { "Cache-Control": "no-store" } },
  )
}

function withoutStatus(error: ChatErrorDefinition) {
  return {
    code: error.code,
    message: error.message,
    retryable: error.retryable,
  }
}
