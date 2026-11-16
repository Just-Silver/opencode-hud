// ─── 共享：路径解析（插件自己的本地应用数据目录） ───
// 各 OS 的「本地应用数据」目录（对齐 LocalApplicationData）：
//   Windows：%LOCALAPPDATA%（C:\Users\<user>\AppData\Local）
//   macOS  ：~/Library/Application Support
//   Linux  ：$XDG_DATA_HOME 或 ~/.local/share
// 插件所有持久文件（更新检查缓存等）都放这里，不与 opencode 自身的数据目录混放。
import { homedir } from "os"
import { join } from "path"

export function localAppDataDir(): string {
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA?.trim()
    return base ? base : join(homedir(), "AppData", "Local")
  }
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support")
  const xdg = process.env.XDG_DATA_HOME?.trim()
  return xdg ? xdg : join(homedir(), ".local", "share")
}

// 本插件专属数据目录：<localAppData>/opencode-hud
export function pluginDataDir(): string {
  return join(localAppDataDir(), "opencode-hud")
}

// opencode 的全局配置根（宿主 packages/util/src/global.ts）：
//   OPENCODE_CONFIG_DIR 的值就是配置根本身，不再拼 opencode；否则 $XDG_CONFIG_HOME/opencode。
// 与安装 / 卸载脚本必须保持同一规则，否则插件会装到宿主不会加载的目录。
export function globalConfigDir(): string {
  const explicit = process.env.OPENCODE_CONFIG_DIR?.trim()
  if (explicit) return explicit
  const base = process.env.XDG_CONFIG_HOME?.trim()
  return join(base ? base : join(homedir(), ".config"), "opencode")
}

// opencode 的「全局插件目录」（与安装脚本 install.sh / install.ps1 一致）：
//   <全局配置根>/plugins
// ⚠️ 这是 opencode 发现插件的位置，用于一键更新时的替换目标；
//    与 pluginDataDir()（本插件自己的缓存/日志数据目录）是两回事，勿混。
export function globalPluginsDir(): string {
  return join(globalConfigDir(), "plugins")
}

export function globalPluginDir(): string {
  return join(globalPluginsDir(), "opencode-hud")
}
