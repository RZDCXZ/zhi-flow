import { spawn, type ChildProcess } from "node:child_process"
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
      expect(html).toContain("项目骨架已就绪")
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

async function withDevelopmentServer(
  assertions: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const port = await findAvailablePort()
  const application = startDevelopmentServer(port)
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

function startDevelopmentServer(port: number): ChildProcess {
  return startNextDevelopmentServer(port, {
    ...process.env,
    ZHI_FLOW_CHAT_API_KEY: "acceptance-test-secret",
    ZHI_FLOW_CHAT_BASE_URL: "https://example.test/v1",
    ZHI_FLOW_CHAT_MODEL: "acceptance-test-model",
    ZHI_FLOW_SUPABASE_URL: "http://127.0.0.1:54321",
    ZHI_FLOW_SUPABASE_SECRET_KEY: "sb_secret_acceptance-test",
  })
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
