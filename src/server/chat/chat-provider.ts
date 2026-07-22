import type { ChatTokenUsage } from "../../lib/chat-api"

export type ChatMessage = Readonly<{
  role: "user" | "assistant"
  content: string
}>

export type ChatRequest = Readonly<{
  messages: readonly ChatMessage[]
  signal: AbortSignal
}>

export type ChatProviderStreamEvent =
  | Readonly<{ type: "activity" }>
  | Readonly<{ type: "content.delta"; delta: string }>
  | Readonly<{ type: "usage.snapshot"; usage: ChatTokenUsage }>

export interface ChatProvider {
  stream(request: ChatRequest): AsyncIterable<ChatProviderStreamEvent>
}

export type ChatProviderErrorKind =
  | "authentication"
  | "rate_limit"
  | "unavailable"
  | "invalid_response"
  | "timeout"
  | "interrupted"

export class ChatProviderError extends Error {
  readonly name = "ChatProviderError"

  constructor(readonly kind: ChatProviderErrorKind) {
    super(`Chat provider failed: ${kind}`)
  }
}
