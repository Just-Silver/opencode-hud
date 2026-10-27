<!-- 职责：OpenCode Desktop（2.2.x）GUI 插件 `./gui-experimental` 的开发手册——包结构、构建与加载、窗口/主进程上下文、注册表、Ipc、存储、生命周期与排障；不写：TUI 插件（tui.tsx）、server 插件、本仓库插件自身的实现（见 README 与设计文档）。 -->

# OpenCode Desktop GUI 插件开发手册（2.2.x）

> 依据：本地源码 `E:\Code\Projects\Agent\Externals\opencode`（`packages/plugin` 与 `packages/desktop` 版本 2.2.0，commit `432d870b02`），与官方 V2 文档 <https://opencode.ai/v2/docs/build/plugins/gui> 对照后整理。凡文档未写、只在源码里成立的行为，标 **[源码]**。
>
> 状态：GUI 插件 API **实验性**，导出名带 `-experimental` 就是提醒；升级 OpenCode 后先跑一遍构建与冒烟再发版。

---

## 1. 心智模型

一个插件包可以有四种部件，同一个 `package.json` 里并存：

| 部件 | 导出 | 运行位置 | SDK |
| --- | --- | --- | --- |
| Server | `.` / `./server` | OpenCode 后台服务 | `@opencode/plugin` |
| TUI | `./tui` | 终端 UI | `@opencode/plugin/tui` |
| **GUI** | **`./gui-experimental`** | 桌面 app 的**每个窗口**（`setup`）+ **Electron 主进程**（`main`） | **`@opencode/plugin/gui`** |
| RPC | `./rpc` | 编译期契约，server 实现、其它部件调用 | `@opencode/plugin/rpc` |

关键点：

- **一个 bundle 两个进程**：桌面窗口与主进程各自求值同一个 `./gui-experimental` 文件，各读它的 default export；窗口跑 `setup`，主进程跑 `main`。
- 求值时给对面进程的模块塞 **inert placeholder**（`electron`、`node:*` 在窗口里；`solid-js`、`@opencode/plugin/gui/{file,review,browser}` 在主进程里）。placeholder 接受任意属性读/调用/构造并返回自身，`then` 恒为 `undefined`（永不像 Promise）。所以模块顶层可以安全 `import`，但**不能在错误进程里真的执行**。
- GUI 由**桌面 app 自己的 server** 提供：主进程列出该 server 上声明了 `./gui-experimental` 的插件、逐个读取 bundle、再广播给所有窗口。其它 server 上的插件没有 GUI。
- 插件 id **不写在 GUI 里**，由宿主赋值：有 server 部件取 server 的 `Plugin.define({ id })`；纯 GUI 包取包名（本地目录无 `name` 则取目录名）。
- 控件没有"死按钮"：所有跨插件依赖都要按 `Live` 状态分支（见 §7）。

---

## 2. 最小可运行插件（纯 GUI）

### 2.1 目录

```text
acme/
├── package.json
├── vite.config.ts
├── src/
│   └── gui.tsx          # 唯一入口：default export = Plugin.define(...)
└── dist/
    └── gui-experimental.cjs   # vite build 产物
```

### 2.2 `package.json`

```json
{
  "name": "opencode-acme",
  "version": "0.1.0",
  "type": "module",
  "exports": { "./gui-experimental": "./dist/gui-experimental.cjs" },
  "files": ["dist"],
  "dependencies": { "@opencode/plugin": "latest" },
  "devDependencies": {
    "solid-js": "^1.9.0",
    "vite": "^7.0.0",
    "vite-plugin-solid": "^2.11.0"
  }
}
```

`@opencode/plugin/gui` 由 app 在运行时提供，bundle 里只需要它的**类型**，所以放 `dependencies`（跟文档一致）即可，不必打进产物。

### 2.3 `vite.config.ts`

```ts
import { defineConfig } from "vite"
import { gui } from "@opencode/plugin/gui/vite"

export default defineConfig({ plugins: [gui()] })
```

预设做的事 **[源码 `packages/plugin/src/gui/vite.ts`]**：

- `vite-plugin-solid` 编译 JSX；
- 输出**单个 CommonJS**（`build.lib.formats: ["cjs"]`、`inlineDynamicImports: true`、`emptyOutDir: false`）；
- 把共享模块、`electron`、Node 内置标记为 external；任何一个 `effect/*`、`solid-js/*`、`@opencode/*`（白名单外）直接**构建失败**；
- 默认入口 `src/gui.tsx`，默认产物 `dist/gui-experimental.cjs`；用 `gui({ entry, outFile })` 改。

### 2.4 `src/gui.tsx`

```tsx
import { Command, Panel, Plugin, type MountedSession, type PanelTab } from "@opencode/plugin/gui"

export default Plugin.define({
  // os 省略 = 所有系统；写了就只在这些系统加载
  i18n: { en: { open: "Open Notes", panel: "Notes" } },
  setup(ctx) {
    // tab 在 setup 内创建：模块级拿不到 ctx.t，硬编码文本也不跟随语言
    const tab: PanelTab = {
      id: "notes",
      get title() {
        return ctx.t("panel")
      },
      closable: "compact",
      fallback: true,
    }

    ctx.add(Command, () => ({
      id: "open",
      title: ctx.t("open"),
      group: "Acme",
      bind: "mod+shift+n",
      run: () => {
        const session = ctx.sessions.current()
        if (session) ctx.layout.open(`${ctx.id}:notes`, session, { background: true })
      },
    }))

    ctx.add(Panel, {
      id: "notes",
      region: "side",
      list: (input) => (input.open.includes("notes") ? [tab] : []),
      render: (props) => <Notes session={props.session} />,
    })
  },
})

function Notes(props: { session: MountedSession }) {
  // props.session 是活的 getter：别解构、别存进变量，切换会话时它原地更新
  return <div>{props.session.directory}</div>
}
```

### 2.5 加载与迭代

```jsonc
// ~/.config/opencode/opencode.jsonc（全局配置；桌面版只读这里，不读项目级、也不读 cli.json）
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-acme"]
  // 本地开发也可以写目录路径："plugins": ["./plugins/acme"]
}
```

- **桌面版只读全局 `opencode.json(c)` 的 `plugins`**；TUI 走 `cli.json`。一个包同时有 `./tui`，用户又只在 `cli.json` 里列了它，那么加了 GUI 之后必须**同时**列进 `opencode.json(c)`。
- 本地目录 + `vite build --watch`：每次重建后 GUI 在所有窗口和主进程重载；**server 部件不重启**（revision 只哈希 GUI bundle）。
- 安装包只在版本变化时更新 GUI；`opencode plugin update` 完成后生效。
- 开关在 **Settings → Extensions → Plugins**，只关桌面 UI；要整体禁用，在 `plugins` 里加 `"-acme"` 或用 `opencode plugin remove`。

---

## 3. 打包、入口解析与身份

### 3.1 入口必须是一个预构建 CJS 文件

- 有 `package.json` 的 `name` + `exports`：走 `exports["./gui-experimental"]`；
- 没有：走目录根的 `gui-experimental.cjs` 或 `.js`；
- 其它扩展名一律忽略；ESM、多 chunk、动态 import 分包都不行（app 不加载第二个 chunk）。

### 3.2 id 与保留命名空间 **[源码 `pluginIdAvailable`]**

宿主拒绝一切与内置插件冲突的 id：相同 id、以 `<内置 id>.` 开头、内置 id 以 `<你的 id>.` 开头，或落在 `opencode` 命名空间里（`opencode` 本身、`opencode.*`）。被拒时 GUI 不加载，Settings 里显示为未加载。

被拒绝的插件**不是错误**，是保留位；不要试图绕过，换 id。

`ctx.id` 会前缀化你创建的一切：

| 对象 | 形态 | 例 |
| --- | --- | --- |
| 命令 | `<id>.<command>` | `acme.open` |
| 面板键 | `<id>:<tab>` | `acme:notes` |
| 存储键（窗口） | `plugin.<id>.<store>` | `plugin.acme.prefs` |
| 契约 / Ipc id | `<id>` 或 `<id>.<name>` | `acme.counter` |

`ctx.provide` / `ctx.main` 对不属于自己 id 的 token **直接抛错**。

### 3.3 声明字段

```ts
Plugin.define({
  os?: ("macos" | "windows" | "linux")[],   // 省略 = 全部；第三方 GUI 只由桌面 app 加载
  stores?: Record<string, StoreDeclaration>, // 窗口状态，宿主在你读之前加载
  i18n?: { en: Messages; [locale: string]: Messages },
  setup?(ctx): Cleanup | void,               // 同步！每个窗口一次
  main?(ctx): Cleanup | void | Promise<...>, // 可异步，主进程一次
})
```

- 至少要有 `setup` 或 `main` 之一，否则 bundle 校验失败。
- bundle 的 `i18n` 必须是**内联** catalog；带 loader（只有内置插件能用 `builtinCatalog`）会被 schema 拒绝。
- `Plugin.define` 只做类型收窄，原样返回对象。

### 3.4 构建期硬约束

| 限制 | 原因 |
| --- | --- |
| 单 CJS、无分包 | app 只 `new Function` 求值一个模块 |
| 依赖里不能有 `@opencode/*`（白名单外）、`effect/*`、`solid-js/*` 子路径 | app 只提供自己那份实例，多一份会导致 Solid 双实例、响应式失效 |
| 不能 import `@opencode/app` / `@opencode/desktop` / `@/` | 不在提供列表里 |
| 不用 `@opencode/ui` | 图标用 `IconName` 字符串 + `ctx.ui.Icon`，组件用 `ctx.ui.*` |

共享模块白名单 **[源码 `modules.ts`]**：

- 两进程共享：`effect`、`@opencode/plugin/gui`、`@opencode/plugin/gui/main`、`@opencode/plugin/rpc`、`@opencode/schema/rpc`、`@opencode/client`、`@opencode/client/effect`
- 仅窗口：`solid-js`、`solid-js/web`、`solid-js/store`、`@opencode/client/solid`、`@opencode/plugin/gui/{file,review,browser}`
- 仅主进程：`electron`、Node 内置（含 `node:` 前缀）

> `@opencode/plugin/gui/host`、`/builtin`、`/updater` 是宿主/内置专用，**第三方 bundle 用不了**（`/builtin` 里的 `onIdle`、懒加载 catalog 等只给内置插件）。

### 3.5 插件来源与自动发现（GUI 视角）

桌面 GUI 只认 **app 自己 server 的插件列表**，所以插件先进 server 的登记，才谈得上 GUI：

| 来源 | 形式 | 进 server 列表的条件 |
| --- | --- | --- |
| 全局 `opencode.json(c)` 的 `plugins` | 包名 / `pkg@1.2.0` / scoped / `github:` 等 git 说明 / 本地目录 / 绝对路径 / `file://` / `{ package, options }` | 目标存在；**本地路径必须是目录**（单文件会被跳过） |
| `opencode plugin add` | npm 包或 git 说明，装进全局 | 装好后由配置引用 |
| 自动发现 | 全局 `~/.config/opencode/plugins/`、项目 `.opencode/plugins/`（`plugin/` 也认）的**直接子项**：`.ts`/`.js` 文件或目录 | 目录必须解析出 **server 或 GUI 入口** |
| 内置 | app 自带 | `source.type === "builtin"`，GUI 不会加载 |

**[源码 `config/plugin/source.ts`]** 自动发现有一条关键过滤：

```ts
// A directory without a server part still lists for its GUI part. A TUI-only directory stays the TUI's own.
const entrypoint = entrypoints.server ?? entrypoints.gui
if (!entrypoint) return []
```

即：**只有 `tui.tsx` 的目录不会被 server 登记**（TUI 插件由 TUI 进程自己扫描），因此它既不会出现在桌面「Settings → Extensions → Plugins」，也不会有 GUI。想让同一个目录同时服务 TUI 和桌面，必须给它补一个 GUI 入口（`gui-experimental.cjs`）或 server 入口。

另外 **[源码 `core/plugin/module.ts`]**：`features.gui` 只在解析出 `entrypoints.gui` 时成立；GUI 入口只接受 `.cjs` / `.js` 文件，TS 源文件和 ESM 都不算入口。

> 官方文档口径是"把 GUI 插件配到全局 `opencode.json(c)`，桌面才在每个窗口都有"。自动发现的全局目录在源码上同样会登记 `features.gui`，但那是实现细节、不是承诺；要稳定，按文档写进全局配置。

### 3.6 与 TUI 插件共存的安装形态

同一个插件目录可以同时被两条链路加载：

- TUI：`~/.config/opencode/plugins/<dir>/tui.tsx`（TUI 进程扫描，只认 `plugins/` 直接子项）；
- 桌面 GUI：同一目录里的 `gui-experimental.cjs`（或包 `exports["./gui-experimental"]`），由 server 登记、桌面读取。

两者互不依赖，但**注意不要重复登记**：目录已被自动发现时，再在 `opencode.json(c)` 里显式列同一路径，会产生两次 add 操作；要么只靠自动发现，要么显式配置并移出自动发现目录，选一种并实测。

---

## 4. 窗口上下文（`setup`）

```ts
interface Context {
  id: string
  options: PluginOptions          // opencode.json 里该插件的 options（必须是 JSON）
  client: OpenCodeClient          // 桌面 app 自己那个 server 的客户端；server 重启后换实例，用时再读
  app: App                        // { name, version, channel, platform, packaged }
  signal: AbortSignal
  add / list / provide / use / main
  layout / sessions / screen / storage / system / desktop / dialogs / toast / tabs
  attention / commands / links / embeds / ui / locale / appearance / router / keybinds
  servers / workspaces
  // SetupContext 额外：stores（按声明类型化）
}
```

### 4.1 宿主 API 速查

| 属性 | 用途 | 关键点 |
| --- | --- | --- |
| `ctx.layout` | 侧栏页签、滚动位置、Settings、新建 draft | `open/close/toggle/hide/state/stored/ready/narrow`，`side.menu()`，`settings(page?)`，`draft()` |
| `ctx.sessions` | 打开页签里的会话、当前 `MountedSession` | `current()` 在 Home、draft、首帧渲染、界面挂载前都是 `undefined` |
| `ctx.screen` | 当前会话的 screen：`file` / `comment` / `composer` | 跟路由走，命令/处理器里现读，别在 setup 里存 |
| `ctx.storage` | 运行时键的 store、窗口内存 | `store(key, { schema, initial, scope, from })`、`memory`、`remove` |
| `ctx.system` | 剪贴板、保存文件、外部浏览器 | 全平台可用 |
| `ctx.desktop` | 仅桌面：`reveal/launch/installed/zoom/pick` | web 上 `undefined` |
| `ctx.dialogs` | `open/confirm/alert/prompt/select` | 随 owner 关闭；`replace: true` 会先关别人的对话框 |
| `ctx.toast` | 轻提示 | 插件停用时整批关闭；`persistent` 需自己 `dismiss()` |
| `ctx.tabs` | 外壳页签 | `list/open/focus/move/close` |
| `ctx.attention` | 系统通知 + 声音 | 跟随用户设置；传 `id` 让多窗口只通知一次；永不 reject |
| `ctx.commands` | 按 id 运行命令 | 返回 `false` = 不存在或已禁用；app 自身命令 id 不稳定 |
| `ctx.links` | 打开/探测本地链接 | 交给优先级最高的 `LinkHandler` |
| `ctx.embeds` | 显示主进程创建的 `WebContentsView` | 配 `Embed.View` |
| `ctx.ui` | app 组件：`Icon/Button/IconButton/Tooltip/Menu/Loader/Dialog/Switch/TextInput/Keybind/Markdown/Code` | 与 app 同主题、同语言 |
| `ctx.locale` / `ctx.appearance` | 语言、方向 / mono 字体、明暗 | `appearance.mode()` 响应式 |
| `ctx.router` | 路由 path、是否切换中 | |
| `ctx.keybinds` | 命令键位显示与匹配 | `keybind(id)` → `["Ctrl","K"]` |
| `ctx.servers` | app 列出的 server 与其活的 `ServerRef` | 自带 server 的 id 是 `"sidecar"`；`data.on(...)` 收事件 |
| `ctx.workspaces` | `on("remove", ...)` | 清理按 workspace 作用域存的状态 |

宿主 API 都是 getter：没读就没成本。**界面挂载前不抛错**——读返回默认值（`layout.ready()` 为 `false`、`state` 为 `"closed"`），写在挂载后按调用顺序补执行；对话框也一样，首帧后显示。

### 4.2 组件里拿上下文

```tsx
import { usePlugin } from "@opencode/plugin/gui"
import type { definition } from "./definition"

function Status() {
  const ctx = usePlugin<typeof definition>()
  return <span>{ctx.t("title")}</span>
}
```

`usePlugin` 在贡献点之外抛错；被其它插件渲染的契约组件必须用 `bindPlugin` 包一层，否则读到的是**消费方**的上下文。

---

## 5. 注册表（窗口）

```ts
ctx.add(Command, () => ({ ... }))   // 函数形式：读到的响应式值变化时重新求值
ctx.add(Style, css)                 // 固定值形式
```

`ctx.add` 返回撤销函数；注册随当前 owner（组件 / `createKeyed` 一轮 / 插件实例）结束而撤销。

### 5.1 `Command`

```ts
ctx.add(Command, (): Command => ({
  id: "toggle",
  title: ctx.t("command.toggle"),
  description: ctx.t("command.toggleHint"),
  keywords: "notes scratch",
  group: ctx.t("command.category.view"),
  section: "prompt",          // general | session | navigation | model | terminal | prompt
  bind: "mod+shift+t",
  slash: { name: "notes", arguments: true, after: "open" },
  hidden: true,               // 不进面板，但快捷键仍生效
  suggested: true,
  featured: true,
  enabled: !!ctx.sessions.current(),
  scope: ".acme-panel",       // 焦点必须在该选择器内
  editable: true,             // 输入框聚焦时也触发
  run: (input) => { /* 返回 false 表示放行按键 */ },
}))
```

- `run` 从快捷键触发时**同步返回 `false`** 才能把按键让给原本目标（例如 Enter 继续交给输入框）。
- 字面量字段（`hidden: true`、`section`、`icon`、菜单名）必须写返回类型标注，否则 TS 推断成 `string`/`boolean`，没有重载匹配。

### 5.2 `Panel`（会话侧栏页签）

```ts
ctx.add(Panel, {
  id: "main",
  region: "side",
  wide: true,
  mobile: { title: ctx.t("panel"), order: 45, kind: "menu", icon: "file-tree" },
  list: (input) => (input.open.includes("main") ? [tab] : []),
  render: (props) => <View tab={props.tab} session={props.session} screen={props.screen} />,
  focus: ({ restored }) => { if (!restored) onUserSelect() },
  enter: ({ session }) => focusPanel(),
  close: ({ tab }) => cleanup(tab.id),
  closed: ({ tab }) => ({ icon: "globe", detail: host(tab), data: url(tab.id) }),
  restore: ({ id, data }) => reopen(id, data),
  normalize: ({ id }) => canonical(id),
})
```

- 所有回调收到**一个具名 input**，`session` 是活 getter，`screen` 是常量；`render` 只跑一次，切会话不重挂。
- `list` 在会话切换时重跑，必须返回**稳定的 tab 对象**（标签用 getter），否则触发器反复重挂。
- `fallback: true` 让该 tab 在"存储的选择不存在/不可选"时被选中；`pinned` 只列出不打开、不关闭、不可拖。
- `transient`（tab 或 panel）= 启动器：下一次预览替换它，窄屏不存储不选中。
- 关闭恢复：`closed` 返回 `false` 表示不可恢复；不给 `closed`/`restore` 时同 key 重开。
- 窄屏：普通 `open` 直接切到 mobile 视图；`{ background: true }` 保持当前视图，`{ tab: "select" }` 追加并选中且不替换预览。

### 5.3 `Slot`（4 个固定位置）

```ts
ctx.add(Slot, { at: "session.header", order: 10, render: (input) => <Ring session={input.session} /> })
```

| `at` | 位置 | 输入 |
| --- | --- | --- |
| `window.bottom` | 窗口底部条（toast 上方） | `{}` |
| `session.header` | 会话时间线标题行 | `{ screen, session, active }`（缓存时间线隐藏时 `active=false`） |
| `session.location.menu` | 项目菜单里位置详情之后 | `{ screen, session, shown }`，只在 `shown` 时订阅数据 |
| `session.panel.end` | 侧栏页签条尾部动作 | `{ screen, session }` |

`order` 升序。内置插件另有 `session.location.workspace`、`.branch.menu`、`.path.menu`，第三方用不到。

### 5.4 `SettingsPage`

```ts
ctx.add(SettingsPage, {
  id: "acme",
  icon: "server",
  get title() { return ctx.t("title") },
  get entries() { return [{ id: "sync", title: ctx.t("settings.sync"), keywords: "sync remote" }] },
  render: (input) => <Page highlight={input.target} />,
})
```

- 独立页：省略 `page`；加 section 到宿主页：`page: "general" | "servers"`；加行到 General 区：`page: "general", section: "general"`（此时 `render` 返回设置行）。
- `group: "about"` 把页面挂到 About 分组（发布说明之类）。
- `entries` 是不挂载页面就能搜索的元数据；命中时 `render` 收到 `target`。
- 有 `render` 的项由宿主保持稳定对象，标签必须用 getter。

### 5.5 其它窗口注册表

| 注册表 | 用途 | 关键字段 |
| --- | --- | --- |
| `MenuItem` | `session.panel` 的 + 菜单、`server.add`、`server.row` | `menu`、`id`、`title`、`order`、`icon`、`keybind`、`opened`、`primary`、`run` |
| `TitlebarItem` | 标题栏/页签栏的胶囊按钮 | `id/label/title/icon/busy/pressed/run` |
| `ComposerPill` | 输入框上方状态胶囊 | `show(input)` 返回 view 或 `undefined`；`label/icon/tone/rows/run` |
| `LinkHandler` | 打开消息里的本地链接 | `priority`、`match`、`open`、`exists` |
| `Server` | 贡献一批 server 连接 | `ready`、`entries[]`（`state: stopped/starting/auth/ready/failed/incompatible`） |
| `Style` | 注入 CSS 字符串 | `ctx.add(Style, css)`，CSS 用 `?inline` 导入 |

`session.panel` 的 `primary: true` 让 + 直接执行；侧栏为空时宿主显示 "New tab" 启动器列表（非 primary 且未打开的项），不会自动执行 primary。

---

## 6. 主进程上下文（`main`）

```ts
Plugin.define({
  main(ctx) {
    ctx.log.write("info", "acme started", { version: ctx.app.version })
    const saved = ctx.storage.store("prefs", { schema: Prefs, initial: { enabled: false } })
    ctx.provide(Acme, {
      ping: () => "pong",
      screenActive: (_input, caller) => awake(caller.window),
      setActive: (enabled) => { /* ... */ },
    })
    ctx.onCleanup(() => release())
  },
})
```

| 属性 | 用途 |
| --- | --- |
| `ctx.storage` | **同步**存储，`value` 永远有值；`set`/`update` 返回前落库 |
| `ctx.log` | 写桌面日志文件（导出诊断日志时包含）：`write(level, message, data?)` |
| `ctx.app` | `platform` 恒为 `"desktop"` |
| `ctx.windows` | `get/list/focused/on("open"|"close")` |
| `ctx.embeds` | `create(WebContentsView, BrowserWindow)` → `Embed`（`show/on("visible")/capture/dispose`） |
| `ctx.serverEndpoints` | `get(id)` → `{ url, headers, sameMachine, password? }`，sidecar 用 `"sidecar"` |
| `ctx.cli` | `{ version, command[], binary?, development }`，可 `spawn(ctx.cli.command[0], [...slice(1), ...])` |
| `ctx.add(MenubarItem, ...)` | 原生/应用内菜单项：`menu: app|file|edit|view|go|window|help`、`after`、`enabled()`、`run(window)` |
| `ctx.onCleanup(fn)` | 反注册顺序执行；异步清理最多等 3 秒 |
| `ctx.signal` | 插件被禁用/重载/移除或 app 退出时中止 |

`main` 可以 `async`，也可以在 `await` 之后检查 `ctx.signal.aborted` 再注册。窗口 `setup` 不行（见 §9）。

---

## 7. 跨进程与跨插件：Contract / Ipc / Live

### 7.1 三种 token

```ts
// 同一进程内：窗口 → 窗口（比如把文件树借给别的插件）
export const FileTree = Contract.define<FileTree, "acme.tree">("acme.tree")

// 主进程 ↔ 窗口
export const Counter = Ipc.define({
  id: "acme.counter",
  state: Schema.Struct({ count: Schema.Number }),      // 每个窗口一份，main 推送
  methods: {
    increment: { input: Schema.Number, output: Schema.Number },
    reset: {},                                           // 无输入、无输出
  },
  events: { overflow: Schema.Struct({ limit: Schema.Number }) },
})

// 自己拥有的一份列表，别的插件往里加
export const Exporter = Registry.define<Exporter>("acme.exporter")
```

- token id 必须等于插件 id 或以 `<id>.` 开头。
- `Ipc` 的每个跨桥值都由 Effect `Schema` 编解码；编码失败只记日志（事件）或 reject（调用）。

### 7.2 提供与调用

```ts
// main：实现
const provider = ctx.provide(Counter, {
  state: (window) => ({ count: counts.get(window) ?? 0 }),
  increment: (step, caller) => {
    const next = (counts.get(caller.window) ?? 0) + step
    counts.set(caller.window, next)
    provider.changed(caller.window)            // 推状态快照
    if (next > 100) provider.emit("overflow", { limit: 100 }, caller.window)
    return next
  },
  reset: (_input, caller) => { counts.set(caller.window, 0); provider.changed(caller.window) },
})

// window：自己的 main
const counter = ctx.main(Counter)              // 同一 token 每次返回同一 client
counter.on("overflow", (data) => {})
const n = () => counter.state()?.count ?? 0

// 别的插件：跟别人的 token
const tree = ctx.use(FileTree)                 // Accessor<Live<FileTree>>
```

- 无 `input` schema 的方法**只接受选项对象**：`pairing.screenActive({ signal })`，不能写 `screenActive(undefined, ...)`。
- `ctx.main` 的调用在 main 启动期间等待；main 关闭或方法抛错时 reject；**插件没有 main 部件时会无限等待** **[源码 JSDoc]**，所以纯窗口插件不要 `ctx.main`。
- `on`/`state` 跟随 main 重启。

### 7.3 `Live` 状态机（必须处理）

```ts
type Live<T> =
  | { status: "pending" }
  | { status: "active"; value: T; generation: number }
  | { status: "inactive"; reason: "disabled" | "failed" }
```

| 状态 | 场景 | 用户应看到 |
| --- | --- | --- |
| `pending` | 提供方尚未启动 / 重启中 | 加载态，或先不提供入口 |
| `active` | 正常，`value` 可用 | 功能 |
| `inactive/disabled` | 被关掉、未组合、平台不支持（web 上所有 Ipc） | "不可用"，不要留死按钮 |
| `inactive/failed` | 提供方 `setup` 抛错 | 同上 |

```ts
ctx.add(Command, () => {
  const live = browser()
  return {
    id: "preview",
    title: ctx.t("preview"),
    enabled: live.status === "active" && !!ctx.sessions.current(),
    run: () => { if (live.status === "active") live.value.open(...) },
  }
})
```

提供方临时消失是**暂停**，不是失败：保留已有数据，回来再续，不要加重试定时器。事件与调用回复走不同通道，若 main 用事件报告结果，以事件为准。

### 7.4 捆绑组件

契约里返回组件时，在提供方 setup 里 `bindPlugin` 包一层，并显式标注 props（`ctx.provide` 内推断不出）：

```tsx
ctx.provide(FileTree, {
  Tree: bindPlugin((props: FileTreeProps) => <Tree {...props} />),
  count: () => 42,           // 数据方法不需要包
})
```

---

## 8. 存储

```ts
stores: {
  prefs: Store.global(Prefs, { enabled: true }, ["plugin.acme.prefs.v2"]),
  view: Store.session(View, { open: [] }),
}
```

| 种类 | 读法 | 何时加载 |
| --- | --- | --- |
| `Store.global` | `ctx.stores.prefs.value`（永不 `undefined`） | `setup` 之前；加载失败 = 插件 setup 失败 |
| `Store.session` | `ctx.stores.view(session).value` | 会话挂载时；此前 `undefined` |
| `ctx.storage.store(key, { schema, initial, scope })` | `value`（先 `undefined`） | 运行时键 |
| main `ctx.storage.store(key, ...)` | `value` 恒有值 | 同步 |

- 窗口存储走 IPC 异步加载，web 同步——**只在 web 测会漏掉桌面问题**，能声明就用声明。
- `scope`：`"global"`（默认）| `{ server, directory? }` | `{ session }`。
- `update(draft => { ... })` 只改深可变草稿，**必须返回 `undefined`**；返回新值编译报错、运行抛错。整体替换用 `set(next)`。
- 窗口的写会等加载完成后按调用顺序应用；main 的写立即落库。
- `from`：从旧键迁移一次（可传数组，新→旧）；`remove(key, { from })` 后再也不会重新导入。内置插件另有 `BuiltinStore`（可 pick 宿主键里的一段），第三方用不到。
- 键在 `plugin.<id>.<name>` 下；改名 = 迁移存储键 + 命令 id + 面板键，别丢用户数据。

---

## 9. 生命周期、异步与渲染规则

```text
enabled → loading → active → (failed | disabled | reload → loading | 窗口关闭)
```

- **窗口 `setup` 必须同步**。返回类型 `Cleanup | void` 会拒绝 async 函数；JS bundle 里返回 thenable 会被宿主直接判失败（不会等它）。
- 需要异步：放进 `createKeyed` / `createLatest`，传 `ctx.signal`；每个 `await` 之后先检查 `ctx.signal.aborted`。
- 清理三条路：`setup` 返回 cleanup、Solid `onCleanup`（setup 在插件根 owner 下运行）、`ctx.signal`（`await` 之后启动的清理只能靠它）。
- main 用 `ctx.onCleanup` 或返回（可 resolve 的）cleanup。
- `ctx.add` / `provide` / `dialogs.open` / `embeds.create` / Ipc 监听：随 owner 结束撤销；owner 已结束后再注册会**立即**撤销。

### 9.1 会话对象与 getter **[源码 + README 规则]**

- 每次路由得到一个新的 `MountedSession`：`key/id/tab/server/directory/visit` 在该对象上冻结；换目录也换对象（`key`、`visit` 不变）。
- 渲染不重挂，宿主通过 getter 递新对象：面板读 `props.session`、slot 读 `input.session`、tab 标签读 `state.session`。**不要解构、不要存进变量、不要拿它做缓存键**。
- 工作区文件 / 评论 / composer 属于 **screen**（跟路由走），不是 session；按 screen 做缓存，按 `session.key` 做会话缓存。
- `ctx.sessions.current()` 与 `ctx.screen.current()` 在首帧渲染、Home、draft、挂载前、离开路由后都是 `undefined`。

### 9.2 响应式约定

| 需求 | 用什么 |
| --- | --- |
| 派生值 | `createMemo` 或普通函数，**不要**用一个 effect 去 set 另一个信号 |
| 跟随外部系统（DOM / 第三方 / Ipc 订阅 / embed） | `createKeyed(source, fn, { otherwise, equals })` |
| 异步取数、丢弃过期回复、不挂起 | `createLatest(source, (v, signal) => ...)` |
| 用户离开会话再回来要重置的选择 | `createVisitState(initial)` |
| 按 id 重置子树 | `<Show keyed>` / 用 id 派生选择 |

`createKeyed` 的 source 如果每次构造新对象（`() => ({ directory, tab: tab() })`），必须给 `equals`，否则每次都当新 key。内置插件的 lint **禁止**直接 import `createEffect/createRenderEffect/createComputed`；SDK 已封装。

### 9.3 性能与 Suspense

- 窗口 bundle 随 app 启动求值，入口要小；重 UI 放 `lazy()`，每个 `lazy()` 包自己的 `<Suspense>`，否则加载时整块空白（严重时整个会话路由重挂、时间线滚动丢失）。
- 首帧之后不要触发悬挂；需要刷新时用 `.latest` 或带 `loading` 标志的 store。
- 可能触发悬挂的状态变更放进 `startTransition`。
- 不要在时间线行里加工作；`session.header` 是唯一的时间线表面。
- 不要写模块级状态（会跨重载、跨窗口泄漏）。

---

## 10. UI、图标、多语言、主题

- 组件一律用 `ctx.ui.*`（图标、按钮、菜单、Loader、Dialog、Switch、TextInput、Keybind、Markdown、Code）。`ctx.ui.Switch` / `TextInput` 不持状态，值由你回传。
- 图标字段类型是 `IconName`（`packages/plugin/src/gui/icon-name.ts`，由 `bun run generate` 从 `@opencode/ui/icons/catalog` 生成）。bundle 不能 `require` `@opencode/ui`，渲染一律 `<ctx.ui.Icon name="branch" />`。
- 字体：终端类输出用 `ctx.appearance.font("mono")`；其它 UI 用 CSS 变量。不要打包字体、不要写死 family。
- i18n：`ctx.t(key, params)` / `ctx.plural(key, count)`；`en` 是兜底，也是所有缺失键的来源。计数文案用 `<key>.one` / `<key>.other` 这类 CLDR 键。
- **标签要用函数形式注册才能跟随语言**：`ctx.add(Command, () => ({ title: ctx.t("open"), ... }))`；固定项里写 `title: ctx.t("open")` 会永远停在注册时的语言。宿主保持稳定的对象（`list` 返回的 tab、带 `render` 的项）用 getter：`get title() { return ctx.t("title") }`。
- 主题：跟随 app（`appearance.mode()`）；不要自己造一套颜色变量硬编码。

---

## 11. 调试与排障

| 现象 | 原因 / 处理 |
| --- | --- |
| Settings → Extensions 里没有你的插件 | 没写进**全局** `opencode.json(c)`；或包没有 `./gui-experimental` 导出；或入口不是 `.cjs`/`.js` |
| 显示 "not loaded"，日志说 id 被占用 | 撞了内置 id / `opencode` 命名空间 (§3.2) |
| 显示 "Not available on this system" | `os` 列表不含当前系统 |
| 改了代码没反应 | 本地目录要 `vite build --watch`；安装包只在版本变化时更新 |
| 构建报 "…is not a module the OpenCode app provides…" | 用了白名单外的 `effect/*`、`solid-js/*`、`@opencode/*`；改用共享入口（如 `import { Schema } from "effect"`） |
| 界面里 `undefined` / 调用静默无效 | 在窗口里真的执行了 `electron` / `node:fs` 代码，拿到的是 inert placeholder；把那段挪进 `main` |
| `usePlugin must run inside a plugin contribution` | 在贡献点外调用；契约组件忘了 `bindPlugin` |
| `ctx.provide` / `ctx.main` 抛错 | token id 不属于本插件（必须是 `<id>` 或 `<id>.*`） |
| 面板切会话不更新 | 解构了 `props.session`；应每次读 getter |
| 存储读到 `undefined` | session store 还没加载；或忘了声明而用了运行时不存在的键 |
| 按钮点了没反应 | 没处理 `Live` 的 `pending`/`inactive` |

- 主进程日志：`ctx.log.write(...)`，进桌面日志文件与"导出诊断日志"。
- 窗口侧：开发者工具（`ctx.app.channel === "dev" || !ctx.app.packaged` 时自建调试入口）。
- 构建自检：`vite build` 必须产出单个 `.cjs`，且 `dist/` 里没有第二个 chunk。

### 11.1 发布清单

1. `vite build` 通过，单产物；
2. `package.json` 的 `exports["./gui-experimental"]` 指向产物，`files` 带上 `dist`；
3. 安装到全局 `opencode.json(c)` 验证加载、开关、重载；
4. 用真实安装包（不是 workspace link）测一遍；
5. 版本与目标 OpenCode 版本匹配（API 是实验性的）。

---

## 12. 常见错法与正解（速查）

| 错 | 对 |
| --- | --- |
| 用 TUI 的 `context.ui.slot(...)` / `context.keymap.layer(...)` | GUI 用 `ctx.add(Slot, ...)` / `ctx.add(Command, ...)` |
| `import { Plugin } from "@opencode/plugin"` 定义 GUI | `import { Plugin } from "@opencode/plugin/gui"` |
| 输出 ESM / 多文件 | 必须单 CJS（`gui()` 预设） |
| `async setup(ctx)` | 同步；异步放 `createKeyed`/`createLatest` |
| 在 setup 里 `const session = ctx.sessions.current()` | 用时再读（命令 `run`、渲染、handler） |
| 在 setup 顶层读 `ctx.stores.view(session).value` | session store 未加载，一律 `undefined` |
| `update(draft => next)` | `update` 只改草稿不返回；替换用 `set(next)` |
| `ctx.add(Command, { title: ctx.t("x") })` | 用函数形式，否则不跟语言 |
| 面板 `list` 每次造新 tab 对象 | 缓存稳定对象，标签用 getter |
| `ctx.main(Ipc)` 但包里没有 `main` | 会一直等；纯窗口插件不要用 |
| main 里 `await` 后直接注册 | 先判 `ctx.signal.aborted` |
| 把 `MountedSession` 存进 Map/Signal 做缓存键 | 用 `session.key`；换目录会换对象 |
| 认为 web 上也有 main | web 上 Ipc 全 `inactive`，`ctx.desktop` 为 `undefined` |

---

## 13. 源码地图（本地 `Externals\opencode`）

| 路径 | 内容 |
| --- | --- |
| `packages/plugin/src/gui/index.ts` | 窗口 SDK 导出（core/registries/host-apis/solid/reactive） |
| `packages/plugin/src/gui/core.ts` | `Plugin`/`Store`/`Contract`/`Ipc`/`Registry`/`Live`/`Persisted`/`Cleanup` 定义 |
| `packages/plugin/src/gui/declarations.ts` | `os` / `stores` / `i18n` 声明 |
| `packages/plugin/src/gui/plugin.ts` | `Setup` / `MainSetup` / `Definition` / `define` |
| `packages/plugin/src/gui/context.ts` | 窗口 `Context` / `SetupContext` 全量 |
| `packages/plugin/src/gui/host-apis.ts` | 窗口宿主 API（Layout/Sessions/Screen/Storage/Dialogs/Ui/…） |
| `packages/plugin/src/gui/registries.ts` | 所有注册表与条目字段（Command/Panel/Slot/…） |
| `packages/plugin/src/gui/main.ts` | 主进程 `MainContext`、`MenubarItem`、`Embed` |
| `packages/plugin/src/gui/reactive.ts` | `createKeyed` / `createLatest` / `createVisitState` |
| `packages/plugin/src/gui/solid.ts` | `usePlugin` / `usePanel` / `useDrawer` / `bindPlugin` |
| `packages/plugin/src/gui/vite.ts` `modules.ts` | `gui()` 预设与模块白名单 |
| `packages/plugin/src/gui/host.ts` | 宿主协议：`compose`、`runsOn`、`pluginEnabled`、`evaluatePluginBundle`、`pluginIdAvailable` |
| `packages/plugin/src/gui/icon-name.ts` | `IconName` 全量（生成文件） |
| `packages/app/src/runtime/plugin/` | 窗口宿主（加载、求值、贡献点） |
| `packages/desktop/src/main/plugin/` | 主进程宿主（列插件、读 bundle、广播、存储） |
| `packages/core/src/plugin/` | server 侧解析入口、watch、GUI revision |
| `packages/gui-plugins/` | 内置插件实现（`pairing` 是最小双进程范例，`ssh`/`wsl`/`terminal` 可参考复杂场景） |
| `packages/gui-plugins/README.md`、`AGENTS.md` | 作者指南与硬规则（比公开文档更细，推荐一并读） |

---

## 14. 与官方文档的差异备忘

公开文档（`/v2/docs/build/plugins/gui`）覆盖了 API 与用法，但没写或写得更松的地方：

1. `pluginIdAvailable` 的**双向前缀**拒绝规则（互相嵌套都算冲突）。
2. bundle 校验细节：必须 default export `Plugin.define`、至少一个 setup、`i18n` 不许带 loader、`stores` 的 scope/schema 会被校验。
3. 模块白名单的**精确列表**与 "main-only" 判定（`electron`、`node:*`、Node 内置名单），以及 inert placeholder 的 `then: undefined` 语义。
4. 本地插件的 GUI 文件被 watch、内容哈希进 revision；安装包只随版本变。
5. `options` 必须是 JSON，否则 server 侧报 `Plugin options must be JSON to reach its ./gui-experimental`。
6. 纯 GUI 包（无 server 部件）的 id 取包名/目录名；`ctx.client` 指向桌面 app 自己的 server，正常可用，只是没有自己的 server 部件 RPC 可调。内置插件拿到的 client 则所有调用都 reject。
7. 窗口 setup 返回 thenable 的 JS bundle 是"直接判失败"，不是等待。
8. main 异步 cleanup 最多等 3 秒。
