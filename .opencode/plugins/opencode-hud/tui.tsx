/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import { FooterPerf } from "./footer.tsx"
import { bindQuotaHost, integrationIDFromProviders } from "./quota/host.ts"
import { Sidebar } from "./view/Sidebar.tsx"

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
    // 性能块独占输入框正上方一行：状态行由宿主按上下文动态拼（路径长短、忙时用量、
    // 提示簇宽度都会变），挂在那里数字会左右漂；这一行宿主不填任何内容，位置固定
    context.ui.slot({
      append: "session.composer.top",
      render: (input: { sessionID?: string }) => <FooterPerf sessionID={input.sessionID} />,
    })
  },
})
