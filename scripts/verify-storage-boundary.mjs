import { execFileSync } from "node:child_process"
import { join } from "node:path"

import { createClient } from "@supabase/supabase-js"

const cliPath = join(
  process.cwd(),
  "node_modules",
  "supabase",
  "dist",
  "supabase.js",
)
const localStatus = JSON.parse(
  execFileSync(process.execPath, [cliPath, "status", "--output", "json"], {
    cwd: process.cwd(),
    encoding: "utf8",
  }),
)

const serverClient = createClient(localStatus.API_URL, localStatus.SECRET_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})
const directClient = createClient(
  localStatus.API_URL,
  localStatus.PUBLISHABLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } },
)
const bucket = "documents"
const objectKey = "boundary-check.txt"
const expectedContent = "private storage boundary check"

try {
  const upload = await serverClient.storage
    .from(bucket)
    .upload(objectKey, new Blob([expectedContent], { type: "text/plain" }), {
      contentType: "text/plain",
      upsert: true,
    })
  if (upload.error) throw upload.error

  const directDownload = await directClient.storage
    .from(bucket)
    .download(objectKey)
  if (directDownload.error === null || directDownload.data !== null) {
    throw new Error("发布密钥客户端读取了私有 Document Storage 对象")
  }

  const serverDownload = await serverClient.storage
    .from(bucket)
    .download(objectKey)
  if (serverDownload.error) throw serverDownload.error
  if ((await serverDownload.data.text()) !== expectedContent) {
    throw new Error("服务端读取的私有 Storage 内容不一致")
  }

  console.log("Storage 边界验证通过：客户端被拒绝，服务端可读取私有对象。")
} finally {
  const cleanup = await serverClient.storage.from(bucket).remove([objectKey])
  if (cleanup.error) throw cleanup.error
}
