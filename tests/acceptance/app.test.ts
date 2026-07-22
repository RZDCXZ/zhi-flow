import { spawn, type ChildProcess } from "node:child_process"
import { writeFileSync } from "node:fs"
import { rm } from "node:fs/promises"
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http"
import { createServer } from "node:net"

import { afterEach, describe, expect, it } from "vitest"

const runningProcesses = new Set<ChildProcess>()
const testArtifactDirectories = new Set<string>()

afterEach(async () => {
  await Promise.all([...runningProcesses].map(stopProcess))
  runningProcesses.clear()
  await Promise.all(
    [...testArtifactDirectories].map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  )
  testArtifactDirectories.clear()
})

describe("Zhi Flow Web 服务", () => {
  it("使用有效后端配置时可通过 HTTP 打开首页", async () => {
    await withDevelopmentServer(async (baseUrl) => {
      const response = await fetch(baseUrl)
      const html = await response.text()

      expect(response.status).toBe(200)
      expect(html).toContain("Zhi Flow")
      expect(html).toContain("观察回答逐步生成")
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

  it("通过公开 SSE 接缝按单调序列流式返回正文、用量与唯一终态", async () => {
    await withChatUpstream(
      async (_request, response) => {
        response.setHeader("Content-Type", "text/event-stream")
        response.write(
          'data: {"choices":[{"delta":{"content":"这是来自"}}]}\n\n',
        )
        await new Promise((resolve) => setTimeout(resolve, 30))
        response.write(
          'data: {"choices":[{"delta":{"content":"测试模型的回答。"}}]}\n\n',
        )
        response.write(
          'data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":10,"total_tokens":17}}\n\n',
        )
        response.end("data: [DONE]\n\n")
      },
      async (upstreamUrl) => {
        await withDevelopmentServer(
          async (baseUrl) => {
            const response = await fetch(`${baseUrl}/api/chat`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                requestId: "11111111-1111-4111-8111-111111111111",
                message: "请给我一个简短回答。",
              }),
            })
            const body = await response.text()
            const events = readSseEvents(body)

            expect(response.status).toBe(200)
            expect(response.headers.get("content-type")).toContain(
              "text/event-stream",
            )
            expect(events.map(({ event }) => event)).toEqual([
              "message.created",
              "content.delta",
              "content.delta",
              "usage.snapshot",
              "message.completed",
            ])
            expect(events.map(({ data }) => data.sequence)).toEqual([
              1, 2, 3, 4, 5,
            ])
            expect(events.map(({ data }) => data.requestId)).toEqual(
              Array(5).fill("11111111-1111-4111-8111-111111111111"),
            )
            expect(events.map(({ data }) => data.version)).toEqual(
              Array(5).fill(1),
            )
            expect(events[1]?.data).toMatchObject({ delta: "这是来自" })
            expect(events[2]?.data).toMatchObject({
              delta: "测试模型的回答。",
            })
            expect(events[3]?.data).toMatchObject({
              usage: {
                inputTokens: 7,
                outputTokens: 10,
                totalTokens: 17,
              },
            })
            expect(events[4]?.data).toMatchObject({
              type: "message.completed",
              latencyMs: expect.any(Number),
            })
            expect(
              events.filter(({ event }) => event.startsWith("message.")),
            ).toHaveLength(2)
            expect(body).not.toContain("acceptance-test-secret")
            expect(body).not.toContain("acceptance-test-model")
          },
          { ZHI_FLOW_CHAT_BASE_URL: `${upstreamUrl}/v1` },
        )
      },
    )
  })

  it("首字节超时只在首个正文增量前重试并最终产生一个失败终态", async () => {
    let upstreamRequests = 0

    await withChatUpstream(
      async (_request, response) => {
        upstreamRequests += 1
        response.setHeader("Content-Type", "text/event-stream")
        await new Promise((resolve) => setTimeout(resolve, 80))
        response.end(
          'data: {"choices":[{"delta":{"content":"迟到的正文"}}]}\n\n' +
            'data: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n' +
            "data: [DONE]\n\n",
        )
      },
      async (upstreamUrl) => {
        await withDevelopmentServer(
          async (baseUrl) => {
            const response = await fetch(`${baseUrl}/api/chat`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ message: "测试首字节超时。" }),
            })
            const events = readSseEvents(await response.text())

            expect(upstreamRequests).toBe(3)
            expect(events.map(({ event }) => event)).toEqual([
              "message.created",
              "message.failed",
            ])
            expect(events[1]?.data).toMatchObject({
              type: "message.failed",
              error: {
                code: "PROVIDER_TIMEOUT",
                retryable: true,
              },
            })
          },
          {
            ZHI_FLOW_CHAT_BASE_URL: `${upstreamUrl}/v1`,
            ZHI_FLOW_CHAT_FIRST_BYTE_TIMEOUT_MS: "20",
          },
        )
      },
    )
  })

  it("首个正文增量后的流中断不重试并产生一个中断终态", async () => {
    let upstreamRequests = 0

    await withChatUpstream(
      (_request, response) => {
        upstreamRequests += 1
        response.setHeader("Content-Type", "text/event-stream")
        response.end(
          'data: {"choices":[{"delta":{"content":"已显示的正文"}}]}\n\n',
        )
      },
      async (upstreamUrl) => {
        await withDevelopmentServer(
          async (baseUrl) => {
            const response = await fetch(`${baseUrl}/api/chat`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ message: "测试流中断。" }),
            })
            const events = readSseEvents(await response.text())

            expect(upstreamRequests).toBe(1)
            expect(events.map(({ event }) => event)).toEqual([
              "message.created",
              "content.delta",
              "message.failed",
            ])
            expect(events[1]?.data).toMatchObject({ delta: "已显示的正文" })
            expect(events[2]?.data).toMatchObject({
              error: { code: "STREAM_INTERRUPTED", retryable: true },
            })
          },
          { ZHI_FLOW_CHAT_BASE_URL: `${upstreamUrl}/v1` },
        )
      },
    )
  })

  it("正文分块之间超过空闲时限时停止 Provider 并失败", async () => {
    let upstreamRequests = 0

    await withChatUpstream(
      async (_request, response) => {
        upstreamRequests += 1
        response.setHeader("Content-Type", "text/event-stream")
        response.write('data: {"choices":[{"delta":{"content":"第一块"}}]}\n\n')
        await new Promise((resolve) => setTimeout(resolve, 80))
        response.end(
          'data: {"choices":[{"delta":{"content":"迟到块"}}]}\n\n' +
            'data: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}\n\n' +
            "data: [DONE]\n\n",
        )
      },
      async (upstreamUrl) => {
        await withDevelopmentServer(
          async (baseUrl) => {
            const response = await fetch(`${baseUrl}/api/chat`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ message: "测试流空闲超时。" }),
            })
            const events = readSseEvents(await response.text())

            expect(upstreamRequests).toBe(1)
            expect(events.map(({ event }) => event)).toEqual([
              "message.created",
              "content.delta",
              "message.failed",
            ])
            expect(events[2]?.data).toMatchObject({
              error: { code: "PROVIDER_TIMEOUT", retryable: true },
            })
          },
          {
            ZHI_FLOW_CHAT_BASE_URL: `${upstreamUrl}/v1`,
            ZHI_FLOW_CHAT_IDLE_TIMEOUT_MS: "20",
          },
        )
      },
    )
  })

  it("持续活动时发送心跳但仍受聊天总时限约束", async () => {
    await withChatUpstream(
      (_request, response) => {
        response.setHeader("Content-Type", "text/event-stream")
        response.write(": upstream-heartbeat\n\n")
        const activity = setInterval(
          () => response.write(": upstream-heartbeat\n\n"),
          5,
        )
        response.once("close", () => clearInterval(activity))
      },
      async (upstreamUrl) => {
        await withDevelopmentServer(
          async (baseUrl) => {
            const response = await fetch(`${baseUrl}/api/chat`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ message: "测试聊天总时限。" }),
            })
            const body = await response.text()
            const events = readSseEvents(body)

            expect(body).toContain(": heartbeat ")
            expect(events.map(({ event }) => event)).toEqual([
              "message.created",
              "message.failed",
            ])
            expect(events[1]?.data).toMatchObject({
              error: { code: "PROVIDER_TIMEOUT", retryable: true },
            })
          },
          {
            ZHI_FLOW_CHAT_BASE_URL: `${upstreamUrl}/v1`,
            ZHI_FLOW_CHAT_FIRST_BYTE_TIMEOUT_MS: "20",
            ZHI_FLOW_CHAT_IDLE_TIMEOUT_MS: "20",
            ZHI_FLOW_CHAT_TOTAL_TIMEOUT_MS: "45",
            ZHI_FLOW_CHAT_HEARTBEAT_INTERVAL_MS: "10",
          },
        )
      },
    )
  })

  it("停止本次请求会传播至 Provider 并返回一个取消终态", async () => {
    let resolveProviderCancellation: (() => void) | undefined
    const providerCancelled = new Promise<void>((resolve) => {
      resolveProviderCancellation = resolve
    })

    await withChatUpstream(
      (_request, response) => {
        response.setHeader("Content-Type", "text/event-stream")
        response.write(
          'data: {"choices":[{"delta":{"content":"停止前正文"}}]}\n\n',
        )
        response.once("close", () => resolveProviderCancellation?.())
      },
      async (upstreamUrl) => {
        await withDevelopmentServer(
          async (baseUrl) => {
            const requestId = "22222222-2222-4222-8222-222222222222"
            const response = await fetch(`${baseUrl}/api/chat`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ requestId, message: "测试停止。" }),
            })
            if (response.body === null) throw new Error("聊天响应没有正文流")

            const reader = response.body.getReader()
            const firstPart = await readStreamUntil(reader, "停止前正文")
            const stopResponse = await fetch(`${baseUrl}/api/chat`, {
              method: "DELETE",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ requestId }),
            })
            const rest = await readRemainingStream(reader)
            const events = readSseEvents(firstPart + rest)

            expect(stopResponse.status).toBe(202)
            expect(events.map(({ event }) => event)).toEqual([
              "message.created",
              "content.delta",
              "message.cancelled",
            ])
            await expect(providerCancelled).resolves.toBeUndefined()
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
      environmentOverrides: {
        ZHI_FLOW_CHAT_FIRST_BYTE_TIMEOUT_MS: "25",
      },
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

function readSseEvents(body: string): Array<{
  event: string
  data: Record<string, unknown>
}> {
  return body
    .split(/\r?\n\r?\n/)
    .map((frame) => frame.trim())
    .filter((frame) => frame && !frame.startsWith(":"))
    .map((frame) => {
      const lines = frame.split(/\r?\n/)
      const event = lines.find((line) => line.startsWith("event: "))?.slice(7)
      const data = lines.find((line) => line.startsWith("data: "))?.slice(6)
      if (!event || !data) throw new Error(`无法解析 SSE 帧：${frame}`)
      return { event, data: JSON.parse(data) as Record<string, unknown> }
    })
}

async function readStreamUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  expectedText: string,
): Promise<string> {
  const decoder = new TextDecoder()
  let body = ""

  while (!body.includes(expectedText)) {
    const chunk = await reader.read()
    if (chunk.done) throw new Error(`SSE 在出现「${expectedText}」前结束`)
    body += decoder.decode(chunk.value, { stream: true })
  }
  return body
}

async function readRemainingStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<string> {
  const decoder = new TextDecoder()
  let body = ""

  while (true) {
    const chunk = await reader.read()
    if (chunk.done) return body + decoder.decode()
    body += decoder.decode(chunk.value, { stream: true })
  }
}

type ProviderErrorScenario = Readonly<{
  message: string
  handleUpstream: (
    request: IncomingMessage,
    response: ServerResponse,
  ) => void | Promise<void>
  environmentOverrides?: Partial<NodeJS.ProcessEnv>
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
        const body = await response.text()
        const events = readSseEvents(body)

        expect(response.status).toBe(200)
        expect(events.map(({ event }) => event)).toEqual([
          "message.created",
          "message.failed",
        ])
        expect(events[1]?.data).toMatchObject({ error: expectedError })
        if (forbiddenText) {
          expect(body).not.toContain(forbiddenText)
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
    await stopProcess(application)
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
  const distDir = `.next-acceptance-${port}`
  const tsconfigPath = `.next-acceptance-${port}.tsconfig.json`
  testArtifactDirectories.add(distDir)
  testArtifactDirectories.add(tsconfigPath)
  writeFileSync(
    tsconfigPath,
    `${JSON.stringify({ extends: "./tsconfig.json" }, null, 2)}\n`,
  )
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
      env: {
        ...environment,
        ZHI_FLOW_NEXT_DIST_DIR: distDir,
        ZHI_FLOW_NEXT_TSCONFIG_PATH: tsconfigPath,
      },
      stdio: "pipe",
    },
  )

  runningProcesses.add(application)
  application.once("exit", () => runningProcesses.delete(application))
  return application
}

async function stopProcess(application: ChildProcess): Promise<void> {
  if (application.exitCode !== null || application.signalCode !== null) return

  await new Promise<void>((resolve) => {
    const forceStop = setTimeout(() => application.kill("SIGKILL"), 5_000)
    application.once("exit", () => {
      clearTimeout(forceStop)
      resolve()
    })
    application.kill("SIGTERM")
  })
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
