import "server-only"

import type { Conversation, Message } from "@/lib/conversation-api"
import { GENERAL_CHAT_CONTEXT_MESSAGE_LIMIT } from "@/lib/chat-api"
import type { ChatMessage } from "@/server/chat/chat-provider"

import { serverConfig } from "./config"
import { createServerDataClient } from "./supabase"

type ConversationRow = Readonly<{
  id: string
  title: string
  mode: Conversation["mode"]
  knowledge_base_id: string | null
  created_at: string
  updated_at: string
}>

type MessageRow = Readonly<{
  id: string
  conversation_id: string
  role: Message["role"]
  content: string
  status: Message["status"]
  source_message_id: string | null
  error_code: string | null
  created_at: string
  updated_at: string
}>

const conversationColumns =
  "id,title,mode,knowledge_base_id,created_at,updated_at"
const messageColumns =
  "id,conversation_id,role,content,status,source_message_id,error_code,created_at,updated_at"

export async function listConversations(): Promise<Conversation[]> {
  const { data, error } = await createServerDataClient()
    .from("conversations")
    .select(conversationColumns)
    .order("updated_at", { ascending: false })
  if (error) throw error
  return (data as ConversationRow[]).map(toConversation)
}

export async function createConversation(title: string): Promise<Conversation> {
  const { data, error } = await createServerDataClient()
    .from("conversations")
    .insert({ title, mode: "general" })
    .select(conversationColumns)
    .single()
  if (error) throw error
  return toConversation(data as ConversationRow)
}

export async function readChatContext(
  conversationId: string,
): Promise<{ mode: Conversation["mode"]; messages: ChatMessage[] } | null> {
  const client = createServerDataClient()
  const { data: conversation, error: conversationError } = await client
    .from("conversations")
    .select("id,mode")
    .eq("id", conversationId)
    .maybeSingle()
  if (conversationError) throw conversationError
  if (conversation === null) return null
  const mode = conversation.mode as Conversation["mode"]
  if (mode !== "general") return { mode, messages: [] }

  const { data: messages, error: messagesError } = await client
    .from("messages")
    .select("role,content")
    .eq("conversation_id", conversationId)
    .eq("status", "completed")
    .order("created_at", { ascending: false })
    .order("role", { ascending: false })
    .limit(GENERAL_CHAT_CONTEXT_MESSAGE_LIMIT - 1)
  if (messagesError) throw messagesError

  return {
    mode,
    messages: (messages as Array<Pick<MessageRow, "role" | "content">>)
      .reverse()
      .map(({ role, content }) => ({ role, content })),
  }
}

export async function readConversation(
  conversationId: string,
): Promise<{ conversation: Conversation; messages: Message[] } | null> {
  const client = createServerDataClient()
  const { data: conversation, error: conversationError } = await client
    .from("conversations")
    .select(conversationColumns)
    .eq("id", conversationId)
    .maybeSingle()
  if (conversationError) throw conversationError
  if (conversation === null) return null

  const staleBefore = new Date(
    Date.now() - serverConfig.chat.totalTimeoutMs,
  ).toISOString()
  const { error: recoveryError } = await client
    .from("messages")
    .update({
      status: "failed",
      error_code: "STREAM_INTERRUPTED",
      updated_at: new Date().toISOString(),
    })
    .eq("conversation_id", conversationId)
    .eq("role", "assistant")
    .eq("status", "streaming")
    .lt("updated_at", staleBefore)
  if (recoveryError) throw recoveryError

  const { data: messages, error: messagesError } = await client
    .from("messages")
    .select(messageColumns)
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true })
    .order("role", { ascending: true })
  if (messagesError) throw messagesError

  return {
    conversation: toConversation(conversation as ConversationRow),
    messages: (messages as MessageRow[]).map(toMessage),
  }
}

export async function renameConversation(
  conversationId: string,
  title: string,
): Promise<Conversation | null> {
  const { data, error } = await createServerDataClient()
    .from("conversations")
    .update({ title, updated_at: new Date().toISOString() })
    .eq("id", conversationId)
    .select(conversationColumns)
    .maybeSingle()
  if (error) throw error
  return data === null ? null : toConversation(data as ConversationRow)
}

export async function deleteConversation(
  conversationId: string,
): Promise<boolean> {
  const { data, error } = await createServerDataClient()
    .from("conversations")
    .delete()
    .eq("id", conversationId)
    .select("id")
    .maybeSingle()
  if (error) throw error
  return data !== null
}

export type MessageSubmissionResult =
  | Readonly<{
      outcome: "created" | "idempotency-replay"
      userMessageId: string
      assistantMessageId: string
      assistantMessageStatus: Message["status"]
    }>
  | Readonly<{
      outcome: "idempotency-key-reused"
      userMessageId: string
    }>
  | Readonly<{
      outcome: "generation-in-progress"
      assistantMessageId: string
    }>

export async function createMessageSubmission(
  conversationId: string,
  content: string,
  clientIdempotencyKey: string,
): Promise<MessageSubmissionResult> {
  const { data, error } = await createServerDataClient().rpc(
    "create_message_submission",
    {
      target_conversation_id: conversationId,
      user_content: content,
      idempotency_key: clientIdempotencyKey,
    },
  )
  if (error) throw error
  const row = data?.[0] as
    | {
        outcome: string
        user_message_id: string | null
        assistant_message_id: string | null
        assistant_message_status: Message["status"] | null
      }
    | undefined
  if (row === undefined) throw new Error("Message submission was not created")
  if (row.outcome === "idempotency_key_reused") {
    if (row.user_message_id === null) throw invalidMessageSubmissionResult()
    return {
      outcome: "idempotency-key-reused",
      userMessageId: row.user_message_id,
    }
  }
  if (row.outcome === "generation_in_progress") {
    if (row.assistant_message_id === null)
      throw invalidMessageSubmissionResult()
    return {
      outcome: "generation-in-progress",
      assistantMessageId: row.assistant_message_id,
    }
  }
  if (
    (row.outcome !== "created" && row.outcome !== "idempotency_replay") ||
    row.user_message_id === null ||
    row.assistant_message_id === null ||
    row.assistant_message_status === null
  ) {
    throw invalidMessageSubmissionResult()
  }
  return {
    outcome: row.outcome === "created" ? "created" : "idempotency-replay",
    userMessageId: row.user_message_id,
    assistantMessageId: row.assistant_message_id,
    assistantMessageStatus: row.assistant_message_status,
  }
}

function invalidMessageSubmissionResult(): Error {
  return new Error("Message submission returned an invalid result")
}

export async function appendAssistantContent(
  assistantMessageId: string,
  content: string,
): Promise<boolean> {
  const { data, error } = await createServerDataClient()
    .from("messages")
    .update({ content, updated_at: new Date().toISOString() })
    .eq("id", assistantMessageId)
    .eq("role", "assistant")
    .eq("status", "streaming")
    .select("id")
    .maybeSingle()
  if (error) throw error
  return data !== null
}

export async function finishAssistantMessage(
  assistantMessageId: string,
  status: Exclude<Message["status"], "streaming">,
  content: string,
  errorCode: string | null,
): Promise<boolean> {
  const { data, error } = await createServerDataClient()
    .from("messages")
    .update({
      content,
      status,
      error_code: errorCode,
      updated_at: new Date().toISOString(),
    })
    .eq("id", assistantMessageId)
    .eq("role", "assistant")
    .eq("status", "streaming")
    .select("id")
    .maybeSingle()
  if (error) throw error
  return data !== null
}

export async function cancelAssistantMessage(
  assistantMessageId: string,
): Promise<boolean> {
  const { data, error } = await createServerDataClient()
    .from("messages")
    .update({
      status: "cancelled",
      error_code: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", assistantMessageId)
    .eq("role", "assistant")
    .eq("status", "streaming")
    .select("id")
    .maybeSingle()
  if (error) throw error
  return data !== null
}

export async function isAssistantMessageStreaming(
  assistantMessageId: string,
): Promise<boolean> {
  const { data, error } = await createServerDataClient()
    .from("messages")
    .select("id")
    .eq("id", assistantMessageId)
    .eq("role", "assistant")
    .eq("status", "streaming")
    .maybeSingle()
  if (error) throw error
  return data !== null
}

function toConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    title: row.title,
    mode: row.mode,
    knowledgeBaseId: row.knowledge_base_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    content: row.content,
    status: row.status,
    sourceMessageId: row.source_message_id,
    errorCode: row.error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
