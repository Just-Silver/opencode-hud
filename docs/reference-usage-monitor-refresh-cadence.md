<!-- 职责：记录外部高星用量监控项目的刷新间隔与失败退避样本，以及「网络端点 vs 本地读取」的分档结论，用于判断本插件 `QUOTA_REFRESH_MS` 取值是否合理；不写本插件的刷新实现（见 AGENTS.md 与 `model/quota.ts`）、不写各项目功能评测。 -->

# 参考：用量监控项目的刷新间隔

查阅时间：2026-11-10。星数为当日 GitHub 搜索排序结果，仅用于筛样本。

## 0. 结论

**5 分钟属于「网络端点型」监控的主流值，不算长。**

刷新间隔几乎完全由**数据源成本**决定，而不是由 UI 的「实时感」决定：

| 数据源 | 典型间隔 | 原因 |
| --- | --- | --- |
| 本地 JSONL / 缓存文件 / DB | 1–10 秒 | 无网络成本，可随便读；配缓存 TTL 防重复解析 |
| 远端额度端点（HTTP） | 60 秒 – 15 分钟 | 端点普遍限流（429），高频轮询会被退避吃掉，反而更不实时 |

本插件（`QUOTA_REFRESH_MS = 5min` + 60s 心跳 + 5→15min 退避）落在后一档的中位，与同生态的 `slkiser/opencode-quota` 默认值完全一致。

## 1. 样本

| 项目 | ★ | 默认刷新 | 数据源 / 机制 |
| --- | --- | --- | --- |
| `Maciek-roboblog/Claude-Code-Usage-Monitor` | 8799 | **10 秒**（`--refresh-rate` 可调） | 读本地 Claude JSONL；`DataManager(cache_ttl=5)` |
| `HermannBjorgvin/Clawdmeter` | 2337 | 工作态 **3 分钟**、无 hook **5 分钟**、Stop 后约 **10 秒一次**、静默 10 分钟后 **15 分钟**、非当前账号 **10 分钟** | 打 `/usage` 端点；任何触发都不在 2 分钟内重复；失败退避 **10→20→30 分钟**（注释称 10 分钟下限来自 Claude Code 自身对 429 的记忆） |
| `Iamshankhadeep/ccseva` | 808 | **60 秒**（可配，最小 10 秒） | 直打用量接口 |
| `CodeZeno/Claude-Code-Usage-Monitor` | 696 | **15 分钟**（可选 1/2/5/7/15/60/120/1440 分钟） | 轮询多供应商端点 |
| `leeguooooo/claude-code-usage-bar` | 390 | **1 秒** | 本地缓存 + 后台 daemon（自称 1%/CPU） |
| `richhickson/claudecodeusage` | 341 | **5 分钟**，睡眠唤醒时补刷 | 打远端用量接口 |
| `slkiser/opencode-quota` | — | **5 分钟**（`providers.checking.minIntervalMs=300000`）；有模型回合时允许降到 **30 秒** | 失败退避 **60 秒→15 分钟**，并遵守 `Retry-After` |

## 2. 值得注意的几个设计

- **事件驱动优于固定高频**：Clawdmeter 把「刚有模型回合」当作最近的刷新时机（3 分钟），空闲后逐步退到 15 分钟。固定 60 秒轮询在限流端点上会被 429 反噬，实际有效刷新率更低。
- **回合后补刷是低成本提升**：opencode-quota 不缩短全局间隔，只在 `reason === "turn"` 时把等待压到 `min(minIntervalMs, 30s)`。这样「刚问完一轮」的数据滞后最多 30 秒，而空闲时仍是 5 分钟。
- **失败退避差异不大**：网络型项目普遍是 1–10 分钟起步、15–30 分钟封顶；clawdmeter 的 10 分钟起步是特例，因为它以 Claude 官方 429 记忆期为下限。
- **健康检查与网络刷新分离**：本插件的 60 秒心跳（解析凭据、判断退避）不等于 60 秒请求；同类项目也普遍把「检查该不该刷」和「真的发请求」拆开。

## 3. 对本插件的判断

- **保持 5 分钟合理**。额度窗口是 5 小时/周/月级别，数据本身变化慢；5 分钟滞后对决策没有实质影响，却把日请求量从 1440 次（60 秒）降到 288 次。
- **不要直接降到 60 秒**，除非先确认 `opencode-go` / `openai` 的额度端点没有严格限流或按次计费。Clawdmeter 的经历说明高频轮询会拿到 429，随后被退避打得比原来更稀疏。
- **若要提升「刚用完」的即时性**，优先级是：回合结束后延迟一次补刷（30 秒档）> 侧栏手动刷新入口 > 全局缩短间隔。当前 `QuotaStore.load(pid, { force })` 的 `force` 参数在生产代码中**没有调用方**，属于未接线能力。

## 4. 复验方法

```powershell
gh search repos "claude code usage" --sort stars --limit 15 --json fullName,stargazersCount
gh search code "interval" repo:<owner>/<repo> --limit 20 --json path
gh repo read-file <path> -R <owner>/<repo>
```
