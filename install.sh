#!/usr/bin/env bash
# opencode-hud 全局安装脚本（bash）
# 用法: curl -fsSL https://raw.githubusercontent.com/Just-Silver/opencode-hud/main/install.sh | bash
# 说明: 安装/更新到「最新 Release」版本（与 TUI 内一键更新的取源一致），非 main。
set -euo pipefail
REPO="Just-Silver/opencode-hud"
REPO_URL="https://github.com/$REPO.git"
# releases/latest 是 302 跳转：读最终 URL 尾部即最新 tag（不用 api.github.com，避免限流/403）
LATEST_URL="https://github.com/$REPO/releases/latest"
XDG_BASE="${XDG_CONFIG_HOME:-$HOME/.config}"
PLUGINS_DIR="$XDG_BASE/opencode/plugins"
# opencode2 ≥ 0.0.0-beta-18721 的发现器只认 plugins/ 的直接子项，且目录型插件以 tui.tsx 为 TUI 入口：
# 整个插件必须落在单个目录 plugins/opencode-hud/（入口 tui.tsx + 子模块），不能再是嵌套的 plugins/tui/opencode-hud.tsx
DEST="$PLUGINS_DIR/opencode-hud"
TMP="$(mktemp -d)"
# STAGE 必须与 DEST 同文件系统才原子（同目录必同 FS），放 PLUGINS_DIR 内是最简单取法；固定名+复制前先清理，异常残留也不影响下次
STAGE="$PLUGINS_DIR/.tmp.opencode-hud"
trap 'rm -rf "$TMP" "$STAGE"' EXIT

# 颜色：成功绿 失败红 警告黄（非 TTY 自动禁用）
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  GREEN='\033[32m'; RED='\033[31m'; YELLOW='\033[33m'; RESET='\033[0m'
else
  GREEN=''; RED=''; YELLOW=''; RESET=''
fi

# 解析最新 Release 的 tag：优先 curl 跟随 302 读最终 URL，回退 git ls-remote（按版本号倒序取第一个）
resolve_latest_tag() {
  if command -v curl >/dev/null 2>&1; then
    local url
    url="$(curl -fsSL -o /dev/null -w '%{url_effective}' "$LATEST_URL" 2>/dev/null || true)"
    case "$url" in
      */releases/tag/*) printf '%s' "${url##*/releases/tag/}"; return 0 ;;
    esac
  fi
  if command -v git >/dev/null 2>&1; then
    git ls-remote --tags --refs --sort=-v:refname "$REPO_URL" 2>/dev/null | head -n1 | sed -n 's#.*refs/tags/##p'
  fi
}

TAG="$(resolve_latest_tag)"
if [ -z "$TAG" ]; then
  printf "${RED}无法解析最新 Release（检查网络 / 仓库是否有 Release）${RESET}\n" >&2
  exit 1
fi
ARCHIVE_URL="https://github.com/$REPO/archive/refs/tags/$TAG.tar.gz"

echo "→ 最新 Release: $TAG"
echo "→ 目标目录: $DEST"
mkdir -p "$PLUGINS_DIR"

cloned=0
if command -v git >/dev/null 2>&1; then
  echo "→ git clone --depth 1 --branch $TAG $REPO_URL"
  if git clone --depth 1 --branch "$TAG" "$REPO_URL" "$TMP" 2>/dev/null && [ -f "$TMP/.opencode/plugins/opencode-hud/tui.tsx" ]; then
    cloned=1
  else
    printf "${YELLOW}warn: git clone 失败，尝试 curl 回退${RESET}\n" >&2
    rm -rf "$TMP"
    mkdir -p "$TMP"
  fi
fi

if [ "$cloned" -eq 0 ]; then
  command -v curl >/dev/null 2>&1 || { printf "${RED}需要 git 或 curl${RESET}\n" >&2; exit 1; }
  echo "→ curl $ARCHIVE_URL"
  mkdir -p "$TMP"
  if ! curl -fsSL "$ARCHIVE_URL" | tar -xz -C "$TMP" --strip-components=1; then
    printf "${RED}下载或解压失败${RESET}\n" >&2
    exit 1
  fi
  [ -f "$TMP/.opencode/plugins/opencode-hud/tui.tsx" ] || { printf "${RED}解压后未找到插件入口${RESET}\n" >&2; exit 1; }
fi

SRC_DIR="$TMP/.opencode/plugins/opencode-hud"
[ -f "$SRC_DIR/tui.tsx" ] || { printf "${RED}未找到 $SRC_DIR/tui.tsx${RESET}\n" >&2; exit 1; }

# 原子替换：整目录 cp 到同文件系统的 STAGE，再 mv 覆盖 DEST（单目录 rename 原子，优于旧版 tsx+目录两对象分步替换）
# STAGE 若残留（上次 kill -9/断电），cp -rf 会嵌套复制而非覆盖，故复制前先清空
rm -rf "$STAGE"
cp -rf "$SRC_DIR" "$STAGE"
[ -f "$STAGE/tui.tsx" ] || { printf "${RED}staging 失败: $STAGE/tui.tsx${RESET}\n" >&2; exit 1; }
rm -rf "$DEST"
mv "$STAGE" "$DEST"

[ -f "$DEST/tui.tsx" ] || { printf "${RED}安装失败${RESET}\n" >&2; exit 1; }
# 改名迁移（v4.1.x → opencode-hud）：旧目录不清会让两个插件实例同时注册同样两个 slot，侧栏重复渲染。
for legacy in "$PLUGINS_DIR/opencode-tui-usage" "$PLUGINS_DIR/.tmp.opencode-tui-usage"; do
  if [ -e "$legacy" ]; then rm -rf "$legacy"; printf "${GREEN}✓ 已清理旧版目录 $legacy${RESET}\n"; fi
done
printf "${GREEN}✓ 已安装到 $DEST/tui.tsx${RESET}\n"
printf "${GREEN}  额度模块: $DEST/quota/${RESET}\n"
echo ""
printf "${GREEN}✓ 安装完成${RESET}\n"
