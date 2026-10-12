// ─── OpenCode Go 额度查询：quota/providers/opencode-go.ts ───
// 自动发现：导出 provider 即视为一个供应商查询（index.ts 运行时 fs 扫描 + 动态 import 收集，无 glob）。
// 端点自持：本供应商专属 URL 定义在此文件（通用 registry 层不含任何供应商细节）。
import type { QuotaData, QuotaItem } from "../../model/types.ts"
import { fmtResetHint } from "../../shared/format.ts"
import type { ProviderRegistration } from "../registry.ts"

export const QUOTA_API_URL = "https://opencode.ai/zen/go/v1/usage"

const QUOTA_USER_AGENT = "opencode-tui-usage"

// API 窗口结构（仅取用字段；窗口语义与标签由本文件决定，契约层不认识它们）
type UsageWindow = { status?: string; percent?: number; resetsAt?: string }
type UsageResp = { usage?: { rolling?: UsageWindow; weekly?: UsageWindow; monthly?: UsageWindow } }

// 纯转换（离线可测）：API 三窗口 → 条目列表。
// 标签与顺序在此定义；重置时间（resetsAt）经 fmtResetHint 转成 "↻ 周一" 放进 hint（契约无语义字段）。
export function mapOpencodeGo(resp: UsageResp | undefined): QuotaData | undefined {
  const items: QuotaItem[] = []
  const add = (label: string, w: UsageWindow | undefined) => {
    if (!w || typeof w.percent !== "number") return
    items.push({ label, percent: w.percent, hint: fmtResetHint(w.resetsAt) })
  }
  add("5h", resp?.usage?.rolling)
  add("周", resp?.usage?.weekly)
  add("月", resp?.usage?.monthly)
  return items.length > 0 ? { items } : undefined
}

export async function fetchOpencodeGo(apiUrl: string, key: string): Promise<QuotaData | undefined> {
  const res = await fetch(apiUrl, {
    headers: { Authorization: `Bearer ${key}`, "User-Agent": QUOTA_USER_AGENT },
  })
  if (!res.ok) {
    throw new Error(`quota ${res.status} ${res.statusText}`)
  }
  let json: UsageResp
  try {
    json = (await res.json()) as UsageResp
  } catch (e) {
    throw new Error(`quota json parse failed: ${String(e)}`)
  }
  return mapOpencodeGo(json)
}

export const provider: ProviderRegistration = {
  id: "opencode-go",
  apiUrl: QUOTA_API_URL,
  render: "bars",
  fetch: fetchOpencodeGo,
}
