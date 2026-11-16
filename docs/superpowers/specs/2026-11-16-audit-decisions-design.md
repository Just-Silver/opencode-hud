<!-- 职责：2026-11-16 审计决策的落地设计（范围、三个子系统边界、控制器裁定、条件阻塞与残余风险）；不写：逐任务步骤与命令（见三份 plans）、审计原始证据（见 docs/audit-2026-11-16.md）、凭据/交付的技术核验过程（见 .superpowers/decisions-2026-11-16/）。 -->

# 审计决策落地设计（2026-11-16）

- 来源：`docs/audit-2026-11-16.md` §8 的 16 项用户确认。
- 性质：设计边界与裁定，不是实现。三份计划把边界拆成 8 个可独立复审的任务。
- 授权边界：只改工作区。**不提交、不推送、不发版、不安装/卸载全局插件、不读真实凭据、不请求真实额度、不建 worktree**。
- 基线：未提交的审计修复全部保留；`node --test tests/*.test.ts` 261/261、0 skip。

## 1. 目标与不变量

目标：把 §8 的 16 项确认落成可验证的行为，且不把"当时建议"当成"已实施"。

不变量（改动全过程必须成立）：

1. 数据口径不变：会话累计 still 取 `SessionInfo.tokens`；上下文只取最后一条 completed compaction 后的 assistant；性能只算已完成步。
2. 额度契约不变：`QuotaItem` 只放渲染原语；5min 刷新、5→10→15min 退避、`Retry-After`、在途切号、无数据不出行、失败不画 0% 全部保留。
3. 安装/更新的失败语义不变：旧版不因失败被破坏；回滚失败保留唯一备份；清理失败不覆盖已确定结果；宿主只认 `tui.tsx`。
4. 依赖约束不变：无根 `package.json`、无 lockfile、无 lint/type/format 配置；测试用 `node --test`，运行时导入必须带 `.ts`/`.tsx` 后缀。
5. 文档纪律：历史 specs/plans/CHANGELOG 不回填；同一事实只在归属文档维护；代码注释只写不显然的原因。

## 2. 范围（按用户确认）

| # | 确认 | 本轮落地 |
| --- | --- | --- |
| 1 | 跟随宿主有效账号，配置兜底 | 解析顺序反转为「宿主连接 → 仅无连接时配置」 |
| 2 | 多凭据跟随宿主选行 | SQL 排序改 `active DESC, time_created DESC, id DESC` |
| 3 | 仅本机显式配置 | 不扩远程/频道探测；显式 `OPENCODE_DB` 是唯一覆盖手段 |
| 4 | OAuth 稳定身份 | 缓存身份 = DB 来源 scope + integration + credential id（key/config 另带 key 哈希） |
| 5 | 企业 Console 识别后跳过 | 非公共 `metadata.server` → 静默跳过，不回退配置/公共端点 |
| 6 | 子代理计数互斥 | `stopped = 总数 − running − failed` |
| 7 | 发版保留回推 + 门禁 | 串行、来源 main、测试/编译门禁；回推失败让 job 红、不撤销 Release |
| 8 | 仅正式 Release | 只认 `vX.Y.Z`；无法确认最新 Release 时安装失败、检查静默冷却 |
| 9 | 完整供应链加固 | 无条件「校验资产」协议：先 checksum、流式有界下载、解压前限额与条目校验 |
| 10 | 现在结束旧名兼容 | 删除全部 `opencode-tui-usage` 源码引用；**不删用户机器上的旧目录** |
| 11 | 加锁与恢复指引 | `<plugins>/.opencode-hud.lock` 目录锁；30s / 200ms；不自动破锁、不自动清陌生备份 |
| 12 | 先基准与复现 | 不改 `useSubagents` 结构；只把实测上限与未复现限制写进文档 |
| 13 | 终端宽度暂不改 | 不动宽度表与几何常量 |
| 14 | 原生额度验证后迁移 | **阻塞**：六项验收未过，保留 HTTP provider |
| 15 | 文档/日志改善 | 升级 `docs/config-install.md`；git-cliff 比较链接与自指 chore 过滤 |
| 16 | 目录边界不改 | 不改空串/trim 语义、不新增目录选项、不精简 `.gitignore` |

## 3. 三个子系统边界

### A. 本机凭据与额度展示（计划 `2026-11-16-credential-rules.md`）

- 边界：`quota/key.ts`（唯一凭据解析）、`model/quota.ts`（状态机）、`quota/host.ts`（宿主映射）、`tui.tsx`/`view/hooks/useQuota.ts`（接线）。
- 不做：不改 `quota/providers/*` 端点与渲染器、不改 `QuotaItem`、不接原生 `usage.limits`、不扩远程/多账号/频道探测。
- 判据：宿主推理用哪条凭据，额度就用哪条；宿主没有连接才允许配置兜底；宿主状态不明（外部托管、坏行、非公共 Console、DB 打不开）一律跳过而不是换一个账号。

### B. 交付链路（计划 `2026-11-16-verified-delivery.md`）

- 边界：`update/release.ts`（协议纯函数）、`update/download.ts`（有界流式）、`update/tar.ts`（解压前逐 header 扫描）、`update/apply.ts`（编排 + 锁）、`update/index.ts`（Release 发现）、`shared/lock.ts`、`install.*`/`uninstall.*`、`scripts/build-release-asset.sh`、`.github/workflows/*`、`cliff.toml`。
- 不做：不做签名/attestation；不自动清随机容器与陌生备份；不实现 `< 首个带资产 Release` 的无校验回退；不按内容探测/自动清理旧名副本；不推送/发版。
- 判据：任何一条校验不通过都不触碰现有安装；网络失败不降级到无校验来源；Node/Bash/PS 三套实现遵守**同一套**归档规则，由同一批攻击/合法 fixture 覆盖。

### C. 验证与文档收口（计划 `2026-11-16-validation-docs.md`）

- 边界：`model/subagent.ts` 计数、`tests/perf.test.ts`、`docs/config-install.md`、审计 §8 状态附录、子代理区块的基准注记、AGENTS 文档地图与一致性。
- 不做：不改性能结构、不改宽度表、不精简 `.gitignore`、不回填历史 specs/plans。

## 4. 控制器裁定（实现必须照此，不得照搬核验建议）

1. **供应链关闭**：不引入 `ASSETS_SINCE`；不允许无 checksum 的旧源码归档、`git clone`、`main` 下载回退。旧 Release 缺资产即明确失败；文档说明"脚本合入 main 到首个带资产 Release 发布之间暂不可用""旧客户端仍走源码归档"只作为兼容事实记录，不扩展新客户端。
2. **DB 状态二义性**：DB 不存在或 `:memory:` = 无连接，可用配置兜底；DB 已存在却打不开/坏 schema/`bun:sqlite` 不可用 = 未知状态，静默跳过且**不回退配置**（不得用"工具环境读不到库"解释错误账号）。
3. **integration 映射**：优先宿主 `provider.integrationID`；无映射时不得跨 integration 猜旧账号，按 providerID 本身查。映射规则与宿主一致：provider 在列表中 → `integrationID ?? provider.id`；**只有 provider 不在 `list()` 里才算未就绪**。Console 供应商（`opencode-go`/`opencode`）仅在未就绪时不查 DB 也不走配置兜底（`null` 静默跳过）。
4. **身份**：OAuth 身份含实际 DB 来源 scope（哈希）+ integration + credential id；同 id 的 token 刷新不失效；key/config 另含 key 哈希。不接受无 scope 身份导致多 DB 串账号。
5. **严格契约**：`QuotaDeps.resolveKey` 返回 `{key, identity} | null | undefined`；`null` 静默跳过、`undefined` missing。删除为迁就测试保留的 string 兼容；`fetch` 结果语义保持原样（不加入未实施的 native `fetch:null`）。
6. **宿主 getter**：不得被单例捕获第一个已卸载组件的 context；由插件 setup 绑定模块级访问器，hook 每次调用时读取；不做未经实测的 probe 重构。
7. **归档校验**：只受控 USTAR 常规文件/目录；先校验 hash，再做**解压前**条目与总量限额（16 MiB 压缩 / 64 MiB 解压 / 2000 条 / 4 KiB checksum；120 s 下载 / 15 s checksum）。三套实现规则相同：校验 header checksum（两种写法）、`ustar\0` + `00`、name/prefix 原始字节（首 NUL 后只允许 NUL/空格，拒绝控制字符）、octal size 禁 base-256、type 仅 `0`/NUL/`5`、按 size 跳块、末尾两零块其后只零 padding；拒绝 PAX/GNU 扩展、链接/设备、重复名与大小写碰撞、Windows ADS（`:`）、段尾空格/点、`..`、绝对路径、盘符、反斜杠、根外条目。Node 流式 gunzip 逐 header；Bash 用单次 `od -A n -v -t x1` 流式、PowerShell 用 `FileStream` + `byte[512]`，都是**一次遍历、不逐条目 spawn**。下载有界：Bash `curl | head -c MAX+1` 并立刻取 `PIPESTATUS`（超限失败、curl 非 0 失败）；PowerShell 调用前 guard `curl.exe --version >= 8.4.0`（不满足明确报错退出），再用 `--max-filesize`/`--max-time` 并在落盘后复核大小。gzip 解压同样 `gzip -dc | head -c LIMIT+1`：超限失败、gzip 非 0 且未超限失败（CRC/损坏），**不忽略任何非零**。稳定打包禁链接/特殊文件。
8. **锁**：目录锁 30 s / 200 ms；Node `mkdirSync`、Bash `mkdir`、PowerShell `New-Item`（**不加 `-Force`**；已实测重复路径抛 `System.IO.IOException`）。owner token 只释放自己的锁；陌生备份不清理。
9. **旧名结束**：全仓源码不再引用/删除 `opencode-tui-usage`（含 `plugins/tui/opencode-tui-usage*`）；只保留与旧名无关的 hud 旧布局清理；不动用户真实旧目录。
10. **发版**：draft 发布失败必须红；禁止 `&& publish || true`；已公开 Release 重跑不得 clobber 资产（公开态直接失败；draft 重跑先按本次两个资产名 `gh release delete-asset` 再上传）；回推只提交 `CHANGELOG.md`，每轮 fetch 后重新检验 tag 后 CHANGELOG 是否变化，避免 rebase 静默覆写。`gh` 步骤需 `GH_TOKEN: ${{ github.token }}` 与 job 级 `permissions`；`actions/checkout` 在 preflight 与 changelog 都必须 `fetch-depth: 0`；`gh release view` 非零且 stderr 含 not found 才算不存在。运维口径：Release 已发布后仅重跑 changelog 时用 Re-run failed jobs。固定 SHA 取核验报告值，但 CI 必须真的装 bun 跑 `node --test`；bash/pwsh 可用性显式检查，skip 不算覆盖；不盲加 `queue: max`。
11. **文档**：区分源码 2.2.6 与未实测的 CLI 2.3.0；不回填历史 spec/plan 原决策；性能写实测 p95 上限 **0.272 ms**（不采纳"全都 < 0.2"），并声明这是纯函数成本、不是 TUI CPU。

## 5. 条件阻塞（不实施，只保留现状并报告）

| 项 | 阻塞证据 | 本轮动作 |
| --- | --- | --- |
| 原生 `experimental.usage.limits`（#14） | 错误口径、企业跳过、null 语义、配置兜底、窗口严格性、2.2.6 实机调用均不满足 | 保留 `opencode-go` 的 HTTP provider；不新增 native 模块、不改 `fetch` 契约 |
| 性能重构（#12） | 1000 行实测平均 0.08–0.11 ms、p95 上限 0.272 ms；秒级 tick 占比约 0.01% | 不改 memo/引用复用；文档记录上限与"未测 TUI CPU" |
| `message.sync` 裁剪 / probe 重挂（#12 复现部分） | 源码可确认，未实机复现；无 hook 测试环境 | 只把"下一步会自愈"改为已知限制；不改代码 |
| 终端宽度（#13） | 无可观察错位样本 | 不改表、不安排实机改造 |
| `.gitignore`（#15/#16） | 用户未选择精简 | 不动 |

## 6. 残余风险（实现后必须在报告里如实列出）

- **checksum 不是签名**：sidecar 与归档同源（GitHub Release/TLS），只能防截断、CDN 错配与损坏；不防仓库或发布者被攻陷。README/AGENTS 不得表述为"供应链已加固到可防仓库攻陷"；本批不引入签名/attestation。
- **三实现同等规则，复杂度靠共享 fixture 兜底**：Node `scanTarGz`、Bash（`od` + 单个 awk 状态机）、PowerShell（`FileStream` + `byte[512]`）逐 512 字节 header 扫描遵守同一张规则表。风险不在"某实现更弱"，而在脚本侧解析（octal/checksum/名字字节）写错；因此攻击与合法 fixture 必须被三处共用，脚本测试必须同时证明"攻击归档失败且 DEST 不变"与"合法归档可安装"。CI 的 ubuntu job 上这些用例必须 0 skip。
- **锁不自动破锁**：崩溃后必须人工确认并删除锁目录；Release/CI 无法替代这一步。
- **Console 映射未就绪窗口**：只有 provider 不在 `list()` 里才算未就绪；**当前会话的 Console 供应商最多 60 s 不显示额度**（`null` 跳过），其余供应商的显示还受 5min 凭据探测 TTL 约束。已同步但无 `integrationID` 的 provider 按 `provider.id` 查询，不得当成未就绪。
- **默认 location 的取数边界**：`quota/host.ts` 读 `location.default()` 与其 provider 列表；worktree / 多目录会话下，当前会话目录特供的 provider 映射可能取不到 → 该供应商按 providerID 查询或暂时 `null`。这是已知边界，不扩展多 location 解析。
- **直读 DB 不触发宿主 OAuth 刷新**：access token 刷新后最多 60 s 内外层缓存可能持旧 token，出现一次 401 并进入 5min 退避；稳定身份只解决"刷新不换桶"。
- **旧名副本不会被自动清理**：安装/卸载都不删除用户机器上的旧目录，也不会按内容探测旧副本。升级或卸载后旧插件仍可能被宿主加载并与新安装同时注册相同 slot（侧栏、性能块重复渲染）；README/AGENTS/TODO 与本文必须显著写明需手工删除。
- **PowerShell 依赖 curl.exe ≥ 8.4.0**：低于该版本 `--max-filesize` 对无 `Content-Length` 的 chunked 响应无效；脚本在调用前 guard 版本，不满足明确报错退出（Bash 用 `curl | head -c` 不依赖该版本）。
- **发版流程只能静态验证**：本轮不推送/打 tag/创建 Release，也没有本地 actionlint；workflow 正确性靠逐项核对 + YAML 解析 + 下次真实发版确认。
- **脚本锁的 mkdir 已改 `LC_ALL=C`**：`install.sh`/`uninstall.sh` 的争用判定只认英文 `File exists`，加 `LC_ALL=C` 后不再依赖调用者语言环境；未在非英文 locale 实机复跑。
- **Bash 的 64 MiB 限额比 Node 更早拒绝**：脚本对 `gzip -dc` 的 raw tar 总量（含 512 字节 header 与 padding 块）施加 64 MiB 上限，而 Node 按条目内容累计，故同一份合法归档在脚本侧可能先触限。
- **跨机器 gzip 字节一致性未验证**：只证同一台机器两次构建字节相同（`cmp`）；不同 gzip/zlib 版本与平台组合下能否复现未验证。
- **Windows 上「解压后拒绝符号链接」真实行为未测**：`verifyExtractedTree` 的符号链接分支只在 POSIX 语义下测过，Windows 解压产出链接的形态没有实测样本。

## 7. 计划索引

1. `docs/superpowers/plans/2026-11-16-credential-rules.md` — Task 2 凭据 resolver、Task 3 store 与宿主接线。
2. `docs/superpowers/plans/2026-11-16-verified-delivery.md` — Task 4 Node 校验与更新器、Task 5 跨语言锁与脚本消费者/旧名结束、Task 6 稳定资产构建、Task 7 CI 与发版日志。
3. `docs/superpowers/plans/2026-11-16-validation-docs.md` — Task 1 互斥计数、Task 8 文档收口。

依赖：Task 3 依赖 Task 2 的公开面；Task 5 依赖 Task 4 的协议常量与函数（跨语言对齐）；Task 6/7 依赖 Task 4 的 checksum 解析与 Task 5 的脚本协议；Task 8 最后执行（读前三批结果）。

项 → 任务（事实，写审计状态附录时以此为准）：项 1 由 **Task 2/3** 实施；项 2–5 由 Task 2/3；项 6 由 Task 1；项 7–11 由 Task 4/5/6/7；项 12 只落 Task 8 文档；项 13/14/16 按现状保留；项 15 由 **Task 7（git-cliff/发版日志）+ Task 8（`docs/config-install.md`）**。
