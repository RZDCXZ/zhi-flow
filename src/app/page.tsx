import Link from "next/link"
import { HeartPulseIcon } from "lucide-react"

import { ChatPanel } from "@/components/chat-panel"
import { buttonVariants } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export default function HomePage() {
  return (
    <div className="grid min-h-svh grid-rows-[auto_1fr_auto]">
      <header className="border-b">
        <div className="mx-auto flex h-20 w-full max-w-7xl items-center justify-between px-5 sm:h-24 sm:px-8">
          <span className="shrink-0 whitespace-nowrap text-2xl font-semibold tracking-tight sm:text-3xl">
            Zhi Flow
          </span>
          <Link
            href="/api/health"
            className={cn(
              buttonVariants({
                variant: "primary-outline",
                size: "lg",
              }),
              "h-10 px-4 sm:h-11 sm:text-base",
            )}
          >
            <HeartPulseIcon data-icon="inline-start" />
            健康状态
          </Link>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-7xl flex-col justify-center gap-10 px-5 py-12 sm:px-8 sm:py-16">
        <div className="max-w-3xl space-y-4">
          <h1 className="text-4xl leading-tight font-semibold tracking-[-0.04em] sm:text-6xl">
            观察多轮上下文增长
          </h1>
          <p className="max-w-2xl text-lg leading-relaxed text-muted-foreground sm:text-xl">
            在独立 Conversation 中连续追问，观察发送给 Provider 的角色顺序与
            Token 用量。
          </p>
        </div>

        <ChatPanel />
      </main>

      <footer className="border-t bg-muted/30 py-7 text-center text-sm text-muted-foreground sm:text-base">
        里程碑 06 · 基础多轮对话
      </footer>
    </div>
  )
}
