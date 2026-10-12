// ─── view/renderers/registry.ts 共享渲染器名解析（纯逻辑） ───
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  DEFAULT_RENDERER,
  RENDERER_NAMES,
  resolveRendererName,
} from "../.opencode/plugins/opencode-tui-usage/view/renderers/registry.ts"

test("resolveRendererName：已知 → 原名；未知/空/未声明 → 默认（绝不报错）", () => {
  for (const name of RENDERER_NAMES) assert.equal(resolveRendererName(name), name)
  assert.equal(resolveRendererName(undefined), DEFAULT_RENDERER)
  assert.equal(resolveRendererName(""), DEFAULT_RENDERER)
  assert.equal(resolveRendererName("nope"), DEFAULT_RENDERER)
})

test("渲染器名单含默认渲染器", () => {
  assert.ok((RENDERER_NAMES as readonly string[]).includes(DEFAULT_RENDERER))
})
