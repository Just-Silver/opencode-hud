// ─── update/download.ts：有界流式下载（mock fetch，零网络） ───
import { test } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "crypto"
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { downloadFile, fetchText } from "../.opencode/plugins/opencode-hud/update/download.ts"

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex")

function streamResponse(chunks: Uint8Array[], opts: { status?: number; contentLength?: number } = {}): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
  const headers: Record<string, string> = {}
  if (opts.contentLength !== undefined) headers["content-length"] = String(opts.contentLength)
  return new Response(body, { status: opts.status ?? 200, headers })
}

test("分块下载边写边算 SHA256，成功不留半成品", async () => {
  const root = mkdtempSync(join(tmpdir(), "otu-dl-"))
  const dest = join(root, "asset.tar.gz")
  const url = "https://example.test/asset.tar.gz"
  const chunks = [Buffer.from("0123456789"), Buffer.from("abcdefghij"), Buffer.from("XYZ")]
  const expected = Buffer.concat(chunks)
  let seenUrl = ""
  try {
    const result = await downloadFile(url, dest, {
      maxBytes: 1024,
      timeoutMs: 5000,
      fetchImpl: (async (input: unknown) => {
        seenUrl = String(input)
        return streamResponse(chunks, { contentLength: expected.length })
      }) as unknown as typeof fetch,
    })
    assert.deepEqual(result, { ok: true, path: dest, bytes: expected.length, sha256: sha256(expected) })
    assert.equal(seenUrl, url)
    assert.deepEqual(readFileSync(dest), expected)
    assert.deepEqual(readdirSync(root), ["asset.tar.gz"])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("超过压缩上限立即中止并删除半成品（无 Content-Length 也生效）", async () => {
  const root = mkdtempSync(join(tmpdir(), "otu-dl-"))
  try {
    const declaredUrl = "https://example.test/declared.bin"
    const declared = join(root, "declared.bin")
    let declaredSeen = ""
    const byHeader = await downloadFile(declaredUrl, declared, {
      maxBytes: 10,
      timeoutMs: 5000,
      fetchImpl: (async (input: unknown) => {
        declaredSeen = String(input)
        return streamResponse([Buffer.alloc(4)], { contentLength: 11 })
      }) as unknown as typeof fetch,
    })
    assert.equal(byHeader.ok, false)
    assert.equal(declaredSeen, declaredUrl)
    assert.equal(existsSync(declared), false)

    const undeclaredUrl = "https://example.test/undeclared.bin"
    const undeclared = join(root, "undeclared.bin")
    let undeclaredSeen = ""
    const byStream = await downloadFile(undeclaredUrl, undeclared, {
      maxBytes: 10,
      timeoutMs: 5000,
      fetchImpl: (async (input: unknown) => {
        undeclaredSeen = String(input)
        return streamResponse([Buffer.alloc(6), Buffer.alloc(6)])
      }) as unknown as typeof fetch,
    })
    assert.equal(byStream.ok, false)
    if (!byStream.ok) assert.ok(byStream.message.includes("上限"), byStream.message)
    assert.equal(undeclaredSeen, undeclaredUrl)
    assert.equal(existsSync(undeclared), false)
    assert.deepEqual(readdirSync(root), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("非 2xx / 超时 / 写盘失败 → 失败且清理", async () => {
  const root = mkdtempSync(join(tmpdir(), "otu-dl-"))
  try {
    const notFoundUrl = "https://example.test/not-found.bin"
    const notFound = join(root, "404.bin")
    let notFoundSeen = ""
    const res404 = await downloadFile(notFoundUrl, notFound, {
      maxBytes: 1024,
      timeoutMs: 5000,
      fetchImpl: (async (input: unknown) => {
        notFoundSeen = String(input)
        return new Response("no", { status: 404 })
      }) as unknown as typeof fetch,
    })
    assert.equal(res404.ok, false)
    if (!res404.ok) assert.ok(res404.message.includes("404"), res404.message)
    assert.equal(notFoundSeen, notFoundUrl)
    assert.equal(existsSync(notFound), false)

    const timeoutUrl = "https://example.test/timeout.bin"
    const timedOut = join(root, "timeout.bin")
    let timeoutSeen = ""
    const resTimeout = await downloadFile(timeoutUrl, timedOut, {
      maxBytes: 1024,
      timeoutMs: 20,
      fetchImpl: ((input: unknown, init?: { signal?: AbortSignal }) => {
        timeoutSeen = String(input)
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))
        })
      }) as unknown as typeof fetch,
    })
    assert.equal(resTimeout.ok, false)
    if (!resTimeout.ok) assert.ok(resTimeout.message.includes("超时"), resTimeout.message)
    assert.equal(timeoutSeen, timeoutUrl)
    assert.equal(existsSync(timedOut), false)

    const unwritableUrl = "https://example.test/unwritable.bin"
    const unwritable = join(root, "missing-dir", "asset.bin")
    let unwritableSeen = ""
    const resWrite = await downloadFile(unwritableUrl, unwritable, {
      maxBytes: 1024,
      timeoutMs: 5000,
      fetchImpl: (async (input: unknown) => {
        unwritableSeen = String(input)
        return streamResponse([Buffer.from("x")])
      }) as unknown as typeof fetch,
    })
    assert.equal(resWrite.ok, false)
    assert.equal(unwritableSeen, unwritableUrl)
    assert.equal(existsSync(unwritable), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("fetchText：返回文本且超过上限即失败", async () => {
  const ok = await fetchText("https://example.test/checksum", {
    maxBytes: 100,
    timeoutMs: 5000,
    fetchImpl: (async () => new Response("hello\n", { status: 200 })) as unknown as typeof fetch,
  })
  assert.deepEqual(ok, { ok: true, text: "hello\n" })

  const tooBig = await fetchText("https://example.test/checksum", {
    maxBytes: 4,
    timeoutMs: 5000,
    fetchImpl: (async () => new Response("hello\n", { status: 200 })) as unknown as typeof fetch,
  })
  assert.equal(tooBig.ok, false)
})
