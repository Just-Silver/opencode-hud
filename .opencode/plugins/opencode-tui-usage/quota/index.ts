// ─── 统一前缀：此插件所有 quota 逻辑由此分发 ───
// 供应商自动发现：运行时扫描 quota/providers/<name>.ts，凡导出 provider 即视为一个查询。
// 加载机制（opencode 源码确认）：TUI 插件由 bun 运行时逐文件动态 import（plugin/loader.ts
// `await import(entry)`），无打包器、无 import.meta.glob；本模块用同款机制（fs 扫描 + 动态
// import）实现运行时发现。新增供应商 = 只新增 providers/<name>.ts 一个文件，热重载即生效。
import { readdirSync } from "fs"
import { join } from "path"
import { fileURLToPath } from "url"
import { createRegistry, type ProviderRegistration } from "./registry.ts"

function providersDir(): string {
  // ① 模块以磁盘 file:// 加载（bun/node 运行时加载源码的常规形态）
  if (import.meta.url.startsWith("file:")) return fileURLToPath(new URL("./providers/", import.meta.url))
  // ② bun 特有 import.meta.dir（磁盘模块）
  const dir = (import.meta as { dir?: string }).dir
  if (dir) return join(dir, "providers")
  throw new Error("无法定位 providers 目录（模块非磁盘加载）")
}

async function discoverProviders(): Promise<ProviderRegistration[]> {
  const out: ProviderRegistration[] = []
  for (const name of readdirSync(providersDir())) {
    if (!name.endsWith(".ts") && !name.endsWith(".tsx")) continue
    const mod = (await import(new URL(`./providers/${name}`, import.meta.url).href)) as {
      provider?: ProviderRegistration
    }
    if (mod.provider) out.push(mod.provider)
  }
  return out
}

// 顶层 await（ESM，bun/node 均支持）：模块加载时扫描一次；热重载重新 import → 重新扫描。
// 不做兜底（如扫描失败退回显式注册单个供应商）——加载失败直接抛出，暴露问题，避免静默降级。
const registered: ProviderRegistration[] = await discoverProviders()

const { isQuotaProvider, getProviderApiUrl, getProviderRenderer, fetchQuota } = createRegistry(registered)

export { isQuotaProvider, getProviderApiUrl, getProviderRenderer, fetchQuota }