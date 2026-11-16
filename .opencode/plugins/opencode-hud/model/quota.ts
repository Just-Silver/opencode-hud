// ─── 模型层：额度查询状态机（凭据分桶 + 刷新/退避 + 并发去重 + 写库订阅通知，依赖注入可单测） ───
import { QuotaRequestError, redactSecrets, type QuotaErrorCode } from "../shared/http.ts"
import { normID } from "../shared/id.ts"
import { fmtAge, fmtCountdown } from "../shared/format.ts"
import type { QuotaData, QuotaItem, QuotaStatus } from "./types.ts"

// 网络刷新最小间隔：额度接口按次计费/限流，60s 强刷不划算。
export const QUOTA_REFRESH_MS = 5 * 60_000
// 超过这个年龄的缓存视为过期：正常 5min 刷新下不会发生，说明刷新连续失败或进程被挂起。
export const QUOTA_STALE_MS = 2 * QUOTA_REFRESH_MS
// 兜底心跳：只做凭据探测与「到点没被唤醒」的补漏，不决定请求节奏（请求节奏由 nextCheckAt 排程）。
export const QUOTA_TICK_MS = 60_000
const BACKOFF_BASE_MS = 5 * 60_000
const BACKOFF_MAX_MS = 15 * 60_000
const ERROR_TEXT_MAX = 300

export type QuotaErrorState = {
  code: QuotaErrorCode
  status?: number
  /** Retry-After 换算出的绝对时刻；没到点 store 不再请求。 */
  retryAt?: number
  /** 已脱敏、已截断，可直接进应用内 console 面板。 */
  message: string
}

export type QuotaKey = { key: string; identity: string }
// 三分支：对象 = 可用凭据；null = 有意跳过（宿主状态不明/非公共 Console）；undefined = 没有任何来源
export type QuotaKeyResolution = QuotaKey | null | undefined

// 查询服务依赖（生产由入口注入真实实现，测试注入 mock）
export interface QuotaDeps {
  apiUrlFor(pid: string): string | undefined
  resolveKey(pid: string): Promise<QuotaKeyResolution>
  fetch(pid: string, apiUrl: string, key: string): Promise<QuotaData | undefined>
  log(level: "warn" | "error", message: string): void
  /** 可注入时钟，供退避/间隔测试；生产用 Date.now。 */
  now?(): number
}

type InFlight = {
  /** 发请求时的凭据身份：等待者据此判断「等的是不是当前账号」。 */
  fingerprint: string
  promise: Promise<boolean>
}

type Entry = {
  /** 凭据身份：换号（identity 变）就是另一个账号，旧行不能继续展示。 */
  fingerprint: string
  data?: QuotaData
  /** 上次尝试结束的时刻；没有表示这个凭据还没请求过。 */
  at?: number
  /** 上次成功写入数据的时刻（新鲜度只看它，不看失败尝试）。 */
  updatedAt?: number
  failures: number
  retryAt?: number
  error?: QuotaErrorState
}

function backoffMs(failures: number): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (failures - 1))
}

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

function errorStateOf(error: unknown, key: string): QuotaErrorState {
  const message = redactSecrets(errorText(error), [key]).slice(0, ERROR_TEXT_MAX)
  if (error instanceof QuotaRequestError) {
    return {
      code: error.code,
      message,
      ...(error.status === undefined ? {} : { status: error.status }),
      ...(error.retryAt === undefined ? {} : { retryAt: error.retryAt }),
    }
  }
  return { code: "provider_error", message }
}

export class QuotaStore {
  private entries = new Map<string, Entry>()
  private inFlight = new Map<string, InFlight>()
  private listeners = new Set<() => void>()
  private deps: QuotaDeps

  constructor(deps: QuotaDeps) {
    this.deps = deps
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private bump() {
    for (const fn of [...this.listeners]) fn()
  }

  // 当前缓存（只属于最近一次 load 解析出的凭据）
  get(pid: string): QuotaData | undefined {
    return this.entries.get(pid)?.data
  }

  // 最近一次请求失败的结构化原因（未失败/已恢复 → undefined）
  error(pid: string): QuotaErrorState | undefined {
    return this.entries.get(pid)?.error
  }

  // 下一次允许发起请求的绝对时刻（只读）。UI 的倒计时与调度都读它，不在别处重算退避公式。
  // undefined = 无法确定：未注册端点 / 还没解析到凭据 / 从未尝试 / 在途（落定后重新排程）。
  nextCheckAt(pid: string): number | undefined {
    if (!this.deps.apiUrlFor(pid)) return undefined
    const entry = this.entries.get(pid)
    if (!entry) return undefined
    if (this.inFlight.has(pid)) return undefined
    if (entry.fingerprint === "") return undefined // 没凭据：等凭据探测发现登录，不空转
    if (entry.retryAt !== undefined) return entry.retryAt // 服务端 Retry-After 优先于本地退避
    if (entry.at === undefined) return undefined
    return entry.at + (entry.failures > 0 ? backoffMs(entry.failures) : QUOTA_REFRESH_MS)
  }

  // 展示层新鲜度：只读快照，不触发请求。
  // phase 与 error 都来自同一条 entry，因此「有缓存 + 刷新失败」会同时给出 data 与 error。
  status(pid: string, now: number = this.now()): QuotaStatus {
    const entry = this.entries.get(pid)
    const hasData = entry?.data !== undefined
    const { ageMs, stale } = quotaAge(entry?.updatedAt, now)
    const fetching = this.inFlight.has(pid)
    const phase = hasData
      ? entry?.error
        ? "error"
        : stale
          ? "stale"
          : "ready"
      : fetching
        ? "loading"
        : entry?.error
          ? "error"
          : "empty"
    const nextRefreshAt = this.nextCheckAt(pid)
    return {
      phase,
      hasData,
      fetching,
      ...(ageMs === undefined ? {} : { ageMs }),
      stale,
      ...(entry?.updatedAt === undefined ? {} : { updatedAt: entry.updatedAt }),
      ...(nextRefreshAt === undefined ? {} : { nextRefreshAt }),
      ...(entry?.error === undefined ? {} : { error: entry.error }),
    }
  }

  // 订阅数据变更（仅在缓存真正变化时通知）；返回退订函数（组件 onCleanup 调用）
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  // 取（或切换）当前凭据对应的桶。身份变了 = 换了账号：旧数据立刻作废并清空退避，
  // 不能等新请求成功才替换，否则切号后最多还有一个刷新周期的旧账号数据。
  private adopt(pid: string, fingerprint: string): Entry {
    const existing = this.entries.get(pid)
    if (existing && existing.fingerprint === fingerprint) return existing
    const next: Entry = { fingerprint, failures: 0 }
    this.entries.set(pid, next)
    if (existing?.data !== undefined) this.bump()
    return next
  }

  // 按需加载：默认尊重 5min 刷新间隔与失败退避；opts.force 只绕过成功态的间隔，
  // 不绕过失败退避与 Retry-After（timer 轮询用，避免限流时持续加压）。
  // 返回 true = 本次拿到了可用数据；被间隔/退避/Retry-After 跳过返回 false。
  async load(pid: string, opts?: { force?: boolean }): Promise<boolean> {
    // 未注册额度端点：正常路径不可达（候选来自 registry），静默跳过。
    // 不记日志：调用方漏了白名单守卫时，60s 心跳会把「供应商本来就没有查询」刷成 warn。
    const apiUrl = this.deps.apiUrlFor(pid)
    if (!apiUrl) return false

    // 在途请求可能属于刚被切掉的旧凭据：等它落定后为新凭据接续一次请求，否则新账号要等
    // 60s 心跳才出现，且这段时间没有可排程的截止时刻。只接续一轮：等待期间再次切号/登出时，
    // 第二轮会重新解析凭据（不会把旧 key 复活成当前账号），也不会形成递归/重试风暴。
    for (let attempt = 0; attempt < 2; attempt++) {
      // 先解析凭据再判断间隔：否则旧凭据的退避会挡住新凭据的第一次尝试。
      let resolution: QuotaKeyResolution
      try {
        resolution = await this.deps.resolveKey(pid)
      } catch {
        resolution = undefined
      }
      // 有意跳过（宿主状态不明 / 非公共 Console）：换到空桶立即丢掉旧账号数据，
      // 但不 warn（不是「没登录」）、不请求、不写数据；空桶也排不出下一次检查时刻。
      if (resolution === null) {
        this.adopt(pid, "")
        return false
      }
      const fingerprint = resolution ? resolution.identity : ""
      const entry = this.adopt(pid, fingerprint)
      if (!resolution) {
        // 没凭据是常态（没登录 / 未连接）：同一凭据状态下只记一次，心跳不刷屏；
        // 登录或切号会换桶（fingerprint 变化），之后再丢凭据会重新记一条。
        const first = entry.at === undefined
        entry.at = this.now()
        if (first) this.deps.log("warn", `quota ${pid} missing key`)
        return false
      }
      const key = resolution.key

      const now = this.now()
      // 服务端给了 Retry-After 就以它为准：到点就试一次，不再叠加本地退避。
      let retryDue = false
      if (entry.retryAt !== undefined) {
        if (now < entry.retryAt) return false
        entry.retryAt = undefined
        retryDue = true
      }
      const waitMs = entry.failures > 0 ? backoffMs(entry.failures) : QUOTA_REFRESH_MS
      const forced = opts?.force === true && entry.failures === 0
      if (!retryDue && entry.at !== undefined && now - entry.at < waitMs && !forced) {
        return false
      }

      const flight = this.inFlight.get(pid)
      if (flight) {
        await flight.promise
        // 同身份：本次等待就是并发去重，直接回报刚写入的缓存；失败/空响应也在这里结束，
        // 重新走一遍间隔/退避判断只会被同样挡下，不在这里重发。
        if (flight.fingerprint === fingerprint) return this.entries.get(pid)?.data !== undefined
        // 旧身份的结果已按 identity 丢弃：回到循环顶部重新解析当前凭据，并为它接续请求。
        continue
      }

      const promise = (async (): Promise<boolean> => {
        try {
          const usage = await this.deps.fetch(pid, apiUrl, key)
          const current = this.entries.get(pid)
          // 请求期间切了凭据：这是旧账号的结果，丢弃，不覆盖新桶。
          if (!current || current.fingerprint !== fingerprint) return false
          if (usage) {
            const at = this.now()
            this.entries.set(pid, { fingerprint, data: usage, at, updatedAt: at, failures: 0 })
            return true
          }
          current.at = this.now()
          current.failures = 0
          current.error = undefined
          this.deps.log("warn", `quota ${pid} empty response`)
          return false
        } catch (caught) {
          const current = this.entries.get(pid)
          if (!current || current.fingerprint !== fingerprint) return false
          const error = errorStateOf(caught, key)
          this.entries.set(pid, {
            fingerprint,
            ...(current.data === undefined ? {} : { data: current.data }),
            ...(current.updatedAt === undefined ? {} : { updatedAt: current.updatedAt }),
            at: this.now(),
            failures: current.failures + 1,
            ...(error.retryAt === undefined ? {} : { retryAt: error.retryAt }),
            error,
          })
          this.deps.log("error", `quota ${pid} fetch failed: ${error.message}`)
          return false
        }
      })().finally(() => {
        // 先清在途标记再通知：展示层的 fetching 直接读 inFlight，
        // 在清掉之前通知会把界面钉在「有数据 + 仍在途」的快照上（「更新中」要等下一次心跳才撤）。
        // 与下面的开始通知成对出现：开始（fetching=true）→ 落定（fetching=false + 新截止时刻）。
        // 只清自己这条记录：接续请求可能已把它替换成新凭据的记录。
        if (this.inFlight.get(pid)?.promise === promise) this.inFlight.delete(pid)
        this.bump()
      })
      this.inFlight.set(pid, { fingerprint, promise })
      // 请求真正开始时立刻通知一次：展示层的 fetching 直接读 inFlight，只在落定时通知的话
      // 「更新中」永远看不到（倒计时归零后界面会停在 00:00 直到请求结束）。
      // 放到 inFlight 写入之后，订阅者读到的状态才是「在途」；并发等待者不会走到这里，不会重复通知。
      this.bump()
      return promise
    }

    // 第二轮仍在等另一凭据的在途请求：本轮不再接续，交给下一次排程/心跳。
    return this.entries.get(pid)?.data !== undefined
  }
}

// 进程内单例（跨 render 持久，与重构前模块级 Map 语义一致；deps 仅首次创建时生效）
let singleton: QuotaStore | undefined
export function getQuotaStore(deps: QuotaDeps): QuotaStore {
  if (!singleton) singleton = new QuotaStore(deps)
  return singleton
}

// ─── 多订阅展示（纯函数，node 可测） ───
export type QuotaOrderInput = {
  current: string | undefined
  subagentPids: readonly string[]
  available: readonly string[]
}

// 顺序：当前会话 → 本会话运行中子代理在用 → 其余候选（发现顺序）。
// 当前会话供应商即使不在候选里也保留：它仍走原来的按需加载路径，不依赖凭据探测。
export function orderQuotaProviders(input: QuotaOrderInput): string[] {
  // 归一化 → 规范写法（候选里的原始 pid）；同一供应商多种写法只留第一次出现的
  const canonical = new Map<string, string>()
  for (const pid of input.available) {
    const key = normID(pid)
    if (!canonical.has(key)) canonical.set(key, pid)
  }
  const out: string[] = []
  const seen = new Set<string>()
  const push = (raw: string) => {
    const key = normID(raw)
    if (key === "" || seen.has(key)) return
    const hit = canonical.get(key)
    if (hit === undefined && raw !== input.current) return // 不在候选里，也不是当前会话 → 丢弃
    seen.add(key)
    out.push(hit ?? raw)
  }
  if (input.current) push(input.current)
  for (const pid of input.subagentPids) push(pid)
  for (const pid of input.available) push(pid)
  return out
}

// 折叠行摘要：已用最多（最紧张）的一条；并列取先出现；无百分比取首个有文本的；空 → undefined
export function representativeItem(items: readonly QuotaItem[]): QuotaItem | undefined {
  let best: QuotaItem | undefined
  for (const item of items) {
    if (typeof item.percent !== "number") continue
    if (best === undefined || item.percent > (best.percent ?? 0)) best = item
  }
  if (best !== undefined) return best
  return items.find((item) => typeof item.text === "string" && item.text.length > 0)
}

// 展开态：显式记录优先，否则只有默认行展开
export function isQuotaRowOpen(
  pid: string,
  defaultPid: string | undefined,
  state: ReadonlyMap<string, boolean>,
): boolean {
  return state.get(pid) ?? pid === defaultPid
}

// 点击组头后的新状态：取反「当前可见状态」（默认展开规则参与），返回新 Map 供信号驱动
export function toggleQuotaRowState(
  state: ReadonlyMap<string, boolean>,
  pid: string,
  defaultPid: string | undefined,
): Map<string, boolean> {
  const next = new Map(state)
  next.set(pid, !isQuotaRowOpen(pid, defaultPid, state))
  return next
}

// ─── 新鲜度（展示元信息，纯函数） ───

// 失败原因 → 短标签：只给「能不能用 / 该不该重试」的判断，
// 详细文本（已脱敏）留在 error.message 里，供应用内 console 排查。
export function quotaErrorLabel(error: { code?: string } | undefined): string | undefined {
  if (!error) return
  switch (error.code) {
    case "login_expired":
      return "凭据失效"
    case "rate_limited":
      return "限流"
    case "timeout":
      return "超时"
    case "network":
      return "网络异常"
    case "bad_response":
      return "响应异常"
    case "provider_error":
      return "查询失败"
    default:
      return "查询失败"
  }
}

export type QuotaTrailTone = "muted" | "accent" | "danger"
export type QuotaTrail = { text: string; tone: QuotaTrailTone }

// 多供应商共用一条心跳：下一次需要唤醒的绝对时刻取最早的一个；没有可排程目标 → undefined。
export function nextWakeAt(times: readonly (number | undefined)[]): number | undefined {
  let next: number | undefined
  for (const at of times) {
    if (at === undefined) continue
    if (next === undefined || at < next) next = at
  }
  return next
}

// 数据年龄/过期：唯一计算入口。快照（status）与逐秒展示（quotaStatusTrail）都走它，
// 不允许出现第二套公式，否则「刚刷新」和「已过期」会各说各话。
export function quotaAge(updatedAt: number | undefined, now: number): { ageMs: number | undefined; stale: boolean } {
  if (updatedAt === undefined) return { ageMs: undefined, stale: false }
  const ageMs = Math.max(0, now - updatedAt)
  return { ageMs, stale: ageMs > QUOTA_STALE_MS }
}

function remainingOf(at: number | undefined, now: number): number | undefined {
  return at === undefined ? undefined : at - now
}

// 组头右端的状态注记（摘要文本由 UI 自己拼在后面）。展开态永远有内容，它就是 HUD 的心跳：
//   更新中 → 失败原因 + 真实重试倒计时 → 缓存过期 → 下次刷新倒计时 → 数据年龄（兜底）
// 折叠行只给异常前缀：后台刷新是常态，为倒计时挤掉摘要/重置时间不划算。
// now 来自共享秒级时钟：年龄与过期都按 updatedAt 现算，不吃构建行时的快照。
export function quotaStatusTrail(
  status: QuotaStatus,
  open: boolean,
  now: number = Date.now(),
): QuotaTrail | undefined {
  const { ageMs, stale } = quotaAge(status.updatedAt, now)
  if (!open) {
    if (status.error) return { text: "失败", tone: "danger" }
    if (stale) return { text: "旧", tone: "accent" }
    return undefined
  }
  if (status.fetching) return { text: "↻ 更新中", tone: "accent" }
  if (status.error) {
    const label = quotaErrorLabel(status.error) ?? "查询失败"
    // 「查询失败」没有额外信息量，换成「重试」更贴切；凭据失效/限流这类具体原因原样保留
    const prefix = label === "查询失败" ? "重试" : label
    const countdown = fmtCountdown(remainingOf(status.nextRefreshAt, now))
    if (countdown) return { text: `${prefix} ${countdown}`, tone: "danger" }
    const age = fmtAge(ageMs)
    return { text: age ? `${label} ${age}` : label, tone: "danger" }
  }
  if (stale) {
    const age = fmtAge(ageMs)
    return { text: age ? `旧 ${age}` : "旧", tone: "accent" }
  }
  // 无法确定下次刷新（没凭据/端点未注册）时只说实际年龄，不伪造 05:00
  const countdown = fmtCountdown(remainingOf(status.nextRefreshAt, now))
  if (countdown) return { text: `↻ ${countdown}`, tone: "muted" }
  const age = fmtAge(ageMs)
  return age ? { text: age, tone: "muted" } : undefined
}
