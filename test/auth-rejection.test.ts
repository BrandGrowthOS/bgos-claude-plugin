/**
 * Sustained credential rejection.
 *
 * The incident this guards is in lib/auth-rejection.ts: a daemon polled for
 * fifteen hours against a credential the server refused, ~29,000 401s, and said
 * nothing to anyone. These tests pin the two things that made it silent (no
 * counter, no escalation) and the two things that must not go wrong now that it
 * speaks (it must not cry wolf, and it must not try to speak over the channel
 * that is broken).
 *
 * Run with:  npx tsx --test test/auth-rejection.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  AUTH_REJECTION_MIN_COUNT,
  AUTH_REJECTION_MIN_MS,
  buildAuthRejectionNotification,
  heartbeatLastError,
  type AuthRejectionState,
  initialAuthRejectionState,
  markAuthRejectionNotified,
  observeAuthOutcome,
  shouldReportAuthRejection,
} from '../lib/auth-rejection.ts'

const serverSource = readFileSync(new URL('../server.ts', import.meta.url), 'utf8')

/** Drive N rejections spaced `stepMs` apart, starting at t0. */
function reject(n: number, { from = 0, stepMs = 2_000 } = {}) {
  let state = initialAuthRejectionState()
  let now = from
  for (let i = 0; i < n; i++) {
    state = observeAuthOutcome(state, 401, now)
    now += stepMs
  }
  return { state, now }
}

test('a single 401 says nothing', () => {
  const { state } = reject(1)
  assert.equal(shouldReportAuthRejection(state, 10_000), false)
})

test('a burst of rejections in a moment says nothing, however many', () => {
  // Several calls in flight when a token rotates all fail together. That is a
  // blip, not a condition, so the duration floor has to hold the count back.
  const { state, now } = reject(AUTH_REJECTION_MIN_COUNT * 3, { stepMs: 5 })
  assert.ok(state.consecutive >= AUTH_REJECTION_MIN_COUNT)
  assert.equal(shouldReportAuthRejection(state, now), false)
})

test('a long slow trickle says nothing until the count is also met', () => {
  // Two rejections an hour apart clear the duration floor and must still not
  // fire: one unlucky request at the wrong moment is not a broken credential.
  let state = initialAuthRejectionState()
  state = observeAuthOutcome(state, 401, 0)
  state = observeAuthOutcome(state, 401, 3_600_000)
  assert.equal(shouldReportAuthRejection(state, 3_600_000), false)
})

test('sustained rejection, both floors cleared, reports once', () => {
  const { state, now } = reject(AUTH_REJECTION_MIN_COUNT, { stepMs: 3_000 })
  assert.ok(now >= AUTH_REJECTION_MIN_MS, 'fixture must clear the duration floor')
  assert.equal(shouldReportAuthRejection(state, now), true)

  // ...and exactly once, or a 2-second poll posts it thirty times a minute.
  const after = markAuthRejectionNotified(state)
  assert.equal(shouldReportAuthRejection(after, now + 60_000), false)
})

test('ANY success resets the run completely, including the notified latch', () => {
  const { state, now } = reject(AUTH_REJECTION_MIN_COUNT, { stepMs: 3_000 })
  const notified = markAuthRejectionNotified(state)
  const recovered = observeAuthOutcome(notified, 200, now)
  assert.deepEqual(recovered, initialAuthRejectionState())

  // A LATER failure is therefore free to speak again, rather than being
  // permanently silenced by one earlier notification.
  let again = recovered
  let t = now
  for (let i = 0; i < AUTH_REJECTION_MIN_COUNT; i++) {
    again = observeAuthOutcome(again, 401, t)
    t += 3_000
  }
  assert.equal(shouldReportAuthRejection(again, t), true)
})

test('only 401 counts: a 403, a 500 and a 429 all end the run', () => {
  // A 403 is an answer about a resource, not about who we are. A 5xx is the
  // server having a bad day. A 429 is us being throttled. Counting any of them
  // would fire this on every backend deploy.
  for (const status of [403, 500, 502, 429]) {
    const { state, now } = reject(AUTH_REJECTION_MIN_COUNT, { stepMs: 3_000 })
    assert.equal(shouldReportAuthRejection(state, now), true, 'fixture should be armed')
    const cleared = observeAuthOutcome(state, status, now)
    assert.equal(cleared.consecutive, 0, `${status} must end the run`)
    assert.equal(shouldReportAuthRejection(cleared, now), false)
  }
})

test('the notice states the observation and offers re-pairing, never a cause', () => {
  const notice = buildAuthRejectionNotification({ consecutive: 42, minutes: 15 })
  assert.match(notice.content, /refusing this agent's credentials/)
  assert.match(notice.content, /hoai pair/)
  assert.equal(notice.meta.event_type, 'auth_rejected')
  // PR #95's rule: never assert a cause we have not established.
  assert.doesNotMatch(notice.content, /revoked|expired|because/i)
  assert.doesNotMatch(notice.content, /[–—]/)
})

test('the notice is delivered over LOCAL IPC, not the HTTP channel being refused', () => {
  // The whole failure mode is that authenticated calls are rejected, so a chat
  // post is the one delivery that cannot work. This also pins the exact method
  // string: an earlier draft used 'notifications/claude/channel/message', which
  // does not exist, and a wrong method fails silently, which is precisely the
  // class of bug this PR is fixing.
  const fn = /function noteAuthOutcome\([\s\S]*?\n\}/.exec(serverSource)
  assert.ok(fn, 'noteAuthOutcome must exist')
  assert.match(fn[0], /method: 'notifications\/claude\/channel'/)
  assert.doesNotMatch(fn[0], /sendDaemonText|bgosPost|monitoredChatIds/)
  // And it must log unconditionally, because that is what `hoai logs` prints.
  assert.match(fn[0], /log\(`WARN/)
})

test('every authenticated call is observed, because bgosCall is the chokepoint', () => {
  const fn = /function bgosCall<T>\([\s\S]*?\n\}/.exec(serverSource)
  assert.ok(fn, 'bgosCall must exist')
  assert.match(
    fn[0],
    /noteAuthOutcome\(response\.status\)/,
    'bgosCall must observe every response, or a rejected daemon goes quiet again',
  )
})

test('the observer can never break the call it is observing', () => {
  // noteAuthOutcome runs on EVERY response. If it throws, the exception
  // surfaces as a failure of whatever request was in flight, which turns a
  // diagnostic into an outage. `mcp` is a const declared ~900 lines below it,
  // so a call during module evaluation would also hit the temporal dead zone.
  const fn = /function noteAuthOutcome\(status: number\): void \{[\s\S]*?\n\}/.exec(
    serverSource,
  )
  assert.ok(fn, 'noteAuthOutcome must exist')
  assert.match(fn[0], /try \{/, 'the observer must be wrapped')
  assert.match(fn[0], /catch \(/, 'and it must swallow, not rethrow')
})

// ── heartbeatLastError: the FLEET-visible half ───────────────────────────────
// 2026-08-29. The backend has stored a heartbeat lastError since the columns
// existed, and across 76 live pairings the number that had ever carried one was
// zero, because nothing sent it. A blank error column read as health. These pin
// that the daemon now reports the refusal it already detects locally.

test('a healthy daemon reports null, so the backend CLEARS rather than keeps a stale error', () => {
  assert.equal(heartbeatLastError(initialAuthRejectionState(), 1_000_000), null)
})

test('a sustained refusal is reported, with the observation and no guessed cause', () => {
  const started = 1_000_000
  const err = heartbeatLastError(
    { consecutive: AUTH_REJECTION_MIN_COUNT, firstAt: started, notified: false },
    started + AUTH_REJECTION_MIN_MS,
  )
  assert.ok(err, 'a refusal past both thresholds must reach the fleet')
  assert.equal(err!.code, 'auth_rejected')
  assert.equal(err!.at, new Date(started).toISOString())
  assert.ok(err!.message.length <= 300, 'HeartbeatErrorDto caps message at 300')
  assert.ok(err!.code.length <= 64, 'HeartbeatErrorDto caps code at 64')
  assert.doesNotMatch(
    err!.message,
    /revoked|superseded|expired/i,
    'it states the observation; the daemon does not know the cause (see #95)',
  )
})

test('a short blip is NOT reported: same thresholds that gate the local warning', () => {
  const started = 1_000_000
  assert.equal(
    heartbeatLastError(
      { consecutive: AUTH_REJECTION_MIN_COUNT - 1, firstAt: started, notified: false },
      started + AUTH_REJECTION_MIN_MS,
    ),
    null,
    'too few calls',
  )
  assert.equal(
    heartbeatLastError(
      { consecutive: AUTH_REJECTION_MIN_COUNT, firstAt: started, notified: false },
      started + AUTH_REJECTION_MIN_MS - 1,
    ),
    null,
    'not long enough',
  )
})

test('recovery clears itself: one success returns consecutive to 0, so the next beat sends null', () => {
  const started = 1_000_000
  let st: AuthRejectionState = {
    consecutive: AUTH_REJECTION_MIN_COUNT,
    firstAt: started,
    notified: true,
  }
  assert.ok(heartbeatLastError(st, started + AUTH_REJECTION_MIN_MS))
  st = observeAuthOutcome(st, 200, started + AUTH_REJECTION_MIN_MS)
  assert.equal(
    heartbeatLastError(st, started + AUTH_REJECTION_MIN_MS),
    null,
    'no separate clear call: the backend treats explicit null as clear',
  )
})

test('reporting does NOT depend on `notified`, because the fleet wants CURRENT state', () => {
  const started = 1_000_000
  const st = { consecutive: AUTH_REJECTION_MIN_COUNT, firstAt: started, notified: true }
  assert.ok(
    heartbeatLastError(st, started + AUTH_REJECTION_MIN_MS),
    'the owner is told once; the fleet is told while it is still true',
  )
})

// The projection is worthless if nothing calls it, which is the exact failure
// it exists to fix: the backend could store a lastError for months while no
// daemon ever sent one. Pin the WIRING, not just the logic.
test('the daemon actually SENDS it: heartbeat wired to the live rejection state', () => {
  assert.match(
    serverSource,
    /lastError:\s*\(\)\s*=>\s*heartbeatLastError\(authRejection,\s*Date\.now\(\)\)/,
    'startVersionHeartbeat must be passed the projection of the SAME state noteAuthOutcome updates',
  )
  const heartbeatSource = readFileSync(
    new URL('../lib/version-heartbeat.ts', import.meta.url),
    'utf8',
  )
  assert.match(
    heartbeatSource,
    /body\.lastError = deps\.lastError\(\)/,
    'and the heartbeat body must actually carry it',
  )
  assert.match(
    heartbeatSource,
    /if \(deps\.lastError\) \{\s*try \{/,
    'guarded like the update providers: telemetry must never fail a heartbeat',
  )
})
