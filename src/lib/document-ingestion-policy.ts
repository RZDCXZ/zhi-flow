export const DOCUMENT_INGESTION_CONSUMER_DEFAULTS = Object.freeze({
  visibilityTimeoutSeconds: 15 * 60,
  taskTimeoutMs: 10 * 60_000,
  maxAttempts: 5,
  pollIntervalMs: 1_000,
})

export const DOCUMENT_INGESTION_PLACEHOLDER_MODES = [
  "success",
  "transient",
  "permanent",
  "timeout",
  "crash",
] as const

export type DocumentIngestionPlaceholderMode =
  (typeof DOCUMENT_INGESTION_PLACEHOLDER_MODES)[number]
