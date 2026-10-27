---
name: managing-quota-providers
description: Use when adding, updating, or removing a quota provider in the opencode-hud plugin — e.g. 接入某供应商的额度查询（新增 provider）、某额度 API 新增字段要显示、调整额度区块展示、删除某供应商；也用于判断"该复用共享渲染器还是新建"。
---

# 管理额度供应商（新增 / 修改 / 删除）

## 核心原则

- **provider 只给数据、不画 UI**：`quota/providers/<name>.ts` 的 `fetch` 返回 `QuotaData = { items: QuotaItem[] }`；`QuotaItem = { label, percent?, text?, hint? }`。
- **展示形态走共享渲染器层**（`view/renderers/`）：供应商经 `render: "<name>"` 选用；**没有合适的就新建一个共享渲染器**，绝不改 `QuotaSection.tsx`/`bars.tsx` 塞某个供应商的专属逻辑。
- **契约（`model/types.ts`）只放渲染原语**：新语义（新字段/新提示）先想能不能用 `label/percent/text/hint` 表达 —— 能就别动契约。

项目根 = 本仓库根目录（`AGENTS.md` 有结构、硬约束、校验命令）。

## 新增供应商

1. **先搞清 API（先搜，搜不到再问）**：用 `webfetch`/`websearch` 找**官方文档或 OpenAPI 规范**，确定 查询 URL + 鉴权方式 + 响应结构。
   - 留证据：URL 与字段的文档出处；**不许猜**。
   - 搜不到 / 文档不给额度端点 → **停下来问用户**（要 URL 或一份真实响应），不要编。
2. **选渲染器（先查共享层，再决定）**：读 `view/renderers/registry.ts` 的 `RENDERER_NAMES`。
   - 有能表达该形态的 → `render: "<name>"` 直接复用；
   - 没有 → 新建 `view/renderers/<name>.tsx`，并在 `view/renderers/registry.ts` 的 `RENDERER_NAMES` 与 `view/renderers/index.ts` 的 `RENDERERS` 各登记一项（`satisfies` 会强制两处一致）。
3. **写 provider**：照抄 `providers/opencode-go.ts`。`fetch` 把响应映射成 `items`：有上限 → `percent`（进度条）；无上限/余额 → `text`；时间/备注 → `hint`（如 `fmtResetHint(resetsAt)` → `"↻ 周一"`）。**空数组 / `undefined` → 额度区块整体不显示。**
4. **验证前先 `enabled: false`**：没有真实凭据/真实响应验证过，就不要 `enabled: true`（`enabled:false` 会跳过白名单；验证通过再打开）。**展示设计（哪几行、标签叫什么）要跟用户确认**，别自己定完就启用。
5. **测试与校验**：加 `tests/<name>.test.ts` 钉住 `mapXxx`（纯函数、离线、零网络）→ `node --test tests/*.test.ts` 全过 → esbuild 打包检查（命令见 `AGENTS.md`「运行与验证」）→ 更新 `AGENTS.md`（供应商清单、测试文件数）。

## 修改供应商

- **用户要改展示** → 改该 provider 的 `items`，优先复用现有原语。
- **API 返回新字段** → 在 provider 里映射：有上限 → `percent`（进度条）；无上限/余额 → `text`；时间/备注 → `hint`。
- 只有当**现有渲染器表达不了**该形态时，才新增共享渲染器（同「新增」第 2 步）。
- **不要往 `QuotaItem` 加语义字段**（如 `resetsAt`）—— 用 `hint`/`text` 表达。
- 改完跑测试 + esbuild + 更新 `AGENTS.md`。

## 删除供应商

1. 删 `quota/providers/<name>.ts` —— 自动发现，删文件即卸载，**无需改任何注册表**。
2. 删其专属测试 `tests/<name>.test.ts`，并清理其它测试里的引用；**保留通用能力用例**（把专属供应商换成中性合成供应商，别顺手删掉 `enabled` 开关/归一化等通用覆盖）。
3. **共享渲染器与 view 层不主动删**（`view/renderers/*`、`QuotaSection.tsx`、`theme.ts` 等）—— 除非用户**明确要求**。
4. `CHANGELOG.md` 是历史冻结（CI 按 commit 生成），**不改**。
5. 跑测试 + esbuild + 更新 `AGENTS.md`。

## 红旗 —— 停下来重做

- 没搜到/没确认 URL 就开写（应该问用户）
- 为了某个供应商去改 `QuotaSection.tsx` / `bars.tsx`（应走 provider 数据或共享渲染器）
- 往契约加字段（`resetsAt` 之类）—— 用 `hint`/`text`
- 没真实验证就 `enabled: true`
- 删供应商时顺手删了共享层文件 / 改了 CHANGELOG
- 没跑 `node --test` 或没更新 `AGENTS.md`
