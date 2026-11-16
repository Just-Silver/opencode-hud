/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import { FooterPerf } from "./footer.tsx"
import { bindQuotaHost, integrationIDFromProviders } from "./quota/host.ts"
import { Sidebar } from "./view/Sidebar.tsx"

// 两个槽位：侧栏仪表盘 + 输入框下方状态行的性能块。
export default Plugin.define({
  id: "opencode-hud",
  setup(context) {
    // 额度凭据跟随宿主的有效连接：映射规则与宿主一致（integrationID ?? provider.id），
    // 只有 provider 不在列表里才算未就绪。
    bindQuotaHost({
      providerIntegrationID: (pid) => integrationIDFromProviders(context.data.location.provider.list(), pid),
      directory: () => context.data.location.default().directory,
    })
    context.ui.slot({
      append: "sidebar.content",
      // 不解构 props：解构会丢掉宿主的响应式 getter，会话切换后仍是旧 sessionID
      render: (props: { sessionID?: string }) => <Sidebar sessionID={props.sessionID} />,
    })
    // 性能块落在输入框下方状态行（目录路径之后、宿主 usage 之前）
    context.ui.slot({
      append: "prompt.footer.status",
      render: (input: { sessionID?: string; showDetails?: boolean }) => (
        <FooterPerf sessionID={input.sessionID} showDetails={input.showDetails} />
      ),
    })
  },
})
