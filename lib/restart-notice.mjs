/**
 * restart-notice: after a restart somebody asked for, the agent knows it was restarted (board row b7276b5a).
 *
 * WHY. KC pressed Restart on an agent in the Helper on 2026-11-13. The restart was real (the old claude
 * and daemon gone, a new claude resumed the same session), but when KC asked the agent whether it had
 * been restarted it said no. A resumed session carries no line saying it was restarted, so it answered
 * from its transcript, which reads as one unbroken conversation.
 *
 * HOW. Whoever restarts the agent on purpose writes ~/.bgos-agent/<id>/restart-notice.json BEFORE it
 * hands the restart to the agent's own authority (lib/agent-restart.mjs restartAgent):
 *   owner     the owner's Restart in the app (lib/watcher-core.mjs runOwnerRestartJob)
 *   helper    the Helper's check up (lib/watcher-core.mjs runCheckupJob)
 *   watcher   the watcher's own keep-alive sweep or an update job (lib/watcher-keepalive.mjs, the
 *             update executor's restart in lib/watcher-core.mjs)
 * and withdraws it again when the restart could not be handed over. The daemon the restart brings up
 * takes it ONCE, on its first arm as the pairing lock holder (server.ts), and the first channel card it
 * sends after that carries one line in front of its text:
 *   [hoai] You were restarted by the owner at 14:02 UTC; your conversation continued.
 * Nothing is posted to chat: the line is part of the card the session reads, never a message.
 *
 * A start nobody asked for adds nothing: a first start, a crash relaunch by the hoai launcher or the
 * service, a restart the daemon asked of its own ladder (an update, the hook registration). Only the
 * watcher, the Helper or the owner leaving the file makes the line. When one of them STARTED an agent
 * whose session had already stopped (the watcher's start of a dead launcher's task, a check up or
 * owner start of an agent that stayed down) the line says "after your session stopped"; a watcher
 * restart onto an installed update says "to load an update".
 *
 * Which session a notice belongs to: the one whose daemon booted AFTER it was written (the restart's).
 * A notice written after this daemon booted is left for the next one; a notice older than
 * RESTART_NOTICE_MAX_AGE_MS at boot is a restart that never happened (it is removed, and says
 * nothing); the remove is the claim, so of two daemons racing only one tells its session.
 *
 * In the watcher's bundle (lib/watcher-bundle.mjs WATCHER_BUNDLE_FILES): plain JavaScript, node
 * builtins only, import-safe; every effect injectable.
 */

import { readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'

export const RESTART_NOTICE_FILE_NAME = 'restart-notice.json'
/** Who may leave a notice, and the words the line uses for each. */
export const RESTART_NOTICE_BY = Object.freeze({ owner: 'the owner', helper: 'the Helper', watcher: 'the watcher' })
/** Why, when the restarter knows something the agent should: what the line adds after the time. */
export const RESTART_NOTICE_WHY = Object.freeze({ stopped: ' after your session stopped', update: ' to load an update' })
/**
 * A notice older than this when the daemon boots is a restart that never came (the restart failed and
 * the watcher died before it withdrew it). Past the longest restart the watcher waits on: the owner's
 * Restart ends within 170 s, and a sweep's task start may take five bounded commands of 2 min each.
 */
export const RESTART_NOTICE_MAX_AGE_MS = 15 * 60_000

/** <stateDir>/<name>, in the state dir's own separator style (the mirror of agent-inventory joinDir). */
function noticePath(stateDir) {
  const base = String(stateDir ?? '').replace(/[\\/]+$/, '')
  if (!base) return ''
  const sep = base.includes('\\') || /^[A-Za-z]:$/.test(base) ? '\\' : '/'
  return `${base}${sep}${RESTART_NOTICE_FILE_NAME}`
}

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key)

/**
 * The file's text: who, when (ISO), and why only when it is one the line knows. Null when the
 * restarter or the time is not one.
 * @param {{ by: string, atMs: number, why?: string }} notice
 * @returns {string | null}
 */
export function restartNoticeBody({ by, atMs, why } = /** @type {any} */ ({})) {
  if (typeof by !== 'string' || !has(RESTART_NOTICE_BY, by)) return null
  if (!Number.isFinite(atMs)) return null
  const body = { by, at: new Date(atMs).toISOString(), ...(typeof why === 'string' && has(RESTART_NOTICE_WHY, why) ? { why } : {}) }
  return `${JSON.stringify(body)}\n`
}

/**
 * A notice from the file's text, or null for anything that is not one.
 * @param {unknown} text
 * @returns {{ by: string, atMs: number, why?: string } | null}
 */
export function parseRestartNotice(text) {
  if (typeof text !== 'string' || !text.trim()) return null
  let raw
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (typeof raw.by !== 'string' || !has(RESTART_NOTICE_BY, raw.by)) return null
  const atMs = typeof raw.at === 'string' ? Date.parse(raw.at) : Number.NaN
  if (!Number.isFinite(atMs)) return null
  const why = typeof raw.why === 'string' && has(RESTART_NOTICE_WHY, raw.why) ? raw.why : null
  return { by: raw.by, atMs, ...(why ? { why } : {}) }
}

/**
 * The one line the session reads, or '' when there is no notice. Hours and minutes in UTC: the daemon,
 * the watcher and the owner may each be in another time zone, and UTC is the one they all can read.
 * @param {{ by: string, atMs: number, why?: string } | null | undefined} notice
 * @returns {string}
 */
export function restartLine(notice) {
  if (!notice || typeof notice.by !== 'string' || !has(RESTART_NOTICE_BY, notice.by)) return ''
  if (!Number.isFinite(notice.atMs)) return ''
  const hhmm = new Date(notice.atMs).toISOString().slice(11, 16)
  const why = typeof notice.why === 'string' && has(RESTART_NOTICE_WHY, notice.why) ? RESTART_NOTICE_WHY[notice.why] : ''
  return `[hoai] You were restarted by ${RESTART_NOTICE_BY[notice.by]} at ${hhmm} UTC${why}; your conversation continued.`
}

/** The watcher's fs surface (lib/watcher-bundle.mjs nodeFs), what writing and withdrawing need of it. */
function defaultWriterFs() {
  return {
    readFile: (path) => {
      try {
        return readFileSync(path, 'utf8')
      } catch {
        return null
      }
    },
    writeFile: (path, text) => writeFileSync(path, text),
    rename: (from, to) => renameSync(from, to),
    rm: (path) => rmSync(path, { force: true }),
  }
}

/**
 * The restarter's half: leave the notice for the session the restart brings up. Written then renamed,
 * so the daemon never reads half of one. Best effort: false when it could not be written, never a
 * throw (a restart is never held for its notice).
 * @param {{ fs?: any, stateDir: string, by: string, atMs: number, why?: string }} input
 * @returns {boolean}
 */
export function writeRestartNotice({ fs = defaultWriterFs(), stateDir, by, atMs, why }) {
  const path = noticePath(stateDir)
  const body = restartNoticeBody({ by, atMs, ...(why ? { why } : {}) })
  if (!path || !body) return false
  const tmp = `${path}.${process.pid}.tmp`
  try {
    fs.writeFile(tmp, body)
    fs.rename(tmp, path)
    return true
  } catch {
    try {
      fs.rm(tmp)
    } catch {
      // nothing to clean
    }
    return false
  }
}

/**
 * The restarter's undo, when the restart was not handed over: remove the notice, but only the one this
 * restart wrote (its time), never a later restart's. True when it removed it.
 * @param {{ fs?: any, stateDir: string, atMs: number }} input
 * @returns {boolean}
 */
export function withdrawRestartNotice({ fs = defaultWriterFs(), stateDir, atMs }) {
  const path = noticePath(stateDir)
  if (!path) return false
  try {
    const notice = parseRestartNotice(fs.readFile(path))
    if (!notice || notice.atMs !== atMs) return false
    fs.rm(path)
    return true
  } catch {
    return false
  }
}

function defaultTakerFs() {
  return {
    readFile: (path) => {
      try {
        return readFileSync(path, 'utf8')
      } catch {
        return null
      }
    },
    unlink: (path) => unlinkSync(path),
  }
}

/**
 * The daemon's half, once, on its first arm: the notice meant for THIS session, removed so nothing reads
 * it again; null when there is none. Left in place when it was written after this daemon booted (the
 * next session's); removed and ignored when stale or junk. The remove is the claim: a daemon whose
 * remove fails lost the race to another and tells nobody.
 * @param {{ stateDir: string, bootedAtMs: number, fs?: { readFile: (path: string) => string | null, unlink: (path: string) => void } }} input
 * @returns {{ by: string, atMs: number, why?: string } | null}
 */
export function takeRestartNotice({ stateDir, bootedAtMs, fs = defaultTakerFs() }) {
  const path = noticePath(stateDir)
  if (!path) return null
  let text
  try {
    text = fs.readFile(path)
  } catch {
    return null
  }
  if (text == null) return null
  const notice = parseRestartNotice(text)
  if (notice && Number.isFinite(bootedAtMs) && notice.atMs > bootedAtMs) return null
  const stale = !notice || !Number.isFinite(bootedAtMs) || notice.atMs < bootedAtMs - RESTART_NOTICE_MAX_AGE_MS
  try {
    fs.unlink(path)
  } catch {
    return null
  }
  return stale ? null : notice
}

/**
 * Where the daemon keeps the line until a card takes it. take() hands it out once; restore() puts back a
 * line whose card did not go out, unless another card has taken one since.
 */
export function createRestartLineSlot() {
  let line = ''
  return {
    /** @param {string} next */
    set(next) {
      line = typeof next === 'string' ? next : ''
    },
    pending() {
      return line !== ''
    },
    take() {
      const out = line
      line = ''
      return out
    },
    /** @param {string} back */
    restore(back) {
      if (line === '' && typeof back === 'string') line = back
    },
  }
}

/**
 * Put the pending line in front of a channel card's text, in place, and only the text: the meta is not
 * touched, so it stays exactly as all-string as its builder made it (the wake card contract). Null when
 * nothing was added (no line pending, or a card with no text). The step says what the text was and is
 * now (the private turn tracker rekeys the card by it) and how to undo the take when the card fails.
 * @param {Record<string, unknown> | null | undefined} params
 * @param {ReturnType<typeof createRestartLineSlot>} slot
 * @returns {{ before: string, after: string, restore: () => void } | null}
 */
export function applyRestartLine(params, slot) {
  if (!params || typeof params !== 'object' || typeof params.content !== 'string') return null
  if (!slot.pending()) return null
  const line = slot.take()
  const before = params.content
  const after = `${line}\n\n${before}`
  params.content = after
  let restored = false
  return {
    before,
    after,
    restore: () => {
      if (restored) return
      restored = true
      slot.restore(line)
    },
  }
}
