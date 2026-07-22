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
type ProviderMessage = Readonly<{
  role: "user" | "assistant"
  content: string
}>
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

      expect(response.status).toBe(200)
      expect(html).toContain("Zhi Flow")
      expect(html).toContain("观察多轮上下文增长")
      expect(html).toContain("输入消息")
      expect(html).toContain("发送消息")
      expect(html).toContain("新建会话")
      expect(html).toContain("选择一个 Conversation")
      expect(html).toContain("最近 12 条已完成 Message")
      expect(html).toContain("输入 Token")
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

  it("在 SSE 开始前持久化 Message，完成后可刷新读取且重复幂等键不重复生成", async () => {
    let upstreamRequests = 0

    await withChatUpstream(
      (_request, response) => {
        upstreamRequests += 1
        response.setHeader("Content-Type", "text/event-stream")
        response.end(
          'data: {"choices":[{"delta":{"content":"持久化回答"}}]}\n\n' +
            'data: {"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":3,"total_tokens":5}}\n\n' +
            "data: [DONE]\n\n",
        )
      },
      async (upstreamUrl) => {
        await withDevelopmentServer(
          async (baseUrl) => {
            const createResponse = await fetch(`${baseUrl}/api/conversations`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ title: "Message 持久化验收" }),
            })
            const created = (await createResponse.json()) as {
              conversation: { id: string }
            }
            const conversationId = created.conversation.id
            const clientIdempotencyKey = "33333333-3333-4333-8333-333333333333"

            const response = await fetch(`${baseUrl}/api/chat`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                conversationId,
                clientIdempotencyKey,
                requestId: clientIdempotencyKey,
                message: "请持久化这条消息。",
              }),
            })
            const events = readSseEvents(await response.text())

            expect(response.status).toBe(200)
            expect(events[0]?.data).toMatchObject({
              type: "message.created",
              userMessageId: expect.any(String),
              assistantMessageId: expect.any(String),
            })

            const readResponse = await fetch(
              `${baseUrl}/api/conversations/${conversationId}`,
            )
            const history = (await readResponse.json()) as {
              messages: Array<Record<string, unknown>>
            }
            expect(history.messages).toEqual([
              expect.objectContaining({
                role: "user",
                content: "请持久化这条消息。",
                status: "completed",
              }),
              expect.objectContaining({
                role: "assistant",
                content: "持久化回答",
                status: "completed",
                sourceMessageId: events[0]?.data.userMessageId,
                errorCode: null,
              }),
            ])

            const duplicateResponse = await fetch(`${baseUrl}/api/chat`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                conversationId,
                clientIdempotencyKey,
                requestId: "44444444-4444-4444-8444-444444444444",
                message: "请持久化这条消息。",
              }),
            })
            expect(duplicateResponse.status).toBe(409)
            await expect(duplicateResponse.json()).resolves.toMatchObject({
              error: { code: "IDEMPOTENCY_REPLAY" },
              submission: {
                userMessageId: events[0]?.data.userMessageId,
                assistantMessageId: events[0]?.data.assistantMessageId,
                assistantMessageStatus: "completed",
              },
            })
            expect(upstreamRequests).toBe(1)

            const refreshed = (await (
              await fetch(`${baseUrl}/api/conversations/${conversationId}`)
            ).json()) as { messages: Array<{ role: string }> }
            expect(
              refreshed.messages.filter(({ role }) => role === "user"),
            ).toHaveLength(1)
            expect(refreshed.messages).toHaveLength(2)

            await fetch(`${baseUrl}/api/conversations/${conversationId}`, {
              method: "DELETE",
            })
          },
          { ZHI_FLOW_CHAT_BASE_URL: `${upstreamUrl}/v1` },
        )
      },
    )
  })

  it("通用聊天按序发送已完成 Message，并隔离其他 Conversation 与无效助手正文", async () => {
    const providerRequests: ProviderMessage[][] = []

    await withChatUpstream(
      async (request, response) => {
        const body = JSON.parse(await readRequestText(request)) as {
          messages: ProviderMessage[]
        }
        providerRequests.push(body.messages)
        response.setHeader("Content-Type", "text/event-stream")
        response.end(
          'data: {"choices":[{"delta":{"content":"续聊成功"}}]}\n\n' +
            'data: {"choices":[],"usage":{"prompt_tokens":21,"completion_tokens":4,"total_tokens":25}}\n\n' +
            "data: [DONE]\n\n",
        )
      },
      async (upstreamUrl) => {
        await withDevelopmentServer(
          async (baseUrl) => {
            if (currentTestConversationId === null) {
              throw new Error("验收 Conversation 尚未创建")
            }
            const dataClient = createAcceptanceDataClient()

            async function sendMessage(message: string) {
              const response = await fetch(`${baseUrl}/api/chat`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(chatRequestBody({ message })),
              })
              expect(response.status).toBe(200)
              expect(readSseEvents(await response.text()).at(-1)?.event).toBe(
                "message.completed",
              )
            }

            await sendMessage("我的代号是星河。")
            await sendMessage("我的代号是什么？")

            const startedAt = Date.now() + 10_000

            async function insertAttempt(
              sequence: number,
              userContent: string,
              assistantContent: string,
              assistantStatus:
                "streaming" | "completed" | "cancelled" | "failed",
              conversationId = currentTestConversationId,
            ) {
              const userCreatedAt = new Date(
                startedAt + sequence * 2_000,
              ).toISOString()
              const { data: userMessage, error: userError } = await dataClient
                .from("messages")
                .insert({
                  conversation_id: conversationId,
                  role: "user",
                  content: userContent,
                  status: "completed",
                  client_idempotency_key: crypto.randomUUID(),
                  created_at: userCreatedAt,
                  updated_at: userCreatedAt,
                })
                .select("id")
                .single()
              if (userError) throw userError

              const assistantCreatedAt = new Date(
                startedAt + sequence * 2_000 + 1_000,
              ).toISOString()
              const { error: assistantError } = await dataClient
                .from("messages")
                .insert({
                  conversation_id: conversationId,
                  role: "assistant",
                  content: assistantContent,
                  status: assistantStatus,
                  source_message_id: userMessage.id,
                  created_at: assistantCreatedAt,
                  updated_at: assistantCreatedAt,
                })
              if (assistantError) throw assistantError
            }

            await insertAttempt(0, "失败问题", "不应出现的失败正文", "failed")
            await insertAttempt(
              1,
              "取消问题",
              "不应出现的取消正文",
              "cancelled",
            )
            await insertAttempt(2, "中断问题", "不应出现的中断正文", "failed")

            const isolated = (await (
              await fetch(`${baseUrl}/api/conversations`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ title: "隔离 Conversation" }),
              })
            ).json()) as { conversation: { id: string } }
            await insertAttempt(
              3,
              "另一个 Conversation 的问题",
              "另一个 Conversation 的回答",
              "completed",
              isolated.conversation.id,
            )

            await sendMessage("失败后继续。")
            expect(providerRequests).toEqual([
              [{ role: "user", content: "我的代号是星河。" }],
              [
                { role: "user", content: "我的代号是星河。" },
                { role: "assistant", content: "续聊成功" },
                { role: "user", content: "我的代号是什么？" },
              ],
              [
                { role: "user", content: "我的代号是星河。" },
                { role: "assistant", content: "续聊成功" },
                { role: "user", content: "我的代号是什么？" },
                { role: "assistant", content: "续聊成功" },
                { role: "user", content: "失败问题" },
                { role: "user", content: "取消问题" },
                { role: "user", content: "中断问题" },
                { role: "user", content: "失败后继续。" },
              ],
            ])

            await fetch(
              `${baseUrl}/api/conversations/${isolated.conversation.id}`,
              { method: "DELETE" },
            )
          },
          { ZHI_FLOW_CHAT_BASE_URL: `${upstreamUrl}/v1` },
        )
      },
    )
  })

  it("通用聊天只向 Provider 发送最近十二条已完成 Message", async () => {
    let providerMessages: ProviderMessage[] = []

    await withChatUpstream(
      async (request, response) => {
        const body = JSON.parse(await readRequestText(request)) as {
          messages: typeof providerMessages
        }
        providerMessages = body.messages
        response.setHeader("Content-Type", "text/event-stream")
        response.end(
          'data: {"choices":[{"delta":{"content":"已截断上下文"}}]}\n\n' +
            'data: {"choices":[],"usage":{"prompt_tokens":48,"completion_tokens":5,"total_tokens":53}}\n\n' +
            "data: [DONE]\n\n",
        )
      },
      async (upstreamUrl) => {
        await withDevelopmentServer(
          async (baseUrl) => {
            if (currentTestConversationId === null) {
              throw new Error("验收 Conversation 尚未创建")
            }
            const dataClient = createAcceptanceDataClient()
            const createdAt = Date.now() - 60_000
            const { error } = await dataClient.from("messages").insert(
              Array.from({ length: 13 }, (_, index) => {
                const timestamp = new Date(
                  createdAt + index * 1_000,
                ).toISOString()
                return {
                  conversation_id: currentTestConversationId,
                  role: "user",
                  content: `历史 Message ${index + 1}`,
                  status: "completed",
                  client_idempotency_key: crypto.randomUUID(),
                  created_at: timestamp,
                  updated_at: timestamp,
                }
              }),
            )
            if (error) throw error

            const response = await fetch(`${baseUrl}/api/chat`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(
                chatRequestBody({ message: "当前 Message 14" }),
              ),
            })
            const events = readSseEvents(await response.text())

            expect(response.status).toBe(200)
            expect(providerMessages).toHaveLength(12)
            expect(providerMessages.map(({ content }) => content)).toEqual([
              ...Array.from(
                { length: 11 },
                (_, index) => `历史 Message ${index + 3}`,
              ),
              "当前 Message 14",
            ])
            expect(events).toContainEqual(
              expect.objectContaining({
                event: "usage.snapshot",
                data: expect.objectContaining({
                  usage: {
                    inputTokens: 48,
                    outputTokens: 5,
                    totalTokens: 53,
                  },
                }),
              }),
            )
          },
          { ZHI_FLOW_CHAT_BASE_URL: `${upstreamUrl}/v1` },
        )
      },
    )
  })

  it("流中断后保留已生成正文并持久化 failed 终态", async () => {
    await withChatUpstream(
      (_request, response) => {
        response.setHeader("Content-Type", "text/event-stream")
        response.end(
          'data: {"choices":[{"delta":{"content":"中断前已保存"}}]}\n\n',
        )
      },
      async (upstreamUrl) => {
        await withDevelopmentServer(
          async (baseUrl) => {
            const created = (await (
              await fetch(`${baseUrl}/api/conversations`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ title: "失败终态验收" }),
              })
            ).json()) as { conversation: { id: string } }

            const response = await fetch(`${baseUrl}/api/chat`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                conversationId: created.conversation.id,
                clientIdempotencyKey: "55555555-5555-4555-8555-555555555555",
                message: "测试持久化失败终态。",
              }),
            })
            const events = readSseEvents(await response.text())
            expect(events.map(({ event }) => event)).toEqual([
              "message.created",
              "content.delta",
              "message.failed",
            ])

            const history = (await (
              await fetch(
                `${baseUrl}/api/conversations/${created.conversation.id}`,
              )
            ).json()) as { messages: Array<Record<string, unknown>> }
            expect(history.messages[1]).toMatchObject({
              role: "assistant",
              content: "中断前已保存",
              status: "failed",
              errorCode: "STREAM_INTERRUPTED",
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

  it("当前实例没有内存任务时仍按助手 Message 持久化取消", async () => {
    await withDevelopmentServer(async (baseUrl) => {
      if (currentTestConversationId === null) {
        throw new Error("验收 Conversation 尚未创建")
      }
      const dataClient = createClient(
        "http://127.0.0.1:54321",
        localSupabaseServiceRoleKey,
        { auth: { autoRefreshToken: false, persistSession: false } },
      )
      const { data: userMessage, error: userError } = await dataClient
        .from("messages")
        .insert({
          conversation_id: currentTestConversationId,
          role: "user",
          content: "跨实例取消问题",
          status: "completed",
          client_idempotency_key: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        })
        .select("id")
        .single()
      if (userError) throw userError
      const { data: assistantMessage, error: assistantError } = await dataClient
        .from("messages")
        .insert({
          conversation_id: currentTestConversationId,
          role: "assistant",
          content: "已持久化的部分正文",
          status: "streaming",
          source_message_id: userMessage.id,
        })
        .select("id")
        .single()
      if (assistantError) throw assistantError

      const response = await fetch(`${baseUrl}/api/chat`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assistantMessageId: assistantMessage.id }),
      })
      expect(response.status).toBe(202)

      const history = (await (
        await fetch(`${baseUrl}/api/conversations/${currentTestConversationId}`)
      ).json()) as { messages: Array<Record<string, unknown>> }
      expect(history.messages).toContainEqual(
        expect.objectContaining({
          id: assistantMessage.id,
          content: "已持久化的部分正文",
          status: "cancelled",
        }),
      )
    })
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
              body: JSON.stringify(
                chatRequestBody({ message: "测试首字节超时。" }),
              ),
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
              body: JSON.stringify(
                chatRequestBody({ message: "测试流中断。" }),
              ),
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
              body: JSON.stringify(
                chatRequestBody({ message: "测试流空闲超时。" }),
              ),
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
              body: JSON.stringify(
                chatRequestBody({ message: "测试聊天总时限。" }),
              ),
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
              body: JSON.stringify(
                chatRequestBody({ requestId, message: "测试停止。" }),
              ),
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

async function readRequestText(request: IncomingMessage): Promise<string> {
  let body = ""
  for await (const chunk of request) body += String(chunk)
  return body
}

function createAcceptanceDataClient() {
  return createClient("http://127.0.0.1:54321", localSupabaseServiceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
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
