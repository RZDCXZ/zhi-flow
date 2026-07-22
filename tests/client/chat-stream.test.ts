import { describe, expect, it } from "vitest"

import { readChatEventStream } from "../../src/lib/chat-stream-client"

describe("聊天 SSE 客户端", () => {
  it("跨分块增量解码并按 requestId 与单调 sequence 去重", async () => {
    const requestId = "33333333-3333-4333-8333-333333333333"
    const frames = [
      eventFrame("message.created", requestId, 1),
      eventFrame("content.delta", requestId, 2, { delta: "逐步" }),
      eventFrame("content.delta", requestId, 2, { delta: "逐步" }),
      eventFrame("content.delta", requestId, 3, { delta: "显示" }),
      eventFrame("message.completed", requestId, 4, { latencyMs: 42 }),
    ].join("")
    const encoded = new TextEncoder().encode(frames)
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(encoded.slice(0, 137))
          controller.enqueue(encoded.slice(137, 140))
          controller.enqueue(encoded.slice(140))
          controller.close()
        },
      }),
      { headers: { "Content-Type": "text/event-stream" } },
    )

    const events = []
    for await (const event of readChatEventStream(response, requestId)) {
      events.push(event)
    }

    expect(events.map(({ type, sequence }) => ({ type, sequence }))).toEqual([
      { type: "message.created", sequence: 1 },
      { type: "content.delta", sequence: 2 },
      { type: "content.delta", sequence: 3 },
      { type: "message.completed", sequence: 4 },
    ])
    expect(
      events
        .filter((event) => event.type === "content.delta")
        .map((event) => event.delta)
        .join(""),
    ).toBe("逐步显示")
  })
})

function eventFrame(
  type: string,
  requestId: string,
  sequence: number,
  payload: Record<string, unknown> = {},
): string {
  return `event: ${type}\ndata: ${JSON.stringify({
    version: 1,
    type,
    requestId,
    sequence,
    timestamp: "2026-07-22T00:00:00.000Z",
    ...payload,
  })}\n\n`
}
