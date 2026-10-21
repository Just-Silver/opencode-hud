// ─── UI 层：底部状态行性能块（首字 + 速度，纯展示） ───
// 落点：prompt.footer.status 的 append（目录路径之后、宿主 usage 之前），见
// docs/design-performance-footer.md。不可点击、不弹窗。
// 只展示「已完成步」的精确值：生成中沿用上一步的数字，步结束（宿主写回 tokens）时替换。
// ⚠️ 响应式约束：组件函数体只执行一次，禁止 props 快照 const。
/** @jsxImportSource @opentui/solid */
import { Show, createMemo, type JSX } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { fmtSec, fmtTps } from "../shared/format.ts"
import { TEXT_COLOR } from "./theme.ts"

// 两档阈值：≥60 完整（时长 · 速度），<60 只留速度（60 跟随宿主 showDetails 收缩位）
const COMPACT_MIN_WIDTH = 60

type Level = "full" | "minimal"

function levelOf(width: number): Level {
  return width >= COMPACT_MIN_WIDTH ? "full" : "minimal"
}

export function PerfFooter(props: {
  sessionID?: string
  showDetails?: boolean
  ttftMs?: number
  tps?: number
}): JSX.Element {
  const dimensions = useTerminalDimensions()
  const level = createMemo(() => levelOf(dimensions().width))

  // 首字时长不加「首字」标签：状态行本就窄，靠「s · tok/s」的顺序自明
  const text = createMemo(() => {
    const ttftText = fmtSec(props.ttftMs)
    const tpsRaw = fmtTps(props.tps)
    const tpsText = tpsRaw ? `${tpsRaw} tok/s` : ""
    return level() === "full" ? [ttftText, tpsText].filter(Boolean).join(" · ") : tpsText
  })

  // 首页（无 sessionID）、宿主收缩（showDetails=false）、无样本 → 整段不渲染
  return (
    <Show when={props.sessionID && props.showDetails !== false && text() !== ""}>
      <text wrapMode="none" flexShrink={0} fg={TEXT_COLOR}>
        {text()}
      </text>
    </Show>
  )
}
