// ─── 共享/帮助函数：前沿+尾沿节流（纯函数，可注入时钟） ───
// 纯尾沿去抖在连续事件流下会被不断重置、永远不触发；本实现把触发锚定在
// lastFire + interval，突发期间节奏稳定（首个立即触发，之后至多补一次）。

export type ThrottledBumper = {
  bump: () => void
  dispose: () => void
}

export function createThrottledBumper(
  fire: () => void,
  intervalMs: number,
  now: () => number = Date.now,
): ThrottledBumper {
  let last = -Infinity
  let timer: ReturnType<typeof setTimeout> | undefined

  const run = () => {
    last = now()
    fire()
  }

  return {
    bump() {
      const t = now()
      if (t - last >= intervalMs) {
        run()
        return
      }
      if (timer === undefined) {
        timer = setTimeout(() => {
          timer = undefined
          run()
        }, intervalMs - (t - last))
      }
    },
    dispose() {
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
    },
  }
}
