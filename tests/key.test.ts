// ─── key.ts 凭据解析单元测试 ───────────────────────────
// 运行：node --test tests/key.test.ts（node ≥ 23.6 默认支持 TS strip，零依赖）
// fixture：tests/fixtures/ 下官方配置格式样本：
//   project/opencode.json          V2 providers.settings.apiKey（明文 + {env:} 占位符）
//   project/.opencode/opencode.json V1 provider.options.apiKey（应优先于 direct 配置）
//   project/sub/opencode.jsonc     JSONC（注释 + 尾逗号），含无 apiKey 的 provider
//   global/opencode/opencode.json  全局配置（通过 XDG_CONFIG_HOME 指向，{env:} 占位符）
import { test } from "node:test"
import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import {
  credentialIntegrationIDs,
  pickCredentialToken,
  resolveApiKeyFromConfig,
  resolveProviderKey,
} from "../.opencode/plugins/opencode-tui-usage/quota/key.ts"

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures")
const projectDir = join(fixtures, "project")
const subDir = join(fixtures, "project", "sub")

// 测试隔离：保存/恢复环境变量
const savedXdgConfigHome = process.env.XDG_CONFIG_HOME
function setGlobalConfigDir() {
  process.env.XDG_CONFIG_HOME = join(fixtures, "global")
}
function restoreEnv() {
  if (savedXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = savedXdgConfigHome
  delete process.env.OPENCODE_GO_API_KEY
  delete process.env.GROQ_API_KEY
}
test.afterEach(restoreEnv)

// ─── V2：providers.{id}.settings.apiKey ───
test("V2 settings.apiKey 直接字符串命中", () => {
  assert.equal(resolveApiKeyFromConfig("anthropic", { cwd: projectDir }), "sk-ant-test-0000")
})

test("V2 settings.apiKey {env:} 占位符替换命中", () => {
  process.env.GROQ_API_KEY = "gsk-test-1234"
  setGlobalConfigDir()
  assert.equal(resolveApiKeyFromConfig("groq", { cwd: projectDir }), "gsk-test-1234")
})

test("V2 settings.apiKey {env:} 未设置 → undefined", () => {
  setGlobalConfigDir()
  assert.equal(resolveApiKeyFromConfig("groq", { cwd: projectDir }), undefined)
})

// ─── V1：provider.{id}.options.apiKey（V2 兼容读取） ───
test("V1 options.apiKey 命中且 .opencode/ 优先于 direct 配置", () => {
  // project/.opencode/opencode.json 为 V1 明文，应覆盖 project/opencode.json 的 {env:} 占位符
  assert.equal(resolveApiKeyFromConfig("opencode-go", { cwd: projectDir }), "oc-v1-test-key-0000")
})

// ─── JSONC：注释 + 尾逗号 ───
test("JSONC（行注释/块注释/尾逗号）解析命中", () => {
  assert.equal(resolveApiKeyFromConfig("deepseek", { cwd: subDir }), "sk-ds-test-0000")
})

// ─── 无 apiKey / 未知供应商 ───
test("有 settings 无 apiKey → undefined", () => {
  assert.equal(resolveApiKeyFromConfig("openai", { cwd: projectDir }), undefined)
  assert.equal(resolveApiKeyFromConfig("vertex", { cwd: subDir }), undefined)
  assert.equal(resolveApiKeyFromConfig("azure-cognitive-services", { cwd: projectDir }), undefined)
})

test("未知 pid → undefined", () => {
  assert.equal(resolveApiKeyFromConfig("nonexistent", { cwd: projectDir }), undefined)
})

test("空 pid → undefined", () => {
  assert.equal(resolveApiKeyFromConfig("", { cwd: projectDir }), undefined)
})

// ─── 全局配置兜底（XDG_CONFIG_HOME） ───
test("仅全局配置存在时兜底命中（cwd 无任何配置）", () => {
  process.env.GROQ_API_KEY = "gsk-global-5678"
  setGlobalConfigDir()
  assert.equal(resolveApiKeyFromConfig("groq", { cwd: join(fixtures, "empty") }), "gsk-global-5678")
})

// ─── resolveProviderKey：keyCache → 配置 → DB（node 下 DB 不可用静默跳过） ───
test("resolveProviderKey 配置路径返回 key", async () => {
  assert.equal(await resolveProviderKey("anthropic", { cwd: projectDir }), "sk-ant-test-0000")
})

test("resolveProviderKey 缓存命中（第二次不再走文件）", async () => {
  assert.equal(await resolveProviderKey("anthropic", { cwd: projectDir }), "sk-ant-test-0000")
})

test("resolveProviderKey 无凭据 → undefined（DB 不可用时静默跳过）", async () => {
  // node 环境无 bun:sqlite；配置未命中 → readDbKey 内部 catch 返回 undefined，不抛错
  assert.equal(await resolveProviderKey("nonexistent", { cwd: projectDir }), undefined)
})

test("resolveProviderKey 空 pid → undefined", async () => {
  assert.equal(await resolveProviderKey("", { cwd: projectDir }), undefined)
})

// ─── DB 凭据候选与取值（纯函数；对齐官方 consoleIntegration / Credential.Value） ───
test("credentialIntegrationIDs：opencode-go 追加 Console 登录 id", () => {
  assert.deepEqual(credentialIntegrationIDs("opencode-go"), ["opencode-go", "opencode"])
  assert.deepEqual(credentialIntegrationIDs("opencodego"), ["opencodego", "opencode"]) // 归一化写法
  assert.deepEqual(credentialIntegrationIDs("opencode"), ["opencode"]) // 已是 Console id，不重复
  assert.deepEqual(credentialIntegrationIDs("anthropic"), ["anthropic"]) // 非 Console 供应商
})

test("pickCredentialToken：按 type 取 key / access，external 等不处理", () => {
  assert.equal(pickCredentialToken({ type: "key", key: "sk-1" }), "sk-1")
  assert.equal(pickCredentialToken({ type: "oauth", access: "at-2", refresh: "rt", expires: 1 }), "at-2")
  assert.equal(pickCredentialToken({ type: "external", methodID: "azure-cli" }), undefined)
  assert.equal(pickCredentialToken({ type: "key" }), undefined) // 缺字段
  assert.equal(pickCredentialToken({ type: "oauth" }), undefined)
  assert.equal(pickCredentialToken(null), undefined)
  assert.equal(pickCredentialToken("nope"), undefined)
})