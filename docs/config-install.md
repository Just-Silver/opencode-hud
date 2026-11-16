<!-- 职责：记录 opencode 配置安装（`opencode.json(c)` 的 server/GUI 插件与 `cli.json` 的 TUI 插件）的机制、包形状、双 Solid 陷阱与验证方法（供新插件复用）；不写：本仓库自己的安装/更新流程（见 README 与 AGENTS.md），也不写各供应商额度端点。 -->

# 配置安装插件（opencode 配置 `plugins`）

> 记录「通过配置文件让 opencode 自动安装插件」的方式与踩坑，供后续**新插件复用**。
>
> **状态基线（2026-11-16）**：下文结论来自本机宿主**源码 2.2.6**（`D:/Code/Projects/Agents/opencode`，行号均指该树）；本机已安装 CLI 是 **2.3.0**（打包后的单文件 `opencode.exe`，本轮**未反编译、未实机运行**）。**标「需实机验证」的项没有在 2.3.0 上跑过**，不能当成已验证结论。
>
> 本仓库 `opencode-hud` 是 Solid JSX 插件，面向用户仍只提供脚本安装（发现式，见 `README.md`）；本文件的知识留存给新插件复用，不改变该决策。
>
> 本文件写于 2026-09-24（宿主 2.0.x），2.0.x 的原始结论与双 Solid 根因保留为当时证据；2026-11-16 按 2.2.6 源码升级了配置面、缓存与验证方法等变化。一切结论以本机实测为准；发布版源码可能领先/落后于实测。

## 1. 机制

opencode 有**两个配置面**，插件放在哪一侧取决于它提供哪些入口：

| 配置面 | 谁读取 | 放什么 |
| --- | --- | --- |
| `opencode.json(c)` | server / GUI | 提供 server 或 GUI 入口的插件；纯 TUI 包放进这里会被 server 侧跳过（见 §2） |
| `cli.json` | TUI（`packages/cli/src/config/config.ts:31`、`packages/tui/src/plugin/context.tsx:306`） | 纯 TUI 包；TUI 直接读 `plugins` 并 `Host.resolve(...).tui` 加载 |

`opencode.json(c)` 写法：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["<spec>"]
}
```

`cli.json` 同样使用 `plugins` 数组，spec 形态一致（`$schema` 以 CLI 自己生成的默认值为准，不要照抄 `opencode.json` 的 schema URL）。

`<spec>`（配置里那串原文，即「目标」）可为：

- npm 包名：`name` 或 `@scope/name`；
- GitHub：`owner/repo` 或 `github:owner/repo`，可带 ref：`#v1.2.3`、`#<40 位 commit>`。

`"plugin"`（单数，V1 写法）会被自动迁移为 `"plugins"`（`packages/core/src/config/normalize.ts:185`、`packages/schema/src/config/plugin.ts:11`），两者皆可。

opencode 启动时经 arborist 把包（及其依赖）按需装到全局缓存 `global.cache/npm/<spec-key>/<generation>/`：

- 缓存根仍是 `global.cache/npm`（`packages/util/src/npm.ts:148`），但 2.2.6 起包**不再直接铺在 `npm/<key>` 下**，而是落在数字 generation 子目录（`npm.ts:308-328`），取最新数字目录为当前副本。宿主清理只保留最近两代（`npm.ts` 的 `keep = completed.slice(-2)`），更早的 generation 过期后删除。
- `<spec-key>` 含目标哈希；git 源的 key 形如 `git-<slug>-<sha256 前 12 位>`（`npm.ts:92-97`）。

`opencode plugin add <spec>` 会按入口自动路由（`packages/cli/src/commands/handlers/plugin/add.ts:25-51`）：有 server 或 GUI 入口的写进 `opencode.json(c)`；**只有 TUI 入口的写进 `cli.json`**。这是 2.2.6 源码行为，2.3.0 需实机核对。

## 2. 包必须满足的形状

- ESM：`"type": "module"`。
- `exports` 决定各入口（`packages/plugin/src/host.ts:25-65`）：

  | 入口 | 取值 |
  | --- | --- |
  | server | 优先 `exports["./server"]`，否则回退 `exports["."]`；本地目录都没有时按约定模块名 `index` 解析（源码树可为 `.ts`/`.tsx`，发布包通常是 `index.js`） |
  | tui | `exports["./tui"]`；本地目录没有时按约定模块名 `tui` 解析（可为 `tui.tsx`/`tui.js`） |
  | rpc（可选） | `exports["./rpc"]` |
  | gui（桌面，可选） | 打包产物名 `gui-experimental`（本地目录接受 `.cjs`/`.js`） |

  `index` 回退主要是**本地目录**的约定；不要写成「任何包都会自动找入口文件」。

- **纯 TUI-only 包放进 `opencode.json` 不会被加载**：只暴露 `exports["./tui"]` 时，server 侧 resolve 出 `server: undefined` → 整包被 server 跳过 → CLI 拿不到它 → `./tui` 永不加载，且**无明显报错**。
  - 正确做法：把纯 TUI 包写进 **`cli.json`**（或用 `opencode plugin add` 让它自动路由，见 §1）；2.2.6 的 TUI Provider 会直接读取并加载。
  - 如果坚持只写 `opencode.json`，即使只有 TUI 逻辑，也要给一个 no-op server 入口：

    ```json
    {
      "name": "opencode-acme-plugin",
      "type": "module",
      "exports": {
        "./server": "./src/server.ts",
        "./tui": "./src/tui.tsx"
      },
      "files": ["src"]
    }
    ```

  **server 入口不得触碰 `context.ui`**（server 侧没有 UI，触碰会崩）。

- `files` 必须覆盖 `exports` 指向的文件（防点目录/入口被剔除）。
- **`peerDependencies` 需复核**：旧版文档建议 TUI 包把 OpenTUI/Solid 声明为 peerDependencies；但 npm v7+ 会把 peer 自动装成插件自己的副本，这**可能正是第二份 Solid runtime 的来源**。在 2.3.0 实机 A/B 之前，不要照抄这条建议；先查官方发布文档并核对安装后的 `node_modules` 实际布局。

## 3. 版本、更新与卸载

- 钉版本（可复现，推荐）：`github:owner/repo#v1.2.3`；未钉则跟随默认分支。
- 更新：`opencode plugin update <目标>`；卸载：`opencode plugin remove <目标>`（命令定义见 `packages/cli/src/commands/commands.ts`、`inventory.ts:18-80`、`update.ts:10-46`）。
  **`<目标>` 是配置里那串 spec 原样**（如 `owner/repo` 或 `github:owner/repo#v1.2.3`），非包名、非路径。
- 同一 spec（含 ref）的 git 安装会命中缓存，**代码改了不会自动重拉**（`npm.ts:92-97`、`:266-268`；`add` 命中已有 active 且不 update 时直接返回）→ 需清缓存、换 ref 或显式 update。
- 缓存按 generation 累积（§1）：排查旧代码时确认当前数字目录是哪一代，不要只看到一层 `node_modules` 就断定已重装。
- ⚠️ Windows：未钉版本的 git 源在冷启动做更新检查时会 spawn `git ls-remote`。2.2.6 已在 `npm.ts:225`（arborist options）与 `:389`（pacote options）传入 `windowsHide: true`，但 arborist/pacote 是否把它完整透传到 `@npmcli/git` 的 spawn **未验证** → 仍可能弹可见控制台窗口，**需实机验证**。旧结论「必弹」不再成立；规避手段仍是钉完整 40 位 commit SHA（跳过更新检查）或改用发现式安装。

## 4. 验证（避免假阴性/假阳性）

- `opencode plugin list`（2.2.6）已合并 server inventory + 本地发现 + **配置里的 TUI 包**（`packages/cli/src/commands/handlers/plugin/list.ts:29-46`），因此现在可以列出 `cli.json` 里的 TUI 配置项；但 `GET /api/plugin` 的 server handler 仍只列 server 侧（`packages/server/src/handlers/plugin.ts`）。
  - 「CLI list 没列出」不再自动等于「配置无效」；`/api/plugin` 也**不是全量清单**。2.3.0 的实际输出**需实机验证**。
- 真实加载看 stderr：`opencode api --standalone --print-logs GET /api/plugin` 的 `msg="loading plugin"` 与 `WARN failed to load plugin ... cause`；实际 UI 是否渲染/刷新仍是最终判据（2.3.0 需复验）。
- `tui.json`：旧版（2.0.x）结论是「其 `plugin` 字段在 `2.0.15` 实测未生效」，该结论已被 2.2.6 的启动迁移取代——2.2.6 把 V1 `tui.json` 的 `plugin` / `plugin_enabled` 写进 `cli.json` 的 `plugins`（`packages/cli/src/config/migrate.ts:100-110`、`:160-165`），迁移代码只读 `tui.json`（不是 `tui.jsonc`）；TUI 配置文件只读 `cli.json`（另有发现式目录与 server inventory，见 §4）。
  - 旧 `tui.json` **只在迁移时读取**；新配置一律写 `cli.json`。
  - 迁移是否只在启动时发生、迁移后 `tui.json` 是否保留、字段形态如何，**需实机验证**。
- 同名 spec 的旧副本问题仍在（§3）；清缓存或换 ref 后再判断「代码没生效」。

## 5. TUI 插件限制（重要）

### 5.1 双 Solid 根因（2.0.x 源码级已证实；2.2.6 复核定位）

**2.0.x 的根因不是猜测**：配置安装会把插件装进 `node_modules`，而 npm v7+ 会**自动安装其 peerDependencies**（`solid-js`、`@opentui/*`）为插件**自己的副本**。在 2.0.x 上，opencode/OpenTUI 的运行时模块桥接对 `node_modules` 下的 tsx 不生效 → 插件跑在**独立的 Solid 响应式图**上，宿主 store 的更新无法通知到插件的 memo。

- **症状**（2.0.x 活案例）：插件能画出首帧，但**后续更新永远不刷新**——例如侧边栏首次打开为空，**切换一次会话/标签页才显示**（切换会重挂组件、把 memo 重算一次）。
- **源码链条**（2.0.x 挖到底，当前 2.2.6 的调用点已迁移）：
  - opencode 加载 TUI 插件时注册两个 Bun 插件，入口为 `packages/tui/src/plugin/runtime-plugin-support.bun.ts`（2.0.x 时是 `packages/opencode/src/plugin/tui/runtime.ts`）→ `ensureRuntimePluginSupport({ additional })`。
  - **Solid 转换器**：`@opentui/solid/scripts/solid-plugin.js` 的 onLoad 编译 JSX（`moduleName: "@opentui/solid"`），产物直接指向宿主运行时；filter 明确排除 `node_modules`。
  - **运行时重写器**：`@opentui/core/runtime-plugin.js` 的 prescan + onLoad 把 import 重写为虚拟模块 `opentui:runtime-module:*`，但**只认源码文本里可见的 import specifier**。
  - **关键缝隙**：JSX 的 `import ... from "@opentui/solid/jsx-runtime"` 是 **Bun 转译 JSX 当刻注入的**，源码文本里不存在 → prescan 看不到 → 不被重写 → 命中插件 `node_modules` 里那份 Solid → 第二套响应式图。
- **活案例（方案 B）**：<https://github.com/malhashemi/opencode-gpt-live>（npm 包 + `plugins` 配置加载，OpenCode ≥ 2.0.14）。它刻意不用 JSX/Solid（架构文档原文 *"For the same reason the UI does not use Solid"*），UI 全是命令式 renderable + 自建帧时钟，因此根本没有第二套 Solid 可踩。
- **上游 issue**：
  - #48883 `tui: npm package TUI plugins render once and never update (dual solid-js runtime from node_modules resolution)`（已关闭为重复）
  - #33884 `TUI plugins referenced by npm package spec silently fail to load`（OPEN）
  - #39986 `tui: support reactive external TSX plugins in packaged CLI`（OPEN）

**2.2.6 的变化（尚未实测）**：

- 新增 TUI 配置安装的一等通道（`cli.json` + `Host.resolve(...).tui`，§1/§2），纯 TUI 包不再必须伪造 server 入口；`ensureRuntimePluginSupport` 的调用点已迁到 `packages/tui/src/plugin/runtime-plugin-support.bun.ts`（§5.1），不再是 2.0.x 的旧路径。
- 本机缓存中可读的 `@opentui/solid` 0.5.9 里，`scripts/solid-plugin.js:36-38` 仍把 `node_modules` 排除在 TSX 转换之外；同时 `@opentui/core` 的 `runtime-plugin.js:392-423` 已加入对 `node_modules` ESM 的递归 prescan，**可能改变上面的结论**。宿主 2.2.6 的 catalog 声明 `@opentui/solid` **0.8.1**，本机未安装 → **不能把 0.5.9 的推断当成 0.8.1 已验证**。
- 本机安装 CLI 2.3.0 未反编译、未实机 → **双 Solid 是否仍影响响应式，需要在 2.3.0 上做 A/B**：最小 TUI-only 包同时走 `cli.json` 与「不用 Solid」两种实现，观察 `createSignal`/`createEffect` 更新是否触发重绘。

**结论**：2.2.6 起 TUI 插件已有官方配置安装通道，不能再说「必须不用 Solid」是唯一可行结论；但「配置安装的 Solid 插件响应式一定正常」也**未证明**。本仓库仍用发现式脚本安装（§6）。

### 5.2 三条候选路径

| 方案 | 做法 | 自动响应式 | 构建链 | 状态 |
| --- | --- | --- | --- | --- |
| **A 预编译** | 发布前用同一套 `babel-preset-solid`（`moduleName: "@opentui/solid"`）把 TSX 编译成 JS，让 jsx-runtime 的 import 以**文本形式**落进产物 → 被 prescan 重写 | ✅ 理论 | 需要 | 未实测；2.2.6 的 node_modules 递归重写可能改变结论，0.8.1 未在本机 |
| **B 不用 Solid** | 命令式 `@opentui/core` renderable；入口文件 `import * as core from "@opentui/core"` 后**传参注入**（其余文件只 `import type`）；刷新自己订阅驱动 | ❌（订阅驱动） | 无 | **2.0.x 活案例已验证**（opencode-gpt-live）；2.3.0 未复验 |
| **D 只用 solid-js 内核** | 保留 `createSignal`/`createEffect` 的自动追踪，渲染仍走命令式 renderable（不用 JSX） | ✅ 理论 | 无 | 未实测 |

- **分发渠道提醒**：配置安装想要「自动更新且不弹窗」，以 **npm 包名**最稳——2.2.6 的替代链是 `Npm.isInstallablePackage → Npm.add → Host.resolve`（CLI），包名走 registry HTTP，不 spawn git；git 源未钉版本仍可能触发 §3 的 Windows 弹窗，钉 SHA 则不自动更新。旧文档写的 `resolvePluginTarget` **已不存在**，TUI 侧的对应链是 `PackageSource.prepare → Host.resolve`。

## 6. 本仓库现状

- `opencode-hud` 是 TUI 插件，已**回退到脚本安装（发现式）**：根 `package.json`、no-op `server.ts` 及相关守护测试（`tests/package.test.ts`）已一并移除；面向用户的 `README.md` **只提供脚本安装**。
- **决策（2026-09-24）：本项目不再评估配置安装改造。** 作为 Solid JSX 插件，要配置安装就得放弃 Solid（方案 B）或引入预编译构建（方案 A），代价与收益不匹配。本文件的知识**留存给未来新项目**——若新项目一开始就按方案 B 写 TUI，天然可配置安装。
- 若将来上游修复（#33884/#39986）或方案 D/A 被 2.3.0 实测验证，再按 [第 2 节](#2-包必须满足的形状) 恢复评估（该节的 `package.json` 示例即所需形态）。
