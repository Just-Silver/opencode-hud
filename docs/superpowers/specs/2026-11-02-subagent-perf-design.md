<!-- 职责：定义子代理展开行「首字 / 速度」的数据来源、口径、布局与验收；不写：底部状态行的完整口径（见 docs/design-performance-footer.md）、额度查询、安装与更新 -->

# 子代理展开行：首字 / 速度

- 日期：2026-11-02
- 状态：**已实现**（2026-11-02）
- 落点：`sidebar.content` → `SubagentSection` 的展开区
- 前提：opencode2 v2.2.5（已核对 `@opencode/plugin` 与 `@opencode/client` 源码）；不改宿主

## 1. 背景与目标

底部状态行已经显示当前会话最近一步的首字与速度（`docs/design-performance-footer.md`），但侧边栏的子代理只显示耗时与累计 tokens，看不到某个子代理跑得快不快。

目标：**展开某条子代理时，显示该子代理最近有效样本的首字 / 速度（首字与速度分别回溯），口径与底部完全一致。**

非目标：

- 不在主行常驻（34 列放不下，会挤掉标题）
- 不做整段平均速度
- 不做实时估算 / 插值 / 平滑
- 不为历史步骤补造时间戳
- 不改额度、安装、更新

## 2. 现状与约束（已核对源码）

| 事实 | 依据 |
| --- | --- |
| `SessionInfo` 只有累计 `tokens` 与 `time.created/updated/idle`，没有逐步时间戳 | `model/types.ts` 的 `SubagentInfo` |
| 因此只靠 `session.get(id)` 算不出首字 / 速度 | 同上 |
| 插件上下文公开 `ctx.data.session.message.sync(sessionID)` | `packages/plugin/src/tui/context.ts:86` |
| `message.sync` 取最近 20 条消息（TUI 未覆盖 `initialMessageLimit`） | `packages/client/src/solid/data.ts:1820-1849` |
| `message.list()` 返回 Solid store 代理；`step.ended` 把 `tokens` / `time.completed` 写回同一 store | `packages/client/src/solid/data.ts:1012-1021` |
| `sync.run` 成功后同 key 再调直接返回，不重复请求 | `packages/client/src/solid/data.ts:228-233` |
| `family()` 只同步子会话元数据，不同步消息 | `packages/client/src/solid/data.ts:569-575` |

结论：子代理性能必须**按需补一次子会话消息**，之后靠宿主事件写回 store，响应式更新。

### 2.1 硬约束：禁止轮询

- 不新增任何 `setInterval` / `setTimeout`。
- `message.sync(id)` 只在「该条从折叠变为展开」时调用一次；成功后同 key 短路。
- 性能 memo 不读 `subTick`，不跟 1s 耗时心跳重新取值。
- 现有的 1s / 80ms 定时器只服务耗时与 spinner，不参与性能；额度 60s 轮询是既有设计，不在本次范围。

## 3. 设计

### 3.1 数据流

```
展开集合变化（expanded signal）
        ↓ createEffect
message.sync(id) 一次（HTTP GET，失败静默）
        ↓ 宿主写入同一 store
subagentPerf memo：只读已展开 id 的 message.list(id)
        ↓ latestPerf（与底部同一函数）
SubagentRow.ttftMs / tps
        ↓
展开行「性能」
```

- 同步 effect 只依赖 `expanded()`，不依赖 `subagentRows()` / `subTick`。
- `subagentPerf` memo 只依赖展开集合与子会话消息 store。
- 宿主在 `session.step.ended` 写回后，memo 自动重算；**没有事件订阅、没有轮询**。
- `message.sync` 失败（网络 / 404）静默，不显示该行；折叠后重新展开会再试一次。

### 3.2 展示

展开区在「命中」之后补第 5 行，缩进与现有展开行一致：

```
1234567890123456789012345678901234
▼ 子代理 ● 3  ● 1      收起  390.8M
──────────────────────────────────
▶ ● Final cleanup f… 1h57m  19.6M
▼ ● 最终审查三库拆分 58m05s  13.1M
    标题 最终审查三库拆分
    模型 deepseek-v4.1-flash (high)
    代理 general
    命中 98.4%
    性能 0.42s · 48 tok/s
```

- 标签 `性能` 占 4 列，与 `模型` / `代理` / `命中` 同宽；值最多约 20 列，34 列内放得下。
- 值格式与底部完整档一致：`0.42s · 48 tok/s`（`fmtSec` + `fmtTps`，`48.2` 按现有 `fmtTps` 会取整为 `48`）。
- 只有首字、没有速度 → 只显示 `0.42s`；只有速度 → 只显示 `48 tok/s`；两者都没有 → **整行不渲染**，不留占位、不显示 `--`。
- 主行、标题行、常驻裁剪、`还有 N 条已完成` 折叠行一律不动。

### 3.3 口径

- 显示的是该子代理**最近有效样本**的精确值（首字与速度分别回溯），与底部 `latestPerf` 完全同口径；不是整段平均。
- 守卫沿用 `model/perf.ts`：无 `time.streamed`、跨度 < 200ms、净生成 < 300ms → 不出速度；无内容 part 时间戳 → 不出首字。
- 子代理最后一步可能只是收尾短步，数值只代表那一步；文档需写明，避免被读成“这个子代理的平均速度”。

### 3.4 接口与类型

- `SubagentRow` 增加 `ttftMs?: number`、`tps?: number`。
- `buildRow(info, opts)` 的 `opts` 增加 `perf?: { ttftMs?: number; tps?: number }`，由纯函数透传到 row，保持可单测。
- 新增 `shared/format.ts` 的 `fmtPerf(ttftMs, tps): string`：返回 `""` 或 `0.42s · 48 tok/s`。
- `view/PerfFooter.tsx` 改为复用 `fmtPerf` 生成完整档文本；极简档仍只取 `fmtTps`，行为不变。

### 3.5 文件改动

| 动作 | 文件 | 说明 |
| --- | --- | --- |
| 修改 | `shared/format.ts` | 新增 `fmtPerf` |
| 修改 | `model/subagent.ts` | `SubagentRow` 加 `ttftMs` / `tps`；`buildRow` 接收 `perf` |
| 修改 | `view/Sidebar.tsx` | `subagentPerf` memo + 展开时 `message.sync` effect；`buildRow` 传入 perf |
| 修改 | `view/SubagentSection.tsx` | 展开区「命中」之后加「性能」行 |
| 修改 | `view/PerfFooter.tsx` | 复用 `fmtPerf`，避免两处拼接漂移 |
| 修改 | `tests/shared.test.ts` | `fmtPerf` 四种组合 |
| 修改 | `tests/perf.test.ts` | `buildRow` 透传 perf |
| 修改 | `docs/design-subagent-section.md` | 数据来源表、展开布局、已知取舍 |
| 修改 | `docs/design-performance-footer.md` | §5「侧边栏展示」不再算“不做”，改为指向本文 |
| 修改 | `AGENTS.md` | 数据口径一句：子代理默认不读消息，展开时按需 sync |

不新增文档，因此不新增文档地图条目。

## 4. 边界与失败

| 场景 | 行为 |
| --- | --- |
| 子代理刚起、还在第一步 | 没有已完成步 → 不显示性能行 |
| `message.sync` 失败（网络 / 404） | 静默，不显示；下次重新展开再试 |
| 20 条窗口内全是被守卫拦下的步 | 不显示；不向前翻页、不猜 |
| 折叠再展开 | `sync.run` 成功态短路，不重复请求 |
| 切会话 / 侧边栏重建 | 展开态是内存态，回到折叠；消息仍在宿主 store，重新展开不重复拉 |
| 老子代理被复用重新 running | `step.started` 清空 `time.streamed/completed`；当前步结束前可能沿用上一步样本，结束后更新（与底部一致） |
| 子代理执行中消息量很大 | `sync` 只在展开时发生；20 条上限控制响应体积 |

## 5. 测试与验收

### 5.1 自动化

- `fmtPerf`：两者都有 / 只有首字 / 只有速度 / 都没有。
- `buildRow`：`perf` 透传到 `SubagentRow`。
- `latestPerf` 已有测试（`tests/perf.test.ts`），不重复。
- 全量：`node --test tests/*.test.ts` 全部通过。
- 打包检查：esbuild 语法检查通过（命令见 `AGENTS.md`）。

### 5.2 手动冒烟

1. 展开一个运行中的子代理 → 「性能」行出现（或等当前步结束）。
2. 等该子代理完成一步 → 数字自动更新，无闪烁、无空行抖动。
3. 折叠再展开 → 不产生重复 `message.sync` 请求（应用内 console 无报错）。
4. 展开一个没有有效样本的子代理（如纯工具步被守卫拦下）→ 整行不渲染。
5. 展开一个早已完成的子代理 → 首次 sync 后显示它最后一步的样本。

### 5.3 禁止轮询的验收

- 新增代码中不出现 `setInterval` / `setTimeout`（`view/Sidebar.tsx` 只保留现有耗时、spinner、额度三处）。
- `subagentPerf` memo 不引用 `subTick`。

## 6. 文档同步

- `docs/design-subagent-section.md`
  - §1 数据来源表新增「首字 / 速度」行：`message.list(id)` + `latestPerf`，仅展开时、先 `message.sync(id)`。
  - §3 展开布局增加「性能」行，更新列预算与示例。
  - §5 已知取舍补充：每个展开条目一次 HTTP、20 条窗口、最近一步口径。
- `docs/design-performance-footer.md`
  - §5「不做的部分」里的「侧边栏展示」改为「侧边栏展开行复用同一口径（见子代理设计）」。
- `AGENTS.md`
  - 数据口径：子代理默认只读 `family()` 与 `SessionInfo` 聚合列；**展开时**按需 `message.sync(id)` 读子会话消息算首字 / 速度，不轮询。

## 7. 不做

- 主行常驻首字 / 速度
- 整段平均速度
- 实时估算 / 插值 / 平滑 / 定时器
- 历史文本首字补造
- 失败提示、重试按钮、手动刷新
- 持久化展开态或性能缓存
- 额外订阅 `session.*` 事件（store 响应式已覆盖）

## 8. 风险与回退

| 风险 | 处理 |
| --- | --- |
| `message.sync` 拉 20 条含工具输出，大子代理首次展开响应偏大 | 只在展开时发生；若实测卡顿，改为只缓存一次并接受更旧样本 |
| 20 条窗口不覆盖更早的有效步 | 只保证「最近一步」；不翻页、不猜 |
| 旧版 opencode2 没有 `message.sync` | 插件已要求 opencode2 v2 API；若运行时缺失，该行不显示（不崩），不额外加版本探测 |
| 子代理最后一步是短收尾，速度不具代表性 | 文档写明“最近一步”，不改成平均 |

回退：删除 `subagentPerf` memo、sync effect、展开行与 `fmtPerf` 的调用即可；`fmtPerf` 可保留给 footer 复用。
