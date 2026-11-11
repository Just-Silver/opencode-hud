// ─── UI 层：Dashboard 卡片（圆角边框 + 边框内标题） ───
// 一卡一边框，标题写在顶边上（OpenTUI 的 box title），不再叠第二层边框/分隔线。
// 不做整卡折叠：卡片折叠后只剩一个空边框，视觉上比不折叠更糟；区块内的折叠
// （额度分组、子代理详情与历史段）仍然保留。
/** @jsxImportSource @opentui/solid */
import type { JSX } from "solid-js"
import { ACCENT_COLOR, BORDER_COLOR, CARD_COLOR } from "./theme.ts"

export function DashboardCard(props: { title: string; children: JSX.Element }): JSX.Element {
  return (
    <box
      flexDirection="column"
      border
      borderStyle="rounded"
      borderColor={BORDER_COLOR}
      backgroundColor={CARD_COLOR}
      title={` ${props.title} `}
      titleColor={ACCENT_COLOR}
      paddingLeft={1}
      paddingRight={1}
      paddingBottom={1}
    >
      {props.children}
    </box>
  )
}
