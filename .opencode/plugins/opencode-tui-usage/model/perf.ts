// ─── 模型层：性能指标纯函数（首字 / 速度） ───
// 口径见 docs/design-performance-footer.md：分母不含首字等待，工具执行区间按并集扣除。
// 只算「已完成的步」的精确值：tokens 由宿主在步结束时写回，不做任何估算 / 插值 / 平滑。
// 无 solid / UI / 宿主依赖，可直接单测。
import type { PerfMessage, PerfPart } from "./types.ts"

// 精确侧守卫：短窗口与小步的比值不可信（见设计文档「守卫」）
const MIN_GEN_MS = 300
const BUFFER_MS_PER_TOKEN = 1.0

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
type PerfSample = {
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
