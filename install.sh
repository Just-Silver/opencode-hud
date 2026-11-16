#!/usr/bin/env bash
# opencode-hud 全局安装脚本（bash）
# 用法: curl -fsSL https://raw.githubusercontent.com/Just-Silver/opencode-hud/main/install.sh | bash
# 依赖: curl、系统 tar、gzip，以及 sha256sum / shasum / openssl 之一。
# 只安装「最新正式 Release」的带校验资产（opencode-hud-vX.Y.Z.tar.gz + .sha256）；
# 旧版 Release 缺资产时明确失败，不回退源码归档、git 或 main。
set -euo pipefail

REPO="Just-Silver/opencode-hud"
LATEST_URL="https://github.com/$REPO/releases/latest"
MAX_CHECKSUM=4096
MAX_ARCHIVE=16777216
MAX_EXTRACTED=67108864
MAX_ENTRIES=2000
CHECKSUM_TIMEOUT=15
ARCHIVE_TIMEOUT=120
LOCK_WAIT_MS=30000
LOCK_POLL_MS=200

# OPENCODE_CONFIG_DIR 的值就是全局配置根本身（不再拼 opencode），与宿主 packages/util/src/global.ts 一致
CONFIG_BASE="${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}"
PLUGINS_DIR="$CONFIG_BASE/plugins"
# 发现器只认 plugins/ 的直接子项，且目录型插件以 tui.tsx 为 TUI 入口
DEST="$PLUGINS_DIR/opencode-hud"
LOCK_DIR="$PLUGINS_DIR/.opencode-hud.lock"
TMP="$(mktemp -d)"
# 事务容器与 DEST 同父目录（同文件系统才能 rename），名字随机；顶层只放 stage/backup、没有 tui.tsx
CONTAINER=""
KEEP_CONTAINER=0
LOCK_HELD=0
LOCK_TOKEN=""
TOKEN_FILE=".opencode-hud-install-token"

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  GREEN='\033[32m'; RED='\033[31m'; YELLOW='\033[33m'; RESET='\033[0m'
else
  GREEN=''; RED=''; YELLOW=''; RESET=''
fi

die() {
  printf '%s\n' "${RED}$*${RESET}" >&2
  exit 1
}

release_lock() {
  [ "$LOCK_HELD" -eq 1 ] || return 0
  local token=""
  if [ -f "$LOCK_DIR/owner" ]; then
    token="$(sed -n 's/^token=//p' "$LOCK_DIR/owner" 2>/dev/null | head -n1 || true)"
  fi
  if [ "$token" = "$LOCK_TOKEN" ]; then
    if ! rm -rf "$LOCK_DIR" 2>/dev/null; then
      printf '%s\n' "${YELLOW}警告：锁目录未能清理，后续安装可能等待超时；确认无进程后可手工删除 $LOCK_DIR${RESET}" >&2
    fi
  fi
  LOCK_HELD=0
}

cleanup() {
  release_lock || true
  rm -rf "$TMP" 2>/dev/null || true
  if [ -n "$CONTAINER" ] && [ "$KEEP_CONTAINER" -eq 0 ]; then
    rm -rf "$CONTAINER" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# 目录锁：mkdir 的原子性就是互斥判据，不按年龄破锁；崩溃后需人工确认并删除锁目录
acquire_lock() {
  local waited=0 err
  # 锁外先确保父目录存在（幂等），失败直接返回
  mkdir -p "$PLUGINS_DIR"
  while :; do
    if err="$(LC_ALL=C mkdir "$LOCK_DIR" 2>&1)"; then
      LOCK_TOKEN="$$-$(date +%s)-$RANDOM"
      if ! printf 'tool=install\npid=%s\nstartedAt=%s\ntoken=%s\n' "$$" "$(date +%s)" "$LOCK_TOKEN" > "$LOCK_DIR/owner"; then
        rm -rf "$LOCK_DIR" 2>/dev/null || true
        printf '%s\n' "${RED}无法写入锁信息: $LOCK_DIR${RESET}" >&2
        return 1
      fi
      LOCK_HELD=1
      return 0
    fi
    # 只有「目录已存在」才是并发占用；权限/只读父目录等要立即失败并给出真实原因
    case "$err" in
      *"File exists"*) ;;
      *)
        printf '%s\n' "${RED}无法创建安装锁: $LOCK_DIR${RESET}" >&2
        printf '%s\n' "$err" >&2
        return 1
        ;;
    esac
    if [ "$waited" -ge "$LOCK_WAIT_MS" ]; then
      printf '%s\n' "${RED}未能获取安装锁（另一安装/更新/卸载正在进行）: $LOCK_DIR${RESET}" >&2
      printf '%s\n' "${RED}确认没有进程在操作后可手工删除该锁目录后重试${RESET}" >&2
      return 1
    fi
    sleep 0.2
    waited=$((waited + LOCK_POLL_MS))
  done
}

# 只认 3xx、且 Location 精确指向本仓库正式 tag；不跟随跳转、不用 git、不回退 main
resolve_latest_tag() {
  local out code location tag
  out="$(curl -sS --max-time "$CHECKSUM_TIMEOUT" -o /dev/null -w '%{http_code} %{redirect_url}' "$LATEST_URL" 2>/dev/null)" || return 1
  code="${out%% *}"
  location="${out#* }"
  case "$code" in
    3[0-9][0-9]) ;;
    *) return 1 ;;
  esac
  case "$location" in
    "https://github.com/$REPO/releases/tag/"*) tag="${location#"https://github.com/$REPO/releases/tag/"}" ;;
    *) return 1 ;;
  esac
  [[ "$tag" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || return 1
  printf '%s' "$tag"
}

# 有界下载：curl | head -c MAX+1；先判超限，再判 curl 失败（超限时 curl 常被 SIGPIPE 打断）
fetch_bounded() {
  local url="$1" max="$2" timeout="$3" out="$4" st size
  set +e
  curl -fL --max-time "$timeout" -sS "$url" 2>/dev/null | head -c $((max + 1)) > "$out"
  st=("${PIPESTATUS[@]}")
  set -e
  [ -f "$out" ] || return 1
  size="$(wc -c < "$out" | tr -d '[:space:]')"
  if [ "$size" -gt "$max" ]; then
    printf '下载内容超过上限（%s 字节）: %s\n' "$max" "$url" >&2
    return 1
  fi
  [ "${st[0]}" -eq 0 ] || return 1
  return 0
}

sha256_of() {
  local file="$1" out=""
  if command -v sha256sum >/dev/null 2>&1; then
    out="$(sha256sum "$file" 2>/dev/null | awk '{print $1}')" || out=""
  elif command -v shasum >/dev/null 2>&1; then
    out="$(shasum -a 256 "$file" 2>/dev/null | awk '{print $1}')" || out=""
  elif command -v openssl >/dev/null 2>&1; then
    out="$(openssl dgst -sha256 -r "$file" 2>/dev/null | awk '{print $1}')" || out=""
    [ -n "$out" ] || out="$(openssl dgst -sha256 "$file" 2>/dev/null | awk '{print $NF}')" || out=""
  fi
  [ -n "$out" ] || return 1
  printf '%s' "$out" | tr 'A-F' 'a-f'
}

# sidecar 必须单行 <64 hex><空格><空格或 *><资产名>
parse_checksum() {
  local file="$1" name="$2" body hash rest fname
  body="$(cat "$file")"
  body="${body%$'\r'}"
  case "$body" in
    *$'\n'*|*$'\r'*) return 1 ;;
  esac
  [[ "$body" =~ ^[0-9a-fA-F]{64}[[:space:]] ]] || return 1
  hash="${body%%[[:space:]]*}"
  rest="${body#"$hash"}"
  case "$rest" in
    "  "*) fname="${rest#  }" ;;
    " *"*) fname="${rest# \*}" ;;
    *) return 1 ;;
  esac
  [ "$fname" = "$name" ] || return 1
  printf '%s' "$hash" | tr 'A-F' 'a-f'
}

# 解压后复核：常规文件、无符号链接/特殊文件，数量与总量不超限
# 不用 find：Windows 的 Git Bash 里 `find` 会先命中 system32\find.exe（参数语法不同）
TREE_COUNT=0
TREE_BYTES=0
verify_tree_dir() {
  local dir="$1" entry size
  for entry in "$dir"/*; do
    if [ -L "$entry" ]; then
      printf '解压得到符号链接：%s\n' "$entry" >&2
      return 1
    fi
    if [ -d "$entry" ]; then
      verify_tree_dir "$entry" || return 1
      continue
    fi
    if [ ! -f "$entry" ]; then
      printf '解压得到特殊文件：%s\n' "$entry" >&2
      return 1
    fi
    size="$(wc -c < "$entry" | tr -d '[:space:]')"
    TREE_COUNT=$((TREE_COUNT + 1))
    TREE_BYTES=$((TREE_BYTES + size))
    if [ "$TREE_COUNT" -gt "$MAX_ENTRIES" ]; then
      printf '解压文件数超过上限（%s）\n' "$MAX_ENTRIES" >&2
      return 1
    fi
    if [ "$TREE_BYTES" -gt "$MAX_EXTRACTED" ]; then
      printf '解压总量超过上限（%s 字节）\n' "$MAX_EXTRACTED" >&2
      return 1
    fi
  done
  return 0
}

verify_extracted_tree() {
  local root="$1"
  TREE_COUNT=0
  TREE_BYTES=0
  shopt -s nullglob dotglob
  if ! verify_tree_dir "$root"; then
    shopt -u nullglob dotglob
    return 1
  fi
  shopt -u nullglob dotglob
  if [ -L "$root/tui.tsx" ] || [ ! -f "$root/tui.tsx" ]; then
    printf '归档中未找到插件入口 tui.tsx\n' >&2
    return 1
  fi
  return 0
}

# 逐 512 字节 header 状态机：一次 od + 一次 awk，规则与 update/tar.ts 一致
TAR_VERIFY_AWK="$(cat <<'AWK'
BEGIN {
  BLOCK = 512
  pos = 0
  dataBlocks = 0
  zeroBlocks = 0
  ended = 0
  entries = 0
  totalBytes = 0
  hasTui = 0
  failed = 0
  ROOT = "opencode-hud"
  TUI = "opencode-hud/tui.tsx"
  for (i = 32; i < 127; i++) CODE[sprintf("%c", i)] = i
}

function fail(msg) {
  if (!failed) printf "归档校验失败：%s\n", msg > "/dev/stderr"
  failed = 1
  exit 1
}

function hexval(s,   i, v, c) {
  v = 0
  s = tolower(s)
  for (i = 1; i <= length(s); i++) {
    c = index("0123456789abcdef", substr(s, i, 1)) - 1
    if (c < 0) return -1
    v = v * 16 + c
  }
  return v
}

function read_field(start, end, out,   i, nul, by) {
  nul = end + 1
  for (i = start; i <= end; i++) if (b[i] == 0) { nul = i; break }
  for (i = start; i < nul; i++) {
    by = b[i]
    if (by < 32 || by == 127 || by == 92 || by == 58) fail("归档条目名字含非法字节")
  }
  for (i = nul; i <= end; i++) {
    if (b[i] != 0 && b[i] != 32) fail("归档条目名字段填充非法")
  }
  out["len"] = nul - start
  for (i = start; i < nul; i++) out[i - start + 1] = b[i]
}

function path_is_rooted(   i) {
  rl = length(ROOT)
  if (pathLen < rl) return 0
  for (i = 1; i <= rl; i++) if (path[i] != CODE[substr(ROOT, i, 1)]) return 0
  if (pathLen == rl) return 1
  return path[rl + 1] == 47
}

function path_equals(lit,   i, n) {
  n = length(lit)
  if (pathLen != n) return 0
  for (i = 1; i <= n; i++) if (path[i] != CODE[substr(lit, i, 1)]) return 0
  return 1
}

function check_path(   i, segStart, segLen) {
  for (i = 1; i <= pathLen; i++) {
    if (path[i] < 32 || path[i] == 127 || path[i] == 92 || path[i] == 58) fail("归档条目名字含非法字节")
  }
  if (!path_is_rooted()) fail("归档条目路径不安全")
  segStart = 1
  for (i = 1; i <= pathLen + 1; i++) {
    if (i == pathLen + 1 || path[i] == 47) {
      segLen = i - segStart
      if (segLen == 0) fail("归档条目路径不安全")
      if (segLen == 1 && path[segStart] == 46) fail("归档条目路径不安全")
      if (segLen == 2 && path[segStart] == 46 && path[segStart + 1] == 46) fail("归档条目路径不安全")
      if (path[i - 1] == 32 || path[i - 1] == 46) fail("归档条目路径不安全")
      segStart = i + 1
    }
  }
}

function display_path(   i, s) {
  s = ""
  for (i = 1; i <= pathLen; i++) s = s sprintf("%c", path[i])
  return s
}

function path_key(   i, by, s) {
  s = ""
  for (i = 1; i <= pathLen; i++) {
    by = path[i]
    if (by >= 65 && by <= 90) by += 32
    s = s (i == 1 ? "" : ",") by
  }
  return s
}

function read_size(   i, end, v, by) {
  if (b[125] >= 128) fail("归档条目大小不能使用 base-256 编码")
  end = 136
  while (end > 124 && (b[end] == 0 || b[end] == 32)) end--
  if (end == 124) fail("归档条目大小字段为空")
  v = 0
  for (i = 125; i <= end; i++) {
    by = b[i]
    if (by < 48 || by > 55) fail("归档条目大小不是八进制")
    v = v * 8 + (by - 48)
  }
  return v
}

function parse_header(   i, end, expected, actual, type, size, key) {
  end = 156
  while (end > 148 && (b[end] == 0 || b[end] == 32)) end--
  if (end == 148 || end - 148 > 7) fail("归档 header checksum 字段非法")
  expected = 0
  for (i = 149; i <= end; i++) {
    if (b[i] < 48 || b[i] > 55) fail("归档 header checksum 字段非法")
    expected = expected * 8 + (b[i] - 48)
  }
  actual = 0
  for (i = 1; i <= BLOCK; i++) actual += (i >= 149 && i <= 156) ? 32 : b[i]
  if (actual != expected) fail("归档 header checksum 不匹配")

  if (!(b[258] == 117 && b[259] == 115 && b[260] == 116 && b[261] == 97 && b[262] == 114 && b[263] == 0)) fail("归档不是 ustar 格式")
  if (b[264] != 48 || b[265] != 48) fail("归档 ustar 版本不是 00")

  read_field(1, 100, nameB)
  read_field(346, 500, prefixB)
  size = read_size()
  type = b[157]
  if (type != 48 && type != 0 && type != 53) fail("归档含不允许的条目类型")

  pathLen = 0
  for (i = 1; i <= prefixB["len"]; i++) path[++pathLen] = prefixB[i]
  if (pathLen > 0) path[++pathLen] = 47
  for (i = 1; i <= nameB["len"]; i++) path[++pathLen] = nameB[i]
  if (type == 53 && pathLen > 0 && path[pathLen] == 47) pathLen--
  check_path()

  entries++
  if (entries > maxEntries) fail("归档条目数超过上限（" maxEntries "）")
  totalBytes += size
  if (totalBytes > maxBytes) fail("归档解压总量超过上限（" maxBytes " 字节）")
  key = path_key()
  if (key in seen) fail("归档含重复或大小写冲突条目：" display_path())
  seen[key] = 1
  if (type != 53 && path_equals(TUI)) hasTui = 1
  dataBlocks = int((size + BLOCK - 1) / BLOCK)
}

function handle_block(   i, zero) {
  if (dataBlocks > 0) { dataBlocks--; return }
  zero = 1
  for (i = 1; i <= BLOCK; i++) if (b[i] != 0) { zero = 0; break }
  if (zero) { zeroBlocks++; if (zeroBlocks >= 2) ended = 1; return }
  if (ended || zeroBlocks > 0) fail("归档结束标记后出现非零数据")
  parse_header()
}

{
  for (i = 1; i <= NF; i++) {
    by = hexval($i)
    if (by < 0) fail("od 输出非法")
    b[++pos] = by
    if (pos == BLOCK) { handle_block(); pos = 0 }
  }
}

END {
  if (failed) exit 1
  if (pos != 0) fail("归档被截断（尾部有残缺块）")
  if (dataBlocks > 0) fail("归档被截断（数据块不足）")
  if (!ended) fail("归档缺少结束标记（两个全零块）")
  if (!hasTui) fail("归档中未找到插件入口 opencode-hud/tui.tsx")
}
AWK
)"

command -v curl >/dev/null 2>&1 || die "需要 curl"
command -v tar >/dev/null 2>&1 || die "需要系统 tar（Windows 10/11 自带）"
command -v gzip >/dev/null 2>&1 || die "需要 gzip"

TAG="$(resolve_latest_tag)" || die "无法确认最新正式 Release（releases/latest 必须返回指向本仓库正式 tag 的 3xx 跳转；不回退 git 或 main）"
ASSET="opencode-hud-$TAG.tar.gz"

echo "→ 最新正式 Release: $TAG"
echo "→ 目标目录: $DEST"

CHECKSUM_FILE="$TMP/checksum"
fetch_bounded "https://github.com/$REPO/releases/download/$TAG/$ASSET.sha256" "$MAX_CHECKSUM" "$CHECKSUM_TIMEOUT" "$CHECKSUM_FILE" \
  || die "获取校验文件失败（旧版 Release 可能缺少资产）: $TAG"
EXPECTED="$(parse_checksum "$CHECKSUM_FILE" "$ASSET")" || die "校验文件格式错误或资产名不匹配: $TAG"

ARCHIVE="$TMP/$ASSET"
fetch_bounded "https://github.com/$REPO/releases/download/$TAG/$ASSET" "$MAX_ARCHIVE" "$ARCHIVE_TIMEOUT" "$ARCHIVE" \
  || die "下载归档失败: $TAG"
ACTUAL="$(sha256_of "$ARCHIVE")" || die "未找到可用的 SHA256 工具（sha256sum / shasum / openssl）"
[ "$ACTUAL" = "$EXPECTED" ] || die "校验失败：归档 SHA256 与校验文件不一致"

# 解压前置限：gzip 输出超过上限立即失败；未超限时 gzip 非零即损坏/CRC 错误，不能忽略
RAW="$TMP/archive.tar"
set +e
gzip -dc "$ARCHIVE" 2>/dev/null | head -c $((MAX_EXTRACTED + 1)) > "$RAW"
GZIP_ST=("${PIPESTATUS[@]}")
set -e
RAW_SIZE="$(wc -c < "$RAW" | tr -d '[:space:]')"
if [ "$RAW_SIZE" -gt "$MAX_EXTRACTED" ]; then
  die "解压后内容超过上限（$MAX_EXTRACTED 字节）"
fi
[ "${GZIP_ST[0]}" -eq 0 ] || die "gzip 解压失败（归档损坏或 CRC 不匹配）"

if ! od -A n -v -t x1 "$RAW" | awk -v maxBytes="$MAX_EXTRACTED" -v maxEntries="$MAX_ENTRIES" "$TAR_VERIFY_AWK"; then
  die "归档校验失败：拒绝安装（现有版本未改动）"
fi

EXTRACT="$TMP/extract"
mkdir -p "$EXTRACT"
if ! tar -xf "$RAW" -C "$EXTRACT" --strip-components=1 --no-same-owner; then
  die "解压失败（现有版本未改动）"
fi
verify_extracted_tree "$EXTRACT" || die "解压结果校验失败（现有版本未改动）"

# ─── 从这里开始才碰 DEST：先取锁，再重新检查目标 ───
acquire_lock || exit 1

CONTAINER="$(mktemp -d "$PLUGINS_DIR/.opencode-hud-install-XXXXXX")"
STAGE="$CONTAINER/stage"
BACKUP="$CONTAINER/backup"

# 新版本先完整落到 stage 并校验入口
cp -rf "$EXTRACT" "$STAGE"
if [ ! -f "$STAGE/tui.tsx" ]; then
  die "staging 失败: $STAGE/tui.tsx"
fi
printf '%s' "$STAGE" > "$STAGE/$TOKEN_FILE"

# 先整目录挪走旧版再提升：提升失败时旧版仍完整躺在备份里，可以原样恢复
HAD_OLD=0
if [ -e "$DEST" ]; then
  if ! mv "$DEST" "$BACKUP"; then
    printf '%s\n' "${RED}无法挪走现有安装目录（可能正被 opencode 占用）: $DEST${RESET}" >&2
    printf '%s\n' "${RED}旧版本未被改动，请关闭 opencode 后重试${RESET}" >&2
    exit 1
  fi
  HAD_OLD=1
fi

# 挪走旧版与提升之间若有另一次安装落地，不覆盖它；两份副本都保留给用户判断
if [ -e "$DEST" ]; then
  KEEP_CONTAINER=1
  printf '%s\n' "${RED}目标目录在安装期间被创建，已放弃覆盖: $DEST${RESET}" >&2
  if [ "$HAD_OLD" -eq 1 ]; then
    printf '%s\n' "${RED}旧版本保留在: $BACKUP${RESET}" >&2
  fi
  printf '%s\n' "${RED}新副本保留在: $STAGE${RESET}" >&2
  exit 1
fi

if ! mv "$STAGE" "$DEST"; then
  if [ "$HAD_OLD" -eq 1 ]; then
    printf '%s' "$BACKUP" > "$BACKUP/$TOKEN_FILE" 2>/dev/null || true
    if [ ! -e "$DEST" ] && mv "$BACKUP" "$DEST"; then
      RESTORED=""
      if [ -f "$DEST/$TOKEN_FILE" ]; then RESTORED="$(cat "$DEST/$TOKEN_FILE" 2>/dev/null || true)"; fi
      if [ "$RESTORED" = "$BACKUP" ]; then
        rm -f "$DEST/$TOKEN_FILE" 2>/dev/null || true
        printf '%s\n' "${RED}新版本安装失败，已恢复旧版本: $DEST${RESET}" >&2
      else
        # 标记写/读失败时无法证明旧版落回目标；嵌套同样走到这里，一律按「未验证」报告而不是断言失败原因
        KEEP_CONTAINER=1
        rm -f "$DEST/$(basename "$BACKUP")/$TOKEN_FILE" 2>/dev/null || true
        printf '%s\n' "${RED}新版本安装失败；未能验证旧版恢复，请检查正式目标、备份和可能嵌套路径${RESET}" >&2
        printf '%s\n' "${RED}正式目标: $DEST${RESET}" >&2
        printf '%s\n' "${RED}备份可能在: $BACKUP 或嵌套在 $DEST/$(basename "$BACKUP")${RESET}" >&2
        printf '%s\n' "${RED}容器: $CONTAINER${RESET}" >&2
      fi
    else
      KEEP_CONTAINER=1
      rm -f "$BACKUP/$TOKEN_FILE" 2>/dev/null || true
      printf '%s\n' "${RED}新版本安装失败，旧版本恢复也失败${RESET}" >&2
      printf '%s\n' "${RED}旧版本仍在: $BACKUP${RESET}" >&2
      printf '%s\n' "${RED}请关闭 opencode 后把该目录改回: $DEST${RESET}" >&2
    fi
  else
    printf '%s\n' "${RED}新版本安装失败: $DEST${RESET}" >&2
  fi
  exit 1
fi

# mv 的目标若是期间被创建的目录，会静默嵌套进去并返回 0：只有读回本次身份才算落地
LANDED=""
if [ -f "$DEST/$TOKEN_FILE" ]; then LANDED="$(cat "$DEST/$TOKEN_FILE" 2>/dev/null || true)"; fi
if [ "$LANDED" != "$STAGE" ]; then
  KEEP_CONTAINER=1
  printf '%s\n' "${RED}安装未落地: $DEST 根上没有本次安装的身份标记（很可能在安装期间被其他安装/进程创建）${RESET}" >&2
  printf '%s\n' "${RED}本次副本可能被嵌套到: $DEST/$(basename "$STAGE")${RESET}" >&2
  printf '%s\n' "${RED}容器: $CONTAINER${RESET}" >&2
  if [ "$HAD_OLD" -eq 1 ]; then
    printf '%s\n' "${RED}旧版本保留在: $BACKUP${RESET}" >&2
  fi
  exit 1
fi
rm -f "$DEST/$TOKEN_FILE" 2>/dev/null || true

if [ ! -f "$DEST/tui.tsx" ]; then
  KEEP_CONTAINER=1
  printf '%s\n' "${RED}安装失败: $DEST/tui.tsx 不存在${RESET}" >&2
  if [ "$HAD_OLD" -eq 1 ]; then
    printf '%s\n' "${RED}旧版本保留在: $BACKUP${RESET}" >&2
  fi
  exit 1
fi

# 安装已成功：容器清理失败只是留下无入口的隐藏目录，不影响结果
rm -rf "$CONTAINER" 2>/dev/null || true
CONTAINER=""
release_lock

printf '%s\n' "${GREEN}✓ 已安装到 $DEST/tui.tsx${RESET}"
printf '%s\n' "${GREEN}  额度模块: $DEST/quota/${RESET}"
echo ""
printf '%s\n' "${GREEN}✓ 安装完成${RESET}"
