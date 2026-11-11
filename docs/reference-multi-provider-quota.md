<!-- 职责：记录「同时展示多个供应商/订阅额度」的同类实现、共性设计与可借鉴清单；不写：本项目具体实现方案与文件改动（见 docs/design-*.md）。 -->

# 多订阅额度展示：同类项目参考

触发场景：子代理跑的是别的供应商模型，额度消耗发生在主会话之外，只看当前会话供应商就漏了。

## 样本（2026-11 GitHub 搜索，按 star 排序）

| 项目 | star | 形态 | 关键做法 |
| --- | --- | --- | --- |
| `slkiser/opencode-quota` | 1139 | TUI `/quota` 窗口 + 侧栏面板 + 状态行 + toast + Desktop | 按登录自动发现全部供应商，默认全显示；侧栏面板按供应商分组；点标题两级折叠（面板 → 每供应商一行） |
| `razzant/claudexor` | 524 | 多 harness 控制面 | 额度用于跨订阅「轮换选路」，不只是展示 |
| `PhilippPolterauer/opencode-quotas` | 60 | 对话 footer 表格（另带 CLI） | 每行一个 quota：状态/名称/用量/条形/reset/ETTL（预测用完时间）；`filterByCurrentModel` 默认 false |
| `IgorWarzocha/opencode-usage-plugin` | 25 | `/usage` 命令输出到聊天 | 不常驻面板，按需拉全量；`providers` 开关控制显示哪些 |
| `Mark1708/opencode-usage-monitor` | 10 | TUI 侧栏（宽 34） | 两级折叠：面板级 + 供应商级；供应商折叠时只显示一个代表窗口 |

### slkiser/opencode-quota（主要参考）

- 侧栏：`Quota` 面板，展开=每供应商一个组标题 + 该供应商的窗口行；点标题折叠成「每供应商一行」。折叠标题带供应商数（`▶ Quota (2 providers)`）。
- 折叠行：`供应商名(≤9) + 窗口名(4) + 条(≤10) + 百分比 + reset`，代表窗口由 `collapsed.window` 指定，缺省 `lowest`（最紧张那条）。
- 展开行：`缩进 + 窗口名(≤labelWidth 8) + 条(最多 20 列) + 百分比 + reset`；组间 `providerGap=1`；同一供应商多窗口不再加前缀，标签短（`5h`/`7d`/`month`）。
- 设置面（`opencode-quota/settings.jsonc`）：`providers.off`、`sidebar.hidden`、`providerOrder`、`rowOrder`、`names`、`words.onlyCurrentModel`（**默认 false**，开启后只显示当前模型所属供应商）、`words.rowNames`（short/full）、`words.percent`（left/used）、`layout.bar/barWidth/evenUse`、`colors.warningBelow=50`/`lowBelow=20`。
- 刷新：`providers.checking.minIntervalMs` 默认 `300000`（5min），与我们一致；请求超时按供应商 5–10s。
- 错误：供应商之间互不影响；「全部供应商都失败」时才弹 toast；供应商标记 stale。
- 额外价值：`layout.evenUse` 在条上画 `┃` 表示「按均匀消耗到 reset 应到的位置」，可判断会不会提前用完；`colors.levelBy: "pace"` 按速度着色。
- 未登录供应商：README 说「`/connect` 登录后就出现」，即靠凭据发现，不靠固定清单。
- Desktop（2.2.0+）复用同一套设置，侧栏=固定 Quota 侧标签，折叠=标题栏药丸。

### Mark1708/opencode-usage-monitor（视觉参考）

三张截图（`assets/`）：`fully-expanded` / `provider-expanded` / `sidebar-collapsed`。

```
▼ Usage                      1m
▼ openai
    168h   11% · reset 6d
    plan   pro
    ...
▼ z.ai
    month  10% · reset 15d
    5h     20% · reset 1h
    week   32% · reset 5d
```

- 面板级 ▾/▸、供应商级 ▾/▸ 两层折叠，状态各自记住；默认配置 `panel_initial_state: expanded`、`provider_initial_state: collapsed`。
- 供应商折叠时只显示一个窗口（截图里 openai=`168h 11%`、z.ai=`5h 20%`），右侧最近刷新时间（`1m`）。
- 供应商展开时显示全部窗口，无百分比的（plan/余额/`search-pr…` 用量）作为明细行。
- 未登录：显示 `status needs auth` 灰行 —— 与我们的「无数据整块不渲染」约束冲突，不借鉴。
- 结构化输出约定：窗口（usage windows）+ 供应商自有的 details（如余额），不让 provider 直接吐任意属性。

### PhilippPolterauer/opencode-quotas

```
ST    QUOTA NAME            USED   UTILIZATION            RESET    ETTL
OK    Antigravity Flash       0%   ░░░░░░░░░░░░░░░░░░░░   7d 0h    -
OK    Codex Usage             4%   █░░░░░░░░░░░░░░░░░░░   4h 54m   3h 11m
```

- 扁平表格、列对齐，一个 quota 一行；`ETTL` = 按历史斜率预测耗尽时间（线性回归）。
- `filterByCurrentModel` 关闭时展示全部，开启时用模型 ID 分词打分挑相关 quota；`disabled` 黑名单。
- 代价：不是常驻 UI，塞在对话末尾，行数一多就挤。

## 共性结论

1. **默认全量、可关**：四个样本都默认展示所有已登录供应商，用设置收窄（`onlyCurrentModel` / `providers.off` / `providers` 开关）。
2. **靠凭据发现供应商**，不靠手写清单；没凭据就完全不出现。
3. **供应商名做分组标题**，窗口行用短标签（`5h`/`周`/`月`），所以「OpenAI 和 OpenCode Go 都有 5h」不靠前缀解决。
4. **两级折叠**是共识：面板整体 → 每供应商一行 → 供应商内全部窗口；默认态不一致（slkiser 展开、Mark1708 供应商折叠），说明这是用户偏好，不是硬约束。
5. **折叠摘要必须选一条代表窗口**（最紧张/lowest 最常见），否则一行放不下。
6. **5min 刷新 + 供应商级失败隔离**是主流，比我们更保守的没有；展示 stale/失败状态而不是清空。
7. 再往上一层是「按余量选 provider / 自动轮换」（claudexor、opencode-quota-agent-tool），说明多订阅数据的下一步复用是选路。

## 与本项目现状的差距

- 现在额度块由会话 `providerID` 单点决定（`view/Sidebar.tsx`），只显示一个供应商。
- 供应商发现已经具备（`quota/index.ts` 扫 `providers/*.ts`），缺的只是「列出全部启用供应商」的出口。
- 凭据解析（`quota/key.ts`）按 pid 可任意调用，可用「有凭据才算有订阅」做发现。
- 子代理模型供应商可直接读 `SubagentInfo.model.providerID`，不需要读子会话消息 —— 可以低成本标出「本会话里实际在用的供应商」。
- 硬约束：侧栏 42 列、无数据区块不渲染、不引入依赖、`<For>`/`<Index>` 响应式规则。

## 可借鉴 / 不借鉴

借鉴：

- 供应商分组 + 窗口短标签（不做 `OA 5h` 这类前缀）。
- 两级折叠，折叠行 = 供应商名 + 一个代表窗口。
- 「有凭据才出现」，不显示未登录占位。
- 供应商级失败隔离 + 全部失败才提示。
- 折叠行右端显示最近刷新时刻（相对时间），成本低、信息密度高。

不借鉴：

- 常驻多层设置文件：我们目前零配置，先不做 providerOrder/rowOrder。
- `onlyCurrentModel` 过滤：与「想看全部」直接冲突。
- ETTL/线性回归预测：需要历史采样与存储，超出侧栏范围。
- 表格列宽对齐的 footer 表格：侧栏放不下。
- 未登录占位行（`needs auth`）。

## 已定结论（2026-11-11）

- 默认只展开当前会话供应商，其余折叠成一行（全部展开会吃掉侧栏高度，用户已否）。
- 折叠行代表窗口取「最紧张一条」（percent 最大），接受它随刷新换窗口。
- 排序：当前会话 → 本会话子代理用到的 → 其余已登录（按注册顺序）。

实现方案见 `docs/superpowers/specs/2026-11-11-multi-provider-quota-design.md`。
