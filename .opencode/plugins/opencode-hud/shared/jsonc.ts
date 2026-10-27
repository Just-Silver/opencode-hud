// ─── 共享/帮助函数：JSON / JSONC 解析（纯函数） ───
// 轻量 JSONC：先按纯 JSON 解析，失败再去注释/尾逗号后重试；仍失败返回 undefined
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    // fallthrough：尝试 JSONC 清洗
  }
  const clean = text
    .replace(/\/\*[\s\S]*?\*\//g, "") // 块注释
    .replace(/(^|[^:\\])\/\/.*$/gm, "$1") // 行注释（字符串内 // 属极端情况，解析失败即跳过该来源）
    .replace(/,(\s*[}\]])/g, "$1") // 尾逗号
  try {
    return JSON.parse(clean)
  } catch {
    return undefined
  }
}