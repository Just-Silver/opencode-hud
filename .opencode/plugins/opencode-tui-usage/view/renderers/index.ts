// ─── UI 层：共享渲染器绑定（名字 → 实现） ───
// 供应商只声明渲染器名（ProviderRegistration.render），由这里解析成组件；
// 新增渲染器：加 <name>.tsx，并在 registry.ts 的 RENDERER_NAMES 与本文件 RENDERERS 各登记一项。
import type { JSX } from "solid-js"
import type { QuotaItem } from "../../model/types.ts"
import { BarsRenderer } from "./bars.tsx"
import { RENDERER_NAMES, resolveRendererName } from "./registry.ts"

// 渲染器契约：接收条目数组，返回该区块内容（外壳/标题/折叠由 QuotaSection 负责）
export type QuotaRenderer = (props: { items: QuotaItem[] }) => JSX.Element

// 名字 → 实现；satisfies 保证与 RENDERER_NAMES 一一对应（漏登记即编译报错）
export const RENDERERS = {
  bars: BarsRenderer,
} satisfies Record<(typeof RENDERER_NAMES)[number], QuotaRenderer>

// 供应商声明的渲染器名 → 渲染器；未知/省略 → 默认
export function resolveRenderer(name: string | undefined): QuotaRenderer {
  return RENDERERS[resolveRendererName(name) as keyof typeof RENDERERS]
}
