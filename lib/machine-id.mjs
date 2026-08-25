/**
 * Machine identity for the zero-terminal connector lifecycle (design 1.4,
 * 2.1, 7.5).
 *
 * Every agent daemon and the watcher on one host report the same
 * `machineId` in their heartbeat env, which is the only thing that lets the
 * backend group N pairings under one machine and offer "update all on this
 * machine". The id is a uuid v4 minted on first read and persisted at
 * ~/.bgos-agent/machine-id (0600 where the platform honours modes), so it
 * survives plugin updates, reinstalls, and the watcher bundle being copied
 * out of the plugin folder.
 *
 * Fail-closed and quiet: a malformed file is re-minted (the backend only
 * accepts `^[A-Za-z0-9-]{8,64}$`), an unwritable home yields '' (the
 * heartbeat then simply omits the field), and nothing here ever throws. A
 * fresh id per call would make one laptop look like a fleet, so the id is
 * never returned unless it was persisted.
 *
 * Plain JavaScript on node >= 18 builtins only: this file ships inside the
 * watcher bundle (bare node) and runs in server.ts (bun) and in tests.
 */

import { randomUUID } from 'node:crypto'
import * as nodeFs from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** File name under ~/.bgos-agent/. */
export const MACHINE_ID_FILE = 'machine-id'

/** The backend's HeartbeatEnvDto.machineId shape (design 2.1). */
export const MACHINE_ID_RE = /^[A-Za-z0-9-]{8,64}$/

/**
 * <home>/.bgos-agent/machine-id
 * @param {string} home
 */
export function machineIdPath(home) {
  return join(home, '.bgos-agent', MACHINE_ID_FILE)
}

/**
 * Trim and validate a candidate id; null for anything the backend would
 * reject (so a malformed file is re-minted rather than sent).
 * @param {unknown} raw
 * @returns {string | null}
 */
export function normalizeMachineId(raw) {
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  return MACHINE_ID_RE.test(value) ? value : null
}

/**
 * Read the persisted machine id, minting and persisting one when absent or
 * malformed. Returns '' when nothing could be persisted.
 * @param {{
 *   home?: string,
 *   fs?: {
 *     readFileSync: (path: string, encoding: 'utf8') => string,
 *     mkdirSync: (path: string, opts: { recursive: boolean }) => unknown,
 *     writeFileSync: (path: string, data: string, opts: { mode: number }) => void,
 *     chmodSync?: (path: string, mode: number) => void,
 *   },
 *   generateId?: () => string,
 * }} [opts]
 * @returns {string}
 */
export function ensureMachineId({ home = homedir(), fs = nodeFs, generateId = randomUUID } = {}) {
  const path = machineIdPath(home)
  try {
    const existing = normalizeMachineId(fs.readFileSync(path, 'utf8'))
    if (existing) return existing
  } catch {
    // Absent or unreadable: mint below.
  }
  let minted = null
  try {
    minted = normalizeMachineId(generateId())
  } catch {
    minted = null
  }
  if (!minted) return ''
  try {
    fs.mkdirSync(dirname(path), { recursive: true })
    fs.writeFileSync(path, `${minted}\n`, { mode: 0o600 })
    // A re-mint over an existing malformed file keeps that file's mode, so
    // tighten it explicitly; a no-op on win32 and best effort everywhere.
    try {
      fs.chmodSync?.(path, 0o600)
    } catch {}
    return minted
  } catch {
    return ''
  }
}
