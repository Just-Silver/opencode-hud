// ─── shared/ 共享帮助函数单元测试 ───
import { test } from "node:test"
import assert from "node:assert/strict"
import { dividerLine, fmtPct, fmtPctInt, fmtResetHint, fmtResetTime, fmtTokens, padEndVisual, padStartVisual, quotaPct, sharePct, trimZero, visualWidth } from "../.opencode/plugins/opencode-tui-usage/shared/format.ts"
import { normID } from "../.opencode/plugins/opencode-tui-usage/shared/id.ts"
import { parseJson } from "../.opencode/plugins/opencode-tui-usage/shared/jsonc.ts"

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
  assert.equal(trimZero("200.0"), "200")
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

// ─── fmtResetTime：重置时间分级（本地时区；now 注入保证确定性） ───
test("fmtResetTime：<24h 时刻 / <7d 周X / 否则 MM-DD / 异常与过期不显示", () => {
  const now = new Date(2026, 9, 12, 10, 0, 0) // 本地 2026-10-12 10:00（周一）
  const at3h = new Date(now.getTime() + 3 * 3600_000)
  assert.equal(fmtResetTime(at3h.toISOString(), now), "13:00")
  const in3d = new Date(now.getTime() + 3 * 24 * 3600_000)
  assert.equal(fmtResetTime(in3d.toISOString(), now), "周四")
  const in20d = new Date(2026, 10, 1, 0, 0, 0) // 本地 2026-11-01
  assert.equal(fmtResetTime(in20d.toISOString(), now), "11-01")
  assert.equal(fmtResetTime(undefined, now), undefined)
  assert.equal(fmtResetTime("nope", now), undefined)
  assert.equal(fmtResetTime(new Date(now.getTime() - 1000).toISOString(), now), undefined) // 已过期
})

// ─── fmtResetHint：重置时间 + ↻ 前缀（provider 生成 QuotaItem.hint 用） ───
test("fmtResetHint：有值时加 ↻ 前缀，无值/过期 → undefined", () => {
  const now = new Date(2026, 9, 12, 10, 0, 0)
  const at3h = new Date(now.getTime() + 3 * 3600_000)
  assert.equal(fmtResetHint(at3h.toISOString(), now), "↻ 13:00")
  assert.equal(fmtResetHint(undefined, now), undefined)
  assert.equal(fmtResetHint("nope", now), undefined)
  assert.equal(fmtResetHint(new Date(now.getTime() - 1000).toISOString(), now), undefined)
})