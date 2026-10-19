/** @jsxImportSource @opentui/solid */
import { createEffect, createMemo, onCleanup } from "solid-js"
import { usePlugin } from "@opencode/plugin/tui"
import { getLivePerfSource } from "./live/index.ts"
import type { PerfMessage } from "./model/types.ts"
import { PerfFooter } from "./view/PerfFooter.tsx"

// 底部状态行的性能块（首字 + 速度）。
// 放在独立组件里，使 usePlugin() 与实时服务都运行在 slot 自己的 Solid owner 下。
export function FooterPerf(props: { sessionID?: string; showDetails?: boolean }): any {
  const ctx = usePlugin()
  const live = getLivePerfSource({ data: ctx.data as never })

  // busy 心跳由 effect 维护（memo 里不能有副作用）
  createEffect(() => {
    live.track(props.sessionID)
  })
  onCleanup(() => live.track(undefined))

  const messages = createMemo(() => {
    const sid = props.sessionID
    if (!sid) return [] as PerfMessage[]
    void live.version() // 事件驱动重算
    return (ctx.data.session.message.list(sid) ?? []) as PerfMessage[]
  })

  const livePerf = createMemo(() => {
    const sid = props.sessionID
    if (!sid) return undefined
    void live.version()
    return live.live(sid)
  })

  return (
    <PerfFooter
      sessionID={props.sessionID}
      showDetails={props.showDetails}
      messages={messages()}
      live={livePerf()}
    />
  )
}
