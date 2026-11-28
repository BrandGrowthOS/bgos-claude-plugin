/**
 * Direct uploads up to 200 MB, sent from disk one part at a time.
 *
 * The backend lets an owner's paired agent send a file of up to 200 MB
 * through a direct upload session: POST uploads/sessions answers one signed
 * PUT (a file up to 16 MiB) or one signed URL per part (8 MiB parts for any
 * file this size), each URL bound to its exact length. The client PUTs the
 * bytes straight to storage, then POST uploads/sessions/:id/complete has the
 * server read the stored object back and check its size, type and owner. A
 * board attachment over 25 MB gets the same session inside its attach answer
 * (`{attachmentId, upload}`), and is finished by the session's complete and
 * then the row's own complete.
 *
 * What this module promises:
 *   - the file is never read into memory whole: each part is read from disk
 *     by its byte range, sent, and let go before the next is read, so the
 *     daemon holds at most one part (8 MiB) of a 200 MB file;
 *   - bytes travel only to an https URL, with none of this daemon's headers
 *     (a part URL carries its own signature; the pairing token must never
 *     reach the storage host), and an error never names the signed URL;
 *   - a part that fails is sent again (a lapsed URL, answered 403, is signed
 *     afresh first), and a session that will not complete is cancelled, so a
 *     failed send does not hold one of the person's few open uploads;
 *   - the size refusal is one plain sentence, checked from the size on disk
 *     before anything is read or sent.
 *
 * Raw API keys keep their old limits on the server, so the cap here follows
 * the credential: 200 MB for a pairing, the old caps for an API key.
 */

import { open, readFile, stat } from 'node:fs/promises'
import { boundedFetch, UPLOAD_DEADLINE_MS } from './bounded-fetch.js'

const MB = 1024 * 1024

/** The largest file an owner's paired agent sends (the backend's paired limit). */
export const PAIRED_AGENT_UPLOAD_MAX_BYTES = 200 * MB

/**
 * A chat file sent with an API key keeps the caps it always had: the server
 * keeps raw keys at its defaults, so a larger file would only be refused there.
 */
export const API_KEY_CHAT_LIMITS: Readonly<Record<string, number>> = Object.freeze({
  image: 10 * MB,
  video: 100 * MB,
  audio: 20 * MB,
  document: 25 * MB,
})

/** A board file sent with an API key keeps the board default. */
export const API_KEY_BOARD_MAX_BYTES = 25 * MB

/**
 * The largest single PUT read into memory. The server answers one PUT only up
 * to 16 MiB (its parts start above that); a single PUT for more is refused.
 */
export const SINGLE_PUT_READ_MAX_BYTES = 32 * MB

/** How many times one part is sent before the upload gives up. */
export const PART_ATTEMPTS = 3

/** How many times complete is asked while storage does not show every part yet. */
export const COMPLETE_ATTEMPTS = 4

export type CredentialMode = 'pairing' | 'apiKey'

/** The cap on one chat file this credential sends. */
export function chatUploadLimit(mode: CredentialMode, category: string): number {
  if (mode === 'pairing') return PAIRED_AGENT_UPLOAD_MAX_BYTES
  return API_KEY_CHAT_LIMITS[category] ?? API_KEY_CHAT_LIMITS.document!
}

/** The cap on one board file this credential sends. */
export function boardUploadLimit(mode: CredentialMode): number {
  return mode === 'pairing' ? PAIRED_AGENT_UPLOAD_MAX_BYTES : API_KEY_BOARD_MAX_BYTES
}

/** Whole megabytes for a sentence, never rounding a file just over the cap down to the cap. */
function megabytes(bytes: number): number {
  return Math.ceil(bytes / MB)
}

/** The one plain refusal for a file over the cap. */
export function tooLargeMessage(fileName: string, sizeBytes: number, limitBytes: number): string {
  return (
    `"${fileName}" is ${megabytes(sizeBytes)} MB, over the ${Math.floor(limitBytes / MB)} MB ` +
    'limit on a file you send. Send a smaller file or a link to it.'
  )
}

// ── The session the server answers ───────────────────────────────────────────

export interface UploadPart {
  partNumber: number
  /** The exact byte length the part URL is signed for. */
  size: number
  url: string
}

export interface UploadSession {
  sessionId: string
  mode: 'single' | 'multipart'
  /** Headers the single PUT must send exactly (the signed Content-Type). */
  headers: Record<string, string>
  /** mode single: the one PUT URL. */
  url?: string
  /** mode multipart: every part, in order. */
  parts?: UploadPart[]
}

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * The session as the server answered it, checked against the file it is for:
 * a known id, https URLs only, and parts that cover exactly `size` bytes in
 * order. A string is the reason it is refused; nothing has been sent then.
 */
export function readUploadSession(raw: unknown, size: number): UploadSession | string {
  if (!raw || typeof raw !== 'object') return 'the server did not answer an upload session'
  const r = raw as Record<string, unknown>
  if (typeof r.sessionId !== 'string' || !SESSION_ID.test(r.sessionId)) {
    return 'the server did not answer an upload session'
  }
  const headers: Record<string, string> = {}
  if (r.headers && typeof r.headers === 'object' && !Array.isArray(r.headers)) {
    for (const [name, value] of Object.entries(r.headers as Record<string, unknown>)) {
      if (typeof value === 'string') headers[name] = value
    }
  }
  if (r.mode === 'single') {
    if (!isHttpsUrl(r.url)) return 'the upload url is not https, and file bytes only travel over https'
    return { sessionId: r.sessionId, mode: 'single', headers, url: r.url }
  }
  if (r.mode !== 'multipart' || !Array.isArray(r.parts) || r.parts.length === 0) {
    return 'the server did not answer an upload session'
  }
  const parts: UploadPart[] = []
  let covered = 0
  for (const [i, p] of (r.parts as unknown[]).entries()) {
    const part = p as Record<string, unknown> | null
    if (
      !part ||
      part.partNumber !== i + 1 ||
      !Number.isSafeInteger(part.size) ||
      (part.size as number) < 1
    ) {
      return 'the server answered upload parts that do not cover the file'
    }
    if (!isHttpsUrl(part.url)) return 'an upload url is not https, and file bytes only travel over https'
    parts.push({ partNumber: i + 1, size: part.size as number, url: part.url })
    covered += part.size as number
  }
  if (covered !== size) return 'the server answered upload parts that do not cover the file'
  return { sessionId: r.sessionId, mode: 'multipart', headers, parts }
}

// ── Where the bytes come from ────────────────────────────────────────────────

/** A file's bytes, read by range: never all at once unless they are already in memory. */
export interface UploadSource {
  size: number
  read(start: number, length: number): Promise<Uint8Array>
}

/** Bytes from a file on disk, one range at a time. */
export function fileSource(path: string, size: number): UploadSource {
  return {
    size,
    async read(start, length) {
      const handle = await open(path, 'r')
      try {
        const buffer = new Uint8Array(length)
        let at = 0
        while (at < length) {
          const { bytesRead } = await handle.read(buffer, at, length - at, start + at)
          if (bytesRead === 0) break
          at += bytesRead
        }
        if (at !== length) throw new Error('the file changed size while it was being sent')
        return buffer
      } finally {
        await handle.close()
      }
    },
  }
}

/** Bytes already in memory (content_base64). */
export function bytesSource(bytes: Uint8Array): UploadSource {
  return {
    size: bytes.length,
    async read(start, length) {
      return bytes.subarray(start, start + length)
    },
  }
}

// ── The calls ────────────────────────────────────────────────────────────────

export interface DirectUploadDeps {
  /**
   * A BGOS POST with the agent's own credential and no acting-user header:
   * the session routes act for the credential's owner and nobody else.
   */
  post: (path: string, body: Record<string, unknown>) => Promise<unknown>
  /** A BGOS DELETE, the same credential. Cancelling is best effort. */
  del?: (path: string) => Promise<unknown>
  /** One PUT to a signed URL. Defaults to putToStorage. */
  put?: (url: string, bytes: Uint8Array, headers: Record<string, string>) => Promise<void>
  /** Waits between attempts. Injected in tests. */
  sleep?: (ms: number) => Promise<void>
  log?: (msg: string) => void
}

/** An error from a storage PUT, carrying its status, never its URL. */
export class StorageHttpError extends Error {
  readonly status: number
  constructor(status: number) {
    super(`the storage server answered ${status}`)
    this.name = 'StorageHttpError'
    this.status = status
  }
}

/**
 * The default PUT: bounded by the shared upload deadline, no header of this
 * daemon's, and the label never carries the URL (it is a signed credential).
 */
export async function putToStorage(
  url: string,
  bytes: Uint8Array,
  headers: Record<string, string>,
): Promise<void> {
  await boundedFetch<void, Response>(
    {
      url,
      init: { method: 'PUT', headers: { ...headers }, body: bytes as unknown as BodyInit },
      timeoutMs: UPLOAD_DEADLINE_MS,
      label: `PUT upload part (${bytes.length} bytes)`,
    },
    async (response) => {
      if (!response.ok) {
        await response.text().catch(() => '')
        throw new StorageHttpError(response.status)
      }
    },
  )
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function statusOf(err: unknown): number | null {
  const status = (err as { status?: unknown } | null)?.status
  return typeof status === 'number' ? status : null
}

/** An error's text with every link in it replaced, so a signed URL never reaches the model or a log. */
export function withoutLinks(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  return raw.replace(/https?:\/\/\S+/g, 'the link')
}

async function freshPartUrl(
  sessionId: string,
  partNumber: number,
  deps: DirectUploadDeps,
): Promise<string | null> {
  try {
    const answer = (await deps.post(`uploads/sessions/${sessionId}/parts`, {
      partNumbers: [partNumber],
    })) as { parts?: Array<{ partNumber?: unknown; url?: unknown }> } | null
    const fresh = answer?.parts?.find((p) => p?.partNumber === partNumber)
    return fresh && isHttpsUrl(fresh.url) ? fresh.url : null
  } catch {
    return null
  }
}

/**
 * Send every byte of `source` for an open session, in order, one part at a
 * time. Throws when a part cannot be sent; the caller cancels the session.
 */
export async function sendSessionBytes(
  session: UploadSession,
  source: UploadSource,
  deps: DirectUploadDeps,
): Promise<void> {
  const put = deps.put ?? putToStorage
  const sleep = deps.sleep ?? defaultSleep
  if (session.mode === 'single') {
    // Up to 16 MiB: the one PUT, with the headers it was signed for. A single
    // PUT is read whole, so one for a large file is refused, never read in.
    if (source.size > SINGLE_PUT_READ_MAX_BYTES) {
      throw new Error('the server answered one upload for a file this large; send it again')
    }
    const bytes = await source.read(0, source.size)
    await put(session.url!, bytes, session.headers)
    return
  }
  let start = 0
  for (const part of session.parts!) {
    // Read just this part, send it, and let it go before the next is read.
    const bytes = await source.read(start, part.size)
    let url = part.url
    for (let attempt = 1; ; attempt += 1) {
      try {
        // A part URL signs no header but its length: send none (the app does the same).
        await put(url, bytes, {})
        break
      } catch (err) {
        if (attempt >= PART_ATTEMPTS) throw err
        deps.log?.(`upload part ${part.partNumber}: ${withoutLinks(err)}; sending it again`)
        if (statusOf(err) === 403) {
          // A lapsed URL (they live an hour): sign this part afresh.
          const fresh = await freshPartUrl(session.sessionId, part.partNumber, deps)
          if (fresh) url = fresh
        }
        await sleep(500 * attempt)
      }
    }
    start += part.size
  }
}

function incomplete(err: unknown): boolean {
  if (statusOf(err) !== 409 && !/\b409\b/.test(String((err as Error)?.message ?? ''))) return false
  const text = `${(err as Error)?.message ?? ''} ${String((err as { body?: unknown })?.body ?? '')}`
  return /upload_incomplete|not finished uploading/i.test(text)
}

/** POST uploads/sessions/:id/complete, asked again while storage does not show every part yet. */
export async function completeSession(
  sessionId: string,
  deps: DirectUploadDeps,
): Promise<Record<string, unknown>> {
  const sleep = deps.sleep ?? defaultSleep
  for (let attempt = 1; ; attempt += 1) {
    try {
      const answer = await deps.post(`uploads/sessions/${sessionId}/complete`, {})
      return (answer && typeof answer === 'object' ? answer : {}) as Record<string, unknown>
    } catch (err) {
      if (!incomplete(err) || attempt >= COMPLETE_ATTEMPTS) throw err
      await sleep(1000 * attempt)
    }
  }
}

/** Best effort: free what storage holds for a session that will not complete. */
export async function cancelSession(sessionId: string, deps: DirectUploadDeps): Promise<void> {
  if (!deps.del) return
  try {
    await deps.del(`uploads/sessions/${sessionId}`)
  } catch {
    /* the server sweeps an abandoned session itself */
  }
}

/**
 * Send the bytes for a session that is already open and complete it. On any
 * failure the session is cancelled and the error thrown.
 */
export async function sendAndComplete(
  session: UploadSession,
  source: UploadSource,
  deps: DirectUploadDeps,
): Promise<Record<string, unknown>> {
  try {
    await sendSessionBytes(session, source, deps)
    return await completeSession(session.sessionId, deps)
  } catch (err) {
    await cancelSession(session.sessionId, deps)
    throw err
  }
}

/**
 * A chat file from disk, through POST uploads/sessions: the stored key and the
 * link the message carries. The size was checked against the cap before.
 */
export async function uploadChatFile(
  file: { path: string; fileName: string; contentType: string; size: number },
  deps: DirectUploadDeps,
): Promise<{ s3Key: string; url: string }> {
  const raw = await deps.post('uploads/sessions', {
    fileName: file.fileName,
    contentType: file.contentType,
    size: file.size,
  })
  const session = readUploadSession(raw, file.size)
  if (typeof session === 'string') {
    const id = (raw as { sessionId?: unknown } | null)?.sessionId
    if (typeof id === 'string' && SESSION_ID.test(id)) await cancelSession(id, deps)
    throw new Error(`"${file.fileName}" was not sent: ${session}.`)
  }
  const done = await sendAndComplete(session, fileSource(file.path, file.size), deps)
  const stored = done.file as { url?: unknown; key?: unknown } | null | undefined
  const key = typeof stored?.key === 'string' ? stored.key : typeof done.key === 'string' ? done.key : ''
  if (!key || typeof stored?.url !== 'string' || !stored.url) {
    throw new Error(`"${file.fileName}" was uploaded but the server did not record it. Send it again.`)
  }
  return { s3Key: key, url: stored.url }
}

/**
 * A chat file on this machine, ready for a message: a small one inline, a
 * larger one sent from disk through an upload session. The size on disk is
 * checked against the credential's cap before a byte is read.
 */
export async function sendLocalChatFile(
  file: { path: string; fileName: string; mime: string; category: string },
  opts: { mode: CredentialMode; inlineMaxBytes: number; log?: (msg: string) => void },
  deps: DirectUploadDeps,
): Promise<{ fileData: string; s3Key: string | null }> {
  const info = await stat(file.path)
  if (!info.isFile()) throw new Error(`"${file.path}" is not a file.`)
  const limit = chatUploadLimit(opts.mode, file.category)
  if (info.size > limit) throw new Error(tooLargeMessage(file.fileName, info.size, limit))
  if (info.size <= opts.inlineMaxBytes) {
    const buffer = await readFile(file.path)
    return { fileData: `data:${file.mime};base64,${buffer.toString('base64')}`, s3Key: null }
  }
  opts.log?.(`Uploading ${file.fileName} (${info.size} bytes) from disk...`)
  let sent: { s3Key: string; url: string }
  try {
    sent = await uploadChatFile(
      { path: file.path, fileName: file.fileName, contentType: file.mime, size: info.size },
      deps,
    )
  } catch (err) {
    // A failure from storage or the network can name the signed URL: never pass it on.
    throw new Error(withoutLinks(err))
  }
  return { fileData: sent.url, s3Key: sent.s3Key }
}
