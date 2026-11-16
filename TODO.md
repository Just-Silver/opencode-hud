<!-- 职责：记录仍在上游/兼容窗口内的跟踪项与当时的决策复查节点；不写：已修实现细节（见 docs/audit-2026-11-16.md）、现行架构规范（见 AGENTS.md）。 -->

# TODO

## 跟踪中

- [ ] **桌面端（GUI 插件）开发已冻结**（2026-10-28 决策，2026-11-08 冻结删除）
  - 状态：2026-11-08 曾实现 GUI 入口（`gui-experimental.cjs`）与 Markdown 配色并实机验证，同日冻结删除；当前仓库**无桌面入口**，只服务 TUI。恢复方法与设计见 `docs/design-desktop-entry.md`。
  - 冻结原因（用户决定，非技术阻塞）：形态上的硬冲突无法两全 —— 想要「会话内 + 窗口底部全宽状态条」，但第三方可用槽位里 `window.bottom` 横跨全窗口（`shell.tsx` 里是「项目列表 + 会话区」那一行的兄弟节点），会话内只有 `session.header` / `session.panel.end`，没有底部。
  - 已确认可行的部分（重启时可直接用）：
    - 目录型插件可同时是 server + TUI + GUI，**不需要**改成 npm 包安装；
    - server 部件可 import `@opencode/plugin/rpc`，`Rpc.define` 是恒等函数 → **一份契约、TUI 与桌面共用**；
    - 桌面窗口只做渲染，`fs`/`sqlite`/`tar` 全留 server；额度可用 `ctx.client.experimental.usage.limits({ location })` 免密钥、凭据可用 `ctx.client.credential.list()`。
  - 重启时需要重新决策的点：
    - 状态条位置：`ComposerPill`（会话内、胶囊形态）vs `window.bottom`（全宽、非会话内）vs 面板顶部；
    - 面板：1 个 tab（用户已选）还是拆多个；
    - 构建形态：根 `src/` + 根 `package.json`（仅 devDeps）+ 产物 `gui-experimental.cjs` 提交进插件目录（用户已选）；
    - A 阶段（TUI 不动、server 与 TUI 各跑一份）还是直接 B 阶段（TUI 也走 RPC）——用户已选「A 先落地、B 紧随其后」。
  - 未完成（重启时）：长期可维护的 spec 与后续路线；当时的功能实现已随冻结删除。

- [x] **TUI 插件「配置安装」：本项目不采用，知识留存**（2026-09-24 决策；2.0.x 结论；2.2.6 情况见 `docs/config-install.md` 第 5 节）
  - 配置安装会让 TUI 插件加载第二份 Solid 运行时（侧边栏首次为空、切一次会话才显示），代价与收益不匹配，因此继续脚本安装（发现式）。根因、上游 issue、方案 A/B/D 对比见 `docs/config-install.md` 第 5 节。

- [ ] **Windows 上「未钉版本的 git 插件」会让 opencode 弹命令窗**（opencode 侧问题，**非本插件**）
  - 现象：`plugins` 里写**未钉版本**的 git 源（如 `Just-Silver/opencode-hud`），opencode 共享服务 cold start 做插件更新检查时 spawn `git ls-remote` **未加 `CREATE_NO_WINDOW`** → Windows 弹出可见控制台窗口。删 `~/.cache/opencode/npm/...` 后重启（触发强制重装）会弹更多次（实测 3 次）。
  - 根因/上游 issue：<https://github.com/anomalyco/opencode/issues/50868>（OPEN；`server: unpinned plugin update check flashes visible git console window on Windows`）
  - 同类已关闭：`#42440`、`#38715`、`#31629`、`#30315`（Windows 子进程 spawn 通用闪窗）
  - 规避：
    - **钉完整 40 位 commit SHA**（上游明确：full commit hash 会跳过 update check，完全不弹）；tag 是否同样跳过**未验证**。
    - 别删 `~/.cache/opencode/npm/...` 缓存（删了会触发重装 → 更多弹窗）。
    - 彻底不弹只能改用发现式安装（`~/.config/opencode/plugins/` 放目录）。
  - 动作：
    - [ ] 跟踪上游 #50868 修复
    - [ ] 视需要给 README 增加「怕弹窗请钉 commit SHA」的提示
    - [ ] 上游修复后回归验证
  - 备注：本插件自身只 spawn 本地 `tar`（`update/apply.ts` 的 `execFile`，120s 超时、`windowsHide`），不 spawn git/npm/网络安装命令；上面的弹窗问题针对 opencode 自身的 `git ls-remote`。

- [x] **改名迁移保护：旧名兼容已于 2026-11-16 结束，不再对旧版目录负责**（2026-10-28 记录，2026-11-16 结束）
  - 背景：`opencode-tui-usage` → `opencode-hud` 后，安装 / 更新 / 卸载曾会顺手删旧目录 `plugins/opencode-tui-usage`，否则新旧两份插件同时注册 `sidebar.content` 与 `prompt.footer.status`，侧栏和性能块重复渲染。
  - 结论（用户确认项 10）：**源码与脚本已零引用旧名，`install.*`/`uninstall.*`/`update/apply.ts`/`shared/paths.ts` 的旧名清理全部删除，运行时不再删除用户机器上的旧目录。从 v4.1.x 升级或卸载后，旧目录不会被脚本自动删除；旧副本仍可能被宿主加载并与新安装重复注册相同 slot（侧栏、性能块重复渲染），必须手工删除后重启。**
  - 原计划清理点（均已完成）：`install.*` 的旧目录循环、`uninstall.*` 的旧名项、`update/apply.ts` 的 `removeLegacyPluginDir()`、`shared/paths.ts` 的 `LEGACY_PLUGIN_DIR_NAME`/`legacyGlobalPluginDir()`、`tests/update-apply.test.ts` 的旧目录断言、`AGENTS.md` 的旧约束。
  - 顺带：`docs/superpowers/**` 与 `CHANGELOG.md` 里的旧名是历史记录，按文档规则不回填。
