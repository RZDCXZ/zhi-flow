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
    conversationId: body.conversationId,
    clientIdempotencyKey: body.clientIdempotencyKey,
    message: body.message,
  })
  if (result.type !== "started") {
    return chatError(
      {
        ...result.error,
        status: startFailureStatus[result.type],
      },
      startFailureDetails(result),
    )
  }

  return new Response(createResponseStream(result.events, requestId), {
    headers: {
      "Cache-Control": "no-cache, no-store",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream; charset=utf-8",
      "X-Accel-Buffering": "no",
    },
  })
}

export async function DELETE(request: Request) {
  const assistantMessageId = await readAssistantMessageId(request)
  if (assistantMessageId === null) return chatError(invalidInputError)

  const result = await assistantMessageGeneration.cancel(assistantMessageId)
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
  if (result.type === "terminal-conflict") {
    return chatError({
      status: 409,
      code: "INVALID_INPUT",
      message:
        result.status === "completed"
          ? "该 Assistant Message 已完成，无法取消。"
          : "该 Assistant Message 已失败，无法取消。",
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
  "context-unavailable": 503,
  "conversation-not-found": 404,
  "unsupported-mode": 422,
  "message-creation-failed": 404,
  "idempotency-replay": 409,
  "idempotency-key-reused": 409,
  "generation-in-progress": 409,
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
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  let consumerCancelled = false
  const iterator = events[Symbol.asyncIterator]()

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
        }
      }

      void (async () => {
        try {
          while (!consumerCancelled) {
            const next = await iterator.next()
            if (next.done) break
            sequence += 1
            const data = {
              ...next.value,
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
          await iterator.return?.()
          if (!consumerCancelled) controller.close()
        }
      })()
    },
    cancel() {
      consumerCancelled = true
      void iterator.return?.()
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

async function readAssistantMessageId(
  request: Request,
): Promise<string | null> {
  try {
    const body: unknown = await request.json()
    if (
      typeof body !== "object" ||
      body === null ||
      !("assistantMessageId" in body) ||
      !isNonEmptyBoundedString(body.assistantMessageId)
    ) {
      return null
    }
    return body.assistantMessageId
  } catch {
    return null
  }
}

function isNonEmptyBoundedString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128
}

function startFailureDetails(
  result: Exclude<
    Awaited<ReturnType<typeof assistantMessageGeneration.start>>,
    { type: "started" }
  >,
): Omit<ChatErrorResponse, "error"> {
  if (result.type === "idempotency-replay") {
    return { submission: result.submission }
  }
  if (result.type === "idempotency-key-reused") {
    return { userMessageId: result.userMessageId }
  }
  if (result.type === "generation-in-progress") {
    return { assistantMessageId: result.assistantMessageId }
  }
  return {}
}

function chatError(
  { status, ...error }: ChatErrorDefinition,
  details: Omit<ChatErrorResponse, "error"> = {},
) {
  return Response.json(
    { error, ...details },
    { status, headers: { "Cache-Control": "no-store" } },
  )
}
