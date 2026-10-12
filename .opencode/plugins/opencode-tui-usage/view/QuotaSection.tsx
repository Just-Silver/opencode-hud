// ─── UI 层：额度区块外壳（标题 / 折叠 / 门控）───
// 具体渲染交给「供应商选择的共享渲染器」（view/renderers/*）：本组件不含任何窗口语义。
// ⚠️ 响应式约束：组件函数体只执行一次，禁止 props 快照 const；取值须在 JSX 表达式位置。
/** @jsxImportSource @opentui/solid */
import { Show, type JSX } from "solid-js"
import type { QuotaData } from "../model/types.ts"
import { fmtPctInt, quotaPct } from "../shared/format.ts"
import { Collapsible } from "./Collapsible.tsx"
import { resolveRenderer } from "./renderers/index.ts"
import { SECTION_QUOTA_TITLE } from "./theme.ts"

export function QuotaSection(props: { quota: QuotaData | undefined; renderer?: string }): JSX.Element {
  const items = () => props.quota?.items ?? []
  // 折叠摘要：取前两个有百分比的条目（label + 百分比）；全无 → undefined，不显示空 "（）"
  const summary = () => {
    const parts = items()
      .filter((it) => quotaPct(it) !== undefined)
      .slice(0, 2)
      .map((it) => `${it.label} ${fmtPctInt(quotaPct(it))}`)
    return parts.length > 0 ? `（${parts.join(" · ")}）` : undefined
  }
  return (
    // 空条目 → 整个额度区块不渲染（供应商返回 undefined / 空数组即隐藏）
    <Show when={items().length > 0}>
      <Collapsible title={SECTION_QUOTA_TITLE} summary={summary()}>
        {resolveRenderer(props.renderer)({ items: items() })}
      </Collapsible>
    </Show>
  )
}
