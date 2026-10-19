/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import { resetLivePerfSource } from "./live/index.ts"
import { Sidebar } from "./view/Sidebar.tsx"
import { FooterPerf } from "./footer.tsx"

export default Plugin.define({
  id: "opencode-tui-usage",
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
    // 卸载/热重载时退订事件、停心跳（单例是模块级的，不清会泄漏到下一代）
    return () => resetLivePerfSource()
  },
})
