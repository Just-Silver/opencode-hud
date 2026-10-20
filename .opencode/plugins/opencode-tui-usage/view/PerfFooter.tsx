// ─── UI 层：底部状态行性能块（首字 + 速度，纯展示） ───
// 落点：prompt.footer.status 的 append（目录路径之后、宿主 usage 之前），见
// docs/design-performance-footer.md。不可点击、不弹窗。
// ⚠️ 响应式约束：组件函数体只执行一次，禁止 props 快照 const。
/** @jsxImportSource @opentui/solid */
import { Show, createEffect, createMemo, createSignal, onCleanup, type JSX } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import type { PerfMessage } from "../model/types.ts"
import { latestPerf, type LivePerf } from "../model/perf.ts"
import { SPINNER_FRAMES, statusGlyph } from "../model/subagent.ts"
import { fmtSec, fmtTps } from "../shared/format.ts"
import { MUTED_COLOR, TEXT_COLOR } from "./theme.ts"

// 两档阈值：≥60 完整（时长 · 速度），<60 只留速度（60 跟随宿主 showDetails 收缩位）
const COMPACT_MIN_WIDTH = 60

type Level = "full" | "minimal"

function levelOf(width: number): Level {
  return width >= COMPACT_MIN_WIDTH ? "full" : "minimal"
}

export function PerfFooter(props: {
  sessionID?: string
  showDetails?: boolean
  messages: readonly PerfMessage[]
  live?: LivePerf
}): JSX.Element {
  const dimensions = useTerminalDimensions()
  const level = createMemo(() => levelOf(dimensions().width))

  // 工具执行期的动画帧：只在 tool 相位跑 80ms interval，结束后立即清。
  // 冻结时数字不再变化，仅靠数字无法区分「在跑命令」和「模型生成得慢」。
  const [frame, setFrame] = createSignal(0)
  createEffect(() => {
    if (props.live?.phase !== "tool") return
    const timer = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), 80)
    onCleanup(() => clearInterval(timer))
  })

  // `…` 只加在「单调递增的计时器」上（对齐上游 live.ts 的口径）：
  //   · 首字时长：仅 prefill（还在等首字）时带 …，到达后是常量
  //   · 速度：是比值不是计时，永远不带 …
  //   · 工具相位：数值保持不变，行尾追加 spinner 表示「速度已冻结、正在执行工具」
  // 首字时长不加「首字」标签：状态行本就窄，靠「s · tok/s」的顺序自明
  const text = createMemo(() => {
    const live = props.live
    const exact = latestPerf(props.messages)

    const waiting = live?.phase === "prefill"
    const ttft = live?.ttftMs !== undefined ? live.ttftMs : exact.ttftMs
    const tps = live?.tps !== undefined ? live.tps : exact.tps

    const ttftText = ttft !== undefined ? `${fmtSec(ttft)}${waiting ? "…" : ""}` : ""
    const tpsRaw = fmtTps(tps)
    const tpsText = tpsRaw ? `${tpsRaw} tok/s` : ""

    const base =
      level() === "full" ? [ttftText, tpsText].filter(Boolean).join(" · ") : tpsText

    // 冻结期不替换数值：整行内容保持不动、整体变灰，只在行尾加一个动画图标，
    // 避免每次工具执行时内容闪没再回来。
    if (live?.phase === "tool") {
      const glyph = statusGlyph(true, frame())
      return base ? `${base} ${glyph}` : glyph
    }
    return base
  })

  // 首页（无 sessionID）、宿主收缩（showDetails=false）、无样本 → 整段不渲染
  return (
    <Show when={props.sessionID && props.showDetails !== false && text() !== ""}>
      <text wrapMode="none" flexShrink={0} fg={props.live?.phase === "tool" ? MUTED_COLOR : TEXT_COLOR}>
        {text()}
      </text>
    </Show>
  )
}
