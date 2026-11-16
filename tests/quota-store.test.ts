// ─── model/quota.ts QuotaStore 单元测试（mock deps，零网络） ───
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  QUOTA_REFRESH_MS,
  QUOTA_STALE_MS,
  QuotaStore,
  type QuotaDeps,
  type QuotaKeyResolution,
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
    resolveKey: async () => ({ key: "k-test", identity: "id-test" }),
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

test("resolveKey 为 undefined：记 warn、不请求、不写数据", async () => {
  const deps = makeDeps({ resolveKey: async () => undefined })
  const store = new QuotaStore(deps)
  assert.equal(await store.load("opencode-go"), false)
  assert.equal(store.get("opencode-go"), undefined)
  assert.equal(deps.fetchCalls.length, 0)
  assert.deepEqual(deps.logs, [{ level: "warn", message: "quota opencode-go missing key" }])
})

test("resolveKey 为 undefined：只 warn 一次（60s 心跳不刷屏）", async () => {
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
test("订阅：一次真实请求通知两次 —— 开始时 fetching=true、落定时 fetching=false", async () => {
  let release: (value: QuotaData | undefined) => void = () => {}
  let calls = 0
  const deps = makeDeps({
    fetch: () => {
      calls++
      return new Promise<QuotaData | undefined>((resolve) => { release = resolve })
    },
  })
  const store = new QuotaStore(deps)
  const seen: boolean[] = []
  store.subscribe(() => seen.push(store.status("opencode-go").fetching))

  const loading = store.load("opencode-go")
  await flush()
  assert.deepEqual(seen, [true], "请求开始就要通知，否则「更新中」永远看不到")
  assert.equal(store.status("opencode-go").phase, "loading")

  release(okData)
  assert.equal(await loading, true)
  assert.deepEqual(seen, [true, false], "落定通知必须发生在 inFlight 清空之后")
  assert.equal(calls, 1)
})

test("订阅：成功一次请求 = 开始 + 落定两次通知", async () => {
  const deps = makeDeps()
  const store = new QuotaStore(deps)
  let notified = 0
  store.subscribe(() => notified++)
  assert.equal(await store.load("opencode-go"), true)
  assert.equal(notified, 2)
})

test("订阅：请求失败或空响应也在开始与落定时各通知一次（「更新中」必须能撤销）", async () => {
  const cases: Array<Partial<QuotaDeps>> = [
    { fetch: async () => { throw new Error("boom") } },
    { fetch: async () => undefined },
  ]
  for (const overrides of cases) {
    const deps = makeDeps(overrides)
    const store = new QuotaStore(deps)
    let notified = 0
    store.subscribe(() => notified++)
    await store.load("opencode-go")
    assert.equal(notified, 2, `应通知两次: ${JSON.stringify(Object.keys(overrides))}`)
    assert.equal(store.status("opencode-go").fetching, false)
  }
})

test("订阅：被刷新间隔跳过的 load 不通知（没有真实请求就没有开始通知）", async () => {
  let now = 1_000_000
  const deps = makeDeps({ now: () => now })
  const store = new QuotaStore(deps)
  let notified = 0
  store.subscribe(() => notified++)
  await store.load("opencode-go")
  assert.equal(notified, 2)
  now += 60_000 // 间隔内：跳过
  assert.equal(await store.load("opencode-go"), false)
  assert.equal(notified, 2)
})

test("订阅：并发去重时只有一个请求的开始通知，不会双发", async () => {
  let release: (value: QuotaData | undefined) => void = () => {}
  let calls = 0
  const deps = makeDeps({
    fetch: () => {
      calls++
      return new Promise<QuotaData | undefined>((resolve) => { release = resolve })
    },
  })
  const store = new QuotaStore(deps)
  let notified = 0
  store.subscribe(() => notified++)
  const first = store.load("opencode-go")
  await flush()
  const second = store.load("opencode-go") // 命中 inFlight：等待，不再发请求
  await flush()
  assert.equal(notified, 1)
  release(okData)
  assert.equal(await first, true)
  assert.equal(await second, true)
  assert.equal(notified, 2)
  assert.equal(calls, 1)
})

test("订阅：missing key 既不请求也不通知", async () => {
  const deps = makeDeps({ resolveKey: async () => undefined })
  const store = new QuotaStore(deps)
  let notified = 0
  store.subscribe(() => notified++)
  await store.load("opencode-go")
  assert.equal(notified, 0)
})

test("订阅：退订后不再通知", async () => {
  const deps = makeDeps()
  const store = new QuotaStore(deps)
  let notified = 0
  const off = store.subscribe(() => notified++)
  await store.load("a-go")
  assert.equal(notified, 2)
  off()
  await store.load("b-go")
  assert.equal(notified, 2) // 退订后 b-go 写库不再通知
})

test("订阅：多个订阅者全部收到（开始 + 落定）", async () => {
  const deps = makeDeps()
  const store = new QuotaStore(deps)
  let a = 0
  let b = 0
  store.subscribe(() => a++)
  store.subscribe(() => b++)
  await store.load("opencode-go")
  assert.equal(a, 2)
  assert.equal(b, 2)
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
  let resolution: QuotaKeyResolution = { key: "key-one", identity: "id-one" }
  let failing = false
  const deps = makeDeps({
    now: () => now,
    resolveKey: async () => resolution,
    fetch: async () => {
      if (failing) throw new Error("boom")
      return okData
    },
  })
  const store = new QuotaStore(deps)

  assert.equal(await store.load("opencode-go"), true)
  assert.deepEqual(store.get("opencode-go"), okData)

  resolution = { key: "key-two", identity: "id-two" }
  failing = true
  now += 60_000
  assert.equal(await store.load("opencode-go"), false)
  assert.equal(store.get("opencode-go"), undefined) // 不展示上一账号的数据
  assert.equal(store.error("opencode-go")?.code, "provider_error")
})

test("凭据切换：重置旧凭据的退避，新凭据可立即请求", async () => {
  let now = 1_000_000
  let resolution: QuotaKeyResolution = { key: "key-one", identity: "id-one" }
  let failing = true
  const deps = makeDeps({
    now: () => now,
    resolveKey: async () => resolution,
    fetch: async () => {
      if (failing) throw new Error("boom")
      return okData
    },
  })
  const store = new QuotaStore(deps)

  assert.equal(await store.load("opencode-go"), false) // 旧凭据失败，进入 5min 退避
  now += 1_000
  resolution = { key: "key-two", identity: "id-two" }
  failing = false
  assert.equal(await store.load("opencode-go"), true) // 新身份：不继承旧退避
})

test("同一身份、key 变化（OAuth 刷新）：数据保留，间隔内不重复请求", async () => {
  let now = 1_000_000
  let resolution: QuotaKeyResolution = { key: "at-1", identity: "id-stable" }
  const deps = makeDeps({ now: () => now, resolveKey: async () => resolution })
  const store = new QuotaStore(deps)

  assert.equal(await store.load("opencode-go"), true)
  const deadline = store.nextCheckAt("opencode-go")

  // 宿主刷新了 access token：同一条 credential，身份不变
  resolution = { key: "at-2", identity: "id-stable" }
  now += 60_000
  assert.equal(await store.load("opencode-go"), false)
  assert.deepEqual(store.get("opencode-go"), okData, "刷新 token 不能让额度消失")
  assert.equal(deps.fetchCalls.length, 1, "身份不变时仍遵守 5min 间隔")
  assert.equal(store.nextCheckAt("opencode-go"), deadline, "刷新 token 不重置刷新截止时刻")

  now = deadline!
  assert.equal(await store.load("opencode-go"), true)
  assert.equal(deps.fetchCalls.length, 2)
  assert.equal(deps.fetchCalls[1]?.key, "at-2", "到点用刷新后的 key 请求")
})

test("新身份（真正换号）：旧数据立即清空，下一次 load 发请求", async () => {
  let now = 1_000_000
  let resolution: QuotaKeyResolution = { key: "key-one", identity: "id-one" }
  const pending: Array<{ key: string; resolve: (value: QuotaData | undefined) => void }> = []
  const deps = makeDeps({
    now: () => now,
    resolveKey: async () => resolution,
    fetch: (_pid, _apiUrl, key) =>
      new Promise<QuotaData | undefined>((resolve) => pending.push({ key, resolve })),
  })
  const store = new QuotaStore(deps)

  const first = store.load("opencode-go")
  await flush()
  pending[0]?.resolve(okData)
  assert.equal(await first, true)

  resolution = { key: "key-two", identity: "id-two" }
  now += 60_000 // 仍在旧账号的 5min 间隔内
  const second = store.load("opencode-go")
  await flush()
  assert.equal(store.get("opencode-go"), undefined, "换号后旧账号数据立即作废")
  assert.deepEqual(
    pending.map((p) => p.key),
    ["key-one", "key-two"],
    "新身份不受旧账号间隔限制，下一次 load 就请求",
  )

  pending[1]?.resolve(okData)
  assert.equal(await second, true)
})

test("resolveKey 为 null：不请求、不 warn、不写数据、不排程", async () => {
  let now = 1_000_000
  let resolution: QuotaKeyResolution = { key: "key-one", identity: "id-one" }
  const deps = makeDeps({ now: () => now, resolveKey: async () => resolution })
  const store = new QuotaStore(deps)

  assert.equal(await store.load("opencode-go"), true)
  assert.deepEqual(store.get("opencode-go"), okData)

  // 宿主状态不明（企业 Console / DB 打不开）：有意跳过，不能拿别的账号顶替
  resolution = null
  now += 60_000
  assert.equal(await store.load("opencode-go"), false)
  assert.equal(store.get("opencode-go"), undefined, "跳过时不保留上一个账号的数据")
  assert.equal(deps.fetchCalls.length, 1)
  assert.deepEqual(deps.logs, [], "null 不是 missing，不刷 warn")
  assert.equal(store.nextCheckAt("opencode-go"), undefined, "null 不排程")

  now += 30 * 60_000
  assert.equal(await store.load("opencode-go"), false)
  assert.equal(deps.fetchCalls.length, 1, "跳过期间不请求")
  assert.deepEqual(deps.logs, [])
  assert.equal(store.nextCheckAt("opencode-go"), undefined)
})
// ─── 新鲜度状态（展示元信息，不改变刷新策略） ───
const flush = () => new Promise((resolve) => setImmediate(resolve))

// ─── 在途切号：按 identity 判定，等旧请求落定后为当前身份接续（旧结果永不写入新桶） ───
test("在途切号按 identity 判定：旧身份结果丢弃，新身份接续一次", async () => {
  let now = 1_000_000
  let resolution: QuotaKeyResolution = { key: "key-one", identity: "id-one" }
  const oldData: QuotaData = { items: [{ label: "5h", percent: 10 }] }
  const newData: QuotaData = { items: [{ label: "5h", percent: 80 }] }
  const pending: Array<{ key: string; resolve: (value: QuotaData | undefined) => void }> = []
  const deps = makeDeps({
    now: () => now,
    resolveKey: async () => resolution,
    fetch: (_pid, _apiUrl, usedKey) =>
      new Promise<QuotaData | undefined>((resolve) => pending.push({ key: usedKey, resolve })),
  })
  const store = new QuotaStore(deps)

  const first = store.load("opencode-go")
  await flush()
  assert.deepEqual(
    pending.map((p) => p.key),
    ["key-one"],
  )

  // 用户在旧账号请求未落定时换号
  resolution = { key: "key-two", identity: "id-two" }
  const second = store.load("opencode-go")
  await flush()
  assert.equal(store.get("opencode-go"), undefined, "换号后不能继续展示旧账号缓存")
  assert.deepEqual(
    pending.map((p) => p.key),
    ["key-one"],
    "旧请求在途时不并发第二个请求",
  )

  pending[0]?.resolve(oldData)
  assert.equal(await first, false, "旧身份结果按 identity 丢弃")
  await flush()
  assert.deepEqual(
    pending.map((p) => p.key),
    ["key-one", "key-two"],
    "旧请求落定后应为新身份接续请求，不依赖下一次心跳",
  )
  assert.equal(store.get("opencode-go"), undefined, "旧账号结果不写入新桶")

  pending[1]?.resolve(newData)
  assert.equal(await second, true)
  assert.deepEqual(store.get("opencode-go"), newData)
  assert.equal(store.nextCheckAt("opencode-go"), now + QUOTA_REFRESH_MS, "新账号请求成功后建立真实刷新截止")
})

test("请求在途时切号：多个等待者共享新账号的同一次请求与同一份结果", async () => {
  let resolution: QuotaKeyResolution = { key: "key-one", identity: "id-one" }
  const oldData: QuotaData = { items: [{ label: "5h", percent: 10 }] }
  const newData: QuotaData = { items: [{ label: "5h", percent: 80 }] }
  const wrongData: QuotaData = { items: [{ label: "5h", percent: 1 }] }
  const pending: Array<{ key: string; resolve: (value: QuotaData | undefined) => void }> = []
  const deps = makeDeps({
    resolveKey: async () => resolution,
    fetch: (_pid, _apiUrl, usedKey) =>
      new Promise<QuotaData | undefined>((resolve) => pending.push({ key: usedKey, resolve })),
  })
  const store = new QuotaStore(deps)

  const first = store.load("opencode-go")
  await flush()
  resolution = { key: "key-two", identity: "id-two" }
  const waiters = [store.load("opencode-go"), store.load("opencode-go"), store.load("opencode-go")]
  await flush()

  pending[0]?.resolve(oldData)
  assert.equal(await first, false)
  await flush()
  assert.equal(pending.length, 2, "多个等待者只应触发一次新账号请求")
  assert.equal(pending[1]?.key, "key-two")

  // 若实现重复为新账号发请求，额外请求会拿到另一份结果（而不是让测试挂起）
  pending[1]?.resolve(newData)
  await flush()
  for (const extra of pending.slice(2)) extra.resolve(wrongData)
  assert.deepEqual(await Promise.all(waiters), [true, true, true])
  assert.deepEqual(store.get("opencode-go"), newData, "所有等待者看到同一份新账号结果")
  assert.equal(pending.length, 2)
})

test("等待期间再次切号：以最终账号为准接续请求，不回显中间账号", async () => {
  let resolution: QuotaKeyResolution = { key: "key-one", identity: "id-one" }
  const oldData: QuotaData = { items: [{ label: "5h", percent: 10 }] }
  const finalData: QuotaData = { items: [{ label: "5h", percent: 90 }] }
  const pending: Array<{ key: string; resolve: (value: QuotaData | undefined) => void }> = []
  const deps = makeDeps({
    resolveKey: async () => resolution,
    fetch: (_pid, _apiUrl, usedKey) =>
      new Promise<QuotaData | undefined>((resolve) => pending.push({ key: usedKey, resolve })),
  })
  const store = new QuotaStore(deps)

  const first = store.load("opencode-go")
  await flush()
  resolution = { key: "key-two", identity: "id-two" }
  const second = store.load("opencode-go")
  await flush()
  // 等待旧请求期间又切到第三个账号
  resolution = { key: "key-three", identity: "id-three" }

  pending[0]?.resolve(oldData)
  assert.equal(await first, false)
  await flush()
  assert.equal(pending.length, 2)
  assert.equal(pending[1]?.key, "key-three", "按落定时的当前身份请求，不复用等待开始时解析到的过时凭据")
  assert.equal(store.get("opencode-go"), undefined, "旧账号与中间账号的数据都不能回显")

  pending[1]?.resolve(finalData)
  assert.equal(await second, true)
  assert.deepEqual(store.get("opencode-go"), finalData)
})

test("等待期间登出：旧请求落定后不为已失效凭据补发请求，缓存不复活", async () => {
  let resolution: QuotaKeyResolution = { key: "key-one", identity: "id-one" }
  const oldData: QuotaData = { items: [{ label: "5h", percent: 10 }] }
  const pending: Array<{ key: string; resolve: (value: QuotaData | undefined) => void }> = []
  const deps = makeDeps({
    resolveKey: async () => resolution,
    fetch: (_pid, _apiUrl, usedKey) =>
      new Promise<QuotaData | undefined>((resolve) => pending.push({ key: usedKey, resolve })),
  })
  const store = new QuotaStore(deps)

  const first = store.load("opencode-go")
  await flush()
  resolution = { key: "key-two", identity: "id-two" }
  const second = store.load("opencode-go")
  await flush()
  resolution = undefined // 等待期间登出

  pending[0]?.resolve(oldData)
  assert.equal(await first, false)
  assert.equal(await second, false)
  assert.equal(pending.length, 1, "登出后不能为等待开始时解析到的凭据补发请求")
  assert.equal(store.get("opencode-go"), undefined)
  assert.equal(store.nextCheckAt("opencode-go"), undefined)
})

test("同凭据并发请求失败或空响应：等待者不绕过退避立即重发", async () => {
  for (const outcome of ["failure", "empty"] as const) {
    let settle: (value: QuotaData | undefined) => void = () => {}
    let fail: (error: Error) => void = () => {}
    let calls = 0
    const deps = makeDeps({
      fetch: () => {
        calls++
        return new Promise<QuotaData | undefined>((resolve, reject) => {
          settle = resolve
          fail = reject
        })
      },
    })
    const store = new QuotaStore(deps)

    const first = store.load("opencode-go")
    await flush()
    const second = store.load("opencode-go") // 同凭据：命中并发去重
    await flush()
    assert.equal(calls, 1)

    if (outcome === "failure") fail(new Error("boom"))
    else settle(undefined)
    await flush()
    assert.equal(await first, false)
    assert.equal(await second, false)

    // 失败/空响应落定后，等待者与后续调用都要遵守 5min 退避，不能立刻重发
    assert.equal(await store.load("opencode-go"), false)
    assert.equal(calls, 1, `${outcome}：退避内不得重发`)
  }
})

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
// ─── 下一次允许请求时刻（倒计时与真实调度的唯一来源） ───
test("nextCheckAt：未注册端点 / 从未尝试 → undefined（不排程、不显示假倒计时）", () => {
  const deps = makeDeps({ apiUrlFor: (pid) => (pid === "opencode-go" ? "https://x/usage" : undefined) })
  const store = new QuotaStore(deps)
  assert.equal(store.nextCheckAt("opencode-go"), undefined)
  assert.equal(store.nextCheckAt("open-design"), undefined)
})

test("nextCheckAt：成功后 = 上次尝试 + 5min；倒计时归零后 load 真发请求", async () => {
  let now = 1_000_000
  const deps = makeDeps({ now: () => now })
  const store = new QuotaStore(deps)
  await store.load("opencode-go")
  const deadline = store.nextCheckAt("opencode-go")
  assert.equal(deadline, now + QUOTA_REFRESH_MS)
  assert.equal(store.status("opencode-go").nextRefreshAt, deadline)

  now = deadline! // 模拟 UI 排程在截止时刻唤醒
  assert.equal(await store.load("opencode-go"), true)
  assert.equal(deps.fetchCalls.length, 2)
  assert.equal(store.nextCheckAt("opencode-go"), now + QUOTA_REFRESH_MS)
})

test("nextCheckAt：失败按 5/10/15min 退避推进，到点即允许重试", async () => {
  let now = 1_000_000
  const deps = makeDeps({
    now: () => now,
    fetch: async (pid, apiUrl, key) => {
      deps.fetchCalls.push({ pid, apiUrl, key })
      throw new Error("boom")
    },
  })
  const store = new QuotaStore(deps)

  await store.load("opencode-go")
  assert.equal(store.nextCheckAt("opencode-go"), now + 5 * 60_000)
  now = store.nextCheckAt("opencode-go")!
  await store.load("opencode-go")
  assert.equal(store.nextCheckAt("opencode-go"), now + 10 * 60_000)
  now = store.nextCheckAt("opencode-go")!
  await store.load("opencode-go")
  assert.equal(store.nextCheckAt("opencode-go"), now + 15 * 60_000) // 封顶
  assert.equal(deps.fetchCalls.length, 3)
})

test("nextCheckAt：服务端 Retry-After 优先于本地退避", async () => {
  let now = 1_000_000
  let calls = 0
  const retryAt = now + 2 * 60_000
  const deps = makeDeps({
    now: () => now,
    fetch: async () => {
      calls++
      throw new QuotaRequestError("429", "rate_limited", { status: 429, retryAt })
    },
  })
  const store = new QuotaStore(deps)
  await store.load("opencode-go")
  assert.equal(store.nextCheckAt("opencode-go"), retryAt) // 不是 now + 5min
  now = retryAt
  await store.load("opencode-go") // 到点先试一次，不叠加本地退避
  assert.equal(calls, 2)
})

test("nextCheckAt：请求在途 → undefined（落定后重新排程，不重复请求）", async () => {
  let now = 1_000_000
  let release: (value: QuotaData | undefined) => void = () => {}
  const deps = makeDeps({
    now: () => now,
    fetch: () => new Promise<QuotaData | undefined>((resolve) => { release = resolve }),
  })
  const store = new QuotaStore(deps)
  const loading = store.load("opencode-go")
  await flush()
  assert.equal(store.nextCheckAt("opencode-go"), undefined)
  assert.equal(store.status("opencode-go").nextRefreshAt, undefined)

  release(okData)
  assert.equal(await loading, true)
  assert.equal(store.nextCheckAt("opencode-go"), now + QUOTA_REFRESH_MS)
})

test("nextCheckAt：没凭据 → undefined（交给凭据探测发现登录，不空转）", async () => {
  const deps = makeDeps({ resolveKey: async () => undefined })
  const store = new QuotaStore(deps)
  await store.load("opencode-go")
  assert.equal(store.nextCheckAt("opencode-go"), undefined)
})

test("nextCheckAt：切号后不继承旧账号的退避截止时刻", async () => {
  let now = 1_000_000
  let resolution: QuotaKeyResolution = { key: "key-one", identity: "id-one" }
  let failing = true
  const deps = makeDeps({
    now: () => now,
    resolveKey: async () => resolution,
    fetch: async () => {
      if (failing) throw new Error("boom")
      return okData
    },
  })
  const store = new QuotaStore(deps)
  await store.load("opencode-go")
  now = store.nextCheckAt("opencode-go")!
  await store.load("opencode-go") // 第二次失败 → 10min 退避
  assert.equal(store.nextCheckAt("opencode-go"), now + 10 * 60_000)

  resolution = { key: "key-two", identity: "id-two" }
  failing = false
  assert.equal(await store.load("opencode-go"), true) // 新凭据不受旧退避限制
  assert.equal(store.nextCheckAt("opencode-go"), now + QUOTA_REFRESH_MS)
})

test("nextCheckAt：系统休眠恢复后只补一次请求，随即重新对齐", async () => {
  let now = 1_000_000
  const deps = makeDeps({ now: () => now })
  const store = new QuotaStore(deps)
  await store.load("opencode-go")

  now += 30 * 60_000 // 挂起半小时：截止时刻早已过去
  assert.ok(store.nextCheckAt("opencode-go")! < now)
  assert.equal(await store.load("opencode-go"), true)
  assert.equal(deps.fetchCalls.length, 2) // 不补发多次
  assert.equal(store.nextCheckAt("opencode-go"), now + QUOTA_REFRESH_MS)
})

