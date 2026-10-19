// ─── UI 层：折叠区域组件 ───
// 样式：箭头 + 橙金粗体标题成一行的标题行（折叠时摘要右对齐），标题下方一条
// 独立的分隔线（"─" 字符铺满宽度）；整行 onMouseDown 切换、状态持久化。
// 配色固定取 theme.ts 调色板（不随宿主主题）。
/** @jsxImportSource @opentui/solid */
import { createSignal, Show, type JSX } from "solid-js"
import { dividerLine } from "../shared/format.ts"
import { DIVIDER_COLOR, MUTED_COLOR, PRIMARY_COLOR } from "./theme.ts"

const collapseState = new Map<string, boolean>()

// 分隔线字符数：侧边栏内宽上限的量级即可，实际由 width="100%" 裁到容器宽度
const FALLBACK_WIDTH = 80

export function Collapsible(props: {
  /** 折叠状态的 key，也是标题文字（须稳定，不要拼动态内容） */
  title: string
  /** 紧跟标题显示的动态内容（如指示灯），始终可见，且不参与折叠状态 key */
  badge?: JSX.Element
  /** 标题行右端、aside 左侧的操作按钮（如「全部收起」） */
  actions?: JSX.Element
  /** 标题行右端右对齐的补充信息（如合计），展开与折叠都显示 */
  aside?: string
  /** 折叠时显示在标题行右端的摘要（纯文本）；与 aside 同时给则 aside 优先 */
  summary?: string
  children: JSX.Element
}): JSX.Element {
  const [isOpen, setIsOpen] = createSignal(collapseState.get(props.title) ?? true)

  const toggle = () => {
    setIsOpen((v) => {
      const next = !v
      collapseState.set(props.title, next)
      return next
    })
  }

  return (
    <box flexDirection="column">
      {/* 标题行：箭头 + 标题（+ 紧跟的 badge），右端 aside */}
      <box flexDirection="row" onMouseDown={toggle}>
        <text fg={MUTED_COLOR}>{() => (isOpen() ? "▼ " : "▶ ")}</text>
        <text fg={PRIMARY_COLOR}>
          <b>{props.title}</b>
        </text>
        <Show when={props.badge}>{props.badge}</Show>
        <Show when={props.actions || props.aside || (!isOpen() && props.summary)}>
          <box flexGrow={1} />
          <Show when={props.actions}>{props.actions}</Show>
          <Show when={props.actions && (props.aside || (!isOpen() && props.summary))}>
            <text> </text>
          </Show>
          <Show when={props.aside || (!isOpen() && props.summary)}>
            <text fg={MUTED_COLOR}>{props.aside ?? props.summary}</text>
          </Show>
        </Show>
      </box>
      {/* 标题下方的独立分隔线（字符线，1 行高，视觉纤细）。
          用 width="100%" 铺满，不做 onSizeChange 测量：首帧测得 0 时只画 1 个字符、
          随后才撑满，切换会话/重建组件时会闪一下。字符数给足，超出部分由容器裁掉。 */}
      <text fg={DIVIDER_COLOR} width="100%" wrapMode="none">
        {dividerLine(FALLBACK_WIDTH)}
      </text>
      <Show when={isOpen()}>
        <box>{props.children}</box>
      </Show>
    </box>
  )
}
