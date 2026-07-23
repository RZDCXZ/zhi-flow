import { execFileSync } from "node:child_process"

import { createClient } from "@supabase/supabase-js"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

import {
  createDocumentIngestionConsumer,
  DocumentIngestionError,
  type DocumentIngestionJob,
} from "../../src/server/documents/document-ingestion-consumer"

const supabaseUrl = "http://127.0.0.1:54321"
const localServiceRoleKey =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU"
const dataClient = createClient(
  supabaseUrl,
  process.env.ZHI_FLOW_SUPABASE_SECRET_KEY ?? localServiceRoleKey,
  { auth: { autoRefreshToken: false, persistSession: false } },
)
const createdKnowledgeBaseIds = new Set<string>()

beforeEach(() => {
  runDatabaseSql(
    "select pgmq.purge_queue('document_ingestion'); " +
      "select pgmq.purge_queue('document_ingestion_failed');",
  )
})

afterEach(async () => {
  if (createdKnowledgeBaseIds.size > 0) {
    const { error } = await dataClient
      .from("knowledge_bases")
      .delete()
      .in("id", [...createdKnowledgeBaseIds])
    createdKnowledgeBaseIds.clear()
    if (error) throw error
  }
  runDatabaseSql(
    "select pgmq.purge_queue('document_ingestion'); " +
      "select pgmq.purge_queue('document_ingestion_failed');",
  )
})

describe("Document 摄取 Consumer", () => {
  it("通过真实队列处理一条租约消息并持久化成功终态", async () => {
    const documentId = await createQueuedDocument("consumer-success.txt")
    const handledJobs: DocumentIngestionJob[] = []
    const consumer = createDocumentIngestionConsumer({
      supabaseUrl,
      secretKey:
        process.env.ZHI_FLOW_SUPABASE_SECRET_KEY ?? localServiceRoleKey,
      handler: async (job) => {
        handledJobs.push(job)
      },
    })

    await expect(consumer.processOne()).resolves.toMatchObject({
      outcome: "succeeded",
      documentId,
      attemptCount: 1,
    })
    expect(handledJobs).toEqual([
      expect.objectContaining({
        documentId,
        ingestionVersion: 1,
        contentSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        idempotencyKey: expect.stringContaining(`${documentId}:1:`),
      }),
    ])
    await expect(readDocumentState(documentId)).resolves.toMatchObject({
      status: "ready",
      current_stage: "placeholder_completed",
      attempt_count: 1,
      error_code: null,
      error_summary: null,
    })
    expect(
      Number(
        runDatabaseSql(
          "select count(*) from pgmq.a_document_ingestion " +
            `where (message->>'documentId') = '${documentId}';`,
        ),
      ),
    ).toBe(1)
  })

  it("持续运行时逐条报告非 idle 消费结果", async () => {
    const documentId = await createQueuedDocument("consumer-observer.txt")
    const shutdown = new AbortController()
    const observedResults: Array<Record<string, unknown>> = []
    const consumer = createDocumentIngestionConsumer({
      supabaseUrl,
      secretKey:
        process.env.ZHI_FLOW_SUPABASE_SECRET_KEY ?? localServiceRoleKey,
      handler: async () => undefined,
    })

    await consumer.runUntilStopped(shutdown.signal, (result) => {
      observedResults.push(result)
      shutdown.abort()
    })

    expect(observedResults).toEqual([
      expect.objectContaining({
        outcome: "succeeded",
        documentId,
        attemptCount: 1,
      }),
    ])
  })

  it("短暂错误按退避延后消息可见性并保留可解释状态", async () => {
    const documentId = await createQueuedDocument("consumer-retry.txt")
    const consumer = createDocumentIngestionConsumer({
      supabaseUrl,
      secretKey:
        process.env.ZHI_FLOW_SUPABASE_SECRET_KEY ?? localServiceRoleKey,
      handler: async () => {
        throw new DocumentIngestionError(
          "PLACEHOLDER_TRANSIENT",
          "占位处理器模拟短暂错误。",
          true,
        )
      },
      retryDelaySeconds: () => 30,
    })
    const beforeProcessing = Date.now()

    await expect(consumer.processOne()).resolves.toMatchObject({
      outcome: "retried",
      documentId,
      attemptCount: 1,
      errorCode: "PLACEHOLDER_TRANSIENT",
      visibleAt: expect.any(String),
    })
    await expect(readDocumentState(documentId)).resolves.toMatchObject({
      status: "queued",
      current_stage: "retry_wait",
      attempt_count: 1,
      error_code: "PLACEHOLDER_TRANSIENT",
      error_summary: "占位处理器模拟短暂错误。",
    })
    const queueState = JSON.parse(
      runDatabaseSql(
        "select jsonb_build_object(" +
          "'visibleAt', vt, 'readCount', read_ct)::text " +
          "from pgmq.q_document_ingestion " +
          `where (message->>'documentId') = '${documentId}';`,
      ),
    ) as { visibleAt: string; readCount: number }
    expect(queueState.readCount).toBe(1)
    expect(new Date(queueState.visibleAt).getTime()).toBeGreaterThan(
      beforeProcessing + 20_000,
    )
    expect(
      Number(
        runDatabaseSql(
          "select count(*) from pgmq.a_document_ingestion " +
            `where (message->>'documentId') = '${documentId}';`,
        ),
      ),
    ).toBe(0)
  })

  it("永久错误立即标记失败并原子写入失败队列", async () => {
    const documentId = await createQueuedDocument("consumer-permanent.txt")
    const consumer = createDocumentIngestionConsumer({
      supabaseUrl,
      secretKey:
        process.env.ZHI_FLOW_SUPABASE_SECRET_KEY ?? localServiceRoleKey,
      handler: async () => {
        throw new DocumentIngestionError(
          "PLACEHOLDER_PERMANENT",
          "占位处理器模拟永久错误。",
          false,
        )
      },
    })

    await expect(consumer.processOne()).resolves.toMatchObject({
      outcome: "failed",
      documentId,
      attemptCount: 1,
      errorCode: "PLACEHOLDER_PERMANENT",
      failureQueueMessageId: expect.any(Number),
    })
    await expect(readDocumentState(documentId)).resolves.toMatchObject({
      status: "failed",
      current_stage: "failed",
      attempt_count: 1,
      error_code: "PLACEHOLDER_PERMANENT",
      error_summary: "占位处理器模拟永久错误。",
    })
    const failurePayload = JSON.parse(
      runDatabaseSql(
        "select message::text from pgmq.q_document_ingestion_failed " +
          `where (message->>'documentId') = '${documentId}';`,
      ),
    ) as Record<string, unknown>
    expect(failurePayload).toMatchObject({
      documentId,
      ingestionVersion: 1,
      attemptCount: 1,
      errorCode: "PLACEHOLDER_PERMANENT",
      errorSummary: "占位处理器模拟永久错误。",
      failedAt: expect.any(String),
    })
    expect(
      Number(
        runDatabaseSql(
          "select count(*) from public.document_ingestion_failures " +
            `where document_id = '${documentId}' ` +
            "and error_code = 'PLACEHOLDER_PERMANENT';",
        ),
      ),
    ).toBe(1)
  })

  it("短暂错误最多尝试五次，耗尽后只归档一次", async () => {
    const documentId = await createQueuedDocument("consumer-exhausted.txt")
    let handlerCalls = 0
    const consumer = createDocumentIngestionConsumer({
      supabaseUrl,
      secretKey:
        process.env.ZHI_FLOW_SUPABASE_SECRET_KEY ?? localServiceRoleKey,
      handler: async () => {
        handlerCalls += 1
        throw new DocumentIngestionError(
          "PLACEHOLDER_TRANSIENT",
          "占位处理器持续失败。",
          true,
        )
      },
      retryDelaySeconds: () => 0,
    })

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await expect(consumer.processOne()).resolves.toMatchObject({
        outcome: "retried",
        documentId,
        attemptCount: attempt,
      })
    }
    await expect(consumer.processOne()).resolves.toMatchObject({
      outcome: "failed",
      documentId,
      attemptCount: 5,
      errorCode: "PLACEHOLDER_TRANSIENT",
    })

    expect(handlerCalls).toBe(5)
    await expect(readDocumentState(documentId)).resolves.toMatchObject({
      status: "failed",
      attempt_count: 5,
      error_code: "PLACEHOLDER_TRANSIENT",
    })
    expect(
      Number(
        runDatabaseSql(
          "select count(*) from public.document_ingestion_failures " +
            `where document_id = '${documentId}';`,
        ),
      ),
    ).toBe(1)
  })

  it("任务超过总时限时中止处理信号并进入重试", async () => {
    const documentId = await createQueuedDocument("consumer-timeout.txt")
    let handlerSignal: AbortSignal | undefined
    const consumer = createDocumentIngestionConsumer({
      supabaseUrl,
      secretKey:
        process.env.ZHI_FLOW_SUPABASE_SECRET_KEY ?? localServiceRoleKey,
      handler: async (_job, context) => {
        handlerSignal = context.signal
        await new Promise<void>(() => undefined)
      },
      taskTimeoutMs: 10,
      retryDelaySeconds: () => 0,
    })

    await expect(consumer.processOne()).resolves.toMatchObject({
      outcome: "retried",
      documentId,
      attemptCount: 1,
      errorCode: "INGESTION_TASK_TIMEOUT",
    })
    expect(handlerSignal?.aborted).toBe(true)
    await expect(readDocumentState(documentId)).resolves.toMatchObject({
      status: "queued",
      current_stage: "retry_wait",
      error_code: "INGESTION_TASK_TIMEOUT",
      error_summary: "Document 摄取超过任务时限，将自动重试。",
    })
  })

  it("进程在认领后崩溃时由租约过期恢复同一消息", async () => {
    const documentId = await createQueuedDocument("consumer-crash.txt")
    const leased = JSON.parse(
      runDatabaseSql(
        "select jsonb_build_object(" +
          "'queueMessageId', msg_id, 'body', message)::text " +
          "from pgmq.read('document_ingestion', 1, 1);",
      ),
    ) as {
      queueMessageId: number
      body: DocumentIngestionJob
    }
    runDatabaseSql(
      "select outcome from public.claim_document_ingestion(" +
        `${leased.queueMessageId}, ` +
        `'${leased.body.documentId}', ` +
        `${leased.body.ingestionVersion}, ` +
        `'${leased.body.contentSha256}', ` +
        `'${leased.body.idempotencyKey}', ` +
        "5);",
    )
    await expect(readDocumentState(documentId)).resolves.toMatchObject({
      status: "processing",
      attempt_count: 1,
    })

    await new Promise((resolve) => setTimeout(resolve, 1_100))
    let handlerCalls = 0
    const recoveringConsumer = createDocumentIngestionConsumer({
      supabaseUrl,
      secretKey:
        process.env.ZHI_FLOW_SUPABASE_SECRET_KEY ?? localServiceRoleKey,
      handler: async () => {
        handlerCalls += 1
      },
      visibilityTimeoutSeconds: 1,
    })

    await expect(recoveringConsumer.processOne()).resolves.toMatchObject({
      outcome: "succeeded",
      queueMessageId: leased.queueMessageId,
      documentId,
      attemptCount: 2,
    })
    expect(handlerCalls).toBe(1)
    await expect(readDocumentState(documentId)).resolves.toMatchObject({
      status: "ready",
      attempt_count: 2,
    })
  })

  it("连续五次崩溃后第六次领取只归档而不再执行处理器", async () => {
    const documentId = await createQueuedDocument("consumer-crash-limit.txt")
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const leased = leaseMessageImmediately()
      const { data, error } = await dataClient.rpc("claim_document_ingestion", {
        source_queue_message_id: leased.queueMessageId,
        target_document_id: leased.body.documentId,
        target_ingestion_version: leased.body.ingestionVersion,
        target_content_sha256: leased.body.contentSha256,
        target_idempotency_key: leased.body.idempotencyKey,
        maximum_attempts: 5,
      })
      if (error) throw error
      expect(data).toEqual([
        expect.objectContaining({
          outcome: "claimed",
          attempt_count: attempt,
          claim_id: expect.any(String),
        }),
      ])
    }
    let handlerCalls = 0
    const recoveringConsumer = createDocumentIngestionConsumer({
      supabaseUrl,
      secretKey:
        process.env.ZHI_FLOW_SUPABASE_SECRET_KEY ?? localServiceRoleKey,
      handler: async () => {
        handlerCalls += 1
      },
      retryDelaySeconds: () => 0,
    })

    await expect(recoveringConsumer.processOne()).resolves.toMatchObject({
      outcome: "failed",
      documentId,
      attemptCount: 5,
      errorCode: "INGESTION_ATTEMPTS_EXHAUSTED",
    })
    expect(handlerCalls).toBe(0)
    await expect(readDocumentState(documentId)).resolves.toMatchObject({
      status: "failed",
      attempt_count: 5,
      error_code: "INGESTION_ATTEMPTS_EXHAUSTED",
    })
  })

  it("租约过期后的新 claim 阻止旧 Consumer 提交有效终态", async () => {
    const documentId = await createQueuedDocument("consumer-fencing.txt")
    let releaseOldHandler: (() => void) | undefined
    let markOldHandlerEntered: (() => void) | undefined
    const oldHandlerEntered = new Promise<void>((resolve) => {
      markOldHandlerEntered = resolve
    })
    const oldHandlerReleased = new Promise<void>((resolve) => {
      releaseOldHandler = resolve
    })
    const claimIds: string[] = []
    const oldConsumer = createDocumentIngestionConsumer({
      supabaseUrl,
      secretKey:
        process.env.ZHI_FLOW_SUPABASE_SECRET_KEY ?? localServiceRoleKey,
      visibilityTimeoutSeconds: 1,
      handler: async (_job, context) => {
        claimIds.push(context.claimId)
        markOldHandlerEntered?.()
        await oldHandlerReleased
      },
    })
    const newConsumer = createDocumentIngestionConsumer({
      supabaseUrl,
      secretKey:
        process.env.ZHI_FLOW_SUPABASE_SECRET_KEY ?? localServiceRoleKey,
      visibilityTimeoutSeconds: 1,
      handler: async (_job, context) => {
        claimIds.push(context.claimId)
      },
    })

    const oldResult = oldConsumer.processOne()
    await oldHandlerEntered
    await new Promise((resolve) => setTimeout(resolve, 1_100))
    await expect(newConsumer.processOne()).resolves.toMatchObject({
      outcome: "succeeded",
      documentId,
      attemptCount: 2,
    })
    releaseOldHandler?.()
    await expect(oldResult).resolves.toMatchObject({
      outcome: "superseded",
      documentId,
      attemptCount: 1,
    })

    expect(claimIds).toHaveLength(2)
    expect(new Set(claimIds).size).toBe(2)
    await expect(readDocumentState(documentId)).resolves.toMatchObject({
      status: "ready",
      attempt_count: 2,
    })
  })

  it("两个 Consumer 竞争同一消息且重复交付只产生一个有效结果", async () => {
    const documentId = await createQueuedDocument("consumer-race.txt")
    let releaseHandler: (() => void) | undefined
    let markHandlerEntered: (() => void) | undefined
    const handlerEntered = new Promise<void>((resolve) => {
      markHandlerEntered = resolve
    })
    const handlerReleased = new Promise<void>((resolve) => {
      releaseHandler = resolve
    })
    let handlerCalls = 0
    let handledJob: DocumentIngestionJob | undefined
    const handler = async (job: DocumentIngestionJob) => {
      handlerCalls += 1
      handledJob = job
      markHandlerEntered?.()
      await handlerReleased
    }
    const firstConsumer = createDocumentIngestionConsumer({
      supabaseUrl,
      secretKey:
        process.env.ZHI_FLOW_SUPABASE_SECRET_KEY ?? localServiceRoleKey,
      handler,
    })
    const secondConsumer = createDocumentIngestionConsumer({
      supabaseUrl,
      secretKey:
        process.env.ZHI_FLOW_SUPABASE_SECRET_KEY ?? localServiceRoleKey,
      handler,
    })

    const firstResult = firstConsumer.processOne()
    await handlerEntered
    await expect(secondConsumer.processOne()).resolves.toEqual({
      outcome: "idle",
    })
    releaseHandler?.()
    await expect(firstResult).resolves.toMatchObject({
      outcome: "succeeded",
      documentId,
      attemptCount: 1,
    })

    expect(handledJob).toBeDefined()
    runDatabaseSql(
      "select pgmq.send('document_ingestion', " +
        `'${JSON.stringify(handledJob)}'::jsonb);`,
    )
    await expect(secondConsumer.processOne()).resolves.toMatchObject({
      outcome: "skipped",
      documentId,
      attemptCount: 1,
    })

    expect(handlerCalls).toBe(1)
    await expect(readDocumentState(documentId)).resolves.toMatchObject({
      status: "ready",
      attempt_count: 1,
    })
    expect(
      Number(
        runDatabaseSql(
          "select count(*) from pgmq.a_document_ingestion " +
            `where (message->>'documentId') = '${documentId}';`,
        ),
      ),
    ).toBe(2)
  })

  it("无效队列消息进入失败队列而不会静默丢失", async () => {
    const sourceQueueMessageId = Number(
      runDatabaseSql(
        "select pgmq.send(" +
          "'document_ingestion', " +
          '\'{"documentId":"not-a-uuid","secret":"must-not-copy"}\'::jsonb' +
          ");",
      ),
    )
    const consumer = createDocumentIngestionConsumer({
      supabaseUrl,
      secretKey:
        process.env.ZHI_FLOW_SUPABASE_SECRET_KEY ?? localServiceRoleKey,
      handler: async () => {
        throw new Error("无效消息不应进入处理器")
      },
    })

    await expect(consumer.processOne()).resolves.toMatchObject({
      outcome: "invalid",
      queueMessageId: sourceQueueMessageId,
      attemptCount: 0,
      errorCode: "INVALID_QUEUE_MESSAGE",
      failureQueueMessageId: expect.any(Number),
    })
    const failurePayload = runDatabaseSql(
      "select message::text from pgmq.q_document_ingestion_failed " +
        `where (message->>'sourceQueueMessageId')::bigint = ${sourceQueueMessageId};`,
    )
    expect(JSON.parse(failurePayload)).toMatchObject({
      sourceQueueMessageId,
      attemptCount: 0,
      errorCode: "INVALID_QUEUE_MESSAGE",
    })
    expect(failurePayload).not.toContain("must-not-copy")
  })

  it("队列重建后复用消息 ID 时仍以 Document 幂等键区分", async () => {
    const oldDocumentId = await createQueuedDocument("before-recreate.txt")
    const oldMessageId = Number(
      runDatabaseSql(
        "select queue_message_id from public.document_ingestion_enqueues " +
          `where document_id = '${oldDocumentId}';`,
      ),
    )
    const newDocumentId = await createQueuedDocument("after-recreate.txt")
    runDatabaseSql(
      "update public.document_ingestion_enqueues " +
        `set queue_message_id = ${oldMessageId} ` +
        `where document_id = '${newDocumentId}';`,
    )
    expect(
      Number(
        runDatabaseSql(
          "select count(*) from public.document_ingestion_enqueues " +
            `where queue_message_id = ${oldMessageId};`,
        ),
      ),
    ).toBe(2)

    const consumer = createDocumentIngestionConsumer({
      supabaseUrl,
      secretKey:
        process.env.ZHI_FLOW_SUPABASE_SECRET_KEY ?? localServiceRoleKey,
      handler: async () => undefined,
    })
    await expect(consumer.processOne()).resolves.toMatchObject({
      outcome: "succeeded",
      documentId: oldDocumentId,
    })
    await expect(consumer.processOne()).resolves.toMatchObject({
      outcome: "succeeded",
      documentId: newDocumentId,
    })
    await expect(readDocumentState(newDocumentId)).resolves.toMatchObject({
      status: "ready",
      attempt_count: 1,
    })
  })
})

async function createQueuedDocument(filename: string): Promise<string> {
  const { data: knowledgeBase, error: knowledgeBaseError } = await dataClient
    .from("knowledge_bases")
    .insert({ name: `Consumer 测试 ${crypto.randomUUID()}` })
    .select("id")
    .single()
  if (knowledgeBaseError) throw knowledgeBaseError
  createdKnowledgeBaseIds.add(knowledgeBase.id)

  const sha256 = crypto
    .randomUUID()
    .replaceAll("-", "")
    .padEnd(64, "0")
    .slice(0, 64)
  const { data: document, error: documentError } = await dataClient
    .from("documents")
    .insert({
      knowledge_base_id: knowledgeBase.id,
      original_filename: filename,
      storage_object_key: `${knowledgeBase.id}/${filename}`,
      mime_type: "text/plain",
      byte_size: 12,
      sha256,
      status: "uploaded",
      current_stage: "stored",
    })
    .select("id")
    .single()
  if (documentError) throw documentError
  const { error: enqueueError } = await dataClient.rpc(
    "enqueue_document_ingestion",
    { target_document_id: document.id },
  )
  if (enqueueError) throw enqueueError
  return document.id
}

async function readDocumentState(documentId: string) {
  const { data, error } = await dataClient
    .from("documents")
    .select("status,current_stage,attempt_count,error_code,error_summary")
    .eq("id", documentId)
    .single()
  if (error) throw error
  return data
}

function runDatabaseSql(sql: string): string {
  return execFileSync(
    "docker",
    [
      "exec",
      "supabase_db_zhi-flow",
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
      "-At",
      "-c",
      sql,
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  ).trim()
}

function leaseMessageImmediately(): {
  queueMessageId: number
  body: DocumentIngestionJob
} {
  return JSON.parse(
    runDatabaseSql(
      "select jsonb_build_object(" +
        "'queueMessageId', msg_id, 'body', message)::text " +
        "from pgmq.read('document_ingestion', 0, 1);",
    ),
  ) as {
    queueMessageId: number
    body: DocumentIngestionJob
  }
}
