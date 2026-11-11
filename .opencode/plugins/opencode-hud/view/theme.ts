// ─── UI 层：调色板与颜色判定（OpenCode Native Pro） ───
// 中性黑灰为主、琥珀强调、少量功能性色彩；固定暗色，不跟随 ctx.theme（观感稳定）。
// 分层：canvas（面板底）→ card（卡片底）→ raised（指标块/运行中任务）。
// 颜色纪律：琥珀只给品牌强调与上下文主指标；绿/红只表达真实状态；百分比不要一律涂绿。

// 颜色阈值（上下文占用 / 额度已用占比）
export const PCT_WARN_THRESHOLD = 50 // ≥50% 变橙
export const PCT_ERROR_THRESHOLD = 85 // ≥85% 变红

// ── OpenCode Native Pro 调色板 ──
export const CARD_COLOR = "#191919" // 卡片底 / HUD 连续表面
export const RAISED_COLOR = "#242424" // 指标块 / 运行中任务 / 更新横幅
export const TRACK_COLOR = "#363636" // 进度条轨道
export const BORDER_COLOR = "#303030" // 卡片边框 / 展开区竖线
export const ACCENT_COLOR = "#FAB283" // 琥珀主色（标题、上下文主进度、当前供应商）
export const TEXT_COLOR = "#EEEEEE" // 主文本 / 数值
export const SECONDARY_COLOR = "#A9A9A9" // 次级文本
export const MUTED_COLOR = "#858585" // 标签 / 单位 / 弱化注记
export const INPUT_COLOR = "#76A9E0" // token 输入分量
export const OUTPUT_COLOR = "#B99AF7" // token 输出分量
export const CACHE_COLOR = "#65BFA6" // token 缓存分量
export const SUCCESS_COLOR = "#86C89A" // 正常运行 / 成功
export const WARNING_COLOR = "#E5A05A" // 中风险 / 中断
export const ERROR_COLOR = "#E06C75" // 真实错误 / 高风险

// 区块标题（TUI 展示文案，用中文）
export const SECTION_CONTEXT_TITLE = "上下文"
export const SECTION_QUOTA_TITLE = "额度"
export const SECTION_SUBAGENT_TITLE = "子代理"

// 上下文主指标：琥珀是常态强调，只有接近上限才转危险色
export function contextColor(pct: number | undefined): string {
  if (pct === undefined) return MUTED_COLOR
  if (pct >= PCT_ERROR_THRESHOLD) return ERROR_COLOR
  return ACCENT_COLOR
}

// 「已用占比」的语义色：低占用是中性灰（不暗示成功），中段警告，高档危险。
// 用于额度条目与折叠摘要——绿色的「成功」含义留给真实正常状态，不铺给所有百分比。
export function usageColor(pct: number | undefined): string {
  if (pct === undefined) return MUTED_COLOR
  if (pct >= PCT_ERROR_THRESHOLD) return ERROR_COLOR
  if (pct >= PCT_WARN_THRESHOLD) return WARNING_COLOR
  return SECONDARY_COLOR
}
