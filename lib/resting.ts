/**
 * Honest Limits, agent side (BGOS capability: resting status self-report).
 *
 * When the Claude Code session hits a usage/session cap the model cannot
 * speak, so the PLUGIN has to be the honest one: it detects the cap in the
 * session transcript JSONL and PATCHes the assistant status with
 * { status: 'resting', resetAt: <ISO> } (backend PR #745; the backend
 * auto-clears the state at resetAt or on real activity, so the plugin never
 * un-sets it).
 *
 * Detection ground truth (corpus of real transcripts on this machine,
 * 2026-07-17): a cap appends an assistant-typed record with
 * error: 'rate_limit', isApiErrorMessage: true, model '<synthetic>' and a
 * human text like
 *   "You've hit your session limit · resets 7:40pm (Asia/Dubai)"
 *   "You've hit your weekly limit · resets Jul 10 at 10pm (Asia/Dubai)"
 *   "You've reached your Fable 5 limit. Run /usage-credits ..."
 *   "You're out of usage credits. Run /usage-credits ..."
 * TRANSIENT server-side 429s ("API Error: Server is temporarily limiting
 * requests (not your usage limit) · Rate limited", "API Error: Request
 * rejected (429) · Rate limited") arrive in the IDENTICAL envelope, so the
 * text is the only discriminator: genuine caps never start with "API Error".
 *
 * Pure logic (text classification, reset-time parsing, emit decision) lives
 * in exported functions with no fs access; RestingWatcher owns the fs walk
 * with the same byte-cursor accounting as UsageTracker (never re-reads, never
 * consumes a partial tail line, starts at each file's startup size so history
 * from before this server instance is not re-reported).
 */

import { closeSync, fstatSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { mungeCwd } from './usage-report.ts'

/** Conservative rest horizon when the cap message carries no reset time. */
export const RESTING_FALLBACK_MS = 30 * 60_000

export type RestingSignal =
  /** A usage/session cap line; resetAt is the parsed UTC ISO or null. */
  | { type: 'limit'; resetAt: string | null; at: number }
  /** A real (non-synthetic, non-sidechain) assistant turn; the session lives. */
  | { type: 'activity'; at: number }

export interface RestingEpisode {
  /** UTC ISO instant the rest is expected to end. */
  resetAt: string
  /** True when resetAt is a now+fallback guess rather than a parsed time. */
  synthetic: boolean
}

// ── Text classification ──────────────────────────────────────────────────────

/**
 * Is this CLI-synthesized error text a genuine account/usage cap (as opposed
 * to a transient server-side limit or an auth problem)? Anchored in the real
 * corpus: every genuine cap starts with "You've/You're ... limit/credits";
 * every transient starts with "API Error" and the server-side 429 explicitly
 * says "not your usage limit".
 */
export function isUsageCapText(text: string): boolean {
  if (!text) return false
  if (/not your usage limit/i.test(text)) return false
  if (/^\s*API Error/i.test(text)) return false
  if (/(?:hit|reached) your .{0,60}limit/i.test(text)) return true
  if (/out of usage credits/i.test(text)) return true
  return false
}

// ── Reset-time parsing ───────────────────────────────────────────────────────

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
}

// Matches both corpus shapes plus close phrasings:
//   "resets 7:40pm (Asia/Dubai)"        time-only, next occurrence
//   "resets 4am (Asia/Dubai)"           minute-less
//   "resets Jul 10 at 10pm (Asia/Dubai)" absolute date (weekly cap)
//   "will reset at 7pm (Asia/Dubai)"    "reset at" phrasing
//   "resets 19:40 (Asia/Dubai)"         24h clock
// The trailing parenthesized IANA zone is optional; when absent the machine
// timezone is used.
const RESET_RE =
  /reset(?:s)?(?:\s+at)?\s+(?:(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?\s+at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([^)]+)\))?/i

function isValidZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    return true
  } catch {
    return false
  }
}

function machineZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/** Offset (zone wall clock minus UTC) in ms at a given UTC instant. */
function zoneOffsetMs(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(new Date(utcMs))
  const get = (type: string): number =>
    Number(parts.find((p) => p.type === type)?.value ?? '0')
  const asUtc = Date.UTC(
    get('year'), get('month') - 1, get('day'),
    get('hour') % 24, get('minute'), get('second'),
  )
  return asUtc - utcMs
}

/** UTC instant of a wall-clock time in a zone (two-pass, DST-safe). */
function wallTimeToUtcMs(
  year: number, month: number, day: number,
  hour: number, minute: number, timeZone: string,
): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute)
  const off1 = zoneOffsetMs(guess, timeZone)
  let utc = guess - off1
  const off2 = zoneOffsetMs(utc, timeZone)
  if (off2 !== off1) utc = guess - off2
  return utc
}

/** The zone's current wall-clock date at a UTC instant. */
function wallDateAt(utcMs: number, timeZone: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(utcMs))
  const get = (type: string): number =>
    Number(parts.find((p) => p.type === type)?.value ?? '0')
  return { year: get('year'), month: get('month'), day: get('day') }
}

/**
 * Parse the reset time out of a cap message into a UTC ISO string, or null
 * when the text carries none (credits-out) or the values are nonsense.
 * A zone named in the message wins; otherwise `timeZone` (default: machine).
 * Time-only forms resolve to the NEXT occurrence after `nowMs`; date forms
 * resolve within the current year and roll to the next year when far past
 * (12h grace so a reset earlier today does not jump a year).
 */
export function parseResetText(
  text: string,
  nowMs: number,
  timeZone: string = machineZone(),
): string | null {
  const match = RESET_RE.exec(text)
  if (!match) return null
  const [, monthWord, dayStr, yearStr, hourStr, minuteStr, ampmRaw, zoneRaw] = match

  const minute = minuteStr === undefined ? 0 : Number(minuteStr)
  if (minute > 59) return null
  let hour = Number(hourStr)
  const ampm = ampmRaw?.toLowerCase()
  if (ampm) {
    if (hour < 1 || hour > 12) return null
    hour = hour % 12
    if (ampm === 'pm') hour += 12
  } else {
    // Without am/pm require an explicit HH:MM 24h clock; a bare "resets 7"
    // is too ambiguous to act on.
    if (minuteStr === undefined || hour > 23) return null
  }

  let zone = timeZone
  if (zoneRaw && isValidZone(zoneRaw.trim())) zone = zoneRaw.trim()
  if (!isValidZone(zone)) zone = 'UTC'

  if (monthWord) {
    const month = MONTHS[monthWord.slice(0, 3).toLowerCase()]
    const day = Number(dayStr)
    if (!month || day < 1 || day > 31) return null
    const year = yearStr ? Number(yearStr) : wallDateAt(nowMs, zone).year
    let candidate = wallTimeToUtcMs(year, month, day, hour, minute, zone)
    if (!yearStr && candidate < nowMs - 12 * 3_600_000) {
      candidate = wallTimeToUtcMs(year + 1, month, day, hour, minute, zone)
    }
    return new Date(candidate).toISOString()
  }

  const today = wallDateAt(nowMs, zone)
  for (let offset = 0; offset <= 2; offset++) {
    const candidate = wallTimeToUtcMs(
      today.year, today.month, today.day + offset, hour, minute, zone,
    )
    if (candidate > nowMs) return new Date(candidate).toISOString()
  }
  return null
}

// ── Transcript chunk scanning ────────────────────────────────────────────────

function textOf(message: Record<string, unknown>): string {
  const content = message.content
  if (!Array.isArray(content)) return ''
  return content
    .filter(
      (b): b is { type: string; text: string } =>
        typeof b === 'object' && b !== null &&
        (b as Record<string, unknown>).type === 'text' &&
        typeof (b as Record<string, unknown>).text === 'string',
    )
    .map((b) => b.text)
    .join(' ')
}

/**
 * Extract the LAST resting-relevant signal from a JSONL chunk (append order
 * is chronological, so the last one is the current truth): a genuine cap
 * line yields `limit`; a real assistant turn after it yields `activity`
 * (the session resumed). Sidechain (subagent) caps count, a cap is
 * account-wide; sidechain ACTIVITY does not, a parallel subagent still
 * streaming must not clear a capped main loop. Malformed lines are skipped,
 * normal at a live file's tail.
 */
export function extractRestingSignal(
  chunk: string,
  nowMs: number,
  timeZone: string = machineZone(),
): RestingSignal | null {
  let signal: RestingSignal | null = null
  for (const line of chunk.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let entry: unknown
    try {
      entry = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (typeof entry !== 'object' || entry === null) continue
    const e = entry as Record<string, unknown>
    if (e.type !== 'assistant') continue
    const message = e.message
    if (typeof message !== 'object' || message === null) continue
    const m = message as Record<string, unknown>
    const at = typeof e.timestamp === 'string' ? Date.parse(e.timestamp) || 0 : 0
    if (e.isApiErrorMessage === true) {
      if (e.error !== 'rate_limit') continue
      const text = textOf(m)
      if (!isUsageCapText(text)) continue
      signal = { type: 'limit', resetAt: parseResetText(text, nowMs, timeZone), at }
    } else {
      if (e.isSidechain === true) continue
      if (m.model === '<synthetic>') continue
      signal = { type: 'activity', at }
    }
  }
  return signal
}

// ── Emit decision (pure) ─────────────────────────────────────────────────────

/**
 * Fold a scan signal into the observed rest episode. Rules:
 *  - an episode whose resetAt has passed expires (a later cap re-opens fresh,
 *    which is what makes "re-emit if still capped at the horizon" work);
 *  - real activity closes the episode (the backend clears itself too);
 *  - a parsed FUTURE reset time always wins: it opens, upgrades a synthetic
 *    guess, and replaces a stale different time;
 *  - a cap without a usable reset time (none parsed, or the parsed instant
 *    already passed while the transcript says still-capped) only opens a NEW
 *    episode (now+fallback, synthetic); it never overrides a live one, so
 *    retry spam stays quiet.
 */
export function updateObserved(
  prev: RestingEpisode | null,
  signal: RestingSignal | null,
  nowMs: number,
  fallbackMs: number = RESTING_FALLBACK_MS,
): RestingEpisode | null {
  let episode = prev
  if (episode && Date.parse(episode.resetAt) <= nowMs) episode = null
  if (!signal) return episode
  if (signal.type === 'activity') return null
  if (signal.resetAt && Date.parse(signal.resetAt) > nowMs) {
    if (!episode || episode.resetAt !== signal.resetAt) {
      return { resetAt: signal.resetAt, synthetic: false }
    }
    return episode
  }
  if (episode) return episode
  return { resetAt: new Date(nowMs + fallbackMs).toISOString(), synthetic: true }
}

/**
 * PATCH exactly when the observed episode is live, still ahead of now, and
 * differs from what was last successfully emitted. Callers update `emitted`
 * only after the PATCH succeeds, so a failed send retries on the next sweep.
 */
export function shouldEmit(
  observed: RestingEpisode | null,
  emitted: RestingEpisode | null,
  nowMs: number,
): boolean {
  if (!observed) return false
  if (Date.parse(observed.resetAt) <= nowMs) return false
  return !emitted || emitted.resetAt !== observed.resetAt
}

/**
 * One whole sweep decision, pure. Folds the scan signal into the observed
 * episode, resets the emitted bookkeeping on real activity (the backend
 * cleared resting on that same activity, so a LATER re-cap must re-emit even
 * with an identical reset time; the weekly-cap resume-then-recap case), and
 * says which resetAt to PATCH, or null. The caller advances `emitted` to
 * `observed` only after the PATCH succeeds.
 */
export function resolveRestingTick(
  state: { observed: RestingEpisode | null; emitted: RestingEpisode | null },
  signal: RestingSignal | null,
  nowMs: number,
  fallbackMs: number = RESTING_FALLBACK_MS,
): {
  observed: RestingEpisode | null
  emitted: RestingEpisode | null
  resetAtToEmit: string | null
} {
  const observed = updateObserved(state.observed, signal, nowMs, fallbackMs)
  const emitted = signal?.type === 'activity' ? null : state.emitted
  const resetAtToEmit = shouldEmit(observed, emitted, nowMs) ? observed!.resetAt : null
  return { observed, emitted, resetAtToEmit }
}

// ── Transcript watcher (fs walk + cursors) ───────────────────────────────────

/**
 * Cursor-based reader over every session transcript in this workspace's
 * `~/.claude/projects/<munged-cwd>/` (same accounting as UsageTracker, own
 * cursors: both consumers see every appended byte independently). `scan()`
 * returns the newest signal across files, or null when nothing relevant was
 * appended. All fs failures are swallowed; a status nicety must never break
 * the server.
 */
export class RestingWatcher {
  private readonly projectDir: string
  private readonly timeZone: string
  /** Byte sizes at server startup; history is never re-reported. */
  private readonly startupSizes = new Map<string, number>()
  private readonly cursors = new Map<string, number>()

  constructor(
    cwd: string,
    claudeHome: string = join(homedir(), '.claude'),
    timeZone: string = machineZone(),
  ) {
    this.projectDir = join(claudeHome, 'projects', mungeCwd(cwd))
    this.timeZone = timeZone
    try {
      for (const name of readdirSync(this.projectDir)) {
        if (!name.endsWith('.jsonl')) continue
        try {
          this.startupSizes.set(name, statSync(join(this.projectDir, name)).size)
        } catch {
          /* file vanished between readdir and stat */
        }
      }
    } catch {
      /* project dir missing, scan() will keep returning null */
    }
  }

  scan(nowMs: number): RestingSignal | null {
    let names: string[]
    try {
      names = readdirSync(this.projectDir).filter((n) => n.endsWith('.jsonl'))
    } catch {
      return null
    }
    let best: RestingSignal | null = null
    for (const name of names) {
      const filePath = join(this.projectDir, name)
      const from = this.cursors.get(name) ?? this.startupSizes.get(name) ?? 0
      let chunk: string | null = null
      try {
        const fd = openSync(filePath, 'r')
        try {
          const size = fstatSync(fd).size
          if (size > from) {
            const buf = Buffer.alloc(size - from)
            const read = readSync(fd, buf, 0, buf.length, from)
            chunk = buf.subarray(0, read).toString('utf8')
          } else if (size < from) {
            // File truncated/rotated, restart from 0 next time.
            this.cursors.set(name, 0)
            continue
          }
        } finally {
          closeSync(fd)
        }
      } catch {
        continue
      }
      if (chunk === null) continue
      // Only advance past COMPLETE lines: a partial tail line is left for
      // the next scan so its signal is not lost mid-append.
      const lastNewline = chunk.lastIndexOf('\n')
      if (lastNewline === -1) continue
      const complete = chunk.slice(0, lastNewline + 1)
      this.cursors.set(name, from + Buffer.byteLength(complete, 'utf8'))
      const signal = extractRestingSignal(complete, nowMs, this.timeZone)
      if (signal && (!best || signal.at >= best.at)) best = signal
    }
    return best
  }
}
