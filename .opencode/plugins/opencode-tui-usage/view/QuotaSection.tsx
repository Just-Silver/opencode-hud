// ─── UI 层：额度区块（纯展示） ───
// 配色固定取 theme.ts 调色板（opencode 主题色，不随宿主主题）。
// ⚠️ 响应式约束：组件函数体只执行一次，禁止 props 快照 const；
//    所有取值必须发生在 JSX 表达式位置（Solid 编译器包装为响应式 getter）。
/** @jsxImportSource @opentui/solid */
import { Show, type JSX } from "solid-js"
import type { QuotaData, QuotaWindow } from "../model/types.ts"
import { fmtPctInt, fmtResetTime, padStartVisual, quotaPct } from "../shared/format.ts"
import { ColorBar } from "./ColorBar.tsx"
import { Collapsible } from "./Collapsible.tsx"
import { MUTED_COLOR, pctColor, QUOTA_LABELS, SECTION_QUOTA_TITLE, TEXT_COLOR } from "./theme.ts"

// 百分比列宽（fmtPctInt 最长 "100%" = 4 列，定宽右对齐）
const PCT_WIDTH = 4
// 重置时间列宽（"↻" 2 列 + 空格 1 列 + 最长 "HH:MM"/"MM-DD" 5 列 = 8 列）：定宽右对齐，
// 否则各行宽度不一 → ProgressBar(flexGrow) 长度漂移 → 右侧列错位。
// "↻" 为宽度歧义字符，按 2 列计（见 shared/format.ts charColumns），与终端渲染一致，避免字形被裁。
const RESET_WIDTH = 8

// 单行：窗口标签 + 进度条（flex 填充）+ 右对齐百分比 + 定宽重置时间（有数据才出列）
function QuotaRow(props: { label: string; window: QuotaWindow | undefined; showReset: boolean }): JSX.Element {
  // 惰性 getter：在 JSX 位置调用才求值 → 随 props.window 更新响应式重算
  const pct = () => quotaPct(props.window)
  const reset = () => {
    const r = fmtResetTime(props.window?.resetsAt)
    return r ? `↻ ${r}` : "" // ↻ 与时间之间留 1 空格，避免挤在一起
  }
  return (
    <box flexDirection="row" gap={1}>
      <text fg={TEXT_COLOR}>{props.label}</text>
      <ColorBar pct={pct()} color={pctColor(pct())} />
      <text fg={pctColor(pct())}>{fmtPctInt(pct()).padStart(PCT_WIDTH)}</text>
      <Show when={props.showReset}>
        <text fg={MUTED_COLOR}>{padStartVisual(reset(), RESET_WIDTH)}</text>
      </Show>
    </box>
  )
}

export function QuotaSection(props: { quota: QuotaData | undefined }): JSX.Element {
  // 惰性 getter（函数），在 JSX 位置调用才求值 → 随 props.quota 更新响应式重算
  const rollingPct = () => quotaPct(props.quota?.rolling)
  const weeklyPct = () => quotaPct(props.quota?.weekly)
  // 任一行有重置时间才渲染该列（全部缺失如 Command Code → 不出列，不占宽度）
  const showReset = () =>
    !!(props.quota?.rolling?.resetsAt || props.quota?.weekly?.resetsAt || props.quota?.monthly?.resetsAt)
  // 折叠摘要：只列有数据的窗口；全部缺失（如仅 monthly）→ undefined，不显示空 "（）"
  const summary = () => {
    const parts: string[] = []
    if (rollingPct() !== undefined) parts.push(`${QUOTA_LABELS[0]} ${fmtPctInt(rollingPct())}`)
    if (weeklyPct() !== undefined) parts.push(`${QUOTA_LABELS[1]} ${fmtPctInt(weeklyPct())}`)
    return parts.length > 0 ? `（${parts.join(" · ")}）` : undefined
  }
  return (
    <Show when={props.quota?.rolling || props.quota?.weekly || props.quota?.monthly}>
      <Collapsible title={SECTION_QUOTA_TITLE} summary={summary()}>
        <box flexDirection="column" gap={1}>
          <QuotaRow label={QUOTA_LABELS[0]} window={props.quota?.rolling} showReset={showReset()} />
          <QuotaRow label={QUOTA_LABELS[1]} window={props.quota?.weekly} showReset={showReset()} />
          <QuotaRow label={QUOTA_LABELS[2]} window={props.quota?.monthly} showReset={showReset()} />
        </box>
      </Collapsible>
    </Show>
  )
}
