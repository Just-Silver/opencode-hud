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
activeMs = Σ「token 有增长的采样间隔」（单段 ≤ 1250ms）
tps      = estTok 的窗口内增量 / activeMs × 1000
```

- 分母是**活动时长**，不是「从首字起的墙钟」：无 token 产出的时段（等待首字、思考内容不返回、工具执行、工具返回后重新 prefill）不计入。否则这些时段只会让读数一路衰减且不回收。
- 画像（ASCII 字/token）：思考流 `4.0`、答案文本 `2.9`、工具/代码 `3.7`；汉字 `1.5` 字/token；假名/全角 `1` 字/token。
- 守卫：活动时长 < 800ms 或窗口内增量 < 8 tok → 速度沿用**本回合最近实时值**（没有则留空），**不回落累计平均**、不闪现。
- 工具相位（`state.status === "running"`，或 `time.ran` 已写且 `time.completed` 未写）：速度**冻结**在工具开始前的值（分子分母同时停摆），UI **只显示 spinner，不显示任何文字/数字**（冻结值没有信息量，还会被误读成模型变慢）；工具结束时若该步已 `completed`，交回精确值。参数仍在生成的 `streaming` 态不冻结（模型还在吐 token）。
- 首字前（prefill）：显示累计等待时长 `0.42s…`（唯一会增长的计时），速度沿用本回合最近值（无则留空）。
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
| `tool`（工具运行中） | `0.42s · 48.2 tok/s ⠹`（数值冻结并**整体变灰**，行尾 80ms spinner） |
| `idle`（回合结束 / 步已完成） | `0.42s · 48.2 tok/s` |

- **`…` 只加在「单调递增的计时器」上**（对齐上游 `live.ts:196-217`）：首字时长仅 `prefill` 阶段在涨 → 带；**速度是比值，从不带 `…`**。
- 实时值与精确值**不靠 `…` 区分**：上游用两个互斥的渲染函数（`liveStatSegs` / `pushPerfSegs`），回合结束整体切换。我们同理——`live` 有值就用实时，否则回落精确值，二者都是纯数字。
- **工具相位：数值变灰 + 行尾 spinner**（已定）：冻结值语义上是“暂停前最近值”，但单看数字无法与「生成得慢」区分；**整行变灰（`MUTED_COLOR`）+ spinner** 表达“正在执行工具、数值冻结”。**不替换、不隐藏数值**——整行内容保持不动，避免每次工具执行时闪没再回来。
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
2. **实时值是估算**：`estimateTokens` 与供应商真实分词有误差——本机 5989 条实测**中位 0.80、加权 0.96**（纯文本 0.98~1.01，含工具 0.86，纯工具步 0.62，见 §7.3）。`session.step.ended` 后由精确值替换。
3. **工具相位数值冻结、行尾加 spinner**：数值保留（不隐藏，避免整行闪动），spinner 是“正在执行工具”的准确信号；工具返回后 spinner 消失、速度恢复。
4. **分母是活动时长**：没有可观测 token 的时段（含思考内容不返回的模型）不计入，因此真实卡顿不会让读数下降；需要观察卡顿时看首字计时与东西本身的行为。

## 7. 偏高与不准的机制（已量化，2026-10-21）

这两条是历史记录，其中 7.1 的机制已被推翻并修复（见该节顶部说明），保留用于说明「为什么不能按采样点算分母」。

### 7.1 ~~delta 粒度 × 活动时长口径~~（已修复）

> **已被推翻并修复（2026-10-21）**：速度本来就是「一个时间窗口内产出了多少 token」，
> 窗口长度由墙钟确定，**不该取决于采样点落在哪里**。旧实现用「观测到增长的采样间隔」
> 累加分母，才会受 delta 节奏影响——那是算法缺陷，不是需要实测校准的参数。
> 现 `windowedTps` 的分母 = `min(now, 最后一次增长时刻) − 窗口起点`，与 delta 节奏无关。
> 修复后仿真：delta 50/100/150/200/300/400ms 偏差 ≤7%（原为 0%/+11%/+25%/+43%/+102%/+100%），
> 900ms 极端仍有 +28%（离散采样固有，无法用固定阈值消除）。下文的原始记录保留作背景。

`activeMsBetween` 只累计「本次采样相对上一次采样 token 有增长」的区间，且区间长度取 `s.at - prevAt` —— `prevAt` 是**上一个采样点**，不是上一次增长点。两次 delta 之间的静默采样（250ms 心跳正好插在中间）会把一段连续生成切成多段，而每段只在最后一跳计入，中间的静默跳贡献 0：

```
真实 50 tok/s，delta 每 200ms 到一批（每批 10 tok），心跳 250ms：
采样: tok 5 → 10 → 15 → 20 …（每批之间夹一个无增长的心跳采样）
分母: 每 400ms 里只算 200ms → 读数 ≈ 100 tok/s（+100%）
```

仿真（真实 `windowedTps`，采样 = delta ∪ 250ms 心跳）稳定期偏差：

| delta 间隔 | 50 tok/s 真实 | 读数 | 150 tok/s 真实 | 读数 |
| --- | --- | --- | --- | --- |
| 50ms | 50 | 50（0%） | — | — |
| 100ms | 50 | 56（+11%） | 150 | 167（+11%） |
| 200ms | 50 | 71（+43%） | 150 | 214（+43%） |
| 300ms | 50 | 102（**+104%**） | — | — |
| 400/800ms | 50 | 守卫不通过，**沿用旧值**（读数冻结） | 150 | 同左 |

即：**delta 越粗 → 分母被切得越碎 → 读数越高**；粗到批间隔 > 活动时长下限时，守卫整窗不通过，读数停在上一个值（不回落、不报错，看起来像"卡住了"）。只有心跳、没有 delta 采样时同理。

旁证：单独关掉心跳（只剩 delta 采样点）偏差全为 0% —— 说明偏高来自「静默采样点参与切分」，不是窗口长度或插值本身。

### 7.2 停顿/抖动后的补发簇（已被 7.1 的修复覆盖）

旧口径下 `ACTIVE_GAP_CAP_MS = 1250` 只给单段封顶，当窗口内已有 ≥800ms 有效活动时，一次补发会按「新增 token / 很小的新分母」算出极大值（仿真：100 tok/s 流 1.5s 抖动后补发 200 tok → **1111 tok/s**）。

墙钟窗口口径下，补发的 token 落进它真实占用的时间跨度，峰值降到 1.8~2.4 倍以内，无需额外限速机制。**不做**「超阈值视为补发簇」的处理：那必须引入一个固定 token 阈值，而阈值大小随模型速度变化、无法给出无魔法值的依据。

v2 的 delta 走 SSE，网络抖动/宿主批量投递都会造成这种簇；读数会跳一下再被后续窗口拉回。

### 7.3 估算分子（已实现可学习校准）
旧实现用固定画像（思考 4.0 / 答案 2.9 / 工具 3.7 字符每 token），实测整体中位 0.80、纯工具步 0.62，且三个数里两个从未被真实数据验证过（思考与答案总是同步出现，无法分离）。

现改为 **逐类字符计数 × 在线学习系数**（`model/calibration.ts` + `model/prior.ts`）：

```
真实token ≈ Σ cᵢ·字符数ᵢ + c_tool·工具调用次数
特征 = [英文字母, 数字, 标点, CJK(汉字+全角), 工具调用次数]   （空白不计：BPE 并入相邻 token）
```

**五特征而非六特征**：`汉字` 与 `全角` 的相关系数为 **0.98**（中文内容里全角标点总跟着汉字出现），数学上无法分别识别——拟合时两者系数会互相抵消（学出「汉字 2.07 / 全角 0.30」这种组合），样本量增大也不收敛（n=10→43 时仍在 ±1.3 摆动）。合并为 `CJK` 后稳定性从 ±1.3 提升到 **±0.08**。

- **先验是「点估计 + 置信度」的成对信息**（`model/prior.ts`）：系数与协方差来自同一份 ~9900 步拟合，改动其一必须整体重拟合。协方差是**满阵而非对角阵**——`字母` 与 `标点` 的相关系数为 **−0.90**（此消彼长），只填对角会把这种耦合当成两个独立误差，滤波器在正交方向反复横跳。
- **`PRIOR_INFLATION = 8`**：先验精度按 8² 膨胀后作为初始协方差，等价于「先验折合约 1180 条等效样本」。取值依据写在 `prior.ts`：实测安全区间 [×4, ×16] 的几何中点；**×16 已实测出界**（不伤验证劣化），注释中明确警告勿调。
- **`R = ĉ·ŷ`（γ=1）**：方差随预测量线性增长（计数型失配的默认假设）。γ 取值经 5 次随机子集回放验证，1.0 在终点指标上 5/5 全胜；`ĉ` 用窗口内归一化新息的 MAD 在线估（相对残差重尾，实测 p99/p50=4.1，故不用 std）。
- **gate**：归一化新息超 3σ 的观测不参与更新也不污染 `ĉ`。
- **分桶**：按 `providerID/modelID` 隔离（不同分词器合并表不同，系数不可混用），切回用过的桶即时恢复；纯内存 `Map`，重启从先验重学。
- **哨兵**：`gate` 拒绝率 + `ĉ` + **各系数后验相对先验的偏离（单位：先验 SE）**。正常应停在膨胀上限（8）以内；持续超出说明该部署的真实不确定度大于先验假设，此时按数据调整膨胀系数而非重拍。

端到端（本机 8845 步回放）：估算误差中位 **16.8% → 4.7%**。

**真机验证（2026-10-21，284 个真实步）**：

| 指标 | 固定先验 | 在线学习 |
|---|---|---|
| MAPE | 6.0% | **5.6%** |
| gate 拒绝率 | — | 2.8% |
| `ĉ` | — | 1.285 |
| 后验偏离（先验 SE） | — | 字母 7.75 / 工具 0.89（上限 8，未告警） |

学到的系数（字母 4.40 / 数字 0.84 / 标点 1.42 / CJK 1.39 / 工具 29.3）与先验同量级、小幅漂移，符合「同一分词器、流量构成略有不同」的预期。

**两个验收回归测试**（`tests/calibration.test.ts`）：
- **不伤**：与先验一致的流量上，学习后误差不得明显高于固定先验；
- **能学**：工具开销从 33.7 变为 15 的合成流量下，系数须朝真值迁移且不越过。

#### 7.3.1 原始记录（旧固定画像，背景）

旧实现按「观测到增长的采样间隔」累加分母，导致读数取决于 delta 到达节奏。

`estimateParts` 对每条已完成消息与 `tokens.output + tokens.reasoning` 对比（本机近 6000 条 assistant 消息）：

| 分组 | n | 估算/真实 中位 | 均值 |
| --- | --- | --- | --- |
| 全部 | 5989 | 0.80 | 0.78 |
| 仅文本（含 reasoning 文本） | 243 | 0.98~1.01 | ~1.0 |
| 含工具（文本+工具参数） | 3643 | 0.86 | 0.84 |
| 仅工具调用（无可见文本） | 2104 | **0.62** | 0.64 |

原因：估算按字符画像折算（思考 4.0、答案 2.9、代码 3.7 字/token），而工具参数实测 2.07 字符/token（p10 1.37 / p90 3.04）—— 用 3.7 折算等于把工具参数 token 少算约 45%；纯工具步的差额即由此产生。

所以两类误差方向相反、会互相抵消一部分。7.1 修复后，实时侧的偏高已基本消除；分子偏低已由 7.3 的在线校准解决。

### 7.4 精确侧也会偏高：`tool.time.created` 不是首字时刻

`computePerfSample` 用 `firstContentStart`（最早内容 part 的 `time.created`）当首字。对**纯工具调用步**，这个时刻是「工具调用开始组装」而非首 token 到达：

- 纯工具步（n=2094）ttft 中位 5237ms，占整步墙钟的 **80%**（p10 50% / p90 90%）；genMs 中位仅 1338ms。
- 结果：纯工具步精确 tps 中位 **209 tok/s**、p90 328、最高 971；而有文本的步中位 191、p90 257。
- 极端样本：`ttft=20219ms, gen=2040, 分母=1400ms → 971 tok/s`，同期该会话真实转速远低于此。
- 守卫 `genMs >= genTok × 1.0`（1000 tok/s 上限）几乎拦不住，因为分母仍有 0.5~5s。

影响：这类步的**精确值（步骤结束后展示的那个数）**同样偏高，不只是实时估算。总量级不夸张（p90 328），但会把「最高速度」类读数顶到不真实的三位数。

### 7.5 展示口径叠加（不是 bug，但会加深"偏高"观感）

精确口径 `tok / (completed − firstStart − tools)` 天然高于宿主的 `Σtok / Σ(streamed − created)`：本机 5715 条实测**中位高 4.3 倍**（p10 1.5 / p90 17）。宿主 footer 的数字近似"体感速度"，我们的是"解码速度"，两者并列时我们的读数必然更大。首字等待占墙钟中位 52%（纯工具步 76%），这是差距的主因。

### 7.6 处理状态

已修复：

- **~~按增长事件推进 `activeMsBetween`~~ → 改为墙钟窗口**（`windowedTps` 分母 = `min(now, 最后一次增长时刻) − 窗口起点`）。旧方案仍依赖采样点位置、只是换了个锚点；正确做法是分母与采样无关。`activeMsBetween` 与 `ACTIVE_GAP_CAP_MS` 已删除。回归测试：`tests/perf.test.ts` 的「静默采样点不切断增长区间」与「读数与 delta 批次节奏无关」两条。
- 7.2 的补发簇由同一次改动覆盖，不引入阈值机制。
- **7.3 换为逐类字符 + 在线学习系数**（`model/calibration.ts`），旧的 4.0/2.9/3.7 画像与 `estimateTokens` 的 profile 参数已移除。测试：`tests/calibration.test.ts`（含与批量最小二乘对拍、分桶隔离、gate 行为、哨兵）+ `tests/live-recorder.test.ts` 的三条学习接入用例。
- **7.7 速率改为事件驱动卡尔曼**（`model/rate.ts`），`windowedTps` 保留为「卡尔曼尚未给出速率」时的兜底。测试：`tests/rate.test.ts`（稳态收敛、事件重置幂等、只作废速率先验、变化检测不误报、速率非负、单样本不猜）。

未修复（明确不做或有待决定）：

- **7.4 纯工具步精确值偏高**：实测中位只比文本步高 8%（208 vs 192），原判断「系统性虚高」过重；真正的问题只在长尾（>400 的 40 条，最高 971）。**不设上限**（已明确），**不剔除样本**（44 个会话中 0 个会因此丢失速度，但 2.3% 的会话当前展示的样本来自纯工具步，剔除后数值会变）。
- **安全网滞后 0.75s**：无事件的速率突变（供应商限流）会短暂显示旧值。这是 Q=0 的固有代价；缩短它需引入有量纲的 Q（曾尝试从日志推 Q 失败，见下条）。
- **公式推 Q 不成立**：`Q=(P99(|Δv|)·Δt)²/3` 实测漂移期误差 114%（扫描最优 q=1e-2 为 8.9%），分位数 95/99/99.5/99.9 的误差极差 190pp。根因是跳变（速率跳到 0）被摊进 Δt，制造虚假的巨大加速度。改用事件驱动后该问题消失。

### 7.7 速率估计：事件驱动卡尔曼（已实现）

`model/rate.ts`。状态 `[累计 token, 速率]`，观测是每批采样的累计估算 token。

**模型类别的修正**：速率是**跳变过程**而非平滑漂移——工具调用、步结束、新内容段都会让它跳。因此：

- **`Q = 0`**：不建模连续漂移。依据：把 `|Δv|/Δt` 只在无事件间隔统计这件事在本日志中不可行（一条 assistant 消息 = 一步 = 一个流，tokens 只在步末写回，故步内速率不可观测，任何跨步对比都必然跨事件）；反过来用扫描最优 q 反推漂移量级——q=1e-2 对应每 250ms 速率标准差 0.05 tok/s（相对中位 193 的 0.03%），**步内漂移统计上为零**。
- **`P ← P₀`（事件触发重置，幂等）**：`RATE_RESET_EVENTS` = 工具 called/success/failed、步结束、text/reasoning started。重置只作废速率先验，不清累计 token 与观测噪声；反复触发等价于一次。
- **漏检事件安全网**：归一化新息的 EMA 持续超 3σ → 同样 `P ← P₀`（数据驱动的证据，而非 Q 兜底）。阈值属误报预算类参数。

仿真验收（真实会话形态：生成 → 工具 3s → 生成 → 工具 2s → 生成）：

| 指标 | 卡尔曼 | 滑动窗口 |
|---|---|---|
| 生成期误差 | **4.9%** | 16.3% |
| 工具返回后达 ±20% | **350ms** | 1600ms |
| 长稳态 60s 误差 | **0.5%** | 4.5% |
| 稳态相邻读数最大跳变 | 0.46 tok/s（0.5%） | — |

**真机验证（2026-10-21，本机 207 次工具调用 / 148 步真实会话）**：

- **事件字段全部正确**：`assistantMessageID` 在 `tool.called`（207/207）、`tool.success`（207/207）、`step.ended`（148/148）中均存在 → 事件重置路径确实生效。
- **长停顿全部被事件覆盖**：58 次 >2s 的 delta 间隔中，**工具等待 55 次**（停顿期间有 `tool.called`）、步边界 3 次（有 `step.ended`）、**纯静默 0 次**。
- **安全网（新息 EMA）实测滞后 0.75s**：速率 120→25 的突降（无事件）下，第 1~2 个采样点仍输出旧值（119.8 / 119.1），第 3 点检测到并丢弃该帧，第 4 点（≈1s）收敛到 26.0。完全挂住场景 0.3s 归零。渐进劣化（每 2s 掉 15%）偏差稳定在 5~24%。

**已知局限**：完全没有对应事件的速率变化（如供应商中途限流）**会滞后约 0.75 秒**才纠正——这段时间显示的是旧值。这是 Q=0 的固有代价，不是缺陷；缩短它必须引入有量纲的 Q（见 7.6「未修复」）。

> 记录一处此前的错误判断：曾据「停顿结束时刻是否在工具期内」得出「52 次长停顿全部在工具期外」，该判据本身有缺陷（工具执行发生在停顿**期间**，结束时刻必然已在工具之后），修正后的分类见上。
