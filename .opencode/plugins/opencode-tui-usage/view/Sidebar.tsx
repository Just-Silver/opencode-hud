// ─── UI 层：侧边栏根组件（ViewModel：响应式编排 + 组装） ───
// 全部 Solid 信号/memo/副作用在此创建（组件 render 期间，owner 上下文正确）；
// 业务纯函数调 model/，查询服务调 quota/，展示组件调 view/。
/** @jsxImportSource @opentui/solid */
import { createEffect, createMemo, createSignal, onCleanup, Show, type JSX } from "solid-js"
import { usePlugin } from "@opencode/plugin/tui"
import {
  aggregateUsage,
  calcCacheRate,
  calcPercent,
  contextUsageOf,
  resolveContextLimit,
  resolveProviderID,
  usageFromTokens,
} from "../model/usage.ts"
import type { TokenLike } from "../model/types.ts"
import { getQuotaStore, QUOTA_REFRESH_MS, type QuotaDeps } from "../model/quota.ts"
import { buildRow, sortRows, SPINNER_INTERVAL_MS, type SubagentRow } from "../model/subagent.ts"
import { SubagentSection } from "./SubagentSection.tsx"
import { fetchQuota, getProviderApiUrl, getProviderRenderer, isQuotaProvider } from "../quota/index.ts"
import { resolveProviderKey } from "../quota/key.ts"
import { checkForUpdate, type UpdateInfo } from "../update/index.ts"
import { QuotaSection } from "./QuotaSection.tsx"
import { BORDER_COLOR } from "./theme.ts"
import { UpdateBanner } from "./UpdateBanner.tsx"
import { UsageSection } from "./UsageSection.tsx"

// 进程内单例（跨 render 持久，与重构前模块级 Map 语义一致；deps 仅首次创建时生效）
let store: ReturnType<typeof getQuotaStore> | undefined
function quotaStore(deps: QuotaDeps) {
  if (!store) store = getQuotaStore(deps)
  return store
}

// 会话内关闭更新横幅一次即不再打扰（模块级：跨侧边栏重建保持）
let updateDismissedOnce = false

export function Sidebar(props: { sessionID?: string }): JSX.Element {
  const ctx = usePlugin()
  const sessionID = props.sessionID

  // ── 数据源 getter（在 memo 内调用即订阅） ──
  const messages = () => (sessionID ? (ctx.data.session.message.list(sessionID) ?? []) : [])
  const session = () =>
    sessionID
      ? ((ctx.data.session.get(sessionID) as { location?: string; tokens?: TokenLike } | undefined) ?? undefined)
      : undefined
  const models = () =>
    session()?.location ? (ctx.data.location.model.list(session()!.location) ?? []) : []

  // ── 额度查询服务（单例；deps 的 log 首次创建时绑定 client） ──
  const store = quotaStore({
    apiUrlFor: getProviderApiUrl, // 归一化查找；未注册/未启用返回 undefined，由 QuotaStore 记 warn 跳过（无兜底）
    resolveKey: resolveProviderKey,
    fetch: fetchQuota,
    // TUI 插件无 app.log API（client 为 HTTP 客户端）；console 输出被 OpenTUI 接管到应用内面板
    log: (level, message) => {
      if (level === "error") console.error(`[tui-usage] ${message}`)
      else console.warn(`[tui-usage] ${message}`)
    },
  })

  // ── 会话用量（宿主聚合列为准，缺失时退回已加载消息窗口） ──
  const usage = createMemo(() => {
    if (!sessionID) return
    return usageFromTokens(session()?.tokens) ?? aggregateUsage(messages())
  })
  const cacheRate = createMemo(() => calcCacheRate(usage()))
  const ctxUsage = createMemo(() => (sessionID ? contextUsageOf(messages()) : undefined))
  const limit = createMemo(() => {
    if (!sessionID || ctxUsage() === undefined) return
    const s = session()
    if (!s) return
    return resolveContextLimit(messages(), models())
  })
  const ctxPct = createMemo(() => calcPercent(ctxUsage(), limit()))

  // ── 当前会话供应商 ID ──
  const providerID = createMemo(() => {
    if (!sessionID) return
    return resolveProviderID(messages(), (id) => models().find((m) => m.id === id)?.providerID)
  })

  // ── 子代理（结构数据全来自 SessionInfo，不读子会话消息） ──
  // 展开状态存组件级 Map：侧边栏重建后仍保持（内存态，重启即丢）
  const [expanded, setExpanded] = createSignal<Record<string, boolean>>({})
  const [subTick, setSubTick] = createSignal(0)

  // 子代理列表：结构数据全来自 SessionInfo（宿主聚合列），不读子会话消息
  const subagentIds = createMemo<string[]>(() => {
    if (!sessionID) return []
    const family = ctx.data.session.family(sessionID) ?? []
    return family.filter((id: string) => id !== sessionID)
  })

  // 耗时高水位：跨 memo 重算保留，避免步骤边界的 idle 旧值把分钟数拉回去
  const elapsedHigh = new Map<string, number>()

  const subagentRows = createMemo<SubagentRow[]>(() => {
    const tick = subTick() // 运行中条目靠它刷新耗时
    const now = Date.now()
    const state = expanded()
    const rows = subagentIds().map((id) => {
      const info = ctx.data.session.get(id)
      if (!info) return undefined
      const running = ctx.data.session.status(id) === "running"
      return buildRow(info, {
        running,
        expanded: state[id] === true,
        now,
        prevElapsed: elapsedHigh.get(id),
      })
    })
    const list = rows.filter((r): r is SubagentRow => r !== undefined)
    // 记录本轮高水位，供下一次重算钳位
    for (const row of list) {
      if (row.elapsedMs !== undefined) elapsedHigh.set(row.id, row.elapsedMs)
    }
    void tick
    return sortRows(list)
  })

  const anyRunning = createMemo(() => subagentRows().some((row) => row.running))

  // 动画帧：80ms 一步，与宿主 Spinner 节奏一致。只驱动行首字形，
  // 不参与 subagentRows 的重算（否则每 80ms 重建全部行对象）。
  const [spinnerFrame, setSpinnerFrame] = createSignal(0)

  // 存在运行中条目时：帧 80ms、耗时 1s 两条心跳；全 idle 立即停（空闲零 interval）
  createEffect(() => {
    if (!anyRunning()) return
    const frameTimer = setInterval(() => setSpinnerFrame((v) => v + 1), SPINNER_INTERVAL_MS)
    const tickTimer = setInterval(() => setSubTick((v) => v + 1), 1000)
    onCleanup(() => {
      clearInterval(frameTimer)
      clearInterval(tickTimer)
    })
  })

  const toggleSubagent = (id: string) => {
    setExpanded((prev) => ({ ...prev, [id]: prev[id] !== true }))
  }

  // 一键收起：清空展开表（内存态，不影响折叠状态）
  const collapseAllSubagents = () => {
    setExpanded({})
  }

  // ── 配额：按 providerID 分桶，字典缓存 ──
  const [quotaVer, setQuotaVer] = createSignal(0)
  const quota = createMemo(() => {
    void quotaVer()
    const pid = providerID()
    if (!pid) return
    // 白名单守卫：pid 任意写法，经 isQuotaProvider 归一化匹配（opencode-go / opencodego / opencode_go...）
    if (!isQuotaProvider(pid)) return
    return store.get(pid)
  })

  // 订阅 store 写库通知：任何组件发起的 load 写库后当前组件都会刷新（跨组件重建安全）
  onCleanup(
    store.subscribe(() => {
      setQuotaVer((v: number) => v + 1)
    }),
  )

  // effect：会话/数据变化触发首次加载（限流防抖，render 高频重建不连击）
  createEffect(() => {
    const pid = providerID()
    if (pid) void store.load(pid)
  })
  // timer：每 60s force 轮询（绕过限流，必然真请求；限流与轮询相位解耦）
  const timer = setInterval(() => {
    const pid = providerID()
    if (pid) void store.load(pid, { force: true })
  }, QUOTA_REFRESH_MS)
  onCleanup(() => clearInterval(timer))

  // ── 更新检查（状态由本组件持有，便于整块空时零占位） ──
  // mount 时检查一次；结果经信号驱动，无更新/失败 → undefined
  const [update, setUpdate] = createSignal<UpdateInfo | undefined>(undefined)
  const [updateDismissed, setUpdateDismissed] = createSignal(updateDismissedOnce)
  void checkForUpdate().then((info) => setUpdate(info))
  const showUpdate = createMemo(() => !updateDismissed() && update() !== undefined)
  const dismissUpdate = () => {
    updateDismissedOnce = true
    setUpdateDismissed(true)
  }

  // 面板内容：会话用量 / 子代理 / 更新提示；全无 → 整块不渲染（会话初始零占位）
  const hasContent = createMemo(
    () => usage() !== undefined || subagentRows().length > 0 || showUpdate(),
  )

  return (
    // 单面板外框：整个插件（会话 + 额度 + 子代理 + 更新横幅）共用一个带边框的盒子；
    // 无任何内容时整块不渲染，避免会话初始出现空边框占位
    <Show when={hasContent()}>
      <box
        flexDirection="column"
        gap={1}
        border
        borderColor={BORDER_COLOR}
        paddingLeft={1}
        paddingRight={1}
        paddingTop={0}
        paddingBottom={0}
      >
        <Show when={usage()}>
          {(u) => (
            <box flexDirection="column" gap={1}>
              <UsageSection
                usage={u()}
                ctxUsage={ctxUsage()}
                ctxPct={ctxPct()}
                limit={limit()}
                cacheRate={cacheRate()}
              />
              <QuotaSection quota={quota()} renderer={getProviderRenderer(providerID() ?? "")} />
              <SubagentSection
                rows={subagentRows()}
                frame={spinnerFrame()}
                onToggle={toggleSubagent}
                onCollapseAll={collapseAllSubagents}
              />
            </box>
          )}
        </Show>
        {/* 更新提示：不依赖会话数据，放在插件最下方，轻量一行、可关闭 */}
        <UpdateBanner update={update()} onDismiss={dismissUpdate} />
      </box>
    </Show>
  )
}