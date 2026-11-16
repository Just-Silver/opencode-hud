#Requires -Version 7.0
# opencode-hud 全局安装脚本（PowerShell 7）
# 用法: irm https://raw.githubusercontent.com/Just-Silver/opencode-hud/main/install.ps1 | iex
# 依赖: PowerShell 7+、curl.exe >= 8.4.0、系统 tar（Windows 10/11 自带）。
# curl.exe 低于 8.4.0 会明确报错退出（更早版本的 --max-filesize 对无 Content-Length 的响应无效）。
# 只安装「最新正式 Release」的带校验资产（opencode-hud-vX.Y.Z.tar.gz + .sha256）；
# 旧版 Release 缺资产时明确失败，不回退源码归档、git 或 main。
# 配置根来自用户：其中的 [ ] * 会被 -Path 当通配符，除 New-Item 外所有读写一律用 -LiteralPath。
$ErrorActionPreference = "Stop"
$Repo = "Just-Silver/opencode-hud"
$LatestUrl = "https://github.com/$Repo/releases/latest"
$MaxChecksum = 4096
$MaxArchive = 16777216
$MaxExtracted = 67108864
$MaxEntries = 2000
$ChecksumTimeout = 15
$ArchiveTimeout = 120
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

# 8.4.0 之前的 --max-filesize 对没有 Content-Length 的 chunked 响应无效；低版本必须明确失败
function Assert-CurlVersion {
  # 不限定 -CommandType Application：测试会用函数遮蔽 curl.exe，限定 Application 会让函数不可见
  $command = Get-Command curl.exe -ErrorAction SilentlyContinue
  if (-not $command) { throw "未找到 curl.exe（需要 >= 8.4.0）" }
  $lines = @(& curl.exe --version 2>$null)
  $exitCode = $LASTEXITCODE
  $first = @($lines | Where-Object { "$_".Trim() }) | Select-Object -First 1
  if ($exitCode -ne 0 -or -not $first) { throw "无法读取 curl.exe 版本（需要 >= 8.4.0）" }
  if ("$first" -match 'curl\s+([0-9]+)\.([0-9]+)\.([0-9]+)') {
    $version = [version]::new([int]$Matches[1], [int]$Matches[2], [int]$Matches[3])
  } else {
    throw "无法识别 curl.exe 版本：$first（需要 >= 8.4.0）"
  }
  if ($version -lt [version]::new(8, 4, 0)) {
    throw "curl.exe 版本过低：$first；需要 >= 8.4.0"
  }
}

# 只认 3xx、且 Location 精确指向本仓库正式 tag
function Resolve-LatestTag {
  $lines = @(& curl.exe -sS --max-time $ChecksumTimeout -o NUL -w '%{http_code} %{redirect_url}' $LatestUrl 2>$null)
  if ($LASTEXITCODE -ne 0) { return $null }
  $line = @($lines | Where-Object { "$_".Trim() }) | Select-Object -Last 1
  if (-not $line) { return $null }
  if ("$line".Trim() -notmatch '^(3[0-9][0-9]) (\S+)$') { return $null }
  $location = $Matches[2]
  $prefix = "https://github.com/$Repo/releases/tag/"
  if (-not $location.StartsWith($prefix, [StringComparison]::Ordinal)) { return $null }
  $tag = $location.Substring($prefix.Length)
  if ($tag -notmatch '^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$') { return $null }
  return $tag
}

function Save-Bounded {
  param([string]$Url, [int]$MaxBytes, [int]$TimeoutSeconds, [string]$OutFile)
  & curl.exe -fL --max-filesize $MaxBytes --max-time $TimeoutSeconds -sS -o $OutFile $Url 2>$null
  if ($LASTEXITCODE -ne 0) { throw "下载失败（exit $LASTEXITCODE）：$Url" }
  if (-not (Test-Path -LiteralPath $OutFile -PathType Leaf)) { throw "下载失败：$Url" }
  $size = (Get-Item -LiteralPath $OutFile).Length
  if ($size -gt $MaxBytes) { throw "下载内容超过上限（$MaxBytes 字节）：$Url" }
}

# sidecar 必须单行 <64 hex><空格><空格或 *><资产名>
function Read-Checksum {
  param([string]$File, [string]$ExpectedName)
  $bytes = [IO.File]::ReadAllBytes($File)
  if ($bytes.Length -gt $MaxChecksum) { throw "校验文件超过上限（$MaxChecksum 字节）" }
  $body = [Text.Encoding]::ASCII.GetString($bytes)
  if ($body.EndsWith("`r`n")) { $body = $body.Substring(0, $body.Length - 2) }
  elseif ($body.EndsWith("`n")) { $body = $body.Substring(0, $body.Length - 1) }
  if ($body.Contains("`n") -or $body.Contains("`r")) { throw "校验文件格式错误" }
  $match = [regex]::Match($body, '^([0-9a-fA-F]{64}) (?: |\*)(.+)$')
  if (-not $match.Success -or $match.Groups[2].Value -ne $ExpectedName) { throw "校验文件格式错误或资产名不匹配：$ExpectedName" }
  return $match.Groups[1].Value.ToLowerInvariant()
}

# 边解压边计数：超限立即中止，不先把整个 raw 落盘再检查
function Expand-Bounded {
  param([string]$Archive, [string]$Raw, [int]$MaxBytes)
  $stream = [IO.File]::OpenRead($Archive)
  try {
    $gzip = [IO.Compression.GZipStream]::new($stream, [IO.Compression.CompressionMode]::Decompress)
    try {
      $output = [IO.File]::Create($Raw)
      try {
        $buffer = New-Object byte[] 65536
        $total = 0
        while (($read = $gzip.Read($buffer, 0, $buffer.Length)) -gt 0) {
          $total += $read
          if ($total -gt $MaxBytes) { throw "解压后内容超过上限（$MaxBytes 字节）" }
          $output.Write($buffer, 0, $read)
        }
      } finally { $output.Dispose() }
    } finally { $gzip.Dispose() }
  } finally { $stream.Dispose() }
}

function Read-NameField {
  param([byte[]]$Buffer, [int]$Start, [int]$End)
  $nul = $End + 1
  for ($i = $Start; $i -le $End; $i++) { if ($Buffer[$i] -eq 0) { $nul = $i; break } }
  for ($i = $Start; $i -lt $nul; $i++) {
    $byte = $Buffer[$i]
    if ($byte -lt 0x20 -or $byte -eq 0x7f -or $byte -eq 0x5c -or $byte -eq 0x3a) { throw "归档条目名字含非法字节" }
  }
  for ($i = $nul; $i -le $End; $i++) {
    if ($Buffer[$i] -ne 0 -and $Buffer[$i] -ne 0x20) { throw "归档条目名字段填充非法" }
  }
  return [Text.Encoding]::Latin1.GetString($Buffer, $Start, $nul - $Start)
}

function Read-Size {
  param([byte[]]$Buffer)
  if (($Buffer[124] -band 0x80) -ne 0) { throw "归档条目大小不能使用 base-256 编码" }
  $end = 136
  while ($end -gt 124 -and ($Buffer[$end - 1] -eq 0 -or $Buffer[$end - 1] -eq 0x20)) { $end-- }
  if ($end -eq 124) { throw "归档条目大小字段为空" }
  $size = 0
  for ($i = 124; $i -lt $end; $i++) {
    $byte = $Buffer[$i]
    if ($byte -lt 0x30 -or $byte -gt 0x37) { throw "归档条目大小不是八进制" }
    $size = $size * 8 + ($byte - 0x30)
  }
  return $size
}

function Test-SafeEntry {
  param([string]$Name)
  if ($Name -cne "opencode-hud" -and -not $Name.StartsWith("opencode-hud/", [StringComparison]::Ordinal)) { return $false }
  foreach ($char in $Name.ToCharArray()) {
    $code = [int]$char
    if ($code -lt 0x20 -or $code -eq 0x7f -or $char -eq ':' -or $char -eq '\') { return $false }
  }
  foreach ($segment in $Name.Split('/')) {
    if ($segment.Length -eq 0) { return $false }
    if ($segment -eq "." -or $segment -eq "..") { return $false }
    if ($segment.EndsWith(" ") -or $segment.EndsWith(".")) { return $false }
  }
  return $true
}

# 只折叠 ASCII 大小写：非 ASCII 字节按原样比较
function Get-FoldKey {
  param([string]$Name)
  $chars = $Name.ToCharArray()
  for ($i = 0; $i -lt $chars.Length; $i++) {
    $code = [int]$chars[$i]
    if ($code -ge 0x41 -and $code -le 0x5a) { $chars[$i] = [char]($code + 32) }
  }
  return -join $chars
}

function Read-ExactBlock {
  param([IO.FileStream]$Stream, [byte[]]$Buffer)
  $read = 0
  while ($read -lt $Buffer.Length) {
    $count = $Stream.Read($Buffer, $read, $Buffer.Length - $read)
    if ($count -le 0) { break }
    $read += $count
  }
  return $read
}

# 逐 512 字节 header 扫描，规则与 update/tar.ts、install.sh 的 awk 一致
function Test-TarEntries {
  param([string]$Raw)
  $stream = [IO.File]::OpenRead($Raw)
  try {
    $block = New-Object byte[] 512
    $seen = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $entries = 0
    $totalBytes = 0
    $dataBlocks = 0
    $zeroBlocks = 0
    $ended = $false
    $hasTui = $false
    while ($true) {
      $read = Read-ExactBlock -Stream $stream -Buffer $block
      if ($read -eq 0) { break }
      if ($read -lt 512) { throw "归档被截断（尾部有残缺块）" }
      if ($dataBlocks -gt 0) { $dataBlocks--; continue }
      $zero = $true
      for ($i = 0; $i -lt 512; $i++) { if ($block[$i] -ne 0) { $zero = $false; break } }
      if ($zero) {
        $zeroBlocks++
        if ($zeroBlocks -ge 2) { $ended = $true }
        continue
      }
      if ($ended -or $zeroBlocks -gt 0) { throw "归档结束标记后出现非零数据" }

      $fieldEnd = 156
      while ($fieldEnd -gt 148 -and ($block[$fieldEnd - 1] -eq 0 -or $block[$fieldEnd - 1] -eq 0x20)) { $fieldEnd-- }
      if ($fieldEnd -eq 148 -or ($fieldEnd - 148) -gt 7) { throw "归档 header checksum 字段非法" }
      $expected = 0
      for ($i = 148; $i -lt $fieldEnd; $i++) {
        $byte = $block[$i]
        if ($byte -lt 0x30 -or $byte -gt 0x37) { throw "归档 header checksum 字段非法" }
        $expected = $expected * 8 + ($byte - 0x30)
      }
      $actual = 0
      for ($i = 0; $i -lt 512; $i++) {
        if ($i -ge 148 -and $i -lt 156) { $actual += 0x20 } else { $actual += $block[$i] }
      }
      if ($actual -ne $expected) { throw "归档 header checksum 不匹配" }

      if (-not ($block[257] -eq 0x75 -and $block[258] -eq 0x73 -and $block[259] -eq 0x74 -and
                $block[260] -eq 0x61 -and $block[261] -eq 0x72 -and $block[262] -eq 0x00)) {
        throw "归档不是 ustar 格式"
      }
      if ($block[263] -ne 0x30 -or $block[264] -ne 0x30) { throw "归档 ustar 版本不是 00" }

      $name = Read-NameField -Buffer $block -Start 0 -End 99
      $prefix = Read-NameField -Buffer $block -Start 345 -End 499
      $size = Read-Size -Buffer $block
      $type = $block[156]
      if ($type -ne 0x30 -and $type -ne 0x00 -and $type -ne 0x35) { throw "归档含不允许的条目类型" }
      $fullName = if ($prefix) { "$prefix/$name" } else { $name }
      if ($type -eq 0x35 -and $fullName.EndsWith("/")) { $fullName = $fullName.Substring(0, $fullName.Length - 1) }
      if (-not (Test-SafeEntry -Name $fullName)) { throw "归档条目路径不安全：$fullName" }

      $entries++
      if ($entries -gt $MaxEntries) { throw "归档条目数超过上限（$MaxEntries）" }
      $totalBytes += $size
      if ($totalBytes -gt $MaxExtracted) { throw "归档解压总量超过上限（$MaxExtracted 字节）" }
      if (-not $seen.Add((Get-FoldKey -Name $fullName))) { throw "归档含重复或大小写冲突条目：$fullName" }
      if ($type -ne 0x35 -and $fullName -ceq "opencode-hud/tui.tsx") { $hasTui = $true }
      $dataBlocks = [int][Math]::Ceiling($size / 512.0)
    }
    if ($dataBlocks -gt 0) { throw "归档被截断（数据块不足）" }
    if (-not $ended) { throw "归档缺少结束标记（两个全零块）" }
    if (-not $hasTui) { throw "归档中未找到插件入口 opencode-hud/tui.tsx" }
  } finally {
    $stream.Dispose()
  }
}

# 解压后复核：常规文件、无符号链接/特殊文件，数量与总量不超限
function Test-ExtractedTree {
  param([string]$Root)
  $rootFull = [IO.Path]::GetFullPath($Root)
  $count = 0
  $bytes = 0
  $stack = [System.Collections.Generic.Stack[string]]::new()
  $stack.Push($rootFull)
  while ($stack.Count -gt 0) {
    $dir = $stack.Pop()
    foreach ($entry in [IO.Directory]::GetFileSystemEntries($dir)) {
      $item = Get-Item -LiteralPath $entry -Force
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "解压得到符号链接：$entry" }
      if ($item.PSIsContainer) { $stack.Push($item.FullName); continue }
      $count++
      $bytes += $item.Length
      if ($count -gt $MaxEntries) { throw "解压文件数超过上限（$MaxEntries）" }
      if ($bytes -gt $MaxExtracted) { throw "解压总量超过上限（$MaxExtracted 字节）" }
    }
  }
  $tui = Get-Item -LiteralPath (Join-Path $rootFull "tui.tsx") -Force -ErrorAction SilentlyContinue
  if (-not $tui -or $tui.PSIsContainer -or ($tui.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "归档中未找到插件入口 tui.tsx"
  }
}

$pluginsDir = Get-GlobalPluginsDir
$dest = Join-Path $pluginsDir "opencode-hud"
$lockDir = Join-Path $pluginsDir ".opencode-hud.lock"
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("opencode-hud-" + [Guid]::NewGuid().ToString("N"))
# 事务容器与 dest 同父目录（同文件系统才能 rename），名字随机；顶层只放 stage/backup、没有 tui.tsx
$container = $null
$keepContainer = $false
$script:lockHeld = $false
$script:lockToken = ""
$tokenFile = ".opencode-hud-install-token"

# 与安装/更新/卸载同一把目录锁；拿不到就失败
function Enter-DirLock {
  param([string]$Tool)
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
        throw "未能获取安装锁（另一安装/更新/卸载正在进行）：$lockDir；确认没有进程在操作后可手工删除该锁目录后重试"
      }
      Start-Sleep -Milliseconds $LockPollMs
    }
  }
  $startedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $script:lockToken = "$PID-$startedAt-$([Guid]::NewGuid().ToString('N'))"
  try {
    Set-Content -LiteralPath (Join-Path $lockDir "owner") -ErrorAction Stop `
      -Value @("tool=$Tool", "pid=$PID", "startedAt=$startedAt", "token=$script:lockToken")
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

try {
  Assert-CurlVersion
  $tag = Resolve-LatestTag
  if (-not $tag) { throw "无法确认最新正式 Release（releases/latest 必须返回指向本仓库正式 tag 的 3xx 跳转；不回退 git 或 main）" }
  $asset = "opencode-hud-$tag.tar.gz"

  Write-Host "→ 最新正式 Release: $tag"
  Write-Host "→ 目标目录: $dest"

  New-Item -ItemType Directory -Path $tmp -Force | Out-Null
  $checksumFile = Join-Path $tmp "checksum"
  try {
    Save-Bounded -Url "https://github.com/$Repo/releases/download/$tag/$asset.sha256" -MaxBytes $MaxChecksum -TimeoutSeconds $ChecksumTimeout -OutFile $checksumFile
  } catch {
    throw "获取校验文件失败（旧版 Release 可能缺少资产）：$($_.Exception.Message)"
  }
  $expected = Read-Checksum -File $checksumFile -ExpectedName $asset

  $archive = Join-Path $tmp $asset
  Save-Bounded -Url "https://github.com/$Repo/releases/download/$tag/$asset" -MaxBytes $MaxArchive -TimeoutSeconds $ArchiveTimeout -OutFile $archive
  $actual = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $expected) { throw "校验失败：归档 SHA256 与校验文件不一致" }

  # 解压前置限：GZipStream 边解压边计数
  $raw = Join-Path $tmp "archive.tar"
  try {
    Expand-Bounded -Archive $archive -Raw $raw -MaxBytes $MaxExtracted
  } catch {
    throw "gzip 解压失败（归档损坏或 CRC 不匹配）：$($_.Exception.Message)"
  }
  Test-TarEntries -Raw $raw

  $extract = Join-Path $tmp "extract"
  New-Item -ItemType Directory -Path $extract -Force | Out-Null
  & tar -xf $raw -C $extract --strip-components=1 --no-same-owner 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "解压失败（exit $LASTEXITCODE；现有版本未改动）" }
  Test-ExtractedTree -Root $extract

  # ─── 从这里开始才碰 dest：先取锁，再重新检查目标 ───
  Enter-DirLock -Tool "install"

  $container = Join-Path $pluginsDir (".opencode-hud-install-" + [Guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Path $container | Out-Null
  $stage = Join-Path $container "stage"
  $backup = Join-Path $container "backup"

  Copy-Item -LiteralPath $extract -Destination $stage -Recurse -Force
  if (-not (Test-Path -LiteralPath (Join-Path $stage "tui.tsx"))) { throw "staging 失败：$stage\tui.tsx" }
  Set-Content -LiteralPath (Join-Path $stage $tokenFile) -Value $stage -NoNewline

  # 先整目录挪走旧版再提升：提升失败时旧版仍完整躺在备份里，可以原样恢复
  $hadOld = Test-Path -LiteralPath $dest
  if ($hadOld) {
    try {
      Move-Item -LiteralPath $dest -Destination $backup -ErrorAction Stop
    } catch {
      throw "无法挪走现有安装目录（可能正被 opencode 占用）：$dest；旧版本未被改动，请关闭 opencode 后重试。$($_.Exception.Message)"
    }
  }

  if (Test-Path -LiteralPath $dest) {
    $keepContainer = $true
    $kept = "新副本保留在：$stage"
    if ($hadOld) { $kept = "旧版本保留在：$backup；$kept" }
    throw "目标目录在安装期间被创建，已放弃覆盖：$dest；$kept"
  }

  $promoted = $false
  $promotionError = $null
  try {
    Move-Item -LiteralPath $stage -Destination $dest -ErrorAction Stop
    $promoted = $true
  } catch {
    $promotionError = $_.Exception.Message
  }
  if (-not $promoted) {
    if ($hadOld) {
      $rollbackToken = $backup
      try {
        if (Test-Path -LiteralPath $dest) { throw "目标目录已存在" }
        Set-Content -LiteralPath (Join-Path $backup $tokenFile) -Value $rollbackToken -NoNewline
        Move-Item -LiteralPath $backup -Destination $dest -ErrorAction Stop
      } catch {
        $keepContainer = $true
        Remove-Item -LiteralPath (Join-Path $backup $tokenFile) -Force -ErrorAction SilentlyContinue
        throw "新版本安装失败（$promotionError）；旧版本仍在：$backup；请关闭 opencode 后把该目录改回 $dest"
      }
      $restored = ""
      $restoreTokenPath = Join-Path $dest $tokenFile
      if (Test-Path -LiteralPath $restoreTokenPath) {
        $restored = [string](Get-Content -LiteralPath $restoreTokenPath -Raw -ErrorAction SilentlyContinue)
      }
      if ($restored.Trim() -eq $rollbackToken) {
        Remove-Item -LiteralPath $restoreTokenPath -Force -ErrorAction SilentlyContinue
        throw "新版本安装失败，已恢复旧版本：$dest（$promotionError）"
      }
      # 恢复的 Move-Item 也可能把备份嵌套进期间被创建的目录：此时不能再宣称已恢复
      $keepContainer = $true
      Remove-Item -LiteralPath (Join-Path (Join-Path $dest "backup") $tokenFile) -Force -ErrorAction SilentlyContinue
      throw "新版本安装失败，旧版本恢复未落地（目标可能在恢复期间被并发创建）：$dest；旧版本可能被嵌套到：$dest\backup；容器：$container（$promotionError）"
    }
    throw "新版本安装失败：$dest（$promotionError）"
  }

  # Move-Item 的目标若是期间被创建的目录，会静默嵌套进去并返回 0：只有读回本次身份才算落地
  $installedTokenPath = Join-Path $dest $tokenFile
  $installedToken = ""
  if (Test-Path -LiteralPath $installedTokenPath) {
    $installedToken = [string](Get-Content -LiteralPath $installedTokenPath -Raw -ErrorAction SilentlyContinue)
  }
  if ($installedToken.Trim() -ne $stage) {
    $keepContainer = $true
    $where = "本次副本可能被嵌套到：$dest\stage"
    if ($hadOld) { $where = "旧版本保留在：$backup；$where" }
    throw "安装未落地：$dest 根上没有本次安装的身份标记（很可能在安装期间被其他安装/进程创建）；$where；容器：$container"
  }
  Remove-Item -LiteralPath $installedTokenPath -Force -ErrorAction SilentlyContinue

  if (-not (Test-Path -LiteralPath (Join-Path $dest "tui.tsx"))) {
    $keepContainer = $true
    if ($hadOld) {
      throw "安装失败：$dest\tui.tsx 不存在；旧版本保留在：$backup"
    }
    throw "安装失败：$dest\tui.tsx 不存在"
  }

  # 安装已成功：容器清理失败只是留下无入口的隐藏目录，不影响结果
  try { Remove-Item -LiteralPath $container -Recurse -Force -ErrorAction Stop } catch { }
  $container = $null
  Exit-DirLock

  Write-Host "✓ 已安装到 $dest\tui.tsx" -ForegroundColor Green
  Write-Host "  额度模块: $dest\quota\" -ForegroundColor Green
  Write-Host ""
  Write-Host "✓ 安装完成" -ForegroundColor Green
} finally {
  Exit-DirLock
  if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue }
  if ($container -and -not $keepContainer -and (Test-Path -LiteralPath $container)) {
    Remove-Item -LiteralPath $container -Recurse -Force -ErrorAction SilentlyContinue
  }
}
