import "server-only"

import type { Conversation, Message } from "@/lib/conversation-api"

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
