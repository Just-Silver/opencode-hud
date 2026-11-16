# opencode-hud

OpenCode TUI 侧边栏仪表盘：上下文占用与 token 构成、全部已登录订阅的额度、子代理运行监控（中性黑灰 + 琥珀强调的圆角卡片）。

## 安装

前置条件：`curl` + 系统 `tar` + `gzip`。Windows 还需要 PowerShell 7+、`curl.exe >= 8.4.0`（更早版本的 `--max-filesize` 对没有 `Content-Length` 的响应无效）与系统自带 `tar`（Windows 10/11 自带）。

Linux / macOS（bash）：

```bash
curl -fsSL https://raw.githubusercontent.com/Just-Silver/opencode-hud/main/install.sh | bash
```

Windows（PowerShell 7+）：

```powershell
irm https://raw.githubusercontent.com/Just-Silver/opencode-hud/main/install.ps1 | iex
```

脚本会把插件整目录安装到全局插件目录：优先使用 `OPENCODE_CONFIG_DIR`（该值就是配置根本身，不再拼接 `opencode`），否则 `$XDG_CONFIG_HOME/opencode`，最后 `~/.config/opencode`。默认位置：Linux/macOS `~/.config/opencode/plugins/opencode-hud/`，Windows `%USERPROFILE%\.config\opencode\plugins\opencode-hud\`。重启 opencode 生效。

脚本只安装**最新正式 Release 的带校验资产**（`opencode-hud-vX.Y.Z.tar.gz` 与同名 `.sha256`）：下载有 16 MiB / 120 s 上限，先核对 SHA256，解压前逐 512 字节检查归档头（只允许 `opencode-hud/` 下的常规文件与目录），解压后再复核落地内容；安装、更新、卸载共用一把目录锁（`<全局配置根>/plugins/.opencode-hud.lock`）。锁不会自动失效：若脚本或插件异常退出留下锁目录，先确认没有 opencode 或安装进程在操作，再手工删除该锁目录后重试。旧版 Release 缺少资产时会明确失败，**不回退**源码归档、`git clone` 或 main。安装脚本合入 main 到首个带资产 Release 发布之间，脚本暂不可用。

> **从 v4.1.x 升级或卸载后，旧目录不会被脚本自动删除**：旧副本仍可能被宿主加载并与新安装重复注册相同 slot（侧栏、性能块重复渲染），必须手工删除后重启。旧目录是 `<全局配置根>/plugins/opencode-tui-usage/`（以及 `.tmp.opencode-tui-usage`）。

从 **v4.1.x 或更早版本**升级：旧版内置更新器按旧目录名查找入口，无法跨目录自动迁移；请重跑本安装脚本装到新目录，并按上一条手工删除旧目录（脚本不会代删），不要依赖插件内一键更新。

并发安装同一配置根时，后到的脚本会先尝试获取目录锁（30 s 超时）；拿不到锁会直接失败且不改动现有安装。若目标目录在安装期间被另一个进程创建，脚本会以非零状态退出并打印旧版备份与可能被嵌套的新副本路径；两份副本都不会被覆盖或删除，按打印的路径自行确认后再处理。

## 更新

插件启动时会自动对比本地版本与 GitHub 最新 Release，有新版本时在侧边栏底部显示一行黄色提示：**点这行文字即可在弹窗里一键更新**（点 `✕` 则关闭、本次会话内不再出现）。

一键更新只接受正式版本，取源与安装脚本一致：先取 `.sha256`、有界下载、解压前扫描归档、解压后复核，最后在目录锁内事务式替换全局插件目录（失败会保留/回滚旧版；目标同样是 `<全局配置根>/plugins/opencode-hud`）。完成后弹窗提供「重启」按钮，点击即退出 opencode（与官方一致，不会自动重开进程），重新运行 `opencode` 即可，会话会自动恢复。也可以像以前一样手动重跑上面的安装脚本。

## 卸载

Linux / macOS（bash）：

```bash
curl -fsSL https://raw.githubusercontent.com/Just-Silver/opencode-hud/main/uninstall.sh | bash
```

Windows（PowerShell 7+）：

```powershell
irm https://raw.githubusercontent.com/Just-Silver/opencode-hud/main/uninstall.ps1 | iex
```

卸载按与安装相同的全局配置根定位目标，并清理 hud 的旧布局残留（`plugins/tui/opencode-hud*`）。某个目录删不掉时（通常是 opencode 仍在运行）会继续清理其余目标，最后提示关闭 opencode 后重试。卸载与安装/更新共用同一把目录锁：拿不到锁会直接失败且**不删除任何目标**，稍后重试即可。脚本已不再删除改名前的旧目录，见上面的手工清理说明。插件自己的本地数据目录（更新检查缓存，Windows `%LOCALAPPDATA%\opencode-hud`、macOS `~/Library/Application Support/opencode-hud`、Linux `$XDG_DATA_HOME/opencode-hud` 或 `~/.local/share/opencode-hud`）不会被卸载脚本删除，可手工清理。
