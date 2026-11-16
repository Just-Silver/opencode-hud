// ─── update/tar.ts：解压前逐 header 扫描 + 解压后 lstat 复核（本地字节，零网络） ───
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { gzipSync, gunzipSync } from "zlib"
import {
  extractArgs,
  scanTarGz,
  verifyExtractedTree,
} from "../.opencode/plugins/opencode-hud/update/tar.ts"
import { RELEASE_EXTRACTED_MAX_BYTES } from "../.opencode/plugins/opencode-hud/update/release.ts"
import { attackArchives, tarGz, validArchive } from "./helpers/release-fixture.ts"

function writeTempArchive(root: string, archive: Buffer, name = "asset.tar.gz"): string {
  const path = join(root, name)
  writeFileSync(path, archive)
  return path
}

test("合法归档扫描返回条目数与总字节，并包含 tui.tsx", async () => {
  const root = mkdtempSync(join(tmpdir(), "otu-tar-"))
  try {
    const archive = validArchive()
    const result = await scanTarGz(writeTempArchive(root, archive))
    assert.deepEqual(result, {
      ok: true,
      entries: 2,
      totalBytes: Buffer.byteLength("export const version = 1\n"),
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("ustar prefix 字段拼接后的长路径仍须留在 opencode-hud 内", async () => {
  const root = mkdtempSync(join(tmpdir(), "otu-tar-"))
  try {
    const longName = `opencode-hud/${"a/".repeat(60)}deep.ts`
    assert.ok(longName.length > 100, "fixture 应触发 prefix 字段")
    const good = await scanTarGz(
      writeTempArchive(root, tarGz([
        { name: "opencode-hud/tui.tsx", data: "x" },
        { name: longName, data: "x" },
      ])),
    )
    assert.equal(good.ok, true)
    const escape = await scanTarGz(
      writeTempArchive(root, tarGz([{ name: `${"a/".repeat(30)}deep.ts`, prefix: "../..", data: "x" }]), "escape.tar.gz"),
    )
    assert.equal(escape.ok, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("每一类攻击归档都被拒绝", async () => {
  const attacks = attackArchives()
  const names = attacks.map((item) => item.name)
  for (const required of [
    "dotdot",
    "absolute",
    "backslash",
    "drive",
    "control-char",
    "opencode-hudx",
    "dot-segment",
    "ads-colon",
    "trailing-dot",
    "trailing-space",
    "case-collision",
    "duplicate",
    "symlink",
    "char-device",
    "pax-extension",
    "gnu-longname",
    "bad-checksum",
    "non-ustar",
    "base256-size",
    "truncated-data",
    "no-end-blocks",
    "garbage-after-end",
    "too-many-entries",
    "oversize-total",
  ]) {
    assert.ok(names.includes(required), `缺少攻击夹具：${required}`)
  }

  const root = mkdtempSync(join(tmpdir(), "otu-tar-"))
  try {
    for (const attack of attacks) {
      const result = await scanTarGz(writeTempArchive(root, attack.archive, `${attack.name}.tar.gz`))
      assert.equal(result.ok, false, `${attack.name} 应被拒绝`)
      if (!result.ok) {
        assert.ok(
          result.message.includes(attack.reason),
          `${attack.name} 的拒绝原因应包含「${attack.reason}」，实际：${result.message}`,
        )
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("条目数与解压总量在扫描阶段超限即失败", async () => {
  const root = mkdtempSync(join(tmpdir(), "otu-tar-"))
  try {
    const archive = writeTempArchive(root, tarGz([{ name: "opencode-hud/tui.tsx", data: "0123456789" }]))
    const tooMany = await scanTarGz(archive, { maxEntries: 0 })
    assert.equal(tooMany.ok, false)
    const tooLarge = await scanTarGz(archive, { maxBytes: 9 })
    assert.equal(tooLarge.ok, false)
    if (!tooLarge.ok) assert.ok(tooLarge.message.includes("上限"), tooLarge.message)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("归档路径不存在时返回失败而不是悬挂或抛异常", async () => {
  const root = mkdtempSync(join(tmpdir(), "otu-tar-"))
  try {
    const result = await scanTarGz(join(root, "missing.tar.gz"))
    assert.equal(result.ok, false)
    if (!result.ok) assert.ok(result.message.length > 0, "失败必须带原因")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("gzip 解压总量超过 64 MiB 的零 padding 在读完前被拒绝", async () => {
  const root = mkdtempSync(join(tmpdir(), "otu-tar-"))
  try {
    // 结束标记后的零 padding 合法但不能无限：压缩后很小、解压后超限的炸弹必须被预算拦住
    const raw = gunzipSync(validArchive())
    const bomb = gzipSync(Buffer.concat([raw, Buffer.alloc(RELEASE_EXTRACTED_MAX_BYTES + 4 * 1024 * 1024)]))
    assert.ok(bomb.length < 1024 * 1024, `fixture 压缩后应很小，实际 ${bomb.length}`)
    const result = await scanTarGz(writeTempArchive(root, bomb, "bomb.tar.gz"))
    assert.equal(result.ok, false)
    if (!result.ok) assert.ok(result.message.includes("解压总量超过上限"), result.message)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("extractArgs：解压已校验归档并剥离顶层目录", () => {
  assert.deepEqual(extractArgs("/tmp/a.tar.gz", "/tmp/out"), [
    "-xzf",
    "/tmp/a.tar.gz",
    "-C",
    "/tmp/out",
    "--strip-components=1",
    "--no-same-owner",
  ])
})

test("解压后复核：要求 tui.tsx 且拒绝超额目录", () => {
  const root = mkdtempSync(join(tmpdir(), "otu-tree-"))
  try {
    const dir = join(root, "extract")
    mkdirSync(join(dir, "view"), { recursive: true })
    writeFileSync(join(dir, "tui.tsx"), "export {}")
    writeFileSync(join(dir, "view", "Sidebar.tsx"), "export {}")
    assert.deepEqual(verifyExtractedTree(dir), { ok: true })

    const noEntry = join(root, "no-entry")
    mkdirSync(noEntry, { recursive: true })
    writeFileSync(join(noEntry, "index.ts"), "export {}")
    const missing = verifyExtractedTree(noEntry)
    assert.equal(missing.ok, false)
    if (!missing.ok) assert.ok(missing.message.includes("tui.tsx"), missing.message)

    const tooBig = verifyExtractedTree(dir, { maxBytes: 5 })
    assert.equal(tooBig.ok, false)
    const tooMany = verifyExtractedTree(dir, { maxEntries: 1 })
    assert.equal(tooMany.ok, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("解压后复核：符号链接被拒绝", (t) => {
  const root = mkdtempSync(join(tmpdir(), "otu-tree-"))
  try {
    const dir = join(root, "extract")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "tui.tsx"), "export {}")
    writeFileSync(join(root, "outside.txt"), "outside")
    try {
      symlinkSync(join(root, "outside.txt"), join(dir, "link.txt"), "file")
    } catch {
      t.skip("Windows 需要管理员/开发者模式创建符号链接")
      return
    }
    const result = verifyExtractedTree(dir)
    assert.equal(result.ok, false)
    if (!result.ok) assert.ok(result.message.includes("符号链接"), result.message)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
