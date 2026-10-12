// ─── 查询服务层：供应商注册表纯逻辑（node 可测） ───
// createRegistry(providers) 由注册清单推导白名单/端点/fetcher 三件事；
// index.ts 运行时 fs 扫描 + 动态 import 发现 providers/*.ts 后调用本模块（全链无 import.meta.glob）。
// 本层不含任何供应商细节（端点 URL 由 providers/<name>.ts 自持）；
// 未注册 / 未启用的 pid 一律视为未命中，一律返回 undefined（无兜底，避免静默指向错误端点）。
import type { QuotaData } from "../model/types.ts"
import { normID } from "../shared/id.ts"

// 发现接口：providers/*.ts 导出 provider 即视为一个供应商查询
export type ProviderRegistration = {
  id: string
  apiUrl: string
  enabled?: boolean // 默认 true；false = 已实现但暂不激活（如等待真实数据验证）
  fetch: (apiUrl: string, key: string) => Promise<QuotaData | undefined>
}

export function createRegistry(providers: ProviderRegistration[]) {
  // enabled:false 的注册项跳过（已实现但未验证的供应商不进入白名单）
  const active = providers.filter((p) => p.enabled !== false)

  // 归一化命中：pid（用户任意写法）→ 对应注册项；未命中返回 undefined
  const match = (pid: string): ProviderRegistration | undefined => {
    const n = normID(pid)
    return active.find((p) => normID(p.id) === n)
  }

  // 白名单守卫：pid 是否命中已注册且启用的供应商
  const isQuotaProvider = (pid: string): boolean => match(pid) !== undefined

  // API URL 查找：未命中返回 undefined（调用方 QuotaStore 记 warn 并跳过，不做兜底指向）
  const getProviderApiUrl = (pid: string): string | undefined => match(pid)?.apiUrl

  // 按供应商分发 fetcher：未命中返回 undefined
  const fetchQuota = async (pid: string, apiUrl: string, key: string): Promise<QuotaData | undefined> => {
    const p = match(pid)
    return p ? p.fetch(apiUrl, key) : undefined
  }

  return { isQuotaProvider, getProviderApiUrl, fetchQuota }
}