// ─── UI 层：进度条组件 ───
// ⚠️ 响应式约束：组件函数体只执行一次，禁止 props 快照 const；
//    所有取值必须发生在 JSX 表达式位置（Solid 编译器包装为响应式 getter）。
// 进度条：flex 比例填充 + 轨道底色，完整长度可见
// （轨道底色标出全长，即使 8% 也能看出占比；1 行高度不用 border，避免 border 占掉内容区）
/** @jsxImportSource @opentui/solid */
import { Show, type JSX } from "solid-js"
import { TRACK_COLOR } from "./theme.ts"

export function ColorBar(props: { pct: number | undefined; color: string }): JSX.Element {
  // 惰性纯函数：在 JSX 表达式位置调用才求值 → 随 props.pct 更新响应式重算
  const clamped = (p: number | undefined) => (p === undefined ? 0 : Math.max(0, Math.min(100, p)))
  return (
    <Show when={props.pct !== undefined}>
      <box flexDirection="row" flexGrow={1} flexShrink={0} minWidth={0} height={1} backgroundColor={TRACK_COLOR}>
        {/* 仅 >0 才渲染填充块：OpenTUI 里 flexGrow=0 的 box 仍占最小 1 格（minWidth={0} 不足以归零）
            → 0% 会露出绿点，故用 Show 门控，0% 时整条只剩轨道色 */}
        <Show when={clamped(props.pct) > 0}>
          <box backgroundColor={props.color} flexGrow={clamped(props.pct)} flexShrink={0} minWidth={0} />
        </Show>
        <box flexGrow={100 - clamped(props.pct)} flexShrink={0} minWidth={0} />
      </box>
    </Show>
  )
}