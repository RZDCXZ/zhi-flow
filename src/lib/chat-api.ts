export const MAX_CHAT_MESSAGE_LENGTH = 4_000
export const GENERAL_CHAT_CONTEXT_MESSAGE_LIMIT = 12

export type ChatTokenUsage = Readonly<{
  inputTokens: number
  outputTokens: number
  totalTokens: number
}>

export function isChatTokenCount(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0
}

export type ChatErrorCode =
  | "INVALID_INPUT"
  | "INPUT_TOO_LONG"
  | "IDEMPOTENCY_REPLAY"
  | "PROVIDER_AUTHENTICATION_FAILED"
  | "RATE_LIMITED"
  | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_TIMEOUT"
  | "STREAM_INTERRUPTED"
  | "INTERNAL_ERROR"

export type ChatErrorResponse = Readonly<{
  error: Readonly<{
    code: ChatErrorCode
    message: string
    retryable: boolean
  }>
}>

export const CHAT_STREAM_PROTOCOL_VERSION = 1 as const

type ChatStreamEventBase = Readonly<{
  version: typeof CHAT_STREAM_PROTOCOL_VERSION
  requestId: string
  sequence: number
  timestamp: string
}>

export type ChatStreamEvent =
  | (ChatStreamEventBase &
      Readonly<{
        type: "message.created"
        userMessageId: string
        assistantMessageId: string
      }>)
  | (ChatStreamEventBase & Readonly<{ type: "content.delta"; delta: string }>)
  | (ChatStreamEventBase &
      Readonly<{ type: "usage.snapshot"; usage: ChatTokenUsage }>)
  | (ChatStreamEventBase &
      Readonly<{ type: "message.completed"; latencyMs: number }>)
  | (ChatStreamEventBase & Readonly<{ type: "message.cancelled" }>)
  | (ChatStreamEventBase &
      Readonly<{ type: "message.failed"; error: ChatErrorResponse["error"] }>)
