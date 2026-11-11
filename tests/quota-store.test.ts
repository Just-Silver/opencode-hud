// ─── model/quota.ts QuotaStore 单元测试（mock deps，零网络） ───
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  QUOTA_REFRESH_MS,
  QUOTA_STALE_MS,
  QuotaStore,
  type QuotaDeps,
} from "../.opencode/plugins/opencode-hud/model/quota.ts"
import type { QuotaData } from "../.opencode/plugins/opencode-hud/model/types.ts"
import { QuotaRequestError } from "../.opencode/plugins/opencode-hud/shared/http.ts"

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

test("没凭据：同一凭据状态下只记一次 warn，60s 心跳不刷屏", async () => {
  let now = 1_000_000
  const deps = makeDeps({ resolveKey: async () => undefined, now: () => now })
  const store = new QuotaStore(deps)
  for (let tick = 0; tick < 30; tick++) {
    await store.load("opencode-go") // 30 次心跳 = 30 分钟
    now += 60_000
  }
  assert.equal(deps.logs.length, 1)
  assert.deepEqual(deps.logs[0], { level: "warn", message: "quota opencode-go missing key" })
})

test("未注册额度端点：静默跳过，不发请求、不写缓存、不记日志", async () => {
  const deps = makeDeps({ apiUrlFor: () => undefined })
  const store = new QuotaStore(deps)
  assert.equal(await store.load("open-design"), false)
  assert.equal(store.get("open-design"), undefined)
  assert.equal(deps.fetchCalls.length, 0)
  assert.deepEqual(deps.logs, [])
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

test("刷新间隔：5min 内重复 load 不发请求，到点后才刷新", async () => {
  let now = 1_000_000
  const deps = makeDeps({ now: () => now })
  const store = new QuotaStore(deps)
  assert.equal(await store.load("opencode-go"), true)
  now += QUOTA_REFRESH_MS - 1
  assert.equal(await store.load("opencode-go"), false)
  assert.equal(deps.fetchCalls.length, 1)
  now += 1
  assert.equal(await store.load("opencode-go"), true)
  assert.equal(deps.fetchCalls.length, 2)
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
test("force：刷新间隔内仍真请求；非 force 被跳过", async () => {
  const deps = makeDeps()
  const store = new QuotaStore(deps)
  assert.equal(await store.load("opencode-go"), true) // 首次，写库，at 记录
  assert.equal(await store.load("opencode-go"), false) // 非 force：刷新间隔内跳过，不发请求
  assert.equal(deps.fetchCalls.length, 1)
  await store.load("opencode-go", { force: true }) // force：跳过一次成功态的间隔，真请求
  assert.equal(deps.fetchCalls.length, 2)
  assert.equal(store.get("opencode-go")?.items[0]?.percent, 42)
})

// ─── 失败退避（5 → 10 → 15min） ───
test("失败退避：失败后按 5/10/15min 递增，force 也不越过", async () => {
  let now = 1_000_000
  let failing = true
  const deps = makeDeps({
    now: () => now,
    fetch: async (pid, apiUrl, key) => {
      deps.fetchCalls.push({ pid, apiUrl, key })
      if (failing) throw new Error("boom")
      return okData
    },
  })
  const store = new QuotaStore(deps)

  assert.equal(await store.load("opencode-go"), false) // 第 1 次失败 → 等 5min
  now += 4 * 60_000
  assert.equal(await store.load("opencode-go", { force: true }), false)
  assert.equal(deps.fetchCalls.length, 1)

  now += 60_000 // 第 1 次退避到点
  assert.equal(await store.load("opencode-go"), false) // 第 2 次失败 → 等 10min
  assert.equal(deps.fetchCalls.length, 2)

  now += 9 * 60_000
  assert.equal(await store.load("opencode-go", { force: true }), false)
  assert.equal(deps.fetchCalls.length, 2)

  now += 60_000
  failing = false
  assert.equal(await store.load("opencode-go"), true) // 第 3 次成功，退避清零
  assert.equal(deps.fetchCalls.length, 3)
  assert.deepEqual(store.get("opencode-go"), okData)
})

// ─── Retry-After 优先于本地退避 ───
test("429 带 Retry-After：到点前连 force 也不请求，到点后先试一次", async () => {
  let now = 1_000_000
  const retryAt = now + 2 * 60_000
  let calls = 0
  const deps = makeDeps({
    now: () => now,
    fetch: async () => {
      calls++
      throw new QuotaRequestError("quota 429", "rate_limited", { status: 429, retryAt })
    },
  })
  const store = new QuotaStore(deps)

  assert.equal(await store.load("opencode-go"), false)
  assert.equal(store.error("opencode-go")?.code, "rate_limited")
  assert.equal(store.error("opencode-go")?.retryAt, retryAt)

  now += 60_000
  assert.equal(await store.load("opencode-go", { force: true }), false)
  assert.equal(calls, 1)

  now += 60_000 // 到 Retry-After，不受本地 5min 退避挡住
  assert.equal(await store.load("opencode-go"), false)
  assert.equal(calls, 2)
})

// ─── 凭据身份：切号后旧数据立即作废 ───
test("凭据切换：上一账号的额度立即作废，不显示到新请求成功", async () => {
  let now = 1_000_000
  let key = "key-one"
  let failing = false
  const deps = makeDeps({
    now: () => now,
    resolveKey: async () => key,
    fetch: async () => {
      if (failing) throw new Error("boom")
      return okData
    },
  })
  const store = new QuotaStore(deps)

  assert.equal(await store.load("opencode-go"), true)
  assert.deepEqual(store.get("opencode-go"), okData)

  key = "key-two"
  failing = true
  now += 60_000
  assert.equal(await store.load("opencode-go"), false)
  assert.equal(store.get("opencode-go"), undefined) // 不展示上一账号的数据
  assert.equal(store.error("opencode-go")?.code, "provider_error")
})

test("凭据切换：重置旧凭据的退避，新凭据可立即请求", async () => {
  let now = 1_000_000
  let key = "key-one"
  let failing = true
  const deps = makeDeps({
    now: () => now,
    resolveKey: async () => key,
    fetch: async () => {
      if (failing) throw new Error("boom")
      return okData
    },
  })
  const store = new QuotaStore(deps)

  assert.equal(await store.load("opencode-go"), false) // 旧凭据失败，进入 5min 退避
  now += 1_000
  key = "key-two"
  failing = false
  assert.equal(await store.load("opencode-go"), true) // 新指纹：不继承旧退避
})
// ─── 新鲜度状态（展示元信息，不改变刷新策略） ───
const flush = () => new Promise((resolve) => setImmediate(resolve))

test("status：未请求 → empty（不猜有数据）", () => {
  const store = new QuotaStore(makeDeps())
  const status = store.status("opencode-go")
  assert.equal(status.phase, "empty")
  assert.equal(status.hasData, false)
  assert.equal(status.fetching, false)
  assert.equal(status.stale, false)
  assert.equal(status.ageMs, undefined)
})

test("status：请求在途 → loading；成功后 → ready 且从 0 开始计龄", async () => {
  let now = 1_000_000
  let release: (value: QuotaData | undefined) => void = () => {}
  const deps = makeDeps({
    now: () => now,
    fetch: () =>
      new Promise<QuotaData | undefined>((resolve) => {
        release = resolve
      }),
  })
  const store = new QuotaStore(deps)
  const loading = store.load("opencode-go")
  await flush()
  assert.equal(store.status("opencode-go").phase, "loading")
  assert.equal(store.status("opencode-go").fetching, true)

  release(okData)
  assert.equal(await loading, true)
  const ready = store.status("opencode-go")
  assert.equal(ready.phase, "ready")
  assert.equal(ready.hasData, true)
  assert.equal(ready.fetching, false)
  assert.equal(ready.ageMs, 0)

  now += 3 * 60_000
  assert.equal(store.status("opencode-go").ageMs, 3 * 60_000)
  assert.equal(store.status("opencode-go").stale, false)
})

test("status：缓存超过新鲜窗口 → stale（数据仍可展示，不是错误）", async () => {
  let now = 1_000_000
  const deps = makeDeps({ now: () => now })
  const store = new QuotaStore(deps)
  await store.load("opencode-go")
  now += QUOTA_STALE_MS + 1
  const status = store.status("opencode-go")
  assert.equal(status.phase, "stale")
  assert.equal(status.stale, true)
  assert.equal(status.hasData, true)
  assert.equal(status.error, undefined)
})

test("status：刷新失败但保留旧数据 → error 且数据与年龄不被清掉", async () => {
  let now = 1_000_000
  let failing = false
  const deps = makeDeps({
    now: () => now,
    fetch: async () => {
      if (failing) throw new Error("boom")
      return okData
    },
  })
  const store = new QuotaStore(deps)
  await store.load("opencode-go")
  failing = true
  now += QUOTA_REFRESH_MS
  assert.equal(await store.load("opencode-go"), false)

  const status = store.status("opencode-go")
  assert.equal(status.phase, "error")
  assert.equal(status.hasData, true)
  assert.deepEqual(store.get("opencode-go"), okData)
  assert.equal(status.error?.code, "provider_error")
  assert.equal(status.ageMs, QUOTA_REFRESH_MS)
})

test("status：失败且从未成功 → error 但没有数据（UI 不画 0%）", async () => {
  const deps = makeDeps({ fetch: async () => { throw new Error("boom") } })
  const store = new QuotaStore(deps)
  await store.load("opencode-go")
  const status = store.status("opencode-go")
  assert.equal(status.phase, "error")
  assert.equal(status.hasData, false)
  assert.equal(store.get("opencode-go"), undefined)
})

test("status：查询失败原因脱敏后仍可在 UI 上归因", async () => {
  let now = 1_000_000
  const deps = makeDeps({
    now: () => now,
    fetch: async () => { throw new QuotaRequestError("quota 401: bad token", "login_expired", { status: 401 }) },
  })
  const store = new QuotaStore(deps)
  await store.load("opencode-go")
  assert.equal(store.status("opencode-go").error?.code, "login_expired")
  assert.match(store.status("opencode-go").error?.message ?? "", /quota 401/)
})

test("status：读取状态本身不触发请求", async () => {
  const deps = makeDeps()
  const store = new QuotaStore(deps)
  for (let i = 0; i < 10; i++) store.status("opencode-go")
  assert.equal(deps.fetchCalls.length, 0)
})
