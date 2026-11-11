// ─── quota/index.ts 运行时自动发现测试 ───
// 直接 import index.ts：顶层 await 执行真实目录扫描（import.meta.url 为磁盘 file:// 时
// 与 opencode/bun 运行时同路径），断言发现结果与 enabled 过滤。
import { test } from "node:test"
import assert from "node:assert/strict"
import { isQuotaProvider, getProviderApiUrl, listProviders, getProviderName } from "../.opencode/plugins/opencode-hud/quota/index.ts"
import { COMMANDCODE_CREDITS_URL } from "../.opencode/plugins/opencode-hud/quota/providers/command-code.ts"
import { QUOTA_API_URL } from "../.opencode/plugins/opencode-hud/quota/providers/opencode-go.ts"
import { OPENAI_USAGE_URL } from "../.opencode/plugins/opencode-hud/quota/providers/openai.ts"

test("自动发现：扫描 providers/ 后 opencode-go 已注册（任意写法命中）", () => {
  assert.equal(isQuotaProvider("opencode-go"), true)
  assert.equal(isQuotaProvider("opencodego"), true)
  assert.equal(isQuotaProvider("opencode_go"), true)
})

test("自动发现：command-code 已启用并注册（任意写法命中）", () => {
  assert.equal(isQuotaProvider("command-code"), true)
  assert.equal(isQuotaProvider("commandcode"), true)
})

test("自动发现：openai 已启用并注册（任意写法命中）", () => {
  assert.equal(isQuotaProvider("openai"), true)
  assert.equal(isQuotaProvider("OpenAI"), true)
})

test("自动发现：URL 查找命中专属端点、未注册无兜底返回 undefined", () => {
  assert.equal(getProviderApiUrl("opencode-go"), QUOTA_API_URL)
  assert.equal(getProviderApiUrl("command-code"), COMMANDCODE_CREDITS_URL)
  assert.equal(getProviderApiUrl("openai"), OPENAI_USAGE_URL)
  assert.equal(getProviderApiUrl("nope"), undefined) // 未注册 → 不兜底
})
test("自动发现：listProviders 只列已注册并启用的供应商，带显示名", () => {
  const list = listProviders()
  assert.deepEqual(list.map((p) => p.id).sort(), ["command-code", "openai", "opencode-go"])
  assert.equal(list.find((p) => p.id === "opencode-go")?.name, "OpenCode Go")
  assert.equal(list.find((p) => p.id === "openai")?.name, "OpenAI")
  assert.equal(list.find((p) => p.id === "command-code")?.name, "Command Code")
})

test("getProviderName：任意写法归一化命中，未注册返回 undefined", () => {
  assert.equal(getProviderName("opencode_go"), "OpenCode Go")
  assert.equal(getProviderName("OpenAI"), "OpenAI")
  assert.equal(getProviderName("open-design"), undefined)
})
