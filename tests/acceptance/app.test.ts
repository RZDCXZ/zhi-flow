import { spawn, type ChildProcess } from "node:child_process"
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http"
import { createServer } from "node:net"

import { afterEach, describe, expect, it } from "vitest"

const runningProcesses = new Set<ChildProcess>()

afterEach(() => {
  for (const process of runningProcesses) {
    process.kill("SIGTERM")
  }
  runningProcesses.clear()
})

describe("Zhi Flow Web 服务", () => {
  it("使用有效后端配置时可通过 HTTP 打开首页", async () => {
    await withDevelopmentServer(async (baseUrl) => {
      const response = await fetch(baseUrl)
      const html = await response.text()

      expect(response.status).toBe(200)
      expect(html).toContain("Zhi Flow")
      expect(html).toContain("进行一次非流式聊天")
      expect(html).toContain("输入消息")
      expect(html).toContain("发送消息")
      expect(html).toContain("答案")
    })
  })

  it("通过公开健康检查报告服务运行正常", async () => {
    await withDevelopmentServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/health`)

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({
        status: "ok",
        service: "zhi-flow",
      })
    })
  })

  it("通过公开 HTTP 接缝完成一次非流式聊天并返回用量", async () => {
    await withChatUpstream(
      async (_request, response) => {
        response.setHeader("Content-Type", "application/json")
        response.end(
          JSON.stringify({
            choices: [{ message: { content: "这是来自测试模型的回答。" } }],
            usage: {
              prompt_tokens: 7,
              completion_tokens: 10,
              total_tokens: 17,
            },
          }),
        )
      },
      async (upstreamUrl) => {
        await withDevelopmentServer(
          async (baseUrl) => {
            const response = await fetch(`${baseUrl}/api/chat`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ message: "请给我一个简短回答。" }),
            })
            const body = await response.json()

            expect(response.status).toBe(200)
            expect(body).toMatchObject({
              answer: "这是来自测试模型的回答。",
              usage: {
                inputTokens: 7,
                outputTokens: 10,
                totalTokens: 17,
              },
            })
            expect(body.latencyMs).toEqual(expect.any(Number))
            expect(JSON.stringify(body)).not.toContain("acceptance-test-secret")
            expect(JSON.stringify(body)).not.toContain("acceptance-test-model")
          },
          { ZHI_FLOW_CHAT_BASE_URL: `${upstreamUrl}/v1` },
        )
      },
    )
  })

  it("通过公开 HTTP 接缝拒绝空输入", async () => {
    await withDevelopmentServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "  \n  " }),
      })

      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({
        error: {
          code: "INVALID_INPUT",
          message: "请输入消息。",
          retryable: false,
        },
      })
    })
  })

  it("通过公开 HTTP 接缝拒绝超长输入", async () => {
    await withDevelopmentServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "长".repeat(4_001) }),
      })

      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({
        error: {
          code: "INPUT_TOO_LONG",
          message: "消息不能超过 4000 个字符。",
          retryable: false,
        },
      })
    })
  })

  it("将供应商超时映射为稳定且脱敏的应用错误", async () => {
    await expectProviderErrorMapping({
      message: "这个请求会超时。",
      handleUpstream: async (_request, response) => {
        await new Promise((resolve) => setTimeout(resolve, 200))
        response.setHeader("Content-Type", "application/json")
        response.end(
          JSON.stringify({
            choices: [{ message: { content: "迟到的回答" } }],
            usage: {
              prompt_tokens: 1,
              completion_tokens: 1,
              total_tokens: 2,
            },
          }),
        )
      },
      environmentOverrides: { ZHI_FLOW_CHAT_TIMEOUT_MS: "25" },
      expectedStatus: 504,
      expectedError: {
        code: "PROVIDER_TIMEOUT",
        message: "聊天服务响应超时，请重试。",
        retryable: true,
      },
    })
  })

  it("将供应商 401 映射为脱敏的认证配置错误", async () => {
    await expectProviderErrorMapping({
      message: "触发认证错误。",
      handleUpstream: (_request, response) => {
        response.statusCode = 401
        response.setHeader("Content-Type", "application/json")
        response.end(
          JSON.stringify({ error: "upstream-secret-authentication-detail" }),
        )
      },
      expectedStatus: 502,
      expectedError: {
        code: "PROVIDER_AUTHENTICATION_FAILED",
        message: "聊天服务配置异常，请稍后再试。",
        retryable: false,
      },
      forbiddenText: "upstream-secret-authentication-detail",
    })
  })

  it("将供应商 429 映射为可重试的限流错误", async () => {
    await expectProviderErrorMapping({
      message: "触发限流。",
      handleUpstream: (_request, response) => {
        response.statusCode = 429
        response.end("upstream rate-limit detail")
      },
      expectedStatus: 429,
      expectedError: {
        code: "RATE_LIMITED",
        message: "请求过于频繁，请稍后重试。",
        retryable: true,
      },
    })
  })

  it("将供应商 5xx 映射为可重试的不可用错误", async () => {
    await expectProviderErrorMapping({
      message: "触发供应商错误。",
      handleUpstream: (_request, response) => {
        response.statusCode = 503
        response.end("upstream internal infrastructure detail")
      },
      expectedStatus: 502,
      expectedError: {
        code: "PROVIDER_UNAVAILABLE",
        message: "聊天服务暂时不可用，请稍后重试。",
        retryable: true,
      },
    })
  })

  it("缺失必需后端配置时拒绝启动且不泄露密钥", async () => {
    const port = await findAvailablePort()
    const secret = "must-never-appear-in-startup-errors"

    const application = startNextDevelopmentServer(port, {
      ...process.env,
      ZHI_FLOW_CHAT_API_KEY: secret,
      ZHI_FLOW_CHAT_BASE_URL: "",
      ZHI_FLOW_CHAT_MODEL: "acceptance-test-model",
      ZHI_FLOW_SUPABASE_URL: "http://127.0.0.1:54321",
      ZHI_FLOW_SUPABASE_SECRET_KEY: "sb_secret_acceptance-test",
    })
    const result = await waitForExit(application)

    expect(result.code).not.toBe(0)
    expect(result.output).toContain("ZHI_FLOW_CHAT_BASE_URL")
    expect(result.output).not.toContain(secret)
  })
})

type ProviderErrorScenario = Readonly<{
  message: string
  handleUpstream: (
    request: IncomingMessage,
    response: ServerResponse,
  ) => void | Promise<void>
  environmentOverrides?: Partial<NodeJS.ProcessEnv>
  expectedStatus: number
  expectedError: Readonly<{
    code: string
    message: string
    retryable: boolean
  }>
  forbiddenText?: string
}>

async function expectProviderErrorMapping({
  message,
  handleUpstream,
  environmentOverrides = {},
  expectedStatus,
  expectedError,
  forbiddenText,
}: ProviderErrorScenario): Promise<void> {
  await withChatUpstream(handleUpstream, async (upstreamUrl) => {
    await withDevelopmentServer(
      async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message }),
        })
        const body = await response.json()

        expect(response.status).toBe(expectedStatus)
        expect(body).toEqual({ error: expectedError })
        if (forbiddenText) {
          expect(JSON.stringify(body)).not.toContain(forbiddenText)
        }
      },
      {
        ...environmentOverrides,
        ZHI_FLOW_CHAT_BASE_URL: `${upstreamUrl}/v1`,
      },
    )
  })
}

async function withDevelopmentServer(
  assertions: (baseUrl: string) => Promise<void>,
  environmentOverrides: Partial<NodeJS.ProcessEnv> = {},
): Promise<void> {
  const port = await findAvailablePort()
  const application = startDevelopmentServer(port, environmentOverrides)
  const baseUrl = `http://127.0.0.1:${port}`

  try {
    await waitUntilReachable(baseUrl)
    await assertions(baseUrl)
  } finally {
    application.kill("SIGTERM")
  }
}

async function findAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (address === null || typeof address === "string") {
        reject(new Error("无法分配测试端口"))
        return
      }
      server.close(() => resolve(address.port))
    })
  })
}

function startDevelopmentServer(
  port: number,
  environmentOverrides: Partial<NodeJS.ProcessEnv> = {},
): ChildProcess {
  return startNextDevelopmentServer(port, {
    ...process.env,
    ZHI_FLOW_CHAT_API_KEY: "acceptance-test-secret",
    ZHI_FLOW_CHAT_BASE_URL: "https://example.test/v1",
    ZHI_FLOW_CHAT_MODEL: "acceptance-test-model",
    ZHI_FLOW_SUPABASE_URL: "http://127.0.0.1:54321",
    ZHI_FLOW_SUPABASE_SECRET_KEY: "sb_secret_acceptance-test",
    ...environmentOverrides,
  })
}

async function withChatUpstream(
  handler: (
    request: IncomingMessage,
    response: ServerResponse,
  ) => void | Promise<void>,
  assertions: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createHttpServer(handler)

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })

  const address = server.address()
  if (address === null || typeof address === "string") {
    server.close()
    throw new Error("无法分配聊天上游测试端口")
  }

  try {
    await assertions(`http://127.0.0.1:${address.port}`)
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
  }
}

function startNextDevelopmentServer(
  port: number,
  environment: NodeJS.ProcessEnv,
): ChildProcess {
  const application = spawn(
    process.execPath,
    [
      "node_modules/next/dist/bin/next",
      "dev",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(port),
    ],
    {
      cwd: process.cwd(),
      env: environment,
      stdio: "pipe",
    },
  )

  runningProcesses.add(application)
  application.once("exit", () => runningProcesses.delete(application))
  return application
}

async function waitForExit(
  application: ChildProcess,
): Promise<{ code: number | null; output: string }> {
  let output = ""
  application.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString()
  })
  application.stderr?.on("data", (chunk: Buffer) => {
    output += chunk.toString()
  })

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      application.kill("SIGTERM")
      reject(new Error("缺失配置时 Next.js 仍保持运行"))
    }, 10_000)

    application.once("exit", (code) => {
      clearTimeout(timeout)
      resolve({ code, output })
    })
  })
}

async function waitUntilReachable(url: string): Promise<void> {
  const deadline = Date.now() + 20_000

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.status < 500) return
    } catch {
      // Next.js 仍在启动；继续轮询公开 HTTP 接缝。
    }

    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  throw new Error("Next.js 未在预期时间内启动")
}
