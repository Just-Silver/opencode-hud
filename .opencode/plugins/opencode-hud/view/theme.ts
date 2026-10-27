// ─── UI 层：调色板与颜色判定 ───
// 固定采用 opencode 默认主题配色（暗色系），不跟随 ctx.theme（设计决策：观感稳定）。
// 色值取自 opencode 官方主题 assets/opencode.json 的 defs.dark* 段：
//   packages/tui/src/theme/assets/opencode.json（sst/opencode）

// 颜色阈值（上下文占用 / 配额占比）
export const PCT_WARN_THRESHOLD = 50 // ≥50% 变橙
export const PCT_ERROR_THRESHOLD = 85 // ≥85% 变红

// opencode 调色板
export const PRIMARY_COLOR = "#fab283" // 区块标题（primary 橙金）
export const TEXT_COLOR = "#eeeeee" // 正文标签（text）
export const MUTED_COLOR = "#808080" // 弱化文本 / 箭头（textMuted）
export const INPUT_COLOR = "#7fd88f" // 成功绿（进度 <50%）
export const WARN_COLOR = "#f5a742" // 警告橙（进度 ≥50%）
export const ERROR_COLOR = "#e06c75" // 错误红（进度 ≥85%）
export const BORDER_COLOR = "#484848" // 面板边框（border）
export const DIVIDER_COLOR = "#3c3c3c" // 区块分隔线（borderSubtle）
export const TRACK_COLOR = "#1e1e1e" // 进度条轨道（backgroundElement）

// 区块标题（额度区块；行标签由 provider 自定，见 model/types.ts QuotaItem）
export const SECTION_CACHE_TITLE = "会话"
export const SECTION_QUOTA_TITLE = "额度"
export const SECTION_SUBAGENT_TITLE = "子代理"

// 进度条颜色：<50% 绿 → ≥50% 橙 → ≥85% 红
// （pct 未定义 = 无数据 → 弱化灰）
export function pctColor(pct: number | undefined): string {
  if (pct === undefined) return MUTED_COLOR
  if (pct >= PCT_ERROR_THRESHOLD) return ERROR_COLOR
  if (pct >= PCT_WARN_THRESHOLD) return WARN_COLOR
  return INPUT_COLOR
}
