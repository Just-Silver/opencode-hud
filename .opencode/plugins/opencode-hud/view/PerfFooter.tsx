// ─── UI 层：输入框上方的性能行（TTFT + 速度，纯展示） ───
// 落点：session.composer.top 的 append（输入框正上方独占一行），见
// docs/design-performance-footer.md。
// 形态：`────────── TTFT 4.99s · 155 tok/s ──`——左段分隔线自动填满剩余宽度、右段固定 2 列；
// 分隔线用底边框实现（随宽度自适应，不做宽度测量，故不会溢出或抖动）。
// 只展示「已完成步」的精确值：生成中沿用上一步的数字，步结束（宿主写回 tokens）时替换。
// ⚠️ 响应式约束：组件函数体只执行一次，禁止 props 快照 const。
/** @jsxImportSource @opentui/solid */
import { createMemo, Show, type JSX } from "solid-js"
import { fmtSec, fmtTps } from "../shared/format.ts"
import { BORDER_COLOR, SECONDARY_COLOR, TEXT_COLOR } from "./theme.ts"

export function PerfFooter(props: { sessionID?: string; ttftMs?: number; tps?: number }): JSX.Element {
  const ttftText = createMemo(() => fmtSec(props.ttftMs))
  const tpsText = createMemo(() => fmtTps(props.tps))
  const empty = createMemo(() => !ttftText() && !tpsText())

  // 首页（无 sessionID）/ 无有效样本 → 不留空行
  return (
    <Show when={props.sessionID && !empty()}>
      <box flexDirection="row" width="100%" flexShrink={0}>
        <box
          flexGrow={1}
          minWidth={0}
          height={1}
          border={["bottom"]}
          borderColor={BORDER_COLOR}
          marginRight={1}
        />
        <Show when={ttftText()}>
          <text fg={SECONDARY_COLOR} wrapMode="none">
            {"TTFT "}
          </text>
        </Show>
        <Show when={ttftText()}>
          <text fg={TEXT_COLOR} wrapMode="none">
            {ttftText()}
          </text>
        </Show>
        <Show when={ttftText() && tpsText()}>
          <text fg={SECONDARY_COLOR} wrapMode="none">
            {" · "}
          </text>
        </Show>
        <Show when={tpsText()}>
          <text fg={TEXT_COLOR} wrapMode="none">
            {tpsText()}
          </text>
        </Show>
        <Show when={tpsText()}>
          <text fg={SECONDARY_COLOR} wrapMode="none">
            {" tok/s"}
          </text>
        </Show>
        <box
          width={2}
          height={1}
          border={["bottom"]}
          borderColor={BORDER_COLOR}
          marginLeft={1}
        />
      </box>
    </Show>
  )
}
