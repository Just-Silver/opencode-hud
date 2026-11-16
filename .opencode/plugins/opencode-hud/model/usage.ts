// ─── 模型层：用量聚合与解析纯函数（无 solid/UI 依赖，可单测） ───
import type { MessageLike, TokenLike, UsageData } from "./types.ts"

function usageOf(input: number, output: number, reasoning: number, read: number, write: number): UsageData | undefined {
  const total = input + output + reasoning + read + write
  if (total <= 0) return
  return { input, output, reasoning, read, write, total }
}

// 会话累计用量：直接取 SessionInfo.tokens（宿主 session_v2 聚合列，覆盖整个会话）。
// 不能用消息求和：宿主按页加载消息，未滚动的历史不在 list() 里，长会话会少算一到两个数量级。
export function usageFromTokens(tokens: TokenLike | undefined): UsageData | undefined {
  if (!tokens) return
  return usageOf(
    tokens.input ?? 0,
    tokens.output ?? 0,
    tokens.reasoning ?? 0,
    tokens.cache?.read ?? 0,
    tokens.cache?.write ?? 0,
  )
}

// 缓存率：cc-switch 口径 = read / (input + write + read)，一位小数
// 抽成按分量计算，供会话聚合用量与子代理的 TokenLike 共用同一口径
export function cacheRateOf(read: number, input: number, write: number): number | undefined {
  const denom = input + write + read
  if (denom <= 0) return
  return Math.round((read / denom) * 1000) / 10
}

export function calcCacheRate(usage: UsageData | undefined): number | undefined {
  if (!usage) return
  return cacheRateOf(usage.read, usage.input, usage.write)
}

// 上下文归属步：对齐宿主 lastAssistantWithUsage——revert 边界内、最后一次已完成 compaction 之后、
// 最后一条带 tokens 的 assistant。边界消息未加载时返回 undefined，不猜更晚的消息。
function contextMessageOf(messages: MessageLike[], boundary?: string): MessageLike | undefined {
  const boundaryIndex = boundary ? messages.findIndex((message) => message.id === boundary) : -1
  if (boundary && boundaryIndex === -1) return
  const end = boundaryIndex === -1 ? messages.length : boundaryIndex

  const compactionIndex = messages.findLastIndex(
    (message, index) => message.type === "compaction" && message.status === "completed" && index < end,
  )

  return messages.findLast(
    (message, index) =>
      message.type === "assistant" && message.tokens !== undefined && index > compactionIndex && index < end,
  )
}

// 上下文的实际占用：取上下文归属步的 tokens 求和（缓存读取是当前请求的上下文复用，不是累计）
export function contextUsageOf(messages: MessageLike[], boundary?: string): number | undefined {
  const last = contextMessageOf(messages, boundary)
  if (!last?.tokens) return
  const t = last.tokens
  return (
    (t.input ?? 0) +
    (t.output ?? 0) +
    (t.reasoning ?? 0) +
    (t.cache?.read ?? 0) +
    (t.cache?.write ?? 0)
  )
}

function nonEmpty(value: string | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

// 上下文上限（进度条比例）：必须与上下文占用取自同一步，并按该步的 provider + model 匹配，
// 避免同名的别家模型（上限可能差数倍）或刚切换、尚未写 tokens 的新步当分母。
export function resolveContextLimit(
  messages: MessageLike[],
  models: Array<{ id: string; providerID?: string; limit?: { context?: number } }>,
  boundary?: string,
): number | undefined {
  const last = contextMessageOf(messages, boundary)
  const modelID = last?.model?.id
  if (!modelID) return

  const providerID = nonEmpty(last.model?.providerID) ?? nonEmpty(last.providerID)
  const model = providerID
    ? models.find((m) => m.providerID === providerID && m.id === modelID)
    : models.find((m) => m.id === modelID)
  return model?.limit?.context
}

// 上下文占用百分比（1 位小数）；limit 缺失/非正不除零
export function calcPercent(total: number | undefined, limit: number | undefined): number | undefined {
  if (total === undefined || limit === undefined) return
  if (limit <= 0) return
  return Math.round((total / limit) * 1000) / 10
}

// 当前会话供应商 ID：message.providerID → model.providerID → model.id 反查（lookupModel 注入）
export function resolveProviderID(
  messages: MessageLike[],
  lookupModel: (id: string) => { providerID?: string } | undefined,
): string | undefined {
  const last = messages.findLast(
    (m) =>
      (typeof m?.providerID === "string" && m.providerID.length > 0) ||
      (typeof m?.model?.providerID === "string" && m.model.providerID.length > 0) ||
      (typeof m?.model?.id === "string" && m.model.id.length > 0),
  )
  if (!last) return undefined
  if (typeof last.providerID === "string" && last.providerID.length > 0) return last.providerID
  if (typeof last.model?.providerID === "string" && last.model.providerID.length > 0) return last.model.providerID
  if (typeof last.model?.id === "string" && last.model.id.length > 0) {
    return lookupModel(last.model.id)?.providerID
  }
  return undefined
}