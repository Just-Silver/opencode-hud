// ─── view/layout.ts + Task Inspector：双列展开详情的左右内容必须放得进版心 ───
// 双列布局靠弹性盒对齐，列宽不是常量；这里钉住「左 + 1 列间隔 + 右」的代表性组合，
// 防止文案或字体宽度变化后右侧内容被挤到下一行（表现为展开块悄悄多一行）。
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  AGENT_INSPECTOR_INNER,
  AGENT_TITLE_MAX,
  CARD_INNER,
  QUOTA_GROUP_NAME_MAX,
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

test("额度组头：箭头 + 名称列 + 状态注记（倒计时/重试）在同一行内", () => {
  // 与 QuotaGroup 一致：箭头 2 + 名称（最多 14）+ 至少 1 列间隔 + 注记
  const headerWidth = (trail: string) => 2 + QUOTA_GROUP_NAME_MAX + 1 + visualWidth(trail)
  const cases = ["↻ 04:32", "↻ 01:00:00", "↻ 更新中", "重试 09:28", "限流 09:28", "凭据失效 09:28", "网络异常 15:00", "旧 12m", "旧 4d"]
  for (const trail of cases) {
    assert.ok(headerWidth(trail) <= CARD_INNER, `组头超宽（${headerWidth(trail)} > ${CARD_INNER}）：${trail}`)
  }
})
