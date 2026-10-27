// ─── model/usage.ts 纯函数单元测试（离线，构造假 messages） ───
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  aggregateUsage,
  calcCacheRate,
  calcPercent,
  contextUsageOf,
  resolveContextLimit,
  resolveProviderID,
  usageFromTokens,
} from "../.opencode/plugins/opencode-hud/model/usage.ts"
import type { MessageLike } from "../.opencode/plugins/opencode-hud/model/types.ts"

// ─── usageFromTokens ───
test("usageFromTokens：直接采用会话聚合列（含缓存读）", () => {
  assert.deepEqual(usageFromTokens({ input: 100, output: 50, reasoning: 20, cache: { read: 30, write: 10 } }), {
    input: 100,
    output: 50,
    reasoning: 20,
    read: 30,
    write: 10,
    total: 210,
  })
})

test("usageFromTokens：字段缺失按 0；无 tokens 或全 0 → undefined", () => {
  assert.deepEqual(usageFromTokens({ output: 7 }), { input: 0, output: 7, reasoning: 0, read: 0, write: 0, total: 7 })
  assert.equal(usageFromTokens(undefined), undefined)
  assert.equal(usageFromTokens({ input: 0, output: 0, cache: { read: 0 } }), undefined)
})

// ─── aggregateUsage ───
test("aggregateUsage：多条消息 token 累加", () => {
  const messages: MessageLike[] = [
    { tokens: { input: 100, output: 50, reasoning: 20, cache: { read: 30, write: 10 } } },
    { tokens: { input: 200 } },
    { tokens: { output: 100, cache: { read: 40 } } },
    { tokens: {} },
  ]
  const u = aggregateUsage(messages)
  assert.deepEqual(u, {
    input: 300,
    output: 150,
    reasoning: 20,
    read: 70,
    write: 10,
    total: 550,
  })
})

test("aggregateUsage：无 tokens 的消息跳过；全空 → undefined", () => {
  assert.equal(aggregateUsage([{ tokens: undefined }, { tokens: {} }, {}]), undefined)
  assert.equal(aggregateUsage([]), undefined)
})

test("aggregateUsage：total<=0 → undefined", () => {
  assert.equal(aggregateUsage([{ tokens: { input: 0, output: 0 } }]), undefined)
})

// ─── calcCacheRate ───
test("calcCacheRate：cc-switch 口径 read/(input+write+read)", () => {
  const u = aggregateUsage([
    { tokens: { input: 100, output: 10, reasoning: 5, cache: { read: 30, write: 20 } } },
  ])!
  assert.equal(calcCacheRate(u), 20) // 30/(100+20+30) = 0.2 → 20.0 一位小数 → 20
  assert.equal(calcCacheRate(undefined), undefined)
  assert.equal(calcCacheRate({ input: 0, output: 0, reasoning: 0, read: 0, write: 0, total: 0 }), undefined)
})

// ─── contextUsageOf ───
test("contextUsageOf：取最新一条含 tokens 的消息求和", () => {
  const messages: MessageLike[] = [
    { tokens: { input: 10, output: 20 } },
    { tokens: undefined },
    { tokens: { input: 5, output: 1, reasoning: 2, cache: { read: 3, write: 4 } } },
  ]
  assert.equal(contextUsageOf(messages), 15)
  assert.equal(contextUsageOf([{ tokens: undefined }, {}]), undefined)
  assert.equal(contextUsageOf([]), undefined)
})

// ─── resolveContextLimit ───
test("resolveContextLimit：按最后一条含 model.id 的消息反查", () => {
  const messages: MessageLike[] = [
    { tokens: { input: 1 }, model: { id: "a" } },
    { model: { id: "b" } },
    { tokens: { input: 2 } },
  ]
  const models = [{ id: "a", limit: { context: 100 } }, { id: "b", limit: { context: 200000 } }, { id: "c" }]
  assert.equal(resolveContextLimit(messages, models), 200000)
  assert.equal(resolveContextLimit([{ model: { id: "none" } }], models), undefined)
  assert.equal(resolveContextLimit([{ tokens: { input: 1 } }], models), undefined)
  assert.equal(resolveContextLimit(messages, []), undefined)
})

// ─── calcPercent ───
test("calcPercent：一位小数；limit 缺失/0 不除零", () => {
  assert.equal(calcPercent(50, 100), 50)
  assert.equal(calcPercent(333, 1000), 33.3)
  assert.equal(calcPercent(50, 0), undefined)
  assert.equal(calcPercent(undefined, 100), undefined)
  assert.equal(calcPercent(50, undefined), undefined)
})

// ─── resolveProviderID ───
const lookup = (id: string) => (id === "m2" ? { providerID: "opencode-go" } : undefined)

test("resolveProviderID：message.providerID 优先", () => {
  const messages: MessageLike[] = [
    { model: { id: "x", providerID: "other" } },
    { providerID: "anthropic" },
  ]
  assert.equal(resolveProviderID(messages, lookup), "anthropic")
})

test("resolveProviderID：model.providerID 次之", () => {
  const messages: MessageLike[] = [
    { providerID: "anthropic" },
    { model: { id: "x", providerID: "google" } },
  ]
  assert.equal(resolveProviderID(messages, lookup), "google")
})

test("resolveProviderID：model.id 反查（命中/未命中）", () => {
  assert.equal(resolveProviderID([{ model: { id: "m2" } }], lookup), "opencode-go")
  assert.equal(resolveProviderID([{ model: { id: "unknown" } }], lookup), undefined)
})

test("resolveProviderID：无任何归属 → undefined", () => {
  assert.equal(resolveProviderID([], lookup), undefined)
  assert.equal(resolveProviderID([{ tokens: { input: 1 } }], lookup), undefined)
})