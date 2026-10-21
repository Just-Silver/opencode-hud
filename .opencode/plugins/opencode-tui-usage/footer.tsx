/** @jsxImportSource @opentui/solid */
import { createMemo } from "solid-js"
import { usePlugin } from "@opencode/plugin/tui"
import { latestPerf } from "./model/perf.ts"
import type { PerfMessage } from "./model/types.ts"
import { PerfFooter } from "./view/PerfFooter.tsx"

// 底部状态行的性能块（首字 + 速度）。
// 数据全来自宿主内存投影：session.message.list() 里的每条 assistant 消息。
// 宿主在 session.step.ended 时把 tokens / time.completed 写回该消息，memo 随之重算——
// 因此每个步结束都会刷新一次，生成过程中保持上一步的值不动（不估算、不插值、无定时器）。
export function FooterPerf(props: { sessionID?: string; showDetails?: boolean }) {
  const ctx = usePlugin()

  const perf = createMemo(() => {
    const sid = props.sessionID
    if (!sid) return { ttftMs: undefined, tps: undefined }
    return latestPerf((ctx.data.session.message.list(sid) ?? []) as PerfMessage[])
  })

  return (
    <PerfFooter
      sessionID={props.sessionID}
      showDetails={props.showDetails}
      ttftMs={perf().ttftMs}
      tps={perf().tps}
    />
  )
}
