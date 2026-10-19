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
  type LivePerf,
  type SamplePoint,
} from "../model/perf.ts"
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

const STARTED_EVENTS = [
  "session.text.started",
  "session.reasoning.started",
  "session.tool.input.started",
]
const DELTA_EVENTS = ["session.text.delta", "session.reasoning.delta", "session.tool.input.delta"]
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
  opts: { now?: () => number } = {},
): Recorder {
  const now = opts.now ?? Date.now
  const firstOutput = new Map<string, number>()
  // 每条消息的累计估算观测（滑动窗口用）
  const sampleBuckets = new Map<string, SamplePoint[]>()
  // 工具执行期的冻结值（工具开始时锁住，结束即释放）
  const freezeState = new Map<string, { ttftMs?: number; tps?: number }>()
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
      const last = messages[messages.length - 1]
      if (!last || last.type !== "assistant") return undefined
      if (last.error) return undefined

      const messageID = last.id ?? ""
      const firstStart =
        firstOutput.get(messageID) ??
        // 兜底：进程内没记到时，用消息里 reasoning/tool 的时间戳（历史加载路径）
        firstContentStart(last.content ?? [])

      const at = now()
      const parts = last.content ?? []
      const isTool = runningTool(parts) !== undefined

      // 工具执行中：分子分母同时停摆，直接返回「进入工具前一刻」的实时值。
      // 这个值必须在工具开始时由当前消息自身缓存，不能拿上一条消息的 carry
      // （否则当前步已有的速度被丢弃，冻结值往往变成 undefined → 界面回落精确值再切回）。
      if (isTool) {
        const frozen = freezeState.get(messageID)
        return {
          phase: "tool",
          // 首字不需要冻结：它由 created/firstStart 决定，本就是常量
          ttftMs:
            firstStart !== undefined ? Math.max(0, firstStart - (last.time?.created ?? firstStart)) : undefined,
          tps: frozen?.tps,
        }
      }

      // 累计估算样本：滑动窗口靠它算「窗口内增量」。工具执行期不采样，
      // 否则参数累积会把工具后的窗口拉偏。
      const tok = estimateParts(parts)
      const samples = samplesOf(messageID)
      if (samples.length === 0 || at > samples[samples.length - 1].at) {
        samples.push({ at, tok })
        // 窗口外只保留一个基线点，避免长会话无限增长
        while (samples.length > 2 && samples[1].at <= at - LIVE_WINDOW_MS) samples.shift()
      }

      const result = computeLivePerf(last, firstStart, at, {
        ttftMs: previousPerf(messages, last.id)?.ttftMs,
        tps: previousPerf(messages, last.id)?.tps,
        samples,
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
    },
  }
}
