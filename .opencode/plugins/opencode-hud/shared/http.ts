// ─── 通用网络薄层：额度请求的超时/中止、大小上限、Retry-After、错误归类与脱敏 ───
// 供应商只负责「把响应映射成 QuotaData」；失败如何分类、文案是否带密钥都在这里收口。
// 错误文本在返回前先脱敏再截断，调用方拿到的 message 可以直接进 console 面板。
export type QuotaErrorCode =
  | "login_expired"
  | "rate_limited"
  | "timeout"
  | "network"
  | "provider_error"
  | "bad_response"

// 额度接口都很小；超时与上限按「最坏情况也不拖住插件」取值。
export const REQUEST_TIMEOUT_MS = 5_000
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024
const RETRY_AFTER_MAX_MS = 24 * 60 * 60_000
const DETAIL_MAX_LENGTH = 300

export class QuotaRequestError extends Error {
  readonly code: QuotaErrorCode
  readonly status?: number
  /** Retry-After 换算出的绝对时刻；响应没给则为 undefined。 */
  readonly retryAt?: number

  constructor(
    message: string,
    code: QuotaErrorCode,
    facts: { status?: number; retryAt?: number } = {},
  ) {
    super(message)
    this.name = "QuotaRequestError"
    this.code = code
    if (facts.status !== undefined) this.status = facts.status
    if (facts.retryAt !== undefined) this.retryAt = facts.retryAt
  }
}

export type RequestJsonOptions = {
  method?: "GET" | "POST"
  headers?: Record<string, string>
  body?: string
  redirect?: RequestRedirect
  /** 绝不能出现在错误文案里的值（API key / token）。 */
  secrets?: readonly (string | undefined)[]
  timeoutMs?: number
  maxBytes?: number
}

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

// 先替换密钥，再压成单行并截断：截断发生在脱敏之后，避免把密钥切成半截漏出去。
export function redactSecrets(text: string, secrets: readonly (string | undefined)[]): string {
  let cleaned = text
  for (const secret of secrets) {
    if (secret) cleaned = cleaned.split(secret).join("[redacted]")
  }
  cleaned = cleaned.replace(/[\u0000-\u001f\u007f]+/g, " ").trim()
  return cleaned.length > DETAIL_MAX_LENGTH
    ? `${cleaned.slice(0, DETAIL_MAX_LENGTH - 1)}…`
    : cleaned
}

/** Retry-After（秒数或 HTTP 日期）换算成等待时长，上限一天；缺失/过期/非法 → undefined。 */
export function parseRetryAfterMs(
  value: string | null,
  nowMs: number = Date.now(),
): number | undefined {
  const text = value?.trim()
  if (!text) return undefined
  const ms = /^\d+$/.test(text) ? Number(text) * 1_000 : Date.parse(text) - nowMs
  return Number.isFinite(ms) && ms > 0 ? Math.min(ms, RETRY_AFTER_MAX_MS) : undefined
}

function codeForStatus(status: number): QuotaErrorCode {
  if (status === 401) return "login_expired"
  if (status === 429) return "rate_limited"
  return "provider_error"
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {})
    throw new QuotaRequestError(`response exceeded ${maxBytes} bytes`, "bad_response")
  }
  if (!response.body) return ""

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ""
  let received = 0
  try {
    for (let next = await reader.read(); !next.done; next = await reader.read()) {
      received += next.value.byteLength
      if (received > maxBytes) {
        await reader.cancel().catch(() => {})
        throw new QuotaRequestError(`response exceeded ${maxBytes} bytes`, "bad_response")
      }
      text += decoder.decode(next.value, { stream: true })
    }
    return text + decoder.decode()
  } finally {
    reader.releaseLock()
  }
}

/**
 * 一次带超时与大小上限的 JSON 请求；失败抛 QuotaRequestError。
 * 401 → login_expired，429 → rate_limited（带 Retry-After），其它非 2xx → provider_error，
 * 响应体超限或不是 JSON → bad_response。
 */
export async function requestJson(url: string, options: RequestJsonOptions = {}): Promise<unknown> {
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS
  const maxBytes = options.maxBytes ?? MAX_RESPONSE_BYTES
  const secrets = (options.secrets ?? []).filter((secret): secret is string => Boolean(secret))
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new QuotaRequestError(`request timeout after ${Math.round(timeoutMs / 1_000)}s`, "timeout"))
    }, timeoutMs)
  })

  const transaction = (async () => {
    let response: Response
    try {
      response = await fetch(url, {
        ...(options.method ? { method: options.method } : {}),
        ...(options.headers ? { headers: options.headers } : {}),
        ...(options.body !== undefined ? { body: options.body } : {}),
        ...(options.redirect ? { redirect: options.redirect } : {}),
        signal: controller.signal,
      })
    } catch (error) {
      throw new QuotaRequestError(redactSecrets(errorText(error), secrets), "network")
    }

    if (!response.ok) {
      const detail = await readBoundedText(response, maxBytes).then(
        (text) => redactSecrets(text, secrets),
        () => "",
      )
      const retryAfterMs = parseRetryAfterMs(response.headers.get("Retry-After"))
      throw new QuotaRequestError(
        `quota ${response.status}${detail ? `: ${detail}` : ""}`,
        codeForStatus(response.status),
        {
          status: response.status,
          ...(retryAfterMs === undefined ? {} : { retryAt: Date.now() + retryAfterMs }),
        },
      )
    }

    const text = await readBoundedText(response, maxBytes)
    try {
      return JSON.parse(text) as unknown
    } catch {
      throw new QuotaRequestError("response is not valid JSON", "bad_response", {
        status: response.status,
      })
    }
  })()

  try {
    return await Promise.race([transaction, timeout])
  } finally {
    clearTimeout(timer)
  }
}
