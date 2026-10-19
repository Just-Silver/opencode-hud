# Changelog

本仓库所有重要变更记录于此，格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [3.1.0] - 2026-10-19

### 新功能

- **侧边栏「子代理」区块**：主行显示标题、耗时、总消耗；展开补完整标题（超宽按字符换行）、模型与思考强度、agent 类型、缓存命中率
- 子代理标题行指示灯 `● N`（黄=已停止 / 绿=运行中，数量为 0 也显示）与右端合计消耗
- 「收起」按钮常驻标题行，可一键收起全部展开项（可用时白色、不可用时浅灰）
- 运行中的子代理行首显示盲文点阵 spinner（80ms 一帧，与宿主 `component/spinner.tsx` 同节奏同字符）
- **输入框下方性能块**：`prompt.footer.status` 显示首字时长与 token 速度；≥60 列完整、<60 列只留速度

### 修复

- 子代理耗时在步骤边界回跳（`time.idle` 仍是上一轮旧值时按高水位钳住）
- 切换会话时子代理区块闪烁（移除首帧为 0 的宽度测量，改用常量与父级铺满）
- 侧边栏选中文字被周期性刷新掉（`<For>` 改 `<Index>`，按位置复用节点）
- 工具执行期间速度仍在变化（冻结值取自当前步而非上一步；`runningTool` 改为状态优先判定）
- 滑动窗口跨过工具执行期导致工具返回后速度骤降（窗口起点钳位到最近一次工具结束）
- 速度读数持续衰减（累计平均改为 2s 滑动窗口 + 窗口起点插值基线）

### 清理

- 移除探针模块 `shared/probe.ts` 与 `TUI_USAGE_PROBE` 开关

## [3.0.0] - 2026-10-12


### 新功能

- 额度展示改为数据驱动 + 共享渲染器层（供应商自选渲染形态）（破坏性变更）

### 杂项

- 更新 CHANGELOG 到 v2.4.0
## [2.4.0] - 2026-10-12


### 修复

- 额度凭据支持 Console 登录（OAuth）与 integration 映射

### 新功能

- 额度行显示窗口重置时间（resetsAt）+ 进度条与对齐修复

### 杂项

- 更新 CHANGELOG 到 v2.3.1

### 重构

- 额度端点常量归位供应商文件，移除 registry 冗余与兜底

## [2.3.1] - 2026-10-09


### 修复

- 修复会话初始无事件时空边框占位

### 文档

- 记录 OpenDesign 额度 API 探测结论（API Key 无额度端点）

### 杂项

- 更新 CHANGELOG 到 v2.3.0
## [2.3.0] - 2026-10-06


### 新功能

- 侧边栏视觉改版（带边框面板 + opencode 主题配色 + 数值右对齐）

### 杂项

- 更新 CHANGELOG 到 v2.2.0
## [2.2.0] - 2026-09-26


### 修复

- 一键更新改为插件内自包含（避免 Windows Defender 误报）
- 安装脚本改为取最新 Release（与 TUI 一键更新对齐）

### 新功能

- 更新横幅支持一键更新（弹窗 + 执行官方安装脚本）

### 杂项

- 更新 CHANGELOG 到 v2.1.0
## [2.1.0] - 2026-09-26


### 回滚

- 分发回退为脚本安装（TUI 配置安装存在双 Solid 缺陷）

### 文档

- AGENTS 补充配置安装与 TUI 加载的坑（2.0.15 实测，供后续插件开发参考）
- 新增 TODO 跟踪 opencode 未钉版本插件弹窗问题（上游 #50868，非本插件）
- 记录 TUI 插件配置安装的源码级根因与方案 B（不使用 Solid）

### 新功能

- 恢复启动时更新检查（磁盘缓存节流）并将插件数据移至自身目录

### 杂项

- 更新 CHANGELOG 到 v2.0.1
## [2.0.1] - 2026-09-23


### 文档

- README 只保留用户向内容（维护者发版说明留在 AGENTS）并将版本升至 2.0.1
- README 只保留用户向内容；版本升至 2.0.1（破坏性变更）

### 杂项

- 更新 CHANGELOG 到 v2.0.0
## [2.0.0] - 2026-09-23


### CI

- 发版校验扩展为 tag/VERSION/package.json 三方一致

### 文档

- 新增「配置安装」分发改造设计（spec）
- Spec 自审修正（更新/卸载目标写法、发版上线次序、版本同源、成功标准措辞）
- 需求变更——移除侧边栏更新横幅与更新检查（spec/plan 同步）
- Plan 补充 Task 4 触发时的路径替换约定
- 修正 plan Task1 files 覆盖断言（路径归一化）
- 记录配置安装实测结论并同步 spec/plan（需 no-op ./server 入口）
- Plan README 段落去掉侧边栏更新提示表述
- README 改为配置安装（安装/更新/卸载/迁移）
- AGENTS.md 同步配置安装分发约定
- 修正终审指出的 AGENTS/release/plan 过期陈述

### 新功能

- 新增根 package.json（仅 ./tui 入口）并将版本升至 2.0.0
- 增加 no-op ./server 入口（配置安装可达性的必要条件）并同步守护测试
- 分发改为配置安装（移除脚本安装与运行时更新检查）（破坏性变更）

### 杂项

- 更新 CHANGELOG 到 v1.0.1

### 重构

- 移除 install/uninstall 脚本（分发统一为配置安装）
- 移除侧边栏更新横幅与更新检查模块（更新交由 opencode plugin update）
## [1.0.1] - 2026-09-10


### CI

- 修复 Release 工作流 --current 因 CHANGELOG 提交后 HEAD 无 tag 而失败

### 修复

- 适配 opencode2 beta-19425 插件加载（改包名 + 目录型 tui 入口）

### 杂项

- 更新 CHANGELOG 到 v1.0.0
- 更新 CHANGELOG 到 v1.0.1
## [1.0.0] - 2026-09-01


### CI

- 发布流程接入 git-cliff 自动生成 CHANGELOG
- 修复 tag 触发的 Release 工作流——detached HEAD 下 git push 需显式指定目标分支
- 升级 checkout v7 与 action-gh-release v3，消除 Node 20 弃用警告

### 修复

- 按供应商分桶字典缓存与按前缀分文件，修复配置空值崩溃与60s限流
- 空会话不查额度统一日志与清理死类型
- 安装脚本原子化与 PowerShell 错误检测加固
- 真原子安装、去重启与日志提示
- 精简完成提示并为关键输出加色
- 安装脚本零残留与同文件系统准确表述
- 修复安装/卸载脚本回退下载 404、STAGE 残留嵌套与清理缺失
- 占比显示补括号，缓存写入为 0 时隐藏该行

### 其他

- Initial commit
- 创建 opencode-tui-usage.tsx
- 凭据解析收拢为共享模块并支持配置多来源，白名单归一化匹配

- 新增 quota/key.ts：resolveProviderKey 按 keyCache → 项目配置 → 全局配置 → DB credential 表顺序解析，支持 V1/V2 配置格式、{env:} 占位符与 JSONC，模块零日志脱敏
- 插件入口凭据逻辑迁出，readProviderKey 收拢为 resolveProviderKey 转发
- quota/index.ts 新增 isQuotaProvider：白名单守卫与 fetcher 分发按「小写+只留 [a-z]」归一化，兼容 opencode-go/opencodego/opencode_go 等用户写法
- 新增 tests/：key/quota 单元测试 18 例全过 + 官方格式 fixtures
- AGENTS.md 更新热重载、测试命令与归一化说明
- MVVM 四层重构：入口薄壳化，model/quota/shared/view 解耦

- 入口从 421 行收拢为 14 行薄壳（render=<Sidebar/>），Plugin.define 仅保留挂载
- 新增 model/：types（UsageData/QuotaData/MessageLike 契约唯一真源）、usage（聚合/缓存率/上下文/上限/供应商解析纯函数）、quota（QuotaStore 状态机，fetch/log 依赖注入可单测）
- 新增 shared/：format/id（归一化）/jsonc 纯帮助函数，quota 层改为引用
- 新增 view/：Sidebar=ViewModel 响应式编排、UsageSection/QuotaSection/Collapsible/ColorBar/theme 纯展示层
- quota/types.ts 迁入 model/types.ts（原文件删除，引用全改）
- 单元测试 40 例全过（新增 model 13 / quota-store 6 / shared 3）
- 行为零变化：日志文案、60s 限流、missing key 路径、UI 输出 1:1 迁移
- AGENTS.md 更新四层结构与关键逻辑描述
- 新增 Command Code 额度查询（实现完成、注册暂注释）并引入 getProviderApiUrl 归一化 URL 查找

- quota/command-code.ts：mapCommandCode 纯转换（5h/周/月三窗口 + PLAN_CREDITS 套餐映射 + subscriptions 降级）、fetchCommandCode 双 API 主入口（credits 失败 throw）
- quota/index.ts：getProviderApiUrl 活跃（URL 查找走 normID 归一化，未注册落 QUOTA_API_URL 兜底）；Command Code 注册 4 处注释占位（常量/QUOTA_INTEGRATIONS/PROVIDER_API_URL/fetchers + import，取消注释即启用）；清理指向已删 types.ts 的残留 re-export
- view/Sidebar.tsx：apiUrlFor 一行改用 getProviderApiUrl
- 测试 51 例全过（新增 command-code 8 例 + getProviderApiUrl 2 例）
- AGENTS.md 记录 Command Code 状态与启用方式
- 供应商自动发现机制：providers/ 约定导出 + glob 收集，新增供应商只增一个文件

- 新增 quota/registry.ts：ProviderRegistration 发现接口（id/apiUrl/fetch/enabled?）与 createRegistry 纯逻辑（白名单/URL/fetcher 推导，node 可测）
- quota/index.ts 重写为薄入口：import.meta.glob 收集 providers/*.ts，enabled:false 过滤后交 createRegistry，导出面收敛为 isQuotaProvider/getProviderApiUrl/fetchQuota/QUOTA_API_URL
- quota/providers/：opencode-go.ts（含注册对象）与 command-code.ts（enabled:false 待验）迁入集中目录
- 新增供应商 = 只新增 providers/<name>.ts 一个文件（glob 打包期展开，重启服务重新打包生效）；enabled:false 跳过白名单
- 测试 52 例全过：quota.test.ts 改由 createRegistry 静态注册驱动（绕开 node 不支持 glob），增补 enabled 开关场景；ea build 保留 glob（bun 原生支持，esbuild 仅本地工具不转换）
- AGENTS.md 更新自动发现与启用方式说明
- 供应商运行时自动发现：fs 扫描 + 动态 import 替换 glob（源码级确认可行）

- 源码调查（anomalyco/opencode plugin/loader.ts + opentui runtime-plugin-support）：TUI 插件由 bun 运行时逐文件动态 import（await import(entry)），无打包器、无 import.meta.glob
- quota/index.ts 重写：顶层 await + readdirSync 扫描 providers/ + 动态 import 收集 provider 导出（enabled 过滤由 createRegistry 承担）；import.meta.url 非磁盘时防御兜底退回显式注册 opencode-go
- 新增供应商 = 只新增 providers/<name>.ts 一个文件，热重载重新 import 即自动发现（无需重启）
- 新增 tests/discovery.test.ts：node 直接 import index.ts 验证真实扫描链路（opencode-go 注册、command-code enabled:false 跳过）
- 测试 55 例全过；esbuild 打包通过（动态 import 运行时解析保留）
- AGENTS.md 更新自动发现机制描述
- 修复首次启动额度不显示：QuotaStore 订阅通知 + 轮询 force 绕过限流

- model/quota.ts：新增 subscribe/bump（写库即通知订阅者，跨组件重建安全）；load(pid,{force}) 供轮询绕过 60s 限流（限流与轮询相位解耦，重试确定性）；并发等待者返回缓存状态
- view/Sidebar.tsx：onCleanup 订阅 store 写库通知（永远绑定当前组件实例）；effect 保留限流防抖，timer 改用 force 轮询必然真请求；临时探针日志（providerID 首次解析打一条 info，诊断后删除）
- 根因：opencode render 反复重建组件，旧 setQuotaVer 信号随组件销毁而失效；cache 为模块级单例，停用重启用可从缓存读到 —— 修复后写库即通知当前组件，零延迟显示
- 测试 60 例全过（新增 subscribe/退订/多订阅者/force 5 例，并发分支断言更新）
- AGENTS.md 更新订阅机制说明
- 修复 Solid props 快照破坏响应式（额度/进度条不刷新）；探针改 TUI_USAGE_PROBE 开关默认禁用
- AGENTS.md 补全：完整校验命令（7 测试文件 + esbuild 打包检查）、官方源码速查（sst/opencode sparse clone 法）
- AGENTS.md 补供应商模板与功能开关一览；修正 providers/registry 注释中过时的 import.meta.glob 说法（实际为 fs 扫描 + 动态 import）
- AGENTS.md 记录 opencode2 beta 上游回归：18721 起 TUI 插件不加载，最后无 bug 版本 18707，含禁自升级配置
- AGENTS.md 记录我方上报的插件回归 issue #46408（与 #42051 同族互证）
- AGENTS.md 记录 opencode2 插件加载回归三层根因调查：发现器严格化/依赖外置化/mtime URL bug（18743 实测 + service 日志实锤，#42485 未合并）
- 启用 Command Code 供应商：enabled 改 true，白名单命中后即查询显示额度；同步发现测试与 AGENTS.md 文档
- Merge branch 'main' of https://github.com/Just-Silver/opencode-tui-usage
- 额度百分比完全透传：UI 层零加工，供应商决定精度

- fmtPctInt 改为原样透传（42→42%、0.36→0.36%），仅保留 isFinite 守卫与 0-100 clamp
- command-code 保留一位小数（供应商自己决定精度），注释同步新契约
- 新增供应商只需写 providers/<name>.ts 返回真实数值，显示层永不再改
- 新增插件更新提示：SemVer + GitHub Release + Actions 自动发版

- update/version.ts：VERSION 常量（唯一版本事实源）+ parseVersion/compareVersions 纯函数
- update/index.ts：启动时查 releases/latest，resolveUpdate 纯逻辑对比，静默失败原则
- view/UpdateBanner.tsx：侧边栏顶部黄色横幅提示重跑 install.sh，无更新零占位
- .github/workflows/release.yml：推 v* tag 自动创建 Release，校验 tag 与 VERSION 一致
- 新增 tests/update.test.ts（9 用例），70 测试全过；文档同步 README/AGENTS
- 更新提示改轻量单行可关闭，置于插件最下方

### 文档

- 新增 AGENTS.md 沉淀单插件结构与热重载等硬知识
- 精简 README 为人类可读（仅保留装卸两段）

### 新功能

- 新增全局安装与卸载脚本及 README（curl+bash 主推）
- 缓存区块新增总量/推理/命中率行，明细行显示占总量占比

### 杂项

- 更新 LICENSE 版权信息
- 更新 CHANGELOG 到 v1.0.0

### 样式

- 明细数值列固定宽度对齐，百分比列起点统一
- 命中率行改名为缓存命中率，与缓存读取组成末两行
- 缓存明细行改 flex 布局，标题与值隔开并右侧靠齐（同额度样式）
- 明细改三列对齐、区块标题与内容加间距、缩减上下文与总量间隔
- 总量与缓存命中率行补百分比列占位，三列起点统一
- 进度条加轨道底色，完整长度可见
- Indent 0

### 重构

- 缓存容器改名为会话，折叠摘要改为总量
