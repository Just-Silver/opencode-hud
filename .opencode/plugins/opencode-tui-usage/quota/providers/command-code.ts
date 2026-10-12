// ─── Command Code 额度查询：quota/providers/command-code.ts ───
// 数据源（已实测，Bearer 鉴权）：
//   1. /alpha/billing/credits        → 5h/7d 窗口（{used,cap,resetAt}）+ 月度余额（monthlyCredits）
//   2. /alpha/billing/subscriptions  → planId → 套餐映射表推月度上限（API 只给余额不给上限）
// 状态：**已启用**（离线测试与真实数据实测通过）
// 脱敏：本模块不记日志；key 仅用于 Authorization 请求头。
import type { QuotaData, QuotaItem } from "../../model/types.ts"
import type { ProviderRegistration } from "../registry.ts"

export const COMMANDCODE_CREDITS_URL = "https://api.commandcode.ai/alpha/billing/credits"
export const COMMANDCODE_SUBSCRIPTIONS_URL = "https://api.commandcode.ai/alpha/billing/subscriptions"

// planId → 月度额度（来源：cc-switch-commandcode-usage README_CN 套餐表；新套餐需追加）
const PLAN_CREDITS: Record<string, number> = {
  "individual-goat": 70,
  "individual-pro": 30,
  "individual-pro-v1": 80,
  "individual-provider": 15,
  "individual-max": 150,
  "individual-ultra": 300,
  "teams-pro": 40,
}

// 响应结构（仅取用字段）
type CreditsResp = {
  credits?: { monthlyCredits?: number }
  windowLimits?: {
    fiveHour?: { used?: number; cap?: number } | null
    weekly?: { used?: number; cap?: number } | null
  }
}
type SubscriptionsResp = { data?: { planId?: string } | null }

// 窗口百分比：used/cap × 100，保留一位小数（供应商自己决定精度），clamp [0,100]；缺失/非法 → undefined
// 契约：percent 为 0-100 有限数字，UI 层 fmtPctInt 原样透传显示，供应商决定小数位数
function windowPct(w: { used?: number; cap?: number } | null | undefined): number | undefined {
  if (!w || typeof w.used !== "number" || typeof w.cap !== "number" || w.cap <= 0) return
  return Math.max(0, Math.min(100, Math.round((w.used / w.cap) * 1000) / 10))
}

// 纯转换函数（离线可测）：credits + subscriptions 响应 → 条目列表（标签与顺序在此定义）
// 降级策略：subscriptions 失败 / data=null / planId 未知 → 仅月条目缺失，5h/周照常
export function mapCommandCode(creditsResp: unknown, subResp: unknown): QuotaData | undefined {
  const c = (creditsResp ?? {}) as CreditsResp
  const s = (subResp ?? {}) as SubscriptionsResp
  const items: QuotaItem[] = []

  const rolling = windowPct(c.windowLimits?.fiveHour)
  if (rolling !== undefined) items.push({ label: "5h", percent: rolling })

  const weekly = windowPct(c.windowLimits?.weekly)
  if (weekly !== undefined) items.push({ label: "周", percent: weekly })

  // 月度：cap = PLAN_CREDITS[planId]；已用 = cap − 余额；余额异常（>cap）不显示
  const cap = s.data?.planId ? PLAN_CREDITS[s.data.planId] : undefined
  const balance = typeof c.credits?.monthlyCredits === "number" ? c.credits.monthlyCredits : undefined
  if (cap !== undefined && cap > 0 && balance !== undefined && balance <= cap) {
    const used = cap - balance
    items.push({
      label: "月",
      percent: Math.max(0, Math.min(100, Math.round((used / cap) * 1000) / 10)),
    })
  }

  return items.length > 0 ? { items } : undefined
}

// 主入口（兼容 fetchers 分发签名）：apiUrl = credits 端点（由 getProviderApiUrl 提供）
// credits 失败 → throw（沿用入口错误日志）；subscriptions 失败 → 降级不 throw
export async function fetchCommandCode(apiUrl: string, key: string): Promise<QuotaData | undefined> {
  const headers = { Authorization: `Bearer ${key}` }
  const creditsRes = await fetch(apiUrl, { headers })
  if (!creditsRes.ok) {
    throw new Error(`quota ${creditsRes.status} ${creditsRes.statusText}`)
  }
  const credits: unknown = await creditsRes.json()
  let sub: unknown
  try {
    const subRes = await fetch(COMMANDCODE_SUBSCRIPTIONS_URL, { headers })
    if (!subRes.ok) {
      throw new Error(`quota ${subRes.status} ${subRes.statusText}`)
    }
    sub = await subRes.json()
  } catch {
    sub = undefined // 降级：仅月窗口缺失
  }
  return mapCommandCode(credits, sub)
}

// 自动发现注册
export const provider: ProviderRegistration = {
  id: "command-code",
  apiUrl: COMMANDCODE_CREDITS_URL,
  render: "bars",
  fetch: fetchCommandCode,
  enabled: true,
}