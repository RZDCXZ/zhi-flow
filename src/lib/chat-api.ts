export const MAX_CHAT_MESSAGE_LENGTH = 4_000

export type ChatTokenUsage = Readonly<{
  inputTokens: number
  outputTokens: number
  totalTokens: number
}>

export type ChatSuccessResponse = Readonly<{
  answer: string
  latencyMs: number
  usage: ChatTokenUsage
}>

export type ChatErrorCode =
  | "INVALID_INPUT"
  | "INPUT_TOO_LONG"
  | "PROVIDER_AUTHENTICATION_FAILED"
  | "RATE_LIMITED"
  | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_TIMEOUT"
  | "INTERNAL_ERROR"

export type ChatErrorResponse = Readonly<{
  error: Readonly<{
    code: ChatErrorCode
    message: string
    retryable: boolean
  }>
}>
