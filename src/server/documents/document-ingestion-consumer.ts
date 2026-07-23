import { createClient, type SupabaseClient } from "@supabase/supabase-js"

import { DOCUMENT_INGESTION_CONSUMER_DEFAULTS } from "../../lib/document-ingestion-policy"

const MAX_RETRY_DELAY_SECONDS = 5 * 60

export type DocumentIngestionJob = Readonly<{
  documentId: string
  ingestionVersion: number
  contentSha256: string
  idempotencyKey: string
}>

/**
 * 持久化业务输出时必须在同一事务中校验 claimId；AbortSignal 只负责协作取消，
 * 不能替代旧租约持有者的 fencing。
 */
export type DocumentIngestionHandler = (
  job: DocumentIngestionJob,
  context: Readonly<{ signal: AbortSignal; claimId: string }>,
) => Promise<void>

export class DocumentIngestionError extends Error {
  constructor(
    readonly code: string,
    readonly safeSummary: string,
    readonly retryable: boolean,
  ) {
    super(safeSummary)
    this.name = "DocumentIngestionError"
  }
}

export type DocumentIngestionResult =
  | Readonly<{ outcome: "idle" }>
  | Readonly<{
      outcome: "succeeded" | "skipped" | "superseded"
      queueMessageId: number
      documentId: string
      attemptCount: number
    }>
  | Readonly<{
      outcome: "retried"
      queueMessageId: number
      documentId: string
      attemptCount: number
      errorCode: string
      visibleAt: string
    }>
  | Readonly<{
      outcome: "failed" | "invalid"
      queueMessageId: number
      documentId?: string
      attemptCount: number
      errorCode: string
      failureQueueMessageId: number
    }>

export type DocumentIngestionResultObserver = (
  result: Exclude<DocumentIngestionResult, Readonly<{ outcome: "idle" }>>,
) => void

type ConsumerOptions = Readonly<{
  supabaseUrl: string
  secretKey: string
  handler: DocumentIngestionHandler
  visibilityTimeoutSeconds?: number
  taskTimeoutMs?: number
  maxAttempts?: number
  pollIntervalMs?: number
  retryDelaySeconds?: (attemptCount: number) => number
  random?: () => number
}>

type LeasedMessage = Readonly<{
  queueMessageId: number
  readCount: number
  visibleAt: string
  body: unknown
}>

export function createDocumentIngestionConsumer(options: ConsumerOptions) {
  const visibilityTimeoutSeconds =
    options.visibilityTimeoutSeconds ??
    DOCUMENT_INGESTION_CONSUMER_DEFAULTS.visibilityTimeoutSeconds
  const taskTimeoutMs =
    options.taskTimeoutMs ?? DOCUMENT_INGESTION_CONSUMER_DEFAULTS.taskTimeoutMs
  const maxAttempts =
    options.maxAttempts ?? DOCUMENT_INGESTION_CONSUMER_DEFAULTS.maxAttempts
  const pollIntervalMs =
    options.pollIntervalMs ??
    DOCUMENT_INGESTION_CONSUMER_DEFAULTS.pollIntervalMs
  assertPositiveInteger(visibilityTimeoutSeconds, "visibilityTimeoutSeconds")
  assertPositiveInteger(taskTimeoutMs, "taskTimeoutMs")
  assertPositiveInteger(maxAttempts, "maxAttempts")
  assertPositiveInteger(pollIntervalMs, "pollIntervalMs")

  const client = createClient(options.supabaseUrl, options.secretKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const retryDelaySeconds =
    options.retryDelaySeconds ??
    ((attemptCount: number) =>
      calculateRetryDelaySeconds(attemptCount, options.random ?? Math.random))

  async function processOne(): Promise<DocumentIngestionResult> {
    const leasedMessage = await leaseMessage(client, visibilityTimeoutSeconds)
    if (leasedMessage === null) return { outcome: "idle" }

    const job = parseJob(leasedMessage.body)
    if (job === null) {
      const failureQueueMessageId = await archiveInvalidMessage(
        client,
        leasedMessage.queueMessageId,
      )
      return {
        outcome: "invalid",
        queueMessageId: leasedMessage.queueMessageId,
        attemptCount: 0,
        errorCode: "INVALID_QUEUE_MESSAGE",
        failureQueueMessageId,
      }
    }

    const claim = await claimMessage(
      client,
      leasedMessage.queueMessageId,
      job,
      maxAttempts,
    )
    if (claim.outcome === "skipped") {
      return {
        outcome: "skipped",
        queueMessageId: leasedMessage.queueMessageId,
        documentId: job.documentId,
        attemptCount: claim.attemptCount,
      }
    }
    if (claim.claimId === null) {
      throw new Error("Document 摄取认领缺少 claim ID")
    }
    const claimId = claim.claimId
    if (claim.outcome === "exhausted") {
      const failure = {
        code: "INGESTION_ATTEMPTS_EXHAUSTED",
        summary: `Document 摄取已耗尽 ${maxAttempts} 次尝试，任务已归档。`,
        retryable: false,
      }
      const failureQueueMessageId = await failMessage(
        client,
        leasedMessage.queueMessageId,
        job,
        claimId,
        failure,
      )
      if (failureQueueMessageId === null) {
        return supersededResult(leasedMessage, job, claim.attemptCount)
      }
      return {
        outcome: "failed",
        queueMessageId: leasedMessage.queueMessageId,
        documentId: job.documentId,
        attemptCount: claim.attemptCount,
        errorCode: failure.code,
        failureQueueMessageId,
      }
    }

    let processingFailed = false
    let processingError: unknown
    try {
      await runWithTimeout(options.handler, job, claimId, taskTimeoutMs)
    } catch (error) {
      processingFailed = true
      processingError = error
    }

    if (!processingFailed) {
      const completed = await completeMessage(
        client,
        leasedMessage.queueMessageId,
        job.documentId,
        claimId,
      )
      if (!completed) {
        return supersededResult(leasedMessage, job, claim.attemptCount)
      }
      return {
        outcome: "succeeded",
        queueMessageId: leasedMessage.queueMessageId,
        documentId: job.documentId,
        attemptCount: claim.attemptCount,
      }
    }

    const failure = toSafeFailure(processingError)
    if (failure.retryable && claim.attemptCount < maxAttempts) {
      const delaySeconds = retryDelaySeconds(claim.attemptCount)
      assertNonNegativeInteger(delaySeconds, "retryDelaySeconds result")
      const visibleAt = await retryMessage(
        client,
        leasedMessage.queueMessageId,
        job.documentId,
        claimId,
        delaySeconds,
        failure,
      )
      if (visibleAt === null) {
        return supersededResult(leasedMessage, job, claim.attemptCount)
      }
      return {
        outcome: "retried",
        queueMessageId: leasedMessage.queueMessageId,
        documentId: job.documentId,
        attemptCount: claim.attemptCount,
        errorCode: failure.code,
        visibleAt,
      }
    }

    const failureQueueMessageId = await failMessage(
      client,
      leasedMessage.queueMessageId,
      job,
      claimId,
      failure,
    )
    if (failureQueueMessageId === null) {
      return supersededResult(leasedMessage, job, claim.attemptCount)
    }
    return {
      outcome: "failed",
      queueMessageId: leasedMessage.queueMessageId,
      documentId: job.documentId,
      attemptCount: claim.attemptCount,
      errorCode: failure.code,
      failureQueueMessageId,
    }
  }

  async function runUntilStopped(
    signal: AbortSignal,
    observeResult?: DocumentIngestionResultObserver,
  ): Promise<void> {
    while (!signal.aborted) {
      const result = await processOne()
      if (result.outcome !== "idle") {
        observeResult?.(result)
        continue
      }
      await waitForNextPoll(pollIntervalMs, signal)
    }
  }

  return Object.freeze({ processOne, runUntilStopped })
}

function calculateRetryDelaySeconds(
  attemptCount: number,
  random: () => number,
): number {
  const exponentialDelay = Math.min(
    MAX_RETRY_DELAY_SECONDS,
    5 * 2 ** Math.max(0, attemptCount - 1),
  )
  const jitterMultiplier = 0.75 + Math.min(1, Math.max(0, random())) * 0.5
  return Math.max(1, Math.round(exponentialDelay * jitterMultiplier))
}

function supersededResult(
  leasedMessage: LeasedMessage,
  job: DocumentIngestionJob,
  attemptCount: number,
): DocumentIngestionResult {
  return {
    outcome: "superseded",
    queueMessageId: leasedMessage.queueMessageId,
    documentId: job.documentId,
    attemptCount,
  }
}

async function leaseMessage(
  client: SupabaseClient,
  visibilityTimeoutSeconds: number,
): Promise<LeasedMessage | null> {
  const { data, error } = await client.rpc("lease_document_ingestion", {
    visibility_timeout_seconds: visibilityTimeoutSeconds,
  })
  if (error) throw error
  const row = firstRow(data)
  if (row === null) return null
  return {
    queueMessageId: Number(row.queue_message_id),
    readCount: Number(row.read_count),
    visibleAt: String(row.visible_at),
    body: row.message_body,
  }
}

async function claimMessage(
  client: SupabaseClient,
  queueMessageId: number,
  job: DocumentIngestionJob,
  maxAttempts: number,
): Promise<
  Readonly<{
    outcome: "claimed" | "skipped" | "exhausted"
    attemptCount: number
    claimId: string | null
  }>
> {
  const { data, error } = await client.rpc("claim_document_ingestion", {
    source_queue_message_id: queueMessageId,
    target_document_id: job.documentId,
    target_ingestion_version: job.ingestionVersion,
    target_content_sha256: job.contentSha256,
    target_idempotency_key: job.idempotencyKey,
    maximum_attempts: maxAttempts,
  })
  if (error) throw error
  const row = firstRow(data)
  if (
    row === null ||
    (row.outcome !== "claimed" &&
      row.outcome !== "skipped" &&
      row.outcome !== "exhausted")
  ) {
    throw new Error("Document 摄取认领返回了无效结果")
  }
  const claimId = typeof row.claim_id === "string" ? row.claim_id : null
  if (row.outcome !== "skipped" && claimId === null) {
    throw new Error("Document 摄取认领缺少 claim ID")
  }
  return {
    outcome: row.outcome,
    attemptCount: Number(row.attempt_count),
    claimId,
  }
}

async function completeMessage(
  client: SupabaseClient,
  queueMessageId: number,
  documentId: string,
  claimId: string,
): Promise<boolean> {
  const { data, error } = await client.rpc("complete_document_ingestion", {
    source_queue_message_id: queueMessageId,
    target_document_id: documentId,
    target_claim_id: claimId,
  })
  if (error) throw error
  if (typeof data !== "boolean")
    throw new Error("Document 摄取成功终态返回了无效结果")
  return data
}

async function retryMessage(
  client: SupabaseClient,
  queueMessageId: number,
  documentId: string,
  claimId: string,
  delaySeconds: number,
  failure: SafeFailure,
): Promise<string | null> {
  const { data, error } = await client.rpc("retry_document_ingestion", {
    source_queue_message_id: queueMessageId,
    target_document_id: documentId,
    target_claim_id: claimId,
    retry_delay_seconds: delaySeconds,
    stable_error_code: failure.code,
    safe_error_summary: failure.summary,
  })
  if (error) throw error
  if (data === null) return null
  if (typeof data !== "string") {
    throw new Error("Document 摄取重试可见时间未能持久化")
  }
  return data
}

async function failMessage(
  client: SupabaseClient,
  queueMessageId: number,
  job: DocumentIngestionJob,
  claimId: string,
  failure: SafeFailure,
): Promise<number | null> {
  const { data, error } = await client.rpc("fail_document_ingestion", {
    source_queue_message_id: queueMessageId,
    target_document_id: job.documentId,
    target_claim_id: claimId,
    target_ingestion_version: job.ingestionVersion,
    target_idempotency_key: job.idempotencyKey,
    stable_error_code: failure.code,
    safe_error_summary: failure.summary,
  })
  if (error) throw error
  if (data === null) return null
  if (typeof data !== "number") {
    throw new Error("Document 摄取失败任务未能归档")
  }
  return data
}

async function archiveInvalidMessage(
  client: SupabaseClient,
  queueMessageId: number,
): Promise<number> {
  const { data, error } = await client.rpc(
    "archive_invalid_document_ingestion",
    { source_queue_message_id: queueMessageId },
  )
  if (error) throw error
  if (typeof data !== "number") {
    throw new Error("无效 Document 摄取消息未能归档")
  }
  return data
}

function parseJob(body: unknown): DocumentIngestionJob | null {
  if (!isRecord(body)) return null
  const documentId = body.documentId
  const ingestionVersion = body.ingestionVersion
  const contentSha256 = body.contentSha256
  const idempotencyKey = body.idempotencyKey
  if (
    typeof documentId !== "string" ||
    !isUuid(documentId) ||
    typeof ingestionVersion !== "number" ||
    !Number.isInteger(ingestionVersion) ||
    ingestionVersion <= 0 ||
    typeof contentSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(contentSha256) ||
    typeof idempotencyKey !== "string" ||
    idempotencyKey !== `${documentId}:${ingestionVersion}:${contentSha256}`
  ) {
    return null
  }
  return { documentId, ingestionVersion, contentSha256, idempotencyKey }
}

type SafeFailure = Readonly<{
  code: string
  summary: string
  retryable: boolean
}>

function toSafeFailure(error: unknown): SafeFailure {
  if (error instanceof DocumentIngestionError) {
    return {
      code: normalizeErrorCode(error.code),
      summary: normalizeSummary(error.safeSummary),
      retryable: error.retryable,
    }
  }
  return {
    code: "INGESTION_UNEXPECTED_ERROR",
    summary: "Document 摄取遇到暂时性错误，将自动重试。",
    retryable: true,
  }
}

async function runWithTimeout(
  handler: DocumentIngestionHandler,
  job: DocumentIngestionJob,
  claimId: string,
  timeoutMs: number,
): Promise<void> {
  const controller = new AbortController()
  let timeout: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort()
      reject(
        new DocumentIngestionError(
          "INGESTION_TASK_TIMEOUT",
          "Document 摄取超过任务时限，将自动重试。",
          true,
        ),
      )
    }, timeoutMs)
  })

  try {
    await Promise.race([
      Promise.resolve().then(() =>
        handler(job, { signal: controller.signal, claimId }),
      ),
      timeoutPromise,
    ])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}

function waitForNextPoll(
  pollIntervalMs: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timeout)
      signal.removeEventListener("abort", finish)
      resolve()
    }
    const timeout = setTimeout(finish, pollIntervalMs)
    signal.addEventListener("abort", finish, { once: true })
  })
}

function firstRow(data: unknown): Record<string, unknown> | null {
  if (!Array.isArray(data) || data.length === 0) return null
  return isRecord(data[0]) ? data[0] : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  )
}

function normalizeErrorCode(code: string): string {
  const normalized = code.trim().toUpperCase()
  return /^[A-Z][A-Z0-9_]{0,63}$/.test(normalized)
    ? normalized
    : "INGESTION_HANDLER_ERROR"
}

function normalizeSummary(summary: string): string {
  const normalized = summary.trim()
  return normalized
    ? normalized.slice(0, 500)
    : "Document 摄取失败，请检查文件后重试。"
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} 必须是正整数`)
  }
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} 必须是非负整数`)
  }
}
