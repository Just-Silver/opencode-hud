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

// 额度数据的新鲜度状态（展示元信息，不进供应商契约）
export type QuotaPhase = "empty" | "loading" | "ready" | "stale" | "error"

export type QuotaStatus = {
  /** 粗粒度状态：未取到 / 首次请求中 / 新鲜 / 过期 / 失败（有缓存时仍展示缓存） */
  phase: QuotaPhase
  /** 是否有可展示的缓存数据 */
  hasData: boolean
  /** 是否有请求在途 */
  fetching: boolean
  /** 距上次成功写入的毫秒数；从未成功 → undefined */
  ageMs?: number
  /** 成功数据是否已超过新鲜窗口（刷新已失败或长时间未跑到） */
  stale: boolean
  /** 最近一次请求失败的结构化原因（成功/未请求 → undefined） */
  error?: { code: string; status?: number; message: string }
}

// 额度区块的一行「供应商组」：data 来自 store，其余由 Sidebar 计算
export type QuotaRow = {
  pid: string
  name: string
  renderer?: string
  data: QuotaData
  current: boolean
  open: boolean
  status: QuotaStatus
}

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
  time?: PartTime
}

export type PerfMessage = {
  type?: string
  time?: { created?: number; streamed?: number; completed?: number }
  tokens?: TokenLike
  content?: PerfPart[]
  error?: unknown
}

// ── 子代理 ──
// 子会话在 SessionInfo 上的可用字段（宿主 session_v2 聚合列）
// outcome：宿主在 execution 终态（succeeded/failed/interrupted）写入 idle_outcome，
// 仅在 running=false 时代表本次运行的结局（运行中它仍是上一轮的旧值）。
export type SubagentInfo = {
  id: string
  agent?: string
  title?: string
  tokens?: TokenLike
  model?: { id?: string; providerID?: string; variant?: string }
  time?: { created?: number; updated?: number; idle?: number }
  outcome?: "succeeded" | "failed" | "interrupted"
}
