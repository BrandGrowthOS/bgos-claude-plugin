/**
 * The Claude login this session signs in through, as the DAEMON sees it, so
 * the backend can tell the owner once per machine when the login every agent
 * there shares has failed (BGOS board row e5d0fb3a; backend
 * integrations/shared-login-outage.ts).
 *
 * WHY THE DAEMON. When the Claude login expires the model cannot speak, while
 * this daemon keeps polling, so the app shows the agent online. The CLI writes
 * the failure into the session transcript in a fixed envelope, measured on
 * real transcripts (2026-10-09, 90 records, including the 2026-09-03 outage):
 *   type 'assistant', isApiErrorMessage: true, error: 'authentication_failed',
 *   model '<synthetic>', text one of
 *     "Login expired · Please run /login"
 *     "Failed to authenticate: OAuth session expired and could not be refreshed"
 *     "Please run /login · API Error: 401 OAuth access token has expired. ..."
 *     "Not logged in · Please run /login"
 *     "Please run /login · API Error: 401 Invalid authentication credentials"
 * The `error` field is the discriminator, not the text: every variant carries
 * it and no other record does. A usage cap arrives in the SAME envelope with
 * error 'rate_limit' and is already read by lib/resting.ts; this module only
 * reads that module's episode, it never classifies a cap a second time.
 *
 * WHAT IT REPORTS rides the heartbeat's existing `lastError` channel, with two
 * reserved codes the backend reads (claude_login_expired, claude_usage_limit),
 * plus, in env, a non secret fingerprint of the credential store and the
 * signed in account's email, so the backend can group a machine's agents by
 * the login they share and name the account to sign back in.
 *
 * Pure halves (signal extraction, state reduction, heartbeat error, account
 * key and label) take no fs; ClaudeLoginWatcher owns the fs walk with the same
 * byte cursor accounting as RestingWatcher.
 */

import { createHash } from 'node:crypto'
import { closeSync, fstatSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'

import type { RestingEpisode } from './resting.ts'
import { RESTING_STALE_MS, RESTING_STARTUP_TAIL_BYTES } from './resting.ts'
import { mungeCwd } from './usage-report.ts'

/** The backend's reserved lastError codes (shared-login-outage.ts). */
export const CLAUDE_LOGIN_EXPIRED_CODE = 'claude_login_expired'
export const CLAUDE_USAGE_LIMIT_CODE = 'claude_usage_limit'

/**
 * Records older than this never signal: replayed history (a resumed session's
 * new file, the startup tail) must not mark a healthy login failed. Same gate,
 * same reasoning, as RESTING_STALE_MS.
 */
export const LOGIN_STALE_MS = RESTING_STALE_MS

export type LoginSignal =
  | { type: 'login_failed'; at: number; text: string }
  /** A real (non synthetic, non sidechain) assistant turn: the login works. */
  | { type: 'activity'; at: number }

export interface ClaudeLoginState {
  failing: boolean
  /** When the current failure was first seen (record time). */
  since: number | null
  /** The CLI's own words for it, one bounded line. */
  text: string | null
}

export const LOGIN_OK: ClaudeLoginState = { failing: false, since: null, text: null }

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

/** ASCII control characters, newlines included: matched on purpose. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g

/**
 * The LAST login relevant signal in a JSONL chunk (append order is
 * chronological). Sidechain failures count, the login is account wide;
 * sidechain activity does not, a subagent still streaming says nothing about
 * the main loop's next call. Malformed lines are skipped.
 */
export function extractLoginSignal(chunk: string, nowMs: number): LoginSignal | null {
  let signal: LoginSignal | null = null
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
    if (at === 0 || at < nowMs - LOGIN_STALE_MS) continue
    if (e.isApiErrorMessage === true) {
      if (e.error !== 'authentication_failed') continue
      const text = textOf(m).replace(CONTROL, ' ').trim().slice(0, 160)
      signal = { type: 'login_failed', at, text }
    } else {
      if (e.isSidechain === true) continue
      if (m.model === '<synthetic>') continue
      signal = { type: 'activity', at }
    }
  }
  return signal
}

/**
 * Fold a signal into the state. A failure opens (or keeps) the episode with
 * its FIRST time, so the backend's outage start does not walk forward with
 * every retry. Real activity closes it: the session answered, so the login
 * works. No signal changes nothing; a dead login stays dead until proven
 * otherwise, by activity or by a successful /login (markSignedIn).
 */
export function reduceLoginState(prev: ClaudeLoginState, signal: LoginSignal | null): ClaudeLoginState {
  if (!signal) return prev
  if (signal.type === 'activity') return LOGIN_OK
  if (prev.failing) return { ...prev, text: signal.text || prev.text }
  return { failing: true, since: signal.at, text: signal.text || null }
}

/**
 * The heartbeat `lastError` this account state reports, or null. An expired
 * login outranks a usage cap: it is the one the owner can fix now, and a
 * session that cannot sign in cannot be capped. The cap comes from
 * lib/resting.ts's live episode, so the two reports can never disagree.
 */
export function heartbeatClaudeAccountError(input: {
  login: ClaudeLoginState
  resting: RestingEpisode | null
  now: number
}): { code: string; message: string; at: string } | null {
  const { login, resting, now } = input
  if (login.failing) {
    const said = login.text ? ` The CLI says: "${login.text}".` : ''
    return {
      code: CLAUDE_LOGIN_EXPIRED_CODE,
      // Under the DTO's 300 character cap: 160 for the quote plus this.
      message: `This agent's Claude login failed, so its session cannot answer.${said} Fix: run /login.`.slice(0, 300),
      at: new Date(Math.min(login.since ?? now, now)).toISOString(),
    }
  }
  if (resting && Date.parse(resting.resetAt) > now) {
    return {
      code: CLAUDE_USAGE_LIMIT_CODE,
      message:
        `This agent's Claude account hit its usage limit` +
        (resting.synthetic ? '.' : `, resetting at ${resting.resetAt}.`),
      at: new Date(now).toISOString(),
    }
  }
  return null
}

/**
 * The ONE `lastError`, now with three producers. A refused BGOS credential
 * still wins (it explains everything after it); then the Claude account,
 * because a dead login is WHY the session looks deaf, and naming the symptom
 * would bury the cause and its fix.
 */
export function pickAccountAwareLastError(
  authError: { code: string; message: string; at: string } | null,
  accountError: { code: string; message: string; at: string } | null,
  unresponsiveError: { code: string; message: string; at: string } | null,
): { code: string; message: string; at: string } | null {
  return authError ?? accountError ?? unresponsiveError
}

/**
 * Non secret identity of the credential store: the first 12 hex of the
 * sha256 of its resolved directory. Agents sharing one store report the same
 * key, agents on a separate CLAUDE_CONFIG_DIR a different one, which is what
 * "the login on this computer" means to /login.
 */
export function claudeAccountKey(configDir: string): string {
  return createHash('sha256').update(configDir).digest('hex').slice(0, 12)
}

/**
 * Where the CLI keeps the signed in account: `$CLAUDE_CONFIG_DIR/.claude.json`
 * when that is set, else `~/.claude.json` (measured: `~/.claude/.claude.json`
 * carries no account on a default install).
 */
export function claudeAccountFile(input: { env: Record<string, string | undefined>; home: string; configDir: string }): string {
  return input.env.CLAUDE_CONFIG_DIR?.trim()
    ? join(input.configDir, '.claude.json')
    : join(input.home, '.claude.json')
}

/** The account's email from that file, one bounded line, or null. Never throws. */
export function readClaudeAccountLabel(path: string, read: (p: string) => string = (p) => readFileSync(p, 'utf8')): string | null {
  try {
    const parsed = JSON.parse(read(path)) as { oauthAccount?: { emailAddress?: unknown } }
    const email = parsed?.oauthAccount?.emailAddress
    if (typeof email !== 'string') return null
    const line = email.replace(CONTROL, ' ').trim().slice(0, 120)
    return line.length > 0 ? line : null
  } catch {
    return null
  }
}

/**
 * Cursor reader over this workspace's session transcripts, reporting the
 * newest login signal across files. Mirrors RestingWatcher's accounting
 * (startup sizes, a bounded tail of the newest file, complete lines only,
 * truncation restart) with its own cursors, so the two never steal bytes from
 * each other. All fs failures are swallowed.
 */
export class ClaudeLoginWatcher {
  private readonly projectDir: string
  private readonly startupSizes = new Map<string, number>()
  private readonly cursors = new Map<string, number>()

  constructor(cwd: string, claudeHome: string) {
    this.projectDir = join(claudeHome, 'projects', mungeCwd(cwd))
    try {
      let newest: { name: string; mtimeMs: number } | null = null
      for (const name of readdirSync(this.projectDir)) {
        if (!name.endsWith('.jsonl')) continue
        try {
          const st = statSync(join(this.projectDir, name))
          this.startupSizes.set(name, st.size)
          if (!newest || st.mtimeMs > newest.mtimeMs) newest = { name, mtimeMs: st.mtimeMs }
        } catch {
          /* vanished between readdir and stat */
        }
      }
      if (newest) {
        const size = this.startupSizes.get(newest.name) ?? 0
        this.startupSizes.set(newest.name, Math.max(0, size - RESTING_STARTUP_TAIL_BYTES))
      }
    } catch {
      /* no project dir yet */
    }
  }

  scan(nowMs: number): LoginSignal | null {
    let names: string[]
    try {
      names = readdirSync(this.projectDir).filter((n) => n.endsWith('.jsonl'))
    } catch {
      return null
    }
    let best: LoginSignal | null = null
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
      const lastNewline = chunk.lastIndexOf('\n')
      if (lastNewline === -1) continue
      const complete = chunk.slice(0, lastNewline + 1)
      this.cursors.set(name, from + Buffer.byteLength(complete, 'utf8'))
      const signal = extractLoginSignal(complete, nowMs)
      if (signal && (!best || signal.at >= best.at)) best = signal
    }
    return best
  }
}
