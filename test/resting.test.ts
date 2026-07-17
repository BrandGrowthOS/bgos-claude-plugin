/**
 * Honest Limits, agent side (lib/resting.ts): usage-cap detection in the
 * session transcript JSONL, reset-time parsing, and the emit decision for
 * the { status: 'resting', resetAt } self-report.
 *
 * Fixture texts are the EXACT strings observed in real transcripts on this
 * machine (2026-07-17 corpus sweep), including the transient 429 variants
 * that share the same record envelope and must NOT trigger resting.
 *
 * Run with:  npm test      (node --test, no extra deps)
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  RESTING_FALLBACK_MS,
  RESTING_STALE_MS,
  RESTING_STARTUP_TAIL_BYTES,
  RestingWatcher,
  extractRestingSignal,
  isUsageCapText,
  parseResetText,
  resolveRestingTick,
  shouldEmit,
  updateObserved,
} from '../lib/resting.ts'
import type { RestingEpisode, RestingSignal } from '../lib/resting.ts'
import { mungeCwd } from '../lib/usage-report.ts'

// 2026-07-17T10:00:00Z = 14:00 in Asia/Dubai (UTC+4, no DST).
const NOW = Date.UTC(2026, 6, 17, 10, 0, 0)
const iso = (ms: number): string => new Date(ms).toISOString()

// Real corpus strings (verbatim, middle dot and all).
const SESSION_CAP = "You've hit your session limit · resets 7:40pm (Asia/Dubai)"
const SESSION_CAP_EARLY = "You've hit your session limit · resets 4:50am (Asia/Dubai)"
const WEEKLY_CAP = "You've hit your weekly limit · resets Jul 10 at 10pm (Asia/Dubai)"
const GENERIC_CAP = "You've hit your limit · resets 11pm (Asia/Dubai)"
const FABLE_CAP =
  "You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model."
const CREDITS_OUT =
  "You're out of usage credits. Run /usage-credits to keep using Fable 5 or /model to switch models."
const TRANSIENT_429 =
  'API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited'
const REJECTED_429 = 'API Error: Request rejected (429) · Rate limited'
const OVERLOADED_529 =
  'API Error: 529 Overloaded. This is a server-side issue, usually temporary. If it persists, check https://status.claude.com.'
const NOT_LOGGED_IN = 'Not logged in · Please run /login'

// ── line builders (shape mirrors real transcript records) ───────────────────

let seq = 0
const capLine = (text: string, over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    parentUuid: null,
    isSidechain: false,
    type: 'assistant',
    uuid: `cap-${seq++}`,
    timestamp: new Date(NOW - 60_000).toISOString(),
    message: {
      id: `msg-cap-${seq}`,
      model: '<synthetic>',
      role: 'assistant',
      content: [{ type: 'text', text }],
      usage: { input_tokens: 0, output_tokens: 0 },
    },
    requestId: 'req_test',
    error: 'rate_limit',
    isApiErrorMessage: true,
    apiErrorStatus: 429,
    ...over,
  })

const activityLine = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    parentUuid: null,
    isSidechain: false,
    type: 'assistant',
    uuid: `act-${seq++}`,
    timestamp: new Date(NOW - 30_000).toISOString(),
    message: {
      id: `msg-act-${seq}`,
      model: 'claude-opus-4-8',
      role: 'assistant',
      content: [{ type: 'text', text: 'working on it' }],
      usage: { input_tokens: 10, output_tokens: 5 },
    },
    ...over,
  })

// ── isUsageCapText ───────────────────────────────────────────────────────────

test('isUsageCapText accepts every real cap variant', () => {
  for (const text of [SESSION_CAP, SESSION_CAP_EARLY, WEEKLY_CAP, GENERIC_CAP, FABLE_CAP, CREDITS_OUT]) {
    assert.equal(isUsageCapText(text), true, `should accept: ${text}`)
  }
})

test('isUsageCapText rejects transient and non-cap errors', () => {
  for (const text of [TRANSIENT_429, REJECTED_429, OVERLOADED_529, NOT_LOGGED_IN, '', 'hello']) {
    assert.equal(isUsageCapText(text), false, `should reject: ${text}`)
  }
})

test('isUsageCapText rejects rate-limit/retrying phrasings even off the API Error prefix', () => {
  for (const text of [
    "Server busy: you've hit your rate limit, retrying automatically",
    'You have been rate limited, retrying in 30s',
  ]) {
    assert.equal(isUsageCapText(text), false, `should reject: ${text}`)
  }
})

test('isUsageCapText accepts plausible cap rewordings', () => {
  for (const text of [
    'Usage limit reached · resets 5pm (Asia/Dubai)',
    'Your session limit has been reached · resets 5pm (Asia/Dubai)',
  ]) {
    assert.equal(isUsageCapText(text), true, `should accept: ${text}`)
  }
})

// ── parseResetText ───────────────────────────────────────────────────────────

test('parses "resets 7:40pm (Asia/Dubai)" to the same-day UTC instant', () => {
  // 19:40 Dubai on Jul 17 = 15:40Z, still ahead of NOW (14:00 Dubai).
  assert.equal(parseResetText(SESSION_CAP, NOW), '2026-07-17T15:40:00.000Z')
})

test('rolls a time-of-day that already passed to tomorrow', () => {
  // 4:50am Dubai passed at NOW (14:00 Dubai) so the next one is Jul 18.
  assert.equal(parseResetText(SESSION_CAP_EARLY, NOW), '2026-07-18T00:50:00.000Z')
})

test('parses a minute-less time ("resets 4am")', () => {
  assert.equal(
    parseResetText("You've hit your session limit · resets 4am (Asia/Dubai)", NOW),
    '2026-07-18T00:00:00.000Z',
  )
})

test('handles the 12am midnight edge', () => {
  // Next midnight in Dubai after 14:00 local is Jul 18 00:00 Dubai = Jul 17 20:00Z.
  assert.equal(
    parseResetText("You've hit your session limit · resets 12am (Asia/Dubai)", NOW),
    '2026-07-17T20:00:00.000Z',
  )
})

test('handles the 12:10pm noon edge (already passed today)', () => {
  // 12:10pm Dubai = 08:10Z, before NOW, so tomorrow.
  assert.equal(
    parseResetText("You've hit your session limit · resets 12:10pm (Asia/Dubai)", NOW),
    '2026-07-18T08:10:00.000Z',
  )
})

test('parses the weekly absolute form "resets Jul 10 at 10pm (Asia/Dubai)"', () => {
  const before = Date.UTC(2026, 6, 5, 10, 0, 0)
  assert.equal(parseResetText(WEEKLY_CAP, before), '2026-07-10T18:00:00.000Z')
})

test('rolls an absolute date over the year boundary', () => {
  const decNow = Date.UTC(2026, 11, 30, 10, 0, 0)
  assert.equal(
    parseResetText("You've hit your weekly limit · resets Jan 2 at 10pm (Asia/Dubai)", decNow),
    '2027-01-02T18:00:00.000Z',
  )
})

test('honors an explicit year in the absolute form', () => {
  assert.equal(
    parseResetText("You've hit your weekly limit · resets Jul 10, 2027 at 10pm (Asia/Dubai)", NOW),
    '2027-07-10T18:00:00.000Z',
  )
})

test('falls back to the machine timezone when the message names none', () => {
  assert.equal(
    parseResetText("You've hit your session limit · resets 7:40pm", NOW, 'Asia/Dubai'),
    '2026-07-17T15:40:00.000Z',
  )
})

test('respects a DST-observing zone named in the message', () => {
  // 2:30pm America/New_York in July is EDT (UTC-4) = 18:30Z.
  assert.equal(
    parseResetText("You've hit your session limit · resets 2:30pm (America/New_York)", NOW),
    '2026-07-17T18:30:00.000Z',
  )
})

test('parses the "will reset at 7pm" phrasing', () => {
  assert.equal(
    parseResetText('Your limit will reset at 7pm (Asia/Dubai)', NOW),
    '2026-07-17T15:00:00.000Z',
  )
})

test('parses a 24h clock time', () => {
  assert.equal(
    parseResetText("You've hit your session limit · resets 19:40 (Asia/Dubai)", NOW),
    '2026-07-17T15:40:00.000Z',
  )
})

test('ignores an unknown zone and uses the fallback zone', () => {
  assert.equal(
    parseResetText("You've hit your session limit · resets 7:40pm (Somewhere/Odd)", NOW, 'UTC'),
    '2026-07-17T19:40:00.000Z',
  )
})

test('returns null when there is no reset time (credits-out texts)', () => {
  assert.equal(parseResetText(FABLE_CAP, NOW), null)
  assert.equal(parseResetText(CREDITS_OUT, NOW), null)
})

test('returns null for out-of-range clock values', () => {
  assert.equal(
    parseResetText("You've hit your session limit · resets 99:99 (Asia/Dubai)", NOW),
    null,
  )
})

test('does not misparse "presets 5pm" (word boundary on reset)', () => {
  assert.equal(
    parseResetText("You've hit your limit · presets 5pm (Asia/Dubai)", NOW),
    null,
  )
})

test('a date form far outside the plausible cap window returns null', () => {
  // A weekly cap resets at most ~7 days out; "Jul 10" read on Jul 23 is a
  // stale replay, not a rest that ends next July.
  const staleNow = Date.UTC(2026, 6, 23, 10, 0, 0)
  assert.equal(parseResetText(WEEKLY_CAP, staleNow), null)
})

test('a date form just past new year resolves BACK to the prior year, not 12 months out', () => {
  // "resets Dec 31 at 10pm" read on Jan 1 00:30Z is yesterday's reset (an
  // instant a few hours in the past), never next December.
  const jan1 = Date.UTC(2027, 0, 1, 0, 30, 0)
  assert.equal(
    parseResetText("You've hit your weekly limit · resets Dec 31 at 10pm (Asia/Dubai)", jan1),
    '2026-12-31T18:00:00.000Z',
  )
})

// ── extractRestingSignal ─────────────────────────────────────────────────────

test('a cap line yields a limit signal with the parsed resetAt', () => {
  const signal = extractRestingSignal(capLine(SESSION_CAP) + '\n', NOW)
  assert.ok(signal && signal.type === 'limit')
  assert.equal(signal.resetAt, '2026-07-17T15:40:00.000Z')
})

test('a credits-out cap line yields a limit signal with resetAt null', () => {
  const signal = extractRestingSignal(capLine(FABLE_CAP) + '\n', NOW)
  assert.ok(signal && signal.type === 'limit')
  assert.equal(signal.resetAt, null)
})

test('real assistant activity after a cap wins (session resumed)', () => {
  const chunk = capLine(SESSION_CAP) + '\n' + activityLine() + '\n'
  const signal = extractRestingSignal(chunk, NOW)
  assert.ok(signal && signal.type === 'activity')
})

test('a cap after real activity wins (fresh cap)', () => {
  const chunk = activityLine() + '\n' + capLine(SESSION_CAP) + '\n'
  const signal = extractRestingSignal(chunk, NOW)
  assert.ok(signal && signal.type === 'limit')
})

test('repeated retry cap lines collapse to a single limit signal', () => {
  const chunk = [capLine(SESSION_CAP), capLine(SESSION_CAP), capLine(SESSION_CAP)].join('\n') + '\n'
  const signal = extractRestingSignal(chunk, NOW)
  assert.ok(signal && signal.type === 'limit')
  assert.equal(signal.resetAt, '2026-07-17T15:40:00.000Z')
})

test('transient 429 lines never produce a signal', () => {
  const chunk = capLine(TRANSIENT_429) + '\n' + capLine(REJECTED_429) + '\n'
  assert.equal(extractRestingSignal(chunk, NOW), null)
})

test('sidechain activity does not clear a main-loop cap', () => {
  const chunk =
    capLine(SESSION_CAP) + '\n' + activityLine({ isSidechain: true }) + '\n'
  const signal = extractRestingSignal(chunk, NOW)
  assert.ok(signal && signal.type === 'limit')
})

test('a sidechain cap still counts (account-wide cap)', () => {
  const signal = extractRestingSignal(capLine(SESSION_CAP, { isSidechain: true }) + '\n', NOW)
  assert.ok(signal && signal.type === 'limit')
})

test('malformed and irrelevant lines are skipped', () => {
  const chunk = 'not json\n' + JSON.stringify({ type: 'user' }) + '\n' + capLine(SESSION_CAP) + '\n'
  const signal = extractRestingSignal(chunk, NOW)
  assert.ok(signal && signal.type === 'limit')
})

test('stale records are ignored (resume-forked session replay must not emit)', () => {
  // A resumed/forked session writes a NEW .jsonl replaying the parent's
  // history with ORIGINAL timestamps; yesterday's cap line must not mark a
  // healthy agent resting. The freshness gate covers caps AND activity.
  const staleTs = new Date(NOW - RESTING_STALE_MS - 60_000).toISOString()
  const chunk =
    capLine(SESSION_CAP, { timestamp: staleTs }) + '\n' +
    activityLine({ timestamp: staleTs }) + '\n'
  assert.equal(extractRestingSignal(chunk, NOW), null)
})

test('a record with no timestamp is ignored (cannot prove freshness)', () => {
  assert.equal(extractRestingSignal(capLine(SESSION_CAP, { timestamp: undefined }) + '\n', NOW), null)
})

test('a cap whose stated reset already elapsed is ignored (no 24h rollover race)', () => {
  // Retry line appended just before the reset instant, scanned just after:
  // "resets 1:59pm" written at 13:58 Dubai, scanned at 14:00 Dubai. Parsing
  // relative to scan time would roll it 24h forward; relative to the record
  // time it is an instant in the past, so the rest is simply over.
  const line = capLine("You've hit your session limit · resets 1:59pm (Asia/Dubai)", {
    timestamp: new Date(NOW - 120_000).toISOString(),
  })
  assert.equal(extractRestingSignal(line + '\n', NOW), null)
})

test('reset times parse relative to the RECORD time, not scan time', () => {
  // Line written at 13:58 Dubai saying "resets 2:10pm": still ahead at scan
  // time 14:00, and it must resolve to TODAY 2:10pm Dubai (10:10Z).
  const line = capLine("You've hit your session limit · resets 2:10pm (Asia/Dubai)", {
    timestamp: new Date(NOW - 120_000).toISOString(),
  })
  const signal = extractRestingSignal(line + '\n', NOW)
  assert.ok(signal && signal.type === 'limit')
  assert.equal(signal.resetAt, '2026-07-17T10:10:00.000Z')
})

test('a cap after in-chunk activity carries afterActivity (resume-then-recap in ONE sweep)', () => {
  const chunk = activityLine() + '\n' + capLine(SESSION_CAP) + '\n'
  const signal = extractRestingSignal(chunk, NOW)
  assert.ok(signal && signal.type === 'limit')
  assert.equal(signal.afterActivity, true)
})

test('a cap with no preceding activity has afterActivity false', () => {
  const signal = extractRestingSignal(capLine(SESSION_CAP) + '\n', NOW)
  assert.ok(signal && signal.type === 'limit')
  assert.equal(signal.afterActivity, false)
})

// ── updateObserved / shouldEmit (emit decision) ─────────────────────────────

const limitSignal = (resetAt: string | null, afterActivity = false): RestingSignal => ({
  type: 'limit',
  resetAt,
  at: NOW,
  afterActivity,
})
const activitySignal: RestingSignal = { type: 'activity', at: NOW }

test('a fresh parsed cap opens a non-synthetic episode', () => {
  const ep = updateObserved(null, limitSignal('2026-07-17T15:40:00.000Z'), NOW)
  assert.deepEqual(ep, { resetAt: '2026-07-17T15:40:00.000Z', synthetic: false })
})

test('a fresh credits-out cap opens a synthetic now+30min episode', () => {
  const ep = updateObserved(null, limitSignal(null), NOW)
  assert.deepEqual(ep, { resetAt: iso(NOW + RESTING_FALLBACK_MS), synthetic: true })
})

test('the same parsed cap repeated does not change the episode', () => {
  const prev: RestingEpisode = { resetAt: '2026-07-17T15:40:00.000Z', synthetic: false }
  assert.deepEqual(updateObserved(prev, limitSignal(prev.resetAt), NOW), prev)
})

test('a changed reset time replaces the episode', () => {
  const prev: RestingEpisode = { resetAt: '2026-07-17T15:40:00.000Z', synthetic: false }
  const ep = updateObserved(prev, limitSignal('2026-07-18T00:50:00.000Z'), NOW)
  assert.deepEqual(ep, { resetAt: '2026-07-18T00:50:00.000Z', synthetic: false })
})

test('a parsed cap upgrades a synthetic episode', () => {
  const prev: RestingEpisode = { resetAt: iso(NOW + RESTING_FALLBACK_MS), synthetic: true }
  const ep = updateObserved(prev, limitSignal('2026-07-17T15:40:00.000Z'), NOW)
  assert.deepEqual(ep, { resetAt: '2026-07-17T15:40:00.000Z', synthetic: false })
})

test('a synthetic signal never overrides a live parsed episode', () => {
  const prev: RestingEpisode = { resetAt: '2026-07-17T15:40:00.000Z', synthetic: false }
  assert.deepEqual(updateObserved(prev, limitSignal(null), NOW), prev)
})

test('a synthetic signal within the horizon keeps the existing synthetic episode', () => {
  const prev: RestingEpisode = { resetAt: iso(NOW + RESTING_FALLBACK_MS), synthetic: true }
  assert.deepEqual(updateObserved(prev, limitSignal(null), NOW + 60_000), prev)
})

test('still capped past the horizon opens a fresh synthetic episode (re-emit)', () => {
  const prev: RestingEpisode = { resetAt: iso(NOW + RESTING_FALLBACK_MS), synthetic: true }
  const later = NOW + RESTING_FALLBACK_MS + 1
  const ep = updateObserved(prev, { type: 'limit', resetAt: null, at: later, afterActivity: false }, later)
  assert.deepEqual(ep, { resetAt: iso(later + RESTING_FALLBACK_MS), synthetic: true })
})

test('real activity clears the episode', () => {
  const prev: RestingEpisode = { resetAt: '2026-07-17T15:40:00.000Z', synthetic: false }
  assert.equal(updateObserved(prev, activitySignal, NOW), null)
})

test('a parsed reset that already passed falls back to a synthetic horizon', () => {
  // A stale cap text can carry a reset time in the past; the transcript says
  // the session is still capped, so stay honest with the conservative guess
  // instead of an instantly-expiring episode.
  const ep = updateObserved(null, limitSignal(iso(NOW - 3_600_000)), NOW)
  assert.deepEqual(ep, { resetAt: iso(NOW + RESTING_FALLBACK_MS), synthetic: true })
})

test('a past parsed reset never overrides a live episode', () => {
  const prev: RestingEpisode = { resetAt: iso(NOW + 60_000), synthetic: false }
  assert.deepEqual(updateObserved(prev, limitSignal(iso(NOW - 1)), NOW), prev)
})

test('no signal preserves a live episode and expires a stale one', () => {
  const live: RestingEpisode = { resetAt: iso(NOW + 60_000), synthetic: false }
  assert.deepEqual(updateObserved(live, null, NOW), live)
  const stale: RestingEpisode = { resetAt: iso(NOW - 1), synthetic: false }
  assert.equal(updateObserved(stale, null, NOW), null)
})

test('shouldEmit fires once per episode and re-fires on change', () => {
  const ep: RestingEpisode = { resetAt: iso(NOW + 60_000), synthetic: false }
  assert.equal(shouldEmit(ep, null, NOW), true, 'fresh episode emits')
  assert.equal(shouldEmit(ep, ep, NOW), false, 'already emitted, no spam')
  const moved: RestingEpisode = { resetAt: iso(NOW + 120_000), synthetic: false }
  assert.equal(shouldEmit(moved, ep, NOW), true, 'changed resetAt re-emits')
  assert.equal(shouldEmit(null, ep, NOW), false, 'no episode, nothing to emit')
  const past: RestingEpisode = { resetAt: iso(NOW - 1), synthetic: false }
  assert.equal(shouldEmit(past, null, NOW), false, 'an already-passed resetAt is pointless')
})

// ── resolveRestingTick (the whole per-sweep decision, as the server runs it) ─

interface TickHarness {
  observed: RestingEpisode | null
  emitted: RestingEpisode | null
  patches: string[]
}

function runTick(h: TickHarness, signal: RestingSignal | null, now: number, patchOk = true): void {
  const next = resolveRestingTick({ observed: h.observed, emitted: h.emitted }, signal, now)
  h.observed = next.observed
  h.emitted = next.emitted
  if (next.resetAtToEmit !== null && patchOk) {
    h.patches.push(next.resetAtToEmit)
    h.emitted = h.observed
  }
}

test('full cycle: emit once, hold, re-emit after the horizon passes', () => {
  const h: TickHarness = { observed: null, emitted: null, patches: [] }
  runTick(h, limitSignal(null), NOW)
  runTick(h, { type: 'limit', resetAt: null, at: NOW + 30_000, afterActivity: false }, NOW + 30_000)
  runTick(h, null, NOW + 60_000)
  assert.equal(h.patches.length, 1, 'one PATCH per episode')
  const later = NOW + RESTING_FALLBACK_MS + 60_000
  runTick(h, { type: 'limit', resetAt: null, at: later, afterActivity: false }, later)
  assert.equal(h.patches.length, 2, 'still capped past the horizon PATCHes again')
  assert.equal(h.patches[1], iso(later + RESTING_FALLBACK_MS))
})

test('resume-then-recap inside ONE sweep chunk still re-emits (afterActivity)', () => {
  // Same backend-cleared-on-activity scenario as the two-tick test below,
  // but the activity and the re-cap land in the SAME 30s window; the
  // afterActivity flag must reset the emitted bookkeeping.
  const resetAt = iso(NOW + 8 * 3_600_000)
  const h: TickHarness = { observed: null, emitted: null, patches: [] }
  runTick(h, { type: 'limit', resetAt, at: NOW, afterActivity: false }, NOW)
  assert.deepEqual(h.patches, [resetAt])
  runTick(h, { type: 'limit', resetAt, at: NOW + 30_000, afterActivity: true }, NOW + 30_000)
  assert.deepEqual(h.patches, [resetAt, resetAt], 'one-chunk resume+recap re-emits')
})

test('an afterActivity credits-out cap replaces the stale episode, not dedups against it', () => {
  const oldReset = iso(NOW + 8 * 3_600_000)
  const h: TickHarness = { observed: null, emitted: null, patches: [] }
  runTick(h, { type: 'limit', resetAt: oldReset, at: NOW, afterActivity: false }, NOW)
  const t = NOW + 60_000
  runTick(h, { type: 'limit', resetAt: null, at: t, afterActivity: true }, t)
  assert.deepEqual(h.patches, [oldReset, iso(t + RESTING_FALLBACK_MS)])
})

test('a re-cap after a resume re-emits even with the SAME reset time', () => {
  // Weekly-cap scenario: cap until 10pm, owner buys credits (real activity,
  // backend clears resting), credits run out again before 10pm. The second
  // cap carries the IDENTICAL reset time; the emitted-state dedup must not
  // swallow it, or the chat shows a silently dead agent again.
  const resetAt = iso(NOW + 8 * 3_600_000)
  const h: TickHarness = { observed: null, emitted: null, patches: [] }
  runTick(h, { type: 'limit', resetAt, at: NOW, afterActivity: false }, NOW)
  assert.deepEqual(h.patches, [resetAt])
  runTick(h, { type: 'activity', at: NOW + 60_000 }, NOW + 60_000)
  assert.equal(h.observed, null, 'activity closes the episode')
  runTick(h, { type: 'limit', resetAt, at: NOW + 120_000, afterActivity: false }, NOW + 120_000)
  assert.deepEqual(h.patches, [resetAt, resetAt], 'same reset time re-emits after a resume')
})

test('a failed PATCH retries on the next sweep', () => {
  const resetAt = iso(NOW + 3_600_000)
  const h: TickHarness = { observed: null, emitted: null, patches: [] }
  runTick(h, { type: 'limit', resetAt, at: NOW, afterActivity: false }, NOW, false)
  assert.equal(h.patches.length, 0, 'PATCH failed, nothing recorded')
  runTick(h, null, NOW + 30_000)
  assert.deepEqual(h.patches, [resetAt], 'quiet next sweep still delivers the missed emit')
})

// ── RestingWatcher (fs walk + cursors) ───────────────────────────────────────

function makeProject(): { cwd: string; claudeHome: string; dir: string } {
  const claudeHome = mkdtempSync(join(tmpdir(), 'resting-test-'))
  const cwd = '/tmp/fake-workspace'
  const dir = join(claudeHome, 'projects', mungeCwd(cwd))
  mkdirSync(dir, { recursive: true })
  return { cwd, claudeHome, dir }
}

test('watcher sees appended caps and never re-reads consumed bytes', () => {
  const { cwd, claudeHome, dir } = makeProject()
  const staleTs = new Date(NOW - RESTING_STALE_MS - 60_000).toISOString()
  writeFileSync(join(dir, 'session.jsonl'), capLine(SESSION_CAP, { timestamp: staleTs }) + '\n')
  const watcher = new RestingWatcher(cwd, claudeHome, 'Asia/Dubai')
  assert.equal(watcher.scan(NOW), null, 'stale startup history never signals')
  appendFileSync(join(dir, 'session.jsonl'), capLine(SESSION_CAP) + '\n')
  const signal = watcher.scan(NOW)
  assert.ok(signal && signal.type === 'limit')
  assert.equal(signal.resetAt, '2026-07-17T15:40:00.000Z')
  assert.equal(watcher.scan(NOW), null, 'no new bytes, no signal')
})

test('watcher catches a FRESH cap that landed just before a plugin restart', () => {
  // Cap appended, plugin restarted before the first sweep emitted: the new
  // instance seeds the newest file's cursor a tail-window back, and the
  // freshness gate keeps that replay safe (only fresh records signal).
  const { cwd, claudeHome, dir } = makeProject()
  writeFileSync(join(dir, 'session.jsonl'), activityLine({ timestamp: new Date(NOW - RESTING_STALE_MS - 60_000).toISOString() }) + '\n' + capLine(SESSION_CAP) + '\n')
  const watcher = new RestingWatcher(cwd, claudeHome, 'Asia/Dubai')
  const signal = watcher.scan(NOW)
  assert.ok(signal && signal.type === 'limit', 'pre-startup fresh cap detected')
  assert.equal(signal.resetAt, '2026-07-17T15:40:00.000Z')
})

test('watcher startup tail is bounded', () => {
  // Only the last RESTING_STARTUP_TAIL_BYTES of the newest file are re-read;
  // a fresh cap buried deeper than the tail window stays invisible (bounded
  // startup cost) while one inside the window is found.
  const { cwd, claudeHome, dir } = makeProject()
  const filler = activityLine({
    timestamp: new Date(NOW - RESTING_STALE_MS - 60_000).toISOString(),
  })
  const fillerCount = Math.ceil(RESTING_STARTUP_TAIL_BYTES / (filler.length + 1)) + 4
  writeFileSync(
    join(dir, 'session.jsonl'),
    capLine(SESSION_CAP) + '\n' + Array.from({ length: fillerCount }, () => filler).join('\n') + '\n',
  )
  const watcher = new RestingWatcher(cwd, claudeHome, 'Asia/Dubai')
  assert.equal(watcher.scan(NOW), null, 'cap outside the tail window is not scanned')
})

test('watcher reads a file created after startup from byte 0', () => {
  const { cwd, claudeHome, dir } = makeProject()
  const watcher = new RestingWatcher(cwd, claudeHome, 'Asia/Dubai')
  writeFileSync(join(dir, 'later.jsonl'), capLine(FABLE_CAP) + '\n')
  const signal = watcher.scan(NOW)
  assert.ok(signal && signal.type === 'limit')
  assert.equal(signal.resetAt, null)
})

test('watcher leaves a partial tail line for the next scan', () => {
  const { cwd, claudeHome, dir } = makeProject()
  const watcher = new RestingWatcher(cwd, claudeHome, 'Asia/Dubai')
  const line = capLine(SESSION_CAP)
  writeFileSync(join(dir, 's.jsonl'), line.slice(0, 40))
  assert.equal(watcher.scan(NOW), null, 'partial line not consumed')
  appendFileSync(join(dir, 's.jsonl'), line.slice(40) + '\n')
  const signal = watcher.scan(NOW)
  assert.ok(signal && signal.type === 'limit', 'completed line consumed')
})

test('watcher survives a missing project dir', () => {
  const watcher = new RestingWatcher('/tmp/nonexistent-workspace', mkdtempSync(join(tmpdir(), 'resting-none-')))
  assert.equal(watcher.scan(NOW), null)
})

test('watcher restarts from byte 0 after a truncation', () => {
  const { cwd, claudeHome, dir } = makeProject()
  const watcher = new RestingWatcher(cwd, claudeHome, 'Asia/Dubai')
  const path = join(dir, 't.jsonl')
  writeFileSync(path, activityLine() + '\n' + activityLine() + '\n')
  assert.ok(watcher.scan(NOW), 'appended activity seen')
  writeFileSync(path, '') // rotated/truncated
  assert.equal(watcher.scan(NOW), null, 'truncation itself yields nothing')
  writeFileSync(path, capLine(SESSION_CAP) + '\n')
  const signal = watcher.scan(NOW)
  assert.ok(signal && signal.type === 'limit', 'post-truncation content read from byte 0')
})

test('watcher picks the newest signal across files', () => {
  const { cwd, claudeHome, dir } = makeProject()
  const watcher = new RestingWatcher(cwd, claudeHome, 'Asia/Dubai')
  writeFileSync(
    join(dir, 'a.jsonl'),
    capLine(SESSION_CAP, { timestamp: new Date(NOW - 120_000).toISOString() }) + '\n',
  )
  writeFileSync(
    join(dir, 'b.jsonl'),
    activityLine({ timestamp: new Date(NOW - 10_000).toISOString() }) + '\n',
  )
  const signal = watcher.scan(NOW)
  assert.ok(signal && signal.type === 'activity', 'later activity outranks the older cap')
})
