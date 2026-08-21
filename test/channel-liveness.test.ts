/**
 * Channel liveness (fix 04, the double-silent failure).
 *
 * A Claude Code session launched without the channel flag accepts the
 * plugin's channel notifications at the transport and silently discards
 * them; the daemon then persists its cursor advances and the messages are
 * lost forever, even after the operator fixes the flag and restarts. The
 * lib under test carries the pure pieces of the fix:
 *
 *   1. ChannelLiveness: one-way latch, flips on the first bgos tool call.
 *   2. gatePersistedCursors: what a session may persist. Live: everything.
 *      Not live: only the boot entries, each at its boot value; chats first
 *      seen after boot are omitted so a restart re-frames them as backlog.
 *   3. shouldEscalateDeafSession: post the in-chat warning only when the
 *      session is not live, a nudged pending inbound went unacted for a
 *      second full window, and the escalation has not fired this boot.
 *   4. deafSessionChatMessage: the user-facing warning, carrying the exact
 *      launch command verbatim and promising messages are queued, not lost.
 *
 * Run with:  node --test test/channel-liveness.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  ChannelLiveness,
  gatePersistedCursors,
  shouldEscalateDeafSession,
  deafSessionChatMessage,
} from '../lib/channel-liveness.ts'

// ── ChannelLiveness ──────────────────────────────────────────────────────────

test('ChannelLiveness starts not live', () => {
  const liveness = new ChannelLiveness()
  assert.equal(liveness.live, false)
})

test('ChannelLiveness flips live on the first tool call and stays live', () => {
  const liveness = new ChannelLiveness()
  liveness.markToolCall()
  assert.equal(liveness.live, true)
  liveness.markToolCall()
  assert.equal(liveness.live, true)
})

// ── gatePersistedCursors ─────────────────────────────────────────────────────

test('gatePersistedCursors: live session persists the current record unchanged', () => {
  const current = { '101': 500, '102': 900 }
  const boot = { '101': 300 }
  const out = gatePersistedCursors({ current, boot, live: true })
  assert.deepEqual(out, { '101': 500, '102': 900 })
})

test('gatePersistedCursors: not-live session persists ONLY boot entries at boot values', () => {
  const current = { '101': 500, '102': 900, '103': 7 }
  const boot = { '101': 300, '999': 42 }
  const out = gatePersistedCursors({ current, boot, live: false })
  // Advances made while deaf are withheld ('101' stays at its boot value),
  // chats first seen after boot are omitted ('102', '103'), and boot chats
  // with no activity this run keep their value ('999').
  assert.deepEqual(out, { '101': 300, '999': 42 })
})

test('gatePersistedCursors: never mutates inputs and never aliases boot', () => {
  const current = { '101': 500, '102': 900 }
  const boot = { '101': 300 }
  const currentBefore = { ...current }
  const bootBefore = { ...boot }

  const out = gatePersistedCursors({ current, boot, live: false })
  assert.deepEqual(current, currentBefore)
  assert.deepEqual(boot, bootBefore)

  // The gated record must be a fresh object: a caller mutating it must not
  // corrupt the boot snapshot it will need at the next flush.
  assert.notStrictEqual(out, boot)
  out['101'] = 999999
  assert.equal(boot['101'], 300)
})

// ── shouldEscalateDeafSession ────────────────────────────────────────────────

const WINDOW_MS = 1000
const baseInput = {
  live: false,
  pending: { ts: 10_000, reminded: true },
  now: 10_000 + 2 * WINDOW_MS,
  alreadyEscalated: false,
  windowMs: WINDOW_MS,
}

test('shouldEscalateDeafSession: fires when every condition holds (boundary inclusive)', () => {
  // baseInput sits exactly at now - ts == 2 * windowMs, the earliest moment.
  assert.equal(shouldEscalateDeafSession({ ...baseInput }), true)
  // And any time after that.
  assert.equal(
    shouldEscalateDeafSession({ ...baseInput, now: baseInput.now + 60_000 }),
    true,
  )
})

test('shouldEscalateDeafSession: a live session never escalates', () => {
  assert.equal(shouldEscalateDeafSession({ ...baseInput, live: true }), false)
})

test('shouldEscalateDeafSession: no pending inbound, no escalation', () => {
  assert.equal(shouldEscalateDeafSession({ ...baseInput, pending: null }), false)
})

test('shouldEscalateDeafSession: waits for the nudge to have fired first', () => {
  assert.equal(
    shouldEscalateDeafSession({
      ...baseInput,
      pending: { ts: 10_000, reminded: false },
    }),
    false,
  )
})

test('shouldEscalateDeafSession: fires at most once per boot', () => {
  assert.equal(
    shouldEscalateDeafSession({ ...baseInput, alreadyEscalated: true }),
    false,
  )
})

test('shouldEscalateDeafSession: not before two full windows have passed', () => {
  assert.equal(
    shouldEscalateDeafSession({ ...baseInput, now: baseInput.now - 1 }),
    false,
  )
})

// ── deafSessionChatMessage ───────────────────────────────────────────────────

test('deafSessionChatMessage carries the launch command verbatim', () => {
  const cmd =
    'claude --dangerously-skip-permissions --dangerously-load-development-channels plugin:hoai@hoai'
  const msg = deafSessionChatMessage(cmd)
  assert.ok(msg.includes(cmd), 'launch command must appear verbatim')
})

test('deafSessionChatMessage promises messages are queued and offers hoai doctor', () => {
  const msg = deafSessionChatMessage('claude server:bgos')
  assert.ok(msg.toLowerCase().includes('queued'), 'must say messages are queued')
  assert.ok(msg.includes('hoai doctor'), 'must offer hoai doctor as the alternative')
  // House style: no em or en dashes anywhere in user-facing copy.
  assert.ok(!/[\u2013\u2014]/.test(msg), 'no em or en dashes in the chat message')
})
