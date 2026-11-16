#Requires -Version 7.0
# opencode-hud 卸载脚本（PowerShell 7）
# 用法: irm https://raw.githubusercontent.com/Just-Silver/opencode-hud/main/uninstall.ps1 | iex
# 只删除 hud 自己的安装目录与旧布局残留；改名前的旧目录不会被删除（见 README 的手工清理说明）。
# 配置根来自用户：其中的 [ ] * 会被 -Path 当通配符，所有读写一律用 -LiteralPath。
$ErrorActionPreference = "Stop"
$LockWaitMs = 30000
$LockPollMs = 200

function Get-GlobalConfigDir {
  # OPENCODE_CONFIG_DIR 的值就是全局配置根本身（不再拼 opencode），与宿主 packages/util/src/global.ts 一致
  if ($env:OPENCODE_CONFIG_DIR -and $env:OPENCODE_CONFIG_DIR.Trim()) { return $env:OPENCODE_CONFIG_DIR }
  $base = if ($env:XDG_CONFIG_HOME -and $env:XDG_CONFIG_HOME.Trim()) { $env:XDG_CONFIG_HOME } else { Join-Path $HOME ".config" }
  return Join-Path $base "opencode"
}

function Get-GlobalPluginsDir {
  return Join-Path (Get-GlobalConfigDir) "plugins"
}

$pluginsDir = Get-GlobalPluginsDir
$dest = Join-Path $pluginsDir "opencode-hud"
$lockDir = Join-Path $pluginsDir ".opencode-hud.lock"
$script:lockHeld = $false
$script:lockToken = ""

# 与安装/更新同一把目录锁；拿不到就什么都不删
function Enter-DirLock {
  # 锁外先确保父目录存在（幂等）
  New-Item -ItemType Directory -Path $pluginsDir -Force | Out-Null
  $deadline = [DateTime]::UtcNow.AddMilliseconds($LockWaitMs)
  while ($true) {
    try {
      # 不能加 -Force：已存在的目录也会创建成功，互斥随之失效
      New-Item -ItemType Directory -Path $lockDir -ErrorAction Stop | Out-Null
      break
    } catch [System.IO.IOException] {
      if ([DateTime]::UtcNow -ge $deadline) {
        throw "未能获取卸载锁（另一安装/更新/卸载正在进行）：$lockDir；已取消：未删除任何目标；确认没有进程在操作后可手工删除该锁目录后重试"
      }
      Start-Sleep -Milliseconds $LockPollMs
    }
  }
  $startedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $script:lockToken = "$PID-$startedAt-$([Guid]::NewGuid().ToString('N'))"
  try {
    Set-Content -LiteralPath (Join-Path $lockDir "owner") -ErrorAction Stop `
      -Value @("tool=uninstall", "pid=$PID", "startedAt=$startedAt", "token=$script:lockToken")
    $script:lockHeld = $true
  } catch {
    Remove-Item -LiteralPath $lockDir -Recurse -Force -ErrorAction SilentlyContinue
    throw
  }
}

function Exit-DirLock {
  if (-not $script:lockHeld) { return }
  $token = ""
  try {
    foreach ($line in (Get-Content -LiteralPath (Join-Path $lockDir "owner") -ErrorAction Stop)) {
      if ("$line".StartsWith("token=", [StringComparison]::Ordinal)) { $token = "$line".Substring(6).Trim() }
    }
  } catch {
    # owner 读不到就无法证明所有权，保留现场交给人工处理
  }
  if ($token -eq $script:lockToken) {
    Remove-Item -LiteralPath $lockDir -Recurse -Force -ErrorAction SilentlyContinue
  }
  $script:lockHeld = $false
}

Write-Host "→ 目标目录: $dest"
# 删除失败（Windows 上通常是被正在运行的 opencode 占用）不能中断其余目标：
# 全部尝试一遍并记录失败项，最后统一报失败，避免用户以为卸载了但旧插件仍在加载。
$failed = @()
function Remove-Target {
  param([string]$Path, [string]$Label = "", [switch]$Quiet)
  if (-not (Test-Path -LiteralPath $Path)) {
    if (-not $Quiet) { Write-Host "- 未找到 $Path" -ForegroundColor Yellow }
    return $true
  }
  try {
    Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction Stop
    Write-Host "✓ 已删除$Label $Path" -ForegroundColor Green
    return $true
  } catch {
    Write-Host "✗ 未能删除 $Path" -ForegroundColor Red
    return $false
  }
}

try {
  Enter-DirLock
  foreach ($p in @(
      $dest,
      (Join-Path $pluginsDir ".tmp.opencode-hud")
    )) {
    if (-not (Remove-Target -Path $p)) { $failed += $p }
  }
  # 清理旧版（≤18707 布局：嵌套 plugins/tui/ 下的 tsx + 目录）迁移残留
  # 用 Join-Path 逐级拼接：反斜杠在 Linux 上只是普通文件名字符，不是路径分隔符
  $tuiDir = Join-Path $pluginsDir "tui"
  foreach ($p in @(
      (Join-Path $tuiDir "opencode-hud.tsx"),
      (Join-Path $tuiDir "opencode-hud"),
      (Join-Path $tuiDir ".tmp.opencode-hud.tsx"),
      (Join-Path $tuiDir ".tmp.opencode-hud")
    )) {
    if (-not (Remove-Target -Path $p -Label "旧版残留" -Quiet)) { $failed += $p }
  }
} finally {
  Exit-DirLock
}

if ($failed.Count -gt 0) {
  Write-Host "部分目录未能删除（可能正被 opencode 占用）：" -ForegroundColor Red
  foreach ($p in $failed) { Write-Host "  - $p" -ForegroundColor Red }
  throw "请关闭 opencode 后重试"
}
Write-Host ""
Write-Host "下一步: opencode2 service restart"
