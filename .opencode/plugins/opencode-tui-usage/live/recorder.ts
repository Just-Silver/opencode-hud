// ─── 实时性能记录器（纯逻辑，无 solid / UI 依赖，可单测） ───
// 宿主不记录文本 part 的时间戳，因此「首个内容到达时刻」只能由 started 事件现场
// 记下；历史消息靠 reasoning/tool 的 time.created 兜底（见 model/perf.ts）。
import type { PerfMessage } from "../model/types.ts"
import {
  computeLivePerf,
  computePerfSample,
  estimateParts,
  firstContentStart,
  LIVE_WINDOW_MS,
  runningTool,
  stepFeatures,
  type LivePerf,
  type SamplePoint,
} from "../model/perf.ts"
import { bucketKey, createCoefficientBook, type CoefficientBook } from "../model/calibration.ts"
import { createRateFilter, type RateFilter } from "../model/rate.ts"

// 进程内单例：系数学习状态只存内存，不落盘（重启后从先验重新学习）
let singletonBook: CoefficientBook | undefined
export function getCoefficientBook(): CoefficientBook {
  return (singletonBook ??= createCoefficientBook())
}
export function resetCoefficientBook(): void {
  singletonBook = undefined
}
import { createThrottledBumper } from "../shared/throttle.ts"

// 高频增量的刷新节流：v2 的 delta 按 ~100ms 批次下发
export const PART_THROTTLE_MS = 100
// 心跳：仅 running 时存在，用于捕捉「停顿」（无 delta 但时间在走，速度应下降）
export const BUSY_TICK_MS = 250
// 首字记录上限，防止长会话无限增长
const FIRST_OUTPUT_LIMIT = 1024

// 宿主 data 层的最小契约（等价于 Context["data"] 的子集）
export type HostLike = {
  data: {
    on(type: string, handler: (event: any) => void): () => void
    session: {
      status(id: string): "idle" | "running" | undefined
      message: { list(id: string): readonly any[] | undefined }
    }
  }
}

export type Recorder = {
  firstOutput(messageID: string): number | undefined
  live(sessionID: string): LivePerf | undefined
  track(sessionID: string | undefined): void
  dispose(): void
}

// 本回合内最近一条有内容产出的消息的实时值（首字前 / 守卫不通过时回落）。
// 回合边界（user 消息）即停——不跨回合借速度。
// 已完成的上一步用精确样本（tokens 已写回）；仍在生成中的才走估算。
export function previousPerf(
  messages: readonly PerfMessage[],
  currentID: string | undefined,
): { ttftMs?: number; tps?: number } | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.id === currentID) continue
    if (m.type === "user") return undefined
    if (m.type !== "assistant" || m.error) continue

    const exact = computePerfSample(m)
    if (exact) return { ttftMs: exact.ttftMs, tps: exact.tps }

    const firstStart = (m.content ?? []).find(
      (p) => p.type !== "text" && typeof p.time?.created === "number",
    )?.time?.created
    if (firstStart === undefined) continue
    const live = computeLivePerf(m, firstStart, m.time?.completed ?? Date.now())
    if (live?.tps !== undefined) return { ttftMs: live.ttftMs, tps: live.tps }
  }
  return undefined
}

// 一步已结束（tokens 已写回）→ 用真实 token 反哺系数学习。
// 只在「上一步刚完成」时喂一次，靠 messageID 去重（同一 message 不会重复计入）。
export function learnFromCompleted(
  book: CoefficientBook,
  messages: readonly PerfMessage[],
  seen: Set<string>,
): void {
  for (const m of messages) {
    if (m.type !== "assistant" || m.error) continue
    const id = m.id
    if (!id || seen.has(id)) continue
    const output = Number(m.tokens?.output ?? 0)
    const reasoning = Number(m.tokens?.reasoning ?? 0)
    const actual = output + reasoning
    // 未结束或没有可学习量：不标记 seen（等它完成后再学）
    if (typeof m.time?.completed !== "number") continue
    seen.add(id)
    if (actual <= 0) continue
    const key = bucketKey(m.model?.providerID, m.model?.id)
    book.observe(key, stepFeatures(m.content ?? []), actual)
  }
}

// 事件驱动的学习：`session.step.ended` 自带该步的真实 tokens，
// 不必等消息列表刷新（列表是异步投影，可能滞后一拍）。
// 返回 true 表示这条事件被采纳（用于去重：之后轮询到同一 message 不再重复喂）。
export function learnFromStepEnded(
  book: CoefficientBook,
  messages: readonly PerfMessage[],
  seen: Set<string>,
  event: { data?: { assistantMessageID?: unknown; tokens?: unknown } },
): void {
  const id = event?.data?.assistantMessageID
  if (typeof id !== "string" || seen.has(id)) return
  const tokens = event?.data?.tokens as
    | { output?: unknown; reasoning?: unknown }
    | undefined
  if (!tokens) return
  const actual = Number(tokens.output ?? 0) + Number(tokens.reasoning ?? 0)
  if (!Number.isFinite(actual) || actual <= 0) return
  // 从消息列表取该步的特征与模型（特征只能从内容算，事件里没有）
  const message = messages.find((m) => m.id === id)
  if (!message) return
  seen.add(id)
  const key = bucketKey(message.model?.providerID, message.model?.id)
  book.observe(key, stepFeatures(message.content ?? []), actual)
}

const STARTED_EVENTS = [
  "session.text.started",
  "session.reasoning.started",
  "session.tool.input.started",
]
const DELTA_EVENTS = ["session.text.delta", "session.reasoning.delta", "session.tool.input.delta"]
// 速率先验失效的事件（→ P 重置为冷启动先验）
const RATE_RESET_EVENTS = [
  "session.tool.called",
  "session.tool.success",
  "session.tool.failed",
  "session.step.ended",
  "session.text.started",
  "session.reasoning.started",
]
// 相位切换 / 步结束：立即刷新（不能等节流）
const PHASE_EVENTS = [
  "session.tool.called",
  "session.tool.success",
  "session.tool.failed",
  "session.step.ended",
  "session.step.failed",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
]

export function createRecorder(
  host: HostLike,
  onChange: () => void,
  opts: { now?: () => number; book?: CoefficientBook } = {},
): Recorder {
  const now = opts.now ?? Date.now
  // 系数学习按 provider/model 分桶；未注入时用进程内单例
  const book = opts.book ?? getCoefficientBook()
  // 已喂入学习的消息（避免重复计入同一步）
  const learned = new Set<string>()
  const firstOutput = new Map<string, number>()
  // 每条消息的累计估算观测（滑动窗口用）
  const sampleBuckets = new Map<string, SamplePoint[]>()
  // 工具执行期的冻结值（工具开始时锁住，结束即释放）
  const freezeState = new Map<string, { ttftMs?: number; tps?: number }>()
  // 每条消息（= 每步）一个速率滤波器：事件重置后从新值重建
  const rateFilters = new Map<string, RateFilter>()
  let disposed = false

  const samplesOf = (messageID: string): SamplePoint[] => {
    let bucket = sampleBuckets.get(messageID)
    if (!bucket) {
      bucket = []
      // 简单上限：太多消息时清掉最旧一批（长会话内存保护）
      if (sampleBuckets.size >= 64) {
        const oldest = sampleBuckets.keys().next().value
        if (oldest !== undefined) sampleBuckets.delete(oldest)
      }
      sampleBuckets.set(messageID, bucket)
    }
    return bucket
  }

  const rateFilterOf = (messageID: string): RateFilter => {
    let filter = rateFilters.get(messageID)
    if (!filter) {
      if (rateFilters.size >= 64) {
        const oldest = rateFilters.keys().next().value
        if (oldest !== undefined) rateFilters.delete(oldest)
      }
      filter = createRateFilter()
      rateFilters.set(messageID, filter)
    }
    return filter
  }

  const bump = () => {
    if (disposed) return
    onChange()
  }

  const recordFirst = (messageID: unknown, created: unknown) => {
    if (typeof messageID !== "string" || typeof created !== "number") return
    if (firstOutput.has(messageID)) return
    if (firstOutput.size >= FIRST_OUTPUT_LIMIT) {
      const oldest = firstOutput.keys().next().value
      if (oldest !== undefined) firstOutput.delete(oldest)
    }
    firstOutput.set(messageID, created)
  }

  const throttled = createThrottledBumper(bump, PART_THROTTLE_MS)
  const unsubs: (() => void)[] = []
  for (const type of STARTED_EVENTS) {
    unsubs.push(
      host.data.on(type, (event: any) => recordFirst(event?.data?.assistantMessageID, event?.created)),
    )
  }
  for (const type of DELTA_EVENTS) unsubs.push(host.data.on(type, throttled.bump))
  for (const type of PHASE_EVENTS) unsubs.push(host.data.on(type, bump))
  // 速率跳变事件：工具相位切换、步结束/失败、执行结束。
  // 这些时刻速率先验必然失效（工具期速率为 0、换步后速率重建），把 P 重置回
  // 冷启动先验即可——幂等、不需要「膨胀多少」这种隐藏参数。
  for (const type of RATE_RESET_EVENTS) {
    unsubs.push(
      host.data.on(type, (event: any) => {
        const id = event?.data?.assistantMessageID
        if (typeof id === "string") rateFilters.get(id)?.reset()
      }),
    )
  }
  // 步结束：事件自带真实 tokens，立即反哺系数学习（不必等消息列表刷新）
  unsubs.push(
    host.data.on("session.step.ended", (event: any) => {
      const sid = event?.data?.sessionID
      if (typeof sid !== "string") return
      const messages = (host.data.session.message.list(sid) ?? []) as PerfMessage[]
      learnFromStepEnded(book, messages, learned, event)
    }),
  )

  // busy 心跳：仅 running 时存在，空闲零 interval
  let ticker: ReturnType<typeof setInterval> | undefined
  let tickedSession: string | undefined
  const stopTicker = () => {
    if (ticker !== undefined) clearInterval(ticker)
    ticker = undefined
    tickedSession = undefined
  }

  return {
    firstOutput(messageID) {
      return firstOutput.get(messageID)
    },
    live(sessionID) {
      if (!sessionID) return undefined
      if (host.data.session.status(sessionID) !== "running") return undefined

      const messages = (host.data.session.message.list(sessionID) ?? []) as PerfMessage[]
      // 已结束的步用真实 token 反哺系数学习（幂等，按 messageID 去重）
      learnFromCompleted(book, messages, learned)
      const last = messages[messages.length - 1]
      if (!last || last.type !== "assistant") return undefined
      if (last.error) return undefined

      const messageID = last.id ?? ""
      const firstStart =
        firstOutput.get(messageID) ??
        // 兜底：进程内没记到时，用消息里 reasoning/tool 的时间戳（历史加载路径）
        firstContentStart(last.content ?? [])

      // 这一步已经结束（工具跑完、等下一步创建/首字）：交回精确值展示。
      // 若继续用这条已完成消息重算，分母会跟着墙钟涨而分子不动，读数一路衰减。
      if (typeof last.time?.completed === "number") return undefined

      const at = now()
      const parts = last.content ?? []
      // 本步所属的系数桶：不同供应商的分词器不同，系数不可混用
      const coef = book.coefficient(bucketKey(last.model?.providerID, last.model?.id))
      const tool = runningTool(parts)

      // 工具执行中：分子分母同时停摆，直接返回「进入工具前一刻」的实时值。
      // 这个值必须在工具开始时由当前消息自身缓存，不能拿上一条消息的 carry
      // （否则当前步已有的速度被丢弃，冻结值往往变成 undefined → 界面回落精确值再切回）。
      if (tool) {
        return {
          phase: "tool",
          // 首字不需要冻结：它由 created/firstStart 决定，本就是常量
          ttftMs:
            firstStart !== undefined ? Math.max(0, firstStart - (last.time?.created ?? firstStart)) : undefined,
          // 冻结值缺失时沿用本回合最近值，绝不能回落更早的精确样本（会表现为「一执行工具就掉」）
          tps: freezeState.get(messageID)?.tps ?? previousPerf(messages, last.id)?.tps,
        }
      }

      // 累计估算样本：滑动窗口靠它算「窗口内增量」。工具执行期不采样，
      // 否则参数累积会把工具后的窗口拉偏。
      const tok = estimateParts(parts, coef)
      const samples = samplesOf(messageID)
      if (samples.length === 0 || at > samples[samples.length - 1].at) {
        samples.push({ at, tok })
        // 窗口外只保留一个基线点，避免长会话无限增长
        while (samples.length > 2 && samples[1].at <= at - LIVE_WINDOW_MS) samples.shift()
      }

      // 卡尔曼速率：观测 = 累计估算 token；步内连续采样给速率估计。
      // 速率跳变由事件驱动重置处理（见下），不在这里判相位。
      const rf = rateFilterOf(messageID)
      const rateEst = rf.update({ at, tok })
      // 漏检事件安全网：新息持续偏置 → 速率先验作废，重来。
      // 检测当帧的估计是「按旧模型算出来的」，必然还停在错值上（实测拥堵瞬间可差
      // 数百个百分点），因此该帧不采用它，交给窗口口径兜底。
      const drifted = rf.driftDetected()
      if (drifted) rf.reset()

      const result = computeLivePerf(last, firstStart, at, {
        ttftMs: previousPerf(messages, last.id)?.ttftMs,
        tps: previousPerf(messages, last.id)?.tps,
        samples,
        coefficient: coef,
        rate: !drifted && rateEst.rate > 0 ? rateEst.rate : undefined,
      })

      // 缓存当前步的实时值，供下一次工具执行时冻结
      if (result?.tps !== undefined) freezeState.set(messageID, { tps: result.tps })
      return result
    },
    track(sessionID) {
      const target =
        sessionID && host.data.session.status(sessionID) === "running" ? sessionID : undefined
      if (tickedSession === target) return
      stopTicker()
      if (!target) return
      tickedSession = target
      ticker = setInterval(() => {
        if (host.data.session.status(target) !== "running") {
          stopTicker()
          bump()
          return
        }
        bump()
      }, BUSY_TICK_MS)
    },
    dispose() {
      disposed = true
      throttled.dispose()
      stopTicker()
      for (const unsub of unsubs) unsub()
      unsubs.length = 0
      firstOutput.clear()
      learned.clear()
      rateFilters.clear()
      freezeState.clear()
    },
  }
}
