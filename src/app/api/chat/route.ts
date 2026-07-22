import {
  CHAT_STREAM_PROTOCOL_VERSION,
  type ChatErrorResponse,
  type ChatStreamEvent,
} from "@/lib/chat-api"
import type { AssistantMessageGenerationEvent } from "@/server/chat/assistant-message-generation"
import { assistantMessageGeneration } from "@/server/composition-root"
import { serverConfig } from "@/server/config"

export const dynamic = "force-dynamic"

type ChatErrorDefinition = ChatErrorResponse["error"] &
  Readonly<{ status: number }>

const invalidInputError = {
  status: 400,
  code: "INVALID_INPUT",
  message: "请输入消息。",
  retryable: false,
} satisfies ChatErrorDefinition

export async function POST(request: Request) {
  const body = await readRequestBody(request)
  if (body === null) return chatError(invalidInputError)

  const requestId = body.requestId ?? crypto.randomUUID()
  const result = await assistantMessageGeneration.start({
    ...body,
    requestId,
    disconnected: request.signal,
  })
  if (result.type !== "started") {
    return chatError({
      ...result.error,
      status: startFailureStatus[result.type],
    })
  }

  return new Response(
    createResponseStream(result.events, requestId, () => {
      void assistantMessageGeneration.cancel({ kind: "request", id: requestId })
    }),
    {
      headers: {
        "Cache-Control": "no-cache, no-store",
        Connection: "keep-alive",
        "Content-Type": "text/event-stream; charset=utf-8",
        "X-Accel-Buffering": "no",
      },
    },
  )
}

export async function DELETE(request: Request) {
  const target = await readCancellationTarget(request)
  if (target === null) return chatError(invalidInputError)

  const result = await assistantMessageGeneration.cancel(target)
  if (result.type === "unavailable") {
    return chatError({
      status: 503,
      code: "INTERNAL_ERROR",
      message: "暂时无法停止本次生成。",
      retryable: true,
    })
  }
  if (result.type === "not-found") {
    return chatError({
      status: 404,
      code: "INVALID_INPUT",
      message: "本次生成已结束。",
      retryable: false,
    })
  }

  return new Response(null, {
    status: 202,
    headers: { "Cache-Control": "no-store" },
  })
}

const startFailureStatus = {
  "invalid-input": 400,
  "input-too-long": 400,
  "request-in-progress": 409,
  "context-unavailable": 503,
  "conversation-not-found": 404,
  "unsupported-mode": 422,
  "message-creation-failed": 404,
  "idempotency-replay": 409,
} satisfies Record<
  Exclude<
    Awaited<ReturnType<typeof assistantMessageGeneration.start>>["type"],
    "started"
  >,
  number
>

function createResponseStream(
  events: AsyncIterable<AssistantMessageGenerationEvent>,
  requestId: string,
  onCancel: () => void,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  let consumerCancelled = false

  return new ReadableStream({
    start(controller) {
      let sequence = 0
      const heartbeatTimer = setInterval(() => {
        enqueue(encoder.encode(`: heartbeat ${new Date().toISOString()}\n\n`))
      }, serverConfig.chat.heartbeatIntervalMs)

      const enqueue = (chunk: Uint8Array) => {
        if (consumerCancelled) return
        try {
          controller.enqueue(chunk)
        } catch {
          consumerCancelled = true
          onCancel()
        }
      }

      void (async () => {
        try {
          for await (const event of events) {
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
        } finally {
          clearInterval(heartbeatTimer)
          if (!consumerCancelled) controller.close()
        }
      })()
    },
    cancel() {
      consumerCancelled = true
      onCancel()
    },
  })
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
