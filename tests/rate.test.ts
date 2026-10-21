// ─── model/rate.ts 单元测试：速率卡尔曼估计（业务行为） ───
import { test } from "node:test"
import assert from "node:assert/strict"
import { createRateFilter } from "../.opencode/plugins/opencode-tui-usage/model/rate.ts"

// 生成观测序列：真实速率恒定，每 stepMs 采样一次
function feed(filter: ReturnType<typeof createRateFilter>, rate: number, from: number, to: number, stepMs = 250, jitter = 0) {
  let out
  for (let t = from; t <= to; t += stepMs) {
    const tok = (t / 1000) * rate + (jitter ? Math.sin(t / 100) * jitter : 0)
    out = filter.update({ at: t, tok })
  }
  return out!
}

test("稳态：恒定速率下估计收敛到真值", () => {
  const f = createRateFilter()
  const est = feed(f, 150, 0, 20000)
  assert.ok(Math.abs(est.rate - 150) < 3, `估计 ${est.rate.toFixed(1)} 应接近 150`)
})

test("稳态：无观测噪声时估计精确", () => {
  const f = createRateFilter()
  const est = feed(f, 80, 0, 10000)
  assert.ok(Math.abs(est.rate - 80) < 0.5, `估计 ${est.rate.toFixed(2)} 应接近 80`)
})

test("事件重置：工具结束后速度从新值重建，不被旧值拖住", () => {
  const f = createRateFilter()
  // 前段 100 tok/s
  feed(f, 100, 0, 10000, 250)
  // 事件：工具调用结束（速率先验作废）
  f.reset()
  // 后段 300 tok/s
  let out
  for (let t = 10250; t <= 12000; t += 250) {
    out = f.update({ at: t, tok: 1000 + ((t - 10000) / 1000) * 300 })
  }
  assert.ok(Math.abs(out!.rate - 300) < 40, `重置后估计 ${out!.rate.toFixed(0)} 应快速接近 300`)
})

test("事件重置幂等：连续调用 reset 与调用一次等价", () => {
  const a = createRateFilter()
  const b = createRateFilter()
  feed(a, 120, 0, 5000)
  feed(b, 120, 0, 5000)
  a.reset()
  b.reset()
  b.reset()
  b.reset()
  // 之后喂同样的观测，两者估计应一致
  let ea, eb
  for (let t = 5250; t <= 8000; t += 250) {
    const tok = 600 + ((t - 5000) / 1000) * 90
    ea = a.update({ at: t, tok })
    eb = b.update({ at: t, tok })
  }
  assert.equal(ea!.rate, eb!.rate, "幂等：多次 reset 结果应完全相同")
})

test("重置只作废速率先验，不清空累计 token", () => {
  const f = createRateFilter()
  const before = feed(f, 100, 0, 5000)
  assert.ok(before.rate > 0)
  f.reset()
  // 重置后立刻给同一时刻的观测：累计 token 延续，不应出现巨大跳变
  const after = f.update({ at: 5250, tok: 525 })
  assert.ok(Number.isFinite(after.rate))
  assert.ok(after.variance > 0)
})

test("变化检测：速率突变（无事件通知）时能报出来", () => {
  const f = createRateFilter()
  feed(f, 100, 0, 10000, 250)
  assert.equal(f.driftDetected(), false, "稳态不应报警")

  // 速率突变 100 → 400，但不调用 reset（模拟漏检事件）
  // 模型仍假设 100 tok/s，新息会持续偏大 → EMA 应超阈
  for (let t = 10250; t <= 16000; t += 250) {
    f.update({ at: t, tok: 1000 + ((t - 10000) / 1000) * 400 })
  }
  assert.equal(f.driftDetected(), true, "持续新息偏置应被检出")
})

test("变化检测：稳态下长期不误报", () => {
  const f = createRateFilter()
  feed(f, 200, 0, 60000, 250)
  assert.equal(f.driftDetected(), false, "60s 稳态不应误报")
})

test("守卫：速率不会为负", () => {
  const f = createRateFilter()
  // 观测倒退（数据异常）
  f.update({ at: 0, tok: 0 })
  f.update({ at: 1000, tok: 100 })
  const est = f.update({ at: 2000, tok: 0 })
  assert.ok(est.rate >= 0, `速率 ${est.rate} 不应为负`)
})

test("单样本不足以给出速率（不猜）", () => {
  const f = createRateFilter()
  const est = f.update({ at: 1000, tok: 50 })
  assert.equal(est.rate, 0, "只有一个观测时不应产生速率估计")
})
