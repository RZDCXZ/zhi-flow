export type Conversation = Readonly<{
  id: string
  title: string
  mode: "general" | "knowledge_base"
  knowledgeBaseId: string | null
  createdAt: string
  updatedAt: string
}>

export type MessageStatus = "streaming" | "completed" | "cancelled" | "failed"

export type Message = Readonly<{
  id: string
  conversationId: string
  role: "user" | "assistant"
  content: string
  status: MessageStatus
  sourceMessageId: string | null
  errorCode: string | null
  createdAt: string
  updatedAt: string
}>
