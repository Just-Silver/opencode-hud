// ─── 更新模块：版本常量（唯一版本事实源） ───
// 发布流程：改本文件的 VERSION → commit → git tag v<VERSION> → push（Actions 自动出 Release）。
// 本地版本号即此常量，与 GitHub Release 的 tag_name 对比判断是否有更新。

// SemVer（major.minor.patch）
// 修改规则：
//   major：破坏性变更（如删除供应商、改契约）
//   minor：新功能（如新增供应商、新 UI 区块）
//   patch：修复 / 小改动
export const VERSION = "3.1.0"

// 兼容解析：接受 "1.0.0" 或 "v1.0.0"（Release tag_name 常带 v 前缀）
export function parseVersion(s: string): { major: number; minor: number; patch: number } | undefined {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(s.trim())
  if (!m) return undefined
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) }
}

// SemVer 比较：a > b → 1，a < b → -1，相等 → 0；非法 → undefined
export function compareVersions(a: string, b: string): number | undefined {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa || !pb) return undefined
  for (const k of ["major", "minor", "patch"] as const) {
    if (pa[k] !== pb[k]) return pa[k] > pb[k] ? 1 : -1
  }
  return 0
}
