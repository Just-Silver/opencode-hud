// ─── ViewModel 片段：子代理列表 ───
// 结构数据来自 SessionInfo（宿主聚合列）；首字/速度只对「展开中 或 运行中」的条目按需读子会话消息。
// 心跳策略：仅存在运行中条目时开两条 interval（80ms 动画帧 / 1s 耗时），全 idle 立即停。
import { createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { usePlugin } from "@opencode/plugin/tui"
import type { PerfMessage, SubagentInfo } from "../../model/types.ts"
import { latestPerf } from "../../model/perf.ts"
import { buildRow, runningProviderIDs, sortRows, SPINNER_INTERVAL_MS, type SubagentRow } from "../../model/subagent.ts"

export function useSubagents(sessionID: string | undefined) {
  const ctx = usePlugin()

  // 逐条展开态：组件级（侧边栏随会话重建，展开态不跨会话复用）
  const [expanded, setExpanded] = createSignal<Record<string, boolean>>({})
  const [subTick, setSubTick] = createSignal(0)

  // family() 已包含全部子会话（只增不减），去掉自身
  const subagentIds = createMemo<string[]>(() => {
    if (!sessionID) return []
    const family = ctx.data.session.family(sessionID) ?? []
    return family.filter((id: string) => id !== sessionID)
  })

  // 需要读子会话消息的条目：已展开的 ∪ 运行中的。
  // 运行中条目要在常驻行显示首字/速度，所以不能只按展开态取消息。
  // 逐秒重算，但内容相等时复用上一轮数组引用，避免下游 perf/effect 每秒重跑一边。
  const perfTargets = createMemo<string[]>(
    () => {
      void subTick()
      const state = expanded()
      const out: string[] = []
      for (const id of subagentIds()) {
        if (state[id] === true || ctx.data.session.status(id) === "running") out.push(id)
      }
      return out
    },
    undefined,
    { equals: (a, b) => a.length === b.length && a.every((v, i) => v === b[i]) },
  )

  // 只对需要展示性能的条目读子会话消息：其余条目（未展开且已结束）不产生任何请求。
  // 不读 subTick —— 性能只在步结束写回 store 时变，不跟 1s 耗时心跳重算。
  const subagentPerf = createMemo<Record<string, { ttftMs?: number; tps?: number }>>(() => {
    const out: Record<string, { ttftMs?: number; tps?: number }> = {}
    for (const id of perfTargets()) {
      out[id] = latestPerf((ctx.data.session.message.list(id) ?? []) as PerfMessage[])
    }
    return out
  })

  // 展开 / 运行中时补一次子会话消息（宿主只给当前会话/标签页自动同步消息）。
  // sync.run 成功后同 key 短路；失败静默，下次重算再试。
  createEffect(() => {
    for (const id of perfTargets()) void ctx.data.session.message.sync(id).catch(() => {})
  })

  // 耗时高水位：跨 memo 重算保留，避免步骤边界的 idle 旧值把分钟数拉回去
  const elapsedHigh = new Map<string, number>()

  const rows = createMemo<SubagentRow[]>(() => {
    void subTick() // 运行中条目靠它刷新耗时
    const now = Date.now()
    const state = expanded()
    const perf = subagentPerf()
    const list: SubagentRow[] = []
    for (const id of subagentIds()) {
      const info = ctx.data.session.get(id) as SubagentInfo | undefined
      if (!info) continue
      list.push(
        buildRow(info, {
          running: ctx.data.session.status(id) === "running",
          expanded: state[id] === true,
          now,
          prevElapsed: elapsedHigh.get(id),
          perf: perf[id],
        }),
      )
    }
    // 记录本轮高水位，供下一次重算钳位
    for (const row of list) {
      if (row.elapsedMs !== undefined) elapsedHigh.set(row.id, row.elapsedMs)
    }
    return sortRows(list)
  })

  const anyRunning = createMemo(() => rows().some((row) => row.running))

  // 动画帧：只驱动行首字形，不参与 rows 重算（否则每 80ms 重建全部行对象）
  const [spinnerFrame, setSpinnerFrame] = createSignal(0)

  createEffect(() => {
    if (!anyRunning()) return
    const frameTimer = setInterval(() => setSpinnerFrame((v) => v + 1), SPINNER_INTERVAL_MS)
    const tickTimer = setInterval(() => setSubTick((v) => v + 1), 1000)
    onCleanup(() => {
      clearInterval(frameTimer)
      clearInterval(tickTimer)
    })
  })

  const toggle = (id: string) => {
    setExpanded((prev) => ({ ...prev, [id]: prev[id] !== true }))
  }

  // 一键收起：清空展开表（内存态，不影响卡片自身的折叠）
  const collapseAll = () => setExpanded({})

  // 运行中子代理在用供应商：直接吃已组装的行，避免重复 session.get/status。
  // 逐秒重算的 rows 会产出新数组，这里按内容比较压掉无变化的通知，
  // 否则额度 ViewModel 会跟着这枚 1s 心跳整块重算。
  const activeProviderIDs = createMemo(() => runningProviderIDs(rows()), undefined, {
    equals: (a, b) => a.length === b.length && a.every((v, i) => v === b[i]),
  })

  return {
    rows,
    frame: spinnerFrame,
    toggle,
    collapseAll,
    activeProviderIDs,
  }
}
