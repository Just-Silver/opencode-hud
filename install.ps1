#Requires -Version 7.0
# opencode-hud 全局安装脚本（PowerShell 7.6.5）
# 用法: irm https://raw.githubusercontent.com/Just-Silver/opencode-hud/main/install.ps1 | iex
# 说明: 安装/更新到「最新 Release」版本（与 TUI 内一键更新的取源一致），非 main。
$ErrorActionPreference = "Stop"
$Repo = "Just-Silver/opencode-hud"
$RepoUrl = "https://github.com/$Repo.git"
# releases/latest 是 302 跳转：读最终 URL 尾部即最新 tag（不用 api.github.com，避免限流/403）
$LatestUrl = "https://github.com/$Repo/releases/latest"

function Get-GlobalPluginsDir {
  $base = if ($env:XDG_CONFIG_HOME -and $env:XDG_CONFIG_HOME.Trim()) { $env:XDG_CONFIG_HOME } else { Join-Path $HOME ".config" }
  return Join-Path $base "opencode\plugins"
}

function Test-Command($name) { $null -ne (Get-Command $name -ErrorAction SilentlyContinue) }

# 解析最新 Release 的 tag：优先 curl.exe 跟随 302 读最终 URL，回退 git ls-remote（按版本号倒序取第一个）
function Resolve-LatestTag {
  if (Test-Command curl.exe) {
    $final = curl.exe -fsSL -o NUL -w '%{url_effective}' $LatestUrl 2>$null
    if ("$final" -match '/releases/tag/([^/?#]+)') { return $Matches[1] }
  }
  if (Test-Command git) {
    $line = git ls-remote --tags --refs --sort=-v:refname $RepoUrl 2>$null | Select-Object -First 1
    if ("$line" -match 'refs/tags/(\S+)') { return $Matches[1] }
  }
  return $null
}

# opencode2 ≥ 0.0.0-beta-18721 的发现器只认 plugins/ 的直接子项，且目录型插件以 tui.tsx 为 TUI 入口：
# 整个插件必须落在单个目录 plugins/opencode-hud/（入口 tui.tsx + 子模块），不能再是嵌套的 plugins/tui/opencode-hud.tsx
$pluginsDir = Get-GlobalPluginsDir
$dest = Join-Path $pluginsDir "opencode-hud"
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("opencode-hud-" + [Guid]::NewGuid().ToString("N"))
# STAGE 必须与 dest 同文件系统才原子（同目录必同 FS），放 pluginsDir 内是最简单取法；固定名+复制前先清理，异常残留也不影响下次
$stage = Join-Path $pluginsDir ".tmp.opencode-hud"

try {
  $tag = Resolve-LatestTag
  if (-not $tag) { throw "无法解析最新 Release（检查网络 / 仓库是否有 Release）" }
  $archiveUrl = "https://github.com/$Repo/archive/refs/tags/$tag.tar.gz"

  Write-Host "→ 最新 Release: $tag"
  Write-Host "→ 目标目录: $dest"
  New-Item -ItemType Directory -Force -Path $pluginsDir | Out-Null

  $cloned = $false
  if (Test-Command git) {
    Write-Host "→ git clone --depth 1 --branch $tag $RepoUrl"
    git clone --depth 1 --branch $tag $RepoUrl $tmp 2>&1 | Out-Null
    # 只判断 clone 本身；归档内容（目录名 / 入口）在下面统一解析，否则会把「旧版 Release 目录名不同」误报成 clone 失败
    if ($LASTEXITCODE -eq 0) {
      $cloned = $true
    } else {
      Write-Warning "git clone 失败，尝试 curl 回退"
      if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
      New-Item -ItemType Directory -Force -Path $tmp | Out-Null
    }
  }

  if (-not $cloned) {
    if (-not (Test-Command curl.exe)) { throw "需要 git 或 curl 之一" }
    if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
    New-Item -ItemType Directory -Force -Path $tmp | Out-Null
    $tar = Join-Path $tmp "archive.tar.gz"
    Write-Host "→ curl.exe $archiveUrl"
    curl.exe -fsSL "$archiveUrl" -o $tar 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "curl 下载失败 (exit $LASTEXITCODE)" }
    tar -xzf $tar -C $tmp --strip-components=1 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "tar 解压失败 (exit $LASTEXITCODE)" }
  }

  # 归档内的插件目录不硬编码名字：改名前的 Release（≤ v4.1.0）目录还叫 opencode-tui-usage。
  # 硬编码新名会把「Release 早于更名」误报成 clone 失败 / 未找到入口。
  $pluginsRoot = Join-Path $tmp ".opencode\plugins"
  $srcDir = $null
  if (Test-Path $pluginsRoot) {
    $srcDir = Get-ChildItem $pluginsRoot -Directory |
      Where-Object { Test-Path (Join-Path $_.FullName "tui.tsx") } |
      Select-Object -First 1 -ExpandProperty FullName
  }
  if (-not $srcDir) { throw "归档内未找到插件入口（.opencode/plugins/*/tui.tsx），请检查 Release 内容" }
  $srcName = Split-Path $srcDir -Leaf
  if ($srcName -ne "opencode-hud") {
    throw "最新 Release $tag 仍是改名前的目录（$srcName）；请等 v4.2.0 起的 Release，或从 main 手动安装"
  }

  # 原子替换：整目录 Copy 到同文件系统的 STAGE，再 Move 覆盖 dest（单目录 rename 原子，优于旧版 tsx+目录两对象分步替换）
  # STAGE 若残留（上次 kill -9/断电），Copy-Item -Recurse 会嵌套复制而非覆盖，故复制前先清理
  if (Test-Path $stage) { Remove-Item -Recurse -Force $stage -ErrorAction SilentlyContinue }
  Copy-Item -Recurse -Force $srcDir $stage
  if (-not (Test-Path (Join-Path $stage "tui.tsx"))) { throw "staging 失败：$stage\tui.tsx" }
  if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
  Move-Item $stage $dest

  if (-not (Test-Path (Join-Path $dest "tui.tsx"))) { throw "安装失败：$dest\tui.tsx 不存在" }
  # 改名迁移（v4.1.x → opencode-hud）：旧目录不清会让两个插件实例同时注册同样两个 slot，侧栏重复渲染。
  foreach ($legacy in @((Join-Path $pluginsDir "opencode-tui-usage"), (Join-Path $pluginsDir ".tmp.opencode-tui-usage"))) {
    if (Test-Path $legacy) { Remove-Item -Recurse -Force $legacy -ErrorAction SilentlyContinue; Write-Host "✓ 已清理旧版目录 $legacy" -ForegroundColor Green }
  }
  Write-Host "✓ 已安装到 $dest\tui.tsx" -ForegroundColor Green
  Write-Host "  额度模块: $dest\quota\" -ForegroundColor Green
  Write-Host ""
  Write-Host "✓ 安装完成" -ForegroundColor Green
} finally {
  if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
  if (Test-Path $stage) { Remove-Item -Recurse -Force $stage -ErrorAction SilentlyContinue }
}
