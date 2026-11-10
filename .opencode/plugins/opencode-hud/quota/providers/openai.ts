// ─── OpenAI（ChatGPT 订阅）额度查询：quota/providers/openai.ts ───
// 数据源（非公开接口，Codex 客户端 `/status` 读的就是它；2026-11-10 本机实测 200）：
//   GET https://chatgpt.com/backend-api/wham/usage
// 凭据：只认 Codex 登录（credential.methodID = chatgpt-browser / chatgpt-headless）。
//       token-sharing（Sign in with ChatGPT）的 token 调该端点必然 401
//       `rejected_by_access_enforcement / no_matching_rule`——它只授权 api.openai.com。
// 请求头：Authorization: Bearer <access>；chatgpt-account-id 可选（带了才回填 account_id）。
// 响应：rate_limit.primary_window / secondary_window = { used_percent, limit_window_seconds, reset_at(秒) }
//       + spend_control.individual_limit = { remaining_percent, reset_at }（有月度额度时才有，Plus 实测为 null）
import type { QuotaData, QuotaItem } from "../../model/types.ts"
import { fmtResetHint } from "../../shared/format.ts"
import { requestJson } from "../../shared/http.ts"
import type { ProviderRegistration } from "../registry.ts"

export const OPENAI_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage"

const QUOTA_USER_AGENT = "opencode-hud"

// 窗口时长 → 标签；响应只给秒数，窗口语义（5h/周/月）由本文件决定
const FIVE_HOURS = 5 * 60 * 60
const WEEK = 7 * 24 * 60 * 60
const MONTH = 30 * 24 * 60 * 60
const MONTH_LONG = 31 * 24 * 60 * 60

// 响应结构（仅取用字段）。reset 有两个字段：reset_at（绝对秒，实测有）
// 与 reset_after_seconds（相对秒，旧实现用），两个都容错。
type UsageWindow = {
  used_percent?: number
  limit_window_seconds?: number
  reset_at?: number
  reset_after_seconds?: number
}
type IndividualLimit = { remaining_percent?: number; reset_at?: number; reset_after_seconds?: number }
type UsageResp = {
  plan_type?: string
  rate_limit?: { primary_window?: UsageWindow; secondary_window?: UsageWindow }
  spend_control?: { individual_limit?: IndividualLimit | null }
}

// 重置时间：绝对秒优先，相对秒用它加当前时刻
function resetHint(w: { reset_at?: number; reset_after_seconds?: number } | undefined): string | undefined {
  const absolute = typeof w?.reset_at === "number" && Number.isFinite(w.reset_at) ? w.reset_at : undefined
  const relative = typeof w?.reset_after_seconds === "number" && Number.isFinite(w.reset_after_seconds) ? w.reset_after_seconds : undefined
  const epoch = absolute ?? (relative === undefined ? undefined : Date.now() / 1000 + relative)
  return epoch === undefined ? undefined : fmtResetHint(new Date(epoch * 1000).toISOString())
}

// 契约：percent 为 0-100 有限数字；上游可能越界，这里 clamp
function clampPct(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return
  return Math.max(0, Math.min(100, value))
}

function windowLabel(seconds: number | undefined, fallback: string): string {
  if (seconds === FIVE_HOURS) return "5h"
  if (seconds === WEEK) return "周"
  if (seconds === MONTH || seconds === MONTH_LONG) return "月"
  return fallback
}

// 纯转换（离线可测）：rate_limit 两窗口 + 月度额度 → 条目列表（标签与顺序在此定义）
export function mapOpenai(resp: UsageResp | undefined): QuotaData | undefined {
  const items: QuotaItem[] = []
  const addWindow = (w: UsageWindow | undefined, fallback: string) => {
    const percent = clampPct(w?.used_percent)
    if (percent === undefined) return
    items.push({ label: windowLabel(w?.limit_window_seconds, fallback), percent, hint: resetHint(w) })
  }
  addWindow(resp?.rate_limit?.primary_window, "5h")
  addWindow(resp?.rate_limit?.secondary_window, "周")

  // 月额度给的是剩余百分比，契约用已用百分比 → 100 − remaining
  const monthly = resp?.spend_control?.individual_limit
  const remaining = clampPct(monthly?.remaining_percent)
  if (remaining !== undefined) {
    items.push({ label: "月", percent: 100 - remaining, hint: resetHint(monthly) })
  }
  return items.length > 0 ? { items } : undefined
}

// ChatGPT 后端要的账户头。Codex 登录的 token 把它放在嵌套 auth claim 里
// （`https://api.openai.com/auth`.chatgpt_account_id），顶层写法一并兼容。
export function accountIDFromToken(token: string): string | undefined {
  const part = token.split(".")[1]
  if (!part) return
  try {
    const claims = JSON.parse(Buffer.from(part, "base64url").toString()) as {
      chatgpt_account_id?: unknown
      "https://api.openai.com/auth"?: { chatgpt_account_id?: unknown }
    }
    const nested = claims["https://api.openai.com/auth"]?.chatgpt_account_id
    const value = typeof nested === "string" ? nested : claims.chatgpt_account_id
    return typeof value === "string" && value.length > 0 ? value : undefined
  } catch {
    return
  }
}

export async function fetchOpenai(apiUrl: string, key: string): Promise<QuotaData | undefined> {
  const accountID = accountIDFromToken(key)
  const json = await requestJson(apiUrl, {
    headers: {
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
      "User-Agent": QUOTA_USER_AGENT,
      ...(accountID ? { "chatgpt-account-id": accountID } : {}),
    },
    secrets: [key],
  })
  return mapOpenai(json as UsageResp | undefined)
}

export const provider: ProviderRegistration = {
  id: "openai",
  apiUrl: OPENAI_USAGE_URL,
  render: "bars",
  fetch: fetchOpenai,
}
