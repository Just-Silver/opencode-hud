# 参考项目：opencode-cache-and-tps（可借鉴项）

<!-- 职责：沉淀外部同类 TUI 插件 opencode-cache-and-tps 中值得我们吸收的设计与差距清单；不写：本项目自身架构/安装方式（见 AGENTS.md、docs/config-install.md） -->

- 仓库：<https://github.com/doorlockdoor/opencode-cache-and-tps>（MIT，TypeScript）
- 来源：fork 自 `Hotakus/opencode-visual-cache`，上游加 TTFT / TPS / 延迟
- 版本：`1.7.3`；npm 发布（`opencode-cache-and-tps`）；V1（`tui` 字段）与 V2（`{id, setup}`）双端同一份代码
- 查阅时间：2026-10-19（master 最近提交 2026-10-04）

## 0. 已验证的「英雄所见略同」（不必改）

| 口径 | 对方实现 | 本项目 |
| --- | --- | --- |
| 缓存命中率 | `read / (input + read + write)` | 同（`model/usage.ts` `calcCacheRate`） |
| 上下文占用 | 最后一条有 tokens 的消息各字段求和 | 同（`contextUsageOf`） |
| 上下文上限 | 最后一条消息的 `model.id` 反查 `limit.context` | 同（`resolveContextLimit`） |
| 额度无适配器 | 隐藏/不支持 | 同（无数据整块不渲染） |

## 1. 性能指标（价值最高）：TTFT / TPS / 延迟

对方 `src/perf.ts` + `src/live.ts` 是全仓含金量最高的部分，我们目前**完全没有**耗时类指标（只有 token 静态聚合）。

可复用要点（均为纯函数、可离线单测）：

- **精确采样**（`computePerfSample`）：`TTFT = 首个内容 part.time.start − time.created`；`TPS = (output+reasoning) / 净生成时长`；净生成时长 = `completed − firstStart − 工具执行区间并集`（并行重叠去重 + 钳位）。完成/无错误/非压缩/有产出才是样本。**本项目已采用，且是唯一的性能口径（v4.0.0）**。
- ~~**实时估算**（`computeLivePerf`）~~：**本项目已明确不采用**（2026-10-21 移除全部实时链路：数字不稳、估算依赖无法从数据推出的参数）。保留记录：对方用 `estimateTokens(文本)` 估分子、`now − firstStart` 估分母，工具相位冻结。
- **守卫与例外**：`MIN_GEN_MS=300`、`BUFFER_MS_PER_TOKEN=1.0`、整包参数守卫（缓冲 router 把工具参数整块吐出来 → 分子虚高，三阈值联动剔除），每条阈值都写了真实负载误杀率锚点。
- **模型过滤**：会话跨模型时中位数失真 → 按消息 `providerID/modelID` 指纹过滤；回合口径取「该回合最后一条带指纹的步骤」整体计入/排除。
- **体感 TPS**（对齐宿主 footer）：只用消息级 `time.streamed`（v2 专属且持久化），`Σtokens / Σ(streamed−created)`；无该字段（V1/旧会话）自动回落输出速度。
- **token 估算画像**：`thinking 4.0 / answer 2.9 / code 3.7` ASCII 字/token，汉字 1.5 字/token，假名/全角 1 字/token，附 `benchmarks/tokenize-calibrate.mts` 在真库上标定。

落地建议：**只做「最近一条有效步」**（本项目最终选择，v4.0.0 已实现）。实时块（`live.ts`）作为第二阶段：**本项目实测后放弃**，理由见 `docs/design-performance-footer.md` §3。

**我们已经能拿到的（2.0.32 实测类型）**：`SessionMessageAssistant` 顶层就有 `tokens: TokenUsageInfo {input, output, reasoning, cache:{read,write}}`、`cost`、`model: ModelRef`、`time:{created, streamed?, completed?}`、`content[]`、`error`、`finish`，还有 `session.usage.updated` / `session.usage.recorded` 事件。也就是说 TPS 分母（`streamed − created`）与分子（`output+reasoning`）都在，**缺的只是首字时刻**（见第 3 节的事件约束）。

## 2. 常驻运行时（架构级差距）

> **命令层不采纳**（用户决定，2026-10-19）：本项目只做被动展示 + 鼠标点按，不注册任何斜杠命令 / keybind。下文保留对方命令层的调研记录，仅作对照，不实施。

对方 `src/v2/index.tsx`：`app` 插槽挂 `RuntimeRoot`，**与侧边栏是否挂载无关**，负责偏好恢复、余额轮询、自动切换、子代理视图清理、命令注册；`sidebar.content` 只挂纯展示面板。

- 我们目前所有逻辑（quota store、轮询定时器、更新检查）都在 `view/Sidebar.tsx` 里，侧边栏折叠/窄屏时副作用随之消失；`updateDismissedOnce` 也用模块级变量凑合。
- 对方把 `context.keymap.layer(() => ({mode:"global", commands}))` 放在常驻层 → 窄屏/隐藏侧边栏时斜杠命令仍可用（**我们不采用**）。

**宿主契约核对（2.0.32）**：

- `SlotPath` 全集：`app` / `home.footer` / `home.footer.status` / `prompt.footer` / `prompt.footer.status` / `prompt.footer.file` / `session.composer.top` / `session.panel` / `sidebar.content` / `sidebar.footer`。`app` 的 input 是空对象，没有 sessionID —— 适合放只跑一次的常驻运行时。
- **`app` 槽的挂载位置**（`packages/tui/src/app.tsx`）：在路由 `Switch` **之外**、`plugins.ready()` 之内，紧挨主容器末尾。所以它**跨 home/session/plugin 路由与跨会话都只挂载一次**，是放常驻副作用与命令层的正确位置。
- **`sidebar.content` 会消失的两种情形**（`component/session-frame.tsx`）：① 子会话（`session.parentID` 存在）直接 `sidebarVisible = false`；② 终端宽度 ≤120 且 `session.sidebar` 非显式开启时，侧边栏走"按需覆盖"而非常驻。这正是"副作用不能挂在侧边栏"的硬理由。
- Slot claim 是 add/`prepend`/`append`/`before`/`after`/`replace` 六选一，`render(input)` 的 input 是响应式 props（`sidebar.content` 给 `{sessionID}`，`prompt.footer.status` 给 `{sessionID?, mode, showDetails}`）。`ui.slot()` 返回卸载函数，`Plugin.define` 的 `setup` 返回 `cleanup` 即可。
- `context.keymap.layer(factory)`：**factory 必须纯**——实现里先 `Keymap.validateCommands(untrack(factory).commands)` 做一次性校验（命令形状不合规同步抛错），随后在 `createRoot` 里建层并挂到调用方的 owner 上；**创建层所在的响应式作用域销毁即层销毁**。`KeymapCommand` 支持 `id/title/description/group/palette/slash{name,aliases,arguments}/bind/suggested/run`。**本项目不使用**（不做命令）。
- `context.ui.dialog` 有 `show(render, onClose)`（自定义模态）、`alert/confirm/prompt/select`（`select` 支持 `search` 与 `actions` 页脚按钮）；`ui.toast.show({message, variant, duration, sessionID})`。本项目仅在更新弹窗（`UpdateDialog`）与需要提示的场景使用，不用于设置入口。
- **`ui.panel.open()` 也不采用**：它只在该插件内且当前路由是 session 时生效，且与侧边栏争同一块右侧空间；本项目的详情一律在侧边栏内折叠展开，不引入第二处 UI 落点。
- `context.storage.store(key, {initial})` 的真实实现（`context/storage.tsx`）：落到 `<state>/<channel>/tui/plugin.<id>.<key>.json`；写入走 `Flock.withLock` + `writeJsonAtomic`，并用 `fs.watch` + 50ms 防抖**回读**，因此**跨 TUI 实例实时同步**；返回的是 Solid `Store`（读即响应式），mutation 回调 `(draft) => void`。`memory()` 存在宿主侧的 Map 里，**插件热重载后仍是同一份**，退出即消失（可放非 JSON 值）。
- 另有 `context.attention.notify()`（通知/提示音，`when: always|focused|blurred`）与 `ui.tabs`（多标签会话），暂无用武之地。

## 3. 事件驱动 + 节流（涉及我们可能存在的刷新盲区）

- `util.ts` 的 `createThrottledBumper`：**前沿 + 尾沿**节流（首个事件立即触发，间隔满后至多补一次），避免纯尾沿去抖在连续流下被饿死；`dispose` 清理挂起定时器。10 行纯函数、可单测。**本项目未采用**（v4.0.0 无高频刷新需求，`shared/throttle.ts` 已删除）。
- 双通道：`partVersion`（`message.part.updated`/`message.updated`，100ms 节流）承载高频增量；`refreshTick`（仅 `session.updated`）承载会话级聚合变化。
- `createBusyTick`：**只在 busy 时**建 250ms 心跳，空闲零 interval；`status` 不可用时回退「最后一条 assistant 未完成」。

**修正（按 2.0.32 源码核对，此前判断偏保守）**：`data.session.message.list()` 返回的是 Solid store 代理数组（`store.session.message[sessionID]`），在 memo 里读它就是响应式依赖；`session.step.ended` 事件会 `assistant.tokens = event.data.tokens` 写回同一 store → memo 自然重算。所以**我们现有指标（token 聚合）在 step 结束时就会刷新，不存在盲区**，也不需要事件订阅。

真正需要事件的地方只有两类：

1. **亚 step 的实时指标**（TTFT/实时 TPS）：`session.text.delta` / `reasoning.delta` 只改 `text.text`，而我们不读文本 → 必须自己订阅并 bump 版本号；
2. **首个文本 token 时刻**：宿主不写入消息（文本 part 无时间字段，见下），只能由 `session.text.started` / `session.reasoning.started` / `session.tool.input.started` 的 `event.created` 现场记录，历史消息无法补造。

结论：把「事件 + 节流」**绑定到实时块功能**一起做，不要单独作为一项前置改造。

**已核对的宿主事件契约**（`@opencode/plugin@2.0.32` + `@opencode/client@2.0.32` 的 d.ts，非文档推测）：

- `context.data.on(type, handler)` 按 `OpenCodeEvent` 联合类型收窄；`context.data.listen(({name, details}) => …)` 是全量总线（注意参数是 `{name, details}`，参考项目里兼容了旧的 `wrapper.details ?? wrapper` 两种形状）。
- 高频增量事件：`session.text.delta` / `session.reasoning.delta` / `session.tool.input.delta`（payload 带 `sessionID` + `assistantMessageID` + `delta`）；相位事件：`session.text.started|ended`、`session.reasoning.started|ended`、`session.tool.input.started|ended`、`session.tool.called|success|failed|progress`；步进：`session.step.started|streamed|ended|failed`；回合/其它：`session.idle`、`session.compaction.*`、`session.usage.updated|recorded`、`session.message.content.updated`。
- **关键约束（决定了 TTFT 必须靠事件）**：`SessionMessageAssistant.content` 里 `text` part **没有任何时间字段**（只有 `reasoning` 有 `time.{created,completed}`），消息级只有 `time.{created, streamed?, completed?}`。所以「首个文本 token 到达时刻」只能来自 `session.text.started`（或 reasoning/tool.input 的 started）事件的 `created` —— 参考项目维护 `firstOutput: Map<messageID, number>` 正是为此，且历史消息无法补造（宁缺勿错）。
- 工具时间在 `part.time.{created, ran, completed}`（`ran` = 开始执行），不是 `state.time`；`state` 有 `streaming|running|completed|error` 四态（V1 叫 `pending`）。

## 4. v2 适配层（值得抄的宿主能力用法）

对方 `src/v2/panel-api.ts` 把 v2 `Context` 适配成 V1 形状，其中：

- `context.data.listen((wrapper) => ...)` 拿到**全量事件总线**，把 `session.text.*` / `session.reasoning.*` / `session.tool.*` 归一化为 `message.part.updated`，`session.step.*` / `session.compaction.*` → `message.updated`，其余 → `session.updated`。
- 消息归一化：v2 一条 assistant 消息 = 一步，**没有 step-finish part**，cost/tokens 在顶层；工具时间在 `part.time`（`{created, ran, completed}`）而非 `state.time`；工具参数流式期状态是 `"streaming"`（V1 叫 `"pending"`）；`skill` 是独立消息类型；回合边界靠 `idle` 消息（旧会话回退 user/synthetic）。
- `context.storage.store(key, {initial})` 包成类 KV（`get/set` + 串行写保证）；对应 V1 的 `api.kv`。
- 子会话：扫描 `task`/`delegate`/`call_omo_agent` 工具 part 的 `metadata.session_id`，提供 `/cache-session` 切换查看子代理统计（我们目前完全忽略子代理会话）。

**宿主侧更好的做法（2.0.32 新增，对方写法已过时）**：`context.data.session.root(sessionID)` 与 `context.data.session.family(sessionID): string[]` 是官方 API，直接给出同一根会话及其全部子会话（内部按 `parentID` 链维护 family 表）；`session.cost(sessionID)` 直接给会话累计花费；`status()` 返回 `"idle" | "running"`（不再需要从最后一条 assistant 推断）。对方版 `PanelApi` 里从工具 part 的 `metadata.session_id` 反推子会话的做法，属于宿主还没提供 family API 时的权宜之计 —— 我们若做子代理视图，用 `family()` 即可，无需解析工具参数。

## 5. 凭据解析（对我们 `quota/key.ts` 的具体修正）

对方 `src/v2/credentials.ts` 的结论（2026-08 起）：**v2 的实时凭据在 `opencode.db` 的 `credential` 表，`auth.json` 只是迁移遗留、OAuth 刷新后不再同步**；只读 `auth.json` 会在过期后 401。

其查询：`SELECT value FROM credential WHERE integration_id = ? AND active IS NOT 0 ORDER BY time_updated DESC LIMIT 1`；value 是 JSON，token 取值按 `type`：`oauth → access`、`api|key → key`、`wellknown → token`。

我们 `quota/key.ts` 现有实现（`CREDENTIAL_SQL = "SELECT value FROM credential WHERE integration_id = ?"`，只取 `parsed.key`）存在三处偏差：

1. 没有 `active IS NOT 0` 过滤 → 可能读到已停用的旧记录；
2. 没有 `ORDER BY time_updated DESC LIMIT 1` → 多条记录时取值不确定；
3. 只认 `key`，**OAuth 类型的 `access` 取不到**（本机当前 5 个 provider 都是 `type=key`，所以尚未暴露；接入 OAuth 供应商即踩坑）。

## 6. 网络健壮性

- 对方所有 http 都带中止：余额请求 `AbortController` + 10s 超时 + **代际序列号**（旧请求完成即作废，不覆盖新状态）；更新检查 `AbortSignal.timeout(8s)`；解压 120s。
- 我们 `QuotaStore.load` 的 `inFlight` 只在 Promise settle 时删除，而各 provider 的 `fetch` **没有传 signal / 超时** → 一次挂起的请求会让该 provider 永久处于 inFlight，后续 `load` 一直 await 它，不再重试。
- 对方轮询 5min，我们 60s 强制轮询；结合额度接口成本可考虑放宽或改为「有变化才查」。

## 7. 设置持久化（无命令层）

> **斜杠命令不采纳**（用户决定，2026-10-19）。对照项仍记录在此，仅取「注册表驱动 + 持久化」两点。

- 注册表驱动：`BAR_ITEMS` / `STYLES` / `TPS_MODES` 各一份数组（`id + 标签 + 默认值`），校验、偏好恢复、渲染全从注册表推导，新增一项只改一处。
- 旧键迁移集中在 `readXxx()`（新键优先 → 旧键折叠）。
- 对方 `commands-shared.ts` 把「选项构建 + 应用 + toast」抽成纯逻辑——**本项目不需要**，改为「注册表 + 展开状态 + 鼠标点按切换」即可。

我们当前没有任何 UI 开关（折叠状态存在模块级 `Map`，重启即丢）。若引入，先落持久化 + 两三个最高频开关（例如「TTFT/TPS 开关」「折叠态记忆」「刷新间隔」）。

**落地形态（2.0.32 适配我们现状）**：

- 持久化直接用 `context.storage.store("view", { initial: {...} })`，**不要**自己写 JSON 文件（宿主已做原子写 + 文件锁 + 跨实例同步）。注意 key 会被加上 `plugin.<id>.` 前缀并落成独立文件，所以按主题拆几个 key 比塞一个大对象更稳（一次写只锁一个文件）。
- 切换入口走**已有的交互形态**：`Collapsible` 标题行 `onMouseDown`（现已用于折叠），需要更多开关时在区块内加可点行——不引入命令、不引入对话框。
- 偏好读写保持「纯函数算默认值 + store 只存用户显式改过的项」，避免注册表加字段时被旧值锁死。
- 单语言界面下，注册表只需 `{ id, label, default }` 三段，不必照搬 i18n 的 `labelKey + Translation` 体系。

## 8. 可直接换算的新指标（**用户决定不采纳**，2026-10-19）

> 结论：`缓存节省金额`、`会话花费`、`Token 分布估算` 均不做，本节仅留档备查。

- **缓存节省金额**：`saved = read × (inputRate − cacheReadRate) / 1e6`，单价来自模型 `cost`（V1 `api.state.provider[id].models[mid].cost`，V2 `context.data.location.model.list(location)` 的 `cost` 数组）。
- **会话花费**：`session.cost` 直接用（`SessionInfo.cost` 是必填字段）。
- **Token 分布估算**（系统/用户/工具调用/工具结果/推理）：`dist.ts` 用**指纹缓存**（按 part 实际值比较，等长编辑也能失效）摊平重算成本。不做原因：全是字符密度折算的估算值，与宿主自带 context 数字并列会互相打脸；实现成本（全 part 扫描 + 失效逻辑）与收益不匹配。

## 9. 工程化（可选吸收）

- `benchmarks/*.mts`：直接读本机 `opencode.db` 回放真实历史消息，验证阈值/估算密度是否漂移；断言的是「量级与守卫命中率」，不是快照值。适合我们给额度响应/更新检查写探针时借鉴。
- `install.mjs`：用 `jsonc-parser` 的 `modify/applyEdits` **保留用户配置格式**地增删条目；写配置前记录原文、失败逐文件回滚；`checkedPath` 做配置目录越界校验；`STAGE` 与目标同盘再 rename（我们安装脚本已有原子替换，差在配置改写与回滚）。

## 10. 不吸收的部分

- **npm 发布 + 配置安装**：与我们已确认的「TUI 插件双 Solid 运行时 → 只画首帧不刷新」冲突（见 `docs/config-install.md`），对方能跑是因为其包体与加载路径不同，不能作为我们回退的依据。
- **V1/V2 双壳并存**：维护成本 ≈ 两倍；我们只支持 opencode2。
- **4 语言 i18n**：我们单语言（中文界面），引入注册表层即可，不需要翻译框架。
- **斜杠命令 / keybind / 命令面板**：本项目只做被动展示与鼠标点按，不注册任何命令（用户决定）。
- **`ui.panel`（`session.panel` 槽）**：会把详情挪到与侧边栏并列的第二块 UI，增加心智与布局成本；本项目详情一律在侧边栏内折叠展开。
- **Token 分布估算**（系统/用户/工具/调用/结果/推理的字符密度折算）：全是估算值，与宿主自带 context 数字并列会互相打脸，实现成本不低（用户决定不做，2026-10-19）。
- **`tui.js` 双格式入口**：为兼容 V1 目录解析而设，与我们发现式目录入口无关。

## 11. 建议落地顺序

> 已剔除：斜杠命令 / keybind（用户决定不做）、`ui.panel`（第二 UI 落点）、缓存节省金额与会话花费（用户决定不做）。

1. 修 `quota/key.ts` 的 credential 查询（`active IS NOT 0` + `order by time_updated desc limit 1` + oauth `access`）——小改动、真实隐患；
2. 给 provider fetch 加超时/中止，避免 `inFlight` 永久卡死；
3. 常驻运行时：副作用从 `view/Sidebar.tsx` 上提到 `app` 槽，折叠/开关状态改存 `context.storage.store`；
4. 会话级精确 TTFT / TPS / 延迟（纯函数 + 单测；首字时刻靠 `session.text.started` 等事件现场记录）；
5. 流式实时块（事件 + 前沿尾沿节流 + 仅 busy 时的心跳），与第 4 步共用事件层；
6. 子代理视图：`session.family()` 汇总 + 侧边栏内折叠展示（子会话不渲染侧边栏，需在主会话内呈现）。
