/**
 * helper-account-limits: the PURE rules for switching a saved Claude account when an agent hits its
 * limit (acctbuild3, goal 18). The statusline has no per model usage, so the limit is read the way
 * capkeeper reads it: from the agent's own "You've hit your ... limit" line, which Claude Code writes
 * into the session transcript as a synthetic `rate_limit` record (lib/limit-screen.mjs). Any model's
 * line counts. A line that names a model ("Opus", "Fable") blocks only that model on the account until
 * its reset; a session, weekly or unnamed limit blocks the whole account until its reset.
 *
 * Nothing here touches a file, a process, a clock or the network. Plain JavaScript, node >= 18.
 */

import { parseTranscriptTail } from './watcher-checkup.mjs'

const HOUR_MS = 60 * 60_000
/** Without a reset from Claude: a session (or unnamed) limit lasts its 5 hour window, any other a week. */
const SHORT_BLOCK_MS = 5 * HOUR_MS
const LONG_BLOCK_MS = 7 * 24 * HOUR_MS
/** A week reading older than this says nothing about this week's room. */
export const WEEK_READING_MAX_AGE_MS = 24 * HOUR_MS
/** The whole account, in a blocks map. */
export const ANY_MODEL = '*'

const LIMIT_WORDS_RE = /You(?:'|’)ve (?:hit|reached) your\b(.{0,60}?)\blimit\b/i
const WINDOW_WORDS = new Set(['session', 'weekly', 'week', 'daily', 'monthly', 'usage', 'hourly', 'overall', 'plan', 'current', '5-hour', 'five-hour', '5h'])
const MODEL_WORD_RE = /^[a-z][a-z]{1,23}$/

/**
 * The limit a line is about: { model: 'opus' } for one model, { model: null } for the whole account,
 * null when it is not Claude's usage limit line (throttling, a retry, the owner's own words).
 * @param {unknown} text
 * @returns {{ model: string | null } | null}
 */
export function limitScope(text) {
  if (typeof text !== 'string' || !text) return null
  if (/\brate.?limit/i.test(text) || /\bretrying\b/i.test(text) || /^\s*API Error/i.test(text)) return null
  const match = LIMIT_WORDS_RE.exec(text.replace(/[\u0000-\u001f\u007f]/g, ' '))
  if (!match) return null
  const words = match[1].trim().toLowerCase().split(/\s+/).filter(Boolean)
  const model = words.find((word) => !WINDOW_WORDS.has(word) && MODEL_WORD_RE.test(word)) ?? null
  return { model }
}

/** "claude-opus-5-5" as "opus". Null for anything that is not a Claude model id. */
export function modelFamily(id) {
  const match = /^claude-([a-z]{2,24})(?:-|$)/.exec(String(id ?? '').toLowerCase())
  return match ? match[1] : null
}

function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((part) => part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
}

/**
 * The limit this agent is at now, from its transcript tail, or null. The rules for "now" are the
 * watcher's own (parseTranscriptTail: a real turn after the refusal ends it, an old refusal is stale),
 * so the switch and the limit picker agree on when an agent is limited.
 * @param {string | null | undefined} text the transcript tail
 * @param {number} now
 * @returns {{ atMs: number, resetsAtMs: number, model: string | null, agentModel: string | null } | null}
 */
export function agentLimitFrom(text, now) {
  const tail = parseTranscriptTail(text ?? null, now)
  const error = tail.error
  if (error?.kind !== 'rate_limit') return null
  let words = null
  let agentModel = null
  for (const raw of String(text ?? '').split('\n')) {
    const trimmed = raw.trim()
    if (!trimmed) continue
    let entry
    try {
      entry = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (!entry || typeof entry !== 'object' || entry.type !== 'assistant') continue
    const message = entry.message && typeof entry.message === 'object' ? entry.message : {}
    if (entry.isApiErrorMessage === true) {
      if (entry.error === 'rate_limit' && Date.parse(entry.timestamp) === error.atMs) words = textOf(message.content)
      continue
    }
    if (entry.isSidechain === true || message.model === '<synthetic>') continue
    agentModel = modelFamily(message.model) ?? agentModel
  }
  const scope = limitScope(words)
  if (!scope) return null
  const fallback = error.atMs + (scope.model !== null || /\b(?:weekly|monthly)\b/i.test(words) ? LONG_BLOCK_MS : SHORT_BLOCK_MS)
  const resetsAtMs = error.resetsAtMs !== null && error.resetsAtMs > error.atMs ? error.resetsAtMs : fallback
  return { atMs: error.atMs, resetsAtMs, model: scope.model, agentModel }
}

/** The model family of the newest real assistant turn in a transcript tail, or null. */
export function agentModelFrom(text) {
  let model = null
  for (const raw of String(text ?? '').split('\n')) {
    if (!raw.includes('"assistant"')) continue
    let entry
    try {
      entry = JSON.parse(raw.trim())
    } catch {
      continue
    }
    if (entry?.type !== 'assistant' || entry.isApiErrorMessage === true || entry.isSidechain === true) continue
    model = modelFamily(entry.message?.model) ?? model
  }
  return model
}

const isoMs = (value) => {
  const ms = typeof value === 'string' ? Date.parse(value) : Number.NaN
  return Number.isFinite(ms) ? ms : null
}

/**
 * Has this account no room for this model now? `blocks` maps a model (or ANY_MODEL) to the ISO time
 * its limit resets. An agent whose model is not known is blocked by any model's limit.
 */
export function roomBlocked(blocks, model, now) {
  if (!blocks || typeof blocks !== 'object') return false
  return Object.entries(blocks).some(([key, until]) => {
    const ms = isoMs(until)
    if (ms === null || ms <= now) return false
    return key === ANY_MODEL || model === null || model === undefined || key === model
  })
}

/**
 * Week room (100 minus the week used) from the capkeeper statusline reading, or null when there is no
 * usable reading. A week whose reset already passed has all its room again.
 */
export function accountRoom(windows, now) {
  const readAt = isoMs(windows?.readAt)
  const week = windows?.week
  if (readAt === null || readAt > now || now - readAt > WEEK_READING_MAX_AGE_MS) return null
  if (!week || typeof week.used !== 'number' || !Number.isFinite(week.used) || week.used < 0 || week.used > 100) return null
  const reset = isoMs(week.resetAt)
  if (reset === null) return null
  return reset <= now ? 100 : 100 - week.used
}

/**
 * Auto's pick: the signed in account with the most week room for this model. A tie keeps the current
 * account. An account with no reading yet is a last resort behind any known room. No room anywhere is
 * null: the agent waits.
 * @param {{ accounts: { id: string, signedIn: boolean, room: number | null, blocks?: object }[],
 *   model: string | null, current: string | null, now: number }} input
 */
export function mostWeekRoom({ accounts, model, current, now }) {
  const open = accounts.filter((a) => a.signedIn === true && !roomBlocked(a.blocks, model, now))
  const known = open.filter((a) => typeof a.room === 'number' && a.room > 0)
  if (known.length) {
    const best = Math.max(...known.map((a) => a.room))
    const top = known.filter((a) => a.room === best)
    return (top.find((a) => a.id === current) ?? top[0]).id
  }
  const unread = open.filter((a) => a.room === null)
  if (!unread.length) return null
  return (unread.find((a) => a.id === current) ?? unread[0]).id
}
