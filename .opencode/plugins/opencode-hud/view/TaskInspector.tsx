// ─── UI 层：子代理 Task Inspector（统一双列展开详情） ───
// 已停止：四行（完整标题 / 模型 · 强度 / Agent · 缓存 / TTFT · TPS）。
// 运行中：三行——TTFT/TPS 已在主卡片常驻第三行显示，这里不重复。
// 所有行共用一套双列对齐：左列左对齐（可换行），右列右对齐（右缘固定），
// 中间靠弹性盒留白（不手写空格），数值变化只影响中间空白，不带动右缘抖动。
// 状态、耗时、累计消耗由主行承担，详情不重复。
// ⚠️ Solid：组件函数体只执行一次，取值写在 JSX 表达式或惰性 getter 里。
/** @jsxImportSource @opentui/solid */
import { Show, type JSX } from "solid-js"
import type { SubagentRow } from "../model/subagent.ts"
import { fmtPct, fmtSec, fmtTpsText } from "../shared/format.ts"
import { CACHE_COLOR, MUTED_COLOR, RAISED_COLOR, SECONDARY_COLOR, TEXT_COLOR } from "./theme.ts"

// 双列行：左列吃剩余宽度并按字符换行，右列贴右缘。
// 左列 paddingRight 1 保证两列之间至少留 1 列，内容再长也不会贴在一起。
function TwoCol(props: {
  left: string
  leftColor: string
  right?: string
  rightColor?: string
  /** 右列前缀（如「缓存」），弱化色 */
  rightLabel?: string
  /** 右列是否加粗（数值加粗，元信息如思考强度不加粗） */
  rightBold?: boolean
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
          <Show
            when={props.rightBold !== false}
            fallback={
              <text fg={props.rightColor ?? TEXT_COLOR} wrapMode="none">
                {props.right}
              </text>
            }
          >
            <text fg={props.rightColor ?? TEXT_COLOR} wrapMode="none">
              <b>{props.right}</b>
            </text>
          </Show>
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
      {/* 完整标题：主行标题可能被截断，这里给全文；超宽按字符换行 */}
      <Show when={props.row.title}>
        <box flexDirection="row">
          <box flexGrow={1} minWidth={0}>
            {/* 中文标题没有空格分隔，word 模式不会断行；按字符断 */}
            <text fg={TEXT_COLOR} wrapMode="char">
              <b>{props.row.title}</b>
            </text>
          </box>
        </box>
      </Show>

      {/* 模型（左）· 思考强度（右） */}
      <Show when={props.row.modelID}>
        <TwoCol
          left={props.row.modelID ?? ""}
          leftColor={SECONDARY_COLOR}
          right={props.row.variant}
          rightColor={SECONDARY_COLOR}
          rightBold={false}
        />
      </Show>

      {/* Agent（左）· 缓存命中率（右） */}
      <TwoCol
        left={props.row.agent}
        leftColor={MUTED_COLOR}
        rightLabel={cache() ? "缓存" : undefined}
        right={cache() || undefined}
        rightColor={CACHE_COLOR}
      />

      {/* TTFT 首字延迟（左）· TPS 生成速度（右）；运行中已在常驻第三行显示，详情不重复 */}
      <Show when={!props.row.running && (ttft() || speed())}>
        <TwoCol left={ttft()} leftColor={TEXT_COLOR} right={speed() || undefined} rightColor={TEXT_COLOR} />
      </Show>
    </box>
  )
}
