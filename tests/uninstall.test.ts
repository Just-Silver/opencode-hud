// ─── uninstall.sh / uninstall.ps1：目录锁、仅清理 hud 目标、逐项失败继续、自定义全局根 ───
import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const UNINSTALL_SH = join(REPO_ROOT, "uninstall.sh")
const UNINSTALL_PS1 = join(REPO_ROOT, "uninstall.ps1")
const LOCK_NAME = ".opencode-hud.lock"

// Windows 上只认 Git Bash（MSYS/Cygwin）：WSL 的 bash 访问不到 C:/ 路径，脚本夹具会失真
const bashProbe = spawnSync("bash", ["-c", "uname -s"], { encoding: "utf8", windowsHide: true })
const hasBash =
  bashProbe.status === 0 &&
  (process.platform !== "win32" || /MSYS|MINGW|CYGWIN/i.test(bashProbe.stdout ?? ""))
const hasPwsh = spawnSync("pwsh", ["-NoProfile", "-Command", "exit 0"], { windowsHide: true }).status === 0

const posix = (path: string) => path.replace(/\\/g, "/")

// 只让指定目标删除失败；其余仍由真实 rm 执行，保留真实目录结构参与断言
const BASH_FAKES = `
rm() {
  local target="" arg
  for arg in "$@"; do
    case "$arg" in
      -*) ;;
      *) target="$arg" ;;
    esac
  done
  if [ -n "\${FAKE_FAIL_RM_MATCH:-}" ] && [ "$target" = "\${FAKE_FAIL_RM_MATCH}" ]; then
    printf 'simulated: directory in use\\n' >&2
    return 1
  fi
  command rm "$@"
}
`

const PWSH_WRAPPER = `
$ErrorActionPreference = "Stop"

function Remove-Item {
  [CmdletBinding()]
  param([Parameter(Position = 0, ValueFromPipeline = $true)]$Path, [switch]$Recurse, [switch]$Force, [string]$LiteralPath)
  # 假件必须与真实命令语义一致：脚本用 -LiteralPath 才走字面路径，用 -Path 仍保留通配行为
  $useLiteral = $PSBoundParameters.ContainsKey('LiteralPath')
  if ($useLiteral) { $Path = $LiteralPath }
  if ($env:FAKE_FAIL_RM_MATCH -and "$Path" -eq $env:FAKE_FAIL_RM_MATCH) {
    throw "simulated directory in use"
  }
  if ($useLiteral) {
    Microsoft.PowerShell.Management\\Remove-Item -LiteralPath $Path -Recurse:$Recurse -Force:$Force
  } else {
    Microsoft.PowerShell.Management\\Remove-Item -Path $Path -Recurse:$Recurse -Force:$Force
  }
}

. '__UNINSTALL__'
`

type Layout = {
  root: string
  configHome: string
  pluginsDir: string
  dest: string
  legacy: string
  legacyTmp: string
  hudTmp: string
  legacyTui: string
  legacyTuiDir: string
  container: string
  dataDir: string
  dataFile: string
}

// 覆盖脚本会处理的每一类目标；容器与插件数据目录只用于证明卸载不会顺手删掉它们
function seedLayout(withCustomRoot = false, customDirName = "custom config"): Layout {
  const root = mkdtempSync(join(tmpdir(), "ohud uninstall-"))
  const configHome = join(root, "config dir")
  const customRoot = join(root, customDirName)
  const pluginsDir = join(withCustomRoot ? customRoot : join(configHome, "opencode"), "plugins")
  const dest = join(pluginsDir, "opencode-hud")
  const legacy = join(pluginsDir, "opencode-tui-usage")
  const legacyTmp = join(pluginsDir, ".tmp.opencode-tui-usage")
  const hudTmp = join(pluginsDir, ".tmp.opencode-hud")
  const legacyTui = join(pluginsDir, "tui", "opencode-hud.tsx")
  const legacyTuiDir = join(pluginsDir, "tui", "opencode-tui-usage")
  const container = join(pluginsDir, ".opencode-hud-install-deadbeef")
  for (const dir of [dest, legacy, legacyTmp, hudTmp, legacyTuiDir]) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "tui.tsx"), "installed")
  }
  mkdirSync(dirname(legacyTui), { recursive: true })
  writeFileSync(legacyTui, "old-layout")
  mkdirSync(join(container, "backup"), { recursive: true })
  writeFileSync(join(container, "backup", "tui.tsx"), "only-backup")

  // pluginDataDir：Windows 取 %LOCALAPPDATA%，其余取 XDG_DATA_HOME
  const dataDir = join(process.platform === "win32" ? join(root, "local appdata") : join(root, "data home"), "opencode-hud")
  mkdirSync(dataDir, { recursive: true })
  const dataFile = join(dataDir, "update-check.json")
  writeFileSync(dataFile, "{}")

  return {
    root,
    configHome,
    pluginsDir,
    dest,
    legacy,
    legacyTmp,
    hudTmp,
    legacyTui,
    legacyTuiDir,
    container,
    dataDir,
    dataFile,
  }
}

function runBash(layout: Layout, flags: Record<string, string> = {}) {
  const fakeEnv = join(layout.root, "bash-fakes.sh")
  writeFileSync(fakeEnv, BASH_FAKES)
  const env: Record<string, string | undefined> = {
    ...process.env,
    // 空串对 bash/PS/插件都表示「未设置」；不中和会把用例写到 ambient 的真实全局根
    OPENCODE_CONFIG_DIR: "",
    XDG_CONFIG_HOME: posix(layout.configHome),
    BASH_ENV: posix(fakeEnv),
    ...flags,
  }
  if (env.FAKE_FAIL_RM_MATCH) env.FAKE_FAIL_RM_MATCH = posix(env.FAKE_FAIL_RM_MATCH)
  if (process.platform === "win32") env.LOCALAPPDATA = posix(join(layout.root, "local appdata"))
  else env.XDG_DATA_HOME = posix(join(layout.root, "data home"))
  const res = spawnSync("bash", [UNINSTALL_SH], { env, encoding: "utf8", windowsHide: true })
  return { code: res.status ?? -1, output: `${res.stdout ?? ""}${res.stderr ?? ""}` }
}

function runPwsh(layout: Layout, flags: Record<string, string> = {}) {
  const wrapper = join(layout.root, "pwsh-fakes.ps1")
  writeFileSync(wrapper, PWSH_WRAPPER.replace("__UNINSTALL__", UNINSTALL_PS1.replace(/'/g, "''")))
  const env: Record<string, string | undefined> = {
    ...process.env,
    OPENCODE_CONFIG_DIR: "",
    XDG_CONFIG_HOME: layout.configHome,
    ...flags,
  }
  if (process.platform === "win32") env.LOCALAPPDATA = join(layout.root, "local appdata")
  else env.XDG_DATA_HOME = join(layout.root, "data home")
  const res = spawnSync("pwsh", ["-NoProfile", "-File", wrapper], { env, encoding: "utf8", windowsHide: true })
  return { code: res.status ?? -1, output: `${res.stdout ?? ""}${res.stderr ?? ""}` }
}

type Shell = { name: string; run: (layout: Layout, flags?: Record<string, string>) => { code: number; output: string }; skip?: string }
const SHELLS: Shell[] = [
  { name: "uninstall.sh", run: runBash, skip: hasBash ? undefined : "缺少 MSYS/Cygwin bash" },
  { name: "uninstall.ps1", run: runPwsh, skip: hasPwsh ? undefined : "缺少 pwsh（PowerShell 7）" },
]

function assertPreserved(layout: Layout): void {
  assert.equal(readFileSync(join(layout.container, "backup", "tui.tsx"), "utf8"), "only-backup", "随机事务容器可能含唯一备份，不应删除")
  assert.equal(existsSync(layout.dataFile), true, "插件数据目录不属于卸载目标")
  assert.equal(readFileSync(join(layout.legacy, "tui.tsx"), "utf8"), "installed", "旧名目录不再由脚本删除")
  assert.equal(readFileSync(join(layout.legacyTmp, "tui.tsx"), "utf8"), "installed", "旧名 staging 不再由脚本删除")
  assert.equal(readFileSync(join(layout.legacyTuiDir, "tui.tsx"), "utf8"), "installed", "旧名 tui/ 布局不再由脚本删除")
}

function cleanup(layout: Layout): void {
  rmSync(layout.root, { recursive: true, force: true })
}

for (const shell of SHELLS) {
  test(`${shell.name}：卸载 hud 当前目录与旧布局，保留旧名目录、容器与数据目录`, { skip: shell.skip }, () => {
    const layout = seedLayout()
    try {
      const { code, output } = shell.run(layout)
      assert.equal(code, 0, output)
      for (const path of [layout.dest, layout.hudTmp, layout.legacyTui]) {
        assert.equal(existsSync(path), false, `hud 目标应被清理：${path}`)
      }
      assertPreserved(layout)
      assert.equal(existsSync(join(layout.pluginsDir, LOCK_NAME)), false, "正常结束后不应残留目录锁")
    } finally {
      cleanup(layout)
    }
  })

  test(`${shell.name}：某一目标删除失败后继续清理其余目标，最终报失败并提示关闭 opencode`, { skip: shell.skip }, () => {
    const layout = seedLayout()
    try {
      const { code, output } = shell.run(layout, { FAKE_FAIL_RM_MATCH: layout.dest })
      assert.notEqual(code, 0, output)
      assert.equal(existsSync(layout.dest), true, "删除失败的目标应保留")
      for (const path of [layout.hudTmp, layout.legacyTui]) {
        assert.equal(existsSync(path), false, `其余已知目标应继续清理：${path}`)
      }
      assertPreserved(layout)
      assert.match(output, /关闭 opencode 后重试/)
      assert.equal(output.includes(`✓ 已删除 ${layout.dest}`), false, "未删除项不能报成功")
    } finally {
      cleanup(layout)
    }
  })

  test(`${shell.name}：锁被占用时不删除任何目标；释放后可成功`, { skip: shell.skip }, () => {
    const layout = seedLayout()
    const lockDir = join(layout.pluginsDir, LOCK_NAME)
    const owner = "tool=install\npid=4242\nstartedAt=1\ntoken=someone-else\n"
    try {
      mkdirSync(lockDir)
      writeFileSync(join(lockDir, "owner"), owner)
      const blocked = shell.run(layout)
      assert.notEqual(blocked.code, 0, blocked.output)
      const expectedLockPath = shell.name === "uninstall.sh" ? posix(lockDir) : lockDir
      const compact = blocked.output.replace(/\x1b\[[0-9;]*m/g, "").replace(/[\s|]+/g, "")
      assert.ok(compact.includes(expectedLockPath.replace(/\s+/g, "")), `输出应包含锁路径：\n${blocked.output}`)
      for (const path of [layout.dest, layout.hudTmp, layout.legacyTui]) {
        assert.equal(existsSync(path), true, `持锁期间不能删除目标：${path}`)
      }
      assertPreserved(layout)
      assert.equal(readFileSync(join(lockDir, "owner"), "utf8").trim(), owner.trim())

      rmSync(lockDir, { recursive: true, force: true })
      const released = shell.run(layout)
      assert.equal(released.code, 0, released.output)
      assert.equal(existsSync(layout.dest), false)
      assertPreserved(layout)
    } finally {
      cleanup(layout)
    }
  })

  test(`${shell.name}：OPENCODE_CONFIG_DIR 指定自定义全局根时只清理该根，旧 XDG 根不动`, { skip: shell.skip }, () => {
    const layout = seedLayout(true)
    const xdgPlugins = join(layout.configHome, "opencode", "plugins")
    const xdgLegacy = join(xdgPlugins, "opencode-tui-usage")
    mkdirSync(xdgLegacy, { recursive: true })
    writeFileSync(join(xdgLegacy, "tui.tsx"), "xdg-legacy")
    try {
      const { code, output } = shell.run(layout, { OPENCODE_CONFIG_DIR: layout.root + "/custom config" })
      assert.equal(code, 0, output)
      for (const path of [layout.dest, layout.hudTmp, layout.legacyTui]) {
        assert.equal(existsSync(path), false, `自定义根中的 hud 目标应被删除：${path}`)
      }
      assert.equal(readFileSync(join(xdgLegacy, "tui.tsx"), "utf8"), "xdg-legacy", "旧 XDG 根不应被操作")
      assertPreserved(layout)
    } finally {
      cleanup(layout)
    }
  })
}

test("uninstall.ps1：配置根含方括号时只删除字面路径，不误删相邻匹配根", { skip: hasPwsh ? undefined : "缺少 pwsh（PowerShell 7）" }, () => {
  const layout = seedLayout(true, "custom config[1]")
  // `custom config[1]` 作为通配模式会匹配 `custom config1`；后者是无关目录，不能被删除
  const neighborPlugins = join(layout.root, "custom config1", "plugins")
  const neighborDest = join(neighborPlugins, "opencode-hud")
  mkdirSync(neighborDest, { recursive: true })
  writeFileSync(join(neighborDest, "tui.tsx"), "neighbor-tui")
  try {
    const { code, output } = runPwsh(layout, { OPENCODE_CONFIG_DIR: join(layout.root, "custom config[1]") })
    assert.equal(readFileSync(join(neighborDest, "tui.tsx"), "utf8"), "neighbor-tui", "相邻匹配根不能被删除")
    for (const path of [layout.dest, layout.hudTmp, layout.legacyTui]) {
      assert.equal(existsSync(path), false, `自定义根中的 hud 目标应被删除：${path}`)
    }
    assert.equal(code, 0, output)
    assertPreserved(layout)
  } finally {
    cleanup(layout)
  }
})
