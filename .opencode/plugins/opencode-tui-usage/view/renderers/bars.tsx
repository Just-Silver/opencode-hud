// ─── 共享渲染器：bars（默认）───
// 每个 item 一行：
//   有 percent → 进度条(flex 填充) + 右对齐百分比
//   无 percent → 垫片 + 右对齐文本（余额/不限等）
// 行尾 hint（可选）按「区块内最长 hint」定宽右对齐 —— 否则各行宽度不一，
// 进度条(flexGrow) 长度会漂移、右侧列错位（宽度歧义字符按 2 列，见 shared/format.ts charColumns）。
// ⚠️ 响应式约束：组件函数体只执行一次，禁止 props 快照 const；取值须在 JSX 表达式位置。
/** @jsxImportSource @opentui/solid */
import { For, Show, type JSX } from "solid-js"
import type { QuotaItem } from "../../model/types.ts"
import { fmtPctInt, padEndVisual, quotaPct, visualWidth } from "../../shared/format.ts"
import { ColorBar } from "../ColorBar.tsx"
import { MUTED_COLOR, pctColor, TEXT_COLOR } from "../theme.ts"

// 百分比列宽（fmtPctInt 最长 "100%" = 4 列，定宽右对齐）
const PCT_WIDTH = 4

// 单行
function RendererRow(props: { item: QuotaItem; hintWidth: number; showHint: boolean }): JSX.Element {
  // 惰性 getter：在 JSX 位置调用才求值 → 随 props.item 更新响应式重算
  const pct = () => quotaPct(props.item)
  return (
    <box flexDirection="row" gap={1}>
      <text fg={TEXT_COLOR}>{props.item.label}</text>
      <Show when={pct() !== undefined} fallback={<box flexGrow={1} />}>
        <ColorBar pct={pct()} color={pctColor(pct())} />
      </Show>
      <Show when={pct() !== undefined} fallback={<text fg={TEXT_COLOR}>{props.item.text ?? ""}</text>}>
        <text fg={pctColor(pct())}>{fmtPctInt(pct()).padStart(PCT_WIDTH)}</text>
      </Show>
      <Show when={props.showHint}>
        <text fg={MUTED_COLOR}>{padEndVisual(props.item.hint ?? "", props.hintWidth)}</text>
      </Show>
    </box>
  )
}

export function BarsRenderer(props: { items: QuotaItem[] }): JSX.Element {
  // hint 列宽 = 区块内最长 hint 的显示宽度；全无 hint → 不出该列
  const hintWidth = () => props.items.reduce((w, it) => Math.max(w, visualWidth(it.hint ?? "")), 0)
  const showHint = () => hintWidth() > 0
  return (
    <box flexDirection="column" gap={1}>
      <For each={props.items}>
        {(item) => <RendererRow item={item} hintWidth={hintWidth()} showHint={showHint()} />}
      </For>
    </box>
  )
}
