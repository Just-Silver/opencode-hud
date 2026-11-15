// ─── quota/registry.ts 白名单归一化与 fetcher 分发单元测试 ───
// 注意：index.ts 含 import.meta.glob（node 不识别），测试一律以 createRegistry(静态注册) 驱动。
import { test } from "node:test"
import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { createRegistry, type ProviderRegistration } from "../.opencode/plugins/opencode-hud/quota/registry.ts"
import {
  isQuotaRowOpen,
  nextWakeAt,
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
// 所有用例共用一个绝对「现在」，倒计时/年龄都从 updatedAt / nextRefreshAt 现算
const NOW = 1_000_000
const statusOf = (over: Partial<import("../.opencode/plugins/opencode-hud/model/types.ts").QuotaStatus> = {}) => ({
  phase: "ready" as const,
  hasData: true,
  fetching: false,
  ageMs: 3 * 60_000,
  stale: false,
  updatedAt: NOW - 3 * 60_000,
  nextRefreshAt: NOW + 4 * 60_000 + 32_000,
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

test("quotaStatusTrail：展开时正常态是下次刷新倒计时（不是数据年龄）", () => {
  assert.deepEqual(quotaStatusTrail(statusOf(), true, NOW), { text: "↻ 04:32", tone: "muted" })
})

test("quotaStatusTrail：倒计时按绝对时刻现算，每秒递减、休眠跳跃不漂移", () => {
  const status = statusOf()
  const at = (ms: number) => quotaStatusTrail(status, true, NOW + ms)?.text
  assert.equal(at(0), "↻ 04:32")
  assert.equal(at(1_000), "↻ 04:31")
  assert.equal(at(2_000), "↻ 04:30")
  // 定时器延迟 3.7s：显示值直接对齐真实剩余（ceil 268.3s = 04:29），不是「上一秒 − 1」
  assert.equal(at(3_700), "↻ 04:29")
  // 系统休眠跨过截止时刻：不显示负数倒计时
  assert.equal(at(4 * 60_000 + 32_000), "↻ 00:00")
  // 跨过新鲜窗口（>10min）后过期提示优先：不把 13 分钟前的数据说成「马上刷新」
  assert.equal(at(10 * 60_000), "旧 13m")
  // 时间倒退（校时）：按真实剩余回涨，不吃历史状态
  assert.equal(at(-60_000), "↻ 05:32")
})

test("quotaStatusTrail：≥1h 用 HH:MM:SS（定宽不抖动）", () => {
  assert.deepEqual(quotaStatusTrail(statusOf({ nextRefreshAt: NOW + 3600_000 }), true, NOW), {
    text: "↻ 01:00:00",
    tone: "muted",
  })
})

test("quotaStatusTrail：展开时刷新中优先于年龄/错误（正在动作）", () => {
  assert.deepEqual(quotaStatusTrail(statusOf({ fetching: true }), true, NOW), { text: "↻ 更新中", tone: "accent" })
  assert.deepEqual(
    quotaStatusTrail(statusOf({ fetching: true, error: { code: "network", message: "x" } }), true, NOW),
    { text: "↻ 更新中", tone: "accent" },
  )
})

test("quotaStatusTrail：折叠时后台刷新不占位（把宽度留给摘要/重置时间）", () => {
  assert.equal(quotaStatusTrail(statusOf({ fetching: true }), false, NOW), undefined)
  // 过期且正在刷新：仍要标「旧」，否则折叠行会把旧数据当新鲜
  assert.deepEqual(
    quotaStatusTrail(statusOf({ fetching: true, ageMs: 12 * 60_000, updatedAt: NOW - 12 * 60_000 }), false, NOW),
    { text: "旧", tone: "accent" },
  )
})

test("quotaStatusTrail：折叠行正常态不给倒计时（摘要优先）", () => {
  assert.equal(quotaStatusTrail(statusOf(), false, NOW), undefined)
})

test("quotaStatusTrail：失败 → 真实重试倒计时，具体原因不被倒计时挤掉", () => {
  const failing = (code: string) => statusOf({ phase: "error", error: { code, message: "x" }, nextRefreshAt: NOW + 9 * 60_000 + 28_000 })
  assert.deepEqual(quotaStatusTrail(failing("provider_error"), true, NOW), { text: "重试 09:28", tone: "danger" })
  assert.deepEqual(quotaStatusTrail(failing("login_expired"), true, NOW), { text: "凭据失效 09:28", tone: "danger" })
  assert.deepEqual(quotaStatusTrail(failing("rate_limited"), true, NOW), { text: "限流 09:28", tone: "danger" })
  // 秒级推进同样作用于重试倒计时
  assert.equal(quotaStatusTrail(failing("provider_error"), true, NOW + 28_000)?.text, "重试 09:00")
})

test("quotaStatusTrail：失败但无法确定下次刷新 → 原因 + 缓存年龄（不伪造倒计时）", () => {
  assert.deepEqual(
    quotaStatusTrail(
      statusOf({ phase: "error", error: { code: "login_expired", message: "401" }, ageMs: 8 * 60_000, updatedAt: NOW - 8 * 60_000, nextRefreshAt: undefined }),
      true,
      NOW,
    ),
    { text: "凭据失效 8m", tone: "danger" },
  )
})

test("quotaStatusTrail：没有错误但缓存过期 → 保留过期提示（不说成正常倒计时）", () => {
  assert.deepEqual(
    quotaStatusTrail(statusOf({ stale: true, ageMs: 12 * 60_000, updatedAt: NOW - 12 * 60_000 }), true, NOW),
    { text: "旧 12m", tone: "accent" },
  )
  assert.deepEqual(quotaStatusTrail(statusOf({ stale: true, ageMs: 4 * 24 * 3600_000, updatedAt: NOW - 4 * 24 * 3600_000 }), true, NOW), {
    text: "旧 4d",
    tone: "accent",
  })
})

test("quotaStatusTrail：折叠时只有异常才占位（正常数据把宽度留给摘要）", () => {
  assert.deepEqual(quotaStatusTrail(statusOf({ stale: true, ageMs: 12 * 60_000, updatedAt: NOW - 12 * 60_000 }), false, NOW), {
    text: "旧",
    tone: "accent",
  })
  assert.deepEqual(
    quotaStatusTrail(statusOf({ phase: "error", error: { code: "timeout", message: "t" } }), false, NOW),
    { text: "失败", tone: "danger" },
  )
})

test("quotaStatusTrail：无法确定下次刷新时退回数据年龄，无数据无错误不硬凑文案", () => {
  assert.deepEqual(quotaStatusTrail(statusOf({ nextRefreshAt: undefined }), true, NOW), { text: "3m", tone: "muted" })
  assert.equal(
    quotaStatusTrail(statusOf({ phase: "empty", hasData: false, ageMs: undefined, updatedAt: undefined, nextRefreshAt: undefined }), true, NOW),
    undefined,
  )
})

test("nextWakeAt：多供应商取最早截止时刻，全无 → undefined", () => {
  assert.equal(nextWakeAt([NOW + 5_000, undefined, NOW + 1_000]), NOW + 1_000)
  assert.equal(nextWakeAt([NOW + 5_000]), NOW + 5_000)
  assert.equal(nextWakeAt([]), undefined)
  assert.equal(nextWakeAt([undefined, undefined]), undefined)
})
