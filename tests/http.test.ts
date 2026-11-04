// ─── shared/http.ts 网络薄层单元测试（替换全局 fetch，零真实网络） ───
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  QuotaRequestError,
  parseRetryAfterMs,
  requestJson,
} from "../.opencode/plugins/opencode-hud/shared/http.ts"

const originalFetch = globalThis.fetch
test.afterEach(() => {
  globalThis.fetch = originalFetch
})

function useFetch(handler: typeof fetch) {
  globalThis.fetch = handler
}

test("请求成功：返回解析后的 JSON", async () => {
  useFetch(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
  assert.deepEqual(await requestJson("https://example.test/usage"), { ok: true })
})

test("401 → login_expired，错误文本先脱敏", async () => {
  useFetch(async () => new Response("bad key sk-secret-123", { status: 401 }))
  await assert.rejects(requestJson("https://example.test/usage", { secrets: ["sk-secret-123"] }), (error: unknown) => {
    assert.ok(error instanceof QuotaRequestError)
    assert.equal(error.code, "login_expired")
    assert.equal(error.status, 401)
    assert.equal(error.message.includes("sk-secret-123"), false)
    assert.match(error.message, /bad key \[redacted\]/)
    return true
  })
})

test("429 → rate_limited，并把 Retry-After 换算成绝对时刻", async () => {
  useFetch(async () => new Response("slow down", { status: 429, headers: { "Retry-After": "7" } }))
  const startedAt = Date.now()
  await assert.rejects(requestJson("https://example.test/usage"), (error: unknown) => {
    assert.ok(error instanceof QuotaRequestError)
    assert.equal(error.code, "rate_limited")
    assert.equal(error.status, 429)
    assert.ok(error.retryAt !== undefined)
    assert.ok(error.retryAt >= startedAt + 6_000)
    assert.ok(error.retryAt <= startedAt + 8_000)
    return true
  })
})

test("超时 → timeout（中止请求，不把挂起留给调用方）", async () => {
  useFetch(() => new Promise<Response>(() => {}))
  await assert.rejects(
    requestJson("https://example.test/usage", { timeoutMs: 20 }),
    (error: unknown) => {
      assert.ok(error instanceof QuotaRequestError)
      assert.equal(error.code, "timeout")
      return true
    },
  )
})

test("响应超过大小上限 → bad_response", async () => {
  useFetch(async () => new Response("0123456789", { headers: { "content-length": "10" } }))
  await assert.rejects(
    requestJson("https://example.test/usage", { maxBytes: 8 }),
    (error: unknown) => {
      assert.ok(error instanceof QuotaRequestError)
      assert.equal(error.code, "bad_response")
      return true
    },
  )
})

test("2xx 但不是 JSON → bad_response", async () => {
  useFetch(async () => new Response("<html>not json</html>", { status: 200 }))
  await assert.rejects(requestJson("https://example.test/usage"), (error: unknown) => {
    assert.ok(error instanceof QuotaRequestError)
    assert.equal(error.code, "bad_response")
    return true
  })
})

test("Retry-After：秒数与 HTTP 日期都换算成等待时长，过期返回 undefined", () => {
  const now = Date.parse("2026-01-01T00:00:00Z")
  assert.equal(parseRetryAfterMs("120", now), 120_000)
  assert.equal(parseRetryAfterMs(new Date(now + 30_000).toUTCString(), now), 30_000)
  assert.equal(parseRetryAfterMs("0", now), undefined)
  assert.equal(parseRetryAfterMs(new Date(now - 1_000).toUTCString(), now), undefined)
  assert.equal(parseRetryAfterMs(null, now), undefined)
})
