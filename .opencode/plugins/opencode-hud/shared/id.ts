// ─── 共享/帮助函数：供应商 ID 归一化 ───
// 用于「我方写死的 ID」与「用户任意写法」的比较（opencode-go / opencode_go / Opencode-Go → opencodego）。
// 官方（ProviderV2.ID = Schema.String）无字符限制也不归一化，此处仅作用于我们自己的匹配层。
export const normID = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "")