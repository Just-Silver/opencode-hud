// ─── shared/ 共享帮助函数单元测试 ───
import { test } from "node:test"
import assert from "node:assert/strict"
import { dividerLine, fmtPct, fmtPctInt, fmtPerf, fmtResetHint, fmtResetTime, fmtTokens, fmtTpsText, padEndVisual, padStartVisual, fmtAge, quotaPct, quotaSummaryText, sharePct, trimZero, visualWidth } from "../.opencode/plugins/opencode-hud/shared/format.ts"
import { normID } from "../.opencode/plugins/opencode-hud/shared/id.ts"
import { parseJson } from "../.opencode/plugins/opencode-hud/shared/jsonc.ts"

// ─── id：normID 归一化矩阵 ───
test("normID：小写 + 只留 [a-z]，任意写法归一", () => {
  assert.equal(normID("opencode-go"), "opencodego")
  assert.equal(normID("opencode_go"), "opencodego")
  assert.equal(normID("Opencode-Go"), "opencodego")
  assert.equal(normID("opencode2go"), "opencodego")
  assert.equal(normID("command-code"), "commandcode")
  assert.equal(normID("anthropic"), "anthropic")
  assert.equal(normID(""), "")
})

// ─── jsonc：parseJson ───
test("parseJson：纯 JSON / JSONC 注释尾逗号 / 无效文本", () => {
  assert.deepEqual(parseJson('{"a":1}'), { a: 1 })
  assert.deepEqual(
    parseJson(`{
  // 行注释
  "a": 1, /* 块注释 */
  "b": [1, 2,],
}`),
    { a: 1, b: [1, 2] },
  )
  assert.equal(parseJson("{oops"), undefined)
})

// ─── format ───
test("fmtTokens：千分/百万缩写", () => {
  assert.equal(fmtTokens(123), "123")
  assert.equal(fmtTokens(123600), "123.6k")
  assert.equal(fmtTokens(200000), "200k")
  assert.equal(fmtTokens(2840000), "2.8M")
  assert.equal(fmtTokens(999949), "999.9k")
  assert.equal(fmtTokens(999999), "1M")
  assert.equal(fmtTokens(Number.NaN), "")
  assert.equal(trimZero("200.0"), "200")
})

test("fmtPerf：首字与速度按底部格式拼接，缺项省略", () => {
  assert.equal(fmtPerf(420, 48), "0.42s · 48 tok/s")
  assert.equal(fmtPerf(420, 48.2), "0.42s · 48 tok/s") // fmtTps 对 ≥10 取整
  assert.equal(fmtPerf(420, undefined), "0.42s")
  assert.equal(fmtPerf(undefined, 8.4), "8.4 tok/s")
  assert.equal(fmtPerf(undefined, undefined), "")
  assert.equal(fmtTpsText(48), "48 tok/s")
  assert.equal(fmtTpsText(undefined), "")
})

test("fmtPct / sharePct / fmtPctInt / quotaPct", () => {
  assert.equal(fmtPct(34.8), "34.8%")
  assert.equal(fmtPct(undefined), "")
  assert.equal(sharePct(50, 200), "25.0%")
  assert.equal(sharePct(50, 0), "")
  assert.equal(fmtPctInt(42.4), "42.4%")
  assert.equal(fmtPctInt(42), "42%")
  assert.equal(fmtPctInt(0.4), "0.4%")
  assert.equal(fmtPctInt(0.36), "0.36%")
  assert.equal(fmtPctInt(0), "0%")
  assert.equal(fmtPctInt(undefined), "")
  assert.equal(fmtPctInt(NaN), "")
  assert.equal(fmtPctInt(Infinity), "")
  assert.equal(fmtPctInt(150), "100%") // clamp 越界
  assert.equal(fmtPctInt(-5), "0%")
  assert.equal(quotaPct({ label: "5h", percent: 42 }), 42)
  assert.equal(quotaPct({ label: "5h" }), undefined)
  assert.equal(quotaPct({ label: "5h", percent: NaN }), undefined)
  assert.equal(quotaPct({ label: "余额", text: "$1" }), undefined)
  assert.equal(quotaPct(undefined), undefined)
})

// ─── visualWidth：CJK 占 2 列 ───
test("visualWidth：ASCII 1 列、中文/全角 2 列", () => {
  assert.equal(visualWidth(""), 0)
  assert.equal(visualWidth("abc"), 3)
  assert.equal(visualWidth("会话"), 4) // CJK 每字 2 列
  assert.equal(visualWidth("5h"), 2)
  assert.equal(visualWidth("（12.3k）"), 2 + 5 + 2) // 全角括号各 2 列，"12.3k" 5 字符
  assert.equal(visualWidth("↻"), 2) // 宽度歧义符号按 2 列（等宽字体无半宽字形，按 1 算会被裁）
  assert.equal(visualWidth("↻02:28"), 2 + 5)
})

// ─── padStartVisual：按显示列定宽右对齐 ───
test("padStartVisual：按显示列左补空格（CJK 算 2 列）", () => {
  assert.equal(padStartVisual("02:28", 6), " 02:28") // 5 列 → 补 1
  assert.equal(padStartVisual("11-12", 6), " 11-12")
  assert.equal(padStartVisual("周一", 6), "  周一") // 4 列 → 补 2
  assert.equal(padStartVisual("", 6), "      ") // 空占位保持定宽
  assert.equal(padStartVisual("abcdefg", 6), "abcdefg") // 超宽不截断
})

// ─── padEndVisual：按显示列定宽左对齐 ───
test("padEndVisual：按显示列右补空格（图标/前缀对齐列）", () => {
  assert.equal(padEndVisual("↻ 02:28", 8), "↻ 02:28") // 8 列 → 不补
  assert.equal(padEndVisual("↻ 周一", 8), "↻ 周一 ") // 7 列 → 补 1（尾空格）
  assert.equal(padEndVisual("", 8), "        ")
  assert.equal(padEndVisual("abcdefghi", 8), "abcdefghi") // 超宽不截断
})

// ─── dividerLine：分隔线宽度 ───
test("dividerLine：按宽度重复，最少 1 个字符", () => {
  assert.equal(dividerLine(30), "─".repeat(30))
  assert.equal(dividerLine(30).length, 30)
  assert.equal(dividerLine(0).length, 1) // 宽度未测量（首帧 0）→ 至少 1 个
  assert.equal(dividerLine(-5).length, 1)
})

// ─── fmtResetTime：相对剩余时长（分 / 时 / 天，向下取整） ───
test("fmtResetTime：相对剩余时长，过期/非法不显示", () => {
  const now = new Date(2026, 9, 12, 10, 0, 0) // 本地 2026-10-12 10:00
  const at = (ms: number) => new Date(now.getTime() + ms).toISOString()
  assert.equal(fmtResetTime(at(59_000), now), "0m") // 向下取整：不满 1 分钟
  assert.equal(fmtResetTime(at(60_000), now), "1m")
  assert.equal(fmtResetTime(at(59 * 60_000), now), "59m")
  assert.equal(fmtResetTime(at(3600_000), now), "1h") // 整点不写 0m
  assert.equal(fmtResetTime(at((4 * 60 + 12) * 60_000), now), "4h12m")
  assert.equal(fmtResetTime(at((23 * 60 + 59) * 60_000), now), "23h59m")
  assert.equal(fmtResetTime(at(24 * 3600_000), now), "1d")
  assert.equal(fmtResetTime(at((29 * 24 + 23) * 3600_000), now), "29d") // 天数向下取整
  assert.equal(fmtResetTime(undefined, now), undefined)
  assert.equal(fmtResetTime("nope", now), undefined)
  assert.equal(fmtResetTime(at(-1000), now), undefined) // 已过期
})

// ─── fmtResetHint：重置时间 + ↻ 前缀（provider 生成 QuotaItem.hint 用） ───
test("fmtResetHint：有值时加 ↻ 前缀，无值/过期 → undefined", () => {
  const now = new Date(2026, 9, 12, 10, 0, 0)
  const at = (ms: number) => new Date(now.getTime() + ms).toISOString()
  assert.equal(fmtResetHint(at(3 * 3600_000), now), "↻ 3h")
  assert.equal(fmtResetHint(undefined, now), undefined)
  assert.equal(fmtResetHint("nope", now), undefined)
  assert.equal(fmtResetHint(at(-1000), now), undefined)
})
test("quotaSummaryText：标签 + 百分比/文本，带重置提示时一并显示", () => {
  assert.equal(quotaSummaryText({ label: "5h", percent: 36, hint: "↻18:07" }), "5h 36% ↻18:07")
  assert.equal(quotaSummaryText({ label: "周", percent: 69 }), "周 69%")
  assert.equal(quotaSummaryText({ label: "余额", text: "$12.3" }), "余额 $12.3")
  assert.equal(quotaSummaryText(undefined), "")
})

// ─── fmtAge：数据新鲜度短格式 ───
test("fmtAge：刚刚 / 分钟 / 小时 / 天（只做展示，不参与计算）", () => {
  assert.equal(fmtAge(0), "刚刚")
  assert.equal(fmtAge(59_000), "刚刚")
  assert.equal(fmtAge(60_000), "1m")
  assert.equal(fmtAge(59 * 60_000), "59m")
  assert.equal(fmtAge(60 * 60_000), "1h")
  assert.equal(fmtAge(2.44 * 3600_000), "2.4h")
  assert.equal(fmtAge(30 * 3600_000), "1d")
  assert.equal(fmtAge(undefined), "")
  assert.equal(fmtAge(-1), "")
})
