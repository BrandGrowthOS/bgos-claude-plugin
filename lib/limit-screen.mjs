/**
 * limit-screen: the PURE rules for freeing an agent stuck on Claude Code's usage limit screen
 * (Kc 2026-11-01, chat 4465 msg 180081; docs/notes/feat/watcher-frees-limit-stuck.md).
 *
 * When a claude.ai usage limit rejects a turn, Claude Code 2.1.316 writes a synthetic `rate_limit`
 * record into the transcript and opens its rate limit options dialog: a modal picker titled
 * "What do you want to do?". While it is open every queued message waits, and typed text goes to the
 * picker (so /login cannot be typed). ONE Enter on its default, "Stop and wait for limit to reset",
 * closes it and the queue drains. Behind a CLI flag the order flips and the first choice buys usage
 * credits, so the key is never blind: it is derived from the screen, as lib/gate-block.tcl does.
 *
 *   readLimitScreen(text)         is this screen the limit picker with the pointer on the safe choice?
 *   usageBackFrom(...)            is usage available again, by proof (the reset passed, or the login
 *                                 file changed after the limit; its mtime only, never its content)?
 *   decideLimitFree(...)          the gates in order: limit, usage back, one Enter per hour, a key
 *                                 path, a screen that was read and is safe.
 *   parseLimitNotice(raw)         the watcher's note to the daemon: tokens and times only.
 *   limitNoticeText(notice)       the owner's words, from fixed templates.
 *
 * Nothing here touches a file, a process, a clock or the network: every input is a value, so every
 * rule is a row in test/limit-screen.test.ts. Plain JavaScript, node >= 18, no imports.
 */

/** Never more than one Enter per agent per hour. */
export const LIMIT_ENTER_MIN_INTERVAL_MS = 60 * 60_000
/** The reset time counts as passed a minute after it (clock skew between this computer and Claude's). */
export const RESET_GRACE_MS = 60_000

/** "You've hit your weekly limit", "You've hit your session limit", "You've reached your Fable limit." */
const LIMIT_LINE_RE = /You(?:'|’)ve (?:hit|reached) your\b.*\blimit\b/
const TITLE_RE = /What do you want to do\?/
const FOOTER_RE = /\bEnter to confirm\b/
/** The one choice an Enter may land on: it closes the picker and spends nothing. */
const SAFE_CHOICE_RE = /\bStop and wait for limit to reset\b/
/** A numbered choice row that carries the pointer: the figures pointer, or ">" where the console has no glyph for it. */
const POINTED_ROW_RE = /^[\s│|]*(?:❯|>)\s+\d+\.\s/
/** Key hints only a dialog prints ("Enter to confirm", "Esc to cancel"). */
const DIALOG_HINT_RE = /\b(?:Enter|Esc) to\b/
/** The picker opens right under the limit line (the line, a blank row, the top border, the title). */
export const LIMIT_TO_TITLE_MAX_ROWS = 6

/**
 * Read a screen (tmux capture-pane, or the Windows console's visible rows). It is the screen to press
 * ONLY when it shows, top to bottom: the NEWEST limit line, the dialog title at most a few rows under
 * it, the safe choice carrying the ONLY pointer inside the dialog, the "Enter to confirm" footer, and
 * nothing dialog like after that footer (no choice row, no title, no key hint), and no second title or
 * footer anywhere on the screen. A dialog quoted above the newest limit line, one far under it, a
 * second one below it, or two on one screen is never the picker.
 * @param {unknown} text
 * @returns {{ ok: boolean, reason: string, limitLine: string | null }}
 */
export function readLimitScreen(text) {
  if (typeof text !== 'string' || !text.trim()) return seen(false, 'empty', null)
  const rows = text.split(/\r?\n/).map((row) => row.replace(/\s+$/, ''))
  let lastLimit = -1
  for (let i = rows.length - 1; i >= 0; i--) {
    if (LIMIT_LINE_RE.test(rows[i])) {
      lastLimit = i
      break
    }
  }
  if (lastLimit < 0) return seen(false, 'no_limit_line', null)
  const limitLine = rows[lastLimit].trim()
  // The picker the newest limit opened: its title comes after that line, and close to it.
  const title = rows.findIndex((row, i) => i > lastLimit && TITLE_RE.test(row))
  if (title < 0) return seen(false, 'no_picker', limitLine)
  if (title - lastLimit > LIMIT_TO_TITLE_MAX_ROWS) return seen(false, 'limit_line_far', limitLine)
  const footer = rows.findIndex((row, i) => i > title && FOOTER_RE.test(row))
  if (footer < 0) return seen(false, 'no_footer', limitLine)
  const below = rows.slice(footer + 1)
  if (below.some((row) => POINTED_ROW_RE.test(row) || TITLE_RE.test(row) || DIALOG_HINT_RE.test(row))) return seen(false, 'below_footer', limitLine)
  // One dialog on the screen, or none is pressed: with a second title or footer anywhere, the newest
  // copy (text painted under an open dialog, or a quote) may hide the real picker and its pointer.
  if (rows.filter((row) => TITLE_RE.test(row)).length > 1 || rows.filter((row) => FOOTER_RE.test(row)).length > 1) return seen(false, 'two_dialogs', limitLine)
  const dialog = rows.slice(title + 1, footer)
  if (!dialog.some((row) => SAFE_CHOICE_RE.test(row))) return seen(false, 'no_safe_option', limitLine)
  const pointed = dialog.filter((row) => POINTED_ROW_RE.test(row))
  if (pointed.length !== 1) return seen(false, 'selection_unreadable', limitLine)
  if (!SAFE_CHOICE_RE.test(pointed[0])) return seen(false, 'selection_elsewhere', limitLine)
  return seen(true, 'limit_picker_on_safe_option', limitLine)
}

function seen(ok, reason, limitLine) {
  return { ok, reason, limitLine }
}

/**
 * Is usage available again? Only on proof:
 *   reset_passed   now is at least a minute past the reset time the CLI recorded with the limit;
 *   login_changed  the Claude credential file's mtime is AFTER the limit record (a different login,
 *                  or a renewed one). The caller stats it; nothing here or there ever reads it.
 *                  Not while loginProofSpent: Ares's ruling (option A, 2026-11-02), once a press on
 *                  this proof was followed by the limit again, only the reset time counts for that
 *                  agent until the reset passes.
 * @param {{ now: number, limit: { atMs: number, resetsAtMs: number | null } | null, credentialsMtimeMs: number | null, loginProofSpent?: boolean }} input
 * @returns {{ back: boolean, how: 'reset_passed' | 'login_changed' | null }}
 */
export function usageBackFrom({ now, limit, credentialsMtimeMs, loginProofSpent = false }) {
  if (!limit || !finite(limit.atMs)) return { back: false, how: null }
  if (finite(limit.resetsAtMs) && finite(now) && now - limit.resetsAtMs >= RESET_GRACE_MS) return { back: true, how: 'reset_passed' }
  if (loginProofSpent !== true && finite(credentialsMtimeMs) && credentialsMtimeMs > limit.atMs) return { back: true, how: 'login_changed' }
  return { back: false, how: null }
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * The gates, in order; the first that says no wins:
 *   none          no limit in the transcript
 *   report        still_limited (C9 is reported elsewhere; the screen is not even read)
 *   wait          one_enter_per_hour, with retryAtMs
 *   report        no_key_path:<why> (nothing can press here: the owner gets the one tap fix)
 *   read_screen   usage is back and the screen has not been read yet
 *   report        screen_unreadable, or screen_unclear:<reason>
 *   press         ONE Enter; the reason is how usage came back
 * @param {{ now: number, limit: object | null, usage: { back: boolean, how: string | null },
 *   lastEnterAtMs: number | null, keyPath: { ok: boolean, reason?: string },
 *   screen: { ok: boolean, reason: string } | null | undefined }} input
 * @returns {{ act: 'none' | 'report' | 'wait' | 'read_screen' | 'press', reason: string, retryAtMs?: number }}
 */
export function decideLimitFree({ now, limit, usage, lastEnterAtMs, keyPath, screen }) {
  if (!limit) return { act: 'none', reason: 'no_limit' }
  if (!usage || usage.back !== true) return { act: 'report', reason: 'still_limited' }
  // No clock, no hour gate: never a key on a time that cannot be compared.
  if (!finite(now)) return { act: 'wait', reason: 'no_clock', retryAtMs: null }
  if (finite(lastEnterAtMs) && now - lastEnterAtMs < LIMIT_ENTER_MIN_INTERVAL_MS) {
    return { act: 'wait', reason: 'one_enter_per_hour', retryAtMs: lastEnterAtMs + LIMIT_ENTER_MIN_INTERVAL_MS }
  }
  if (!keyPath || keyPath.ok !== true) return { act: 'report', reason: `no_key_path:${keyPath?.reason ?? 'unknown'}` }
  if (screen === undefined) return { act: 'read_screen', reason: 'usage_back' }
  if (screen === null) return { act: 'report', reason: 'screen_unreadable' }
  if (screen.ok !== true) return { act: 'report', reason: `screen_unclear:${screen.reason}` }
  return { act: 'press', reason: String(usage.how) }
}

// -- The owner's notice ------------------------------------------------------------------------------

/** ~/.bgos-agent/<id>/limit-notice.json: the watcher writes it, the agent's daemon takes it (lib/limit-notice.ts). */
export const LIMIT_NOTICE_FILE_NAME = 'limit-notice.json'
export const NOTICE_SCHEMA_VERSION = 1
export const NOTICE_OUTCOMES = Object.freeze(['freed', 'closed', 'still_limited', 'not_taken', 'cannot_press'])
export const NOTICE_HOWS = Object.freeze(['login_changed', 'reset_passed'])
export const NOTICE_WHYS = Object.freeze(['no_tmux', 'no_console', 'screen_unreadable', 'screen_unclear', 'selection_elsewhere', 'unsupported'])
const KEY_RE = /^[A-Za-z0-9:._-]{1,120}$/

/** A dialog that is up but not safe to press: the owner is told. Anything else is not a stuck picker. */
export const UNSAFE_DIALOG_REASONS = Object.freeze(['selection_elsewhere', 'selection_unreadable', 'no_safe_option', 'limit_line_far', 'below_footer', 'two_dialogs'])

/** The notice `why` for a screen reason the owner is told about. */
export function noticeWhyForScreen(reason) {
  return reason === 'selection_elsewhere' ? 'selection_elsewhere' : 'screen_unclear'
}

function isoOrNull(value) {
  if (value === null) return { ok: true, iso: null }
  if (typeof value !== 'string' || value.length > 40) return { ok: false, iso: null }
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? { ok: true, iso: new Date(ms).toISOString() } : { ok: false, iso: null }
}

/**
 * The watcher's note to the daemon, or null when ANY field is not exactly what the watcher writes:
 * no text ever comes from the file, so nothing in it can put words in front of the owner.
 * @param {unknown} raw
 */
export function parseLimitNotice(raw) {
  if (typeof raw !== 'string') return null
  let value
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  if (value.schemaVersion !== NOTICE_SCHEMA_VERSION) return null
  if (typeof value.key !== 'string' || !KEY_RE.test(value.key)) return null
  if (!NOTICE_OUTCOMES.includes(value.outcome)) return null
  if (!NOTICE_HOWS.includes(value.how)) return null
  if (value.outcome === 'cannot_press' ? !NOTICE_WHYS.includes(value.why) : value.why !== null) return null
  const limitAt = isoOrNull(value.limitAt)
  const resetsAt = isoOrNull(value.resetsAt ?? null)
  const pressedAt = isoOrNull(value.pressedAt ?? null)
  if (!limitAt.ok || limitAt.iso === null || !resetsAt.ok || !pressedAt.ok) return null
  return {
    schemaVersion: NOTICE_SCHEMA_VERSION,
    key: value.key,
    outcome: value.outcome,
    how: value.how,
    why: value.outcome === 'cannot_press' ? value.why : null,
    limitAt: limitAt.iso,
    resetsAt: resetsAt.iso,
    pressedAt: pressedAt.iso,
  }
}

/** "2026-11-01 16:39 UTC" */
function utc(iso) {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`
}

const CANNOT_WORDS = {
  no_tmux: 'the watcher cannot press keys in its window on this computer (the agent does not run in tmux)',
  no_console: 'the watcher could not reach the console window it runs in',
  screen_unreadable: 'the watcher could not read its screen',
  screen_unclear: 'its screen did not show the limit choices clearly, so the watcher pressed nothing',
  selection_elsewhere: 'the highlighted choice on its screen is not Stop and wait, so the watcher pressed nothing',
  unsupported: 'the watcher cannot press keys on this computer',
}

/**
 * The owner's words for a parsed notice: fixed templates, filled with times only.
 * @param {NonNullable<ReturnType<typeof parseLimitNotice>>} n
 */
export function limitNoticeText(n) {
  const stopped = `Your agent stopped at ${utc(n.limitAt)} on the Claude usage limit screen.`
  // Still limited carries the reset Claude gave with its new refusal: the time the watcher now waits for.
  // There usage only LOOKED available, whichever proof it was.
  const still = n.outcome === 'still_limited'
  const resetAt = n.resetsAt && !still ? ` at ${utc(n.resetsAt)}` : ''
  const back =
    n.how === 'reset_passed'
      ? still
        ? 'The limit reset time passed, so usage looked available again'
        : `The limit reset${resetAt}, so usage is available again`
      : 'The login on this computer changed after that, so usage looked available again'
  const pressed = n.pressedAt ? `the watcher pressed Enter once at ${utc(n.pressedAt)}` : 'the watcher pressed Enter once'
  switch (n.outcome) {
    case 'freed':
      return `${stopped} ${back}: ${pressed} on Stop and wait for limit to reset, and it is working again.`
    case 'closed':
      return `${stopped} ${back}: ${pressed} on Stop and wait for limit to reset and the limit screen closed. Nothing was waiting, so it answers your next message.`
    case 'still_limited':
      // Ares (option A): say the watcher waits for the reset time; never ask the owner to resend.
      return n.resetsAt
        ? `${stopped} ${back}: ${pressed}, but Claude still refuses on this login. The watcher now waits for the limit to reset at ${utc(n.resetsAt)} before it presses again.`
        : `${stopped} ${back}: ${pressed}, but Claude still refuses on this login. The watcher now waits for the limit to reset, but Claude gave no reset time, so it cannot tell when; once your limit is over, tap Restart now in the app if it has not come back.`
    case 'not_taken':
      return `${stopped} ${back}: ${pressed}, but the limit screen did not close. Tap Restart now in the app, or open the agent window and choose Stop and wait for limit to reset.`
    default:
      return `${stopped} ${back}, but ${CANNOT_WORDS[n.why] ?? CANNOT_WORDS.unsupported}. Tap Restart now in the app, or open the agent window and press Enter on Stop and wait for limit to reset.`
  }
}
