# opencode-hud

OpenCode TUI 侧边栏仪表盘：上下文占用与 token 构成、全部已登录订阅的额度、子代理运行监控（中性黑灰 + 琥珀强调的圆角卡片）。

## 安装

Linux / macOS（bash）：

```bash
curl -fsSL https://raw.githubusercontent.com/Just-Silver/opencode-hud/main/install.sh | bash
```

Windows（PowerShell 7+）：

```powershell
irm https://raw.githubusercontent.com/Just-Silver/opencode-hud/main/install.ps1 | iex
```

脚本会把插件整目录安装到全局插件目录：优先使用 `OPENCODE_CONFIG_DIR`（该值就是配置根本身，不再拼接 `opencode`），否则 `$XDG_CONFIG_HOME/opencode`，最后 `~/.config/opencode`。默认位置：Linux/macOS `~/.config/opencode/plugins/opencode-hud/`，Windows `%USERPROFILE%\.config\opencode\plugins\opencode-hud\`。重启 opencode 生效。

脚本只安装最新正式 Release 的带校验资产：下载归档与同名 `.sha256`，校验通过才解压落地，任何一步失败都不会覆盖现有安装。

安装、更新、卸载共用一把目录锁（`<全局配置根>/plugins/.opencode-hud.lock`）。锁不会自动失效：若安装、卸载或一键更新异常退出留下锁目录，先确认没有 opencode 或安装进程在操作，再手工删除该锁目录后重试。并发操作时拿不到锁的一方会直接失败，不会改动或删除现有安装。

> 若同时还残留改名前的旧目录（`<全局配置根>/plugins/opencode-tui-usage/`），宿主会把它当第二个插件加载，侧栏与性能块会重复渲染；请手工删除该目录后重启。

## 更新

插件启动时会自动对比本地版本与 GitHub 最新 Release，有新版本时在侧边栏底部显示一行黄色提示：**点这行文字即可在弹窗里一键更新**（点 `✕` 则关闭、本次会话内不再出现）。

一键更新只接受正式版本，取源与校验规则和安装脚本一致，并在目录锁内替换全局插件目录：失败会保留或回滚旧版，现有安装不会被破坏；更新成功后弹窗提供「重启」按钮，点击即退出 opencode（与官方一致，不会自动重开进程），重新运行 `opencode` 即可，会话会自动恢复。也可以不点更新，直接重跑上面的安装脚本。

## 卸载

Linux / macOS（bash）：

```bash
curl -fsSL https://raw.githubusercontent.com/Just-Silver/opencode-hud/main/uninstall.sh | bash
```

Windows（PowerShell 7+）：

```powershell
irm https://raw.githubusercontent.com/Just-Silver/opencode-hud/main/uninstall.ps1 | iex
```

卸载按与安装相同的全局配置根定位目标，并清理历史布局残留（`plugins/tui/opencode-hud*`）。某个目录删不掉时（通常是 opencode 仍在运行）会继续清理其余目标，最后提示关闭 opencode 后重试。卸载与安装/更新共用同一把目录锁：拿不到锁会直接失败且**不删除任何目标**，稍后重试即可。改名前的旧目录（`opencode-tui-usage`）不会被脚本删除，需按上面的说明手工清理。插件自己的本地数据目录（更新检查缓存，Windows `%LOCALAPPDATA%\opencode-hud`、macOS `~/Library/Application Support/opencode-hud`、Linux `$XDG_DATA_HOME/opencode-hud` 或 `~/.local/share/opencode-hud`）不会被卸载脚本删除，可手工清理。
