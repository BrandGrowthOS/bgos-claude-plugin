/**
 * The spool intake: how a short lived hook process reaches the long lived daemon.
 *
 * A Claude Code hook is a subprocess that lives for a few milliseconds. The
 * daemon is a separate long lived process. Stage 4 needs the first to hand the
 * second a JSON payload, on Windows, macOS and Linux, without ever blocking the
 * tool call that produced it.
 *
 * WHY A FILE AND NOT A LOOPBACK LISTENER. A port needs an ephemeral bind, a
 * descriptor file so the forwarder can find it, a token so a stranger on the
 * same host cannot post into the chat, a firewall question on Windows and a
 * second failure mode (the daemon is booting, the port is stale, the POST is
 * refused) that needs a fallback anyway. The fallback IS the file. So the file
 * is the whole design: the forwarder appends one line and exits, the daemon
 * watches the directory and drains what it finds. It is also the shape the
 * daemon already uses for one external input (the liveness probe's
 * probe-requested.json), so it is a pattern this codebase has already debugged.
 *
 *   <state>/hooks/<session_id>/events.jsonl    the lines
 *   <state>/hooks/<session_id>/cursor.json     how far THIS host has drained
 *
 * Three rules this module holds.
 *
 * 1. ONLY THE PAIRING LOCK HOLDER CONSUMES. Several daemons can resolve one
 *    pairing on a shared host (lib/pairing-lock.ts records the incident). A
 *    passive daemon never starts an intake, and one that stands down stops it,
 *    so a hook event is posted exactly once however many daemons watch the
 *    directory.
 *
 * 2. A SESSION BINDS ONLY ON POSITIVE PROOF. "Its transcript sits under this
 *    daemon's project dir" is NOT proof: a human's own claude in the agent
 *    folder, a worker, or a session that died last week writes there too, and
 *    the first of those to spool a line used to capture the rail while the real
 *    agent's rows were then refused as foreign. The three proofs, in order:
 *      a. a UserPromptSubmit whose prompt carries the text of a message THIS
 *         daemon delivered recently (the delivery is the only thing that can
 *         only have reached our own session);
 *      b. the transcript lib/session-binding.ts has already proven is ours
 *         (the reply marker chain, or the CLI assigned session id);
 *      c. a SessionStart naming that same proven transcript.
 *    Until one of them lands, a session's events are BUFFERED for at most
 *    UNBOUND_BUFFER_MS and then dropped. Bound: consumed. Another session once
 *    we are bound: ignored, and left for its own daemon.
 *
 * 3. NOTHING IS APPLIED TWICE. The drain cursor is persisted per session in
 *    cursor.json beside the lines, so a daemon restart or a lock re-arm
 *    resumes where the last one stopped instead of replaying the whole session
 *    (which posted every card, marker and step again). Lines below the
 *    persisted cursor are never re-applied, a partial trailing line is left for
 *    the next drain, and the in memory dedupe catches what is left.
 *
 * A session directory is swept when its SessionEnd has been consumed, or when
 * nothing in it has been touched for SESSION_SWEEP_MS.
 */

import { createHash } from 'node:crypto'
import {
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  watch as fsWatch,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// ── Layout ───────────────────────────────────────────────────────────────────

/** The directory name under the plugin state root that holds every spool. */
export const SPOOL_DIR_NAME = 'hooks'
/** The one file a session's hooks append to. */
export const SPOOL_FILE_NAME = 'events.jsonl'
/** The rotated twin: the forwarder renames onto it and starts a fresh file. */
export const SPOOL_ROTATED_NAME = 'events.1.jsonl'
/** How far this host has drained the file beside it. */
export const CURSOR_FILE_NAME = 'cursor.json'
/** Refuse to grow a spool past this; rotate instead. */
export const SPOOL_MAX_BYTES = 2 * 1024 * 1024
/** A session directory nothing has touched for this long is not coming back. */
export const SESSION_SWEEP_MS = 30 * 60_000
/** How long an unproven session's events are held before they are dropped. */
export const UNBOUND_BUFFER_MS = 60_000
/** How many lines one unproven session may hold. A turn is far below this. */
export const UNBOUND_BUFFER_MAX = 400
/** Poll cadence while a turn is live: the card should appear while the tool runs. */
export const INTAKE_POLL_LIVE_MS = 500
/** Poll cadence while nothing is happening. fs.watch does the real work. */
export const INTAKE_POLL_IDLE_MS = 2_000
/** How many dedupe keys to remember. Bounded: this runs for the daemon's life. */
export const DEDUPE_LIMIT = 512

/**
 * The plugin state root, derived exactly as lib/cursor-store.ts derives it.
 * Kept as its own function so the forwarder's plain JavaScript twin has one
 * definition to agree with, and a test pins the two together.
 */
export function hookStateRoot(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string {
  return env.BGOS_PLUGIN_STATE_DIR || join(home, '.bgos-plugin-state')
}

/** Session ids are CLI generated uuids, but the value arrives from a payload,
 *  so it is sanitised before it becomes a directory name. */
export function safeSessionKey(sessionId: unknown): string {
  const raw = String(sessionId ?? '').trim()
  // Dots are dropped along with every separator, so no arrangement of the
  // incoming value can produce a '..' segment and climb out of the spool root.
  const safe = raw.replace(/[^A-Za-z0-9_-]/g, '_')
  if (!safe) return 'unknown'
  if (safe.length <= 64) return safe
  return `${safe.slice(0, 48)}-${createHash('sha256').update(raw).digest('hex').slice(0, 12)}`
}

export function hooksRoot(stateRoot: string): string {
  return join(stateRoot, SPOOL_DIR_NAME)
}

export function sessionSpoolDir(stateRoot: string, sessionId: unknown): string {
  return join(hooksRoot(stateRoot), safeSessionKey(sessionId))
}

export function sessionSpoolPath(stateRoot: string, sessionId: unknown): string {
  return join(sessionSpoolDir(stateRoot, sessionId), SPOOL_FILE_NAME)
}

export function sessionCursorPath(stateRoot: string, sessionId: unknown): string {
  return join(sessionSpoolDir(stateRoot, sessionId), CURSOR_FILE_NAME)
}

// ── The spool line ───────────────────────────────────────────────────────────

export interface SpoolLine {
  /**
   * The forwarder's own line id: a per process random tag plus a counter. It
   * is NOT a position, so two hook processes appending in the same instant can
   * never mint the same one (the byte offset they both stat'ed could). Stable
   * across a re-read, which is what makes it safe inside a dedupe key.
   */
  id: string
  receivedAt: number
  event: string
  payload: Record<string, unknown>
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** Parse one spooled line. Never throws: a half written tail is normal. */
export function parseSpoolLine(raw: string): SpoolLine | null {
  const text = String(raw ?? '').trim()
  if (!text) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  if (!isRecord(parsed.payload)) return null
  let id = typeof parsed.id === 'string' ? parsed.id.trim() : ''
  if (!id && typeof parsed.seq === 'number' && Number.isFinite(parsed.seq)) {
    // A line written by a forwarder older than this release carried a byte
    // offset and no id. Keep reading it rather than dropping a whole session
    // during an upgrade: the offset is still unique within its own file.
    id = `seq-${parsed.seq}`
  }
  if (!id) return null
  const receivedAt =
    typeof parsed.receivedAt === 'number' && Number.isFinite(parsed.receivedAt)
      ? parsed.receivedAt
      : 0
  return { id, receivedAt, event: String(parsed.event ?? ''), payload: parsed.payload }
}

// ── The persisted drain cursor ───────────────────────────────────────────────

export interface DrainCursor {
  /** Complete lines already applied from this file. */
  lines: number
  /** Bytes those lines occupy, so a rotation (a smaller file) is detectable. */
  bytes: number
}

export const EMPTY_CURSOR: DrainCursor = { lines: 0, bytes: 0 }

/** Read a cursor.json. Anything unreadable is "start from the top". */
export function parseCursor(raw: string | null | undefined): DrainCursor {
  if (typeof raw !== 'string' || raw.trim() === '') return { ...EMPTY_CURSOR }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed)) return { ...EMPTY_CURSOR }
    const lines = typeof parsed.lines === 'number' && Number.isFinite(parsed.lines) ? Math.max(0, Math.floor(parsed.lines)) : 0
    const bytes = typeof parsed.bytes === 'number' && Number.isFinite(parsed.bytes) ? Math.max(0, Math.floor(parsed.bytes)) : 0
    return { lines, bytes }
  } catch {
    return { ...EMPTY_CURSOR }
  }
}

export function serializeCursor(cursor: DrainCursor): string {
  return `${JSON.stringify({ lines: cursor.lines, bytes: cursor.bytes })}\n`
}

export interface DrainDecision {
  /** The raw lines this drain must apply, in file order. */
  fresh: string[]
  /** Where to persist the cursor once they are applied. */
  next: DrainCursor
  /** The file shrank under us: it was rotated or truncated. */
  reset: boolean
}

/**
 * Which part of this file has not been drained yet.
 *
 * ONLY COMPLETE LINES COUNT. The forwarder appends with one atomic write, but
 * a reader can still catch a file between two of them, and half a JSON object
 * is not an event. The trailing fragment is left where it is and picked up by
 * the next drain, when its newline has landed.
 */
export function decideDrain(input: { cursor: DrainCursor; text: string }): DrainDecision {
  const text = typeof input.text === 'string' ? input.text : ''
  const held = input.cursor ?? EMPTY_CURSOR
  const size = Buffer.byteLength(text, 'utf8')
  const reset = size < held.bytes
  const cursor = reset ? { ...EMPTY_CURSOR } : held
  const parts = text.split('\n')
  // Whether or not the file ends in a newline, the final element is either an
  // empty string or an unfinished line. Neither is drainable.
  const complete = parts.slice(0, -1)
  const completeBytes = complete.length === 0 ? 0 : Buffer.byteLength(`${complete.join('\n')}\n`, 'utf8')
  const fresh = complete.length > cursor.lines ? complete.slice(cursor.lines) : []
  return {
    fresh,
    next: { lines: complete.length, bytes: completeBytes },
    reset,
  }
}

// ── Dedupe ───────────────────────────────────────────────────────────────────

/**
 * Hook events that carry no id of their own. For these the forwarder's line id
 * IS the occurrence identity: without it two genuine Stops (or two SessionStarts
 * around a compaction, or two prompts inside one turn) collapse into one and the
 * second one is silently dropped.
 */
export const ID_LESS_EVENTS: readonly string[] = [
  'Stop',
  // A SubagentStop carries no tool_use_id and no task_id, so two children
  // stopping inside one prompt share their session, their event name and their
  // prompt id: identical keys, and the second child's stop is dropped in
  // silence. NEVER key it on agent_id instead: the runtime's own task
  // notification says the same task may notify more than once, so a resumed
  // child stopping twice would be the one deduped away.
  'SubagentStop',
  'SessionStart',
  'SessionEnd',
  'PreCompact',
  'PostCompact',
  'UserPromptSubmit',
  'Notification',
]

/**
 * The identity of one hook occurrence. A rotation drain, a retried batch or a
 * clone install that ALSO has the plugin's own hooks file registered can each
 * hand the daemon the same payload twice; this is what makes that free.
 *
 * A tool event identifies itself (tool_use_id / task_id) and keeps that as its
 * key, so the SAME call spooled twice by two registrations is still one row.
 * An id less event has nothing to tell two occurrences apart, so it takes the
 * line id, which is stable across a re-read of the same line and different for
 * a genuinely new one.
 */
export function dedupeKeyOf(payload: Record<string, unknown>, lineId?: string): string {
  const p = isRecord(payload) ? payload : {}
  const id = String(p.tool_use_id ?? p.task_id ?? '')
  const event = String(p.hook_event_name ?? '')
  const occurrence = id || (ID_LESS_EVENTS.includes(event) ? String(lineId ?? '') : '')
  return [String(p.session_id ?? ''), event, occurrence, String(p.prompt_id ?? '')].join('|')
}

export interface Dedupe {
  seen(key: string): boolean
  note(key: string): void
  size(): number
}

/** Bounded insertion ordered set: the oldest key falls out at the limit. */
export function createDedupe(limit: number = DEDUPE_LIMIT): Dedupe {
  const keys = new Set<string>()
  const cap = Math.max(1, Math.floor(limit))
  return {
    seen: (key) => keys.has(key),
    note: (key) => {
      if (keys.has(key)) {
        keys.delete(key)
      }
      keys.add(key)
      while (keys.size > cap) {
        const oldest = keys.values().next().value
        if (oldest === undefined) break
        keys.delete(oldest)
      }
    },
    size: () => keys.size,
  }
}

// ── Admission ────────────────────────────────────────────────────────────────

/** Path containment, separator agnostic, with no fs access. */
export function isUnderDir(child: string, dir: string): boolean {
  const c = normalizePath(child)
  const d = normalizePath(dir)
  if (!c || !d) return false
  if (process.platform === 'win32') {
    return c.toLowerCase() === d.toLowerCase() || c.toLowerCase().startsWith(`${d.toLowerCase()}/`)
  }
  return c === d || c.startsWith(`${d}/`)
}

function normalizePath(value: string): string {
  return String(value ?? '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
}

/**
 * Is this the transcript the binding chain proved?
 *
 * The chain names a file, sometimes as a full path and sometimes as the bare
 * <session-id>.jsonl basename, so the basenames are compared when either side
 * is bare. Case insensitive on Windows, where the two spellings of one path
 * differ freely.
 */
export function isSameTranscript(a: string, b: string): boolean {
  const left = normalizePath(a)
  const right = normalizePath(b)
  if (!left || !right) return false
  const same = (x: string, y: string): boolean =>
    process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y
  if (same(left, right)) return true
  const base = (p: string): string => p.split('/').pop() ?? p
  if (!left.includes('/') || !right.includes('/')) return same(base(left), base(right))
  return false
}

export type AdmissionProof = 'delivered-prompt' | 'binding-chain' | 'session-start'
export type AdmissionRefusal = 'foreign-session' | 'foreign-project' | 'unproven'

export type SessionAdmission =
  | { admit: true; binds: boolean; proof?: AdmissionProof }
  | { admit: false; reason: AdmissionRefusal }

/**
 * Does this payload belong to the session this daemon serves?
 *
 * Bound already: only the same session id is admitted; anything else belongs to
 * another session sharing the cwd and is left alone.
 *
 * Not bound yet: the transcript must live under this daemon's project dir (a
 * necessary condition, never a sufficient one) AND one of the three positive
 * proofs in the file header must be present. Everything else is refused as
 * `unproven`, which the caller BUFFERS rather than drops, because the proof
 * usually arrives a line or two later.
 */
export function decideSessionAdmission(input: {
  bound: { sessionId: string } | null
  incoming: {
    sessionId: string
    transcriptPath: string
    /** hook_event_name, so a UserPromptSubmit / SessionStart can prove itself. */
    event?: string
    /** The prompt text carries a message this daemon delivered recently. */
    deliveredPrompt?: boolean
  }
  projectDir: string
  /** The transcript lib/session-binding.ts has already proven is ours. */
  provenTranscript?: string | null
}): SessionAdmission {
  const incomingId = String(input.incoming?.sessionId ?? '').trim()
  if (!incomingId) return { admit: false, reason: 'foreign-session' }
  const bound = input.bound ? String(input.bound.sessionId ?? '').trim() : ''
  if (bound) {
    return bound === incomingId
      ? { admit: true, binds: false }
      : { admit: false, reason: 'foreign-session' }
  }
  const transcript = String(input.incoming?.transcriptPath ?? '').trim()
  if (!transcript || !isUnderDir(transcript, input.projectDir)) {
    return { admit: false, reason: 'foreign-project' }
  }
  const event = String(input.incoming?.event ?? '')
  if (event === 'UserPromptSubmit' && input.incoming?.deliveredPrompt === true) {
    return { admit: true, binds: true, proof: 'delivered-prompt' }
  }
  const proven = String(input.provenTranscript ?? '').trim()
  if (proven && isSameTranscript(transcript, proven)) {
    return {
      admit: true,
      binds: true,
      proof: event === 'SessionStart' ? 'session-start' : 'binding-chain',
    }
  }
  return { admit: false, reason: 'unproven' }
}

// ── The watcher shell ────────────────────────────────────────────────────────

export interface IntakeFs {
  readdir(dir: string): string[]
  readFile(path: string): string | null
  statSize(path: string): number | null
  statMtime(path: string): number | null
  writeFile(path: string, text: string): void
  removeDir(path: string): void
}

export interface IntakeWatcher {
  close(): void
}

export interface HookIntakeOptions {
  /** The plugin state root; the intake watches <root>/hooks. */
  stateRoot: string
  /** This daemon's Claude project dir. A necessary condition, not a proof. */
  projectDir: string
  /** Every admitted payload, in spool order. Must never throw. */
  onEvent(payload: Record<string, unknown>, line: SpoolLine): void
  /** The pairing lock plus delivery gate. Checked on every pump. */
  isArmed(): boolean
  /** True while a turn is running: the poll tightens to INTAKE_POLL_LIVE_MS. */
  isTurnLive?(): boolean
  /** Does this prompt carry a message we delivered recently? (proof a) */
  provesDelivery?(promptText: string): boolean
  /** The transcript the binding chain has already proven. (proofs b and c) */
  provenTranscript?(): string | null
  now?(): number
  log?(msg: string): void
  fs?: IntakeFs
  watch?(dir: string, onChange: () => void): IntakeWatcher | null
  setIntervalFn?(fn: () => void, ms: number): { unref?(): void }
  clearIntervalFn?(handle: unknown): void
}

export interface HookIntake {
  /** Drain every spool once. Exposed so tests never need a timer. */
  pump(): void
  /** Stop watching and forget the turn. Idempotent. */
  stop(): void
  /** The session id this intake bound to, or null. */
  bound(): string | null
}

function defaultIntakeFs(): IntakeFs {
  return {
    readdir: (dir) => {
      try {
        return readdirSync(dir)
      } catch {
        return []
      }
    },
    readFile: (path) => {
      try {
        return readFileSync(path, 'utf8')
      } catch {
        return null
      }
    },
    statSize: (path) => {
      try {
        return statSync(path).size
      } catch {
        return null
      }
    },
    statMtime: (path) => {
      try {
        return statSync(path).mtimeMs
      } catch {
        return null
      }
    },
    writeFile: (path, text) => {
      // Atomic: a cursor read as half a file would replay or skip a whole turn.
      const tmp = `${path}.tmp`
      try {
        writeFileSync(tmp, text, { mode: 0o600 })
        renameSync(tmp, path)
      } catch {
        try {
          unlinkSync(tmp)
        } catch {
          /* nothing to clean up */
        }
      }
    },
    removeDir: (path) => {
      try {
        rmSync(path, { recursive: true, force: true })
      } catch {
        /* another daemon got there first, or the path is gone */
      }
    },
  }
}

function defaultWatch(dir: string, onChange: () => void): IntakeWatcher | null {
  try {
    const watcher = fsWatch(dir, { recursive: true }, () => onChange())
    watcher.on('error', () => {
      /* a watch that dies leaves the poll, which is the real contract */
    })
    watcher.unref?.()
    return watcher
  } catch {
    // fs.watch is not available for every directory on every platform, and a
    // recursive watch is unsupported on some Linux kernels. The poll below is
    // the floor, so a failed watch costs latency and nothing else.
    return null
  }
}

/**
 * Start draining hook spools. Returns a handle the caller stops on stand down
 * and on exit. Every timer is unref'd: the MCP stdio transport owns the
 * process lifetime, and an intake must never be the reason a daemon lingers.
 */
export function startHookIntake(opts: HookIntakeOptions): HookIntake {
  const fs = opts.fs ?? defaultIntakeFs()
  const watch = opts.watch ?? defaultWatch
  const now = opts.now ?? (() => Date.now())
  const log = opts.log ?? (() => {})
  const setIntervalFn =
    opts.setIntervalFn ?? ((fn: () => void, ms: number) => setInterval(fn, ms))
  const clearIntervalFn = opts.clearIntervalFn ?? ((h: unknown) => clearInterval(h as never))
  const root = hooksRoot(opts.stateRoot)
  const dedupe = createDedupe()
  /** Cursors held in memory; the file beside the lines is the durable copy. */
  const cursors = new Map<string, DrainCursor>()
  const refused = new Set<string>()
  /** Events of a session that has not proven itself yet. */
  const pending = new Map<string, { firstAt: number; lines: SpoolLine[] }>()
  let bound: string | null = null
  let stopped = false
  let watcher: IntakeWatcher | null = null
  let timer: { unref?(): void } | null = null
  let pollMs = INTAKE_POLL_IDLE_MS

  const cursorFor = (dirName: string): DrainCursor => {
    const held = cursors.get(dirName)
    if (held) return held
    const fromDisk = parseCursor(fs.readFile(join(root, dirName, CURSOR_FILE_NAME)))
    cursors.set(dirName, fromDisk)
    return fromDisk
  }

  const forget = (dirName: string): void => {
    cursors.delete(dirName)
    for (const key of [...pending.keys()]) {
      if (safeSessionKey(key) === dirName) pending.delete(key)
    }
  }

  /** The newest mtime anywhere in a session directory, or null. */
  const newestTouch = (dir: string): number | null => {
    let newest = fs.statMtime(dir)
    for (const name of fs.readdir(dir)) {
      const at = fs.statMtime(join(dir, name))
      if (at !== null && (newest === null || at > newest)) newest = at
    }
    return newest
  }

  const sweepIfIdle = (dirName: string): boolean => {
    const dir = join(root, dirName)
    const newest = newestTouch(dir)
    if (newest === null || now() - newest <= SESSION_SWEEP_MS) return false
    fs.removeDir(dir)
    forget(dirName)
    return true
  }

  /** Drop what an unproven session spooled before its buffer window ran out. */
  const expirePending = (): void => {
    const cutoff = now() - UNBOUND_BUFFER_MS
    for (const [sessionId, held] of [...pending.entries()]) {
      if (held.firstAt <= cutoff) {
        pending.delete(sessionId)
        log(
          `hook intake: dropping ${held.lines.length} buffered event(s) from session ` +
            `${sessionId}: it never proved it is ours within ${Math.round(UNBOUND_BUFFER_MS / 1000)}s`,
        )
      }
    }
  }

  const consume = (line: SpoolLine): void => {
    const key = dedupeKeyOf(line.payload, line.id)
    if (dedupe.seen(key)) return
    dedupe.note(key)
    try {
      opts.onEvent(line.payload, line)
    } catch (err) {
      // A mapper or poster failure must never stop the drain: the next line
      // is a different tool call and deserves its chance.
      log(`hook intake: event handler failed: ${err}`)
    }
  }

  const drainDir = (dirName: string): void => {
    const dir = join(root, dirName)
    const path = join(dir, SPOOL_FILE_NAME)
    const raw = fs.readFile(path)
    if (raw === null) {
      // No spool file yet, or it vanished. Only the idle sweep applies.
      sweepIfIdle(dirName)
      return
    }
    const held = cursorFor(dirName)
    const decision = decideDrain({ cursor: held, text: raw })
    if (decision.reset) {
      log(`hook intake: ${dirName} was rotated or truncated; draining it from the top`)
    }
    let ended = false
    for (const rawLine of decision.fresh) {
      const line = parseSpoolLine(rawLine)
      if (line === null) continue
      const payload = line.payload
      const sessionId = String(payload.session_id ?? '')
      const event = String(payload.hook_event_name ?? '')
      let deliveredPrompt = false
      if (bound === null && event === 'UserPromptSubmit' && opts.provesDelivery) {
        try {
          deliveredPrompt = opts.provesDelivery(String(payload.prompt ?? '')) === true
        } catch {
          deliveredPrompt = false
        }
      }
      let proven: string | null = null
      if (bound === null && opts.provenTranscript) {
        try {
          proven = opts.provenTranscript()
        } catch {
          proven = null
        }
      }
      const verdict = decideSessionAdmission({
        bound: bound === null ? null : { sessionId: bound },
        incoming: {
          sessionId,
          transcriptPath: String(payload.transcript_path ?? ''),
          event,
          deliveredPrompt,
        },
        projectDir: opts.projectDir,
        provenTranscript: proven,
      })
      if (!verdict.admit) {
        if (verdict.reason === 'unproven') {
          // Hold it: the proof usually lands a line or two later, and throwing
          // the opening of a turn away would cost the card that turn.
          const held2 = pending.get(sessionId) ?? { firstAt: now(), lines: [] }
          if (held2.lines.length < UNBOUND_BUFFER_MAX) held2.lines.push(line)
          pending.set(sessionId, held2)
          continue
        }
        const mark = `${sessionId}:${verdict.reason}`
        if (!refused.has(mark)) {
          refused.add(mark)
          log(
            `hook intake: ignoring session ${sessionId || '(none)'} (${verdict.reason}); ` +
              `its own daemon drains it, and the sweep removes it if nobody does`,
          )
        }
        continue
      }
      if (verdict.binds) {
        bound = sessionId
        log(`hook intake: bound to session ${sessionId} (proof: ${verdict.proof})`)
        const buffered = pending.get(sessionId)
        pending.delete(sessionId)
        if (buffered) {
          for (const earlier of buffered.lines) consume(earlier)
        }
      }
      consume(line)
      if (event === 'SessionEnd') ended = true
    }
    const next = decision.next
    if (next.lines !== held.lines || next.bytes !== held.bytes) {
      cursors.set(dirName, next)
      fs.writeFile(join(dir, CURSOR_FILE_NAME), serializeCursor(next))
    }
    if (ended) {
      // The session said goodbye and we consumed it. Nothing will append here
      // again, and leaving it would let a future daemon re-drain a dead session.
      fs.removeDir(dir)
      forget(dirName)
      if (bound !== null && safeSessionKey(bound) === dirName) bound = null
      return
    }
    sweepIfIdle(dirName)
  }

  const pump = (): void => {
    if (stopped) return
    if (!opts.isArmed()) return
    expirePending()
    for (const dirName of fs.readdir(root)) {
      if (!dirName || dirName.startsWith('.')) continue
      drainDir(dirName)
    }
  }

  const retime = (): void => {
    if (stopped) return
    const wanted = opts.isTurnLive?.() ? INTAKE_POLL_LIVE_MS : INTAKE_POLL_IDLE_MS
    if (timer !== null && wanted === pollMs) return
    if (timer !== null) clearIntervalFn(timer)
    pollMs = wanted
    timer = setIntervalFn(() => {
      pump()
      retime()
    }, pollMs)
    timer.unref?.()
  }

  watcher = watch(root, () => pump())
  retime()
  pump()

  return {
    pump,
    bound: () => bound,
    stop: () => {
      if (stopped) return
      stopped = true
      try {
        watcher?.close()
      } catch {
        /* already closed */
      }
      watcher = null
      if (timer !== null) clearIntervalFn(timer)
      timer = null
    },
  }
}
