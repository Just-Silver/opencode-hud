// ─── UI 层：会话用量区块（纯展示） ───
// 配色固定取 theme.ts 调色板（opencode 主题色，不随宿主主题）。
// ⚠️ 响应式约束：组件函数体只执行一次，禁止 props 快照 const；
//    所有取值必须发生在 JSX 表达式位置（Solid 编译器包装为响应式 getter）。
/** @jsxImportSource @opentui/solid */
import { Show, type JSX } from "solid-js"
import type { UsageData } from "../model/types.ts"
import { fmtPct, fmtTokens, sharePct } from "../shared/format.ts"
import { ColorBar } from "./ColorBar.tsx"
import { Collapsible } from "./Collapsible.tsx"
import { MUTED_COLOR, pctColor, SECTION_CACHE_TITLE, TEXT_COLOR } from "./theme.ts"

// 右侧数值列宽（纯 ASCII 数字 → padStart 即可右对齐，无需 CJK 视觉宽度计算）
const VALUE_WIDTH = 8
const SHARE_WIDTH = 6

// 单行：左标签 + flex 填充 + 右对齐数值列 + 占比列（列宽固定 → 各行右缘对齐）
function StatRow(props: { label: string; value: string; share?: string; valueColor?: string }): JSX.Element {
  return (
    <box flexDirection="row">
      <text fg={TEXT_COLOR}>{props.label}</text>
      <box flexGrow={1} />
      <text fg={props.valueColor ?? MUTED_COLOR}>{props.value.padStart(VALUE_WIDTH)}</text>
      <text width={SHARE_WIDTH} fg={MUTED_COLOR}>
        {props.share ? props.share.padStart(SHARE_WIDTH) : ""}
      </text>
    </box>
  )
}

export function UsageSection(props: {
  usage: UsageData
  ctxUsage: number | undefined
  ctxPct: number | undefined
  limit: number | undefined
  cacheRate: number | undefined
}): JSX.Element {
  return (
    <Collapsible title={SECTION_CACHE_TITLE} summary={`（${fmtTokens(props.usage.total)}）`}>
      <box flexDirection="column" gap={0}>
        {/* 上下文：标签 + 进度条 + 百分比 同一行 */}
        <box flexDirection="row" gap={1}>
          <text fg={TEXT_COLOR}>上下文</text>
          <Show when={props.ctxPct !== undefined}>
            <ColorBar pct={props.ctxPct} color={pctColor(props.ctxPct)} />
            {/* 百分比与进度条同色，定宽右对齐 */}
            <text fg={pctColor(props.ctxPct)}>{fmtPct(props.ctxPct).padStart(6)}</text>
          </Show>
        </box>
        <text fg={MUTED_COLOR}>
          {fmtTokens(props.ctxUsage ?? 0)}
          {props.limit ? ` / ${fmtTokens(props.limit)}` : ""}
        </text>
        <StatRow label="总量" value={fmtTokens(props.usage.total)} />
        <StatRow
          label="输入"
          value={fmtTokens(props.usage.input)}
          share={sharePct(props.usage.input, props.usage.total)}
        />
        <StatRow
          label="输出"
          value={fmtTokens(props.usage.output)}
          share={sharePct(props.usage.output, props.usage.total)}
        />
        <StatRow
          label="缓存读取"
          value={fmtTokens(props.usage.read)}
          share={sharePct(props.usage.read, props.usage.total)}
        />
        <Show when={props.usage.write > 0}>
          <StatRow
            label="缓存写入"
            value={fmtTokens(props.usage.write)}
            share={sharePct(props.usage.write, props.usage.total)}
          />
        </Show>
        <Show when={props.usage.reasoning > 0}>
          <StatRow
            label="推理"
            value={fmtTokens(props.usage.reasoning)}
            share={sharePct(props.usage.reasoning, props.usage.total)}
          />
        </Show>
        <Show when={props.cacheRate !== undefined}>
          <StatRow label="缓存命中率" value={fmtPct(props.cacheRate)} />
        </Show>
      </box>
    </Collapsible>
  )
}
