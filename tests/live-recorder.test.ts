// ─── live/recorder.ts 单元测试（离线，假宿主 + 假时钟） ───
import { test } from "node:test"
import assert from "node:assert/strict"
import { createRecorder, previousPerf, type HostLike } from "../.opencode/plugins/opencode-tui-usage/live/recorder.ts"
import { bucketKey, createCoefficientBook, predictTokens } from "../.opencode/plugins/opencode-tui-usage/model/calibration.ts"
import type { PerfMessage } from "../.opencode/plugins/opencode-tui-usage/model/types.ts"

// 假宿主：事件总线 + 会话状态 + 消息列表，全部可控
function fakeHost(init: {
  status?: "idle" | "running"
  messages?: PerfMessage[]
} = {}) {
  const handlers = new Map<string, Set<(e: unknown) => void>>()
  let status = init.status ?? "idle"
  let messages = init.messages ?? ([] as PerfMessage[])
  const host: HostLike = {
    data: {
      on(type, handler) {
        const set = handlers.get(type) ?? new Set()
        set.add(handler)
        handlers.set(type, set)
        return () => set.delete(handler)
      },
      session: {
        status: () => status,
        message: { list: () => messages },
      },
    },
  }
  return {
    host,
    emit(type: string, event: unknown) {
      for (const handler of handlers.get(type) ?? []) handler(event)
    },
    setStatus(next: "idle" | "running") {
      status = next
    },
    setMessages(next: PerfMessage[]) {
      messages = next
    },
    handlerCount(type: string) {
      return handlers.get(type)?.size ?? 0
    },
  }
}

const runningMessage = (over: Partial<PerfMessage> = {}): PerfMessage => ({
  id: "m1",
  type: "assistant",
  time: { created: 1000 },
  tokens: { output: 0 },
  content: [{ type: "reasoning", text: "abc", time: { created: 1500 } }],
  ...over,
})

test("started 事件记录首字时刻；同消息只记第一次", () => {
  const fake = fakeHost()
  let changes = 0
  const rec = createRecorder(fake.host, () => changes++, { now: () => 5000 })

  fake.emit("session.text.started", { created: 1500, data: { assistantMessageID: "m1" } })
  assert.equal(rec.firstOutput("m1"), 1500)

  fake.emit("session.reasoning.started", { created: 1200, data: { assistantMessageID: "m1" } })
  assert.equal(rec.firstOutput("m1"), 1500, "已有记录时不覆盖")

  rec.dispose()
})

test("非 started 形状的事件不写入（缺 id 或 created）", () => {
  const fake = fakeHost()
  const rec = createRecorder(fake.host, () => {}, { now: () => 0 })
  fake.emit("session.text.started", { created: 1500 })
  fake.emit("session.text.started", { data: { assistantMessageID: "m1" } })
  assert.equal(rec.firstOutput("m1"), undefined)
  rec.dispose()
})

test("delta 事件经节流触发刷新（不逐条触发）", async () => {
  const fake = fakeHost()
  let changes = 0
  const rec = createRecorder(fake.host, () => changes++, { now: () => 0 })
  for (let i = 0; i < 20; i++) fake.emit("session.text.delta", {})
  assert.equal(changes, 1, "首条立即触发")
  await new Promise((r) => setTimeout(r, 150))
  assert.equal(changes, 2, "尾沿补一次")
  rec.dispose()
})

test("相位事件立即刷新，不经节流", () => {
  const fake = fakeHost()
  let changes = 0
  const rec = createRecorder(fake.host, () => changes++, { now: () => 0 })
  fake.emit("session.tool.called", {})
  fake.emit("session.step.ended", {})
  assert.equal(changes, 2)
  rec.dispose()
})

test("dispose 后退订全部事件，不再回调", () => {
  const fake = fakeHost()
  let changes = 0
  const rec = createRecorder(fake.host, () => changes++, { now: () => 0 })
  rec.dispose()
  fake.emit("session.text.started", { created: 1, data: { assistantMessageID: "m1" } })
  fake.emit("session.tool.called", {})
  assert.equal(changes, 0)
  assert.equal(fake.handlerCount("session.text.started"), 0)
})

test("live：非 running 会话返回 undefined", () => {
  const fake = fakeHost({ status: "idle", messages: [runningMessage()] })
  const rec = createRecorder(fake.host, () => {}, { now: () => 5000 })
  assert.equal(rec.live("s1"), undefined)
  rec.dispose()
})

test("live：running 时返回当前步实时值（首字来自事件）", () => {
  const fake = fakeHost({ status: "running", messages: [runningMessage()] })
  const rec = createRecorder(fake.host, () => {}, { now: () => 4500 })

  const withoutEvent = rec.live("s1")!
  assert.equal(withoutEvent.phase, "streaming")
  assert.equal(withoutEvent.ttftMs, 500, "兜底用 part 的 time.created")

  fake.emit("session.text.started", { created: 1300, data: { assistantMessageID: "m1" } })
  const withEvent = rec.live("s1")!
  assert.equal(withEvent.ttftMs, 300, "事件记录的时刻优先")
  rec.dispose()
})

test("live：出错或最终消息非 assistant → undefined", () => {
  const fake = fakeHost({
    status: "running",
    messages: [runningMessage({ error: "boom" })],
  })
  const rec = createRecorder(fake.host, () => {}, { now: () => 5000 })
  assert.equal(rec.live("s1"), undefined)

  fake.setMessages([{ id: "u1", type: "user" }])
  assert.equal(rec.live("s1"), undefined)
  rec.dispose()
})

test("previousPerf：跨回合不借速度（user 消息即停）", () => {
  const prev: PerfMessage = {
    id: "m0",
    type: "assistant",
    time: { created: 100, completed: 4100 },
    tokens: { output: 200 },
    content: [{ type: "reasoning", text: "x", time: { created: 600 } }],
  }
  const current: PerfMessage = { id: "m2", type: "assistant" }

  // 同回合：能借到
  const same = previousPerf([prev, { id: "m1", type: "assistant" }, current], "m2")
  assert.ok(same?.tps !== undefined)

  // 中间隔着 user：借不到
  const nextTurn = previousPerf([prev, { id: "u1", type: "user" }, current], "m2")
  assert.equal(nextTurn, undefined)
})

test("track：仅 running 时建心跳，转 idle 自动停", async () => {
  const fake = fakeHost({ status: "running", messages: [runningMessage()] })
  let changes = 0
  const rec = createRecorder(fake.host, () => changes++, { now: () => Date.now() })

  rec.track("s1")
  await new Promise((r) => setTimeout(r, 300))
  assert.ok(changes >= 1, "心跳应触发刷新")

  const before = changes
  fake.setStatus("idle")
  await new Promise((r) => setTimeout(r, 400))
  const after = changes
  assert.ok(after - before <= 2, "转 idle 后心跳停止（至多补一次）")
  rec.dispose()
})

test("live：当前步已完成 → undefined（交回精确值，不跨步继续衰减）", () => {
  const fake = fakeHost({
    status: "running",
    messages: [runningMessage({ time: { created: 1000, completed: 5000 } })],
  })
  const rec = createRecorder(fake.host, () => {}, { now: () => 9000 })
  assert.equal(rec.live("s1"), undefined)
  rec.dispose()
})

test("回归：工具相位没有冻结值时沿用本回合最近速度，不回落更早样本", () => {
  const prev: PerfMessage = {
    id: "m0",
    type: "assistant",
    time: { created: 100, completed: 4100 },
    tokens: { output: 200 },
    content: [{ type: "reasoning", text: "x", time: { created: 600 } }],
  }
  const withTool: PerfMessage = {
    id: "m2",
    type: "assistant",
    time: { created: 5000 },
    content: [
      { type: "reasoning", text: "abc", time: { created: 5500 } },
      { type: "tool", state: { status: "running" }, time: { created: 6000, ran: 6000 } },
    ],
  }
  const fake = fakeHost({ status: "running", messages: [prev, withTool] })
  const rec = createRecorder(fake.host, () => {}, { now: () => 8000 })
  // 上一步 200 tok / 3500ms ≈ 57 tok/s
  assert.equal(Math.round(rec.live("s1")!.tps!), 57)
  rec.dispose()
})

// ── 冻结回归：工具执行期速度必须完全不动 ──
test("回归：工具执行期速度完全冻结（不随 now 变化）", () => {
  let clock = 10_000
  const fake = fakeHost()
  const rec = createRecorder(fake.host, () => {}, { now: () => clock })

  // 生成中：让速度算出一个值
  const streaming: PerfMessage = {
    id: "m1",
    type: "assistant",
    time: { created: 1000 },
    content: [{ type: "reasoning", text: "a".repeat(400 * 3), time: { created: 1500 } }],
  }
  fake.setStatus("running")
  fake.setMessages([streaming])
  rec.live("s1")
  clock += 1000
  fake.setMessages([{ ...streaming, content: [{ type: "reasoning", text: "a".repeat(400 * 6), time: { created: 1500 } }] }])
  const beforeTool = rec.live("s1")!
  assert.ok(beforeTool.tps !== undefined && beforeTool.tps > 0, "工具前应有速度")

  // 进入工具执行（ran 已写、completed 未写）
  const withTool: PerfMessage = {
    ...streaming,
    content: [
      { type: "reasoning", text: "a".repeat(400 * 6), time: { created: 1500 } },
      { type: "tool", state: { status: "running" }, time: { created: 3500, ran: 3500 } },
    ],
  }
  fake.setMessages([withTool])
  const t1 = rec.live("s1")!
  assert.equal(t1.phase, "tool")
  assert.equal(t1.tps, beforeTool.tps, "冻结值 = 进入工具前一刻的值")

  // 时间推进 30 秒，冻结值必须一字不变
  for (let i = 0; i < 10; i++) {
    clock += 3000
    assert.equal(rec.live("s1")!.tps, beforeTool.tps, "工具执行期速度不得变化")
  }
  rec.dispose()
})

test("回归：首字不冻结也不随 now 变化", () => {
  let clock = 5000
  const fake = fakeHost()
  const rec = createRecorder(fake.host, () => {}, { now: () => clock })
  const message: PerfMessage = {
    id: "m1",
    type: "assistant",
    time: { created: 1000 },
    content: [
      { type: "reasoning", text: "abc", time: { created: 1500 } },
      { type: "tool", state: { status: "running" }, time: { created: 3000, ran: 3000 } },
    ],
  }
  fake.setStatus("running")
  fake.setMessages([message])

  const first = rec.live("s1")!
  assert.equal(first.ttftMs, 500) // 1500 − 1000
  for (let i = 0; i < 5; i++) {
    clock += 2000
    assert.equal(rec.live("s1")!.ttftMs, 500, "首字是常量")
  }
  rec.dispose()
})

// ─── 系数学习接入：真实 token 反哺估算 ───
test("学习：已结束的步用真实 token 反哺，估算随之变准", () => {
  const book = createCoefficientBook()
  const key = bucketKey("p", "m")
  const fake = fakeHost({ status: "running" })

  // 构造若干已结束的步：800 个 ASCII 字母 + 1 次工具，真实 250 tok
  const done: PerfMessage[] = []
  for (let i = 0; i < 120; i++) {
    done.push({
      id: `h${i}`,
      type: "assistant",
      time: { created: 1000 + i * 100, completed: 1500 + i * 100 },
      tokens: { output: 250, reasoning: 0 },
      model: { providerID: "p", id: "m" },
      content: [
        { type: "text", text: "a".repeat(800), time: { created: 1400 + i * 100 } },
        { type: "tool", state: { input: {} }, time: { created: 1400 + i * 100 } },
      ],
    })
  }
  fake.setMessages(done)
  const rec = createRecorder(fake.host, () => {}, { now: () => 99999, book })

  const before = predictTokens(book.coefficient(key), {
    counts: { letter: 800, digit: 0, punct: 0, cjk: 0 },
    tools: 1,
  })
  rec.live("s1")
  const after = predictTokens(book.coefficient(key), {
    counts: { letter: 800, digit: 0, punct: 0, cjk: 0 },
    tools: 1,
  })
  rec.dispose()

  assert.notEqual(after, before, "学习后系数应改变")
  assert.ok(Math.abs(after / 250 - 1) < 0.15, `学习后估算 ${after.toFixed(0)} 应接近真实 250`)
})

test("学习：同一步重复 live() 不会重复计入", () => {
  const book = createCoefficientBook()
  const fake = fakeHost({ status: "running" })
  const msg: PerfMessage = {
    id: "m1",
    type: "assistant",
    time: { created: 1000, completed: 2000 },
    tokens: { output: 100, reasoning: 0 },
    model: { providerID: "p", id: "m" },
    content: [{ type: "text", text: "a".repeat(300), time: { created: 1500 } }],
  }
  fake.setMessages([msg])
  const rec = createRecorder(fake.host, () => {}, { now: () => 99999, book })
  for (let i = 0; i < 5; i++) rec.live("s1")
  rec.dispose()
  assert.equal(book.sentinel(bucketKey("p", "m")).samples, 1, "同一步只应计入一次")
})

test("学习：未结束的步不学习（等 tokens 写回）", () => {
  const book = createCoefficientBook()
  const fake = fakeHost({ status: "running" })
  fake.setMessages([
    {
      id: "m1",
      type: "assistant",
      time: { created: 1000 }, // 无 completed
      tokens: { output: 100 },
      model: { providerID: "p", id: "m" },
      content: [{ type: "text", text: "a".repeat(300), time: { created: 1500 } }],
    },
  ])
  const rec = createRecorder(fake.host, () => {}, { now: () => 5000, book })
  rec.live("s1")
  rec.dispose()
  assert.equal(book.sentinel(bucketKey("p", "m")).samples, 0, "未完成不计入学习")
})

// ─── 事件驱动学习：step.ended 自带 tokens ───
test("学习：step.ended 事件立即反哺，不必等消息列表标记完成", () => {
  const book = createCoefficientBook()
  const key = bucketKey("p", "m")
  const fake = fakeHost({ status: "running" })
  // 消息尚未标记 completed（投影滞后），但 step.ended 已经带 tokens
  fake.setMessages([
    {
      id: "m1",
      type: "assistant",
      time: { created: 1000 }, // 无 completed
      tokens: { output: 0 },
      model: { providerID: "p", id: "m" },
      content: [{ type: "text", text: "a".repeat(400), time: { created: 1500 } }],
    },
  ])
  const rec = createRecorder(fake.host, () => {}, { now: () => 5000, book })
  fake.emit("session.step.ended", {
    created: 5000,
    data: { sessionID: "s1", assistantMessageID: "m1", tokens: { output: 100, reasoning: 0 } },
  })
  rec.dispose()
  assert.equal(book.sentinel(key).samples, 1, "事件驱动应立即学到一条")
})

test("学习：step.ended 与后续列表轮询不会重复计入同一步", () => {
  const book = createCoefficientBook()
  const key = bucketKey("p", "m")
  const fake = fakeHost({ status: "running" })
  const msg: PerfMessage = {
    id: "m1",
    type: "assistant",
    time: { created: 1000 },
    tokens: { output: 0 },
    model: { providerID: "p", id: "m" },
    content: [{ type: "text", text: "a".repeat(400), time: { created: 1500 } }],
  }
  fake.setMessages([msg])
  const rec = createRecorder(fake.host, () => {}, { now: () => 5000, book })

  fake.emit("session.step.ended", {
    created: 5000,
    data: { sessionID: "s1", assistantMessageID: "m1", tokens: { output: 100, reasoning: 0 } },
  })
  // 之后列表刷新（completed + tokens 都写回），再走一次 live() 的轮询路径
  fake.setMessages([{ ...msg, time: { created: 1000, completed: 4500 }, tokens: { output: 100, reasoning: 0 } }])
  rec.live("s1")
  rec.dispose()
  assert.equal(book.sentinel(key).samples, 1, "同一步只应计入一次")
})

test("学习：step.ended 缺 tokens 或消息未找到时不学（不猜）", () => {
  const book = createCoefficientBook()
  const fake = fakeHost({ status: "running" })
  fake.setMessages([])
  const rec = createRecorder(fake.host, () => {}, { now: () => 5000, book })
  // 缺 tokens
  fake.emit("session.step.ended", { data: { sessionID: "s1", assistantMessageID: "m1" } })
  // 有 tokens 但消息列表里没有该步（拿不到特征）
  fake.emit("session.step.ended", { data: { sessionID: "s1", assistantMessageID: "m2", tokens: { output: 50 } } })
  rec.dispose()
  assert.equal(book.sentinel(bucketKey("p", "m")).samples, 0)
})

// ─── 安全网：检测当帧不得采用「按旧模型算出的」错值 ───
test("安全网：速率突降时 1 秒内自动纠正（检测前允许短暂滞后）", () => {
  // 稳定 120 tok/s 让滤波器收敛，然后骤降到 25 tok/s（无事件通知）。
  // 真实行为：检测需要累积几次偏置，检测到之前会短暂沿用旧值——这是安全网的固有
  // 滞后（实测约 0.75s），不是缺陷；要求的是「1 秒内纠正到真值附近」。
  const fake = fakeHost({ status: "running" })
  const book = createCoefficientBook()
  const CHARS_PER_TOKEN = 4
  let text = ""
  let now = 1792500000000
  const rec = createRecorder(fake.host, () => {}, { now: () => now, book })
  const shown: (number | undefined)[] = []

  const push = (t: number, chars: number) => {
    now = 1792500000000 + t
    text += "a".repeat(chars)
    fake.setMessages([{
      id: "cur", type: "assistant",
      time: { created: 1792500000000 },
      tokens: { output: 0 },
      model: { providerID: "p", id: "m" },
      content: [{ type: "reasoning", text, time: { created: 1792500000050 } }],
    }])
    return rec.live("s1")
  }

  for (let t = 0; t < 12000; t += 250) push(t, Math.round((120 * 250) / 1000) * CHARS_PER_TOKEN)
  for (let t = 12000; t < 16000; t += 250) shown.push(push(t, Math.round((25 * 250) / 1000) * CHARS_PER_TOKEN)?.tps)
  rec.dispose()

  const defined = shown.filter((v) => v !== undefined) as number[]
  assert.ok(defined.length >= 8, "应有足够读数")
  // 1 秒（4 个采样）之内必须纠正
  const within1s = defined.slice(0, 4).filter((v) => Math.abs(v / 25 - 1) < 0.25)
  assert.ok(within1s.length > 0, `前 1 秒内应已纠正，实际 ${defined.slice(0, 4).map((v) => v.toFixed(0)).join(",")}`)
  // 且迟迟不纠正即为缺陷：2 秒后必须稳定在真值
  const later = defined.slice(8)
  for (const v of later) assert.ok(Math.abs(v / 25 - 1) < 0.25, `2 秒后读数 ${v.toFixed(1)} 应接近 25`)
})
