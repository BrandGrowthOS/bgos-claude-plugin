/**
 * Persistent per-chat poll cursors (the restart-replay fix, Dutify aijvk1h8LM).
 *
 * CRITICAL, DO NOT REGRESS. server.ts used to keep the per-chat last-seen
 * message id in a plain in-memory Map; every daemon restart reset it, so the
 * first poll ran the lastSeen === 0 full-fetch heuristic for EVERY monitored
 * chat and replayed dormant chats' trailing unanswered messages as [backlog]
 * (observed live 2026-07-18: one restart delivered ~40 June-era messages).
 * This is the same bug the gobot channel hit; the store is modeled on its
 * fix (gobot-channel-bgos src/last-id-store.ts): atomic tempfile + rename
 * writes, tolerant loads, never throw on a persistence hiccup.
 *
 * Keying: multiple daemons run from the SAME plugin checkout, one per
 * assistant, so the file MUST be per assistant:
 *   ~/.bgos-plugin-state/<assistantId>/chat-cursors.json
 * (root overridable via BGOS_PLUGIN_STATE_DIR). When the assistant id is
 * missing or filesystem-hostile we fall back to a hash of the daemon's cwd,
 * never a shared file, two daemons sharing cursors would suppress each
 * other's deliveries.
 *
 * Format: { "v": 1, "cursors": { "<chatId>": <positive int message id> } }.
 *
 * Tolerance: a missing OR unreadable OR corrupt file loads as an empty map
 * with fileExisted false, which server.ts treats as a genuine first run (the
 * first-run gate then refuses to deliver dormant history, so the failure
 * mode of a lost store is "skip ancient tails once", never "replay weeks").
 * Malformed entries inside an otherwise valid file are skipped one by one.
 *
 * Write coalescing: callers mark the store dirty on every cursor advance and
 * flush on a timer (CURSOR_FLUSH_INTERVAL_MS) plus at process exit. Losing
 * the last few seconds of cursor on a crash is fine; the poll filter dedups
 * a short replay. A failed flush keeps the dirty flag so the next tick
 * retries.
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const CURSOR_FILE_NAME = 'chat-cursors.json'
export const CURSOR_FLUSH_INTERVAL_MS = 5_000

const FILE_VERSION = 1

/** Assistant ids safe to use directly as a directory name. */
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * Resolve the per-assistant cursor file path. `env` and `home` are
 * injectable for tests; production callers pass only assistantId + cwd.
 */
export function resolveCursorFilePath(opts: {
  assistantId: string | null | undefined
  cwd: string
  env?: Record<string, string | undefined>
  home?: string
}): string {
  const env = opts.env ?? process.env
  const root =
    env.BGOS_PLUGIN_STATE_DIR || join(opts.home ?? homedir(), '.bgos-plugin-state')
  const raw = String(opts.assistantId ?? '').trim()
  const key = SAFE_ID_RE.test(raw)
    ? raw
    : `cwd-${createHash('sha256').update(opts.cwd).digest('hex').slice(0, 16)}`
  return join(root, key, CURSOR_FILE_NAME)
}

export interface LoadedCursors {
  cursors: Map<string, number>
  /**
   * True only when a parseable cursor file was read. False for missing,
   * unreadable, or corrupt files: server.ts treats all of those as a first
   * run so the first-run gate applies (safe direction: skip ancient tails
   * rather than replay them).
   */
  fileExisted: boolean
}

/** Read + validate the cursor file. Never throws. */
export function loadCursorFile(filePath: string): LoadedCursors {
  const empty = (): LoadedCursors => ({ cursors: new Map(), fileExisted: false })
  let raw: string
  try {
    raw = readFileSync(filePath, 'utf8')
  } catch {
    return empty()
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return empty()
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return empty()
  }
  const envelope = parsed as { v?: unknown; cursors?: unknown }
  if (envelope.v !== FILE_VERSION) return empty()
  if (
    typeof envelope.cursors !== 'object' ||
    envelope.cursors === null ||
    Array.isArray(envelope.cursors)
  ) {
    return empty()
  }
  const cursors = new Map<string, number>()
  for (const [chatId, value] of Object.entries(envelope.cursors)) {
    if (!chatId) continue
    if (typeof value !== 'number') continue
    if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) continue
    cursors.set(chatId, value)
  }
  return { cursors, fileExisted: true }
}

/**
 * Atomically persist the cursor map: write a sibling tempfile, then rename,
 * so a crash mid-write can never leave a partial file. Creates the parent
 * directory. Never throws; returns false on failure so the caller can keep
 * its dirty flag and retry later.
 */
export function saveCursorFile(
  filePath: string,
  cursors: ReadonlyMap<string, number>,
): boolean {
  const tmp = `${filePath}.${process.pid}.tmp`
  try {
    mkdirSync(dirname(filePath), { recursive: true })
    const body = JSON.stringify({
      v: FILE_VERSION,
      cursors: Object.fromEntries(cursors),
    })
    writeFileSync(tmp, body, { mode: 0o600 })
    renameSync(tmp, filePath)
    return true
  } catch {
    try {
      unlinkSync(tmp)
    } catch {
      /* tempfile never existed or is already gone */
    }
    return false
  }
}

/**
 * The live store: loads once at boot, hands the caller the live Map (server.ts
 * keeps using it directly for reads), and coalesces writes behind a dirty
 * flag. The caller marks dirty on every cursor advance and flushes on its own
 * timer + exit hook.
 */
export class CursorStore {
  readonly filePath: string
  private live: Map<string, number> = new Map()
  private dirty = false
  private loadedFileExisted = false

  constructor(filePath: string) {
    this.filePath = filePath
  }

  /** Load the file; the returned map is retained as the live map to flush. */
  load(): LoadedCursors {
    const loaded = loadCursorFile(this.filePath)
    this.live = loaded.cursors
    this.loadedFileExisted = loaded.fileExisted
    return loaded
  }

  get fileExisted(): boolean {
    return this.loadedFileExisted
  }

  get isDirty(): boolean {
    return this.dirty
  }

  markDirty(): void {
    this.dirty = true
  }

  /**
   * Write the live map if anything advanced since the last successful flush.
   * Returns true only when a write happened and succeeded. A failed write
   * keeps the dirty flag set so the next flush retries.
   */
  flushIfDirty(): boolean {
    if (!this.dirty) return false
    const ok = saveCursorFile(this.filePath, this.live)
    if (ok) this.dirty = false
    return ok
  }
}
