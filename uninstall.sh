#!/usr/bin/env bash
# opencode-hud 卸载脚本（bash）
# 用法: curl -fsSL https://raw.githubusercontent.com/Just-Silver/opencode-hud/main/uninstall.sh | bash
# 只删除 hud 自己的安装目录与旧布局残留；改名前的旧目录不会被删除（见 README 的手工清理说明）。
set -euo pipefail
# OPENCODE_CONFIG_DIR 的值就是全局配置根本身（不再拼 opencode），与宿主 packages/util/src/global.ts 一致
CONFIG_BASE="${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}"
PLUGINS_DIR="$CONFIG_BASE/plugins"
DEST="$PLUGINS_DIR/opencode-hud"
LOCK_DIR="$PLUGINS_DIR/.opencode-hud.lock"
LOCK_WAIT_MS=30000
LOCK_POLL_MS=200
LOCK_HELD=0
LOCK_TOKEN=""

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  GREEN='\033[32m'; RED='\033[31m'; YELLOW='\033[33m'; RESET='\033[0m'
else
  GREEN=''; RED=''; YELLOW=''; RESET=''
fi

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
trap 'release_lock || true' EXIT

# 与安装/更新同一把锁：拿不到就什么都不删
acquire_lock() {
  local waited=0 err
  mkdir -p "$PLUGINS_DIR"
  while :; do
    if err="$(LC_ALL=C mkdir "$LOCK_DIR" 2>&1)"; then
      LOCK_TOKEN="$$-$(date +%s)-$RANDOM"
      if ! printf 'tool=uninstall\npid=%s\nstartedAt=%s\ntoken=%s\n' "$$" "$(date +%s)" "$LOCK_TOKEN" > "$LOCK_DIR/owner"; then
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
        printf '%s\n' "${RED}无法创建卸载锁: $LOCK_DIR${RESET}" >&2
        printf '%s\n' "$err" >&2
        return 1
        ;;
    esac
    if [ "$waited" -ge "$LOCK_WAIT_MS" ]; then
      printf '%s\n' "${RED}未能获取卸载锁（另一安装/更新/卸载正在进行）: $LOCK_DIR${RESET}" >&2
      printf '%s\n' "${RED}已取消：未删除任何目标；确认没有进程在操作后可手工删除该锁目录后重试${RESET}" >&2
      return 1
    fi
    sleep 0.2
    waited=$((waited + LOCK_POLL_MS))
  done
}

echo "→ 目标目录: $DEST"
acquire_lock || exit 1

# 删除失败（Windows 上通常是被正在运行的 opencode 占用）不能中断其余目标：
# 全部尝试一遍并记录失败项，最后统一报失败，避免用户以为卸载了但旧插件仍在加载。
FAILED=()
remove() {
  local p="$1" label="$2"
  if [ ! -e "$p" ]; then
    printf '%s\n' "${YELLOW}- 未找到 $p${RESET}"
    return 0
  fi
  if rm -rf "$p" 2>/dev/null; then
    printf '%s\n' "${GREEN}✓ 已删除$label $p${RESET}"
  else
    printf '%s\n' "${RED}✗ 未能删除 $p${RESET}" >&2
    FAILED+=("$p")
  fi
}

for p in "$DEST" "$PLUGINS_DIR/.tmp.opencode-hud"; do
  remove "$p" ""
done
# 清理旧版（≤18707 布局：嵌套 plugins/tui/ 下的 tsx + 目录）迁移残留
for p in "$PLUGINS_DIR/tui/opencode-hud.tsx" "$PLUGINS_DIR/tui/opencode-hud" "$PLUGINS_DIR/tui/.tmp.opencode-hud.tsx" "$PLUGINS_DIR/tui/.tmp.opencode-hud"; do
  remove "$p" "旧版残留"
done

release_lock
if [ "${#FAILED[@]}" -gt 0 ]; then
  printf '%s\n' "${RED}部分目录未能删除（可能正被 opencode 占用）：${RESET}" >&2
  for p in "${FAILED[@]}"; do
    printf '%s\n' "${RED}  - $p${RESET}" >&2
  done
  printf '%s\n' "${RED}请关闭 opencode 后重试${RESET}" >&2
  exit 1
fi
echo ""
echo "下一步: opencode2 service restart"
