import { spawn } from "node:child_process"
import { createServer } from "node:net"
import { join } from "node:path"

const secret = "must-never-appear-in-production-startup-errors"
const port = await findAvailablePort()
const application = spawn(
  process.execPath,
  [
    join(process.cwd(), "node_modules/next/dist/bin/next"),
    "start",
    "--hostname",
    "127.0.0.1",
    "--port",
    String(port),
  ],
  {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ZHI_FLOW_CHAT_API_KEY: secret,
      ZHI_FLOW_CHAT_BASE_URL: "",
      ZHI_FLOW_CHAT_MODEL: "production-startup-test-model",
    },
    stdio: "pipe",
  },
)

let output = ""
application.stdout.on("data", (chunk) => {
  output += chunk.toString()
})
application.stderr.on("data", (chunk) => {
  output += chunk.toString()
})

const result = await waitForExit(application)

if (result.timedOut) {
  throw new Error("缺失配置时生产服务仍保持运行")
}
if (result.code === 0) {
  throw new Error("缺失配置时生产服务以成功状态退出")
}
if (!output.includes("ZHI_FLOW_CHAT_BASE_URL")) {
  throw new Error("生产启动错误未指出缺失的配置变量")
}
if (output.includes(secret)) {
  throw new Error("生产启动错误泄露了配置值")
}

console.log("生产启动配置校验通过：缺失配置时安全退出。")

async function findAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (address === null || typeof address === "string") {
        reject(new Error("无法分配生产启动测试端口"))
        return
      }
      server.close(() => resolve(address.port))
    })
  })
}

async function waitForExit(childProcess) {
  return new Promise((resolve) => {
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      childProcess.kill("SIGTERM")
    }, 5_000)

    childProcess.once("exit", (code) => {
      clearTimeout(timeout)
      resolve({ code, timedOut })
    })
  })
}
