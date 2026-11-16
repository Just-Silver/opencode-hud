<!-- 职责：执行计划——本机凭据解析与额度状态机跟随宿主账号（Task 2–3）；不写：交付链路与发版（见 2026-11-16-verified-delivery.md）、计数与文档收口（见 2026-11-16-validation-docs.md）、设计裁定（见 2026-11-16-audit-decisions-design.md）。 -->

# 凭据与宿主账号跟随 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让额度查询始终使用宿主当前有效账号的凭据；宿主没有连接时才用配置兜底，状态不明时静默跳过。

**Architecture:** `quota/key.ts` 成为唯一凭据解析器：SQL 直接取宿主等价的第一行，`decodeCredentialRow` 只做行值解析，返回 `{key, identity}` 或 `null`（有意跳过）/`undefined`（无来源）。`model/quota.ts` 用 identity 分桶。`quota/host.ts` 由插件 setup 绑定宿主访问器，映射规则与宿主一致（`integrationID ?? provider.id`），hook 每次调用时读取。

**Tech Stack:** TypeScript（Node 原生 TS strip 测试）、Bun 运行时（`bun:sqlite` 只读真库探针）、Solid（仅接线，无新测试环境）。

**Spec:** `docs/superpowers/specs/2026-11-16-audit-decisions-design.md`

## Global Constraints

- 测试命令：`node --test tests/*.test.ts`（Node ≥ 23.6，零安装）；单文件 `node --test tests/key.test.ts`。
- 编译门禁：`npx --yes esbuild .opencode/plugins/opencode-hud/tui.tsx --bundle --platform=node --format=esm --jsx=automatic --jsx-import-source=@opentui/solid --external:@opencode/plugin/tui --external:@opentui/solid --external:solid-js --outfile=$env:TEMP\opencode\tui-bundle-check.js`。
- 相对导入必须带 `.ts`/`.tsx` 后缀。
- 不新增依赖、不引入打包器/测试框架；不改 `package.json`（仓库没有）。
- `quota/key.ts` 不记日志、不落盘、不刷新 token；错误信息与日志不得包含 key。
- 刷新节奏不变：`QUOTA_REFRESH_MS = 5 * 60_000`、退避 5→10→15min、`Retry-After` 优先、在途切号逻辑保留。
- 计数、交付链路、文档收口不在本计划。
- **禁止 `git commit` / `git push` / 发版**。每个任务开始前 `pwsh -NoProfile -File .superpowers/decisions-2026-11-16/task-snapshot.ps1 -Mode capture -Name task-0N-<slug>`；结束时用 `-Mode review` 生成 `review.diff`，把结果与命令输出写进 `.superpowers/decisions-2026-11-16/task-0N-report.md`（忽略目录，不提交）。

## Review Focus

- 宿主有效行是 `external`/坏 JSON/非公共 Console 时不能读配置或旧行顶替（Task 2 测试 6、7）。
- 多 active / legacy 行的选行与宿主一致，且用真库行为断言而不是私有比较器（Task 2 测试 5）。
- 已同步但缺 `integrationID` 的 provider 不能当成"未就绪"，否则额度永久消失（Task 3 测试 8）。
- 同一账号 OAuth token 刷新后额度不能消失、不能多发请求（Task 3 测试 1）。
- 组件重建/重绑后额度解析必须仍用当前宿主上下文（Task 3 测试 7）。

---

### Task 2: 宿主账号优先的凭据解析器

**Files:**
- Modify: `.opencode/plugins/opencode-hud/quota/key.ts`
- Test: `tests/key.test.ts`

**Interfaces:**
- Produces:
  - `export type QuotaCredential = { key: string; identity: string }`
  - `export async function resolveProviderCredential(providerID: string, opts?: { cwd?: string; integrationID?: string }): Promise<QuotaCredential | null | undefined>`
  - `export function decodeCredentialRow(value: unknown): { token: string; value: Record<string, unknown> } | undefined`
  - `export function consoleServerStateOf(value: unknown): "public" | "non-public" | "invalid"`
  - `export function isPublicConsoleServer(server: string): boolean`
- Consumes: 现有 `resolveApiKeyFromConfig`、`globalConfigDir()`、`databaseFile()`（保持私有）。
- 删除：`credentialIntegrationIDs`、`pickStoredCredentialToken`、`pickStoredCredential`（不再暴露任何排序面）。
- 临时保留：`resolveProviderKey(providerID, opts?): Promise<string | undefined>` 改成委托新解析器（`null`/`undefined` 都折叠为 `undefined`），只因为 `view/hooks/useQuota.ts` 与 `model/quota.ts` 在 Task 3 才迁移；Task 3 Step 3 删除它，**不得留到批次结束**。

**规则（实现决定，不要自行放宽）：**

1. `integrationIDFor`：`opts.integrationID` 非空 → 用它；否则若 `normID(providerID)` ∈ `{opencode, opencodego}` → **返回 `null`**（真正的未就绪，不查 DB、不读配置）；否则用 `providerID`。
2. 选行：`SELECT id, value FROM credential WHERE integration_id = ? ORDER BY active DESC, time_created DESC, id DESC LIMIT 1`。**不在 JS 里重排、不取全量行、不暴露比较器**；宿主等价性由这条 SQL 与真库探针保证。
3. 行值解析：`decodeCredentialRow(value)` 对 `value` 字符串做 JSON 解析 → `type:"key"` 取 `key`、`type:"oauth"` 取 `access`，返回 `{ token, value: 解析后的对象 }`；`external`/缺字段/坏 JSON/非对象 → `undefined`。行存在但解析失败 → 整体 `null`（不回退历史行）。
4. Console server 只对 Console 供应商（`normID ∈ {opencode, opencodego}`）检查，规则：
   - `value.metadata` 缺失/不是对象，或 `metadata.server === undefined` → `"public"`（宿主默认公共）。
   - `metadata.server` 存在但不是字符串 → `"invalid"`（跳过，**不得**回落到默认公共，否则企业 token 会被发到 `opencode.ai`）。
   - 字符串 → 去尾部 `/`；`https://console.opencode.ai`（带或不带路径）按宿主规则改写为默认主机同名路径；能 `URL` 解析且规范化后**严格等于** `https://opencode.ai/console` → `"public"`，其余 origin/path → `"non-public"`；解析失败 → `"invalid"`。
   - 非 Console 供应商不读 `metadata.server`，不做该检查。
5. DB 状态：
   - `databaseFile()` 为 `undefined`（`:memory:`）或文件不存在 → 无连接：允许配置兜底。
   - 文件存在但 `import("bun:sqlite")` 失败、`new Database` 失败、查询失败（含缺表）→ `null`，**不读配置、不记日志**。
   - 查询成功但该 integration 零行 → 无连接：配置兜底。
6. 配置兜底：`resolveApiKeyFromConfig(providerID, { cwd })` 命中 → `{key, identity}`；未命中 → `undefined`。
7. 身份（`sha256(...).slice(0,16)`，路径只进哈希；身份是内部缓存桶键，不是对外契约）：
   - OAuth：`credential:<dbScope12>:<integrationID>:<credentialID>:oauth`
   - key：`credential:<dbScope12>:<integrationID>:<credentialID>:key:<key12>`
   - 配置：`config:<configScope12>:<key12>`，`configScope12 = sha256([resolve(cwd), resolve(globalConfigDir())].join("\0"))`
   - `dbScope12 = sha256(databaseFile() ?? ":memory:")`
8. 缓存：`Map<string, { credential: QuotaCredential; at: number }>`，键 = `providerID + "\0" + integrationID + "\0" + cacheScope(cwd)`，TTL 60 s；只缓存成功结果；`null`/`undefined` 不缓存。
9. `providerID` 为空 → `undefined`。

- [ ] **Step 1: 先写失败回归（纯函数 + bun 子进程真库）**

在 `tests/key.test.ts` 增加/改写以下用例（保留现有配置读取、JSONC、环境变量隔离用例；把 `resolveProviderKey` 调用改为 `resolveProviderCredential` 并断言 `.key`）：
1. `"配置兜底生效，且身份只随 key 与配置来源变化"`：无 DB 文件 + 项目配置 → 返回可用凭据；同 key 两次 identity **相等**、换 key 后**不相等**、换 cwd/全局根（配置来源变化）后**不相等**。不断言任何身份字符串前缀。
2. `"宿主 integrationID 精确匹配：只读该 integration 的凭据"`（bun 真库：同时有 `opencode` 与 `opencode-go` 行，传 `integrationID:"opencode"` 只取前者）。
3. `"无映射的非 Console 供应商按 providerID 查询"`（bun 真库：`db-probe` integration 行可读到；不传 integrationID）。
4. `"无映射的 Console 供应商不查 DB 也不回退配置"`（bun 真库：`opencode-go` + DB 有 `opencode-go` 行 + 项目配置有 key → `null`）。
5. `"多 active 与 legacy 行按宿主规则选行"`（bun 真库：A created=100/updated=999、B created=200/updated=100 → 取 B；两行 active=NULL 同样取 B；两行 active=1 同 created 时按 id 倒序）。只断言解析结果，不测比较器。
6. `"有效行 external / 缺字段 / 坏 JSON 时不回退旧行与配置"`（bun 真库，三种种子各一断言）。
7. `"Console 供应商按 metadata.server 判定；非 Console 供应商不检查 server"`：
   - 默认（缺 server）→ 正常取到；
   - `https://console.opencode.ai` → 正常取到；
   - `https://dev.opencode.ai/console`、`https://opencode.ai/enterprise`、非法 URL → `null`；
   - `server` 存在但非字符串（如 `42`）→ `null`；
   - 同一份 `metadata.server` 放在非 Console integration（如 `command-code`）→ 仍正常取到（不误伤）。
8. `"同一 credential id 的 OAuth 刷新保持身份，换 id 后身份变化"`（bun 真库：同 id 改 access → identity 相等；插入新 id 行成为有效行 → 不相等）。
9. `"DB 文件存在但无法读取时静默跳过，不回退配置"`（bun 真库：非 SQLite 文件 + 配置有 key → `null`）。
10. `"显式 OPENCODE_DB 三种形态"`（迁移现有探针：绝对路径、相对 dataDir、`:memory:`；`:memory:` 时配置兜底生效、不落盘 `:memory:` 文件）。
11. `"keyCache 作用域：cwd / 全局根 / DB / integrationID 变化不串缓存，null 与 undefined 不缓存"`。

- [ ] **Step 2: 运行，确认红**

Run: `node --test tests/key.test.ts`
Expected: FAIL（`resolveProviderCredential` 未导出 / `decodeCredentialRow` 不存在 / 旧 SQL 选错账号）。

- [ ] **Step 3: 实现 `quota/key.ts`**

按规则 1–9 实现；文件顶部约束注释改为"宿主有效连接优先、仅无连接时配置兜底；状态不明跳过"，去掉"配置优先、DB 兜底"旧说明。SQL 常量直接写规则 2 的语句（含 `LIMIT 1`），不写排序函数。

- [ ] **Step 4: 运行，确认绿**

Run: `node --test tests/key.test.ts`
Expected: PASS；bun 探针用例 0 skip（本机有 bun；缺 bun 时如实 skip 并在报告中说明）。

- [ ] **Step 5: 全量 + 编译**

Run: `node --test tests/*.test.ts`
Expected: 全部 pass、0 fail（被替换的旧用例已删除，不保留平行用例）。
Run: esbuild 命令（见 Global Constraints）。
Expected: `Done in`，无报错。
（若 `model/quota.ts` 的 string 桩导致 store 测试类型不匹配，允许把该迁移并入 Task 3，但不得为省改测试保留 string 兼容分支。）

- [ ] **Step 6: 记录证据（不提交）**

Run: `pwsh -NoProfile -File .superpowers/decisions-2026-11-16/task-snapshot.ps1 -Mode review -Name task-02-credential`
Expected: 输出 `review.diff` 路径；把 `node --test tests/key.test.ts` 与全量输出写进 `task-02-credential-report.md`。

---

### Task 3: 额度状态机的身份语义与宿主接线

**Files:**
- Modify: `.opencode/plugins/opencode-hud/model/quota.ts`
- Create: `.opencode/plugins/opencode-hud/quota/host.ts`
- Modify: `.opencode/plugins/opencode-hud/tui.tsx`
- Modify: `.opencode/plugins/opencode-hud/view/hooks/useQuota.ts`
- Test: `tests/quota-store.test.ts`、`tests/key.test.ts`（仅当 Task 2 的 store 迁移留到这里）
- 新建测试：`tests/quota-host.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `resolveProviderCredential`、`QuotaCredential`。
- Produces:
  - `model/quota.ts`：`export type QuotaKey = { key: string; identity: string }`；`export type QuotaKeyResolution = QuotaKey | null | undefined`；`QuotaDeps.resolveKey(pid): Promise<QuotaKeyResolution>`（`fetch` 签名不变）。
  - `quota/host.ts`：`export type QuotaHostSource = { providerIntegrationID(pid: string): string | undefined; directory(): string | undefined }`；`export function bindQuotaHost(source: QuotaHostSource | undefined): void`；`export function hostIntegrationID(pid: string): string | undefined`；`export function hostDirectory(): string | undefined`。
  - `tui.tsx` 的 `setup(context)` 调用：
    ```ts
    bindQuotaHost({
      providerIntegrationID: (pid) => {
        const p = context.data.location.provider.list()?.find((x) => x.id === pid)
        return p ? (p.integrationID ?? p.id) : undefined
      },
      directory: () => context.data.location.default().directory,
    })
    ```
- 删除：Task 2 临时保留的 `resolveProviderKey`。

**语义（实现决定）：**

1. **映射三态**：provider 不在 `provider.list()`（列表未同步/不存在）→ `undefined`（未就绪）；provider 存在且 `integrationID` 缺失 → 返回 `p.id`（不是未就绪）；provider 存在且有值 → 返回该值。`quota/key.ts` 的 Console `null` 只由 `undefined` 触发。
2. `load` 解析结果三分支：
   - 对象：`fingerprint = identity`，`fetch(pid, apiUrl, resolution.key)`；错误脱敏仍用 `key`。
   - `null`：`adopt(pid, "")` 后立即 `return false`；不 warn、不请求、不写数据、不排程。
   - `undefined`：保持现有 missing 行为（同一状态只 warn 一次）。
3. `inFlight` 的 `fingerprint` 改为 identity；同身份等待直接复用结果，跨身份等待接续一轮（现有两轮结构保留）。
4. 身份变化立即 `adopt` 新桶（旧数据/退避清空）；同身份换 key 保留数据与截止时刻。
5. `useQuota` 的 `resolveKey` 改为每次调用读取 `hostIntegrationID(pid)` 与 `hostDirectory()`，再调 `resolveProviderCredential`；`probe()` 同样带这两个参数，`null`/`undefined` 都不计入 `probeHits`。
6. 不在 hook 内新增组件级缓存；`probedAt/probing/probedHits` 的模块级语义保持不变（probe 重挂问题不在本轮修）。
7. `bindQuotaHost` 由 setup 持有，组件卸载不清除；后一次绑定覆盖前一次。

- [ ] **Step 1: 先写失败回归**

`tests/quota-store.test.ts`：把所有 `resolveKey` 桩改为返回对象（`{ key: "k-test", identity: "id-test" }`），并新增：
1. `"同一身份、key 变化（OAuth 刷新）：数据保留，间隔内不重复请求"`
2. `"新身份（真正换号）：旧数据立即清空，下一次 load 发请求"`
3. `"resolveKey 为 null：不请求、不 warn、不写数据、不排程"`
4. `"resolveKey 为 undefined：只 warn 一次（回归）"`
5. `"在途切号按 identity 判定：旧身份结果丢弃，新身份接续一次"`（改写现有切号用例，断言身份而非 key 哈希）
6. `"5min / 退避 / Retry-After 不因身份改造改变节奏"`（保留现有时钟注入断言）

`tests/quota-host.test.ts`（新，三条行为用例）：
7. `"额度宿主映射随最近一次 setup 绑定切换：A → B → 解绑"`：绑定 A 读到 A 的 integration 与目录；重绑 B 读到 B；`bindQuotaHost(undefined)` 后两者 `undefined`。
8. `"已同步但缺 integrationID 的 provider 按 provider.id 映射，不当作未就绪"`：source 的 `list()` 返回 `[{ id: "opencode-go" }]`（无 integrationID），`providerIntegrationID("opencode-go")` 必须返回 `"opencode-go"`；`provider` 不在列表时才返回 `undefined`。
9. `"目录来自宿主 location.default()，缺失时 undefined"`。

- [ ] **Step 2: 运行，确认红**

Run: `node --test tests/quota-store.test.ts tests/quota-host.test.ts`
Expected: FAIL（`quota-host.ts` 不存在 / 身份未生效 / 映射缺失被当成未就绪）。

- [ ] **Step 3: 实现**

按语义 1–7 落地：`model/quota.ts` 删除 `fingerprintOf`（identity 已是稳定字符串；错误脱敏仍按 key），`resolveKey` 返回类型改为严格 union；新增 `quota/host.ts`；`tui.tsx` setup 绑定；`useQuota.ts` 换用新解析器并删除 `resolveProviderKey` 导入与导出。

- [ ] **Step 4: 运行，确认绿**

Run: `node --test tests/quota-store.test.ts tests/quota-host.test.ts tests/key.test.ts`
Expected: PASS，0 skip（本机有 bun）。

- [ ] **Step 5: 全量 + 编译**

Run: `node --test tests/*.test.ts`；Run: esbuild 命令。
Expected: 全绿；`Done in`。

- [ ] **Step 6: 同步 AGENTS 额度段（事实变更）**

改 `AGENTS.md`「额度（quota/）」：解析顺序改为「宿主有效连接 → 仅无连接时配置兜底」；DB 选行 `time_created` 且 SQL `LIMIT 1`；身份含 DB 来源 scope + integration + id（key/config 另带 key 哈希）；`null` 跳过 vs `undefined` missing；Console 供应商映射未就绪（provider 不在列表）才不查库/不兜底，已同步缺 `integrationID` 按 `provider.id`；非公共 Console 跳过；`metadata.server` 非字符串对 Console 判跳过。

- [ ] **Step 7: 记录证据（不提交）**

Run: `pwsh -NoProfile -File .superpowers/decisions-2026-11-16/task-snapshot.ps1 -Mode review -Name task-03-store-host`
Expected: `review.diff`；报告写入测试输出、esbuild 结果、AGENTS 改动点。
