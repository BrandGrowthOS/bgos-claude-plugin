/**
 * Read attachments (HOAI row 5b141728, design section 3): an email's files,
 * fetched by this daemon BEFORE the turn and saved on this computer, so the
 * agent reads them with Read and never fetches a stranger's link itself.
 *
 * Only while the owner's switch is on: the server says so per delivery
 * (`readAttachments: true`, lib/inbound-channel.ts readsEmailFiles), and an old
 * backend never says it, so nothing here runs. The builder then writes each
 * file's local path into that file's one `[Attached ...]` line.
 *
 * THESE FILES COME FROM STRANGERS. So:
 *   - the fetch is https only, sends no header of this daemon's (the link is a
 *     presigned one and carries its own authorization; the pairing token must
 *     never reach the storage host), follows no redirect, reads at most 25 MB
 *     (the declared length and the stream are both counted) and has one
 *     deadline for the whole email, short of the self update drain's 45 s;
 *   - the type is read off the bytes and must match the extension of the name
 *     the SERVER gave the file (`attachment-N.ext`): pdf, png, jpg, gif, webp,
 *     txt and csv as clean UTF-8 text, docx and xlsx as a zip whose
 *     [Content_Types].xml names the main part. A plain zip, a macro or template
 *     document, an encrypted entry, a zip64 or multi disk archive, an unsafe or
 *     duplicate entry name, or a content types part that would inflate past a
 *     small cap is refused;
 *   - the save is `~/.bgos-agent/email-files/<assistant id>/<email id>/<name>`
 *     with every segment checked against a strict pattern, private folders
 *     (0o700) and file (0o600), a `.part` file renamed into place, no linked
 *     folder anywhere on the way, and the real path kept inside the root;
 *   - nothing here ever names the link: it is a credential until it expires.
 * A file that fails any of this is simply not saved, and its line says so.
 *
 * The sweep (boot and every 6 hours) deletes what is older than 7 days, never
 * follows a link and enters only the folders this code names.
 *
 * No em or en dashes in this file.
 */
import { randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, readdir, realpath, rename, rm, rmdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { inflateRawSync } from 'node:zlib'

import { boundedFetch } from './bounded-fetch.ts'
import { emailFileEntries, isExternalEmailInbound, readExternalEmailId, readsEmailFiles } from './inbound-channel.ts'
import type { EmailFileSave } from './inbound-channel.ts'
import type { InboundFileLike } from './message-text.ts'

/** One file's cap, the backend's own per email cap. */
export const EMAIL_FILE_MAX_BYTES = 25 * 1024 * 1024
/** What one email may bring in all (originals of 25 MB plus extracted texts). */
export const EMAIL_FILES_TOTAL_BYTES = 50 * 1024 * 1024
/** The backend keeps at most 10 files per email (agent-email-config maxAttachments). */
export const EMAIL_FILES_PER_EMAIL = 10
/** One deadline for every file of one email, well inside UPDATE_DRAIN_TIMEOUT_MS (45 s). */
export const EMAIL_FILES_DEADLINE_MS = 20_000
export const EMAIL_FILES_KEEP_MS = 7 * 24 * 60 * 60 * 1000
export const EMAIL_FILES_SWEEP_MS = 6 * 60 * 60 * 1000

const ASSISTANT_SEGMENT = /^[0-9]{1,20}$/
const EMAIL_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
export const EMAIL_FILE_NAME = /^attachment-[0-9]{1,3}\.(pdf|png|jpg|gif|webp|txt|csv|docx|xlsx)$/
const PART_FILE = /^\.[0-9a-f-]{1,64}\.part$/
/** Names Windows gives to devices, which a folder can never safely carry. */
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/i
/** A root that could not sit inside a file's line: a control, a bracket, a hidden character. */
const UNSAFE_ROOT = /[\u0000-\u001F\u007F-\u009F[\]\p{Cf}\p{Zl}\p{Zp}]/u

/** `~/.bgos-agent/email-files` under the given home. */
export function emailFilesRoot(home: string): string {
  return join(home, '.bgos-agent', 'email-files')
}

// ── the type ─────────────────────────────────────────────────────────────────

type EmailFileType = 'pdf' | 'png' | 'jpg' | 'gif' | 'webp' | 'text' | 'docx' | 'xlsx'

const TYPE_OF_EXTENSION: Record<string, EmailFileType> = {
  pdf: 'pdf', png: 'png', jpg: 'jpg', gif: 'gif', webp: 'webp', txt: 'text', csv: 'text', docx: 'docx', xlsx: 'xlsx',
}

function startsWith(bytes: Uint8Array, prefix: ArrayLike<number>, at = 0): boolean {
  if (bytes.length < at + prefix.length) return false
  for (let i = 0; i < prefix.length; i++) if (bytes[at + i] !== prefix[i]) return false
  return true
}

const ascii = (s: string): number[] => Array.from(s, (c) => c.charCodeAt(0))

/** Valid UTF-8 with no NUL and no control character but tab, newline, form feed and return, not opening as markup. */
function isCleanText(bytes: Uint8Array): boolean {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return false
  }
  if (/[\u0000-\u0008\u000B\u000E-\u001F\u007F-\u009F]/.test(text)) return false
  return !text.replace(/^﻿/, '').trimStart().startsWith('<')
}

const ZIP_ENTRIES_MAX = 2000
const CONTENT_TYPES_PACKED_MAX = 16 * 1024
const CONTENT_TYPES_MAX = 256 * 1024
const DOCX_MAIN = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'
const XLSX_MAIN = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml'

/** An entry name that could leave the archive's root, or hide what it is. */
function unsafeEntryName(name: string): boolean {
  return (
    name === '' ||
    name.startsWith('/') ||
    /[\\:\u0000-\u001F\u007F]/.test(name) ||
    name.split('/').some((seg) => seg === '..' || seg === '.')
  )
}

/**
 * Which office document a zip is, read off its central directory and its
 * [Content_Types].xml, or null. Never more than one small part is inflated,
 * and that one under a cap, so a zip bomb costs nothing.
 */
function officeTypeOf(bytes: Uint8Array): 'docx' | 'xlsx' | null {
  if (!startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let end = -1
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 0xffff); at--) {
    if (view.getUint32(at, true) === 0x06054b50) {
      end = at
      break
    }
  }
  if (end < 0) return null
  const disk = view.getUint16(end + 4, true)
  const diskWithDir = view.getUint16(end + 6, true)
  const onDisk = view.getUint16(end + 8, true)
  const count = view.getUint16(end + 10, true)
  const dirSize = view.getUint32(end + 12, true)
  const dirAt = view.getUint32(end + 16, true)
  // Zip64 and multi disk archives are refused, as the backend refuses them.
  if (disk !== 0 || diskWithDir !== 0 || onDisk !== count || count === 0xffff || dirSize === 0xffffffff || dirAt === 0xffffffff) return null
  if (count > ZIP_ENTRIES_MAX || dirAt + dirSize > end) return null
  const names = new Set<string>()
  let contentTypes: { method: number; packed: number; size: number; local: number } | null = null
  let at = dirAt
  for (let n = 0; n < count; n++) {
    if (at + 46 > end || view.getUint32(at, true) !== 0x02014b50) return null
    const flags = view.getUint16(at + 8, true)
    const method = view.getUint16(at + 10, true)
    const packed = view.getUint32(at + 20, true)
    const size = view.getUint32(at + 24, true)
    const nameLength = view.getUint16(at + 28, true)
    const extraLength = view.getUint16(at + 30, true)
    const commentLength = view.getUint16(at + 32, true)
    const local = view.getUint32(at + 42, true)
    if (at + 46 + nameLength > end) return null
    const name = new TextDecoder('utf-8').decode(bytes.subarray(at + 46, at + 46 + nameLength))
    const folded = name.toLowerCase()
    if (flags & 0x1) return null // encrypted
    if (unsafeEntryName(name) || names.has(folded)) return null
    if (folded.includes('vbaproject') || folded.startsWith('activex/') || folded.includes('/activex/')) return null
    names.add(folded)
    if (name === '[Content_Types].xml') contentTypes = { method, packed, size, local }
    at += 46 + nameLength + extraLength + commentLength
  }
  if (!contentTypes) return null
  if (contentTypes.packed > CONTENT_TYPES_PACKED_MAX || contentTypes.size > CONTENT_TYPES_MAX) return null
  const local = contentTypes.local
  if (local + 30 > bytes.length || view.getUint32(local, true) !== 0x04034b50) return null
  const dataAt = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true)
  if (dataAt + contentTypes.packed > bytes.length) return null
  const packed = bytes.subarray(dataAt, dataAt + contentTypes.packed)
  let raw: Uint8Array
  try {
    if (contentTypes.method === 0) raw = packed
    else if (contentTypes.method === 8) raw = inflateRawSync(packed, { maxOutputLength: CONTENT_TYPES_MAX })
    else return null
  } catch {
    return null
  }
  if (raw.length !== contentTypes.size || raw.length > CONTENT_TYPES_MAX) return null
  let xml: string
  try {
    xml = new TextDecoder('utf-8', { fatal: true }).decode(raw)
  } catch {
    return null
  }
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) return null
  if (/macroEnabled|vbaProject|activeX/i.test(xml)) return null
  let docx = false
  let xlsx = false
  for (const m of xml.matchAll(/<Override\b[^>]*>/g)) {
    const part = /\bPartName="([^"]*)"/.exec(m[0])?.[1]
    const type = /\bContentType="([^"]*)"/.exec(m[0])?.[1]
    if (part === '/word/document.xml' && type === DOCX_MAIN) docx = true
    if (part === '/xl/workbook.xml' && type === XLSX_MAIN) xlsx = true
  }
  if (docx === xlsx) return null
  if (docx && !names.has('word/document.xml')) return null
  if (xlsx && !names.has('xl/workbook.xml')) return null
  return docx ? 'docx' : 'xlsx'
}

function isType(bytes: Uint8Array, type: EmailFileType): boolean {
  switch (type) {
    case 'pdf':
      return startsWith(bytes, ascii('%PDF-'))
    case 'png':
      return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    case 'jpg':
      return startsWith(bytes, [0xff, 0xd8, 0xff])
    case 'gif':
      return startsWith(bytes, ascii('GIF87a')) || startsWith(bytes, ascii('GIF89a'))
    case 'webp':
      return startsWith(bytes, ascii('RIFF')) && startsWith(bytes, ascii('WEBP'), 8)
    case 'text':
      return isCleanText(bytes)
    case 'docx':
    case 'xlsx':
      return officeTypeOf(bytes) === type
  }
}

/**
 * Are these bytes what the server's name says (`attachment-N.<ext>`)? The
 * name must be one this code writes, and the bytes must be that type.
 */
export function emailFileMatchesName(bytes: Uint8Array, name: string): boolean {
  const ext = EMAIL_FILE_NAME.exec(name)?.[1]
  const type = ext ? TYPE_OF_EXTENSION[ext] : undefined
  return type !== undefined && isType(bytes, type)
}

// ── the fetch ────────────────────────────────────────────────────────────────

/** The response this needs, narrower than the DOM one so a test can stand in for it. */
interface EmailFileResponse {
  ok: boolean
  status: number
  headers: { get(name: string): string | null }
  body?: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void> } } | null
  arrayBuffer?: () => Promise<ArrayBuffer>
}

export type EmailFileFetch = (url: string, init: RequestInit) => Promise<EmailFileResponse>

/** An error's message with every link replaced: a signed link is a credential. */
function withoutLinks(err: unknown, url: string): string {
  const raw = err instanceof Error ? err.message : String(err)
  return raw.split(url).join('the link').replace(/[a-z][a-z0-9+.-]*:\/\/\S*/gi, 'the link')
}

/**
 * Fetch one email file: an https link only, GET with no header and no
 * redirect, at most `maxBytes` (the declared length is refused before the body
 * is read, a body that runs past it is cut off), under `timeoutMs` for the
 * headers and the body together. Errors never name the link.
 */
export async function downloadEmailFile(
  url: string,
  opts: { fetchImpl?: EmailFileFetch; timeoutMs: number; maxBytes?: number; log?: (line: string) => void },
): Promise<Uint8Array> {
  let https = false
  try {
    const parsed = new URL(url)
    https = parsed.protocol === 'https:' && parsed.hostname !== '' && parsed.username === '' && parsed.password === ''
  } catch {
    https = false
  }
  if (!https) throw new Error('refused: only an https link is fetched')
  const maxBytes = opts.maxBytes ?? EMAIL_FILE_MAX_BYTES
  const tooLarge = () => new Error(`the file is too large (over ${maxBytes} bytes)`)
  try {
    return await boundedFetch<Uint8Array, EmailFileResponse>(
      {
        url,
        init: { method: 'GET', redirect: 'error', headers: {} },
        timeoutMs: opts.timeoutMs,
        // Never the link: it is signed.
        label: 'GET email file',
      },
      async (response) => {
        if (!response.ok) throw new Error(`the storage server answered ${response.status}`)
        const declared = Number(response.headers.get('content-length') ?? '')
        if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge()
        if (!response.body) {
          const whole = new Uint8Array(await (response.arrayBuffer?.() ?? Promise.resolve(new ArrayBuffer(0))))
          if (whole.byteLength > maxBytes) throw tooLarge()
          return whole
        }
        const reader = response.body.getReader()
        const chunks: Uint8Array[] = []
        let total = 0
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (!value) continue
          total += value.byteLength
          if (total > maxBytes) {
            await reader.cancel().catch(() => {})
            throw tooLarge()
          }
          chunks.push(value)
        }
        const bytes = new Uint8Array(total)
        let at = 0
        for (const chunk of chunks) {
          bytes.set(chunk, at)
          at += chunk.byteLength
        }
        return bytes
      },
      { fetchImpl: opts.fetchImpl as never, log: opts.log },
    )
  } catch (err) {
    throw new Error(withoutLinks(err, url))
  }
}

// ── the save ─────────────────────────────────────────────────────────────────

/** A folder this code writes through must be a real folder, never a link to somewhere else. */
async function refuseLinkedFolder(path: string): Promise<void> {
  let info
  try {
    info = await lstat(path)
  } catch {
    return // not there yet: mkdir makes it a real folder
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error('the folder for email files is a link or not a folder, so nothing was written')
  }
}

async function makeFolder(path: string): Promise<void> {
  await refuseLinkedFolder(path)
  try {
    await mkdir(path, { mode: 0o700 })
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') throw err
  }
  await refuseLinkedFolder(path)
}

/**
 * Save one email file at `<root>/<assistantId>/<emailId>/<name>` and answer
 * that path. Every segment must match its pattern, every folder on the way
 * must be a real one (never a link), the email's folder must resolve inside
 * the root, and the file lands by renaming a private `.part` file, so a reader
 * never sees half of it.
 */
export async function saveEmailFile(
  root: string,
  assistantId: string,
  emailId: string,
  name: string,
  bytes: Uint8Array,
): Promise<string> {
  if (
    !ASSISTANT_SEGMENT.test(assistantId) ||
    !EMAIL_SEGMENT.test(emailId) ||
    WINDOWS_DEVICE.test(emailId) ||
    !EMAIL_FILE_NAME.test(name)
  ) {
    throw new Error('refused: a name this code does not write')
  }
  if (!isAbsolute(root) || UNSAFE_ROOT.test(root)) throw new Error('refused: the email files folder is not a plain absolute path')
  // ~/.bgos-agent, the root, the assistant's folder and the email's: a link
  // planted at any of them would carry the write, and the chmod, elsewhere.
  await refuseLinkedFolder(dirname(root))
  await refuseLinkedFolder(root)
  await mkdir(root, { recursive: true, mode: 0o700 })
  await refuseLinkedFolder(root)
  const assistantDir = join(root, assistantId)
  await makeFolder(assistantDir)
  const folder = join(assistantDir, emailId)
  await makeFolder(folder)
  if ((await realpath(folder)) !== join(await realpath(root), assistantId, emailId)) {
    throw new Error('the folder for this email resolved somewhere else, so nothing was written')
  }
  // mkdir's mode only applies to a folder it creates: tighten ones that exist.
  if (process.platform !== 'win32') {
    for (const dir of [root, assistantDir, folder]) await chmod(dir, 0o700)
  }
  const target = join(folder, name)
  const part = join(folder, `.${randomUUID()}.part`)
  try {
    await writeFile(part, bytes, { mode: 0o600, flag: 'wx' })
    await rename(part, target)
  } catch (err) {
    await rm(part, { force: true }).catch(() => {})
    throw err
  }
  return target
}

// ── one email ────────────────────────────────────────────────────────────────

/** Should a lane fetch this delivery's files before the turn? An email, the switch on, a file. */
export function emailFilesWanted(record: unknown, files: unknown): boolean {
  return Array.isArray(files) && files.length > 0 && isExternalEmailInbound(record) && readsEmailFiles(record)
}

/**
 * Fetch and save every file of one email, in order, and answer one entry per
 * file (the order of lib/inbound-channel.ts emailFileEntries, which the
 * builder reads): its saved path, or null when it was not saved. Never throws
 * and never runs past `deadlineMs` for the whole email, so a lane awaiting it
 * is held for a bounded time and the self update drain is never stuck. Only
 * the first EMAIL_FILES_PER_EMAIL files are fetched, and EMAIL_FILES_TOTAL_BYTES
 * in all.
 */
export async function prepareEmailFiles(opts: {
  root: string
  assistantId: string | number
  record: unknown
  files: InboundFileLike[]
  fetchImpl?: EmailFileFetch
  deadlineMs?: number
  log?: (line: string) => void
}): Promise<Array<EmailFileSave | null>> {
  const log = opts.log ?? (() => {})
  let entries: ReturnType<typeof emailFileEntries> = []
  try {
    entries = emailFileEntries(Array.isArray(opts.files) ? opts.files : [])
  } catch {
    return []
  }
  const saves: Array<EmailFileSave | null> = entries.map(() => null)
  const emailId = readExternalEmailId(opts.record)
  const assistantId = String(opts.assistantId)
  if (!emailId || !ASSISTANT_SEGMENT.test(assistantId)) {
    log(`email files: none saved: ${emailId ? 'the assistant id is not a number' : 'the delivery names no email id'}`)
    return saves
  }
  const until = Date.now() + (opts.deadlineMs ?? EMAIL_FILES_DEADLINE_MS)
  let budget = EMAIL_FILES_TOTAL_BYTES
  for (let i = 0; i < entries.length && i < EMAIL_FILES_PER_EMAIL; i++) {
    const f = entries[i]!
    if (!EMAIL_FILE_NAME.test(f.name)) {
      log(`email files: file ${i + 1} not saved: not a name the server gives`)
      continue
    }
    if (!/^https:\/\//i.test(f.ref)) {
      log(`email files: ${f.name} not saved: no https link`)
      continue
    }
    const left = until - Date.now()
    if (left <= 0 || budget <= 0) {
      log(`email files: ${f.name} not saved: ${left <= 0 ? 'out of time for this email' : 'over the size for this email'}`)
      continue
    }
    try {
      const bytes = await downloadEmailFile(f.ref, {
        fetchImpl: opts.fetchImpl,
        timeoutMs: left,
        maxBytes: Math.min(EMAIL_FILE_MAX_BYTES, budget),
      })
      if (!emailFileMatchesName(bytes, f.name)) {
        log(`email files: ${f.name} not saved: its bytes are not what its name says`)
        continue
      }
      budget -= bytes.byteLength
      saves[i] = { path: await saveEmailFile(opts.root, assistantId, emailId, f.name, bytes) }
    } catch (err) {
      log(`email files: ${f.name} not saved: ${withoutLinks(err, f.ref)}`)
    }
  }
  return saves
}

// ── the sweep ────────────────────────────────────────────────────────────────

/** A folder's entries, or none when it is missing, unreadable, or a link (never read through one). */
async function entriesOf(dir: string) {
  try {
    const info = await lstat(dir)
    if (info.isSymbolicLink() || !info.isDirectory()) return []
    return await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

/**
 * Delete saved email files older than `keepMs` (and leftover `.part` files),
 * then the folders they leave empty. Enters only `<root>/<digits>/<email id>`,
 * never follows a link (a link found there is removed itself, whatever it
 * points at is left alone) and leaves every other name alone. Best effort;
 * answers how many entries it removed.
 */
export async function sweepEmailFiles(
  root: string,
  now: number = Date.now(),
  keepMs: number = EMAIL_FILES_KEEP_MS,
): Promise<number> {
  let removed = 0
  const removeLink = async (path: string) => {
    await rm(path, { force: true }).catch(() => {})
    removed++
  }
  for (const assistant of await entriesOf(root)) {
    if (!ASSISTANT_SEGMENT.test(assistant.name)) continue
    const assistantDir = join(root, assistant.name)
    if (assistant.isSymbolicLink()) {
      await removeLink(assistantDir)
      continue
    }
    if (!assistant.isDirectory()) continue
    for (const email of await entriesOf(assistantDir)) {
      if (!EMAIL_SEGMENT.test(email.name)) continue
      const folder = join(assistantDir, email.name)
      if (email.isSymbolicLink()) {
        await removeLink(folder)
        continue
      }
      if (!email.isDirectory()) continue
      for (const entry of await entriesOf(folder)) {
        const path = join(folder, entry.name)
        try {
          const info = await lstat(path)
          if (info.isSymbolicLink()) {
            await removeLink(path)
          } else if (info.isFile() && (EMAIL_FILE_NAME.test(entry.name) || PART_FILE.test(entry.name)) && now - info.mtimeMs > keepMs) {
            await rm(path, { force: true })
            removed++
          }
        } catch {
          /* gone already */
        }
      }
      await rmdir(folder).catch(() => {}) // only when empty
    }
    await rmdir(assistantDir).catch(() => {}) // only when empty
  }
  return removed
}
