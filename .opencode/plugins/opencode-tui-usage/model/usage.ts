// ─── 模型层：用量聚合与解析纯函数（无 solid/UI 依赖，可单测） ───
import type { MessageLike, UsageData } from "./types.ts"

// 会话全部消息的 token 累加聚合；无任何 token 时返回 undefined
export function aggregateUsage(messages: MessageLike[]): UsageData | undefined {
  let input = 0
  let output = 0
  let reasoning = 0
  let read = 0
  let write = 0
  for (const message of messages) {
    const t = message.tokens
    if (!t) continue
    input += t.input ?? 0
    output += t.output ?? 0
    reasoning += t.reasoning ?? 0
    read += t.cache?.read ?? 0
    write += t.cache?.write ?? 0
  }
  const total = input + output + reasoning + read + write
  if (total <= 0) return
  return { input, output, reasoning, read, write, total }
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

// 上下文的实际占用：取最新一条 assistant 消息的 tokens 求和
// （对齐内置 Context 显示口径，缓存读取是当前请求的上下文复用，不是累计）
export function contextUsageOf(messages: MessageLike[]): number | undefined {
  const last = [...messages].reverse().find((m) => m.tokens)
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

// 上下文上限（进度条比例）：取最后一条含 model.id 的消息，在模型列表中反查 limit.context
export function resolveContextLimit(
  messages: MessageLike[],
  models: Array<{ id: string; limit?: { context?: number } }>,
): number | undefined {
  const last = [...messages].reverse().find((m) => m.model?.id)
  if (!last) return
  return models.find((m) => m.id === last.model!.id)?.limit?.context
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
  const last = [...messages]
    .reverse()
    .find(
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