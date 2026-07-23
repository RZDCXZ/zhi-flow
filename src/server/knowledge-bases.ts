import "server-only"

import type { Document, KnowledgeBase } from "@/lib/knowledge-base-api"

import {
  documentColumns,
  toDocument,
  type DocumentRow,
} from "./documents/document-record"
import {
  cancelDocumentStorageCleanup,
  completeDocumentStorageCleanup,
  prepareDocumentStorageCleanup,
  retryPendingDocumentStorageCleanup,
} from "./documents/storage-cleanup"
import { createServerDataClient } from "./supabase"

type KnowledgeBaseRow = Readonly<{
  id: string
  name: string
  created_at: string
  updated_at: string
}>

const knowledgeBaseColumns = "id,name,created_at,updated_at"

export async function listKnowledgeBases(): Promise<KnowledgeBase[]> {
  await retryPendingDocumentStorageCleanup()
  const { data, error } = await createServerDataClient()
    .from("knowledge_bases")
    .select(knowledgeBaseColumns)
    .order("updated_at", { ascending: false })
  if (error) throw error
  return (data as KnowledgeBaseRow[]).map(toKnowledgeBase)
}

export async function createKnowledgeBase(
  name: string,
): Promise<KnowledgeBase> {
  const { data, error } = await createServerDataClient()
    .from("knowledge_bases")
    .insert({ name })
    .select(knowledgeBaseColumns)
    .single()
  if (error) throw error
  return toKnowledgeBase(data as KnowledgeBaseRow)
}

export async function readKnowledgeBase(knowledgeBaseId: string): Promise<{
  knowledgeBase: KnowledgeBase
  documents: Document[]
} | null> {
  const client = createServerDataClient()
  const { data: knowledgeBase, error: knowledgeBaseError } = await client
    .from("knowledge_bases")
    .select(knowledgeBaseColumns)
    .eq("id", knowledgeBaseId)
    .maybeSingle()
  if (knowledgeBaseError) throw knowledgeBaseError
  if (knowledgeBase === null) return null

  const { data: documents, error: documentsError } = await client
    .from("documents")
    .select(documentColumns)
    .eq("knowledge_base_id", knowledgeBaseId)
    .order("created_at", { ascending: false })
  if (documentsError) throw documentsError

  return {
    knowledgeBase: toKnowledgeBase(knowledgeBase as KnowledgeBaseRow),
    documents: (documents as DocumentRow[]).map(toDocument),
  }
}

export async function renameKnowledgeBase(
  knowledgeBaseId: string,
  name: string,
): Promise<KnowledgeBase | null> {
  const { data, error } = await createServerDataClient()
    .from("knowledge_bases")
    .update({ name, updated_at: new Date().toISOString() })
    .eq("id", knowledgeBaseId)
    .select(knowledgeBaseColumns)
    .maybeSingle()
  if (error) throw error
  return data === null ? null : toKnowledgeBase(data as KnowledgeBaseRow)
}

export async function deleteKnowledgeBase(
  knowledgeBaseId: string,
): Promise<boolean> {
  await retryPendingDocumentStorageCleanup()
  const cleanupJobId = await prepareDocumentStorageCleanup(knowledgeBaseId)
  const { data, error } = await createServerDataClient()
    .from("knowledge_bases")
    .delete()
    .eq("id", knowledgeBaseId)
    .select("id")
    .maybeSingle()
  if (error) {
    await cancelDocumentStorageCleanup(cleanupJobId)
    throw error
  }
  if (data === null) {
    await cancelDocumentStorageCleanup(cleanupJobId)
    return false
  }
  await completeDocumentStorageCleanup(cleanupJobId, knowledgeBaseId)
  return true
}

function toKnowledgeBase(row: KnowledgeBaseRow): KnowledgeBase {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
