"use client"

import { FormEvent, useState } from "react"
import { LoaderCircleIcon, SendIcon } from "lucide-react"

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
  type ChatSuccessResponse,
} from "@/lib/chat-api"

export function ChatPanel() {
  const [message, setMessage] = useState("")
  const [answer, setAnswer] = useState<ChatSuccessResponse | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  async function submitMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setIsSubmitting(true)
    setErrorMessage(null)

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      })
      const body: unknown = await response.json()

      if (!response.ok) {
        setAnswer(null)
        setErrorMessage(readErrorMessage(body))
        return
      }
      if (!isChatSuccessResponse(body)) {
        throw new Error("聊天 API 返回了无法识别的响应")
      }

      setAnswer(body)
    } catch {
      setAnswer(null)
      setErrorMessage("无法连接聊天服务，请稍后重试。")
    } finally {
      setIsSubmitting(false)
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
                placeholder="例如：用三句话解释向量检索。"
                className="min-h-52 w-full resize-y rounded-lg border bg-background px-4 py-3 text-base leading-relaxed shadow-xs outline-none transition-shadow placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"
              />
              <span className="text-right text-xs text-muted-foreground">
                {message.length} / {MAX_CHAT_MESSAGE_LENGTH}
              </span>
            </div>
            <Button
              type="submit"
              size="lg"
              className="h-11 px-5 text-base"
              disabled={isSubmitting || !message.trim()}
            >
              {isSubmitting ? (
                <LoaderCircleIcon
                  data-icon="inline-start"
                  className="animate-spin"
                />
              ) : (
                <SendIcon data-icon="inline-start" />
              )}
              {isSubmitting ? "正在等待回答…" : "发送消息"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card className="[--card-spacing:--spacing(6)]">
        <CardHeader className="gap-2">
          <CardTitle className="text-xl">答案</CardTitle>
          <CardDescription className="text-base leading-relaxed">
            回答完成后会显示延迟和本次 token 用量。
          </CardDescription>
        </CardHeader>
        <CardContent
          className="flex min-h-80 flex-col justify-between gap-8"
          aria-live="polite"
        >
          {errorMessage ? (
            <p className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-base leading-relaxed text-destructive">
              {errorMessage}
            </p>
          ) : (
            <p className="whitespace-pre-wrap text-base leading-8">
              {answer?.answer ?? "输入问题后，答案会显示在这里。"}
            </p>
          )}

          {answer ? (
            <dl className="grid grid-cols-2 gap-x-5 gap-y-3 border-t pt-5 text-sm sm:grid-cols-4">
              <Usage label="延迟" value={`${answer.latencyMs} ms`} />
              <Usage
                label="输入"
                value={`${answer.usage.inputTokens} tokens`}
              />
              <Usage
                label="输出"
                value={`${answer.usage.outputTokens} tokens`}
              />
              <Usage
                label="总计"
                value={`${answer.usage.totalTokens} tokens`}
              />
            </dl>
          ) : null}
        </CardContent>
      </Card>
    </div>
  )
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

function isChatSuccessResponse(body: unknown): body is ChatSuccessResponse {
  if (typeof body !== "object" || body === null) return false

  return (
    "answer" in body &&
    typeof body.answer === "string" &&
    "latencyMs" in body &&
    typeof body.latencyMs === "number" &&
    "usage" in body &&
    typeof body.usage === "object" &&
    body.usage !== null &&
    "inputTokens" in body.usage &&
    typeof body.usage.inputTokens === "number" &&
    "outputTokens" in body.usage &&
    typeof body.usage.outputTokens === "number" &&
    "totalTokens" in body.usage &&
    typeof body.usage.totalTokens === "number"
  )
}
