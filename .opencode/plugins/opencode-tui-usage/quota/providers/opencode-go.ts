// ─── OpenCode Go 额度查询：quota/providers/opencode-go.ts ───
// 自动发现：导出 provider 即视为一个供应商查询（index.ts 运行时 fs 扫描 + 动态 import 收集，无 glob）。
// 端点自持：本供应商专属 URL 定义在此文件（通用 registry 层不含任何供应商细节）。
import type { QuotaData } from "../../model/types.ts"
import type { ProviderRegistration } from "../registry.ts"

export const QUOTA_API_URL = "https://opencode.ai/zen/go/v1/usage"

const QUOTA_USER_AGENT = "opencode-tui-usage"

export async function fetchOpencodeGo(apiUrl: string, key: string): Promise<QuotaData | undefined> {
  const res = await fetch(apiUrl, {
    headers: { Authorization: `Bearer ${key}`, "User-Agent": QUOTA_USER_AGENT },
  })
  if (!res.ok) {
    throw new Error(`quota ${res.status} ${res.statusText}`)
  }
  let json: { usage?: QuotaData }
  try {
    json = (await res.json()) as { usage?: QuotaData }
  } catch (e) {
    throw new Error(`quota json parse failed: ${String(e)}`)
  }
  return json.usage
}

export const provider: ProviderRegistration = {
  id: "opencode-go",
  apiUrl: QUOTA_API_URL,
  fetch: fetchOpencodeGo,
}