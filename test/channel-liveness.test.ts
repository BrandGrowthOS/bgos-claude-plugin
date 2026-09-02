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
 *   3. deafSessionAction: three-way. Wait, then PROBE (ask the session to
 *      call channel_ack), and only escalate to an in-chat warning when the
 *      probe itself went unanswered. Silence alone never accuses anyone: see
 *      the 2026-08-26 Observer false positive recorded in the lib.
 *   4. deafSessionChatMessage: the user-facing warning, stating what was
 *      observed rather than an unproven cause, leading with the harmless
 *      diagnostic and carrying the launch command verbatim.
 *
 * Run with:  node --test test/channel-liveness.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  ChannelLiveness,
  gatePersistedCursors,
  deafSessionAction,
  deafSessionChatMessage,
  deafFixCommand,
  DEAF_PROBE_GRACE_WINDOWS,
  inboundOwesReply,
} from '../lib/channel-liveness.ts'
import { readFileSync } from 'node:fs'

const serverSource = readFileSync(new URL('../server.ts', import.meta.url), 'utf8')

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

// ── deafSessionAction ────────────────────────────────────────────────────────

const WINDOW_MS = 1000
// The earliest moment the old boolean returned true. It now buys a probe.
const baseInput = {
  live: false,
  pending: { ts: 10_000, reminded: true },
  now: 10_000 + 2 * WINDOW_MS,
  alreadyEscalated: false,
  probeSentAt: null as number | null,
  windowMs: WINDOW_MS,
}
/** Same input, advanced to just past the probe grace with the probe unanswered. */
const afterProbe = {
  ...baseInput,
  probeSentAt: baseInput.now,
  now: baseInput.now + DEAF_PROBE_GRACE_WINDOWS * WINDOW_MS,
}

test('deafSessionAction: probes (never accuses) at the old escalation moment', () => {
  // baseInput sits exactly at now - ts == 2 * windowMs, the earliest moment.
  assert.equal(deafSessionAction({ ...baseInput }), 'probe')
  // And any time after that, as long as no probe has gone out yet.
  assert.equal(
    deafSessionAction({ ...baseInput, now: baseInput.now + 60_000 }),
    'probe',
  )
})

test('deafSessionAction: THE REGRESSION. a quiet session is asked, not accused', () => {
  // Observer, 2026-08-26: heard its 00:30 wake, worked 7m37s, stood down
  // silently because its standing order says to, and was told in its owner's
  // chat that it could not receive messages and was launched without the
  // channel flag. Both were false. However long such a session stays quiet,
  // the FIRST thing it ever earns is a question.
  for (const elapsed of [2, 5, 20, 500]) {
    assert.equal(
      deafSessionAction({ ...baseInput, now: 10_000 + elapsed * WINDOW_MS }),
      'probe',
      `silence alone must never escalate (${elapsed} windows)`,
    )
  }
})

test('deafSessionAction: answering the probe ends it for the boot', () => {
  // channel_ack goes through the CallTool chokepoint and flips live, so the
  // session that answers is never warned about, whatever the clock says.
  assert.equal(deafSessionAction({ ...afterProbe, live: true }), 'wait')
})

test('deafSessionAction: escalates only after an unanswered probe', () => {
  assert.equal(deafSessionAction({ ...afterProbe }), 'escalate')
})

test('deafSessionAction: waits out the full probe grace before escalating', () => {
  assert.equal(
    deafSessionAction({ ...afterProbe, now: afterProbe.now - 1 }),
    'wait',
  )
})

test('deafSessionAction: a live session never probes or escalates', () => {
  assert.equal(deafSessionAction({ ...baseInput, live: true }), 'wait')
})

test('deafSessionAction: no pending inbound, nothing to do', () => {
  assert.equal(deafSessionAction({ ...baseInput, pending: null }), 'wait')
  assert.equal(deafSessionAction({ ...afterProbe, pending: null }), 'wait')
})

test('deafSessionAction: waits for the nudge to have fired first', () => {
  assert.equal(
    deafSessionAction({
      ...baseInput,
      pending: { ts: 10_000, reminded: false },
    }),
    'wait',
  )
})

test('deafSessionAction: escalates at most once per boot', () => {
  assert.equal(
    deafSessionAction({ ...afterProbe, alreadyEscalated: true }),
    'wait',
  )
})

test('deafSessionAction: not before two full windows have passed', () => {
  assert.equal(
    deafSessionAction({ ...baseInput, now: baseInput.now - 1 }),
    'wait',
  )
})

test('deafSessionAction: the grace is a real wait, not zero', () => {
  // A grace of 0 would collapse probe and escalate into the same tick and
  // hand the session no chance to answer, which is the old bug wearing a
  // new shape.
  assert.ok(DEAF_PROBE_GRACE_WINDOWS >= 1, 'probe grace must be at least one window')
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

test('deafSessionChatMessage states the observation, not an unproven cause', () => {
  // It used to say "It was launched without the channel flag" as a fact. That
  // was a diagnosis inferred from silence, and on 2026-08-26 it was flatly
  // wrong about an agent whose argv carried the flag. Say what we saw.
  const msg = deafSessionChatMessage('claude server:bgos')
  assert.ok(
    !/was launched without the channel flag/i.test(msg),
    'must not assert a cause we have not established',
  )
  assert.ok(
    /has not answered a direct check/i.test(msg),
    'must report the observation that actually happened',
  )
})

test('deafSessionChatMessage leads with the diagnostic, not the restart', () => {
  // Quitting a Claude Code session throws away whatever it was mid-task on,
  // so the harmless check has to come first in reading order.
  const msg = deafSessionChatMessage('claude server:bgos')
  assert.ok(
    msg.indexOf('hoai doctor') < msg.indexOf('quit the session'),
    'hoai doctor must appear before the instruction to quit',
  )
})

// ── inboundOwesReply ─────────────────────────────────────────────────────────
//
// 2026-08-26: two reply-overdue nudges landed on this agent's own hourly
// board-check wakes, each about four minutes after the wake, on a wake whose
// body says "Tell KC in 1048 only if blocked". The daemon asked for silence
// and then chased it. Same shape as the deaf-session false positive above.

test('a system wake card owes no reply', () => {
  assert.equal(inboundOwesReply('system'), false)
})

test('a real message from a person or a peer still owes a reply', () => {
  for (const kind of ['user', 'assistant', 'agent', 'unknown']) {
    assert.equal(inboundOwesReply(kind), true, `${kind} must still arm the tracker`)
  }
})

test('an ABSENT sender still owes a reply, so the guard can never silence a real message', () => {
  // Fail OPEN. A missing senderKind means we do not know, and the cost of a
  // spurious nudge is one message while the cost of suppressing a real one is
  // a user waiting forever.
  assert.equal(inboundOwesReply(undefined), true)
  assert.equal(inboundOwesReply(null), true)
  assert.equal(inboundOwesReply(''), true)
})

test('the system check is not defeated by case or padding', () => {
  for (const kind of ['System', 'SYSTEM', ' system ']) {
    assert.equal(inboundOwesReply(kind), false, `${JSON.stringify(kind)} is still a system card`)
  }
})

test('recordInbound consults the guard, and every call site passes a sender', () => {
  // The predicate is worthless if the wiring drops the argument, and there are
  // three independent inbound paths (poll, stream forward, websocket).
  const fn = /function recordInbound\([\s\S]*?\n\}/.exec(serverSource)
  assert.ok(fn, 'recordInbound must still exist')
  assert.match(fn[0], /if \(!inboundOwesReply\(senderKind\)\) return/)

  const calls = serverSource.match(/recordInbound\(\s*chatId,[\s\S]*?\)/g) ?? []
  assert.equal(calls.length, 3, `expected 3 recordInbound call sites, found ${calls.length}`)
  for (const call of calls) {
    // turnState is the 3rd arg, sender the 4th: four comma-separated args.
    assert.equal(
      call.split(',').length >= 4,
      true,
      `call site must pass a sender kind, got: ${call.replace(/\s+/g, ' ')}`,
    )
  }
})

// ── deafFixCommand ───────────────────────────────────────────────────────────
// The fix line in the deaf-session notice used to come from install-method
// detection alone. The launcher resolves the channel WORKSPACE-FIRST (a
// .mcp.json server named bgos wins), so on a host with a clone pinned by
// .mcp.json and a marketplace install also registered, the notice told the
// user to relaunch on the marketplace route, the deaf one. Seen live twice on
// 2026-09-02 (agent 1040's notice named plugin:hoai@hoai for a server:bgos
// workspace). The command must follow the route the runner would take.

test('deafFixCommand: a workspace route wins over the install-method command', () => {
  const cmd = deafFixCommand({
    resolution: { spec: 'server:bgos', source: 'workspace', conflict: false },
    installCommand: 'claude --dangerously-skip-permissions --dangerously-load-development-channels plugin:hoai@hoai',
    commandForSpec: (spec) => `claude --dangerously-skip-permissions --dangerously-load-development-channels ${spec}`,
  })
  assert.match(cmd, /server:bgos$/)
  assert.doesNotMatch(cmd, /plugin:hoai@hoai/)
})

test('deafFixCommand: without a workspace server the install-method command stands', () => {
  const cmd = deafFixCommand({
    resolution: { spec: 'plugin:hoai@hoai', source: 'install-method', conflict: false },
    installCommand: 'claude --dangerously-skip-permissions --dangerously-load-development-channels plugin:hoai@hoai',
    commandForSpec: (spec) => `claude ${spec}`,
  })
  assert.match(cmd, /plugin:hoai@hoai$/)
})

test('deafFixCommand: a conflicting .mcp.json never yields a guessed workspace spec', () => {
  const cmd = deafFixCommand({
    resolution: { spec: 'server:bgos', source: 'install-method', conflict: true },
    installCommand: 'claude x plugin:hoai@hoai',
    commandForSpec: (spec) => `claude ${spec}`,
  })
  assert.strictEqual(cmd, 'claude x plugin:hoai@hoai')
})

test('deafFixCommand: nothing resolvable falls back to hoai, which refuses out loud', () => {
  const cmd = deafFixCommand({ resolution: null, installCommand: '', commandForSpec: (spec) => `claude ${spec}` })
  assert.strictEqual(cmd, 'hoai')
})
