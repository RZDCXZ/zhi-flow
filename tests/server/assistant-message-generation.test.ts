import { createClient } from "@supabase/supabase-js"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

import { AssistantMessageGenerationModule } from "../../src/server/chat/assistant-message-generation"
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
})

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
