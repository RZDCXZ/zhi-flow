import type { ChatCompletion, ChatProvider, ChatRequest } from "./chat-provider"

type FakeChatResponder = (
  request: ChatRequest,
) => ChatCompletion | Promise<ChatCompletion>

export class FakeChatProvider implements ChatProvider {
  readonly requests: ChatRequest[] = []

  constructor(private readonly respond: FakeChatResponder) {}

  async complete(request: ChatRequest): Promise<ChatCompletion> {
    this.requests.push(request)
    return this.respond(request)
  }
}
