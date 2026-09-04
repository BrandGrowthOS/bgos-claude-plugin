/**
 * Reporting a deaf session on the heartbeat (the daemon half of backend #1278).
 *
 * WHY THIS EXISTS. #1278 gave presence a third tier: connected but not
 * answering reads 'unresponsive' instead of a confident green 'online'. Its
 * fail-safe is that no report means 'ok'. That fail-safe is right, and it is
 * exactly why the feature shipped DARK: backend and app were both live and
 * nothing ever sent the code, so every agent read 'ok' and the quiet field
 * looked like a healthy fleet.
 *
 * The tests below pin the two properties that decide whether this is worth
 * having at all. It must FIRE on a genuinely deaf session, or it is the same
 * dark feature with more code. And it must NOT fire on anything else, because
 * a health tier that cries wolf gets ignored, and the population it would
 * wrongly accuse is every busy agent in the fleet.
 *
 * Run: npm test (node --test) or bun test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  SESSION_UNRESPONSIVE_CODE,
  heartbeatUnresponsiveError,
  pickHeartbeatLastError,
} from '../lib/channel-liveness.ts'

const NOW = 1_800_000_000_000
const TWENTY_MIN = 20 * 60_000

// ── It fires when the session is genuinely deaf ──────────────────────────────

test('reports the reserved code once the deaf verdict is reached', () => {
  const err = heartbeatUnresponsiveError({
    escalated: true,
    live: false,
    since: NOW - TWENTY_MIN,
    now: NOW,
  })
  assert.ok(err, 'a confirmed deaf session must be reported')
  assert.equal(err.code, SESSION_UNRESPONSIVE_CODE)
  assert.equal(err.at, new Date(NOW - TWENTY_MIN).toISOString())
  assert.match(err.message, /20 minute/)
})

test('the code is the exact string the backend reserves', () => {
  // CONTRACT with backend/src/dto/integrations/heartbeat.dto.ts, which owns
  // SESSION_UNRESPONSIVE_CODE and treats every other code as 'ok'. The two
  // trees do not share a compiler, so this literal IS the interface: a typo
  // here does not fail a build, it silently reports a code the backend ignores
  // and the tier stays dark exactly as before. Pinned rather than derived,
  // because there is nothing here to derive it from.
  assert.equal(SESSION_UNRESPONSIVE_CODE, 'session_unresponsive')
})

test('the message fits the DTO cap and claims no cause', () => {
  const err = heartbeatUnresponsiveError({
    escalated: true,
    live: false,
    since: NOW - TWENTY_MIN,
    now: NOW,
  })
  assert.ok(err)
  // HeartbeatErrorDto caps message at 300 chars; over it the whole heartbeat
  // is rejected, so an over-long message does not degrade the report, it
  // deletes it.
  assert.ok(
    err.message.length <= 300,
    `message is ${err.message.length} chars, over the DTO's 300 cap`,
  )
  // States observations. Never guesses why (out of credits, wedged, waiting).
  assert.doesNotMatch(err.message, /credit|wedged|crashed|killed|because/i)
})

// ── It stays silent on everything else ───────────────────────────────────────

test('says nothing until the verdict is actually reached', () => {
  // The fail-safe. Every healthy agent in the fleet is this case on every
  // heartbeat, so a false positive here is a false positive everywhere.
  assert.equal(
    heartbeatUnresponsiveError({
      escalated: false,
      live: false,
      since: null,
      now: NOW,
    }),
    null,
  )
})

test('a session that speaks again clears itself, with no recovery call', () => {
  // The escalation latch is once-per-boot and never un-latches, so recovery
  // CANNOT come from the latch. It comes from liveness: any bgos tool call
  // makes the session live, this returns null, and the backend reads an
  // explicit null as "clear the columns". If this returned an error while
  // live, a session that recovered would stay marked unresponsive until it
  // restarted, which is worse than never having reported it.
  assert.equal(
    heartbeatUnresponsiveError({
      escalated: true,
      live: true,
      since: NOW - TWENTY_MIN,
      now: NOW,
    }),
    null,
  )
})

test('a missing timestamp degrades to now rather than to a bogus duration', () => {
  const err = heartbeatUnresponsiveError({
    escalated: true,
    live: false,
    since: null,
    now: NOW,
  })
  assert.ok(err)
  assert.equal(err.at, new Date(NOW).toISOString())
  assert.match(err.message, /0 minute/)
})

// ── One field, two producers ─────────────────────────────────────────────────

test('a refused credential wins, because it explains the silence', () => {
  const auth = { code: 'auth_rejected', message: 'refused', at: 'a' }
  const deaf = { code: SESSION_UNRESPONSIVE_CODE, message: 'deaf', at: 'b' }
  // Not independent failures: a daemon whose calls are refused cannot deliver
  // messages to its session, so that session goes quiet and LOOKS deaf.
  // Reporting the deafness would name the symptom and bury the cause, and the
  // two have different remedies.
  assert.equal(pickHeartbeatLastError(auth, deaf), auth)
  assert.equal(pickHeartbeatLastError(null, deaf), deaf)
  assert.equal(pickHeartbeatLastError(auth, null), auth)
  assert.equal(pickHeartbeatLastError(null, null), null)
})
