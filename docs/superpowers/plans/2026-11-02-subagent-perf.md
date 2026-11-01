# 子代理展开行首字 / 速度 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 展开某条子代理时，显示该子代理最近有效样本的首字与 token 速度（首字与速度分别回溯），口径与底部状态行完全一致。

**Architecture:** 计算复用 `model/perf.ts` 的 `latestPerf`，格式化抽到 `shared/format.ts` 的 `fmtPerf`；`Sidebar` 在展开时对子会话做一次 `message.sync` 补历史，之后靠宿主写回 Solid store 响应式更新；`SubagentSection` 只在展开区多渲染一行。

**Tech Stack:** TypeScript、Solid（`@opentui/solid`）、Node `node:test`、esbuild 语法检查。

**Spec:** `docs/superpowers/specs/2026-11-02-subagent-perf-design.md`

## Global Constraints

- **禁止轮询**：不新增 `setInterval` / `setTimeout`；`message.sync(id)` 只在展开时调用，成功后靠 `sync.run` 短路；性能 memo 不读 `subTick`。
- **共享模块，不重复造轮子**：计算用 `model/perf.ts` 的 `latestPerf`；文本拼接用 `shared/format.ts` 的 `fmtPerf`；footer 与子代理共用。
- 主行、标题行、常驻裁剪、折叠行一律不动；新内容只出现在展开区第 5 行。
- 侧边栏内宽固定 34 列；标签 4 列，值最多约 20 列。
- 无有效样本 → 整行不渲染，不显示 `--`、不显示占位。
- 测试用 `node --test tests/*.test.ts`；改完跑 esbuild 语法检查。
- 提交信息用中文。

## Review Focus

1. **没有已完成步**（子代理刚起、还在第一步）→ 不显示性能行，不能显示 `--` 或 `0`。
2. **`message.sync` 失败**（网络 / 404）→ 静默，不崩、不显示；折叠后重新展开再试。
3. **部分样本**：只有首字、只有速度、`fmtTps` 对 ≥10 取整（`48.2` → `48`）。
4. **折叠再展开**：`sync.run` 成功态短路，不重复发请求。
5. **复用的老子代理重新 running**：`step.started` 清空 `time.streamed/completed`，当前步结束前可能沿用上一步样本；结束后更新（与底部一致）。

---

### Task 1: 共享格式化 `fmtPerf`

**Files:**
- Modify: `shared/format.ts`（在 `fmtTps` 之后新增）
- Modify: `view/PerfFooter.tsx`
- Test: `tests/shared.test.ts`

**Interfaces:**
- Produces: `fmtTpsText(tps: number | undefined): string`（`48 tok/s` 或 `""`）
- Produces: `fmtPerf(ttftMs: number | undefined, tps: number | undefined): string`（`0.42s · 48 tok/s`、单项、或 `""`）

- [ ] **Step 1: 写失败测试**

在 `tests/shared.test.ts` 的 import 中加入 `fmtPerf, fmtTpsText`，并新增：

```ts
test("fmtPerf：首字与速度按底部格式拼接，缺项省略", () => {
  assert.equal(fmtPerf(420, 48), "0.42s · 48 tok/s")
  assert.equal(fmtPerf(420, undefined), "0.42s")
  assert.equal(fmtPerf(undefined, 8.4), "8.4 tok/s")
  assert.equal(fmtPerf(undefined, undefined), "")
  assert.equal(fmtTpsText(48), "48 tok/s")
  assert.equal(fmtTpsText(undefined), "")
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/shared.test.ts`
Expected: FAIL，报 `fmtPerf` / `fmtTpsText` 未导出。

- [ ] **Step 3: 实现 `shared/format.ts`**

```ts
// 速度文本：48 tok/s；无有效值返回空串（调用方据此决定是否渲染）
export function fmtTpsText(tps: number | undefined): string {
  const v = fmtTps(tps)
  return v ? `${v} tok/s` : ""
}

// 首字 + 速度（底部完整档 / 子代理展开行共用）：0.42s · 48 tok/s；缺项只留存在的
export function fmtPerf(ttftMs: number | undefined, tps: number | undefined): string {
  return [fmtSec(ttftMs), fmtTpsText(tps)].filter(Boolean).join(" · ")
}
```

- [ ] **Step 4: `PerfFooter` 复用**

把 `view/PerfFooter.tsx` 的 import 改为 `fmtPerf, fmtTpsText`，`text` memo 改为：

```ts
const text = createMemo(() =>
  level() === "full" ? fmtPerf(props.ttftMs, props.tps) : fmtTpsText(props.tps),
)
```

删除不再使用的 `fmtSec` / `fmtTps` 局部拼接。

- [ ] **Step 5: 跑测试与语法检查**

Run: `node --test tests/shared.test.ts`
Expected: PASS

Run:
```powershell
npx --yes esbuild .opencode/plugins/opencode-hud/tui.tsx --bundle --platform=node --format=esm --jsx=automatic --jsx-import-source=@opentui/solid --external:@opencode/plugin/tui --external:@opentui/solid --external:solid-js --outfile=$env:TEMP\opencode\tui-bundle-check.js
```
Expected: `Done in ...`

- [ ] **Step 6: 提交**

```bash
git add .opencode/plugins/opencode-hud/shared/format.ts .opencode/plugins/opencode-hud/view/PerfFooter.tsx tests/shared.test.ts
git commit -m "refactor: 抽取首字与速度的共用格式化"
```

---

### Task 2: `SubagentRow` 携带性能样本

**Files:**
- Modify: `model/subagent.ts`
- Test: `tests/perf.test.ts`

**Interfaces:**
- Produces: `SubagentRow.ttftMs?: number`、`SubagentRow.tps?: number`
- Produces: `buildRow(info, opts)` 的 `opts.perf?: { ttftMs?: number; tps?: number }`
- Consumes: 无（Task 3 负责传入 `latestPerf` 的结果）

- [ ] **Step 1: 写失败测试**

在 `tests/perf.test.ts` 的子代理区块新增（`buildRow` 加入 import）：

```ts
test("buildRow：透传子代理最近一步的首字与速度", () => {
  const info = {
    id: "s",
    agent: "general",
    tokens: { output: 1 },
    time: { created: 1000, idle: 5000 },
  }
  const row = buildRow(info, {
    running: false,
    expanded: true,
    now: 6000,
    perf: { ttftMs: 420, tps: 48 },
  })
  assert.equal(row.ttftMs, 420)
  assert.equal(row.tps, 48)
  assert.equal(row.expanded, true)

  const bare = buildRow(info, { running: false, expanded: false, now: 6000 })
  assert.equal(bare.ttftMs, undefined)
  assert.equal(bare.tps, undefined)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/perf.test.ts`
Expected: FAIL，`buildRow` 未导出或 `ttftMs` 不存在。

- [ ] **Step 3: 实现**

在 `SubagentRow` 增加：

```ts
  /** 该子代理最近可算样本的首字（ms）；与底部 latestPerf 同口径，无样本时 undefined */
  ttftMs?: number
  /** 该子代理最近通过守卫的速度（tok/s）；与底部 latestPerf 同口径，无样本时 undefined */
  tps?: number
```

`buildRow` 的 `opts` 增加 `perf?: { ttftMs?: number; tps?: number }`，返回值增加：

```ts
    ttftMs: opts.perf?.ttftMs,
    tps: opts.perf?.tps,
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/perf.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add .opencode/plugins/opencode-hud/model/subagent.ts tests/perf.test.ts
git commit -m "feat: 子代理行携带首字与速度样本"
```

---

### Task 3: Sidebar 按需同步与响应式取数

**Files:**
- Modify: `view/Sidebar.tsx`

**Interfaces:**
- Consumes: `ctx.data.session.message.list(id)`、`ctx.data.session.message.sync(id)`、`latestPerf`、`buildRow` 的 `perf` 参数
- Produces: 无导出；`subagentRows` 中每条已展开的行带上 `ttftMs` / `tps`

- [ ] **Step 1: 加 import**

```ts
import { latestPerf } from "../model/perf.ts"
import type { PerfMessage } from "../model/types.ts"
```

- [ ] **Step 2: 加 `subagentPerf` memo**

放在 `expanded` 信号之后、`subagentRows` 之前：

```ts
// 只对已展开的条目读子会话消息：未展开的条目不产生任何请求。
// 不读 subTick —— 性能只在步结束写回 store 时变，不跟 1s 耗时心跳重算。
const subagentPerf = createMemo<Record<string, { ttftMs?: number; tps?: number }>>(() => {
  const state = expanded()
  const out: Record<string, { ttftMs?: number; tps?: number }> = {}
  for (const id of Object.keys(state)) {
    if (state[id] !== true) continue
    out[id] = latestPerf((ctx.data.session.message.list(id) ?? []) as PerfMessage[])
  }
  return out
})
```

- [ ] **Step 3: 加同步 effect**

放在 `subagentPerf` 之后：

```ts
// 展开时才补一次子会话消息（宿主只给当前会话/标签页自动同步消息）。
// sync.run 成功后同 key 短路；失败静默，下次重新展开再试。
createEffect(() => {
  const state = expanded()
  for (const id of Object.keys(state)) {
    if (state[id] !== true) continue
    void ctx.data.session.message.sync(id).catch(() => {})
  }
})
```

- [ ] **Step 4: 把 perf 传给 `buildRow`**

在 `subagentRows` memo 开头加：

```ts
const perf = subagentPerf()
```

`buildRow` 调用改为：

```ts
return buildRow(info, {
  running,
  expanded: state[id] === true,
  now,
  prevElapsed: elapsedHigh.get(id),
  perf: perf[id],
})
```

- [ ] **Step 5: 跑测试与语法检查**

Run: `node --test tests/*.test.ts`
Expected: 全部 PASS

Run esbuild 命令（同 Task 1 Step 5）。
Expected: `Done in ...`

- [ ] **Step 6: 提交**

```bash
git add .opencode/plugins/opencode-hud/view/Sidebar.tsx
git commit -m "feat: 子代理展开时按需读取首字与速度"
```

---

### Task 4: 展开行渲染与文档同步

**Files:**
- Modify: `view/SubagentSection.tsx`
- Modify: `docs/design-subagent-section.md`
- Modify: `docs/design-performance-footer.md`
- Modify: `AGENTS.md`
- Modify: `docs/superpowers/specs/2026-11-02-subagent-perf-design.md`（状态改「已实现」）

**Interfaces:**
- Consumes: `SubagentRow.ttftMs` / `tps`（Task 2）、`fmtPerf`（Task 1）
- Produces: 展开区「性能」行

- [ ] **Step 1: 渲染「性能」行**

`view/SubagentSection.tsx` import 增加 `fmtPerf`（与现有 `shared/format.ts` 的导入合并）。在「命中」`<Show>` 之后加：

```tsx
{/* 行 5：最近有效样本的首字 / 速度（与底部同口径）；无样本时整行不渲染 */}
<Show when={fmtPerf(props.row.ttftMs, props.row.tps)}>
  {(text) => (
    <box flexDirection="row" height={1}>
      <text fg={MUTED_COLOR}>{"  性能 "}</text>
      <text fg={TEXT_COLOR}>{text()}</text>
    </box>
  )}
</Show>
```

- [ ] **Step 2: 更新子代理设计文档**

`docs/design-subagent-section.md`：

- §1 数据来源表新增：

```md
| 首字 / 速度 | 展开时 `message.sync(id)` → `message.list(id)` → `latestPerf` | 仅展开时取数；首字与速度分别回溯最近有效样本；与底部同口径 |
```

- §3 展开示例在「命中」后补：

```
    性能 0.42s · 48 tok/s
```

- §3 列预算补一句：标签 `性能` 4 列，值复用 `fmtPerf`，34 列内放得下。
- §5 已知取舍新增：每个展开条目首次一次 HTTP、20 条消息窗口、最近一步口径（不是平均）。

- [ ] **Step 3: 更新性能文档**

`docs/design-performance-footer.md` §5「不做的部分」中，把：

```md
- 侧边栏展示（落点固定在底部状态行）
```

改为：

```md
- 侧边栏主行常驻展示（展开行复用同一口径，见 `docs/design-subagent-section.md`）
```

- [ ] **Step 4: 更新 AGENTS.md 数据口径**

把「子代理只读 `session.family()` 与 `SessionInfo` 聚合列，不读子会话消息、不持久化。」改为：

```md
子代理默认只读 `session.family()` 与 `SessionInfo` 聚合列；**展开时**按需 `message.sync(id)` 读子会话消息算首字 / 速度，不轮询、不持久化。
```

- [ ] **Step 5: 规格状态**

`docs/superpowers/specs/2026-11-02-subagent-perf-design.md` 的状态改为 `**已实现**（2026-11-02）`。

- [ ] **Step 6: 全量验证**

Run: `node --test tests/*.test.ts`
Expected: 全部 PASS

Run esbuild 命令（同 Task 1 Step 5）。
Expected: `Done in ...`

Run: `rg -n "setInterval|setTimeout" .opencode/plugins/opencode-hud/view/Sidebar.tsx`
Expected: 只有现有的 3 处（spinner、耗时、额度），没有新增。

- [ ] **Step 7: 提交**

```bash
git add .opencode/plugins/opencode-hud/view/SubagentSection.tsx docs/design-subagent-section.md docs/design-performance-footer.md AGENTS.md docs/superpowers/specs/2026-11-02-subagent-perf-design.md
git commit -m "feat: 子代理展开行显示首字与速度"
```

---

### Task 5: 手动冒烟

**Files:** 无

- [ ] **Step 1: 启动本仓库的 opencode2**

在本仓库启动 opencode，进入一个已有子代理的会话。

- [ ] **Step 2: 验证展开**

- 展开运行中的子代理 → 当前步结束后出现「性能」行。
- 等下一步结束 → 数字更新。
- 折叠再展开 → 无重复请求、无报错。
- 展开没有有效样本的子代理 → 整行不渲染。
- 展开早已完成的子代理 → 首次 sync 后显示最后一步样本。

- [ ] **Step 3: 记录结果**

若某项不通过，回到对应 Task 修复；不要用定时器/轮询兜底。
