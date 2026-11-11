// ─── UI 层：更新提示（纯展示） ───
// 设计原则：提示不应当影响插件正常使用。
//   - 单行窄条（不换行、不撑高），置于插件最下方
//   - 右侧提供 ✕ 关闭按钮（点击即消失，本会话内不再出现）
//   - 无更新 / 检查失败 / 已关闭 → 本组件零占位；是否整体渲染由父组件决定
// 展示：▍更新 v1.1.0 可用 · 点击安装   ✕（点正文 → 弹出更新弹窗）
//
// 状态（更新信息 + 是否已关闭）由 view/hooks/useUpdate.ts 持有；本组件只负责画。
/** @jsxImportSource @opentui/solid */
import { Show, type JSX } from "solid-js"
import { usePlugin } from "@opencode/plugin/tui"
import type { UpdateInfo } from "../update/index.ts"
import { MUTED_COLOR, RAISED_COLOR, TEXT_COLOR, WARNING_COLOR } from "./theme.ts"
import { UpdateDialog } from "./UpdateDialog.tsx"

const CLOSE_LABEL = "✕"

export function UpdateBanner(props: { update?: UpdateInfo; onDismiss: () => void }): JSX.Element {
  const ctx = usePlugin()

  // 点击正文 → 弹出更新弹窗；更新成功后 onDismiss 让横幅消失
  const open = (version: string) => {
    ctx.ui.dialog.show(() => <UpdateDialog version={version} onUpdated={props.onDismiss} />)
  }

  // 无更新 → 不渲染（零占位）
  return (
    <Show when={props.update}>
      {(u) => (
        <box
          flexDirection="row"
          height={1}
          backgroundColor={RAISED_COLOR}
          paddingLeft={1}
          paddingRight={1}
        >
          {/* 只有正文是打开弹窗的点击区：✕ 的 mousedown 不能连带触发它 */}
          <text fg={WARNING_COLOR} onMouseUp={() => open(u().latestVersion)} cursor="pointer">
            <b>{"▍更新 "}</b>
          </text>
          <text
            fg={TEXT_COLOR}
            wrapMode="none"
            onMouseUp={() => open(u().latestVersion)}
            cursor="pointer"
          >
            {`v${u().latestVersion} 可用 · 点击安装`}
          </text>
          <box flexGrow={1} />
          <text fg={MUTED_COLOR} onMouseDown={props.onDismiss} cursor="pointer">
            {CLOSE_LABEL}
          </text>
        </box>
      )}
    </Show>
  )
}
