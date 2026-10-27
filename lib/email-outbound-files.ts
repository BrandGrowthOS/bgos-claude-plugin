// ── Agent email files, outbound: the plugin's check of every file to attach ──
//
// HOAI row 5b141728, step 2 (DESIGN-OUT.md D7, rule 4). email_draft and
// email_send take `files: [{ path }]`. Rule 1 follows the agent's usual send
// setting, so in Send for me with Always ask off nothing after this file and
// rule 2's turn check stops a file going out: this file is where a key, a
// password store or a sign in file is refused, before any byte is read.
//
// Each path goes through four steps, in this order:
//   1. a lexical refusal BEFORE any file system call: not a full path, a
//      network (UNC) or device path (\\host, //host, \\?\, \\.\, a Windows
//      device name, a stream after a colon), a Unix system folder (/proc,
//      /dev, /sys, /etc). A stat of \\host\share on Windows opens an SMB
//      connection and can hand the user's NTLM hash to that host (G2), so
//      nothing here may touch such a path;
//   2. backslashes read as slashes, then the secret list
//      (OUTBOUND_SECRET_PATTERNS) and lanePathIsSecret (lib/hard-floor-lane.mjs,
//      which splits on slashes only, so it is always handed the forward slash
//      form: G1);
//   3. realpath.native, then steps 1 and 2 again on the real path: a link in
//      a plain folder that leads into ~/.aws is caught here;
//   4. a regular file, read through one open handle checked against the
//      stat, at most 25 MB each and 25 MB in all, at most 10, and its bytes
//      the type its name says, on the same safe list as an inbound file
//      (lib/email-files.ts isType).
//
// Every refusal is one plain sentence that names the file and says why. The
// file system functions are injected (ctx.fs), so a test proves that a
// network path met no file system call at all. The backend checks the type,
// the size and the count again and scans every file (rule 3): this is the
// first wall, not the only one.
//
// No em or en dashes in this file.

import { realpath as realpathCallback } from 'node:fs'
import { lstat as lstatPromise, open as openPromise, realpath as realpathPromise } from 'node:fs/promises'
import { homedir } from 'node:os'

import { isType, TYPE_OF_EXTENSION, type EmailFileType } from './email-files.ts'
import { parsePreviewObject } from './email-send-approval.ts'
import { lanePathIsSecret } from './hard-floor-lane.mjs'

/** At most this many files go with one email (the backend's AGENT_EMAIL_OUTBOUND_MAX_FILES). */
export const AGENT_EMAIL_OUTBOUND_MAX_FILES = 10
/** At most this many bytes, each file and all of them together (the backend's AGENT_EMAIL_OUTBOUND_MAX_BYTES). */
export const AGENT_EMAIL_OUTBOUND_MAX_BYTES = 25 * 1024 * 1024

const MB = 1024 * 1024

/**
 * THE SECRET LIST (rule 4), read on the lower case, forward slash, resolved
 * form of a path (`c:/users/kc/.ssh/id_rsa`, `/home/kc/.aws/config`). Any
 * match refuses the file. lanePathIsSecret runs beside it and adds
 * .config/gcloud, .bgos-plugin-state, another person's lane and any `..` that
 * climbs out. One list, so a test can empty it and see the refusals go.
 */
export const OUTBOUND_SECRET_PATTERNS: readonly RegExp[] = Object.freeze([
  // .env, .env.local, .envrc: any segment.
  /(?:^|\/)\.env[^/]*(?:\/|$)/,
  // Key and cloud folders.
  /(?:^|\/)\.(?:ssh|aws|gnupg|azure|kube|docker|password-store)(?:\/|$)/,
  // A git folder: its config can hold a token, its objects the whole history.
  /(?:^|\/)\.git(?:\/|$)/,
  // Key and certificate files.
  /\.(?:pem|key|p12|pfx|ppk|kdbx|keystore|jks)$/,
  // id_rsa, id_ed25519, id_ecdsa.pub: anywhere, not only in .ssh.
  /(?:^|\/)id_[^/]*$/,
  // credentials, credentials.csv, credentials.json.
  /(?:^|\/)credentials[^/]*$/,
  // Password files of common tools.
  /(?:^|\/)\.(?:netrc|npmrc|pypirc|pgpass|git-credentials)$/,
  // Browser profile stores: Chrome, Edge, Brave and Chromium keep every profile under "User Data" on Windows.
  /(?:^|\/)user data(?:\/|$)/,
  /(?:^|\/)firefox\/profiles(?:\/|$)/,
  /(?:^|\/)\.mozilla(?:\/|$)/,
  /(?:^|\/)library\/application support\/(?:google\/chrome|microsoft edge|bravesoftware|chromium|firefox)(?:\/|$)/,
  /(?:^|\/)\.config\/(?:google-chrome|chromium|microsoft-edge|bravesoftware)(?:\/|$)/,
  /(?:^|\/)(?:login data|login data for account|cookies|cookies\.sqlite|key3\.db|key4\.db|logins\.json|signons\.sqlite|web data|local state)$/,
  // Keychains.
  /(?:^|\/)library\/keychains(?:\/|$)/,
  /\.keychain(?:-db)?(?:\/|$)/,
  // Claude's own folder and file (~/.claude, ~/.claude.json), and every HOAI state folder (~/.bgos-agent, which holds
  // the stranger's email files, and ~/.bgos-plugin-state, which holds the pairing).
  /(?:^|\/)\.claude[^/]*(?:\/|$)/,
  /(?:^|\/)\.bgos-[^/]*(?:\/|$)/,
])

/** A Unicode control character: never in a file name HOAI attaches. */
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/
/** Names Windows gives to devices: `nul`, `nul.pdf` and `CON` open a device, never a file. */
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$|clock\$)$/i
/** Unix folders that hold the system's live state or its own secrets. */
const SYSTEM_ROOTS: ReadonlySet<string> = new Set(['proc', 'dev', 'sys', 'etc'])

const TYPE_LABEL: Readonly<Record<EmailFileType, string>> = {
  pdf: 'PDF', png: 'PNG', jpg: 'JPG', gif: 'GIF', webp: 'WebP', text: 'text', docx: 'Word', xlsx: 'Excel',
}
const TYPE_MIME: Readonly<Record<EmailFileType, string>> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  text: 'text/plain',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
}
const SAFE_LIST_WORDS = 'only PDF, pictures (PNG, JPG, GIF, WebP), text (TXT, CSV), Word (DOCX) and Excel (XLSX) files are'

/** What the read needs of a stat: the fields the swap check compares. */
export interface OutboundStat {
  isFile(): boolean
  size: number
  dev?: number | bigint
  ino?: number | bigint
}

/** What the read needs of an open file. */
export interface OutboundHandle {
  stat(): Promise<OutboundStat>
  read(buffer: Uint8Array, offset: number, length: number, position: number): Promise<{ bytesRead: number }>
  close(): Promise<void>
}

/** The file system this file uses; a test passes its own to count the calls. */
export interface OutboundFs {
  realpath(path: string): Promise<string>
  lstat(path: string): Promise<OutboundStat>
  open(path: string, flags: 'r'): Promise<OutboundHandle>
}

export interface OutboundFileCtx {
  /** The home `~` stands for; this computer's home when left out. */
  home?: string
  /** The owner's user id, so lanePathIsSecret refuses every other person's lane. */
  actorUserId?: string
  fs?: Partial<OutboundFs>
}

export interface OutboundFile {
  /** The path as the agent named it. */
  path: string
  /** The path after every link: what was read. */
  realPath: string
  /** The file's own name, which the email shows. */
  name: string
  type: EmailFileType
  mime: string
  size: number
  bytes: Uint8Array
}

export type OutboundRead = { ok: true; file: OutboundFile } | { ok: false; error: string }
export type OutboundReadAll = { ok: true; files: OutboundFile[] } | { ok: false; error: string }

/** realpath.native: it resolves every link and, on Windows, a short (8.3) name into the long one. */
function nativeRealpath(path: string): Promise<string> {
  const native = (realpathCallback as unknown as { native?: typeof realpathCallback }).native
  if (typeof native !== 'function') return realpathPromise(path)
  return new Promise((resolve, reject) => native(path, (err, real) => (err ? reject(err) : resolve(String(real)))))
}

const REAL_FS: OutboundFs = {
  realpath: nativeRealpath,
  lstat: (path) => lstatPromise(path),
  open: async (path, flags) => {
    const handle = await openPromise(path, flags)
    return {
      stat: () => handle.stat(),
      read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position),
      close: () => handle.close(),
    }
  },
}

function fsOf(ctx: OutboundFileCtx): OutboundFs {
  return { ...REAL_FS, ...(ctx.fs ?? {}) } as OutboundFs
}

/** The path as the agent wrote it, kept to one line of a sentence. */
function shown(path: string): string {
  return path.length > 200 ? `${path.slice(0, 120)}...${path.slice(-60)}` : path
}

const megabytes = (bytes: number): number => Math.ceil(bytes / MB)

/** `~`, `~/x` and `~\x` stand for the home; nothing else is expanded. */
function expandHome(path: string, home: string): string {
  if (path === '~') return home
  if (path.startsWith('~/') || path.startsWith('~\\')) return `${home.replace(/[\\/]+$/, '')}/${path.slice(2)}`
  return path
}

type LexicalKind = 'secret' | 'device' | 'system' | 'not_full' | 'empty' | 'control'
type Lexical = { kind: LexicalKind } | { kind: 'ok'; form: string }

/** Two slashes of any kind at the start: \\host, //host, \\?\ and \\.\ (device paths), \/host. */
const NETWORK_OR_DEVICE = /^[\\/]{2}/

/**
 * Steps 1 and 2 on one spelling: no file system call. `form` is the lower
 * case, forward slash, resolved path that both secret checks read.
 */
function lexical(path: string, ctx: OutboundFileCtx): Lexical {
  if (path.trim() === '') return { kind: 'empty' }
  if (CONTROL.test(path)) return { kind: 'control' }
  // `~` expands only a leading `~/` or `~\`, so a path that starts with two slashes is still one here; and a home
  // that is itself a network path is refused the same way.
  const expanded = expandHome(path, ctx.home ?? homedir())
  if (NETWORK_OR_DEVICE.test(expanded)) return { kind: 'device' }
  const slashed = expanded.replace(/\\/g, '/')
  const drive = /^[a-z]:\//i.test(slashed) ? slashed.slice(0, 2).toLowerCase() : ''
  if (!drive && !slashed.startsWith('/')) return { kind: 'not_full' }
  const rest = drive ? slashed.slice(2) : slashed
  // A wildcard or a colon after the drive (an NTFS stream such as a.pdf:hidden) names no plain file.
  if (/[?*:]/.test(rest)) return { kind: 'device' }
  const segments: string[] = []
  for (const raw of rest.split('/')) {
    // Windows drops trailing dots and spaces: `.ssh.` and `.ssh ` open `.ssh`, so they are read as it.
    const seg = raw.replace(/[. ]+$/, '') || raw
    if (seg === '' || seg === '.') continue
    if (WINDOWS_DEVICE.test(seg.split('.')[0]!.trim())) return { kind: 'device' }
    if (seg === '..') {
      // Above the top is not a full path; lanePathIsSecret reads the same climb as a secret.
      if (segments.length === 0) return { kind: 'not_full' }
      segments.pop()
      continue
    }
    segments.push(seg.toLowerCase())
  }
  if (!drive && segments.length > 0 && (SYSTEM_ROOTS.has(segments[0]!) || (segments[0] === 'private' && segments[1] === 'etc'))) {
    return { kind: 'system' }
  }
  const form = `${drive}/${segments.join('/')}`
  if (OUTBOUND_SECRET_PATTERNS.some((pattern) => pattern.test(form))) return { kind: 'secret' }
  if (lanePathIsSecret(form, { actorUserId: ctx.actorUserId ?? '' })) return { kind: 'secret' }
  return { kind: 'ok', form }
}

function lexicalSentence(kind: Exclude<LexicalKind, 'ok'>, path: string, followed: boolean): string {
  const name = shown(path)
  const lead = followed ? `${name} leads to` : `${name}`
  switch (kind) {
    case 'empty':
      return 'An attached file names no file, so nothing is attached.'
    case 'control':
      return 'A file path holds a control character, so it is not attached.'
    case 'device':
      return followed
        ? `${lead} a network or device path (HOAI followed its links), so it is never attached.`
        : `${name} is a network or device path, so it is never attached.`
    case 'system':
      return followed
        ? `${lead} a system file (HOAI followed its links), so it is never attached.`
        : `${name} is a system file, so it is never attached.`
    case 'not_full':
      return `${name} is not a full path, so it is not attached; name the file from the top, like C:\\Users\\you\\Documents\\report.pdf or /home/you/report.pdf.`
    case 'secret':
      return followed
        ? `${lead} a key or password file (HOAI followed its links), so it is never attached.`
        : `${name} looks like a key or password file, so it is never attached.`
  }
}

/**
 * Steps 1 and 2 alone, with no file system call: why this path is refused
 * before anything is read, or null. The permission relay runs it on the CLI's
 * preview so a key path never reaches a card or the floor check.
 */
export function outboundFileLexicalRefusal(path: unknown, ctx: OutboundFileCtx = {}): string | null {
  if (typeof path !== 'string') return lexicalSentence('empty', '', false)
  const seen = lexical(path, ctx)
  return seen.kind === 'ok' ? null : lexicalSentence(seen.kind, path, false)
}

/** A real path Windows hands back as \\?\C:\...: the same local file, read as C:\... (\\?\UNC\ stays a network path). */
function plainLocal(real: string): string {
  return /^\\\\\?\\[a-z]:\\/i.test(real) ? real.slice(4) : real
}

function baseName(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/')
  return parts[parts.length - 1] ?? ''
}

/** One file, all four steps: the file with its bytes, or the one sentence that says why not. */
export async function readOutboundFile(path: unknown, ctx: OutboundFileCtx = {}): Promise<OutboundRead> {
  if (typeof path !== 'string') return { ok: false, error: lexicalSentence('empty', '', false) }
  // Steps 1 and 2: nothing below runs for a refused spelling.
  const given = lexical(path, ctx)
  if (given.kind !== 'ok') return { ok: false, error: lexicalSentence(given.kind, path, false) }
  const fs = fsOf(ctx)
  const name = baseName(path)
  const notFound = `${shown(path)} could not be found or read, so it is not attached.`
  // Step 3: every link resolved, then steps 1 and 2 again on where it really is.
  let real: string
  try {
    real = plainLocal(await fs.realpath(expandHome(path, ctx.home ?? homedir())))
  } catch {
    return { ok: false, error: notFound }
  }
  const resolved = lexical(real, ctx)
  if (resolved.kind !== 'ok') return { ok: false, error: lexicalSentence(resolved.kind, path, true) }
  // Step 4: a regular file, its size, its type by name and then by its bytes.
  let stat: OutboundStat
  try {
    stat = await fs.lstat(real)
  } catch {
    return { ok: false, error: notFound }
  }
  if (!stat.isFile()) return { ok: false, error: `${shown(path)} is not a regular file, so it is not attached.` }
  const tooBig = (size: number) =>
    `${shown(path)} is ${megabytes(size)} MB; one email can carry at most ${AGENT_EMAIL_OUTBOUND_MAX_BYTES / MB} MB of files, so it is not attached.`
  if (stat.size > AGENT_EMAIL_OUTBOUND_MAX_BYTES) return { ok: false, error: tooBig(stat.size) }
  if (stat.size === 0) return { ok: false, error: `${shown(path)} is empty, so it is not attached.` }
  const ext = /\.([^./\\]+)$/.exec(name)?.[1]?.toLowerCase() ?? ''
  const type = Object.hasOwn(TYPE_OF_EXTENSION, ext) ? TYPE_OF_EXTENSION[ext]! : null
  if (type === null) return { ok: false, error: `${shown(path)} is not a type that can be attached; ${SAFE_LIST_WORDS}.` }
  let bytes: Uint8Array
  let handle: OutboundHandle
  try {
    handle = await fs.open(real, 'r')
  } catch {
    return { ok: false, error: notFound }
  }
  try {
    // The handle must be the file just checked: a swap between the stat and the open is refused.
    const opened = await handle.stat()
    // Compared by device and file number where the system gives them (a zero is none), else by size.
    const known = (v: unknown) => v !== undefined && String(v) !== '0'
    const sameFile = known(stat.ino) && known(opened.ino)
      ? String(stat.ino) === String(opened.ino) && String(stat.dev) === String(opened.dev)
      : opened.size === stat.size
    if (!opened.isFile() || !sameFile) {
      return { ok: false, error: `${shown(path)} changed while HOAI read it, so it is not attached.` }
    }
    if (opened.size > AGENT_EMAIL_OUTBOUND_MAX_BYTES) return { ok: false, error: tooBig(opened.size) }
    // One byte past the cap, so a file that grew after the stat is caught too.
    const buffer = new Uint8Array(Math.min(opened.size, AGENT_EMAIL_OUTBOUND_MAX_BYTES) + 1)
    let read = 0
    while (read < buffer.length) {
      const { bytesRead } = await handle.read(buffer, read, buffer.length - read, read)
      if (bytesRead === 0) break
      read += bytesRead
    }
    if (read > AGENT_EMAIL_OUTBOUND_MAX_BYTES) return { ok: false, error: tooBig(read) }
    if (read === 0) return { ok: false, error: `${shown(path)} is empty, so it is not attached.` }
    bytes = buffer.subarray(0, read)
  } catch {
    return { ok: false, error: notFound }
  } finally {
    await handle.close().catch(() => {})
  }
  if (!isType(bytes, type)) {
    return { ok: false, error: `${shown(path)} is not really a ${TYPE_LABEL[type]} file (its contents say otherwise), so it is not attached.` }
  }
  return { ok: true, file: { path, realPath: real, name, type, mime: TYPE_MIME[type], size: bytes.length, bytes } }
}

/** Why this one file is never attached (rule 4, rule 3's local half), or null when it may go. */
export async function outboundFileRefusal(path: unknown, ctx: OutboundFileCtx = {}): Promise<string | null> {
  const read = await readOutboundFile(path, ctx)
  return read.ok ? null : read.error
}

/** Every file of one email: the count first (no file system call), then each file, no file twice, and the total. */
export async function readOutboundFiles(paths: readonly unknown[], ctx: OutboundFileCtx = {}): Promise<OutboundReadAll> {
  if (!Array.isArray(paths) || paths.length === 0) return { ok: false, error: 'An email with files names at least one file.' }
  if (paths.length > AGENT_EMAIL_OUTBOUND_MAX_FILES) {
    return { ok: false, error: `At most ${AGENT_EMAIL_OUTBOUND_MAX_FILES} files can go with one email; this one names ${paths.length}.` }
  }
  // Every spelling is checked before the first file is touched.
  for (const path of paths) {
    const why = outboundFileLexicalRefusal(path, ctx)
    if (why) return { ok: false, error: why }
  }
  const files: OutboundFile[] = []
  const seen = new Set<string>()
  let total = 0
  for (const path of paths) {
    const read = await readOutboundFile(path, ctx)
    if (!read.ok) return read
    const key = /^[a-z]:[\\/]/i.test(read.file.realPath) ? read.file.realPath.toLowerCase() : read.file.realPath
    if (seen.has(key)) return { ok: false, error: `${shown(read.file.path)} is named twice; each file goes with an email once.` }
    seen.add(key)
    total += read.file.size
    if (total > AGENT_EMAIL_OUTBOUND_MAX_BYTES) {
      return { ok: false, error: `These files come to ${megabytes(total)} MB together; one email can carry at most ${AGENT_EMAIL_OUTBOUND_MAX_BYTES / MB} MB of files.` }
    }
    files.push(read.file)
  }
  return { ok: true, files }
}

// ── no path leaves the machine in a floor check or a card (G9) ───────────────

/** email_send and email_draft under any install prefix, or bare. */
const EMAIL_TOOL_NAME = /^(?:mcp__(?:.*_)?bgos__)?email_(?:send|draft)$/

/** A `"path": "..."` value, closed or cut off at the end of the preview. */
const PATH_VALUE = /("path"\s*:\s*)"(?:[^"\\]|\\.)*(?:"|$)/g
/** The `"files":` key itself, never the word inside an escaped string. */
const FILES_KEY = /(^|[^\\])"files"\s*:/

/**
 * The CLI's preview of an email tool call with every file path taken out:
 * `files` becomes a count ("2 files"). Sent to the floor check, written on a
 * card and its push in place of the preview. A preview the CLI cut in the
 * middle (a long value keeps its head and tail with a line break between) is
 * read the way the email card reads it (parsePreviewObject), so the list is
 * replaced whatever shape its entries take. A preview that still does not
 * read keeps only what comes before its `files` key: every later byte may be
 * a path. Any other tool, or an email with no files, is returned exactly as
 * it was.
 */
export function hideEmailFilePaths(toolName: string, inputPreview: string): string
export function hideEmailFilePaths(toolName: string, inputPreview: string | undefined): string | undefined
export function hideEmailFilePaths(toolName: string, inputPreview: string | undefined): string | undefined {
  if (typeof inputPreview !== 'string' || !EMAIL_TOOL_NAME.test(String(toolName ?? ''))) return inputPreview
  if (!/"files"/.test(inputPreview)) return inputPreview
  const record = parsePreviewObject(inputPreview)
  if (record) {
    if (!Object.hasOwn(record, 'files')) return inputPreview
    return JSON.stringify({ ...record, files: emailFilesCountWords(record.files) })
  }
  const key = FILES_KEY.exec(inputPreview)
  const head = key ? inputPreview.slice(0, key.index + key[1]!.length) : inputPreview
  const kept = head.replace(PATH_VALUE, '$1"(a file path, hidden)"')
  return key ? `${kept}"files": "(file paths hidden)"}` : kept
}

/** "1 file", "2 files": how many files a call names, in words. */
export function emailFilesCountWords(files: unknown): string {
  const n = Array.isArray(files) ? files.length : 1
  return `${n} file${n === 1 ? '' : 's'}`
}
