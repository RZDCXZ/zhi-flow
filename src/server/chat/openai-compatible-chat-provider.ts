import type { ChatCompletion, ChatProvider, ChatRequest } from "./chat-provider"
import { ChatProviderError } from "./chat-provider"

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

type OpenAiCompatibleConfig = Readonly<{
  apiKey: string
  baseUrl: string
  model: string
  timeoutMs: number
}>

export class OpenAiCompatibleChatProvider implements ChatProvider {
  constructor(
    private readonly config: OpenAiCompatibleConfig,
    private readonly fetchImplementation: Fetch = fetch,
  ) {}

  async complete(request: ChatRequest): Promise<ChatCompletion> {
    let response: Response
    try {
      response = await this.fetchImplementation(
        `${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: this.config.model,
            messages: [{ role: "user", content: request.message }],
            stream: false,
          }),
          signal: AbortSignal.timeout(this.config.timeoutMs),
        },
      )
    } catch (error) {
      if (
        error instanceof DOMException &&
        (error.name === "TimeoutError" || error.name === "AbortError")
      ) {
        throw new ChatProviderError("timeout")
      }
      throw new ChatProviderError("unavailable")
    }

    if (response.status === 401 || response.status === 403) {
      throw new ChatProviderError("authentication")
    }
    if (response.status === 429) {
      throw new ChatProviderError("rate_limit")
    }
    if (response.status >= 500) {
      throw new ChatProviderError("unavailable")
    }
    if (!response.ok) {
      throw new ChatProviderError("invalid_response")
    }

    let body: unknown
    try {
      body = await response.json()
    } catch {
      throw new ChatProviderError("invalid_response")
    }

    const completion = readCompletion(body)
    if (completion === null) {
      throw new ChatProviderError("invalid_response")
    }

    return completion
  }
}

function readCompletion(body: unknown): ChatCompletion | null {
  if (
    typeof body !== "object" ||
    body === null ||
    !("choices" in body) ||
    !Array.isArray(body.choices) ||
    body.choices.length === 0 ||
    typeof body.choices[0] !== "object" ||
    body.choices[0] === null ||
    !("message" in body.choices[0]) ||
    typeof body.choices[0].message !== "object" ||
    body.choices[0].message === null ||
    !("content" in body.choices[0].message) ||
    typeof body.choices[0].message.content !== "string" ||
    !body.choices[0].message.content.trim() ||
    !("usage" in body) ||
    typeof body.usage !== "object" ||
    body.usage === null ||
    !("prompt_tokens" in body.usage) ||
    !isTokenCount(body.usage.prompt_tokens) ||
    !("completion_tokens" in body.usage) ||
    !isTokenCount(body.usage.completion_tokens) ||
    !("total_tokens" in body.usage) ||
    !isTokenCount(body.usage.total_tokens)
  ) {
    return null
  }

  return {
    answer: body.choices[0].message.content,
    usage: {
      inputTokens: body.usage.prompt_tokens,
      outputTokens: body.usage.completion_tokens,
      totalTokens: body.usage.total_tokens,
    },
  }
}

function isTokenCount(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0
}
