// ─── 凭据解析（共享模块）：key.ts ──────────────────────
// 全仓库唯一的额度凭据解析实现：宿主有效连接优先，仅「无连接」时配置兜底；状态不明跳过。
// 宿主有效连接 = credential 表里宿主自己会选中的那一行（对齐 packages/core/src/credential.ts 的 currentActive）；
// OAuth 登录的凭据统一挂在 Console integration 下，API key 归 provider 自己的 integration。
// 有意跳过（null）：外部托管凭据、坏行、非公共/未知 Console 端点、DB 存在却读不了——
//   这些情况下拿配置或旧行顶替都会把「当前账号」伪装成另一个账号。
// 无连接、可兜底（undefined/继续兜底）：DB 不存在或 :memory:、该 integration 零行、配置也没有。
// 脱敏约束：本模块不记任何日志，错误信息不得包含 key；key 仅存于内存缓存与调用方请求头，不落盘。
import { createHash } from "crypto"
import { existsSync, readFileSync } from "fs"
import { homedir } from "os"
import { dirname, join, resolve } from "path"
import { parseJson } from "../shared/jsonc.ts"
import { normID } from "../shared/id.ts"
import { globalConfigDir } from "../shared/paths.ts"

const OPENCODE_DATA_DIR_NAME = "opencode" // opencode 数据目录名
const OPENCODE_DATA_DIR_REL = [".local", "share", "opencode"] // ~ 下相对路径
const OPENCODE_DB_FILE = "opencode.db"

// 宿主 Credential.currentActive 的等价查询：标题一行就是当前使用的连接。
// 不取全量行、不在 JS 里重排——排序语义只由宿主同一张表上的这一条 SQL 决定。
const CREDENTIAL_SQL =
  "SELECT id, value FROM credential WHERE integration_id = ? ORDER BY active DESC, time_created DESC, id DESC LIMIT 1"

// Console 集成（对齐官方 consoleIntegration）：opencode / opencode-go 均通过 OpenCode Console 登录，
// 它们的 OAuth 凭据写入 integration_id = "opencode"，未拿到宿主映射时不能按 providerID 去猜旧账号。
const CONSOLE_PROVIDER_NORMS = new Set(["opencode", "opencodego"]) // normID 归一化写法（兼容 opencode_go 等）
const CONSOLE_DEFAULT_SERVER = "https://opencode.ai/console"
// 宿主把 2026-08 前保存的退役主机按同一路径映射到默认主机（packages/core/src/console-access.ts）。
const CONSOLE_LEGACY_SERVER = /^https:\/\/console\.opencode\.ai(?=\/|$)/

export type QuotaCredential = { key: string; identity: string }

// 缓存 60s：插件内轮询会频繁解析凭据，但切号/换 key 后要让 store 在一个心跳内发现身份变化。
// 键必须带上配置作用域：同一供应商在不同项目 / 全局根 / DB 来源下可能是不同账号。
const CREDENTIAL_CACHE_TTL_MS = 60_000
const credentialCache = new Map<string, { credential: QuotaCredential; at: number }>()

function digest16(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16)
}

function cacheScope(cwd: string): string {
  return [resolve(cwd), resolve(globalConfigDir()), databaseFile() ?? ":memory:"].join("\u0000")
}

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
  out.push(join(globalConfigDir(), "opencode.json"))
  out.push(join(globalConfigDir(), "opencode.jsonc"))
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

// 凭据行值 → token。只认宿主当前两种可直读形态：key → key，oauth → access；
// external 由外部托管、缺字段或坏 JSON 都不产出 token（调用方据此整体跳过，不回退旧行）。
export function decodeCredentialRow(
  value: unknown,
): { token: string; value: Record<string, unknown> } | undefined {
  if (typeof value !== "string") return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return undefined
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined
  const record = parsed as Record<string, unknown>
  // 空字符串与缺字段同口径：空 Bearer 必然失败，还会把「没有可用凭据」伪装成有连接。
  if (record.type === "key") {
    return typeof record.key === "string" && record.key.length > 0
      ? { token: record.key, value: record }
      : undefined
  }
  if (record.type === "oauth") {
    return typeof record.access === "string" && record.access.length > 0
      ? { token: record.access, value: record }
      : undefined
  }
  return undefined
}

// 去掉尾部 /、按宿主规则改写退役主机、再交给 URL 解析规范化。
// 解析失败（含非 URL 字符串）返回 undefined，供调用方区分「不确定」与「明确非公共」。
function normalizeConsoleServer(server: string): string | undefined {
  const rewritten = server.replace(/\/+$/, "").replace(CONSOLE_LEGACY_SERVER, CONSOLE_DEFAULT_SERVER)
  try {
    const url = new URL(rewritten)
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}${url.search}${url.hash}`
  } catch {
    return undefined
  }
}

export function isPublicConsoleServer(server: string): boolean {
  return normalizeConsoleServer(server) === CONSOLE_DEFAULT_SERVER
}

// 只对 Console 供应商调用。metadata 缺失/无 server 是宿主明确的默认公共；
// server 存在但不是字符串（企业部署可能写了结构化配置）无法确认归属，判 invalid 跳过，
// 绝不能回落公共默认——否则企业 token 会被发到 opencode.ai。
export function consoleServerStateOf(value: unknown): "public" | "non-public" | "invalid" {
  if (typeof value !== "object" || value === null) return "public"
  const metadata = (value as Record<string, unknown>).metadata
  if (typeof metadata !== "object" || metadata === null) return "public"
  const server = (metadata as Record<string, unknown>).server
  if (server === undefined) return "public"
  if (typeof server !== "string") return "invalid"
  const normalized = normalizeConsoleServer(server)
  if (normalized === undefined) return "invalid"
  return normalized === CONSOLE_DEFAULT_SERVER ? "public" : "non-public"
}

// 宿主数据目录（packages/util/src/global-roots.ts 的 XDG_DATA_HOME 规则）
function opencodeDataDir(): string {
  const xdg = process.env.XDG_DATA_HOME?.trim()
  return xdg ? join(xdg, OPENCODE_DATA_DIR_NAME) : join(homedir(), ...OPENCODE_DATA_DIR_REL)
}

// 宿主 database-path.ts：OPENCODE_DB 绝对路径原样、相对文件名相对 dataDir；
// :memory: 是宿主进程内的库，外部只读连接看不到同一实例，必须视为无 DB 凭据且不落盘。
function databaseFile(): string | undefined {
  const explicit = process.env.OPENCODE_DB
  const name = explicit === undefined || explicit.length === 0 ? OPENCODE_DB_FILE : explicit
  if (name === ":memory:") return undefined
  return resolve(opencodeDataDir(), name)
}

// providerID → 要查的 integration_id。宿主映射缺失时按 providerID 查；
// Console 供应商没有映射 = provider 尚未同步，此时既不能查库也不能读配置（猜不到账号）。
function integrationIDFor(providerID: string, opts?: { integrationID?: string }): string | null {
  if (opts?.integrationID) return opts.integrationID
  // 调用方必须传宿主 provider 的 `integrationID ?? provider.id`；漏传会让「未就绪」判定长期成立。
  if (CONSOLE_PROVIDER_NORMS.has(normID(providerID))) return null
  return providerID
}

type DbLookup =
  | { kind: "row"; id: string; value: unknown }
  | { kind: "none" }
  | { kind: "failure" }

// DB 读取三态：命中一行 / 该 integration 零行（可兜底）/ 读不了（状态不明，整体跳过）。
// 失败原因不进日志也不进错误文本：调用方只需要知道「不能确定账号」。
async function lookupStoredCredential(file: string, integrationID: string): Promise<DbLookup> {
  try {
    const { Database } = await import("bun:sqlite")
    const db = new Database(file, { readonly: true })
    try {
      const row = db.query(CREDENTIAL_SQL).get(integrationID) as
        | { id?: unknown; value?: unknown }
        | undefined
      if (!row) return { kind: "none" }
      // id 是宿主主键；拿不到就无法构造稳定身份，只能当状态不明
      if (typeof row.id !== "string") return { kind: "failure" }
      return { kind: "row", id: row.id, value: row.value }
    } finally {
      try {
        db.close()
      } catch {
        // 关闭失败不改变已经读到的结果
      }
    }
  } catch {
    return { kind: "failure" }
  }
}

function configCredential(providerID: string, cwd: string): QuotaCredential | undefined {
  const key = resolveApiKeyFromConfig(providerID, { cwd })
  if (!key) return undefined
  return {
    key,
    identity: `config:${digest16([resolve(cwd), resolve(globalConfigDir())].join("\u0000"))}:${digest16(key)}`,
  }
}

async function resolveCredentialSource(
  providerID: string,
  integrationID: string,
  cwd: string,
): Promise<QuotaCredential | null | undefined> {
  const file = databaseFile()
  if (!file || !existsSync(file)) return configCredential(providerID, cwd)

  const lookup = await lookupStoredCredential(file, integrationID)
  if (lookup.kind === "failure") return null
  if (lookup.kind === "none") return configCredential(providerID, cwd)

  const decoded = decodeCredentialRow(lookup.value)
  if (!decoded) return null

  if (CONSOLE_PROVIDER_NORMS.has(normID(providerID)) && consoleServerStateOf(decoded.value) !== "public") {
    return null
  }

  const scope = digest16(file)
  const identity =
    decoded.value.type === "oauth"
      ? `credential:${scope}:${integrationID}:${lookup.id}:oauth`
      : `credential:${scope}:${integrationID}:${lookup.id}:key:${digest16(decoded.token)}`
  return { key: decoded.token, identity }
}

// 宿主有效连接优先；无连接时才看配置。null = 有意跳过，undefined = 没有任何来源。
export async function resolveProviderCredential(
  providerID: string,
  opts?: { cwd?: string; integrationID?: string },
): Promise<QuotaCredential | null | undefined> {
  if (!providerID) return undefined
  const integrationID = integrationIDFor(providerID, opts)
  if (integrationID === null) return null
  const cwd = opts?.cwd ?? process.cwd()
  const cacheKey = [providerID, integrationID, cacheScope(cwd)].join("\u0000")
  const cached = credentialCache.get(cacheKey)
  if (cached && Date.now() - cached.at < CREDENTIAL_CACHE_TTL_MS) return cached.credential

  const credential = await resolveCredentialSource(providerID, integrationID, cwd)
  if (credential) credentialCache.set(cacheKey, { credential, at: Date.now() })
  return credential
}
