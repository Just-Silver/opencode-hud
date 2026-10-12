// ─── quota/registry.ts 白名单归一化与 fetcher 分发单元测试 ───
// 注意：index.ts 含 import.meta.glob（node 不识别），测试一律以 createRegistry(静态注册) 驱动。
import { test } from "node:test"
import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { createRegistry, type ProviderRegistration } from "../.opencode/plugins/opencode-tui-usage/quota/registry.ts"
import { QUOTA_API_URL } from "../.opencode/plugins/opencode-tui-usage/quota/providers/opencode-go.ts"
import { resolveApiKeyFromConfig } from "../.opencode/plugins/opencode-tui-usage/quota/key.ts"

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
        return { rolling: { status: "ok", percent: 42 } }
      },
    },
  ])
  const url = "https://example.test/v1/usage"
  for (const pid of ["test-go", "test_go", "Test-Go", "testgo"]) {
    const usage = await reg.fetchQuota(pid, url, "k-secret")
    assert.equal(usage?.rolling?.percent, 42, `应为命中: ${pid}`)
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