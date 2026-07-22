import {
  CHAT_STREAM_PROTOCOL_VERSION,
  isChatTokenCount,
  type ChatStreamEvent,
  type ChatTokenUsage,
} from "./chat-api"
import { takeSseFrame } from "./sse"

export async function* readChatEventStream(
  response: Response,
  expectedRequestId: string,
): AsyncGenerator<ChatStreamEvent> {
  if (response.body === null) throw new Error("聊天响应没有正文流")

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let lastSequence = 0
  let terminalReceived = false

  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })

      let frame
      while ((frame = takeSseFrame(buffer)) !== null) {
        buffer = frame.rest
        const event = parseFrame(frame.value)
        if (event === null) continue
        if (event.requestId !== expectedRequestId) {
          throw new Error("聊天 SSE 的 requestId 与当前请求不一致")
        }
        if (event.sequence <= lastSequence) continue
        if (event.sequence !== lastSequence + 1) {
          throw new Error("聊天 SSE 的 sequence 不连续")
        }
        if (terminalReceived) throw new Error("聊天 SSE 在终态后仍有事件")

        lastSequence = event.sequence
        terminalReceived = isTerminal(event)
        yield event
      }
    }
    buffer += decoder.decode()
  } finally {
    reader.releaseLock()
  }

  if (buffer.trim()) throw new Error("聊天 SSE 以不完整帧结束")
  if (!terminalReceived) throw new Error("聊天 SSE 在终态前中断")
}

function parseFrame(frame: string): ChatStreamEvent | null {
  if (!frame || frame.startsWith(":")) return null

  const lines = frame.split(/\r?\n/)
  const eventName = lines
    .find((line) => line.startsWith("event:"))
    ?.slice(6)
    .trim()
  const data = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""))
    .join("\n")
  if (!eventName || !data) throw new Error("聊天 SSE 帧缺少事件名或数据")

  let value: unknown
  try {
    value = JSON.parse(data)
  } catch {
    throw new Error("聊天 SSE 包含无效 JSON")
  }
  if (!isChatStreamEvent(value) || value.type !== eventName) {
    throw new Error("聊天 SSE 事件不符合协议 v1")
  }
  return value
}

function isChatStreamEvent(value: unknown): value is ChatStreamEvent {
  if (
    typeof value !== "object" ||
    value === null ||
    !("version" in value) ||
    value.version !== CHAT_STREAM_PROTOCOL_VERSION ||
    !("requestId" in value) ||
    typeof value.requestId !== "string" ||
    !("sequence" in value) ||
    !Number.isInteger(value.sequence) ||
    Number(value.sequence) <= 0 ||
    !("timestamp" in value) ||
    typeof value.timestamp !== "string" ||
    !("type" in value) ||
    typeof value.type !== "string"
  ) {
    return false
  }

  switch (value.type) {
    case "message.created":
    case "message.cancelled":
      return true
    case "content.delta":
      return "delta" in value && typeof value.delta === "string"
    case "usage.snapshot":
      return "usage" in value && isUsage(value.usage)
    case "message.completed":
      return "latencyMs" in value && typeof value.latencyMs === "number"
    case "message.failed":
      return "error" in value && isError(value.error)
    default:
      return false
  }
}

function isUsage(value: unknown): value is ChatTokenUsage {
  return (
    typeof value === "object" &&
    value !== null &&
    "inputTokens" in value &&
    isChatTokenCount(value.inputTokens) &&
    "outputTokens" in value &&
    isChatTokenCount(value.outputTokens) &&
    "totalTokens" in value &&
    isChatTokenCount(value.totalTokens)
  )
}

function isError(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    typeof value.code === "string" &&
    "message" in value &&
    typeof value.message === "string" &&
    "retryable" in value &&
    typeof value.retryable === "boolean"
  )
}

function isTerminal(event: ChatStreamEvent): boolean {
  return (
    event.type === "message.completed" ||
    event.type === "message.cancelled" ||
    event.type === "message.failed"
  )
}
