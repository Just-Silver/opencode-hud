// ─── quota/host.ts 宿主映射单元测试（setup 绑定一次，hook 每次读取） ───
// 运行：node --test tests/quota-host.test.ts
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  bindQuotaHost,
  hostDirectory,
  hostIntegrationID,
  integrationIDFromProviders,
} from "../.opencode/plugins/opencode-hud/quota/host.ts"

test.afterEach(() => {
  bindQuotaHost(undefined)
})

test("额度宿主映射随最近一次 setup 绑定切换：A → B → 解绑", () => {
  bindQuotaHost({
    providerIntegrationID: (pid) => (pid === "opencode-go" ? "opencode" : undefined),
    directory: () => "/work/a",
  })
  assert.equal(hostIntegrationID("opencode-go"), "opencode")
  assert.equal(hostIntegrationID("command-code"), undefined)
  assert.equal(hostDirectory(), "/work/a")

  // 后一次 setup 覆盖前一次：不得残留第一个绑定
  bindQuotaHost({
    providerIntegrationID: (pid) => `b:${pid}`,
    directory: () => "/work/b",
  })
  assert.equal(hostIntegrationID("opencode-go"), "b:opencode-go")
  assert.equal(hostDirectory(), "/work/b")

  bindQuotaHost(undefined)
  assert.equal(hostIntegrationID("opencode-go"), undefined)
  assert.equal(hostDirectory(), undefined)
})

test("已同步但缺 integrationID 的 provider 按 provider.id 映射，不当作未就绪", () => {
  const providers = [
    { id: "opencode-go" },
    { id: "command-code", integrationID: "command-code-integration" },
  ]
  bindQuotaHost({
    providerIntegrationID: (pid) => integrationIDFromProviders(providers, pid),
    directory: () => undefined,
  })

  // 已同步但缺映射：按 providerID 本身查询，不能当成「列表未就绪」
  assert.equal(hostIntegrationID("opencode-go"), "opencode-go")
  // 有映射时用宿主给的 integration
  assert.equal(hostIntegrationID("command-code"), "command-code-integration")
  // 不在列表里才是未就绪
  assert.equal(hostIntegrationID("not-synced"), undefined)
})

test("宿主 provider id 与注册 pid 只差大小写/下划线时仍能映射，返回值用宿主原值", () => {
  const providers = [{ id: "OpenCode_Go" }, { id: "Command-Code", integrationID: "cc-integration" }]
  bindQuotaHost({
    providerIntegrationID: (pid) => integrationIDFromProviders(providers, pid),
    directory: () => undefined,
  })

  // 归一化后相等即视为同一 provider；无 integrationID 时返回宿主自己的 id（保留原写法）
  assert.equal(hostIntegrationID("opencode-go"), "OpenCode_Go")
  assert.equal(hostIntegrationID("command_code"), "cc-integration")
  // 归一化后仍不相等才是未就绪
  assert.equal(hostIntegrationID("opencode"), undefined)
})

test("目录来自宿主 location.default()，缺失时 undefined", () => {
  bindQuotaHost({ providerIntegrationID: () => undefined, directory: () => "/work/session" })
  assert.equal(hostDirectory(), "/work/session")

  bindQuotaHost({ providerIntegrationID: () => undefined, directory: () => undefined })
  assert.equal(hostDirectory(), undefined)
})
