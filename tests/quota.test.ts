// ─── quota/registry.ts 白名单归一化与 fetcher 分发单元测试 ───
// 注意：index.ts 含 import.meta.glob（node 不识别），测试一律以 createRegistry(静态注册) 驱动。
import { test } from "node:test"
import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { createRegistry, type ProviderRegistration } from "../.opencode/plugins/opencode-hud/quota/registry.ts"
import {
  isQuotaRowOpen,
  orderQuotaProviders,
  quotaErrorLabel,
  quotaStatusTrail,
  representativeItem,
  toggleQuotaRowState,
} from "../.opencode/plugins/opencode-hud/model/quota.ts"
import { QUOTA_API_URL } from "../.opencode/plugins/opencode-hud/quota/providers/opencode-go.ts"
import { resolveApiKeyFromConfig } from "../.opencode/plugins/opencode-hud/quota/key.ts"

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures")
const projectDir = join(fixtures, "project")

// 与 providers/opencode-go.ts 等价的静态注册（测试不动 glob，直接构造）
const opencodeGo: ProviderRegistration = {
  id: "opencode-go",
  apiUrl: QUOTA_API_URL,
  fetch: async () => undefined, // 本组测试不触发真实请求（分发/守卫逻辑与 fetch 实现无关）
}

const registry = createRegistry([opencodeGo])

// ─── 白名单归一化（isQuotaProvider） ───
test("isQuotaProvider：任意写法命中 opencode-go", () => {
  for (const pid of ["opencode-go", "opencodego", "opencode_go", "Opencode-Go", "opencode2go"]) {
    assert.equal(registry.isQuotaProvider(pid), true, `应为命中: ${pid}`)
  }
})

test("isQuotaProvider：无关/空 pid 不命中（含未启用供应商 command-code）", () => {
  for (const pid of ["anthropic", "openai", "azure", "", "opencode-x", "command-code", "commandcode"]) {
    assert.equal(registry.isQuotaProvider(pid), false, `应不命中: ${pid}`)
  }
})

test("createRegistry：enabled:false 注册项被跳过，enabled 后命中", () => {
  const reg = createRegistry([
    opencodeGo,
    { id: "command-code", apiUrl: "https://api.commandcode.ai/alpha/billing/credits", fetch: async () => undefined, enabled: false },
  ])
  assert.equal(reg.isQuotaProvider("command-code"), false) // 未启用：不进入白名单
  const reg2 = createRegistry([
    opencodeGo,
    { id: "command-code", apiUrl: "https://api.commandcode.ai/alpha/billing/credits", fetch: async () => undefined, enabled: true },
  ])
  assert.equal(reg2.isQuotaProvider("command-code"), true)
  assert.equal(reg2.getProviderApiUrl("commandcode"), "https://api.commandcode.ai/alpha/billing/credits")
})

// ─── fetchQuota 归一化分发（用户写法 pid 也要能取到 fetcher） ───
test("fetchQuota：归一化匹配 fetcher 并透传 apiUrl/key", async () => {
  let seenApiUrl = ""
  let seenKey = ""
  const reg = createRegistry([
    {
      id: "test-go",
      apiUrl: "https://example.test/v1/usage",
      fetch: async (apiUrl: string, key: string) => {
        seenApiUrl = apiUrl
        seenKey = key
        return { items: [{ label: "5h", percent: 42 }] }
      },
    },
  ])
  const url = "https://example.test/v1/usage"
  for (const pid of ["test-go", "test_go", "Test-Go", "testgo"]) {
    const usage = await reg.fetchQuota(pid, url, "k-secret")
    assert.equal(usage?.items[0]?.percent, 42, `应为命中: ${pid}`)
    assert.equal(seenApiUrl, url)
    assert.equal(seenKey, "k-secret")
  }
})

test("fetchQuota：无对应 fetcher → undefined", async () => {
  assert.equal(await registry.fetchQuota("nope", "https://x", "k"), undefined)
})

// ─── 全链路：用户写法的 pid → 守卫过 → 配置 key 命中 ───
test("全链路：opencodego 写法从配置提取 key（fixture 覆盖）", () => {
  // 会话 pid 为用户写法 opencodego：
  // 1) isQuotaProvider("opencodego") = true（白名单归一化）
  // 2) resolveApiKeyFromConfig("opencodego", {cwd: projectDir}) 命中配置里同名键
  assert.equal(registry.isQuotaProvider("opencodego"), true)
  assert.equal(resolveApiKeyFromConfig("opencodego", { cwd: projectDir }), "sk-oc-go-alias-0000")
})

// ─── getProviderApiUrl（归一化 URL 查找；未注册/未启用一律 undefined，无兜底） ───
test("getProviderApiUrl：opencode-go 任意写法命中专属 URL", () => {
  const url = registry.getProviderApiUrl("opencode-go")
  assert.equal(url, QUOTA_API_URL)
  assert.equal(registry.getProviderApiUrl("opencode_go"), url) // 归一化写法同样命中
})

test("getProviderApiUrl：未注册/未启用 pid → undefined（不兜底指向）", () => {
  assert.equal(registry.getProviderApiUrl("command-code"), undefined) // 未注册
  assert.equal(registry.getProviderApiUrl("nope"), undefined)
})
test("listProviders：只返回启用项，省略 name 时回退 id；getProviderName 未命中 undefined", () => {
  const reg = createRegistry([
    opencodeGo,
    { id: "command-code", apiUrl: "https://api.commandcode.ai/alpha/billing/credits", fetch: async () => undefined, enabled: false },
  ])
  assert.deepEqual(reg.listProviders(), [{ id: "opencode-go", name: "opencode-go" }])
  assert.equal(reg.getProviderName("opencode-go"), "opencode-go")
  assert.equal(reg.getProviderName("command-code"), undefined)
})

// ─── 多订阅展示的纯函数 ───
test("orderQuotaProviders：当前 → 子代理在用 → 其余注册顺序，按归一化去重", () => {
  assert.deepEqual(
    orderQuotaProviders({
      current: "opencode_go",
      subagentPids: ["OpenAI"],
      available: ["command-code", "openai", "opencode-go"],
    }),
    ["opencode-go", "openai", "command-code"],
  )
})

test("orderQuotaProviders：当前不在候选里也保留（仍走原有加载路径）", () => {
  assert.deepEqual(
    orderQuotaProviders({ current: "open-design", subagentPids: [], available: ["openai"] }),
    ["open-design", "openai"],
  )
})

test("orderQuotaProviders：子代理供应商不在候选 / 重复 / 为空 → 忽略", () => {
  assert.deepEqual(
    orderQuotaProviders({
      current: undefined,
      subagentPids: ["anthropic", "OpenAI", "openai"],
      available: ["openai", "command-code"],
    }),
    ["openai", "command-code"],
  )
})

test("representativeItem：取已用最多的条目，并列取先出现", () => {
  assert.deepEqual(representativeItem([{ label: "5h", percent: 12 }, { label: "周", percent: 69 }]), {
    label: "周",
    percent: 69,
  })
  assert.deepEqual(representativeItem([{ label: "a", percent: 50 }, { label: "b", percent: 50 }]), {
    label: "a",
    percent: 50,
  })
})

test("representativeItem：全无百分比取首个有文本的；空数组 undefined", () => {
  assert.deepEqual(representativeItem([{ label: "x" }, { label: "余额", text: "$12.3" }]), {
    label: "余额",
    text: "$12.3",
  })
  assert.equal(representativeItem([]), undefined)
})

test("isQuotaRowOpen：无记录按默认行，显式记录优先", () => {
  const state = new Map<string, boolean>()
  assert.equal(isQuotaRowOpen("a", "a", state), true)
  assert.equal(isQuotaRowOpen("b", "a", state), false)
  state.set("b", true)
  state.set("a", false)
  assert.equal(isQuotaRowOpen("b", "a", state), true)
  assert.equal(isQuotaRowOpen("a", "a", state), false)
})

test("toggleQuotaRowState：点默认展开组一次即收起，显式状态与默认规则解耦", () => {
  let state = new Map<string, boolean>()
  state = toggleQuotaRowState(state, "a", "a")
  assert.equal(isQuotaRowOpen("a", "a", state), false) // 默认展开 → 一次点击收起
  state = toggleQuotaRowState(state, "a", "a")
  assert.equal(isQuotaRowOpen("a", "a", state), true)
  const other = toggleQuotaRowState(state, "b", "a")
  assert.equal(isQuotaRowOpen("b", "a", other), true) // 其余组原本折叠 → 一次点击展开
  assert.equal(isQuotaRowOpen("a", "a", other), true) // 其它组的状态不被连带修改
})

test("listProviders：保持注册顺序（发现顺序），不排序", () => {
  const reg = createRegistry([
    { id: "b-provider", name: "B", apiUrl: "u", fetch: async () => undefined },
    { id: "a-provider", name: "A", apiUrl: "u", fetch: async () => undefined },
  ])
  assert.deepEqual(reg.listProviders().map((p) => p.id), ["b-provider", "a-provider"])
})

// ─── 新鲜度展示（纯函数） ───
const statusOf = (over: Partial<import("../.opencode/plugins/opencode-hud/model/types.ts").QuotaStatus> = {}) => ({
  phase: "ready" as const,
  hasData: true,
  fetching: false,
  ageMs: 3 * 60_000,
  stale: false,
  ...over,
})

test("quotaErrorLabel：失败原因归成短标签（不含英文/密钥细节）", () => {
  assert.equal(quotaErrorLabel({ code: "login_expired" }), "凭据失效")
  assert.equal(quotaErrorLabel({ code: "rate_limited" }), "限流")
  assert.equal(quotaErrorLabel({ code: "timeout" }), "超时")
  assert.equal(quotaErrorLabel({ code: "network" }), "网络异常")
  assert.equal(quotaErrorLabel({ code: "bad_response" }), "响应异常")
  assert.equal(quotaErrorLabel({ code: "provider_error" }), "查询失败")
  assert.equal(quotaErrorLabel({ code: "unknown-code" }), "查询失败")
  assert.equal(quotaErrorLabel(undefined), undefined)
})

test("quotaStatusTrail：展开时给数据年龄，过期转琥珀", () => {
  assert.deepEqual(quotaStatusTrail(statusOf(), true), { text: "3m", tone: "muted" })
  assert.deepEqual(quotaStatusTrail(statusOf({ stale: true, ageMs: 12 * 60_000 }), true), {
    text: "12m",
    tone: "accent",
  })
})

test("quotaStatusTrail：展开时刷新中优先于年龄/错误（正在动作）", () => {
  assert.deepEqual(quotaStatusTrail(statusOf({ fetching: true }), true), { text: "更新中", tone: "accent" })
  assert.deepEqual(
    quotaStatusTrail(statusOf({ fetching: true, error: { code: "network", message: "x" } }), true),
    { text: "更新中", tone: "accent" },
  )
})

test("quotaStatusTrail：折叠时后台刷新不占位（把宽度留给摘要/重置时间）", () => {
  assert.equal(quotaStatusTrail(statusOf({ fetching: true }), false), undefined)
  // 过期且正在刷新：仍要标「旧」，否则折叠行会把旧数据当新鲜
  assert.deepEqual(quotaStatusTrail(statusOf({ fetching: true, stale: true }), false), {
    text: "旧",
    tone: "accent",
  })
})

test("quotaStatusTrail：失败但有缓存 → 原因 + 缓存年龄（不隐藏旧数据）", () => {
  assert.deepEqual(
    quotaStatusTrail(statusOf({ phase: "error", error: { code: "login_expired", message: "401" }, ageMs: 8 * 60_000 }), true),
    { text: "凭据失效 8m", tone: "danger" },
  )
})

test("quotaStatusTrail：折叠时只有异常才占位（正常数据把宽度留给摘要）", () => {
  assert.equal(quotaStatusTrail(statusOf(), false), undefined)
  assert.deepEqual(quotaStatusTrail(statusOf({ stale: true }), false), { text: "旧", tone: "accent" })
  assert.deepEqual(
    quotaStatusTrail(statusOf({ phase: "error", error: { code: "timeout", message: "t" } }), false),
    { text: "失败", tone: "danger" },
  )
})

test("quotaStatusTrail：无缓存无错误（尚未取到）不硬凑文案", () => {
  assert.equal(quotaStatusTrail(statusOf({ phase: "empty", hasData: false, ageMs: undefined }), true), undefined)
})
