import Link from "next/link"
import { HeartPulseIcon } from "lucide-react"

import { ChatPanel } from "@/components/chat-panel"
import { KnowledgeBasePanel } from "@/components/knowledge-base-panel"
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
            构建私有知识库摄取入口
          </h1>
          <p className="max-w-2xl text-lg leading-relaxed text-muted-foreground sm:text-xl">
            管理 Knowledge Base，将受支持的 Document 安全落入私有
            Storage，并观察服务端权威校验与上传状态。
          </p>
        </div>

        <KnowledgeBasePanel />
        <ChatPanel />
      </main>

      <footer className="border-t bg-muted/30 py-7 text-center text-sm text-muted-foreground sm:text-base">
        里程碑 07 · 知识库与文件上传
      </footer>
    </div>
  )
}
