// ─── update/apply.ts 执行更新单元测试（离线：mock fetch + 本地归档字节 + 假 tar） ───
import { mock, test } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "child_process"
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs"
import { syncBuiltinESMExports } from "node:module"
import { Readable } from "node:stream"
import { tmpdir } from "os"
import { dirname, isAbsolute, join } from "path"
import {
  applyUpdate,
  installAtomically,
  summarizeOutput,
  type UpdateExec,
  type UpdateRunResult,
} from "../.opencode/plugins/opencode-hud/update/apply.ts"
import { assetName, assetUrl, checksumUrl } from "../.opencode/plugins/opencode-hud/update/release.ts"
import { attackArchives, sha256Hex, tarGz, validArchive } from "./helpers/release-fixture.ts"

const TAG = "v9.9.9"
const VERSION = "9.9.9"

const ok = (): UpdateRunResult => ({ code: 0, stdout: "", stderr: "" })

// 假 tar：--strip-components=1 已剥离 opencode-hud/，入口直接落在 -C 目标根。
// 生产代码以 cwd + 相对路径调用，所以相对目标要按 opts.cwd 解析。
function fakeExtract(content: string): UpdateExec {
  return async (_file, args, _timeout, opts) => {
    const dest = args[args.indexOf("-C") + 1]
    const target = opts?.cwd ? join(opts.cwd, dest) : dest
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, "tui.tsx"), content)
    return ok()
  }
}

// 证明「没有发生解压」：一旦被调用就抛出，且错误文本不会与前置失败原因混淆
const refuseExtract: UpdateExec = async () => {
  throw new Error("不应解压")
}

function makePluginDir(root: string, content: string): string {
  const dir = join(root, "plugins", "opencode-hud")
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "tui.tsx"), content)
  return dir
}

// 按 URL 分发的 Release 假件：checksum 端点 → 文本，资产端点 → 归档字节
function releaseServer(
  archive: Buffer,
  checksum: string = `${sha256Hex(archive)}  ${assetName(TAG)}\n`,
  opts: { failAsset?: boolean; checksumStatus?: number } = {},
): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = []
  const fetchImpl = (async (input: unknown) => {
    const url = String(input)
    calls.push(url)
    if (url.endsWith(".sha256")) {
      if (opts.checksumStatus && opts.checksumStatus !== 200) {
        return new Response("no", { status: opts.checksumStatus })
      }
      return new Response(checksum, { status: 200 })
    }
    if (opts.failAsset) throw new Error("network down")
    return new Response(archive, { status: 200 })
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

// 在 fs 外部边界注入故障；每个用例的 finally 里 restoreFs（node:test 默认串行执行同文件用例）
function injectFs(
  name: "renameSync" | "rmSync" | "mkdtempSync" | "createReadStream",
  impl: (...args: any[]) => unknown,
): void {
  mock.method(fs, name, impl)
  syncBuiltinESMExports()
}

function restoreFs(): void {
  mock.restoreAll()
  syncBuiltinESMExports()
}

// 宿主发现器只看 plugins 的直接子目录里有没有 tui.tsx；把这类目录找出来
function discoverableDirs(parent: string, exclude: string): string[] {
  return readdirSync(parent, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(parent, entry.name))
    .filter((dir) => dir !== exclude && existsSync(join(dir, "tui.tsx")))
}

// ─── 纯函数 ───
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

// ─── 前置校验：任何失败都不进入下一步，也不触碰 DEST ───
test("非正式或缺失 version → 失败，不访问网络", async () => {
  const root = mkdtempSync(join(tmpdir(), "otu-root-"))
  const pluginDir = makePluginDir(root, "old")
  try {
    const { fetchImpl, calls } = releaseServer(validArchive())
    for (const version of ["v9.9.9", " 9.9.9", "9.9.9-rc.1", ""]) {
      const result = await applyUpdate({
        version,
        pluginDir,
        workDir: mkdtempSync(join(tmpdir(), "otu-work-")),
        fetch: fetchImpl,
        exec: refuseExtract,
      })
      assert.equal(result.ok, false, version)
      if (!result.ok) assert.ok(result.message.includes("版本"), result.message)
    }
    assert.deepEqual(calls, [])
    assert.equal(readFileSync(join(pluginDir, "tui.tsx"), "utf8"), "old")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("checksum 缺失/格式错/不匹配 → 失败，且不发生解压、DEST 未动", async () => {
  const root = mkdtempSync(join(tmpdir(), "otu-root-"))
  const pluginDir = makePluginDir(root, "old")
  try {
    const archive = validArchive()
    const cases: Array<{ name: string; server: ReturnType<typeof releaseServer> }> = [
      { name: "missing", server: releaseServer(archive, "unused", { checksumStatus: 404 }) },
      { name: "bad", server: releaseServer(archive, "not a checksum\n") },
      {
        name: "mismatch",
        server: releaseServer(archive, `${"0".repeat(64)}  ${assetName(TAG)}\n`),
      },
    ]
    for (const item of cases) {
      const work = mkdtempSync(join(tmpdir(), "otu-work-"))
      const result = await applyUpdate({
        version: VERSION,
        pluginDir,
        workDir: work,
        fetch: item.server.fetchImpl,
        exec: refuseExtract,
      })
      assert.equal(result.ok, false, item.name)
      if (!result.ok) {
        assert.ok(result.message.includes("校验"), `${item.name}: ${result.message}`)
        assert.ok(!result.message.includes("不应解压"), `${item.name}: 不应进入解压阶段`)
      }
      assert.equal(readFileSync(join(pluginDir, "tui.tsx"), "utf8"), "old", item.name)
      assert.equal(existsSync(work), false, item.name)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("归档含不安全条目 / 超限 → 失败且不发生解压", async () => {
  const root = mkdtempSync(join(tmpdir(), "otu-root-"))
  const pluginDir = makePluginDir(root, "old")
  try {
    const attacks = attackArchives()
    for (const name of ["dotdot", "symlink", "ads-colon", "oversize-total", "case-collision", "bad-checksum"]) {
      const attack = attacks.find((item) => item.name === name)
      assert.ok(attack, `缺少攻击夹具：${name}`)
      const work = mkdtempSync(join(tmpdir(), "otu-work-"))
      const result = await applyUpdate({
        version: VERSION,
        pluginDir,
        workDir: work,
        fetch: releaseServer(attack.archive).fetchImpl,
        exec: refuseExtract,
      })
      assert.equal(result.ok, false, name)
      if (!result.ok) {
        assert.ok(result.message.includes("归档校验失败"), `${name}: ${result.message}`)
        assert.ok(result.message.includes(attack.reason), `${name}: 应包含「${attack.reason}」`)
        assert.ok(!result.message.includes("不应解压"), `${name}: 不应进入解压阶段`)
      }
      assert.equal(readFileSync(join(pluginDir, "tui.tsx"), "utf8"), "old", name)
      assert.equal(existsSync(work), false, name)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("归档读取失败 → 失败且目标目录不动", async () => {
  const root = mkdtempSync(join(tmpdir(), "otu-root-"))
  const work = mkdtempSync(join(tmpdir(), "otu-work-"))
  const pluginDir = makePluginDir(root, "old")
  try {
    injectFs("createReadStream", () => {
      const stream = new Readable({
        read() {
          this.destroy(new Error("EIO: simulated 归档读取失败"))
        },
      })
      return stream
    })
    const result = await applyUpdate({
      version: VERSION,
      pluginDir,
      workDir: work,
      fetch: releaseServer(validArchive()).fetchImpl,
      exec: refuseExtract,
    })
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.ok(result.message.includes("归档校验失败"), result.message)
      assert.ok(result.message.includes("读取失败"), result.message)
    }
    assert.equal(readFileSync(join(pluginDir, "tui.tsx"), "utf8"), "old")
  } finally {
    restoreFs()
    rmSync(root, { recursive: true, force: true })
    rmSync(work, { recursive: true, force: true })
  }
})

test("下载失败 → 失败且目标目录不动", async () => {
  const root = mkdtempSync(join(tmpdir(), "otu-root-"))
  const work = mkdtempSync(join(tmpdir(), "otu-work-"))
  const pluginDir = makePluginDir(root, "old")
  try {
    const result = await applyUpdate({
      version: VERSION,
      pluginDir,
      workDir: work,
      fetch: releaseServer(validArchive(), undefined, { failAsset: true }).fetchImpl,
      exec: refuseExtract,
    })
    assert.equal(result.ok, false)
    if (!result.ok) assert.ok(result.message.includes("下载失败"), result.message)
    assert.equal(readFileSync(join(pluginDir, "tui.tsx"), "utf8"), "old")
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(work, { recursive: true, force: true })
  }
})

test("tar 缺失（ENOENT）→ 失败提示", async () => {
  const root = mkdtempSync(join(tmpdir(), "otu-root-"))
  const work = mkdtempSync(join(tmpdir(), "otu-work-"))
  const pluginDir = makePluginDir(root, "old")
  try {
    const result = await applyUpdate({
      version: VERSION,
      pluginDir,
      workDir: work,
      fetch: releaseServer(validArchive()).fetchImpl,
      exec: async () => ({ code: -1, stdout: "", stderr: "", spawnError: "ENOENT" }),
    })
    assert.equal(result.ok, false)
    if (!result.ok) assert.ok(result.message.includes("未找到命令：tar"))
    assert.equal(readFileSync(join(pluginDir, "tui.tsx"), "utf8"), "old")
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(work, { recursive: true, force: true })
  }
})

test("tar 非零退出 → 失败并带出 stderr", async () => {
  const root = mkdtempSync(join(tmpdir(), "otu-root-"))
  const work = mkdtempSync(join(tmpdir(), "otu-work-"))
  const pluginDir = makePluginDir(root, "old")
  try {
    const result = await applyUpdate({
      version: VERSION,
      pluginDir,
      workDir: work,
      fetch: releaseServer(validArchive()).fetchImpl,
      exec: async () => ({ code: 1, stdout: "", stderr: "tar: Error is not recoverable" }),
    })
    assert.equal(result.ok, false)
    if (!result.ok) assert.ok(result.message.includes("tar: Error is not recoverable"))
    assert.equal(readFileSync(join(pluginDir, "tui.tsx"), "utf8"), "old")
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(work, { recursive: true, force: true })
  }
})

test("归档缺 tui.tsx → 失败提示", async () => {
  const root = mkdtempSync(join(tmpdir(), "otu-root-"))
  const work = mkdtempSync(join(tmpdir(), "otu-work-"))
  const pluginDir = makePluginDir(root, "old")
  try {
    const archive = tarGz([{ name: "opencode-hud/readme.txt", data: "x" }])
    const result = await applyUpdate({
      version: VERSION,
      pluginDir,
      workDir: work,
      fetch: releaseServer(archive).fetchImpl,
      exec: refuseExtract,
    })
    assert.equal(result.ok, false)
    if (!result.ok) assert.ok(result.message.includes("tui.tsx"), result.message)
    assert.equal(readFileSync(join(pluginDir, "tui.tsx"), "utf8"), "old")
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(work, { recursive: true, force: true })
  }
})

// ─── 成功路径与事务替换 ───
test("成功：校验并扫描通过后才事务替换，资产 URL 带 v 前缀", async () => {
  const root = mkdtempSync(join(tmpdir(), "otu-root-"))
  const work = mkdtempSync(join(tmpdir(), "otu-work-"))
  const pluginDir = makePluginDir(root, "old")
  try {
    const server = releaseServer(validArchive())
    const extractCalls: Array<{ args: string[]; cwd?: string }> = []
    const exec: UpdateExec = async (file, args, timeoutMs, opts) => {
      extractCalls.push({ args, cwd: opts?.cwd })
      return fakeExtract("new")(file, args, timeoutMs, opts)
    }
    const result = await applyUpdate({
      version: VERSION,
      pluginDir,
      workDir: work,
      fetch: server.fetchImpl,
      exec,
    })
    assert.deepEqual(result, { ok: true })
    assert.ok(server.calls.includes(assetUrl(TAG)), server.calls.join("\n"))
    assert.equal(readFileSync(join(pluginDir, "tui.tsx"), "utf8"), "new")
    assert.equal(existsSync(work), false) // 临时目录已清理
    // GNU tar 在 Windows 会把盘符当远程主机：解压参数只能是相对名，路径由 cwd 定位
    assert.equal(extractCalls.length, 1)
    assert.equal(extractCalls[0].cwd, work)
    for (const arg of extractCalls[0].args) {
      assert.doesNotMatch(arg, /^[A-Za-z]:/, `tar 参数不能带盘符：${arg}`)
      assert.equal(isAbsolute(arg), false, `tar 参数不能是绝对路径：${arg}`)
    }
    assert.equal(extractCalls[0].args[extractCalls[0].args.indexOf("-C") + 1], "extract")
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(work, { recursive: true, force: true })
  }
})

test("先校验后下载：第一个请求是 .sha256，之后才请求资产归档", async () => {
  const root = mkdtempSync(join(tmpdir(), "otu-root-"))
  const work = mkdtempSync(join(tmpdir(), "otu-work-"))
  const pluginDir = makePluginDir(root, "old")
  try {
    const server = releaseServer(validArchive())
    const result = await applyUpdate({
      version: VERSION,
      pluginDir,
      workDir: work,
      fetch: server.fetchImpl,
      exec: fakeExtract("new"),
    })
    assert.deepEqual(result, { ok: true })
    assert.deepEqual(server.calls, [checksumUrl(TAG), assetUrl(TAG)])
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(work, { recursive: true, force: true })
  }
})

test("applyUpdate：旧目录无法挪走时失败，旧版文件保持完整", async () => {
  const root = mkdtempSync(join(tmpdir(), "otu-root-"))
  const work = mkdtempSync(join(tmpdir(), "otu-work-"))
  const pluginDir = makePluginDir(root, "old")
  mkdirSync(join(pluginDir, "sub"), { recursive: true })
  writeFileSync(join(pluginDir, "a.ts"), "old-a")
  writeFileSync(join(pluginDir, "sub", "deep.ts"), "old-deep")
  const realRename = fs.renameSync
  try {
    injectFs("renameSync", (src: string, dest: string) => {
      if (String(src) === pluginDir) throw new Error("EPERM: simulated 旧目录被占用")
      return realRename(src, dest)
    })
    const result = await applyUpdate({
      version: VERSION,
      pluginDir,
      workDir: work,
      fetch: releaseServer(validArchive()).fetchImpl,
      exec: fakeExtract("new"),
    })
    assert.equal(result.ok, false)
    assert.equal(readFileSync(join(pluginDir, "tui.tsx"), "utf8"), "old")
    assert.equal(readFileSync(join(pluginDir, "a.ts"), "utf8"), "old-a")
    assert.equal(readFileSync(join(pluginDir, "sub", "deep.ts"), "utf8"), "old-deep")
  } finally {
    restoreFs()
    rmSync(root, { recursive: true, force: true })
    rmSync(work, { recursive: true, force: true })
  }
})

test("applyUpdate：新副本提升失败时回滚旧版，且不留可被宿主发现的残留目录", async () => {
  const root = mkdtempSync(join(tmpdir(), "otu-root-"))
  const work = mkdtempSync(join(tmpdir(), "otu-work-"))
  const pluginDir = makePluginDir(root, "old")
  const realRename = fs.renameSync
  let promotionFailed = false
  try {
    injectFs("renameSync", (src: string, dest: string) => {
      if (String(dest) === pluginDir && !promotionFailed) {
        promotionFailed = true
        throw new Error("EPERM: simulated 提升失败")
      }
      return realRename(src, dest)
    })
    const result = await applyUpdate({
      version: VERSION,
      pluginDir,
      workDir: work,
      fetch: releaseServer(validArchive()).fetchImpl,
      exec: fakeExtract("new"),
    })
    assert.equal(result.ok, false)
    assert.equal(readFileSync(join(pluginDir, "tui.tsx"), "utf8"), "old")
    assert.deepEqual(discoverableDirs(dirname(pluginDir), pluginDir), [])
  } finally {
    restoreFs()
    rmSync(root, { recursive: true, force: true })
    rmSync(work, { recursive: true, force: true })
  }
})

test("applyUpdate：临时工作目录创建失败时返回失败结果而非抛异常", async () => {
  const root = mkdtempSync(join(tmpdir(), "otu-root-"))
  const pluginDir = makePluginDir(root, "old")
  try {
    injectFs("mkdtempSync", () => {
      throw new Error("EACCES: simulated 临时目录不可写")
    })
    const result = await applyUpdate({
      version: VERSION,
      pluginDir,
      fetch: releaseServer(validArchive()).fetchImpl,
      exec: fakeExtract("new"),
    })
    assert.equal(result.ok, false)
    if (!result.ok) assert.ok(result.message.includes("EACCES"), result.message)
    assert.equal(readFileSync(join(pluginDir, "tui.tsx"), "utf8"), "old")
  } finally {
    restoreFs()
    rmSync(root, { recursive: true, force: true })
  }
})

test("applyUpdate：安装成功但清理临时目录失败时仍返回成功", async () => {
  const root = mkdtempSync(join(tmpdir(), "otu-root-"))
  const work = mkdtempSync(join(tmpdir(), "otu-work-"))
  const pluginDir = makePluginDir(root, "old")
  const realRm = fs.rmSync
  try {
    injectFs("rmSync", (path: string, ...rest: any[]) => {
      if (String(path) === work) throw new Error("EPERM: simulated 清理失败")
      return realRm(path, ...(rest as [any]))
    })
    const result = await applyUpdate({
      version: VERSION,
      pluginDir,
      workDir: work,
      fetch: releaseServer(validArchive()).fetchImpl,
      exec: fakeExtract("new"),
    })
    assert.deepEqual(result, { ok: true })
    assert.equal(readFileSync(join(pluginDir, "tui.tsx"), "utf8"), "new")
  } finally {
    restoreFs()
    rmSync(root, { recursive: true, force: true })
    rmSync(work, { recursive: true, force: true })
  }
})

test("applyUpdate：安装失败时保留安装错误，不被清理异常覆盖", async () => {
  const root = mkdtempSync(join(tmpdir(), "otu-root-"))
  const work = mkdtempSync(join(tmpdir(), "otu-work-"))
  const pluginDir = makePluginDir(root, "old")
  const realRename = fs.renameSync
  const realRm = fs.rmSync
  try {
    injectFs("renameSync", (src: string, dest: string) => {
      if (String(src) === pluginDir) throw new Error("EPERM: simulated 旧目录被占用")
      return realRename(src, dest)
    })
    injectFs("rmSync", (path: string, ...rest: any[]) => {
      if (String(path) === work) throw new Error("EPERM: simulated 清理失败")
      return realRm(path, ...(rest as [any]))
    })
    const result = await applyUpdate({
      version: VERSION,
      pluginDir,
      workDir: work,
      fetch: releaseServer(validArchive()).fetchImpl,
      exec: fakeExtract("new"),
    })
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.ok(result.message.includes("旧目录被占用"), result.message)
      assert.ok(!result.message.includes("清理失败"), result.message)
    }
  } finally {
    restoreFs()
    rmSync(root, { recursive: true, force: true })
    rmSync(work, { recursive: true, force: true })
  }
})

test("applyUpdate：回滚也失败时保留备份并在错误中给出可恢复路径", async () => {
  const root = mkdtempSync(join(tmpdir(), "otu-root-"))
  const work = mkdtempSync(join(tmpdir(), "otu-work-"))
  const pluginDir = makePluginDir(root, "old")
  const realRename = fs.renameSync
  try {
    injectFs("renameSync", (src: string, dest: string) => {
      if (String(src) !== pluginDir && String(dest) === pluginDir) {
        throw new Error("EPERM: simulated 提升与回滚都失败")
      }
      return realRename(src, dest)
    })
    const result = await applyUpdate({
      version: VERSION,
      pluginDir,
      workDir: work,
      fetch: releaseServer(validArchive()).fetchImpl,
      exec: fakeExtract("new"),
    })
    assert.equal(result.ok, false)
    const backups = findFileDirs(dirname(pluginDir), "tui.tsx").filter(
      (dir) => dir !== pluginDir && readFileSync(join(dir, "tui.tsx"), "utf8") === "old",
    )
    assert.equal(backups.length, 1, `应恰好保留一份旧版备份，实际：${backups.join(", ")}`)
    if (!result.ok) assert.ok(result.message.includes(backups[0]), result.message)
    // 备份容器本身不是合法的插件目录（宿主只认直接含 tui.tsx 的目录）
    assert.deepEqual(discoverableDirs(dirname(pluginDir), pluginDir), [])
  } finally {
    restoreFs()
    rmSync(root, { recursive: true, force: true })
    rmSync(work, { recursive: true, force: true })
  }
})

test("installAtomically：安装成功但清理临时容器失败时不报安装失败", () => {
  const root = mkdtempSync(join(tmpdir(), "otu-root-"))
  const src = join(root, "src")
  mkdirSync(src, { recursive: true })
  writeFileSync(join(src, "tui.tsx"), "new")
  const pluginDir = join(root, "plugins", "opencode-hud")
  const realRm = fs.rmSync
  try {
    injectFs("rmSync", (path: string, ...rest: any[]) => {
      if (String(path) !== pluginDir) throw new Error("EPERM: simulated 清理失败")
      return realRm(path, ...(rest as [any]))
    })
    assert.doesNotThrow(() => installAtomically(src, pluginDir))
    assert.equal(readFileSync(join(pluginDir, "tui.tsx"), "utf8"), "new")
  } finally {
    restoreFs()
    rmSync(root, { recursive: true, force: true })
  }
})

// ─── 目录锁 ───
const LOCK_NAME = ".opencode-hud.lock"

// 真实子进程创建锁目录并保持存活（覆盖「另一进程持锁」而不是同进程重入）
async function holdLockInChildProcess(lockDir: string): Promise<{ kill: () => void }> {
  const ownerPath = join(lockDir, "owner")
  const ownerText = "tool=install\npid=424242\nstartedAt=1\ntoken=other-process\n"
  const script = [
    'const fs = require("fs")',
    `fs.mkdirSync(${JSON.stringify(lockDir)})`,
    `fs.writeFileSync(${JSON.stringify(ownerPath)}, ${JSON.stringify(ownerText)})`,
    "setTimeout(() => {}, 30000)",
  ].join("\n")
  const child = spawn(process.execPath, ["-e", script], { stdio: "ignore", windowsHide: true })
  const deadline = Date.now() + 10_000
  while (!existsSync(ownerPath)) {
    if (Date.now() > deadline) throw new Error("子进程未能创建锁")
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return { kill: () => child.kill() }
}

function readOwner(lockDir: string): string {
  return readFileSync(join(lockDir, "owner"), "utf8")
}

test("目标被另一进程持锁时等待超时失败，DEST 不变，锁与 owner 保留", async () => {
  const root = mkdtempSync(join(tmpdir(), "otu-root-"))
  const work = mkdtempSync(join(tmpdir(), "otu-work-"))
  const pluginDir = makePluginDir(root, "old")
  const lockDir = join(dirname(pluginDir), LOCK_NAME)
  const holder = await holdLockInChildProcess(lockDir)
  try {
    const ownerBefore = readOwner(lockDir)
    const result = await applyUpdate({
      version: VERSION,
      pluginDir,
      workDir: work,
      fetch: releaseServer(validArchive()).fetchImpl,
      exec: fakeExtract("new"),
      lockWaitMs: 300,
    })
    assert.equal(result.ok, false)
    if (!result.ok) assert.ok(result.message.includes(lockDir), result.message)
    assert.equal(readFileSync(join(pluginDir, "tui.tsx"), "utf8"), "old")
    assert.equal(existsSync(lockDir), true, "超时失败不能删除别人的锁")
    assert.equal(readOwner(lockDir), ownerBefore, "别人的 owner 不能被改写")
  } finally {
    holder.kill()
    rmSync(root, { recursive: true, force: true })
    rmSync(work, { recursive: true, force: true })
  }
})

test("成功与失败都只释放自己的锁", async () => {
  const root = mkdtempSync(join(tmpdir(), "otu-root-"))
  const pluginDir = makePluginDir(root, "old")
  const pluginsDir = dirname(pluginDir)
  const lockDir = join(pluginsDir, LOCK_NAME)
  try {
    // 他人锁：超时失败后必须原样保留
    mkdirSync(lockDir)
    writeFileSync(join(lockDir, "owner"), "tool=uninstall\npid=7\nstartedAt=1\ntoken=foreign\n")
    const work1 = mkdtempSync(join(tmpdir(), "otu-work-"))
    const blocked = await applyUpdate({
      version: VERSION,
      pluginDir,
      workDir: work1,
      fetch: releaseServer(validArchive()).fetchImpl,
      exec: fakeExtract("new"),
      lockWaitMs: 300,
    })
    assert.equal(blocked.ok, false)
    assert.equal(readFileSync(join(lockDir, "owner"), "utf8"), "tool=uninstall\npid=7\nstartedAt=1\ntoken=foreign\n")
    rmSync(lockDir, { recursive: true, force: true })

    // 自己拿锁后事务失败：只释放自己的锁
    const realRename = fs.renameSync
    const work2 = mkdtempSync(join(tmpdir(), "otu-work-"))
    try {
      injectFs("renameSync", (src: string, dest: string) => {
        if (String(src) === pluginDir) throw new Error("EPERM: simulated 旧目录被占用")
        return realRename(src, dest)
      })
      const failed = await applyUpdate({
        version: VERSION,
        pluginDir,
        workDir: work2,
        fetch: releaseServer(validArchive()).fetchImpl,
        exec: fakeExtract("new"),
      })
      assert.equal(failed.ok, false)
    } finally {
      restoreFs()
    }
    assert.equal(existsSync(lockDir), false, "自己失败也要释放自己的锁")

    // 自成功路径：锁同样消失
    const work3 = mkdtempSync(join(tmpdir(), "otu-work-"))
    const result = await applyUpdate({
      version: VERSION,
      pluginDir,
      workDir: work3,
      fetch: releaseServer(validArchive()).fetchImpl,
      exec: fakeExtract("new"),
    })
    assert.deepEqual(result, { ok: true })
    assert.equal(readFileSync(join(pluginDir, "tui.tsx"), "utf8"), "new")
    assert.equal(existsSync(lockDir), false, "成功路径不能留下锁")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("预先存在的陌生事务容器不被清理", async () => {
  const root = mkdtempSync(join(tmpdir(), "otu-root-"))
  const pluginDir = makePluginDir(root, "old")
  const pluginsDir = dirname(pluginDir)
  const stranger = join(pluginsDir, ".opencode-hud-install-stranger")
  mkdirSync(join(stranger, "backup"), { recursive: true })
  writeFileSync(join(stranger, "backup", "tui.tsx"), "only-backup")
  try {
    const work = mkdtempSync(join(tmpdir(), "otu-work-"))
    const result = await applyUpdate({
      version: VERSION,
      pluginDir,
      workDir: work,
      fetch: releaseServer(validArchive()).fetchImpl,
      exec: fakeExtract("new"),
    })
    assert.deepEqual(result, { ok: true })
    assert.equal(readFileSync(join(stranger, "backup", "tui.tsx"), "utf8"), "only-backup")

    const realRename = fs.renameSync
    try {
      injectFs("renameSync", (src: string, dest: string) => {
        if (String(src) === pluginDir) throw new Error("EPERM: simulated 旧目录被占用")
        return realRename(src, dest)
      })
      const failed = await applyUpdate({
        version: VERSION,
        pluginDir,
        workDir: mkdtempSync(join(tmpdir(), "otu-work-")),
        fetch: releaseServer(validArchive()).fetchImpl,
        exec: fakeExtract("new"),
      })
      assert.equal(failed.ok, false)
    } finally {
      restoreFs()
    }
    assert.equal(readFileSync(join(stranger, "backup", "tui.tsx"), "utf8"), "only-backup")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

function findFileDirs(root: string, name: string): string[] {
  const found: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name === name) found.push(dirname(full))
    }
  }
  walk(root)
  return found
}
