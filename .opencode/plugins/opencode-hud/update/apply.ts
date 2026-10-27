// ─── 更新模块：执行更新（插件内自包含，不执行任何远程脚本） ───
// 背景：原先「下载并执行官方安装脚本」（`pwsh -Command "irm … | iex"`）会被 Windows Defender
//   按 Trojan:Win32/Commando.A!ml 误报拦截——「下载即执行远程脚本」是典型启发式特征。
//   故改为插件内自己下载归档 + 解压 + 原子替换，全程不执行任何远程脚本。
//
// 目标目录：固定「全局插件目录」（与安装脚本 install.sh / install.ps1 一致），
//   $XDG_CONFIG_HOME/opencode/plugins/opencode-hud（默认 ~/.config/opencode/plugins/...；Windows 取 $HOME/.config）。
//   这样在仓库目录里冒烟时不会覆盖开发副本。
//
// 步骤（等价于把安装脚本走一遍，只是「取源」改为 fetch 对应版本 tag 的归档）：
//   1. fetch https://github.com/<repo>/archive/refs/tags/v<version>.tar.gz
//   2. 写临时文件 → 系统 tar -xzf 解压（仅 spawn 本地 tar，无远程脚本执行）
//   3. 校验归档内 .opencode/plugins/opencode-hud/tui.tsx
//   4. 复制到目标同盘 staging → rm dest → mv stage dest（原子替换）
// 与 update/index.ts 的「静默失败」不同：这是用户主动点更新，失败必须如实回报给弹窗。
import { execFile } from "child_process"
import { cpSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { dirname, join } from "path"
import { globalPluginDir, LEGACY_PLUGIN_DIR_NAME } from "../shared/paths.ts"

export const REPO = "Just-Silver/opencode-hud"
export const REPO_ARCHIVE_BASE = `https://github.com/${REPO}/archive`
export const UPDATE_RUN_TIMEOUT_MS = 120_000
// 归档内插件所在子路径（解压剥离顶层目录后）
export const UPDATE_PLUGIN_SUBPATH = join(".opencode", "plugins", "opencode-hud")
// 与安装脚本一致的同盘 staging 名（固定名 + 复制前先清理，异常残留不影响下次）
export const UPDATE_STAGE_NAME = ".tmp.opencode-hud"

// 纯函数：归档 URL。有版本号 → 对应 tag 的归档（确定性）；无 → main
export function archiveUrl(version?: string): string {
  return version ? `${REPO_ARCHIVE_BASE}/refs/tags/v${version}.tar.gz` : `${REPO_ARCHIVE_BASE}/main.tar.gz`
}

// 纯函数：tar 解压参数（--strip-components=1 剥掉归档顶层目录）
export function buildTarArgs(archivePath: string, destDir: string): string[] {
  return ["-xzf", archivePath, "-C", destDir, "--strip-components=1"]
}

// 纯函数：把命令输出裁成可读错误（优先 stderr，取末尾若干行）
export function summarizeOutput(stdout: string, stderr: string, code: number, maxLines = 12): string {
  const raw = (stderr.trim() || stdout.trim() || `命令退出码 ${code}`).replace(/\r\n/g, "\n")
  const lines = raw.split("\n").filter((line) => line.trim().length > 0)
  return lines.slice(-maxLines).join("\n")
}

export type UpdateRunResult = {
  code: number
  stdout: string
  stderr: string
  // 命令不存在 → "ENOENT"；超时 → "TIMEOUT"；正常/非零退出为 undefined
  spawnError?: "ENOENT" | "TIMEOUT"
}

export type UpdateExec = (file: string, args: string[], timeoutMs: number) => Promise<UpdateRunResult>

export type UpdateResult = { ok: true } | { ok: false; message: string }

// 默认执行器：node:child_process 异步执行（不阻塞 TUI 线程）
export const execProcess: UpdateExec = (file, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 1_000_000 }, (error, stdout, stderr) => {
      const out = String(stdout ?? "")
      const err = String(stderr ?? "")
      if (!error) return resolve({ code: 0, stdout: out, stderr: err })
      const raw = error as { code?: unknown; killed?: boolean }
      if (raw.killed) return resolve({ code: -1, stdout: out, stderr: err, spawnError: "TIMEOUT" })
      const code = typeof raw.code === "number" ? raw.code : 1
      const spawnError = raw.code === "ENOENT" ? "ENOENT" : undefined
      resolve({ code, stdout: out, stderr: err, spawnError })
    })
  })

// 默认下载：fetch 归档字节；任何失败 → undefined（由调用方回报）
export async function fetchArchive(url: string, timeoutMs: number = UPDATE_RUN_TIMEOUT_MS): Promise<Uint8Array | undefined> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "opencode-hud" },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return undefined
    return new Uint8Array(await res.arrayBuffer())
  } catch {
    return undefined
  }
}

// 原子替换：复制到目标同盘 staging → rm dest → mv stage dest（与安装脚本同款）
export function installAtomically(srcDir: string, pluginDir: string): void {
  mkdirSync(dirname(pluginDir), { recursive: true })
  const stage = join(dirname(pluginDir), UPDATE_STAGE_NAME)
  rmSync(stage, { recursive: true, force: true })
  cpSync(srcDir, stage, { recursive: true })
  if (!existsSync(join(stage, "tui.tsx"))) throw new Error("staging 失败：缺少 tui.tsx")
  rmSync(pluginDir, { recursive: true, force: true })
  renameSync(stage, pluginDir)
}

// 删掉改名前的旧目录。旧插件可能正被宿主加载（Windows 会锁目录），失败留给卸载/下次安装再清。
export function removeLegacyPluginDir(pluginDir: string): void {
  const legacy = join(dirname(pluginDir), LEGACY_PLUGIN_DIR_NAME)
  if (legacy === pluginDir) return
  try {
    rmSync(legacy, { recursive: true, force: true })
  } catch {
    // 忽略：目录被占用时下次安装或卸载脚本清理
  }
}

export type ApplyUpdateDeps = {
  version?: string
  pluginDir?: string // 默认全局插件目录；测试注入
  workDir?: string // 默认 mkdtemp；测试注入
  fetchArchive?: (url: string) => Promise<Uint8Array | undefined>
  exec?: UpdateExec
  timeoutMs?: number
}

// 执行更新：下载 → 解压 → 校验 → 原子替换；返回可读结果（注入 deps 便于离线单测）
export async function applyUpdate(deps: ApplyUpdateDeps = {}): Promise<UpdateResult> {
  const timeoutMs = deps.timeoutMs ?? UPDATE_RUN_TIMEOUT_MS
  const pluginDir = deps.pluginDir ?? globalPluginDir()
  const fetchArchiveImpl = deps.fetchArchive ?? ((url: string) => fetchArchive(url, timeoutMs))
  const exec = deps.exec ?? execProcess
  const workDir = deps.workDir ?? mkdtempSync(join(tmpdir(), "opencode-hud-"))

  try {
    const url = archiveUrl(deps.version)
    const bytes = await fetchArchiveImpl(url)
    if (!bytes) return { ok: false, message: `下载失败：${url}` }

    const archivePath = join(workDir, "archive.tar.gz")
    const extractDir = join(workDir, "extract")
    mkdirSync(extractDir, { recursive: true })
    writeFileSync(archivePath, bytes)

    const tar = await exec("tar", buildTarArgs(archivePath, extractDir), timeoutMs)
    if (tar.spawnError === "ENOENT") return { ok: false, message: "未找到命令：tar（系统需自带 tar）" }
    if (tar.spawnError === "TIMEOUT") return { ok: false, message: `解压超时（${Math.round(timeoutMs / 1000)}s）` }
    if (tar.code !== 0) return { ok: false, message: summarizeOutput(tar.stdout, tar.stderr, tar.code) }

    const srcDir = join(extractDir, UPDATE_PLUGIN_SUBPATH)
    if (!existsSync(join(srcDir, "tui.tsx"))) return { ok: false, message: "归档中未找到插件入口 tui.tsx" }

    installAtomically(srcDir, pluginDir)
    removeLegacyPluginDir(pluginDir)
    return { ok: true }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
}
