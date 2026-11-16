// ─── install.sh / install.ps1：受控 Release 资产协议、有界下载、归档校验与目录锁 ───
// 隔离临时配置目录 + 本地假 curl（不触网、不写全局目录）；归档字节与 Node 扫描器共用同一批 fixture。
import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { basename, dirname, join } from "path"
import { fileURLToPath } from "url"
import { attackArchives, sha256Hex, tarGz } from "./helpers/release-fixture.ts"

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const INSTALL_SH = join(REPO_ROOT, "install.sh")
const INSTALL_PS1 = join(REPO_ROOT, "install.ps1")
// 脚本写在 stage、提升后必须能在 DEST 根读回的本次安装身份
const TOKEN_FILE = ".opencode-hud-install-token"
const LOCK_NAME = ".opencode-hud.lock"
const TAG = "v9.9.9"
const ASSET = `opencode-hud-${TAG}.tar.gz`

// Windows 上只认 Git Bash（MSYS/Cygwin）：WSL 的 bash 访问不到 C:/ 路径，脚本夹具会失真
const bashProbe = spawnSync("bash", ["-c", "uname -s"], { encoding: "utf8", windowsHide: true })
const hasBash =
  bashProbe.status === 0 &&
  (process.platform !== "win32" || /MSYS|MINGW|CYGWIN/i.test(bashProbe.stdout ?? ""))
const hasPwsh = spawnSync("pwsh", ["-NoProfile", "-Command", "exit 0"], { windowsHide: true }).status === 0

const posix = (path: string) => path.replace(/\\/g, "/")

// 合法资产：顶层目录 + 入口 + 子目录（用于证明旧文件随整目录替换消失）
function installArchive(): Buffer {
  return tarGz([
    { name: "opencode-hud/", type: "dir" },
    { name: "opencode-hud/tui.tsx", data: "new-tui" },
    { name: "opencode-hud/sub/", type: "dir" },
    { name: "opencode-hud/sub/new.ts", data: "new-sub" },
  ])
}

// 假 curl 按 URL 返回本地 Release 夹具；latest 只回 3xx 状态行，下载走 stdout 或 -o。
// git 只做调用探针：脚本一旦回退到 git 就会留下标记文件。
const BASH_FAKES = `
curl() {
  local url="" arg fmt=""
  for arg in "$@"; do
    case "$arg" in
      http://*|https://*) url="$arg" ;;
      *url_effective*|*http_code*) fmt="$arg" ;;
    esac
  done
  case "$url" in
    */releases/latest)
      if [ -n "$fmt" ]; then
        printf '%s %s' "\${FAKE_LATEST_HTTP:-302}" "\${FAKE_LATEST_URL:-https://github.com/Just-Silver/opencode-hud/releases/tag/\${FAKE_TAG:-${TAG}}}"
      fi
      return 0
      ;;
    *.sha256)
      case "\${FAKE_CHECKSUM_MODE:-ok}" in
        missing) return 22 ;;
        oversize) head -c 4097 /dev/zero; return 0 ;;
        *)
          [ -n "\${FAKE_CHECKSUM_FILE:-}" ] || return 22
          cat "$FAKE_CHECKSUM_FILE"
          return 0
          ;;
      esac
      ;;
    *.tar.gz)
      if [ "\${FAKE_CURL_OVERSIZE:-0}" = "1" ]; then
        head -c 17825792 /dev/zero
        return 0
      fi
      [ -n "\${FAKE_ARCHIVE_FILE:-}" ] || return 22
      cat "$FAKE_ARCHIVE_FILE"
      return 0
      ;;
  esac
  return 22
}

git() {
  if [ -n "\${FAKE_GIT_MARKER:-}" ]; then printf 'git' >> "$FAKE_GIT_MARKER"; fi
  return 1
}

tar() {
  if [ -n "\${FAKE_TAR_MARKER:-}" ]; then printf 'tar' >> "$FAKE_TAR_MARKER"; fi
  command tar "$@"
}

mv() {
  local src="\${1:-}" dst="\${2:-}" sbase dbase
  sbase="$(basename "$src")"
  dbase="$(basename "$dst")"
  if [ "\${FAKE_FAIL_MOVE_OLD:-0}" = "1" ] && [ "$sbase" = "opencode-hud" ]; then
    printf 'simulated: cannot move existing install dir\\n' >&2
    return 1
  fi
  if [ "\${FAKE_FAIL_PROMOTE:-0}" = "1" ] && [ "$sbase" = "stage" ] && [ "$dbase" = "opencode-hud" ]; then
    printf 'simulated: cannot promote new copy\\n' >&2
    return 1
  fi
  if [ "\${FAKE_FAIL_ROLLBACK:-0}" = "1" ] && [ "$dbase" = "opencode-hud" ]; then
    printf 'simulated: cannot write install dir\\n' >&2
    return 1
  fi
  # 真实 TOCTOU 窗口：最后一次检查之后、真正提升之前，另一个安装落地
  if [ "\${FAKE_CREATE_DEST_ON_PROMOTE:-0}" = "1" ] && [ "$sbase" = "stage" ] && [ "$dbase" = "opencode-hud" ]; then
    mkdir -p "$FAKE_DEST"
    printf 'concurrent-tui' > "$FAKE_DEST/tui.tsx"
  fi
  # 同类窗口出现在回滚：检查目标不存在之后、恢复 mv 之前
  if [ "\${FAKE_CREATE_DEST_ON_ROLLBACK:-0}" = "1" ] && [ "$sbase" = "backup" ] && [ "$dbase" = "opencode-hud" ]; then
    mkdir -p "$FAKE_DEST"
    printf 'concurrent-tui' > "$FAKE_DEST/tui.tsx"
  fi
  command mv "$@"
  if [ "\${FAKE_CREATE_DEST_ON_BACKUP:-0}" = "1" ] && [ "$sbase" = "opencode-hud" ] && [ "$dbase" = "backup" ]; then
    mkdir -p "$FAKE_DEST"
    printf 'concurrent-tui' > "$FAKE_DEST/tui.tsx"
  fi
}

rm() {
  local target="" arg
  for arg in "$@"; do
    case "$arg" in
      -*) ;;
      *) target="$arg" ;;
    esac
  done
  case "$(basename "$target")" in
    .opencode-hud-install-token) ;;
    .opencode-hud-install-*)
      if [ "\${FAKE_FAIL_CONTAINER_RM:-0}" = "1" ]; then
        printf 'simulated: container in use\\n' >&2
        return 1
      fi
      ;;
  esac
  command rm "$@"
}
`

const PWSH_WRAPPER = `
$ErrorActionPreference = "Stop"
# Windows CI 的控制台代码页会把中文输出变成 ?，断言按 utf8 读回时失败
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding

# 让脚本的「curl.exe 不存在」分支可达；其余调用原样委托
function Get-Command {
  [CmdletBinding()]
  param([Parameter(Position = 0)][string]$Name, $CommandType)
  if ($env:FAKE_CURL_MISSING -eq '1' -and $Name -eq 'curl.exe') { return $null }
  Microsoft.PowerShell.Core\\Get-Command @PSBoundParameters
}

# 假 curl.exe：函数可遮蔽原生命令，并照常收到 -o / -w 参数
function curl.exe {
  $argv = @($args)
  if ($argv.Count -gt 0 -and $argv[0] -eq '--version') {
    $version = if ($env:FAKE_CURL_VERSION) { $env:FAKE_CURL_VERSION } else { '8.4.0' }
    Write-Output ("curl " + $version + " (fake)")
    $global:LASTEXITCODE = 0
    return
  }
  if ($argv.Count -eq 0) { $global:LASTEXITCODE = 22; return }
  $url = [string]$argv[-1]
  $outPath = $null
  for ($i = 0; $i -lt $argv.Count - 1; $i++) {
    if ($argv[$i] -eq '-o') { $outPath = [string]$argv[$i + 1] }
  }
  $wantsStatus = ($argv -join ' ') -match '\\{http_code\\}'
  if ($url -like '*/releases/latest') {
    if ($wantsStatus) {
      $http = if ($env:FAKE_LATEST_HTTP) { $env:FAKE_LATEST_HTTP } else { '302' }
      $tag = if ($env:FAKE_TAG) { $env:FAKE_TAG } else { '${TAG}' }
      $loc = if ($env:FAKE_LATEST_URL) { $env:FAKE_LATEST_URL } else { "https://github.com/Just-Silver/opencode-hud/releases/tag/$tag" }
      Write-Output ("$http $loc")
    }
    $global:LASTEXITCODE = 0
    return
  }
  if ($url -like '*.sha256') {
    if ($env:FAKE_CHECKSUM_MODE -eq 'missing') { $global:LASTEXITCODE = 22; return }
    if ($env:FAKE_CHECKSUM_MODE -eq 'oversize') {
      [IO.File]::WriteAllBytes($outPath, (New-Object byte[] 4097))
      $global:LASTEXITCODE = 0
      return
    }
    if ($env:FAKE_CHECKSUM_FILE) {
      [IO.File]::WriteAllBytes($outPath, [IO.File]::ReadAllBytes($env:FAKE_CHECKSUM_FILE))
      $global:LASTEXITCODE = 0
      return
    }
    $global:LASTEXITCODE = 22
    return
  }
  if ($url -like '*.tar.gz') {
    if ($env:FAKE_CURL_OVERSIZE -eq '1') {
      [IO.File]::WriteAllBytes($outPath, (New-Object byte[] 17825792))
      $global:LASTEXITCODE = 0
      return
    }
    if ($env:FAKE_ARCHIVE_FILE) {
      [IO.File]::WriteAllBytes($outPath, [IO.File]::ReadAllBytes($env:FAKE_ARCHIVE_FILE))
      $global:LASTEXITCODE = 0
      return
    }
    $global:LASTEXITCODE = 22
    return
  }
  $global:LASTEXITCODE = 22
}

function git {
  if ($env:FAKE_GIT_MARKER) { Add-Content -LiteralPath $env:FAKE_GIT_MARKER -Value 'git' -NoNewline }
  $global:LASTEXITCODE = 1
}

function tar {
  if ($env:FAKE_TAR_MARKER) { Add-Content -LiteralPath $env:FAKE_TAR_MARKER -Value 'tar' -NoNewline }
  # 复现 Git 自带 GNU tar 的行为：带盘符的参数会被当成远程主机
  if ($env:FAKE_TAR_REJECT_DRIVE -eq '1') {
    foreach ($arg in $args) {
      if ("$arg" -match '^[A-Za-z]:') {
        [Console]::Error.WriteLine("tar: Cannot connect to $($Matches[0]) resolve failed")
        $global:LASTEXITCODE = 128
        return
      }
    }
  }
  # Windows 是可执行文件 tar.exe，Linux 是 tar；两种都要能找到
  $exe = @(Get-Command tar.exe -CommandType Application -ErrorAction SilentlyContinue) | Select-Object -First 1
  if (-not $exe) { $exe = @(Get-Command tar -CommandType Application -ErrorAction SilentlyContinue) | Select-Object -First 1 }
  if (-not $exe) { throw "测试环境缺少 tar" }
  & $exe.Source @args
}

function Move-Item {
  [CmdletBinding()]
  param([Parameter(Position = 0)]$Path, [Parameter(Position = 1)]$Destination, [switch]$Force, [string]$LiteralPath)
  # 假件必须与真实命令语义一致：脚本用 -LiteralPath 才走字面路径，用 -Path 仍保留通配行为
  $useLiteral = $PSBoundParameters.ContainsKey('LiteralPath')
  if ($useLiteral) { $Path = $LiteralPath }
  $srcLeaf = Split-Path -Leaf $Path
  $dstLeaf = Split-Path -Leaf $Destination
  $fail = ($env:FAKE_FAIL_MOVE_OLD -eq '1' -and $srcLeaf -eq 'opencode-hud') -or
          ($env:FAKE_FAIL_PROMOTE -eq '1' -and $srcLeaf -eq 'stage' -and $dstLeaf -eq 'opencode-hud') -or
          ($env:FAKE_FAIL_ROLLBACK -eq '1' -and $dstLeaf -eq 'opencode-hud')
  if ($fail) { Write-Error "simulated move failure"; return }
  # 真实 TOCTOU 窗口：最后一次检查之后、真正提升之前，另一个安装落地
  if ($env:FAKE_CREATE_DEST_ON_PROMOTE -eq '1' -and $srcLeaf -eq 'stage' -and $dstLeaf -eq 'opencode-hud') {
    New-Item -ItemType Directory -Force -Path $env:FAKE_DEST | Out-Null
    Set-Content -LiteralPath (Join-Path $env:FAKE_DEST "tui.tsx") -Value "concurrent-tui" -NoNewline
  }
  if ($env:FAKE_CREATE_DEST_ON_ROLLBACK -eq '1' -and $srcLeaf -eq 'backup' -and $dstLeaf -eq 'opencode-hud') {
    New-Item -ItemType Directory -Force -Path $env:FAKE_DEST | Out-Null
    Set-Content -LiteralPath (Join-Path $env:FAKE_DEST "tui.tsx") -Value "concurrent-tui" -NoNewline
  }
  if ($useLiteral) {
    Microsoft.PowerShell.Management\\Move-Item -LiteralPath $Path -Destination $Destination -Force:$Force
  } else {
    Microsoft.PowerShell.Management\\Move-Item -Path $Path -Destination $Destination -Force:$Force
  }
  if ($env:FAKE_CREATE_DEST_ON_BACKUP -eq '1' -and $srcLeaf -eq 'opencode-hud' -and $dstLeaf -eq 'backup') {
    New-Item -ItemType Directory -Force -Path $env:FAKE_DEST | Out-Null
    Set-Content -LiteralPath (Join-Path $env:FAKE_DEST "tui.tsx") -Value "concurrent-tui" -NoNewline
  }
}

function Remove-Item {
  [CmdletBinding()]
  param([Parameter(Position = 0, ValueFromPipeline = $true)]$Path, [switch]$Recurse, [switch]$Force, [string]$LiteralPath)
  $useLiteral = $PSBoundParameters.ContainsKey('LiteralPath')
  if ($useLiteral) { $Path = $LiteralPath }
  if ($env:FAKE_FAIL_CONTAINER_RM -eq '1' -and (Split-Path -Leaf $Path) -like '.opencode-hud-install-*' -and (Split-Path -Leaf $Path) -ne '.opencode-hud-install-token') {
    Write-Error "simulated container in use"
    return
  }
  if ($useLiteral) {
    Microsoft.PowerShell.Management\\Remove-Item -LiteralPath $Path -Recurse:$Recurse -Force:$Force
  } else {
    Microsoft.PowerShell.Management\\Remove-Item -Path $Path -Recurse:$Recurse -Force:$Force
  }
}

. '__INSTALL__'
`

type Layout = {
  root: string
  configHome: string
  pluginsDir: string
  dest: string
  legacy: string
}

// 配置目录刻意带空格：安装路径含空格也必须可用
function seedLayout(withLegacy = true): Layout {
  const root = mkdtempSync(join(tmpdir(), "ohud install-"))
  const configHome = join(root, "config dir")
  const pluginsDir = join(configHome, "opencode", "plugins")
  const dest = join(pluginsDir, "opencode-hud")
  mkdirSync(join(dest, "sub"), { recursive: true })
  writeFileSync(join(dest, "tui.tsx"), "old-tui")
  writeFileSync(join(dest, "a.ts"), "old-a")
  writeFileSync(join(dest, "sub", "deep.ts"), "old-deep")
  const legacy = join(pluginsDir, "opencode-tui-usage")
  if (withLegacy) {
    mkdirSync(legacy, { recursive: true })
    writeFileSync(join(legacy, "tui.tsx"), "legacy")
  }
  return { root, configHome, pluginsDir, dest, legacy }
}

// 首次安装：目标目录还不存在
function freshLayout(): Layout {
  const root = mkdtempSync(join(tmpdir(), "ohud install-"))
  const configHome = join(root, "config dir")
  const pluginsDir = join(configHome, "opencode", "plugins")
  return { root, configHome, pluginsDir, dest: join(pluginsDir, "opencode-hud"), legacy: join(pluginsDir, "opencode-tui-usage") }
}

// OPENCODE_CONFIG_DIR 是全局配置根本身（值后不再拼 opencode）；旧 XDG 根只用于证明未被误操作
function customRootLayout(customDirName = "custom config") {
  const root = mkdtempSync(join(tmpdir(), "ohud install-"))
  const xdgRoot = join(root, "xdg config")
  const customRoot = join(root, customDirName)
  const xdgPlugins = join(xdgRoot, "opencode", "plugins")
  const xdgLegacy = join(xdgPlugins, "opencode-tui-usage")
  mkdirSync(xdgLegacy, { recursive: true })
  writeFileSync(join(xdgLegacy, "tui.tsx"), "xdg-legacy")
  const pluginsDir = join(customRoot, "plugins")
  const dest = join(pluginsDir, "opencode-hud")
  mkdirSync(join(dest, "sub"), { recursive: true })
  writeFileSync(join(dest, "tui.tsx"), "old-tui")
  writeFileSync(join(dest, "a.ts"), "old-a")
  writeFileSync(join(dest, "sub", "deep.ts"), "old-deep")
  const legacy = join(pluginsDir, "opencode-tui-usage")
  mkdirSync(legacy, { recursive: true })
  writeFileSync(join(legacy, "tui.tsx"), "legacy")
  return { root, configHome: xdgRoot, pluginsDir, dest, legacy, customRoot, xdgPlugins, xdgLegacy }
}

// 本地 Release 夹具：资产字节 + 对应的单行 sidecar；返回脚本要读的文件路径
// 每次调用都写新文件：同组用例共享 layout 时，后一次调用不能覆盖前一个用例的字节
let fixtureSeq = 0
function releaseFixtures(layout: Layout, archive: Buffer = installArchive(), checksum?: string): Record<string, string> {
  const id = ++fixtureSeq
  const archivePath = join(layout.root, `release-asset-${id}.tar.gz`)
  const checksumPath = join(layout.root, `release-asset-${id}.tar.gz.sha256`)
  writeFileSync(archivePath, archive)
  writeFileSync(checksumPath, checksum ?? `${sha256Hex(archive)}  ${ASSET}\n`)
  return { FAKE_ARCHIVE_FILE: archivePath, FAKE_CHECKSUM_FILE: checksumPath }
}

function runBash(layout: Layout, flags: Record<string, string> = {}) {
  const fakeEnv = join(layout.root, "bash-fakes.sh")
  writeFileSync(fakeEnv, BASH_FAKES)
  const env: Record<string, string | undefined> = {
    ...process.env,
    // 空串对 bash/PS/插件都表示「未设置」；不中和会把用例写到 ambient 的真实全局根
    OPENCODE_CONFIG_DIR: "",
    XDG_CONFIG_HOME: posix(layout.configHome),
    BASH_ENV: posix(fakeEnv),
    ...flags,
  }
  for (const key of ["FAKE_ARCHIVE_FILE", "FAKE_CHECKSUM_FILE", "FAKE_GIT_MARKER", "FAKE_TAR_MARKER"]) {
    if (env[key]) env[key] = posix(env[key]!)
  }
  const res = spawnSync("bash", [INSTALL_SH], { env, encoding: "utf8", windowsHide: true })
  return { code: res.status ?? -1, output: `${res.stdout ?? ""}${res.stderr ?? ""}` }
}

function runPwsh(layout: Layout, flags: Record<string, string> = {}) {
  const wrapper = join(layout.root, "pwsh-fakes.ps1")
  writeFileSync(wrapper, PWSH_WRAPPER.replace("__INSTALL__", INSTALL_PS1.replace(/'/g, "''")))
  const res = spawnSync("pwsh", ["-NoProfile", "-File", wrapper], {
    env: {
      ...process.env,
      OPENCODE_CONFIG_DIR: "",
      XDG_CONFIG_HOME: layout.configHome,
      ...flags,
    },
    encoding: "utf8",
    windowsHide: true,
  })
  return { code: res.status ?? -1, output: `${res.stdout ?? ""}${res.stderr ?? ""}` }
}

type Shell = { name: string; run: (layout: Layout, flags?: Record<string, string>) => { code: number; output: string }; skip?: string }
const SHELLS: Shell[] = [
  { name: "install.sh", run: runBash, skip: hasBash ? undefined : "缺少 MSYS/Cygwin bash" },
  { name: "install.ps1", run: runPwsh, skip: hasPwsh ? undefined : "缺少 pwsh（PowerShell 7）" },
]

function assertOldIntact(dest: string): void {
  assert.equal(readFileSync(join(dest, "tui.tsx"), "utf8"), "old-tui")
  assert.equal(readFileSync(join(dest, "a.ts"), "utf8"), "old-a")
  assert.equal(readFileSync(join(dest, "sub", "deep.ts"), "utf8"), "old-deep")
}

function assertNewInstalled(dest: string): void {
  assert.equal(readFileSync(join(dest, "tui.tsx"), "utf8").trim(), "new-tui")
  assert.equal(existsSync(join(dest, "a.ts")), false, "旧文件应随整目录替换消失")
  assert.equal(existsSync(join(dest, "sub", "deep.ts")), false, "旧子目录应随整目录替换消失")
  assert.equal(readFileSync(join(dest, "sub", "new.ts"), "utf8").trim(), "new-sub")
  assert.equal(existsSync(join(dest, TOKEN_FILE)), false, "安装成功后不应残留本次安装的身份标记")
}

function assertNoLock(pluginsDir: string): void {
  assert.equal(existsSync(join(pluginsDir, LOCK_NAME)), false, "正常结束后不应残留目录锁")
}

// 宿主发现器只认 plugins/ 直接子目录里的 tui.tsx
function discoverableDirs(pluginsDir: string, exclude: string[] = []): string[] {
  return readdirSync(pluginsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(pluginsDir, entry.name))
    .filter((dir) => !exclude.includes(dir) && existsSync(join(dir, "tui.tsx")))
}

// 事务容器的 backup/ 里保存的旧版本（顶层容器本身不含 tui.tsx）
function backupDirs(pluginsDir: string): string[] {
  return readdirSync(pluginsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(pluginsDir, entry.name, "backup"))
    .filter((dir) => existsSync(join(dir, "tui.tsx")))
}

function cleanup(layout: Layout): void {
  rmSync(layout.root, { recursive: true, force: true })
}

// ─── 成功路径 ───

for (const shell of SHELLS) {
  test(`${shell.name}：受控资产安装成功，新版本生效、旧文件消失、无锁/身份标记残留`, { skip: shell.skip }, () => {
    const layout = seedLayout()
    try {
      // 证明传给 tar 的是相对路径：假 tar 对任何带盘符的参数退 128
      const driveGuard = shell.name === "install.ps1" ? { FAKE_TAR_REJECT_DRIVE: "1" } : {}
      const { code, output } = shell.run(layout, { ...releaseFixtures(layout), ...driveGuard })
      assert.equal(code, 0, output)
      assertNewInstalled(layout.dest)
      assertNoLock(layout.pluginsDir)
      assert.deepEqual(discoverableDirs(layout.pluginsDir, [layout.dest, layout.legacy]), [])
    } finally {
      cleanup(layout)
    }
  })

  test(`${shell.name}：首次安装（无旧版本）直接落地`, { skip: shell.skip }, () => {
    const layout = freshLayout()
    try {
      const { code, output } = shell.run(layout, releaseFixtures(layout))
      assert.equal(code, 0, output)
      assertNewInstalled(layout.dest)
      assertNoLock(layout.pluginsDir)
    } finally {
      cleanup(layout)
    }
  })

  test(`${shell.name}：旧名目录存在时安装不删除它、也不失败`, { skip: shell.skip }, () => {
    const layout = seedLayout()
    try {
      const { code, output } = shell.run(layout, releaseFixtures(layout))
      assert.equal(code, 0, output)
      assertNewInstalled(layout.dest)
      assert.equal(readFileSync(join(layout.legacy, "tui.tsx"), "utf8"), "legacy", "旧副本必须原样保留")
    } finally {
      cleanup(layout)
    }
  })

  // ─── 供应链：任何校验失败都不触碰现有安装 ───

  test(`${shell.name}：checksum 不匹配 / 缺失 / 格式错 → 非零，旧版完整且未调用解压`, { skip: shell.skip }, () => {
    const layout = seedLayout()
    const tarMarker = join(layout.root, "tar-called")
    try {
      const cases: Array<{ name: string; flags: Record<string, string> }> = [
        { name: "mismatch", flags: releaseFixtures(layout, installArchive(), `${"0".repeat(64)}  ${ASSET}\n`) },
        { name: "missing", flags: { ...releaseFixtures(layout), FAKE_CHECKSUM_MODE: "missing" } },
        { name: "bad", flags: releaseFixtures(layout, installArchive(), "not a checksum\n") },
        { name: "oversize", flags: { ...releaseFixtures(layout), FAKE_CHECKSUM_MODE: "oversize" } },
      ]
      for (const item of cases) {
        const { code, output } = shell.run(layout, { ...item.flags, FAKE_TAR_MARKER: tarMarker })
        assert.notEqual(code, 0, `${item.name}: ${output}`)
        assert.match(output, /校验|checksum/i, item.name)
        assertOldIntact(layout.dest)
        assertNoLock(layout.pluginsDir)
        assert.equal(existsSync(tarMarker), false, `${item.name}: 校验失败后不应调用解压`)
      }
    } finally {
      cleanup(layout)
    }
  })

  test(`${shell.name}：非正式 tag 或最新 Release 无法确认 → 非零，且未调用 git`, { skip: shell.skip }, () => {
    const layout = seedLayout()
    const marker = join(layout.root, "git-called")
    try {
      const cases: Array<{ name: string; flags: Record<string, string> }> = [
        { name: "200", flags: { ...releaseFixtures(layout), FAKE_LATEST_HTTP: "200" } },
        {
          name: "cross-repo",
          flags: {
            ...releaseFixtures(layout),
            FAKE_LATEST_URL: "https://github.com/evil/opencode-hud/releases/tag/v9.9.9",
          },
        },
        {
          name: "prerelease",
          flags: { ...releaseFixtures(layout), FAKE_TAG: "v9.9.9-rc.1" },
        },
        {
          name: "not-a-tag",
          flags: { ...releaseFixtures(layout), FAKE_TAG: "latest" },
        },
      ]
      for (const item of cases) {
        const { code, output } = shell.run(layout, { ...item.flags, FAKE_GIT_MARKER: marker })
        assert.notEqual(code, 0, `${item.name}: ${output}`)
        assert.match(output, /最新正式 Release|无法确认/i, item.name)
        assertOldIntact(layout.dest)
        assert.equal(existsSync(marker), false, "不允许回退到 git")
      }
    } finally {
      cleanup(layout)
    }
  })

  test(`${shell.name}：每一类攻击归档 → 非零、给出具体拒绝原因、旧版完整`, { skip: shell.skip }, () => {
    const layout = seedLayout()
    const tarMarker = join(layout.root, "tar-called")
    try {
      for (const attack of attackArchives()) {
        const { code, output } = shell.run(layout, { ...releaseFixtures(layout, attack.archive), FAKE_TAR_MARKER: tarMarker })
        assert.notEqual(code, 0, `${attack.name}: ${output}`)
        assert.ok(output.includes(attack.reason), `${attack.name}: 应包含「${attack.reason}」\n${output}`)
        assertOldIntact(layout.dest)
        assertNoLock(layout.pluginsDir)
        assert.equal(existsSync(tarMarker), false, `${attack.name}: 归档校验失败后不应调用解压`)
      }
    } finally {
      cleanup(layout)
    }
  })

  test(`${shell.name}：条目超 2000 / 解压总量超 64 MiB 在解压前失败`, { skip: shell.skip }, () => {
    const layout = seedLayout()
    try {
      for (const name of ["too-many-entries", "oversize-total"]) {
        const attack = attackArchives().find((item) => item.name === name)
        assert.ok(attack, `缺少攻击夹具：${name}`)
        const { code, output } = shell.run(layout, releaseFixtures(layout, attack.archive))
        assert.notEqual(code, 0, `${name}: ${output}`)
        assert.ok(output.includes(attack.reason), `${name}: ${output}`)
        assertOldIntact(layout.dest)
      }
    } finally {
      cleanup(layout)
    }
  })

  test(`${shell.name}：下载超 16 MiB 或 gzip 损坏 → 非零，旧版完整`, { skip: shell.skip }, () => {
    const layout = seedLayout()
    try {
      const oversize = shell.run(layout, { ...releaseFixtures(layout), FAKE_CURL_OVERSIZE: "1" })
      assert.notEqual(oversize.code, 0, oversize.output)
      assert.match(oversize.output, /上限/, "下载超限必须给出上限原因")
      assertOldIntact(layout.dest)

      const corruptBytes = Buffer.concat([Buffer.from("this is not a gzip archive\n"), Buffer.alloc(128, 0x41)])
      const corrupt = shell.run(layout, releaseFixtures(layout, corruptBytes))
      assert.notEqual(corrupt.code, 0, corrupt.output)
      assert.match(corrupt.output, /gzip|解压/i, "gzip 损坏必须失败而不是被忽略")
      assertOldIntact(layout.dest)
    } finally {
      cleanup(layout)
    }
  })

  // ─── 目录锁 ───

  test(`${shell.name}：锁被占用 → 非零、旧版完整、锁与 owner 保留并打印锁路径`, { skip: shell.skip }, () => {
    const layout = seedLayout()
    const lockDir = join(layout.pluginsDir, LOCK_NAME)
    const owner = "tool=update\npid=4242\nstartedAt=1\ntoken=someone-else\n"
    mkdirSync(lockDir)
    writeFileSync(join(lockDir, "owner"), owner)
    try {
      const { code, output } = shell.run(layout, releaseFixtures(layout))
      assert.notEqual(code, 0, output)
      assert.match(output, /锁/)
      const expectedLockPath = shell.name === "install.sh" ? posix(lockDir) : lockDir
      const compact = output.replace(/\x1b\[[0-9;]*m/g, "").replace(/[\s|]+/g, "")
      assert.ok(compact.includes(expectedLockPath.replace(/\s+/g, "")), `输出应包含锁路径：\n${output}`)
      assertOldIntact(layout.dest)
      assert.equal(readFileSync(join(lockDir, "owner"), "utf8").trim(), owner.trim(), "别人的 owner 不能被改写")
    } finally {
      cleanup(layout)
    }
  })

  test(`${shell.name}：成功与失败都只释放自己的锁`, { skip: shell.skip }, () => {
    const layout = seedLayout()
    try {
      const success = shell.run(layout, releaseFixtures(layout))
      assert.equal(success.code, 0, success.output)
      assertNoLock(layout.pluginsDir)

      // 失败路径前把目标恢复为旧版内容，才能断言「失败不碰 DEST」
      writeFileSync(join(layout.dest, "tui.tsx"), "old-tui")
      writeFileSync(join(layout.dest, "a.ts"), "old-a")
      mkdirSync(join(layout.dest, "sub"), { recursive: true })
      writeFileSync(join(layout.dest, "sub", "deep.ts"), "old-deep")
      const failure = shell.run(layout, { ...releaseFixtures(layout), FAKE_FAIL_MOVE_OLD: "1" })
      assert.notEqual(failure.code, 0, failure.output)
      assertOldIntact(layout.dest)
      assertNoLock(layout.pluginsDir)
    } finally {
      cleanup(layout)
    }
  })

  // ─── 事务语义（既有契约保留） ───

  test(`${shell.name}：旧版本无法挪走时不改动旧版本并报失败`, { skip: shell.skip }, () => {
    const layout = seedLayout()
    try {
      const { code, output } = shell.run(layout, { ...releaseFixtures(layout), FAKE_FAIL_MOVE_OLD: "1" })
      assert.notEqual(code, 0, output)
      assertOldIntact(layout.dest)
      assert.deepEqual(discoverableDirs(layout.pluginsDir, [layout.dest, layout.legacy]), [])
    } finally {
      cleanup(layout)
    }
  })

  test(`${shell.name}：新版本提升失败时回滚旧版本，不留下可被宿主发现的副本`, { skip: shell.skip }, () => {
    const layout = seedLayout()
    try {
      const { code, output } = shell.run(layout, { ...releaseFixtures(layout), FAKE_FAIL_PROMOTE: "1" })
      assert.notEqual(code, 0, output)
      assertOldIntact(layout.dest)
      assert.deepEqual(discoverableDirs(layout.pluginsDir, [layout.dest, layout.legacy]), [])
    } finally {
      cleanup(layout)
    }
  })

  test(`${shell.name}：回滚也失败时保留旧版本备份并打印可恢复路径`, { skip: shell.skip }, () => {
    const layout = seedLayout()
    try {
      const { code, output } = shell.run(layout, { ...releaseFixtures(layout), FAKE_FAIL_ROLLBACK: "1" })
      assert.notEqual(code, 0, output)
      const backups = backupDirs(layout.pluginsDir)
      assert.equal(backups.length, 1, `应恰好保留一份旧版本备份，实际：${backups.join(", ")}`)
      assert.equal(readFileSync(join(backups[0], "tui.tsx"), "utf8"), "old-tui")
      assert.equal(existsSync(join(backups[0], TOKEN_FILE)), false, "唯一旧版备份里不应残留身份标记")
      // 终端换行可能把长路径拆行，用随机的容器名作为可定位标识
      assert.ok(output.includes(basename(dirname(backups[0]))), `输出应给出旧版本路径：\n${output}`)
      assert.deepEqual(discoverableDirs(layout.pluginsDir, [layout.dest, layout.legacy]), [])
    } finally {
      cleanup(layout)
    }
  })

  test(`${shell.name}：预检查发现目标已被并发创建时放弃覆盖，保留旧版本备份`, { skip: shell.skip }, () => {
    const layout = seedLayout()
    try {
      const { code, output } = shell.run(layout, {
        ...releaseFixtures(layout),
        FAKE_CREATE_DEST_ON_BACKUP: "1",
        FAKE_DEST: layout.dest,
      })
      assert.notEqual(code, 0, output)
      assert.equal(readFileSync(join(layout.dest, "tui.tsx"), "utf8").trim(), "concurrent-tui", "并发落地的副本不应被覆盖")
      const backups = backupDirs(layout.pluginsDir)
      assert.equal(backups.length, 1, `应保留旧版本备份，实际：${backups.join(", ")}`)
      assert.equal(readFileSync(join(backups[0], "tui.tsx"), "utf8"), "old-tui")
      assert.match(output, /放弃覆盖/)
    } finally {
      cleanup(layout)
    }
  })

  test(`${shell.name}：最后检查后、提升前目标被并发创建时报失败，并发副本与旧备份都保留`, { skip: shell.skip }, () => {
    const layout = seedLayout()
    try {
      // 注入点就在提升前：mv/Move-Item 会把 stage 静默嵌套进这个并发目录并返回 0
      const { code, output } = shell.run(layout, {
        ...releaseFixtures(layout),
        FAKE_CREATE_DEST_ON_PROMOTE: "1",
        FAKE_DEST: layout.dest,
      })
      assert.notEqual(code, 0, output)
      assert.equal(readFileSync(join(layout.dest, "tui.tsx"), "utf8").trim(), "concurrent-tui", "并发落地的副本不应被覆盖")
      const backups = backupDirs(layout.pluginsDir)
      assert.equal(backups.length, 1, `应保留旧版本备份，实际：${backups.join(", ")}`)
      assert.equal(readFileSync(join(backups[0], "tui.tsx"), "utf8"), "old-tui")
      assert.match(output, /身份标记/)
      assert.match(output, /嵌套/)
      assert.doesNotMatch(output, /安装完成/)
    } finally {
      cleanup(layout)
    }
  })

  test(`${shell.name}：回滚时目标被并发创建不误报已恢复，旧版本实际副本仍可定位`, { skip: shell.skip }, () => {
    const layout = seedLayout()
    try {
      const { code, output } = shell.run(layout, {
        ...releaseFixtures(layout),
        FAKE_FAIL_PROMOTE: "1",
        FAKE_CREATE_DEST_ON_ROLLBACK: "1",
        FAKE_DEST: layout.dest,
      })
      assert.notEqual(code, 0, output)
      assert.equal(readFileSync(join(layout.dest, "tui.tsx"), "utf8").trim(), "concurrent-tui", "并发落地的副本不应被覆盖")
      assert.equal(readFileSync(join(layout.dest, "backup", "tui.tsx"), "utf8"), "old-tui", "旧版本应保留在可定位的嵌套目录")
      assert.equal(existsSync(join(layout.dest, "backup", TOKEN_FILE)), false, "失败报告后不应把身份标记留在旧版本里")
      assert.doesNotMatch(output, /已恢复旧版本/)
      assert.match(output, shell.name === "install.sh" ? /未能验证旧版恢复/ : /恢复未落地/)
    } finally {
      cleanup(layout)
    }
  })

  test(`${shell.name}：安装成功后容器清理失败仍报成功，且不残留身份标记`, { skip: shell.skip }, () => {
    const layout = seedLayout()
    try {
      const { code, output } = shell.run(layout, { ...releaseFixtures(layout), FAKE_FAIL_CONTAINER_RM: "1" })
      assert.equal(code, 0, output)
      assertNewInstalled(layout.dest)
      assert.match(output, /安装完成/)
      // 清理失败只留下无 tui.tsx 的事务容器，不该被宿主当成第二个插件
      assert.deepEqual(discoverableDirs(layout.pluginsDir, [layout.dest, layout.legacy]), [])
    } finally {
      cleanup(layout)
    }
  })

  test(`${shell.name}：OPENCODE_CONFIG_DIR 指定自定义全局根时只装到该根，旧 XDG 根不动`, { skip: shell.skip }, () => {
    const layout = customRootLayout()
    try {
      const { code, output } = shell.run(layout, { ...releaseFixtures(layout), OPENCODE_CONFIG_DIR: layout.customRoot })
      assert.equal(code, 0, output)
      assertNewInstalled(layout.dest)
      assert.equal(readFileSync(join(layout.xdgLegacy, "tui.tsx"), "utf8"), "xdg-legacy", "旧 XDG 根不应被操作")
      assert.equal(existsSync(join(layout.xdgPlugins, "opencode-hud")), false, "不应装到旧 XDG 根")
    } finally {
      cleanup(layout)
    }
  })
}

test("install.ps1：配置根含方括号时只操作字面路径，不误写相邻匹配根", { skip: hasPwsh ? undefined : "缺少 pwsh（PowerShell 7）" }, () => {
  const layout = customRootLayout("custom config[1]")
  // `custom config[1]` 作为通配模式会匹配 `custom config1`；后者是无关目录，不能被读写
  const neighborPlugins = join(layout.root, "custom config1", "plugins")
  const neighborDest = join(neighborPlugins, "opencode-hud")
  const neighborLegacy = join(neighborPlugins, "opencode-tui-usage")
  mkdirSync(neighborDest, { recursive: true })
  writeFileSync(join(neighborDest, "tui.tsx"), "neighbor-tui")
  mkdirSync(neighborLegacy, { recursive: true })
  writeFileSync(join(neighborLegacy, "tui.tsx"), "neighbor-legacy")
  try {
    const { code, output } = runPwsh(layout, { ...releaseFixtures(layout), OPENCODE_CONFIG_DIR: layout.customRoot })
    assert.equal(readFileSync(join(neighborDest, "tui.tsx"), "utf8"), "neighbor-tui", "相邻匹配根不能被替换")
    assert.equal(existsSync(neighborLegacy), true, "相邻匹配根的目录不能被清理")
    assert.equal(code, 0, output)
    assertNewInstalled(layout.dest)
  } finally {
    cleanup(layout)
  }
})

test("install.ps1：curl.exe < 8.4.0 时明确报错退出，不静默降级", { skip: hasPwsh ? undefined : "缺少 pwsh（PowerShell 7）" }, () => {
  const layout = seedLayout()
  try {
    const { code, output } = runPwsh(layout, { ...releaseFixtures(layout), FAKE_CURL_VERSION: "8.3.0" })
    assert.notEqual(code, 0, output)
    assert.match(output, /8\.4\.0/)
    assertOldIntact(layout.dest)
    assertNoLock(layout.pluginsDir)
  } finally {
    cleanup(layout)
  }
})

test("install.ps1：curl.exe 不存在时给出明确提示而不是命令解析错误", { skip: hasPwsh ? undefined : "缺少 pwsh（PowerShell 7）" }, () => {
  const layout = seedLayout()
  try {
    const { code, output } = runPwsh(layout, { ...releaseFixtures(layout), FAKE_CURL_MISSING: "1" })
    assert.notEqual(code, 0, output)
    assert.match(output, /未找到 curl\.exe/)
    assert.doesNotMatch(output, /CommandNotFoundException/)
    assertOldIntact(layout.dest)
    assertNoLock(layout.pluginsDir)
  } finally {
    cleanup(layout)
  }
})
