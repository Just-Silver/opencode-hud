# 配置安装插件（opencode `plugins`）

> 记录「通过 `opencode.json(c)` 的 `plugins` 让 opencode 自动安装插件」的方式与踩坑，供后续**新插件复用**。
>
> **适用范围：非 TUI 插件（server 侧）**。
> TUI 插件（渲染侧边栏等 Solid UI）要配置安装，**须不使用 Solid**——已验证方案见 [第 5 节](#5-tui-插件限制重要)（方案 B，另有待验的 A/D）。本仓库的 `opencode-hud` 是 Solid 插件且不再改造，因此面向用户只提供脚本安装（发现式）。
>
> 一切结论以本机实测为准；opencode 发布版源码可能领先/落后于实测。

## 1. 机制

在 `opencode.json(c)` 写：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["<spec>"]
}
```

`<spec>`（配置里那串原文，即「目标」）可为：

- npm 包名：`name` 或 `@scope/name`；
- GitHub：`owner/repo` 或 `github:owner/repo`，可带 ref：`#v1.2.3`、`#<40 位 commit>`。

opencode 启动时经 arborist 把包（及其依赖）按需装到全局缓存 `~/.cache/opencode/npm/...`，再加载入口。

`"plugin"`（单数，V1 写法）会被自动迁移为 `"plugins"`，两者皆可。

## 2. 包必须满足的形状

- ESM：`"type": "module"`。
- `exports` 决定各入口（依据 `@opencode/plugin` 的 `Host.resolve` 规则，2.0.x 实测）：

  | 入口 | 取值 |
  | --- | --- |
  | server | 优先 `exports["./server"]`，否则回退 `exports["."]`；都没有则按约定 `index.js` |
  | tui | `exports["./tui"]`；都没有则按约定 `tui.js` |
  | rpc（可选） | `exports["./rpc"]` |

- **纯 TUI-only 包不会被加载**：只暴露 `exports["./tui"]` 时，server 侧 resolve 出 `server: undefined` → **整包被 server 跳过** → CLI 拿不到它 → `./tui` 永不加载，且**无明显报错**（`plugin list` / `/api/plugin` 也看不到）。因此即使只有 TUI 逻辑，也要给一个 no-op server 入口：

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
- TUI 插件还需声明 OpenTUI/Solid 为 peerDependencies（见官方 publish 文档）。

## 3. 版本、更新与卸载

- 钉版本（可复现，推荐）：`github:owner/repo#v1.2.3`；未钉则跟随默认分支。
- 更新：`opencode plugin update <目标>`；卸载：`opencode plugin remove <目标>`。
  **`<目标>` 是配置里那串 spec 原样**（如 `owner/repo` 或 `github:owner/repo#v1.2.3`），非包名、非路径（依 `plugin update --help` 的 "configured package target"）。
- ⚠️ Windows：未钉版本的 git 源在冷启动做更新检查时会 spawn `git ls-remote` 且未加 `CREATE_NO_WINDOW` → **弹可见控制台窗口**（上游问题，非插件自身）。规避：钉完整 40 位 commit SHA（会跳过更新检查），或改用发现式安装。

## 4. 验证（避免假阴性/假阳性）

- `opencode plugin list` / `GET /api/plugin` **不枚举「配置里的插件」**：用合法本地控制组验证过，配置项正确也不出现在列表里 →「没列出」是**无效信号**，不能据此判定加载失败。
- 真实加载看 stderr：`opencode api --standalone --print-logs GET /api/plugin` 的 `msg="loading plugin"` 与 `WARN failed to load plugin ... cause`。
- 同名 spec（含 ref）的 git 安装会命中 `~/.cache/opencode/npm/git-*` **旧副本**，代码改了也不重拉 → 需清缓存或换 ref。
- `tui.json(c)` 的 `plugin` 字段在 `2.0.15` 上**未生效**（疑似更高版本才支持）；CLI 侧插件来源实际仍以发现式为准。

## 5. TUI 插件限制（重要）

- **根因**：配置安装会把插件装进 `node_modules`，而 npm v7+ 会**自动安装其 peerDependencies**（`solid-js`、`@opentui/*`）为插件**自己的副本**。opencode/OpenTUI 的运行时模块桥接对 `node_modules` 下的 tsx 不生效 → 插件跑在**独立的 Solid 响应式图**上，宿主 store 的更新无法通知到插件的 memo。
- **症状**：插件能画出首帧，但**后续更新永远不刷新**——例如侧边栏首次打开为空，**切换一次会话/标签页才显示**（切换会重挂组件、把 memo 重算一次）。
- **上游 issue**：
  - #48883 `tui: npm package TUI plugins render once and never update (dual solid-js runtime from node_modules resolution)`（已关闭为重复）
  - #33884 `TUI plugins referenced by npm package spec silently fail to load`（OPEN）
  - #39986 `tui: support reactive external TSX plugins in packaged CLI`（OPEN）
- **规避**：TUI 插件改用**发现式**安装——把插件目录放到 `~/.config/opencode/plugins/<name>/`（`node_modules` 之外），桥接生效、响应式正常。本仓库的脚本安装即此方式。
- server 侧（非 TUI）插件不碰 OpenTUI/Solid 渲染器，配置安装完全正常。

### 5.1 源码级精确根因（2026-09-24 挖到底）

opencode 加载 TUI 插件时注册两个 Bun 插件（`packages/opencode/src/plugin/tui/runtime.ts` → `ensureRuntimePluginSupport({ additional })`）：

| 链路 | 实现 | 对 `node_modules` |
| --- | --- | --- |
| **Solid 转换器** | `@opentui/solid/scripts/solid-plugin.js`：onLoad 编译 JSX（`moduleName: "@opentui/solid"`），产物直接指向宿主运行时 | **不生效**——filter 明确排除：`^(?!.*[/\\]node_modules[/\\]).*\.(m|c)?[jt]sx?$` |
| **运行时重写器** | `@opentui/core/runtime-plugin.js`：prescan + onLoad，把 import 重写为虚拟模块 `opentui:runtime-module:*` | 生效，但**只认源码文本里可见的 import specifier** |

**关键缝隙**：JSX 的 `import ... from "@opentui/solid/jsx-runtime"` 是 **Bun 转译 JSX 当刻注入的**，源码文本里根本不存在 → 运行时重写器的 prescan 看不到 → 不被重写 → 命中插件 `node_modules` 里那份 Solid → 第二套响应式图。

**推论**：出问题的只是 **JSX 那层**；`solid-js` 本身是源码显式 import（文本可见），prescan 是**能**重写的（这正是下面方案 D 的理论依据）。

### 5.2 TUI 插件也能配置安装的三条路

| 方案 | 做法 | 自动响应式 | 构建链 | 状态 |
| --- | --- | --- | --- | --- |
| **A 预编译** | 发布前用同一套 `babel-preset-solid`（`moduleName: "@opentui/solid"`）把 TSX 编译成 JS，让 jsx-runtime 的 import 以**文本形式**落进产物 → 被 prescan 重写 | ✅ | 需要 | 未实测 |
| **B 不用 Solid** | 命令式 `@opentui/core` renderable；入口文件 `import * as core from "@opentui/core"` 后**传参注入**（其余文件只 `import type`）；刷新自己订阅驱动 | ❌（订阅驱动） | 无 | **已验证**（见下） |
| **D 只用 solid-js 内核** | 保留 `createSignal`/`createEffect` 的自动追踪，渲染仍走命令式 renderable（不用 JSX） | ✅ | 无 | 未实测 |

**结论：TUI 插件要支持配置安装，当前唯一已见成效的做法是「不使用 Solid」（方案 B）。** 想保留响应式又要零构建，只能押注方案 D。

- **方案 B 活案例**：<https://github.com/malhashemi/opencode-gpt-live>（npm 包 + `plugins` 配置加载，OpenCode ≥ 2.0.14）。它刻意不用 JSX/Solid（架构文档原文 *"For the same reason the UI does not use Solid"*），UI 全是命令式 renderable + 自建帧时钟，因此根本没有第二套 Solid 可踩。
- **分发渠道提醒**：配置安装想要「自动更新且不弹窗」，以 **npm 包名**最稳——`resolvePluginTarget` 对包名走 `Npm.add(name@latest)`（registry HTTP，不 spawn git），可规避 [第 3 节](#3-版本更新与卸载) 的 Windows 弹窗（#50868）；git 源未钉版本必弹，钉 SHA 则不自动更新。

## 6. 本仓库现状

- `opencode-hud` 是 TUI 插件，已**回退到脚本安装（发现式）**：根 `package.json`、no-op `server.ts` 及相关守护测试（`tests/package.test.ts`）已一并移除；面向用户的 README **只提供脚本安装**。
- **决策（2026-09-24）：本项目不再评估配置安装改造。** 作为 Solid JSX 插件，要配置安装就得放弃 Solid（方案 B）或引入预编译构建（方案 A），代价与收益不匹配。本文件的知识**留存给未来新项目**——若新项目一开始就按方案 B 写 TUI，天然可配置安装。
- 若将来上游修复（#33884/#39986）或方案 D/A 被实测验证，再按 [第 2 节](#2-包必须满足的形状) 恢复评估（本节 `package.json` 示例即所需形态）。
