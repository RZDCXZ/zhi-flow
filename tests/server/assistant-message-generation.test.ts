import { createClient } from "@supabase/supabase-js"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

import {
  AssistantMessageGenerationModule,
  type AssistantMessageGenerationEvent,
} from "../../src/server/chat/assistant-message-generation"
import { FakeChatProvider } from "../../src/server/chat/fake-chat-provider"

const supabaseUrl = "http://127.0.0.1:54321"
const localServiceRoleKey =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU"

const dataClient = createClient(
  supabaseUrl,
  process.env.ZHI_FLOW_SUPABASE_SECRET_KEY ?? localServiceRoleKey,
  { auth: { autoRefreshToken: false, persistSession: false } },
)
const createdConversationIds = new Set<string>()
const createdKnowledgeBaseIds = new Set<string>()

afterEach(async () => {
  if (createdConversationIds.size > 0) {
    const { error } = await dataClient
      .from("conversations")
      .delete()
      .in("id", [...createdConversationIds])
    createdConversationIds.clear()
    if (error) throw error
  }
  if (createdKnowledgeBaseIds.size === 0) return
  const { error: knowledgeBaseError } = await dataClient
    .from("knowledge_bases")
    .delete()
    .in("id", [...createdKnowledgeBaseIds])
  createdKnowledgeBaseIds.clear()
  if (knowledgeBaseError) throw knowledgeBaseError
})

describe("Assistant Message 生成 module", () => {
  it("在调用 Provider 前原子创建 Message，并按序产生事件及持久化完成终态", async () => {
    const conversationId = await createConversation("module 成功路径")
    const provider = new FakeChatProvider(async function* () {
      const { data: messages, error } = await dataClient
        .from("messages")
        .select("role,status,content")
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: true })
        .order("role", { ascending: true })
      if (error) throw error
      expect(messages).toEqual([
        { role: "user", status: "completed", content: "解释深模块。" },
        { role: "assistant", status: "streaming", content: "" },
      ])

      yield { type: "content.delta", delta: "把复杂度" }
      yield { type: "content.delta", delta: "藏在窄接口后。" }
      yield {
        type: "usage.snapshot",
        usage: { inputTokens: 7, outputTokens: 9, totalTokens: 16 },
      }
    })
    const generation = new AssistantMessageGenerationModule(provider, {
      firstByteTimeoutMs: 1_000,
      idleTimeoutMs: 1_000,
      totalTimeoutMs: 5_000,
      maxStreamAttempts: 1,
    })

    const result = await generation.start({
      conversationId,
      clientIdempotencyKey: crypto.randomUUID(),
      message: "  解释深模块。  ",
    })

    expect(result.type).toBe("started")
    if (result.type !== "started") return
    const events = []
    for await (const event of result.events) events.push(event)

    expect(events).toEqual([
      {
        type: "message.created",
        userMessageId: expect.any(String),
        assistantMessageId: expect.any(String),
      },
      { type: "content.delta", delta: "把复杂度" },
      { type: "content.delta", delta: "藏在窄接口后。" },
      {
        type: "usage.snapshot",
        usage: { inputTokens: 7, outputTokens: 9, totalTokens: 16 },
      },
      { type: "message.completed", latencyMs: expect.any(Number) },
    ])
    expect(provider.requests[0]?.messages).toEqual([
      { role: "user", content: "解释深模块。" },
    ])
    const createdEvent = events[0]
    expect(createdEvent?.type).toBe("message.created")
    if (createdEvent?.type !== "message.created") return

    const { data: messages, error } = await dataClient
      .from("messages")
      .select("role,status,content,source_message_id,error_code")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true })
      .order("role", { ascending: true })
    if (error) throw error
    expect(messages).toEqual([
      {
        role: "user",
        status: "completed",
        content: "解释深模块。",
        source_message_id: null,
        error_code: null,
      },
      {
        role: "assistant",
        status: "completed",
        content: "把复杂度藏在窄接口后。",
        source_message_id: createdEvent.userMessageId,
        error_code: null,
      },
    ])
  })

  it("根据持久化的 Conversation 模式稳定拒绝尚未实现的生成路径", async () => {
    const { data: knowledgeBase, error: knowledgeBaseError } = await dataClient
      .from("knowledge_bases")
      .insert({ name: "尚未实现的生成模式" })
      .select("id")
      .single()
    if (knowledgeBaseError) throw knowledgeBaseError
    createdKnowledgeBaseIds.add(knowledgeBase.id)
    const { data: conversation, error: conversationError } = await dataClient
      .from("conversations")
      .insert({
        title: "知识库 Conversation",
        mode: "knowledge_base",
        knowledge_base_id: knowledgeBase.id,
      })
      .select("id")
      .single()
    if (conversationError) throw conversationError
    createdConversationIds.add(conversation.id)
    const provider = new FakeChatProvider(async function* () {
      yield { type: "content.delta", delta: "不应调用" }
    })
    const generation = new AssistantMessageGenerationModule(provider, {
      firstByteTimeoutMs: 1_000,
      idleTimeoutMs: 1_000,
      totalTimeoutMs: 5_000,
      maxStreamAttempts: 1,
    })

    const result = await generation.start({
      conversationId: conversation.id,
      clientIdempotencyKey: crypto.randomUUID(),
      message: "不能绕过持久化模式。",
    })

    expect(result).toEqual({
      type: "unsupported-mode",
      error: {
        code: "UNSUPPORTED_CONVERSATION_MODE",
        message: "该 Conversation 模式暂不支持生成。",
        retryable: false,
      },
    })
    expect(provider.requests).toEqual([])
    const { count, error: messageError } = await dataClient
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("conversation_id", conversation.id)
    if (messageError) throw messageError
    expect(count).toBe(0)
  })

  it("只把同一 Conversation 最近十一条已完成历史和当前 User Message 交给 Provider", async () => {
    const conversationId = await createConversation("上下文选择")
    const otherConversationId = await createConversation("隔离上下文")
    const createdAt = Date.now() - 60_000
    const historicalMessages = Array.from({ length: 13 }, (_, index) => {
      const timestamp = new Date(createdAt + index * 1_000).toISOString()
      return {
        conversation_id: conversationId,
        role: "user",
        content: `历史 Message ${index + 1}`,
        status: "completed",
        client_idempotency_key: crypto.randomUUID(),
        created_at: timestamp,
        updated_at: timestamp,
      }
    })
    const { error: historyError } = await dataClient
      .from("messages")
      .insert(historicalMessages)
    if (historyError) throw historyError
    const { error: isolatedError } = await dataClient.from("messages").insert({
      conversation_id: otherConversationId,
      role: "user",
      content: "另一个 Conversation 的 Message",
      status: "completed",
      client_idempotency_key: crypto.randomUUID(),
    })
    if (isolatedError) throw isolatedError
    const provider = new FakeChatProvider(async function* () {
      yield { type: "content.delta", delta: "上下文正确" }
      yield {
        type: "usage.snapshot",
        usage: { inputTokens: 20, outputTokens: 2, totalTokens: 22 },
      }
    })
    const generation = new AssistantMessageGenerationModule(provider, {
      firstByteTimeoutMs: 1_000,
      idleTimeoutMs: 1_000,
      totalTimeoutMs: 5_000,
      maxStreamAttempts: 1,
    })

    const result = await generation.start({
      conversationId,
      clientIdempotencyKey: crypto.randomUUID(),
      message: "当前 User Message",
    })
    expect(result.type).toBe("started")
    if (result.type !== "started") return
    const events = []
    for await (const event of result.events) events.push(event)

    expect(events.at(-1)?.type).toBe("message.completed")
    expect(provider.requests[0]?.messages).toEqual([
      ...Array.from({ length: 11 }, (_, index) => ({
        role: "user" as const,
        content: `历史 Message ${index + 3}`,
      })),
      { role: "user", content: "当前 User Message" },
    ])
  })

  it("在终态前后重放相同提交并返回已有 Message 与持久化状态", async () => {
    const conversationId = await createConversation("幂等重放")
    const idempotencyKey = crypto.randomUUID()
    const provider = successfulProvider("只生成一次")
    const generation = createGeneration(provider)

    const first = await generation.start({
      conversationId,
      clientIdempotencyKey: idempotencyKey,
      message: "安全重试",
    })
    expect(first.type).toBe("started")
    if (first.type !== "started") return

    const replayWhileStreaming = await generation.start({
      conversationId,
      clientIdempotencyKey: idempotencyKey,
      message: "安全重试",
    })
    expect(replayWhileStreaming).toMatchObject({
      type: "idempotency-replay",
      submission: {
        userMessageId: expect.any(String),
        assistantMessageId: expect.any(String),
        assistantMessageStatus: "streaming",
      },
      error: { code: "IDEMPOTENCY_REPLAY" },
    })
    expect(provider.requests).toHaveLength(0)

    const events = await collectEvents(first.events)
    const created = events[0]
    expect(created?.type).toBe("message.created")
    if (created?.type !== "message.created") return
    expect(replayWhileStreaming).toMatchObject({
      submission: {
        userMessageId: created.userMessageId,
        assistantMessageId: created.assistantMessageId,
      },
    })

    const replayAfterCompletion = await generation.start({
      conversationId,
      clientIdempotencyKey: idempotencyKey,
      message: "安全重试",
    })
    expect(replayAfterCompletion).toEqual({
      type: "idempotency-replay",
      submission: {
        userMessageId: created.userMessageId,
        assistantMessageId: created.assistantMessageId,
        assistantMessageStatus: "completed",
      },
      error: {
        code: "IDEMPOTENCY_REPLAY",
        message: "这条消息已经提交过。",
        retryable: false,
      },
    })
    expect(provider.requests).toHaveLength(1)
  })

  it("拒绝用不同正文复用幂等键且不泄露旧正文或调用 Provider", async () => {
    const conversationId = await createConversation("幂等键正文冲突")
    const idempotencyKey = crypto.randomUUID()
    const provider = successfulProvider("不会重复生成")
    const generation = createGeneration(provider)
    const first = await generation.start({
      conversationId,
      clientIdempotencyKey: idempotencyKey,
      message: "原始正文",
    })
    expect(first.type).toBe("started")
    if (first.type !== "started") return

    const reused = await generation.start({
      conversationId,
      clientIdempotencyKey: idempotencyKey,
      message: "不同正文",
    })

    expect(reused).toEqual({
      type: "idempotency-key-reused",
      userMessageId: expect.any(String),
      error: {
        code: "IDEMPOTENCY_KEY_REUSED",
        message: "该幂等键已用于另一条消息。",
        retryable: false,
      },
    })
    expect(JSON.stringify(reused)).not.toContain("原始正文")
    expect(provider.requests).toHaveLength(0)

    const { data: messages, error } = await dataClient
      .from("messages")
      .select("role,content,status")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true })
      .order("role", { ascending: true })
    if (error) throw error
    expect(messages).toEqual([
      { role: "user", content: "原始正文", status: "completed" },
      { role: "assistant", content: "", status: "streaming" },
    ])

    await collectEvents(first.events)
    expect(provider.requests).toHaveLength(1)
  })

  it("并发提交同一 Conversation 时只启动一个生成并返回活动 Assistant Message", async () => {
    const conversationId = await createConversation("单活动生成")
    const provider = successfulProvider("竞争获胜")
    const generation = createGeneration(provider)

    const results = await Promise.all([
      generation.start({
        conversationId,
        clientIdempotencyKey: crypto.randomUUID(),
        message: "并发消息一",
      }),
      generation.start({
        conversationId,
        clientIdempotencyKey: crypto.randomUUID(),
        message: "并发消息二",
      }),
    ])
    const started = results.find((result) => result.type === "started")
    const conflict = results.find(
      (result) => result.type === "generation-in-progress",
    )

    expect(started?.type).toBe("started")
    expect(conflict).toMatchObject({
      type: "generation-in-progress",
      assistantMessageId: expect.any(String),
      error: { code: "GENERATION_IN_PROGRESS" },
    })
    expect(provider.requests).toHaveLength(0)
    if (started?.type !== "started") return

    const events = await collectEvents(started.events)
    const created = events[0]
    expect(created?.type).toBe("message.created")
    if (created?.type !== "message.created") return
    expect(conflict).toMatchObject({
      assistantMessageId: created.assistantMessageId,
    })
    expect(provider.requests).toHaveLength(1)

    const { count, error } = await dataClient
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("conversation_id", conversationId)
      .eq("role", "assistant")
    if (error) throw error
    expect(count).toBe(1)
  })

  it("允许不同 Conversation 的生成并行进入 Provider", async () => {
    const firstConversationId = await createConversation("并行生成一")
    const secondConversationId = await createConversation("并行生成二")
    let releaseBoth!: () => void
    const bothStarted = new Promise<void>((resolve) => {
      releaseBoth = resolve
    })
    const provider = new FakeChatProvider(async function* () {
      if (provider.requests.length === 2) releaseBoth()
      await bothStarted
      yield { type: "content.delta", delta: "并行完成" }
      yield {
        type: "usage.snapshot",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      }
    })
    const generation = createGeneration(provider)

    const [first, second] = await Promise.all([
      generation.start({
        conversationId: firstConversationId,
        clientIdempotencyKey: crypto.randomUUID(),
        message: "第一条",
      }),
      generation.start({
        conversationId: secondConversationId,
        clientIdempotencyKey: crypto.randomUUID(),
        message: "第二条",
      }),
    ])
    expect(first.type).toBe("started")
    expect(second.type).toBe("started")
    if (first.type !== "started" || second.type !== "started") return

    const [firstEvents, secondEvents] = await Promise.all([
      collectEvents(first.events),
      collectEvents(second.events),
    ])

    expect(provider.requests).toHaveLength(2)
    expect(firstEvents.at(-1)?.type).toBe("message.completed")
    expect(secondEvents.at(-1)?.type).toBe("message.completed")
  })

  it("同实例按 Assistant Message ID 停止时立即取消 Provider 并持久化 cancelled", async () => {
    const conversationId = await createConversation("同实例取消")
    const provider = new FakeChatProvider(async function* (request) {
      yield { type: "content.delta", delta: "停止前正文" }
      await waitForAbort(request.signal)
    })
    const generation = createGeneration(provider)
    const started = await generation.start({
      conversationId,
      clientIdempotencyKey: crypto.randomUUID(),
      message: "请停止这次生成",
    })
    expect(started.type).toBe("started")
    if (started.type !== "started") return

    const stream = await takeUntilContentDelta(started.events)
    const cancelResult = await generation.cancel(stream.assistantMessageId)
    const events = await collectEvents(stream.rest)

    expect(cancelResult).toEqual({ type: "accepted", status: "cancelled" })
    expect(provider.requests[0]?.signal.aborted).toBe(true)
    expect(events.at(-1)).toEqual({ type: "message.cancelled" })
    await expectAssistantStatus(
      stream.assistantMessageId,
      "cancelled",
      "停止前正文",
    )
  })

  it("其他实例可通过数据库状态发现取消并产生 cancelled 终态", async () => {
    const conversationId = await createConversation("跨实例取消")
    const ownerProvider = new FakeChatProvider(async function* (request) {
      yield { type: "content.delta", delta: "跨实例部分正文" }
      await waitForAbort(request.signal)
    })
    const peerProvider = successfulProvider("不会被调用")
    const owner = createGeneration(ownerProvider)
    const peer = createGeneration(peerProvider)
    const started = await owner.start({
      conversationId,
      clientIdempotencyKey: crypto.randomUUID(),
      message: "跨实例停止",
    })
    expect(started.type).toBe("started")
    if (started.type !== "started") return

    const stream = await takeUntilContentDelta(started.events)
    const cancelResult = await peer.cancel(stream.assistantMessageId)
    const events = await collectEvents(stream.rest)

    expect(cancelResult).toEqual({ type: "accepted", status: "cancelled" })
    expect(events.at(-1)).toEqual({ type: "message.cancelled" })
    await expectAssistantStatus(
      stream.assistantMessageId,
      "cancelled",
      "跨实例部分正文",
    )
    expect(peerProvider.requests).toHaveLength(0)
  })

  it("重复停止已取消的 Assistant Message 仍成功且不改写状态", async () => {
    const conversationId = await createConversation("重复取消")
    const provider = new FakeChatProvider(async function* (request) {
      yield { type: "content.delta", delta: "可重复停止" }
      await waitForAbort(request.signal)
    })
    const generation = createGeneration(provider)
    const started = await generation.start({
      conversationId,
      clientIdempotencyKey: crypto.randomUUID(),
      message: "重复停止",
    })
    expect(started.type).toBe("started")
    if (started.type !== "started") return
    const stream = await takeUntilContentDelta(started.events)

    const firstCancel = await generation.cancel(stream.assistantMessageId)
    const secondCancel = await generation.cancel(stream.assistantMessageId)
    await collectEvents(stream.rest)

    expect(firstCancel).toEqual({ type: "accepted", status: "cancelled" })
    expect(secondCancel).toEqual({ type: "accepted", status: "cancelled" })
    await expectAssistantStatus(
      stream.assistantMessageId,
      "cancelled",
      "可重复停止",
    )
  })

  it("停止已完成或已失败的 Assistant Message 返回终态冲突且不改写", async () => {
    const conversationId = await createConversation("终态冲突取消")
    const completedProvider = successfulProvider("已经完成")
    const completedGeneration = createGeneration(completedProvider)
    const completedStart = await completedGeneration.start({
      conversationId,
      clientIdempotencyKey: crypto.randomUUID(),
      message: "完成后停止",
    })
    expect(completedStart.type).toBe("started")
    if (completedStart.type !== "started") return
    const completedEvents = await collectEvents(completedStart.events)
    const completedCreated = completedEvents[0]
    expect(completedCreated?.type).toBe("message.created")
    if (completedCreated?.type !== "message.created") return

    const completedCancel = await completedGeneration.cancel(
      completedCreated.assistantMessageId,
    )
    expect(completedCancel).toEqual({
      type: "terminal-conflict",
      status: "completed",
    })
    await expectAssistantStatus(
      completedCreated.assistantMessageId,
      "completed",
      "已经完成",
    )

    const failedConversationId = await createConversation("失败后取消")
    const failedProvider = new FakeChatProvider(async function* () {
      throw new Error("provider boom")
    })
    const failedGeneration = createGeneration(failedProvider)
    const failedStart = await failedGeneration.start({
      conversationId: failedConversationId,
      clientIdempotencyKey: crypto.randomUUID(),
      message: "失败后停止",
    })
    expect(failedStart.type).toBe("started")
    if (failedStart.type !== "started") return
    const failedEvents = await collectEvents(failedStart.events)
    const failedCreated = failedEvents[0]
    expect(failedCreated?.type).toBe("message.created")
    if (failedCreated?.type !== "message.created") return
    expect(failedEvents.at(-1)?.type).toBe("message.failed")

    const failedCancel = await failedGeneration.cancel(
      failedCreated.assistantMessageId,
    )
    expect(failedCancel).toEqual({
      type: "terminal-conflict",
      status: "failed",
    })
    const { data: failedMessage, error } = await dataClient
      .from("messages")
      .select("status,content,error_code")
      .eq("id", failedCreated.assistantMessageId)
      .single()
    if (error) throw error
    expect(failedMessage).toEqual({
      status: "failed",
      content: "",
      error_code: "PROVIDER_UNAVAILABLE",
    })
  })

  it("停止未知或用户角色 Message 返回未找到", async () => {
    const conversationId = await createConversation("取消目标校验")
    const generation = createGeneration(successfulProvider("不会调用"))
    const { data: userMessage, error } = await dataClient
      .from("messages")
      .insert({
        conversation_id: conversationId,
        role: "user",
        content: "不是助手",
        status: "completed",
        client_idempotency_key: crypto.randomUUID(),
      })
      .select("id")
      .single()
    if (error) throw error

    await expect(
      generation.cancel("00000000-0000-4000-8000-000000000000"),
    ).resolves.toEqual({ type: "not-found" })
    await expect(generation.cancel(userMessage.id)).resolves.toEqual({
      type: "not-found",
    })
  })

  it("完成与取消竞争时只有数据库获胜方决定终态", async () => {
    const conversationId = await createConversation("完成取消竞争")
    let releaseCompletion!: () => void
    const allowCompletion = new Promise<void>((resolve) => {
      releaseCompletion = resolve
    })
    const provider = new FakeChatProvider(async function* () {
      yield { type: "content.delta", delta: "竞争正文" }
      await allowCompletion
      yield {
        type: "usage.snapshot",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      }
    })
    const generation = createGeneration(provider)
    const started = await generation.start({
      conversationId,
      clientIdempotencyKey: crypto.randomUUID(),
      message: "竞争",
    })
    expect(started.type).toBe("started")
    if (started.type !== "started") return
    const stream = await takeUntilContentDelta(started.events)

    const cancelResult = await generation.cancel(stream.assistantMessageId)
    releaseCompletion()
    const events = await collectEvents(stream.rest)

    expect(cancelResult).toEqual({ type: "accepted", status: "cancelled" })
    expect(events.at(-1)).toEqual({ type: "message.cancelled" })
    await expectAssistantStatus(
      stream.assistantMessageId,
      "cancelled",
      "竞争正文",
    )
  })
})

function createGeneration(provider: FakeChatProvider) {
  return new AssistantMessageGenerationModule(provider, {
    firstByteTimeoutMs: 1_000,
    idleTimeoutMs: 1_000,
    totalTimeoutMs: 5_000,
    maxStreamAttempts: 1,
  })
}

function successfulProvider(content: string) {
  return new FakeChatProvider(async function* () {
    yield { type: "content.delta", delta: content }
    yield {
      type: "usage.snapshot",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    }
  })
}

async function collectEvents(
  events: AsyncIterable<AssistantMessageGenerationEvent>,
): Promise<AssistantMessageGenerationEvent[]> {
  const collected: AssistantMessageGenerationEvent[] = []
  for await (const event of events) collected.push(event)
  return collected
}

async function takeUntilContentDelta(
  events: AsyncIterable<AssistantMessageGenerationEvent>,
): Promise<{
  assistantMessageId: string
  rest: AsyncIterable<AssistantMessageGenerationEvent>
}> {
  const iterator = events[Symbol.asyncIterator]()
  let assistantMessageId: string | undefined
  while (true) {
    const next = await iterator.next()
    if (next.done) throw new Error("流在正文前结束")
    if (next.value.type === "message.created") {
      assistantMessageId = next.value.assistantMessageId
      continue
    }
    if (next.value.type === "content.delta") {
      if (assistantMessageId === undefined) {
        throw new Error("未收到 message.created")
      }
      return {
        assistantMessageId,
        rest: prependEvent(next.value, iterator),
      }
    }
  }
}

function prependEvent(
  event: AssistantMessageGenerationEvent,
  iterator: AsyncIterator<AssistantMessageGenerationEvent>,
): AsyncIterable<AssistantMessageGenerationEvent> {
  let first = true
  return {
    [Symbol.asyncIterator]: () => ({
      next: async () => {
        if (first) {
          first = false
          return { done: false as const, value: event }
        }
        return iterator.next()
      },
      return: async (value?: unknown) =>
        iterator.return?.(value) ?? { done: true as const, value },
    }),
  }
}

async function waitForAbort(signal: AbortSignal): Promise<never> {
  if (signal.aborted) {
    throw new DOMException("Chat stream was cancelled", "AbortError")
  }
  await new Promise<void>((_, reject) => {
    signal.addEventListener(
      "abort",
      () => {
        reject(new DOMException("Chat stream was cancelled", "AbortError"))
      },
      { once: true },
    )
  })
  throw new DOMException("Chat stream was cancelled", "AbortError")
}

async function expectAssistantStatus(
  assistantMessageId: string,
  status: "streaming" | "completed" | "cancelled" | "failed",
  content: string,
): Promise<void> {
  const { data, error } = await dataClient
    .from("messages")
    .select("status,content,error_code")
    .eq("id", assistantMessageId)
    .single()
  if (error) throw error
  expect(data).toEqual({
    status,
    content,
    error_code: null,
  })
}

async function createConversation(title: string): Promise<string> {
  const { data, error } = await dataClient
    .from("conversations")
    .insert({ title, mode: "general" })
    .select("id")
    .single()
  if (error) throw error
  createdConversationIds.add(data.id)
  return data.id
}
