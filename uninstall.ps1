#Requires -Version 7.0
# opencode-hud 卸载脚本（PowerShell 7.6.5）
# 用法: irm https://raw.githubusercontent.com/Just-Silver/opencode-hud/main/uninstall.ps1 | iex
$ErrorActionPreference = "Stop"
function Get-GlobalPluginsDir {
  $base = if ($env:XDG_CONFIG_HOME -and $env:XDG_CONFIG_HOME.Trim()) { $env:XDG_CONFIG_HOME } else { Join-Path $HOME ".config" }
  return Join-Path $base "opencode\plugins"
}
$pluginsDir = Get-GlobalPluginsDir
$dest = Join-Path $pluginsDir "opencode-hud"
Write-Host "→ 目标目录: $dest"
# 同时删改名前的旧目录与旧 staging，否则旧目录的插件仍会加载并重复渲染
foreach ($p in @(
    $dest,
    (Join-Path $pluginsDir ".tmp.opencode-hud"),
    (Join-Path $pluginsDir "opencode-tui-usage"),
    (Join-Path $pluginsDir ".tmp.opencode-tui-usage")
  )) {
  if (Test-Path $p) { Remove-Item -Recurse -Force $p; Write-Host "✓ 已删除 $p" -ForegroundColor Green } else { Write-Host "- 未找到 $p" -ForegroundColor Yellow }
}
# 清理旧版（≤18707 布局：嵌套 plugins/tui/ 下的 tsx + 目录）迁移残留
$legacy = @(
  (Join-Path $pluginsDir "tui\opencode-hud.tsx"),
  (Join-Path $pluginsDir "tui\opencode-hud"),
  (Join-Path $pluginsDir "tui\.tmp.opencode-hud.tsx"),
  (Join-Path $pluginsDir "tui\.tmp.opencode-hud"),
  (Join-Path $pluginsDir "tui\opencode-tui-usage.tsx"),
  (Join-Path $pluginsDir "tui\opencode-tui-usage"),
  (Join-Path $pluginsDir "tui\.tmp.opencode-tui-usage.tsx"),
  (Join-Path $pluginsDir "tui\.tmp.opencode-tui-usage")
)
foreach ($p in $legacy) {
  if (Test-Path $p) { Remove-Item -Recurse -Force $p; Write-Host "✓ 已删除旧版残留 $p" -ForegroundColor Green }
}
Write-Host ""
Write-Host "下一步: opencode2 service restart"
