// ─── quota/providers/opencode-go.ts mapOpencodeGo 单元测试（离线，零网络） ───
// 契约：QuotaData = { items: QuotaItem[] }；标签/顺序与 hint 格式化都由本 provider 决定
import { test } from "node:test"
import assert from "node:assert/strict"
import { mapOpencodeGo } from "../.opencode/plugins/opencode-hud/quota/providers/opencode-go.ts"

const inHours = (h: number) => new Date(Date.now() + h * 3600_000).toISOString()

test("mapOpencodeGo：三窗口 → 条目（标签 5h/周/月 + hint 重置时间）", () => {
  const q = mapOpencodeGo({
    usage: {
      rolling: { status: "ok", percent: 0, resetsAt: inHours(3) },
      weekly: { status: "ok", percent: 12.5, resetsAt: inHours(72) },
      monthly: { status: "ok", percent: 30 }, // 无 resetsAt
    },
  })
  assert.deepEqual(
    q?.items.map((i) => i.label),
    ["5h", "周", "月"],
  )
  assert.equal(q?.items[0].percent, 0)
  assert.equal(q?.items[1].percent, 12.5)
  assert.equal(q?.items[2].percent, 30)
  assert.match(q?.items[0].hint ?? "", /^↻ \d{2}:\d{2}$/) // <24h → 本地时刻（带 ↻ 前缀）
  assert.match(q?.items[1].hint ?? "", /^↻ 周[日一二三四五六]$/) // <7d → 周X
  assert.equal(q?.items[2].hint, undefined) // 无 resetsAt → 无 hint
})

test("mapOpencodeGo：缺窗口 / 无 percent → 跳过；全空 → undefined", () => {
  assert.equal(mapOpencodeGo(undefined), undefined)
  assert.equal(mapOpencodeGo({ usage: {} }), undefined)
  assert.equal(mapOpencodeGo({ usage: { rolling: { status: "ok" } } }), undefined) // 无 percent
  const q = mapOpencodeGo({ usage: { weekly: { percent: 5 } } })
  assert.deepEqual(
    q?.items.map((i) => i.label),
    ["周"],
  )
})
