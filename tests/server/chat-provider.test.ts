import { describe, expect, it } from "vitest"

import { FakeChatProvider } from "../../src/server/chat/fake-chat-provider"
import { OpenAiCompatibleChatProvider } from "../../src/server/chat/openai-compatible-chat-provider"

describe("Chat Provider 合约", () => {
  it("可控假 Provider 按序产生正文增量与最终用量，并接收取消信号", async () => {
    const provider = new FakeChatProvider(async function* () {
      yield { type: "content.delta", delta: "这是一个" }
      yield { type: "content.delta", delta: "可控回答。" }
      yield {
        type: "usage.snapshot",
        usage: { inputTokens: 8, outputTokens: 6, totalTokens: 14 },
      }
    })
    const controller = new AbortController()

    const events = []
    for await (const event of provider.stream({
      messages: [
        { role: "user", content: "什么是向量检索？" },
        { role: "assistant", content: "它会按相似度查找相关内容。" },
        { role: "user", content: "它适合处理追问吗？" },
      ],
      signal: controller.signal,
    })) {
      events.push(event)
    }

    expect(events).toEqual([
      { type: "content.delta", delta: "这是一个" },
      { type: "content.delta", delta: "可控回答。" },
      {
        type: "usage.snapshot",
        usage: { inputTokens: 8, outputTokens: 6, totalTokens: 14 },
      },
    ])
    expect(provider.requests).toEqual([
      {
        messages: [
          { role: "user", content: "什么是向量检索？" },
          { role: "assistant", content: "它会按相似度查找相关内容。" },
          { role: "user", content: "它适合处理追问吗？" },
        ],
        signal: controller.signal,
      },
    ])
  })

  it("OpenAI-compatible Provider 增量解码流式正文、心跳与用量", async () => {
    const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
    const encoder = new TextEncoder()
    const upstreamBody = encoder.encode(
      ': keep-alive\n\ndata: {"choices":[{"delta":{"content":"向量"}}]}\n\n' +
        'data: {"choices":[{"delta":{"content":"检索。"}}]}\n\n' +
        'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":9,"total_tokens":21}}\n\n' +
        "data: [DONE]\n\n",
    )
    const provider = new OpenAiCompatibleChatProvider(
      {
        apiKey: "provider-secret",
        baseUrl: "https://chat.example.test/v1/",
        model: "learning-model",
      },
      async (input, init) => {
        requests.push({ input, init })
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(upstreamBody.slice(0, 61))
              controller.enqueue(upstreamBody.slice(61, 64))
              controller.enqueue(upstreamBody.slice(64))
              controller.close()
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        )
      },
    )
    const controller = new AbortController()

    const events = []
    for await (const event of provider.stream({
      messages: [
        { role: "user", content: "解释向量检索。" },
        { role: "assistant", content: "它按向量相似度召回内容。" },
        { role: "user", content: "再简短一点。" },
      ],
      signal: controller.signal,
    })) {
      events.push(event)
    }

    expect(events.some((event) => event.type === "activity")).toBe(true)
    expect(events.filter((event) => event.type !== "activity")).toEqual([
      { type: "content.delta", delta: "向量" },
      { type: "content.delta", delta: "检索。" },
      {
        type: "usage.snapshot",
        usage: {
          inputTokens: 12,
          outputTokens: 9,
          totalTokens: 21,
        },
      },
    ])
    expect(requests).toHaveLength(1)
    expect(requests[0]?.input).toBe(
      "https://chat.example.test/v1/chat/completions",
    )
    expect(requests[0]?.init?.headers).toEqual({
      Authorization: "Bearer provider-secret",
      Accept: "text/event-stream",
      "Content-Type": "application/json",
    })
    expect(requests[0]?.init?.signal).toBe(controller.signal)
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      model: "learning-model",
      messages: [
        { role: "user", content: "解释向量检索。" },
        { role: "assistant", content: "它按向量相似度召回内容。" },
        { role: "user", content: "再简短一点。" },
      ],
      stream: true,
      stream_options: { include_usage: true },
    })
  })

  it("OpenAI-compatible Provider 将畸形成功响应归类为无效供应商响应", async () => {
    const provider = new OpenAiCompatibleChatProvider(
      {
        apiKey: "provider-secret",
        baseUrl: "https://chat.example.test/v1",
        model: "learning-model",
      },
      async () =>
        new Response('data: {"choices":[],"usage":{}}\n\ndata: [DONE]\n\n', {
          headers: { "Content-Type": "text/event-stream" },
        }),
    )
    const controller = new AbortController()

    await expect(
      (async () => {
        for await (const event of provider.stream({
          messages: [{ role: "user", content: "无法解析的响应。" }],
          signal: controller.signal,
        })) {
          void event
        }
      })(),
    ).rejects.toMatchObject({
      name: "ChatProviderError",
      kind: "invalid_response",
    })
  })
})
