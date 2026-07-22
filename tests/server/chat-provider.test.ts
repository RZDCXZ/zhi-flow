import { describe, expect, it } from "vitest"

import { FakeChatProvider } from "../../src/server/chat/fake-chat-provider"
import { OpenAiCompatibleChatProvider } from "../../src/server/chat/openai-compatible-chat-provider"

describe("Chat Provider 合约", () => {
  it("可控假 Provider 接收单条用户消息并返回答案与用量", async () => {
    const provider = new FakeChatProvider(async () => ({
      answer: "这是一个可控回答。",
      usage: {
        inputTokens: 8,
        outputTokens: 6,
        totalTokens: 14,
      },
    }))

    const result = await provider.complete({ message: "什么是向量检索？" })

    expect(result).toEqual({
      answer: "这是一个可控回答。",
      usage: {
        inputTokens: 8,
        outputTokens: 6,
        totalTokens: 14,
      },
    })
    expect(provider.requests).toEqual([{ message: "什么是向量检索？" }])
  })

  it("OpenAI-compatible Provider 发送非流式消息并规范化响应", async () => {
    const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
    const provider = new OpenAiCompatibleChatProvider(
      {
        apiKey: "provider-secret",
        baseUrl: "https://chat.example.test/v1/",
        model: "learning-model",
        timeoutMs: 1_000,
      },
      async (input, init) => {
        requests.push({ input, init })
        return Response.json({
          choices: [{ message: { content: "向量检索会比较语义相似度。" } }],
          usage: {
            prompt_tokens: 12,
            completion_tokens: 9,
            total_tokens: 21,
          },
        })
      },
    )

    const result = await provider.complete({ message: "解释向量检索。" })

    expect(result).toEqual({
      answer: "向量检索会比较语义相似度。",
      usage: {
        inputTokens: 12,
        outputTokens: 9,
        totalTokens: 21,
      },
    })
    expect(requests).toHaveLength(1)
    expect(requests[0]?.input).toBe(
      "https://chat.example.test/v1/chat/completions",
    )
    expect(requests[0]?.init?.headers).toEqual({
      Authorization: "Bearer provider-secret",
      "Content-Type": "application/json",
    })
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      model: "learning-model",
      messages: [{ role: "user", content: "解释向量检索。" }],
      stream: false,
    })
  })

  it("OpenAI-compatible Provider 将畸形成功响应归类为无效供应商响应", async () => {
    const provider = new OpenAiCompatibleChatProvider(
      {
        apiKey: "provider-secret",
        baseUrl: "https://chat.example.test/v1",
        model: "learning-model",
        timeoutMs: 1_000,
      },
      async () => Response.json({ choices: [], usage: {} }),
    )

    await expect(
      provider.complete({ message: "无法解析的响应。" }),
    ).rejects.toMatchObject({
      name: "ChatProviderError",
      kind: "invalid_response",
    })
  })
})
