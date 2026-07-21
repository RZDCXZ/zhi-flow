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
  }>
  supabase: Readonly<{
    url: string
    secretKey: string
  }>
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
    }),
    supabase: Object.freeze({
      url: supabaseUrl,
      secretKey: values.get("ZHI_FLOW_SUPABASE_SECRET_KEY")!,
    }),
  })
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
