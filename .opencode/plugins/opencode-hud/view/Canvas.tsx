// ─── UI 层：HUD 画布（连续的卡片底色 + 区块间距） ───
// 底色与卡片一致：卡片之间的空行不会露出更暗的一条「断层」，整块 HUD 是连续表面，
// 卡片靠圆角边框与抬升色块分层。
/** @jsxImportSource @opentui/solid */
import type { JSX } from "solid-js"
import { CARD_COLOR } from "./theme.ts"

export function Canvas(props: { children: JSX.Element }): JSX.Element {
  return (
    <box flexDirection="column" gap={1} backgroundColor={CARD_COLOR}>
      {props.children}
    </box>
  )
}
