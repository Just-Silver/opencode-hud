# TODO

## 跟踪中

- [x] **TUI 插件「配置安装」：本项目不采用，知识留存**（2026-09-24 决策）
  - 现象：经 `opencode.json(c)` 的 `plugins` 安装本插件后，侧边栏**首次为空、切一次会话才显示**（之后更新也不刷新）
  - 根因（源码级）：插件落进 `node_modules`；opencode 的 **Solid 转换器 filter 明确排除 `node_modules`**，而**运行时重写器只重写「源码文本可见」的 import** —— JSX 的 `@opentui/solid/jsx-runtime` 是 Bun 转译当刻注入的，prescan 看不见 → 命中插件自带的第二份 Solid
  - 上游：#48883（已关闭为重复）、#33884、#39986（均 OPEN）
  - 结论：Solid JSX 插件要配置安装须**放弃 Solid**（方案 B，已见活案例 opencode-gpt-live）或引入预编译（方案 A），代价与收益不匹配 → 本项目继续**脚本安装（发现式）**
  - 完整方法学（方案 A/B/D 对比、npm 包名 vs git 源的更新/弹窗差异）见 `docs/config-install.md` 第 5 节

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
  - 备注：本插件自身**不 spawn 任何进程**（全仓无 `child_process`/`spawn(`/`exec(` 调用，唯一命中是 `quota/key.ts` 的正则 `.exec()`）。

- [ ] **改名迁移保护：v4.6.0 后清理，不再对旧版目录负责**（2026-10-28 记录，计划从 v4.1.0 起第 5 个版本执行）
  - 背景：`opencode-tui-usage` → `opencode-hud` 后，安装 / 更新 / 卸载会顺手删旧目录 `plugins/opencode-tui-usage`，否则新旧两份插件同时注册 `sidebar.content` 与 `prompt.footer.status`，侧栏和性能块重复渲染。
  - 触发：从 v4.1.0 起第 5 个版本（**v4.6.0**）发布后可删；届时仍停在 v4.1.x 的用户不再走自动更新，改为重跑安装脚本。
  - 清理点（删完全仓应无 `opencode-tui-usage` 引用，历史文档除外）：
    - `install.ps1` / `install.sh`：旧目录与 `.tmp.opencode-tui-usage` 的清理循环
    - `uninstall.ps1` / `uninstall.sh`：旧目录、旧 stage、旧 `tui/*` 布局项
    - `update/apply.ts`：`removeLegacyPluginDir()` 及其调用
    - `shared/paths.ts`：`LEGACY_PLUGIN_DIR_NAME`、`legacyGlobalPluginDir()`
    - `tests/update-apply.test.ts`：成功用例里的旧目录清理断言
    - `AGENTS.md`：「改名迁移」与「v4.1.x 升级」两条约束
  - 顺带：`docs/superpowers/**` 与 `CHANGELOG.md` 里的旧名是历史记录，按文档规则不回填。
