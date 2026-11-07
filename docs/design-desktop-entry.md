<!-- 职责：opencode-hud 的双入口形态（TUI + 桌面 GUI）——入口解析、无构建约束、桌面侧能做什么/不能做什么，以及 Markdown 配色与后续 HUD 面板的实现路线；不写：GUI 插件通用开发手册（见 reference-desktop-gui-plugins.md）、额度与性能口径（见各自设计文档）。 -->

# 双入口设计：TUI + 桌面版

> 依据：本地源码 `E:\Code\Projects\Agent\Externals\opencode`（2.2.6），以及本仓库 `docs/reference-desktop-gui-plugins.md` 中 2.2.0 的实机结论。GUI 插件 API 仍是实验性（`gui-experimental`），升级 OpenCode 后要重新冒烟。

## 1. 现状与硬约束

- **目录型插件可以被两条链路分别加载**：TUI 进程扫描 `tui.tsx`；桌面走 server 的插件列表，读取同目录的 `gui-experimental.cjs` / `.js`。
- **GUI 入口只接受 `.cjs` / `.js`**，TS 源文件和 ESM 都不算入口。本仓库没有构建步骤，所以桌面入口是**手写 CommonJS**，不引入 Vite。
- **不要给插件目录加带 `name` + `exports` 的 `package.json`**：入口解析会切换到包名模式，绕过 `tui.tsx` / `gui-experimental.cjs` 的约定文件名。
- **只有 `tui.tsx` 的目录不会进 server 的插件列表**（`config/plugin/source.ts`：`entrypoints.server ?? entrypoints.gui`），桌面因此看不到它。补一个 GUI 入口就够了，不需要 server 入口。
- **桌面只列服务器默认 location 的插件，不跟会话/项目走**：`plugin.list` 在没有 `location` 查询或 `x-opencode-directory` 头时解析服务器的默认 location，桌面主进程的 client 只带 authorization（`packages/desktop/src/main/plugin/host.ts` 的 `clientFor`）。实测 `opencode2 api GET /api/plugin` 返回 `location.directory = C:\Users\13178`，其中没有项目级插件。所以**桌面 GUI 插件必须装在全局**（`~/.config/opencode/plugins/` 或全局 `opencode.json(c)`），项目级 `.opencode/plugins` 只有 TUI 能加载。
- **热更存在，但只针对已列出的插件**：server 会 watch 本地插件的 `gui-experimental.cjs`，把内容哈希进 GUI revision（`packages/core/src/plugin/module.ts`）；revision 变化触发 `plugin.updated`，桌面重列并让窗口重载（`packages/desktop/src/main/plugin/host.ts` 的 `watchPlugins`）。新增插件/入口文件则要等配置变化触发重扫（`ConfigPluginSource.changes()`）。
- 目录里没有 server 入口时，GUI 插件的 id 取**目录名**（这里是 `opencode-hud`），与 TUI 的 `Plugin.define id` 一致。
- **窗口进程里 `node:*` / `electron` 是 inert placeholder**：`fs`、`sqlite`、`child_process` 读到的是 Proxy。现有 `quota/key.ts`、`update/apply.ts` 一行都不能在窗口里跑。
- 安装与更新都是**整目录复制**（`install.*` 的 `Copy-Item -Recurse` / `tar` 解压后 `cp`），新增的 `.cjs` 会自动分发；`update/apply.ts` 目前只校验 `tui.tsx`，不需要改。

## 2. 入口形态

```text
.opencode/plugins/opencode-hud/
├── tui.tsx                 # TUI 入口（既有）
├── gui-experimental.cjs    # 桌面 GUI 入口（本次新增，无构建）
├── index.ts                # 后续：server 入口（额度查询、更新）
├── rpc.ts                  # 后续：TUI 与桌面共用的契约
├── model/ quota/ shared/ view/ update/
└── footer.tsx
```

TUI 侧不受影响：发现器只找 `tui.tsx`，新增的 `.cjs` 不会被执行。

## 3. 第一阶段：桌面 Markdown 配色（已实现）

### 3.1 问题

桌面/web 的会话 Markdown 把标题、加粗绑在正文 token 上（`packages/session-ui/src/components/markdown.css`）：

```css
h1, h2, h3 { color: var(--v2-text-text-base); }
strong, b  { color: var(--v2-text-text-base); }
```

暗色主题里 `--v2-text-text-base` 是近白，所以标题和加粗只有字号/字重差别，观感是「一片白字」；TUI 则按 `markdown` 角色单独上色（`packages/theme/src/tui/schema.ts`）。

主题侧其实**已经生成**了对应 token（`packages/ui/src/theme/resolve.ts` 用主题的 primary/accent 派生，默认值在 `packages/ui/src/styles/theme.css`）：

`--markdown-heading` / `--markdown-strong` / `--markdown-emph` / `--markdown-code` / `--markdown-block-quote` / `--markdown-list-item` / `--markdown-list-enumeration` / `--markdown-horizontal-rule`

只是 `markdown.css` 没有消费它们。上游 issue：`anomalyco/opencode#61221`（open，已被记为 feature request）。

### 3.2 实现

`gui-experimental.cjs` 通过 `Style` 注册表注入 CSS（`packages/app/src/runtime/plugin/render.tsx` 的 `PluginStyles` 会 `<style data-plugin>` 注入 `document.head`，全局生效）：

```js
const { Plugin, Style } = require("@opencode/plugin/gui")
module.exports = Plugin.define({ setup: (ctx) => ctx.add(Style, css) })
```

要点：

- 选择器重复一次 `[data-component="markdown"]`：宿主规则是嵌套写法（编译后 `[data-component="markdown"] h1`，特异性 0,1,1），重复后是 0,2,1。
- 行内代码加 `:not([data-inline-code-kind])`：保留宿主给 `path` / `url` 两种行内代码的专属颜色（它们的规则带属性选择器和 `a.external-link`，不该被通用规则盖掉）。
- **钉 TUI 配色**：桌面主题的 `--markdown-*` 多为 `resolve.ts` 派生的高亮度值（`oc-2` 的 heading/strong 亮度约 0.90），直接用会偏白刺眼。插件改为直接钉 TUI 默认主题（`opencode`, v2）的 markdown 色值，按 `data-color-scheme` 给亮/暗两套，写在 `--hud-md-*` 上，规则只引用这些变量。代价是这些角色不再跟随桌面主题（正文仍跟随）；要换回跟随主题，删掉变量块、改回 `var(--markdown-*)` 即可。链接暂不覆盖，保持 app 自己的 accent 色。
- 只改 `[data-component="markdown"]` 内部；插件自己用 `ctx.ui.Markdown` 渲染的内容也会同样生效。
- 正文基色（`--v2-text-text-base`）不在此范围：它由 `theme/v2/foreground.ts` 和白色混合而来，属于另一个问题（`anomalyco/opencode#53567`）。

### 3.3 为什么没有单元测试

契约是浏览器 CSS 与主题变量的组合，本仓库的 `node --test` 跑不到渲染；对 CSS 字符串做断言属于「源码文本测试」，AGENTS.md 明确不采用。验证方式是桌面冒烟（见 §5）。

## 4. 第二阶段：桌面 HUD 面板与数据通道

目标：桌面版也能看到额度 / 会话 / 子代理区块。桌面没有 42 列侧边栏，第三方面板只有 `Panel`（`region: "side"`，会话侧栏页签）；`window.bottom` 横跨全窗口且不属于会话，`session.header` 是唯一的时间线表面。

数据分三类：

| 数据 | 现在（TUI） | 桌面 |
| --- | --- | --- |
| 会话累计 token / 上下文 | `SessionInfo.tokens` | 同一份 `ctx.client`，可直接读 |
| 子代理 | `session.family()` + 展开时 `message.sync()` | 同一份 client，可直接读 |
| 额度（opencode-go） | 直接 fetch `/zen/go/v1/usage` | `ctx.client.usage.limits()` 自带三窗口，不需要 key |
| 额度（command-code） | `quota/key.ts` 读 DB + fetch | 窗口不能读 fs/sqlite；fetch 还会撞 CORS |
| 更新检查 / 一键更新 | `fs` + `child_process` + `tar` | 窗口不能跑，必须留 TUI（或 server） |

**推荐结构（与参考手册 §15.3 一致）**：

1. `rpc.ts` 用 `Rpc.define` 写纯 JSON 契约（不 import 任何包），TUI 与窗口都能 import。
2. `index.ts` 作为 server 入口：`Plugin.define({ id: "opencode-hud", setup(ctx) { ctx.rpc.register(...) } })`，额度查询、凭据读取（`bun:sqlite` / `node:fs` / `fetch` 在 server 里都可用）留在这里。
3. TUI 与桌面窗口都只做渲染：`ctx.client.rpc(contract)`，不再各自维护一份取数逻辑。
4. 桌面面板用 `ctx.ui.*` 渲染，宽度用 `Panel.width`，不要照搬 42 列；首帧不要悬挂（重 UI 用 `lazy()` + 局部 `<Suspense>`）。

不建议走 GUI 的 `main` + `Ipc`：那套只服务桌面窗口，TUI 拿不到，会变成两份后端。

## 5. 验证

```powershell
node --check .opencode/plugins/opencode-hud/gui-experimental.cjs
node --test tests/*.test.ts
```

桌面冒烟（不动真实配置时用临时 `XDG_CONFIG_HOME` 隔离）：

```powershell
opencode2 api --standalone --print-logs GET /api/plugin
```

过滤 `loading plugin` / `WARN failed to load plugin`。插件默认装在 `$XDG_CONFIG_HOME/opencode/plugins/opencode-hud`（Windows 为 `$HOME/.config/...`）；桌面只加载**它自己 server** 上的插件，所以确认当前 server 就是装插件的那一个。

验收：桌面会话里标题、加粗、强调、行内代码、引用、列表标记与 TUI 默认主题（`opencode`, v2）一致；切换桌面主题时这些角色颜色不变、正文仍跟随主题；TUI 侧栏与性能块不受影响。

## 6. 风险与未决

- **加载来源**：自动发现的全局目录在源码上会登记 `features.gui`，但官方文档要求把 GUI 插件写进全局 `opencode.json(c)`。发行前用真实安装包两种方式各测一次。
- **id 归属**：现在没有 server 入口，id 取目录名；一旦加 `index.ts`，id 改由 server 的 `Plugin.define` 决定，必须保持 `opencode-hud`，否则命令/面板/存储键会漂移。
- **样式全局性**：`Style` 注入到整个文档，选择器必须始终带 `[data-component="markdown"]` 前缀，避免影响其他界面。
- **实验性 API**：`gui-experimental` 与注册表随 OpenCode 版本变化；升级后重跑构建（TUI 的 esbuild 检查）与桌面冒烟。
- **上游修复**：若 `anomalyco/opencode#61221` 落地（把 `markdown.css` 接回 `--markdown-*`），需要重新评估本插件的钉值——它仍会用固定色覆盖上游，届时应删除或改成跟随主题。
