import { spawn, type ChildProcess } from "node:child_process"
import { writeFileSync } from "node:fs"
import { rm } from "node:fs/promises"
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http"
import { createServer } from "node:net"

import { createClient } from "@supabase/supabase-js"
import { afterEach, describe, expect, it } from "vitest"

const runningProcesses = new Set<ChildProcess>()
const testArtifactDirectories = new Set<string>()
let currentTestConversationId: string | null = null
const localSupabaseServiceRoleKey =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU"

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
      const visibleHtml = html.replaceAll("<!-- -->", "")

      expect(response.status).toBe(200)
      expect(html).toContain("Zhi Flow")
      expect(html).toContain("构建私有知识库摄取入口")
      expect(html).toContain("输入消息")
      expect(html).toContain("发送消息")
      expect(html).toContain("新建会话")
      expect(html).toContain("选择一个 Conversation")
      expect(html).toContain("最近 12 条已完成 Message")
      expect(html).toContain("输入 Token")
      expect(html).toContain("Knowledge Bases")
      expect(html).toContain("新建知识库")
      expect(html).toContain("上传 Document")
      expect(html).toContain("PDF、Markdown、TXT")
      expect(visibleHtml).toContain("20 MiB")
      expect(visibleHtml).toContain("200 页")
      expect(visibleHtml).toContain("最多 10 个文件")
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

  it("通过公开策略接口展示后端配置，并以同一限制权威校验上传", async () => {
    await withDevelopmentServer(
      async (baseUrl) => {
        const policyResponse = await fetch(
          `${baseUrl}/api/knowledge-bases/upload-policy`,
        )
        expect(policyResponse.status).toBe(200)
        await expect(policyResponse.json()).resolves.toMatchObject({
          policy: {
            maxFiles: 2,
            maxFileBytes: 3,
            maxPdfPages: 7,
            maxParsedCharacters: 99,
            acceptedExtensions: [".pdf", ".md", ".markdown", ".txt"],
          },
        })

        const created = (await (
          await fetch(`${baseUrl}/api/knowledge-bases`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: "可配置上传限制" }),
          })
        ).json()) as { knowledgeBase: { id: string } }
        await expectUploadError(
          `${baseUrl}/api/knowledge-bases/${created.knowledgeBase.id}/documents`,
          [new File(["four"], "four.txt", { type: "text/plain" })],
          "FILE_TOO_LARGE",
        )
        await fetch(
          `${baseUrl}/api/knowledge-bases/${created.knowledgeBase.id}`,
          {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ confirmation: "可配置上传限制" }),
          },
        )
      },
      {
        ZHI_FLOW_DOCUMENT_MAX_FILES: "2",
        ZHI_FLOW_DOCUMENT_MAX_FILE_BYTES: "3",
        ZHI_FLOW_DOCUMENT_MAX_PDF_PAGES: "7",
        ZHI_FLOW_DOCUMENT_MAX_PARSED_CHARACTERS: "99",
      },
    )
  })

  it("通过公开 HTTP 接缝创建、列表、读取、重命名和删除 Conversation", async () => {
    await withDevelopmentServer(async (baseUrl) => {
      const createResponse = await fetch(`${baseUrl}/api/conversations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "持久化验收会话" }),
      })
      const created = (await createResponse.json()) as {
        conversation: { id: string; title: string; mode: string }
      }

      expect(createResponse.status).toBe(201)
      expect(created.conversation).toMatchObject({
        id: expect.any(String),
        title: "持久化验收会话",
        mode: "general",
      })

      const listResponse = await fetch(`${baseUrl}/api/conversations`)
      const listed = (await listResponse.json()) as {
        conversations: Array<{ id: string; title: string }>
      }
      expect(listResponse.status).toBe(200)
      expect(listed.conversations).toContainEqual(
        expect.objectContaining({
          id: created.conversation.id,
          title: "持久化验收会话",
        }),
      )

      const readResponse = await fetch(
        `${baseUrl}/api/conversations/${created.conversation.id}`,
      )
      expect(readResponse.status).toBe(200)
      await expect(readResponse.json()).resolves.toMatchObject({
        conversation: { id: created.conversation.id },
        messages: [],
      })

      const renameResponse = await fetch(
        `${baseUrl}/api/conversations/${created.conversation.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "已重命名会话" }),
        },
      )
      expect(renameResponse.status).toBe(200)
      await expect(renameResponse.json()).resolves.toMatchObject({
        conversation: {
          id: created.conversation.id,
          title: "已重命名会话",
        },
      })

      const deleteResponse = await fetch(
        `${baseUrl}/api/conversations/${created.conversation.id}`,
        { method: "DELETE" },
      )
      expect(deleteResponse.status).toBe(204)
      expect(
        await fetch(`${baseUrl}/api/conversations/${created.conversation.id}`),
      ).toMatchObject({ status: 404 })
    })
  })

  it("通过公开 HTTP 接缝创建、列表、读取、重命名和确认删除 Knowledge Base", async () => {
    await withDevelopmentServer(async (baseUrl) => {
      const createResponse = await fetch(`${baseUrl}/api/knowledge-bases`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "产品手册" }),
      })
      const created = (await createResponse.json()) as {
        knowledgeBase: { id: string; name: string }
      }

      expect(createResponse.status).toBe(201)
      expect(created.knowledgeBase).toMatchObject({
        id: expect.any(String),
        name: "产品手册",
      })

      const listResponse = await fetch(`${baseUrl}/api/knowledge-bases`)
      const listed = (await listResponse.json()) as {
        knowledgeBases: Array<{ id: string; name: string }>
      }
      expect(listResponse.status).toBe(200)
      expect(listed.knowledgeBases).toContainEqual(
        expect.objectContaining({
          id: created.knowledgeBase.id,
          name: "产品手册",
        }),
      )

      const readResponse = await fetch(
        `${baseUrl}/api/knowledge-bases/${created.knowledgeBase.id}`,
      )
      expect(readResponse.status).toBe(200)
      await expect(readResponse.json()).resolves.toMatchObject({
        knowledgeBase: { id: created.knowledgeBase.id },
        documents: [],
      })

      const renameResponse = await fetch(
        `${baseUrl}/api/knowledge-bases/${created.knowledgeBase.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "已更新手册" }),
        },
      )
      expect(renameResponse.status).toBe(200)
      await expect(renameResponse.json()).resolves.toMatchObject({
        knowledgeBase: {
          id: created.knowledgeBase.id,
          name: "已更新手册",
        },
      })

      const unconfirmedDelete = await fetch(
        `${baseUrl}/api/knowledge-bases/${created.knowledgeBase.id}`,
        {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ confirmation: "产品手册" }),
        },
      )
      expect(unconfirmedDelete.status).toBe(400)

      const deleteResponse = await fetch(
        `${baseUrl}/api/knowledge-bases/${created.knowledgeBase.id}`,
        {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ confirmation: "已更新手册" }),
        },
      )
      expect(deleteResponse.status).toBe(204)
      expect(
        await fetch(
          `${baseUrl}/api/knowledge-bases/${created.knowledgeBase.id}`,
        ),
      ).toMatchObject({ status: 404 })
    })
  })

  it("上传合法 TXT 至私有 Storage，创建 queued Document，并随 Knowledge Base 删除", async () => {
    await withDevelopmentServer(async (baseUrl) => {
      const created = (await (
        await fetch(`${baseUrl}/api/knowledge-bases`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "上传一致性验收" }),
        })
      ).json()) as { knowledgeBase: { id: string; name: string } }
      const knowledgeBaseId = created.knowledgeBase.id
      const form = new FormData()
      form.append(
        "files",
        new File(["Zhi Flow 私有知识库内容。"], "guide.txt", {
          type: "text/plain",
        }),
      )

      const uploadResponse = await fetch(
        `${baseUrl}/api/knowledge-bases/${knowledgeBaseId}/documents`,
        { method: "POST", body: form },
      )
      const uploadBody = (await uploadResponse.json()) as {
        documents: Array<{
          id: string
          originalFilename: string
          status: string
          currentStage: string
        }>
      }
      expect(uploadResponse.status).toBe(201)
      expect(uploadBody.documents).toEqual([
        expect.objectContaining({
          id: expect.any(String),
          originalFilename: "guide.txt",
          status: "queued",
          currentStage: "queue_pending",
        }),
      ])

      const dataClient = createClient(
        "http://127.0.0.1:54321",
        localSupabaseServiceRoleKey,
        { auth: { autoRefreshToken: false, persistSession: false } },
      )
      const { data: storedDocument, error: documentError } = await dataClient
        .from("documents")
        .select("id,storage_object_key,status")
        .eq("id", uploadBody.documents[0]!.id)
        .single()
      if (documentError) throw documentError
      expect(storedDocument.status).toBe("queued")

      const download = await dataClient.storage
        .from("documents")
        .download(storedDocument.storage_object_key)
      if (download.error) throw download.error
      expect(await download.data.text()).toBe("Zhi Flow 私有知识库内容。")

      const publicUrl = dataClient.storage
        .from("documents")
        .getPublicUrl(storedDocument.storage_object_key).data.publicUrl
      expect((await fetch(publicUrl)).status).not.toBe(200)

      const deleteResponse = await fetch(
        `${baseUrl}/api/knowledge-bases/${knowledgeBaseId}`,
        {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ confirmation: "上传一致性验收" }),
        },
      )
      expect(deleteResponse.status).toBe(204)
      const deletedDocument = await dataClient
        .from("documents")
        .select("id")
        .eq("id", uploadBody.documents[0]!.id)
        .maybeSingle()
      expect(deletedDocument.error).toBeNull()
      expect(deletedDocument.data).toBeNull()
      const deletedObject = await dataClient.storage
        .from("documents")
        .download(storedDocument.storage_object_key)
      expect(deletedObject.error).not.toBeNull()
      expect(deletedObject.data).toBeNull()
      const cleanupJobs = await dataClient
        .from("storage_cleanup_jobs")
        .select("id")
        .eq("knowledge_base_id", knowledgeBaseId)
      expect(cleanupJobs.error).toBeNull()
      expect(cleanupJobs.data).toEqual([])
    })
  })

  it("队列写入失败时保留 Document，并可幂等地手动重新入队", async () => {
    await runLocalDatabaseSql("select pgmq.drop_queue('document_ingestion');")

    try {
      await withDevelopmentServer(async (baseUrl) => {
        const created = (await (
          await fetch(`${baseUrl}/api/knowledge-bases`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: "队列恢复验收" }),
          })
        ).json()) as { knowledgeBase: { id: string } }
        const knowledgeBaseId = created.knowledgeBase.id
        const uploadResponse = await fetch(
          `${baseUrl}/api/knowledge-bases/${knowledgeBaseId}/documents`,
          {
            method: "POST",
            body: filesForm([
              new File(["只应留在私有 Storage。"], "recover.txt", {
                type: "text/plain",
              }),
            ]),
          },
        )
        const uploadBody = (await uploadResponse.json()) as {
          documents: Array<{
            id: string
            status: string
            currentStage: string
            errorCode: string | null
            errorSummary: string | null
          }>
        }
        const document = uploadBody.documents[0]!

        expect(uploadResponse.status).toBe(201)
        expect(document).toMatchObject({
          id: expect.any(String),
          status: "uploaded",
          currentStage: "enqueue_failed",
          errorCode: "QUEUE_WRITE_FAILED",
          errorSummary: expect.stringContaining("手动重新入队"),
        })

        const retryUrl =
          `${baseUrl}/api/knowledge-bases/${knowledgeBaseId}` +
          `/documents/${document.id}/enqueue`
        const unavailableRetry = await fetch(retryUrl, { method: "POST" })
        expect(unavailableRetry.status).toBe(503)
        await expect(unavailableRetry.json()).resolves.toMatchObject({
          document: {
            id: document.id,
            status: "uploaded",
            currentStage: "enqueue_failed",
          },
          error: { code: "QUEUE_WRITE_FAILED" },
        })

        await runLocalDatabaseSql("select pgmq.create('document_ingestion');")

        const retryResponse = await fetch(retryUrl, { method: "POST" })
        expect(retryResponse.status).toBe(200)
        await expect(retryResponse.json()).resolves.toMatchObject({
          document: {
            id: document.id,
            status: "queued",
            currentStage: "queue_pending",
            errorCode: null,
            errorSummary: null,
          },
        })

        const replayResponse = await fetch(retryUrl, { method: "POST" })
        expect(replayResponse.status).toBe(200)

        const queuedPayloads = JSON.parse(
          await runLocalDatabaseSql(
            "select coalesce(jsonb_agg(message order by msg_id), '[]')::text " +
              "from pgmq.read('document_ingestion', 30, 10);",
          ),
        ) as Array<Record<string, unknown>>
        expect(queuedPayloads).toHaveLength(1)
        expect(Object.keys(queuedPayloads[0]!).sort()).toEqual([
          "contentSha256",
          "documentId",
          "idempotencyKey",
          "ingestionVersion",
        ])
        expect(queuedPayloads[0]).toMatchObject({
          documentId: document.id,
          ingestionVersion: 1,
          contentSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
          idempotencyKey: expect.any(String),
        })
        expect(queuedPayloads[0]!.idempotencyKey).toBe(
          `${document.id}:1:${queuedPayloads[0]!.contentSha256}`,
        )
        expect(JSON.stringify(queuedPayloads)).not.toContain(
          "只应留在私有 Storage。",
        )
        expect(JSON.stringify(queuedPayloads)).not.toContain(
          "acceptance-test-secret",
        )

        const dataClient = createClient(
          "http://127.0.0.1:54321",
          localSupabaseServiceRoleKey,
          { auth: { autoRefreshToken: false, persistSession: false } },
        )
        const { error: terminalStateError } = await dataClient
          .from("documents")
          .update({ status: "ready", current_stage: "completed" })
          .eq("id", document.id)
        if (terminalStateError) throw terminalStateError

        const terminalRetry = await fetch(retryUrl, { method: "POST" })
        expect(terminalRetry.status).toBe(409)
        await expect(terminalRetry.json()).resolves.toMatchObject({
          document: {
            id: document.id,
            status: "ready",
            currentStage: "completed",
          },
          error: { code: "REQUEUE_NOT_ALLOWED" },
        })

        await fetch(`${baseUrl}/api/knowledge-bases/${knowledgeBaseId}`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ confirmation: "队列恢复验收" }),
        })
      })
    } finally {
      await runLocalDatabaseSql(
        "select pgmq.drop_queue('document_ingestion'); " +
          "select pgmq.create('document_ingestion');",
      )
    }
  })

  it(
    "通过 HTTP 接缝权威校验文件格式、大小、PDF 与批次数量",
    { timeout: 30_000 },
    async () => {
      await withDevelopmentServer(async (baseUrl) => {
        const created = (await (
          await fetch(`${baseUrl}/api/knowledge-bases`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: "上传校验矩阵" }),
          })
        ).json()) as { knowledgeBase: { id: string } }
        const knowledgeBaseId = created.knowledgeBase.id
        const uploadUrl = `${baseUrl}/api/knowledge-bases/${knowledgeBaseId}/documents`

        await expectUploadError(uploadUrl, [], "INVALID_INPUT")
        await expectUploadError(
          uploadUrl,
          [new File([], "empty.txt", { type: "text/plain" })],
          "EMPTY_FILE",
        )
        await expectUploadError(
          uploadUrl,
          [new File(["not a pdf"], "forged.pdf", { type: "application/pdf" })],
          "INVALID_FILE_TYPE",
        )
        await expectUploadError(
          uploadUrl,
          [new File(["plain text"], "forged.txt", { type: "application/pdf" })],
          "INVALID_FILE_TYPE",
        )
        await expectUploadError(
          uploadUrl,
          [new File(["a,b"], "unsupported.csv", { type: "text/csv" })],
          "INVALID_FILE_TYPE",
        )
        await expectUploadError(
          uploadUrl,
          [
            new File([new Uint8Array([0xff, 0xfe, 0xfd])], "invalid.txt", {
              type: "text/plain",
            }),
          ],
          "INVALID_TEXT_ENCODING",
        )
        await expectUploadError(
          uploadUrl,
          [
            new File(["x".repeat(2_000_001)], "too-many-characters.md", {
              type: "text/markdown",
            }),
          ],
          "PARSED_TEXT_TOO_LARGE",
        )
        await expectUploadError(
          uploadUrl,
          [
            new File([new Uint8Array(20 * 1024 * 1024 + 1)], "too-large.txt", {
              type: "text/plain",
            }),
          ],
          "FILE_TOO_LARGE",
        )
        await expectUploadError(
          uploadUrl,
          Array.from(
            { length: 11 },
            (_, index) =>
              new File(["ok"], `file-${index}.txt`, { type: "text/plain" }),
          ),
          "TOO_MANY_FILES",
        )
        await expectUploadError(
          uploadUrl,
          [
            new File(["%PDF-1.7\nnot a valid PDF"], "damaged.pdf", {
              type: "application/pdf",
            }),
          ],
          "PDF_DAMAGED",
        )
        await expectUploadError(
          uploadUrl,
          [
            new File([createTextPdf(1, "")], "scanned.pdf", {
              type: "application/pdf",
            }),
          ],
          "PDF_NO_TEXT",
        )
        await expectUploadError(
          uploadUrl,
          [
            new File([createTextPdf(201, "page")], "too-many-pages.pdf", {
              type: "application/pdf",
            }),
          ],
          "PDF_TOO_MANY_PAGES",
        )

        const validForm = filesForm([
          new File([createTextPdf(2, "searchable text")], "manual.pdf", {
            type: "application/pdf",
          }),
          new File(["# Markdown\n可检索正文"], "notes.md", {
            type: "text/markdown",
          }),
        ])
        const validResponse = await fetch(uploadUrl, {
          method: "POST",
          body: validForm,
        })
        expect(validResponse.status).toBe(201)
        await expect(validResponse.json()).resolves.toMatchObject({
          documents: [
            {
              originalFilename: "manual.pdf",
              mimeType: "application/pdf",
              pageCount: 2,
              status: "queued",
            },
            {
              originalFilename: "notes.md",
              mimeType: "text/markdown",
              pageCount: null,
              status: "queued",
            },
          ],
        })

        const dataClient = createClient(
          "http://127.0.0.1:54321",
          localSupabaseServiceRoleKey,
          { auth: { autoRefreshToken: false, persistSession: false } },
        )
        const { count, error } = await dataClient
          .from("documents")
          .select("id", { count: "exact", head: true })
          .eq("knowledge_base_id", knowledgeBaseId)
        if (error) throw error
        expect(count).toBe(2)

        await fetch(`${baseUrl}/api/knowledge-bases/${knowledgeBaseId}`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ confirmation: "上传校验矩阵" }),
        })
      })
    },
  )

  it("按助手 Message 停止生成并持久化 cancelled 终态", async () => {
    let resolveProviderCancellation: (() => void) | undefined
    const providerCancelled = new Promise<void>((resolve) => {
      resolveProviderCancellation = resolve
    })

    await withChatUpstream(
      (_request, response) => {
        response.setHeader("Content-Type", "text/event-stream")
        response.write(
          'data: {"choices":[{"delta":{"content":"停止前已保存"}}]}\n\n',
        )
        response.once("close", () => resolveProviderCancellation?.())
      },
      async (upstreamUrl) => {
        await withDevelopmentServer(
          async (baseUrl) => {
            const created = (await (
              await fetch(`${baseUrl}/api/conversations`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ title: "取消终态验收" }),
              })
            ).json()) as { conversation: { id: string } }
            const response = await fetch(`${baseUrl}/api/chat`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                conversationId: created.conversation.id,
                clientIdempotencyKey: "66666666-6666-4666-8666-666666666666",
                message: "测试持久化取消终态。",
              }),
            })
            if (response.body === null) throw new Error("聊天响应没有正文流")
            const reader = response.body.getReader()
            const firstPart = await readStreamUntil(reader, "停止前已保存")
            const assistantMessageId =
              readSseEvents(firstPart)[0]?.data.assistantMessageId
            expect(assistantMessageId).toEqual(expect.any(String))

            const stopResponse = await withBareDevelopmentServer(
              (cancellationBaseUrl) =>
                fetch(`${cancellationBaseUrl}/api/chat`, {
                  method: "DELETE",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ assistantMessageId }),
                }),
              { ZHI_FLOW_CHAT_BASE_URL: `${upstreamUrl}/v1` },
            )
            const events = readSseEvents(
              firstPart + (await readRemainingStream(reader)),
            )
            expect(stopResponse.status).toBe(202)
            expect(events.at(-1)?.event).toBe("message.cancelled")
            await expect(providerCancelled).resolves.toBeUndefined()

            const history = (await (
              await fetch(
                `${baseUrl}/api/conversations/${created.conversation.id}`,
              )
            ).json()) as { messages: Array<Record<string, unknown>> }
            expect(history.messages[1]).toMatchObject({
              id: assistantMessageId,
              content: "停止前已保存",
              status: "cancelled",
              errorCode: null,
            })

            await fetch(
              `${baseUrl}/api/conversations/${created.conversation.id}`,
              { method: "DELETE" },
            )
          },
          { ZHI_FLOW_CHAT_BASE_URL: `${upstreamUrl}/v1` },
        )
      },
    )
  })

  it("刷新读取时将遗留 streaming Message 恢复为可解释的 failed 终态", async () => {
    await withDevelopmentServer(async (baseUrl) => {
      const created = (await (
        await fetch(`${baseUrl}/api/conversations`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "遗留 streaming 恢复验收" }),
        })
      ).json()) as { conversation: { id: string } }
      const conversationId = created.conversation.id
      const dataClient = createClient(
        "http://127.0.0.1:54321",
        localSupabaseServiceRoleKey,
        { auth: { autoRefreshToken: false, persistSession: false } },
      )
      const { data: userMessage, error: userError } = await dataClient
        .from("messages")
        .insert({
          conversation_id: conversationId,
          role: "user",
          content: "刷新前的问题",
          status: "completed",
          client_idempotency_key: "77777777-7777-4777-8777-777777777777",
        })
        .select("id")
        .single()
      if (userError) throw userError
      const { error: assistantError } = await dataClient
        .from("messages")
        .insert({
          conversation_id: conversationId,
          role: "assistant",
          content: "刷新前的部分回答",
          status: "streaming",
          source_message_id: userMessage.id,
          updated_at: new Date(Date.now() - 10 * 60_000).toISOString(),
        })
      if (assistantError) throw assistantError

      const response = await fetch(
        `${baseUrl}/api/conversations/${conversationId}`,
      )
      const history = (await response.json()) as {
        messages: Array<Record<string, unknown>>
      }
      expect(response.status).toBe(200)
      expect(history.messages[1]).toMatchObject({
        role: "assistant",
        content: "刷新前的部分回答",
        status: "failed",
        errorCode: "STREAM_INTERRUPTED",
      })

      await fetch(`${baseUrl}/api/conversations/${conversationId}`, {
        method: "DELETE",
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
              body: JSON.stringify(
                chatRequestBody({
                  requestId: "11111111-1111-4111-8111-111111111111",
                  message: "请给我一个简短回答。",
                }),
              ),
            })
            const body = await response.text()
            const events = readSseEvents(body)

            expect(response.status).toBe(200)
            expect(body).toContain(": heartbeat ")
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
          {
            ZHI_FLOW_CHAT_BASE_URL: `${upstreamUrl}/v1`,
            ZHI_FLOW_CHAT_HEARTBEAT_INTERVAL_MS: "10",
          },
        )
      },
    )
  })

  it("通过公开 HTTP 接缝拒绝空输入", async () => {
    await withDevelopmentServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(chatRequestBody({ message: "  \n  " })),
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
        body: JSON.stringify(chatRequestBody({ message: "长".repeat(4_001) })),
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
          body: JSON.stringify(chatRequestBody({ message })),
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
    const conversationResponse = await fetch(`${baseUrl}/api/conversations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: `验收会话 ${crypto.randomUUID()}` }),
    })
    if (!conversationResponse.ok) throw new Error("无法创建验收 Conversation")
    const body = (await conversationResponse.json()) as {
      conversation: { id: string }
    }
    currentTestConversationId = body.conversation.id
    await assertions(baseUrl)
  } finally {
    if (currentTestConversationId !== null) {
      await fetch(`${baseUrl}/api/conversations/${currentTestConversationId}`, {
        method: "DELETE",
      }).catch(() => undefined)
    }
    currentTestConversationId = null
    await stopProcess(application)
  }
}

async function expectUploadError(
  uploadUrl: string,
  files: File[],
  expectedCode: string,
): Promise<void> {
  const response = await fetch(uploadUrl, {
    method: "POST",
    body: filesForm(files),
  })
  expect(response.status).toBe(400)
  await expect(response.json()).resolves.toMatchObject({
    error: { code: expectedCode, message: expect.any(String) },
  })
}

async function runLocalDatabaseSql(sql: string): Promise<string> {
  const database = spawn(
    "docker",
    [
      "exec",
      "supabase_db_zhi-flow",
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
      "-At",
      "-c",
      sql,
    ],
    { cwd: process.cwd(), stdio: "pipe" },
  )
  let stdout = ""
  let stderr = ""
  database.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString()
  })
  database.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString()
  })

  const code = await new Promise<number | null>((resolve, reject) => {
    database.once("error", reject)
    database.once("exit", resolve)
  })
  if (code !== 0) {
    throw new Error(`本地数据库命令失败：${stderr.trim()}`)
  }
  return stdout.trim()
}

function filesForm(files: File[]): FormData {
  const form = new FormData()
  for (const file of files) form.append("files", file)
  return form
}

function createTextPdf(pageCount: number, text: string): string {
  const encoder = new TextEncoder()
  const escapedText = text.replaceAll("\\", "\\\\").replaceAll("(", "\\(")
  const objects: string[] = []
  const pageObjectNumbers = Array.from(
    { length: pageCount },
    (_, index) => 3 + index * 2,
  )
  const fontObjectNumber = 3 + pageCount * 2

  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>"
  objects[2] =
    `<< /Type /Pages /Kids [${pageObjectNumbers.map((number) => `${number} 0 R`).join(" ")}] ` +
    `/Count ${pageCount} >>`
  for (let index = 0; index < pageCount; index += 1) {
    const pageObjectNumber = pageObjectNumbers[index]!
    const contentObjectNumber = pageObjectNumber + 1
    const stream = `BT /F1 12 Tf 72 72 Td (${escapedText}) Tj ET`
    objects[pageObjectNumber] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] ` +
      `/Resources << /Font << /F1 ${fontObjectNumber} 0 R >> >> ` +
      `/Contents ${contentObjectNumber} 0 R >>`
    objects[contentObjectNumber] =
      `<< /Length ${encoder.encode(stream).length} >>\nstream\n${stream}\nendstream`
  }
  objects[fontObjectNumber] =
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"

  let pdf = "%PDF-1.4\n"
  const offsets = [0]
  for (let objectNumber = 1; objectNumber < objects.length; objectNumber += 1) {
    offsets[objectNumber] = encoder.encode(pdf).length
    pdf += `${objectNumber} 0 obj\n${objects[objectNumber]}\nendobj\n`
  }
  const xrefOffset = encoder.encode(pdf).length
  pdf += `xref\n0 ${objects.length}\n`
  pdf += "0000000000 65535 f \n"
  for (let objectNumber = 1; objectNumber < objects.length; objectNumber += 1) {
    pdf += `${String(offsets[objectNumber]).padStart(10, "0")} 00000 n \n`
  }
  pdf +=
    `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\n` +
    `startxref\n${xrefOffset}\n%%EOF\n`
  return pdf
}

async function withBareDevelopmentServer<T>(
  assertions: (baseUrl: string) => Promise<T>,
  environmentOverrides: Partial<NodeJS.ProcessEnv> = {},
): Promise<T> {
  const port = await findAvailablePort()
  const application = startDevelopmentServer(port, environmentOverrides)
  const baseUrl = `http://127.0.0.1:${port}`

  try {
    await waitUntilReachable(baseUrl)
    return await assertions(baseUrl)
  } finally {
    await stopProcess(application)
  }
}

function chatRequestBody({
  message,
  requestId,
}: {
  message: string
  requestId?: string
}) {
  if (currentTestConversationId === null) {
    throw new Error("验收 Conversation 尚未创建")
  }
  return {
    conversationId: currentTestConversationId,
    clientIdempotencyKey: requestId ?? crypto.randomUUID(),
    ...(requestId ? { requestId } : {}),
    message,
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
    ZHI_FLOW_SUPABASE_SECRET_KEY: localSupabaseServiceRoleKey,
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
