// ─── ViewModel 片段：更新提示 ───
// 检查本身带磁盘缓存节流（成功 24h / 失败冷却 1h），这里再补一层进程内去重：
// 宿主按会话重建侧边栏，多个实例同时挂载时不应并发检查。
import { createSignal, onCleanup } from "solid-js"
import { checkForUpdate, type UpdateInfo } from "../../update/index.ts"

// 模块级：跨侧边栏重建保持
let pending: Promise<UpdateInfo | undefined> | undefined
let dismissedOnce = false

export function useUpdate() {
  const [update, setUpdate] = createSignal<UpdateInfo | undefined>(undefined)
  const [dismissed, setDismissed] = createSignal(dismissedOnce)
  let disposed = false
  onCleanup(() => {
    disposed = true
  })

  pending ??= checkForUpdate().catch(() => undefined)
  void pending.then((info) => {
    if (!disposed) setUpdate(info)
  })

  const show = () => !dismissed() && update() !== undefined
  const dismiss = () => {
    dismissedOnce = true
    setDismissed(true)
  }

  return { update, show, dismiss }
}
