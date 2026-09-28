/**
 * A message the previous session consumed and never answered comes back after
 * a restart (board row 294a571a, raised 2026-09-06, fixed 2026-09-26).
 *
 * THE DEFECT. The per-chat cursor advances when a message is FORWARDED, not
 * when it is ANSWERED. A session handed a message that it then cannot act on,
 * because the account hit a limit, because the model call failed, because it
 * was killed mid turn, leaves that message BELOW the cursor forever: the delta
 * window starts above it, `selectFirstPollBacklogIds` only runs for a chat with
 * no cursor at all, and the restart hands the new session nothing.
 *
 * THE CLEAN EXEMPLAR, and it is why this is not a corner case. On 2026-09-24
 * Argus's session was running on an account that had hit its weekly limit. KC
 * wrote at 14:29:00Z; the daemon forwarded it; every model call the session
 * made was refused, including the reply overdue nudge and the liveness probe.
 * It was restarted at 14:49:46Z, came up, and SAT IDLE with KC's question still
 * unanswered, because the restart was given nothing. It answered at 14:53:45Z
 * only after a person noticed and asked again. A shared account running out is
 * a fleet wide event, so every message that arrives during one is consumed by a
 * session that cannot answer it.
 *
 * WHAT MAKES THE FIX SAFE IS THE STOP RULE, not the window or the cap: the scan
 * stops at a real user then assistant REPLY, so a message the previous session
 * DID answer is never re-offered. The three tests under "it never re-offers an
 * answered message" are the ones to read first.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  selectRestartRecoveryIds,
  RESTART_RECOVERY_WINDOW_MS,
  FIRST_RUN_RECENT_WINDOW_MS,
  type FirstPollRow,
} from '../lib/poll-core.ts'

const NOW = 1_800_000_000_000
const RECENT = NOW - 60_000
const YESTERDAY = NOW - 20 * 3_600_000
const ANCIENT = NOW - 30 * 24 * 3_600_000

function row(
  id: number,
  sender: string | null,
  opts: { pendingEmpty?: boolean; sentMs?: number | null } = {},
): FirstPollRow {
  return {
    id,
    sender,
    pendingEmptySystem: opts.pendingEmpty ?? false,
    sentDateMs: opts.sentMs === undefined ? RECENT : opts.sentMs,
  }
}

const recover = (rows: FirstPollRow[], lastSeen: number, maxForward = 10) =>
  selectRestartRecoveryIds({ rows, lastSeen, maxForward, nowMs: NOW })

// ── The case this exists for ─────────────────────────────────────────────────

test('the Argus case: a consumed, unanswered message below the cursor comes back', () => {
  // The cursor advanced past 42 when it was forwarded. Nothing answered it.
  const rows = [row(40, 'user'), row(41, 'assistant'), row(42, 'user')]
  assert.deepEqual(recover(rows, 42), [42])
})

test('several unanswered in a row all come back, oldest first', () => {
  const rows = [row(40, 'assistant'), row(41, 'user'), row(42, 'user'), row(43, 'user')]
  assert.deepEqual(recover(rows, 43), [41, 42, 43])
})

test('a system wake card the session never answered comes back too', () => {
  // System rows are inbound machine traffic the agent must process exactly
  // like a user message, and a scheduled wake that is consumed and dropped is
  // how a nightly job silently stops happening.
  const rows = [row(40, 'user'), row(41, 'assistant'), row(42, 'system')]
  assert.deepEqual(recover(rows, 42), [42])
})

// ── It never re-offers an answered message ───────────────────────────────────

test('a user message the session ANSWERED is never re-offered', () => {
  const rows = [row(40, 'user'), row(41, 'assistant')]
  assert.deepEqual(recover(rows, 41), [])
})

test('an answered message stays answered however many boots happen', () => {
  // The same input twice: this function is pure and carries no state, so a
  // crash loop cannot turn one answered message into a growing backlog.
  const rows = [row(40, 'user'), row(41, 'assistant')]
  assert.deepEqual(recover(rows, 41), [])
  assert.deepEqual(recover(rows, 41), [])
})

test('the stop is a REPLY, not merely an assistant row: a proactive one does not stop it', () => {
  // A cron check in or an external trigger writes an assistant row that answers
  // nothing. Treating it as a reply would silently swallow the messages
  // underneath it, which is this defect wearing the opposite coat.
  //
  // NOTE ON HOW "REPLY" IS DEFINED, because I wrote this test wrongly first and
  // the failure taught me the rule rather than the other way round: a reply is
  // POSITIONAL, an assistant row whose IMMEDIATELY PRECEDING row is a user row.
  // So an assistant row can only be proactive when what sits under it is not a
  // user row. My first version was [user 40, assistant 41, assistant 42] and I
  // expected 40 back; 41 is directly above user 40, so by the rule it IS 40's
  // reply and the scan correctly stopped. The empty answer was right and my
  // expectation was wrong.
  const rows = [row(40, 'user'), row(41, 'system'), row(42, 'assistant')]
  assert.deepEqual(recover(rows, 42), [40, 41])
})

test('only the tail comes back: an older answered exchange is left alone', () => {
  const rows = [
    row(30, 'user'),
    row(31, 'assistant'),
    row(40, 'user'),
    row(41, 'assistant'),
    row(42, 'user'),
  ]
  assert.deepEqual(recover(rows, 42), [42])
})

// ── It cannot deliver anything twice in one poll ─────────────────────────────

test('a row ABOVE the cursor is left to the delta path, never duplicated here', () => {
  // The ordinary delta filter on the same poll forwards id > lastSeen. If this
  // returned one too, the agent would be handed the same message twice in one
  // turn.
  const rows = [row(40, 'user'), row(41, 'assistant'), row(42, 'user'), row(43, 'user')]
  assert.deepEqual(recover(rows, 42), [42])
})

test('an unanswered row BELOW the cursor still comes back when a newer one sits above it', () => {
  // The scan must not stop at the first row above the cursor: the row worth
  // recovering is the older one.
  const rows = [row(41, 'user'), row(42, 'user')]
  assert.deepEqual(recover(rows, 41), [41])
})

test('no cursor at all is not this function job: selectFirstPollBacklogIds owns that', () => {
  const rows = [row(40, 'user'), row(41, 'user')]
  assert.deepEqual(recover(rows, 0), [])
})

// ── It cannot flood, and it cannot replay history ────────────────────────────

test('the cap holds: a chat where nothing was ever answered returns at most maxForward', () => {
  const rows = Array.from({ length: 40 }, (_, i) => row(100 + i, 'user'))
  const ids = recover(rows, 139, 10)
  assert.equal(ids.length, 10)
  // And it keeps the NEWEST ten, in order, not the oldest ten.
  assert.deepEqual(ids, [130, 131, 132, 133, 134, 135, 136, 137, 138, 139])
})

test('a message older than the window does not come back', () => {
  const rows = [row(40, 'assistant'), row(41, 'user', { sentMs: ANCIENT })]
  assert.deepEqual(recover(rows, 41), [])
})

test('yesterday still counts, because a muted account can last hours', () => {
  const rows = [row(40, 'assistant'), row(41, 'user', { sentMs: YESTERDAY })]
  assert.deepEqual(recover(rows, 41), [41])
  // And the window is a DAY, deliberately wider than the first run gate's ten
  // minutes, because the two answer different questions.
  assert.ok(RESTART_RECOVERY_WINDOW_MS > FIRST_RUN_RECENT_WINDOW_MS)
  assert.equal(RESTART_RECOVERY_WINDOW_MS, 24 * 3_600_000)
})

test('a row with NO sent date does not qualify: unknown age must not read as recent', () => {
  const rows = [row(40, 'assistant'), row(41, 'user', { sentMs: null })]
  assert.deepEqual(recover(rows, 41), [])
})

test('a wake card still in its empty write-1 state is skipped, not recovered', () => {
  // Its body has not landed, so there is nothing to forward; the cursor cap in
  // advanceCursor parks under it and a later poll re-reads it once it fills.
  const rows = [row(40, 'assistant'), row(41, 'system', { pendingEmpty: true })]
  assert.deepEqual(recover(rows, 41), [])
})

test('maxForward of zero returns nothing rather than everything', () => {
  const rows = [row(40, 'assistant'), row(41, 'user')]
  assert.deepEqual(recover(rows, 41, 0), [])
})

// ── The wiring, because a pure function nobody calls fixes nothing ───────────

const server = readFileSync(new URL('../server.ts', import.meta.url), 'utf8').replace(
  /\r\n/g,
  '\n',
)

test('the recovery runs on the BOOT poll only, and its result is framed as backlog', () => {
  // Every test above passes with the function sitting in lib/ uncalled, which
  // is the one shape that would make this whole file worthless.
  //
  // AND THE FIRST VERSION OF THIS TEST WAS ITSELF HOLLOW, which is worth more
  // than the test. It searched the 1200 characters before the call for the word
  // `isBootPoll`, and the comment I had just written above the call contains
  // that word, so replacing the real gate with `if (true)` left all 17 tests
  // green. A guard that can be satisfied by a COMMENT is not a guard. It now
  // walks back to the nearest `if (` line and reads THAT.
  assert.ok(
    server.includes('selectRestartRecoveryIds('),
    'server.ts must call selectRestartRecoveryIds',
  )
  const at = server.indexOf('selectRestartRecoveryIds({')
  assert.ok(at > 0, 'the call must pass an options object')
  const before = server.slice(0, at)
  const gateAt = before.lastIndexOf('\n      if (')
  assert.ok(gateAt > 0, 'the call must sit inside an if at the delta branch depth')
  const gate = before.slice(gateAt + 1, before.indexOf('\n', gateAt + 1))
  assert.equal(
    gate.trim(),
    'if (isBootPoll) {',
    `the call must be gated on isBootPoll and nothing else, got: ${gate.trim()}. A steady-state poll re-offering rows below its own cursor would repeat every message forever.`,
  )
})
