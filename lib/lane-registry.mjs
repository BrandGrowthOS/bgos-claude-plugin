/**
 * PERSON LANES, the registry and the locks (shared agents Phase 3, P3;
 * design 4.2 "Who owns the lanes" and "Caps").
 *
 * ONE machine wide registry, `~/.bgos-agent/lanes-machine.json`, under a file
 * lock, lists every recipient lane running on this computer across every
 * agent, so caps count across agents and a restarted owner daemon re-reads
 * which lanes run instead of forgetting them. Each entry is owned by the
 * lane's supervisor process (bin/hoai-lane.mjs); an entry whose supervisor is
 * gone is pruned on every locked read, so a crash never holds a place.
 *
 * The SINGLETON per lane is a lock file in the lane folder holding the
 * supervisor's pid: two wakes for one person can never start two Claudes,
 * because the second supervisor finds the first alive and leaves.
 *
 * Every function takes its file system and its process checks as
 * parameters (house pattern, testable without touching the machine).
 *
 * No em or en dashes in this file.
 */
import * as nodeFs from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname } from 'node:path'

/** A registry lock older than this is a dead holder's (registry work takes milliseconds). */
export const REGISTRY_LOCK_STALE_MS = 15_000
/** How long a caller waits for the registry lock before giving up. */
export const REGISTRY_LOCK_WAIT_MS = 5_000

const SUPERVISOR_SCRIPT = 'hoai-lane.mjs'

/** Is a pid alive? `kill(pid, 0)`: EPERM still means alive. */
export function defaultPidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err?.code === 'EPERM'
  }
}

/** The command line of a pid, or '' (POSIX `ps`; Windows has no lanes in P3). */
export function defaultPidCommand(pid) {
  if (process.platform === 'win32') return ''
  try {
    const out = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: 3000 })
    return String(out.stdout ?? '').trim()
  } catch {
    return ''
  }
}

/** Is this pid a live lane supervisor (alive, and running bin/hoai-lane.mjs)? */
export function isLiveSupervisor(pid, { pidAlive = defaultPidAlive, pidCommand = defaultPidCommand } = {}) {
  if (!pidAlive(pid)) return false
  const command = pidCommand(pid)
  // An unreadable command line keeps the lock (a false "alive" waits; a false
  // "dead" would start a second Claude for one person).
  return command === '' || command.includes(SUPERVISOR_SCRIPT)
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

let tmpCounter = 0

/**
 * Create `lockPath` holding `body`, atomically and only if it does not exist:
 * the body is written to a private temp file first and then hard linked into
 * place, so the lock never exists empty (an empty file read in the gap
 * between an O_EXCL create and its write used to look like a dead holder and
 * be taken over: security review finding 2). True when this call created it.
 */
export function createLockFile(lockPath, body, { fs = nodeFs } = {}) {
  tmpCounter += 1
  const tmp = `${lockPath}.${process.pid}.${tmpCounter}.tmp`
  fs.writeFileSync(tmp, body, { mode: 0o600 })
  try {
    fs.linkSync(tmp, lockPath)
    return true
  } catch (err) {
    if (err?.code === 'EEXIST') return false
    throw err
  } finally {
    try { fs.unlinkSync(tmp) } catch { /* gone */ }
  }
}

/**
 * Take over a lock judged stale, safely against a racing taker: the file is
 * renamed aside (only one rename of it can succeed), and only if what was
 * moved is still exactly the text judged stale is it dropped. Anything else
 * (a fresh lock another process made in between) is put back if the place is
 * still free. True when the stale lock is gone and a create may be tried.
 */
export function takeOverStaleLock(lockPath, staleText, { fs = nodeFs } = {}) {
  tmpCounter += 1
  const aside = `${lockPath}.stale-${process.pid}-${tmpCounter}`
  try {
    fs.renameSync(lockPath, aside)
  } catch {
    return true
  }
  let moved = null
  try {
    moved = String(fs.readFileSync(aside, 'utf8'))
  } catch { /* unreadable: treat as the stale one */ }
  if (moved === null || moved === staleText) {
    try { fs.unlinkSync(aside) } catch { /* gone */ }
    return true
  }
  try { fs.linkSync(aside, lockPath) } catch { /* the place was taken again */ }
  try { fs.unlinkSync(aside) } catch { /* gone */ }
  return false
}

/** How old an unreadable lock must be before it counts as abandoned. */
export const UNREADABLE_LOCK_GRACE_MS = 10_000

function lockAgeMs(fs, path, now) {
  try {
    return now() - fs.statSync(path).mtimeMs
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

/**
 * Run `fn` while holding `<path>.lock`. A lock older than
 * REGISTRY_LOCK_STALE_MS, or whose holder is dead, is taken over.
 *
 * @template T
 * @param {string} path
 * @param {() => T} fn
 * @param {{ fs?: typeof nodeFs, now?: () => number, pidAlive?: (pid: number) => boolean,
 *   waitMs?: number, sleep?: (ms: number) => void }} [deps]
 * @returns {T}
 */
export function withFileLock(path, fn, { fs = nodeFs, now = Date.now, pidAlive = defaultPidAlive, waitMs = REGISTRY_LOCK_WAIT_MS, sleep = sleepSync } = {}) {
  const lockPath = `${path}.lock`
  fs.mkdirSync(dirname(lockPath), { recursive: true })
  const deadline = now() + waitMs
  const body = JSON.stringify({ pid: process.pid, at: now() })
  for (;;) {
    if (createLockFile(lockPath, body, { fs })) break
    let text = null
    let stale = false
    try {
      text = String(fs.readFileSync(lockPath, 'utf8'))
      const held = JSON.parse(text)
      stale = !Number.isFinite(held?.at) || now() - held.at > REGISTRY_LOCK_STALE_MS || !pidAlive(Number(held?.pid))
    } catch {
      // Unreadable (or gone between the create and the read): abandoned only
      // once it is old; a missing one is simply retried.
      stale = text !== null && lockAgeMs(fs, lockPath, now) > UNREADABLE_LOCK_GRACE_MS
    }
    if (stale && takeOverStaleLock(lockPath, text, { fs })) continue
    if (now() >= deadline) throw new Error(`lane registry: ${lockPath} is held`)
    sleep(50)
  }
  try {
    return fn()
  } finally {
    // Only our own lock is removed.
    try {
      if (String(fs.readFileSync(lockPath, 'utf8')) === body) fs.unlinkSync(lockPath)
    } catch { /* already gone */ }
  }
}

/** Read the registry leniently: a missing or unreadable file is empty. */
export function readRegistry(path, { fs = nodeFs } = {}) {
  try {
    const raw = JSON.parse(String(fs.readFileSync(path, 'utf8')))
    const lanes = Array.isArray(raw?.lanes) ? raw.lanes : []
    return {
      v: 1,
      lanes: lanes
        .filter((l) => l && typeof l === 'object' && typeof l.userId === 'string' && l.assistantId != null)
        .map((l) => ({ ...l, assistantId: String(l.assistantId), supervisorPid: Number(l.supervisorPid) })),
    }
  } catch {
    return { v: 1, lanes: [] }
  }
}

/** Write the registry atomically (tmp then rename), mode 0600. */
export function writeRegistry(path, registry, { fs = nodeFs } = {}) {
  fs.mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify({ v: 1, lanes: registry.lanes }, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(tmp, path)
}

/** Drop every entry whose supervisor is gone. */
export function pruneRegistry(registry, { isAlive }) {
  return { v: 1, lanes: registry.lanes.filter((l) => isAlive(l.supervisorPid)) }
}

/**
 * Read, prune, change and write the registry under its lock, in one step.
 *
 * @template T
 * @param {string} path
 * @param {(registry: { v: 1, lanes: any[] }) => { registry?: { v: 1, lanes: any[] }, result: T }} change
 * @param {{ fs?: typeof nodeFs, isAlive?: (pid: number) => boolean, lockDeps?: object }} [deps]
 * @returns {T}
 */
export function updateRegistry(path, change, { fs = nodeFs, isAlive = (pid) => isLiveSupervisor(pid), lockDeps = {} } = {}) {
  return withFileLock(path, () => {
    const before = readRegistry(path, { fs })
    const pruned = pruneRegistry(before, { isAlive })
    const { registry, result } = change(pruned)
    const next = registry ?? pruned
    if (registry || pruned.lanes.length !== before.lanes.length) writeRegistry(path, next, { fs })
    return result
  }, { fs, ...lockDeps })
}

// ── The singleton per lane ──────────────────────────────────────────────────

/**
 * Take the lane's supervisor lock. `acquired: false` names the live holder;
 * a lock whose holder is gone (or is not a lane supervisor any more, a reused
 * pid) is reclaimed.
 *
 * @param {string} lockPath
 * @param {{ fs?: typeof nodeFs, selfPid?: number, isAlive?: (pid: number) => boolean, now?: () => number }} [deps]
 * @returns {{ acquired: true, reclaimed: boolean } | { acquired: false, holderPid: number }}
 */
export function acquireLaneLock(lockPath, { fs = nodeFs, selfPid = process.pid, isAlive = (pid) => isLiveSupervisor(pid), now = Date.now } = {}) {
  fs.mkdirSync(dirname(lockPath), { recursive: true })
  let reclaimed = false
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (createLockFile(lockPath, JSON.stringify({ pid: selfPid, at: new Date(now()).toISOString() }), { fs })) {
      return { acquired: true, reclaimed }
    }
    let text = null
    let holder = NaN
    try {
      text = String(fs.readFileSync(lockPath, 'utf8'))
      holder = Number(JSON.parse(text)?.pid)
    } catch { /* unreadable or gone */ }
    if (holder === selfPid) return { acquired: true, reclaimed }
    if (Number.isSafeInteger(holder) && holder > 0 && isAlive(holder)) return { acquired: false, holderPid: holder }
    if (text === null) continue
    // Unreadable but young: someone may still be making it.
    if (!(Number.isSafeInteger(holder) && holder > 0) && lockAgeMs(fs, lockPath, now) <= UNREADABLE_LOCK_GRACE_MS) {
      return { acquired: false, holderPid: NaN }
    }
    if (takeOverStaleLock(lockPath, text, { fs })) reclaimed = true
  }
  return { acquired: false, holderPid: NaN }
}

/** Release the lane lock, only if this process holds it. */
export function releaseLaneLock(lockPath, { fs = nodeFs, selfPid = process.pid } = {}) {
  try {
    const holder = Number(JSON.parse(String(fs.readFileSync(lockPath, 'utf8')))?.pid)
    if (holder === selfPid) fs.unlinkSync(lockPath)
  } catch { /* gone */ }
}

/** The pid holding a lane's supervisor lock when it is a live supervisor, else null. */
export function liveLaneSupervisor(lockPath, { fs = nodeFs, isAlive = (pid) => isLiveSupervisor(pid) } = {}) {
  try {
    const holder = Number(JSON.parse(String(fs.readFileSync(lockPath, 'utf8')))?.pid)
    return Number.isSafeInteger(holder) && holder > 0 && isAlive(holder) ? holder : null
  } catch {
    return null
  }
}
