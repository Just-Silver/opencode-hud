// ─── 模型层：额度查询状态机（分桶缓存 + 限流 + 并发去重 + 写库订阅通知，依赖注入可单测） ───
import type { QuotaData } from "./types.ts"

export const QUOTA_REFRESH_MS = 60_000 // 配额轮询间隔

// 查询服务依赖（生产由入口注入真实实现，测试注入 mock）
export interface QuotaDeps {
  apiUrlFor(pid: string): string | undefined
  resolveKey(pid: string): Promise<string | undefined>
  fetch(pid: string, apiUrl: string, key: string): Promise<QuotaData | undefined>
  log(level: "warn" | "error", message: string): void
}

export class QuotaStore {
  private cache = new Map<string, QuotaData>() // 字典：providerID -> QuotaData
  private at = new Map<string, number>() // 字典：providerID -> 上次刷新时间戳
  private inFlight = new Map<string, Promise<void>>() // 去重：同 provider 并发只发一次
  private version = 0 // 数据版本号（每次写库递增）
  private listeners = new Set<() => void>() // 写库通知订阅者（组件订阅当前实例）
  private deps: QuotaDeps

  constructor(deps: QuotaDeps) {
    this.deps = deps
  }

  // 订阅数据变更（仅在真正写入 cache 时通知）；返回退订函数（组件 onCleanup 调用）
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  private bump() {
    this.version++
    for (const fn of [...this.listeners]) fn()
  }

  // 当前缓存值（未加载过返回 undefined）
  get(pid: string): QuotaData | undefined {
    return this.cache.get(pid)
  }

  // 按需加载：默认 60s 限流（opts.force 跳过，供定时轮询使用）；并发去重。
  // 返回 true = 当前有该 pid 缓存（新写入或等待并发完成后已有）。
  async load(pid: string, opts?: { force?: boolean }): Promise<boolean> {
    const now = Date.now()
    if (!opts?.force && now - (this.at.get(pid) ?? 0) < QUOTA_REFRESH_MS) return false
    if (this.inFlight.has(pid)) {
      await this.inFlight.get(pid)
      return this.cache.has(pid) // 并发等待完成后：缓存可能已被写入
    }
    const p = (async (): Promise<boolean> => {
      const apiUrl = this.deps.apiUrlFor(pid)
      if (!apiUrl) {
        this.at.set(pid, now)
        this.deps.log("warn", `quota ${pid} missing api url`)
        return false
      }
      const key = await this.deps.resolveKey(pid)
      if (!key) {
        this.at.set(pid, now)
        this.deps.log("warn", `quota ${pid} missing key`)
        return false
      }
      try {
        const usage = await this.deps.fetch(pid, apiUrl, key)
        if (usage) {
          this.cache.set(pid, usage)
          this.at.set(pid, now)
          this.bump() // 写库即通知订阅者（当前组件刷新，跨组件重建安全）
          return true
        }
        this.at.set(pid, now)
        this.deps.log("warn", `quota ${pid} empty response`)
        return false
      } catch (e) {
        this.at.set(pid, now)
        this.deps.log("error", `quota ${pid} fetch failed: ${String(e)}`)
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