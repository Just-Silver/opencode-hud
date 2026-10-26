// ─── model/perf.ts 纯函数单元测试（离线，构造假消息） ───
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  computePerfSample,
  firstContentStart,
  latestPerf,
  mergedIntervalMs,
  subagentElapsedMs,
  subagentEndedAt,
  subagentTokens,
  toolIntervals,
} from "../.opencode/plugins/opencode-tui-usage/model/perf.ts"
import type { PerfMessage } from "../.opencode/plugins/opencode-tui-usage/model/types.ts"
import {
  clampElapsed,
  SPINNER_FRAMES,
  sortRows,
  statusGlyph,
  statusLights,
  subagentCacheRate,
  totalTokensText,
  visibleRows,
  type SubagentRow,
} from "../.opencode/plugins/opencode-tui-usage/model/subagent.ts"
import { calcCacheRate } from "../.opencode/plugins/opencode-tui-usage/model/usage.ts"

const assistant = (over: Partial<PerfMessage> = {}): PerfMessage => ({
  type: "assistant",
  time: { created: 1000, streamed: 4900, completed: 5000 },
  tokens: { output: 200, reasoning: 0 },
  content: [{ type: "reasoning", text: "x", time: { created: 1500 } }],
  ...over,
})

// ─── mergedIntervalMs ───
test("mergedIntervalMs：重叠区间只算一次", () => {
  assert.equal(mergedIntervalMs([[100, 200], [150, 250]], 0), 150)
  assert.equal(mergedIntervalMs([[100, 200], [300, 400]], 0), 200)
  assert.equal(mergedIntervalMs([], 0), 0)
})

test("mergedIntervalMs：钳位到窗口，窗口外不计", () => {
  assert.equal(mergedIntervalMs([[100, 200]], 150), 50)
  assert.equal(mergedIntervalMs([[100, 200]], 0, 120), 20)
  assert.equal(mergedIntervalMs([[100, 200]], 300), 0)
})

// ─── toolIntervals / firstContentStart ───
test("toolIntervals：只收已完成工具，未结束的忽略", () => {
  const parts = [
    { type: "tool", time: { created: 1100, ran: 1200, completed: 1500 } },
    { type: "tool", time: { created: 1100, ran: 1200 } },
    { type: "text", time: { created: 1100 } },
  ]
  assert.deepEqual(toolIntervals(parts), [[1200, 1500]])
})

test("firstContentStart：取最早内容 part（text 无时间戳，靠 reasoning/tool）", () => {
  assert.equal(firstContentStart([{ type: "text", text: "a" }]), undefined)
  assert.equal(
    firstContentStart([
      { type: "reasoning", time: { created: 1500 } },
      { type: "tool", time: { created: 1300 } },
    ]),
    1300,
  )
})

// ─── computePerfSample ───
test("computePerfSample：首字 = 首个内容 − 创建；速度分母扣工具", () => {
  const m = assistant({
    content: [
      { type: "reasoning", text: "x", time: { created: 1500 } },
      { type: "tool", time: { created: 2000, ran: 2000, completed: 3000 } },
    ],
  })
  const s = computePerfSample(m)!
  assert.equal(s.ttftMs, 500) // 1500 − 1000
  // gen = 5000 − 1500 − 1000 = 2500ms，200 tok → 80 tok/s
  assert.equal(Math.round(s.tps!), 80)
})

test("computePerfSample：并行工具重叠区间只扣一次", () => {
  const m = assistant({
    content: [
      { type: "reasoning", text: "x", time: { created: 1500 } },
      { type: "tool", time: { ran: 2000, completed: 3000 } },
      { type: "tool", time: { ran: 2500, completed: 3500 } },
    ],
  })
  // 工具并集 2000~3500 = 1500ms；gen = 5000 − 1500 − 1500 = 2000ms → 100 tok/s
  assert.equal(Math.round(computePerfSample(m)!.tps!), 100)
})

test("computePerfSample：未完成/出错/无产出 → undefined", () => {
  assert.equal(computePerfSample(assistant({ time: { created: 1000 } })), undefined)
  assert.equal(computePerfSample(assistant({ error: "boom" })), undefined)
  assert.equal(computePerfSample(assistant({ tokens: { output: 0 } })), undefined)
  assert.equal(
    computePerfSample(assistant({ content: [{ type: "text", text: "a" }] })),
    undefined, // 无时间戳可用
  )
})

test("computePerfSample：短窗口被守卫拦下（速度缺失，首字仍有）", () => {
  const m = assistant({
    time: { created: 1000, streamed: 1150, completed: 1200 },
    content: [{ type: "reasoning", text: "x", time: { created: 1100 } }],
    tokens: { output: 10 },
  })
  const s = computePerfSample(m)!
  assert.equal(s.ttftMs, 100)
  assert.equal(s.tps, undefined)
})

test("computePerfSample：增量跨度 <200ms → 不出速度（与速度大小无关）", () => {
  // 跨度 100ms（1500→1600），净生成 3.5s、200 tok 只有 57 tok/s —— 仍视为“观测不到持续流”
  const m = assistant({
    time: { created: 1000, streamed: 1600, completed: 5000 },
    content: [{ type: "reasoning", text: "x", time: { created: 1500 } }],
  })
  const s = computePerfSample(m)!
  assert.equal(s.ttftMs, 500)
  assert.equal(s.tps, undefined)
})

test("computePerfSample：跨度够长时没有速度上限（>1000 tok/s 照常显示）", () => {
  // 跨度 300ms、净生成 300ms、500 tok → 1666 tok/s
  const m = assistant({
    time: { created: 1000, streamed: 1800, completed: 1800 },
    content: [{ type: "reasoning", text: "x", time: { created: 1500 } }],
    tokens: { output: 500 },
  })
  assert.equal(Math.round(computePerfSample(m)!.tps!), 1667)
})

test("computePerfSample：缺 time.streamed → 无法判定增量，不出速度", () => {
  const m = assistant({ time: { created: 1000, completed: 5000 } })
  const s = computePerfSample(m)!
  assert.equal(s.ttftMs, 500)
  assert.equal(s.tps, undefined)
})

// ─── latestPerf ───
test("latestPerf：首字与速度分别回溯最近有效值", () => {
  const messages: PerfMessage[] = [
    assistant({ time: { created: 1000, streamed: 4900, completed: 5000 } }),
    assistant({
      time: { created: 6000, streamed: 6100, completed: 6200 }, // 跨度 <200ms，速度被守卫拦下
      content: [{ type: "reasoning", text: "x", time: { created: 6100 } }],
      tokens: { output: 10 },
    }),
  ]
  const out = latestPerf(messages)
  assert.equal(out.ttftMs, 100) // 最后一条自身有效
  assert.equal(Math.round(out.tps!), 57) // 回退到上一条：200 / 3500ms
})

// ─── 子代理 ───
test("subagentTokens：含缓存读的总消耗", () => {
  assert.equal(
    subagentTokens({ input: 100, output: 50, reasoning: 20, cache: { read: 1000, write: 30 } }),
    1200,
  )
  assert.equal(subagentTokens(undefined), 0)
})

test("subagentElapsedMs：运行中按 now，结束后用 idle、回退 updated", () => {
  const time = { created: 1000, updated: 9000, idle: 6000 }
  assert.equal(subagentElapsedMs(time, true, 4000), 3000) // now − created
  assert.equal(subagentElapsedMs(time, false, 4000), 5000) // idle − created
  assert.equal(subagentElapsedMs({ created: 1000, updated: 6000 }, false, 4000), 5000)
  assert.equal(subagentElapsedMs({ created: 1000 }, false, 4000), undefined)
  assert.equal(subagentElapsedMs(undefined, false, 4000), undefined)
})

// ── 子代理区块：标题后缀与合计（纯函数） ──
test("子代理状态指示灯：运行中数与已停止数（不显示 0 的灯在渲染层做）", () => {
  const mk = (running: boolean): SubagentRow => ({
    id: "s", agent: "general", tokens: 1, running, expanded: false,
  })
  assert.deepEqual(statusLights([mk(false), mk(false), mk(true)]), { running: 1, done: 2 })
  assert.deepEqual(statusLights([mk(true), mk(true)]), { running: 2, done: 0 })
  assert.deepEqual(statusLights([mk(false)]), { running: 0, done: 1 })
  assert.equal(statusLights([]), undefined)
})

test("子代理合计：各条真实累计消耗相加（含缓存读）", () => {
  const row = (tokens: number): SubagentRow => ({
    id: "s", agent: "general", tokens, running: false, expanded: false,
  })
  assert.equal(totalTokensText([row(13_064_289), row(4_281_482), row(350_544)]), "17.7M")
  assert.equal(totalTokensText([row(0)]), undefined)
  assert.equal(totalTokensText([]), undefined)
})

// ── 子代理缓存命中率：与会话区块同一口径 ──
test("subagentCacheRate：read / (input + write + read)", () => {
  // 实测：最终审查三库拆分 input 203278 / read 12294656 / write 0 → 98.4%
  assert.equal(subagentCacheRate({ input: 203278, cache: { read: 12294656, write: 0 } }), 98.4)
  assert.equal(subagentCacheRate({ input: 43685, cache: { read: 281728 } }), 86.6)
  // 无缓存数据 → 不猜
  assert.equal(subagentCacheRate({ input: 100 }), 0)
  assert.equal(subagentCacheRate(undefined), undefined)
})

test("calcCacheRate 与 subagentCacheRate 口径一致", () => {
  const tokens = { input: 1000, cache: { read: 3000, write: 1000 } }
  const session = calcCacheRate({ input: 1000, output: 0, reasoning: 0, read: 3000, write: 1000, total: 5000 })
  assert.equal(subagentCacheRate(tokens), session)
})

// ── 子代理耗时高水位：步骤边界的 idle 旧值不得把数字拉回去 ──
test("clampElapsed：耗时单调不减（钳住步骤边界的回跳）", () => {
  // 首次无历史 → 直接采用
  assert.equal(clampElapsed(undefined, 78_000), 78_000)
  // 同一行从 1m19s 回跳到 57s（idle 是上一轮旧值）→ 保持 1m19s
  assert.equal(clampElapsed(79_000, 57_000), 79_000)
  // 正常增长 → 采用新值
  assert.equal(clampElapsed(79_000, 80_000), 80_000)
  // 本轮算不出（缺 created）→ 沿用高水位，不退化成空
  assert.equal(clampElapsed(79_000, undefined), 79_000)
  assert.equal(clampElapsed(undefined, undefined), undefined)
})

// ── 运行中条目的 spinner 字形 ──
test("statusGlyph：运行中按帧旋转，停止时固定为状态点", () => {
  assert.equal(statusGlyph(true, 0), "⠋")
  assert.equal(statusGlyph(true, 1), "⠙")
  assert.equal(statusGlyph(true, 9), "⠏")
  // 循环回绕
  assert.equal(statusGlyph(true, 10), "⠋")
  assert.equal(statusGlyph(true, 25), "⠴") // 25 % 10 = 5
  // 停止（含完成/中断）不旋转
  assert.equal(statusGlyph(false, 0), "●")
  assert.equal(statusGlyph(false, 7), "●")
  // 每帧至少占 1 列，否则会挤动标题列
  for (const f of SPINNER_FRAMES) assert.equal([...f].length, 1)
})

// ── 子代理排序与常驻裁剪 ──
test("subagentEndedAt：结束时刻取 idle 优先，运行中不参与已完成排序", () => {
  assert.equal(subagentEndedAt({ created: 1000, updated: 9000, idle: 6000 }, false), 6000)
  assert.equal(subagentEndedAt({ created: 1000, updated: 9000 }, false), 9000)
  assert.equal(subagentEndedAt({ created: 1000 }, false), 1000)
  // 运行中被复用的老子代理：旧的 idle 不能让它混进「最近完成」
  assert.equal(subagentEndedAt({ created: 1000, updated: 9000, idle: 6000 }, true), undefined)
  assert.equal(subagentEndedAt(undefined, false), undefined)
})

test("sortRows：已完成按结束时刻倒序，耗时长的老任务不再压住新完成的", () => {
  const row = (id: string, running: boolean, elapsedMs: number, endedAt?: number): SubagentRow => ({
    id, agent: "general", tokens: 1, running, expanded: false, elapsedMs, endedAt,
  })
  const sorted = sortRows([
    row("old-long", false, 3_480_000, 1000), // 58m 但很早完成
    row("new-short", false, 120_000, 9000), // 2m 但刚完成
    row("idle-a", true, 60_000),
    row("idle-b", true, 300_000),
  ])
  assert.deepEqual(sorted.map((r) => r.id), ["idle-b", "idle-a", "new-short", "old-long"])
})

test("visibleRows：运行中不设上限，已完成只留最近 N 条", () => {
  const row = (id: string, running: boolean, endedAt?: number): SubagentRow => ({
    id, agent: "general", tokens: 1, running, expanded: false, endedAt,
  })
  const rows = sortRows([
    row("done-1", false, 1000),
    row("done-2", false, 6000),
    row("done-3", false, 5000),
    row("done-4", false, 4000),
    row("done-5", false, 3000),
    row("done-6", false, 2000),
    row("run-a", true),
    row("run-b", true),
  ])
  const { head, tail } = visibleRows(rows, 5)
  // 运行中全留；已完成按结束时刻取最新的 5 条（6 条里丢掉最老的 done-1）
  assert.deepEqual(head.map((r) => r.id), ["run-a", "run-b", "done-2", "done-3", "done-4", "done-5", "done-6"])
  assert.deepEqual(tail.map((r) => r.id), ["done-1"])
  // 折叠段顺序即列表续排，拼接回去与原序列一致
  assert.deepEqual([...head, ...tail].map((r) => r.id), rows.map((r) => r.id))
})

test("visibleRows：运行中条数超过上限时也全部保留（复用的老子代理不被藏起）", () => {
  const row = (id: string, running: boolean, endedAt?: number): SubagentRow => ({
    id, agent: "general", tokens: 1, running, expanded: false, endedAt,
  })
  const rows = sortRows([
    row("done-old", false, 1000),
    row("done-new", false, 2000),
    row("run-a", true),
    row("run-b", true),
    row("run-c", true),
  ])
  const { head, tail } = visibleRows(rows, 1)
  assert.deepEqual(head.map((r) => r.id), ["run-a", "run-b", "run-c", "done-new"])
  assert.deepEqual(tail.map((r) => r.id), ["done-old"])
})
