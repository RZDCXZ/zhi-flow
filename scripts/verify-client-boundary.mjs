import { readdir, readFile } from "node:fs/promises"
import { extname, join, relative } from "node:path"

const buildDirectory = join(process.cwd(), ".next")
const clientArtifactDirectories = [
  join(buildDirectory, "static"),
  join(buildDirectory, "server", "app"),
]
const publicServerArtifactExtensions = new Set([
  ".body",
  ".html",
  ".rsc",
  ".txt",
])
const forbiddenValues = [
  ["ZHI_FLOW_CHAT_API_KEY", process.env.ZHI_FLOW_CHAT_API_KEY],
  ["ZHI_FLOW_CHAT_BASE_URL", process.env.ZHI_FLOW_CHAT_BASE_URL],
  ["ZHI_FLOW_CHAT_MODEL", process.env.ZHI_FLOW_CHAT_MODEL],
]

for (const [name, value] of forbiddenValues) {
  if (!value) throw new Error(`无法验证客户端边界：缺失 ${name}`)
}

const artifacts = []
for (const directory of clientArtifactDirectories) {
  artifacts.push(...(await listFiles(directory)))
}

const publicArtifacts = artifacts.filter((file) => {
  if (file.includes(`${join(".next", "static")}`)) return true
  return publicServerArtifactExtensions.has(extname(file))
})

for (const artifact of publicArtifacts) {
  const content = await readFile(artifact, "utf8")
  for (const [name, value] of forbiddenValues) {
    if (content.includes(value)) {
      throw new Error(
        `客户端产物 ${relative(process.cwd(), artifact)} 泄露了 ${name}`,
      )
    }
  }
}

console.log(
  `客户端边界验证通过：检查 ${publicArtifacts.length} 个公开构建产物。`,
)

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []

  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await listFiles(path)))
    } else if (entry.isFile()) {
      files.push(path)
    }
  }

  return files
}
