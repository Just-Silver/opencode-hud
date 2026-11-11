// ─── 模型层：额度查询状态机（凭据分桶 + 刷新/退避 + 并发去重 + 写库订阅通知，依赖注入可单测） ───
import { createHash } from "node:crypto"
import { QuotaRequestError, redactSecrets, type QuotaErrorCode } from "../shared/http.ts"
import type { QuotaData } from "./types.ts"

// 网络刷新最小间隔：额度接口按次计费/限流，60s 强刷不划算。
export const QUOTA_REFRESH_MS = 5 * 60_000
// UI 侧检查心跳：每分钟看一次凭据与退避，真正是否发请求由上面的间隔决定。
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

// 查询服务依赖（生产由入口注入真实实现，测试注入 mock）
export interface QuotaDeps {
  apiUrlFor(pid: string): string | undefined
  resolveKey(pid: string): Promise<string | undefined>
  fetch(pid: string, apiUrl: string, key: string): Promise<QuotaData | undefined>
  log(level: "warn" | "error", message: string): void
  /** 可注入时钟，供退避/间隔测试；生产用 Date.now。 */
  now?(): number
}

type Entry = {
  /** 凭据指纹：key 变了就是另一个账号，旧行不能继续展示。 */
  fingerprint: string
  data?: QuotaData
  /** 上次尝试结束的时刻；没有表示这个凭据还没请求过。 */
  at?: number
  failures: number
  retryAt?: number
  error?: QuotaErrorState
}

function fingerprintOf(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 16)
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
  private inFlight = new Map<string, Promise<boolean>>()
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

  // 订阅数据变更（仅在缓存真正变化时通知）；返回退订函数（组件 onCleanup 调用）
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  // 取（或切换）当前凭据对应的桶。指纹变了 = 换了账号：旧数据立刻作废并清空退避，
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

    // 先解析凭据再判断间隔：否则旧凭据的退避会挡住新凭据的第一次尝试。
    let key: string | undefined
    try {
      key = await this.deps.resolveKey(pid)
    } catch {
      key = undefined
    }
    const fingerprint = key ? fingerprintOf(key) : ""
    const entry = this.adopt(pid, fingerprint)
    if (!key) {
      // 没凭据是常态（没登录 / 未连接），日志按刷新间隔节流，避免心跳每分钟刷一条
      const now = this.now()
      const waitMs = entry.failures > 0 ? backoffMs(entry.failures) : QUOTA_REFRESH_MS
      const due = entry.at === undefined || now - entry.at >= waitMs
      entry.at = now
      if (due) this.deps.log("warn", `quota ${pid} missing key`)
      return false
    }

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

    if (this.inFlight.has(pid)) {
      await this.inFlight.get(pid)
      return this.entries.get(pid)?.data !== undefined // 并发等待完成后：缓存可能已被写入
    }

    const p = (async (): Promise<boolean> => {
      try {
        const usage = await this.deps.fetch(pid, apiUrl, key)
        const current = this.entries.get(pid)
        // 请求期间切了凭据：这是旧账号的结果，丢弃，不覆盖新桶。
        if (!current || current.fingerprint !== fingerprint) return false
        if (usage) {
          this.entries.set(pid, { fingerprint, data: usage, at: this.now(), failures: 0 })
          this.bump() // 写库即通知订阅者（当前组件刷新，跨组件重建安全）
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
          at: this.now(),
          failures: current.failures + 1,
          ...(error.retryAt === undefined ? {} : { retryAt: error.retryAt }),
          error,
        })
        this.deps.log("error", `quota ${pid} fetch failed: ${error.message}`)
        return false
      }
    })().finally(() => this.inFlight.delete(pid))
    this.inFlight.set(pid, p)
    return p
  }
}

// 进程内单例（跨 render 持久，与重构前模块级 Map 语义一致；deps 仅首次创建时生效）
let singleton: QuotaStore | undefined
export function getQuotaStore(deps: QuotaDeps): QuotaStore {
  if (!singleton) singleton = new QuotaStore(deps)
  return singleton
}
