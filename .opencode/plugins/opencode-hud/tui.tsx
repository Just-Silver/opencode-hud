/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import { FooterPerf } from "./footer.tsx"
import { Sidebar } from "./view/Sidebar.tsx"

// 两个槽位：侧栏仪表盘 + 输入框下方状态行的性能块。
export default Plugin.define({
  id: "opencode-hud",
  setup(context) {
    context.ui.slot({
      append: "sidebar.content",
      render: ({ sessionID }: { sessionID?: string }) => <Sidebar sessionID={sessionID} />,
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
