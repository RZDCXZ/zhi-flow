import type { DocumentIngestionPlaceholderMode } from "../src/lib/document-ingestion-policy"
import { loadServerConfig } from "../src/server/config-definition"
import {
  createDocumentIngestionConsumer,
  DocumentIngestionError,
  type DocumentIngestionHandler,
  type DocumentIngestionResult,
} from "../src/server/documents/document-ingestion-consumer"
import { createDocumentParsingHandler } from "../src/server/documents/document-parser"

const config = loadServerConfig()
const parsingHandler = createDocumentParsingHandler({
  supabaseUrl: config.supabase.url,
  secretKey: config.supabase.secretKey,
  limits: config.upload,
})
const consumer = createDocumentIngestionConsumer({
  supabaseUrl: config.supabase.url,
  secretKey: config.supabase.secretKey,
  handler: withFaultInjection(parsingHandler, config.consumer.placeholderMode),
  visibilityTimeoutSeconds: config.consumer.visibilityTimeoutSeconds,
  taskTimeoutMs: config.consumer.taskTimeoutMs,
  maxAttempts: config.consumer.maxAttempts,
  pollIntervalMs: config.consumer.pollIntervalMs,
})

void main().catch((error: unknown) => {
  console.error("Document ingestion Consumer stopped unexpectedly", {
    category: error instanceof Error ? error.name : "UnknownError",
  })
  process.exitCode = 1
})

async function main(): Promise<void> {
  if (process.argv.includes("--once")) {
    logConsumptionResult(await consumer.processOne())
    return
  }

  const shutdown = new AbortController()
  process.once("SIGINT", () => shutdown.abort())
  process.once("SIGTERM", () => shutdown.abort())
  console.log("Document ingestion Consumer started", {
    faultMode: config.consumer.placeholderMode,
    visibilityTimeoutSeconds: config.consumer.visibilityTimeoutSeconds,
    taskTimeoutSeconds: config.consumer.taskTimeoutMs / 1_000,
    maxAttempts: config.consumer.maxAttempts,
  })
  await consumer.runUntilStopped(shutdown.signal, logConsumptionResult)
  console.log("Document ingestion Consumer stopped")
}

function withFaultInjection(
  handler: DocumentIngestionHandler,
  mode: DocumentIngestionPlaceholderMode,
): DocumentIngestionHandler {
  if (mode === "success") return handler
  return async (job, context) => {
    switch (mode) {
      case "transient":
        throw new DocumentIngestionError(
          "PLACEHOLDER_TRANSIENT",
          "占位处理器模拟短暂错误。",
          true,
        )
      case "permanent":
        throw new DocumentIngestionError(
          "PLACEHOLDER_PERMANENT",
          "占位处理器模拟永久错误。",
          false,
        )
      case "timeout":
        await new Promise<void>(() => undefined)
        return
      case "crash":
        console.error("Simulating Consumer crash", {
          documentId: job.documentId,
          claimId: context.claimId,
        })
        process.exit(70)
    }
  }
}

function logConsumptionResult(result: DocumentIngestionResult): void {
  if (result.outcome === "idle") {
    console.log("Document ingestion queue has no visible message")
    return
  }
  console.log("Document ingestion message processing finished", result)
}
