// ─── UI 层：HUD 画布（卡片直接相邻，不留区块间距） ───
// 底色与卡片一致：卡片之间若有空行也不会露出更暗的一条「断层」，整块 HUD 是连续表面，
// 卡片靠圆角边框与抬升色块分层。卡片自带下内边距，卡间再留空行会显得松散，故 gap=0。
/** @jsxImportSource @opentui/solid */
import type { JSX } from "solid-js"
import { CARD_COLOR } from "./theme.ts"

export function Canvas(props: { children: JSX.Element }): JSX.Element {
  return (
    <box flexDirection="column" backgroundColor={CARD_COLOR}>
      {props.children}
    </box>
  )
}
