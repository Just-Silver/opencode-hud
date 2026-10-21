# 外部同类：实时 TPS / 首 Token 实现对照

<!-- 职责：对照 GitHub 上高星 OpenCode TPS 插件（v1/v2）的实时速度、防抖与首 Token 口径，提炼可借鉴做法；不写：本项目自身实现细节（见 docs/design-performance-footer.md）、额度与安装 -->

> **历史文档（2026-10-21 归档）**：本项目**已不再实现实时速度**（v4.0.0 移除全部实时链路，只显示每个 assistant 步结束后的精确值，见 `docs/design-performance-footer.md` §3）。本文保留作为「实时口径为什么不可靠」的调研证据，不再代表当前设计。

- 调研时间：2026-10-20
- 方法：按 star 排序抓取候选仓库后 `git clone --depth 1` 直接读源码（非 README 推断）
- 结论一句话：**没有人用「从首 token 起的累计时间」当实时分母**；高星实现要么按「每个 chunk 的生成区间」计权（ChiR24），要么用短窗口 + 空档裁切，并且在无 token 到达时**隐藏或冻结**读数，而不是让它自然衰减。

## 1. 样本（按 star 排序）

| 仓库 | ★ | 适配 | 落点 / 形态 | 关键文件 |
| --- | --- | --- | --- | --- |
| `Tarquinen/oc-tps` | 170 | **v2**（`@opencode/plugin@2.0.10`） | `prompt.footer`，显示 `TPS / AVG / TTFT` | `tui.tsx`（单文件） |
| `floze-the-genius/opencode-tps-meter` | 95 | v1 时代（patch 宿主 1.3.13/1.3.14） | 直接补丁宿主 `Prompt` footer | `patches/opencode-1.3.14-tps.patch` |
| `williamcr01/opencode-tps` | 48 | v1（`@opencode-ai/plugin/tui`） | `session_prompt_right`，显示 `TPS x` | `tps.tsx`（单文件） |
| `ChiR24/opencode-tps-meter` | 35 | v1 + **v2** | `prompt.footer` 单行 + family 吞吐视图 + 仪表盘 | `src/tracker.ts`、`src/v2/meter.ts`、`src/v2/metrics.ts` |
| `doorlockdoor/opencode-cache-and-tps` | 4 | v1 + v2 | 侧边栏性能段（本插件设计来源） | `src/live.ts`、`src/perf.ts` |

> star 数只代表关注度，不代表算法质量；本表用于看**做法分布**。

## 2. 实时 TPS 怎么算

### Tarquinen/oc-tps（v2，170★）

```
samples: 每个 delta 到达时 push {at: event.created, tokens: bytes(delta)/5}
live = Σ tokens(最近 5s 内样本)
     / activeDuration(样本间隔之和 + 尾部间隔, 下限 1s)
显示条件：status === "running" 且 now − 最后样本 ≤ 1500ms，否则显示 "-"
```

- 工具相关：`session.tool.input.started` 与回合结束都 **清空 samples** → 工具参数流式期与工具执行期**不显示**实时值。
- 它从不显示一个“正在下降”的旧值：过期即 `-`。

### floze（宿主补丁，95★）

```
STREAM_WINDOW_MS = 15000
activeDuration = Σ min(相邻样本间隔, 1250ms) + min(尾部间隔, 1250ms)
live = Σ tokens(窗口内) / activeDuration
陈旧：now − 最后样本 > 1500ms → 不渲染
```

- **空档裁切 1250ms** 是核心防抖手段：模型停顿/工具等待再长，分母最多只记 1.25s，恢复输出时速度不会断崖。
- 没有任何工具事件处理，纯靠窗口 + 裁切 + 陈旧隐藏。

### williamcr01/opencode-tps（v1，48★）

```
SAMPLE_WINDOW_MS = 5000
activeDuration = Σ 样本间隔 + min(尾部间隔, 1000ms)，下限 250ms
单样本时：clamp(now − 样本时间, 250, 1000)
陈旧：> 1500ms → 显示 "-"
工具：part.type==="tool" 且 status ∈ {running, completed, error} → 清空该会话 samples
```

- 与 tarq 同思路：**工具相位直接清空**，宁可空着也不给一个衰减值。
- 只算 `field === "text"` 的 delta（reasoning 是否在该版本存在差异），估算 `bytes/5`。

### ChiR24/opencode-tps-meter（35★，算法最完整）

核心不是“窗口内有几个 token”，而是**每个 chunk 按它自己的生成区间计权**（`src/tracker.ts`）：

```
recordTokens(count, at):
  第一个 chunk（或与上一个同一时刻的整批）→ 只计入总数，不进速率（生成区间未知）
  其余：entries.push({ from: 上一个 chunk 的 at, at, count })
        ratedTokens += count

rateAt(now):
  start = max(now - 滚动窗口, origin)        // 默认窗口 1000ms
  span = now - start；span < 50ms → 不可测（不猜）
  tokens = Σ entry.count × overlap(entry.from..entry.at, start..now) / (entry.at - entry.from)
  return tokens / span
```

- 关键点：chunk 的 token 是**在上一 chunk 到这一 chunk 之间生成**的（v2 约 100ms 批量下发），按区间摊到窗口里，而不是“到达瞬间全算在当前时刻”；
- **首个 chunk 不进分母**（它可能包含 prefill/首字，见下）；
- 窗口 1s、最小跨度 50ms、缓冲 256 条（超出时合并相邻项而不是丢 token）；
- 停顿：`STALL_REPUBLISH_MS = 250` 定时按 `now` 重算 → 无 token 时 1s 内自然衰减到 0（这是它唯一“允许下降”的场景，且窗口本身就短）；
- 步骤结束：用**精确步均值**（provider tokens；`correctedAverage` 在 0.5~2 倍内才用真实 token 校正估算），并置 `active=false`，UI 显示 `avg`；因此工具执行期显示的是**冻结的步均值**，不是衰减中的即时值；
- 刷新节流 8ms（v2）；`minVisibleTPS` 以下不发布。

### doorlockdoor/opencode-cache-and-tps（4★，本插件来源）

- 工具执行期：**冻结**在工具开始前的值（冻结实现与本插件同源）；
- 与本插件差异：它还有 tool 计时、延迟指标、多种展示风格；实时窗口口径在本插件里做了 2s + 800ms 最小跨度 + 一致性守卫。

## 3. 防波动手段汇总

| 手段 | tarq | floz | will | chi | 本插件 |
| --- | --- | --- | --- | --- | --- |
| 窗口长度 | 5s | 15s | 5s | **1s** | 2s |
| 最小可测跨度 | 1s（单样本 250~1000ms） | 1s | 250ms | **50ms**（且 span 不足不发布） | 800ms |
| 窗口内空档处理 | 只裁尾部 1s | **每个间隔裁到 1.25s** | 只裁尾部 1s | 短窗口自然滑出 | 不裁 |
| chunk 生成区间计权 | 否 | 否 | 否 | **是（重叠加权）** | 否（按 tick 采样累计值） |
| 首个 chunk 不计速率 | 否 | 否 | 否 | **是** | 是（`firstStart` 之后才算） |
| 陈旧处理 | 1.5s → `-` | 1.5s → 隐藏 | 1.5s → `-` | 衰减到 0 + 步结束后换 avg | **冻结** |
| 工具相位 | 清空 samples | 无处理 | 清空 samples | 步结束即冻结为 avg | **冻结** |
| 步结束取值 | 精确 token / 生成期 | 精确 token / 活动时长 | 无 | provider token 校正的均值 | 精确 tokens /（完成−首内容−工具） |
| 刷新节流 | 1s tick | 1s tick | 1s tick | 8ms + 250ms 停顿重发 | 100ms/250ms |
| 估算校准 | 无（bytes/5） | 无（bytes/4） | 无（bytes/5） | **按模型学习 chars/token（0.25~4，加权 20k tok）** | 固定画像（思考 4.0 / 答案 2.9 / 代码 3.7） |

## 4. 首 Token（TTFT）怎么算

三种口径，实际都在用：

| 实现 | 起点 | 终点（首 token） | 展示 |
| --- | --- | --- | --- |
| tarq | `session.execution.started`（回合开始） | 首个 text/reasoning delta，或 `session.tool.input.started` | **按步求平均**（`Σttft/stepCount`） |
| chi | `session.execution.started`（每回合重置） | 首个任意 delta（text/reasoning/tool input 都算） | **回合级只记一次**，后续步不重复计入 |
| will / floz | — | — | 不显示 TTFT |
| 本插件 | 消息 `time.created`（每步） | 首个 content part / 于运行期用 `session.*.started` 事件补齐 | 最近一条有效步，不回退平均 |

- **本项目现状（v4.0.0）**：只算「最近一条已完成步的精确值」，无实时读数、无窗口、无平滑、无事件订阅——每个 assistant 步结束刷新一次。下表的「本插件」列是**历史实现**（已删除），保留用于对照。

共识与差异：

- **首 token 包含工具参数**：chi 与 tarq 都把 `tool.input` 的第一个 delta/started 当作首 token（DeepSeek Harness 也一样，`argumentsDelta` 非空算首 token）。
- **首 token 不含工具执行**：工具执行发生在该步 token 流结束之后（v2 中一条 assistant 消息 = 一步，`time.streamed` 在工具运行之前），所以工具计时既不进 TTFT，也不该进速度分母。
- 首 token 起点用**回合开始**（`execution.started`）还是**步开始**（`step.started` / `message.created`）决定数值含义：
  - 回合级 = 用户按回车到第一次出字（含排队、prefill、思考）；
  - 步级 = 本步请求到本步首字（多步回合里每步都有）。
  tarq 取 `execution.started` 但按步平均，会把“回合首步的排队时间”摊进每一步均值；chi 明确只记一次，避免重复。
- **`finished === "tool-calls"` 是速度窗口的天然右界**（tarq）：步均值的结束时间取 `lastToolCallAt` 而不是 `step.ended`，避免把工具执行算进生成时长。

## 5. 网关与推理引擎的实际口径（补充调研 2026-10-20）

结论先说：**网关项目基本不做“实时 TPS”**；真正定义这个指标的是推理引擎。

### new-api（Go，网关，最接近“网关统计 TPS”的实现）

`pkg/perf_metrics/metrics.go`：

```
ttftMs       = FirstResponseTime − StartTime          // 请求开始 → 首个响应字节
generationMs = End − FirstResponseTime                 // 首响应 → 流结束
avg_tps      = Σ provider 上报的 completion_tokens / Σ generationMs
```

- 只在请求结束时采样一次，按小时桶聚合到数据库，前端展示 `avg_tps` / `avg_ttft_ms`；**没有实时值、没有窗口、没有平滑**。
- 分子是 **provider 返回的真实 token**（`usage.CompletionTokens`），不是估算。
- 分母包含首响应之后的全部时间（包括供应商限流/停顿）；网关一次请求里没有工具执行，所以无需处理工具。
- `RelayInfo.SetFirstResponseTime()` 在首次向客户端写出响应时置位；非流式请求没有 TTFT，退化为整段 latency。

### one-api

没有 TPS / TTFT 指标，只有请求耗时日志（`param.Latency`），完全不存在实时速度概念。

### LiteLLM

只有 Prometheus 计数器：`litellm_total_tokens_metric_total` 等；K8s HPA 用 `sum(rate(...[1m]))` 得到每 pod 的 tokens/s。官方注释明确 **“Tokens are counted when a response completes, so TPS trails long streams.”** 仅用于容量扩缩，不是用户体验指标。

### vLLM（推理引擎，事实标准）

`vllm/v1/metrics/stats.py`：

```
TTFT   = first_token_ts − arrival_time
ITL    = 相邻两次 new_token 的 engine 时间差
decode_time = last_token_ts − first_token_ts
mean_time_per_output_token = decode_time / (num_generation_tokens − 1)
TPS ≈ 1 / mean_time_per_output_token = (N − 1) / (last_token_ts − first_token_ts)
```

- 源码注释：**“Do not count the token generated by the prefill phase.”** —— 首 token 不计入解码时长，这一点和我们一致。
- **ITL 包含解码期间的停顿**（抢占、批调度、限流），所以引擎侧速度是会掉的；它衡量的是“实际出字速率”，不做静默剔除。
- 暴露为 Prometheus 直方图（`vllm:time_to_first_token_seconds`、`vllm:inter_token_latency_seconds`），不提供实时读数。

### 与本插件的关系

| 口径 | 公式 | 性质 |
| --- | --- | --- |
| new-api / vLLM | tokens / 解码墙钟（首 token 之后） | 服务端事实标准，**含停顿**，无实时值 |
| 本插件精确值 | (output+reasoning) / (completed − 首内容 − 工具区间) | 与上者形状一致；工具区间是 opencode 特有扣除 |
| 本插件实时值 | 2s 窗口内增量 / **活动时长** | 客户端适配：不把“看不见的等待”算进分母 |

因此：**精确口径是标准的**（tokens / decode time，扣工具）；**实时口径不是标准做法**，是为“客户端看不到隐形思考、deltas 批量下发、工具在步内执行”做的折中。若严格对齐 vLLM，应把停顿计入分母（速度会掉）；本项目选择掉值只反映“有 token 产出时的真实速率”，代价是读不到真实卡顿。

## 6. 对本项目的启示（针对「工具前后速度下掉」）

高星实现里没有“工具前隐形思考 + 累计分母”这个组合，原因有两层：

1. **分母不是从首 token 起算的墙钟**，而是「有 token 的 chunk 区间之和」（chi）或「短窗口 + 空档裁切」（floz）。改造前本插件用 `now − firstStart − 工具区间`，只要出现“没有可观测 token 的时段”（思考内容不返回、工具参数未开始、工具刚结束），分母就白涨。
2. **无 token 到达时的显示策略是“隐藏/冻结/换均值”**，不是“回落累计平均”。改造前 `windowedTps` 失败后回退 `estTok / elapsed` 的累计分支，正是“掉下去且不回收”的直接来源。

可借用、按收益排序（**1~3 曾于 2026-10-20 落地，2026-10-21 随实时链路一并移除**；最终只保留「步结束用精确值」，见 `docs/design-performance-footer.md` §3）：

1. **实时分母改成活动时长**：采样点之间 `tok` 不变的间隔不计入（单段封顶 1250ms）。等价于 floz 的 `ACTIVE_GAP_MS`，但以“有无新增 token”为判据，比固定裁切更适合隐形思考。
2. **窗口失效时保持冻结值**，不要回落累计平均；工具结束后的窗口重建期沿用工具前冻结值。
3. **步结束时用精确均值替换**：v2 的 `session.step.ended` 带 `tokens` 与 `finish`；本插件改为「最后一条消息已 completed → 交回精确值」，比冻结一个实时估算值更稳。
4. **首个可见 chunk 不计速率**（chi）：与 `firstStart` 语义等价，但若改用 chunk 区间模型，需要显式跳过。
5. 可选：**按模型校准 chars/token**；对本机 `open-design/deepseek-v4.1-flash`（约 2/3 的 reasoning 文本为空）意义有限——分子缺失无法靠系数补，反而会放大误差，校准应只在“流式文本与 provider token 统计同一批输出”时启用（chi 的 0.5~2 倍守卫正是这个意思）。

## 7. 与既有文档的关系

- 本项目性能口径与落点：`docs/design-performance-footer.md`
- `doorlockdoor/opencode-cache-and-tps` 的其余可借鉴项（运行时常驻、命令层、凭据解析等）：`docs/reference-opencode-cache-and-tps.md`
