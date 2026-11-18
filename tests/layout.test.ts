// ─── view/layout.ts + Task Inspector：双列展开详情的左右内容必须放得进版心 ───
// 双列布局靠弹性盒对齐，列宽不是常量；这里钉住「左 + 1 列间隔 + 右」的代表性组合，
// 防止文案或字体宽度变化后右侧内容被挤到下一行（表现为展开块悄悄多一行）。
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  AGENT_COUNT_NUM_WIDTH,
  AGENT_INSPECTOR_INNER,
  AGENT_RUNNING_INNER,
  AGENT_TITLE_MAX,
  AGENT_TOTAL_WIDTH,
  CARD_INNER,
  QUOTA_GROUP_NAME_MAX,
} from "../.opencode/plugins/opencode-hud/view/layout.ts"
import { padStartVisual, visualWidth } from "../.opencode/plugins/opencode-hud/shared/format.ts"

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

test("运行中卡片：耗时 · 消耗（左）与缓存率（右）在 30 列内同行", () => {
  const left = "58m05s · 999.9k"
  const right = "缓存 100.0%"
  assert.ok(
    visualWidth(left) + 1 + visualWidth(right) <= AGENT_RUNNING_INNER,
    `左右两列占 ${visualWidth(left) + 1 + visualWidth(right)} 列，超出运行中块内宽 ${AGENT_RUNNING_INNER}`,
  )
})

test("运行中卡片：Agent·供应商、模型·强度 两组双列在 30 列内同行", () => {
  assert.ok(
    visualWidth("explore") + 1 + visualWidth("Open Design") <= AGENT_RUNNING_INNER,
    "agent + 供应商名",
  )
  assert.ok(
    visualWidth("DeepSeek V4.1 Flash") + 1 + visualWidth("xhigh") <= AGENT_RUNNING_INNER,
    "模型显示名 + 强度（最坏值）",
  )
})

test("额度组头：箭头 + 名称列 + 状态注记（倒计时/重试）在同一行内", () => {
  // 与 QuotaGroup 一致：箭头 2 + 名称（最多 14）+ 至少 1 列间隔 + 注记
  const headerWidth = (trail: string) => 2 + QUOTA_GROUP_NAME_MAX + 1 + visualWidth(trail)
  const cases = ["↻ 04:32", "↻ 01:00:00", "↻ 更新中", "重试 09:28", "限流 09:28", "凭据失效 09:28", "网络异常 15:00", "旧 12m", "旧 4d"]
  for (const trail of cases) {
    assert.ok(headerWidth(trail) <= CARD_INNER, `组头超宽（${headerWidth(trail)} > ${CARD_INNER}）：${trail}`)
  }
})

// 卡片头（三个状态胶囊 + 合计）必须一行放下：超宽会被 flexShrink 裁掉计数，而不是换行。
// 取最坏值：三个胶囊都是 999、合计是最长的 999.9M（失败为 0 时只有两个胶囊，已被覆盖）。
test("子代理卡片头：三个胶囊与合计在最坏值下仍同行", () => {
  const capsule = (n: number) => `● ${padStartVisual(String(n), AGENT_COUNT_NUM_WIDTH)} `
  const left = [capsule(999), capsule(999), capsule(999)].join(" ")
  const right = "合计" + " " + padStartVisual("999.9M", AGENT_TOTAL_WIDTH)
  const used = visualWidth(left) + 1 + visualWidth(right)
  assert.ok(used <= CARD_INNER, `卡片头占 ${used} 列，超出卡片内容 ${CARD_INNER} 列`)
})
