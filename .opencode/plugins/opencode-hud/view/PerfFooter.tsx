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
          width={2}
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
        {/* 用边框随容器伸缩，不用测量宽度或拼接字符。 */}
        <box
          flexGrow={1}
          minWidth={0}
          height={1}
          border={["bottom"]}
          borderColor={BORDER_COLOR}
          marginLeft={1}
        />
      </box>
    </Show>
  )
}
