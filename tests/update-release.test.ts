// ─── update/release.ts：Release 协议与归档条目的纯函数（离线） ───
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  assetName,
  assetUrl,
  checksumAssetName,
  checksumUrl,
  isSafeArchiveEntry,
  parseChecksum,
  parseFormalTag,
  parseTrustedReleaseLocation,
  parseVersionInput,
  REPO,
  RELEASE_ARCHIVE_MAX_BYTES,
  RELEASE_CHECKSUM_MAX_BYTES,
  RELEASE_DOWNLOAD_TIMEOUT_MS,
  RELEASE_CHECKSUM_TIMEOUT_MS,
  RELEASE_EXTRACTED_MAX_BYTES,
  RELEASE_EXTRACTED_MAX_ENTRIES,
  RELEASES_LATEST_URL,
} from "../.opencode/plugins/opencode-hud/update/release.ts"

const HASH = "a".repeat(64)
const ASSET = "opencode-hud-v5.3.0.tar.gz"

test("只接受正式版 vX.Y.Z", () => {
  assert.deepEqual(parseFormalTag("v5.3.0"), { major: 5, minor: 3, patch: 0 })
  assert.deepEqual(parseFormalTag("v0.0.0"), { major: 0, minor: 0, patch: 0 })
  for (const bad of ["v5.3", "v5.3.0-rc.1", "5.3.0", "v05.3.0", "v5.3.0/../x", "V5.3.0", "v5.3.0 ", " v5.3.0", "v5.3.0\n", ""]) {
    assert.equal(parseFormalTag(bad), undefined, bad)
  }
})

test("applyUpdate 入参只接受裸 X.Y.Z", () => {
  assert.equal(parseVersionInput("5.3.0"), "v5.3.0")
  assert.equal(parseVersionInput("0.0.0"), "v0.0.0")
  for (const bad of ["v5.3.0", " 5.3.0", "5.3.0 ", "5.3.0-rc.1", "5.3", "05.3.0", "5.3.0.1", "", "5.3.0/../x", "5.3.0\r\n"]) {
    assert.equal(parseVersionInput(bad), undefined, bad)
  }
  // 接受时拼出的资产 URL 使用带 v 的正式 tag
  assert.equal(assetUrl(parseVersionInput("5.3.0")!), assetUrl("v5.3.0"))
})

test("Release 跳转只认本仓库正式 tag 的绝对 https 地址", () => {
  const tag = "v1.2.3"
  const absolute = `https://github.com/${REPO}/releases/tag/${tag}`
  assert.equal(parseTrustedReleaseLocation(absolute), tag)
  assert.equal(parseTrustedReleaseLocation(`/${REPO}/releases/tag/${tag}`), tag)
  assert.equal(parseTrustedReleaseLocation(`${REPO}/releases/tag/${tag}`), tag)

  for (const bad of [
    `http://github.com/${REPO}/releases/tag/${tag}`,
    `https://evil.example/${REPO}/releases/tag/${tag}`,
    `https://github.com/other/opencode-hud/releases/tag/${tag}`,
    `https://github.com/${REPO}/releases/tag/${tag}/extra`,
    `https://github.com/${REPO}/releases/tag/${tag}/`,
    `https://github.com/${REPO}/releases/tag/${tag}?x=1`,
    `https://github.com/${REPO}/releases/tag/${tag}#x`,
    `https://github.com/${REPO}/releases/latest`,
    `https://github.com/${REPO}/releases/tag/v1.2.3-rc.1`,
    `https://github.com:8443/${REPO}/releases/tag/${tag}`,
    `https://user@github.com/${REPO}/releases/tag/${tag}`,
    "",
    null,
    undefined,
  ]) {
    assert.equal(parseTrustedReleaseLocation(bad), undefined, String(bad))
  }
})

test("checksum 单行且文件名必须匹配", () => {
  assert.equal(parseChecksum(`${HASH}  ${ASSET}`, ASSET), HASH)
  assert.equal(parseChecksum(`${HASH} *${ASSET}`, ASSET), HASH)
  assert.equal(parseChecksum(`${HASH}  ${ASSET}\r\n`, ASSET), HASH)
  assert.equal(parseChecksum(`${HASH.toUpperCase()}  ${ASSET}\n`, ASSET), HASH.toUpperCase())

  const wrongName = "opencode-hud-v5.3.1.tar.gz"
  for (const bad of [
    `${HASH.slice(0, 63)}  ${ASSET}`,
    `${HASH}0  ${ASSET}`,
    `${HASH}  ${wrongName}`,
    `${HASH}  dir/${ASSET}`,
    `${HASH} ${ASSET}`,
    `${HASH}  ${ASSET}\n${HASH}  ${ASSET}`,
    `${HASH}`,
    `${HASH}  ${ASSET} extra`,
    ` ${HASH}  ${ASSET}`,
    "",
  ]) {
    assert.equal(parseChecksum(bad, ASSET), undefined, JSON.stringify(bad))
  }
})

test("资产名/URL 精确", () => {
  assert.equal(REPO, "Just-Silver/opencode-hud")
  assert.equal(RELEASES_LATEST_URL, "https://github.com/Just-Silver/opencode-hud/releases/latest")
  assert.equal(assetName("v5.3.0"), ASSET)
  assert.equal(checksumAssetName("v5.3.0"), `${ASSET}.sha256`)
  assert.equal(
    assetUrl("v5.3.0"),
    `https://github.com/Just-Silver/opencode-hud/releases/download/v5.3.0/${ASSET}`,
  )
  assert.equal(
    checksumUrl("v5.3.0"),
    `https://github.com/Just-Silver/opencode-hud/releases/download/v5.3.0/${ASSET}.sha256`,
  )
  // 协议限额是安全边界，不能在实现里悄悄改大
  assert.equal(RELEASE_ARCHIVE_MAX_BYTES, 16 * 1024 * 1024)
  assert.equal(RELEASE_CHECKSUM_MAX_BYTES, 4 * 1024)
  assert.equal(RELEASE_EXTRACTED_MAX_BYTES, 64 * 1024 * 1024)
  assert.equal(RELEASE_EXTRACTED_MAX_ENTRIES, 2000)
  assert.equal(RELEASE_DOWNLOAD_TIMEOUT_MS, 120_000)
  assert.equal(RELEASE_CHECKSUM_TIMEOUT_MS, 15_000)
})

test("归档条目只允许 opencode-hud 自身或其子路径", () => {
  for (const good of [
    "opencode-hud",
    "opencode-hud/tui.tsx",
    "opencode-hud/view/Sidebar.tsx",
    "opencode-hud/中文.tsx",
  ]) {
    assert.equal(isSafeArchiveEntry(good), true, good)
  }
  for (const bad of [
    "opencode-hudx/tui.tsx",
    "opencode-hud/",
    "opencode-hud/./tui.tsx",
    "opencode-hud/../tui.tsx",
    "opencode-hud/tui.tsx:ads",
    "opencode-hud/tui.tsx.",
    "opencode-hud/tui.tsx ",
    "../x",
    "/etc/passwd",
    "C:\\x",
    "opencode-hud\\..\\x",
    "other/tui.tsx",
    "",
    "opencode-hud//tui.tsx",
    "opencode-hud/ti\u0000u.tsx",
    "opencode-hud/ti\u0001u.tsx",
    "opencode-hud/ti\u007fu.tsx",
  ]) {
    assert.equal(isSafeArchiveEntry(bad), false, JSON.stringify(bad))
  }
})
