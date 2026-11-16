// ─── scripts/build-release-asset.sh：可复现资产、裸名 sidecar 与源目录校验 ───
// 本机 bash 的 PATH 上常是 system32 的 bsdtar（不支持 --sort/--mtime=@0），所以探测到 GNU tar 后
// 每次构建都通过 TAR=<路径> 注入，不依赖 PATH。
import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "child_process"
import { createHash } from "crypto"
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs"
import { tmpdir } from "os"
import { basename, dirname, join } from "path"
import { fileURLToPath } from "url"
import {
  assetName,
  checksumAssetName,
  parseChecksum,
  parseFormalTag,
} from "../.opencode/plugins/opencode-hud/update/release.ts"
import { VERSION } from "../.opencode/plugins/opencode-hud/update/version.ts"
import { scanTarGz } from "../.opencode/plugins/opencode-hud/update/tar.ts"

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const SCRIPT = join(REPO_ROOT, "scripts", "build-release-asset.sh")
const PLUGIN_DIR = join(REPO_ROOT, ".opencode/plugins/opencode-hud")
const TAG = `v${VERSION}`
const ASSET = assetName(TAG)
// 版本常量是唯一事实源：测试的「正式 tag」必须真的长成 vX.Y.Z
assert.ok(parseFormalTag(TAG), `VERSION 不是正式 SemVer：${VERSION}`)

const posix = (path: string) => path.replace(/\\/g, "/")

function isGnuTar(candidate: string): boolean {
  const direct = spawnSync(candidate, ["--version"], { encoding: "utf8", windowsHide: true })
  if (direct.status === 0 && `${direct.stdout ?? ""}`.includes("GNU tar")) return true
  // Windows 上 /usr/bin/tar 是 MSYS 路径，只有 bash 视角能解析
  const viaBash = spawnSync("bash", ["-c", '"$1" --version', "probe", candidate], {
    encoding: "utf8",
    windowsHide: true,
  })
  return viaBash.status === 0 && `${viaBash.stdout ?? ""}`.includes("GNU tar")
}

// 探测顺序：显式 TAR → Windows 的 /usr/bin/tar → PATH；只认 --version 含 GNU tar 的实现
function findGnuTar(): string | undefined {
  const candidates = [
    process.env.TAR,
    process.platform === "win32" ? "/usr/bin/tar" : undefined,
    "tar",
  ]
  for (const candidate of candidates) {
    if (candidate && isGnuTar(candidate)) return candidate
  }
  return undefined
}

const GNU_TAR = findGnuTar()
const NEED_GNU_TAR = GNU_TAR ? undefined : "需要 GNU tar（PATH、/usr/bin/tar 与 TAR 均未命中）"

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "ohud-asset-"))
}

// 真实插件目录的临时副本（目录名带空格，验证路径含空格可用）
function seedSource(root: string): string {
  const src = join(root, "src plugin")
  cpSync(PLUGIN_DIR, src, { recursive: true })
  return src
}

function runBuild(
  tag: string,
  outDir: string,
  src?: string,
  overrides: Record<string, string> = {},
): { code: number; stdout: string; output: string } {
  const env: NodeJS.ProcessEnv = { ...process.env }
  if (GNU_TAR) env.TAR = GNU_TAR
  for (const [key, value] of Object.entries(overrides)) env[key] = value
  const args = [SCRIPT, tag, outDir, ...(src ? [src] : [])]
  const res = spawnSync("bash", args, { cwd: REPO_ROOT, env, encoding: "utf8", windowsHide: true })
  return {
    code: res.status ?? -1,
    stdout: res.stdout ?? "",
    output: `${res.stdout ?? ""}${res.stderr ?? ""}`,
  }
}

function listArchive(archive: string): string[] {
  // GNU tar 可能是 MSYS 的 /usr/bin/tar，Node 直接 spawn 解析不到，必须经 bash 调用；
  // Windows 路径里的 `D:` 会被 GNU tar 当成远程主机，必须 --force-local
  const list = spawnSync("bash", ["-c", '"$1" --force-local -tzf "$2"', "probe", GNU_TAR!, posix(archive)], {
    encoding: "utf8",
    windowsHide: true,
  })
  assert.equal(list.status, 0, list.stderr ?? "无法列出构建产物")
  return (list.stdout ?? "").trim().split(/\r?\n/).filter(Boolean)
}

function assertNoOutput(outDir: string): void {
  assert.equal(existsSync(join(outDir, ASSET)), false, "失败时不应留下资产")
  assert.equal(existsSync(join(outDir, checksumAssetName(TAG))), false, "失败时不应留下 sidecar")
}

// ─── 用例 ───

test("同一源目录两次构建字节一致，sidecar 可被 parseChecksum 解析", { skip: NEED_GNU_TAR }, () => {
  const root = tempRoot()
  try {
    const src = seedSource(root)
    // 归一化必须抹掉源目录的 mode：noacl 文件系统会静默忽略 chmod 的 go 位，只有只读属性
    // 会进 stat 与 tar header，所以额外做 a-w；POSIX 上两者都会让源文件变成不可写。
    const chmod = spawnSync("bash", ["-c", 'chmod -R go-rwx "$1" && chmod -R a-w "$1"', "probe", posix(src)], {
      windowsHide: true,
    })
    assert.equal(chmod.status, 0, chmod.stderr?.toString() ?? "chmod 失败")

    const outA = join(root, "out a")
    const outB = join(root, "out b")
    const first = runBuild(TAG, outA, src)
    const second = runBuild(TAG, outB, src)
    assert.equal(first.code, 0, first.output)
    assert.equal(second.code, 0, second.output)

    const bytesA = readFileSync(join(outA, ASSET))
    const bytesB = readFileSync(join(outB, ASSET))
    assert.ok(bytesA.length > 0, "资产不能为空")
    // Buffer.equals 是常量级比较；deepEqual 对大 Buffer 会生成 O(n²) 的字节 diff
    assert.ok(bytesA.equals(bytesB), "两次构建的字节必须一致")

    const hash = createHash("sha256").update(bytesA).digest("hex")
    const sidecar = readFileSync(join(outA, checksumAssetName(TAG)), "utf8")
    assert.equal(parseChecksum(sidecar, ASSET), hash, "sidecar 必须与资产内容一致且可被宿主解析")

    // 第三参数缺省时默认使用仓库内的插件目录；mode 被归一化后同一内容必须产出同一字节
    const outDefault = join(root, "out default")
    const fallback = runBuild(TAG, outDefault)
    assert.equal(fallback.code, 0, fallback.output)
    assert.ok(
      readFileSync(join(outDefault, ASSET)).equals(bytesA),
      "默认源目录与改过 mode 的副本必须字节一致",
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("归档顶层唯一项是目录 opencode-hud/，含 tui.tsx，且无隐藏垃圾", { skip: NEED_GNU_TAR }, async () => {
  const root = tempRoot()
  try {
    const src = seedSource(root)
    const outDir = join(root, "out")
    const built = runBuild(TAG, outDir, src)
    assert.equal(built.code, 0, built.output)

    const archive = join(outDir, ASSET)
    const entries = listArchive(archive)
    const topLevel = entries.filter((entry) => !entry.startsWith("opencode-hud/") || entry === "opencode-hud/")
    assert.deepEqual(topLevel, ["opencode-hud/"], "顶层必须只有目录 opencode-hud/")
    assert.ok(entries.includes("opencode-hud/tui.tsx"), "归档必须包含插件入口 tui.tsx")
    assert.deepEqual(entries.filter((entry) => /(^|\/)\./.test(entry)), [], "归档不能含隐藏条目")

    // 产物必须能被宿主自己的解压前扫描器接受：--format/路径规则漂移会在这里暴露
    const scan = await scanTarGz(archive)
    assert.equal(scan.ok, true, scan.ok ? "" : scan.message)

    // 源路径若是恰好名为 opencode-hud 的常规文件，必须明确拒绝而不是把它当目录打包
    const fileSrc = join(root, "opencode-hud")
    writeFileSync(fileSrc, "not a directory")
    const outFile = join(root, "out file")
    const rejected = runBuild(TAG, outFile, fileSrc)
    assert.notEqual(rejected.code, 0, "常规文件不能作为源目录")
    assert.match(rejected.output, /不是目录/)
    assertNoOutput(outFile)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("tag 与 VERSION 不一致时构建失败", { skip: NEED_GNU_TAR }, () => {
  const root = tempRoot()
  try {
    const src = seedSource(root)
    const mismatch = runBuild(`v0.0.0`, join(root, "out mismatch"), src)
    assert.notEqual(mismatch.code, 0, "与 VERSION 不一致的正式 tag 必须失败")
    assert.match(mismatch.output, /VERSION|不一致/)
    assertNoOutput(join(root, "out mismatch"))

    const informal = runBuild(VERSION, join(root, "out informal"), src)
    assert.notEqual(informal.code, 0, "缺少 v 前缀的版本号不是正式 tag")
    assert.match(informal.output, /正式|vX\.Y\.Z/)
    assertNoOutput(join(root, "out informal"))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("源目录含符号链接时构建失败", { skip: NEED_GNU_TAR }, (t) => {
  const root = tempRoot()
  try {
    const src = seedSource(root)
    const seesLink = (path: string) =>
      spawnSync("bash", ["-c", '[ -L "$1" ]', "probe", posix(path)], { windowsHide: true }).status === 0

    // Windows 无开发者模式时文件符号链接需要管理员；目录 junction 不需要，MSYS 同样当符号链接
    let link = join(src, "link.ts")
    try {
      symlinkSync("tui.tsx", link, "file")
    } catch {
      link = join(src, "link-dir")
      try {
        symlinkSync(join(src, "model"), link, "junction")
      } catch {
        t.skip("当前平台无法创建符号链接/目录联接")
        return
      }
    }
    if (!seesLink(link)) {
      t.skip("当前平台无法创建符号链接/目录联接")
      return
    }

    const outDir = join(root, "out")
    const rejected = runBuild(TAG, outDir, src)
    assert.notEqual(rejected.code, 0, "源目录含符号链接必须拒绝")
    assert.match(rejected.output, /符号链接/)
    assertNoOutput(outDir)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("源目录含隐藏条目时构建失败", { skip: NEED_GNU_TAR }, () => {
  const root = tempRoot()
  try {
    const src = seedSource(root)
    writeFileSync(join(src, ".hidden"), "hidden")
    const outDir = join(root, "out")
    const rejected = runBuild(TAG, outDir, src)
    assert.notEqual(rejected.code, 0, "隐藏条目必须在打包前被拒绝")
    assert.match(rejected.output, /隐藏条目/)
    assert.doesNotMatch(rejected.output, /^tar:/m, "失败原因应来自脚本而不是 tar")
    assertNoOutput(outDir)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("TAR 指向非 GNU tar 时构建失败并提示需要 GNU tar", () => {
  const root = tempRoot()
  try {
    const src = seedSource(root)
    const fakeTar = join(root, "fake bin", "tar")
    mkdirSync(dirname(fakeTar), { recursive: true })
    writeFileSync(fakeTar, '#!/usr/bin/env bash\nprintf "bsdtar 3.8.9\\n"\n')
    const outDir = join(root, "out")
    const rejected = runBuild(TAG, outDir, src, { TAR: posix(fakeTar) })
    assert.notEqual(rejected.code, 0, "假 tar 不能通过 GNU tar 校验")
    assert.match(rejected.output, /需要 GNU tar/)
    assert.doesNotMatch(rejected.output, /tar: unrecognized option/)
    assertNoOutput(outDir)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("sidecar 文件名是裸资产名（无目录前缀）", { skip: NEED_GNU_TAR }, () => {
  const root = tempRoot()
  try {
    const src = seedSource(root)
    const outDir = join(root, "out dir")
    const built = runBuild(TAG, outDir, src)
    assert.equal(built.code, 0, built.output)

    const sidecarPath = join(outDir, checksumAssetName(TAG))
    assert.equal(existsSync(sidecarPath), true, `缺少 sidecar：${sidecarPath}`)
    const text = readFileSync(sidecarPath, "utf8")
    assert.equal(text.includes("/"), false, `sidecar 不能含目录前缀：${text}`)
    assert.equal(text.includes("\\"), false, `sidecar 不能含 Windows 路径：${text}`)
    // 脚本固定写 `<hash>  <asset>`；这里也接受 coreutils 的 ` *` 变体，避免绑定具体工具
    assert.match(text, new RegExp(`^[0-9a-f]{64} (?: |\\*)${ASSET.replace(/\./g, "\\.")}\\r?\\n$`))
    assert.ok(parseChecksum(text, ASSET), "sidecar 必须能被宿主的 parseChecksum 解析")

    // stdout 恰好给出两个可定位的产物路径，且末段是裸名
    const lines = built.stdout.trim().split(/\r?\n/)
    assert.equal(lines.length, 2, `stdout 应打印两个路径：\n${built.stdout}`)
    assert.equal(basename(lines[0]), ASSET)
    assert.equal(basename(lines[1]), checksumAssetName(TAG))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
