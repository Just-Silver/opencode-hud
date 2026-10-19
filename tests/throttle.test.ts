// ─── 共享/帮助函数：前沿+尾沿节流单元测试 ───
import { test } from "node:test"
import assert from "node:assert/strict"
import { createThrottledBumper } from "../.opencode/plugins/opencode-tui-usage/shared/throttle.ts"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

test("前沿立即触发，突发期间只补一次", async () => {
  let n = 0
  const b = createThrottledBumper(() => n++, 40)
  for (let i = 0; i < 10; i++) b.bump()
  assert.equal(n, 1)
  await sleep(90)
  assert.equal(n, 2)
  b.dispose()
})

test("连续事件流不会被饿死（~10Hz 节奏）", async () => {
  let n = 0
  const b = createThrottledBumper(() => n++, 40)
  const start = Date.now()
  while (Date.now() - start < 400) {
    b.bump()
    await sleep(20)
  }
  await sleep(100)
  assert.ok(n >= 8 && n <= 15, `触发次数 ${n} 应在 [8,15]`)
  b.dispose()
})

test("静默期后首个事件立即生效", async () => {
  let n = 0
  const b = createThrottledBumper(() => n++, 40)
  b.bump()
  await sleep(90)
  const before = n
  b.bump()
  assert.equal(n, before + 1)
  b.dispose()
})

test("dispose 后不再触发", async () => {
  let n = 0
  const b = createThrottledBumper(() => n++, 40)
  b.bump()
  b.dispose()
  await sleep(90)
  assert.equal(n, 1)
})
