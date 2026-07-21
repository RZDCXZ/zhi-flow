"use client"

import { useSyncExternalStore } from "react"

export function BrowserRuntimeStatus() {
  const connected = useSyncExternalStore(
    subscribeToBrowserRuntime,
    () => true,
    () => false,
  )

  return (
    <span className="flex items-center gap-3" aria-live="polite">
      <span className="size-3 rounded-full bg-success" aria-hidden="true" />
      {connected ? "已连接" : "连接中…"}
    </span>
  )
}

function subscribeToBrowserRuntime() {
  return () => undefined
}
