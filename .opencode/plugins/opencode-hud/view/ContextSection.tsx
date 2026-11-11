// ─── UI 层：上下文卡片（OpenCode Native Pro） ───
// 三层信息：① 上下文占用（百分比 + 当前/上限 + 主进度条）
//          ② 累计量的关键值（总量 / 缓存命中 指标块）
//          ③ token 明细（真实数值 + 占总量比例）
// 口径见 docs/token-accounting.md：累计取 SessionInfo.tokens，上下文取最新一条消息。
// ⚠️ 响应式约束：组件函数体只执行一次，禁止 props 快照 const；取值须在 JSX 表达式位置。
/** @jsxImportSource @opentui/solid */
import { Show, type JSX } from "solid-js"
import type { UsageData } from "../model/types.ts"
import { fmtPct, fmtTokens, padEndVisual, padStartVisual, sharePct } from "../shared/format.ts"
import { DashboardCard } from "./Card.tsx"
import { ColorBar } from "./ColorBar.tsx"
import { TOKEN_LABEL_WIDTH, TOKEN_SHARE_WIDTH, TOKEN_VALUE_WIDTH } from "./layout.ts"
import {
  CACHE_COLOR,
  INPUT_COLOR,
  MUTED_COLOR,
  OUTPUT_COLOR,
  RAISED_COLOR,
  SECTION_CONTEXT_TITLE,
  SECONDARY_COLOR,
  TEXT_COLOR,
  WARNING_COLOR,
  contextColor,
} from "./theme.ts"

// 指标块：抬升底色 + 小标签 + 高对比数值（累计量没有固定上限，适合数值块而不是进度条）
function MetricTile(props: { label: string; value: string; tone?: string }): JSX.Element {
  return (
    <box
      flexGrow={1}
      flexBasis={0}
      flexDirection="column"
      backgroundColor={RAISED_COLOR}
      paddingLeft={1}
      paddingRight={1}
    >
      <text fg={MUTED_COLOR} wrapMode="none">
        {props.label}
      </text>
      <text fg={props.tone ?? TEXT_COLOR} wrapMode="none">
        <b>{props.value}</b>
      </text>
    </box>
  )
}

// 明细行：类别色标签 + 右对齐数值 + 占比列（列宽固定 → 各行右缘齐）
function TokenRow(props: {
  label: string
  value: string
  share?: string
  tone: string
}): JSX.Element {
  return (
    <box flexDirection="row" height={1}>
      <text fg={props.tone} wrapMode="none">
        {padEndVisual(props.label, TOKEN_LABEL_WIDTH)}
      </text>
      <text fg={TEXT_COLOR} wrapMode="none">
        {padStartVisual(props.value, TOKEN_VALUE_WIDTH)}
      </text>
      <box flexGrow={1} />
      <text fg={MUTED_COLOR} wrapMode="none">
        {padStartVisual(props.share ?? "", TOKEN_SHARE_WIDTH)}
      </text>
    </box>
  )
}

export function ContextSection(props: {
  usage: UsageData
  ctxUsage: number | undefined
  ctxPct: number | undefined
  limit: number | undefined
  cacheRate: number | undefined
}): JSX.Element {
  const pctText = () => (props.ctxPct === undefined ? "—" : fmtPct(props.ctxPct))
  const contextText = () =>
    props.ctxUsage === undefined
      ? "—"
      : props.limit === undefined
        ? fmtTokens(props.ctxUsage)
        : `${fmtTokens(props.ctxUsage)} / ${fmtTokens(props.limit)}`

  return (
    <DashboardCard title={SECTION_CONTEXT_TITLE}>
      {/* ① 上下文占用：百分比 + 当前/上限 + 主进度条 */}
      <box flexDirection="row" height={1}>
        <text fg={contextColor(props.ctxPct)}>
          <b>{pctText()}</b>
        </text>
        <box flexGrow={1} />
        <text fg={SECONDARY_COLOR} wrapMode="none">
          {contextText()}
        </text>
      </box>
      <ColorBar pct={props.ctxPct} color={contextColor(props.ctxPct)} />

      {/* ② 累计关键值：数值块，不画没有上限意义的满格进度条 */}
      <box flexDirection="row" gap={1} paddingTop={1}>
        <MetricTile label="总量" value={fmtTokens(props.usage.total)} />
        <MetricTile
          label="缓存命中"
          value={props.cacheRate === undefined ? "—" : fmtPct(props.cacheRate)}
          tone={props.cacheRate === undefined ? MUTED_COLOR : TEXT_COLOR}
        />
      </box>

      {/* ③ token 明细：数值 + 占比（累计量不画百分比条，避免无上限的满格条） */}
      <box flexDirection="column" paddingTop={1}>
        <TokenRow
          label="输入"
          tone={INPUT_COLOR}
          value={fmtTokens(props.usage.input)}
          share={sharePct(props.usage.input, props.usage.total)}
        />
        <TokenRow
          label="输出"
          tone={OUTPUT_COLOR}
          value={fmtTokens(props.usage.output)}
          share={sharePct(props.usage.output, props.usage.total)}
        />
        <TokenRow
          label="缓存读"
          tone={CACHE_COLOR}
          value={fmtTokens(props.usage.read)}
          share={sharePct(props.usage.read, props.usage.total)}
        />
        <Show when={props.usage.write > 0}>
          <TokenRow
            label="缓存写"
            tone={CACHE_COLOR}
            value={fmtTokens(props.usage.write)}
            share={sharePct(props.usage.write, props.usage.total)}
          />
        </Show>
        <Show when={props.usage.reasoning > 0}>
          <TokenRow
            label="推理"
            tone={WARNING_COLOR}
            value={fmtTokens(props.usage.reasoning)}
            share={sharePct(props.usage.reasoning, props.usage.total)}
          />
        </Show>
      </box>
    </DashboardCard>
  )
}
