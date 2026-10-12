// ─── 凭据解析（共享模块）：key.ts ──────────────────────
// 全仓库唯一的 API Key 解析实现，供插件入口与未来多个查询脚本复用。
// 来源优先级：keyCache → 项目配置（近→远，同目录 .opencode/ 优先）
//             → 全局配置（XDG_CONFIG_HOME 或 ~/.config）→ DB credential 表（兜底）
// 脱敏约束：本模块不记任何日志，错误信息不得包含 key；
//           key 仅存于内存 keyCache 与调用方请求头，不落盘、不上报。
// DB 兜底覆盖两种登录形态（判别依据 = 官方 Credential.Value 的 type 字段，packages/schema/src/credential.ts）：
//   type:"key"   → API key 连接（/connect 粘贴 key），凭据归 provider 自己（官方 keyProvider = provider）；
//   type:"oauth" → Console 登录（auth login device flow），凭据归 Console 集成 "opencode"
//                  （官方 consoleIntegration()：opencode / opencode-go 共用同一次登录）；
//   type:"external" 等 → 凭据由外部托管，本模块不处理。
// 插件只读现值、不做 refresh / expires 处理（token 过期由 opencode 自身刷新写回 DB）。
import { readFileSync } from "fs"
import { homedir } from "os"
import { dirname, join, resolve } from "path"
import { parseJson } from "../shared/jsonc.ts"
import { normID } from "../shared/id.ts"

const OPENCODE_DATA_DIR_NAME = "opencode" // opencode 数据目录名
const OPENCODE_DATA_DIR_REL = [".local", "share", "opencode"] // ~ 下相对路径
const OPENCODE_DB_FILE = "opencode.db"
const CREDENTIAL_SQL = "SELECT value FROM credential WHERE integration_id = ?"

// Console 集成（对齐官方 packages/app/src/providers/connect/controller.ts）：
// opencode / opencode-go 均通过 OpenCode Console 登录，OAuth 凭据统一写入 integration_id = "opencode"。
const CONSOLE_INTEGRATION_ID = "opencode"
const CONSOLE_PROVIDER_NORMS = new Set(["opencode", "opencodego"]) // normID 归一化写法（兼容 opencode_go 等）

const keyCache = new Map<string, string>()

// {env:VAR} 占位符 → 环境变量；普通字符串原文；占位符替换不到返回 undefined
function resolveEnvPlaceholder(value: string): string | undefined {
  const m = /^\{env:([^}]+)\}$/.exec(value.trim())
  if (!m) return value
  const v = process.env[m[1]]
  return typeof v === "string" && v.length > 0 ? v : undefined
}

// 配置文件候选，按优先级排列：项目（近→远，.opencode/ 优先）→ 全局
function configCandidates(cwd: string): string[] {
  const out: string[] = []
  let dir = resolve(cwd)
  // eslint-disable-next-line no-constant-condition
  while (true) {
    for (const p of [
      ".opencode/opencode.json",
      ".opencode/opencode.jsonc",
      "opencode.json",
      "opencode.jsonc",
    ]) {
      out.push(join(dir, p))
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  const xdg = process.env.XDG_CONFIG_HOME?.trim()
  const base = xdg ? xdg : join(homedir(), ".config")
  out.push(join(base, "opencode", "opencode.json"))
  out.push(join(base, "opencode", "opencode.jsonc"))
  return out
}

// 从一份配置里提取 pid 的 apiKey：V2 providers[pid].settings.apiKey → V1 provider[pid].options.apiKey
function pickApiKey(cfg: unknown, pid: string): string | undefined {
  if (typeof cfg !== "object" || cfg === null) return undefined
  const root = cfg as Record<string, unknown>
  const v2 = (root.providers as Record<string, unknown> | undefined)?.[pid]
  if (v2 && typeof v2 === "object") {
    const s = (v2 as Record<string, unknown>).settings as Record<string, unknown> | undefined
    if (s && typeof s.apiKey === "string") return resolveEnvPlaceholder(s.apiKey)
  }
  const v1 = (root.provider as Record<string, unknown> | undefined)?.[pid]
  if (v1 && typeof v1 === "object") {
    const o = (v1 as Record<string, unknown>).options as Record<string, unknown> | undefined
    if (o && typeof o.apiKey === "string") return resolveEnvPlaceholder(o.apiKey)
  }
  return undefined
}

// 仅从配置文件提取（同步；opts.cwd 指定查找根，默认进程 cwd）
export function resolveApiKeyFromConfig(
  providerID: string,
  opts?: { cwd?: string },
): string | undefined {
  if (!providerID) return undefined
  for (const file of configCandidates(opts?.cwd ?? process.cwd())) {
    let text: string
    try {
      text = readFileSync(file, "utf8")
    } catch {
      continue // 不存在/无权限 → 下一来源
    }
    const key = pickApiKey(parseJson(text), providerID)
    if (key) return key
  }
  return undefined
}

// DB credential 候选 integration_id，按「API key 归自己 → OAuth 归 Console」顺序：
// 官方 dialog.tsx：OAuth 登录 provider = consoleIntegration(pid)，API key keyProvider = pid。
// 纯函数（node 可测）：非 Console 供应商原样返回；已是 Console id 不重复追加。
export function credentialIntegrationIDs(providerID: string): string[] {
  const ids = [providerID]
  if (providerID !== CONSOLE_INTEGRATION_ID && CONSOLE_PROVIDER_NORMS.has(normID(providerID))) {
    ids.push(CONSOLE_INTEGRATION_ID)
  }
  return ids
}

// 凭据取值：按官方 Credential.Value 的 type 判别（key → key；oauth → access；其余不处理）。
// 纯函数（node 可测）：本模块只读现值，不碰 refresh / expires。
export function pickCredentialToken(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const v = value as Record<string, unknown>
  switch (v.type) {
    case "key":
      return typeof v.key === "string" ? v.key : undefined
    case "oauth":
      return typeof v.access === "string" ? v.access : undefined
    default:
      return undefined
  }
}

// DB credential 表（对应 opencode 登录/连接写入的凭据），作为配置之后的兜底。
// 遍历候选 integration_id（API key 归 provider 自己、OAuth 归 Console "opencode"），
// 命中第一个可取值即返回；不处理 refresh / expires（过期由 opencode 自身刷新写回）。
async function readDbKey(providerID: string): Promise<string | undefined> {
  try {
    const { Database } = await import("bun:sqlite")
    const base = process.env.XDG_DATA_HOME?.trim()
      ? join(process.env.XDG_DATA_HOME, OPENCODE_DATA_DIR_NAME)
      : join(homedir(), ...OPENCODE_DATA_DIR_REL)
    const db = new Database(join(base, OPENCODE_DB_FILE), { readonly: true })
    try {
      for (const id of credentialIntegrationIDs(providerID)) {
        const row = db.query(CREDENTIAL_SQL).get(id) as { value?: string } | undefined
        if (!row?.value) continue
        const key = pickCredentialToken(JSON.parse(row.value))
        if (key) return key
      }
      return
    } finally {
      db.close()
    }
  } catch {
    return // 静默：读取失败视为无凭据，由调用方统一记录 missing key；不暴露错误细节
  }
}

// 完整凭据解析：keyCache → 项目配置 → 全局配置 → DB credential 表
// opts.cwd 透传给配置查找（默认进程 cwd），与 resolveApiKeyFromConfig 一致
export async function resolveProviderKey(
  providerID: string,
  opts?: { cwd?: string },
): Promise<string | undefined> {
  if (!providerID) return undefined
  if (keyCache.has(providerID)) return keyCache.get(providerID)
  const key = resolveApiKeyFromConfig(providerID, opts) ?? (await readDbKey(providerID))
  if (key) keyCache.set(providerID, key)
  return key
}