<!-- 职责：执行计划——子代理计数互斥（Task 1）与文档收口（Task 8，含配置安装文档升级、审计状态附录、性能注记与全分支验证）；不写：凭据与额度（见 2026-11-16-credential-rules.md）、交付链路（见 2026-11-16-verified-delivery.md）。 -->

# 计数口径与文档收口 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把子代理计数改成互斥三类，并把本轮所有事实变更收口到归属文档：配置安装文档升级、审计状态附录、性能实测上限，且不污染历史记录。

**Architecture:** Task 1 是一次纯函数行为修正（一处返回值 + 一条测试 + 四处同源文案）。Task 8 是文档任务，不改生产代码；按「单一事实源」把结论写进归属文档，审计与历史 specs/plans 只追加注记、不回填原决策。

**Tech Stack:** TypeScript（`node:test`）、Markdown 文档、现有 esbuild 编译门禁。

**Spec:** `docs/superpowers/specs/2026-11-16-audit-decisions-design.md`

## Global Constraints

- 测试命令：`node --test tests/perf.test.ts`、`node --test tests/*.test.ts`（Node ≥ 23.6）。
- 编译门禁：`npx --yes esbuild .opencode/plugins/opencode-hud/tui.tsx --bundle --platform=node --format=esm --jsx=automatic --jsx-import-source=@opentui/solid --external:@opencode/plugin/tui --external:@opentui/solid --external:solid-js --outfile=$env:TEMP\opencode\tui-bundle-check.js`。
- 计数口径（用户确认）：**运行中 / 非失败的已停止 / 失败**，三项互斥、之和等于子代理行数；失败不重复计入已停止。保留现有 UI：运行中/已停止为 0 仍显示，失败为 0 时红色胶囊不渲染。
- 性能事实：1000 条历史 + 1 running 的一次 `buildRow`+`sort` 平均 0.08–0.11 ms、**p95 上限 0.272 ms**；这是纯函数成本，**不是 TUI 进程 CPU**。不采纳"全都 < 0.2"。
- 文档：每篇开头 HTML 职责注释；不改 `docs/superpowers/specs/**` 与 `docs/superpowers/plans/**` 的历史决策正文；`CHANGELOG.md` 不手改；`.gitignore` 不动；不改宽度表与路径空串/trim 语义。
- **禁止 `git commit` / `git push` / 发版**。每任务前 `task-snapshot.ps1 -Mode capture -Name task-0N-<slug>`，结束后 `-Mode review`，证据写 `.superpowers/decisions-2026-11-16/task-0N-report.md`。

## Review Focus

- 全失败时是否显示"黄色 0 + 红色 N"，且三数之和等于行数（Task 1 测试 1）。
- 缺失 outcome / `interrupted` / 旧数据无 `state` 时是否只算已停止、不冒充失败（Task 1 测试 1）。
- 文档是否出现"已实施"与"待决"并存的矛盾表述（Task 1 Step 4、Task 8 Step 2）。
- 配置安装文档是否把 2.2.6 源码结论写成了 2.3.0 实机结论（Task 8 测试 1）。
- 性能注记是否把纯函数耗时说成 TUI CPU，或复述错误的 "< 0.2 ms"（Task 8 测试 3）。

---

### Task 1: 子代理计数改为互斥三类

**Files:**
- Modify: `.opencode/plugins/opencode-hud/model/subagent.ts`
- Test: `tests/perf.test.ts:373-385`
- Modify: `AGENTS.md`（子代理计数口径）、`docs/design-subagent-section.md`（计数口径与 `message.sync` 限制）、`docs/audit-2026-11-16.md`（§4.6/§5 追加后续注记）、`docs/superpowers/specs/2026-11-11-heavy-dashboard-design.md`（仅 2026-11-16 审计注记行）
- 不改：`view/SubagentSection.tsx`（胶囊结构、颜色、定宽都不变）

**Interfaces:**
- Consumes: `SubagentRow.state`、`SubagentRow.running`。
- Produces: `subagentCounts(rows): { running: number; stopped: number; failed: number }`（签名不变，语义改为互斥）。

**规则：** `running` 仍按 `row.state ? row.state === "running" : row.running`（旧数据兜底）；`failed` 只数 `state === "failed"`；`stopped = rows.length - running - failed`。未知/`interrupted`/`stopped` 都只进 `stopped`。

- [ ] **Step 1: 改写既有测试（不新增平行用例）**

把 `tests/perf.test.ts` 中固化 inclusive 语义的用例改名为业务规则并更新期望：

```ts
test("subagentCounts：运行中 + 非失败已停止 + 失败 = 总数，失败不重复计入已停止", () => {
  const mk = (state: SubagentState): SubagentRow => ({
    id: state, agent: "general", tokens: 1, running: state === "running", state, expanded: false,
  })
  assert.deepEqual(subagentCounts([mk("running"), mk("failed"), mk("succeeded")]), { running: 1, stopped: 1, failed: 1 })
  assert.deepEqual(subagentCounts([mk("failed"), mk("failed")]), { running: 0, stopped: 0, failed: 2 })
  assert.deepEqual(subagentCounts([mk("stopped"), mk("interrupted")]), { running: 0, stopped: 2, failed: 0 })
  const { state: _state, ...legacy } = mk("stopped")
  assert.deepEqual(subagentCounts([legacy, { ...legacy, running: true }]), { running: 1, stopped: 1, failed: 0 })
  assert.deepEqual(subagentCounts([]), { running: 0, stopped: 0, failed: 0 })
})
```

- [ ] **Step 2: 运行，确认红**

Run: `node --test tests/perf.test.ts`
Expected: FAIL（`stopped` 仍含 failed）。

- [ ] **Step 3: 改实现（一行，移除过时注释）**

`model/subagent.ts`：删除与新口径相反的旧注释，返回 `{ running, stopped: rows.length - running - failed, failed }`。不新增函数、不改类型，不为显然的算术添加注释。

- [ ] **Step 4: 运行，确认绿**

Run: `node --test tests/perf.test.ts`
Expected: PASS。

- [ ] **Step 5: 同步四处文案（同一次改动内）**

1. `AGENTS.md`「数据口径」子代理段：删除"stopped = 全部非运行中（含失败）、三数不可相加、待裁定"，改为互斥三桶与"失败不重复计入已停止"。把笼统的"计数 0 也显示"明确成现有行为："运行中/已停止为 0 仍显示，失败为 0 不渲染"；不修改 UI。
2. `docs/design-subagent-section.md` 计数段：删除"待决（2026-11-16）"整条，改为已确认的互斥口径；同时把第 149 行"下一步事件会自愈"改为已知限制："`message.sync` 只取最近 20 条并 `reconcile` 替换该会话缓存；可能替换其他视图已加载的更早历史；插入行与响应交错时可能被裁掉且后续事件不会补回；未实机复现"。
3. `docs/audit-2026-11-16.md` §4.6 末尾追加一行"后续：2026-11-16 已按 §8 项 6 改为互斥三桶（见 `model/subagent.ts` 与 `tests/perf.test.ts`）"；§5 对应条目前加"审计当时是待决口径；2026-11-16 已改为互斥三桶"。**不删除原段落、不改当时证据。**
4. `docs/superpowers/specs/2026-11-11-heavy-dashboard-design.md` 的 2026-11-16 审计注记行：把"口径待用户决定"改为"用户已确认互斥三桶并于 2026-11-16 实施；本节原设计文字保留"。该文件正文原决策不动。

- [ ] **Step 6: 全量 + 编译**

Run: `node --test tests/*.test.ts`；Run: esbuild 命令。
Expected: 全绿；`Done in`。

- [ ] **Step 7: 记录证据（不提交）**

Run: `pwsh -NoProfile -File .superpowers/decisions-2026-11-16/task-snapshot.ps1 -Mode review -Name task-01-counts`
Expected: `review.diff`；报告写 perf 与全量输出、四处文档改动位置。

---

### Task 8: 文档收口（配置安装、审计状态、性能注记、最终验证）

**Files:**
- Modify: `docs/config-install.md`
- Modify: `docs/audit-2026-11-16.md`（§8 追加实施状态表）
- Modify: `docs/design-subagent-section.md`（基准注记）
- Verify: `AGENTS.md` 文档地图（四篇新文档已登记）、`README.md`/`TODO.md` 与已实施行为一致
- 不改：`docs/superpowers/specs/**`、`docs/superpowers/plans/**` 历史正文；`CHANGELOG.md`；`.gitignore`

**规则（配置安装文档）：**
- 顶部状态块写明：基线 = 源码 **2.2.6**（`D:/Code/Projects/Agents/opencode`）；本机安装 CLI **2.3.0**（单文件，未反编译/未实机）；标"需实机验证"的项不得写成已验证。
- 按核验清单改写：① 拆 `opencode.json(c)`（server/GUI）与 `cli.json`（TUI-only）两个配置面，`plugin` 单数迁移仍成立；② npm 缓存新增 generation 子目录；③ 纯 TUI 包"不会加载"的条件限定为 `opencode.json`，并写 `plugin add` 的路由；④ `plugin list` 现在合并 TUI 配置项，`/api/plugin` 仍只列 server 侧；⑤ `tui.json` 只在迁移时读取，新配置写 `cli.json`；⑥ Windows `windowsHide` 已传但需实机；⑦ 双 Solid 根因仍是历史假设，2.2.6 有 TUI 配置通道但 2.3.0 未实测，`peerDependencies` 标"需复核"；⑧ `resolvePluginTarget` 已不存在，替代链为 `Npm.isInstallablePackage → Npm.add → Host.resolve` / `PackageSource.prepare → Host.resolve`。
- 保留"本项目仍只支持脚本安装"的历史决策；不把 `docs/superpowers/specs/2026-09-24-config-install-design.md` 的废止设计回填。

**规则（审计状态附录）：** 在 `docs/audit-2026-11-16.md` §8 末尾追加"实施状态（2026-11-16 决策落实）"表：每项给 `已实施 / 条件阻塞 / 按现状保留` 与计划任务编号（1→Task 8 文档、2–5→Task 2/3、6→Task 1、7–11→Task 4/5/6/7、12–16→按现状保留或 Task 8）。明确"§4 的原始建议与证据不回填"。

**规则（性能注记）：** `docs/design-subagent-section.md` 的已知取舍加一句：1000 条已完成 + 1 running 的一次全量 `buildRow`+`sortRows` 实测平均 0.08–0.11 ms、p95 上限 0.272 ms；当前有意保持全量重算；**未测 OpenTUI 布局/渲染与进程 CPU，不能据此声称 TUI 整体流畅**。

- [ ] **Step 1: 先写文档验收清单（作为失败基线）**

在 `task-08-docs-report.md` 中列出断言（逐条勾选）：
1. `docs/config-install.md` 同时出现"源码 2.2.6""CLI 2.3.0""需实机验证"三处状态说明，且没有"2.0.15 未生效""必须不用 Solid"这类已失效结论当现状。
2. `docs/audit-2026-11-16.md` §8 有实施状态表且每项有任务编号；§4 原文未被改写。
3. `docs/design-subagent-section.md` 含 `0.272` 与"不是 TUI CPU"的限定。
4. `AGENTS.md` 文档地图含本设计 + 三份计划四条入口，职责一句话。
5. 全仓无"待裁定"的计数表述；`git grep -n "opencode-tui-usage"` 只命中历史文档。
6. `README.md` 前置条件与资产/锁/手工清理说明与脚本实现一致。

- [ ] **Step 2: 逐篇改写并自查**

按上面规则改三篇文档；每篇保留/修正 HTML 职责注释；发现跨文档重复事实时只留一处 + 链接。改完逐条勾 Step 1 清单，未通过项当场修正。

- [ ] **Step 3: 全项目验证**

Run: `node --test tests/*.test.ts` → 全绿、0 fail（skip 需说明原因）。
Run: esbuild 命令 → `Done in`。
Run: `bash -n install.sh uninstall.sh`；PowerShell Parser 检查 →
`pwsh -NoProfile -Command "foreach ($f in 'install.ps1','uninstall.ps1') { $t=$null;$e=$null; [System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path $f),[ref]$t,[ref]$e)|Out-Null; if($e.Count){$e|%{Write-Error $_};exit 1} }"` → 0 error。
Run: `python -c "import sys,yaml; [yaml.safe_load(open(f,encoding='utf-8')) for f in sys.argv[1:]]" .github/workflows/ci.yml .github/workflows/release.yml` → 无输出。
Run: `git diff --check` → 无输出。
Run: `git grep -n "opencode-tui-usage"` → 只命中 `docs/superpowers/**`、`CHANGELOG.md`、`TODO.md` 历史段。

- [ ] **Step 4: 隔离环境复验（沿用既有做法）**

Run: 在空 `OPENCODE_CONFIG_DIR` decoy 与 filled dummy decoy（只放占位 key）下各跑一遍 `node --test tests/*.test.ts`；前后比较 decoy 目录文件列表与 SHA256。
Expected: 两种环境均全绿；decoy 未被写入、未被读取成真实凭据。

- [ ] **Step 5: 记录证据（不提交）**

Run: `pwsh -NoProfile -File .superpowers/decisions-2026-11-16/task-snapshot.ps1 -Mode review -Name task-08-docs`
Expected: `review.diff`；报告写清单勾选结果、全量/隔离输出、esbuild、语法、YAML、diff 检查，以及未验证项（2.3.0 实机、真实发版、TUI 冒烟）。
