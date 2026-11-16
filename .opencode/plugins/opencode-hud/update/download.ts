// ─── 有界流式下载：边写盘边算 SHA256，任何失败都不留半成品 ───
import { createHash } from "crypto"
import { createWriteStream, rmSync } from "fs"
import { Readable, Transform } from "stream"
import { pipeline } from "stream/promises"

export type DownloadResult =
  | { ok: true; path: string; bytes: number; sha256: string }
  | { ok: false; message: string }

export type TextResult = { ok: true; text: string } | { ok: false; message: string }

export type DownloadOptions = {
  maxBytes: number
  timeoutMs: number
  fetchImpl?: typeof fetch
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function removePartial(path: string): void {
  try {
    rmSync(path, { force: true })
  } catch {
    // 半成品清理失败不能掩盖真正的下载失败原因
  }
}

function contentLengthOf(response: Response): number | undefined {
  const raw = response.headers.get("content-length")
  if (raw === null) return undefined
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : undefined
}

function openRequest(
  url: string,
  opts: DownloadOptions,
): { controller: AbortController; timer: ReturnType<typeof setTimeout>; response: Promise<Response> } {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs)
  let response: Promise<Response>
  try {
    response = (opts.fetchImpl ?? fetch)(url, {
      redirect: "follow", // 资产会跳到对象存储；信任边界由 checksum 决定
      headers: { "User-Agent": "opencode-hud" },
      signal: controller.signal,
    })
  } catch (error) {
    response = Promise.reject(error)
  }
  return { controller, timer, response }
}

export async function downloadFile(url: string, dest: string, opts: DownloadOptions): Promise<DownloadResult> {
  const { controller, timer, response } = openRequest(url, opts)
  const hash = createHash("sha256")
  let bytes = 0
  let result: DownloadResult
  try {
    const res = await response
    if (!res.ok) {
      await res.body?.cancel().catch(() => {})
      return { ok: false, message: `HTTP ${res.status}` }
    }
    const declared = contentLengthOf(res)
    if (declared !== undefined && declared > opts.maxBytes) {
      await res.body?.cancel().catch(() => {})
      return { ok: false, message: `下载内容超过上限（${opts.maxBytes} 字节）` }
    }
    const body = res.body ? Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]) : Readable.from([])
    const limiter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length
        if (bytes > opts.maxBytes) {
          callback(new Error(`下载内容超过上限（${opts.maxBytes} 字节）`))
          return
        }
        hash.update(chunk)
        callback(null, chunk)
      },
    })
    await pipeline(body, limiter, createWriteStream(dest))
    result = { ok: true, path: dest, bytes, sha256: hash.digest("hex") }
  } catch (error) {
    const message = controller.signal.aborted
      ? `下载超时（${Math.round(opts.timeoutMs / 1000)}s）`
      : errorMessage(error)
    result = { ok: false, message }
  } finally {
    clearTimeout(timer)
  }
  if (!result.ok) removePartial(dest)
  return result
}

export async function fetchText(url: string, opts: DownloadOptions): Promise<TextResult> {
  const { controller, timer, response } = openRequest(url, opts)
  let result: TextResult
  try {
    const res = await response
    if (!res.ok) {
      await res.body?.cancel().catch(() => {})
      return { ok: false, message: `HTTP ${res.status}` }
    }
    const declared = contentLengthOf(res)
    if (declared !== undefined && declared > opts.maxBytes) {
      await res.body?.cancel().catch(() => {})
      return { ok: false, message: `内容超过上限（${opts.maxBytes} 字节）` }
    }
    const chunks: Buffer[] = []
    let bytes = 0
    if (res.body) {
      for await (const chunk of Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0])) {
        const buffer = Buffer.from(chunk as Uint8Array)
        bytes += buffer.length
        if (bytes > opts.maxBytes) return { ok: false, message: `内容超过上限（${opts.maxBytes} 字节）` }
        chunks.push(buffer)
      }
    }
    result = { ok: true, text: Buffer.concat(chunks).toString("utf8") }
  } catch (error) {
    const message = controller.signal.aborted
      ? `下载超时（${Math.round(opts.timeoutMs / 1000)}s）`
      : errorMessage(error)
    result = { ok: false, message }
  } finally {
    clearTimeout(timer)
  }
  return result
}
