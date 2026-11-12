<!-- 职责：给在本仓库工作的 agent 的入口约束（结构、校验、插件加载/安装、UI 硬约束、数据口径、发版）；不写：各主题的完整设计推导（见文末文档地图）。 -->

# 语言

- 全程中文沟通；`git commit` 信息用中文。

# 仓库速览

- 单一 opencode2 TUI 插件仓库，非 monorepo。**没有根 `package.json`、lockfile 或构建步骤**；测试用 Node 内建，不要为跑测试引入依赖或打包配置。
- 唯一插件：`.opencode/plugins/opencode-hud/`，入口 `tui.tsx`（`Plugin.define id:"opencode-hud"`），注册两个 slot：
  - `sidebar.content` → `view/Sidebar.tsx`（ViewModel：信号/memo/副作用都在这里）
  - `prompt.footer.status` → `footer.tsx` → `view/PerfFooter.tsx`（首字/速度）
- 桌面 GUI 入口（`gui-experimental.cjs`）与 Markdown 配色**已冻结并删除**，当前只服务 TUI；恢复方式与设计见 `docs/design-desktop-entry.md`。
- **宿主源码在本机**：`D:\Code\Projects\Agents\opencode`（opencode 2.x 工作树，版本以它 `package.json` 为准）。核对宿主 API、slot 跨度、键位、内置 UI 行为时直接读这里（`packages/tui/src`、`packages/plugin/src`、`packages/client/src`、`packages/schema/src`），**不要先搜网**；文档里引用的 `packages/...` 行号即指这个目录。
- 目录职责：`model/` = 数据与纯函数；`quota/` = 供应商发现 + 凭据 + 查询；`shared/` = 通用纯函数；`view/` = Solid UI；`view/hooks/` = ViewModel（会话用量 / 子代理 / 额度 / 更新各一块）；`view/layout.ts` = 侧边栏几何常量唯一真源；`update/` = 更新检查与一键更新。
- **相对导入必须带 `.ts`/`.tsx` 后缀**：运行时由 Bun 逐文件直接 import，没有打包器做后缀解析。

# 校验（改完必跑）

- 全量测试：`node --test tests/*.test.ts`（Node ≥23.6 原生 TS strip，零依赖；当前 189 个用例，全部须过）。单文件可用 `node --test tests/perf.test.ts`。
- 测试按 `node:test` 写，不要用 `bun test` 代替。
- 打包语法检查（Windows PowerShell；`Done in` 即通过）：

```powershell
npx --yes esbuild .opencode/plugins/opencode-hud/tui.tsx --bundle --platform=node --format=esm --jsx=automatic --jsx-import-source=@opentui/solid --external:@opencode/plugin/tui --external:@opentui/solid --external:solid-js --outfile=$env:TEMP\opencode\tui-bundle-check.js
```

- 没有 lint / typecheck / formatter 配置；esbuild 就是编译检查。
- 运行冒烟：在本仓库启动 opencode（`.opencode/plugins/` 会被发现），侧边栏不出现 `sidebar.content` 崩溃即基本正常；额度/性能逻辑靠应用内 console 面板观察。

# 插件加载与安装

- 发现器只认 `plugins/`（或 `plugin/`）的**直接子项**：目录型插件的 TUI 入口是 `tui.tsx`。不要再嵌套目录，也不要把 TUI 入口写成直接子 `.tsx` 文件（文件插件只认 `.ts`/`.js`）。
- 运行时包名是 `@opencode/plugin/tui`，**不是**旧的 `@opencode-ai/plugin/tui`（无兼容重映射，改回旧名会直接加载失败）。
- 面向用户只支持脚本安装：`install.sh` / `install.ps1` 解析最新 Release 的 302 tag，优先 `git clone --branch <tag>`，失败回退 tag 归档；整目录原子装到 `$XDG_CONFIG_HOME/opencode/plugins/opencode-hud/`（Windows 取 `$HOME/.config`）。`uninstall.*` 删该目录并清理旧版 `plugins/tui/*` 残留。
- **改名迁移（`opencode-tui-usage` → `opencode-hud`）必须清理旧目录**：`plugins/opencode-tui-usage/` 与旧 stage 不删，老用户升级后旧插件仍被加载，两个实例注册同样两个 slot，侧栏与性能块重复渲染。`install.*`、`uninstall.*`、`update/apply.ts` 三处都保留这段清理；插件若正被宿主加载（Windows 锁目录），删除失败要能容错，留到卸载或下次安装再清。
- 老用户从 v4.1.x 升级时，**旧版更新器按旧子路径 `.opencode/plugins/opencode-tui-usage` 找入口，在 v4.2.0+ 的归档里必然失败**（报「归档中未找到插件入口 tui.tsx」），不会自动迁移；Release 说明必须要求这类用户重跑 `install.*`（装到新目录并清旧目录）。
- **不要改用 `opencode.json(c)` 的 `plugins` 配置安装**：插件会落进 `node_modules`，peer 依赖带进第二份 Solid 运行时，表现为只画首帧、切一次会话才刷新。完整方法与上游 issue 见 `docs/config-install.md`。
- 排查加载：`opencode2 plugin list` 只列候选且读 service 缓存，改盘后可能需要 `opencode2 service restart`；真实加载看 `opencode2 api --standalone --print-logs GET /api/plugin` 的 `loading plugin` / `WARN failed to load plugin`。
- **本插件无法移除宿主内置区块**（slot claim 只能加/替换整条路径）：宿主侧栏的 `Context` 块来自内置插件 `opencode.sidebar.context`。不要为此去 `replace: "sidebar.content"`（会连带吞掉 MCP/Todo 等宿主区块）。
- 开发时 opencode2 会热重载该插件目录（新增/重命名/删除文件通常无需重启）。
- **热重载按「内容摘要」判新旧，`touch` 改 mtime 不算改动**：只改 mtime 不会触发重新准备模块图。更坑的是多文件中途失败的加载会让宿主停在上一版（模块图里残留旧模块，日志见 `plugin operation failed ... stage=read`），此时**改入口 `tui.tsx` 的内容**（触发重新准备）即可恢复；必要时重启 opencode。改完多文件先跑一次 esbuild，再改入口内容触发重载，能少踩一次。
- **TUI 插件没有 `app.log` API**（`ctx.client.app.log` 会崩）。`console.*` 进 OpenTUI 应用内 console 面板，不进 `opencode.log`；`opencode.log` 只有宿主的插件加载器日志。不要新增文件日志。
- 应用内 console 就是 OpenTUI 的 `TerminalConsole` 覆盖层（默认底部 30%、2000 条环形缓冲、`openConsoleOnError: false`），**不会自己弹出**：`ctrl+p` → 搜「Toggle console」（`app.console` 默认无键位，可在 `cli.json` 的 `keybinds` 绑）；面板内 `ctrl+s` 存 `_console_<时间戳>.log` 到 cwd，`ctrl+shift+c`/`ctrl+y` 复制选区。宿主渲染器配置见 `packages/tui/src/app.tsx` 的 `consoleOptions`。

# Solid / UI 硬约束

- **组件函数体只执行一次**：禁止 `const x = props.x` 这类 props 快照；取值放 JSX 表达式，或用惰性 getter（`const pct = () => quotaPct(props.item)`）。额度不显示、上下文进度条不刷新都踩过这个坑。
- 周期性重算的行列表用 `<Index>`（子代理区块）；`<For>` 按引用比较会销毁重建整行，清掉用户选中/滚动。数据只在数据源变化时更新的列表（如 `bars` 的 items）可以用 `<For>`。
- **宿主侧栏为 42 列，本插件可用 37 列**（`42 − 宿主 padding 4 − scrollbox 预留 1`，见 `packages/tui/src/routes/session/sidebar.tsx`）。卡片一圈圆角边框（2 列）+ 左右内边距（2 列）→ 内容 **33 列**；所有几何常量只在 `view/layout.ts` 定义，**不要用 `onSizeChange` 实测**（首帧为 0，会让标题在两种截断宽度间闪）。
- 视觉分层两种底色：`CARD_COLOR`（HUD 连续表面 + 卡片底）→ `RAISED_COLOR`（指标块/运行中任务）。卡片之间的空行也用 `CARD_COLOR`，不要露更暗的间隙（会有「断层」感）。区块用 `DashboardCard`：**一卡一圈 `borderStyle="rounded"` 边框 + 边框内标题（box `title`）**，不要再叠第二层边框/分隔线，也不要在卡片下垫色块。
- 卡片**不做整卡折叠**（折叠后只剩空边框）；区块内折叠（额度分组、子代理详情与历史段）保留。
- 配色只从 `view/theme.ts` 取（OpenCode Native Pro，固定暗色，不跟随 `ctx.theme`）。琥珀是强调色，给品牌元素与上下文主指标；绿色表示「运行中 / 成功 / 低占用」，但**同一区块内「正在跑」与「已跑完」不能同色**（子代理区块：运行中绿、已停止黄、失败红；计数 0 也显示）；红色只给真实错误与 ≥85%。上下文主指标用 `contextColor`（琥珀，≥85 转红），额度「已用占比」用 `usageColor`（低=绿、≥50 橙、≥85 红）。token 分量色：输入蓝 / 输出紫 / 缓存青绿 / 推理琥珀。
- 整个 HUD 由 `Sidebar` 的 `hasContent()` 门控（用量 / 额度 / 子代理 / 更新提示全无时整块不渲染）；三块内容各自独立门控，**额度不得嵌在「有会话用量」里**（新会话还没有 token 时，已登录订阅照样要能看）。更新检查在 `view/hooks/useUpdate.ts`，进程内只跑一次 Promise，横幅随 `hasContent()` 一起卸载也不丢状态。
- 无数据区块整块不渲染（额度为空、供应商不支持、无子代理），不要显示“不支持/无数据”占位。
- 进度条 0% 不渲染填充块：OpenTUI 里 `flexGrow=0` 的 box 仍占 1 格，`ColorBar` 用 `Show when={pct > 0}` 门控。
- 含 CJK/符号的拼接才用 `visualWidth`；`↻`(U+21BB) 实测占 2 列，`charColumns` 已特判。新增符号/emoji 要按终端实际渲染宽度核对。
- 额度渲染器在 `view/renderers/`：新增展示形态要加 `<name>.tsx`，并在 `registry.ts` 的 `RENDERER_NAMES` 与 `index.ts` 的 `RENDERERS` 各登记一项。不要把单个供应商的专属逻辑塞进 `QuotaSection` 或 `bars`。

# 额度（quota/）

- **增删改供应商前先加载 `.opencode/skills/managing-quota-providers/SKILL.md`**。
- 供应商是运行时自动发现：`quota/index.ts` 顶层用 fs 扫描 `providers/*.ts` 并动态 import，导出 `provider` 即生效。**新增供应商只加一个文件，不改注册表；删除只删文件**。
- `provider = { id, name?, apiUrl, render?, enabled?, fetch }`；`fetch` 返回 `QuotaData = { items: [{ label, percent?, text?, hint? }] }`。契约只放渲染原语，不要加 `resetsAt` 之类语义字段。
- 未用真实响应验证前用 `enabled: false`；展示设计（显示哪几行、标签叫什么）先与用户确认。
- 白名单、URL、fetcher 分发均按 `normID`（小写 + 仅保留 a-z）匹配；未注册/未启用返回 `undefined`，**无兜底**。
- 凭据统一在 `quota/key.ts`：keyCache（60s TTL）→ 项目配置（近到远，同目录 `.opencode/` 优先）→ 全局配置 → DB `credential` 表。DB 取 `active` 且最近更新的那条（`ORDER BY active DESC, time_updated DESC, id DESC`），按 `type` 取值：`key` → `key`，`oauth` → `access`；该条不可用时不回退旧记录。`opencode`/`opencode-go` 的 OAuth 凭据都挂在 `integration_id="opencode"` 下；`openai` 的在 `integration_id="openai"`，且**只有 Codex 登录（`chatgpt-browser`/`headless`）的 token 能查额度**，token-sharing 一律 401（见 `docs/provider-openai-quota.md`）。只读现值，不刷新、不落盘、不写日志。
- `QuotaStore` 按 providerID 分桶：网络刷新最小间隔 5min（`QUOTA_REFRESH_MS`），失败按 5→10→15min 退避并遵守 `Retry-After`；缓存按凭据指纹分桶，切号后旧数据立即作废。Sidebar 每 60s 用 `QUOTA_TICK_MS` 检查一次（凭据/退避），是否符合刷新间隔由 store 决定，切回会话走缓存。**通知订阅者必须在请求落定、`inFlight` 已清之后**（成功/失败/空响应都通知）：UI 的 `fetching` 直接读 `inFlight`，在清掉之前通知会把界面钉在「有数据 + 更新中」的快照上，直到下一次 60s 心跳才撤销。**只有 `isQuotaProvider` 命中的 pid 才调 `load`**：未注册端点静默返回、不记日志（否则非额度供应商会被 60s 心跳刷成 `missing api url`）；`missing key` 的 warn 在同一凭据状态下只记一次（登录/切号换桶后重新计数）。
- 网络请求统一走 `shared/http.ts`：5s 超时/中止、8MB 上限、`Retry-After`、401/429/超时/网络/坏 JSON 归类、错误文本先脱敏再截断。provider 不再直接 `fetch`。
- 行内 `↻` 重置提示是**查询时刻的快照**：provider 在 fetch 时把 `resetsAt` 格式化成相对剩余时长（`12m` / `4h12m` / `5d`）塞进 `hint`，渲染层不重算。所以它最多滞后一个刷新周期，失败/退避期间可能更久（折叠态靠 `失败`/`旧` 前缀、展开态靠数据年龄兜底）。要真实倒计时得给契约加时间字段，属另一次设计。
- 额度区块展示**本机全部有凭据的已启用供应商**（`listProviders` + 凭据探测，5min TTL；无凭据不出现、不记日志）。排序：当前会话 → 本会话运行中子代理在用 → 其余注册顺序；只展开当前会话那组，其余折叠成一行、点击就地展开，折叠摘要取已用最多的一条。当前会话供应商没有额度查询时它不出行，**全部折叠**（不猜哪条重要）。手动展开态存模块级 Map，跨重建保持。
- 当前已启用：`opencode-go`（`/zen/go/v1/usage`）、`command-code`（credits + subscriptions 双 API）、`openai`（`chatgpt.com/backend-api/wham/usage`，5h/周 + 有月度额度时补「月」）。Zen 侧 `/zen/v1/usage` 为 404，所以 `opencode` 不接额度。
- **新鲜度是展示元信息，不进供应商契约**：`QuotaStore` 记录 `updatedAt`（只在成功写入时更新，与「上次尝试 `at`」分离），`status(pid)` 返回 `phase`（`empty/loading/ready/stale/error`）、`fetching`、`ageMs`、`stale`、`error`；`QUOTA_STALE_MS = 2 × 刷新间隔`。UI 只消费这份状态（`quotaStatusTrail` / `quotaErrorLabel` 纯函数）：在途→`更新中`；展开且有缓存但失败→`凭据失效 8m`；折叠且失败/过期→`失败` / `旧` 前缀 + 摘要。**未取到数据不出行、失败不画 0%**；有缓存时失败仍展示缓存。

# 数据口径（别自己发明）

- 会话累计 token 取 `SessionInfo.tokens`（`usageFromTokens`）；**不能**对 `session.message.list()` 求和——宿主分页加载，未滚动的历史不在列表里。上下文占用取最新 assistant 消息的 token 和。
- 性能（首字/速度）只算每个**已完成**的 assistant 步：速度守卫为 `time.streamed − firstContentStart ≥ 200ms` 且净生成 `≥ 300ms`，**无速度上限**；生成中沿用上一步的值。无实时估算、滑窗、滤波或定时器。改速度逻辑前先读 `docs/design-performance-footer.md`。
- 子代理默认只读 `session.family()` 与 `SessionInfo` 聚合列；**展开时或运行中**按需 `message.sync(id)` 读子会话消息算首字 / 速度（运行中条目要在常驻第三行显示），不轮询、不持久化。耗时用 `(time.idle ?? time.updated) − time.created`，并用高水位钳住（步骤边界的旧 `idle` 会回跳）。**排序：running 优先 → 已完成按结束时刻（`idle ?? updated ?? created`）倒序**；默认只常驻最近 5 条已完成（`VISIBLE_DONE_ROWS`），其余折叠成 `还有 N 条已完成` 一行，running 不设上限（复用的老子代理会凭状态自动回到常驻区）。缓存率与会话区块共用 `cacheRateOf`。
- **结局取 `SessionInfo.outcome`**（宿主在 `session.execution.succeeded/failed/interrupted` 时写 `idle_outcome`，见 `packages/core/src/session/projector.ts` 的 `projectIdle`）：只在 `running === false` 时采信（运行中它仍是上一轮的旧值），缺失才降级为「已停止」。**禁止用 `running=false` 推断成功**。卡片头用 `subagentCounts` 给三个独立计数：运行中 / 已停止 / 失败。

# 更新与发版

- 版本唯一来源：`update/version.ts` 的 `VERSION`（SemVer）。流程：改 `VERSION` → commit → `git tag vX.Y.Z` → `git push origin vX.Y.Z`。
- `.github/workflows/release.yml` 校验 tag 与 `VERSION` 一致，用 git-cliff 生成并提交 `CHANGELOG.md`，再建 Release。**不要手改 `CHANGELOG.md`**（发版时会被全量覆盖）。
- 更新检查走 `github.com/<repo>/releases/latest` 的 302 `Location`，**不要改 `api.github.com`**（未认证限流 60 次/小时，部分网络直接 403）。节流：成功 TTL 24h / 失败冷却 1h / 超时 8s；缓存写到 `pluginDataDir()/update-check.json`。
- 一键更新是插件自包含：fetch 对应 tag 归档 → 系统 `tar -xzf` → 校验 `tui.tsx` → 原子替换 `globalPluginDir()`。**不要改回“下载并执行安装脚本”**：`irm ... | iex` 会被 Windows Defender 判为 `Trojan:Win32/Commando.A!ml`。`child_process` 只用于本地 `tar`（120s 超时、`windowsHide`）。

# 文档地图

- `README.md` — 用户的安装 / 更新 / 卸载。
- `docs/config-install.md` — 配置安装方式与 TUI 插件的双 Solid 陷阱（本插件不采用，供其他插件复用）。
- `docs/token-accounting.md` — 会话 token 口径、数据来源与 DB 对账。
- `docs/design-performance-footer.md` — 首字/速度口径、守卫与 footer 布局；改速度逻辑前必读。
- `docs/design-subagent-section.md` — 子代理区块取数、耗时口径与布局。
- `docs/reference-opencode-cache-and-tps.md` — 外部同类插件的可借鉴设计。
- `docs/reference-opencode-quota.md` — 外部同类项目 opencode-quota 的可借鉴项（行语义/配速、HTTP、凭据、刷新、server+RPC、用量与工程化取舍）。
- `docs/reference-multi-provider-quota.md` — 多订阅额度展示的同类实现（slkiser/opencode-quota 等）：分组/两级折叠/代表窗口/刷新与错误口径，及可借鉴清单。
- `docs/superpowers/specs/2026-11-11-multi-provider-quota-design.md` — 额度区块展示全部已登录订阅的设计（发现/排序/折叠/验收）。
- `docs/superpowers/specs/2026-11-11-heavy-dashboard-design.md` — HUD 5.0 重型仪表盘：审计结论、Obsidian Amber 视觉系统、37 列几何、额度新鲜度与子代理结局口径、ViewModel 拆分。
- `docs/superpowers/specs/2026-11-11-quota-reset-relative-design.md` — 额度 `↻` 重置提示改为相对剩余时长、数据年龄 `0m` 的口径与验收。
- `docs/reference-usage-monitor-refresh-cadence.md` — 外部高星用量监控项目的刷新间隔/退避样本与「网络端点 vs 本地读取」分档，用于判断本插件 5min 间隔是否合理。
- `docs/reference-desktop-gui-plugins.md` — OpenCode Desktop GUI 插件（`./gui-experimental`）开发手册：构建/加载规则、窗口与主进程上下文、注册表、Ipc/存储/生命周期、排障；**§15 是 2.2.0 实机验证结论**（目录型插件三入口、server 可 import 什么、共用 RPC 契约、槽位真实跨度）。
- `docs/design-desktop-entry.md` — 双入口设计与桌面 Markdown 配色的历史记录（**已冻结**）、恢复方式与后续 HUD 面板路线。
- `docs/reference-realtime-tps.md` — 历史调研；实时 TPS 已在 v4.0.0 移除。
- `docs/provider-open-design.md` — OpenDesign 额度探测：推理 API Key 无端点；Control Key 可查 preflight + wallet（未接入）。
- `docs/provider-openai-quota.md` — OpenAI/ChatGPT 订阅额度：`wham/usage` 端点、真实响应、**只有 Codex 登录凭据可读**（token-sharing 401）与复验命令。
- `.opencode/skills/managing-quota-providers/SKILL.md` — 供应商新增/修改/删除流程。
- `CHANGELOG.md` — 发版自动生成、历史冻结；`TODO.md` — 跟踪中的上游问题。
- 新文档必须在同一次改动中登记到本节目录；代码注释只写不显然的原因/约束，来源、迁移、review 记录放 `docs/` 或本文件。
