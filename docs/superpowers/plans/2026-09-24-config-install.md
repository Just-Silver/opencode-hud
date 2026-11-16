<!-- 职责：记录 2026-09-24 配置安装改造的实施步骤（已废止，历史计划）；不写：现行安装方式与完整根因（见 docs/config-install.md）。 -->

# opencode-tui-usage「配置安装」分发改造 Implementation Plan

> ⚠️ **已废止（2026-09-24 回退）**：配置安装对 TUI 插件存在双 Solid 缺陷（只画首帧、不再刷新：侧边栏首次为空、切一次会话才显示），已回退脚本安装；方法学保留在 `docs/config-install.md`。本 plan 仅作历史记录。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让本插件只通过 `opencode.json(c)` 的 `"plugins": ["Just-Silver/opencode-tui-usage"]` 一行即可安装/更新/卸载，并删除其余全部安装通道。

**Architecture:** 仓库根新增 `package.json`，`exports["./tui"]` 指向现有 `.opencode/plugins/opencode-tui-usage/tui.tsx`；opencode 启动时经 `resolvePluginTarget → Npm.add`（arborist）按需从 GitHub 安装。不发布 npm registry。先探针验证（本地路径 + Git 规格）通过，再删除 4 个脚本并改写文档/发版/横幅。

**Tech Stack:** Node ≥23.6 原生 TS strip 单测（`node --test`）、Bun 1.3.14 运行时、opencode v2.0.15、GitHub Actions + git-cliff、esbuild（打包语法检查）。

**Spec:** `docs/superpowers/specs/2026-09-24-config-install-design.md`

## Global Constraints

- 包名 / 插件 id 均为 `opencode-tui-usage`；**不发布 npm registry**。
- **仅暴露 TUI 入口** `exports["./tui"]`；**还必须暴露 no-op `exports["./server"]`**（实测：纯 TUI-only 包会被 server 跳过、CLI 拿不到，配置安装失效）；不声明 `main`/`server.tsx` 之外的入口。server 入口不得触碰 `context.ui`。
- 版本三方一致：`tag == update/version.ts 的 VERSION == package.json.version`；**VERSION 为运行时唯一事实源**，`package.json.version` 为其镜像。
- 安装主写法 `"plugins": ["Just-Silver/opencode-tui-usage"]`；钉版本写法 `"plugins": ["github:Just-Silver/opencode-tui-usage#v2.0.0"]`。
- 更新/卸载走 `opencode plugin update|remove <目标>`（目标写法以 Task 3 探针结论为准）。
- **Task 2、Task 3 探针全部通过前，禁止执行 Task 5（删除旧脚本）**。
- `commit` 信息用中文；改完必须过 `node --test tests/*.test.ts` 与 esbuild 打包检查。

---

## File Structure

| 文件 | 责任 | 动作 |
|---|---|---|
| `package.json` | 包的公开接口（name/exports/files/version/deps） | 新建 |
| `tests/package.test.ts` | 离线守护：入口可达、被 files 覆盖、版本镜像一致、仅 TUI 入口 | 新建 |
| `.opencode/plugins/opencode-tui-usage/update/version.ts` | 运行时版本事实源 | 改 `VERSION` → `2.0.0` |
| `install.sh` / `install.ps1` / `uninstall.sh` / `uninstall.ps1` | 旧安装通道 | 删除 |
| `README.md` | 面向用户的分发说明 | 全量改写 |
| `AGENTS.md` | 仓库约定（布局/发版/运行） | 定点改写 |
| `.opencode/plugins/opencode-tui-usage/view/UpdateBanner.tsx` | 更新提示横幅 | 删除 |
| `.opencode/plugins/opencode-tui-usage/view/Sidebar.tsx` | 移除横幅 import 与渲染 | 定点改写 |
| `.opencode/plugins/opencode-tui-usage/update/index.ts` | 更新检查逻辑 | 删除 |
| `.opencode/plugins/opencode-tui-usage/update/version.ts` | 版本事实源 | 精简为仅 `VERSION` |
| `tests/update.test.ts` | 更新检查单测 | 删除 |
| `.github/workflows/release.yml` | 发版三方一致校验 | 定点改写校验步 |

---

### Task 1: 根 `package.json` + 版本镜像 + 守护测试

**Files:**
- Create: `package.json`
- Create: `tests/package.test.ts`
- Modify: `.opencode/plugins/opencode-tui-usage/update/version.ts:10`

**Interfaces:**
- Consumes: 现有 `update/version.ts` 导出的 `VERSION`
- Produces: 根 `package.json`（后续所有任务与 opencode 安装器依赖）; `VERSION === "2.0.0"`

- [ ] **Step 1: 写失败测试**

创建 `tests/package.test.ts`：

```ts
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"
import { VERSION } from "../.opencode/plugins/opencode-tui-usage/update/version.ts"

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)))
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"))

test("包名与插件 id 一致且为 ESM", () => {
  assert.equal(pkg.name, "opencode-tui-usage")
  assert.equal(pkg.type, "module")
})

test("暴露 ./server 与 ./tui 两个入口（server 入口是配置安装可达的必要条件）", () => {
  assert.deepEqual(Object.keys(pkg.exports), ["./server", "./tui"])
  assert.equal(pkg.main, undefined)
})

test("exports 两个入口都指向真实存在的文件", () => {
  for (const rel of [pkg.exports["./server"], pkg.exports["./tui"]]) {
    assert.ok(typeof rel === "string" && rel.length > 0, "入口必须是字符串")
    assert.ok(existsSync(path.join(root, rel)), `入口文件不存在: ${rel}`)
  }
  assert.ok(pkg.exports["./tui"].endsWith("tui.tsx"), "TUI 入口应为 tui.tsx")
  assert.ok(pkg.exports["./server"].endsWith("server.ts"), "server 入口应为 server.ts")
})

test("files 覆盖 exports 指向的入口（防点目录被剔除）", () => {
  const norm = (s: string) => s.replace(/^\.\//, "").replace(/\/+$/, "")
  const entry = norm(pkg.exports["./tui"])
  const covered = pkg.files.some((f: string) => {
    const dir = norm(f)
    return entry === dir || entry.startsWith(dir + "/")
  })
  assert.ok(covered, `files 未覆盖入口: ${pkg.exports["./tui"]}`)
})

test("package.json.version 与运行时 VERSION 一致", () => {
  assert.equal(pkg.version, VERSION)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/package.test.ts`
Expected: FAIL —— `Cannot find module '.../package.json'`（ENOENT 读取失败）

- [ ] **Step 3: 新建 `package.json`**

```json
{
  "name": "opencode-tui-usage",
  "version": "2.0.0",
  "type": "module",
  "files": [".opencode/plugins/opencode-tui-usage"],
  "exports": {
    "./tui": "./.opencode/plugins/opencode-tui-usage/tui.tsx"
  },
  "dependencies": {
    "@opencode/plugin": "latest"
  },
  "peerDependencies": {
    "@opentui/core": ">=0.5.8",
    "@opentui/solid": ">=0.5.8",
    "solid-js": ">=1.9.0"
  }
}
```

- [ ] **Step 4: `VERSION` 升级到 2.0.0**

`.opencode/plugins/opencode-tui-usage/update/version.ts:10`：

```ts
export const VERSION = "2.0.0"
```

- [ ] **Step 5: 跑全量测试确认通过**

Run: `node --test tests/*.test.ts`
Expected: 全绿（含 `tests/package.test.ts` 5 项）

- [ ] **Step 6: 提交**

```bash
git add package.json tests/package.test.ts .opencode/plugins/opencode-tui-usage/update/version.ts
git commit -m "feat: 新增根 package.json（仅 ./tui 入口）并将版本升至 2.0.0"
```

---

### Task 2: 探针 A —— 本地路径规格验证入口解析与 server 跳过（闸门）

**Files:**
- 临时工程：`$env:TEMP\oc-probe-a\opencode.jsonc`（不属于仓库）

**Interfaces:**
- Consumes: Task 1 的 `package.json`
- Produces: 结论「`exports["./tui"]` 能被解析；server 端因无 `./server` 而跳过且不报错」——Task 3 的前提

- [ ] **Step 1: 建临时工程并写配置**

```powershell
$proj = Join-Path $env:TEMP "oc-probe-a"
New-Item -ItemType Directory -Force $proj | Out-Null
Set-Content -Path (Join-Path $proj "opencode.jsonc") -Value '{ "$schema": "https://opencode.ai/config.json", "plugins": ["file:///E:/Code/Projects/Agent/opencode-tui-usage"] }' -Encoding utf8
```

> 历史命令注记：`E:/Code/Projects/Agent/opencode-tui-usage` 是 2026-09-24 时的本机路径，现已迁移/不存在；本条不保证当前可原样执行。

- [ ] **Step 2: 启动私有 server 看插件解析日志**

```powershell
Push-Location $proj
opencode api --standalone --print-logs GET /api/plugin 2>&1 |
  Select-String -Pattern "opencode-tui-usage|entrypoint|missing|loading plugin|error|cause"
Pop-Location
```

Expected（探针通过）：
- 出现 `opencode-tui-usage` 相关解析记录；
- server 端**无** `failed to load plugin` 崩溃性错误；若提示 `does not expose a server entrypoint` 属**预期**（TUI-only）；
- 不出现 `missing package.json or index file`（说明入口解析成功）。

- [ ] **Step 3: 记录结论**

将实际输出与是否通过记入 Task 3 的提交说明或本文件末尾「探针记录」。**不通过 → 停下，回到 spec 第 6 节风险评估，不进入 Task 3。**

---

### Task 3: 探针 B —— Git 规格端到端（自动安装 + 点目录打包 + TUI 加载）(闸门)

**Files:**
- 临时工程：`$env:TEMP\oc-probe-b\opencode.jsonc`

**Interfaces:**
- Consumes: Task 1、Task 2
- Produces: 结论「Git 规格可自动安装、`.opencode` 在安装产物内、TUI 侧加载、`bun:sqlite`+`quota/providers/` 扫描正常」——Task 5 的前提

- [ ] **Step 1: 推送本分支供远端克隆**

```bash
git push -u origin feat/config-install
```

- [ ] **Step 2: 建临时工程并写 Git 规格**

```powershell
$proj = Join-Path $env:TEMP "oc-probe-b"
New-Item -ItemType Directory -Force $proj | Out-Null
Set-Content -Path (Join-Path $proj "opencode.jsonc") -Value '{ "$schema": "https://opencode.ai/config.json", "plugins": ["github:Just-Silver/opencode-tui-usage#feat/config-install"] }' -Encoding utf8
```

- [ ] **Step 3: 确认被识别为可用插件**

```powershell
Push-Location $proj
opencode plugin list
opencode plugin check 2>&1 | Select-String -Pattern "opencode-tui-usage"
Pop-Location
```

Expected: 列表/检查中出现 `opencode-tui-usage`（TUI-only 包应被 `plugin list`/`plugin check` 识别）。

- [ ] **Step 4: 确认安装产物包含点目录入口**

```powershell
Get-ChildItem "$env:LOCALAPPDATA\opencode", "$env:USERPROFILE\.cache\opencode" -Recurse -Filter "tui.tsx" -ErrorAction SilentlyContinue |
  Select-Object -First 5 -ExpandProperty FullName
```

Expected: 找到 `<cache>\…\node_modules\opencode-tui-usage\.opencode\plugins\opencode-tui-usage\tui.tsx`（**此步失败即触发 Task 4**）。

- [ ] **Step 5: 确认 `plugin update/remove` 的目标写法**

```powershell
Push-Location $proj
opencode plugin update opencode-tui-usage 2>&1 | Select-String -Pattern "opencode-tui-usage|not found|no plugin"
opencode plugin update Just-Silver/opencode-tui-usage 2>&1 | Select-String -Pattern "opencode-tui-usage|not found|no plugin"
Pop-Location
```

Expected: 其中**一种**写法被识别（记录是哪种），据此刻定 README / AGENTS 的命令写法。

- [ ] **Step 6: TUI 端加载验证（手动，交互）**

```powershell
$env:TUI_USAGE_PROBE = "1"
Push-Location $proj
opencode
Pop-Location
```

在 TUI 中肉眼确认侧边栏出现上下文/缓存区块、无崩溃；退出后：

```powershell
Get-Content "$env:USERPROFILE\.local\share\opencode\log\tui-usage.log" -Tail 20
```

Expected: 探针日志出现（且无异常堆栈）。`$env:TUI_USAGE_PROBE` 用完后置空。

- [ ] **Step 7: 记录结论**

记入本文件末尾「探针记录」。**任一步失败 → 停下，执行 Task 4 或回到 spec 重新设计；禁止 Task 5。**

---

### Task 4: （条件执行）点目录打包回退

**触发条件：** 仅当 Task 3 Step 4 找不到 `.opencode` 下的入口（点目录被 pacote 剔除）时执行。若 Task 3 已通过，跳过本任务。

**路径替换约定：** 若本任务触发，后续所有任务（T5–T8）中出现的 `.opencode/plugins/opencode-tui-usage` 一律替换为 `plugin/opencode-tui-usage`（`release.yml` 的 grep 路径、README/AGENTS 文案、esbuild 命令同）。

**Files:**
- Rename: `.opencode/plugins/opencode-tui-usage/` → `plugin/opencode-tui-usage/`
- Modify: `package.json`（`files` 与 `exports` 路径）
- Modify: `tests/package.test.ts`（断言路径若含硬编码则同步）
- Create: `opencode.jsonc`（本仓库自用，保持开发时自动加载）

**Interfaces:**
- Consumes: Task 3 失败结论
- Produces: 非点目录的包布局，使 Task 3 重跑通过

- [ ] **Step 1: 迁移目录到非点路径**

```bash
git mv .opencode/plugins/opencode-tui-usage plugin/opencode-tui-usage
```

- [ ] **Step 2: 同步 `package.json`**

```json
  "files": ["plugin/opencode-tui-usage"],
  "exports": {
    "./tui": "./plugin/opencode-tui-usage/tui.tsx"
  },
```

- [ ] **Step 3: 新建根 `opencode.jsonc`（开发时自加载）**

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["./plugin/opencode-tui-usage"]
}
```

- [ ] **Step 4: 跑测试 + esbuild 检查**

Run:
```
node --test tests/*.test.ts
npx --yes esbuild plugin/opencode-tui-usage/tui.tsx --bundle --platform=node --format=esm --jsx=automatic --jsx-import-source=@opentui/solid --external:@opencode/plugin/tui --external:@opentui/solid --external:solid-js --outfile=$env:TEMP\opencode\tui-bundle-check.js
```
Expected: 测试全绿；esbuild 输出 `Done in`。

- [ ] **Step 5: 重跑 Task 2、Task 3**

Expected: 均通过。

- [ ] **Step 6: 提交**

```bash
git add -A
git commit -m "refactor: 插件目录迁出点目录以兼容 npm 打包（package.json 同步）"
```

---

### Task 5: 删除全部旧安装脚本

**前置：Task 2、Task 3 已通过（Task 4 若触发亦已通过）。**

**Files:**
- Delete: `install.sh`、`install.ps1`、`uninstall.sh`、`uninstall.ps1`

**Interfaces:**
- Consumes: 探针通过结论
- Produces: 仓库不再包含脚本式安装通道

- [ ] **Step 1: 删除脚本**

```bash
git rm install.sh install.ps1 uninstall.sh uninstall.ps1
```

- [ ] **Step 2: 确认无残留引用**

Run: `rg -n "install\.(sh|ps1)|uninstall\.(sh|ps1)" --glob '!.git'`
Expected: 仅可能命中 `README.md` / `AGENTS.md`（将在 Task 6、7 修复）；无其它代码引用。

- [ ] **Step 3: 提交**

```bash
git commit -m "refactor: 移除 install/uninstall 脚本（分发统一为配置安装）"
```

---

### Task 6: 改写 `README.md`

**Files:**
- Modify: `README.md`（全量替换）

**Interfaces:**
- Consumes: Task 3 Step 5 得出的 `opencode plugin` 目标写法
- Produces: 面向用户的唯一安装/更新/卸载说明

- [ ] **Step 1: 用下列内容全量替换 `README.md`**

````markdown
# opencode-tui-usage

TUI 侧边栏：上下文 / 缓存 / 额度。

## 安装

在 `opencode.json(c)` 的 `plugins` 中加入一行，opencode 启动时会自动从 GitHub 安装：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["Just-Silver/opencode-tui-usage"]
}
```

钉版本（可复现，推荐）：

```jsonc
{
  "plugins": ["github:Just-Silver/opencode-tui-usage#v2.0.0"]
}
```

> 未钉版本会跟随默认分支；钉 tag 后更新由 `opencode plugin update` 负责。

## 更新

```sh
opencode plugin update <配置中的目标>
```

或直接重启 opencode。

## 卸载

```sh
opencode plugin remove <配置中的目标>
```

或从 `plugins` 中删掉该行。

## 从旧版脚本迁移

曾用 `install.sh` / `install.ps1` 安装的用户：删除 `~/.config/opencode/plugins/opencode-tui-usage/`，按上面的「安装」写入配置行，重启 opencode。

## 发布新版本

更新交给 opencode：未钉版本会在启动时刷新，手动更新用 `opencode plugin update <配置中的目标>`。

```bash
# 1. 改 .opencode/plugins/opencode-tui-usage/update/version.ts 的 VERSION
#    并同步 package.json 的 version 为同一值
# 2. 提交（建议用约定式提交前缀，便于 CHANGELOG 归类）
git commit -m "feat: 新增 XX"
# 3. 打 tag 并推送（触发 Actions）
git tag v2.0.0
git push origin v2.0.0
```

Actions 自动完成：
- 校验 tag == `VERSION` == `package.json.version`（不一致即 fail 拦截）
- **git-cliff 生成 `CHANGELOG.md`**（按 Conventional Commits 归类），提交回仓库
- 创建 Release，说明直接用 CHANGELOG

> CHANGELOG 遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本遵循 [SemVer](https://semver.org/lang/zh-CN/)。
````

- [ ] **Step 2: 自查无脚本残留**

Run: `rg -n "install\.(sh|ps1)|uninstall|curl -fsSL|irm " README.md`
Expected: 无输出（除「从旧版脚本迁移」段落中作为历史名词出现的 `install.sh`/`install.ps1` —— 允许，属迁移说明）。

- [ ] **Step 3: 提交**

```bash
git add README.md
git commit -m "docs: README 改为配置安装（安装/更新/卸载/迁移）"
```

---

### Task 7: 改写 `AGENTS.md`

**Files:**
- Modify: `AGENTS.md`（定点）

**Interfaces:**
- Consumes: Task 3 Step 5 结论
- Produces: 仓库约定与新分发方式一致

- [ ] **Step 1: 改「项目」段与「布局硬约束」段**

把首段中 `无 package.json/README/opencode.json` 的表述改为：

```
- 单 TUI 插件仓库，非 monorepo；**分发为配置安装**：根 `package.json` 暴露 `exports["./server"]`（no-op）与 `exports["./tui"]` → `.opencode/plugins/opencode-tui-usage/{server,tui}.tsx`，不发布 npm registry（CI 仅 `.github/workflows/release.yml` 发版）
```

「布局硬约束」段里把「只有 `tui.tsx`、无 server 入口」改为：

```
- 入口为 `tui.tsx`（TUI，import `@opencode/plugin/tui`）+ `server.ts`（**no-op** server 入口，import `@opencode/plugin`，**不得触碰 `context.ui`**）：实测纯 TUI-only 包会被 server 跳过、CLI 拿不到，配置安装失效，故必须有 server 入口
```

同一段里把 `update/` 的描述从「更新检查（版本常量+Release 对比）」改为「版本常量」：

```
、`update/` 版本常量
```

- [ ] **Step 2: 改「发版」段**

**删除**整条「运行时更新提示」bullet（`插件启动时 fetch …/releases/latest … 落后则 view/UpdateBanner.tsx …`），并在「版本单一事实源」处补：

```
- 版本三方一致：tag == update/version.ts 的 VERSION == package.json.version（release.yml 校验）；VERSION 为运行时唯一事实源，package.json.version 为其镜像
- 更新交由 opencode：`opencode plugin update <配置中的目标>`；插件自身不再做更新检查
```

- [ ] **Step 3: 新增「分发安装」小节**（放在「发版」前）

```
# 分发安装
- 唯一安装方式：`opencode.json(c)` 的 `"plugins": ["Just-Silver/opencode-tui-usage"]`（钉版本用 `github:Just-Silver/opencode-tui-usage#vX.Y.Z`）；opencode 启动时经 arborist 从 GitHub 按需安装到 global.cache
- 更新 `opencode plugin update <目标>` / 卸载 `opencode plugin remove <目标>`（目标写法见探针结论）
- 旧件 install.sh/install.ps1/uninstall.sh/uninstall.ps1 已删除，不再维护
```

- [ ] **Step 4: 提交**

```bash
git add AGENTS.md
git commit -m "docs: AGENTS.md 同步配置安装分发约定"
```

---

### Task 8: 移除更新横幅与更新检查模块

**Files:**
- Delete: `.opencode/plugins/opencode-tui-usage/view/UpdateBanner.tsx`
- Delete: `.opencode/plugins/opencode-tui-usage/update/index.ts`
- Delete: `tests/update.test.ts`
- Modify: `.opencode/plugins/opencode-tui-usage/view/Sidebar.tsx:23,145-146`
- Modify: `.opencode/plugins/opencode-tui-usage/update/version.ts`（整文件精简）

**Interfaces:**
- Consumes: 无
- Produces: 插件不再自查更新；`update/version.ts` 仅导出 `VERSION`（`tests/package.test.ts` 依赖它）

- [ ] **Step 1: 删除更新横幅与更新检查文件**

```bash
git rm .opencode/plugins/opencode-tui-usage/view/UpdateBanner.tsx \
       .opencode/plugins/opencode-tui-usage/update/index.ts \
       tests/update.test.ts
```

- [ ] **Step 2: `Sidebar.tsx` 移除 import（第 23 行）**

删除这一行：

```tsx
import { UpdateBanner } from "./UpdateBanner.tsx"
```

- [ ] **Step 3: `Sidebar.tsx` 移除渲染（第 145-146 行）**

删除这两行：

```tsx
      {/* 更新提示：不依赖会话数据，放在插件最下方，轻量一行、可关闭 */}
      <UpdateBanner theme={theme} />
```

- [ ] **Step 4: 精简 `update/version.ts` 为仅版本常量**

用以下内容整体替换该文件：

```ts
// ─── 版本常量（唯一版本事实源） ───
// 发布流程：改本文件的 VERSION（并同步根 package.json 的 version）→ commit → git tag v<VERSION> → push（Actions 自动出 Release）。
export const VERSION = "2.0.0"
```

- [ ] **Step 5: 确认无更新模块残留引用**

Run: `rg -n "UpdateBanner|checkForUpdate|fetchLatestRelease|resolveUpdate|compareVersions|parseVersion" --glob '!.git' --glob '!docs/**' --glob '!CHANGELOG.md'`
Expected: 无输出。

- [ ] **Step 6: 全量单测 + esbuild 打包检查**

Run:
```
node --test tests/*.test.ts
npx --yes esbuild .opencode/plugins/opencode-tui-usage/tui.tsx --bundle --platform=node --format=esm --jsx=automatic --jsx-import-source=@opentui/solid --external:@opencode/plugin/tui --external:@opentui/solid --external:solid-js --outfile=$env:TEMP\opencode\tui-bundle-check.js
```
Expected: 测试全绿（`tests/update.test.ts` 已删）；esbuild 输出 `Done in ...`。

- [ ] **Step 7: 提交**

```bash
git add -A
git commit -m "refactor: 移除侧边栏更新横幅与更新检查模块（更新交由 opencode plugin update）"
```

---

### Task 9: 发版三方一致校验

**Files:**
- Modify: `.github/workflows/release.yml:21-32`

**Interfaces:**
- Consumes: Task 1 的 `package.json.version`
- Produces: CI 在 tag 与 VERSION 或 package.json.version 不一致时 fail

- [ ] **Step 1: 替换校验步骤**

将 `release.yml` 的 `- name: 校验 tag 与 VERSION 一致` 整步替换为：

```yaml
      - name: 校验 tag / VERSION / package.json 一致
        id: version
        run: |
          TAG="${GITHUB_REF_NAME#v}"
          IN_CODE="$(grep -oP 'VERSION = "\K[0-9]+\.[0-9]+\.[0-9]+' .opencode/plugins/opencode-tui-usage/update/version.ts)"
          IN_PKG="$(grep -oP '"version": "\K[0-9]+\.[0-9]+\.[0-9]+' package.json)"
          echo "tag=$TAG"
          echo "code=$IN_CODE"
          echo "pkg=$IN_PKG"
          if [ "$TAG" != "$IN_CODE" ]; then
            echo "::error::tag ($TAG) 与 update/version.ts VERSION ($IN_CODE) 不一致"
            exit 1
          fi
          if [ "$TAG" != "$IN_PKG" ]; then
            echo "::error::tag ($TAG) 与 package.json version ($IN_PKG) 不一致"
            exit 1
          fi
          echo "version=$TAG" >> "$GITHUB_OUTPUT"
```

- [ ] **Step 2: 本地验证 grep 能取到两处版本**

Run:
```
Bash -c 'grep -oP "VERSION = \"\K[0-9]+\.[0-9]+\.[0-9]+" .opencode/plugins/opencode-tui-usage/update/version.ts; grep -oP "\"version\": \"\K[0-9]+\.[0-9]+\.[0-9]+" package.json'
```
Expected: 两行均输出 `2.0.0`。（无 bash 时改用 `rg` 手工核对两文件均为 `2.0.0`）

- [ ] **Step 3: 提交**

```bash
git add .github/workflows/release.yml
git commit -m "ci: 发版校验扩展为 tag/VERSION/package.json 三方一致"
```

---

### Task 10: 收尾验证（合并前）

**Files:** 无（仅验证）

**Interfaces:**
- Consumes: Task 1–9
- Produces: 合并前证据

- [ ] **Step 1: 全量单测**

Run: `node --test tests/*.test.ts`
Expected: 全绿。

- [ ] **Step 2: 打包语法检查**

Run:
```
npx --yes esbuild .opencode/plugins/opencode-tui-usage/tui.tsx --bundle --platform=node --format=esm --jsx=automatic --jsx-import-source=@opentui/solid --external:@opencode/plugin/tui --external:@opentui/solid --external:solid-js --outfile=$env:TEMP\opencode\tui-bundle-check.js
```
Expected: `Done in ...`。

- [ ] **Step 3: 复跑 Task 2 / Task 3 探针**

Expected: 均通过（含 TUI 侧探针日志）。

- [ ] **Step 4: 核对无旧通道残留**

Run: `rg -n "install\.(sh|ps1)|uninstall\.(sh|ps1)" --glob '!.git' --glob '!docs/**'`
Expected: 无输出。

---

### Task 11: 发布 v2.0.0

**Files:** 无（发版动作）

**Interfaces:**
- Consumes: Task 10 通过、分支已 push
- Produces: 存在 `v2.0.0` tag + Release，使 README 的 `#v2.0.0` 成立

- [ ] **Step 1: 合并到 main**

```bash
git checkout main
git merge --no-ff feat/config-install
git push origin main
```

- [ ] **Step 2: 打 tag 并推送（触发 Actions）**

```bash
git tag v2.0.0
git push origin v2.0.0
```

- [ ] **Step 3: 等 Actions 完成并验证**

```bash
gh run watch --exit-status
gh release view v2.0.0
```

Expected: Release `v2.0.0` 存在；CHANGELOG 已由 bot 提交回 main。

- [ ] **Step 4: 用钉版本写法终验**

在临时工程写 `{"plugins":["github:Just-Silver/opencode-tui-usage#v2.0.0"]}`，跑 Task 3 Step 3/4/6。
Expected: 通过。

---

## 探针记录（执行时填写）

| 探针 | 日期 | 结论 | 备注 |
|---|---|---|---|
| Task 2 本地路径 | | | |
| Task 3 Git 规格（识别/打包/加载/命令目标） | | | |
| Task 4 是否触发 | | | |

## Self-Review 记录

- **Spec 覆盖**：spec §4.1→T1；§4.2（新增包/测试→T1，删脚本→T5，README→T6，AGENTS→T7，**删除更新横幅与更新检查→T8**，release.yml→T9，CHANGELOG→T11）；§4.3→T6/T7；§4.4→T9/T11；§5.1 探针 1→T2、探针 2→T3、探针 3→T3 Step5；§5.2→T10；§6 回退→T4；§7 迁移→T6；§8 待定→T3 记录。
- **占位符扫描**：无 TBD/TODO；命令与代码均为可执行内容。
- **类型/命名一致**：包名 `opencode-tui-usage`、入口 `exports["./tui"]`、`VERSION`/`package.json.version` 全篇一致；Task 4 变更路径已同步 T4 Step 2 与 T4 Step 4 命令。

## 验证记录（实测，2026-09-24，本机 opencode v2.0.15）

探针方式：复制插件到临时工程、改 id、在模块顶层写唯一标记文件/用 `TUI_USAGE_PROBE=1` 日志；拉 TUI 若干秒后判定。全局脚本插件在测试期间移出 `plugins/` 目录以免混淆。

| 场景 | 结果 |
|---|---|
| 发现式 `.opencode/plugins/<dir>/tui.tsx` | ✅ 加载 |
| `opencode.jsonc` `plugins` + 包**仅** `./tui`（file://） | ❌ 不加载 |
| `opencode.jsonc` `plugins` + 包**仅** `./tui`（git 分支） | ❌ 不加载 |
| `opencode.jsonc` `plugins` + `."`/`./tui`（file://，含 no-op server） | ❌ 不加载（file:// 形态） |
| `tui.jsonc` `plugin`（file:// / git） | ❌ 不加载 |
| **`opencode.jsonc` `plugins` + `./server`(no-op) + `./tui`（git 分支）** | ✅ **加载成功** |
| 临时工程非 git 仓库 → 改到真 git 仓库复测（仅 `./tui`） | ❌ 仍不加载 |

**结论**：配置安装可行的**必要条件**是包同时暴露 `./server`（让 server 端可见，server 入口不得触碰 `context.ui`）与 `./tui`。纯 TUI-only 包在 2.0.15 上无法经配置安装。
