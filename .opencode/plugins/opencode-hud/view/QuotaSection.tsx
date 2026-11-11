// ─── UI 层：额度卡片（多供应商分组 + 新鲜度） ───
// 当前会话供应商展开、其余折叠成一行；点组头就地展开。条目交给各供应商声明的共享渲染器。
// 展开区用一条左侧竖线（BORDER 色）+ 内缩做「背景层级」，不加第二层边框/底色块。
// ⚠️ 响应式约束：组件函数体只执行一次，取值须在 JSX 表达式或惰性 getter 中。
/** @jsxImportSource @opentui/solid */
import { Index, Show, type JSX } from "solid-js"
import { quotaStatusTrail, representativeItem } from "../model/quota.ts"
import type { QuotaRow } from "../model/types.ts"
import { fmtPctInt, quotaPct, quotaSummaryText, truncateVisual, visualWidth } from "../shared/format.ts"
import { DashboardCard } from "./Card.tsx"
import { CARD_INNER, QUOTA_GROUP_NAME_MAX, QUOTA_INDENT } from "./layout.ts"
import { resolveRenderer } from "./renderers/index.ts"
import {
  ACCENT_COLOR,
  ERROR_COLOR,
  MUTED_COLOR,
  SECONDARY_COLOR,
  SECTION_QUOTA_TITLE,
  TRACK_COLOR,
  WARNING_COLOR,
  usageColor,
} from "./theme.ts"

// 整块折叠摘要不做了（卡片不折叠）；组头摘要按可用宽度动态截断
function trailColor(tone: "muted" | "accent" | "danger"): string {
  if (tone === "danger") return ERROR_COLOR
  if (tone === "accent") return WARNING_COLOR
  return MUTED_COLOR
}

function QuotaGroup(props: { row: QuotaRow; onToggle: (pid: string) => void }): JSX.Element {
  // 摘要条目只取一次：百分比取色与摘要文本共用，避免同一轮渲染重复挑选
  const item = () => representativeItem(props.row.data.items)
  const pct = () => quotaPct(item())
  const name = () => truncateVisual(props.row.name, QUOTA_GROUP_NAME_MAX)
  const trail = () => quotaStatusTrail(props.row.status, props.row.open)
  // 折叠行右端预算：内容宽 − 箭头 2 − 名称列 − 状态注记（含 1 列间隔）
  const summaryText = () => {
    const statusText = trail()?.text
    const used = 2 + QUOTA_GROUP_NAME_MAX + (statusText ? visualWidth(statusText) + 1 : 0)
    return truncateVisual(quotaSummaryText(item()), Math.max(4, CARD_INNER - used))
  }

  return (
    <box flexDirection="column">
      <box flexDirection="row" height={1} onMouseDown={() => props.onToggle(props.row.pid)}>
        <text fg={MUTED_COLOR}>{props.row.open ? "▾ " : "▸ "}</text>
        {/* 当前会话那组用主色加粗；其余保持次级色（两个 text 节点，避免条件包裹 b 标签） */}
        <Show when={props.row.current} fallback={<text fg={SECONDARY_COLOR}>{name()}</text>}>
          <text fg={ACCENT_COLOR}>
            <b>{name()}</b>
          </text>
        </Show>
        <box flexGrow={1} />
        {/* 展开时右端是新鲜度；折叠时右端是摘要（状态注记在摘要前） */}
        <Show when={trail()}>
          {(value) => <text fg={trailColor(value().tone)}>{value().text}</text>}
        </Show>
        <Show when={!props.row.open && quotaSummaryText(item())}>
          <Show when={trail()}>
            <text> </text>
          </Show>
          <text fg={usageColor(pct())} wrapMode="none">
            {summaryText()}
          </text>
        </Show>
      </box>
      <Show when={props.row.open}>
        <box
          flexDirection="column"
          border={["left"]}
          borderColor={TRACK_COLOR}
          paddingLeft={QUOTA_INDENT - 1}
        >
          {resolveRenderer(props.row.renderer)({ items: props.row.data.items })}
        </box>
      </Show>
    </box>
  )
}

export function QuotaSection(props: { rows: QuotaRow[]; onToggle: (pid: string) => void }): JSX.Element {
  return (
    // 空列表 → 整个额度卡片不渲染（没有可用额度数据即隐藏，不留「无数据」占位）
    <Show when={props.rows.length > 0}>
      <DashboardCard title={SECTION_QUOTA_TITLE}>
        {/* 紧凑排布：组头 / 条目 / 下一组紧邻，不插空行（37 列侧栏优先信息密度） */}
        <box flexDirection="column">
          <Index each={props.rows}>{(row) => <QuotaGroup row={row()} onToggle={props.onToggle} />}</Index>
        </box>
      </DashboardCard>
    </Show>
  )
}
