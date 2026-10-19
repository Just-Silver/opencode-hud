// ─── 共享/帮助函数：展示格式化（纯函数，全层可引用） ───
import type { QuotaItem } from "../model/types.ts"

// token 数：123.6k / 200k / 28.4k
export function fmtTokens(v: number): string {
  if (v >= 1_000_000) return trimZero((v / 1_000_000).toFixed(1)) + "M"
  if (v >= 1000) return trimZero((v / 1000).toFixed(1)) + "k"
  return String(v)
}

export function trimZero(s: string): string {
  return s.replace(/\.0$/, "")
}

// 百分比统一显示：1 位小数（如 34.8%）
export function fmtPct(v: number | undefined): string {
  return v !== undefined ? `${v.toFixed(1)}%` : ""
}

// 占总量占比（百分数，1 位小数）：v / total × 100
export function sharePct(v: number, total: number): string {
  return total > 0 ? fmtPct((v / total) * 100) : ""
}

// ── 视觉宽度（终端列数）：CJK/全角字符占 2 列，JS 字符串 length 会算错对齐 ──
export function charColumns(c: string): number {
  const code = c.codePointAt(0) ?? 0
  if (code < 0x20) return 0 // 控制字符
  if (code < 0x7f) return 1 // ASCII
  if (code < 0xa0) return 0 // C1 控制字符
  // 宽度歧义符号（East Asian Ambiguous）：等宽字体常无半宽字形，实际按 2 列渲染。
  // 本机实测 "↻"(U+21BB) 会占 2 列，若按 1 列计算 → 字形被裁一半；故显式按 2 列计。
  if (code === 0x21bb) return 2
  // 东亚宽字符 / 全角（CJK、假名、谚文、全角形式、emoji、SIP 汉字）
  if (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe6f) ||
    (code >= 0xff01 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f64f) ||
    (code >= 0x20000 && code <= 0x3fffd)
  )
    return 2
  return 1
}

export function visualWidth(s: string): number {
  let w = 0
  for (const c of s) w += charColumns(c)
  return w
}

// 按终端显示列数左补空格（CJK 按 2 列）：用于定宽右对齐列。
// 背景：flex 行里进度条用 flexGrow 吸收剩余宽度，右侧列宽度若不固定，各行的列位置会随之漂移。
export function padStartVisual(s: string, width: number): string {
  const pad = width - visualWidth(s)
  return pad > 0 ? " ".repeat(pad) + s : s
}

// 按终端显示列数右补空格（CJK 按 2 列）：用于定宽左对齐列（图标/前缀对齐，如 "↻"）。
// 与 padStartVisual 一样保证列宽固定（bar 等长），只是内容贴左。
export function padEndVisual(s: string, width: number): string {
  const pad = width - visualWidth(s)
  return pad > 0 ? s + " ".repeat(pad) : s
}

// 满宽分隔线：1 行 "─" 铺满 width 个终端列。用于区块标题下方的独立分隔线。
export function dividerLine(width: number): string {
  return "─".repeat(Math.max(1, Math.floor(width)))
}

// 额度百分比：原样透传（供应商决定精度）
// percent 契约：0-100 的有限数字（整数或任意小数）。整数显示 42%、小数原样显示 0.36%。
// UI 层零加工 → 新增供应商只需返回真实数值，显示层永远不用改。
export function fmtPctInt(v: number | undefined): string {
  if (v === undefined) return ""
  if (typeof v !== "number" || !Number.isFinite(v)) return "" // 防脏数据：非有限数字不显示
  return `${Math.max(0, Math.min(100, v))}%` // 越界 clamp，防脏数据
}

// 条目可展示百分比：有限数字才画进度条（provider 只在有效时给 percent）
export function quotaPct(item: QuotaItem | undefined): number | undefined {
  const p = item?.percent
  return typeof p === "number" && Number.isFinite(p) ? p : undefined
}

// ── 额度窗口重置时间（ISO 字符串）→ 短文本（本地时区） ──
// 分级：<24h → 本地时刻 HH:MM；<7d → 周X；否则 MM-DD。缺失/非法/已过期 → undefined（不显示）。
// now 可注入便于单测；各供应商可能不返回 resetsAt（如 Command Code），故调用方需容忍 undefined。
const WEEKDAY_CN = ["日", "一", "二", "三", "四", "五", "六"] as const
export function fmtResetTime(iso: string | undefined, now: Date = new Date()): string | undefined {
  if (!iso) return undefined
  const t = new Date(iso)
  const ms = t.getTime()
  if (Number.isNaN(ms)) return undefined
  const diff = ms - now.getTime()
  if (diff <= 0) return undefined // 已到期/已重置：不显示
  if (diff < 24 * 3600_000) {
    return `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`
  }
  if (diff < 7 * 24 * 3600_000) return `周${WEEKDAY_CN[t.getDay()]}`
  return `${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`
}

// 额度重置提示（含刷新图标前缀）：fmtResetTime 有值时返回 "↻ 02:28"，否则 undefined。
// 供 provider 生成 QuotaItem.hint 用（图标在 shared 统一，宽度由 charColumns 按 2 列计）。
export function fmtResetHint(iso: string | undefined, now: Date = new Date()): string | undefined {
  const t = fmtResetTime(iso, now)
  return t ? `↻ ${t}` : undefined
}

// ── 性能指标格式化 ──

// 首字/耗时（秒）：0.83s / 1.23s，始终两位小数（与设计文档一致）
export function fmtSec(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return ""
  return (ms / 1000).toFixed(2) + "s"
}

// 速度：≥10 取整、<10 一位小数（对齐宿主与 dsh 的格式约定）
export function fmtTps(tps: number | undefined): string {
  if (tps === undefined || !Number.isFinite(tps) || tps <= 0) return ""
  const v = tps >= 10 ? Math.round(tps) : Math.round(tps * 10) / 10
  return String(v)
}

// 子代理耗时（短格式）：42s / 1m10s / 1h02m
export function fmtElapsed(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return ""
  const totalSec = Math.round(ms / 1000)
  if (totalSec < 60) return `${totalSec}s`
  const minutes = Math.floor(totalSec / 60)
  const seconds = totalSec % 60
  if (minutes < 60) return `${minutes}m${String(seconds).padStart(2, "0")}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h${String(minutes % 60).padStart(2, "0")}m`
}

// 截断到 maxCols 显示列，超出加省略号（CJK 安全）
export function truncateVisual(s: string, maxCols: number): string {
  if (visualWidth(s) <= maxCols) return s
  if (maxCols <= 1) return "…"
  let out = ""
  let w = 0
  for (const c of s) {
    const cw = charColumns(c)
    if (w + cw > maxCols - 1) break
    out += c
    w += cw
  }
  return out + "…"
}