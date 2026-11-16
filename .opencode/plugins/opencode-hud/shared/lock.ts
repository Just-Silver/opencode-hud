// ─── 共享：插件目录锁（安装 / 更新 / 卸载互斥） ───
// 目录锁用 mkdir 的原子性互斥：目录已存在即失败，不靠 mtime 猜存活、不按年龄破锁。
// 崩溃后会留下无人释放的锁，必须由人工确认后删除锁目录。
import { randomBytes } from "crypto"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs"
import { join } from "path"

export const LOCK_WAIT_MS = 30_000
export const LOCK_POLL_MS = 200
export const LOCK_DIR_NAME = ".opencode-hud.lock"

export function lockDirFor(pluginsDir: string): string {
  return join(pluginsDir, LOCK_DIR_NAME)
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export type DirLockOptions = {
  pluginsDir: string
  tool: "update" | "install" | "uninstall"
  waitMs?: number
  pollMs?: number
  pid?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  onWarn?: (message: string) => void
}

function readToken(lockDir: string): string | undefined {
  try {
    for (const line of readFileSync(join(lockDir, "owner"), "utf8").split(/\r?\n/)) {
      if (line.startsWith("token=")) return line.slice("token=".length).trim()
    }
  } catch {
    // owner 缺失/读不到时无法证明所有权，下面按「不是自己的锁」处理
  }
  return undefined
}

export async function withDirLock<T>(options: DirLockOptions, fn: () => Promise<T> | T): Promise<T> {
  const waitMs = options.waitMs ?? LOCK_WAIT_MS
  const pollMs = options.pollMs ?? LOCK_POLL_MS
  const pid = options.pid ?? process.pid
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? defaultSleep
  const lockDir = lockDirFor(options.pluginsDir)

  // 锁外先确保父目录存在：插件目录不存在时安装要能创建它；这一步不参与互斥
  mkdirSync(options.pluginsDir, { recursive: true })

  const startedAt = now()
  const token = `${pid}-${startedAt}-${randomBytes(8).toString("hex")}`
  let waited = 0
  for (;;) {
    try {
      mkdirSync(lockDir) // 不能加 recursive：目录已存在时抛 EEXIST 才是互斥判据
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      if (waited >= waitMs) {
        throw new Error(
          `获取锁超时（${waitMs}ms，另一安装/更新/卸载正在进行）：${lockDir}；确认没有进程在操作后可手工删除该锁目录`,
        )
      }
      await sleep(pollMs)
      waited += pollMs
    }
  }

  try {
    writeFileSync(join(lockDir, "owner"), `tool=${options.tool}\npid=${pid}\nstartedAt=${startedAt}\ntoken=${token}\n`)
  } catch (error) {
    // 刚创建的锁没有 owner 就无法证明所有权，必须立刻收回，否则它会永久挡住后续操作
    try {
      rmSync(lockDir, { recursive: true, force: true })
    } catch {
      // 收不回时保留现场，交给人工删除
    }
    throw error
  }

  try {
    return await fn()
  } finally {
    if (readToken(lockDir) === token) {
      try {
        rmSync(lockDir, { recursive: true, force: true })
      } catch (error) {
        options.onWarn?.(`未能释放目录锁：${lockDir}（${error instanceof Error ? error.message : String(error)}）`)
      }
    } else {
      options.onWarn?.(`锁目录已不属于本次操作，未释放：${lockDir}`)
    }
  }
}
