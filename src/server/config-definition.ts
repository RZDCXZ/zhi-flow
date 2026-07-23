import {
  DEFAULT_DOCUMENT_UPLOAD_LIMITS,
  type DocumentUploadLimits,
} from "../lib/document-upload-policy"
import {
  DOCUMENT_INGESTION_CONSUMER_DEFAULTS,
  DOCUMENT_INGESTION_PLACEHOLDER_MODES,
  type DocumentIngestionPlaceholderMode,
} from "../lib/document-ingestion-policy"

const requiredVariables = [
  "ZHI_FLOW_CHAT_API_KEY",
  "ZHI_FLOW_CHAT_BASE_URL",
  "ZHI_FLOW_CHAT_MODEL",
  "ZHI_FLOW_SUPABASE_URL",
  "ZHI_FLOW_SUPABASE_SECRET_KEY",
] as const

type RequiredVariable = (typeof requiredVariables)[number]

export type ServerConfig = Readonly<{
  chat: Readonly<{
    apiKey: string
    baseUrl: string
    model: string
    firstByteTimeoutMs: number
    idleTimeoutMs: number
    totalTimeoutMs: number
    heartbeatIntervalMs: number
    maxStreamAttempts: number
  }>
  supabase: Readonly<{
    url: string
    secretKey: string
  }>
  consumer: Readonly<{
    visibilityTimeoutSeconds: number
    taskTimeoutMs: number
    maxAttempts: number
    pollIntervalMs: number
    placeholderMode: DocumentIngestionPlaceholderMode
  }>
  upload: DocumentUploadLimits
}>

export function loadServerConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ServerConfig {
  const values = new Map<RequiredVariable, string>()
  const missingVariables: RequiredVariable[] = []

  for (const variable of requiredVariables) {
    const value = environment[variable]?.trim()
    if (value) {
      values.set(variable, value)
    } else {
      missingVariables.push(variable)
    }
  }

  if (missingVariables.length > 0) {
    throw new Error(`后端配置无效：缺失 ${missingVariables.join(", ")}`)
  }

  const baseUrl = values.get("ZHI_FLOW_CHAT_BASE_URL")!
  assertHttpUrl("ZHI_FLOW_CHAT_BASE_URL", baseUrl)
  const supabaseUrl = values.get("ZHI_FLOW_SUPABASE_URL")!
  assertHttpUrl("ZHI_FLOW_SUPABASE_URL", supabaseUrl)

  return Object.freeze({
    chat: Object.freeze({
      apiKey: values.get("ZHI_FLOW_CHAT_API_KEY")!,
      baseUrl,
      model: values.get("ZHI_FLOW_CHAT_MODEL")!,
      firstByteTimeoutMs: loadPositiveInteger(
        environment,
        "ZHI_FLOW_CHAT_FIRST_BYTE_TIMEOUT_MS",
        15_000,
      ),
      idleTimeoutMs: loadPositiveInteger(
        environment,
        "ZHI_FLOW_CHAT_IDLE_TIMEOUT_MS",
        30_000,
      ),
      totalTimeoutMs: loadPositiveInteger(
        environment,
        "ZHI_FLOW_CHAT_TOTAL_TIMEOUT_MS",
        120_000,
      ),
      heartbeatIntervalMs: loadPositiveInteger(
        environment,
        "ZHI_FLOW_CHAT_HEARTBEAT_INTERVAL_MS",
        10_000,
      ),
      maxStreamAttempts: loadPositiveInteger(
        environment,
        "ZHI_FLOW_CHAT_MAX_STREAM_ATTEMPTS",
        3,
      ),
    }),
    supabase: Object.freeze({
      url: supabaseUrl,
      secretKey: values.get("ZHI_FLOW_SUPABASE_SECRET_KEY")!,
    }),
    consumer: Object.freeze({
      ...DOCUMENT_INGESTION_CONSUMER_DEFAULTS,
      placeholderMode: loadPlaceholderMode(environment),
    }),
    upload: Object.freeze({
      maxFiles: loadPositiveInteger(
        environment,
        "ZHI_FLOW_DOCUMENT_MAX_FILES",
        DEFAULT_DOCUMENT_UPLOAD_LIMITS.maxFiles,
      ),
      maxFileBytes: loadPositiveInteger(
        environment,
        "ZHI_FLOW_DOCUMENT_MAX_FILE_BYTES",
        DEFAULT_DOCUMENT_UPLOAD_LIMITS.maxFileBytes,
      ),
      maxPdfPages: loadPositiveInteger(
        environment,
        "ZHI_FLOW_DOCUMENT_MAX_PDF_PAGES",
        DEFAULT_DOCUMENT_UPLOAD_LIMITS.maxPdfPages,
      ),
      maxParsedCharacters: loadPositiveInteger(
        environment,
        "ZHI_FLOW_DOCUMENT_MAX_PARSED_CHARACTERS",
        DEFAULT_DOCUMENT_UPLOAD_LIMITS.maxParsedCharacters,
      ),
    }),
  })
}

function loadPlaceholderMode(
  environment: NodeJS.ProcessEnv,
): DocumentIngestionPlaceholderMode {
  const value =
    environment.ZHI_FLOW_CONSUMER_PLACEHOLDER_MODE?.trim() || "success"
  if (
    DOCUMENT_INGESTION_PLACEHOLDER_MODES.includes(
      value as DocumentIngestionPlaceholderMode,
    )
  ) {
    return value as DocumentIngestionPlaceholderMode
  }
  throw new Error(
    "后端配置无效：ZHI_FLOW_CONSUMER_PLACEHOLDER_MODE 必须是 " +
      DOCUMENT_INGESTION_PLACEHOLDER_MODES.join(", "),
  )
}

function loadPositiveInteger(
  environment: NodeJS.ProcessEnv,
  variable: string,
  defaultValue: number,
): number {
  const configuredValue = environment[variable]?.trim()
  if (!configuredValue) return defaultValue

  const value = Number(configuredValue)
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`后端配置无效：${variable} 必须是正整数`)
  }

  return value
}

function assertHttpUrl(variable: RequiredVariable, value: string): void {
  try {
    const url = new URL(value)
    if (url.protocol !== "http:" && url.protocol !== "https:")
      throw new Error("unsupported protocol")
  } catch {
    throw new Error(`后端配置无效：${variable} 必须是 HTTP(S) URL`)
  }
}
