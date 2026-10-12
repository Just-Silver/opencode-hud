# 语言规则
- 全程中文沟通与中文 `git commit`

# 项目
- 单 TUI 插件仓库，非 monorepo；**分发为脚本安装（发现式）**：`install.sh`/`install.ps1` 把插件整目录装到 `~/.config/opencode/plugins/opencode-tui-usage/`（`node_modules` 之外），不发布 npm registry（CI 仅 `.github/workflows/release.yml` 发版）
- 根 `package.json` 与 no-op `server.ts` 已随「配置安装」一并移除（TUI 插件配置安装当前不可用，方法学见 `docs/config-install.md`）；插件仅含 `tui.tsx` 入口
- 唯一插件：`.opencode/plugins/opencode-tui-usage/`（目录型插件，`Plugin.define id:"opencode-tui-usage"`），入口 `tui.tsx`（TUI 入口，薄壳，import `@opencode/plugin/tui`）+ 同目录子模块 `{model,quota,shared,view,update}/*` 视为单插件，子模块仅被入口 `import`；MVVM 四层：`model/` 数据与纯函数（可单测）、`quota/` 查询服务（fetcher+凭据）、`shared/` 纯帮助函数、`view/` UI（Sidebar=ViewModel 编排）、`update/` 更新检查与一键更新（版本常量 + GitHub Release 对比 + 执行安装脚本）
- 布局硬约束（opencode2 ≥ beta-18721 发现器）：插件必须是 `.opencode/plugins/`（或 `plugin/`）的**直接子目录**，目录内 `tui.tsx` = TUI 入口（`index.ts`/`server.ts` = server 入口）；**不可**再嵌套（旧 `plugins/tui/opencode-tui-usage.tsx` 形态在 19425 上不被发现、不加载）；直接子 `.tsx` 文件也不会被发现（只认 `.ts`/`.js`）。
- 入口仅 `tui.tsx`（TUI，import `@opencode/plugin/tui`）：**发现式/脚本安装只需 TUI 入口**。`server.ts`（no-op server 入口，import `@opencode/plugin`，不得触碰 `context.ui`）**仅配置安装需要**（纯 TUI-only 包会被 server 跳过 → CLI 拿不到 → `./tui` 不加载），已随配置安装移除，详见 `docs/config-install.md`

# 分发安装
- **面向用户：脚本安装（发现式）**。`install.sh` / `install.ps1` 取**最新 Release**（先解析 `github.com/<repo>/releases/latest` 的 302 tag，再 `git clone --depth 1 --branch <tag>`，失败回退 `archive/refs/tags/<tag>.tar.gz`；**与 TUI 一键更新取源一致，非 `main`**），整目录**原子**装到 `$XDG_CONFIG_HOME/opencode/plugins/opencode-tui-usage/`（默认 `~/.config/opencode/plugins/...`；Windows 取 `$HOME/.config`）；`uninstall.sh` / `uninstall.ps1` 删该目录并清理 ≤18707 旧布局（`plugins/tui/*`）残留。安装后重启 opencode 生效；更新 = 重跑安装脚本（或 TUI 内一键更新）
- 脚本落在 `plugins/` **直接子目录**且在 `node_modules` 之外 → 走 OpenTUI 运行时桥接，Solid 响应式正常。**这是 TUI 插件当前唯一可用的安装方式**
- **配置安装（`opencode.json(c)` 的 `plugins`）当前不用于本插件**：会把插件装进 `node_modules`，npm 自动安装的 peer 依赖（`solid-js`/`@opentui/*`）导致**双 Solid 运行时** → 只画首帧、不再刷新（现象：侧边栏首次为空、切一次会话才显示）。上游未修复（#33884/#39986 OPEN）；非 TUI（server）插件不受影响。完整方法学/验证判据整理在 `docs/config-install.md`

# 发版
- 版本单一事实源：`.opencode/plugins/opencode-tui-usage/update/version.ts` 的 `VERSION`（SemVer）
- tag == VERSION（release.yml 校验，不一致即 fail 拦截）；用户更新 = 重跑安装脚本
- **启动时自动检查更新**：`update/index.ts` 查 GitHub 最新 Release 对比本地 `VERSION`（走 `github.com/<repo>/releases/latest` 的 **302 跳转**读 `Location`，**不用 `api.github.com`**——未认证限流 60 次/小时、部分网络直接 403），落后则 `view/UpdateBanner.tsx` 在侧边栏底部显示可点击一键更新的单行提示；无 Release / 网络失败 / 本地超前 → 静默零占位（静默失败原则，见 `update/index.ts` 头注释）。**节流**：结果落盘到插件自己的「本地应用数据」目录（对齐各 OS 的 `LocalApplicationData`：Windows `%LOCALAPPDATA%\opencode-tui-usage\update-check.json`、macOS `~/Library/Application Support/...`、Linux `$XDG_DATA_HOME` 或 `~/.local/share`），成功 TTL 24h / 失败冷却 1h / 查询超时 8s，跨进程共享。**一键更新**：横幅正文可点击 → `ctx.ui.dialog.show(<UpdateDialog>)` 弹出模态弹窗（状态 available/updating/done/failed，Esc 由对话框系统处理、Enter 走 `ctx.keymap.layer`）→ `update/apply.ts` **插件内自包含更新**（`fetch` 对应版本 tag 归档 → 系统 `tar -xzf` 解压 → 校验 `tui.tsx` → 原子替换到**全局插件目录** `shared/paths.ts` 的 `globalPluginDir()` = `$XDG_CONFIG_HOME/opencode/plugins/opencode-tui-usage`；`node:child_process` 仅 spawn 本地 `tar`、超时 120s、失败展示输出尾部）。**不用官方安装脚本、不执行远程脚本**——`pwsh -Command "irm … | iex"` 会被 Windows Defender 误报 `Trojan:Win32/Commando.A!ml`（「下载即执行」启发式），实测被拦截。成功后 `markUpdated()` 清缓存使横幅消失；弹窗 done 态提供「重启」按钮 = `ctx.keymap.dispatch("app.exit")`（官方 `exit()` → `destroyRenderer` 路径，退出 opencode，非自动重启进程）；见 `view/UpdateBanner.tsx` / `view/UpdateDialog.tsx`
- 流程：改 `VERSION` → commit → `git tag vX.Y.Z` → `git push origin vX.Y.Z` → `.github/workflows/release.yml` 自动创建 Release

# 运行与验证
- 本地 `Bun 1.3.14`，`TUI` 依赖 `bun:sqlite` 读 `~/.local/share/opencode/opencode.db`
- 热重载：`B/~BUN/root/chunk-*.js?mtime` 内存打包，opencode2 动态加载，新增/重命名/删除/同名覆盖均无需重启
- 日志：TUI 插件**无 `app.log`**（client 为 HTTP 客户端；旧文档 `ctx.client.app.log` 会直接崩溃，已踩坑）。`console.*` 被 **OpenTUI 接管到应用内 console 面板**（`renderer.console`，需 keybind 打开；**不进** opencode.log，面板临时、`save-logs` 另存到 `./_console_<ts>.log`）——opencode.log 里只有**宿主插件加载器**的日志（`plugin operation started/completed/failed/stalled`，`packages/tui/src/plugin/context.tsx`）。诊断走文件日志 `<localAppData>/opencode-tui-usage/tui-usage.log`（`shared/paths.ts` 的 `pluginDataDir()`；Windows = `%LOCALAPPDATA%\opencode-tui-usage\`）：**默认禁用零开销**，排查时 `$env:TUI_USAGE_PROBE="1"; opencode` 启用（TUI 插件跑在客户端进程），文件超 1MB 自动重建（官方 opencode.log 无限 append 无任何清理，我们自管）；失败统一 `60s` 限流不重试
- 校验：单元测试 `node --test tests/*.test.ts`（node ≥23.6 原生 TS strip，零依赖；9 个文件：key/quota/model/quota-store/shared/command-code/discovery/update/update-apply，全部须过）；改后打包语法检查用 esbuild：`npx --yes esbuild .opencode/plugins/opencode-tui-usage/tui.tsx --bundle --platform=node --format=esm --jsx=automatic --jsx-import-source=@opentui/solid --external:@opencode/plugin/tui --external:@opentui/solid --external:solid-js --outfile=$env:TEMP\opencode\tui-bundle-check.js`（`Done in` 即通过）；`opencode` 启动侧边栏无 `sidebar.content` 崩溃即正常
- 官方源码速查：v2 仓库 = `sst/opencode`（TS monorepo，**`opencode-ai/opencode` 已归档勿用**）；日志实现 `packages/core/src/observability/logging.ts`（`Logger.toFile(..., { flag: "a" })`，**opencode.log 无轮转/截断/清理**）；查代码用 sparse clone 绕过 GitHub code search 对超大仓库的截断：`git clone --depth 1 --filter=blob:none --sparse <url> && git -C <dir> sparse-checkout set packages/core packages/tui`

# opencode2 版本与插件加载
- **当前推荐版本 `0.0.0-beta-19425`（2026-09-10）已实测可加载本插件**（本文档即修复于 19425）；**`2.0.15`（2026-09-24）亦实测可加载**（发现式；配置安装曾实测生效，但因 TUI 双 Solid 缺陷已回退，见「分发安装」）
- 19425 双层变化（相对 18707，实测）：
  1. **包名改名**：运行时注入的插件模块由 `@opencode-ai/plugin/tui` 改为 `@opencode/plugin/tui`（**无兼容重映射**，旧名 import 直接 ResolveMessage 失败）；npm 主包同时 `@opencode-ai/cli` → `@opencode/cli`
  2. **目录型插件布局**：发现器只扫 `plugins/`（与 `plugin/`）**直接子项**；直接子 `.ts`/`.js` = 文件插件；直接子目录 = 目录插件，入口经解析器取 `tui.tsx`（TUI）/`index.*`、`server.*`（server）。旧的嵌套 `plugins/tui/opencode-tui-usage.tsx` 形态在 19425 上**既不被服务端也不被 TUI 加载**（探针实测空日志）。直接子 `.tsx` 文件（非目录）也不被发现（文件只认 `.ts`/`.js`，实测）
- **判据**：`opencode2 plugin list` 列出候选（目录型只看 `tui` 入口存在与否）；真实加载看 `opencode2 api --standalone --print-logs GET /api/plugin` 的 stderr `msg="loading plugin"` + `WARN failed to load plugin ... cause`；TUI 侧看探针文件 `~/.local/share/opencode/log/tui-usage.log`（`$env:TUI_USAGE_PROBE=1`）
- **注意**：`plugin list` 读后台 **service 缓存**，改磁盘后需 `opencode2 service restart`（或等 `plugin update`）才刷新；`api --standalone` 起私有子服务可即时看真值
- **历史（≤18707，2026-09-01 三层根因，已过时仅供参考）**：18721/18743 曾出现「发现器只认根层 direct `.ts`/`.js` + 依赖外置化（server 端 import `@opencode-ai/plugin` 走磁盘 `~/.config/opencode/node_modules/`，官方从不安装）+ 加载器 `?mtime=` file:// URL bug」；我方实证提交 #46408、#42051 同族
- **配置安装（`opencode.json(c)` 的 `plugins`）：完整方法学、包形状、验证判据与「TUI 插件双 Solid 陷阱」已整理到 `docs/config-install.md`（面向非 TUI 插件复用；2026-09-24 定论）**。一句话：TUI 插件经配置安装会落进 `node_modules`，npm 自动安装的 peer 依赖（`solid-js`/`@opentui/*`）形成**双 Solid 运行时** → 只画首帧不刷新（现象：侧边栏首次为空、**切一次会话才显示**）→ 本插件回退脚本安装；上游 #48883（关闭为重复）/#33884/#39986（均 OPEN），非 TUI（server）插件不受影响

# 关键逻辑
- `sidebar.content` 的 `render({sessionID})` 仅跟当前展示会话，空会话 `providerID` 返回 `undefined` 不查额度、有缓存 `Map<providerID,QuotaData>` 切回瞬时显示，子代理独立 `sessionID` 不进侧边栏不触发
- 额度按 `providerID` 分桶：`model/quota.ts` 的 `QuotaStore`（cache/at/inFlight + **subscribe 写库通知**，依赖注入可测；`load(pid, {force})` 供轮询绕过 60s 限流，Sidebar 订阅的是当前组件实例，跨 render 重建不丢刷新）；供应商**运行时自动发现**（opencode 源码确认：TUI 插件为 bun 运行时逐文件动态 import，无打包器/glob）：`quota/index.ts` 顶层 await 用 fs 扫描 + 动态 import 收集 `quota/providers/<name>.ts` 导出 `provider` 的模块，交 `quota/registry.ts` 的 `createRegistry`（纯逻辑可测）推导白名单/URL/fetcher；白名单守卫与 fetcher 分发均经 `isQuotaProvider`/`normID` 按「小写+只留 [a-z]」归一化匹配（用户写法 `opencode-go`/`opencodego`/`opencode_go` 均命中），配置/DB 查找保持原样 pid（同源天然命中）；API URL 经 `getProviderApiUrl` 归一化查找（未注册/未启用返回 `undefined`，由 `QuotaStore.load` 记 `missing api url` warn 并跳过——**无兜底**，避免静默指向错误端点；端点由各 `providers/*.ts` 自持，通用 `registry.ts` 不含任何供应商细节）。**新增供应商 = 只需新增 `providers/<name>.ts` 一个文件，热重载即生效**
- 新增供应商模板（照抄 `quota/providers/opencode-go.ts`）：文件导出 `provider: {id, apiUrl, enabled?, fetch}`——`id` 任意写法（白名单归一化匹配）；`apiUrl` 为供应商自持端点（如 `opencode-go.ts` 的 `QUOTA_API_URL`）；`fetch(apiUrl, key): Promise<QuotaData | undefined>` 返回扁平 `QuotaData = {rolling?, weekly?, monthly?}`（各窗口 `{status?, percent?}`，percent 0-100 整数），`key` 由调用方经 `resolveProviderKey(id)` 注入（**仅用于 Authorization 头，不落盘不上报**）；`enabled` 默认 true，`enabled: false` = 已实现待验不激活（跳过白名单，新供应商验证期间可用）
- 功能开关一览：`TUI_USAGE_PROBE=1` 探针文件日志（默认关，见「运行与验证」日志行）；供应商级 `enabled: false` 跳过白名单（新供应商待验期间用）
- Command Code 已启用（`quota/providers/command-code.ts`：`mapCommandCode` 纯函数 + `fetchCommandCode` 双 API，`enabled: true`）；测试 `tests/command-code.test.ts` 离线覆盖转换逻辑
- 凭据解析统一在 `quota/key.ts`：`resolveProviderKey(pid)` 顺序 keyCache → 项目配置（近→远，同目录 `.opencode/` 优先）→ 全局配置（XDG_CONFIG_HOME 优先）→ DB credential 表兜底；支持 V2 `providers.{id}.settings.apiKey` / V1 `provider.{id}.options.apiKey` 与 `{env:VAR}` 占位符，模块零日志（脱敏：key 不落盘、不上报）
- **DB 兜底覆盖两种登录形态**（判别 = 官方 `Credential.Value` 的 `type` 字段，`packages/schema/src/credential.ts`）：`type:"key"`（`/connect` 粘贴 key，凭据归 provider 自己 = 官方 `keyProvider`）取 `key`；`type:"oauth"`（`auth login` Console device flow）取 `access`；`type:"external"` 等不处理。**Console 供应商（`opencode`/`opencode-go`）的 OAuth 凭据统一写在 `integration_id = "opencode"` 下**（官方 `consoleIntegration()`），故 DB 查询按 `credentialIntegrationIDs(pid) = [pid, consoleIntegration(pid)]` 顺序（`opencode-go` → `opencode`，`normID` 归一化兼容 `opencode_go`）。**插件只读现值、不刷新**：不碰 `refresh`/`expires`，token 过期由 opencode 自身刷新写回 DB（过期时查询失败与模型访问失败同因）
- **auth 登录额度已实测打通（2026-10-12）**：Console 登录的 `access`（DB `type=oauth`/`method=device`）可直接调用 `https://opencode.ai/zen/go/v1/usage`（200，返回 `rolling/weekly/monthly` + `resetsAt`）；Zen 侧 `https://opencode.ai/zen/v1/usage` 为 404（按量计费无窗口端点，故 `opencode` 不入白名单）。修前 `providerID=opencode-go` 因凭据挂 `opencode` 名下而落 `missing key` → 额度不显示

# UI 硬约束（Solid 响应式）
- **组件函数体只执行一次**：禁止 `const q = props.xxx` 这类 props 快照 const——挂载后 props 更新不生效（历史 bug：QuotaSection/UsageSection/ColorBar 均踩过，额度不显示、压缩上下文后进度条不刷新皆源于此）
- 取值必须发生在 **JSX 表达式位置**（Solid 编译器包装为响应式 getter），或惰性函数（`const pct = () => quotaPct(props.quota?.rolling)`）在 JSX 内调用
- 组件文件头部已含此约束注释；新增展示组件时必须遵守

# UI 视觉规范（view 层，2026-10-06 定）
- **配色固定用 opencode 默认主题色（不跟随 `ctx.theme`）**，单一事实源 `view/theme.ts`：primary `#fab283`（区块标题）/ text `#eeeeee` / muted `#808080` / 绿 `#7fd88f` / 橙 `#f5a742` / 红 `#e06c75` / 边框 `#484848` / 分隔线 `#3c3c3c` / 进度条轨道 `#1e1e1e`。色值取自 opencode 官方主题 `packages/tui/src/theme/assets/opencode.json`（defs.dark*）；进度阈值不变（<50 绿 / ≥50 橙 / ≥85 红，`pctColor(pct)` 不再收 theme 参数）。**view 层组件不再接 `theme` prop**（UpdateBanner/UsageSection/QuotaSection/Sidebar 均已移除；Sidebar 仍需 `usePlugin()` 取 `ctx.data`）
- **面板**：整个插件（会话 + 额度 + 更新横幅）共用一个带边框盒子（`border` + `borderColor`，`paddingLeft/Right=1`、`paddingTop/Bottom=0`）。**盒子整体由 `Sidebar` 的 `hasContent()` 门控**（`usage() !== undefined || showUpdate()`）：无用量且无更新提示时**整块不渲染**，避免会话初始（尚无事件、`usage()` 为 `undefined`）出现空边框占位。更新检查状态因此上提到 `Sidebar`（ViewModel）持有，`UpdateBanner` 改为纯展示（`props.update` + `onDismiss`）——否则检查随空盒子卸载，横幅永不出现。**不用整行 `backgroundColor` 色块做分隔线**——1 行高的实心色块视觉厚重（踩过，用户否决）；分隔线一律用 `─` 字符线（`dividerLine(rowWidth())`）
- **区块**：标题行（▼/▶ + 橙金粗体标题，折叠时摘要右对齐）**自成一行**，分隔线在其**下方独立一行**（不是跟在标题文字后面、也不是同行的填充线——这是参考项目 opencode-visual-cache 的实际形态，用户明确要求）
- **行宽测量**：`ref` + `onSizeChange` → `rowWidth` signal → 字符线按测量宽 repeat（首帧 0 时 `dividerLine` 返回最少 1 个字符）
- **数值行**：`box flexDirection="row"` = label + `flexGrow` 垫片 + 右对齐 value/share 列；数值列是纯 ASCII，用 `padStart` 定宽右对齐即可，**中文标签不需要 visualWidth**（flex 垫片自动处理）。仅摘要等含 CJK 的字符串拼接才需要 `visualWidth`（`shared/format.ts`，纯函数可单测；`dividerLine` 同）
- **无数据区块整块不渲染**：额度供应商不在白名单（如 deepseek）时，额度区块连标题/分隔线都不显示（不给「不支持」提示——用户明确要求不显示）
- **额度行显示窗口重置时间**：`resetsAt` → `fmtResetTime`（`shared/format.ts` 纯函数，本地时区）：<24h 显示时刻 `HH:MM`、<7d 显示 `周X`、否则 `MM-DD`；缺失/非法/已过期一律不显示。**重置列必须定宽右对齐**（`padStartVisual` 按显示列补空格，宽 8 列 = `↻`(2) + 空格(1) + 5）：flex 行里进度条 `flexGrow` 吸收剩余宽度，右侧列宽度不固定会让各行进度条长度漂移、列错位；任一行有 `resetsAt` 才出该列（全无则不占宽度，如 Command Code）。标记 `↻`(U+21BB) 属宽度歧义字符：等宽字体无半宽字形、实际占 2 列，故 `charColumns` 特判为 2 列（按 1 列算字形会被裁一半）— 加新符号/emoji 时同样要按终端实际渲染宽度核对
- **进度条 0% 不渲染填充块**：OpenTUI 里 `flexGrow=0` 的 box 仍占最小 1 格（`minWidth={0}` 不足以归零），故 `ColorBar` 用 `Show when={clamped(pct) > 0}` 门控填充块，0% 时整条只剩轨道色
