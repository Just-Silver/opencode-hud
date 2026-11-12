// ─── quota/providers/openai.ts mapOpenai / accountIDFromToken 单元测试（离线，零网络） ───
// 响应样例取自 2026-11-10 本机实测（ChatGPT Plus，Codex 登录）：5h 窗口 + 周窗口，
// spend_control.individual_limit 为 null（无月度额度）。
import { test } from "node:test"
import assert from "node:assert/strict"
import { mapOpenai, accountIDFromToken } from "../.opencode/plugins/opencode-hud/quota/providers/openai.ts"

const inSeconds = (hours: number) => Math.floor(Date.now() / 1000 + hours * 3600)

test("mapOpenai：5h + 周窗口 → 条目（标签按窗口秒数，hint 为重置时间）", () => {
  const q = mapOpenai({
    plan_type: "plus",
    rate_limit: {
      primary_window: { used_percent: 15, limit_window_seconds: 18000, reset_at: inSeconds(2.5) },
      secondary_window: { used_percent: 2, limit_window_seconds: 604800, reset_at: inSeconds(72) },
    },
    spend_control: { individual_limit: null },
  })
  assert.deepEqual(
    q?.items.map((i) => i.label),
    ["5h", "周"],
  )
  assert.equal(q?.items[0].percent, 15)
  assert.equal(q?.items[1].percent, 2)
  assert.match(q?.items[0].hint ?? "", /^↻ \d+(?:m|h(?:\d+m)?|d)$/) // 相对剩余时长
  assert.match(q?.items[1].hint ?? "", /^↻ \d+(?:m|h(?:\d+m)?|d)$/)
})

test("mapOpenai：有月度额度时补一行「月」，percent = 100 − remaining", () => {
  const q = mapOpenai({
    rate_limit: { primary_window: { used_percent: 0, limit_window_seconds: 18000 } },
    spend_control: { individual_limit: { remaining_percent: 30, reset_at: inSeconds(240) } },
  })
  assert.deepEqual(
    q?.items.map((i) => i.label),
    ["5h", "月"],
  )
  assert.equal(q?.items[1].percent, 70)
  assert.match(q?.items[1].hint ?? "", /^↻ \d+(?:m|h(?:\d+m)?|d)$/) // 相对剩余时长
})

test("mapOpenai：只有 reset_after_seconds 时也算得出重置时间", () => {
  const q = mapOpenai({ rate_limit: { primary_window: { used_percent: 1, limit_window_seconds: 18000, reset_after_seconds: 3600 } } })
  assert.match(q?.items[0].hint ?? "", /^↻ \d+(?:m|h(?:\d+m)?|d)$/)
})

test("mapOpenai：越界百分比 clamp 到 0-100", () => {
  const q = mapOpenai({
    rate_limit: {
      primary_window: { used_percent: 130, limit_window_seconds: 18000 },
      secondary_window: { used_percent: -5, limit_window_seconds: 604800 },
    },
  })
  assert.equal(q?.items[0].percent, 100)
  assert.equal(q?.items[1].percent, 0)
})

test("mapOpenai：缺 used_percent / 空响应 → 对应行不出现；全空 → undefined", () => {
  assert.equal(mapOpenai(undefined), undefined)
  assert.equal(mapOpenai({}), undefined)
  assert.equal(mapOpenai({ rate_limit: { primary_window: { limit_window_seconds: 18000 } } }), undefined)
  const q = mapOpenai({ rate_limit: { secondary_window: { used_percent: 5, limit_window_seconds: 604800 } } })
  assert.deepEqual(
    q?.items.map((i) => i.label),
    ["周"],
  )
})

test("mapOpenai：窗口秒数未知时用位置兜底标签", () => {
  const q = mapOpenai({ rate_limit: { primary_window: { used_percent: 1 } } })
  assert.equal(q?.items[0].label, "5h")
})

test("accountIDFromToken：兼容嵌套 auth claim 与顶层写法，缺失/坏 token → undefined", () => {
  const jwt = (payload: unknown) => `h.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.s`
  assert.equal(
    accountIDFromToken(jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-123" } })),
    "acct-123",
  )
  assert.equal(accountIDFromToken(jwt({ chatgpt_account_id: "acct-top" })), "acct-top")
  assert.equal(accountIDFromToken(jwt({ sub: "x" })), undefined)
  assert.equal(accountIDFromToken("not-a-jwt"), undefined)
  assert.equal(accountIDFromToken(jwt({ "https://api.openai.com/auth": {} })), undefined)
})
