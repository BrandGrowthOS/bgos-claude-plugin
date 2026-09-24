/**
 * The floor's two small files on the host (0.49.0): the ATTACHED marker and
 * the FLOOR RECORD. Plain JavaScript, node >= 18 builtins only, because the
 * blocking hook (bin/hoai-floor-hook.mjs) loads it on a bare `node`, and the
 * daemon (server.ts, under bun) loads the same file, so both sides derive
 * every path and key from one implementation.
 *
 * WHY THE HOOK NEEDS TO KNOW A DAEMON IS ATTACHED. The hook runs in EVERY
 * Claude Code session on a machine that has the plugin enabled, including a
 * person's own `claude` in some other folder and a headless `claude -p` job.
 * With no HOAI daemon behind the session there is no relay to take the ask,
 * so an `ask` becomes a terminal prompt nobody expected (or, headless, a call
 * nothing can answer). Spec 2 moment 1 and spec 8 promise that with the
 * owner's switch off nothing changes, and a HOAI agent's session is the only
 * place the switch can be on. So the daemon, while it holds its pairing lock,
 * writes a marker keyed by its PROJECT FOLDER:
 *
 *   <state>/floor/attached/<key>.json      { v, pid, at }
 *
 * and the hook asks only when it finds a marker for its own session's folder
 * (CLAUDE_PROJECT_DIR, BGOS_LAUNCH_CWD, the payload's cwd, or a folder above
 * that cwd) whose pid is still alive. The daemon keys it by its LAUNCH folder
 * first (daemonFloorFolders), because bin/bgos-launch.mjs moves its working
 * folder to the plugin folder. A crashed daemon leaves a marker with a dead pid, which
 * reads as not attached. The key is the folder normalised (slashes, a WSL
 * `/mnt/<d>/` read as `<d>:/`, case) and hashed, so a Windows daemon behind a
 * WSL session and the session itself name the same folder the same way.
 *
 * WHY THE RELAY NEEDS THE HOOK'S RECORD. The permission request the CLI
 * sends the relay carries the tool input only as `input_preview`, and the CLI
 * CUTS a long value in the middle (truncateForPreview in Claude Code
 * 2.1.281: over 3500 code points keeps the first 2000 and the last 1500).
 * A listed action in the middle of a long command is therefore invisible to
 * the relay, and a relay that decided from the preview alone auto approved
 * it (the review's `echo <2500 a> ; rm -rf ~/work ; echo <2000 b>`). The
 * hook saw the WHOLE input, so on a match it writes, before it asks:
 *
 *   <state>/floor/asks/<key>/<at>-<pid>-<rand>.json
 *   { v, at, toolName, ruleId, rulesVersion, evidence, permissionMode,
 *     sessionId, toolUseId, probe: { head, tail } }
 *
 * and the relay, synchronously and before its auto approve branch, takes the
 * record for the request (spec part 24, decision 3(b)). The request carries no
 * tool_use_id, so a record is matched by tool name, age and a PROBE: a short
 * hash of the first and of the last 40 letters and digits of the value's JSON
 * rendering, which survive the CLI's middle cut, its whitespace folding and
 * its replacement of odd characters (the probe keeps letters and digits
 * only), and which keep the command's own text out of the record. A redaction can
 * change them, so a record the probe cannot confirm is still taken when it is
 * the oldest one for that tool: a wrong pairing only ever ASKS about the
 * other request, it never lets one through unasked.
 *
 * Every function here swallows its own filesystem errors: a floor that fails
 * because a directory is missing is worse than one that falls back.
 */

import { createHash, randomBytes } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** The directory under the plugin state root that holds both files. */
export const FLOOR_STATE_DIR_NAME = 'floor'

/** A record the relay has not taken within this long is not for any request now. */
export const FLOOR_RECORD_MATCH_WINDOW_MS = 120_000

/** A record older than this is swept on the next read. */
export const FLOOR_RECORD_STALE_MS = 10 * 60_000

/** The evidence kept in a record: enough for the server to read the match. */
export const FLOOR_RECORD_EVIDENCE_MAX = 3500

/** How many letters and digits each end of the probe keeps. */
export const FLOOR_PROBE_CHARS = 40

/** How many folders up from the payload's cwd the hook looks for a marker. */
export const FLOOR_ATTACH_MAX_ANCESTORS = 24

/** The plugin state root, derived exactly as lib/hook-intake.ts and the forwarder do. */
export function floorStateRoot(env = process.env, home = homedir()) {
  return (env && env.BGOS_PLUGIN_STATE_DIR) || join(home, '.bgos-plugin-state')
}

/**
 * A folder as both sides of a session name it: slashes forward, a WSL
 * `/mnt/<d>/` read as the Windows drive, no trailing slash, lower case.
 */
export function normalizeFloorFolder(folder) {
  let path = String(folder ?? '').trim().replace(/\\/g, '/')
  if (!path) return ''
  path = path.replace(/^\/\/[?.]\//, '')
  path = path.replace(/^\/mnt\/([a-z])(?=\/|$)/i, '$1:')
  path = path.replace(/\/{2,}/g, '/')
  if (path.length > 1) path = path.replace(/\/+$/, '')
  if (/^[a-z]:$/i.test(path)) path += '/'
  return path.toLowerCase()
}

/** The key a folder's marker and records live under, or '' for no folder. */
export function floorKey(folder) {
  const normalized = normalizeFloorFolder(folder)
  if (!normalized) return ''
  return createHash('sha256').update(normalized).digest('hex').slice(0, 32)
}

export function attachedMarkerPath(root, key) {
  return join(root, FLOOR_STATE_DIR_NAME, 'attached', `${key}.json`)
}

export function floorAsksDir(root, key) {
  return join(root, FLOOR_STATE_DIR_NAME, 'asks', key)
}

/** A folder and every folder above it, nearest first, bounded. */
export function folderAndAncestors(folder, max = FLOOR_ATTACH_MAX_ANCESTORS) {
  const out = []
  let path = String(folder ?? '').trim().replace(/\\/g, '/').replace(/\/+$/, '')
  while (path && out.length <= max) {
    out.push(path)
    const cut = path.lastIndexOf('/')
    if (cut <= 0) {
      if (cut === 0 && path.length > 1) out.push('/')
      break
    }
    const parent = path.slice(0, cut)
    if (/^[A-Za-z]:$/.test(parent)) {
      out.push(`${parent}/`)
      break
    }
    path = parent
  }
  return out
}

/** Each folder once by its key, empty and unkeyable ones dropped, order kept. */
function distinctFolders(folders) {
  const seen = new Set()
  return folders.filter((f) => {
    if (typeof f !== 'string' || !f.trim()) return false
    const key = floorKey(f)
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** An env value when it is a non blank string, else ''. */
function envFolder(env, name) {
  const value = env && typeof env[name] === 'string' ? env[name] : ''
  return value.trim() ? value : ''
}

/**
 * The folders the DAEMON keys its attached marker and reads the hook's
 * records by, most specific first:
 *
 *   launchCwd           the folder the operator launched from (server.ts
 *                       LAUNCH_CWD: BGOS_LAUNCH_CWD, else its own cwd).
 *                       bin/bgos-launch.mjs moves bun's working folder to the
 *                       PLUGIN folder so bun can resolve the server's
 *                       dependencies and passes the original through as
 *                       BGOS_LAUNCH_CWD, so this, and not `cwd`, is the
 *                       session's project folder on a launcher start.
 *   CLAUDE_PROJECT_DIR  when the CLI passed it down. The live proof of wave
 *                       B1b lost it across the WSL hop, and with the marker
 *                       keyed by it and `cwd` alone the floor silently did
 *                       not ask; the launch folder is the key that survives.
 *   cwd                 the process's own folder, as before.
 */
export function daemonFloorFolders({ launchCwd = '', cwd = '', env = process.env } = {}) {
  return distinctFolders([launchCwd, envFolder(env, 'CLAUDE_PROJECT_DIR'), cwd])
}

/**
 * The folders a hook payload's session may be keyed by, most specific first:
 * CLAUDE_PROJECT_DIR, BGOS_LAUNCH_CWD when the hook's environment carries it
 * (the same key the daemon writes first), then the payload's cwd and the
 * folders above it.
 */
export function sessionFolders(payload, env = process.env) {
  const folders = []
  const project = envFolder(env, 'CLAUDE_PROJECT_DIR')
  if (project) folders.push(project)
  const launch = envFolder(env, 'BGOS_LAUNCH_CWD')
  if (launch) folders.push(launch)
  const cwd = payload && typeof payload.cwd === 'string' ? payload.cwd : ''
  if (cwd.trim()) folders.push(...folderAndAncestors(cwd))
  return distinctFolders(folders)
}

/** Is a pid alive? A permission error means it is, somebody else's. */
export function pidIsAlive(pid) {
  const n = Number(pid)
  if (!Number.isSafeInteger(n) || n <= 0) return false
  try {
    process.kill(n, 0)
    return true
  } catch (err) {
    return Boolean(err && err.code === 'EPERM')
  }
}

const defaultFs = {
  exists: (p) => existsSync(p),
  read: (p) => readFileSync(p, 'utf8'),
  write: (p, text) => writeFileSync(p, text),
  mkdir: (p) => mkdirSync(p, { recursive: true }),
  list: (p) => readdirSync(p),
  remove: (p) => unlinkSync(p),
}

/**
 * The daemon's half: mark this project folder attached. Answers the keys
 * written (one per distinct folder), [] when nothing could be written.
 */
export function markFloorAttached({ root, folders, pid = process.pid, now = Date.now(), fs = defaultFs }) {
  const keys = []
  for (const folder of folders) {
    const key = floorKey(folder)
    if (!key || keys.includes(key)) continue
    try {
      const path = attachedMarkerPath(root, key)
      fs.mkdir(join(root, FLOOR_STATE_DIR_NAME, 'attached'))
      fs.write(path, `${JSON.stringify({ v: 1, pid, at: now })}\n`)
      keys.push(key)
    } catch {
      /* a marker that cannot be written leaves the hook silent, as before 0.49.0 */
    }
  }
  return keys
}

/** Take this daemon's markers down (only the ones that still name this pid). */
export function clearFloorAttached({ root, keys, pid = process.pid, fs = defaultFs }) {
  for (const key of keys) {
    try {
      const path = attachedMarkerPath(root, key)
      const marker = JSON.parse(fs.read(path))
      if (marker && Number(marker.pid) === Number(pid)) fs.remove(path)
    } catch {
      /* gone already */
    }
  }
}

/**
 * The hook's half: the key of a live marker for this session, or null.
 */
export function findAttachedKey({ root, folders, fs = defaultFs, isAlive = pidIsAlive }) {
  for (const folder of folders) {
    const key = floorKey(folder)
    if (!key) continue
    try {
      const path = attachedMarkerPath(root, key)
      if (!fs.exists(path)) continue
      const marker = JSON.parse(fs.read(path))
      if (marker && isAlive(marker.pid)) return key
    } catch {
      /* unreadable: not attached */
    }
  }
  return null
}

function alnum(text) {
  return String(text ?? '').replace(/[^A-Za-z0-9]/g, '')
}

/** Each end of a probe is kept as a short hash, so a record never holds the command's text. */
function probeOf(head, tail) {
  const hash = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16)
  return { head: hash(head), tail: hash(tail) }
}

/** The probe of a value as the hook holds it: its JSON rendering, letters and digits. */
export function valueProbe(value) {
  const letters = alnum(JSON.stringify(typeof value === 'string' ? value : ''))
  return probeOf(letters.slice(0, FLOOR_PROBE_CHARS), letters.slice(-FLOOR_PROBE_CHARS))
}

/** Which key of a tool input the floor reads, by the tool's name. */
export function probeKeyFor(toolName, toolInput) {
  const name = String(toolName ?? '')
  if (name === 'Bash' || name === 'PowerShell') return 'command'
  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(name)) {
    const input = toolInput && typeof toolInput === 'object' ? toolInput : {}
    return typeof input.file_path === 'string' ? 'file_path' : 'notebook_path'
  }
  return null
}

const ELISION_RE = /\n⋯ \d+ code points? elided ⋯\n/

/**
 * The probe of a value as the relay sees it, read raw out of the preview (the
 * JSON rendering, so its letters are the ones valueProbe counts), with the
 * CLI's middle cut taken out: the head from before the cut, the tail from
 * after it. Null when the preview does not carry the key.
 */
export function previewProbe(key, inputPreview) {
  if (!key) return probeOf('', '')
  const text = String(inputPreview ?? '')
  const match = new RegExp(`"${key}"\\s*:\\s*("(?:[^"\\\\]|\\\\[\\s\\S])*"?)`).exec(text)
  if (!match) return null
  const raw = match[1]
  const parts = raw.split(ELISION_RE)
  const head = alnum(parts[0])
  const tail = alnum(parts[parts.length - 1])
  return probeOf(head.slice(0, FLOOR_PROBE_CHARS), tail.slice(-FLOOR_PROBE_CHARS))
}

/**
 * The record the hook writes for one matched call.
 * @param {{ toolName: string, toolInput: unknown, match: { ruleId: string, rulesVersion: number, evidence: string },
 *   payload?: Record<string, unknown>, now?: number }} input
 */
export function buildFloorRecord({ toolName, toolInput, match, payload = {}, now = Date.now() }) {
  const key = probeKeyFor(toolName, toolInput)
  const input = toolInput && typeof toolInput === 'object' ? toolInput : {}
  return {
    v: 1,
    at: now,
    toolName: String(toolName ?? ''),
    ruleId: String(match.ruleId ?? ''),
    rulesVersion: Number(match.rulesVersion ?? 0),
    evidence: String(match.evidence ?? '').slice(0, FLOOR_RECORD_EVIDENCE_MAX),
    permissionMode: typeof payload.permission_mode === 'string' ? payload.permission_mode : null,
    sessionId: typeof payload.session_id === 'string' ? payload.session_id : null,
    toolUseId: typeof payload.tool_use_id === 'string' ? payload.tool_use_id : null,
    probe: key ? valueProbe(input[key]) : probeOf('', ''),
  }
}

/** Write one record under a key. Never throws; answers the path or null. */
export function writeFloorRecord({ root, key, record, fs = defaultFs, suffix = randomBytes(4).toString('hex') }) {
  try {
    const dir = floorAsksDir(root, key)
    fs.mkdir(dir)
    const path = join(dir, `${record.at}-${process.pid}-${suffix}.json`)
    fs.write(path, `${JSON.stringify(record)}\n`)
    return path
  } catch {
    return null
  }
}

function isRecordShape(value) {
  return (
    value &&
    typeof value === 'object' &&
    value.v === 1 &&
    typeof value.at === 'number' &&
    typeof value.toolName === 'string' &&
    typeof value.ruleId === 'string' &&
    typeof value.evidence === 'string'
  )
}

/**
 * The relay's half: TAKE (read and delete) the record for one permission
 * request, or null. Synchronous on purpose: it runs inside the request
 * handler, before the auto approve branch, not on any drain's cadence.
 * Stale and unreadable records are swept on the way.
 */
export function takeFloorRecord({ root, keys, toolName, inputPreview, now = Date.now(), fs = defaultFs }) {
  const candidates = []
  for (const key of keys) {
    const dir = floorAsksDir(root, key)
    let names = []
    try {
      names = fs.list(dir)
    } catch {
      continue
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const path = join(dir, name)
      let record = null
      try {
        record = JSON.parse(fs.read(path))
      } catch {
        record = null
      }
      if (!isRecordShape(record) || now - record.at > FLOOR_RECORD_STALE_MS) {
        try {
          fs.remove(path)
        } catch {
          /* swept by someone else */
        }
        continue
      }
      if (record.toolName !== String(toolName ?? '')) continue
      if (now - record.at > FLOOR_RECORD_MATCH_WINDOW_MS || record.at - now > FLOOR_RECORD_MATCH_WINDOW_MS) continue
      candidates.push({ path, record })
    }
  }
  if (candidates.length === 0) return null
  candidates.sort((a, b) => a.record.at - b.record.at || (a.path < b.path ? -1 : 1))
  const key = probeKeyFor(toolName, {})
  const seen =
    key === null
      ? probeOf('', '')
      : key === 'command'
        ? previewProbe('command', inputPreview)
        : previewProbe('file_path', inputPreview) ?? previewProbe('notebook_path', inputPreview)
  const probeFits = (record) => {
    const probe = record.probe && typeof record.probe === 'object' ? record.probe : null
    return Boolean(seen && probe && seen.head === probe.head && seen.tail === probe.tail)
  }
  const chosen = candidates.find((c) => probeFits(c.record)) ?? candidates[0]
  try {
    fs.remove(chosen.path)
  } catch {
    // Another taker got there first: the record is still the right one to use.
  }
  return chosen.record
}
