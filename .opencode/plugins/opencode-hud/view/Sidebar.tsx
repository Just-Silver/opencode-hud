// ─── UI 层：侧边栏根组件（只做编排：取数 → 卡片） ───
// ViewModel 拆分在 view/hooks/：会话用量 / 子代理 / 额度 / 更新各管一块，
// 本组件只决定「有哪些区块、以什么顺序出现」。
// 全部 Solid 信号/memo/副作用在 hooks 内创建（owner 上下文正确）。
/** @jsxImportSource @opentui/solid */
import { createMemo, Show, type JSX } from "solid-js"
import { Canvas } from "./Canvas.tsx"
import { ContextSection } from "./ContextSection.tsx"
import { QuotaSection } from "./QuotaSection.tsx"
import { SubagentSection } from "./SubagentSection.tsx"
import { UpdateBanner } from "./UpdateBanner.tsx"
import { useQuota } from "./hooks/useQuota.ts"
import { useSessionStats } from "./hooks/useSessionStats.ts"
import { useSubagents } from "./hooks/useSubagents.ts"
import { useUpdate } from "./hooks/useUpdate.ts"

export function Sidebar(props: { sessionID?: string }): JSX.Element {
  const sessionID = props.sessionID

  const stats = useSessionStats(sessionID)
  const agents = useSubagents(sessionID)
  const quota = useQuota({
    currentPid: stats.providerID,
    subagentPids: agents.activeProviderIDs,
  })
  const update = useUpdate()

  // 面板内容：会话用量 / 额度 / 子代理 / 更新提示；全无 → 整块不渲染（会话初始零占位）
  const hasContent = createMemo(
    () => stats.usage() !== undefined || quota.rows().length > 0 || agents.rows().length > 0 || update.show(),
  )

  return (
    <Show when={hasContent()}>
      <Canvas>
        <Show when={stats.usage()}>
          {(usage) => (
            <ContextSection
              usage={usage()}
              ctxUsage={stats.ctxUsage()}
              ctxPct={stats.ctxPct()}
              limit={stats.limit()}
              cacheRate={stats.cacheRate()}
            />
          )}
        </Show>
        {/* 额度不依赖会话用量：新会话还没有 token 时，已登录订阅照样要能看 */}
        <QuotaSection rows={quota.rows()} onToggle={quota.toggle} />
        <SubagentSection
          rows={agents.rows()}
          frame={agents.frame()}
          onToggle={agents.toggle}
          onCollapseAll={agents.collapseAll}
        />
        {/* 更新提示：不依赖会话数据，放在最下方，轻量一行、可关闭 */}
        <UpdateBanner update={update.update()} onDismiss={update.dismiss} />
      </Canvas>
    </Show>
  )
}
