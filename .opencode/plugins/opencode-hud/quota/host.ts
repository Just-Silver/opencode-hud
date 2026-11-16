// ─── 额度宿主映射：插件 setup 绑定一次，hook 每次调用时读取 ───
// 组件会随会话重建；若让单例捕获第一个组件的 context，后续重建就会一直用旧 location。
// 因此只保存 setup 注入的访问器：后一次绑定覆盖前一次，组件卸载不清除（setup 才是持有者）。
import { normID } from "../shared/id.ts"

export type QuotaHostProvider = { readonly id: string; readonly integrationID?: string }

export type QuotaHostSource = {
  providerIntegrationID(pid: string): string | undefined
  directory(): string | undefined
}

let source: QuotaHostSource | undefined

export function bindQuotaHost(next: QuotaHostSource | undefined): void {
  source = next
}

export function hostIntegrationID(pid: string): string | undefined {
  return source?.providerIntegrationID(pid)
}

export function hostDirectory(): string | undefined {
  return source?.directory()
}

// 与宿主映射一致：provider 在列表里 → integrationID ?? provider.id；
// 只有不在列表（尚未同步）才是未就绪，不能把「缺 integrationID」当成没登录。
// 匹配按 normID：宿主的 provider id 与注册 pid 可能只差大小写/下划线，返回值仍用宿主原值。
export function integrationIDFromProviders(
  providers: readonly QuotaHostProvider[] | undefined,
  pid: string,
): string | undefined {
  const normalized = normID(pid)
  const provider = providers?.find((p) => normID(p.id) === normalized)
  return provider ? (provider.integrationID ?? provider.id) : undefined
}
