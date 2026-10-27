// ─── 数据层：子代理行的取数与汇总（纯函数，可单测） ───
// 结构数据全部来自 SessionInfo 聚合列，不读子会话消息。
// 布局与交互见 docs/design-subagent-section.md。
import type { SubagentInfo } from "./types.ts"
import { subagentElapsedMs, subagentEndedAt, subagentTokens } from "./perf.ts"
import { cacheRateOf } from "./usage.ts"
import { fmtTokens } from "../shared/format.ts"

// 单条子代理的展示数据
export type SubagentRow = {
  id: string
  agent: string
  title?: string
  modelID?: string
  variant?: string
  tokens: number
  /** 缓存命中率（%），与会话区块同一口径；无缓存数据时 undefined */
  cacheRate?: number
  elapsedMs?: number
  /** 结束时刻（只用于排序，不展示）；运行中为 undefined */
  endedAt?: number
  running: boolean
  expanded: boolean
}

// 子代理缓存命中率：与会话区块同一口径（read / (input + write + read)）
export function subagentCacheRate(tokens: SubagentInfo["tokens"]): number | undefined {
  if (!tokens) return
  return cacheRateOf(tokens.cache?.read ?? 0, tokens.input ?? 0, tokens.cache?.write ?? 0)
}

// 从 SessionInfo 组装一行；无 tokens 也显示（新起的子代理）
export function buildRow(
  info: SubagentInfo,
  opts: { running: boolean; expanded: boolean; now: number; prevElapsed?: number },
): SubagentRow {
  return {
    id: info.id,
    agent: info.agent || "agent",
    title: info.title,
    modelID: info.model?.id,
    variant: info.model?.variant,
    tokens: subagentTokens(info.tokens),
    cacheRate: subagentCacheRate(info.tokens),
    elapsedMs: clampElapsed(opts.prevElapsed, subagentElapsedMs(info.time, opts.running, opts.now)),
    endedAt: subagentEndedAt(info.time, opts.running),
    running: opts.running,
    expanded: opts.expanded,
  }
}

// 耗时只增不减。多步执行的子代理在步骤边界会短暂变 idle，而 time.idle 仍是上一轮
// 的旧值，直接采用会让「分」来回跳（实测同一行在 1m19s 与 57s 间闪烁）。
// created 不变，耗时在语义上就是单调不减的，用高水位钳住即可。
export function clampElapsed(prev: number | undefined, next: number | undefined): number | undefined {
  if (next === undefined) return prev
  if (prev === undefined) return next
  return next > prev ? next : prev
}

// 模型 + 强度：`deepseek-v4.1-flash (high)`；无 variant 时省略括号
export function modelLabel(modelID: string | undefined, variant: string | undefined): string {
  if (!modelID) return ""
  return variant ? `${modelID} (${variant})` : modelID
}

// 主行文字：标题优先；标题缺失（旧会话/未命名）时回退 agent 类型，不留空
export function headingOf(row: SubagentRow): string {
  return row.title || row.agent
}

// 标题行的状态指示灯：运行中数 / 已完成数，形如 `●35 ●1`（上游同款形态）。
// 与上游的差别：两个数的语义在文档里写死——橙点=运行中、绿点=已完成，
// 不上游那种「●N 是已完成、另一个 ●N 是失败」的歧义。
export type StatusLights = {
  running: number
  done: number
}

export function statusLights(rows: readonly SubagentRow[]): StatusLights | undefined {
  if (rows.length === 0) return undefined
  const running = rows.filter((r) => r.running).length
  return { running, done: rows.length - running }
}

// 标题行右端的合计。子代理单项就是真实累计消耗（含缓存读），加总有意义；
// 上游的 token 徽标是「上下文规模横向相加」，口径不同不可类推。
export function totalTokensText(rows: readonly SubagentRow[]): string | undefined {
  if (rows.length === 0) return undefined
  const total = rows.reduce((sum, r) => sum + r.tokens, 0)
  return total > 0 ? fmtTokens(total) : undefined
}

// 排序：运行中优先（组内按耗时倒序），已完成按**结束时刻**倒序（最近完成的在最上）。
// 为什么不用耗时倒序：耗时倒序会把 58m 的老任务压在刚跑完的 2m 之上，「最近 N 条」
// 的筛选与展示会自相矛盾。同值用 id 兜底，避免每秒重算时等价行互换位置（会让列表闪动）。
export function sortRows(rows: SubagentRow[]): SubagentRow[] {
  return [...rows].sort((a, b) => {
    if (a.running !== b.running) return a.running ? -1 : 1
    const diff = a.running
      ? (b.elapsedMs ?? 0) - (a.elapsedMs ?? 0)
      : (b.endedAt ?? 0) - (a.endedAt ?? 0)
    if (diff !== 0) return diff
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
}

// 常驻区最多保留的已完成条数（运行中的条目不设上限）。
// 5 覆盖「一次并发 3~5 个」的常见批量，且不会把上方的用量区块挤出视野。
export const VISIBLE_DONE_ROWS = 5

// 切成常驻段与折叠段：head = 全部运行中 + 最近 keepDone 条已完成，tail = 其余已完成。
// 输入须已 sortRows。被复用的老子代理重新 running 时凭状态自动回到 head，
// 与它多老无关；再次结束后 idle 被刷新，于是成为「最近完成」的头部。
export function visibleRows(
  rows: readonly SubagentRow[],
  keepDone: number = VISIBLE_DONE_ROWS,
): { head: SubagentRow[]; tail: SubagentRow[] } {
  let budget = Math.max(0, keepDone)
  const head: SubagentRow[] = []
  const tail: SubagentRow[] = []
  for (const row of rows) {
    if (row.running) {
      head.push(row)
    } else if (budget > 0) {
      budget--
      head.push(row)
    } else {
      tail.push(row)
    }
  }
  return { head, tail }
}

// ── 运行中条目的 spinner ──
// 字符取自宿主 component/spinner-frames.ts 的 SPINNER_FRAMES（盲文点阵，1 列宽）。
// 宿主输入框运行态用的是 8 列扫描条（Knight Rider），在 34 列侧边栏里会挤掉标题，
// 故这里用单字符点阵：语义相同（正在工作），不破坏行宽预算。
export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const

// 每帧间隔：与宿主 Spinner 组件默认节奏一致（80ms）
export const SPINNER_INTERVAL_MS = 80

// 行首字形：运行中取旋转点阵，已停止用静态状态点
export function statusGlyph(running: boolean, frame: number): string {
  if (!running) return "●"
  const i = Math.abs(Math.trunc(frame)) % SPINNER_FRAMES.length
  return SPINNER_FRAMES[i]
}
