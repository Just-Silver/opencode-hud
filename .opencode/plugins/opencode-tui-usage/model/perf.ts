// ─── 模型层：性能指标纯函数（首字 / 速度） ───
// 口径见 docs/design-performance-footer.md：分母不含首字等待，工具执行区间按并集扣除。
// 无 solid / UI / 宿主依赖，可直接单测。
import type { PerfMessage, PerfPart } from "./types.ts"

// 精确侧守卫：短窗口与小步的比值不可信（见设计文档「守卫」）
export const MIN_GEN_MS = 300
export const BUFFER_MS_PER_TOKEN = 1.0
// 实时侧守卫：分子是估算值，需要更长窗口才稳定
export const LIVE_MIN_GEN_MS = 500
export const LIVE_MIN_TOK = 8

// token 密度画像（ASCII 字/token），来源见设计文档
const ASCII_PER_TOKEN = { thinking: 4.0, answer: 2.9, code: 3.7 } as const

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0)

// 合并重叠区间（并行工具不重复扣），并钳位到 [lo, hi]；返回总毫秒
export function mergedIntervalMs(
  intervals: readonly (readonly [number, number])[],
  lo: number,
  hi?: number,
): number {
  if (intervals.length === 0) return 0
  const sorted = [...intervals].sort((a, b) => a[0] - b[0])
  let total = 0
  let ws = -1
  let we = -1
  for (const [s, e] of sorted) {
    const a = Math.max(s, lo)
    const b = hi === undefined ? e : Math.min(e, hi)
    if (b <= a) continue
    if (ws < 0) {
      ws = a
      we = b
    } else if (a <= we) {
      if (b > we) we = b
    } else {
      total += we - ws
      ws = a
      we = b
    }
  }
  if (ws >= 0) total += we - ws
  return total
}

// 工具是否正在执行（分子分母应停摆）。
// 判定用「状态优先 + 时间戳兜底」：`running` 是确定的执行态；`streaming` 是参数仍在
// 生成（模型还在吐 token），不能冻结。不同供应商/宿主版本对 `ran` 的写入不一致
// （实测有只写 time.created 不写 ran 的情况），因此不能只依赖时间戳。
export function runningTool(parts: readonly PerfPart[]): PerfPart | undefined {
  for (const p of parts) {
    if (p.type !== "tool") continue
    const status = p.state?.status
    if (status === "running") return p
    const ran = p.time?.ran
    const completed = p.time?.completed
    if (typeof ran === "number" && ran > 0 && typeof completed !== "number") return p
  }
  return undefined
}

// 最近一个已完成工具的结束时刻：滑动窗口不得跨过工具执行期，
// 否则工具返回后的第一个窗口会把大段空档算进分母，速度骤降。
export function lastToolEnd(parts: readonly PerfPart[]): number | undefined {
  let end: number | undefined
  for (const p of parts) {
    if (p.type !== "tool") continue
    const c = p.time?.completed
    if (typeof c === "number" && c > 0 && (end === undefined || c > end)) end = c
  }
  return end
}

// 估算分子：文本按形态分画像；工具参数一并计入（参数也是模型生成的 token，
// 参数流式期 state.input 是逐步拼接的字符串，长度即增量）。
export function estimateParts(parts: readonly PerfPart[]): number {
  let estTok = 0
  for (const p of parts) {
    if (p.type === "text" || p.type === "reasoning") {
      estTok += estimateTokens(p.text ?? "", p.type === "reasoning" ? "thinking" : "answer")
    } else if (p.type === "tool") {
      const input = p.state?.input
      const raw = typeof input === "string" ? input : input == null ? "" : JSON.stringify(input)
      if (raw) estTok += estimateTokens(raw, "code")
    }
  }
  return estTok
}

// 单个工具的执行区间；未执行/未结束时返回 undefined
function toolInterval(part: PerfPart): readonly [number, number] | undefined {
  const st = part.time
  const start = st?.ran ?? st?.created
  const end = st?.completed
  if (typeof start !== "number" || start <= 0) return undefined
  if (typeof end !== "number" || end <= start) return undefined
  return [start, end]
}

// 所有已完成工具的执行区间（供扣减）
export function toolIntervals(parts: readonly PerfPart[]): readonly (readonly [number, number])[] {
  const out: (readonly [number, number])[] = []
  for (const p of parts) {
    if (p.type !== "tool") continue
    const iv = toolInterval(p)
    if (iv) out.push(iv)
  }
  return out
}

// 首个内容 part 的时间戳：text 无时间字段，故只有 reasoning / tool 能提供
export function firstContentStart(parts: readonly PerfPart[]): number | undefined {
  let first: number | undefined
  for (const p of parts) {
    if (p.type !== "text" && p.type !== "reasoning" && p.type !== "tool") continue
    const t = p.time?.created
    if (typeof t !== "number" || t <= 0) continue
    if (first === undefined || t < first) first = t
  }
  return first
}

// 一条消息的性能样本；无法计算时返回 undefined（不填 0、不猜）
export type PerfSample = {
  ttftMs: number
  tps: number | undefined
}

export function computePerfSample(message: PerfMessage): PerfSample | undefined {
  const created = message.time?.created
  const completed = message.time?.completed
  if (typeof created !== "number" || created <= 0) return undefined
  if (typeof completed !== "number" || completed <= created) return undefined
  if (message.error) return undefined

  const parts = message.content ?? []
  const firstStart = firstContentStart(parts)
  if (firstStart === undefined || firstStart <= created) return undefined

  const tokens = message.tokens
  const output = num(tokens?.output)
  const reasoning = num(tokens?.reasoning)
  const genTok = output + reasoning
  if (genTok <= 0) return undefined

  const toolMs = mergedIntervalMs(toolIntervals(parts), firstStart, completed)
  const genMs = Math.max(0, completed - firstStart - toolMs)
  const ttftMs = firstStart - created

  const tps =
    genTok > 0 && genMs >= Math.max(MIN_GEN_MS, genTok * BUFFER_MS_PER_TOKEN)
      ? (genTok / genMs) * 1000
      : undefined

  return { ttftMs, tps }
}

// 会话内最近的可用样本：首字与速度分别回溯（速度可来自更早的有效步）
export function latestPerf(messages: readonly PerfMessage[]): {
  ttftMs: number | undefined
  tps: number | undefined
} {
  let ttftMs: number | undefined
  let tps: number | undefined
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.type !== "assistant") continue
    const sample = computePerfSample(message)
    if (!sample) continue
    if (ttftMs === undefined) ttftMs = sample.ttftMs
    if (tps === undefined) tps = sample.tps
    if (ttftMs !== undefined && tps !== undefined) break
  }
  return { ttftMs, tps }
}

// ── 实时值 ──

// 估算文本 token 数：汉字 1.5 字/token，假名/全角 1 字/token，ASCII 按画像折算
export function estimateTokens(text: string, profile: keyof typeof ASCII_PER_TOKEN = "answer"): number {
  if (!text) return 0
  let ascii = 0
  let wide = 0
  let han = 0
  for (const c of text) {
    const code = c.codePointAt(0) ?? 0
    if (code >= 0x4e00 && code <= 0x9fff) han++
    else if (
      (code >= 0x3040 && code <= 0x30ff) ||
      (code >= 0x3000 && code <= 0x303f) ||
      (code >= 0xff00 && code <= 0xffef) ||
      (code >= 0xac00 && code <= 0xd7af)
    )
      wide++
    else ascii++
  }
  const value = ascii / ASCII_PER_TOKEN[profile] + wide + han / 1.5
  return value > 0 ? Math.ceil(value) : 0
}

// 实时速度用滑动窗口而不是「从首字起的累计平均」：
// 累计平均在开头一簇 token 到达后会单调衰减（分子不再涨、分母一直涨），
// 实测：起始 200 tok/s 后恒定 50 tok/s，累计口径会一路从 225 掉到 88 且永不回收。
export const LIVE_WINDOW_MS = 2000
// 窗口内有效生成时长的下限：太短则比值不可信
export const LIVE_MIN_SPAN_MS = 800

// 累计估算的一次观测（tok 为该时刻的累计估算值）
export type SamplePoint = { at: number; tok: number }

// [lo, hi] 内工具执行总时长（合并重叠后）
export function toolMsBetween(parts: readonly PerfPart[], lo: number, hi: number): number {
  return mergedIntervalMs(toolIntervals(parts), lo, hi)
}

// 滑动窗口速度：只用窗口内的增量与净生成时长。
// windowStart 由调用方指定（已钳位到「生成起点 / 最近工具结束」之后），
// 避免把工具执行期或生成开始前的空档算进分母。
export function windowedTps(
  samples: readonly SamplePoint[],
  now: number,
  pausedMs: number,
  windowStart: number,
): number | undefined {
  if (samples.length < 2) return undefined
  // 起点不能早于首个样本：早于它的时间是「生成尚未开始」，计入分母会压低速度
  const start = Math.max(windowStart, samples[0].at)

  // 起点处的累计值：在相邻样本间线性插值，不能退回到「最老样本」
  // （修剪后最老项可能远早于窗口起点，直接当基线等于又回到累计平均，会一路掉）
  const baseTok = tokAt(samples, start)
  if (baseTok === undefined) return undefined

  const last = samples[samples.length - 1]
  const span = last.at - start
  if (span <= 0) return undefined
  const active = span - pausedMs
  if (active < LIVE_MIN_SPAN_MS) return undefined
  const deltaTok = last.tok - baseTok
  if (deltaTok < LIVE_MIN_TOK) return undefined
  return (deltaTok / active) * 1000
}

// 估算时刻 at 的累计 token：线性插值；早于首样本返回首样本值，晚于末样本返回末样本值
function tokAt(samples: readonly SamplePoint[], at: number): number | undefined {
  if (samples.length === 0) return undefined
  if (at <= samples[0].at) return samples[0].tok
  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1]
    const cur = samples[i]
    if (cur.at === prev.at) continue
    if (at <= cur.at) {
      const ratio = (at - prev.at) / (cur.at - prev.at)
      return prev.tok + (cur.tok - prev.tok) * ratio
    }
  }
  return samples[samples.length - 1].tok
}

// 实时性能：同一位置同一顺序，工具执行期冻结（值由调用方缓存，不再重算）
export type LivePhase = "prefill" | "streaming" | "tool"

export type LivePerf = {
  phase: LivePhase
  ttftMs: number | undefined
  tps: number | undefined
}

export type LiveOpts = {
  ttftMs?: number
  tps?: number
  // 当前消息的累计估算观测序列（含本次），用于滑动窗口
  samples?: readonly SamplePoint[]
}

export function computeLivePerf(
  message: PerfMessage,
  firstStart: number | undefined,
  now: number,
  opts?: LiveOpts,
): LivePerf | undefined {
  const created = message.time?.created
  if (typeof created !== "number" || created <= 0) return undefined

  const parts = message.content ?? []
  const ttftMs = firstStart !== undefined ? Math.max(0, firstStart - created) : undefined

  // 工具执行中：分子分母同时停摆 → 用调用方缓存的「工具开始前」的值，绝不再重算。
  // 不能用 state.status === "streaming" 判定：那是参数仍在生成（模型还在吐 token），
  // 此时参数已计入分子，速度应继续计算；只有 ran 已写、completed 未写才是真执行。
  if (runningTool(parts)) {
    return { phase: "tool", ttftMs: ttftMs ?? opts?.ttftMs, tps: opts?.tps }
  }

  // 首字前：等待时长仍在累计（此时用 … 表示「还在等」），速度沿用本回合最近值
  if (firstStart === undefined) {
    return { phase: "prefill", ttftMs: Math.max(0, now - created), tps: opts?.tps }
  }

  const estTok = estimateParts(parts)
  const totalToolMs = toolMsBetween(parts, firstStart, now)
  const elapsed = Math.max(0, now - firstStart - totalToolMs)

  // 优先滑动窗口（需要足够长的运行时间才有意义）；早期用累计值，二者此时等价。
  // 窗口起点不得跨过最近一次工具执行：工具刚返回时若把工具期的空档算进分母，速度会骤降。
  let tps: number | undefined
  if (opts?.samples && opts.samples.length >= 2 && elapsed >= LIVE_WINDOW_MS) {
    const floor = Math.max(firstStart, lastToolEnd(parts) ?? firstStart)
    const windowStart = Math.max(floor, now - LIVE_WINDOW_MS)
    const pausedInWindow = toolMsBetween(parts, windowStart, now)
    tps = windowedTps(opts.samples, now, pausedInWindow, windowStart)
  }
  if (tps === undefined) {
    tps =
      elapsed >= LIVE_MIN_GEN_MS && estTok >= LIVE_MIN_TOK ? (estTok / elapsed) * 1000 : opts?.tps
  }

  return { phase: "streaming", ttftMs, tps }
}

// ── 子代理 ──

// 子会话总消耗（含缓存读，用户明确不排除）
export function subagentTokens(tokens: {
  input?: number
  output?: number
  reasoning?: number
  cache?: { read?: number; write?: number }
} | undefined): number {
  if (!tokens) return 0
  return (
    num(tokens.input) + num(tokens.output) + num(tokens.reasoning) + num(tokens.cache?.read) + num(tokens.cache?.write)
  )
}

// 子会话耗时；运行中按 now 计，否则用 idle（缺失回退 updated）
export function subagentElapsedMs(
  time: { created?: number; updated?: number; idle?: number } | undefined,
  running: boolean,
  now: number,
): number | undefined {
  const created = time?.created
  if (typeof created !== "number" || created <= 0) return undefined
  if (running) return Math.max(0, now - created)
  const end = time?.idle ?? time?.updated
  if (typeof end !== "number" || end <= created) return undefined
  return end - created
}
