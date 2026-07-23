import "server-only"

import type { Document } from "@/lib/knowledge-base-api"
import { createServerDataClient } from "@/server/supabase"

import {
  documentColumns,
  toDocument,
  type DocumentRow,
} from "./document-record"

const ENQUEUE_ERROR_CODE = "QUEUE_WRITE_FAILED"
const ENQUEUE_ERROR_SUMMARY =
  "Document 已安全保存，但暂时无法写入摄取队列。请手动重新入队。"
const QUEUE_WRITE_ERROR_CODES = new Set(["P0001", "42P01", "42501"])

export type DocumentEnqueueResult = Readonly<{
  document: Document
  outcome: "queued" | "queue_write_failed" | "ineligible"
}>

export async function enqueueDocumentIngestion(
  documentId: string,
): Promise<DocumentEnqueueResult> {
  const client = createServerDataClient()
  const { error } = await client.rpc("enqueue_document_ingestion", {
    target_document_id: documentId,
  })

  if (error === null) {
    return { document: await readDocument(documentId), outcome: "queued" }
  }
  if (error.code === "55000") {
    return { document: await readDocument(documentId), outcome: "ineligible" }
  }
  if (!QUEUE_WRITE_ERROR_CODES.has(error.code)) throw error

  console.error("Document ingestion enqueue failed", {
    documentId,
    category: error.code ?? "UnknownQueueError",
  })
  const { data, error: updateError } = await client
    .from("documents")
    .update({
      status: "uploaded",
      current_stage: "enqueue_failed",
      error_code: ENQUEUE_ERROR_CODE,
      error_summary: ENQUEUE_ERROR_SUMMARY,
      updated_at: new Date().toISOString(),
    })
    .eq("id", documentId)
    .eq("status", "uploaded")
    .select(documentColumns)
    .maybeSingle()
  if (updateError) throw updateError

  if (data !== null) {
    return {
      document: toDocument(data as DocumentRow),
      outcome: "queue_write_failed",
    }
  }
  const currentDocument = await readDocument(documentId)
  return {
    document: currentDocument,
    outcome: currentDocument.status === "queued" ? "queued" : "ineligible",
  }
}

async function readDocument(documentId: string): Promise<Document> {
  const { data, error } = await createServerDataClient()
    .from("documents")
    .select(documentColumns)
    .eq("id", documentId)
    .single()
  if (error) throw error
  return toDocument(data as DocumentRow)
}
