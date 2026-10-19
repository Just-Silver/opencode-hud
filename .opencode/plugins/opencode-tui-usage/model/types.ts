// ─── 模型层：数据模型类型（UI 与查询服务契约的唯一真源） ───

// 额度条目（渲染原语；数量/顺序/标签/形态全部由 provider 决定，UI 不预设窗口）
// - percent：有 → 进度条 + 百分比（0-100，供应商决定精度）
// - text：无 percent 时的值文本（如 "$12.34" / "不限" / "19/100"），右对齐
// - hint：行尾弱化注记（自由文本，如 "↻ 周一"）；provider 用 shared/format 自行格式化
export type QuotaItem = {
  label: string
  percent?: number
  text?: string
  hint?: string
}

// 供应商额度数据（fetcher 输出 / UI 输入）：items 顺序即渲染顺序；空数组 → 不显示额度区块
export type QuotaData = { items: QuotaItem[] }

// 会话用量聚合
export type UsageData = {
  input: number
  output: number
  reasoning: number
  read: number
  write: number
  total: number
}

// 会话消息的结构化子集（tokens / provider / model 字段），供纯函数解析
export type MessageLike = {
  tokens?: {
    input?: number
    output?: number
    reasoning?: number
    cache?: { read?: number; write?: number }
  }
  providerID?: string
  model?: { id?: string; providerID?: string }
}

// ── 性能指标（首字 / 速度） ──
// v2 assistant 消息的子集：一条消息 = 一步，content 内含 text/reasoning/tool
export type TokenLike = {
  input?: number
  output?: number
  reasoning?: number
  cache?: { read?: number; write?: number }
}

export type PartTime = { created?: number; ran?: number; completed?: number }

export type PerfPart = {
  type?: string
  text?: string
  time?: PartTime
  state?: { status?: string; input?: unknown; time?: PartTime }
}

export type PerfMessage = {
  id?: string
  type?: string
  time?: { created?: number; streamed?: number; completed?: number }
  tokens?: TokenLike
  model?: { id?: string; providerID?: string; variant?: string }
  content?: PerfPart[]
  error?: unknown
}

// ── 子代理 ──
// 子会话在 SessionInfo 上的可用字段（宿主 session_v2 聚合列）
export type SubagentInfo = {
  id: string
  agent?: string
  title?: string
  tokens?: TokenLike
  model?: { id?: string; providerID?: string; variant?: string }
  time?: { created?: number; updated?: number; idle?: number }
}