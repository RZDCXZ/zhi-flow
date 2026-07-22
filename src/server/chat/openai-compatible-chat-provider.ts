import type {
  ChatProvider,
  ChatProviderStreamEvent,
  ChatRequest,
} from "./chat-provider"
import { ChatProviderError } from "./chat-provider"
import { takeSseFrame } from "../../lib/sse"
import { isChatTokenCount } from "../../lib/chat-api"

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

type OpenAiCompatibleConfig = Readonly<{
  apiKey: string
  baseUrl: string
  model: string
}>

export class OpenAiCompatibleChatProvider implements ChatProvider {
  constructor(
    private readonly config: OpenAiCompatibleConfig,
    private readonly fetchImplementation: Fetch = fetch,
  ) {}

  async *stream(request: ChatRequest): AsyncGenerator<ChatProviderStreamEvent> {
    let response: Response
    try {
      response = await this.fetchImplementation(
        `${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
            Accept: "text/event-stream",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: this.config.model,
            messages: [{ role: "user", content: request.message }],
            stream: true,
            stream_options: { include_usage: true },
          }),
          signal: request.signal,
        },
      )
    } catch {
      if (request.signal.aborted) throw abortError()
      throw new ChatProviderError("unavailable")
    }

    assertSuccessfulResponse(response)
    if (response.body === null) throw new ChatProviderError("invalid_response")

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    let receivedDone = false

    try {
      while (!receivedDone) {
        const chunk = await reader.read()
        if (chunk.done) break
        if (chunk.value.byteLength > 0) yield { type: "activity" }
        buffer += decoder.decode(chunk.value, { stream: true })

        let frame
        while ((frame = takeSseFrame(buffer)) !== null) {
          buffer = frame.rest
          const parsed = readFrame(frame.value)
          if (parsed === "done") {
            receivedDone = true
            break
          }
          for (const event of parsed) yield event
        }
      }
      buffer += decoder.decode()
    } catch (error) {
      if (request.signal.aborted) throw abortError()
      if (error instanceof ChatProviderError) throw error
      throw new ChatProviderError("interrupted")
    } finally {
      reader.releaseLock()
    }

    if (!receivedDone || buffer.trim()) {
      throw new ChatProviderError("interrupted")
    }
  }
}

function assertSuccessfulResponse(response: Response): void {
  if (response.status === 401 || response.status === 403) {
    throw new ChatProviderError("authentication")
  }
  if (response.status === 429) throw new ChatProviderError("rate_limit")
  if (response.status >= 500) throw new ChatProviderError("unavailable")
  if (!response.ok) throw new ChatProviderError("invalid_response")
}

function readFrame(frame: string): readonly ChatProviderStreamEvent[] | "done" {
  const lines = frame.split(/\r?\n/)
  const data = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""))
    .join("\n")

  if (!data) return []
  if (data === "[DONE]") return "done"

  let body: unknown
  try {
    body = JSON.parse(data)
  } catch {
    throw new ChatProviderError("invalid_response")
  }

  const events: ChatProviderStreamEvent[] = []
  const delta = readContentDelta(body)
  if (delta !== null && delta !== "") {
    events.push({ type: "content.delta", delta })
  }
  const usage = readUsage(body)
  if (usage !== null) events.push({ type: "usage.snapshot", usage })
  if (events.length === 0) events.push({ type: "activity" })
  return events
}

function readContentDelta(body: unknown): string | null {
  if (
    typeof body !== "object" ||
    body === null ||
    !("choices" in body) ||
    !Array.isArray(body.choices) ||
    body.choices.length === 0
  ) {
    return null
  }

  const choice: unknown = body.choices[0]
  if (
    typeof choice !== "object" ||
    choice === null ||
    !("delta" in choice) ||
    typeof choice.delta !== "object" ||
    choice.delta === null ||
    !("content" in choice.delta)
  ) {
    return null
  }
  if (choice.delta.content === null) return null
  if (typeof choice.delta.content !== "string") {
    throw new ChatProviderError("invalid_response")
  }
  return choice.delta.content
}

function readUsage(body: unknown) {
  if (
    typeof body !== "object" ||
    body === null ||
    !("usage" in body) ||
    body.usage === null
  ) {
    return null
  }
  if (typeof body.usage !== "object") {
    throw new ChatProviderError("invalid_response")
  }

  const usage = body.usage
  if (
    !("prompt_tokens" in usage) ||
    !isChatTokenCount(usage.prompt_tokens) ||
    !("completion_tokens" in usage) ||
    !isChatTokenCount(usage.completion_tokens) ||
    !("total_tokens" in usage) ||
    !isChatTokenCount(usage.total_tokens)
  ) {
    throw new ChatProviderError("invalid_response")
  }

  return {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
  }
}

function abortError(): DOMException {
  return new DOMException("Chat stream was cancelled", "AbortError")
}
