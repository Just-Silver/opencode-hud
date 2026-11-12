# 额度重置提示改为相对剩余时长 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把额度行的 `↻` 重置提示从绝对时刻（`04:31` / `周一` / `11-01`）改成相对剩余时长（`12m` / `4h12m` / `5d`），数据年龄的「刚刚」改成 `0m`。

**Architecture:** 只改 `shared/format.ts` 的两个纯函数（`fmtResetTime`、`fmtAge`）及其注释；`fmtResetHint` 前缀不变，provider / `model/quota.ts` / 渲染器全部不动（`hint` 本来就是自由文本）。

**Tech Stack:** TypeScript（Node ≥23.6 原生 strip，`node:test`），零依赖。

**Spec:** `docs/superpowers/specs/2026-11-11-quota-reset-relative-design.md`

## Global Constraints

- 全部**向下取整**：宁可少报，不让剩 59 秒显示成 `1m`。
- 小时档整点不写 `0m`：`5h`，不是 `5h0m`。
- 过期 / 非法 / 缺失一律返回 `undefined`，不得输出负值或 `NaN`。
- 不改 `fmtResetHint` 的签名与 `↻ ` 前缀，不改 `QuotaItem` 契约。
- 不改 provider、`model/quota.ts`、`renderers/bars.tsx`、刷新间隔与通知时机。
- 提交信息用中文。

## Review Focus

- 剩余 59 秒 → `0m`（不能是 `1m`；这是「向下取整」最容易被写反的一处）。
- 恰好整小时 → `5h`（不能是 `5h0m`）。
- 跨天不再出现绝对时刻：剩 23h59m → `23h59m`，而不是 `00:31` 之类的钟点。
- 已过期的 ISO → 不显示（不能出现 `-1m` 或负数天）。
- 天数向下取整：剩 29d23h → `29d`，不是 `30d`。

---

### Task 1: `fmtResetTime` 改为相对剩余时长

**Files:**
- Modify: `shared/format.ts`（`.opencode/plugins/opencode-hud/shared/format.ts:95-118`）
- Test: `tests/shared.test.ts:113-135`

**Interfaces:**
- Consumes: 无
- Produces: `fmtResetTime(iso: string | undefined, now?: Date): string | undefined`（签名不变，输出改为 `Nm` / `Nh` / `NhMMm` / `Nd`）；`fmtResetHint(iso, now?)` 行为不变（`↻ ` + `fmtResetTime`）

- [ ] **Step 1: 改测试为相对格式（应失败）**

把 `tests/shared.test.ts` 的 `fmtResetTime` 用例整段替换为：

```typescript
// ─── fmtResetTime：相对剩余时长（分 / 时 / 天，向下取整） ───
test("fmtResetTime：相对剩余时长，过期/非法不显示", () => {
  const now = new Date(2026, 9, 12, 10, 0, 0) // 本地 2026-10-12 10:00
  const at = (ms: number) => new Date(now.getTime() + ms).toISOString()
  assert.equal(fmtResetTime(at(59_000), now), "0m") // 向下取整：不满 1 分钟
  assert.equal(fmtResetTime(at(60_000), now), "1m")
  assert.equal(fmtResetTime(at(59 * 60_000), now), "59m")
  assert.equal(fmtResetTime(at(3600_000), now), "1h") // 整点不写 0m
  assert.equal(fmtResetTime(at((4 * 60 + 12) * 60_000), now), "4h12m")
  assert.equal(fmtResetTime(at((23 * 60 + 59) * 60_000), now), "23h59m")
  assert.equal(fmtResetTime(at(24 * 3600_000), now), "1d")
  assert.equal(fmtResetTime(at((29 * 24 + 23) * 3600_000), now), "29d") // 天数向下取整
  assert.equal(fmtResetTime(undefined, now), undefined)
  assert.equal(fmtResetTime("nope", now), undefined)
  assert.equal(fmtResetTime(at(-1000), now), undefined) // 已过期
})
```

并把 `fmtResetHint` 用例里的断言改为：

```typescript
  assert.equal(fmtResetHint(at(3 * 3600_000), now), "↻ 3h")
```

（`now` 与 `at` 在该用例内同样定义；其余三条 `undefined` 断言保持不变。）

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/shared.test.ts`
Expected: FAIL，`fmtResetTime` 相关断言输出 `13:00` / `周四` / `11-01` 等旧格式

- [ ] **Step 3: 实现相对格式**

在 `shared/format.ts` 中把 `WEEKDAY_CN` 与 `fmtResetTime` 一起替换为：

```typescript
export function fmtResetTime(iso: string | undefined, now: Date = new Date()): string | undefined {
  if (!iso) return undefined
  const t = new Date(iso)
  const ms = t.getTime()
  if (Number.isNaN(ms)) return undefined
  const diff = ms - now.getTime()
  if (diff <= 0) return undefined // 已到期/已重置：不显示
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(diff / 3600_000)
  if (hours < 24) {
    const rest = minutes - hours * 60
    return rest === 0 ? `${hours}h` : `${hours}h${rest}m`
  }
  return `${Math.floor(diff / 86_400_000)}d`
}
```

同时把函数上方的注释改为「分级：<60min → Nm；<24h → Nh / NhMMm；其他 → Nd；缺失/非法/已过期 → undefined（不显示）」，并删掉不再使用的 `WEEKDAY_CN` 常量。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test tests/shared.test.ts`
Expected: PASS（全部用例）

- [ ] **Step 5: 提交**

```bash
git add .opencode/plugins/opencode-hud/shared/format.ts tests/shared.test.ts
git commit -m "feat: 额度重置提示改为相对剩余时长"
```

### Task 2: 数据年龄 `0m` 取代「刚刚」，并登记设计文档

**Files:**
- Modify: `shared/format.ts`（`.opencode/plugins/opencode-hud/shared/format.ts:146-156`）
- Modify: `AGENTS.md`（文档地图一节）
- Test: `tests/shared.test.ts:143-154`

**Interfaces:**
- Consumes: 无
- Produces: `fmtAge(ms: number | undefined): string`（签名不变；`<1 分钟` 改为 `0m`）

- [ ] **Step 1: 改测试（应失败）**

把 `tests/shared.test.ts` 的 `fmtAge` 用例改为：

```typescript
// ─── fmtAge：数据新鲜度短格式 ───
test("fmtAge：0m / 分钟 / 小时 / 天（只做展示，不参与计算）", () => {
  assert.equal(fmtAge(0), "0m")
  assert.equal(fmtAge(59_000), "0m")
  assert.equal(fmtAge(60_000), "1m")
  assert.equal(fmtAge(59 * 60_000), "59m")
  assert.equal(fmtAge(60 * 60_000), "1h")
  assert.equal(fmtAge(2.44 * 3600_000), "2.4h")
  assert.equal(fmtAge(30 * 3600_000), "1d")
  assert.equal(fmtAge(undefined), "")
  assert.equal(fmtAge(-1), "")
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/shared.test.ts`
Expected: FAIL，`fmtAge(0)` 实际返回 `刚刚`

- [ ] **Step 3: 实现并更新文档**

`fmtAge` 中删除「刚刚」分支：

```typescript
export function fmtAge(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return ""
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = ms / 3_600_000
  if (hours < 24) return `${Math.round(hours * 10) / 10}h`
  return `${Math.floor(hours / 24)}d`
}
```

同时把注释里的「刚刚 / 3m / 2.4h / 3d」改为「0m / 3m / 2.4h / 3d」。

在 `AGENTS.md` 的「文档地图」中，紧跟现有的额度相关 spec 条目追加一行：

```markdown
- `docs/superpowers/specs/2026-11-11-quota-reset-relative-design.md` — 额度 `↻` 重置提示改为相对剩余时长、数据年龄 `0m` 的口径与验收。
```

- [ ] **Step 4: 运行全量校验**

Run: `node --test tests/*.test.ts`
Expected: 全部 PASS（原 188 项 + 本次改动不新增用例数）

Run:

```powershell
npx --yes esbuild .opencode/plugins/opencode-hud/tui.tsx --bundle --platform=node --format=esm --jsx=automatic --jsx-import-source=@opentui/solid --external:@opencode/plugin/tui --external:@opentui/solid --external:solid-js --outfile=$env:TEMP\opencode\tui-bundle-check.js
```

Expected: `Done in` 且无 error

- [ ] **Step 5: 提交**

```bash
git add .opencode/plugins/opencode-hud/shared/format.ts tests/shared.test.ts AGENTS.md
git commit -m "feat: 数据年龄以 0m 起步，登记额度重置口径文档"
```
