# 性能区块设计（首字 + 速度）

<!-- 职责：定义 TTFT / token 速度两指标的口径、取数来源与底部状态栏布局；不写：子代理区块（见 docs/design-subagent-section.md）、额度查询、安装更新 -->

- 状态：**已实现**（2026-10-19，v2.4.0）
- 落点：`prompt.footer.status`（输入框下方状态行，目录路径与 `295.0K (28%)` 之间）
- 前提：只支持 opencode2；不做命令、不做 `ui.panel`、**不显示延迟**

## 1. 为什么是这个落点

`component/prompt/index.tsx` 的结构：

```tsx
<box flexDirection="row" justifyContent="space-between" gap={2}>
  <Slot path="prompt.footer">
    <Slot path="prompt.footer.status">
      <box flexGrow={1} flexShrink={1} minWidth={0}>  ← 目录路径 / interrupt，左对齐
    </Slot>
    <Slot path="prompt.footer.file">…</Slot>
  </Slot>
  {宿主 builtin append: "295.0K (28%)" + "ctrl+p commands"}
</box>
```

- 元信息行（`Build · Deepseek V4.1 Flash … high`）是 `PromptMetadataRow`，**不在 slot 树里**，无法注入。
- `prompt.footer.status` 的状态盒是 `flexGrow={1} flexShrink={1} minWidth={0}`，**会自动让位**：我们以 `flexShrink={0}` 追加，宽度稳定，代价是路径被截短。

## 2. 口径（精确值）

对每条 assistant 消息（= v2 的一步）：

```
工具区间 = 所有 part.type==="tool" 的 [time.ran ?? time.created, time.completed] 并集（重叠去重、钳位）
firstStart = 所有内容 part 的最早 time.created（reasoning 有 time.created；tool 有 time.created）
genMs     = completed − firstStart − 工具区间总长
ttft      = firstStart − time.created
tps       = (tokens.output + tokens.reasoning) / genMs × 1000
```

**首字时刻的关键事实**（本机 3000 条 assistant 消息实测）：

- `SessionMessageAssistantText` **没有时间字段**；`SessionMessageAssistantReasoning` 有 `time.{created,completed}`；`tool` 有 `time.{created,ran,completed}`。
- 实测 2782 条带 tokens 的消息中，**首 content part 全部是 reasoning，且都带 time.created**（`open-design/deepseek-v4.1-flash` 2586/2586，`opencode-go/deepseek-v4.1-flash` 176/190 靠 reasoning、14 靠 tool）。
- 因此**历史数据可算 TTFT**，不必等插件运行。

**直接吐正文（无 reasoning、无先发工具）的模型**：历史消息缺首字时刻 → 该步不产出 TTFT 样本（不填 0、不猜）。插件运行期间用事件补：订阅 `session.text.started` / `session.reasoning.started` / `session.tool.input.started`，把 `event.created` 按 `assistantMessageID` 记进 `Map`（会话级、内存态）。

**守卫**（防抖与防虚高）：

- `MIN_GEN_MS = 300`：净生成窗口过短的步不计 TPS。
- `BUFFER_MS_PER_TOKEN = 1.0`：`genMs < genTok × 1.0` 视为异常，不计 TPS。
- 不通过守卫的步仍产出 ttft。

**展示哪个样本**：从最后一条 assistant 向前回溯，取**最近一条有效样本**（ttft 与 tps 可来自不同步——速度允许继续向前找）。不显示会话中位数（宽度不足，且单次值与中位并列会误读）。

**不做延迟**：`completed − created − 工具区间` 与「首字 + 速度」高度相关，信息增量小；用户明确只要首字与速度。

## 3. 实时值（流式期间）

### 为什么不采用滚动窗口

同类实现分五派（2026-10-19 核对源码）：

| 实现 | 算法 | 参数 |
| --- | --- | --- |
| 宿主 `turnTokensPerSecond` | `Σ(output+reasoning) / Σ(streamed − created)`，按回合聚合 | 含 TTFT、不含工具；要求每步都有 `streamed` |
| **DeepSeek Harness** | `Σ outputTokens / Σ(completed − firstToken)`，**仅步骤结束**，无实时值 | 缺采样整条丢弃；不扣工具（架构保证） |
| `doorlockdoor/opencode-cache-and-tps` | `estTok / (now − firstStart − 工具区间)`，**累计口径** | 守卫 500ms / 8 tok；工具相位冻结 |
| `ChiR24/opencode-tps-meter` | **每块按其生成区间计价** + 1s 滚动窗口 | `MIN_RATE_SPAN_MS=50`、`STALL_REPUBLISH_MS=250` |
| `williamcr01/opencode-tps` | 5s 样本窗口，跳过静默 gap | stale 1.5s 返回 -1 |
| `floze-the-genius/opencode-tps-meter` | 15s 窗口，gap 截断 | 打补丁进宿主本体 |

**ChiR24 的两条实测结论值得记录**：

1. v2 的 delta 按 **~100ms 批次**下发，不是逐 token——拿单块 token 数除以更短的时间会算出 10000 tok/s 这类离谱值。
2. **首块（含 prefill）只计入分子、不计入分母**，否则单块样本会把速度压得极低。

我们的累计口径天然不受第 1 点影响（分子分母都从 `firstStart` 累计），且第 2 点正好是对的：`firstStart` 取首个内容到达时刻，prefill 本就在分母之外。

### DeepSeek Harness 的做法（重要对照）

`packages/session/session-stats/src/projection.ts` + `packages/client/ui-chat/src/client/contract/turn-metrics.ts`：

```ts
tps      = decodeTokens / (decodeMs / 1000)
ttftMs   = firstTokenTime − stepStartTime
decodeMs = completedTime − firstTokenTime
decodeTokens = usage.outputTokens        // 供应商精确值
```

四个要点：

1. **首 token 定义更宽**：`isTokenDelta` 把非空 `text-delta` / `reasoning-delta` / `tool-call-delta`（`argumentsDelta` 非空或 `name` 存在）都算作首 token。
2. **先聚合再相除**：`Σtokens / Σms`，每步按时长加权。
3. **缺采样整条丢弃**：任一步缺 `firstTokenTime` 或 `usage` 就退出分子分母，明确「以省略的方式退化，而不是渲染成零」。
4. **没有实时值**：`StatsPills` 注释写明 `Settled-node identity prevents stream-delta updates from rerendering the pills`——只在步骤结束更新。

**不能照抄的一点**：dsh 的 `decodeMs = completedTime − firstTokenTime` 天然不含工具时间，因为它的**工具在步与步之间**（`assistant/message` 在 LLM 流结束时组装，之后才跑工具）；而 opencode v2 的一条 assistant 消息把 text/reasoning 与 tool part 放在同一个 content 数组里，工具在**步内部**——所以我们必须扣工具区间并集。

**他们自己承认的局限**（归档笔记原文）：读数来自实测墙钟，**不可复现**——同一回放场景连续两次跑出 69 与 70 tok/s，一段 3ms 的回放流会读成 26333 tok/s。这正是实时侧需要 500ms / 8 tok 守卫的原因。

**选 2s 滑动窗口而非累计平均**：累计口径在起始高速后会单调衰减（实测 225 → 70.6 且永不恢复），这是分子增长慢于分母增长的必然结果，不是模型变慢。窗口取 2s（`LIVE_WINDOW_MS`）、要求净生成 ≥ 800ms（`LIVE_MIN_SPAN_MS`），既能让读数跟上真实转速，也不会因单批 delta 抖动。工具相位仍冻结（工具时间已从分母扣除）。

**跨步取值**：我们显示的是"当前这一步"，取最近有效样本；dsh 显示轮次/会话汇总，所以用加权平均。两者口径不同，不混用。

### 口径差异（不是 bug）

- 宿主：`Σtok / Σ(streamed − created)` = 体感速度（**含** TTFT）
- 我们：`tok / (completed − firstStart − tools)` = 输出速度（**不含** TTFT）

因此我们的数会略高于宿主 footer，属正常。

### 事件通道

| 用途 | 事件 | 处理 |
| --- | --- | --- |
| 首字时刻 | `session.text.started` / `session.reasoning.started` / `session.tool.input.started` | 记 `Map<assistantMessageID, event.created>`（最多 1024 条，超限丢最旧） |
| 触发重算 | `session.text.delta` / `session.reasoning.delta` / `session.tool.input.delta` | 前沿+尾沿节流 100ms → bump 版本信号 |
| 相位 | `session.tool.called` / `success` / `failed`、`session.step.ended` | 立即 bump（相位切换不能等节流） |
| 心跳 | — | **仅当 `status(sid) === "running"`** 时开 250ms interval，空闲立即清（用于捕捉停顿：无 delta 时速度应下降） |

实时估算：

```
estTok   = Σ estimateTokens(文本, 画像)      // 文本来自 part 内容；画像见下
genMs    = now − firstStart − 工具区间并集
tps      = estTok / genMs × 1000
```

- 画像（ASCII 字/token）：思考流 `4.0`、答案文本 `2.9`、工具/代码 `3.7`；汉字 `1.5` 字/token；假名/全角 `1` 字/token。
- 守卫：`genMs < 500ms` 或 `estTok < 8` → 速度沿用**本回合最近实时值**（没有则留空），不回落到精确值、不闪现。
- 工具相位（`state.status === "running"`，或 `time.ran` 已写且 `time.completed` 未写）：速度**冻结**在工具开始前的值（分子分母同时停摆），不显示工具计时，工具返回后严格接续。参数仍在生成的 `streaming` 态不冻结（模型还在吐 token）。
- 首字前（prefill）：显示累计等待时长 `0.42s…`（这是唯一会增长的计时），速度沿用本回合最近值（无则留空）。
- 净生成时长扣工具区间时按**并集去重**（并行工具不重复扣），并钳位到 `[firstStart, now]`。
- 滑动窗口起点钳位到「最近一次工具结束时刻」之后：否则工具返回后的第一个窗口会把整段工具执行期算进分母，速度骤降。

## 4. 布局与宽度预算

### 结构确认

`prompt.footer` 与 `prompt.footer.status` 的 `<Slot>` 均渲染为 fragment（不额外包 box），因此 `append: "prompt.footer.status"` 的内容会成为那个 `flexDirection="row"` 容器的**直接子元素**，与目录路径**同一行**、按 `gap={2}` 排列：

```
row (width 100%, justifyContent: space-between, gap 2)
 ├─ Slot prompt.footer.status
 │   ├─ 状态盒  flexGrow={1} flexShrink={1} minWidth={0}   ← 目录路径，会主动让位
 │   └─ 我们的块  flexShrink={0}                            ← 宽度稳定
 ├─ Slot prompt.footer.file                                ← 编辑器文件名
 └─ 宿主 builtin（append prompt.footer）                   ← "295.0K (28%)  ctrl+p commands"
```

我们用 `flexShrink={0}` 保持宽度，路径靠 `flexGrow={1}` 吸收剩余空间。

### 两档阈值

| 终端宽度 | 档位 | 显示 | 列宽 |
| --- | --- | --- | --- |
| ≥ 60 | 完整 | `0.42s · 48.2 tok/s` | 17 |
| < 60 或 `showDetails === false` | 极简 | `48.2 tok/s` | 10 |
| 首页 / 无 `sessionID` / 无有效样本 | 不渲染 | — | 0 |

**`60` 是宿主的硬阈值**（`component/prompt/index.tsx:1588` 的下界；宿主在 `interrupt > 0` 且宽度不足时收缩并隐藏 usage）。我们跟随它，避免出现「宿主数字消失、只剩我们的」割裂。注意 60 这个值来自宿主对「能否同时容纳 usage + 快捷键提示」的判断，我们保留 `showDetails === false` 这一条作为强制降档信号。

**不再有「首字」前缀**：状态行本就窄，`3.78s · 169 tok/s` 的顺序（时长在前、速度在后）已自明；去掉标签省 5 列（CJK 实占 5 列），完整档从 22 降到 17。原来靠 100 列区分的「详细档」与「紧凑档」在去掉前缀后内容完全相同，故合并为一档。

固定开销：

```
输入框左右 padding 4 + 宿主 usage 12 + 宿主 commands 15 + 三处 gap 6 + 我们的完整档 17 = 54
终端 100 → 目录路径剩 46 列
终端 80  → 路径剩 26 列（`D:\Code\...\tui-usage:main` 约 30 列 → 会被截断但可辨）
终端 60  → 路径剩 6 列 → 降到极简档
```

固定开销实为动态：宿主在无 usage / 无子代理时会改显示快捷键提示，宽度变化。因此分档只能保守，真正的兜底是容器 `flexShrink={0}` + 文本 `truncate`，极端宽度下截断自己而不是挤坏宿主。

**宽度来源**：`useTerminalDimensions()`（`@opentui/solid`，宿主同款，随 resize 响应式）；退路 `context.renderer.terminalWidth` + 自建 resize 监听。

### 四相位

同一位置、同一顺序，仅值与后缀变化：

| 相位 | 显示 |
| --- | --- |
| `prefill`（等首字） | `0.42s…` / `0.42s… · 48.2 tok/s` |
| `streaming` | `0.42s · 48.2 tok/s` |
| `tool`（工具运行中） | `0.42s · 48.2 tok/s`（速度**冻结**，与上游一致） |
| `idle`（回合结束） | `0.42s · 48.2 tok/s` |

- **`…` 只加在「单调递增的计时器」上**（对齐上游 `live.ts:196-217`）：工具计时、延迟在涨 → 带；首字时长仅 `prefill` 阶段在涨 → 带。**速度是比值，从不带 `…`**。
- 实时值与精确值**不靠 `…` 区分**：上游用两个互斥的渲染函数（`liveStatSegs` / `pushPerfSegs`），回合结束整体切换。我们同理——`live` 有值就用实时，否则回落精确值，二者都是纯数字。
- **工具相位冻结速度**（已定，方案 A）：工具时间已从分母扣除，冻结值是语义正确的"暂停前最近值"；不单独显示工具计时，不衰减到 0（衰减会让人误以为模型卡了）。
- 无任何有效样本（新会话、无 reasoning 的模型且插件刚启动）→ 不渲染，不显示 `--`。

### 交互

**纯展示，不可点击**。不做「点击切换详细/极简」、不做 hover、不弹窗。档位只由终端宽度与 `showDetails` 决定。

## 5. 不做的部分

- 会话级中位数（宽度不足；单次值已能表达量级）
- 体感 TPS 双模式（只保留"输出速度"一种：净生成时长口径）
- 侧边栏展示（落点固定在底部状态行）
- 历史文本首字补造（无时间戳就是无，不猜）
- 温度/成本/模型名等元信息（元信息行不可注入）
- **任何鼠标交互**：不可点击、不切换档位、不弹窗（档位只由宽度与 `showDetails` 决定）

## 6. 已知取舍

1. **首次启动无历史**：`Map` 只在本次进程内累积，重启后历史消息仍可算（靠 reasoning/tool 时间戳），只有"直接吐正文的模型"的历史步拿不到首字。
2. **实时值是估算**：`estimateTokens` 与供应商真实分词有 ±10% 级误差，`session.step.ended` 后由精确值替换。
3. **工具相位速度消失**：这是刻意的（冻结值 vs 0 的歧义），工具返回后速度立即恢复。
