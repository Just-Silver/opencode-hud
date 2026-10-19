// ─── 实时性能服务：纯记录器 + Solid 版本信号（组件侧订阅点） ───
// 纯逻辑在 live/recorder.ts（可单测）；本文件只负责把 onChange 接到 solid 信号上。
import { createSignal } from "solid-js"
import type { LivePerf } from "../model/perf.ts"
import { createRecorder, type HostLike, type Recorder } from "./recorder.ts"

export type LivePerfSource = Recorder & {
  // 版本信号：组件在 memo 里读它即订阅（bump 时重算）
  version: () => number
}

function createSource(host: HostLike): LivePerfSource {
  // 单一版本号：所有订阅方共用一个响应式依赖
  const [version, setVersion] = createSignal(0)
  const recorder = createRecorder(host, () => setVersion((v) => v + 1))
  return {
    ...recorder,
    version,
  }
}

// 进程内单例（deps 仅首次创建生效，与 quota store 同策略）
let singleton: LivePerfSource | undefined
export function getLivePerfSource(host: HostLike): LivePerfSource {
  if (!singleton) singleton = createSource(host)
  return singleton
}

// 供测试 / 热重载使用
export function resetLivePerfSource(): void {
  singleton?.dispose()
  singleton = undefined
}
