// ─── 测试夹具：受控 RELEASE 归档（Node / Bash / PowerShell 三套校验共用同一批字节） ───
// 只生成内存字节，不联网、不依赖系统 tar；攻击归档的每一类都对应 scanner 规则表中的一条拒绝理由。
import { createHash } from "crypto"
import { writeFileSync } from "fs"
import { join } from "path"
import { gzipSync } from "zlib"
import {
  assetName,
  RELEASE_EXTRACTED_MAX_BYTES,
  RELEASE_EXTRACTED_MAX_ENTRIES,
} from "../../.opencode/plugins/opencode-hud/update/release.ts"

export type FixtureEntry = {
  name: string
  type?: "file" | "dir" | "symlink" | "char" | "pax" | "gnu-longname"
  data?: string
  declaredSize?: number
  badChecksum?: boolean
  nonUstar?: boolean
  base256Size?: boolean
  omitEndBlocks?: boolean
  trailingGarbage?: boolean
  // 显式 prefix（ustar 长路径字段），用于覆盖 prefix 拼接与穿越
  prefix?: string
}

const BLOCK = 512
const TYPE_FLAG: Record<NonNullable<FixtureEntry["type"]>, number> = {
  file: 0x30, // "0"
  dir: 0x35, // "5"
  symlink: 0x32, // "2"
  char: 0x33, // "3"
  pax: 0x78, // "x"
  "gnu-longname": 0x4c, // "L"
}

function writeString(header: Buffer, offset: number, length: number, value: string): void {
  const bytes = Buffer.from(value, "latin1")
  if (bytes.length > length) throw new Error(`fixture 字段过长：${value}`)
  bytes.copy(header, offset)
}

function writeOctal(header: Buffer, offset: number, length: number, value: number): void {
  writeString(header, offset, length, value.toString(8).padStart(length - 1, "0") + "\0")
}

function splitName(entry: FixtureEntry): { name: string; prefix: string } {
  if (entry.prefix !== undefined) return { name: entry.name, prefix: entry.prefix }
  const chars = entry.name.split("")
  if (chars.length <= 100) return { name: entry.name, prefix: "" }
  // 在 100 字符边界之前找斜杠，切成 ustar 的 prefix + name（prefix ≤155）
  for (let i = Math.min(chars.length - 1, 155); i > 0; i--) {
    if (chars[i] === "/" && chars.length - i - 1 <= 100 && i <= 155) {
      return { prefix: chars.slice(0, i).join(""), name: chars.slice(i + 1).join("") }
    }
  }
  throw new Error(`fixture 名字无法放入 ustar 字段：${entry.name}`)
}

function headerBlock(entry: FixtureEntry): Buffer {
  const header = Buffer.alloc(BLOCK)
  const { name, prefix } = splitName(entry)
  const type = entry.type ?? "file"
  const payload = entry.data === undefined ? undefined : Buffer.from(entry.data, "latin1")
  const size = entry.declaredSize ?? payload?.length ?? 0

  writeString(header, 0, 100, name)
  writeOctal(header, 100, 8, type === "dir" ? 0o755 : 0o644)
  writeOctal(header, 108, 8, 0)
  writeOctal(header, 116, 8, 0)
  writeOctal(header, 124, 12, size)
  writeOctal(header, 136, 12, 0)
  writeString(header, 148, 8, "        ") // 校验和字段先按 8 个空格计入
  header[156] = TYPE_FLAG[type]
  writeString(header, 257, 6, entry.nonUstar ? "ustar " : "ustar\0")
  writeString(header, 263, 2, entry.nonUstar ? "  " : "00")
  writeOctal(header, 329, 8, 0)
  writeOctal(header, 337, 8, 0)
  if (prefix) writeString(header, 345, 155, prefix)

  if (entry.base256Size) {
    header[124] = 0x80
    header.writeUInt32BE(size, 132)
  }

  let sum = 0
  for (const byte of header) sum += byte
  if (entry.badChecksum) sum += 1
  writeString(header, 148, 8, `${sum.toString(8).padStart(6, "0")}\0 `)
  return header
}

function bodyBlocks(entry: FixtureEntry): Buffer {
  const payload = entry.data === undefined ? undefined : Buffer.from(entry.data, "latin1")
  if (!payload || payload.length === 0) return Buffer.alloc(0)
  const padded = Buffer.alloc(Math.ceil(payload.length / BLOCK) * BLOCK)
  payload.copy(padded)
  return padded
}

function endBlocks(count: number): Buffer {
  return Buffer.alloc(count * BLOCK)
}

export function tarGz(entries: FixtureEntry[]): Buffer {
  const parts: Buffer[] = []
  let omitEnd = false
  let garbage = false
  for (const entry of entries) {
    parts.push(headerBlock(entry), bodyBlocks(entry))
    omitEnd ||= entry.omitEndBlocks === true
    garbage ||= entry.trailingGarbage === true
  }
  if (!omitEnd) parts.push(endBlocks(2))
  if (garbage) {
    const block = Buffer.alloc(BLOCK)
    block.write("garbage", 0, "latin1")
    parts.push(block)
  }
  return gzipSync(Buffer.concat(parts))
}

export function validArchive(): Buffer {
  return tarGz([
    { name: "opencode-hud/", type: "dir" },
    { name: "opencode-hud/tui.tsx", data: "export const version = 1\n" },
  ])
}

export function attackArchives(): Array<{ name: string; archive: Buffer; reason: string }> {
  const many = Array.from({ length: RELEASE_EXTRACTED_MAX_ENTRIES + 1 }, (_, i) => ({
    name: `opencode-hud/f${i}.ts`,
  }))
  return [
    { name: "dotdot", reason: "路径不安全", archive: tarGz([{ name: "opencode-hud/../evil.ts", data: "x" }]) },
    { name: "absolute", reason: "路径不安全", archive: tarGz([{ name: "/etc/passwd", data: "x" }]) },
    { name: "backslash", reason: "名字含非法字节", archive: tarGz([{ name: "opencode-hud\\..\\evil.ts", data: "x" }]) },
    { name: "drive", reason: "名字含非法字节", archive: tarGz([{ name: "C:\\evil.ts", data: "x" }]) },
    {
      name: "control-char",
      reason: "名字含非法字节",
      archive: tarGz([{ name: "opencode-hud/ti\u0001u.tsx", data: "x" }]),
    },
    { name: "opencode-hudx", reason: "路径不安全", archive: tarGz([{ name: "opencode-hudx/tui.tsx", data: "x" }]) },
    { name: "dot-segment", reason: "路径不安全", archive: tarGz([{ name: "opencode-hud/./tui.tsx", data: "x" }]) },
    {
      name: "ads-colon",
      reason: "名字含非法字节",
      archive: tarGz([{ name: "opencode-hud/tui.tsx:ads", data: "x" }]),
    },
    {
      name: "trailing-dot",
      reason: "路径不安全",
      archive: tarGz([{ name: "opencode-hud/tui.tsx.", data: "x" }]),
    },
    {
      name: "trailing-space",
      reason: "路径不安全",
      archive: tarGz([{ name: "opencode-hud/tui.tsx ", data: "x" }]),
    },
    {
      name: "case-collision",
      reason: "重复或大小写冲突",
      archive: tarGz([
        { name: "opencode-hud/tui.tsx", data: "x" },
        { name: "opencode-hud/TUI.tsx", data: "x" },
      ]),
    },
    {
      // 入口必须精确为 tui.tsx：大小写不同的入口在大小写不敏感的文件系统上会“看起来存在”
      name: "tui-uppercase",
      reason: "未找到插件入口",
      archive: tarGz([
        { name: "opencode-hud/", type: "dir" },
        { name: "opencode-hud/TUI.TSX", data: "x" },
      ]),
    },
    {
      name: "duplicate",
      reason: "重复或大小写冲突",
      archive: tarGz([
        { name: "opencode-hud/tui.tsx", data: "x" },
        { name: "opencode-hud/tui.tsx", data: "y" },
      ]),
    },
    {
      name: "prefix-traversal",
      reason: "路径不安全",
      archive: tarGz([{ name: "evil.ts", prefix: "../..", data: "x" }]),
    },
    {
      name: "symlink",
      reason: "条目类型",
      archive: tarGz([{ name: "opencode-hud/link", type: "symlink", data: "x" }]),
    },
    {
      name: "char-device",
      reason: "条目类型",
      archive: tarGz([{ name: "opencode-hud/dev", type: "char", data: "x" }]),
    },
    {
      name: "pax-extension",
      reason: "条目类型",
      archive: tarGz([{ name: "opencode-hud/pax", type: "pax", data: "x" }]),
    },
    {
      name: "gnu-longname",
      reason: "条目类型",
      archive: tarGz([{ name: "opencode-hud/long", type: "gnu-longname", data: "x" }]),
    },
    {
      name: "bad-checksum",
      reason: "header checksum",
      archive: tarGz([{ name: "opencode-hud/tui.tsx", data: "x", badChecksum: true }]),
    },
    {
      name: "non-ustar",
      reason: "不是 ustar",
      archive: tarGz([{ name: "opencode-hud/tui.tsx", data: "x", nonUstar: true }]),
    },
    {
      name: "base256-size",
      reason: "base-256",
      archive: tarGz([{ name: "opencode-hud/tui.tsx", data: "x", base256Size: true }]),
    },
    {
      name: "truncated-data",
      reason: "数据块不足",
      archive: tarGz([{ name: "opencode-hud/tui.tsx", declaredSize: 4096, data: "" }]),
    },
    {
      name: "no-end-blocks",
      reason: "结束标记",
      archive: tarGz([{ name: "opencode-hud/tui.tsx", data: "x", omitEndBlocks: true }]),
    },
    {
      name: "garbage-after-end",
      reason: "结束标记",
      archive: tarGz([{ name: "opencode-hud/tui.tsx", data: "x", trailingGarbage: true }]),
    },
    { name: "too-many-entries", reason: "条目数超过上限", archive: tarGz(many) },
    {
      name: "oversize-total",
      reason: "解压总量超过上限",
      archive: tarGz([{ name: "opencode-hud/big.bin", declaredSize: RELEASE_EXTRACTED_MAX_BYTES + 1, data: "" }]),
    },
  ]
}

export function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex")
}

export function writeRelease(
  root: string,
  opts: { tag: string; archive?: Buffer; checksum?: "ok" | "mismatch" | "missing" | "bad" },
): { archivePath: string; checksumPath?: string } {
  const archive = opts.archive ?? validArchive()
  const archivePath = join(root, assetName(opts.tag))
  writeFileSync(archivePath, archive)
  const kind = opts.checksum ?? "ok"
  if (kind === "missing") return { archivePath }
  const checksumPath = `${archivePath}.sha256`
  const hash = kind === "mismatch" ? "0".repeat(64) : sha256Hex(archive)
  const text = kind === "bad" ? "not a checksum\n" : `${hash}  ${assetName(opts.tag)}\n`
  writeFileSync(checksumPath, text, "utf8")
  return { archivePath, checksumPath }
}
