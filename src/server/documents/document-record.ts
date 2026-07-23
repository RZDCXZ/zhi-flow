import "server-only"

import type { Document } from "@/lib/knowledge-base-api"

export type DocumentRow = Readonly<{
  id: string
  knowledge_base_id: string
  original_filename: string
  mime_type: string
  byte_size: number
  page_count: number | null
  status: Document["status"]
  current_stage: string
  error_code: string | null
  error_summary: string | null
  created_at: string
  updated_at: string
}>

export const documentColumns =
  "id,knowledge_base_id,original_filename,mime_type,byte_size,page_count,status,current_stage,error_code,error_summary,created_at,updated_at"

export function toDocument(row: DocumentRow): Document {
  return {
    id: row.id,
    knowledgeBaseId: row.knowledge_base_id,
    originalFilename: row.original_filename,
    mimeType: row.mime_type,
    byteSize: row.byte_size,
    pageCount: row.page_count,
    status: row.status,
    currentStage: row.current_stage,
    errorCode: row.error_code,
    errorSummary: row.error_summary,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
