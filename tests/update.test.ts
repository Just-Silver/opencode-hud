// ─── update/ 更新检测单元测试（离线，零网络） ───
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import {
  compareVersions,
  parseVersion,
} from "../.opencode/plugins/opencode-hud/update/version.ts"
import {
  resolveUpdate,
  fetchLatestTag,
  parseTagFromReleaseUrl,
  isCacheFresh,
  readUpdateCache,
  writeUpdateCache,
  checkForUpdate,
  updateCachePath,
  markUpdated,
} from "../.opencode/plugins/opencode-hud/update/index.ts"
import type { UpdateCheckCache } from "../.opencode/plugins/opencode-hud/update/index.ts"

const H = 60 * 60 * 1000 // 1 小时（毫秒）

// ─── version.ts ───
test("parseVersion：SemVer 与 v 前缀", () => {
  assert.deepEqual(parseVersion("1.0.0"), { major: 1, minor: 0, patch: 0 })
  assert.deepEqual(parseVersion("v1.2.3"), { major: 1, minor: 2, patch: 3 })
  assert.equal(parseVersion("1.0"), undefined)
  assert.equal(parseVersion("v1.2.3.4"), undefined)
  assert.equal(parseVersion("abc"), undefined)
})

test("compareVersions：SemVer 比较", () => {
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0)
  assert.equal(compareVersions("1.0.0", "1.0.1"), -1)
  assert.equal(compareVersions("1.0.1", "1.0.0"), 1)
  assert.equal(compareVersions("1.1.0", "1.0.9"), 1)
  assert.equal(compareVersions("2.0.0", "1.9.9"), 1)
  assert.equal(compareVersions("1.0.0", "v1.0.1"), -1) // 容忍 v 前缀
  assert.equal(compareVersions("abc", "1.0.0"), undefined) // 非法 → undefined
})

// ─── index.ts resolveUpdate ───
test("resolveUpdate：无远程 Release → 不提示", () => {
  assert.equal(resolveUpdate("1.0.0", undefined), undefined)
})

test("resolveUpdate：版本一致 → 不提示", () => {
  assert.equal(resolveUpdate("1.0.0", "v1.0.0"), undefined)
})

test("resolveUpdate：本地落后 → 提示，v 前缀剥离", () => {
  const u = resolveUpdate("1.0.0", "v1.1.0", "v1.1.0")
  assert.deepEqual(u, { latestVersion: "1.1.0", name: "v1.1.0", body: undefined })
})

test("resolveUpdate：本地超前（开发版）→ 不提示", () => {
  assert.equal(resolveUpdate("1.2.0", "v1.1.0"), undefined)
})

test("resolveUpdate：远程非法版本 → 不提示", () => {
  assert.equal(resolveUpdate("1.0.0", "latest"), undefined)
})

// ─── index.ts parseTagFromReleaseUrl ───
test("parseTagFromReleaseUrl：提取 tag（容忍 v 前缀 / 查询串 / 编码）", () => {
  assert.equal(parseTagFromReleaseUrl("https://github.com/o/r/releases/tag/v1.1.0"), "v1.1.0")
  assert.equal(parseTagFromReleaseUrl("https://github.com/o/r/releases/tag/v1.1.0?x=1"), "v1.1.0")
  assert.equal(parseTagFromReleaseUrl("https://github.com/o/r/releases/tag/v1.1.0%2Bmeta"), "v1.1.0+meta")
  assert.equal(parseTagFromReleaseUrl("https://github.com/o/r/releases/latest"), undefined)
  assert.equal(parseTagFromReleaseUrl(undefined), undefined)
})

// ─── index.ts fetchLatestTag（mock fetch，302 跳转） ───
test("fetchLatestTag：302 Location → tag", async () => {
  const mock = (async () =>
    new Response(null, {
      status: 302,
      headers: { location: "https://github.com/Just-Silver/opencode-hud/releases/tag/v1.1.0" },
    })) as unknown as typeof fetch
  assert.equal(await fetchLatestTag(mock), "v1.1.0")
})

test("fetchLatestTag：无 Release（404 / 无 Location）/ 网络失败 → undefined", async () => {
  const mock404 = (async () => new Response("not found", { status: 404 })) as unknown as typeof fetch
  assert.equal(await fetchLatestTag(mock404), undefined)
  const mockThrow = (async () => {
    throw new Error("network")
  }) as unknown as typeof fetch
  assert.equal(await fetchLatestTag(mockThrow), undefined)
})

test("fetchLatestTag：网络挂起 → 超时中止返回 undefined", async () => {
  const mock = ((_url: unknown, init?: { signal?: AbortSignal }) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))
    })) as unknown as typeof fetch
  assert.equal(await fetchLatestTag(mock, 10), undefined)
})

// ─── index.ts isCacheFresh（节流纯逻辑：成功 24h / 失败冷却 1h） ───
test("isCacheFresh：无缓存 → false", () => {
  assert.equal(isCacheFresh(undefined, 10 * H), false)
})

test("isCacheFresh：成功 TTL 内 → true（零网络）", () => {
  const now = 10 * H
  assert.equal(isCacheFresh({ lastAttemptAt: now - H, lastSuccessAt: now - H, latest: "v1.0.0" }, now), true)
})

test("isCacheFresh：成功超 TTL 且尝试也在冷却外 → false", () => {
  const now = 30 * H
  assert.equal(
    isCacheFresh({ lastAttemptAt: now - 25 * H, lastSuccessAt: now - 25 * H, latest: "v1.0.0" }, now),
    false,
  )
})

test("isCacheFresh：失败冷却期内（无成功）→ true", () => {
  const now = 10 * H
  assert.equal(isCacheFresh({ lastAttemptAt: now - 30 * 60 * 1000 }, now), true)
})

test("isCacheFresh：失败且超出冷却 → false", () => {
  const now = 10 * H
  assert.equal(isCacheFresh({ lastAttemptAt: now - 2 * H }, now), false)
})

// ─── index.ts readUpdateCache / writeUpdateCache（落盘往返） ───
test("readUpdateCache / writeUpdateCache：落盘往返 + 缺失/损坏静默", () => {
  const dir = mkdtempSync(join(tmpdir(), "tui-usage-update-"))
  try {
    const path = join(dir, "sub", "update-check.json")
    assert.equal(readUpdateCache(path), undefined) // 文件不存在
    writeUpdateCache(path, { lastAttemptAt: 123, lastSuccessAt: 123, latest: "v1.2.3" })
    assert.deepEqual(readUpdateCache(path), { lastAttemptAt: 123, lastSuccessAt: 123, latest: "v1.2.3" })
    writeFileSync(path, "{ not json", "utf8")
    assert.equal(readUpdateCache(path), undefined) // 损坏
    writeFileSync(path, JSON.stringify({ latest: "v9" }), "utf8")
    assert.equal(readUpdateCache(path), undefined) // 缺 lastAttemptAt
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ─── index.ts updateCachePath（各 OS 的本地应用数据目录，不放 opencode 目录） ───
test("updateCachePath：落在插件自己的本地应用数据目录下", () => {
  const p = updateCachePath()
  assert.ok(p.endsWith(join("opencode-hud", "update-check.json")), p)
  if (process.platform === "win32") assert.ok(/AppData[\\/]Local/.test(p), p) // %LOCALAPPDATA%
})

// ─── index.ts checkForUpdate（节流编排；VERSION 无关：用 v99/v0 保证高/低） ───
test("checkForUpdate：缓存新鲜 → 不联网，用缓存判断", async () => {
  const now = 10 * H
  let called = 0
  const info = await checkForUpdate({
    cachePath: "unused",
    now: () => now,
    readCache: () => ({ lastAttemptAt: now - H, lastSuccessAt: now - H, latest: "v99.0.0" }),
    writeCache: () => {},
    fetchTag: async () => {
      called++
      return "v0.0.1"
    },
  })
  assert.equal(called, 0)
  assert.deepEqual(info, { latestVersion: "99.0.0", name: "v99.0.0", body: undefined })
})

test("checkForUpdate：失败冷却期内 → 不联网，无上次成功 → 不提示", async () => {
  const now = 10 * H
  let called = 0
  const info = await checkForUpdate({
    cachePath: "unused",
    now: () => now,
    readCache: () => ({ lastAttemptAt: now - 30 * 60 * 1000 }),
    writeCache: () => {},
    fetchTag: async () => {
      called++
      return "v99.0.0"
    },
  })
  assert.equal(called, 0)
  assert.equal(info, undefined)
})

test("checkForUpdate：缓存过期 + 成功 → 联网并落盘（lastSuccessAt=now）", async () => {
  const now = 30 * H
  let written: UpdateCheckCache | undefined
  const info = await checkForUpdate({
    cachePath: "unused",
    now: () => now,
    readCache: () => ({ lastAttemptAt: now - 25 * H, lastSuccessAt: now - 25 * H, latest: "v0.0.1" }),
    writeCache: (_p, c) => {
      written = c
    },
    fetchTag: async () => "v99.0.0",
  })
  assert.deepEqual(written, { lastAttemptAt: now, lastSuccessAt: now, latest: "v99.0.0" })
  assert.deepEqual(info, { latestVersion: "99.0.0", name: "v99.0.0", body: undefined })
})

test("checkForUpdate：缓存过期 + 失败 → 仅更新 lastAttemptAt，保留上次成功值", async () => {
  const now = 30 * H
  let written: UpdateCheckCache | undefined
  const info = await checkForUpdate({
    cachePath: "unused",
    now: () => now,
    readCache: () => ({ lastAttemptAt: now - 25 * H, lastSuccessAt: now - 25 * H, latest: "v99.0.0" }),
    writeCache: (_p, c) => {
      written = c
    },
    fetchTag: async () => undefined,
  })
  assert.deepEqual(written, { lastAttemptAt: now, lastSuccessAt: now - 25 * H, latest: "v99.0.0" })
  assert.deepEqual(info, { latestVersion: "99.0.0", name: "v99.0.0", body: undefined })
})

// ─── index.ts markUpdated（更新成功后清缓存） ───
test("markUpdated：清空 latest + 刷新成功时间 → 不再提示且 24h 内不联网", () => {
  const dir = mkdtempSync(join(tmpdir(), "otu-mark-"))
  try {
    const p = join(dir, "update-check.json")
    writeUpdateCache(p, { lastAttemptAt: 1, lastSuccessAt: 1, latest: "v99.0.0" })
    markUpdated(123, p)
    const cache = readUpdateCache(p)
    assert.deepEqual(cache, { lastAttemptAt: 123, lastSuccessAt: 123, latest: undefined })
    assert.equal(resolveUpdate("2.0.0", cache?.latest), undefined) // 无 latest → 不提示
    assert.equal(isCacheFresh(cache, 123 + 60 * 60 * 1000), true) // 成功 TTL 内 → 不联网
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
