<!-- 职责：执行计划——受控 Release 资产、Node 更新器、跨语言锁、安装/卸载脚本消费者、稳定构建、CI 与发版日志（Task 4–7）；不写：凭据与额度（见 2026-11-16-credential-rules.md）、计数与文档收口（见 2026-11-16-validation-docs.md）。 -->

# 受控交付链路 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让安装与更新只从「已发布、带 SHA256 校验资产的正式版 Release」取源，并在下载/解压/落地全程有界、可验证、可恢复。

**Architecture:** 协议拆成三个纯模块（`release.ts` 校验与常量、`download.ts` 有界流式、`tar.ts` 解压前逐 header 扫描），`apply.ts` 只做编排并在重命名事务上持目录锁。Bash/PowerShell 消费者实现**同一套**归档规则（有界 raw tar + 逐 512 字节 header 扫描），与 Node 共用攻击/合法 fixture。CI 复用同一套测试与编译门禁。

**Tech Stack:** Node 24（`node:test`、`node:zlib`、`node:crypto`）、系统 `tar`（GNU tar 构建资产、解压已校验归档）、Bash（`od` + 单个 awk 状态机）、PowerShell 7（`FileStream` + `GZipStream`，`New-Item` 目录锁，`curl.exe` ≥ 8.4.0）、GitHub Actions。

**Spec:** `docs/superpowers/specs/2026-11-16-audit-decisions-design.md`

## Global Constraints

- 协议常量：压缩上限 **16 MiB**、checksum 上限 **4 KiB**、解压后上限 **64 MiB**、条目上限 **2000**、下载超时 **120 s**、checksum 超时 **15 s**、锁等待 **30 s**、轮询 **200 ms**。
- 只接受正式 tag：`^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$`。`applyUpdate` 的入参是**裸 `X.Y.Z`**（拒绝前导 `v`、预发布、首尾空白），内部拼 `v`；现有 `UpdateInfo.latestVersion` 与 `UpdateDialog` 传值已符合，无需改调用方。**不引入 `ASSETS_SINCE`**，没有无校验回退（无旧源码归档、无 `git clone`、无 `main` 下载）。
- 资产名：`opencode-hud-vX.Y.Z.tar.gz` 与 `opencode-hud-vX.Y.Z.tar.gz.sha256`；归档根 `opencode-hud/`；sidecar 单行 `<64 hex>  <资产名>`。
- 归档只允许 USTAR 常规文件与目录；**Node/Bash/PS 三套实现遵守同一张规则表**：header checksum（两种写法，校验和字段按空格计）、`ustar\0` + `00`、name/prefix 原始字节（首 NUL 后只允许 NUL/空格，拒绝控制字符）、octal size 禁 base-256、type 仅 `0`/NUL/`5`、按 size 跳块、末尾两零块且其后只零 padding；拒绝 PAX/GNU 扩展、链接/设备、重复名与大小写碰撞、ADS（`:`）、段尾空格/点、`..`、绝对路径、盘符、反斜杠、根外条目。**禁止用 `tar -tf`/`-tvf` 文本解析做校验**。
- 有界性：Bash 下载 `curl -fL --max-time 120 url | head -c MAX+1 > file` 并立刻保存 `PIPESTATUS`（超限失败、curl 非 0 失败）；Bash 解压 `gzip -dc | head -c LIMIT+1`（超限失败、gzip 非 0 且未超限失败，**任何非零都不忽略**）。PowerShell 调用前 guard `curl.exe --version >= 8.4.0`（不满足明确报错退出），再用 `--max-filesize`/`--max-time` 并在落盘后复核大小；解压用 `GZipStream` 边解压边计数、超限即中止。解压前完成条目/总量校验；解压后 lstat 复核。
- 锁：目录 `<globalPluginsDir>/.opencode-hud.lock`；建锁前在**锁外** `mkdirSync(pluginsDir, { recursive: true })`；Node `mkdirSync`、Bash `mkdir`、PowerShell `New-Item` **不加 `-Force`**（已实测重复路径抛 `System.IO.IOException`）。只有 owner token 相同才释放；不按年龄破锁；不扫描/删除 `.opencode-hud-install-*`。安装、更新、卸载都走同一把锁。
- 旧名结束：源码/脚本零引用 `opencode-tui-usage`；安装/卸载**不删除**用户旧目录，也不按内容探测旧副本。README/AGENTS/TODO/设计必须显著写明"升级或卸载后旧副本仍可能被宿主加载，需手工删除，否则双实例重复渲染"。
- 固定 Action SHA（核验报告值，写全 40 位并注释版本）：`actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1`(v7.0.1)、`actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1`(v7.1.0)、`orhun/git-cliff-action@a9a95522b26fe6403f7bb24031f21fb573d0f5ff`(v4.9.1)、`oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6`(v2.2.0)。
- 不新增依赖、不引入打包器；`child_process` 只用于本地 `tar`（120 s、`windowsHide`）。
- **禁止 `git commit` / `git push` / 打 tag / 创建 Release / 安装到全局 / 请求真实额度**。每任务前 `task-snapshot.ps1 -Mode capture -Name task-0N-<slug>`，结束后 `-Mode review`，证据写 `.superpowers/decisions-2026-11-16/task-0N-report.md`。

## Review Focus

- 三套归档校验对同一批攻击 fixture 都失败、对合法归档都能安装（Task 4 测试 9–12；Task 5 脚本用例 5–8）。
- checksum 缺失/不匹配时不能发生解压，且 `DEST` 不动（Task 4 测试 13）。
- 下载/解压超限在写入过程中被截断，而不是落盘后才发现；gzip CRC 错误不能被吞掉（Task 4 测试 7；Task 5 脚本用例 7、9）。
- 旧名目录不被删除，但"仍需手工删除否则双实例"必须写入文档（Task 5 Step 8）。
- 已公开 Release 重跑不得 clobber、失败必须红；draft 重跑可幂等补齐资产（Task 7 静态清单）。

---

### Task 4: Release 协议、下载、归档扫描与更新器

**Files:**
- Create: `.opencode/plugins/opencode-hud/update/release.ts`、`update/download.ts`、`update/tar.ts`
- Modify: `.opencode/plugins/opencode-hud/update/apply.ts`、`update/index.ts`
- Create: `tests/update-release.test.ts`、`tests/update-download.test.ts`、`tests/update-tar.test.ts`、`tests/helpers/release-fixture.ts`
- Modify: `tests/update-apply.test.ts`、`tests/update.test.ts`

**Interfaces:**
- `release.ts`（纯函数，无网络/fs）：
  - 常量：`REPO`、`RELEASES_LATEST_URL`、`RELEASE_ARCHIVE_MAX_BYTES`、`RELEASE_CHECKSUM_MAX_BYTES`、`RELEASE_EXTRACTED_MAX_BYTES`、`RELEASE_EXTRACTED_MAX_ENTRIES`、`RELEASE_DOWNLOAD_TIMEOUT_MS`、`RELEASE_CHECKSUM_TIMEOUT_MS`。
  - `parseFormalTag(tag: string): { major: number; minor: number; patch: number } | undefined`
  - `parseVersionInput(version: string): string | undefined`：只接受裸 `X.Y.Z`（无前导 `v`、无空白、无预发布），返回 `vX.Y.Z`；供 `applyUpdate` 使用。
  - `parseTrustedReleaseLocation(location: string | null | undefined): string | undefined`：以 `https://github.com/` 为基解析相对 Location；要求 `https:`、host `github.com`、path 精确 `/Just-Silver/opencode-hud/releases/tag/<tag>`（无额外段/尾斜杠/query/hash），tag 通过 `parseFormalTag`。
  - `assetName(tag)`、`checksumAssetName(tag)`、`assetUrl(tag)`、`checksumUrl(tag)`。
  - `parseChecksum(text: string, expectedName: string): string | undefined`
  - `isSafeArchiveEntry(name: string): boolean`：必须**等于 `opencode-hud`** 或以 **`opencode-hud/`** 开头（`opencode-hudx/...` 拒绝）；按 `/` 分段后拒绝空段、`.`、`..`、段尾空格或点、任何 `:`、`\`、控制字符（`<0x20` 或 `0x7f`）、绝对路径与盘符。
- `download.ts`：
  - `downloadFile(url, dest, opts: { maxBytes: number; timeoutMs: number; fetchImpl?: typeof fetch }): Promise<{ ok: true; path: string; bytes: number; sha256: string } | { ok: false; message: string }>`
  - `fetchText(url, opts: { maxBytes: number; timeoutMs: number; fetchImpl?: typeof fetch }): Promise<{ ok: true; text: string } | { ok: false; message: string }>`
  - 跟随重定向（资产下载合法跳转到对象存储）；`Content-Length` 超限立即失败；无 `Content-Length` 时按累计字节；失败删除半成品。
- `tar.ts`：
  - `scanTarGz(path, limits?: { maxBytes?: number; maxEntries?: number }): Promise<{ ok: true; entries: number; totalBytes: number } | { ok: false; message: string }>`
  - `extractArgs(archivePath: string, destDir: string): string[]`（`["-xzf", archive, "-C", dest, "--strip-components=1", "--no-same-owner"]`，**不含 `-P`/`--absolute-names`**）
  - `verifyExtractedTree(dir, limits?): { ok: true } | { ok: false; message: string }`：递归 lstat 拒绝符号链接/特殊文件，确认所有路径都在 `dir` 内，文件数与总字节不超限，并要求 `dir/tui.tsx` 是常规文件。
- `apply.ts`：`ApplyUpdateDeps` 改为 `{ version: string; pluginDir?; workDir?; fetch?: typeof fetch; exec?; timeoutMs? }`；删除 `archiveUrl`、`buildTarArgs`、`fetchArchive`、`UPDATE_PLUGIN_SUBPATH` 与 `removeLegacyPluginDir`。仍返回 `{ok:true}|{ok:false,message}`，不抛异常。
  - 测试里的 `fakeExtract` 改为把 `tui.tsx` 直接写到 `-C` 目标根：`--strip-components=1` 已剥离 `opencode-hud/`，旧子路径断言全部删除。
- `update/index.ts`：删除 `parseTagFromReleaseUrl`；`fetchLatestTag` 用 `redirect:"manual"` + 状态 3xx + `parseTrustedReleaseLocation`；`resolveUpdate` 要求远程 tag 通过 `parseFormalTag`。
- 测试夹具 `tests/helpers/release-fixture.ts`（**Node/Bash/PS 共用**）：
  - `tarGz(entries: Array<{ name: string; type?: "file" | "dir" | "symlink" | "char" | "pax" | "gnu-longname"; data?: string; declaredSize?: number; badChecksum?: boolean; nonUstar?: boolean; base256Size?: boolean; omitEndBlocks?: boolean; trailingGarbage?: boolean }>): Buffer`
  - `validArchive(): Buffer`、`attackArchives(): Array<{ name: string; archive: Buffer }>`，至少覆盖：`dotdot`、`absolute`、`backslash`、`drive`、`control-char`、`opencode-hudx`、`dot-segment`、`ads-colon`、`trailing-dot`、`trailing-space`、`case-collision`、`duplicate`、`symlink`、`char-device`、`pax-extension`、`gnu-longname`、`bad-checksum`、`non-ustar`、`base256-size`、`truncated-data`、`no-end-blocks`、`garbage-after-end`、`too-many-entries`、`oversize-total`。
  - `writeRelease(root, opts: { tag: string; archive?: Buffer; checksum?: "ok" | "mismatch" | "missing" | "bad" }): { archivePath: string; checksumPath?: string }`

**扫描算法（Node `scanTarGz`，Bash/PS 同规则）：** `createReadStream → createGunzip`；按 512 字节处理：
1. header checksum：字段 `148..155` 按空格（0x20）计入 512 字节和；解析该字段为八进制（去掉尾部 NUL/空格，长度 1–7，仅 `0-7`），两种写法（6 位+NUL+空格 / 7 位+NUL）都接受；不等即失败。
2. magic：`257..262` == `"ustar\0"`，`263..264` == `"00"`；GNU `ustar  `、空 magic、PAX 一律失败。
3. name `0..99`、prefix `345..499`：读到首个 NUL；其后只允许 NUL/空格；字节级拒绝控制字符、`\`、`:`；非 ASCII 允许。prefix 非空时拼接 `prefix + "/" + name` 再交 `isSafeArchiveEntry`。
4. size `124..135`：仅八进制数字（允许 NUL/空格填充）；首字节最高位为 1（base-256）即失败；累计 `totalBytes` 与 `entries`，任一超限立即失败。
5. typeflag `156`：只接受 `0x30`（`0`）、`0x00`、`0x35`（`5`）；其余（`1/2/3/4/6/x/g/L/K` 等）失败。
6. 按 size 跳过 `ceil(size/512)` 个数据块；数据不足即"归档被截断"。
7. 重复名与大小写碰撞：以 ASCII 大小写折叠后的名字作键（非 ASCII 字节按原样），重复即失败。
8. 结束：至少两个连续全零块；出现第一个全零块后不得再出现非零块；其后只允许零 padding。EOF 时不足两零块、半块残留、无 `opencode-hud/tui.tsx` 条目均失败。

- [ ] **Step 1: 先写失败回归**

`tests/update-release.test.ts`：
1. `"只接受正式版 vX.Y.Z"`：接受 `v5.3.0`；拒绝 `v5.3`、`v5.3.0-rc.1`、`5.3.0`、`v05.3.0`、`v5.3.0/../x`。
2. `"applyUpdate 入参只接受裸 X.Y.Z"`：接受 `5.3.0`；拒绝 `v5.3.0`、` 5.3.0`、`5.3.0-rc.1`；接受时内部拼出 `v5.3.0` 资产 URL。
3. `"Release 跳转只认本仓库正式 tag 的绝对 https 地址"`：接受绝对与相对 Location；拒绝 `http:`、其他 owner/repo、`/releases/tag/v1.0.0/extra`、带 `?x=1`、`/releases/latest`、`v1.0.0-rc.1`。
4. `"checksum 单行且文件名必须匹配"`：接受两空格与 ` *`、CRLF、大小写 hex；拒绝 63/65 位、名字不符、多行、仅 hash、路径名字。
5. `"资产名/URL 精确"`。
6. `"归档条目只允许 opencode-hud 自身或其子路径"`：接受 `opencode-hud`、`opencode-hud/tui.tsx`、嵌套；拒绝 `opencode-hudx/tui.tsx`、`opencode-hud/./tui.tsx`、`opencode-hud/tui.tsx:ads`、`opencode-hud/tui.tsx.`、`opencode-hud/tui.tsx `、`../x`、`/etc/passwd`、`C:\x`、`opencode-hud\..\x`、`other/tui.tsx`、空/NUL/控制字符/`//`。

`tests/update-download.test.ts`：
7. `"分块下载边写边算 SHA256，成功不留半成品"`
8. `"超过压缩上限立即中止并删除半成品（无 Content-Length 也生效）"`
9. `"非 2xx / 超时 / 写盘失败 → 失败且清理"`

`tests/update-tar.test.ts`：
10. `"合法归档扫描返回条目数与总字节，并包含 tui.tsx"`
11. `"每一类攻击归档都被拒绝"`：遍历 `attackArchives()`，逐条断言 `ok:false` 且消息非空。
12. `"条目数与解压总量在扫描阶段超限即失败"`；`"header checksum 错 / 非 ustar / base-256 size / 缺结束块 / 结束块后垃圾 / 重复名 / 大小写碰撞 → 失败"`。

`tests/update-apply.test.ts` 改写（保留现有事务/回滚/清理失败用例骨架）：
13. `"checksum 缺失/格式错/不匹配 → 失败，且不发生解压、DEST 未动"`：`exec` 假件一被调用就 `throw new Error("不应解压")`（用于证明未解压），随后断言 `DEST/tui.tsx` 仍是旧内容。
14. `"成功：校验并扫描通过后才事务替换"`：注入合法字节能通过 `scanTarGz` 与校验（用 `release-fixture` 生成），断言 `DEST/tui.tsx` 更新、临时目录清理。
15. `"非正式或缺失 version → 失败，不访问网络"`。
16. `"归档含不安全条目 / 超限 → 失败且不发生解压"`。
17. `"下载失败 → 失败且目标目录不动"`；`"tar 缺失/非零退出 → 失败提示"`；`"归档缺 tui.tsx → 失败提示"`。
18. 保留：旧目录挪不走、提升失败回滚、回滚失败保留备份、临时目录创建失败返回失败、清理失败不覆盖结果、容器清理失败不报错。
19. 删除旧目录清理断言（旧名处理在 Task 5）。

`tests/update.test.ts`：
20. `"fetchLatestTag：只有 3xx 且 Location 指向本仓库正式 tag 才算最新"`（mock `Response`：302 合法、200 无 Location、302 跨仓库、302 带 query、302 预发布 → 后四者 `undefined`）。
21. `"checkForUpdate：非法/预发布不写入 latest，只推 lastAttemptAt"`。
22. 保留 TTL/冷却/损坏缓存用例。

- [ ] **Step 2: 运行，确认红**

Run: `node --test tests/update-release.test.ts tests/update-download.test.ts tests/update-tar.test.ts tests/update-apply.test.ts tests/update.test.ts`
Expected: FAIL（模块/函数不存在，旧 `archiveUrl` 断言失败）。

- [ ] **Step 3: 实现四个模块与更新器**

按 Interfaces 与扫描算法实现；`applyUpdate` 顺序固定为：`parseVersionInput` → `fetchText(checksumUrl)` → `parseChecksum` → `downloadFile(assetUrl)` → 比较 hash（大小写不敏感）→ `scanTarGz` → `mkdirSync(extractDir)` → `exec("tar", extractArgs(...))` → `verifyExtractedTree` → `installAtomically`。任何一步失败返回可读中文消息，**不进入下一步**；`finally` 清理 `workDir` 的既有语义保留。

- [ ] **Step 4: 运行，确认绿**

Run: 同 Step 2。
Expected: PASS。

- [ ] **Step 5: 全量 + 编译**

Run: `node --test tests/*.test.ts`；Run: esbuild 命令。
Expected: 全绿；`Done in`。

- [ ] **Step 6: 记录证据（不提交）**

Run: `pwsh -NoProfile -File .superpowers/decisions-2026-11-16/task-snapshot.ps1 -Mode review -Name task-04-release-protocol`
Expected: `review.diff`；报告写攻击 fixture 清单、Node 扫描结果与全量输出。

---

### Task 5: 目录锁、两套脚本消费者与旧名兼容结束

**Files:**
- Create: `.opencode/plugins/opencode-hud/shared/lock.ts`
- Modify: `.opencode/plugins/opencode-hud/update/apply.ts`（事务段加锁）、`shared/paths.ts`（删除旧名导出）、`install.sh`、`install.ps1`、`uninstall.sh`、`uninstall.ps1`
- Modify: `tests/update-apply.test.ts`、`tests/install.test.ts`、`tests/uninstall.test.ts`、`tests/helpers/release-fixture.ts`（导出脚本夹具所需的攻击/合法归档）
- Modify: `README.md`、`AGENTS.md`（安装/更新段）、`TODO.md`

**Interfaces:**
- `shared/lock.ts`：
  - `LOCK_WAIT_MS = 30_000`、`LOCK_POLL_MS = 200`、`LOCK_DIR_NAME = ".opencode-hud.lock"`
  - `lockDirFor(pluginsDir: string): string`
  - `withDirLock<T>(opts: { pluginsDir: string; tool: "update" | "install" | "uninstall"; waitMs?: number; pollMs?: number; pid?: number; now?: () => number; sleep?: (ms: number) => Promise<void>; onWarn?: (message: string) => void }, fn: () => Promise<T> | T): Promise<T>`
  - 进入临界区前 `mkdirSync(pluginsDir, { recursive: true })`（幂等、在锁外）；owner 文件 `owner` 四行：`tool=`、`pid=`、`startedAt=`、`token=`（token = `${pid}-${startedAt}-${随机}`）。
  - `applyUpdate` 与卸载脚本用 `dirname(pluginDir)` / `$pluginsDir` 作为 `pluginsDir`；**卸载也获取同一把锁**，拿不到就失败且不删除任何目标。

**脚本侧协议（bash 与 PowerShell 同序、同规则）：**
> Bash 中每个 `... | head -c` 管道都必须用 `set +e` 包裹、执行后立刻 `st=("${PIPESTATUS[@]}")`、再 `set -e`，否则 `set -euo pipefail` 会先退出而拿不到两侧状态。

1. 解析最新 tag：`curl` 不跟随跳转，读 `%{http_code} %{redirect_url}`（PS 用 `curl.exe -w`），要求 3xx 且 URL 通过本仓库正式 tag 校验；失败退出（无 `git ls-remote`、无 main）。
2. 取 checksum：`curl -fL --max-time 15`，Bash 走 `curl ... | head -c 4097 > file` + `PIPESTATUS`；PS 先 guard curl 版本再用 `--max-filesize 4096`，落盘后复核 ≤ 4 KiB。解析单行、文件名匹配。
3. 取归档：Bash `curl -fL --max-time 120 url | head -c 16777217 > "$archive"` 后立刻取 `PIPESTATUS`：大小 > 16 MiB 失败、curl 非 0 失败；PS guard `curl.exe --version >= 8.4.0`（不满足打印所需版本并非零退出），再用 `curl.exe -fL --max-filesize 16777216 --max-time 120 -o`，落盘后复核大小。
4. SHA256：Bash 依次尝试 `sha256sum` / `shasum -a 256` / `openssl dgst -sha256 -r`（没有 `-r` 时取最后一列）；都没有则失败；PS 用 `Get-FileHash -Algorithm SHA256`。不匹配即失败。
5. 解压前置限：Bash `gzip -dc "$archive" | head -c 67108865 > "$raw"`，立刻保存 `PIPESTATUS`：`raw` 大小 > 64 MiB → 失败；否则 gzip 非 0 → 失败（CRC/损坏）；PS 用 `GZipStream` 分块写 `raw`，写入过程中超限即中止，解压异常即失败。**这一步在 extract 之前。**
6. 条目校验（逐 512 字节 header，禁止 `tar -t*` 文本解析）：
   - Bash：`od -A n -v -t x1 "$raw" | awk -v maxBytes=67108864 -v maxEntries=2000 "$TAR_VERIFY_AWK"`。awk 程序以 here-doc 内嵌在 `install.sh`（脚本必须能单文件 `curl | bash`），**只 spawn 一次 `od` + 一次 `awk`**：把 `od` 的十六进制 token 累积到 512 字节块（不依赖 `-w512`；该选项 GNU od 有、BSD/macOS od 没有），按 Task 4 的规则表逐块校验（checksum、`ustar\0`+`00`、name/prefix 原始字节与 NUL 填充、octal size、type、跳块、条目数/总量、重复名与大小写折叠键、ADS/尾空格/尾点、两零块结束且其后只零），末尾断言存在 `opencode-hud/tui.tsx`。失败输出原因到 stderr 并非零退出。
   - PowerShell：`FileStream` + `byte[512]` 单次读取 `raw`，实现同一张规则表（含 header checksum、magic、NUL 填充、octal/base-256、type、跳块、结束块、重复/碰撞、ADS/尾空格/尾点、限额），失败即 `throw`。
7. 解压到全新空目录：`tar -xf "$raw" -C "$extract" --strip-components=1 --no-same-owner`，随后遍历确认 `tui.tsx` 为常规文件、无符号链接/特殊文件、路径都在 `extract` 内（纵深防线，不是唯一防线）。
8. 获取锁 → 重新检查 `DEST` → 既有 stage/backup/身份标记/回滚序列 → 成功清理自己的容器 → 释放自己的锁。
9. 删除旧名清理与 `git` 分支；`uninstall` 保留 `plugins/tui/opencode-hud*` 等 hud 旧布局条目，删除全部 `opencode-tui-usage` 条目（源码改动），但**运行时不再删除用户机器上的旧名目录**。

**测试夹具：** `BASH_FAKES` 的 `curl` 改为按 URL 返回：latest 的 `-w` 输出（可注入 302/200/跨仓库/预发布）、checksum 文件、归档文件（`-o` 落盘或写 stdout；可注入 `FAKE_CURL_OVERSIZE=1` 用 `dd` 输出 17 MiB）；删除 `git` 假件。PowerShell wrapper 用 `function curl.exe { ... }`（已验证函数可遮蔽原生 curl.exe 并收到 `-o/-w` 参数）返回同样夹具，并支持 `FAKE_CURL_VERSION`（默认 `8.4.0`，注入 `8.3.0` 验证版本 guard）、`FAKE_CURL_OVERSIZE` 输出超限字节；`Get-Command` 假件改为返回 curl.exe 非空。

- [ ] **Step 1: 先写失败回归（Node 锁）**

`tests/update-apply.test.ts` 新增：
1. `"目标被另一进程持锁时等待超时失败，DEST 不变，锁与 owner 保留"`（子进程创建锁目录并睡眠；`waitMs: 300`）。
2. `"成功与失败都只释放自己的锁"`（预置陌生 token 的锁 → 超时失败后锁仍在；正常路径结束后锁消失）。
3. `"预先存在的陌生事务容器不被清理"`。

- [ ] **Step 2: 写失败回归（脚本）**

`tests/install.test.ts` 新增（bash 与 PowerShell 各一套）：
4. `"资产安装成功：新 tui.tsx 生效、旧文件消失、无锁/身份标记残留"`（用 `validArchive()`）。
5. `"checksum 不匹配 / 缺失 / 格式错 → 非零，旧版完整，且未调用解压"`。
6. `"非正式 tag、最新 Release 无法确认（200/跨仓库）→ 非零，且未调用 git"`。
7. `"每一类攻击归档 → 非零，旧版完整"`（遍历 `attackArchives()`；含 `opencode-hudx`、dot 段、ADS、尾点/尾空格、大小写碰撞、重复、PAX/GNU 扩展、bad checksum、非 ustar、base-256、截断、缺结束块、结束块后垃圾）。
8. `"条目超 2000 / 解压总量超 64 MiB → 在解压前失败，旧版完整"`。
9. `"下载超 16 MiB 或 gzip 损坏 → 非零（Bash 检查 PIPESTATUS；PS 检查版本 guard 与解压异常）"`。
10. `"锁被占用 → 非零，旧版完整，锁与 owner 保留，输出含锁路径"`；`"成功与失败都释放自己的锁"`。
11. `"PowerShell 在 curl.exe < 8.4.0 时明确报错退出（不静默降级）"`（注入 `FAKE_CURL_VERSION=8.3.0`）。
12. `"旧名目录存在时安装不删除它、也不失败"`；保留现有 TOCTOU/回滚/容器清理/旧版清理用例（去掉旧名断言）。

`tests/uninstall.test.ts` 新增/改写：
13. `"锁被占用时不删除任何目标；释放后可成功"`
14. `"旧名目录（含 tui/opencode-tui-usage*）保留不删；hud 旧布局仍清理"`
15. 保留逐项失败继续与数据目录不删。

- [ ] **Step 3: 运行，确认红**

Run: `node --test tests/update-apply.test.ts tests/install.test.ts tests/uninstall.test.ts`
Expected: FAIL（锁不存在；脚本仍走 git/旧名清理/文本 tar 校验）。

- [ ] **Step 4: 实现锁、脚本与旧名清理**

按 Interfaces/协议实现。`applyUpdate` 只把「重命名事务」放进 `withDirLock`（下载/校验/解压在锁外）。`shared/paths.ts` 删除 `LEGACY_PLUGIN_DIR_NAME` 与 `legacyGlobalPluginDir`，并删掉 `update/apply.ts` 的旧名 import/调用。PowerShell 的 `New-Item` 注释写明「不能加 `-Force`，否则已存在目录也成功、失去互斥」这一非显然约束（不写来源/迁移缘由）。脚本头部说明必需命令与低版本 curl 的失败口径（无敏感信息）。

- [ ] **Step 5: 运行，确认绿**

Run: 同 Step 3。
Expected: PASS（本机 bash 与 pwsh 都存在，应 0 skip；若某平台缺 shell，报告里注明而不是当作通过）。

- [ ] **Step 6: 源码/脚本旧名与回退检查（分域验收）**

Run: `git grep -n "opencode-tui-usage" -- install.sh install.ps1 uninstall.sh uninstall.ps1 .opencode scripts .github`
Expected: **零命中**。
Run: `git grep -nE "ls-remote|git clone|archive/refs/tags|main\\.tar\\.gz" -- install.sh install.ps1 .opencode`
Expected: 零命中。
Run: `git grep -n "opencode-tui-usage" -- README.md AGENTS.md TODO.md docs`
Expected: 允许命中，但每处只能是「手工删除旧目录/旧副本仍会加载」的迁移说明（Step 8 检查）。

- [ ] **Step 7: 语法 + 全量**

Run: `bash -n install.sh uninstall.sh`
Run: `pwsh -NoProfile -Command "foreach ($f in 'install.ps1','uninstall.ps1') { $t=$null;$e=$null; [System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path $f),[ref]$t,[ref]$e)|Out-Null; if($e.Count){$e|%{Write-Error $_};exit 1} }"`
Run: `node --test tests/*.test.ts`；Run: esbuild 命令。
Expected: 语法 0 error；全绿；`Done in`。

- [ ] **Step 8: 文档同步（本任务行为）**

- `README.md`：前置条件改为 `curl` + 系统 `tar` + `gzip`；Windows 要求 PowerShell 7 + `curl.exe >= 8.4.0` + 自带 `tar`；说明「脚本只安装带校验资产的最新正式 Release；脚本合入 main 到首个带资产 Release 发布之间暂不可用」「旧版 Release 缺资产会明确失败，不回退」。
- `README.md`/`AGENTS.md`/`TODO.md`（三处都要，措辞一致）：**显著写明**「从 v4.1.x 升级或卸载后，旧目录不会被脚本自动删除；旧副本仍可能被宿主加载并与新安装重复注册相同 slot（侧栏、性能块重复渲染），必须手工删除后重启」。
- `AGENTS.md`「安装/更新」：资产协议、锁、旧名兼容已结束（只描述现状与手工清理，不再要求源码清理）。
- `TODO.md`：旧名迁移项标记为已结束（保留历史背景，不动其他条目）。
- 不新增按内容探测旧副本/自动清理的逻辑。

- [ ] **Step 9: 记录证据（不提交）**

Run: `pwsh -NoProfile -File .superpowers/decisions-2026-11-16/task-snapshot.ps1 -Mode review -Name task-05-lock-scripts`
Expected: `review.diff`；报告写各脚本用例数、0 skip、语法检查、分域 grep 结果与三处文档警告位置。

---

### Task 6: 稳定资产构建脚本

**Files:**
- Create: `scripts/build-release-asset.sh`
- Create: `tests/release-asset.test.ts`

**Interfaces:**
- `bash scripts/build-release-asset.sh <tag> <outDir> [srcPluginDir]`
  - `srcPluginDir` 默认 `.opencode/plugins/opencode-hud`（测试注入临时副本）。
  - 输出 `<outDir>/opencode-hud-<tag>.tar.gz` 与 `.sha256`；stdout 打印两个路径。
- 行为（失败即非零）：tag 必须是正式版且等于 `update/version.ts` 的 `VERSION`（前缀 `v`）；**显式 `TAR=${TAR:-tar}` 并校验 `"$TAR" --version | grep -q 'GNU tar'`，否则报「需要 GNU tar」并退出**（本机 bash 默认 `tar` 可能是 system32 bsdtar，不能假设）；源目录含符号链接/特殊文件即拒绝；用 `LC_ALL=C`、`"$TAR" --sort=name --mtime='@0' --owner=0 --group=0 --numeric-owner --format=ustar`、`gzip -n -9` 构建两次并 `cmp`；sidecar 用裸文件名（先 `cd` 到输出目录再 `sha256sum`；无 `sha256sum` 时用 `shasum -a 256`）；构建后断言：`tar -tf`（仅用于构建产物观察，不用于安全校验）**顶层唯一项必须是目录 `opencode-hud/`**、含 `opencode-hud/tui.tsx`、无隐藏垃圾（`grep -E '(^|/)\.'` 零命中）。

- [ ] **Step 1: 先写失败回归**

`tests/release-asset.test.ts`（依赖注入 GNU tar）：
- 探测顺序：`process.env.TAR` → Windows 下 `"/usr/bin/tar"`（Git Bash 自带 GNU tar）→ `"tar"`；对每个候选跑 `--version` 且必须含 `GNU tar`。都不可用才 `skip: "需要 GNU tar"`；Windows 允许 skip（但必须不是探测写错导致），**CI ubuntu 必须 0 skip**。命中后所有构建调用都带 `TAR=<该路径>` 注入。
1. `"同一源目录两次构建字节一致，sidecar 可被 parseChecksum 解析"`（两次构建到不同 outDir 比较字节；用 `update/release.ts` 的 `parseChecksum` 校验 sidecar）。
2. `"归档顶层唯一项是目录 opencode-hud/，含 tui.tsx，且无隐藏垃圾"`（拒绝「常规文件恰好名为 `opencode-hud`」的源布局）。
3. `"tag 与 VERSION 不一致时构建失败"`。
4. `"源目录含符号链接时构建失败"`（不能创建符号链接的平台跳过该子断言）。
5. `"TAR 指向非 GNU tar 时构建失败并提示需要 GNU tar"`（写一个只打印 `bsdtar 3.8.9` 的临时假 `tar` 并注入 `TAR`，不依赖平台路径）。
6. `"sidecar 文件名是裸资产名（无目录前缀）"`。

- [ ] **Step 2: 运行，确认红**

Run: `node --test tests/release-asset.test.ts`
Expected: FAIL（脚本不存在）。

- [ ] **Step 3: 实现脚本**

严格 `set -euo pipefail`；`trap` 清理临时目录；错误信息给出失败原因（无堆栈、无敏感信息）。注释只写非显然约束（为何固定 `--mtime/--sort/--numeric-owner`、为何显式校验 GNU tar、为何 sidecar 必须裸名）。

- [ ] **Step 4: 运行，确认绿**

Run: `node --test tests/release-asset.test.ts`
Expected: PASS（本机通过 `TAR=/usr/bin/tar` 注入 GNU tar 1.35，不应 skip）。
Run: `bash -n scripts/build-release-asset.sh`
Expected: 通过。

- [ ] **Step 5: 全量 + 编译**

Run: `node --test tests/*.test.ts`；Run: esbuild 命令。
Expected: 全绿；`Done in`。

- [ ] **Step 6: 记录证据（不提交）**

Run: `pwsh -NoProfile -File .superpowers/decisions-2026-11-16/task-snapshot.ps1 -Mode review -Name task-06-asset-build`
Expected: `review.diff`；报告写两次构建的 SHA256、sidecar 内容、GNU tar 探测结果与测试输出。

---

### Task 7: CI 门禁、发版工作流与发布日志

**Files:**
- Create: `.github/workflows/ci.yml`
- Modify: `.github/workflows/release.yml`
- Modify: `cliff.toml`
- Modify: `AGENTS.md`（「校验（改完必跑）」「更新与发版」）
- Test: 无单元测试；验证 = YAML 解析 + 逐项核对 + 本地脚本 dry-run（不推送）

**Interfaces / 结构：**
- `ci.yml`：`on: push(main) / pull_request / workflow_call`；`permissions: contents: read`。
  - `test`（matrix `ubuntu-latest`、`windows-latest`）：checkout(固定 SHA) → setup-node 24 → **setup-bun 1.3.14** → `bun --version` → `node --test --test-reporter=tap tests/install.test.ts tests/uninstall.test.ts` 后断言 `# skipped 0` → `node --test --test-reporter=tap tests/key.test.ts` 后断言 `# skipped 0` → `node --test --test-reporter=tap tests/release-asset.test.ts` 后断言 `# skipped 0`（**仅 ubuntu**；Windows 允许因系统无 GNU tar 而 skip，但必须显式打印探测结果）→ 全量 `node --test tests/*.test.ts` → `bash -n install.sh uninstall.sh` → PowerShell Parser 检查。
  - `bundle`：esbuild `0.28.2` 固定版本编译门禁。
  - `bun`：`bun build` 冒烟（`--external @opencode/plugin/tui --external @opentui/solid --external solid-js`）。
  - `changelog-render`：git-cliff 固定 SHA，`args: --unreleased --strip header` 输出到临时文件并断言非空（验证模板可渲染，不发布）。
- `release.yml`：`preflight → verify(uses ci.yml) → release → changelog`；workflow 级 `concurrency: { group: release-${{ github.repository }}, cancel-in-progress: false }`（**不加 `queue: max`**）。
  - 所有 job 显式 `permissions`；`release`/`changelog` 需要 `contents: write`，`preflight`/`verify` 为 `contents: read`；`gh` 步骤带 `GH_TOKEN: ${{ github.token }}`。
  - `preflight`：checkout `fetch-depth: 0` 且 `fetch-tags: true`；tag 正式版正则、`VERSION` 精确一致、`git fetch origin main` 后 `git merge-base --is-ancestor $GITHUB_SHA origin/main`。
  - `release`：checkout `fetch-depth: 0`；构建资产（调用 `scripts/build-release-asset.sh`）；git-cliff `--current --strip header` 生成 body；**存在性判断**：`gh release view "$TAG"` 非零且 stderr 含 `not found` 才算不存在；否则读取 `isDraft`。`isDraft=false`（已公开）→ **直接失败**（"已发布，拒绝覆盖资产"）。draft 存在 → 先按本次两个资产名逐个 `gh release delete-asset "$TAG" <name>`（该资产不存在时忽略），再上传；不存在 → `gh release create --draft --verify-tag`。上传后 `gh release download` + `sha256sum -c` 复核两个资产名都在，最后 `gh release edit --draft=false`。任何一步失败即非零，**禁止 `--clobber` 与 `|| true`**。
  - `changelog`：`needs: release`；checkout `fetch-depth: 0`；生成全量 CHANGELOG；循环 3 次：`git fetch origin main` → 比对 `git show "$TAG:CHANGELOG.md"` 与 `git show origin/main:CHANGELOG.md` 字节内容（不同即失败，避免覆盖）→ 从 `origin/main` 重建临时分支 → 只复制并提交 `CHANGELOG.md` → 断言 `git diff --name-only origin/main HEAD` 只有 `CHANGELOG.md` → `git push origin HEAD:main`；3 次失败后明确报"Release 已发布，请手工合并"并非零退出。
  - 运维口径写入 job 注释与 AGENTS：**Release 已发布后若只有 changelog 失败，用 Re-run failed jobs（只重跑 changelog），不要整条 workflow 重跑**（整条重跑会因已公开态按设计失败）。
- `cliff.toml`：在 `^chore` 解析器前加入 `{ message = "^chore.*CHANGELOG", skip = true }` 与 `{ message = "^更新 CHANGELOG", skip = true }`；`body` 版本标题改为比较链接（`previous.version` 存在则 compare，否则 `releases/tag/{{ version }}`），仓库 URL 写死，不加 `[remote.github]`。

- [ ] **Step 1: 写 ci.yml**

按上面结构落地；所有 `uses` 写 40 位 SHA + `# vX.Y.Z` 注释；skip 断言用跨 shell 一致的方式：
`node --test --test-reporter=tap <files> > out.txt` 然后 `node -e "const t=require('fs').readFileSync('out.txt','utf8'); if(!/^# skipped 0$/m.test(t)){console.error(t);process.exit(1)}"`。

- [ ] **Step 2: 重写 release.yml 与 cliff.toml**

按结构落地；保留"改 VERSION → commit → tag → push"的入口注释；不手改 `CHANGELOG.md`。

- [ ] **Step 3: 静态验证**

Run: `python -c "import sys,yaml; [yaml.safe_load(open(f,encoding='utf-8')) for f in sys.argv[1:]]" .github/workflows/ci.yml .github/workflows/release.yml`
Expected: 无输出（解析通过）。若本机无 PyYAML，如实报告"未验证"。
Run: `git grep -nE "uses:\\s+\\S+@(v[0-9]|main|master)" -- .github/workflows`
Expected: 零命中（全部固定 SHA）。
Run: 人工核对清单（写进报告）：每个 `uses` 的 40 位 SHA 与注释一致；每个 job 有 `permissions`；`GH_TOKEN` 只在需要 `gh` 的步骤；`needs` 图正确；release 中无 `--clobber`、无 `|| true`；公开 Release 分支先失败；draft 分支先 `delete-asset` 再上传；changelog 每轮 fetch 后重新比对 CHANGELOG；`queue:` 未出现；preflight/changelog 的 `fetch-depth: 0` 存在。
Run: `node --test tests/*.test.ts`；Run: esbuild 命令；Run: `bash -n install.sh uninstall.sh`。
Expected: 全绿。

- [ ] **Step 4: 文档同步（发版事实）**

`AGENTS.md`「校验（改完必跑）」补 CI 口径（bun 必须存在、skip 门禁、esbuild、双 shell）；「更新与发版」改为：只发正式 `vX.Y.Z`、tag 必须来自 main、资产与 checksum 协议、锁、旧名兼容已结束（手工清理警告）、发版需 CI 门禁、Release 先于 CHANGELOG 回推、回推只允许 CHANGELOG、已发布后重跑只用 Re-run failed jobs 跑 changelog。

- [ ] **Step 5: 记录证据（不提交）**

Run: `pwsh -NoProfile -File .superpowers/decisions-2026-11-16/task-snapshot.ps1 -Mode review -Name task-07-ci-release`
Expected: `review.diff`；报告写 YAML 解析结果、SHA/权限/重跑口径核对清单、未执行项（无推送/发版/本地 actionlint 缺失）。
