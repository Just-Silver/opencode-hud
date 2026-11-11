# 额度区块：展示全部已登录订阅 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 额度区块列出本机所有有凭据的已启用供应商；当前会话的展开，其余折叠成一行摘要，点击就地展开。

**Architecture:** registry 增加「列出启用供应商 + 显示名」的只读出口；Sidebar 每 5min 探测一次凭据得到候选集合，按「当前会话 → 运行中子代理在用 → 其余」排序后逐个交给现有 `QuotaStore`（分桶/间隔/退避不变）；`QuotaSection` 从单供应商改为多组列表，组头可点击展开。

**Tech Stack:** TypeScript + Solid（`@opentui/solid`）、Node 内建测试（`node --test`）、esbuild 语法检查；零新增依赖。

**Spec:** `docs/superpowers/specs/2026-11-11-multi-provider-quota-design.md`

## Global Constraints

- 相对导入必须带 `.ts` / `.tsx` 后缀。
- 侧栏宽 42 列，子代理按 34 列常量布局；不新增 `onSizeChange` 实测。
- 组件函数体只执行一次：禁止 `const x = props.x` 快照，取值放 JSX 表达式或惰性 getter。
- 周期性重算的行列表用 `<Index>`；配色只从 `view/theme.ts` 取。
- 无数据区块整块不渲染；不显示「未登录/不支持/无数据」占位。
- 探测与加载不得新增日志：未注册端点静默返回（已实现），没凭据的 warn 已按刷新间隔节流。
- 网络刷新最小间隔 5min（`QUOTA_REFRESH_MS`）；不加新定时器，沿用 `QUOTA_TICK_MS` 心跳。
- 每个提交都能通过 `node --test tests/*.test.ts` 与 esbuild 检查。
- 提交信息用中文。

## Review Focus

1. **已登录但查不了的供应商**（OpenAI API Key / token-sharing、未订 Go 的 Console 登录）：永远没有数据 → 不得出现空的组标题，也不能每 5min 刷日志。→ Task 3 的行集合过滤 + 冒烟 6。
2. **当前会话供应商不是额度供应商**（open-design、Zen）：不得加载、不得记日志；其余订阅照常列出且**全部折叠**，区块不能空、也不能凭空展开一组。→ Task 2 的 `current` 保留用例 + Task 3 的守卫与 `defaultPid = undefined` + 冒烟 2。
3. **凭据中途失效 / 切号**：该行要在一次探测内消失，不能残留旧账号的数据行。→ Task 3 行集合以 `available` 为准 + 冒烟 5。
4. **高度与 42 列宽度**：3 个订阅 + 当前展开时组头不换行、摘要不挤压名称、展开行不被裁。→ Task 3 名称截断 12 列、摘要 `wrapMode="none"`、组间无空行 + 冒烟 1。
5. **切会话 / 侧边栏重建**：手动展开的组保持，未手动干预的组跟随当前供应商；重建不得重复发请求。→ Task 3 模块级 `quotaRowOpen` + 冒烟 3/4。

---

### Task 1: 供应商清单与显示名

**Files:**
- Modify: `.opencode/plugins/opencode-hud/quota/registry.ts`
- Modify: `.opencode/plugins/opencode-hud/quota/index.ts`
- Modify: `.opencode/plugins/opencode-hud/quota/providers/opencode-go.ts:40-45`
- Modify: `.opencode/plugins/opencode-hud/quota/providers/openai.ts:113-118`
- Modify: `.opencode/plugins/opencode-hud/quota/providers/command-code.ts:84-90`
- Test: `tests/discovery.test.ts`, `tests/quota.test.ts`

**Interfaces:**
- Produces:
  - `ProviderRegistration.name?: string`（显示名，缺省回退 `id`）
  - `listProviders(): { id: string; name: string }[]`（仅 `enabled !== false`，保持发现顺序）
  - `getProviderName(pid: string): string | undefined`（归一化命中；未命中 `undefined`）
  - `quota/index.ts` 透出 `listProviders`、`getProviderName`

- [ ] **Step 1: 写失败测试（发现层）**

`tests/discovery.test.ts` 第 6 行的 import 追加 `listProviders, getProviderName`，文件末尾追加：

```ts
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
```

- [ ] **Step 2: 写失败测试（纯注册表层）**

`tests/quota.test.ts` 末尾追加：

```ts
test("listProviders：只返回启用项，省略 name 时回退 id；getProviderName 未命中 undefined", () => {
  const reg = createRegistry([
    opencodeGo,
    { id: "command-code", apiUrl: "https://api.commandcode.ai/alpha/billing/credits", fetch: async () => undefined, enabled: false },
  ])
  assert.deepEqual(reg.listProviders(), [{ id: "opencode-go", name: "opencode-go" }])
  assert.equal(reg.getProviderName("opencode-go"), "opencode-go")
  assert.equal(reg.getProviderName("command-code"), undefined)
})
```

- [ ] **Step 3: 运行测试确认失败**

Run: `node --test tests/discovery.test.ts tests/quota.test.ts`
Expected: FAIL —— `listProviders is not a function` / `reg.listProviders is not a function`。

- [ ] **Step 4: 实现**

`quota/registry.ts`：`ProviderRegistration` 增加 `name?: string`；`createRegistry` 在 `active` 之后加：

```ts
// 有查询能力的供应商清单（保持发现顺序）：UI 用它决定「可以展示哪些供应商」
const listProviders = (): { id: string; name: string }[] =>
  active.map((p) => ({ id: p.id, name: p.name ?? p.id }))

// 显示名：命中用注册名，未命中 undefined（UI 回退 id）
const getProviderName = (pid: string): string | undefined => match(pid)?.name ?? match(pid)?.id
```

把两者加入 `createRegistry` 的返回对象。`quota/index.ts` 的解构与导出同步加上这两项。

三个 provider 的 `provider` 字面量补 `name`：`"OpenCode Go"` / `"OpenAI"` / `"Command Code"`（`id` 不变）。

- [ ] **Step 5: 运行测试确认通过**

Run: `node --test tests/discovery.test.ts tests/quota.test.ts`
Expected: 全部 PASS。

- [ ] **Step 6: 提交**

```bash
git add .opencode/plugins/opencode-hud/quota tests/discovery.test.ts tests/quota.test.ts
git commit -m "feat(quota): 供应商注册表提供启用清单与显示名"
```

---

### Task 2: 排序 / 代表窗口 / 展开判定的纯函数

**Files:**
- Modify: `.opencode/plugins/opencode-hud/model/quota.ts`（`QuotaStore` 之后，文件末尾）
- Test: `tests/quota.test.ts`

**Interfaces:**
- Consumes: `normID`（`shared/id.ts`）、`QuotaItem`（`model/types.ts`）
- Produces:
  - `orderQuotaProviders(input: { current: string | undefined; subagentPids: readonly string[]; available: readonly string[] }): string[]`
    —— 返回**规范 pid**（命中候选时用候选里的写法；`current` 不在候选里时保留原写法）；顺序 current → subagentPids（命中候选者）→ 其余候选（发现顺序）；按 `normID` 去重。
  - `representativeItem(items: readonly QuotaItem[]): QuotaItem | undefined`
  - `isQuotaRowOpen(pid: string, defaultPid: string | undefined, state: ReadonlyMap<string, boolean>): boolean`

- [ ] **Step 1: 写失败测试**

`tests/quota.test.ts` 的 import 增加这三个函数，末尾追加：

```ts
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/quota.test.ts`
Expected: FAIL —— `orderQuotaProviders is not defined`。

- [ ] **Step 3: 实现三个纯函数**

`model/quota.ts` 末尾追加（import 合并进现有语句）：

```ts
// ─── 多订阅展示（纯函数，node 可测） ───
export type QuotaOrderInput = {
  current: string | undefined
  subagentPids: readonly string[]
  available: readonly string[]
}

// 顺序：当前会话 → 本会话运行中子代理在用 → 其余候选（发现顺序）。
// 当前会话供应商不在候选里也保留：它仍走原有按需加载路径（不依赖凭据探测）。
export function orderQuotaProviders(input: QuotaOrderInput): string[] { /* ... */ }

// 折叠行摘要：已用最多（最紧张）的一条；并列取先出现；无百分比取首个有文本的；空 → undefined
export function representativeItem(items: readonly QuotaItem[]): QuotaItem | undefined { /* ... */ }

// 展开态：显式记录优先，否则只有默认行展开
export function isQuotaRowOpen(
  pid: string,
  defaultPid: string | undefined,
  state: ReadonlyMap<string, boolean>,
): boolean {
  return state.get(pid) ?? pid === defaultPid
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test tests/quota.test.ts`
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add .opencode/plugins/opencode-hud/model/quota.ts tests/quota.test.ts
git commit -m "feat(quota): 多订阅排序、折叠摘要与展开判定纯函数"
```

---

### Task 3: 多组渲染 + Sidebar 接线（一次提交，保持可编译）

`QuotaSection` 的入参变更会让 Sidebar 暂时编译不过，因此类型、组件、接线放在同一个任务里一次提交。

**Files:**
- Modify: `.opencode/plugins/opencode-hud/model/types.ts`（`QuotaData` 之后）
- Rewrite: `.opencode/plugins/opencode-hud/view/QuotaSection.tsx`
- Modify: `.opencode/plugins/opencode-hud/view/Sidebar.tsx`

**Interfaces:**
- Consumes: `listProviders` / `getProviderName`（Task 1）、`orderQuotaProviders` / `isQuotaRowOpen` / `QUOTA_REFRESH_MS`（Task 2）、`resolveProviderKey`、`normID`、`resolveRenderer`
- Produces:
  - `export type QuotaRow = { pid: string; name: string; renderer?: string; data: QuotaData; current: boolean; open: boolean }`
  - `export function QuotaSection(props: { rows: QuotaRow[]; onToggle: (pid: string) => void }): JSX.Element`

- [ ] **Step 1: 加 `QuotaRow` 类型**

`model/types.ts` 的 `QuotaData` 之后：

```ts
// 额度区块的一行「供应商组」：data 来自 store，open/current 由 Sidebar 计算
export type QuotaRow = {
  pid: string
  name: string
  renderer?: string
  data: QuotaData
  current: boolean
  open: boolean
}
```

- [ ] **Step 2: 重写 `QuotaSection`**

要点（不保留旧的 `quota` / `renderer` 入参）：

- 空列表整块不渲染：`<Show when={props.rows.length > 0}>`。
- 标题摘要（整块折叠时才有）取 `props.rows[0].data.items` 前两条有 `percent` 的：第一行是当前会话供应商 → `（5h 36% · 周 69%）`；不是 → 名称前缀 `（OpenCode Go 5h 36% · 周 69%）`；无百分比条目 → `undefined`。
- 组头一行：`▾ ` / `▸ `（`MUTED_COLOR`）+ 名称 `truncateVisual(name, 12)`（当前会话 `PRIMARY_COLOR` 且 `<b>`，其余 `TEXT_COLOR`）+ `<box flexGrow={1} />` + 折叠摘要文本（`MUTED_COLOR`，`wrapMode="none"`；展开时传空串占位，不用多个并列节点）。
- 摘要格式：`标签 百分比`（`fmtPctInt(percent)`）或 `标签 文本`；条目由 `representativeItem(row().data.items)` 提供；百分比取色与 `bars` 一致（`pctColor`）。
- 组头 `onMouseDown={() => props.onToggle(row().pid)}`。
- 展开时：`<box flexDirection="column" paddingLeft={2}>{resolveRenderer(row().renderer)({ items: row().data.items })}</box>`。
- 行列表用 `<Index each={props.rows}>`，一律 `row().xxx` 取值，不解构。
- 组间不额外加空行。

- [ ] **Step 3: Sidebar —— 展开态与凭据探测**

模块级（`quotaStore` 附近）加：

```ts
// 模块级：跨侧边栏重建保持手动展开结果（与 Collapsible 的 collapseState 同思路）
const quotaRowOpen = new Map<string, boolean>()
```

组件内加（与 `quotaVer` 并列）：

```ts
const [quotaOpenVer, setQuotaOpenVer] = createSignal(0)
const [available, setAvailable] = createSignal<string[]>([])
let probedAt = 0
let probing = false

// 5min TTL：只回答「有没有 token」，能否查额度交给 store 的首次请求
const probeSubscriptions = async () => {
  if (probing) return
  if (probedAt !== 0 && Date.now() - probedAt < QUOTA_REFRESH_MS) return
  probing = true
  try {
    const hits: string[] = []
    for (const { id } of listProviders()) {
      const key = await resolveProviderKey(id).catch(() => undefined)
      if (key) hits.push(id)
    }
    probedAt = Date.now()
    setAvailable(hits)
  } finally {
    probing = false
  }
}
void probeSubscriptions()
```

- [ ] **Step 4: Sidebar —— 运行中子代理的供应商**

```ts
// 只取运行中的子代理：family() 只增不减，历史条目会把「在用」变成「用过」
const subagentProviderIDs = createMemo<string[]>(() => {
  const out: string[] = []
  for (const id of subagentIds()) {
    if (ctx.data.session.status(id) !== "running") continue
    const pid = (ctx.data.session.get(id) as { model?: { providerID?: string } } | undefined)?.model?.providerID
    if (typeof pid === "string" && pid.length > 0) out.push(pid)
  }
  return out
})
```

- [ ] **Step 5: Sidebar —— 排序、行集合、默认展开行**

删掉旧 `quota` memo，替换为：

```ts
const quotaTargets = createMemo<string[]>(() =>
  orderQuotaProviders({
    current: providerID(),
    subagentPids: subagentProviderIDs(),
    available: available(),
  }),
)

const quotaRows = createMemo<QuotaRow[]>(() => {
  void quotaVer()
  void quotaOpenVer()
  const currentPid = providerID()
  const base = quotaTargets().flatMap((pid) => {
    const data = store.get(pid)
    if (!data || data.items.length === 0) return [] // 无数据不出现（含空条目）
    return [{
      pid,
      name: getProviderName(pid) ?? pid,
      renderer: getProviderRenderer(pid),
      data,
      current: currentPid !== undefined && normID(pid) === normID(currentPid),
    }]
  })
  // 只有当前会话供应商在行集合里时才默认展开它；否则全部折叠（不猜哪条更重要）
  const defaultPid = base.find((r) => r.current)?.pid
  return base.map((r) => ({ ...r, open: isQuotaRowOpen(r.pid, defaultPid, quotaRowOpen) }))
})

const toggleQuotaRow = (pid: string) => {
  quotaRowOpen.set(pid, !isQuotaRowOpen(pid, undefined, quotaRowOpen))
  setQuotaOpenVer((v) => v + 1)
}
```

`toggleQuotaRow` 的 `defaultPid` 传 `undefined` 是有意的：点击时只把当前可见状态取反，不重新解释「默认行」。

- [ ] **Step 6: Sidebar —— 加载与心跳**

`loadQuota` 保留现有 `isQuotaProvider` 守卫；加载集合换成 `quotaTargets()`：

```ts
createEffect(() => {
  for (const pid of quotaTargets()) loadQuota(pid)
})
const timer = setInterval(() => {
  void probeSubscriptions() // 5min TTL 内直接返回
  for (const pid of quotaTargets()) loadQuota(pid)
}, QUOTA_TICK_MS)
```

- [ ] **Step 7: Sidebar —— 换调用点**

```tsx
<QuotaSection rows={quotaRows()} onToggle={toggleQuotaRow} />
```

补齐 import：`listProviders`、`getProviderName`（`quota/index.ts`），`orderQuotaProviders`、`isQuotaRowOpen`、`QUOTA_REFRESH_MS`（`model/quota.ts`），`QuotaRow`（`model/types.ts`），`normID`（`shared/id.ts`）。

- [ ] **Step 8: 全量测试 + 语法检查**

Run: `node --test tests/*.test.ts`
Expected: 全部 PASS。

Run: `npx --yes esbuild .opencode/plugins/opencode-hud/tui.tsx --bundle --platform=node --format=esm --jsx=automatic --jsx-import-source=@opentui/solid --external:@opencode/plugin/tui --external:@opentui/solid --external:solid-js --outfile=$env:TEMP\opencode\tui-bundle-check.js`
Expected: `Done in ...`。

- [ ] **Step 9: 人工冒烟（需要真实订阅）**

1. 同时登录 ≥2 个订阅 → 组头都出现，当前会话那组展开，其余一行，无换行（42 列）。
2. 当前会话换成 open-design（无额度端点）→ 其余订阅正常列出且全部折叠（标题摘要带供应商名），console 无 `missing api url`、无 `missing key` 刷屏。
3. 点折叠行 → 就地展开该供应商 bars；再点收起；其他组不受影响。
4. 切换会话到另一供应商 → 未手动干预的组跟随切换；手动展开过的保持。
5. 断开某订阅凭据（改 key / 退出登录）→ 5min 内该行消失（当前会话那个除外）。
6. 起一个跑别家模型的子代理 → 该供应商升到第二位。
7. 起一个已登录但查不了的供应商（OpenAI API Key / 未订 Go）→ 不出行、console 无 error 刷屏。

- [ ] **Step 10: 提交**

```bash
git add .opencode/plugins/opencode-hud/model/types.ts .opencode/plugins/opencode-hud/view/QuotaSection.tsx .opencode/plugins/opencode-hud/view/Sidebar.tsx
git commit -m "feat(hud): 额度区块展示全部已登录订阅并支持逐组展开"
```

---

### Task 4: 文档同步与最终验证

**Files:**
- Modify: `README.md:3`
- Modify: `AGENTS.md`（额度段）
- Modify: `docs/superpowers/specs/2026-11-11-multi-provider-quota-design.md`（状态行）

- [ ] **Step 1: README**

第 3 行改为：`TUI 侧边栏：上下文 / 缓存 / 额度（含全部已登录订阅）。`

- [ ] **Step 2: AGENTS 额度段**

在「当前已启用：…」之前补一条：

> - 额度区块展示**本机全部有凭据的已启用供应商**（`listProviders` + 凭据探测，5min TTL；无凭据不出现、不记日志）。排序：当前会话 → 本会话运行中子代理在用 → 其余注册顺序；只展开当前会话那组（无额度数据时退化为第一行），其余折叠成一行、点击就地展开，折叠摘要取已用最多的一条。手动展开态存模块级 Map，跨重建保持。

- [ ] **Step 3: 设计文档状态**

`docs/superpowers/specs/2026-11-11-multi-provider-quota-design.md` 的状态行改为：`- 状态：**已实现**（2026-11-11）`。

- [ ] **Step 4: 最终验证**

Run: `node --test tests/*.test.ts`
Expected: 全部 PASS。

Run: esbuild 命令（同 Task 3 Step 8）。
Expected: `Done in ...`。

- [ ] **Step 5: 提交**

```bash
git add README.md AGENTS.md docs
git commit -m "docs: 同步多订阅额度区块的展示口径与设计状态"
```
