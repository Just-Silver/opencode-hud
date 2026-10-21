<!-- 职责：说明侧边栏「缓存」区块各数字的口径、数据来源（含分页陷阱），以及与宿主 DB 的核对方法；不写 UI 布局规范（见 AGENTS.md「UI 视觉规范」）、不写额度查询（见 quota/）。 -->

# 会话 token 口径与核对方法

侧边栏「缓存」区块的**累计用量**来自 `usageFromTokens(session().tokens)`，即宿主 `SessionInfo.tokens`（DB `session_v2` 的聚合列，覆盖整个会话）；`SessionInfo.tokens` 缺失时才退回 `aggregateUsage()` 对已加载消息求和。

## 分页陷阱（2026-10-20 实测踩坑）

宿主的 `ctx.data.session.message.list(sessionID)` **只返回当前已加载的消息窗口**，不是全会话：`@opencode/client` 的 `createData` 首次只取最近一页（`messagePageLimit = 20`，TUI 传入的 `initialMessageLimit` 更大），往上滚动才按 20 条一页补历史（`loadMore`）。因此对 `list()` 求和会：

- 长会话严重少算（实测某会话真实 141.3M，消息窗口只有 39.3M，占 28%；另一会话 12.17M → 11.9M）；
- 数字随滚动**变大**，同一个会话每次看都可能不同。

结论：累计用量、缓存命中率一律取 `SessionInfo.tokens`；只有「上下文」必须用消息（见下）。

## 各数字口径

| 显示项 | 口径 |
| --- | --- |
| 总量 | `input + output + reasoning + cache.read + cache.write`，**含缓存读取**，是会话**全生命周期累计**（跨天不清零） |
| 输入 / 输出 / 推理 / 缓存读(写) | `SessionInfo.tokens` 各分量（宿主为每条消息 `tokens` 的累计） |
| 缓存命中率 | `read / (input + write + read)`（cc-switch 口径） |
| 上下文 | **只看最后一条含 tokens 的消息**（最新一页必有），是当前请求的上下文占用，不是累计；与「总量」不能横向比较 |

范围上还有两条硬边界：

- **只覆盖当前展示的会话**。子代理是独立 session，其消耗只出现在子代理自己的侧边栏与该会话的 `SubagentSection` 汇总行里，**不并入主会话总量**（也因此不重复计）。
- **不做「今日」切分**。跨天继续用的长会话，侧边栏总量包含昨天及更早的消耗。

## 数据来源清单（改代码前先查这张表）

| 侧边栏字段 | 来源 | 完整性判据 |
| --- | --- | --- |
| 累计五分量（总量/输入/输出/推理/缓存读/写） | `SessionInfo.tokens`（`session_v2` 聚合列） | 权威全量；**禁止**用消息窗口求和 |
| 上下文占用 | `message.list()` 中最后一条带 tokens 的消息 | 只取“最新一条”，最新页必含 → 窗口足够 |
| 上下文上限 | `location.model.list(session.location)` 的 `limit.context` | 模型目录缺失 → 不显示百分比（不猜） |
| 当前供应商 ID | 最后一条带 `providerID`/`model` 的消息 | 最新语义，同上 |
| 子代理列表 | `session.family(sessionID)` | 客户端 `listChildren` 走完全部分页（200/页）→ 全量 |
| 子代理用量 / 耗时 / 标题 | 各子会话自己的 `SessionInfo`（`tokens`/`time`/`title`/`agent`） | 权威全量；耗时用 `time.idle` 并在 UI 侧高水位钳制 |
| 性能（首字/速度） | 最新一条已完成 assistant 消息的「精确样本」（`session.message.list()` 内存投影，再逐条 `computePerfSample`） | 最新语义；纯内存，**不读 DB**、无实时估算 |
| 额度 | 供应商 HTTP 端点（由 `providers/*.ts` 自持）+ 凭据解析 `quota/key.ts` | 凭据顺序：配置（cwd 起逐级向上 → 全局）→ DB `credential` 兜底 |
| 更新提示 | `github.com/<repo>/releases/latest` 的 302 tag + 本地缓存文件 | 不用 `api.github.com`（未认证限流/403） |

三条判据（以后加字段先归类，再选源）：

1. **累计/总数** → 必须用宿主聚合列或自己维护的完整账本，绝不能用“渲染用的分页窗口”求和；
2. **最新一条/当前状态** → 用消息窗口或事件即可，最新页一定包含它；
3. **完整集合**（子代理、历史） → 必须确认分页已走完（`family()` 有；`message.list()` 没有，只能靠 `loadMore` 滚出来）。

已知限制：`quota/key.ts` 的项目配置查找根是**进程 cwd**（`process.cwd()`），不是当前会话的 `location.directory`。opencode 从 A 目录启动、切到 B 目录的会话时，配置里的项目级 `providers.<id>.settings.apiKey` 覆盖可能读的是 A 的。常见路径（全局配置 / Console 登录的 DB 凭据）不受影响，故暂未改。

## 与宿主 DB 对账

数据源 `~/.local/share/opencode/opencode.db`（Windows `%USERPROFILE%\.local\share\opencode\opencode.db`）：

- 每条 assistant 消息：`session_message` 表 `type='assistant'`，`data` 列 JSON 的 `tokens`（`input`/`output`/`reasoning`/`cache.read`/`cache.write`）与 `cost`。
- 会话聚合列：`session_v2.tokens_input/tokens_output/tokens_reasoning/tokens_cache_read/tokens_cache_write`、`cost`（宿主自己累加，子会话分开计；侧边栏累计用量即此口径）。
- 按「今日」统计必须用 `session_message.time_created >= 本地零点` 过滤消息，**不能**用 `session_v2` 的聚合列（那是全生命周期），也不能用 `time_updated`（只能判断会话有没有被碰过）。

实测结论（2026-10-20）：`session_v2` 聚合列与逐条消息求和完全相等；仅**正在流式输出**的会话差几百 token（消息行的 `tokens` 在 `finish` 时落盘，聚合列已先行递增）。

缓存读取占比通常极高（实测为总量的 98%+，因为每一轮都会重读整个上下文），与供应商账单/额度端的「计费 token」相差可达两个数量级，属正常现象。
