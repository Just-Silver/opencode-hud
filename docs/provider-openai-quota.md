<!-- 职责：记录 OpenAI（ChatGPT 订阅）额度端点、凭据前提、真实响应与实测结论；不写：HUD 额度契约/渲染实现（见 model/types.ts、view/renderers/）、其他供应商。 -->

# OpenAI（ChatGPT 订阅）额度查询

- 探测/实测日期：2026-11-10（ChatGPT **Plus**，Codex 登录）
- 目标：判断 `quota/providers/openai.ts` 能否按 `provider` 契约（一个 GET + Bearer）拿到 5h / 周 / 月额度
- **结论**：能，但**只认 Codex 登录凭据**；`chatgpt-token-sharing`（Sign in with ChatGPT）的 token 一定 401。

## 0. 端点与鉴权

```
GET https://chatgpt.com/backend-api/wham/usage
Authorization: Bearer <oauth access>
Accept: application/json
User-Agent: opencode-hud
chatgpt-account-id: <可选>
```

- 这是**非公开接口**（Codex 客户端 `/status` 读的就是它），不在 OpenAI 公开文档里；响应结构可能无预警变化。
- `chatgpt-account-id` 可选：不带也 200，但 `account_id` 字段为空；带了才回填。
- 值从 token 的 **嵌套** claim 取：`["https://api.openai.com/auth"].chatgpt_account_id`（Codex 登录的 token 里就有，36 位）。opencode 同时把它存在 `credential.metadata.accountID`。

## 1. 凭据前提（踩过的坑）

opencode 对 `integration_id="openai"` 有**两套 OAuth 方法**，它们签发的 token 权限范围不同：

| 方法 | 代码 | 能否读 `wham/usage` | 实测 |
|---|---|---|---|
| `chatgpt-token-sharing`（Sign in with ChatGPT，当前默认） | `packages/core/src/plugin/provider/chatgpt.ts` | ❌ | `401 rejected_by_access_enforcement / no_matching_rule` |
| `chatgpt-browser` / `chatgpt-headless`（Codex 登录，UI 标 legacy） | `packages/core/src/plugin/provider/openai.ts` | ✅ | `200` |

token-sharing 的 token 只授权 `https://api.openai.com/v1`（`/v1/models` 200），而 `chatgpt.com/backend-api/*` 对它一律 401（`wham/usage`、`wham/profiles/me`、`codex/models` 都试过）。
第三方项目 [WrongStack](https://github.com/WrongStack/WrongStack) 的 `docs/slash/openai-quota.md` 也写明同一结论：*"the direct OAuth token cannot access ChatGPT's usage endpoints"*，所以它把 Codex 凭据只用于读额度。

同一账号下，token-sharing 的限额还是 **App 级**（错误码 `subscription_sharing_*`），与 plan 总额度不是一回事；要看 plan 额度必须走 Codex 凭据。

## 2. 真实响应（2026-11-10，Plus）

```json
{
  "plan_type": "plus",
  "rate_limit": {
    "allowed": true,
    "limit_reached": false,
    "primary_window":   { "used_percent": 15, "limit_window_seconds": 18000,  "reset_after_seconds": 8959,   "reset_at": 1794296300 },
    "secondary_window": { "used_percent": 2,  "limit_window_seconds": 604800, "reset_after_seconds": 595759, "reset_at": 1794883100 }
  },
  "spend_control": { "reached": false, "individual_limit": null },
  "additional_rate_limits": null,
  "credits": { "has_credits": false, "unlimited": false, "balance": "0" }
}
```

要点：

- **窗口语义全靠 `limit_window_seconds`**：`18000` = 5h，`604800` = 周，`2592000`/`2678400` = 月。不要按 primary/secondary 位置硬编码。
- **重置时间两个字段都有**：`reset_at`（绝对 epoch 秒）与 `reset_after_seconds`（相对秒）。provider 以 `reset_at` 优先、相对值兜底。
- **月度额度**在 `spend_control.individual_limit`（`remaining_percent` / `used` / `limit`）；Plus 实测为 `null` → 不出「月」行，只有该字段存在才加。
- `additional_rate_limits` 是 per-model / per-feature 的额外计量（可能为 null），当前不展示。
- 头 `x-codex-*` 类响应头是另一个数据源（真实请求带回来的读数），TUI 插件拿不到会话请求头，不采用。

## 3. 第三方实现对照（字段命名差异的由来）

| 实现 | 凭据来源 | 读取字段 |
|---|---|---|
| [@illiadotdev/codex-usage-plugin](https://www.npmjs.com/package/@illiadotdev/codex-usage-plugin) | `~/.codex/auth.json` 或旧版 opencode `auth.json` | `reset_at` + `spend_control.individual_limit` |
| [pi-chatgpt-limit](https://github.com/patlux/pi-chatgpt-limit) | pi 的 model registry | `used_percent` / `limit_window_seconds` / `reset_at` |
| [vbgate/opencode-mystatus](https://github.com/vbgate/opencode-mystatus) | **旧版** `~/.local/share/opencode/auth.json` | `reset_after_seconds`、`limit_reached` |

即：`reset_at` 与 `reset_after_seconds` 两种写法都被不同实现用过，provider 两个都容错。
注意 `opencode-mystatus` 读的是 opencode V1 的 `auth.json`，当前凭据在 sqlite `credential` 表，它在本仓同款环境里读不到——不要照抄它的凭据层。

## 4. 复验方法

```powershell
# 1) 看当前 openai 凭据是哪套方法（只读，不打印 token）
node -e "const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.env.USERPROFILE+'/.local/share/opencode/opencode.db',{readOnly:true});for(const r of db.prepare(\"SELECT value FROM credential WHERE integration_id='openai'\").all()){const v=JSON.parse(r.value);console.log(v.methodID, v.type, v.metadata&&Object.keys(v.metadata))}"

# 2) 探端点（走系统代理时加 NODE_USE_ENV_PROXY=1）
$env:NODE_USE_ENV_PROXY='1'; node -e "const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.env.USERPROFILE+'/.local/share/opencode/opencode.db',{readOnly:true});const v=JSON.parse(db.prepare(\"SELECT value FROM credential WHERE integration_id='openai' AND active=1 ORDER BY time_updated DESC LIMIT 1\").get().value);fetch('https://chatgpt.com/backend-api/wham/usage',{headers:{Authorization:'Bearer '+v.access,Accept:'application/json'}}).then(async r=>console.log(r.status,(await r.text()).slice(0,800)))"
```

- `200` → 正常，`quota/providers/openai.ts` 生效。
- `401 rejected_by_access_enforcement / no_matching_rule` → 当前是 token-sharing 凭据，需在 `/connect` 改用 Codex 登录（`chatgpt-browser` / `chatgpt-headless`）。
- 端点或响应结构变化时，改 `mapOpenai` 与 `tests/openai.test.ts` 的样例。
