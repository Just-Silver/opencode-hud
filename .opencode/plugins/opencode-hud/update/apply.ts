// ─── 更新模块：执行更新（插件内自包含，不执行任何远程脚本） ───
// 目标目录固定为全局插件目录（与安装脚本一致），在仓库内冒烟时不会覆盖开发副本。
// 与 update/index.ts 的「静默失败」不同：这是用户主动点更新，失败必须如实回报给弹窗。
//
// 顺序不可调整：先取 checksum、再下载、边下边算 hash、解压前扫描、解压后复核，最后才碰 DEST。
// 任何一步失败都直接返回，旧版保持原样。
import { execFile } from "child_process"
import { cpSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "fs"
import { tmpdir } from "os"
import { dirname, join } from "path"
import { withDirLock } from "../shared/lock.ts"
import { globalPluginDir } from "../shared/paths.ts"
import { downloadFile, fetchText } from "./download.ts"
import {
  assetName,
  assetUrl,
  checksumUrl,
  parseChecksum,
  parseVersionInput,
  RELEASE_ARCHIVE_MAX_BYTES,
  RELEASE_CHECKSUM_MAX_BYTES,
  RELEASE_CHECKSUM_TIMEOUT_MS,
  RELEASE_DOWNLOAD_TIMEOUT_MS,
} from "./release.ts"
import { extractArgs, scanTarGz, verifyExtractedTree } from "./tar.ts"

// staging/备份容器建在插件父目录内（同文件系统才能 rename）。容器里只放子目录、不含 tui.tsx，
// 否则残留会被宿主当成第二个插件目录发现。
const INSTALL_CONTAINER_PREFIX = ".opencode-hud-install-"

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

// cwd 用于 tar：Git 自带的 GNU tar 会把 "C:\..." 当成远程主机（exit 128），
// 所以归档路径与 -C 目标一律传相对名，由 cwd 定位。
export type UpdateExec = (
  file: string,
  args: string[],
  timeoutMs: number,
  opts?: { cwd?: string },
) => Promise<UpdateRunResult>

export type UpdateResult = { ok: true } | { ok: false; message: string }

// 默认执行器：node:child_process 异步执行（不阻塞 TUI 线程）
export const execProcess: UpdateExec = (file, args, timeoutMs, opts) =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 1_000_000, cwd: opts?.cwd },
      (error, stdout, stderr) => {
        const out = String(stdout ?? "")
        const err = String(stderr ?? "")
        if (!error) return resolve({ code: 0, stdout: out, stderr: err })
        const raw = error as { code?: unknown; killed?: boolean }
        if (raw.killed) return resolve({ code: -1, stdout: out, stderr: err, spawnError: "TIMEOUT" })
        const code = typeof raw.code === "number" ? raw.code : 1
        const spawnError = raw.code === "ENOENT" ? "ENOENT" : undefined
        resolve({ code, stdout: out, stderr: err, spawnError })
      },
    )
  })

// 事务式替换：旧目录整体挪到备份 → 新副本提到正式位置；第二步失败则把备份挪回。
// 任何一步失败都不得删除旧版文件；安装已成功后清理失败只留下容器，不影响结果。
export function installAtomically(srcDir: string, pluginDir: string): void {
  const parent = dirname(pluginDir)
  mkdirSync(parent, { recursive: true })
  const container = mkdtempSync(join(parent, INSTALL_CONTAINER_PREFIX))
  const stage = join(container, "stage")
  const backup = join(container, "backup")
  const discardContainer = () => {
    try {
      rmSync(container, { recursive: true, force: true })
    } catch {
      // 容器内没有 tui.tsx，残留不会被宿主当成插件；留给用户手动清理
    }
  }

  try {
    cpSync(srcDir, stage, { recursive: true })
    if (!existsSync(join(stage, "tui.tsx"))) throw new Error("staging 失败：缺少 tui.tsx")
  } catch (error) {
    discardContainer()
    throw error
  }

  const hadOld = existsSync(pluginDir)
  if (hadOld) {
    try {
      renameSync(pluginDir, backup) // 失败时旧版原封不动
    } catch (error) {
      discardContainer()
      throw error
    }
  }

  try {
    renameSync(stage, pluginDir)
  } catch (error) {
    if (!hadOld) {
      discardContainer()
      throw error
    }
    try {
      renameSync(backup, pluginDir)
    } catch (rollbackError) {
      // 这是唯一一份旧副本：不能删，路径必须让用户能看到
      throw new Error(
        `${errorMessage(error)}；旧版本已备份到 ${backup}，但恢复失败：${errorMessage(rollbackError)}`,
      )
    }
    discardContainer()
    throw error
  }

  discardContainer()
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export type ApplyUpdateDeps = {
  version: string // 裸 X.Y.Z（UpdateInfo.latestVersion）
  pluginDir?: string // 默认全局插件目录；测试注入
  workDir?: string // 默认 mkdtemp；测试注入
  fetch?: typeof fetch
  exec?: UpdateExec
  timeoutMs?: number // 下载与解压超时；默认 120s
  lockWaitMs?: number // 目录锁等待；测试注入更短的超时
}

// 执行更新：校验 checksum → 有界下载 → 扫描归档 → 解压 → 复核 → 事务式替换；
// 返回可读结果，不抛异常（注入 deps 便于离线单测）
export async function applyUpdate(deps: ApplyUpdateDeps): Promise<UpdateResult> {
  const tag = parseVersionInput(deps.version)
  if (!tag) {
    return { ok: false, message: `版本号无效：只接受正式版 X.Y.Z（收到 ${JSON.stringify(deps.version)}）` }
  }
  const timeoutMs = deps.timeoutMs ?? RELEASE_DOWNLOAD_TIMEOUT_MS
  const pluginDir = deps.pluginDir ?? globalPluginDir()
  const exec = deps.exec ?? execProcess
  let workDir = deps.workDir

  try {
    workDir ??= mkdtempSync(join(tmpdir(), "opencode-hud-"))

    const checksum = await fetchText(checksumUrl(tag), {
      maxBytes: RELEASE_CHECKSUM_MAX_BYTES,
      timeoutMs: RELEASE_CHECKSUM_TIMEOUT_MS,
      fetchImpl: deps.fetch,
    })
    if (!checksum.ok) return { ok: false, message: `获取校验文件失败：${checksum.message}` }
    const expected = parseChecksum(checksum.text, assetName(tag))
    if (!expected) return { ok: false, message: "校验文件格式错误或资产名不匹配" }

    const archiveName = assetName(tag)
    const archivePath = join(workDir, archiveName)
    const download = await downloadFile(assetUrl(tag), archivePath, {
      maxBytes: RELEASE_ARCHIVE_MAX_BYTES,
      timeoutMs,
      fetchImpl: deps.fetch,
    })
    if (!download.ok) return { ok: false, message: `下载失败：${download.message}` }
    if (download.sha256.toLowerCase() !== expected.toLowerCase()) {
      return { ok: false, message: "校验失败：归档 SHA256 与校验文件不一致" }
    }

    const scan = await scanTarGz(archivePath)
    if (!scan.ok) return { ok: false, message: `归档校验失败：${scan.message}` }

    const extractDir = join(workDir, "extract")
    mkdirSync(extractDir, { recursive: true })
    // 相对名 + cwd：GNU tar 见到盘符会当成远程主机
    const tar = await exec("tar", extractArgs(archiveName, "extract"), timeoutMs, { cwd: workDir })
    if (tar.spawnError === "ENOENT") return { ok: false, message: "未找到命令：tar（系统需自带 tar）" }
    if (tar.spawnError === "TIMEOUT") return { ok: false, message: `解压超时（${Math.round(timeoutMs / 1000)}s）` }
    if (tar.code !== 0) return { ok: false, message: summarizeOutput(tar.stdout, tar.stderr, tar.code) }

    const tree = verifyExtractedTree(extractDir)
    if (!tree.ok) return { ok: false, message: tree.message }

    // 下载/校验/解压都在锁外；只有重命名事务需要互斥
    await withDirLock(
      {
        pluginsDir: dirname(pluginDir),
        tool: "update",
        waitMs: deps.lockWaitMs,
        onWarn: (message) => console.warn(`[opencode-hud] ${message}`),
      },
      () => {
        installAtomically(extractDir, pluginDir)
      },
    )
    return { ok: true }
  } catch (error) {
    return { ok: false, message: errorMessage(error) }
  } finally {
    if (workDir) {
      try {
        rmSync(workDir, { recursive: true, force: true })
      } catch {
        // 清理失败不改变已确定的更新结果（Windows 上归档可能正被杀软扫描）
      }
    }
  }
}
