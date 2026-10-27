// ─── 更新模块：更新检查（带磁盘缓存节流） ───
// 启动时查询 GitHub 最新 Release 的 tag，与本地 VERSION 对比；落后则在侧边栏提示。
//
// 两条设计原则：
//   1. 静默失败：网络失败 / 无 Release / 本地超前 → 一律不打扰（返回 undefined）。
//   2. 少联网：结果落盘（见 updateCachePath），跨进程共享，避免每次启动都打网络。
//      节流规则：
//        · 成功 TTL 24h：距上次成功不足 24h → 直接用缓存，不联网；
//        · 失败冷却 1h：距上次尝试（含失败）不足 1h → 不联网（断网时不反复重试）；
//        · 失败时保留上次成功查到的版本，只把 lastAttemptAt 推到当前时刻（开启冷却窗口）。
//
// 端点：刻意不用 api.github.com（未认证限流 60 次/小时，且部分网络直接 403），
// 改用 github.com 的 `/releases/latest` 302 跳转——Location 尾部即 tag，无频率限制。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { dirname, join } from "path"
import { pluginDataDir } from "../shared/paths.ts"
import { compareVersions, VERSION } from "./version.ts"

export const REPO = "Just-Silver/opencode-hud"
export const RELEASES_LATEST_URL = `https://github.com/${REPO}/releases/latest`

// ── 节流参数 ──
// 成功 TTL 取 24h：Release 不常发，一天查一次足够；
// 失败冷却取 1h：断网 / 被挡时避免每次启动都重试；
// 查询超时取 8s：避免网络挂起时请求长期悬挂（超时按失败处理，进入冷却）。
export const UPDATE_CHECK_SUCCESS_TTL_MS = 24 * 60 * 60 * 1000
export const UPDATE_CHECK_FAILURE_BACKOFF_MS = 60 * 60 * 1000
export const UPDATE_CHECK_TIMEOUT_MS = 8_000

// 磁盘缓存结构（JSON）
export type UpdateCheckCache = {
  lastAttemptAt: number // 最近一次尝试（成功/失败都写），epoch ms
  lastSuccessAt?: number // 最近一次成功，epoch ms
  latest?: string // 最近一次成功查到的 tag（如 "v1.2.3"）
}

// 更新提示信息（纯数据）
export type UpdateInfo = {
  latestVersion: string // 远程最新 SemVer（去 v 前缀）
  name: string // 展示名（默认 v<版本>）
  body?: string // Release 说明（302 跳转拿不到；保留字段，将来改用 API 时可填）
}

// 缓存文件路径：插件自己的应用数据目录（见 shared/paths.ts）
export function updateCachePath(): string {
  return join(pluginDataDir(), "update-check.json")
}

// 纯逻辑（离线可测）：缓存是否新鲜（成功 TTL 内，或失败冷却期内）→ 新鲜则不联网
export function isCacheFresh(cache: UpdateCheckCache | undefined, now: number): boolean {
  if (!cache) return false
  if (cache.lastSuccessAt !== undefined && now - cache.lastSuccessAt < UPDATE_CHECK_SUCCESS_TTL_MS) return true
  return now - cache.lastAttemptAt < UPDATE_CHECK_FAILURE_BACKOFF_MS
}

// 读缓存（零网络）；无文件 / 损坏 / 形状不符 → undefined（静默）
export function readUpdateCache(path: string): UpdateCheckCache | undefined {
  try {
    if (!existsSync(path)) return undefined
    const json = JSON.parse(readFileSync(path, "utf8")) as Partial<UpdateCheckCache>
    if (typeof json?.lastAttemptAt !== "number") return undefined
    return {
      lastAttemptAt: json.lastAttemptAt,
      lastSuccessAt: typeof json.lastSuccessAt === "number" ? json.lastSuccessAt : undefined,
      latest: typeof json.latest === "string" ? json.latest : undefined,
    }
  } catch {
    return undefined
  }
}

// 写缓存（静默：只读目录 / 写盘失败一律吞掉，不影响功能）
export function writeUpdateCache(path: string, cache: UpdateCheckCache): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(cache), "utf8")
  } catch {
    /* 静默 */
  }
}

// 更新成功后调用：把缓存标记为「已是最新」（清空 latest + 刷新成功时间）
// → 横幅立即消失，且 24h 内不再联网（避免刚更新完又提示；重启后新版本 VERSION 也会自然对齐）
export function markUpdated(now: number = Date.now(), cachePath: string = updateCachePath()): void {
  writeUpdateCache(cachePath, { lastAttemptAt: now, lastSuccessAt: now })
}

// 纯逻辑（离线可测）：本地版本 vs 远程 tag → 是否需要提示
export function resolveUpdate(
  local: string,
  remote: string | undefined,
  name?: string,
  body?: string,
): UpdateInfo | undefined {
  if (!remote) return undefined // 无 Release → 不提示
  const cmp = compareVersions(local, remote)
  if (cmp === undefined || cmp >= 0) return undefined // 非法/本地不落后（含开发版超前）→ 不提示
  return { latestVersion: parseVersionTag(remote), name: name ?? `v${parseVersionTag(remote)}`, body }
}

// tag_name "v1.2.0" → "1.2.0"；非法原样返回（交给调用方）
function parseVersionTag(tag: string): string {
  return tag.replace(/^v/, "")
}

// 从跳转目标 URL 提取 tag：.../releases/tag/v1.2.3 → "v1.2.3"
export function parseTagFromReleaseUrl(url: string | null | undefined): string | undefined {
  const m = /\/releases\/tag\/([^/?#]+)/.exec(url ?? "")
  if (!m?.[1]) return undefined
  try {
    return decodeURIComponent(m[1])
  } catch {
    return m[1]
  }
}

// 拉取远程最新 Release 的 tag；超时 / 任何失败 → undefined（静默）
export async function fetchLatestTag(
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = UPDATE_CHECK_TIMEOUT_MS,
): Promise<string | undefined> {
  try {
    const res = await fetchImpl(RELEASES_LATEST_URL, {
      redirect: "manual", // 只读 302 的 Location，不下载 Release 页面
      headers: { "User-Agent": "opencode-hud" },
      signal: AbortSignal.timeout(timeoutMs), // 网络挂起时 8s 后中止（按失败处理）
    })
    // manual：Location 头；个别实现落到 res.url
    return parseTagFromReleaseUrl(res.headers.get("location") ?? res.url)
  } catch {
    return undefined // 超时 / 网络异常 → 静默
  }
}

// 可注入依赖（测试用；生产走默认实现）
export type UpdateCheckDeps = {
  fetchTag?: typeof fetchLatestTag
  readCache?: (path: string) => UpdateCheckCache | undefined
  writeCache?: (path: string, cache: UpdateCheckCache) => void
  cachePath?: string
  now?: () => number
}

// 便捷入口：带缓存节流，返回"是否有更新 + 提示信息"
export async function checkForUpdate(deps: UpdateCheckDeps = {}): Promise<UpdateInfo | undefined> {
  const fetchTag = deps.fetchTag ?? fetchLatestTag
  const readCache = deps.readCache ?? readUpdateCache
  const writeCache = deps.writeCache ?? writeUpdateCache
  const cachePath = deps.cachePath ?? updateCachePath()
  const now = (deps.now ?? Date.now)()

  const cache = readCache(cachePath)
  if (isCacheFresh(cache, now)) return resolveUpdate(VERSION, cache?.latest) // 新鲜 → 零网络

  const tag = await fetchTag()
  if (tag) {
    writeCache(cachePath, { lastAttemptAt: now, lastSuccessAt: now, latest: tag })
    return resolveUpdate(VERSION, tag)
  }
  // 失败：保留上次成功值，仅更新 lastAttemptAt（开启冷却窗口）
  writeCache(cachePath, { lastAttemptAt: now, lastSuccessAt: cache?.lastSuccessAt, latest: cache?.latest })
  return resolveUpdate(VERSION, cache?.latest)
}

// 供测试直接导入
export { VERSION }
