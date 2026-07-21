import Link from "next/link"
import {
  AppWindowIcon,
  ArrowDownIcon,
  ArrowRightIcon,
  CircleCheckBigIcon,
  HeartPulseIcon,
  ServerIcon,
} from "lucide-react"

import { BrowserRuntimeStatus } from "@/components/browser-runtime-status"
import { buttonVariants } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"

export default function HomePage() {
  return (
    <div className="grid min-h-svh grid-rows-[auto_1fr_auto]">
      <header className="border-b">
        <div className="mx-auto flex h-24 w-full max-w-[1536px] items-center justify-between px-5 sm:h-28 sm:px-14">
          <span className="shrink-0 whitespace-nowrap text-2xl font-semibold tracking-tight sm:text-3xl">
            Zhi Flow
          </span>
          <Link
            href="/api/health"
            className={cn(
              buttonVariants({
                variant: "primary-outline",
                size: "xl",
              }),
            )}
          >
            <HeartPulseIcon data-icon="inline-start" />
            查看健康状态
          </Link>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-6xl flex-col items-center justify-center gap-12 px-5 py-16 sm:px-8 lg:gap-16">
        <div className="flex w-full max-w-4xl flex-col items-center gap-5 text-center lg:-translate-y-12">
          <h1 className="text-3xl leading-tight font-semibold tracking-[-0.04em] sm:text-6xl lg:text-7xl">
            项目骨架已就绪
          </h1>
          <p className="text-lg text-muted-foreground sm:text-2xl">
            Next.js 全栈学习项目从这里开始。
          </p>
        </div>

        <div className="grid w-full items-center gap-6 md:grid-cols-[1fr_minmax(6rem,0.4fr)_1fr] lg:max-w-[1064px] lg:grid-cols-[360px_1fr_360px]">
          <RuntimeBoundaryCard icon={AppWindowIcon} title="浏览器组件">
            <BrowserRuntimeStatus />
          </RuntimeBoundaryCard>

          <div
            className="relative flex min-h-16 items-center justify-center text-primary"
            aria-hidden="true"
          >
            <span className="absolute hidden h-px w-full bg-primary md:block" />
            <span className="absolute h-full w-px bg-primary md:hidden" />
            <span className="relative grid size-10 place-items-center rounded-full border border-primary bg-background">
              <ArrowRightIcon className="hidden size-5 md:block" />
              <ArrowDownIcon className="size-5 md:hidden" />
            </span>
          </div>

          <RuntimeBoundaryCard icon={ServerHealthIcon} title="服务端健康检查">
            <span className="flex items-center gap-3">
              <span
                className="size-3 rounded-full bg-success"
                aria-hidden="true"
              />
              运行正常
            </span>
          </RuntimeBoundaryCard>
        </div>
      </main>

      <footer className="border-t bg-muted/30 py-11 text-center text-sm text-muted-foreground sm:text-base">
        里程碑 01 · 项目骨架
      </footer>
    </div>
  )
}

function ServerHealthIcon({ className }: { className?: string }) {
  return (
    <span className={cn("relative block", className)}>
      <ServerIcon className="size-full" />
      <CircleCheckBigIcon className="absolute right-0 bottom-0 size-6 rounded-full bg-card" />
    </span>
  )
}

function RuntimeBoundaryCard({
  children,
  icon: Icon,
  title,
}: {
  children: React.ReactNode
  icon: React.ComponentType<{ className?: string }>
  title: string
}) {
  return (
    <Card
      variant="runtime"
      className="min-h-64 justify-between [--card-spacing:--spacing(6)] sm:min-h-72"
    >
      <CardHeader className="justify-items-center gap-5 pt-4 text-center">
        <Icon className="size-14 text-primary" />
        <CardTitle variant="runtime">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <Separator />
      </CardContent>
      <CardFooter variant="runtime">{children}</CardFooter>
    </Card>
  )
}
