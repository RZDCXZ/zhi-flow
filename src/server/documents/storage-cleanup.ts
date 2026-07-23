import "server-only"

import { createServerDataClient } from "@/server/supabase"

const DOCUMENTS_BUCKET = "documents"

type StorageCleanupJob = Readonly<{
  id: string
  knowledge_base_id: string
  storage_prefix: string
}>

export async function prepareDocumentStorageCleanup(
  knowledgeBaseId: string,
): Promise<string> {
  const { data, error } = await createServerDataClient()
    .from("storage_cleanup_jobs")
    .insert({
      knowledge_base_id: knowledgeBaseId,
      bucket: DOCUMENTS_BUCKET,
      storage_prefix: knowledgeBaseId,
    })
    .select("id")
    .single()
  if (error) throw error
  return (data as { id: string }).id
}

export async function cancelDocumentStorageCleanup(
  cleanupJobId: string,
): Promise<void> {
  const { error } = await createServerDataClient()
    .from("storage_cleanup_jobs")
    .delete()
    .eq("id", cleanupJobId)
  if (error) throw error
}

export async function completeDocumentStorageCleanup(
  cleanupJobId: string,
  storagePrefix: string,
): Promise<void> {
  try {
    await deleteDocumentStoragePrefix(storagePrefix)
    await cancelDocumentStorageCleanup(cleanupJobId)
  } catch (error) {
    console.error("Document storage cleanup deferred", {
      cleanupJobId,
      category: error instanceof Error ? error.name : "UnknownError",
    })
  }
}

export async function retryPendingDocumentStorageCleanup(): Promise<void> {
  const client = createServerDataClient()
  const { data, error } = await client
    .from("storage_cleanup_jobs")
    .select("id,knowledge_base_id,storage_prefix")
    .order("created_at", { ascending: true })
    .limit(20)
  if (error) throw error

  for (const job of data as StorageCleanupJob[]) {
    const { data: knowledgeBase, error: knowledgeBaseError } = await client
      .from("knowledge_bases")
      .select("id")
      .eq("id", job.knowledge_base_id)
      .maybeSingle()
    if (knowledgeBaseError) throw knowledgeBaseError
    if (knowledgeBase !== null) {
      await cancelDocumentStorageCleanup(job.id)
      continue
    }
    await completeDocumentStorageCleanup(job.id, job.storage_prefix)
  }
}

async function deleteDocumentStoragePrefix(
  storagePrefix: string,
): Promise<void> {
  const storage = createServerDataClient().storage.from(DOCUMENTS_BUCKET)
  const objectKeys: string[] = []
  let offset = 0

  while (true) {
    const { data, error } = await storage.list(storagePrefix, {
      limit: 100,
      offset,
    })
    if (error) throw error
    objectKeys.push(
      ...data
        .filter(({ id }) => id !== null)
        .map(({ name }) => `${storagePrefix}/${name}`),
    )
    if (data.length < 100) break
    offset += data.length
  }

  if (objectKeys.length === 0) return
  const { error } = await storage.remove(objectKeys)
  if (error) throw error
}
