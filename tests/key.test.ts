// ─── key.ts 凭据解析单元测试 ───────────────────────────
// 运行：node --test tests/key.test.ts（node ≥ 23.6 默认支持 TS strip，零依赖）
// fixture：tests/fixtures/ 下官方配置格式样本：
//   project/opencode.json          V2 providers.settings.apiKey（明文 + {env:} 占位符）
//   project/.opencode/opencode.json V1 provider.options.apiKey（应优先于 direct 配置）
//   project/sub/opencode.jsonc     JSONC（注释 + 尾逗号），含无 apiKey 的 provider
//   global/opencode/opencode.json  全局配置（通过 XDG_CONFIG_HOME 指向，{env:} 占位符）
// DB 用例：node 无 bun:sqlite，用 bun 子进程读临时 SQLite（不碰用户真实 DB）。
import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { fileURLToPath, pathToFileURL } from "node:url"
import { dirname, join } from "node:path"
import {
  consoleServerStateOf,
  decodeCredentialRow,
  isPublicConsoleServer,
  resolveApiKeyFromConfig,
  resolveProviderCredential,
} from "../.opencode/plugins/opencode-hud/quota/key.ts"

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures")
const projectDir = join(fixtures, "project")
const subDir = join(fixtures, "project", "sub")
const KEY_MODULE = join(dirname(fileURLToPath(import.meta.url)), "..", ".opencode", "plugins", "opencode-hud", "quota", "key.ts")
const KEY_URL = pathToFileURL(KEY_MODULE).href
const hasBun = spawnSync("bun", ["--version"], { windowsHide: true }).status === 0

// 测试隔离：保存/恢复环境变量（含占位符变量，不在 afterEach 里一律删除用户原值）
const ENV_KEYS = [
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "OPENCODE_CONFIG_DIR",
  "OPENCODE_DB",
  "OPENCODE_GO_API_KEY",
  "GROQ_API_KEY",
] as const
const savedEnv = Object.fromEntries(ENV_KEYS.map((name) => [name, process.env[name]]))
function setGlobalConfigDir() {
  // 这些用例验证的是 XDG 全局根；ambient OPENCODE_CONFIG_DIR 会替换它，不中和就读不到 fixture
  delete process.env.OPENCODE_CONFIG_DIR
  process.env.XDG_CONFIG_HOME = join(fixtures, "global")
}
function restoreEnv() {
  for (const name of ENV_KEYS) {
    const value = savedEnv[name]
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
}

// 每条用例的默认全局源：XDG 指向 fixture 全局配置，自定义根与 data 目录用空临时目录，
// 占位符变量默认未设置。负向用例（期望 undefined）因此只受固定 fixture 影响，
// 不会读开发者真实的全局 / 自定义根配置或环境变量；特定用例再显式覆盖。
let scratchRoot = ""
test.beforeEach(() => {
  scratchRoot = mkdtempSync(join(tmpdir(), "oc-key-scratch-"))
  process.env.XDG_CONFIG_HOME = join(fixtures, "global")
  process.env.OPENCODE_CONFIG_DIR = join(scratchRoot, "global config")
  process.env.XDG_DATA_HOME = join(scratchRoot, "data")
  delete process.env.OPENCODE_DB
  delete process.env.OPENCODE_GO_API_KEY
  delete process.env.GROQ_API_KEY
})
test.afterEach(() => {
  restoreEnv()
  rmSync(scratchRoot, { recursive: true, force: true })
})

// 隔离的项目目录：祖先链里没有 opencode 配置，避免测试被仓库/用户配置抢先命中
function isolatedProject(prefix: string): { root: string; cwd: string } {
  const root = mkdtempSync(join(tmpdir(), prefix))
  const cwd = join(root, "project")
  mkdirSync(cwd, { recursive: true })
  return { root, cwd }
}

function writeProjectKeys(cwd: string, keys: Record<string, string>): string {
  const file = join(cwd, ".opencode", "opencode.json")
  mkdirSync(dirname(file), { recursive: true })
  const providers = Object.fromEntries(Object.entries(keys).map(([pid, key]) => [pid, { settings: { apiKey: key } }]))
  writeFileSync(file, JSON.stringify({ providers }))
  return file
}

function writeProjectKey(cwd: string, pid: string, key: string): string {
  return writeProjectKeys(cwd, { [pid]: key })
}

// 缓存用例会走到全局配置与 DB 兜底：必须把两者都固定到临时目录，否则会读开发者真实全局 key / DB
function isolateKeySources(root: string): void {
  process.env.XDG_CONFIG_HOME = join(root, "xdg config")
  process.env.OPENCODE_CONFIG_DIR = join(root, "global config")
  process.env.XDG_DATA_HOME = join(root, "data")
  delete process.env.OPENCODE_DB
}

// ─── bun 子进程探针：真实 SQLite + 生产解析器 ───
// node 无 bun:sqlite；探针只读写临时库，不涉及网络与用户凭据。
const PROBE_PRELUDE = `
import { Database } from "bun:sqlite"
import { existsSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { resolveProviderCredential } from __KEY_URL__

function keyValue(key, metadata) {
  return JSON.stringify({ type: "key", key, ...(metadata === undefined ? {} : { metadata }) })
}
function oauthValue(access, metadata) {
  return JSON.stringify({ type: "oauth", access, refresh: "refresh-token", expires: 0, ...(metadata === undefined ? {} : { metadata }) })
}
function seed(file, rows) {
  mkdirSync(dirname(file), { recursive: true })
  const db = new Database(file)
  db.run("CREATE TABLE credential (id text primary key, integration_id text, label text, value text, active integer, time_created integer, time_updated integer)")
  const insert = db.query("INSERT INTO credential (id, integration_id, label, value, active, time_created, time_updated) VALUES (?, ?, 'test', ?, ?, ?, ?)")
  for (const row of rows) insert.run(row.id, row.integrationID, row.value, row.active ?? null, row.created ?? 1, row.updated ?? 1)
  db.close()
}
function update(file, sql, params) {
  const db = new Database(file)
  db.query(sql).run(...params)
  db.close()
}
function shape(credential) {
  if (credential === null) return "null"
  if (credential === undefined) return "undefined"
  return { key: credential.key, identity: credential.identity }
}
function emit(result) {
  console.log("PROBE=" + JSON.stringify(result))
}
`

function probeEnv(root: string, dbPath: string, cwd: string, mode?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    XDG_CONFIG_HOME: join(root, "xdg config"),
    OPENCODE_CONFIG_DIR: join(root, "config dir"),
    XDG_DATA_HOME: join(root, "data dir"),
    OPENCODE_DB: dbPath,
    PROBE_CWD: cwd,
  }
  if (mode) env.PROBE_MODE = mode
  else delete env.PROBE_MODE
  return env
}

function runBunProbe(root: string, body: string, env: NodeJS.ProcessEnv): any {
  const script = join(root, "probe.ts")
  writeFileSync(script, PROBE_PRELUDE.replace("__KEY_URL__", JSON.stringify(KEY_URL)) + body)
  const res = spawnSync("bun", [script], { env, encoding: "utf8", windowsHide: true })
  assert.equal(res.status, 0, `${res.stdout ?? ""}${res.stderr ?? ""}`)
  const line = (res.stdout ?? "").split(/\r?\n/).find((l) => l.startsWith("PROBE="))
  assert.ok(line, `bun 探针没有输出结果：${res.stdout ?? ""}${res.stderr ?? ""}`)
  return JSON.parse(line.slice("PROBE=".length))
}

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
  // cwd 用临时目录：configCandidates 会从 cwd 逐级向上找配置，fixture 目录的祖先里
  // 一旦出现 opencode.json 就会抢先命中，测试会变成在验证别的东西。
  const isolated = mkdtempSync(join(tmpdir(), "oc-key-isolated-"))
  try {
    process.env.GROQ_API_KEY = "gsk-global-5678"
    setGlobalConfigDir()
    // 前置自检：该 cwd 的祖先链必须查不到任何配置，否则下面的断言失去意义
    assert.equal(resolveApiKeyFromConfig("__isolation_probe__", { cwd: isolated }), undefined)
    assert.equal(resolveApiKeyFromConfig("groq", { cwd: isolated }), "gsk-global-5678")
  } finally {
    rmSync(isolated, { recursive: true, force: true })
  }
})

// ─── 自定义全局配置根（OPENCODE_CONFIG_DIR） ───
test("OPENCODE_CONFIG_DIR 指定的全局配置根优先于 XDG 根", () => {
  const { root, cwd } = isolatedProject("oc-key-config-dir-")
  const customRoot = join(root, "custom config")
  mkdirSync(customRoot, { recursive: true })
  writeFileSync(
    join(customRoot, "opencode.json"),
    JSON.stringify({ providers: { "custom-root-probe": { settings: { apiKey: "from-config-dir" } } } }),
  )
  try {
    // XDG 根里放另一个 key：若实现仍读 XDG 根，会拿到错误的值
    process.env.XDG_CONFIG_HOME = join(fixtures, "global")
    process.env.OPENCODE_CONFIG_DIR = customRoot
    assert.equal(resolveApiKeyFromConfig("custom-root-probe", { cwd }), "from-config-dir")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ─── 凭据行解码与 Console 端点判定（公开的解析原语，无 DB） ───
test("凭据行解码：key / oauth 取 token，external 与坏值不产出", () => {
  const key = decodeCredentialRow(JSON.stringify({ type: "key", key: "sk-1" }))
  assert.equal(key?.token, "sk-1")
  assert.equal(key?.value.type, "key")

  const oauth = decodeCredentialRow(JSON.stringify({ type: "oauth", access: "at-2", refresh: "rt", expires: 0 }))
  assert.equal(oauth?.token, "at-2")

  assert.equal(decodeCredentialRow(JSON.stringify({ type: "external", methodID: "azure-cli" })), undefined)
  assert.equal(decodeCredentialRow(JSON.stringify({ type: "key" })), undefined)
  assert.equal(decodeCredentialRow(JSON.stringify({ type: "oauth" })), undefined)
  assert.equal(decodeCredentialRow(JSON.stringify({ type: "key", key: "" })), undefined)
  assert.equal(decodeCredentialRow(JSON.stringify({ type: "oauth", access: "" })), undefined)
  assert.equal(decodeCredentialRow("{broken"), undefined)
  assert.equal(decodeCredentialRow(42), undefined)
  assert.equal(decodeCredentialRow(JSON.stringify(["key"])), undefined)
})

test("Console 公共端点判定：默认主机同名路径唯一，其他主机/路径/非法输入都不是", () => {
  assert.equal(isPublicConsoleServer("https://opencode.ai/console"), true)
  assert.equal(isPublicConsoleServer("https://opencode.ai/console/"), true)
  assert.equal(isPublicConsoleServer("https://console.opencode.ai"), true)
  assert.equal(isPublicConsoleServer("https://console.opencode.ai/"), true)
  assert.equal(isPublicConsoleServer("https://opencode.ai/enterprise"), false)
  assert.equal(isPublicConsoleServer("https://dev.opencode.ai/console"), false)
  assert.equal(isPublicConsoleServer("https://opencode.ai/console/team"), false)
  assert.equal(isPublicConsoleServer("not a url"), false)

  assert.equal(consoleServerStateOf({ type: "key", key: "k" }), "public")
  assert.equal(consoleServerStateOf({ type: "key", key: "k", metadata: {} }), "public")
  assert.equal(consoleServerStateOf({ type: "key", key: "k", metadata: { server: 42 } }), "invalid")
  assert.equal(consoleServerStateOf({ type: "key", key: "k", metadata: { server: "not a url" } }), "invalid")
  assert.equal(
    consoleServerStateOf({ type: "key", key: "k", metadata: { server: "https://opencode.ai/enterprise" } }),
    "non-public",
  )
})

// ─── 配置兜底（无宿主连接）：key 与身份 ───
test("resolveProviderCredential 配置路径返回 key 与身份", async () => {
  const credential = await resolveProviderCredential("anthropic", { cwd: projectDir })
  assert.equal(credential?.key, "sk-ant-test-0000")
  assert.ok(credential?.identity)
})

test("配置兜底生效，且身份只随 key 与配置来源变化", async () => {
  const { root, cwd } = isolatedProject("oc-key-identity-")
  try {
    isolateKeySources(root)
    const shared = "identity-shared-key"
    writeProjectKeys(cwd, {
      "identity-probe-a": shared,
      "identity-probe-b": shared,
      "identity-probe-c": "identity-other-key",
    })

    // 同 key 两次（换 providerID 绕开 keyCache，身份仍应只看 key 与来源）
    const first = await resolveProviderCredential("identity-probe-a", { cwd })
    const same = await resolveProviderCredential("identity-probe-b", { cwd })
    const other = await resolveProviderCredential("identity-probe-c", { cwd })
    assert.equal(first?.key, shared)
    assert.equal(same?.key, shared)
    assert.equal(first?.identity, same?.identity)
    assert.notEqual(first?.identity, other?.identity)

    // 换 cwd：同一份配置内容，配置来源变化 → 新身份
    const moved = join(root, "moved")
    mkdirSync(moved, { recursive: true })
    writeProjectKey(moved, "identity-probe-a", shared)
    const movedCredential = await resolveProviderCredential("identity-probe-a", { cwd: moved })
    assert.equal(movedCredential?.key, shared)
    assert.notEqual(movedCredential?.identity, first?.identity)

    // 换全局根（cwd 无项目配置）：同一 key，来源变化 → 新身份
    const bare = join(root, "bare")
    mkdirSync(bare, { recursive: true })
    const identities: string[] = []
    for (const dir of ["global one", "global two"]) {
      const configRoot = join(root, dir)
      mkdirSync(configRoot, { recursive: true })
      writeFileSync(
        join(configRoot, "opencode.json"),
        JSON.stringify({ providers: { "identity-global-probe": { settings: { apiKey: "global-shared-key" } } } }),
      )
      process.env.OPENCODE_CONFIG_DIR = configRoot
      const credential = await resolveProviderCredential("identity-global-probe", { cwd: bare })
      assert.equal(credential?.key, "global-shared-key")
      identities.push(credential?.identity ?? "")
    }
    assert.ok(identities[0] && identities[1])
    assert.notEqual(identities[0], identities[1])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("解析结果在 TTL 内复用：配置文件删除后仍命中", async () => {
  const { root, cwd } = isolatedProject("oc-key-cache-ttl-")
  const pid = "cache-ttl-probe"
  try {
    isolateKeySources(root)
    const file = writeProjectKey(cwd, pid, "cached-key")
    assert.equal((await resolveProviderCredential(pid, { cwd }))?.key, "cached-key")
    rmSync(file)
    assert.equal((await resolveProviderCredential(pid, { cwd }))?.key, "cached-key")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("无凭据 → undefined（配置与 DB 都无来源）", async () => {
  assert.equal(await resolveProviderCredential("nonexistent", { cwd: projectDir }), undefined)
})

test("空 pid → undefined", async () => {
  assert.equal(await resolveProviderCredential("", { cwd: projectDir }), undefined)
})

// ─── 宿主 DB：选行、集成映射、Console 端点、身份 ───
test(
  "宿主 integrationID 精确匹配：只读该 integration 的凭据",
  { skip: hasBun ? false : "需要 bun 的 bun:sqlite（node 无此模块）" },
  () => {
    const root = mkdtempSync(join(tmpdir(), "oc-key-integration-"))
    const cwd = join(root, "project")
    mkdirSync(cwd, { recursive: true })
    const dbPath = join(root, "creds.db")
    try {
      const body = `
        seed(process.env.OPENCODE_DB, [
          { id: "cred-console", integrationID: "opencode", value: oauthValue("console-token"), active: 1, created: 100 },
          { id: "cred-go", integrationID: "opencode-go", value: keyValue("go-key"), active: 1, created: 200 },
        ])
        const fromConsole = await resolveProviderCredential("opencode-go", { cwd: process.env.PROBE_CWD, integrationID: "opencode" })
        const fromGo = await resolveProviderCredential("opencode-go", { cwd: process.env.PROBE_CWD, integrationID: "opencode-go" })
        emit({ fromConsole: shape(fromConsole), fromGo: shape(fromGo) })
      `
      const out = runBunProbe(root, body, probeEnv(root, dbPath, cwd))
      assert.equal(out.fromConsole.key, "console-token")
      assert.equal(out.fromGo.key, "go-key")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)

test(
  "无映射的非 Console 供应商按 providerID 查询",
  { skip: hasBun ? false : "需要 bun 的 bun:sqlite（node 无此模块）" },
  () => {
    const root = mkdtempSync(join(tmpdir(), "oc-key-provider-"))
    const cwd = join(root, "project")
    mkdirSync(cwd, { recursive: true })
    const dbPath = join(root, "creds.db")
    try {
      const body = `
        seed(process.env.OPENCODE_DB, [
          { id: "cred-probe", integrationID: "db-probe", value: keyValue("db-probe-key"), active: 1, created: 100 },
        ])
        const credential = await resolveProviderCredential("db-probe", { cwd: process.env.PROBE_CWD })
        emit({ credential: shape(credential) })
      `
      const out = runBunProbe(root, body, probeEnv(root, dbPath, cwd))
      assert.equal(out.credential.key, "db-probe-key")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)

test(
  "DB 可读但该 integration 零行时允许配置兜底",
  { skip: hasBun ? false : "需要 bun 的 bun:sqlite（node 无此模块）" },
  () => {
    const root = mkdtempSync(join(tmpdir(), "oc-key-empty-"))
    const cwd = join(root, "project")
    mkdirSync(cwd, { recursive: true })
    writeProjectKey(cwd, "zero-row-probe", "config-zero-row-key")
    const dbPath = join(root, "creds.db")
    try {
      const body = `
        // 这个库可读，但只有别的 integration 的凭据：该 integration 零行 = 无宿主连接
        seed(process.env.OPENCODE_DB, [
          { id: "other-row", integrationID: "zero-row-other", value: keyValue("other-key"), active: 1 },
        ])
        const credential = await resolveProviderCredential("zero-row-probe", { cwd: process.env.PROBE_CWD })
        emit({ credential: shape(credential) })
      `
      const out = runBunProbe(root, body, probeEnv(root, dbPath, cwd))
      assert.equal(out.credential.key, "config-zero-row-key")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)

test(
  "已映射的 Console 供应商在该 integration 零行时回退配置，不当作未就绪",
  { skip: hasBun ? false : "需要 bun 的 bun:sqlite（node 无此模块）" },
  () => {
    const root = mkdtempSync(join(tmpdir(), "oc-key-empty-console-"))
    const cwd = join(root, "project")
    mkdirSync(cwd, { recursive: true })
    writeProjectKey(cwd, "opencode-go", "config-console-key")
    const dbPath = join(root, "creds.db")
    try {
      const body = `
        // integration "opencode" 零行 = 宿主映射已同步但该账号未登录
        seed(process.env.OPENCODE_DB, [
          { id: "other-row", integrationID: "zero-row-other", value: keyValue("other-key"), active: 1 },
        ])
        const credential = await resolveProviderCredential("opencode-go", { cwd: process.env.PROBE_CWD, integrationID: "opencode" })
        emit({ credential: shape(credential) })
      `
      const out = runBunProbe(root, body, probeEnv(root, dbPath, cwd))
      assert.equal(out.credential.key, "config-console-key")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)

test(
  "无映射的 Console 供应商不查 DB 也不回退配置",
  { skip: hasBun ? false : "需要 bun 的 bun:sqlite（node 无此模块）" },
  () => {
    const root = mkdtempSync(join(tmpdir(), "oc-key-unmapped-"))
    const cwd = join(root, "project")
    mkdirSync(cwd, { recursive: true })
    writeProjectKey(cwd, "opencode-go", "config-go-key")
    const dbPath = join(root, "creds.db")
    try {
      const body = `
        seed(process.env.OPENCODE_DB, [
          { id: "cred-go", integrationID: "opencode-go", value: keyValue("db-go-key"), active: 1, created: 100 },
        ])
        const credential = await resolveProviderCredential("opencode-go", { cwd: process.env.PROBE_CWD })
        emit({ credential: shape(credential) })
      `
      const out = runBunProbe(root, body, probeEnv(root, dbPath, cwd))
      assert.equal(out.credential, "null")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)

test(
  "多 active 与 legacy 行按宿主规则选行",
  { skip: hasBun ? false : "需要 bun 的 bun:sqlite（node 无此模块）" },
  () => {
    const root = mkdtempSync(join(tmpdir(), "oc-key-order-"))
    const cwd = join(root, "project")
    mkdirSync(cwd, { recursive: true })
    const dbPath = join(root, "creds.db")
    try {
      const body = `
        seed(process.env.OPENCODE_DB, [
          // 时间列以 time_created 为准，time_updated 更晚也不改变选行
          { id: "created-old", integrationID: "order-created", value: keyValue("key-created-old"), active: 1, created: 100, updated: 999 },
          { id: "created-new", integrationID: "order-created", value: keyValue("key-created-new"), active: 1, created: 200, updated: 100 },
          // legacy 行没有 active：同为 NULL 时按 time_created 取最新
          { id: "legacy-old", integrationID: "order-legacy", value: keyValue("key-legacy-old"), active: null, created: 100 },
          { id: "legacy-new", integrationID: "order-legacy", value: keyValue("key-legacy-new"), active: null, created: 200 },
          // 同 created 时按 id 倒序
          { id: "cred-a", integrationID: "order-id", value: keyValue("key-id-a"), active: 1, created: 300 },
          { id: "cred-b", integrationID: "order-id", value: keyValue("key-id-b"), active: 1, created: 300 },
        ])
        const created = await resolveProviderCredential("order-created", { cwd: process.env.PROBE_CWD })
        const legacy = await resolveProviderCredential("order-legacy", { cwd: process.env.PROBE_CWD })
        const byId = await resolveProviderCredential("order-id", { cwd: process.env.PROBE_CWD })
        emit({ created: shape(created), legacy: shape(legacy), byId: shape(byId) })
      `
      const out = runBunProbe(root, body, probeEnv(root, dbPath, cwd))
      assert.equal(out.created.key, "key-created-new")
      assert.equal(out.legacy.key, "key-legacy-new")
      assert.equal(out.byId.key, "key-id-b")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)

test(
  "有效行 external / 缺字段 / 坏 JSON 时不回退旧行与配置",
  { skip: hasBun ? false : "需要 bun 的 bun:sqlite（node 无此模块）" },
  () => {
    const root = mkdtempSync(join(tmpdir(), "oc-key-invalid-"))
    const cwd = join(root, "project")
    mkdirSync(cwd, { recursive: true })
    writeProjectKeys(cwd, {
      "invalid-external": "config-invalid-external",
      "invalid-missing": "config-invalid-missing",
      "invalid-json": "config-invalid-json",
    })
    const dbPath = join(root, "creds.db")
    try {
      const body = `
        seed(process.env.OPENCODE_DB, [
          { id: "external-old", integrationID: "invalid-external", value: keyValue("old-external-key"), active: 1, created: 100 },
          { id: "external-new", integrationID: "invalid-external", value: JSON.stringify({ type: "external", methodID: "azure-cli" }), active: 1, created: 200 },
          { id: "missing-old", integrationID: "invalid-missing", value: keyValue("old-missing-key"), active: 1, created: 100 },
          { id: "missing-new", integrationID: "invalid-missing", value: JSON.stringify({ type: "key" }), active: 1, created: 200 },
          { id: "json-old", integrationID: "invalid-json", value: keyValue("old-json-key"), active: 1, created: 100 },
          { id: "json-new", integrationID: "invalid-json", value: "{broken", active: 1, created: 200 },
        ])
        const external = await resolveProviderCredential("invalid-external", { cwd: process.env.PROBE_CWD })
        const missing = await resolveProviderCredential("invalid-missing", { cwd: process.env.PROBE_CWD })
        const broken = await resolveProviderCredential("invalid-json", { cwd: process.env.PROBE_CWD })
        emit({ external: shape(external), missing: shape(missing), broken: shape(broken) })
      `
      const out = runBunProbe(root, body, probeEnv(root, dbPath, cwd))
      assert.equal(out.external, "null")
      assert.equal(out.missing, "null")
      assert.equal(out.broken, "null")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)

test(
  "Console 供应商按 metadata.server 判定；非 Console 供应商不检查 server",
  { skip: hasBun ? false : "需要 bun 的 bun:sqlite（node 无此模块）" },
  () => {
    const root = mkdtempSync(join(tmpdir(), "oc-key-console-"))
    const cwd = join(root, "project")
    mkdirSync(cwd, { recursive: true })
    const dbPath = join(root, "creds.db")
    try {
      const body = `
        seed(process.env.OPENCODE_DB, [
          { id: "c-default", integrationID: "console-default", value: oauthValue("token-default"), active: 1 },
          { id: "c-legacy", integrationID: "console-legacy", value: oauthValue("token-legacy", { server: "https://console.opencode.ai" }), active: 1 },
          { id: "c-dev", integrationID: "console-dev", value: keyValue("token-dev", { server: "https://dev.opencode.ai/console" }), active: 1 },
          { id: "c-enterprise", integrationID: "console-enterprise", value: keyValue("token-enterprise", { server: "https://opencode.ai/enterprise" }), active: 1 },
          { id: "c-bad", integrationID: "console-bad", value: keyValue("token-bad", { server: "not a url" }), active: 1 },
          { id: "c-nonstr", integrationID: "console-nonstr", value: keyValue("token-nonstr", { server: 42 }), active: 1 },
          { id: "cc-row", integrationID: "cc-server", value: keyValue("token-cc", { server: "https://opencode.ai/enterprise" }), active: 1 },
        ])
        const read = (integrationID) => resolveProviderCredential("opencode", { cwd: process.env.PROBE_CWD, integrationID })
        const fallback = await read("console-default")
        const legacy = await read("console-legacy")
        const dev = await read("console-dev")
        const enterprise = await read("console-enterprise")
        const bad = await read("console-bad")
        const nonString = await read("console-nonstr")
        const nonConsole = await resolveProviderCredential("command-code", { cwd: process.env.PROBE_CWD, integrationID: "cc-server" })
        emit({
          fallback: shape(fallback), legacy: shape(legacy), dev: shape(dev), enterprise: shape(enterprise),
          bad: shape(bad), nonString: shape(nonString), nonConsole: shape(nonConsole),
        })
      `
      const out = runBunProbe(root, body, probeEnv(root, dbPath, cwd))
      assert.equal(out.fallback.key, "token-default")
      assert.equal(out.legacy.key, "token-legacy")
      assert.equal(out.dev, "null")
      assert.equal(out.enterprise, "null")
      assert.equal(out.bad, "null")
      assert.equal(out.nonString, "null")
      assert.equal(out.nonConsole.key, "token-cc")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)

test(
  "同一 credential id 的 OAuth 刷新保持身份，换 id 后身份变化",
  { skip: hasBun ? false : "需要 bun 的 bun:sqlite（node 无此模块）" },
  () => {
    const root = mkdtempSync(join(tmpdir(), "oc-key-refresh-"))
    const cwd = join(root, "project")
    mkdirSync(cwd, { recursive: true })
    const dbPath = join(root, "creds.db")
    // 每步独立进程：身份必须跨进程稳定，缓存不参与
    const body = `
      const mode = process.env.PROBE_MODE
      const file = process.env.OPENCODE_DB
      const cwd = process.env.PROBE_CWD
      if (mode === "seed") {
        seed(file, [{ id: "cred-stable", integrationID: "refresh-scope", value: oauthValue("at-1"), active: 1, created: 100 }])
        emit({})
      } else if (mode === "resolve") {
        const credential = await resolveProviderCredential("refresh-probe", { cwd, integrationID: "refresh-scope" })
        emit({ credential: shape(credential) })
      } else if (mode === "refresh") {
        update(file, "UPDATE credential SET value = ? WHERE id = ?", [oauthValue("at-2"), "cred-stable"])
        emit({})
      } else if (mode === "next") {
        update(file, "UPDATE credential SET active = 0 WHERE integration_id = ?", ["refresh-scope"])
        update(file, "INSERT INTO credential (id, integration_id, label, value, active, time_created, time_updated) VALUES (?, ?, 'test', ?, 1, 200, 200)", ["cred-next", "refresh-scope", oauthValue("at-3")])
        emit({})
      }
    `
    try {
      runBunProbe(root, body, probeEnv(root, dbPath, cwd, "seed"))
      const first = runBunProbe(root, body, probeEnv(root, dbPath, cwd, "resolve")).credential
      assert.equal(first.key, "at-1")

      runBunProbe(root, body, probeEnv(root, dbPath, cwd, "refresh"))
      const refreshed = runBunProbe(root, body, probeEnv(root, dbPath, cwd, "resolve")).credential
      assert.equal(refreshed.key, "at-2")
      assert.equal(refreshed.identity, first.identity)

      runBunProbe(root, body, probeEnv(root, dbPath, cwd, "next"))
      const switched = runBunProbe(root, body, probeEnv(root, dbPath, cwd, "resolve")).credential
      assert.equal(switched.key, "at-3")
      assert.notEqual(switched.identity, refreshed.identity)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)

test(
  "DB 文件存在但无法读取时静默跳过，不回退配置",
  { skip: hasBun ? false : "需要 bun 的 bun:sqlite（node 无此模块）" },
  () => {
    const root = mkdtempSync(join(tmpdir(), "oc-key-broken-"))
    const cwd = join(root, "project")
    mkdirSync(cwd, { recursive: true })
    writeProjectKey(cwd, "broken-db-probe", "config-fallback-key")
    const dbPath = join(root, "broken.db")
    writeFileSync(dbPath, "this is not a sqlite database")
    try {
      const body = `
        const credential = await resolveProviderCredential("broken-db-probe", { cwd: process.env.PROBE_CWD })
        emit({ credential: shape(credential) })
      `
      const out = runBunProbe(root, body, probeEnv(root, dbPath, cwd))
      assert.equal(out.credential, "null")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)

test("DB 文件不可读且运行时无 bun:sqlite 时静默跳过，不回退配置", async () => {
  const root = mkdtempSync(join(tmpdir(), "oc-key-node-db-"))
  const cwd = join(root, "project")
  mkdirSync(cwd, { recursive: true })
  try {
    isolateKeySources(root)
    // XDG_DATA_HOME 下放一个非 SQLite 文件：宿主 DB 存在，但当前运行时读不了
    const dbPath = join(root, "data", "opencode", "opencode.db")
    mkdirSync(dirname(dbPath), { recursive: true })
    writeFileSync(dbPath, "this is not a sqlite database")
    writeProjectKey(cwd, "node-broken-db-probe", "config-node-key")
    assert.equal(await resolveProviderCredential("node-broken-db-probe", { cwd }), null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test(
  "缺少 credential 表的库视为状态不明，不回退配置",
  { skip: hasBun ? false : "需要 bun 的 bun:sqlite（node 无此模块）" },
  () => {
    const root = mkdtempSync(join(tmpdir(), "oc-key-no-table-"))
    const cwd = join(root, "project")
    mkdirSync(cwd, { recursive: true })
    writeProjectKey(cwd, "no-table-probe", "config-no-table-key")
    const dbPath = join(root, "creds.db")
    try {
      const body = `
        const db = new Database(process.env.OPENCODE_DB)
        db.run("CREATE TABLE unrelated (id text primary key)")
        db.close()
        const credential = await resolveProviderCredential("no-table-probe", { cwd: process.env.PROBE_CWD })
        emit({ credential: shape(credential) })
      `
      const out = runBunProbe(root, body, probeEnv(root, dbPath, cwd))
      assert.equal(out.credential, "null")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)

test(
  "显式 OPENCODE_DB 三种形态",
  { skip: hasBun ? false : "需要 bun 的 bun:sqlite（node 无此模块）" },
  () => {
    const root = mkdtempSync(join(tmpdir(), "oc-key-db-"))
    const cwd = join(root, "project dir")
    const dataHome = join(root, "data dir")
    const dbPath = join(root, "abs db", "creds.db")
    mkdirSync(cwd, { recursive: true })
    writeProjectKey(cwd, "db-source-probe", "config-memory-key")
    try {
      const body = `
        const pid = "db-source-probe"
        seed(process.env.PROBE_ABS_DB, [{ id: "cred-abs", integrationID: pid, value: keyValue("db-key-abs"), active: 1 }])
        seed(join(process.env.PROBE_DATA_HOME, "opencode", "rel.db"), [{ id: "cred-rel", integrationID: pid, value: keyValue("db-key-rel"), active: 1 }])

        process.env.OPENCODE_DB = process.env.PROBE_ABS_DB
        const abs = await resolveProviderCredential(pid, { cwd: process.env.PROBE_CWD })

        // 同一 pid/cwd 切换到相对文件名：缓存作用域必须包含实际 DB 路径，不能沿用上一次的结果
        process.env.XDG_DATA_HOME = process.env.PROBE_DATA_HOME
        process.env.OPENCODE_DB = "rel.db"
        const rel = await resolveProviderCredential(pid, { cwd: process.env.PROBE_CWD })

        // :memory: 是宿主进程内的库：视为无连接，走配置兜底且不落盘
        process.env.OPENCODE_DB = ":memory:"
        const memory = await resolveProviderCredential(pid, { cwd: process.env.PROBE_CWD })

        emit({
          abs: shape(abs),
          rel: shape(rel),
          memory: shape(memory),
          memoryFileAtData: existsSync(join(process.env.PROBE_DATA_HOME, "opencode", ":memory:")),
          memoryFileAtCwd: existsSync(join(process.env.PROBE_CWD, ":memory:")),
        })
      `
      const out = runBunProbe(root, body, {
        ...probeEnv(root, dbPath, cwd),
        PROBE_ABS_DB: dbPath,
        PROBE_DATA_HOME: dataHome,
      })
      assert.equal(out.abs.key, "db-key-abs")
      assert.equal(out.rel.key, "db-key-rel")
      assert.equal(out.memory.key, "config-memory-key")
      assert.equal(out.memoryFileAtData, false)
      assert.equal(out.memoryFileAtCwd, false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)

test(
  "credentialCache 作用域：cwd / 全局根 / DB / integrationID 变化不串缓存，null 与 undefined 不缓存",
  { skip: hasBun ? false : "需要 bun 的 bun:sqlite（node 无此模块）" },
  async () => {
    const first = isolatedProject("oc-key-scope-a-")
    const second = isolatedProject("oc-key-scope-b-")
    try {
      isolateKeySources(first.root)
      // cwd 变化
      writeProjectKey(first.cwd, "cache-cwd-probe", "key-from-a")
      writeProjectKey(second.cwd, "cache-cwd-probe", "key-from-b")
      assert.equal((await resolveProviderCredential("cache-cwd-probe", { cwd: first.cwd }))?.key, "key-from-a")
      assert.equal((await resolveProviderCredential("cache-cwd-probe", { cwd: second.cwd }))?.key, "key-from-b")

      // 全局根变化
      for (const [dir, key] of [
        ["root one", "root-one-key"],
        ["root two", "root-two-key"],
      ]) {
        const configRoot = join(first.root, dir)
        mkdirSync(configRoot, { recursive: true })
        writeFileSync(join(configRoot, "opencode.json"), JSON.stringify({ providers: { "cache-root-probe": { settings: { apiKey: key } } } }))
      }
      const bare = join(first.root, "bare")
      mkdirSync(bare, { recursive: true })
      process.env.OPENCODE_CONFIG_DIR = join(first.root, "root one")
      assert.equal((await resolveProviderCredential("cache-root-probe", { cwd: bare }))?.key, "root-one-key")
      process.env.OPENCODE_CONFIG_DIR = join(first.root, "root two")
      assert.equal((await resolveProviderCredential("cache-root-probe", { cwd: bare }))?.key, "root-two-key")

      // undefined 不缓存
      const late = join(first.root, "late")
      mkdirSync(late, { recursive: true })
      assert.equal(await resolveProviderCredential("cache-miss-probe", { cwd: late }), undefined)
      writeProjectKey(late, "cache-miss-probe", "late-key")
      assert.equal((await resolveProviderCredential("cache-miss-probe", { cwd: late }))?.key, "late-key")

      // DB / integrationID / null 不缓存
      const probeRoot = mkdtempSync(join(tmpdir(), "oc-key-cache-db-"))
      try {
        const cwd = join(probeRoot, "project")
        mkdirSync(cwd, { recursive: true })
        const dbOne = join(probeRoot, "one.db")
        const dbTwo = join(probeRoot, "two.db")
        const dbScope = join(probeRoot, "scope.db")
        const body = `
          const cwd = process.env.PROBE_CWD
          seed(process.env.PROBE_DB_ONE, [{ id: "db-one-cred", integrationID: "cache-db-probe", value: keyValue("db-one-key"), active: 1 }])
          seed(process.env.PROBE_DB_TWO, [{ id: "db-two-cred", integrationID: "cache-db-probe", value: keyValue("db-two-key"), active: 1 }])
          seed(process.env.PROBE_DB_SCOPE, [
            { id: "int-a", integrationID: "cache-int-a", value: keyValue("int-a-key"), active: 1 },
            { id: "int-b", integrationID: "cache-int-b", value: keyValue("int-b-key"), active: 1 },
            { id: "null-row", integrationID: "cache-null-scope", value: keyValue("null-token", { server: "https://opencode.ai/enterprise" }), active: 1 },
          ])

          process.env.OPENCODE_DB = process.env.PROBE_DB_ONE
          const dbFirst = await resolveProviderCredential("cache-db-probe", { cwd })
          process.env.OPENCODE_DB = process.env.PROBE_DB_TWO
          const dbSecond = await resolveProviderCredential("cache-db-probe", { cwd })

          process.env.OPENCODE_DB = process.env.PROBE_DB_SCOPE
          const integrationA = await resolveProviderCredential("cache-int-probe", { cwd, integrationID: "cache-int-a" })
          const integrationB = await resolveProviderCredential("cache-int-probe", { cwd, integrationID: "cache-int-b" })

          const skipped = await resolveProviderCredential("opencode", { cwd, integrationID: "cache-null-scope" })
          update(process.env.PROBE_DB_SCOPE, "UPDATE credential SET value = ? WHERE id = ?", [keyValue("null-token"), "null-row"])
          const recovered = await resolveProviderCredential("opencode", { cwd, integrationID: "cache-null-scope" })

          emit({
            dbFirst: shape(dbFirst), dbSecond: shape(dbSecond),
            integrationA: shape(integrationA), integrationB: shape(integrationB),
            skipped: shape(skipped), recovered: shape(recovered),
          })
        `
        const out = runBunProbe(probeRoot, body, {
          ...probeEnv(probeRoot, dbOne, cwd),
          PROBE_DB_ONE: dbOne,
          PROBE_DB_TWO: dbTwo,
          PROBE_DB_SCOPE: dbScope,
        })
        assert.equal(out.dbFirst.key, "db-one-key")
        assert.equal(out.dbSecond.key, "db-two-key")
        assert.equal(out.integrationA.key, "int-a-key")
        assert.equal(out.integrationB.key, "int-b-key")
        assert.equal(out.skipped, "null")
        assert.equal(out.recovered.key, "null-token")
      } finally {
        rmSync(probeRoot, { recursive: true, force: true })
      }
    } finally {
      rmSync(first.root, { recursive: true, force: true })
      rmSync(second.root, { recursive: true, force: true })
    }
  },
)
