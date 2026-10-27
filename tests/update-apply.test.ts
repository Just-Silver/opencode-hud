// ─── update/apply.ts 执行更新单元测试（离线，不真的下载/解压） ───
import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import {
  applyUpdate,
  archiveUrl,
  buildTarArgs,
  summarizeOutput,
  UPDATE_PLUGIN_SUBPATH,
  type UpdateExec,
  type UpdateRunResult,
} from "../.opencode/plugins/opencode-hud/update/apply.ts"
import { globalPluginDir } from "../.opencode/plugins/opencode-hud/shared/paths.ts"

const ok = (): UpdateRunResult => ({ code: 0, stdout: "", stderr: "" })

// 假 tar：按 -C <dest> 造出「解压后」的目录结构
function fakeExtract(content: string): UpdateExec {
  return async (_file, args) => {
    const dest = args[args.indexOf("-C") + 1]
    const dir = join(dest, UPDATE_PLUGIN_SUBPATH)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "tui.tsx"), content)
    return ok()
  }
}

// 造一个「已安装的」插件目录
function makePluginDir(root: string, content: string): string {
  const dir = join(root, "plugins", "opencode-hud")
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "tui.tsx"), content)
  return dir
}

// ─── 纯函数 ───
test("archiveUrl：有版本号走 tag 归档，无则走 main", () => {
  assert.equal(
    archiveUrl("2.1.0"),
    "https://github.com/Just-Silver/opencode-hud/archive/refs/tags/v2.1.0.tar.gz",
  )
  assert.ok(archiveUrl().endsWith("/archive/main.tar.gz"), archiveUrl())
})

test("buildTarArgs：-xzf + -C + --strip-components=1", () => {
  assert.deepEqual(buildTarArgs("/tmp/a.tar.gz", "/tmp/out"), [
    "-xzf",
    "/tmp/a.tar.gz",
    "-C",
    "/tmp/out",
    "--strip-components=1",
  ])
})

test("summarizeOutput：优先 stderr，取末尾若干行", () => {
  const stderr = Array.from({ length: 20 }, (_, i) => `err${i + 1}`).join("\n")
  assert.equal(summarizeOutput("stdout", stderr, 1, 3), "err18\nerr19\nerr20")
})

test("summarizeOutput：stderr 为空用 stdout；都空用退出码", () => {
  assert.equal(summarizeOutput("hello", "", 1), "hello")
  assert.equal(summarizeOutput("", "", 7), "命令退出码 7")
})

test("summarizeOutput：归一化 CRLF 并丢弃空行", () => {
  assert.equal(summarizeOutput("", "a\r\n\r\nb\r\n", 1), "a\nb")
})

test("globalPluginDir：落在 $XDG_CONFIG_HOME/opencode/plugins/opencode-hud", () => {
  const p = globalPluginDir()
  assert.ok(p.endsWith(join("opencode", "plugins", "opencode-hud")), p)
})

// ─── applyUpdate 编排 ───
test("applyUpdate：成功 → 下载 tag 归档、解压、原子替换、清理临时目录与改名前的旧目录", async () => {
  const root = mkdtempSync(join(tmpdir(), "otu-root-"))
  const work = mkdtempSync(join(tmpdir(), "otu-work-"))
  const pluginDir = makePluginDir(root, "old")
  const legacyDir = join(root, "plugins", "opencode-tui-usage")
  mkdirSync(legacyDir, { recursive: true })
  writeFileSync(join(legacyDir, "tui.tsx"), "legacy")
  let fetched = ""
  try {
    const result = await applyUpdate({
      version: "9.9.9",
      pluginDir,
      workDir: work,
      fetchArchive: async (url) => {
        fetched = url
        return new Uint8Array([1, 2, 3])
      },
      exec: fakeExtract("new"),
    })
    assert.deepEqual(result, { ok: true })
    assert.ok(fetched.endsWith("/archive/refs/tags/v9.9.9.tar.gz"), fetched)
    assert.equal(readFileSync(join(pluginDir, "tui.tsx"), "utf8"), "new")
    assert.equal(existsSync(work), false) // 临时目录已清理
    assert.equal(existsSync(legacyDir), false) // 旧目录已清理，避免两个实例重复渲染
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(work, { recursive: true, force: true })
  }
})

test("applyUpdate：下载失败 → 失败且目标目录不动", async () => {
  const root = mkdtempSync(join(tmpdir(), "otu-root-"))
  const work = mkdtempSync(join(tmpdir(), "otu-work-"))
  const pluginDir = makePluginDir(root, "old")
  try {
    const result = await applyUpdate({ version: "9.9.9", pluginDir, workDir: work, fetchArchive: async () => undefined })
    assert.equal(result.ok, false)
    if (!result.ok) assert.ok(result.message.includes("下载失败"))
    assert.equal(readFileSync(join(pluginDir, "tui.tsx"), "utf8"), "old")
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(work, { recursive: true, force: true })
  }
})

test("applyUpdate：tar 缺失（ENOENT）→ 失败提示", async () => {
  const root = mkdtempSync(join(tmpdir(), "otu-root-"))
  const work = mkdtempSync(join(tmpdir(), "otu-work-"))
  const pluginDir = makePluginDir(root, "old")
  try {
    const result = await applyUpdate({
      version: "9.9.9",
      pluginDir,
      workDir: work,
      fetchArchive: async () => new Uint8Array([1]),
      exec: async () => ({ code: -1, stdout: "", stderr: "", spawnError: "ENOENT" }),
    })
    assert.equal(result.ok, false)
    if (!result.ok) assert.ok(result.message.includes("未找到命令：tar"))
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(work, { recursive: true, force: true })
  }
})

test("applyUpdate：tar 非零退出 → 失败并带出 stderr", async () => {
  const root = mkdtempSync(join(tmpdir(), "otu-root-"))
  const work = mkdtempSync(join(tmpdir(), "otu-work-"))
  const pluginDir = makePluginDir(root, "old")
  try {
    const result = await applyUpdate({
      version: "9.9.9",
      pluginDir,
      workDir: work,
      fetchArchive: async () => new Uint8Array([1]),
      exec: async () => ({ code: 1, stdout: "", stderr: "tar: Error is not recoverable" }),
    })
    assert.equal(result.ok, false)
    if (!result.ok) assert.ok(result.message.includes("tar: Error is not recoverable"))
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(work, { recursive: true, force: true })
  }
})

test("applyUpdate：归档缺 tui.tsx → 失败提示", async () => {
  const root = mkdtempSync(join(tmpdir(), "otu-root-"))
  const work = mkdtempSync(join(tmpdir(), "otu-work-"))
  const pluginDir = makePluginDir(root, "old")
  try {
    const result = await applyUpdate({
      version: "9.9.9",
      pluginDir,
      workDir: work,
      fetchArchive: async () => new Uint8Array([1]),
      exec: async () => ok(), // 解压成功但没造出 tui.tsx
    })
    assert.equal(result.ok, false)
    if (!result.ok) assert.ok(result.message.includes("tui.tsx"))
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(work, { recursive: true, force: true })
  }
})
