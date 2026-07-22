import type {
  ChatProvider,
  ChatProviderStreamEvent,
  ChatRequest,
} from "./chat-provider"

type FakeChatResponder = (
  request: ChatRequest,
) => AsyncIterable<ChatProviderStreamEvent>

export class FakeChatProvider implements ChatProvider {
  readonly requests: ChatRequest[] = []

  constructor(private readonly respond: FakeChatResponder) {}

  stream(request: ChatRequest): AsyncIterable<ChatProviderStreamEvent> {
    this.requests.push(request)
    return this.respond(request)
  }
}
