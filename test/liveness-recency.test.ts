/**
 * Liveness recency (0.39.3): a session that was live and then stopped.
 *
 * THE CASE. 2026-09-12, the Data agent (assistant 900). Its session made its
 * last bgos tool call at 07:49Z (a reply), then a queued /exit wedged it. The
 * daemon stayed connected and heartbeating for the next 12h47m: 13 hourly
 * wakes and 2 owner messages queued unanswered, ONE reply-overdue line at
 * 19:54:36Z, and zero probe or escalate lines (161 log lines in the window,
 * verified by hand against ~/.bgos-agent/logs/bgos-plugin-900.log). The
 * daemon never asked the session anything and never told the owner, because
 * deafSessionAction returned 'wait' whenever `live` was true, and server.ts
 * passed `channelLiveness.live`, which is "any bgos tool call since boot": a
 * one-way latch that had flipped at 07:49 and could never flip back.
 *
 * THE FIX. The deaf-session decision now reads recency: a tool call within
 * LIVE_RECENCY_WINDOWS reply-overdue windows. `.live` keeps its ever-live
 * meaning for the gates that want it (cursor persistence, the on-disk
 * marker), which is why this file tests the COMPOSITION server.ts uses rather
 * than deafSessionAction alone: the bug was in what was passed, not in the
 * decision.
 *
 * Run with:  bun test test/liveness-recency.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  ChannelLiveness,
  LIVE_RECENCY_WINDOWS,
  DEAF_PROBE_GRACE_WINDOWS,
  SESSION_UNRESPONSIVE_CODE,
  deafSessionAction,
  heartbeatUnresponsiveError,
  lastToolCallPhrase,
  unansweredProbe,
} from '../lib/channel-liveness.ts'

const serverSource = readFileSync(new URL('../server.ts', import.meta.url), 'utf8')

/** REPLY_OVERDUE_MS in server.ts: 4 minutes. */
const WINDOW_MS = 240_000
const HOUR = 3_600_000
/** 2026-09-12T07:49:23Z, the last reply 900's session ever sent that boot. */
const LAST_CALL = Date.parse('2026-09-12T07:49:23.859Z')

/** Exactly what checkReplyOverdue passes: recency, never the ever-live latch. */
function actionAt(
  liveness: ChannelLiveness,
  now: number,
  pending: { ts: number; reminded: boolean } | null,
  probeSentAt: number | null,
  alreadyEscalated = false,
) {
  return deafSessionAction({
    live: liveness.recentlyLive(now, WINDOW_MS),
    pending,
    now,
    alreadyEscalated,
    probeSentAt,
    windowMs: WINDOW_MS,
  })
}

// ── ChannelLiveness.recentlyLive ─────────────────────────────────────────────

test('recentlyLive is false before any tool call, and lastToolCallAt is null', () => {
  const liveness = new ChannelLiveness()
  assert.equal(liveness.lastToolCallAt, null)
  assert.equal(liveness.recentlyLive(LAST_CALL, WINDOW_MS), false)
})

test('recentlyLive flips false exactly at LIVE_RECENCY_WINDOWS * windowMs', () => {
  const liveness = new ChannelLiveness()
  liveness.markToolCall(LAST_CALL)
  const horizon = LIVE_RECENCY_WINDOWS * WINDOW_MS
  assert.equal(liveness.lastToolCallAt, LAST_CALL)
  assert.equal(liveness.recentlyLive(LAST_CALL, WINDOW_MS), true, 'at the call itself')
  assert.equal(liveness.recentlyLive(LAST_CALL + horizon - 1, WINDOW_MS), true, 'one ms inside')
  assert.equal(liveness.recentlyLive(LAST_CALL + horizon, WINDOW_MS), false, 'exactly at the horizon')
  assert.equal(liveness.recentlyLive(LAST_CALL + horizon + 1, WINDOW_MS), false, 'one ms past')
  // A later call re-arms it: recency is a clock, not a latch.
  liveness.markToolCall(LAST_CALL + horizon + 5)
  assert.equal(liveness.recentlyLive(LAST_CALL + horizon + 5, WINDOW_MS), true)
  assert.equal(liveness.lastToolCallAt, LAST_CALL + horizon + 5)
})

test('.live keeps its ever-live meaning: still true long after recency has lapsed', () => {
  // server.ts gates cursor persistence and the on-disk marker on this, and
  // those must not start withholding writes because a session went quiet.
  const liveness = new ChannelLiveness()
  liveness.markToolCall(LAST_CALL)
  const muchLater = LAST_CALL + 100 * LIVE_RECENCY_WINDOWS * WINDOW_MS
  assert.equal(liveness.live, true)
  assert.equal(liveness.recentlyLive(muchLater, WINDOW_MS), false)
})

test('LIVE_RECENCY_WINDOWS covers at least the two windows the ladder already waits', () => {
  // The probe is first possible at now - inbound.ts >= 2 windows. A session
  // that spoke the moment the inbound landed must still count as live at that
  // moment, or the very first eligible tick would probe a working session.
  assert.ok(LIVE_RECENCY_WINDOWS >= 2, `got ${LIVE_RECENCY_WINDOWS}`)
})

// ── deafSessionAction through the daemon's composition ──────────────────────

test('THE REGRESSION (900, 2026-09-12): a session that was live and then stopped is probed', () => {
  const liveness = new ChannelLiveness()
  liveness.markToolCall(LAST_CALL)
  // The owner's message lands about 12 hours later and the nudge has fired.
  const pending = { ts: LAST_CALL + 12 * HOUR, reminded: true }
  const now = pending.ts + 2 * WINDOW_MS
  assert.equal(actionAt(liveness, now, pending, null), 'probe')
})

test('a recent tool call means wait, right up to the recency horizon', () => {
  const liveness = new ChannelLiveness()
  const inboundTs = LAST_CALL + HOUR
  // The session touched a bgos tool half a minute after the message arrived,
  // then went heads-down (a long build, a long read). That is a working
  // session, not a wedged one.
  const workingCall = inboundTs + 30_000
  liveness.markToolCall(workingCall)
  const pending = { ts: inboundTs, reminded: true }
  assert.equal(actionAt(liveness, inboundTs + 2 * WINDOW_MS, pending, null), 'wait')
  const horizon = workingCall + LIVE_RECENCY_WINDOWS * WINDOW_MS
  assert.equal(actionAt(liveness, horizon - 1, pending, null), 'wait')
  // And at the horizon the same session earns a question, not a verdict.
  assert.equal(actionAt(liveness, horizon, pending, null), 'probe')
})

test('an unanswered probe plus the grace escalates, on a session that once spoke', () => {
  const liveness = new ChannelLiveness()
  liveness.markToolCall(LAST_CALL)
  const pending = { ts: LAST_CALL + 12 * HOUR, reminded: true }
  const probeAt = pending.ts + 2 * WINDOW_MS
  assert.equal(actionAt(liveness, probeAt, pending, null), 'probe')
  const grace = DEAF_PROBE_GRACE_WINDOWS * WINDOW_MS
  assert.equal(actionAt(liveness, probeAt + grace - 1, pending, probeAt), 'wait', 'inside the grace')
  assert.equal(actionAt(liveness, probeAt + grace, pending, probeAt), 'escalate')
  // Once per boot, exactly as before.
  assert.equal(actionAt(liveness, probeAt + grace, pending, probeAt, true), 'wait')
})

test('answering the probe is a tool call, so it ends the ladder', () => {
  const liveness = new ChannelLiveness()
  liveness.markToolCall(LAST_CALL)
  const pending = { ts: LAST_CALL + HOUR, reminded: true }
  const probeAt = pending.ts + 2 * WINDOW_MS
  assert.equal(actionAt(liveness, probeAt, pending, null), 'probe')
  liveness.markToolCall(probeAt + 60_000)
  const grace = DEAF_PROBE_GRACE_WINDOWS * WINDOW_MS
  assert.equal(actionAt(liveness, probeAt + grace, pending, probeAt), 'wait')
})

/**
 * One checkReplyOverdue tick, with the per-boot state server.ts keeps: the
 * spent-probe reset, the decision, and the two transitions the daemon makes.
 */
function tick(
  liveness: ChannelLiveness,
  now: number,
  pending: { ts: number; reminded: boolean },
  state: { probeSentAt: number | null; escalated: boolean },
) {
  state.probeSentAt = unansweredProbe(state.probeSentAt, liveness.lastToolCallAt)
  const action = deafSessionAction({
    live: liveness.recentlyLive(now, WINDOW_MS),
    pending,
    now,
    alreadyEscalated: state.escalated,
    probeSentAt: state.probeSentAt,
    windowMs: WINDOW_MS,
  })
  if (action === 'probe') state.probeSentAt = now
  if (action === 'escalate') state.escalated = true
  return action
}

test('unansweredProbe: a probe answered since it was sent is spent, an unanswered one stands', () => {
  const P = LAST_CALL + HOUR
  assert.equal(unansweredProbe(null, LAST_CALL), null, 'no probe, nothing to carry')
  assert.equal(unansweredProbe(P, null), P, 'no call at all: still unanswered')
  assert.equal(unansweredProbe(P, P - 1), P, 'a call BEFORE the probe does not answer it')
  assert.equal(unansweredProbe(P, P), null, 'a call at the probe instant counts')
  assert.equal(unansweredProbe(P, P + 60_000), null, 'the ack')
})

test('an answered probe never becomes the evidence for a later escalation', () => {
  // Probe, ack, then quiet again with the SAME inbound still unanswered. The
  // latch made an ack permanent; a clock has to say it, or the next lapse
  // escalates on a probe that was answered and the chat copy lies.
  const liveness = new ChannelLiveness()
  liveness.markToolCall(LAST_CALL)
  const pending = { ts: LAST_CALL + 12 * HOUR, reminded: true }
  const state = { probeSentAt: null as number | null, escalated: false }
  const grace = DEAF_PROBE_GRACE_WINDOWS * WINDOW_MS
  const firstProbe = pending.ts + 2 * WINDOW_MS
  assert.equal(tick(liveness, firstProbe, pending, state), 'probe')
  const ack = firstProbe + 60_000
  liveness.markToolCall(ack)
  assert.equal(tick(liveness, firstProbe + grace, pending, state), 'wait', 'recent ack: wait')
  // Recency lapses again. This tick must ASK again, not accuse.
  const lapsed = ack + LIVE_RECENCY_WINDOWS * WINDOW_MS
  assert.equal(tick(liveness, lapsed, pending, state), 'probe', 'a spent probe is re-armed, not escalated')
  assert.equal(state.probeSentAt, lapsed)
  // And only THAT probe, unanswered for the full grace, earns the warning.
  assert.equal(tick(liveness, lapsed + grace - 1, pending, state), 'wait')
  assert.equal(tick(liveness, lapsed + grace, pending, state), 'escalate')
  assert.equal(state.escalated, true)
  assert.equal(tick(liveness, lapsed + grace + HOUR, pending, state), 'wait', 'once per boot')
})

test('a session with no tool call since boot walks the same ladder as before', () => {
  // The never-live path is the one the 2026-08-26 record was written for; it
  // must be byte-for-byte the same decision sequence.
  const liveness = new ChannelLiveness()
  const pending = { ts: LAST_CALL, reminded: true }
  assert.equal(actionAt(liveness, LAST_CALL + 2 * WINDOW_MS - 1, pending, null), 'wait')
  const probeAt = LAST_CALL + 2 * WINDOW_MS
  assert.equal(actionAt(liveness, probeAt, pending, null), 'probe')
  const grace = DEAF_PROBE_GRACE_WINDOWS * WINDOW_MS
  assert.equal(actionAt(liveness, probeAt + grace - 1, pending, probeAt), 'wait')
  assert.equal(actionAt(liveness, probeAt + grace, pending, probeAt), 'escalate')
})

// ── The heartbeat's unresponsive report ─────────────────────────────────────

/** Exactly what the heartbeat's lastError closure passes as `live`. */
function heartbeatLive(liveness: ChannelLiveness, now: number, escalatedAt: number | null): boolean {
  return liveness.recentlyLive(now, WINDOW_MS) || liveness.spokeSince(escalatedAt)
}

test('the heartbeat reports the wedge: escalated, and the last tool call is old', () => {
  const liveness = new ChannelLiveness()
  liveness.markToolCall(LAST_CALL)
  const escalatedAt = LAST_CALL + 13 * HOUR
  const now = escalatedAt + 60_000
  const err = heartbeatUnresponsiveError({
    escalated: true,
    live: heartbeatLive(liveness, now, escalatedAt),
    since: escalatedAt,
    now,
  })
  assert.ok(err, 'the ever-live latch used to hide this from the backend')
  assert.equal(err.code, SESSION_UNRESPONSIVE_CODE)
})

test('a tool call after the verdict clears the report and keeps it clear for the boot', () => {
  // The escalation latch is once per boot and never un-latches, so no second
  // verdict can ever be reached in this boot. A report that came back on
  // silence alone after a recovery would be a stale accusation re-asserted
  // with no new probe, and on a 6-hourly heartbeat it would be a coin flip.
  const liveness = new ChannelLiveness()
  liveness.markToolCall(LAST_CALL)
  const escalatedAt = LAST_CALL + 13 * HOUR
  liveness.markToolCall(escalatedAt + 5 * 60_000)
  for (const now of [escalatedAt + 6 * 60_000, escalatedAt + 6 * HOUR, escalatedAt + 48 * HOUR]) {
    assert.equal(
      heartbeatUnresponsiveError({
        escalated: true,
        live: heartbeatLive(liveness, now, escalatedAt),
        since: escalatedAt,
        now,
      }),
      null,
      `must stay clear at +${(now - escalatedAt) / 60_000} minutes`,
    )
  }
})

test('spokeSince: a call BEFORE the verdict is not a recovery, and null is never one', () => {
  const liveness = new ChannelLiveness()
  assert.equal(liveness.spokeSince(LAST_CALL), false, 'no call at all')
  liveness.markToolCall(LAST_CALL)
  assert.equal(liveness.spokeSince(LAST_CALL + 1), false)
  assert.equal(liveness.spokeSince(LAST_CALL), true, 'at the same instant counts')
  assert.equal(liveness.spokeSince(null), false, 'no verdict, nothing to have spoken since')
})

// ── The log line says what was observed ─────────────────────────────────────

test('lastToolCallPhrase states the observation instead of "zero calls since boot"', () => {
  assert.equal(lastToolCallPhrase(null, LAST_CALL), 'no bgos tool call since boot')
  assert.equal(lastToolCallPhrase(LAST_CALL, LAST_CALL), 'last bgos tool call 0 minute(s) ago')
  assert.equal(
    lastToolCallPhrase(LAST_CALL, LAST_CALL + 12 * HOUR + 5_000),
    'last bgos tool call 720 minute(s) ago',
  )
})

// ── server.ts wiring ────────────────────────────────────────────────────────
// The bug was entirely in what server.ts passed, so the wiring is pinned. Each
// pin names the line it guards.

test('server.ts: checkReplyOverdue passes recency to deafSessionAction, never the latch', () => {
  assert.match(
    serverSource,
    /deafSessionAction\(\{\s*live: channelLiveness\.recentlyLive\(now, REPLY_OVERDUE_MS\),/,
    'the deaf decision must read recentlyLive(now, REPLY_OVERDUE_MS)',
  )
  assert.doesNotMatch(
    serverSource,
    /deafSessionAction\(\{\s*live: channelLiveness\.live,/,
    'the 900 wiring: the ever-live latch fed to the deaf decision',
  )
})

test('server.ts: checkReplyOverdue spends an answered probe before the ladder runs', () => {
  const start = serverSource.indexOf('function checkReplyOverdue(): void {')
  const loop = serverSource.indexOf('for (const [chatId, p] of pendingInbounds.entries())', start)
  assert.ok(start !== -1 && loop !== -1)
  const preamble = serverSource.slice(start, loop)
  assert.match(
    preamble,
    /deafProbeSentAt = unansweredProbe\(deafProbeSentAt, channelLiveness\.lastToolCallAt\)/,
    'the reset must run once per tick, before any chat is judged',
  )
})

test('server.ts: the heartbeat reads the same recency, plus a recovery after the verdict', () => {
  assert.match(
    serverSource,
    /heartbeatUnresponsiveError\(\{[\s\S]{0,200}?escalated: deafEscalationDone,[\s\S]{0,300}?live:\s*channelLiveness\.recentlyLive\(now, REPLY_OVERDUE_MS\)\s*\|\|\s*channelLiveness\.spokeSince\(deafEscalatedAt\),/,
  )
})

test('server.ts: EVERY tool call refreshes recency, the first still records the on-disk marker', () => {
  const callTool = serverSource.slice(serverSource.indexOf('mcp.setRequestHandler(CallToolRequestSchema'))
  const head = callTool.slice(0, 1800)
  assert.doesNotMatch(
    head,
    /if \(!channelLiveness\.live\) \{\s*channelLiveness\.markToolCall\(\)/,
    'markToolCall inside the ever-live guard runs once per boot, which is the 900 bug',
  )
  assert.match(
    head,
    /const firstToolCallThisBoot = !channelLiveness\.live[\s\S]*?channelLiveness\.markToolCall\(\)[\s\S]*?if \(firstToolCallThisBoot\) \{\s*recordLiveMarker\(LIVE_MARKER_PATH/,
    'mark unconditionally, record the marker only on the first call',
  )
})

test('server.ts: the ever-live gate on cursor persistence is untouched', () => {
  assert.match(
    serverSource,
    /function flushChatCursors\(\): void \{\s*if \(!channelLiveness\.live\) return/,
  )
})

test('server.ts: the probe and escalate log lines no longer claim zero calls since boot', () => {
  // Scoped to checkReplyOverdue: the flushChatCursors comment still says
  // "zero bgos tool calls since boot" and is right to, that gate IS the latch.
  const start = serverSource.indexOf('function checkReplyOverdue(): void {')
  assert.notEqual(start, -1, 'checkReplyOverdue must still exist')
  const end = serverSource.indexOf('\n}\n', start)
  const body = serverSource.slice(start, end)
  assert.doesNotMatch(body, /zero bgos tool calls since/, 'the log lines asserted the latch reading, false for 900')
  const uses = body.match(/lastToolCallPhrase\(channelLiveness\.lastToolCallAt, now\)/g) ?? []
  assert.equal(uses.length, 2, `probe and escalate lines must both say what was observed, found ${uses.length}`)
})
