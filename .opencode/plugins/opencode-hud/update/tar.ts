// ─── 归档校验：解压前逐 512 字节 header 扫描 + 解压后 lstat 复核 ───
// 只允许受控 USTAR 常规文件与目录；GNU/PAX 扩展、链接、设备、重复名都在解压前拒绝。
import { createReadStream, lstatSync, readdirSync } from "fs"
import { isAbsolute, join, relative, resolve } from "path"
import { createGunzip } from "zlib"
import {
  isSafeArchiveEntry,
  RELEASE_EXTRACTED_MAX_BYTES,
  RELEASE_EXTRACTED_MAX_ENTRIES,
} from "./release.ts"

const BLOCK = 512

export type TarLimits = { maxBytes?: number; maxEntries?: number }
export type ScanResult = { ok: true; entries: number; totalBytes: number } | { ok: false; message: string }

function isZeroBlock(block: Buffer): boolean {
  for (const byte of block) if (byte !== 0) return false
  return true
}

function readNameField(block: Buffer, start: number, end: number): string {
  let nul = end
  for (let i = start; i < end; i++) {
    if (block[i] === 0) {
      nul = i
      break
    }
  }
  for (let i = start; i < nul; i++) {
    const byte = block[i]
    if (byte < 0x20 || byte === 0x7f || byte === 0x5c || byte === 0x3a) {
      throw new Error("归档条目名字含非法字节")
    }
  }
  for (let i = nul; i < end; i++) {
    if (block[i] !== 0 && block[i] !== 0x20) throw new Error("归档条目名字段填充非法")
  }
  return block.subarray(start, nul).toString("latin1")
}

function readSize(block: Buffer): number {
  if ((block[124] & 0x80) !== 0) throw new Error("归档条目大小不能使用 base-256 编码")
  let end = 136
  while (end > 124 && (block[end - 1] === 0 || block[end - 1] === 0x20)) end--
  if (end === 124) throw new Error("归档条目大小字段为空")
  let size = 0
  for (let i = 124; i < end; i++) {
    const byte = block[i]
    if (byte < 0x30 || byte > 0x37) throw new Error("归档条目大小不是八进制")
    size = size * 8 + (byte - 0x30)
  }
  if (!Number.isSafeInteger(size)) throw new Error("归档条目大小超出范围")
  return size
}

function parseHeader(block: Buffer): { name: string; size: number; isRegularFile: boolean } {
  // 1) header checksum：校验和字段本身按 8 个空格计入
  let fieldEnd = 156
  while (fieldEnd > 148 && (block[fieldEnd - 1] === 0 || block[fieldEnd - 1] === 0x20)) fieldEnd--
  if (fieldEnd === 148 || fieldEnd - 148 > 7) throw new Error("归档 header checksum 字段非法")
  let expected = 0
  for (let i = 148; i < fieldEnd; i++) {
    const byte = block[i]
    if (byte < 0x30 || byte > 0x37) throw new Error("归档 header checksum 字段非法")
    expected = expected * 8 + (byte - 0x30)
  }
  let actual = 0
  for (let i = 0; i < BLOCK; i++) actual += i >= 148 && i < 156 ? 0x20 : block[i]
  if (actual !== expected) throw new Error("归档 header checksum 不匹配")

  // 2) 只接受 POSIX ustar；GNU 的 "ustar  " 与 PAX 一律拒绝
  if (block.subarray(257, 263).toString("latin1") !== "ustar\0") throw new Error("归档不是 ustar 格式")
  if (block[263] !== 0x30 || block[264] !== 0x30) throw new Error("归档 ustar 版本不是 00")

  // 3) name / prefix：原始字节规则（拒绝控制字符、反斜杠、ADS 冒号）
  const name = readNameField(block, 0, 100)
  const prefix = readNameField(block, 345, 500)

  // 4) size：仅八进制；base-256 直接拒绝（已在 readSize 内判断）
  const size = readSize(block)

  // 5) typeflag：仅常规文件（0 / NUL）与目录（5）
  const type = block[156]
  if (type !== 0x30 && type !== 0x00 && type !== 0x35) throw new Error("归档含不允许的条目类型")
  const isDirectory = type === 0x35
  let fullName = prefix ? `${prefix}/${name}` : name
  // GNU tar 的目录条目以 / 结尾；去掉它再做段级校验，避免把合法目录当成空段
  if (isDirectory && fullName.endsWith("/")) fullName = fullName.slice(0, -1)
  if (!isSafeArchiveEntry(fullName)) throw new Error(`归档条目路径不安全：${fullName}`)
  return { name: fullName, size, isRegularFile: !isDirectory }
}

function asciiFold(name: string): string {
  return name.replace(/[A-Z]/g, (char) => char.toLowerCase())
}

export async function scanTarGz(path: string, limits: TarLimits = {}): Promise<ScanResult> {
  const maxBytes = limits.maxBytes ?? RELEASE_EXTRACTED_MAX_BYTES
  const maxEntries = limits.maxEntries ?? RELEASE_EXTRACTED_MAX_ENTRIES
  // 结束标记后的零 padding 本身无害但不能无限：给每个 header 与尾部记录留出上限
  const maxDecompressed = maxBytes + (maxEntries + 64) * BLOCK

  let pending = Buffer.alloc(0)
  let decompressed = 0
  let entries = 0
  let totalBytes = 0
  let dataBlocks = 0
  let zeroBlocks = 0
  let ended = false
  let hasTui = false
  const seen = new Set<string>()
  const file = createReadStream(path)
  const gunzip = createGunzip()
  // pipe 不会转发源流的 error；不显式转接时，读失败会让 for-await 永远等不到结束
  file.on("error", (error) => gunzip.destroy(error))
  const source = file.pipe(gunzip)

  try {
    for await (const chunk of source) {
      decompressed += (chunk as Buffer).length
      if (decompressed > maxDecompressed) throw new Error("归档解压总量超过上限")
      pending = pending.length === 0 ? Buffer.from(chunk as Buffer) : Buffer.concat([pending, chunk as Buffer])
      while (pending.length >= BLOCK) {
        const block = pending.subarray(0, BLOCK)
        pending = pending.subarray(BLOCK)
        if (dataBlocks > 0) {
          dataBlocks--
          continue
        }
        if (isZeroBlock(block)) {
          zeroBlocks++
          if (zeroBlocks >= 2) ended = true
          continue
        }
        if (ended || zeroBlocks > 0) throw new Error("归档结束标记后出现非零数据")

        const header = parseHeader(block)
        entries++
        if (entries > maxEntries) throw new Error(`归档条目数超过上限（${maxEntries}）`)
        totalBytes += header.size
        if (totalBytes > maxBytes) throw new Error(`归档解压总量超过上限（${maxBytes} 字节）`)
        const key = asciiFold(header.name)
        if (seen.has(key)) throw new Error(`归档含重复或大小写冲突条目：${header.name}`)
        seen.add(key)
        if (header.name === "opencode-hud/tui.tsx" && header.isRegularFile) hasTui = true
        dataBlocks = Math.ceil(header.size / BLOCK)
      }
    }
    if (pending.length !== 0) throw new Error("归档被截断（尾部有残缺块）")
    if (dataBlocks > 0) throw new Error("归档被截断（数据块不足）")
    if (!ended) throw new Error("归档缺少结束标记（两个全零块）")
    // 不要求 opencode-hud 条目本身是目录：--strip-components=1 会剥掉第一段，
    // 顶层常规文件最多被剥成空路径，无法落到目标根之外。
    if (!hasTui) throw new Error("归档中未找到插件入口 opencode-hud/tui.tsx")
    return { ok: true, entries, totalBytes }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  } finally {
    source.destroy()
    file.destroy()
  }
}

export function extractArgs(archivePath: string, destDir: string): string[] {
  return ["-xzf", archivePath, "-C", destDir, "--strip-components=1", "--no-same-owner"]
}

export type TreeResult = { ok: true } | { ok: false; message: string }

export function verifyExtractedTree(dir: string, limits: TarLimits = {}): TreeResult {
  const maxBytes = limits.maxBytes ?? RELEASE_EXTRACTED_MAX_BYTES
  const maxEntries = limits.maxEntries ?? RELEASE_EXTRACTED_MAX_ENTRIES
  const root = resolve(dir)
  let files = 0
  let bytes = 0
  try {
    const walk = (current: string): void => {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const full = join(current, entry.name)
        const rel = relative(root, resolve(full))
        if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`解压得到根外路径：${full}`)
        const stat = lstatSync(full)
        if (stat.isSymbolicLink()) throw new Error(`解压得到符号链接：${full}`)
        if (stat.isDirectory()) {
          walk(full)
          continue
        }
        if (!stat.isFile()) throw new Error(`解压得到特殊文件：${full}`)
        files++
        bytes += stat.size
        if (files > maxEntries) throw new Error(`解压文件数超过上限（${maxEntries}）`)
        if (bytes > maxBytes) throw new Error(`解压总量超过上限（${maxBytes} 字节）`)
      }
    }
    walk(root)
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }

  let entry
  try {
    entry = lstatSync(join(root, "tui.tsx"))
  } catch {
    return { ok: false, message: "归档中未找到插件入口 tui.tsx" }
  }
  if (!entry.isFile() || entry.isSymbolicLink()) {
    return { ok: false, message: "归档中未找到插件入口 tui.tsx" }
  }
  return { ok: true }
}
