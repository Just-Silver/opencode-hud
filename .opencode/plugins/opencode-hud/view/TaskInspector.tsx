// ─── UI 层：子代理 Task Inspector（已停止条目的展开详情，与运行中同一套信息行） ───
// 运行中卡片的五行与这里的四行使用同一顺序：Agent·供应商 / 模型·强度 / 耗时·消耗·缓存 / 首字·速度。
// 已停止主行是单行摘要，所以展开需要这些补充信息；运行中展开只把标题换成全文（不渲染本组件）。
// 双列对齐：左列吃剩余宽度（可换行），右列贴右缘，数值变化不带动右缘抖动。
// ⚠️ Solid：组件函数体只执行一次，取值写在 JSX 表达式或惰性 getter 里。
/** @jsxImportSource @opentui/solid */
import { Show, type JSX } from "solid-js"
import type { SubagentRow } from "../model/subagent.ts"
import { fmtElapsed, fmtPct, fmtSec, fmtTokens, fmtTpsText } from "../shared/format.ts"
import { CACHE_COLOR, MUTED_COLOR, RAISED_COLOR, SECONDARY_COLOR, TEXT_COLOR } from "./theme.ts"

// 双列行：左列吃剩余宽度并按字符换行，右列贴右缘。
// 左列 paddingRight 1 保证两列之间至少留 1 列，内容再长也不会贴在一起。
// 右列不做加粗：与运行中卡片的双列保持同一字重。
function TwoCol(props: {
  left: string
  leftColor: string
  right?: string
  rightColor?: string
  /** 右列前缀（如「缓存」），弱化色 */
  rightLabel?: string
}): JSX.Element {
  return (
    <box flexDirection="row">
      <box flexGrow={1} minWidth={0} paddingRight={1}>
        <text fg={props.leftColor} wrapMode="char">
          {props.left}
        </text>
      </box>
      <Show when={props.rightLabel || props.right}>
        <Show when={props.rightLabel}>
          <text fg={MUTED_COLOR} wrapMode="none">
            {(props.rightLabel ?? "") + " "}
          </text>
        </Show>
        <Show when={props.right}>
          <text fg={props.rightColor ?? TEXT_COLOR} wrapMode="none">
            {props.right}
          </text>
        </Show>
      </Show>
    </box>
  )
}

export function TaskInspector(props: { row: SubagentRow }): JSX.Element {
  const cache = () => (props.row.cacheRate === undefined ? "" : fmtPct(props.row.cacheRate))
  const ttft = () => fmtSec(props.row.ttftMs)
  const speed = () => fmtTpsText(props.row.tps)

  return (
    <box flexDirection="column" backgroundColor={RAISED_COLOR} paddingLeft={2} paddingRight={1}>
      {/* 完整标题：主行标题可能被截断，这里给全文；颜色与收起态一致（不改强调） */}
      <Show when={props.row.title}>
        <box flexDirection="row">
          <box flexGrow={1} minWidth={0}>
            {/* 中文标题没有空格分隔，word 模式不会断行；按字符断 */}
            <text fg={SECONDARY_COLOR} wrapMode="char">
              {props.row.title}
            </text>
          </box>
        </box>
      </Show>

      {/* Agent（左）· 供应商（右） */}
      <TwoCol
        left={props.row.agentName ?? props.row.agent}
        leftColor={MUTED_COLOR}
        right={props.row.providerName}
        rightColor={SECONDARY_COLOR}

      />

      {/* 模型（左）· 思考强度（右） */}
      <Show when={props.row.modelName ?? props.row.modelID}>
        <TwoCol
          left={(props.row.modelName ?? props.row.modelID) ?? ""}
          leftColor={SECONDARY_COLOR}
          right={props.row.variant}
          rightColor={SECONDARY_COLOR}

        />
      </Show>

      {/* 耗时 · 消耗（左）· 缓存命中率（右） */}
      <TwoCol
        left={`${fmtElapsed(props.row.elapsedMs)} · ${fmtTokens(props.row.tokens)}`}
        leftColor={SECONDARY_COLOR}
        rightLabel={cache() ? "缓存" : undefined}
        right={cache() || undefined}
        rightColor={CACHE_COLOR}

      />

      {/* TTFT 首字延迟（左）· TPS 生成速度（右）：与运行中第 5 行同色 */}
      <Show when={ttft() || speed()}>
        <TwoCol
          left={ttft()}
          leftColor={SECONDARY_COLOR}
          right={speed() || undefined}
          rightColor={SECONDARY_COLOR}
        />
      </Show>
    </box>
  )
}
