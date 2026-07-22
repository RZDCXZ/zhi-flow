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
} from "@/server/chat/chat-provider"
import { OpenAiCompatibleChatProvider } from "@/server/chat/openai-compatible-chat-provider"
import { serverConfig } from "@/server/config"

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

  const cancellation = new AbortController()
  activeChats.set(requestId, cancellation)
  const stream = createResponseStream({
    request,
    requestId,
    message,
    cancellation,
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
  const requestId = await readCancellationRequestId(request)
  if (requestId === null) return chatError(invalidInputError)

  const cancellation = activeChats.get(requestId)
  if (cancellation === undefined) {
    return chatError({
      status: 404,
      code: "INVALID_INPUT",
      message: "本次生成已结束。",
      retryable: false,
    })
  }

  cancellation.abort()
  return new Response(null, {
    status: 202,
    headers: { "Cache-Control": "no-store" },
  })
}

type ResponseStreamOptions = Readonly<{
  request: Request
  requestId: string
  message: string
  cancellation: AbortController
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
  message,
  cancellation,
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
        try {
          emit({ type: "message.created" })
          await pipeProviderStream({
            provider,
            message,
            cancellation: cancellation.signal,
            disconnected: request.signal,
            totalTimeout: totalTimeout.signal,
            emit,
          })
        } catch (error) {
          const failure =
            error instanceof ChatProviderError
              ? providerErrors[error.kind]
              : internalError
          emit({
            type: "message.failed",
            error: withoutStatus(failure),
          })
        } finally {
          clearTimeout(totalTimer)
          clearInterval(heartbeatTimer)
          activeChats.delete(requestId)
          closed = true
          if (!consumerCancelled) controller.close()
        }
      })()

      async function pipeProviderStream({
        provider,
        message,
        cancellation,
        disconnected,
        totalTimeout,
        emit,
      }: Readonly<{
        provider: ChatProvider
        message: string
        cancellation: AbortSignal
        disconnected: AbortSignal
        totalTimeout: AbortSignal
        emit: (event: ChatStreamEventData) => void
      }>): Promise<void> {
        let contentStarted = false

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
            .stream({ message, signal })
            [Symbol.asyncIterator]()

          try {
            while (true) {
              const result = await nextWithTimeout(
                iterator,
                firstActivity
                  ? serverConfig.chat.firstByteTimeoutMs
                  : serverConfig.chat.idleTimeoutMs,
                attemptTimeout,
              )
              if (result.done) break
              firstActivity = false

              if (result.value.type === "content.delta") {
                if (!result.value.delta) continue
                receivedContent = true
                contentStarted = true
                emit({ type: "content.delta", delta: result.value.delta })
              } else if (result.value.type === "usage.snapshot") {
                usage = result.value.usage
              }
            }

            if (!receivedContent || usage === null) {
              throw new ChatProviderError("invalid_response")
            }
            emit({ type: "usage.snapshot", usage })
            emit({
              type: "message.completed",
              latencyMs: Math.round(performance.now() - startedAt),
            })
            return
          } catch (error) {
            if (cancellation.aborted || disconnected.aborted) {
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
): Promise<IteratorResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const next = iterator.next()
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new ChatProviderError("timeout"))
      timeoutController.abort()
    }, timeoutMs)
  })

  try {
    return await Promise.race([next, timeout])
  } finally {
    clearTimeout(timer)
  }
}

function normalizeProviderError(error: unknown): ChatProviderError {
  return error instanceof ChatProviderError
    ? error
    : new ChatProviderError("unavailable")
}

async function readRequestBody(
  request: Request,
): Promise<{ message: string; requestId?: string } | null> {
  try {
    const body: unknown = await request.json()
    if (
      typeof body !== "object" ||
      body === null ||
      !("message" in body) ||
      typeof body.message !== "string"
    ) {
      return null
    }
    const requestId =
      "requestId" in body
        ? isRequestId(body.requestId)
          ? body.requestId
          : null
        : undefined
    if (requestId === null) return null
    return { message: body.message, ...(requestId ? { requestId } : {}) }
  } catch {
    return null
  }
}

async function readCancellationRequestId(
  request: Request,
): Promise<string | null> {
  try {
    const body: unknown = await request.json()
    if (
      typeof body !== "object" ||
      body === null ||
      !("requestId" in body) ||
      !isRequestId(body.requestId)
    ) {
      return null
    }
    return body.requestId
  } catch {
    return null
  }
}

function isRequestId(value: unknown): value is string {
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
