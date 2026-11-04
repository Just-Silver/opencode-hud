<!-- 职责：沉淀外部同类项目 slkiser/opencode-quota 中值得吸收/明确不吸收的设计、与本仓库的差距和落地顺序；不写：本仓库自身架构、安装与发版（见 AGENTS.md 与 README）。 -->

# 参考项目：opencode-quota（可借鉴项）

- 仓库：<https://github.com/slkiser/opencode-quota>（MIT，TypeScript）
- 版本：`6.2.1`；npm 发布 `@slkiser/opencode-quota`，同时提供 **server + TUI + Desktop GUI（`./gui-experimental`）+ CLI** 四个入口
- 规模：`src/` 约 4.4 万行，`tests/` 约 5.5 万行、148 个测试文件（本仓库插件约 2.4 千行、12 个测试文件）
- 本地路径：`E:\Code\Projects\Externals\opencode-quota`
- 查阅时间：2026-11-05（master 最新 `0854d4ab`）

它比我们大一个数量级，不能整体照搬；下面只挑**能落进当前 TUI 插件**的部分，并标明与我们既有约束的冲突。

## 0. 结论速览

| 主题 | 对方做法 | 对我们的价值 | 建议 |
| --- | --- | --- | --- |
| 额度行语义 + 配速（even-use） | 行带 `window`/`resetsAt`/`percentRemaining`，算「按当前速度能否用到重置」并画 `┃` | ★★★ 用户可感知，纯函数可测 | 先决定契约形态，再做 |
| HTTP 健壮性与错误词汇 | 统一 `requestJson`：超时/大小上限/Retry-After/脱敏/错误码 | ★★★ 修我们已知的 inFlight 卡死 | 已采纳（2026-11-05） |
| 凭据读取 | server 侧 `ctx.integration`；只有 CLI 直读 DB，且 SQL 带 `active`/`time_updated` 排序 | ★★★ 我们仍直读 DB（SQL 已对齐） | SQL 已修（2026-11-05）；server 化另议 |
| 刷新/缓存策略 | 按身份分桶、失败退避、遵守 Retry-After、操作代际 | ★★☆ 避免旧账号数据/无效轮询 | 已采纳（2026-11-05） |
| server + RPC 分层 | 四端共用 `core` + 一份 RPC 契约 | ★★☆ 我们已实测目录插件可行 | 单独写 spec |
| 设置系统 | `settings.jsonc` 注释保留、schema 驱动、草稿预览、跨实例热更新 | ★☆☆ 我们零设置 | 只取持久化思路 |
| 用量/成本报表 | models.dev 价格、按天/模型/供应商、缓存节省、分页读 DB、fork 去重 | ★★☆ 功能决策 | 先不做，留参考 |
| 自定义供应商 DSL + agent 工具 | JSON 声明式定义，默认关闭，agent 只能加不能启用 | ★☆☆ 安全模型值得抄 | 暂不做 |
| 工程化 | 148 测试、发布闸门、npm 产物冒烟、跨平台 CI | ★☆☆ 按我们规则取舍 | 只取 CI 平台覆盖 |

## 1. 已达成共识（不必改）

| 口径 | 对方 | 我们 |
| --- | --- | --- |
| 缓存命中率 | `read / (input + cacheWrite + read)` | 同（`calcCacheRate`） |
| 无数据/未登录 | 不渲染或一行状态，不编造占位 | 同（整块不渲染） |
| 会话累计 token | 报表读 SQLite 全量 | 我们取 `SessionInfo.tokens`，**这是对的**：侧边栏只看当前会话，不能用 `message.list()` 求和（见 `docs/token-accounting.md`） |
| 子代理消耗归属 | 用量报表把子会话并入顶层父会话 | 我们独立展示、不并入主会话；口径不同但都不重复计，不必改 |
| 不做实时估算 | 只算已完成步 | 同 |

## 2. 额度行：从「渲染原语」到「可计算的行」

对方 `src/core/types.ts` 的行模型（一行 = 一个窗口/余额/状态）：

```ts
QuotaRow = {
  id: `${providerId}.${key}`         // 稳定 id，供隐藏/排序/改名
  account?, label, type, method, authority, window, prominence
  percentRemaining?                  // 原始剩余百分比，可小于 0（超用）
  used?, limit?, remaining?, amount?, flag?, text?
  resetsAt?, windowStartedAt?        // 配速与重置通知的基础
}
```

我们 `model/types.ts` 只有 `{ label, percent?, text?, hint? }`，重置时间被塞进自由文本 `hint`，因此下面这些**做不了**：

- 进度条上的「按当前速度，重置前够不够用」标记 `┃`（`src/core/pace.ts`，约 50 行纯函数）；
- 「预计 2h 后耗尽」提示；
- 按行 id 隐藏/排序/改名（换供应商文案或窗口就失效）；
- 重置通知（比较两次检查的 `resetsAt` 与百分比回升）；
- 一个供应商多账号/多行（对方一行一个登录，重名自动编号 `Pro`、`Pro 2`）。

**与当前约束的冲突**：`AGENTS.md` 明确「契约只放渲染原语，不要加 `resetsAt` 之类语义字段」。要享受配速，必须先选形态：

- **方案 A（推荐，不破规则）**：`QuotaItem` 增可选 `mark?: number`（0–100，UI 只负责把 `┃` 画在对应位置），由 provider 在 `fetch` 时用共享的 `shared/pace.ts` 算好。标记最多滞后一个网络刷新周期（5min），对 5h/周窗口可接受。
- **方案 B（需改规则）**：行上加 `window` + `resetsAt`，UI 实时算。表达力更强，但要同时改 `AGENTS.md` 与渲染契约，应走 spec，不要顺手改。

配速口径（可直接移植，纯函数、离线单测）：

- 窗口区间 = `windowStartedAt`，或 `resetsAt − 窗口长度`；无法确定则不显示标记。
- `evenLeft = 剩余时间 / 窗口总长 × 100`；与 `percentRemaining` 相差 ±5 个点内算「正常」。
- 已用时间不足窗口 10% 时不给「耗尽时间」（样本太少）。
- 只剩 `left%`、已过 `elapsed`：`runsOutInMs = left / (100 − left) × elapsed`。
- **颜色仍按剩余量**；对方把「按配速着色」做成可选设置，我们不要默认改，避免现有视觉行为变化。

不建议现在做：多账号行、`hidden`/`providerOrder`/`rowOrder`/`names` 全套设置、重置 toast——都依赖设置持久化与更大的 UI 面。

## 3. HTTP 与错误

- 我们已于 2026-11-05 接入 `shared/http.ts`：5s 超时/中止（`QuotaStore` 的 `inFlight` 不会再被挂起请求永久占住）、8MB 上限、`Retry-After`、错误归类、错误文本先脱敏再截断；provider 不再直接 `fetch`。错误原因只留在内存（`QuotaErrorState`），不写文件日志。
- 对方 `src/lib/http.ts` 是一个可直接借用的薄层：
  - 一个 timeout 覆盖到 body 读完（默认 5s，可用设置覆盖）；
  - 响应体 8MB 上限，超过即中止并归类 `bad_response`；
  - 可选 `redirect: "manual"`，避免落到登录页；
  - 解析 `Retry-After`（秒数或 HTTP 日期，上限 24h）；
  - 失败归类：401 → `login_expired`、429 → `rate_limited`、其它非 2xx → `provider_error`、超时/网络/过大/非 JSON 各有码；
  - `detail` **先脱敏再截断**（300 字）；密钥本身作为 `secrets` 传入，保证永不回显。
- 配套 `src/core/errors.ts`：一套错误词汇 + 用户短句（`Sign in again` / `Rate limited, retry in 5m` / `Provider error 503` / `Timed out`），原始细节只进 `/quota_status`，不进侧边栏。
- 可落地：新增 `shared/http.ts`（约 80 行，纯依赖注入、可单测），provider 改用它；`QuotaStore` 把错误 code/retryAt 存入缓存，用于退避与提示。**不要**把 401/`not_subscribed` 这类供应商专属语义塞进通用层——对方也放在各 provider 里（例如 Go 的「未订阅」直接返回空账号）。

## 4. 凭据与账号

对方的读法分三层，边界很清楚：

1. **server 插件**：`ctx.integration` 读登录，按需传 integration id，OpenCode 负责刷新/失效；凭据变更事件会清缓存。
2. **TUI**：不绑定任何凭据源（读了也拿不到），只消费 server 快照。
3. **CLI**：唯一允许直查 `credential` 表的地方（`lib/opencode-auth-sqlite.ts`），且：

```sql
SELECT id, integration_id, label, active, value FROM credential
WHERE integration_id IS NOT NULL
ORDER BY active DESC, time_updated DESC, id DESC
```

解析 `type`：`key`/`api` → `key`，`oauth` → `access`；外部托管（`external`）不读。

对照我们 `quota/key.ts`（2026-11-05 已修）：SQL 改为 `ORDER BY active DESC, time_updated DESC, id DESC`，只认排序后的首条；该条不可用（`external`/缺字段/JSON 坏）时不回退旧记录。`keyCache` 加 60s TTL，切号后一个心跳内就能被 store 发现。已补纯函数回归测试 `pickStoredCredentialToken`。

中期若要彻底摆脱 DB schema：补 server 入口后用 `ctx.integration`，顺带获得 OAuth 刷新与凭据变更通知。这属于第 6 节的架构动作，不要零散改。

对方的多账号能力（每个登录一组行、`(active)` 标记、重名编号、同一 key 挂在别名 integration 下去重）目前用不上——我们只展示当前模型的供应商。等接入真正多账号的供应商再抄 `formatCredentialDisplayNames` / `selectConnectionCredentialRows` 的思路。

## 5. 刷新与缓存

对方 `src/core/store.ts` 的几条硬规则：

- 缓存按 **identity**（账号 + 供应商相关设置）分桶；身份变化的旧行绝不展示，不能持久化的身份只留内存。
- 同 provider 单飞；失败退避 60s → 15min，并遵守服务端 `Retry-After`（上限 1 天）；手动/重试绕过；有模型回合时可 30s 刷新一次。
- 每次快照/刷新/登录变更是一个 **operation（代际）**：旧代际的结果不写库、不通知订阅者。
- 每行记住来源 login；某个登录失败时保留该登录的旧行并记录错误，不连坐其它登录。
- 快照带 `serverId` + 递增 `revision`；TUI 收到乱序响应时按代际取新，并只接受**本文件夹**的事件（共享后台服务会把别的文件夹事件也推过来）。

对照我们（2026-11-05 已改造）：

- 缓存按凭据指纹分桶（`sha256(key)` 前 16 位）——切号后旧数据立即作废，不再等新请求成功；
- 网络刷新最小间隔 5min；失败退避 5 → 10 → 15min，并遵守 `Retry-After`（到点先试一次，不叠加本地退避）；`force` 只绕过成功态间隔，不绕过失败退避与 `Retry-After`；
- 每 60s 的 `QUOTA_TICK_MS` 只做「解析凭据 + 判断退避」，不发请求；`keyCache` 加 60s TTL，让切号在一个心跳内被发现；
- 请求失败的原因存在内存 `QuotaErrorState{code,status,retryAt,message}` 里（已脱敏），不落盘、不写文件日志；侧边栏暂不展示，留给后续错误提示。

仍未做：失败时保留「上次成功时间」并在 UI 区分新旧数据；跨进程快照/单飞。前者可随错误提示一起做。

**不照搬**：快照文件 + 跨进程文件锁 + 合并写。那是为了 CLI/多窗口共享一次抓取；我们没有 CLI，暂时是纯成本。

## 6. server + RPC 分层

对方的结构：`core/`（纯数据与纯函数）← `plugin.ts`（server，唯一有 fs/sqlite/network 的地方）→ `rpc.ts`（纯 JSON Schema 契约）→ `tui/` 与 `gui/` 只做渲染。TUI 拿到的快照会剥离 server-only 的 `debug`/`exportPart`；RPC 只暴露 `snapshot`/`refresh`/`status`/`usage`/`settings` 等必要方法。

这条路对我们**已经验证可行**：`docs/reference-desktop-gui-plugins.md` §15.1 实测目录插件可同时是 server + TUI + GUI，§15.3 实测 `Rpc.define` 是纯数据契约、TUI 与窗口用同一个 `ctx.client.rpc(definition)`；§15.2 也确认 server 里可用 `bun:sqlite`、`node:fs`、`child_process`、`fetch`。

收益：

- 用官方 `ctx.integration`，不再直读 `credential` 表；
- 多个 TUI/窗口共享一次抓取（现在每个 TUI 各自轮询）；
- 将来桌面 GUI 可直接复用同一份契约，不必再做第二套后端（我们的 `gui-experimental.cjs` 也能进 server 登记）。

成本：新增 `index.ts`（server 入口）+ RPC 契约 + 启动顺序/热重载验证；TUI 要处理 `serverId`/`revision` 与跨文件夹事件（可直接抄对方的 `ownFolderEvents` 思路）。**GUI 窗口里 `fs`/`child_process` 是 inert placeholder**（§15.6），更新器与任何 IO 都必须留在 server/TUI。

建议：如果要动，**只先迁 quota 查询与凭据**（最小 RPC：`snapshot`/`refresh`），渲染与 store 形状保持不变；更新检查/一键更新继续留在 TUI。动手前先写 spec。

## 7. 设置系统

对方是一套完整方案：单个 `settings.jsonc`（全局，无项目级）、只写用户改过的键、保留注释与尾逗号、file-only 键、schema 驱动 UI、编辑草稿实时预览、跨实例文件 watch（防抖）、旧版本迁移、`/quota_status` 校验问题。

我们的现状是零设置：折叠/展开、更新横幅的「已忽略」都在模块级内存里，重启即丢。

可吸收的只有两点：

- 用宿主的 `context.storage.store` 持久化「面板展开态 / 更新已忽略 / 子代理展开态」，不要自己写 JSON（宿主已做原子写、文件锁、跨实例同步）；按主题拆 key。
- 若以后要开关，沿用「只存用户显式改过的项 + 纯函数算默认值」，避免旧值锁死新默认。

**不照搬**：完整设置文件 + schema UI + 多语言文案层。我们单语言、surface 少，成本远大于收益；需要时再单独设计。

## 8. 用量与成本（功能决策，不是待修项）

对方 `src/core/usage.ts` + `lib/modelsdev-pricing.ts` 是目前看到最完整的 OpenCode 历史用量实现：

- 价格：随包带一份 models.dev 快照，运行时下载到 OpenCode 缓存目录；按设置选 bundled/runtime/auto；过期刷新（跨进程 6h 节流）；**下架模型保留最后一次价格**，否则老会话算不出钱。
- 口径：`cachedInput`（cache read）/ `uncachedInput`（input + cache write）/ `output`（output + reasoning）；同时给金额与 token 的分类拆解、缓存节省金额、**无价格 token 占比**（不把未知价格当 0）。
- 范围：`today`/`24h`/`7d`/`30d`/`90d`/`all`/`session`/`between`；本地日界，今天算在内。
- 读取：DB 分页（250 行/页），每页后 `setImmediate` 让出事件循环；fork 会话复制来的消息按指纹去重；同名问题 30s 内复用报告；session 范围把子代理并入顶层父会话。
- 展示：按供应商/模型/天排序，金额优先；`unpricedShare` 如实展示。

我们之前已明确不做缓存节省金额、会话花费、token 分布估算（`docs/reference-opencode-cache-and-tps.md` §8）。如果哪天改主意做「今日/7 天成本」，直接照它的口径实现，尤其别踩：**分页不能阻塞事件循环、fork 会重复计、无价模型不能算 0、价格是 API list price 不是账单**。当前阶段不动。

## 9. 自定义供应商与 agent 工具（安全模型值得抄）

对方允许用户在 `settings.jsonc` 的 `providers.custom` 里声明供应商：

- 两种模式：`remote-api`（格式白名单 `quota-v1` / `openrouter-key-v1` / `json-v1`，JSON 路径映射）与 `local-estimate`（按 OpenCode 历史请求数估算，窗口 `utc-day`/`rolling` + `requestLimit`/`usdBudget`）。
- **明确拒绝**：脚本、方法、自定义 header、模板、可执行映射、正则、JSONPath、自动发现端点。
- 安全默认：新增定义一律 `enabled: false`，用户手动打开前**不 fetch、不发 key**；打开时展示目标 URL 与 key 来源；非 localhost 的明文 HTTP 单独警告；agent 工具可以增/删/测，但**不能启用**。
- agent 工具的所有输入/输出统一过脱敏（复用 `core/redact.ts` 的密钥形状识别），并拒绝任何疑似密钥的字段。

我们的 `providers/*.ts` 代码文件发现机制更简单、类型安全，但用户/agent 不能自助新增。**若将来要开放自定义供应商**，照它的三件事做：白名单格式、默认关闭、启用前展示 URL/key 来源；不要为了灵活开放脚本或任意 header。agent 工具本身不优先——我们不注册命令，也不希望 agent 改额度配置。

## 10. 工程化（按我们规则取舍）

- 对方 148 个测试文件里，值得看的是**发布闸门**：npm 包内容校验、release artifact 与 tag 一致性、dist import graph、打包产物冒烟、Node 22/24 双版本、Windows 平台任务。
- 我们目前 CI 只有 `release.yml`。可考虑加一个最小 workflow 跑 `node --test tests/*.test.ts` + esbuild 检查（Windows 上跑，因为插件的主要用户环境是 Windows）。
- **不抄**：文档一致性测试（与本仓库「测试只写业务行为」冲突）、6 语言 README、npm 发布路径（我们已确认脚本安装 + 避免双 Solid 运行时）、V1/V2 双壳、斜杠命令层。

## 11. 建议落地顺序

1. ✅ **`quota/key.ts` SQL**（2026-11-05）：`ORDER BY active DESC, time_updated DESC, id DESC`，只认首条、不回退旧记录；已补回归测试。
2. ✅ **HTTP 超时与错误词汇**（2026-11-05）：新增 `shared/http.ts`（5s 超时/中止、8MB 上限、`Retry-After`、错误码、脱敏）；provider 全部接入；修掉 inFlight 永久卡死。
3. ✅ **缓存身份与退避**（2026-11-05）：key 指纹分桶、切号即作废旧数据、5→15min 退避、遵守 `Retry-After`、60s 心跳 + 5min 网络间隔。
4. **配速标记**：先定契约形态（推荐方案 A：`mark?: number`），移植 `pace.ts` 纯函数与单测。
5. **server + RPC 最小迁移**：凭据走 `ctx.integration`，quota 抓取移到 server，TUI 只渲染。先写 spec，再动代码。
6. 其余（成本报表、自定义供应商、设置系统）按真实需求再开。

## 12. 对方关键文件索引

- 数据模型/窗口/配速/行转换：`src/core/{types,windows,pace,rows}.ts`
- 存储/持久化/错误：`src/core/{store,persist,errors}.ts`
- 用量与价格：`src/core/usage.ts`、`src/lib/{modelsdev-pricing,pricing-key,token-buckets,opencode-storage}.ts`
- 凭据：`src/lib/{opencode-auth,opencode-auth-sqlite,api-key-resolver}.ts`
- provider 契约与实现：`src/providers/{contract,registry,opencode-go}.ts`
- 网络层：`src/lib/http.ts`
- 设置：`src/settings/{schema,file,live}.ts`
- 四端入口：`src/plugin.ts`（server）、`src/rpc.ts`（契约）、`src/tui/index.tsx`、`src/gui/index.tsx`、`src/bin/opencode-quota.ts`
- 安全/脱敏：`src/core/redact.ts`、`src/agent-tools.ts`
