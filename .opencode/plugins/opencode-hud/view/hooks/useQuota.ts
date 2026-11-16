// ─── ViewModel 片段：额度监控 ───
// 发现（有凭据的已启用供应商）→ 排序（当前 → 运行中子代理在用 → 其余）→ 行集合（有数据才出现）。
// 请求节奏由 QuotaStore 决定（最小间隔 / 失败退避 / Retry-After / 并发去重），这里只负责排程：
//   · 精确唤醒：按 store 的 nextCheckAt 排到真实截止时刻，倒计时归零即发请求；
//   · 兜底心跳：每 60s 探测一次凭据并补一次 load（发现登录 / 切号 / 漏排程）。
import { createEffect, createMemo, createSignal, on, onCleanup } from "solid-js"
import type { QuotaRow } from "../../model/types.ts"
import type { QuotaDeps } from "../../model/quota.ts"
import {
  getQuotaStore,
  isQuotaRowOpen,
  nextWakeAt,
  orderQuotaProviders,
  QUOTA_REFRESH_MS,
  QUOTA_TICK_MS,
  toggleQuotaRowState,
} from "../../model/quota.ts"
import { hostDirectory, hostIntegrationID } from "../../quota/host.ts"
import { fetchQuota, getProviderApiUrl, getProviderName, getProviderRenderer, isQuotaProvider, listProviders } from "../../quota/index.ts"
import { resolveProviderCredential } from "../../quota/key.ts"
import { normID } from "../../shared/id.ts"

// 已到点的目标被再次叫醒时的最小间隔：防止「时刻没前进」时 setImmediate 式空转
const MIN_WAKE_MS = 250

// 进程内单例（跨 render 持久；deps 仅首次创建时生效）
let store: ReturnType<typeof getQuotaStore> | undefined
function quotaStore(deps: QuotaDeps) {
  if (!store) store = getQuotaStore(deps)
  return store
}

// 凭据探测缓存：宿主按会话 keyed 重建侧边栏，放组件里会让 5min TTL 每次重建作废
let probedAt = 0
let probing = false
let probedHits: string[] = []

// 额度组的展开态：模块级，跨侧边栏重建保持
let quotaRowOpen = new Map<string, boolean>()

// 每次调用都现读宿主映射：setup 重绑（切目录/换宿主实例）后立即生效，不缓存第一个组件的 context
function resolveCredential(pid: string) {
  return resolveProviderCredential(pid, {
    cwd: hostDirectory(),
    integrationID: hostIntegrationID(pid),
  })
}

export function useQuota(opts: {
  currentPid: () => string | undefined
  subagentPids: () => string[]
}) {
  const quota = quotaStore({
    apiUrlFor: getProviderApiUrl,
    resolveKey: resolveCredential,
    fetch: fetchQuota,
    // TUI 插件无 app.log API（client 为 HTTP 客户端）；console 输出被 OpenTUI 接管到应用内面板
    log: (level, message) => {
      if (level === "error") console.error(`[opencode-hud] ${message}`)
      else console.warn(`[opencode-hud] ${message}`)
    },
  })

  const [storeVer, setStoreVer] = createSignal(0)
  const [openVer, setOpenVer] = createSignal(0)
  const [available, setAvailable] = createSignal<string[]>(probedHits)

  // 候选 = 本机有凭据的已启用供应商；5min TTL 只回答「有没有 token」，能否查额度交给首次请求
  const probe = async () => {
    if (probing) return
    if (probedAt !== 0 && Date.now() - probedAt < QUOTA_REFRESH_MS) return
    probing = true
    try {
      const hits: string[] = []
      for (const { id } of listProviders()) {
        // null（有意跳过）与 undefined（无来源）都不算候选：没有可用凭据就不展示
        const credential = await resolveCredential(id).catch(() => undefined)
        if (credential) hits.push(id)
      }
      probedAt = Date.now()
      probedHits = hits
      setAvailable(hits)
    } finally {
      probing = false
    }
  }
  void probe()

  const targets = createMemo<string[]>(() =>
    orderQuotaProviders({
      current: opts.currentPid(),
      subagentPids: opts.subagentPids(),
      available: available(),
    }),
  )

  // 只有注册了额度端点的供应商需要调度：其他供应商 load 只会刷日志
  const quotaTargets = () => targets().filter((pid) => isQuotaProvider(pid))

  const rows = createMemo<QuotaRow[]>(() => {
    void storeVer() // 写库通知
    void openVer() // 展开态
    // 不读时钟：status 里带的是绝对时刻（updatedAt / nextRefreshAt），
    // 逐秒变化只发生在渲染倒计时的那一个文本节点上，不重建行、不重跑 renderer。
    const currentPid = opts.currentPid()
    const now = Date.now()
    const base = targets().flatMap((pid) => {
      const data = quota.get(pid)
      if (!data || data.items.length === 0) return [] // 无数据不出现（含空条目）
      return [
        {
          pid,
          name: getProviderName(pid) ?? pid,
          renderer: getProviderRenderer(pid),
          data,
          current: currentPid !== undefined && normID(pid) === normID(currentPid),
          open: false,
          status: quota.status(pid, now),
        },
      ]
    })
    // 只有当前会话供应商在行集合里时才默认展开它；否则全部折叠（不猜哪条更重要）
    const defaultPid = base.find((r) => r.current)?.pid
    return base.map((r) => ({ ...r, open: isQuotaRowOpen(r.pid, defaultPid, quotaRowOpen) }))
  })

  // 点击组头：取反「当前可见状态」（含默认展开规则），否则点当前组第一下会被吞掉
  const toggle = (pid: string) => {
    const defaultPid = rows().find((r) => r.current)?.pid
    quotaRowOpen = toggleQuotaRowState(quotaRowOpen, pid, defaultPid)
    setOpenVer((v) => v + 1)
  }

  // ── 刷新调度 ──
  let wake: ReturnType<typeof setTimeout> | undefined
  let disposed = false

  function clearWake() {
    if (wake !== undefined) clearTimeout(wake)
    wake = undefined
  }

  // 排到最早的真实截止时刻：倒计时与调度读同一个 nextCheckAt，不存在归零后干等心跳
  function scheduleWake() {
    clearWake()
    if (disposed) return
    const next = nextWakeAt(quotaTargets().map((pid) => quota.nextCheckAt(pid)))
    if (next === undefined) return
    wake = setTimeout(kick, Math.max(MIN_WAKE_MS, next - Date.now()))
  }

  // 逐供应商 load（是否真发请求由 store 判定）；全部落定后再排程，读到的才是请求后的截止时刻
  function kick() {
    if (disposed) return
    const jobs = quotaTargets().map((pid) => quota.load(pid))
    if (jobs.length === 0) {
      scheduleWake()
      return
    }
    void Promise.allSettled(jobs).then(() => scheduleWake())
  }

  // 订阅 store 落定（成功/失败/空响应/切号）→ 刷新行数据 + 重排下一次检查
  onCleanup(
    quota.subscribe(() => {
      setStoreVer((v: number) => v + 1)
      scheduleWake()
    }),
  )

  // 目标集合变化才加载（目标数组每轮都是新引用，用 key 压掉无意义的重跑）
  const targetKey = createMemo(() => targets().join("\u0000"))
  createEffect(
    on(targetKey, () => {
      kick()
    }),
  )

  // 兜底心跳：凭据探测 + 补一次 load（到点没被唤醒时最多晚 60s）；请求节奏仍由 nextCheckAt 决定
  const tickTimer = setInterval(() => {
    void probe().then(kick)
  }, QUOTA_TICK_MS)

  onCleanup(() => {
    disposed = true
    clearWake()
    clearInterval(tickTimer)
  })

  return { rows, toggle }
}
