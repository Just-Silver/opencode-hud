// ─── model/quota.ts QuotaStore 单元测试（mock deps，零网络） ───
import { test } from "node:test"
import assert from "node:assert/strict"
import { QuotaStore, type QuotaDeps } from "../.opencode/plugins/opencode-hud/model/quota.ts"
import type { QuotaData } from "../.opencode/plugins/opencode-hud/model/types.ts"

const okData: QuotaData = { items: [{ label: "5h", percent: 42 }] }

function makeDeps(overrides: Partial<QuotaDeps> = {}): QuotaDeps & {
  fetchCalls: Array<{ pid: string; apiUrl: string; key: string }>
  logs: Array<{ level: "warn" | "error"; message: string }>
} {
  const fetchCalls: Array<{ pid: string; apiUrl: string; key: string }> = []
  const logs: Array<{ level: "warn" | "error"; message: string }> = []
  return {
    apiUrlFor: (pid) => `https://example.test/${pid}/usage`,
    resolveKey: async () => "k-test",
    fetch: async (pid, apiUrl, key) => {
      fetchCalls.push({ pid, apiUrl, key })
      return okData
    },
    log: (level, message) => logs.push({ level, message }),
    ...overrides,
    fetchCalls,
    logs,
  }
}

test("load 成功：写缓存、返回 true、参数透传", async () => {
  const deps = makeDeps()
  const store = new QuotaStore(deps)
  assert.equal(await store.load("opencode-go"), true)
  assert.deepEqual(store.get("opencode-go"), okData)
  assert.deepEqual(deps.fetchCalls, [{ pid: "opencode-go", apiUrl: "https://example.test/opencode-go/usage", key: "k-test" }])
  assert.equal(deps.logs.length, 0)
})

test("load missing key：记 warn、不写缓存、返回 false", async () => {
  const deps = makeDeps({ resolveKey: async () => undefined })
  const store = new QuotaStore(deps)
  assert.equal(await store.load("opencode-go"), false)
  assert.equal(store.get("opencode-go"), undefined)
  assert.equal(deps.fetchCalls.length, 0)
  assert.deepEqual(deps.logs, [{ level: "warn", message: "quota opencode-go missing key" }])
})

test("load missing api url：记 warn、不写缓存、返回 false", async () => {
  const deps = makeDeps({ apiUrlFor: () => undefined })
  const store = new QuotaStore(deps)
  assert.equal(await store.load("opencode-go"), false)
  assert.equal(store.get("opencode-go"), undefined)
  assert.equal(deps.fetchCalls.length, 0)
  assert.deepEqual(deps.logs, [{ level: "warn", message: "quota opencode-go missing api url" }])
})

test("load empty response：记 warn、不写缓存", async () => {
  const deps = makeDeps({ fetch: async () => undefined })
  const store = new QuotaStore(deps)
  assert.equal(await store.load("opencode-go"), false)
  assert.equal(store.get("opencode-go"), undefined)
  assert.deepEqual(deps.logs, [{ level: "warn", message: "quota opencode-go empty response" }])
})

test("load fetch 失败：记 error、不写缓存", async () => {
  const deps = makeDeps({ fetch: async () => { throw new Error("boom") } })
  const store = new QuotaStore(deps)
  assert.equal(await store.load("opencode-go"), false)
  assert.equal(store.get("opencode-go"), undefined)
  assert.equal(deps.logs.length, 1)
  assert.equal(deps.logs[0].level, "error")
  assert.match(deps.logs[0].message, /^quota opencode-go fetch failed: Error: boom$/)
})

test("60s 限流：限流窗口内重复 load 不再发请求", async () => {
  const deps = makeDeps()
  const store = new QuotaStore(deps)
  assert.equal(await store.load("opencode-go"), true)
  assert.equal(await store.load("opencode-go"), false) // 限流
  assert.equal(await store.load("opencode-go"), false)
  assert.equal(deps.fetchCalls.length, 1)
})

test("并发去重：同一 pid 并发 load 只发一次请求；等待者返回缓存状态", async () => {
  const deps = makeDeps()
  const store = new QuotaStore(deps)
  const [r1, r2] = await Promise.all([store.load("opencode-go"), store.load("opencode-go")])
  assert.equal(r1, true)
  assert.equal(r2, true) // 并发等待完成后：缓存已被写入，返回有数据
  assert.equal(deps.fetchCalls.length, 1)
  // inFlight 清理后再次加载（不同 pid 独立）
  await store.load("other-go")
  assert.equal(deps.fetchCalls.length, 2)
})

test("不同 pid 独立分桶", async () => {
  const deps = makeDeps()
  const store = new QuotaStore(deps)
  await store.load("a-go")
  await store.load("b-go")
  assert.equal(deps.fetchCalls.length, 2)
  assert.deepEqual(store.get("a-go"), okData)
  assert.deepEqual(store.get("b-go"), okData)
})

// ─── 订阅通知（bump） ───
test("订阅：写库触发监听器（成功路径 bump 一次）", async () => {
  const deps = makeDeps()
  const store = new QuotaStore(deps)
  let notified = 0
  store.subscribe(() => notified++)
  assert.equal(await store.load("opencode-go"), true)
  assert.equal(notified, 1)
})

test("订阅：失败/空响应/missing key 不触发监听器", async () => {
  const cases: Array<Partial<QuotaDeps>> = [
    { fetch: async () => { throw new Error("boom") } },
    { fetch: async () => undefined },
    { resolveKey: async () => undefined },
  ]
  for (const overrides of cases) {
    const deps = makeDeps(overrides)
    const store = new QuotaStore(deps)
    let notified = 0
    store.subscribe(() => notified++)
    await store.load("opencode-go")
    assert.equal(notified, 0, `不应通知: ${JSON.stringify(Object.keys(overrides))}`)
  }
})

test("订阅：退订后不再通知", async () => {
  const deps = makeDeps()
  const store = new QuotaStore(deps)
  let notified = 0
  const off = store.subscribe(() => notified++)
  await store.load("a-go")
  assert.equal(notified, 1)
  off()
  await store.load("b-go")
  assert.equal(notified, 1) // 退订后 b-go 写库不再通知
})

test("订阅：多个订阅者全部收到", async () => {
  const deps = makeDeps()
  const store = new QuotaStore(deps)
  let a = 0
  let b = 0
  store.subscribe(() => a++)
  store.subscribe(() => b++)
  await store.load("opencode-go")
  assert.equal(a, 1)
  assert.equal(b, 1)
})

// ─── force 绕过限流（timer 轮询用） ───
test("force：限流窗口内仍真请求；非 force 被限流跳过", async () => {
  const deps = makeDeps()
  const store = new QuotaStore(deps)
  assert.equal(await store.load("opencode-go"), true) // 首次，写库，at 记录
  assert.equal(await store.load("opencode-go"), false) // 非 force：60s 限流跳过，不发请求
  assert.equal(deps.fetchCalls.length, 1)
  await store.load("opencode-go", { force: true }) // force：跳过限流，真请求
  assert.equal(deps.fetchCalls.length, 2)
  assert.equal(store.get("opencode-go")?.items[0]?.percent, 42)
})