<!-- 职责：给在本仓库工作的 agent 的入口约束（结构、校验、插件加载/安装、UI 硬约束、数据口径、发版）；不写：各主题的完整设计推导（见文末文档地图）。 -->

# 语言

- 全程中文沟通；`git commit` 信息用中文。

# 仓库速览

- 单一 opencode2 TUI 插件仓库，非 monorepo。**没有根 `package.json`、lockfile 或构建步骤**；测试用 Node 内建，不要为跑测试引入依赖或打包配置。
- 唯一插件：`.opencode/plugins/opencode-tui-usage/`，入口 `tui.tsx`（`Plugin.define id:"opencode-tui-usage"`），注册两个 slot：
  - `sidebar.content` → `view/Sidebar.tsx`（ViewModel：信号/memo/副作用都在这里）
  - `prompt.footer.status` → `footer.tsx` → `view/PerfFooter.tsx`（首字/速度）
- 目录职责：`model/` = 数据与纯函数；`quota/` = 供应商发现 + 凭据 + 查询；`shared/` = 通用纯函数；`view/` = Solid UI；`update/` = 更新检查与一键更新。
- **相对导入必须带 `.ts`/`.tsx` 后缀**：运行时由 Bun 逐文件直接 import，没有打包器做后缀解析。

# 校验（改完必跑）

- 全量测试：`node --test tests/*.test.ts`（Node ≥23.6 原生 TS strip，零依赖；当前 134 个用例，全部须过）。单文件可用 `node --test tests/perf.test.ts`。
- 测试按 `node:test` 写，不要用 `bun test` 代替。
- 打包语法检查（Windows PowerShell；`Done in` 即通过）：

```powershell
npx --yes esbuild .opencode/plugins/opencode-tui-usage/tui.tsx --bundle --platform=node --format=esm --jsx=automatic --jsx-import-source=@opentui/solid --external:@opencode/plugin/tui --external:@opentui/solid --external:solid-js --outfile=$env:TEMP\opencode\tui-bundle-check.js
```

- 没有 lint / typecheck / formatter 配置；esbuild 就是编译检查。
- 运行冒烟：在本仓库启动 opencode（`.opencode/plugins/` 会被发现），侧边栏不出现 `sidebar.content` 崩溃即基本正常；额度/性能逻辑靠应用内 console 面板观察。

# 插件加载与安装

- 发现器只认 `plugins/`（或 `plugin/`）的**直接子项**：目录型插件的 TUI 入口是 `tui.tsx`。不要再嵌套目录，也不要把 TUI 入口写成直接子 `.tsx` 文件（文件插件只认 `.ts`/`.js`）。
- 运行时包名是 `@opencode/plugin/tui`，**不是**旧的 `@opencode-ai/plugin/tui`（无兼容重映射，改回旧名会直接加载失败）。
- 面向用户只支持脚本安装：`install.sh` / `install.ps1` 解析最新 Release 的 302 tag，优先 `git clone --branch <tag>`，失败回退 tag 归档；整目录原子装到 `$XDG_CONFIG_HOME/opencode/plugins/opencode-tui-usage/`（Windows 取 `$HOME/.config`）。`uninstall.*` 删该目录并清理旧版 `plugins/tui/*` 残留。
- **不要改用 `opencode.json(c)` 的 `plugins` 配置安装**：插件会落进 `node_modules`，peer 依赖带进第二份 Solid 运行时，表现为只画首帧、切一次会话才刷新。完整方法与上游 issue 见 `docs/config-install.md`。
- 排查加载：`opencode2 plugin list` 只列候选且读 service 缓存，改盘后可能需要 `opencode2 service restart`；真实加载看 `opencode2 api --standalone --print-logs GET /api/plugin` 的 `loading plugin` / `WARN failed to load plugin`。
- 开发时 opencode2 会热重载该插件目录（新增/重命名/删除文件通常无需重启）。
- **TUI 插件没有 `app.log` API**（`ctx.client.app.log` 会崩）。`console.*` 进 OpenTUI 应用内 console 面板，不进 `opencode.log`；`opencode.log` 只有宿主的插件加载器日志。不要新增文件日志。

# Solid / UI 硬约束

- **组件函数体只执行一次**：禁止 `const x = props.x` 这类 props 快照；取值放 JSX 表达式，或用惰性 getter（`const pct = () => quotaPct(props.item)`）。额度不显示、上下文进度条不刷新都踩过这个坑。
- 周期性重算的行列表用 `<Index>`（子代理区块）；`<For>` 按引用比较会销毁重建整行，清掉用户选中/滚动。数据只在数据源变化时更新的列表（如 `bars` 的 items）可以用 `<For>`。
- 侧边栏宽度由宿主硬编码为 42，子代理按 34 列常量布局；**不要用 `onSizeChange` 实测**（首帧为 0，会让标题与分隔线闪一下）。分隔线用 `─` 字符线 + `width="100%"`，不要用整行 `backgroundColor`。
- 配色只从 `view/theme.ts` 取：固定 opencode 暗色主题，不跟随 `ctx.theme`。百分比阈值：<50 绿 / ≥50 橙 / ≥85 红。
- 整个插件的边框盒子由 `Sidebar` 的 `hasContent()` 门控（用量 / 子代理 / 更新提示全无时整块不渲染）。更新检查状态必须留在 `Sidebar`，否则横幅会随空盒子卸载。
- 无数据区块整块不渲染（额度为空、供应商不支持、无子代理），不要显示“不支持/无数据”占位。
- 进度条 0% 不渲染填充块：OpenTUI 里 `flexGrow=0` 的 box 仍占 1 格，`ColorBar` 用 `Show when={pct > 0}` 门控。
- 含 CJK/符号的拼接才用 `visualWidth`；`↻`(U+21BB) 实测占 2 列，`charColumns` 已特判。新增符号/emoji 要按终端实际渲染宽度核对。
- 额度渲染器在 `view/renderers/`：新增展示形态要加 `<name>.tsx`，并在 `registry.ts` 的 `RENDERER_NAMES` 与 `index.ts` 的 `RENDERERS` 各登记一项。不要把单个供应商的专属逻辑塞进 `QuotaSection` 或 `bars`。

# 额度（quota/）

- **增删改供应商前先加载 `.opencode/skills/managing-quota-providers/SKILL.md`**。
- 供应商是运行时自动发现：`quota/index.ts` 顶层用 fs 扫描 `providers/*.ts` 并动态 import，导出 `provider` 即生效。**新增供应商只加一个文件，不改注册表；删除只删文件**。
- `provider = { id, apiUrl, render?, enabled?, fetch }`；`fetch` 返回 `QuotaData = { items: [{ label, percent?, text?, hint? }] }`。契约只放渲染原语，不要加 `resetsAt` 之类语义字段。
- 未用真实响应验证前用 `enabled: false`；展示设计（显示哪几行、标签叫什么）先与用户确认。
- 白名单、URL、fetcher 分发均按 `normID`（小写 + 仅保留 a-z）匹配；未注册/未启用返回 `undefined`，**无兜底**。
- 凭据统一在 `quota/key.ts`：keyCache → 项目配置（近到远，同目录 `.opencode/` 优先）→ 全局配置 → DB `credential` 表。DB 按 `type` 取值：`key` → `key`，`oauth` → `access`；`opencode`/`opencode-go` 的 OAuth 凭据都挂在 `integration_id="opencode"` 下。只读现值，不刷新、不落盘、不写日志。
- `QuotaStore` 按 providerID 分桶：60s 限流、并发去重、写库后 `subscribe` 通知。Sidebar 每 60s 用 `load(pid, { force: true })` 轮询，切回会话走缓存。
- 当前已启用：`opencode-go`（`/zen/go/v1/usage`）与 `command-code`（credits + subscriptions 双 API）。Zen 侧 `/zen/v1/usage` 为 404，所以 `opencode` 不接额度。

# 数据口径（别自己发明）

- 会话累计 token 取 `SessionInfo.tokens`（`usageFromTokens`）；**不能**对 `session.message.list()` 求和——宿主分页加载，未滚动的历史不在列表里。上下文占用取最新 assistant 消息的 token 和。
- 性能（首字/速度）只算每个**已完成**的 assistant 步：速度守卫为 `time.streamed − firstContentStart ≥ 200ms` 且净生成 `≥ 300ms`，**无速度上限**；生成中沿用上一步的值。无实时估算、滑窗、滤波或定时器。改速度逻辑前先读 `docs/design-performance-footer.md`。
- 子代理只读 `session.family()` 与 `SessionInfo` 聚合列，不读子会话消息、不持久化。耗时用 `(time.idle ?? time.updated) − time.created`，并用高水位钳住（步骤边界的旧 `idle` 会回跳）。**排序：running 优先 → 已完成按结束时刻（`idle ?? updated ?? created`）倒序**；默认只常驻最近 5 条已完成（`VISIBLE_DONE_ROWS`），其余折叠成 `还有 N 条已完成` 一行，running 不设上限（复用的老子代理会凭状态自动回到常驻区）。缓存率与会话区块共用 `cacheRateOf`。

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
- `docs/reference-desktop-gui-plugins.md` — OpenCode Desktop GUI 插件（`./gui-experimental`）开发手册：构建/加载规则、窗口与主进程上下文、注册表、Ipc/存储/生命周期、排障。
- `docs/reference-realtime-tps.md` — 历史调研；实时 TPS 已在 v4.0.0 移除。
- `docs/provider-open-design.md` — OpenDesign 额度探测：推理 API Key 无端点；Control Key 可查 preflight + wallet（未接入）。
- `.opencode/skills/managing-quota-providers/SKILL.md` — 供应商新增/修改/删除流程。
- `CHANGELOG.md` — 发版自动生成、历史冻结；`TODO.md` — 跟踪中的上游问题。
- 新文档必须在同一次改动中登记到本节目录；代码注释只写不显然的原因/约束，来源、迁移、review 记录放 `docs/` 或本文件。
