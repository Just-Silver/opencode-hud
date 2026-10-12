// ─── quota/index.ts 运行时自动发现测试 ───
// 直接 import index.ts：顶层 await 执行真实目录扫描（import.meta.url 为磁盘 file:// 时
// 与 opencode/bun 运行时同路径），断言发现结果与 enabled 过滤。
import { test } from "node:test"
import assert from "node:assert/strict"
import { isQuotaProvider, getProviderApiUrl } from "../.opencode/plugins/opencode-tui-usage/quota/index.ts"
import { COMMANDCODE_CREDITS_URL } from "../.opencode/plugins/opencode-tui-usage/quota/providers/command-code.ts"
import { QUOTA_API_URL } from "../.opencode/plugins/opencode-tui-usage/quota/providers/opencode-go.ts"

test("自动发现：扫描 providers/ 后 opencode-go 已注册（任意写法命中）", () => {
  assert.equal(isQuotaProvider("opencode-go"), true)
  assert.equal(isQuotaProvider("opencodego"), true)
  assert.equal(isQuotaProvider("opencode_go"), true)
})

test("自动发现：command-code 已启用并注册（任意写法命中）", () => {
  assert.equal(isQuotaProvider("command-code"), true)
  assert.equal(isQuotaProvider("commandcode"), true)
})

test("自动发现：URL 查找命中专属端点、未注册无兜底返回 undefined", () => {
  assert.equal(getProviderApiUrl("opencode-go"), QUOTA_API_URL)
  assert.equal(getProviderApiUrl("command-code"), COMMANDCODE_CREDITS_URL)
  assert.equal(getProviderApiUrl("nope"), undefined) // 未注册 → 不兜底
})