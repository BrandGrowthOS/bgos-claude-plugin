/**
 * peer-refusal-counter: how often a PEER agent's request needed a private tool
 * and was refused (board 614cd7df follow-up, KC 2026-10-12: "a peer request
 * from a trusted agent should be able to run private tools; he is happy to wait
 * and see the impact before deciding", docs/proposals/peer-delegation-private-tools.md).
 *
 * Since 0.67.0 a boards, schedule or browser call runs only inside a turn whose
 * sender is a verified human, and a message that arrives from another agent is
 * never one. The refusal is correct; this only makes it COUNTABLE so the
 * delegation question can be decided on numbers:
 *
 *   - one log line per refused call: tool name, the delegate (the peer
 *     assistant's id), this agent's id and the day's running count;
 *   - one small file beside the daemon's state, per day and per
 *     "<delegate>:<tool>", so a daily count is a file read, not a log grep.
 *
 * NO CONTENT, EVER: no message text, no tool arguments, no chat or board names.
 * Only ids and the tool's name. Best effort: a write failure is swallowed and
 * never changes the refusal.
 *
 * Plain JavaScript, node >= 18 builtins only, import-safe; fs and clock are
 * injectable so tests never touch a real state directory.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const PEER_REFUSAL_FILE_NAME = 'peer-private-refusals.json'
/** Days of counts kept; older days are dropped on the next write. */
export const PEER_REFUSAL_KEEP_DAYS = 30

/**
 * An id or a tool name, never free text: anything that is not a short run of letters, digits, dot, colon, dash
 * and underscore is replaced whole (not scrubbed, so a sentence cannot survive as a glued-together word).
 */
const safeToken = (value) => {
  const text = String(value ?? '')
  return /^[A-Za-z0-9_.:-]{1,64}$/.test(text) ? text : 'invalid'
}

/** @param {number} ms */
export function dayKey(ms) {
  return new Date(ms).toISOString().slice(0, 10)
}

function readDoc(path, fs) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path, 'utf8'))
    if (parsed && typeof parsed === 'object' && parsed.days && typeof parsed.days === 'object') return parsed
  } catch {
    /* absent or junk: start again */
  }
  return { v: 1, days: {} }
}

/**
 * Record one refused private call that came on a peer turn.
 * @param {{ dir: string, tool: string, delegate: string | number, target: string | number,
 *   now?: number, fs?: { readFileSync: Function, writeFileSync: Function, renameSync: Function, mkdirSync: Function } }} input
 * @returns {{ line: string, count: number, day: string }}
 */
export function recordPeerRefusal({ dir, tool, delegate, target, now = Date.now(), fs = { readFileSync, writeFileSync, renameSync, mkdirSync } }) {
  const day = dayKey(now)
  const key = `${safeToken(delegate)}:${safeToken(tool)}`
  const path = join(dir, PEER_REFUSAL_FILE_NAME)
  let count = 1
  try {
    const doc = readDoc(path, fs)
    const today = (doc.days[day] ??= {})
    today[key] = (Number(today[key]) || 0) + 1
    count = today[key]
    const keep = Object.keys(doc.days).sort().slice(-PEER_REFUSAL_KEEP_DAYS)
    for (const old of Object.keys(doc.days)) if (!keep.includes(old)) delete doc.days[old]
    fs.mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.${process.pid}.tmp`
    fs.writeFileSync(tmp, `${JSON.stringify(doc)}\n`)
    fs.renameSync(tmp, path)
  } catch {
    /* counting never changes the refusal */
  }
  return {
    day,
    count,
    line: `peer private call refused: tool=${safeToken(tool)} delegate=${safeToken(delegate)} target=${safeToken(target)} today=${count}`,
  }
}

/** The day's counts, summed per tool and per delegate, for a reader (a doctor row, a test). */
export function readPeerRefusals(dir, day, fs = { readFileSync }) {
  const doc = readDoc(join(dir, PEER_REFUSAL_FILE_NAME), fs)
  const entries = doc.days[day] ?? {}
  const byTool = {}
  const byDelegate = {}
  let total = 0
  for (const [key, raw] of Object.entries(entries)) {
    const n = Number(raw) || 0
    const [delegate, tool] = key.split(':')
    total += n
    byTool[tool] = (byTool[tool] ?? 0) + n
    byDelegate[delegate] = (byDelegate[delegate] ?? 0) + n
  }
  return { day, total, byTool, byDelegate }
}
