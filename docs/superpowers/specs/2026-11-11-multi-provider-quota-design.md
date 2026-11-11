<!-- 职责：定义「额度区块展示本机全部已登录订阅」的发现、排序、折叠/展开与验收；不写：单个供应商端点与响应映射（见 docs/provider-*.md）、同类实现调研（见 docs/reference-multi-provider-quota.md）。 -->

# 额度区块：展示全部已登录订阅

- 日期：2026-11-11
- 状态：**已实现**（2026-11-11）
- 后续：HUD 5.0 在同一数据上补了新鲜度/失败注记（`QuotaStore.status` + `quotaStatusTrail`），见 `docs/superpowers/specs/2026-11-11-heavy-dashboard-design.md`；本文的发现、排序、折叠规则保持不变。
- 落点：`sidebar.content` → `QuotaSection`
- 前提：opencode2 v2；不改宿主；沿用 42 列侧栏、5min 刷新、零配置

## 1. 背景与目标

本机同时登录多个订阅（opencode-go / command-code / openai），而额度区块只看会话当前供应商。子代理常跑别家模型，额度在别处消耗，主会话的额度条完全反映不出来。

目标：额度区块列出**本机有凭据的全部已启用供应商**；当前会话供应商默认展开完整行，其余折叠成一行摘要，点该行就地展开。

用户已定：**只展开当前会话的**，全部展开侧栏高度不够。

非目标：

- 不加设置文件、开关、白名单（零配置）
- 不显示未登录供应商占位（沿用「无数据整块不渲染」）
- 不做剩余量排序、ETTL / 用量预测、跨会话历史
- 不改底部状态行、不改单个供应商的条目口径

## 2. 现状与约束（已核对源码）

| 事实 | 依据 |
| --- | --- |
| 额度块由会话 `providerID` 单点驱动，只 `store.get(pid)` 一个供应商 | `view/Sidebar.tsx` 的 `providerID` / `quota` memo |
| 供应商已在运行时自动发现（`fs` 扫 `providers/*.ts` + 动态 import） | `quota/index.ts` |
| registry 只有单 pid 查找，没有「列出全部」的出口 | `quota/registry.ts` 的 `createRegistry` |
| 凭据可按任意 pid 解析（keyCache 60s） | `quota/key.ts` 的 `resolveProviderKey` |
| `QuotaStore` 按 pid 分桶、按凭据指纹失效、各自 5min 间隔与 5→10→15min 退避、并发去重 | `model/quota.ts` |
| 子代理模型供应商可直接读 `SessionInfo.model.providerID`，不需要读子会话消息 | `model/types.ts` 的 `SubagentInfo`；`view/Sidebar.tsx` 的 `subagentIds` |
| 侧栏宽 42，内容区约 34–38 列；子代理区块按 34 列常量布局 | `AGENTS.md` UI 硬约束 |
| 组件函数体只执行一次，取值必须放 JSX 或惰性 getter | `AGENTS.md` Solid 硬约束 |

结论：多供应商数据侧已基本就绪，缺的是「列出候选 + 有凭据才算有时」的发现，以及多行展示。

### 2.1 已知代价

- 网络：每个进入列表的供应商各自 5min 一次请求（当前启用 3 个 → 最多 3 次 / 5min），失败按 pid 独立退避。
- 凭据探测：每个候选 5min 一次 `resolveProviderKey`；命中走 60s keyCache，未命中才读配置 / DB。
- 侧栏高度：3 个订阅、当前展开 3 行时约占 7 行（1 组 4 行 + 2 折叠行 + 组间隙）。

## 3. 设计

### 3.1 供应商清单与凭据探测

- `ProviderRegistration` 增加可选 `name?: string`（显示名，缺省用 `id`）；三个 provider 补 `name`：`OpenCode Go` / `OpenAI` / `Command Code`。
- registry 新增：
  - `listProviders(): { id: string; name: string }[]` —— 仅 `enabled !== false` 的注册项，保持发现顺序；
  - `getProviderName(pid): string | undefined` —— 归一化命中后返回显示名，未命中返回 `undefined`。
- `quota/index.ts` 透出这两个函数。
- Sidebar 侧探测：`PROBE_TTL_MS = QUOTA_REFRESH_MS`（5min）。把 `listProviders().map(p => p.id)` 串行 `resolveProviderKey(id)`，命中即视为「有订阅」；**探测失败 / 无凭据一律静默**（不写 `missing key` 日志——那是 store 对已选供应商的口径，探测阶段写会造成噪音）。
- 探测在挂载时跑一次，之后由现有 60s `QUOTA_TICK_MS` 心跳触发，TTL 内直接跳过；并发用 `probing` 标志去重。
- 探测只回答「有没有 token」，**不代表能查到额度**：`openai` 的 API Key / token-sharing token 调 `wham/usage` 必 401；`opencode-go` 只要有 Console 登录就会命中，与是否订购 Go 无关。这类供应商由首次请求失败自然淘汰（无数据 → 不出现），不做凭据能力判别（见 §8）。

### 3.2 排序与行集合

纯函数（`model/quota.ts`）：

```ts
orderQuotaProviders(opts: {
  current: string | undefined          // 当前会话供应商（任意写法）
  subagentPids: readonly string[]      // 运行中子代理的 model.providerID
  available: readonly string[]         // 有凭据的候选（注册顺序）
}): string[]                           // 归一化后的 pid 列表
```

- 顺序：当前会话 → 本会话**运行中**子代理在用（按出现顺序）→ 其余按 `available` 顺序。
- `subagentPids` 只取 `session.status(id) === "running"` 的子代理：`family()` 只增不减，把历史条目全算进来会让「在用」名不副实、长期占住第 2 位。已完成的子代理供应商仍在候选列表里，只是不提前。
- 只保留 `available` 里的 pid（以 `normID` 比较），对 `current` 额外放行（它仍走原有的按需加载路径，不依赖探测结果）。
- 去重，保持首次出现位置。

**加载集合与渲染集合要分开**（否则没有数据的供应商永远不会被加载）：

- 加载集合 = 排序结果（含 `current`）——每个 pid 都调用 `store.load`，由 store 决定是否真发请求。
- 渲染集合 = 加载集合里**有数据**的供应商（`store.get(pid)` 有值且 `items` 非空）。没有数据的供应商不出现，与现有「空则不渲染」一致。

### 3.3 折叠 / 展开状态

- 模块级 `const quotaRowOpen = new Map<string, boolean>()`（跨侧边栏重建保持，与 `Collapsible` 的 `collapseState` 同思路）。
- 纯函数 `isQuotaRowOpen(pid, defaultPid, state)`：有显式记录用记录，否则 `pid === defaultPid`。
- `defaultPid` = 当前会话供应商**在行集合里**的那个 pid；当前会话供应商没有额度数据（open-design / Zen / 没登录）时 **`defaultPid = undefined`，即全部折叠**——不猜测「第一条更重要」，避免展开一个跟当前工作无关的订阅。
- 点击组头 `onMouseDown` 切换并写入 map。
- **独立开关，不做手风琴**：每组各自记录，允许同时展开多组（用户主动点开就是要看）。默认只展开一个只是因为 `defaultPid` 只有一个；不做「打开新的自动收起旧的」——那样点开第二组会把第一组的上下文弄丢。

### 3.4 折叠摘要

纯函数 `representativeItem(items): QuotaItem | undefined`：

- 有 `percent` 的条目里取**最大值**（已用最多 = 最紧张），并列取先出现者；
- 全无 `percent` → 取第一条有 `text` 的（如余额）；
- 空数组 → `undefined`。

摘要文本：`标签 百分比`（`fmtPctInt`）或 `标签 文本`。折叠行若有 `hint`（如 `↻ 周二`）也带上。

### 3.5 展示

外壳（`▼ 额度` 标题 + 分隔线 + 整块折叠）不变；组头是轻量行，不加分隔线：

```
1234567890123456789012345678901234
▼ 额度
──────────────────────────────────
▾ OpenCode Go
    5h ━━━━━━━ 36% ↻18:07
    周 ━━━━━━━━━ 69% ↻周二
▸ OpenAI          5h 12%
▸ Command Code    周 55%
```

- 组头：`▾ ` / `▸ ` + 显示名（超 12 列用 `truncateVisual` 截断）；**仅在折叠时**右端显示摘要（展开时有明细行，不重复）。
- 整块标题沿用 `Collapsible` 的既有语义：**只有整块折叠时**才在标题右端显示摘要，取**排序第一行**的前两条有百分比的条目。第一行就是当前会话供应商时保持现状 `（5h 36% · 周 69%）`；不是（当前会话没有额度查询）时带上供应商名 `（OpenCode Go 5h 36% · 周 69%）`，否则无法判断说的是谁。正文截断到 24 列（标题 6 + 括号 2 + 正文 24 ≤ 34），避免 42 列侧栏里标题换行。第一行没有百分比条目则不显示。`QuotaSection` 内部从 `rows[0]` 算，不额外加入参。
- 展开行：直接复用该供应商的渲染器（`resolveRenderer(getProviderRenderer(pid))`），不改渲染器契约。
- 命名：当前会话供应商的组头用 `PRIMARY_COLOR`，其余用 `TEXT_COLOR`；箭头与摘要用 `MUTED_COLOR`；百分比颜色走 `pctColor`。
- 行列表用 `<Index>`（数据随 store 写库周期重算，避免 `<For>` 按引用销毁重建）。
- 垂直节奏：**全紧凑，不插空行** —— 组头 / 条目 / 下一组紧邻；`bars` 渲染器容器与分组盒子都不带 `gap`（42 列侧栏优先信息密度）。
- 整个额度块仍由「至少一行有数据」门控；全无 → 不渲染（含标题）。

### 3.6 数据加载

- `createEffect`：依赖加载集合（含 `available` 与 `providerID`）→ 对每个 pid `void store.load(pid)`；store 自身负责 5min 间隔、退避、并发去重。
- 所有 `load` 调用统一先过 `isQuotaProvider`（与本次多供应商改造一起落地；2026-11-11 已先单独修掉现网噪音）。
- 60s tick：先 `probe()`（TTL 内跳过），再对当前加载集合逐个 `store.load`。
- `hasContent()` 维持现状：额度仍嵌在「会话用量存在」的块内。

### 3.7 类型与文件改动

`model/types.ts` 增加：

```ts
export type QuotaRow = {
  pid: string
  name: string
  renderer?: string
  data: QuotaData
  current: boolean
  open: boolean
}
```

| 动作 | 文件 | 说明 |
| --- | --- | --- |
| 修改 | `quota/registry.ts` | `ProviderRegistration.name?`；`listProviders`、`getProviderName` |
| 修改 | `quota/index.ts` | 透出上面两个函数 |
| 修改 | `quota/providers/{opencode-go,openai,command-code}.ts` | 补 `name` |
| 修改 | `model/types.ts` | `QuotaRow` |
| 修改 | `model/quota.ts` | `orderQuotaProviders`、`representativeItem`、`isQuotaRowOpen` |
| 修改 | `view/Sidebar.tsx` | 凭据探测、行集合 memo、逐行 load、tick 扩展、展开状态与切换 |
| 重写 | `view/QuotaSection.tsx` | 组头 + 展开渲染（入参改 `rows` + `onToggle`） |
| 修改 | `tests/discovery.test.ts` | `listProviders` / `getProviderName` |
| 修改 | `tests/quota.test.ts` | 三个纯函数 |
| 新增 | `docs/superpowers/specs/2026-11-11-multi-provider-quota-design.md`（本文） | — |
| 修改 | `docs/reference-multi-provider-quota.md` | 「待定问题」结案，指向本文 |
| 修改 | `AGENTS.md` | 额度段补多订阅口径；文档地图登记本文 |
| 修改 | `README.md` | 一句：显示所有已登录订阅的额度 |

## 4. 边界与失败

| 场景 | 行为 |
| --- | --- |
| 没登录某供应商 | 探测无凭据 → 不出现，不写日志 |
| 有 token 但查不了额度（OpenAI API Key / token-sharing、未订 Go 的 Console 登录） | 请求失败 → 无数据 → 该行不出现；store 按 pid 退避（5→15min），不做凭据能力判别（见 §8） |
| 探测整体失败（DB 不可读） | 视为无凭据；当前会话供应商仍按原路径加载并显示 |
| 某供应商首次请求失败、无缓存 | 无数据 → 该行不出现；后续按 pid 退避重试 |
| 某供应商有旧数据后请求失败 | 保留旧数据（store 现有行为），不做 stale 标记 |
| 切号 / 换 key | 指纹变化清空该 pid 数据 → 该行消失，新凭据首次成功后再出现 |
| 当前会话供应商无额度端点（open-design / Zen） | 它不产生行、不加载、不记日志；其余订阅正常列出，**默认全部折叠**（不猜第一条），点击任意组展开 |
| `opencode-go` 与 `opencode` 共用 Console 凭据 | `opencode` 未注册，不会重复出现 |
| 显示名过长 / 未注册 pid | 截断到 12 列；未注册不出现在候选列表 |
| 全部无数据 | 整个额度块（含标题）不渲染 |
| 用户在两个会话间切换 | 未手动干预的组跟随 `defaultPid`；手动展开/折叠的保持 |

## 5. 测试与验收

### 5.1 自动化

- `listProviders`：只返回启用的注册项、带 `name`；`getProviderName` 命中 / 未命中。
- `orderQuotaProviders`：当前优先；运行中子代理的供应商次之（已完成的子代理不提前）；去重；不在 `available` 的丢弃；`current` 任意写法（`opencode_go`）也能命中。
- `representativeItem`：取最大 percent；并列取先出现；无 percent 取首个 text；空 → undefined。
- `isQuotaRowOpen`：无记录按 `defaultPid`；显式记录优先。
- 全量 `node --test tests/*.test.ts` 通过；esbuild 打包检查通过。

### 5.2 手动冒烟（本机 3 个订阅）

1. 同时登录 opencode-go / command-code / openai → 三行都出现，当前会话那组展开。
2. 切到另一个供应商的会话 → 展开组随之切换，之前手动展开的保持。
3. 点折叠行 → 就地出现该供应商的 bars；再点收起，不闪、不重建其他行。
4. 断开某订阅凭据 → 5min 内该行消失（当前会话那个除外）。
5. 应用内 console 无 `missing key` 噪音；网络失败只有该供应商的独立退避。
6. 子代理换供应商跑一会儿 → 该供应商排到第二位并显示对应额度。

## 6. 文档同步

- `docs/reference-multi-provider-quota.md`：把「待定问题」三条按本文结论改写（只展开当前；摘要取最紧张；排序含子代理在用）。
- `AGENTS.md`：额度段补「展示全部有凭据的已启用供应商；排序 current → 子代理在用 → 其余；只展开当前；摘要取最紧张一条；探测 5min TTL、无凭据不出现也不记日志」，文档地图登记本文。
- `README.md`：首行描述补「（含多个已登录订阅）」。

## 7. 不做

- 设置文件 / 显示开关 / 供应商排序配置
- 未登录占位行、错误行、手动刷新按钮
- ETTL / 按速度着色 / stale 标记
- 每供应商独立刷新间隔
- 把额度暴露给 agent 做选路（后续另议）

## 8. 风险与回退

| 风险 | 处理 |
| --- | --- |
| 多供应商请求叠加触发限流 | 每个 pid 各自 5min + 退避；当前最多 3 个供应商 |
| 探测每分钟打开 DB | 5min TTL + 串行 + 失败静默；实测卡顿再退化为复用 store 的解析结果 |
| 高度挤压子代理区块 | 默认只展开当前；折叠行各占 1 行；不做组间空行 |
| 摘要随刷新换窗口（最紧张变了） | 仅折叠行受影响，属预期（一眼看风险）；展开后顺序稳定 |
| 探测遗漏（配置里刚加 key） | ≤5min 内自动补上，并有 60s tick 兜底 |
| 有 token 但端点不可用：每 5→15min 一次失败请求 + 一条应用内 console `error` | 属已知取舍（不做凭据能力判别）。若实测噪音明显，再在 store 上补「auth 失败后长时间静默」或让 `key.ts` 透出 `type` / `methodID` 做预判 |

回退：`QuotaSection` 恢复单 `quota` + `renderer` 入参，Sidebar 去掉探测与行集合，registry 新增函数可保留（无副作用）。
