"use client"

import { FormEvent, useCallback, useEffect, useRef, useState } from "react"
import {
  LoaderCircleIcon,
  PencilIcon,
  PlusIcon,
  SendIcon,
  SquareIcon,
  Trash2Icon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  MAX_CHAT_MESSAGE_LENGTH,
  type ChatErrorResponse,
  type ChatTokenUsage,
} from "@/lib/chat-api"
import { readChatEventStream } from "@/lib/chat-stream-client"
import type {
  Conversation,
  Message as ConversationMessage,
} from "@/lib/conversation-api"
import { cn } from "@/lib/utils"

type GenerationStatus = "idle" | "streaming" | "stopping"

export function ChatPanel() {
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [selectedConversationId, setSelectedConversationId] = useState<
    string | null
  >(null)
  const [messages, setMessages] = useState<ConversationMessage[]>([])
  const [message, setMessage] = useState("")
  const [usage, setUsage] = useState<ChatTokenUsage | null>(null)
  const [latencyMs, setLatencyMs] = useState<number | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [status, setStatus] = useState<GenerationStatus>("idle")
  const [canStop, setCanStop] = useState(false)
  const activeRequestId = useRef<string | null>(null)
  const activeAssistantMessageId = useRef<string | null>(null)
  const isGenerating = status !== "idle"

  const openConversation = useCallback(async (conversationId: string) => {
    const body = await fetchConversation(conversationId)
    setSelectedConversationId(body.conversation.id)
    setMessages(body.messages)
  }, [])

  const refreshConversations = useCallback(
    async (preferredConversationId?: string) => {
      const body = await fetchConversations()
      setConversations(body.conversations)
      const target =
        preferredConversationId ??
        selectedConversationId ??
        body.conversations[0]?.id
      if (target && body.conversations.some(({ id }) => id === target)) {
        await openConversation(target)
      } else {
        setSelectedConversationId(null)
        setMessages([])
      }
    },
    [openConversation, selectedConversationId],
  )

  useEffect(() => {
    let ignore = false

    void (async () => {
      try {
        const body = await fetchConversations()
        if (ignore) return
        setConversations(body.conversations)

        const firstConversationId = body.conversations[0]?.id
        if (!firstConversationId) return
        const conversationBody = await fetchConversation(firstConversationId)
        if (ignore) return
        setSelectedConversationId(conversationBody.conversation.id)
        setMessages(conversationBody.messages)
      } catch (error) {
        if (!ignore) setErrorMessage(readUnknownError(error))
      }
    })()

    return () => {
      ignore = true
    }
  }, [])

  async function createNewConversation() {
    setErrorMessage(null)
    const response = await fetch("/api/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "新会话" }),
    })
    if (!response.ok) {
      setErrorMessage("无法新建会话。")
      return
    }
    const body = (await response.json()) as { conversation: Conversation }
    await refreshConversations(body.conversation.id)
  }

  async function renameSelectedConversation() {
    const conversation = conversations.find(
      ({ id }) => id === selectedConversationId,
    )
    if (!conversation) return
    const title = window.prompt("新的会话标题", conversation.title)?.trim()
    if (!title || title === conversation.title) return

    const response = await fetch(`/api/conversations/${conversation.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    })
    if (!response.ok) {
      setErrorMessage("无法重命名会话。")
      return
    }
    await refreshConversations(conversation.id)
  }

  async function deleteSelectedConversation() {
    const conversation = conversations.find(
      ({ id }) => id === selectedConversationId,
    )
    if (!conversation || !window.confirm(`删除“${conversation.title}”？`))
      return

    const response = await fetch(`/api/conversations/${conversation.id}`, {
      method: "DELETE",
    })
    if (!response.ok) {
      setErrorMessage("无法删除会话。")
      return
    }
    setSelectedConversationId(null)
    setMessages([])
    await refreshConversations()
  }

  async function submitMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!selectedConversationId || !message.trim()) return
    const requestId = crypto.randomUUID()
    activeRequestId.current = requestId
    activeAssistantMessageId.current = null
    setCanStop(false)
    setUsage(null)
    setLatencyMs(null)
    setErrorMessage(null)
    setStatus("streaming")

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId: selectedConversationId,
          clientIdempotencyKey: requestId,
          requestId,
          message,
        }),
      })
      if (!response.ok) {
        const body: unknown = await response.json()
        throw new Error(readErrorMessage(body))
      }

      for await (const streamEvent of readChatEventStream(
        response,
        requestId,
      )) {
        if (streamEvent.type === "message.created") {
          activeAssistantMessageId.current = streamEvent.assistantMessageId
          setCanStop(true)
          setMessage("")
          await openConversation(selectedConversationId)
        } else if (streamEvent.type === "content.delta") {
          updateAssistantMessage(streamEvent.requestId, (current) => ({
            ...current,
            content: current.content + streamEvent.delta,
          }))
        } else if (streamEvent.type === "usage.snapshot") {
          setUsage(streamEvent.usage)
        } else if (streamEvent.type === "message.completed") {
          setLatencyMs(streamEvent.latencyMs)
          updateAssistantMessage(streamEvent.requestId, (current) => ({
            ...current,
            status: "completed",
          }))
        } else if (streamEvent.type === "message.cancelled") {
          updateAssistantMessage(streamEvent.requestId, (current) => ({
            ...current,
            status: "cancelled",
          }))
        } else if (streamEvent.type === "message.failed") {
          setErrorMessage(streamEvent.error.message)
          updateAssistantMessage(streamEvent.requestId, (current) => ({
            ...current,
            status: "failed",
            errorCode: streamEvent.error.code,
          }))
        }
      }
    } catch (error) {
      setErrorMessage(readUnknownError(error))
    } finally {
      activeRequestId.current = null
      activeAssistantMessageId.current = null
      setCanStop(false)
      setStatus("idle")
      await openConversation(selectedConversationId).catch(() => undefined)
      await refreshConversations(selectedConversationId).catch(() => undefined)
    }
  }

  function updateAssistantMessage(
    requestId: string,
    update: (message: ConversationMessage) => ConversationMessage,
  ) {
    if (activeRequestId.current !== requestId) return
    const assistantMessageId = activeAssistantMessageId.current
    setMessages((current) =>
      current.map((item) =>
        item.id === assistantMessageId ? update(item) : item,
      ),
    )
  }

  async function stopGeneration() {
    const assistantMessageId = activeAssistantMessageId.current
    if (assistantMessageId === null || status === "stopping") return
    setStatus("stopping")

    try {
      const response = await fetch("/api/chat", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assistantMessageId }),
      })
      if (!response.ok) throw new Error("停止请求未被接受")
    } catch {
      setErrorMessage("无法停止本次生成，请稍后重试。")
      setStatus("streaming")
    }
  }

  return (
    <div className="grid w-full gap-6 lg:grid-cols-[18rem_minmax(0,1fr)]">
      <Card className="[--card-spacing:--spacing(5)]">
        <CardHeader className="gap-3">
          <CardTitle className="text-xl">Conversations</CardTitle>
          <Button onClick={createNewConversation} disabled={isGenerating}>
            <PlusIcon data-icon="inline-start" />
            新建会话
          </Button>
        </CardHeader>
        <CardContent className="grid gap-3">
          {conversations.length === 0 ? (
            <p className="text-sm leading-6 text-muted-foreground">
              尚无 Conversation。新建后即可发送 Message。
            </p>
          ) : (
            <div className="grid gap-2">
              {conversations.map((conversation) => (
                <Button
                  key={conversation.id}
                  variant={
                    conversation.id === selectedConversationId
                      ? "secondary"
                      : "ghost"
                  }
                  className="h-auto justify-start py-2.5 text-left whitespace-normal"
                  disabled={isGenerating}
                  onClick={() => void openConversation(conversation.id)}
                >
                  {conversation.title}
                </Button>
              ))}
            </div>
          )}
          {selectedConversationId ? (
            <div className="grid grid-cols-2 gap-2 border-t pt-3">
              <Button
                variant="outline"
                onClick={renameSelectedConversation}
                disabled={isGenerating}
              >
                <PencilIcon data-icon="inline-start" />
                重命名
              </Button>
              <Button
                variant="destructive"
                onClick={deleteSelectedConversation}
                disabled={isGenerating}
              >
                <Trash2Icon data-icon="inline-start" />
                删除
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card className="[--card-spacing:--spacing(6)]">
        <CardHeader className="gap-2">
          <CardTitle className="text-xl">输入消息</CardTitle>
          <CardDescription className="text-base leading-relaxed">
            Message 会在生成前持久化；刷新后可从数据库恢复。
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-6">
          {selectedConversationId ? (
            <div
              className="grid min-h-72 content-start gap-4"
              aria-live="polite"
            >
              {messages.length === 0 ? (
                <p className="text-muted-foreground">发送第一条 Message。</p>
              ) : (
                messages.map((item) => (
                  <article
                    key={item.id}
                    className={cn(
                      "max-w-[88%] rounded-xl border px-4 py-3",
                      item.role === "user"
                        ? "ml-auto bg-primary text-primary-foreground"
                        : "mr-auto bg-muted/40",
                    )}
                  >
                    <p className="whitespace-pre-wrap text-base leading-7">
                      {item.content || "等待首个正文增量…"}
                    </p>
                    {item.role === "assistant" ? (
                      <p className="mt-2 text-xs opacity-70">
                        {messageStatusLabel(item)}
                      </p>
                    ) : null}
                  </article>
                ))
              )}
            </div>
          ) : (
            <div className="grid min-h-72 place-items-center rounded-xl border border-dashed p-8 text-center text-muted-foreground">
              选择一个 Conversation，或新建会话。
            </div>
          )}

          {errorMessage ? (
            <p className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-base leading-relaxed text-destructive">
              {errorMessage}
            </p>
          ) : null}

          {usage && latencyMs !== null ? (
            <p className="text-sm text-muted-foreground">
              {latencyMs} ms · 输入 {usage.inputTokens} · 输出{" "}
              {usage.outputTokens}· 总计 {usage.totalTokens} tokens
            </p>
          ) : null}

          <form className="grid gap-3 border-t pt-5" onSubmit={submitMessage}>
            <label className="sr-only" htmlFor="chat-message">
              消息内容
            </label>
            <textarea
              id="chat-message"
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              maxLength={MAX_CHAT_MESSAGE_LENGTH}
              rows={4}
              disabled={!selectedConversationId || isGenerating}
              placeholder="例如：用三句话解释向量检索。"
              className="w-full resize-y rounded-lg border bg-background px-4 py-3 text-base leading-relaxed shadow-xs outline-none transition-shadow placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-60"
            />
            <div className="flex items-center justify-between gap-4">
              <span className="text-xs text-muted-foreground">
                {message.length} / {MAX_CHAT_MESSAGE_LENGTH}
              </span>
              {isGenerating ? (
                <Button
                  type="button"
                  variant="destructive"
                  size="lg"
                  disabled={status === "stopping" || !canStop}
                  onClick={stopGeneration}
                >
                  {status === "stopping" ? (
                    <LoaderCircleIcon
                      data-icon="inline-start"
                      className="animate-spin"
                    />
                  ) : (
                    <SquareIcon data-icon="inline-start" />
                  )}
                  {status === "stopping" ? "正在停止…" : "停止生成"}
                </Button>
              ) : (
                <Button
                  type="submit"
                  size="lg"
                  disabled={!selectedConversationId || !message.trim()}
                >
                  <SendIcon data-icon="inline-start" />
                  发送消息
                </Button>
              )}
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}

function messageStatusLabel(message: ConversationMessage): string {
  if (message.status === "streaming") return "正在生成"
  if (message.status === "completed") return "已完成"
  if (message.status === "cancelled") return "已取消"
  return message.errorCode === "STREAM_INTERRUPTED"
    ? "生成中断，可重新发送"
    : "生成失败，可重新发送"
}

function readUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : "操作失败，请稍后重试。"
}

function readErrorMessage(body: unknown): string {
  if (
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    typeof body.error === "object" &&
    body.error !== null &&
    "message" in body.error &&
    typeof body.error.message === "string"
  ) {
    return (body as ChatErrorResponse).error.message
  }
  return "聊天服务暂时不可用，请稍后重试。"
}

async function fetchConversations(): Promise<{
  conversations: Conversation[]
}> {
  const response = await fetch("/api/conversations", { cache: "no-store" })
  if (!response.ok) throw new Error("无法读取会话列表。")
  return (await response.json()) as { conversations: Conversation[] }
}

async function fetchConversation(conversationId: string): Promise<{
  conversation: Conversation
  messages: ConversationMessage[]
}> {
  const response = await fetch(`/api/conversations/${conversationId}`, {
    cache: "no-store",
  })
  if (!response.ok) throw new Error("无法读取会话。")
  return (await response.json()) as {
    conversation: Conversation
    messages: ConversationMessage[]
  }
}
