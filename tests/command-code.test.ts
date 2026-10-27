// ─── quota/command-code.ts mapCommandCode 单元测试（离线，零网络） ───
// 契约：QuotaData = { items: QuotaItem[] }（标签/顺序由 provider 定义）
import { test } from "node:test"
import assert from "node:assert/strict"
import { mapCommandCode } from "../.opencode/plugins/opencode-hud/quota/providers/command-code.ts"
import type { QuotaData } from "../.opencode/plugins/opencode-hud/model/types.ts"

// 按标签取百分比（条目顺序由 provider 决定，断言按语义取）
const pct = (q: QuotaData | undefined, label: string): number | undefined =>
  q?.items.find((i) => i.label === label)?.percent

// 构造有数据的正常响应
const creditsWithData = {
  credits: { monthlyCredits: 28 },
  windowLimits: {
    fiveHour: { used: 19, cap: 100 },
    weekly: { used: 21, cap: 100 },
  },
}
const subGoat = { success: true, data: { planId: "individual-goat", currentPeriodEnd: "2026-09-24T00:00:00Z" } }

test("正常数据：三窗口百分比正确（planId 命中映射 → 月度）", () => {
  // monthly: cap=70(goat), 已用=70-28=42 → 42/70=60%
  const q = mapCommandCode(creditsWithData, subGoat)
  assert.deepEqual(q, {
    items: [
      { label: "5h", percent: 19 },
      { label: "周", percent: 21 },
      { label: "月", percent: 60 },
    ],
  })
})

test("窗口 used>cap：clamp 到 100", () => {
  const q = mapCommandCode(
    {
      credits: { monthlyCredits: 0 },
      windowLimits: { fiveHour: { used: 150, cap: 100 }, weekly: { used: 200, cap: 100 } },
    },
    subGoat,
  )
  assert.equal(pct(q, "5h"), 100)
  assert.equal(pct(q, "周"), 100)
})

test("窗口字段缺失/为 null → 对应条目缺失", () => {
  const q = mapCommandCode(
    {
      credits: { monthlyCredits: 10 },
      windowLimits: { fiveHour: null, weekly: undefined, limited: false },
    },
    subGoat,
  )
  assert.equal(pct(q, "5h"), undefined)
  assert.equal(pct(q, "周"), undefined)
  assert.equal(pct(q, "月"), 85.7) // 月窗口不受影响：(70-10)/70 = 85.7 → 保留一位小数
})

test("subscriptions data=null → 月缺失，5h/周照常", () => {
  const q = mapCommandCode(creditsWithData, { success: true, data: null })
  assert.equal(pct(q, "月"), undefined)
  assert.equal(pct(q, "5h"), 19)
  assert.equal(pct(q, "周"), 21)
})

test("subscriptions 失败降级（undefined 传入）→ 5h/周照常", () => {
  const q = mapCommandCode(creditsWithData, undefined)
  assert.equal(pct(q, "5h"), 19)
  assert.equal(pct(q, "周"), 21)
  assert.equal(pct(q, "月"), undefined)
})

test("planId 未知 → 月缺失（映射未命中静默）", () => {
  const q = mapCommandCode(creditsWithData, { success: true, data: { planId: "individual-hype-tier" } })
  assert.equal(pct(q, "月"), undefined)
  assert.equal(pct(q, "5h"), 19)
})

test("余额异常（>cap）→ 月缺失", () => {
  const q = mapCommandCode(
    { credits: { monthlyCredits: 999 }, windowLimits: { fiveHour: { used: 1, cap: 100 } } },
    subGoat,
  )
  assert.equal(pct(q, "月"), undefined)
  assert.equal(pct(q, "5h"), 1)
})

test("实测空账户真空用例：credits 全 0 + windowLimits 全 null + data null → undefined", () => {
  const q = mapCommandCode(
    {
      credits: { belowThreshold: false, creditThreshold: 0, monthlyCredits: 0, purchasedCredits: 0, freeCredits: 0 },
      windowLimits: { limited: false, exceeded: null, fiveHour: null, weekly: null },
    },
    { success: true, data: null },
  )
  assert.equal(q, undefined)
})

test("小用量：保留一位小数（真实场景 0.05/14 → 0.4）", () => {
  const q = mapCommandCode(
    {
      credits: { monthlyCredits: 69.949 },
      windowLimits: { fiveHour: { used: 0.0508, cap: 14 }, weekly: { used: 0.0508, cap: 35 } },
    },
    { success: true, data: { planId: "individual-goat" } },
  )
  assert.equal(pct(q, "5h"), 0.4) // 0.0508/14 = 0.36% → 0.4
  assert.equal(pct(q, "周"), 0.1) // 0.0508/35 = 0.15% → 0.1
  assert.equal(pct(q, "月"), 0.1) // (70-69.949)/70 = 0.07% → 0.1
})

test("完全空响应/undefined → undefined", () => {
  assert.equal(mapCommandCode(undefined, undefined), undefined)
  assert.equal(mapCommandCode({}, {}), undefined)
})
