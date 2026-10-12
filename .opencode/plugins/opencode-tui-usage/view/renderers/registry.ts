// ─── UI 层：共享渲染器注册表（纯逻辑，node 可测） ───
// 供应商经 ProviderRegistration.render 声明用哪个渲染器；未知/省略一律回落默认（绝不报错，保证数据总能显示）。
// 新增一种渲染形态：加 view/renderers/<name>.tsx + 在 RENDERER_NAMES 与 index.ts 的 RENDERERS 各登记一项。
export const DEFAULT_RENDERER = "bars"

// 已注册渲染器名单（与 index.ts 的 RENDERERS 键一一对应，由 satisfies 在编译期钉住）
export const RENDERER_NAMES = ["bars"] as const

// 渲染器名解析：已知 → 原名；未知/空 → 默认
export function resolveRendererName(name: string | undefined): string {
  return name && (RENDERER_NAMES as readonly string[]).includes(name) ? name : DEFAULT_RENDERER
}
