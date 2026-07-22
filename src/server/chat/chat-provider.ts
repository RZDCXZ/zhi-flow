import type { ChatTokenUsage } from "../../lib/chat-api"

export type ChatRequest = Readonly<{
  message: string
}>

export type ChatCompletion = Readonly<{
  answer: string
  usage: ChatTokenUsage
}>

export interface ChatProvider {
  complete(request: ChatRequest): Promise<ChatCompletion>
}

export type ChatProviderErrorKind =
  | "authentication"
  | "rate_limit"
  | "unavailable"
  | "invalid_response"
  | "timeout"

export class ChatProviderError extends Error {
  readonly name = "ChatProviderError"

  constructor(readonly kind: ChatProviderErrorKind) {
    super(`Chat provider failed: ${kind}`)
  }
}
