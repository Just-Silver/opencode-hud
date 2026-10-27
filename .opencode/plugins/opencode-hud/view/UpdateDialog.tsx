// ─── UI 层：更新弹窗（点击横幅后弹出；复刻 opencode 的 DialogUpdate） ───
// 状态机：available（待确认）→ updating（执行中）→ done / failed
//   · available：说明 + 「更新 / 取消」
//   · updating ：执行中（不提供按钮）
//   · done     ：成功，提示重启生效（「稍后」关闭 / 「重启」退出 opencode）
//   · failed   ：失败，展示错误输出尾部 + 「关闭」
// 关闭：Esc / 点击遮罩由 opencode 对话框系统统一处理（见 packages/tui/src/ui/dialog.tsx）；
//       Enter 由下方 keymap 绑定。
// ⚠️ 响应式约束：组件函数体只执行一次，禁止 props 快照 const；状态一律用 signal。
/** @jsxImportSource @opentui/solid */
import { createSignal, Match, Show, Switch, type JSX } from "solid-js"
import { usePlugin } from "@opencode/plugin/tui"
import { applyUpdate } from "../update/apply.ts"
import { markUpdated } from "../update/index.ts"
import { ERROR_COLOR, INPUT_COLOR, MUTED_COLOR, WARN_COLOR } from "./theme.ts"

type Phase = "available" | "updating" | "done" | "failed"

export function UpdateDialog(props: { version: string; onUpdated?: () => void }): JSX.Element {
  const ctx = usePlugin()
  const [phase, setPhase] = createSignal<Phase>("available")
  const [error, setError] = createSignal("")

  // 居中展示（show→replace 会把 centered 重置为 false，故在内容渲染时再设置）
  ctx.ui.dialog.set({ centered: true })

  const close = () => ctx.ui.dialog.clear()

  // 重启：走 opencode 注册的全局命令 app.exit（官方 exit() → destroyRenderer 退出进程那条路径）
  // 与官方一致：不是自动重启进程，而是帮你退出应用，用户重新启动即可（会话在 server 侧自动恢复）
  const restart = () => ctx.keymap.dispatch("app.exit")

  // 执行更新：成功后清缓存（横幅不再出现）并回调 onUpdated
  const run = async () => {
    setPhase("updating")
    const result = await applyUpdate({ version: props.version })
    if (result.ok) {
      markUpdated()
      setPhase("done")
      props.onUpdated?.()
    } else {
      setError(result.message)
      setPhase("failed")
    }
  }

  // Enter：available → 更新；done → 重启；failed → 关闭（Esc 由对话框系统处理）
  ctx.keymap.layer(() => ({
    mode: "modal",
    commands: [
      {
        bind: "return",
        title: "确认更新",
        run: () => {
          const current = phase()
          if (current === "available") void run()
          else if (current === "done") restart()
          else if (current === "failed") close()
        },
      },
    ],
  }))

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={WARN_COLOR}>⚡ 更新 opencode-hud</text>
        <text fg={MUTED_COLOR} onMouseUp={close} cursor="pointer">
          esc
        </text>
      </box>
      <box flexDirection="column">
        <Switch>
          <Match when={phase() === "available"}>
            <text fg={MUTED_COLOR}>发现新版本 v{props.version}，是否立即更新？</text>
            <text fg={MUTED_COLOR}>将重新下载并替换插件目录。</text>
          </Match>
          <Match when={phase() === "updating"}>
            <text fg={WARN_COLOR}>正在更新…（下载并安装 v{props.version}）</text>
          </Match>
          <Match when={phase() === "done"}>
            <text fg={INPUT_COLOR}>更新完成，重启 opencode 生效。</text>
            <text fg={MUTED_COLOR}>点「重启」退出 opencode，重新启动即可（会话自动恢复）。</text>
          </Match>
          <Match when={phase() === "failed"}>
            <text fg={ERROR_COLOR}>更新失败：</text>
            <text fg={ERROR_COLOR} wrapMode="word">
              {error()}
            </text>
          </Match>
        </Switch>
      </box>
      <box flexDirection="row" justifyContent="flex-end" gap={2} paddingBottom={1}>
        <Show when={phase() === "available"}>
          <text fg={MUTED_COLOR} onMouseUp={close} cursor="pointer">
            取消
          </text>
          <text fg={WARN_COLOR} onMouseUp={() => void run()} cursor="pointer">
            更新
          </text>
        </Show>
        <Show when={phase() === "done"}>
          <text fg={MUTED_COLOR} onMouseUp={close} cursor="pointer">
            稍后
          </text>
          <text fg={WARN_COLOR} onMouseUp={restart} cursor="pointer">
            重启
          </text>
        </Show>
        <Show when={phase() === "failed"}>
          <text fg={WARN_COLOR} onMouseUp={close} cursor="pointer">
            关闭
          </text>
        </Show>
      </box>
    </box>
  )
}
