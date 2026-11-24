<!-- 职责：给在本仓库工作的 agent 的入口约束（结构、校验、插件加载/安装、UI 硬约束、数据口径、发版）；不写：各主题的完整设计推导（见文末文档地图）。 -->

# 语言

- 全程中文沟通；`git commit` 信息用中文。

# 仓库速览

- 单一 opencode2 TUI 插件仓库，非 monorepo。**没有根 `package.json`、lockfile 或构建步骤**；测试用 Node 内建，不要为跑测试引入依赖或打包配置。
- 唯一插件：`.opencode/plugins/opencode-hud/`，入口 `tui.tsx`（`Plugin.define id:"opencode-hud"`），注册两个 slot：
  - `sidebar.content` → `view/Sidebar.tsx`（ViewModel：信号/memo/副作用都在这里）
  - `session.composer.top` → `footer.tsx` → `view/PerfFooter.tsx`（首字/速度，输入框正上方一行）
- 桌面 GUI 入口（`gui-experimental.cjs`）与 Markdown 配色**已冻结并删除**，当前只服务 TUI；恢复方式与设计见 `docs/design-desktop-entry.md`。
- **宿主源码在本机**：`D:\Code\Projects\Agents\opencode`（opencode 2.x 工作树，版本以它 `package.json` 为准）。核对宿主 API、slot 跨度、键位、内置 UI 行为时直接读这里（`packages/tui/src`、`packages/plugin/src`、`packages/client/src`、`packages/schema/src`），**不要先搜网**；文档里引用的 `packages/...` 行号即指这个目录。
- 目录职责：`model/` = 数据与纯函数；`quota/` = 供应商发现 + 凭据 + 查询；`shared/` = 通用纯函数；`view/` = Solid UI；`view/hooks/` = ViewModel（会话用量 / 子代理 / 额度 / 更新 / 共享秒级时钟）；`view/layout.ts` = 侧边栏几何常量唯一真源；`update/` = 更新检查与一键更新。
- **相对导入必须带 `.ts`/`.tsx` 后缀**：运行时由 Bun 逐文件直接 import，没有打包器做后缀解析。

# 校验（改完必跑）

- 全量测试：`node --test tests/*.test.ts`（Node ≥23.6 原生 TS strip，零依赖；全部用例须过）。单文件可用 `node --test tests/perf.test.ts`。
- 测试按 `node:test` 写，不要用 `bun test` 代替。
- 打包语法检查（Windows PowerShell；`Done in` 即通过）：

```powershell
npx --yes esbuild .opencode/plugins/opencode-hud/tui.tsx --bundle --platform=node --format=esm --jsx=automatic --jsx-import-source=@opentui/solid --external:@opencode/plugin/tui --external:@opentui/solid --external:solid-js --outfile=$env:TEMP\opencode\tui-bundle-check.js
```

- 没有 lint / typecheck / formatter 配置；esbuild 就是编译检查。
- **CI（`.github/workflows/ci.yml`）的判定标准与本机一致**：ubuntu + windows 矩阵；`install/uninstall`、`key`（ubuntu 另加 `release-asset`）分组跑 `--test-reporter=tap` 并断言 `# skipped 0`。**skip 不算覆盖**，所以 CI 真实安装 bun（`1.3.14`，`key.test.ts` 的 `bun:sqlite` 用例依赖它）；本机跑全量前也要保证 `bun` 在 PATH。`release-asset` 组只在 ubuntu 单独跑并断言 0 skip；Windows 不单独跑该组，由全量测试兜底——Windows 的 PATH 常是 bsdtar，找不到 GNU tar 时该组按设计 skip 并打印原因。
- CI 还会跑：全量 `node --test tests/*.test.ts`、`bash -n install.sh uninstall.sh`、PowerShell Parser 检查 `install.ps1`/`uninstall.ps1`、固定 `esbuild@0.28.2` 打包、`bun build` 冒烟、git-cliff 模板全量渲染。`release.yml` 的 verify 直接复用该 workflow，别另写一套门禁。
- 运行冒烟：在本仓库启动 opencode（`.opencode/plugins/` 会被发现），侧边栏不出现 `sidebar.content` 崩溃即基本正常；额度/性能逻辑靠应用内 console 面板观察。

# 插件加载与安装

- 发现器只认 `plugins/`（或 `plugin/`）的**直接子项**：目录型插件的 TUI 入口是 `tui.tsx`。不要再嵌套目录，也不要把 TUI 入口写成直接子 `.tsx` 文件（文件插件只认 `.ts`/`.js`）。
- 运行时包名是 `@opencode/plugin/tui`，**不是**旧的 `@opencode-ai/plugin/tui`（无兼容重映射，改回旧名会直接加载失败）。
- 面向用户只支持脚本安装：`install.sh` / `install.ps1` 用 `curl` 不跟随跳转读 `releases/latest` 的 `%{http_code} %{redirect_url}`，只接受本仓库正式 tag（`vX.Y.Z`）的 3xx；再取 `.sha256`、有界下载（16 MiB / 120 s）、核对 SHA256、`gzip` 有界解压（64 MiB）、逐 512 字节校验归档头（条目 ≤ 2000）、解压后复核，最后在目录锁内事务式装到 `<全局配置根>/plugins/opencode-hud/`（配置根优先级与默认位置以 `README.md` 安装段为准，实现见 `shared/paths.ts` 的 `globalConfigDir()`）。`uninstall.*` 删该目录并清理 hud 旧布局 `plugins/tui/*` 残留。提升后必须读回 stage 里写的安装身份标记才认成功：`mv`/`Move-Item` 落到期间被创建的目录时会静默嵌套并返回 0。**没有无校验回退**：不得恢复 `git clone`、`git ls-remote`、tag 源码归档或 main 下载；旧 Release 缺资产即失败。
- **目录锁**：`<全局配置根>/plugins/.opencode-hud.lock`（目录锁，30 s 等待 / 200 ms 轮询）。Node 用 `mkdirSync`、bash 用 `mkdir`、PowerShell 用 `New-Item`（**不能加 `-Force`**，否则已存在目录也会成功、互斥失效）；`owner` 四行 `tool=`/`pid=`/`startedAt=`/`token=`，只有 token 相同的持有者才释放；不按年龄破锁、不扫描/清理 `.opencode-hud-install-*`。安装、更新、卸载共用这一把锁；拿不到锁时安装/卸载直接失败且不改动/不删除目标。崩溃后需人工确认并删除锁目录。
- **改名兼容已结束**：源码与脚本不再引用或删除 `plugins/opencode-tui-usage*`，运行时也不删除用户机器上的旧目录。**从 v4.1.x 升级或卸载后，旧目录不会被脚本自动删除；旧副本仍可能被宿主加载并与新安装重复注册相同 slot（侧栏、性能块重复渲染），必须手工删除后重启。** 不要新增按内容探测旧副本或自动清理逻辑。
- 老用户从 v4.1.x 升级时，**旧版更新器按旧子路径 `.opencode/plugins/opencode-tui-usage` 找入口，在 v4.2.0+ 的归档里必然失败**（报「归档中未找到插件入口 tui.tsx」），不会自动迁移；Release 说明必须要求这类用户重跑 `install.*` 并手工删除旧目录。
- **不要改用 `opencode.json(c)` 的 `plugins` 配置安装**：插件会落进 `node_modules`，peer 依赖带进第二份 Solid 运行时，表现为只画首帧、切一次会话才刷新。完整方法与上游 issue 见 `docs/config-install.md`。
- 排查加载：`opencode2 plugin list` 只列候选且读 service 缓存，改盘后可能需要 `opencode2 service restart`；真实加载看 `opencode2 api --standalone --print-logs GET /api/plugin` 的 `loading plugin` / `WARN failed to load plugin`。
- **本插件无法移除宿主内置区块**（slot claim 只能加/替换整条路径）：宿主侧栏的 `Context` 块来自内置插件 `opencode.sidebar.context`。不要为此去 `replace: "sidebar.content"`（会连带吞掉 MCP/Todo 等宿主区块）。
- 开发时 opencode2 会热重载该插件目录（新增/重命名/删除文件通常无需重启）。
- **热重载按「内容摘要」判新旧，`touch` 改 mtime 不算改动**：只改 mtime 不会触发重新准备模块图。更坑的是多文件中途失败的加载会让宿主停在上一版（模块图里残留旧模块，日志见 `plugin operation failed ... stage=read`），此时**改入口 `tui.tsx` 的内容**（触发重新准备）即可恢复；必要时重启 opencode。改完多文件先跑一次 esbuild，再改入口内容触发重载，能少踩一次。
- **TUI 插件没有 `app.log` API**（`ctx.client.app.log` 会崩）。`console.*` 进 OpenTUI 应用内 console 面板，不进 `opencode.log`；`opencode.log` 只有宿主的插件加载器日志。不要新增文件日志。
- 应用内 console 就是 OpenTUI 的 `TerminalConsole` 覆盖层（默认底部 30%、2000 条环形缓冲、`openConsoleOnError: false`），**不会自己弹出**：`ctrl+p` → 搜「Toggle console」（`app.console` 默认无键位，可在 `cli.json` 的 `keybinds` 绑）；面板内 `ctrl+s` 存 `_console_<时间戳>.log` 到 cwd，`ctrl+shift+c`/`ctrl+y` 复制选区。宿主渲染器配置见 `packages/tui/src/app.tsx` 的 `consoleOptions`。

# Solid / UI 硬约束

- **组件函数体只执行一次**：禁止 `const x = props.x` 这类 props 快照；取值放 JSX 表达式，或用惰性 getter（`const pct = () => quotaPct(props.item)`）。额度不显示、上下文进度条不刷新都踩过这个坑。
- **ViewModel 入参传 getter、不传值**（`useSessionStats(() => props.sessionID)`）：hook 在组件体创建时只跑一次，传值等于把会话钉在首帧；slot 的 `render` 回调同样不要解构 props（`render: (props) => <Sidebar sessionID={props.sessionID} />`）。
- 周期性重算的行列表用 `<Index>`（子代理区块）；`<For>` 按引用比较会销毁重建整行，清掉用户选中/滚动。数据只在数据源变化时更新的列表（如 `bars` 的 items）可以用 `<For>`。
- **秒级心跳只喂单个文本节点**：`view/hooks/useClock.ts` 是唯一秒级时钟（引用计数，最后一个消费者卸载即停），倒计时/年龄用「绝对时刻 − now」现算；`rows()` 不许读时钟，否则每秒重建全部额度行、重跑供应商 renderer。
- **宿主侧栏为 42 列，本插件可用 37 列**（`42 − 宿主 padding 4 − scrollbox 预留 1`；常量见 `packages/tui/src/ui/layout.ts` 的 `SESSION_SIDEBAR_WIDTH`，sidebar 只引用）。卡片一圈圆角边框（2 列）+ 左右内边距（2 列）→ 内容 **33 列**；所有几何常量只在 `view/layout.ts` 定义，**不要用 `onSizeChange` 实测**（首帧为 0，会让标题在两种截断宽度间闪）。
- 视觉分层两种底色：`CARD_COLOR`（HUD 连续表面 + 卡片底）→ `RAISED_COLOR`（指标块/运行中任务）。卡片之间的空行也用 `CARD_COLOR`，不要露更暗的间隙（会有「断层」感）。区块用 `DashboardCard`：**一卡一圈 `borderStyle="rounded"` 边框 + 边框内标题（box `title`）**，不要再叠第二层边框/分隔线，也不要在卡片下垫色块。
- 卡片**不做整卡折叠**（折叠后只剩空边框）；区块内折叠（额度分组、子代理详情与历史段）保留。
- 配色只从 `view/theme.ts` 取（OpenCode Native Pro，固定暗色，不跟随 `ctx.theme`）。琥珀是强调色，给品牌元素与上下文主指标；绿色表示「运行中 / 低占用」等非冲突语义（更新成功等单点结果可用绿），但**同一区块内「正在跑」与「已跑完」不能同色**（子代理区块：运行中绿、已停止黄（含成功）、失败红；运行中/已停止为 0 仍显示，失败为 0 不渲染）；红色只给真实错误与 ≥85%。上下文主指标用 `contextColor`（琥珀，≥85 转红），额度「已用占比」用 `usageColor`（低=绿、≥50 橙、≥85 红）。token 分量色：输入蓝 / 输出紫 / 缓存青绿 / 推理琥珀。状态胶囊的三种暗底（`*_WASH_COLOR`）只用于小面积状态块，不做大面积铺色。
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
- 凭据统一在 `quota/key.ts`：**宿主有效连接优先**（`credential` 表里宿主会选中的那一行，`ORDER BY active DESC, time_created DESC, id DESC LIMIT 1`）；仅当库不存在 / `:memory:` / 该 integration 零行时才用配置兜底（项目配置近到远、同目录 `.opencode/` 优先 → 全局配置；全局根见 `README.md` 安装段，实现 `shared/paths.ts` 的 `globalConfigDir()`）。解析结果 60s 缓存，按 pid + integration + 实际配置作用域分桶。行值按 `type` 取值：`key` → `key`，`oauth` → `access`；该行不可用（`external` / 缺字段 / 坏 JSON）整体跳过，不回退旧行或配置。身份 = DB 来源 scope + integration + credential id（`key` 另带 key 哈希；配置来源为 config scope + key 哈希）：同一 id 的 OAuth token 刷新不换桶，换号立即换桶并清空旧数据。`null` = 有意跳过（宿主状态不明 / 企业等非公共或非法 `metadata.server` 的 Console / 库存在却读不了），不请求、不写数据、不排程也不 warn；`undefined` = 没有任何来源，按 missing 只 warn 一次。宿主映射由 `quota/host.ts` 在 `tui.tsx` setup 绑定、hook 每次调用读取，必须传 `integrationID ?? provider.id`：provider 不在 `provider.list()` 才算未就绪（Console 供应商此时不查库、不走配置兜底），已同步但缺 `integrationID` 按 `provider.id` 查询。显式 `OPENCODE_DB` 只补宿主规则（绝对路径 / 相对 dataDir / `:memory:` 无凭据），不探测频道后缀或其他库。`opencode`/`opencode-go` 的 OAuth 凭据都挂在 `integration_id="opencode"` 下；`openai` 的在 `integration_id="openai"`，且**只有 Codex 登录（`chatgpt-browser`/`headless`）的 token 能查额度**，token-sharing 一律 401（见 `docs/provider-openai-quota.md`）。只读现值，不刷新、不落盘、不写日志。
- `QuotaStore` 按 providerID 分桶：网络刷新最小间隔 5min（`QUOTA_REFRESH_MS`），失败按 5→10→15min 退避并遵守 `Retry-After`；缓存按凭据身份（identity）分桶，同一凭据刷新 token 不换桶，换号后旧数据立即作废。**刷新调度不靠固定轮询**：`nextCheckAt(pid)` 是「下一次允许请求的绝对时刻」的唯一真源（`retryAt` → `at + backoff`），`useQuota` 用 `nextWakeAt()` 取最早目标 `setTimeout` 排到那一刻，60s 的 `QUOTA_TICK_MS` 只做凭据探测 + 补一次 `load`（漏排程兜底），请求频率仍由 store 决定。**通知订阅者两次**：请求真正开始时（`inFlight` 写入之后——否则「更新中」根本不会出现，倒计时归零后会停在 `00:00`）与落定之后（成功/失败/空响应都通知，且必须在 `inFlight` 清空之后，否则界面会被钉在「有数据 + 更新中」）。被间隔/退避跳过、**同凭据**并发等待的 `load` 不通知；**跨凭据**等待后接续的真实请求仍在该请求开始与落定各通知一次。**只有 `isQuotaProvider` 命中的 pid 才调 `load`**：未注册端点静默返回、不记日志（否则非额度供应商会被心跳刷成 `missing api url`）；`missing key` 的 warn 在同一凭据状态下只记一次（登录/切号换桶后重新计数）。
- 网络请求统一走 `shared/http.ts`：5s 超时/中止、8MB 上限、`Retry-After`、401/429/超时/网络/坏 JSON 归类、错误文本先脱敏再截断。provider 不再直接 `fetch`。
- 行内 `↻` 重置提示是**查询时刻的快照**：provider 在 fetch 时把 `resetsAt` 格式化成相对剩余时长（`12m` / `4h12m` / `5d`）塞进 `hint`，渲染层不重算。所以它最多滞后一个刷新周期，失败/退避期间可能更久（折叠态靠 `失败`/`旧` 前缀、展开态靠数据年龄兜底）。要真实倒计时得给契约加时间字段，属另一次设计。**别把它和组头的刷新倒计时搞混**：组头 `↻ 04:32` 是本插件下次去查额度的时刻（秒级、真实调度），`hint` 里的 `↻ 4h12m` 是供应商额度窗口重置时刻。
- 额度区块展示**本机全部有凭据的已启用供应商**（`listProviders` + 凭据探测，5min TTL；无凭据不出现、不记日志）。排序：当前会话 → 本会话运行中子代理在用 → 其余注册顺序；只展开当前会话那组，其余折叠成一行、点击就地展开，折叠摘要取已用最多的一条。当前会话供应商没有额度查询时它不出行，**全部折叠**（不猜哪条重要）。手动展开态存模块级 Map，跨重建保持。
- 当前已启用：`opencode-go`（`/zen/go/v1/usage`）、`command-code`（credits + subscriptions 双 API）、`openai`（`chatgpt.com/backend-api/wham/usage`，5h/周 + 有月度额度时补「月」）。Zen 侧 `/zen/v1/usage` 为 404，所以 `opencode` 不接额度。
- **新鲜度是展示元信息，不进供应商契约**：`QuotaStore` 记录 `updatedAt`（只在成功写入时更新，与「上次尝试 `at`」分离），`status(pid)` 返回 `phase`（`empty/loading/ready/stale/error`）、`fetching`、`ageMs`、`stale`、`updatedAt`、`nextRefreshAt`、`error`；`QUOTA_STALE_MS = 2 × 刷新间隔`。UI 只消费这份状态（`quotaStatusTrail` / `quotaErrorLabel` / `fmtCountdown` 纯函数）：展开态优先 在途`↻ 更新中` → 失败原因 + 真实重试倒计时（通用原因写`重试`，`凭据失效`/`限流` 原样保留）→ 过期`旧 12m` → 正常`↻ 04:32` → 算不出时刻退回数据年龄；折叠态只给 `失败`/`旧` 前缀 + 摘要（倒计时不挤占摘要）。**未取到数据不出行、失败不画 0%**；有缓存时失败仍展示缓存。**倒计时/年龄必须用 `updatedAt`、`nextRefreshAt` 与共享秒级时钟现算**（`rows()` 不读时钟，否则每秒重建全部行、重跑 renderer）。

# 数据口径（别自己发明）

- 会话累计 token 取 `SessionInfo.tokens`（`usageFromTokens`）；**不能**对 `session.message.list()` 求和——宿主分页加载，未滚动的历史不在列表里。上下文占用取最后一条 `completed` compaction 之后、revert 边界之前的 `assistant` 消息的 token 和（compaction/user 的 tokens 不算；上限与上下文取同一条 assistant，按 providerID + id 匹配）。
- 性能（首字/速度）只算每个**已完成**的 assistant 步：速度守卫为 `time.streamed − firstContentStart ≥ 200ms` 且净生成 `≥ 300ms`，**无速度上限**；生成中沿用上一步的值。无实时估算、滑窗、滤波或定时器。改速度逻辑前先读 `docs/design-performance-footer.md`。
- 子代理默认只读 `session.family()` 与 `SessionInfo` 聚合列；**展开时或运行中**按需 `message.sync(id)` 读子会话消息算首字 / 速度（运行中条目要在常驻第三行显示），不轮询、不持久化。耗时用 `(time.idle ?? time.updated) − time.created`，并用高水位钳住（步骤边界的旧 `idle` 会回跳）。**排序：running 优先 → 已完成按结束时刻（`idle ?? updated ?? created`）倒序**；默认只常驻最近 5 条已完成（`VISIBLE_DONE_ROWS`），其余折叠成 `还有 N 条已完成` 一行，running 不设上限（复用的老子代理会凭状态自动回到常驻区）。缓存率与会话区块共用 `cacheRateOf`。
- **结局取 `SessionInfo.outcome`**（宿主在 `session.execution.succeeded/failed/interrupted` 时写 `idle_outcome`，见 `packages/core/src/session/projector.ts` 的 `projectIdle`）：只在 `running === false` 时采信（运行中它仍是上一轮的旧值），缺失才降级为「已停止」。**禁止用 `running=false` 推断成功**。卡片头用 `subagentCounts` 给三个状态胶囊：运行中 / 已停止 / 失败（灯 + 状态色数字、不写文字标签；数字 3 位、合计 6 位定宽右对齐，见 `AGENT_COUNT_NUM_WIDTH` / `AGENT_TOTAL_WIDTH`）。**三个计数互斥**：`running + stopped + failed = 总数`，`stopped` 只数非失败的已停止（`stopped = 总数 − running − failed`），未知/中断都进 `stopped`，失败不重复计入已停止。运行中/已停止为 0 仍显示，失败为 0 不渲染。

# 更新与发版

- **版本号必须先问用户**：每次发版前用提问工具（`question`）把候选版本（沿用 `VERSION` / patch / minor / major）列给用户确认，**不得自行决定**；用户确认后再改 `VERSION` 并打 tag。
- 版本唯一来源：`update/version.ts` 的 `VERSION`（SemVer）。流程：改 `VERSION` → commit 到 `main` → `git tag vX.Y.Z` → `git push origin vX.Y.Z`。**只发正式版 `vX.Y.Z`**（无预发布/构建元数据），tag 必须落在 `main` 上。
- `.github/workflows/release.yml` 的链路固定为 `preflight → verify（复用 ci.yml）→ release → changelog`，workflow 级 `concurrency` 串行且不取消在跑的发布。preflight 校验正式 tag 正则、`VERSION` 精确一致、`git merge-base --is-ancestor` 证明 tag 来自 `main`；verify 就是整条 CI 门禁，**门禁失败不发版**。
- 资产协议：`scripts/build-release-asset.sh "$TAG" dist` 产出 `opencode-hud-vX.Y.Z.tar.gz` + 同名 `.sha256`（可复现、拒绝链接/隐藏条目）。Release **先以 draft 创建并上传**，再从线上 `gh release download` 回读两个资产，用 sidecar 复核归档字节（sidecar 的存在性由下载路径隐含验证），全部通过才 `gh release edit --draft=false`。已公开的 Release 重跑直接失败「拒绝覆盖资产」；draft 重跑先按本次两个资产名 `gh release delete-asset` 再上传。**禁止 `--clobber` 与 `|| true`**。
- 发布顺序：先发 Release、后回推 `CHANGELOG.md`。回推 job 只允许提交 `CHANGELOG.md`（提交后额外断言 `git diff --name-only origin/main HEAD` 只有它），且每轮 `git fetch origin main` 后都比对 `git show "$TAG:CHANGELOG.md"` 与 `origin/main` 的同名字节，不一致即失败而不是覆盖；连续 3 次失败会明确报「Release 已发布，请手工合并」。**不要手改 `CHANGELOG.md`**（发版时会被全量覆盖）。
- **Release 已发布后若只有 changelog job 失败，用 Re-run failed jobs 只重跑它**；整条 workflow 重跑会再次进入 release job，因公开态按设计失败。安装/更新/卸载共用目录锁、资产校验与旧名目录的手工清理，见「插件加载与安装」。
- 更新检查走 `github.com/<repo>/releases/latest` 的 302 `Location`，**不要改 `api.github.com`**（未认证限流 60 次/小时，部分网络直接 403）。节流：成功 TTL 24h / 失败冷却 1h / 超时 8s；缓存写到 `pluginDataDir()/update-check.json`。
- 一键更新是插件自包含：取 `.sha256` → 有界下载 → 解压前扫描归档头（与安装脚本同一套规则）→ 目录锁内原子替换 `globalPluginDir()`；任何校验失败都不触碰现有安装，也不回退源码归档/`git clone`/`main`。**不要改回“下载并执行安装脚本”**：`irm ... | iex` 会被 Windows Defender 判为 `Trojan:Win32/Commando.A!ml`。`child_process` 只用于本地 `tar`（120s 超时、`windowsHide`）。
- **Windows 上不能只靠重命名插件目录完成替换**：宿主热重载会为本插件每个源文件的父目录（含 `view/hooks`、`quota/providers` 这类后代目录）开 `fs.watch`，句柄覆盖整棵子树时旧目录和它的顶层条目都无法重命名，只会返回 `EPERM`；复制与删除不受影响。`installAtomically` 先试整体重命名，只有 `EPERM`/`EBUSY`/`EACCES` 才降级为「整树复制到备份容器 → 删除旧目录 → staging 落位」，任何一步失败都用备份恢复；其他 errno 直接失败。`tests/update-apply.test.ts` 必须保留真实 `fs.watch`（含嵌套目录）的回归用例——没有句柄时 rename 在 CI 上永远成功，会把这条路径测成绿的。

# 文档地图

- `README.md` — 用户的安装 / 更新 / 卸载（面向用户的使用说明；不记录版本变化、迁移历史、内部校验实现与供应链细节）。
- `docs/config-install.md` — 配置安装方式与 TUI 插件的双 Solid 陷阱（本插件不采用，供其他插件复用）。
- `docs/token-accounting.md` — 会话 token 口径、数据来源与 DB 对账。
- `docs/design-performance-footer.md` — 首字/速度口径、守卫与输入框上方性能行布局；改速度逻辑前必读。
- `docs/design-subagent-section.md` — 子代理区块取数、耗时口径与布局。
- `docs/reference-opencode-cache-and-tps.md` — 外部同类插件的可借鉴设计。
- `docs/reference-opencode-quota.md` — 外部同类项目 opencode-quota 的可借鉴项（行语义/配速、HTTP、凭据、刷新、server+RPC、用量与工程化取舍）。
- `docs/reference-multi-provider-quota.md` — 多订阅额度展示的同类实现（slkiser/opencode-quota 等）：分组/两级折叠/代表窗口/刷新与错误口径，及可借鉴清单。
- `docs/superpowers/specs/2026-11-11-multi-provider-quota-design.md` — 额度区块展示全部已登录订阅的设计（发现/排序/折叠/验收）。
- `docs/superpowers/specs/2026-09-24-config-install-design.md` — 配置安装改造的原始设计（**已废止**，历史快照；方法与根因见 `docs/config-install.md`）。
- `docs/superpowers/specs/2026-11-02-subagent-perf-design.md` — 子代理展开行首字/速度的原始设计（历史快照；运行中也读消息、Inspector 改版等后续变更见 `docs/design-subagent-section.md`）。
- `docs/superpowers/plans/` — 各次改动的历史实施计划（按日期；记录当时步骤与验收，不代表当前实现）。
- `docs/superpowers/specs/2026-11-11-heavy-dashboard-design.md` — HUD 5.0 重型仪表盘：审计结论、Obsidian Amber 视觉系统、37 列几何、额度新鲜度与子代理结局口径、ViewModel 拆分。
- `docs/superpowers/specs/2026-11-11-quota-reset-relative-design.md` — 额度 `↻` 重置提示改为相对剩余时长、数据年龄 `0m` 的口径与验收。
- `docs/superpowers/specs/2026-11-15-quota-refresh-countdown.md` — 组头「下次刷新倒计时」与秒级 UI 心跳：状态优先级、`nextCheckAt` 排程约束、格式化边界与测试清单。
- `docs/superpowers/specs/2026-11-16-audit-decisions-design.md` — 2026-11-16 审计决策的落地设计：三个子系统边界、控制器裁定（凭据身份/供应链/锁/发版/旧名结束）、条件阻塞与残余风险。
- `docs/superpowers/plans/2026-11-16-credential-rules.md` — 执行计划：宿主账号优先的凭据解析（Task 2）与额度状态机身份语义/宿主接线（Task 3）。
- `docs/superpowers/plans/2026-11-16-verified-delivery.md` — 执行计划：受控 Release 资产与更新器、跨语言锁与脚本消费者/旧名结束、稳定资产构建、CI 与发版日志（Task 4–7）。
- `docs/superpowers/plans/2026-11-16-validation-docs.md` — 执行计划：子代理计数互斥（Task 1）与文档收口/全分支验证（Task 8）。
- `docs/reference-usage-monitor-refresh-cadence.md` — 外部高星用量监控项目的刷新间隔/退避样本与「网络端点 vs 本地读取」分档，用于判断本插件 5min 间隔是否合理。
- `docs/reference-desktop-gui-plugins.md` — OpenCode Desktop GUI 插件（`./gui-experimental`）开发手册：构建/加载规则、窗口与主进程上下文、注册表、Ipc/存储/生命周期、排障；**§15 是 2.2.0 实机验证结论**（目录型插件三入口、server 可 import 什么、共用 RPC 契约、槽位真实跨度）。
- `docs/design-desktop-entry.md` — 双入口设计与桌面 Markdown 配色的历史记录（**已冻结**）、恢复方式与后续 HUD 面板路线。
- `docs/reference-realtime-tps.md` — 历史调研；实时 TPS 已在 v4.0.0 移除。
- `docs/provider-open-design.md` — OpenDesign 额度探测：推理 API Key 无端点；Control Key 可查 preflight + wallet（未接入）。
- `docs/provider-openai-quota.md` — OpenAI/ChatGPT 订阅额度：`wham/usage` 端点、真实响应、**只有 Codex 登录凭据可读**（token-sharing 401）与复验命令。
- `.opencode/skills/managing-quota-providers/SKILL.md` — 供应商新增/修改/删除流程。
- `CHANGELOG.md` — 发版自动生成、历史冻结；`TODO.md` — 跟踪中的上游问题。
- `docs/audit-2026-11-16.md` — 2026-11-16 全项目审计：覆盖范围、已修问题、验证证据、16 组审查事项及后续用户确认（唯一长期审计入口）。
- 新文档必须在同一次改动中登记到本节目录；代码注释只写不显然的原因/约束，来源、迁移、review 记录放 `docs/` 或本文件。
