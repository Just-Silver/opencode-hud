// ─── ViewModel 片段：当前会话的用量 / 上下文 / 模型 ───
// 只做「宿主投影 → 纯函数 → memo」的编排；口径全部在 model/usage.ts。
// 全部取值放在 memo 内，随宿主 Solid store 变化自动重算。
import { createMemo } from "solid-js"
import { usePlugin } from "@opencode/plugin/tui"
import type { MessageLike, TokenLike } from "../../model/types.ts"
import {
  calcCacheRate,
  calcPercent,
  contextUsageOf,
  resolveContextLimit,
  resolveProviderID,
  usageFromTokens,
} from "../../model/usage.ts"

// 宿主 SessionInfo 的实际字段远多于这里用到的；只声明读取的部分
type SessionShape = {
  location?: { directory: string; workspaceID?: string }
  tokens?: TokenLike
  revert?: { messageID?: string }
}

// sessionID 传 getter：组件体只执行一次，传值会把下游 memo 钉在首帧的会话上。
export function useSessionStats(sessionID: () => string | undefined) {
  const ctx = usePlugin()

  // 一轮重算里有多个指标要读同一份列表：message.list / location.model.list 每次都走宿主投影，
  // 不 memo 化会在 usage、上下文、限额、供应商四处各取一遍。
  const messages = createMemo<MessageLike[]>(() => {
    const id = sessionID()
    return id ? ((ctx.data.session.message.list(id) ?? []) as MessageLike[]) : []
  })
  const session = createMemo(() => {
    const id = sessionID()
    return id ? (ctx.data.session.get(id) as SessionShape | undefined) : undefined
  })
  const models = createMemo(() => {
    const location = session()?.location
    return location ? (ctx.data.location.model.list(location) ?? []) : []
  })

  // 会话累计：只取宿主聚合列（全量）；消息窗口分页加载，禁止求和（见 docs/token-accounting.md）
  const usage = createMemo(() => {
    if (!sessionID()) return
    return usageFromTokens(session()?.tokens)
  })
  const cacheRate = createMemo(() => calcCacheRate(usage()))
  const revertBoundary = createMemo(() => session()?.revert?.messageID)
  const ctxUsage = createMemo(() => (sessionID() ? contextUsageOf(messages(), revertBoundary()) : undefined))
  const limit = createMemo(() => {
    if (!sessionID() || ctxUsage() === undefined) return
    if (!session()) return
    return resolveContextLimit(messages(), models(), revertBoundary())
  })
  const ctxPct = createMemo(() => calcPercent(ctxUsage(), limit()))

  const providerID = createMemo(() => {
    if (!sessionID()) return
    return resolveProviderID(messages(), (id) => models().find((m) => m.id === id)?.providerID)
  })

  return { usage, cacheRate, ctxUsage, limit, ctxPct, providerID }
}
