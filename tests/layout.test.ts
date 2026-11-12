// ─── view/layout.ts + Task Inspector：双列展开详情的左右内容必须放得进版心 ───
// 双列布局靠弹性盒对齐，列宽不是常量；这里钉住「左 + 1 列间隔 + 右」的代表性组合，
// 防止文案或字体宽度变化后右侧内容被挤到下一行（表现为展开块悄悄多一行）。
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  AGENT_INSPECTOR_INNER,
  AGENT_TITLE_MAX,
  CARD_INNER,
} from "../.opencode/plugins/opencode-hud/view/layout.ts"
import { visualWidth } from "../.opencode/plugins/opencode-hud/shared/format.ts"

// 与 TwoCol 的布局一致：左列 paddingRight 1 → 至少 1 列间隔
function fits(left: string, right: string): boolean {
  return visualWidth(left) + 1 + visualWidth(right) <= AGENT_INSPECTOR_INNER
}

test("子代理 Task Inspector：三组双列在最窄版心内同行", () => {
  assert.ok(fits("deepseek-v4.1-flash", "high"), "模型 + 强度")
  assert.ok(fits("general", "缓存 100.0%"), "Agent + 缓存命中（最坏值）")
  assert.ok(fits("20.22s", "7625 tok/s"), "TTFT + TPS（最坏值）")
  assert.ok(AGENT_INSPECTOR_INNER < CARD_INNER, "详情版心必须窄于卡片内容（运行中卡片还要减去强调线与内边距）")
  // 主行标题列不能被数字列挤到不可用
  assert.ok(AGENT_TITLE_MAX >= 12, `标题列只剩 ${AGENT_TITLE_MAX} 列，短标题也会频繁截断`)
})
