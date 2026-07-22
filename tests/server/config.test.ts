import { describe, expect, it } from "vitest"

import { loadServerConfig } from "../../src/server/config-definition"

const validEnvironment: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  ZHI_FLOW_CHAT_API_KEY: "test-chat-secret",
  ZHI_FLOW_CHAT_BASE_URL: "https://example.test/v1",
  ZHI_FLOW_CHAT_MODEL: "test-chat-model",
  ZHI_FLOW_SUPABASE_URL: "http://127.0.0.1:54321",
  ZHI_FLOW_SUPABASE_SECRET_KEY: "sb_secret_test-server-only",
}

describe("服务端配置", () => {
  it("提供 OpenAI-compatible 聊天配置与可覆盖的流式超时", () => {
    const config = loadServerConfig({
      ...validEnvironment,
      ZHI_FLOW_CHAT_FIRST_BYTE_TIMEOUT_MS: "2500",
      ZHI_FLOW_CHAT_IDLE_TIMEOUT_MS: "3500",
      ZHI_FLOW_CHAT_TOTAL_TIMEOUT_MS: "4500",
      ZHI_FLOW_CHAT_HEARTBEAT_INTERVAL_MS: "500",
      ZHI_FLOW_CHAT_MAX_STREAM_ATTEMPTS: "4",
    })

    expect(config.chat).toEqual({
      apiKey: "test-chat-secret",
      baseUrl: "https://example.test/v1",
      model: "test-chat-model",
      firstByteTimeoutMs: 2_500,
      idleTimeoutMs: 3_500,
      totalTimeoutMs: 4_500,
      heartbeatIntervalMs: 500,
      maxStreamAttempts: 4,
    })
  })

  it("聊天超时未配置时使用安全默认值，并拒绝非正整数", () => {
    expect(loadServerConfig(validEnvironment).chat).toMatchObject({
      firstByteTimeoutMs: 15_000,
      idleTimeoutMs: 30_000,
      totalTimeoutMs: 120_000,
      heartbeatIntervalMs: 10_000,
      maxStreamAttempts: 3,
    })
    expect(() =>
      loadServerConfig({
        ...validEnvironment,
        ZHI_FLOW_CHAT_FIRST_BYTE_TIMEOUT_MS: "0",
      }),
    ).toThrowError(/ZHI_FLOW_CHAT_FIRST_BYTE_TIMEOUT_MS/)
  })

  it("提供仅供服务端数据访问使用的 Supabase 配置", () => {
    const config = loadServerConfig(validEnvironment)

    expect(config.supabase).toEqual({
      url: "http://127.0.0.1:54321",
      secretKey: "sb_secret_test-server-only",
    })
  })

  it("缺失 Supabase 特权密钥时拒绝启动且不泄露其他密钥", () => {
    const environment = { ...validEnvironment }
    delete environment.ZHI_FLOW_SUPABASE_SECRET_KEY

    expect(() => loadServerConfig(environment)).toThrowError(
      /ZHI_FLOW_SUPABASE_SECRET_KEY/,
    )

    try {
      loadServerConfig(environment)
    } catch (error) {
      expect(String(error)).not.toContain("test-chat-secret")
    }
  })
})
