/**
 * Persistent Agent Update Stream cursor, one per (assistant state dir,
 * pairing token fingerprint).
 * (docs/architecture/agent-message-routing.md 5.7 and 8 phase 2; the doc
 * lives in the BGOS repo.)
 *
 * The stream cursor {seq, epoch} is the daemon's position in its per
 * assistant update sequence. Two rules shape this store:
 *
 *  - Keyed to the PAIRING TOKEN fingerprint (sha256, first 16 hex chars),
 *    the OpenClaw update-offset-store pattern: a re-pair mints a different
 *    token, so its fingerprint differs, the stored cursor reads as a first
 *    run, and the daemon adopts the server's state instead of resurrecting
 *    another pairing's cursor.
 *  - Tolerance and atomicity follow lib/cursor-store.ts exactly: missing,
 *    unreadable, corrupt, wrong version, and fingerprint mismatch all load
 *    as null (first run; the safe direction is one full adoption, never a
 *    poisoned cursor), and writes are tempfile + rename at mode 0600 that
 *    never throw.
 *
 * Unlike the chat cursor store there is NO write coalescing here: spec 5.7
 * requires a synchronous flush after side effecting applies, so callers
 * write on every advance. The file is a few dozen bytes.
 */

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const STREAM_CURSOR_FILE_NAME = 'stream-cursor.json'

const FILE_VERSION = 1

/** sha256 of the pairing token, first 16 hex chars. Never reversible. */
export function pairingTokenFingerprint(pairingToken: string): string {
  return createHash('sha256').update(pairingToken).digest('hex').slice(0, 16)
}

/**
 * The stream cursor lives beside the chat cursor file in the same per
 * assistant state dir (~/.bgos-plugin-state/<assistantId>/).
 */
export function resolveStreamCursorFilePath(daemonStateFile: string): string {
  return join(dirname(daemonStateFile), STREAM_CURSOR_FILE_NAME)
}

export interface PersistedStreamCursor {
  seq: number
  epoch: number
}

function validCounter(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

/**
 * Read + validate the cursor file. Returns null (first run) for a missing,
 * unreadable, corrupt, wrong version, malformed, or fingerprint mismatched
 * file. Never throws.
 */
export function loadStreamCursorFile(
  filePath: string,
  tokenFingerprint: string,
): PersistedStreamCursor | null {
  let raw: string
  try {
    raw = readFileSync(filePath, 'utf8')
  } catch {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null
  }
  const envelope = parsed as {
    v?: unknown
    seq?: unknown
    epoch?: unknown
    tokenFingerprint?: unknown
  }
  if (envelope.v !== FILE_VERSION) return null
  if (!validCounter(envelope.seq) || !validCounter(envelope.epoch)) return null
  if (envelope.tokenFingerprint !== tokenFingerprint) return null
  return { seq: envelope.seq, epoch: envelope.epoch }
}

/**
 * Atomically persist the cursor: sibling tempfile, then rename, mode 0600.
 * Creates the parent directory. Never throws; returns false on failure so
 * the caller keeps its state and the next advance retries.
 */
export function saveStreamCursorFile(
  filePath: string,
  cursor: PersistedStreamCursor,
  tokenFingerprint: string,
): boolean {
  const tmp = `${filePath}.${process.pid}.tmp`
  try {
    mkdirSync(dirname(filePath), { recursive: true })
    const body = JSON.stringify({
      v: FILE_VERSION,
      seq: cursor.seq,
      epoch: cursor.epoch,
      tokenFingerprint,
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
