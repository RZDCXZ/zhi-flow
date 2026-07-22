"use client"

import { FormEvent, useRef, useState } from "react"
import { LoaderCircleIcon, SendIcon, SquareIcon } from "lucide-react"

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

type GenerationStatus =
  "idle" | "streaming" | "stopping" | "completed" | "cancelled" | "failed"

export function ChatPanel() {
  const [message, setMessage] = useState("")
  const [answer, setAnswer] = useState("")
  const [usage, setUsage] = useState<ChatTokenUsage | null>(null)
  const [latencyMs, setLatencyMs] = useState<number | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [status, setStatus] = useState<GenerationStatus>("idle")
  const activeRequestId = useRef<string | null>(null)
  const isGenerating = status === "streaming" || status === "stopping"

  async function submitMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const requestId = crypto.randomUUID()
    activeRequestId.current = requestId
    setAnswer("")
    setUsage(null)
    setLatencyMs(null)
    setErrorMessage(null)
    setStatus("streaming")
    let terminalReceived = false

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId, message }),
      })
      if (!response.ok) {
        const body: unknown = await response.json()
        throw new Error(readErrorMessage(body))
      }

      for await (const streamEvent of readChatEventStream(
        response,
        requestId,
      )) {
        if (streamEvent.type === "content.delta") {
          setAnswer((current) => current + streamEvent.delta)
        } else if (streamEvent.type === "usage.snapshot") {
          setUsage(streamEvent.usage)
        } else if (streamEvent.type === "message.completed") {
          terminalReceived = true
          setLatencyMs(streamEvent.latencyMs)
          setStatus("completed")
        } else if (streamEvent.type === "message.cancelled") {
          terminalReceived = true
          setStatus("cancelled")
        } else if (streamEvent.type === "message.failed") {
          terminalReceived = true
          setErrorMessage(streamEvent.error.message)
          setStatus("failed")
        }
      }
    } catch (error) {
      if (!terminalReceived) {
        setErrorMessage(
          error instanceof Error
            ? error.message
            : "无法连接聊天服务，请稍后重试。",
        )
        setStatus("failed")
      }
    } finally {
      activeRequestId.current = null
    }
  }

  async function stopGeneration() {
    const requestId = activeRequestId.current
    if (requestId === null || status === "stopping") return
    setStatus("stopping")

    try {
      const response = await fetch("/api/chat", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId }),
      })
      if (!response.ok) throw new Error("停止请求未被接受")
    } catch {
      if (activeRequestId.current === requestId) {
        setErrorMessage("无法停止本次生成，请稍后重试。")
        setStatus("streaming")
      }
    }
  }

  return (
    <div className="grid w-full gap-6 lg:grid-cols-2">
      <Card className="[--card-spacing:--spacing(6)]">
        <CardHeader className="gap-2">
          <CardTitle className="text-xl">输入消息</CardTitle>
          <CardDescription className="text-base leading-relaxed">
            本阶段每次只发送这一条消息，不保留上下文。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="grid gap-4" onSubmit={submitMessage}>
            <div className="grid gap-2">
              <label className="text-sm font-medium" htmlFor="chat-message">
                消息内容
              </label>
              <textarea
                id="chat-message"
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                maxLength={MAX_CHAT_MESSAGE_LENGTH}
                rows={9}
                disabled={isGenerating}
                placeholder="例如：用三句话解释向量检索。"
                className="min-h-52 w-full resize-y rounded-lg border bg-background px-4 py-3 text-base leading-relaxed shadow-xs outline-none transition-shadow placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-60"
              />
              <span className="text-right text-xs text-muted-foreground">
                {message.length} / {MAX_CHAT_MESSAGE_LENGTH}
              </span>
            </div>

            {isGenerating ? (
              <Button
                type="button"
                variant="destructive"
                size="lg"
                className="h-11 px-5 text-base"
                disabled={status === "stopping"}
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
                className="h-11 px-5 text-base"
                disabled={!message.trim()}
              >
                <SendIcon data-icon="inline-start" />
                发送消息
              </Button>
            )}
          </form>
        </CardContent>
      </Card>

      <Card className="[--card-spacing:--spacing(6)]">
        <CardHeader className="gap-2">
          <CardTitle className="text-xl">答案</CardTitle>
          <CardDescription className="text-base leading-relaxed">
            正文会逐步显示；完成后展示延迟与本次 token 用量。
          </CardDescription>
        </CardHeader>
        <CardContent
          className="flex min-h-80 flex-col justify-between gap-8"
          aria-live="polite"
        >
          <div className="grid gap-4">
            <p className="whitespace-pre-wrap text-base leading-8">
              {answer || answerPlaceholder(status)}
            </p>
            {status === "streaming" ? (
              <p className="text-sm text-muted-foreground">正在接收回答…</p>
            ) : null}
            {status === "stopping" ? (
              <p className="text-sm text-muted-foreground">正在停止生成…</p>
            ) : null}
            {status === "cancelled" ? (
              <p className="rounded-lg border px-4 py-3 text-sm">
                已停止生成。
              </p>
            ) : null}
            {errorMessage ? (
              <p className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-base leading-relaxed text-destructive">
                {errorMessage}
              </p>
            ) : null}
          </div>

          {status === "completed" && usage && latencyMs !== null ? (
            <dl className="grid grid-cols-2 gap-x-5 gap-y-3 border-t pt-5 text-sm sm:grid-cols-4">
              <Usage label="延迟" value={`${latencyMs} ms`} />
              <Usage label="输入" value={`${usage.inputTokens} tokens`} />
              <Usage label="输出" value={`${usage.outputTokens} tokens`} />
              <Usage label="总计" value={`${usage.totalTokens} tokens`} />
            </dl>
          ) : null}
        </CardContent>
      </Card>
    </div>
  )
}

function answerPlaceholder(status: GenerationStatus): string {
  if (status === "streaming" || status === "stopping")
    return "等待首个正文增量…"
  if (status === "cancelled") return "本次生成在正文开始前已停止。"
  return "输入问题后，答案会显示在这里。"
}

function Usage({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-1">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium tabular-nums">{value}</dd>
    </div>
  )
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
