# opencode-hud

TUI 侧边栏：上下文 / 缓存 / 额度。

## 安装

Linux / macOS（bash）：

```bash
curl -fsSL https://raw.githubusercontent.com/Just-Silver/opencode-hud/main/install.sh | bash
```

Windows（PowerShell 7+）：

```powershell
irm https://raw.githubusercontent.com/Just-Silver/opencode-hud/main/install.ps1 | iex
```

脚本会把插件整目录安装到全局插件目录（Linux/macOS 为 `~/.config/opencode/plugins/opencode-hud/`，Windows 为 `%USERPROFILE%\.config\opencode\plugins\opencode-hud\`），重启 opencode 生效。安装的是**最新 Release** 版本（与插件内一键更新同一取源）。

## 更新

插件启动时会自动对比本地版本与 GitHub 最新 Release，有新版本时在侧边栏底部显示一行黄色提示：**点这行文字即可在弹窗里一键更新**（点 `✕` 则关闭、本次会话内不再出现）。

一键更新会在后台由插件自己下载对应版本归档（GitHub tag tar.gz）、用系统 `tar` 解压，并**原子替换全局插件目录**（`$XDG_CONFIG_HOME/opencode/plugins/opencode-hud`，与安装脚本同一目标）。完成后弹窗提供「重启」按钮，点击即退出 opencode（与官方一致，不会自动重开进程），重新运行 `opencode` 即可，会话会自动恢复。也可以像以前一样手动重跑上面的安装脚本。

## 卸载

Linux / macOS（bash）：

```bash
curl -fsSL https://raw.githubusercontent.com/Just-Silver/opencode-hud/main/uninstall.sh | bash
```

Windows（PowerShell 7+）：

```powershell
irm https://raw.githubusercontent.com/Just-Silver/opencode-hud/main/uninstall.ps1 | iex
```
