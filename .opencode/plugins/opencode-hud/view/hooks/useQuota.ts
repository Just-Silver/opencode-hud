// ─── ViewModel 片段：额度监控 ───
// 发现（有凭据的已启用供应商）→ 排序（当前 → 运行中子代理在用 → 其余）→ 行集合（有数据才出现）。
// 刷新间隔 / 退避 / Retry-After / 并发去重全部由 QuotaStore 负责，这里只按 60s 心跳调用。
import { createEffect, createMemo, createSignal, on, onCleanup } from "solid-js"
import type { QuotaRow } from "../../model/types.ts"
import type { QuotaDeps } from "../../model/quota.ts"
import {
  getQuotaStore,
  isQuotaRowOpen,
  orderQuotaProviders,
  QUOTA_REFRESH_MS,
  QUOTA_TICK_MS,
  toggleQuotaRowState,
} from "../../model/quota.ts"
import { fetchQuota, getProviderApiUrl, getProviderName, getProviderRenderer, isQuotaProvider, listProviders } from "../../quota/index.ts"
import { resolveProviderKey } from "../../quota/key.ts"
import { normID } from "../../shared/id.ts"

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

export function useQuota(opts: {
  currentPid: () => string | undefined
  subagentPids: () => string[]
}) {
  const quota = quotaStore({
    apiUrlFor: getProviderApiUrl,
    resolveKey: resolveProviderKey,
    fetch: fetchQuota,
    // TUI 插件无 app.log API（client 为 HTTP 客户端）；console 输出被 OpenTUI 接管到应用内面板
    log: (level, message) => {
      if (level === "error") console.error(`[tui-usage] ${message}`)
      else console.warn(`[tui-usage] ${message}`)
    },
  })

  const [storeVer, setStoreVer] = createSignal(0)
  const [openVer, setOpenVer] = createSignal(0)
  // 新鲜度（数据年龄/过期）需要自己的心跳：store 只在写库时通知
  const [clock, setClock] = createSignal(0)
  const [available, setAvailable] = createSignal<string[]>(probedHits)

  // 候选 = 本机有凭据的已启用供应商；5min TTL 只回答「有没有 token」，能否查额度交给首次请求
  const probe = async () => {
    if (probing) return
    if (probedAt !== 0 && Date.now() - probedAt < QUOTA_REFRESH_MS) return
    probing = true
    try {
      const hits: string[] = []
      for (const { id } of listProviders()) {
        const key = await resolveProviderKey(id).catch(() => undefined)
        if (key) hits.push(id)
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

  const rows = createMemo<QuotaRow[]>(() => {
    void storeVer() // 写库通知
    void openVer() // 展开态
    void clock() // 数据年龄 / 过期判定
    const currentPid = opts.currentPid()
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
          status: quota.status(pid),
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

  // 订阅 store 写库通知：任何组件发起的 load 写库后当前组件都会刷新
  onCleanup(
    quota.subscribe(() => {
      setStoreVer((v: number) => v + 1)
    }),
  )

  // 只对已注册的额度供应商加载：其他供应商没有查询端点，调用只会产生日志噪音
  const load = (pid: string | undefined) => {
    if (pid && isQuotaProvider(pid)) void quota.load(pid)
  }

  // 目标集合变化才加载（目标数组每轮都是新引用，用 key 压掉无意义的重跑）
  const targetKey = createMemo(() => targets().join("\u0000"))
  createEffect(
    on(targetKey, () => {
      for (const pid of targets()) load(pid)
    }),
  )

  // 每 60s：探测凭据（TTL 内直接返回）+ 逐供应商 load（是否真请求由 store 决定）+ 刷新数据年龄
  const timer = setInterval(() => {
    void probe()
    for (const pid of targets()) load(pid)
    setClock((v) => v + 1)
  }, QUOTA_TICK_MS)
  onCleanup(() => clearInterval(timer))

  return { rows, toggle }
}
