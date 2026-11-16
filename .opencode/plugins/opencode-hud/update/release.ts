// ─── 更新协议：只认正式 Release + 受控归档条目（纯函数，无网络 / 无文件系统） ───
// 只接受已发布的 vX.Y.Z：没有 ASSETS_SINCE、没有源码归档或 main 下载等无校验回退。
export const REPO = "Just-Silver/opencode-hud"
export const RELEASES_LATEST_URL = `https://github.com/${REPO}/releases/latest`

export const RELEASE_ARCHIVE_MAX_BYTES = 16 * 1024 * 1024
export const RELEASE_CHECKSUM_MAX_BYTES = 4 * 1024
export const RELEASE_EXTRACTED_MAX_BYTES = 64 * 1024 * 1024
export const RELEASE_EXTRACTED_MAX_ENTRIES = 2000
export const RELEASE_DOWNLOAD_TIMEOUT_MS = 120_000
export const RELEASE_CHECKSUM_TIMEOUT_MS = 15_000

// 无前导零、无预发布/构建元数据：v05.3.0 与 v5.3.0-rc.1 都不是正式版
const FORMAL_TAG = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/
const FORMAL_VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/

export function parseFormalTag(tag: string): { major: number; minor: number; patch: number } | undefined {
  if (/[\r\n]/.test(tag)) return undefined // JS 的 $ 会匹配末尾换行，必须显式拒绝
  const match = FORMAL_TAG.exec(tag)
  if (!match) return undefined
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
}

// applyUpdate 的入参：裸 X.Y.Z（UpdateInfo.latestVersion 已是这个形态），内部再拼 v
export function parseVersionInput(version: string): string | undefined {
  if (/[\r\n]/.test(version)) return undefined
  const match = FORMAL_VERSION.exec(version)
  return match ? `v${version}` : undefined
}

// 302 的 Location 只可能是本仓库正式 tag 的 https 地址；相对地址按 github.com 基址解析
export function parseTrustedReleaseLocation(location: string | null | undefined): string | undefined {
  if (!location) return undefined
  let url: URL
  try {
    url = new URL(location, "https://github.com/")
  } catch {
    return undefined
  }
  if (url.origin !== "https://github.com") return undefined
  if (url.username !== "" || url.password !== "") return undefined
  if (url.search !== "" || url.hash !== "") return undefined
  const match = /^\/Just-Silver\/opencode-hud\/releases\/tag\/([^/]+)$/.exec(url.pathname)
  if (!match?.[1] || !parseFormalTag(match[1])) return undefined
  return match[1]
}

export function assetName(tag: string): string {
  return `opencode-hud-${tag}.tar.gz`
}

export function checksumAssetName(tag: string): string {
  return `${assetName(tag)}.sha256`
}

export function assetUrl(tag: string): string {
  return `https://github.com/${REPO}/releases/download/${tag}/${assetName(tag)}`
}

export function checksumUrl(tag: string): string {
  return `https://github.com/${REPO}/releases/download/${tag}/${checksumAssetName(tag)}`
}

// sidecar 必须单行：<64 hex><空格><空格或 *><裸资产名>
export function parseChecksum(text: string, expectedName: string): string | undefined {
  const body = text.endsWith("\r\n") ? text.slice(0, -2) : text.endsWith("\n") ? text.slice(0, -1) : text
  if (body.includes("\n") || body.includes("\r")) return undefined
  const match = /^([0-9a-fA-F]{64}) (?: |\*)(.+)$/.exec(body)
  if (!match?.[1] || match[2] !== expectedName) return undefined
  return match[1]
}

// 归档只允许 opencode-hud 目录自身及其子路径；拒绝 Windows ADS（:）、反斜杠、控制字符、
// 空段与 . / ..、段尾空格/点（Windows 会静默去掉它们，导致校验与落地路径不一致）。
export function isSafeArchiveEntry(name: string): boolean {
  if (name !== "opencode-hud" && !name.startsWith("opencode-hud/")) return false
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) return false
    const char = name[i]
    if (char === ":" || char === "\\") return false
  }
  for (const segment of name.split("/")) {
    if (segment.length === 0) return false
    if (segment === "." || segment === "..") return false
    if (segment.endsWith(" ") || segment.endsWith(".")) return false
  }
  return true
}
