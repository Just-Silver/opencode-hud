// ─── UI 层：底部状态行性能块（首字 + 速度，纯展示） ───
// 落点：prompt.footer.status 的 append（目录路径之后、宿主 usage 之前），见
// docs/design-performance-footer.md。不可点击、不弹窗。
// 只展示「已完成步」的精确值：生成中沿用上一步的数字，步结束（宿主写回 tokens）时替换。
// 视觉与 Dashboard 统一：首字弱化、速度用主色（同一组数字里更常用的那个）。
// ⚠️ 响应式约束：组件函数体只执行一次，禁止 props 快照 const。
/** @jsxImportSource @opentui/solid */
import { createMemo, Show, type JSX } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { fmtPerf, fmtSec, fmtTpsText } from "../shared/format.ts"
import { ACCENT_COLOR, MUTED_COLOR, TEXT_COLOR } from "./theme.ts"

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
  const ttftText = createMemo(() => (level() === "full" ? fmtSec(props.ttftMs) : ""))
  const tpsText = createMemo(() => fmtTpsText(props.tps))
  const empty = createMemo(() => fmtPerf(props.ttftMs, props.tps) === "")

  // 首页（无 sessionID）、宿主收缩（showDetails=false）、无样本 → 整段不渲染
  return (
    <Show when={props.sessionID && props.showDetails !== false && !empty()}>
      <box flexDirection="row" flexShrink={0}>
        <Show when={ttftText()}>
          <text fg={TEXT_COLOR} wrapMode="none">
            {ttftText()}
          </text>
        </Show>
        <Show when={ttftText() && tpsText()}>
          <text fg={MUTED_COLOR} wrapMode="none">
            {" · "}
          </text>
        </Show>
        <Show when={tpsText()}>
          <text fg={ACCENT_COLOR} wrapMode="none">
            {tpsText()}
          </text>
        </Show>
      </box>
    </Show>
  )
}
