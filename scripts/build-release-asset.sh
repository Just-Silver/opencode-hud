#!/usr/bin/env bash
# 构建 Release 资产：<outDir>/opencode-hud-<tag>.tar.gz 与同名 .sha256，stdout 打印两个路径。
# 用法: bash scripts/build-release-asset.sh <tag> <outDir> [srcPluginDir]
set -euo pipefail

if [ "$#" -lt 2 ] || [ "$#" -gt 3 ]; then
  printf '用法: bash %s <tag> <outDir> [srcPluginDir]\n' "$0" >&2
  exit 1
fi

TAG="$1"
OUT_DIR="${2%/}"
SRC="${3:-.opencode/plugins/opencode-hud}"
TAR="${TAR:-tar}"

die() {
  printf '%s\n' "$*" >&2
  exit 1
}

# Windows 的 bash 默认命中的是 system32 的 bsdtar：它没有 --sort/--mtime=@0/--numeric-owner，
# 静默降级会写入本机时间戳与用户名，同一提交每次构建都不一样。

# 与 update/release.ts 的 FORMAL_TAG 一致：无前导零、无预发布/构建元数据
if ! [[ "$TAG" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
  die "tag 必须是正式版 vX.Y.Z：$TAG"
fi

[ -d "$SRC" ] || die "源目录不是目录：$SRC"

# 资产名里的版本就是随包发布的版本：与插件自报 VERSION 不一致会让更新器把错版本当成目标
VERSION_FILE="$SRC/update/version.ts"
[ -f "$VERSION_FILE" ] || die "缺少版本文件：$VERSION_FILE"
VERSION="$(set +o pipefail; sed -n 's/^export const VERSION = "\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)".*$/\1/p' "$VERSION_FILE" | head -n 1)"
VERSION="${VERSION%$'\r'}"
[ -n "$VERSION" ] || die "无法从 $VERSION_FILE 读取 VERSION"
[ "$TAG" = "v$VERSION" ] || die "tag 与 VERSION 不一致：$TAG ≠ v$VERSION"

# 错 tag 应优先得到版本错误；tar 实现不满足可复现参数时在版本确认后再拒绝。
TAR_VERSION="$("$TAR" --version 2>/dev/null || true)"
case "$TAR_VERSION" in
  *"GNU tar"*) ;;
  *) die "需要 GNU tar（当前 TAR=$TAR）；请安装 GNU tar 并用 TAR=<路径> 指定" ;;
esac

command -v gzip >/dev/null 2>&1 || die "需要 gzip"

# tar 会把链接与设备原样写进归档，而更新器/安装器都会拒绝这类条目；在打包前按条目名明确失败。
check_source_tree() {
  local dir="$1" entry base
  for entry in "$dir"/*; do
    base="${entry##*/}"
    if [ -L "$entry" ]; then
      die "源目录含符号链接：$entry"
    fi
    case "$base" in
      .*)
        die "源目录含隐藏条目：$entry"
        ;;
    esac
    if [ -d "$entry" ]; then
      check_source_tree "$entry"
      continue
    fi
    if [ ! -f "$entry" ]; then
      die "源目录含特殊文件：$entry"
    fi
  done
}
shopt -s nullglob dotglob
check_source_tree "$SRC"
shopt -u nullglob dotglob
[ -f "$SRC/tui.tsx" ] || die "源目录缺少插件入口 tui.tsx：$SRC"

TMP="$(mktemp -d)" || die "无法创建临时目录"
cleanup() {
  rm -rf "$TMP" 2>/dev/null || true
}
trap cleanup EXIT

# 归档根名固定为 opencode-hud：调用方可以注入任意路径/目录名的源副本
STAGE="$TMP/stage"
mkdir -p "$STAGE/opencode-hud"
cp -R "$SRC"/. "$STAGE/opencode-hud/" || die "无法复制源目录：$SRC"

# 同一提交必须跨 checkout / umask / CI 机器复现：文件统一 0644、目录统一 0755，
# 否则 mode 位会随源目录权限变化而改变归档字节。
normalize_modes() {
  local dir="$1" entry
  chmod 0755 "$dir"
  shopt -s nullglob
  for entry in "$dir"/*; do
    if [ -d "$entry" ]; then
      normalize_modes "$entry"
    else
      chmod 0644 "$entry"
    fi
  done
  shopt -u nullglob
}
normalize_modes "$STAGE/opencode-hud"

mkdir -p "$OUT_DIR" || die "无法创建输出目录：$OUT_DIR"
[ -d "$OUT_DIR" ] || die "输出路径不是目录：$OUT_DIR"

BUILD_A="$TMP/a.tar.gz"
BUILD_B="$TMP/b.tar.gz"

# --sort=name 固定遍历顺序，--mtime/--owner/--group/--numeric-owner 抹掉时间与归属，
# --format=ustar 禁用 PAX/GNU 扩展（宿主扫描器只接受 USTAR），gzip -n 不写名字与时间戳。
build_once() {
  local out="$1"
  ( cd "$STAGE" && LC_ALL=C "$TAR" \
      --sort=name --mtime='@0' --owner=0 --group=0 --numeric-owner --format=ustar \
      -cf - opencode-hud | gzip -n -9 > "$out" )
}
build_once "$BUILD_A" || die "构建归档失败"
build_once "$BUILD_B" || die "构建归档失败"
cmp -s "$BUILD_A" "$BUILD_B" || die "两次构建字节不一致，归档不可复现"

ENTRIES="$("$TAR" -tzf "$BUILD_A")" || die "无法读取构建产物"
[ -n "$ENTRIES" ] || die "构建产物为空"

# 顶层唯一项必须是目录 opencode-hud/；常规文件恰好叫 opencode-hud 时没有尾斜杠，同样拒绝。
TOP_LEVEL="$(awk '! /^opencode-hud\// || $0 == "opencode-hud/"' <<< "$ENTRIES")"
[ "$TOP_LEVEL" = "opencode-hud/" ] || die "归档顶层必须唯一且为目录 opencode-hud/：$(printf '%s' "$TOP_LEVEL" | tr '\n' ' ')"

grep -qxF 'opencode-hud/tui.tsx' <<< "$ENTRIES" || die "归档中未找到插件入口 tui.tsx"

# 源目录扫描已拒绝隐藏条目，这里再对产物复核一次：打包方式变化（例如改用 --transform）也要拦住
HIDDEN="$(grep -E '(^|/)\.' <<< "$ENTRIES" || true)"
[ -z "$HIDDEN" ] || die "归档含隐藏条目：$(printf '%s' "$HIDDEN" | tr '\n' ' ')"

ASSET="opencode-hud-$TAG.tar.gz"
OUT_ASSET="$OUT_DIR/$ASSET"
OUT_SIDECAR="$OUT_DIR/$ASSET.sha256"

# sidecar 只写裸资产名：安装脚本 cd 到同目录后按名字校验，任何目录前缀都会被 parseChecksum 拒绝。
# 先算 hash 并与 sidecar 一起准备到临时目录：hash 工具缺失/写失败时不能留下「有资产无 sidecar」。
if command -v sha256sum >/dev/null 2>&1; then
  HASH_TOOL=(sha256sum)
elif command -v shasum >/dev/null 2>&1; then
  HASH_TOOL=(shasum -a 256)
else
  die "需要 sha256sum 或 shasum 计算 sidecar"
fi
HASH_OUTPUT="$("${HASH_TOOL[@]}" "$BUILD_A")" || die "无法计算 SHA256：$BUILD_A"
HASH="${HASH_OUTPUT%%[[:space:]]*}"
printf '%s  %s\n' "$HASH" "$ASSET" > "$TMP/sidecar" || die "无法写入 sidecar"

if ! cp "$BUILD_A" "$OUT_ASSET"; then
  rm -f "$OUT_ASSET" 2>/dev/null || true
  die "无法写入资产：$OUT_ASSET"
fi
if ! cmp -s "$BUILD_A" "$OUT_ASSET"; then
  rm -f "$OUT_ASSET" 2>/dev/null || true
  die "写入后的资产与构建结果不一致：$OUT_ASSET"
fi
if ! cp "$TMP/sidecar" "$OUT_SIDECAR"; then
  rm -f "$OUT_SIDECAR" "$OUT_ASSET" 2>/dev/null || true
  die "无法写入 sidecar：$OUT_SIDECAR"
fi

printf '%s\n%s\n' "$OUT_ASSET" "$OUT_SIDECAR"
