// ─── model/usage.ts 纯函数单元测试（离线，构造假 messages） ───
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  calcCacheRate,
  calcPercent,
  contextUsageOf,
  resolveContextLimit,
  resolveProviderID,
  usageFromTokens,
} from "../.opencode/plugins/opencode-hud/model/usage.ts"
import type { MessageLike } from "../.opencode/plugins/opencode-hud/model/types.ts"

// 真实 assistant 消息的最小构造：上下文只认 type=assistant 且带 tokens 的步。
const assistant = (id: string, input: number, model?: { id?: string; providerID?: string }): MessageLike => ({
  id,
  type: "assistant",
  tokens: { input },
  model,
})

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

// ─── calcCacheRate ───
test("calcCacheRate：cc-switch 口径 read/(input+write+read)", () => {
  const u = { input: 100, output: 10, reasoning: 5, read: 30, write: 20, total: 165 }
  assert.equal(calcCacheRate(u), 20) // 30/(100+20+30) = 0.2 → 20.0 一位小数 → 20
  assert.equal(calcCacheRate(undefined), undefined)
  assert.equal(calcCacheRate({ input: 0, output: 0, reasoning: 0, read: 0, write: 0, total: 0 }), undefined)
})

// ─── contextUsageOf ───
test("contextUsageOf：最后一条合资格 assistant 的 token 求和", () => {
  const messages: MessageLike[] = [
    { id: "msg_1", type: "assistant", tokens: { input: 10, output: 20 } },
    { id: "msg_2", type: "assistant", tokens: undefined },
    {
      id: "msg_3",
      type: "assistant",
      tokens: { input: 5, output: 1, reasoning: 2, cache: { read: 3, write: 4 } },
    },
  ]
  assert.equal(contextUsageOf(messages), 15)
  assert.equal(contextUsageOf([{ id: "msg_4", type: "assistant", tokens: undefined }]), undefined)
  assert.equal(contextUsageOf([]), undefined)
})

test("contextUsageOf：completed compaction 后还没有带 tokens 的 assistant 时无上下文", () => {
  const messages: MessageLike[] = [
    assistant("msg_1", 1000, { id: "m" }),
    { id: "msg_2", type: "compaction", status: "completed", tokens: { input: 180000 } },
    { id: "msg_3", type: "user", tokens: { input: 9000 } },
  ]
  assert.equal(contextUsageOf(messages), undefined)
})

test("contextUsageOf：completed compaction 之后的新 assistant 才代表当前上下文", () => {
  const messages: MessageLike[] = [
    assistant("msg_1", 1000, { id: "m" }),
    { id: "msg_2", type: "compaction", status: "completed", tokens: { input: 180000 } },
    assistant("msg_3", 2000, { id: "m" }),
  ]
  assert.equal(contextUsageOf(messages), 2000)
})

test("contextUsageOf：未完成的 compaction 不截断上下文", () => {
  const messages: MessageLike[] = [
    assistant("msg_1", 1000, { id: "m" }),
    { id: "msg_2", type: "compaction", status: "running", tokens: { input: 180000 } },
    { id: "msg_3", type: "user" },
  ]
  assert.equal(contextUsageOf(messages), 1000)
})

test("contextUsageOf：revert 边界之前的 assistant 才是上下文；边界未加载则无数据", () => {
  const messages: MessageLike[] = [
    assistant("msg_1", 2000, { id: "m" }),
    assistant("msg_2", 9000, { id: "m" }),
  ]
  assert.equal(contextUsageOf(messages, "msg_2"), 2000)
  assert.equal(contextUsageOf(messages, "msg_1"), undefined)
  assert.equal(contextUsageOf(messages, "msg_missing"), undefined)
  assert.equal(contextUsageOf(messages), 9000)
})

// ─── resolveContextLimit ───
test("resolveContextLimit：上限取与上下文同一条 assistant 的模型", () => {
  const messages: MessageLike[] = [
    assistant("msg_1", 2000, { id: "old", providerID: "p1" }),
    // 尾部新一步还没有 tokens：不能拿它的模型当分母
    { id: "msg_2", type: "assistant", model: { id: "new", providerID: "p2" } },
  ]
  const models = [
    { id: "old", providerID: "p1", limit: { context: 100000 } },
    { id: "new", providerID: "p2", limit: { context: 500000 } },
  ]
  assert.equal(resolveContextLimit(messages, models), 100000)
})

test("resolveContextLimit：按 providerID + id 匹配同名模型，不取别家的同名模型", () => {
  const messages: MessageLike[] = [assistant("msg_1", 200000, { id: "qwen", providerID: "opencode" })]
  const models = [
    { id: "qwen", providerID: "opencode-go", limit: { context: 1000000 } },
    { id: "qwen", providerID: "opencode", limit: { context: 262144 } },
  ]
  assert.equal(resolveContextLimit(messages, models), 262144)
  assert.equal(
    resolveContextLimit([assistant("msg_2", 1, { id: "qwen", providerID: "missing" })], models),
    undefined,
  )
})

test("resolveContextLimit：model.providerID 缺失时用 message.providerID", () => {
  const messages: MessageLike[] = [
    { id: "msg_1", type: "assistant", providerID: "opencode", tokens: { input: 1 }, model: { id: "qwen" } },
  ]
  const models = [
    { id: "qwen", providerID: "opencode-go", limit: { context: 1000000 } },
    { id: "qwen", providerID: "opencode", limit: { context: 262144 } },
  ]
  assert.equal(resolveContextLimit(messages, models), 262144)
})

test("resolveContextLimit：provider 身份本来就缺失时按 id 匹配", () => {
  const messages: MessageLike[] = [assistant("msg_1", 1, { id: "a" })]
  const models = [{ id: "a", limit: { context: 100 } }, { id: "b", limit: { context: 200000 } }, { id: "c" }]
  assert.equal(resolveContextLimit(messages, models), 100)
  assert.equal(resolveContextLimit([assistant("msg_2", 1, { id: "none" })], models), undefined)
  assert.equal(resolveContextLimit([{ id: "msg_3", type: "assistant", tokens: { input: 1 } }], models), undefined)
  assert.equal(resolveContextLimit(messages, []), undefined)
})

test("resolveContextLimit：revert 边界与 compaction 边界同样生效", () => {
  const messages: MessageLike[] = [
    assistant("msg_1", 1, { id: "old", providerID: "p1" }),
    assistant("msg_2", 1, { id: "new", providerID: "p2" }),
  ]
  const models = [
    { id: "old", providerID: "p1", limit: { context: 100 } },
    { id: "new", providerID: "p2", limit: { context: 200 } },
  ]
  assert.equal(resolveContextLimit(messages, models, "msg_2"), 100)
  assert.equal(resolveContextLimit(messages, models, "msg_missing"), undefined)

  const compacted: MessageLike[] = [
    assistant("msg_3", 1, { id: "old", providerID: "p1" }),
    { id: "msg_4", type: "compaction", status: "completed", tokens: { input: 1 } },
  ]
  assert.equal(resolveContextLimit(compacted, models), undefined)
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
