export type KnowledgeBase = Readonly<{
  id: string
  name: string
  createdAt: string
  updatedAt: string
}>

export type DocumentStatus =
  "uploaded" | "queued" | "processing" | "ready" | "failed" | "archived"

export type Document = Readonly<{
  id: string
  knowledgeBaseId: string
  originalFilename: string
  mimeType: string
  byteSize: number
  pageCount: number | null
  status: DocumentStatus
  currentStage: string
  errorCode: string | null
  errorSummary: string | null
  createdAt: string
  updatedAt: string
}>
