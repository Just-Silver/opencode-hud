// ─── UI 层：额度区块（多供应商分组）───
// 当前会话供应商展开、其余折叠成一行；点组头就地展开。具体条目交给各供应商声明的共享渲染器，
// 本组件只负责分组外壳、折叠与摘要（不含任何窗口语义）。
// ⚠️ 响应式约束：组件函数体只执行一次，取值须在 JSX 表达式或惰性 getter 中。
/** @jsxImportSource @opentui/solid */
import { Index, Show, type JSX } from "solid-js"
import { representativeItem } from "../model/quota.ts"
import type { QuotaRow } from "../model/types.ts"
import { fmtPctInt, quotaPct, truncateVisual } from "../shared/format.ts"
import { Collapsible } from "./Collapsible.tsx"
import { resolveRenderer } from "./renderers/index.ts"
import { MUTED_COLOR, pctColor, PRIMARY_COLOR, SECTION_QUOTA_TITLE, TEXT_COLOR } from "./theme.ts"

// 组头名称上限：42 列宽还要给折叠摘要留位置
const NAME_MAX = 12

// 折叠行摘要：标签 + 已用百分比（或余额等文本）；展开时不显示
function summaryText(row: QuotaRow): string {
  if (row.open) return ""
  const item = representativeItem(row.data.items)
  if (!item) return ""
  if (item.percent === undefined) return `${item.label} ${item.text ?? ""}`.trim()
  return `${item.label} ${fmtPctInt(item.percent)}`
}

function QuotaGroup(props: { row: QuotaRow; onToggle: (pid: string) => void }): JSX.Element {
  // 摘要百分比决定取色；没有百分比（余额/不限）走弱化色
  const item = () => representativeItem(props.row.data.items)
  const pct = () => quotaPct(item())
  return (
    <box flexDirection="column">
      <box flexDirection="row" onMouseDown={() => props.onToggle(props.row.pid)}>
        <text fg={MUTED_COLOR}>{props.row.open ? "▾ " : "▸ "}</text>
        <text fg={props.row.current ? PRIMARY_COLOR : TEXT_COLOR}>
          <b>{truncateVisual(props.row.name, NAME_MAX)}</b>
        </text>
        <box flexGrow={1} />
        <Show when={!props.row.open}>
          <text fg={pct() === undefined ? MUTED_COLOR : pctColor(pct())} wrapMode="none">
            {summaryText(props.row)}
          </text>
        </Show>
      </box>
      <Show when={props.row.open}>
        <box flexDirection="column" paddingLeft={2}>
          {resolveRenderer(props.row.renderer)({ items: props.row.data.items })}
        </box>
      </Show>
    </box>
  )
}

export function QuotaSection(props: { rows: QuotaRow[]; onToggle: (pid: string) => void }): JSX.Element {
  // 整块折叠时的摘要：第一行是当前会话供应商时省略名称，否则带上名字（否则不知道说的是谁）
  const summary = () => {
    const first = props.rows[0]
    if (!first) return undefined
    const parts = first.data.items
      .filter((it) => quotaPct(it) !== undefined)
      .slice(0, 2)
      .map((it) => `${it.label} ${fmtPctInt(quotaPct(it))}`)
    if (parts.length === 0) return undefined
    const body = parts.join(" · ")
    return first.current ? `（${body}）` : `（${truncateVisual(first.name, NAME_MAX)} ${body}）`
  }
  return (
    // 空列表 → 整个额度区块不渲染（没有可用额度数据即隐藏，不留「无数据」占位）
    <Show when={props.rows.length > 0}>
      <Collapsible title={SECTION_QUOTA_TITLE} summary={summary()}>
        <Index each={props.rows}>{(row) => <QuotaGroup row={row()} onToggle={props.onToggle} />}</Index>
      </Collapsible>
    </Show>
  )
}
