// ─── UI 层：侧边栏几何常量（字符列，单一真源） ───
// 宿主侧栏宽度硬编码 42（packages/tui/src/ui/layout.ts 的 SESSION_SIDEBAR_WIDTH），
// 去掉宿主 padding 4 与 scrollbox 预留的 1 列 → 本插件可用 37 列。
//
// 卡片带一圈圆角边框（1 列）+ 左右内边距（各 1 列）→ 卡片内容 33 列。
// 不要改成 onSizeChange 实测：首帧测量为 0，标题会在两种截断宽度间闪一次；
// 宿主也不支持调宽，所以这里只能是常量。

export const HUD_WIDTH = 37
/** 卡片圆角边框占用（左右各 1 列） */
export const CARD_BORDER = 1
/** 卡片左右内边距 */
export const CARD_PADDING = 1
/** 卡片内容宽度 */
export const CARD_INNER = HUD_WIDTH - (CARD_BORDER + CARD_PADDING) * 2

// ── Context 卡片 ──
export const TOKEN_LABEL_WIDTH = 8 // 「缓存写」= 6，留 2 列呼吸
export const TOKEN_VALUE_WIDTH = 9
export const TOKEN_SHARE_WIDTH = 6

// ── 子代理 ──
// 已停止行：箭头 2 + 结局点 2 + 标题 + 垫片 + 耗时 6 + 空格 1 + 消耗 6
export const AGENT_STOPPED_LEAD = 4
export const AGENT_ELAPSED_WIDTH = 6 // 「58m05s」最长
export const AGENT_TOKENS_WIDTH = 6 // 「999.9k」最长
export const AGENT_TAIL = AGENT_ELAPSED_WIDTH + 1 + AGENT_TOKENS_WIDTH
export const AGENT_TITLE_MAX = CARD_INNER - AGENT_STOPPED_LEAD - AGENT_TAIL - 1
// 运行中块：左侧强调线 1 + 左右内边距 2 → 内容 30；行首 spinner 2 + 右侧箭头 1
export const AGENT_RUNNING_INNER = CARD_INNER - 3
export const AGENT_RUNNING_TITLE_MAX = AGENT_RUNNING_INNER - 2 - 2
// 展开行：缩进 2 + 标签 4 + 空格 1 = 7；运行中块内宽 30，展开值上限取 23
// （按 33 − 7 = 26 会撑出运行中块 3 列，两处共用这个更保守的上限）
export const AGENT_DETAIL_MAX = 23

// ── 额度组 ──
export const QUOTA_INDENT = 2
export const QUOTA_GROUP_NAME_MAX = 14
