// ─── 模型层：数据模型类型（UI 与查询服务契约的唯一真源） ───

// 额度窗口（5h/周/月 之一）
export type QuotaWindow = { status?: string; percent?: number; resetsAt?: string }

// 供应商额度数据（fetcher 输出 / UI 输入）
export type QuotaData = { rolling?: QuotaWindow; weekly?: QuotaWindow; monthly?: QuotaWindow }

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