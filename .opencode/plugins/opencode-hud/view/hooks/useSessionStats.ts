// ─── ViewModel 片段：当前会话的用量 / 上下文 / 模型 ───
// 只做「宿主投影 → 纯函数 → memo」的编排；口径全部在 model/usage.ts。
// 全部取值放在 memo 内，随宿主 Solid store 变化自动重算。
import { createMemo } from "solid-js"
import { usePlugin } from "@opencode/plugin/tui"
import type { MessageLike, TokenLike } from "../../model/types.ts"
import {
  aggregateUsage,
  calcCacheRate,
  calcPercent,
  contextUsageOf,
  resolveContextLimit,
  resolveProviderID,
  usageFromTokens,
} from "../../model/usage.ts"

// 宿主 SessionInfo 的实际字段远多于这里用到的；只声明读取的部分
type SessionShape = {
  location?: string
  tokens?: TokenLike
}

export function useSessionStats(sessionID: string | undefined) {
  const ctx = usePlugin()

  const messages = () => (sessionID ? (ctx.data.session.message.list(sessionID) ?? []) : [])
  const session = () => (sessionID ? (ctx.data.session.get(sessionID) as SessionShape | undefined) : undefined)
  const models = () => {
    const location = session()?.location
    return location ? (ctx.data.location.model.list(location) ?? []) : []
  }

  // 会话累计：宿主聚合列（全量）优先，缺失时才退回已加载消息窗口（见 docs/token-accounting.md）
  const usage = createMemo(() => {
    if (!sessionID) return
    return usageFromTokens(session()?.tokens) ?? aggregateUsage(messages() as MessageLike[])
  })
  const cacheRate = createMemo(() => calcCacheRate(usage()))
  const ctxUsage = createMemo(() => (sessionID ? contextUsageOf(messages() as MessageLike[]) : undefined))
  const limit = createMemo(() => {
    if (!sessionID || ctxUsage() === undefined) return
    if (!session()) return
    return resolveContextLimit(messages() as MessageLike[], models())
  })
  const ctxPct = createMemo(() => calcPercent(ctxUsage(), limit()))

  const providerID = createMemo(() => {
    if (!sessionID) return
    return resolveProviderID(messages() as MessageLike[], (id) => models().find((m) => m.id === id)?.providerID)
  })

  return { usage, cacheRate, ctxUsage, limit, ctxPct, providerID }
}
