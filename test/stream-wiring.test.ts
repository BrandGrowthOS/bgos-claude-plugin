/**
 * Wiring pins for the Agent Update Stream in server.ts (flag-gated behind
 * BGOS_UPDATE_STREAM === 'true', STRICT default OFF).
 *
 * server.ts cannot be imported in tests (it exits without credentials at
 * module load), so, per this repo's convention (see first-poll-gate.test.ts
 * and poll-core.test.ts), the load-bearing call sites are pinned textually
 * and the one scheduler predicate that lives inline is mirrored in
 * lockstep. The pure machinery itself is tested directly in
 * update-stream.test.ts, stream-client.test.ts, stream-cursor-store.test.ts
 * and stream-apply.test.ts.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const serverSource = readFileSync(new URL('../server.ts', import.meta.url), 'utf8')

function handlerBody(event: string): string {
  const start = serverSource.indexOf(`realtimeSocket.on('${event}'`)
  assert.notEqual(start, -1, `missing handler registration for ${event}`)
  const next = serverSource.indexOf('realtimeSocket.on(', start + 1)
  return serverSource.slice(start, next === -1 ? serverSource.length : next)
}

// ── The flag: strict default OFF ─────────────────────────────────────────────

test('the stream is gated on the exact flag string, default off', () => {
  assert.ok(
    serverSource.includes(
      "const UPDATE_STREAM_ENABLED = process.env.BGOS_UPDATE_STREAM === 'true'",
    ),
    'anything but the exact string true must leave the daemon on legacy paths',
  )
})

test('the stamped router short-circuits before anything else when the flag is off', () => {
  const body = serverSource.slice(
    serverSource.indexOf('function routeStampedInbound('),
  )
  const firstStatement = body.indexOf('if (!UPDATE_STREAM_ENABLED) return false')
  assert.ok(firstStatement !== -1)
  assert.ok(
    firstStatement < body.indexOf('onStampedEvent'),
    'the flag guard must precede any consumer involvement',
  )
})

// ── WS handlers: registered beside the neighbors, guarded like them ─────────

test('stream_authority and update_state handlers carry the drain guard', () => {
  for (const event of ['stream_authority', 'update_state']) {
    const body = handlerBody(event)
    assert.ok(
      body.includes('if (updateDrainMode) return'),
      `${event} must be drain-guarded like every neighbor`,
    )
  }
})

test('a beacon feeds consumer.onBeacon through the operation tracker', () => {
  const body = handlerBody('update_state')
  assert.ok(body.includes('streamLastBeaconAtMs = Date.now()'))
  assert.ok(body.includes('beaconSeenOnConnection = true'))
  assert.match(body, /trackMessageOperation\(\(\) =>\s*consumer\.onBeacon\(/)
})

test('stream authority is applied per assistant and keeps per-connection state', () => {
  const body = handlerBody('stream_authority')
  assert.ok(body.includes('String(payload.assistantId) !== String(ASSISTANT_ID)'))
  assert.ok(body.includes('beaconSeenOnConnection: streamAuthority?.beaconSeenOnConnection ?? false'))
})

// ── Stamped inbound routing ─────────────────────────────────────────────────

test('inbound_message routes stamped events through the consumer, legacy body otherwise', () => {
  const body = handlerBody('inbound_message')
  const routed = body.indexOf('if (routeStampedInbound(payload, deliverWsInbound)) return')
  const legacy = body.indexOf('deliverWsInbound(payload)', routed + 1)
  assert.ok(routed !== -1, 'the stamped router must be consulted')
  assert.ok(legacy !== -1, 'the unstamped path must run the exact legacy delivery')
})

test('the apply callback IS the legacy delivery function', () => {
  assert.match(
    serverSource,
    /consumer\.onStampedEvent\(\s*\{ seq, streamEpoch \},\s*async \(\) => deliver\(payload\),/,
  )
})

test('no inbound_click WS listener was added (single-announce stays with the poll)', () => {
  assert.ok(!/realtimeSocket\.on\(\s*['"]inbound_click['"]/.test(serverSource))
})

// ── Reconnect: one chain instead of 600 requests, legacy fallback intact ─────

test('the connect handler runs ONE jittered catch-up chain in stream mode', () => {
  const body = handlerBody('connect')
  assert.ok(body.includes("runCatchup('reconnect'"))
  assert.ok(body.includes('Math.floor(Math.random() * 5000)'), '0-5s jitter dep')
  assert.ok(
    body.includes('pollAllChats()'),
    'the legacy reconnect sweep must remain the fallback',
  )
  assert.ok(
    body.includes('beaconSeenOnConnection = false'),
    'authority resets per connection (spec 8)',
  )
})

// ── Scheduler: deadlines, WS-down poll, healthy-sweep demotion ──────────────

test('the 2s tick drives consumer deadlines and the beacon watchdog', () => {
  assert.ok(serverSource.includes('streamSchedulerTick(Date.now())'))
  assert.ok(serverSource.includes('consumer.checkDeadlines(nowMs)'))
  assert.ok(serverSource.includes('beaconWatchdog(streamLastBeaconAtMs'))
})

test('WS down prefers one getDifference poll, with the sweep as fallback', () => {
  assert.ok(serverSource.includes("runCatchup('ws_down_poll'"))
  assert.ok(serverSource.includes('!isWsHealthy() && streamWsDownPollPreferred()'))
})

test('stream mode stretches the healthy sweep to a daily reconciliation', () => {
  assert.ok(serverSource.includes('const STREAM_RECONCILE_INTERVAL_MS = 24 * 3600_000'))
  assert.ok(
    serverSource.includes(
      'Date.now() - lastFullCycleAt < STREAM_RECONCILE_INTERVAL_MS',
    ),
  )
})

// Mirror of the demotion predicate in the tick (keep in lockstep): a full
// sweep is demoted ONLY when the WS is healthy, stream mode is fully active
// (authority + beacon on this connection), a full cycle has happened since
// boot, and the daily reconciliation is not yet due.
function sweepDemotedMirror(opts: {
  planFull: boolean
  wsHealthy: boolean
  streamModeActive: boolean
  lastFullCycleAt: number
  now: number
  reconcileIntervalMs: number
}): boolean {
  return (
    opts.planFull &&
    opts.wsHealthy &&
    opts.streamModeActive &&
    opts.lastFullCycleAt !== 0 &&
    opts.now - opts.lastFullCycleAt < opts.reconcileIntervalMs
  )
}

test('demotion mirror: losing stream mode resumes the legacy cadence at once', () => {
  const base = {
    planFull: true,
    wsHealthy: true,
    streamModeActive: true,
    lastFullCycleAt: 1_000,
    now: 2_000,
    reconcileIntervalMs: 24 * 3600_000,
  }
  assert.equal(sweepDemotedMirror(base), true)
  assert.equal(sweepDemotedMirror({ ...base, streamModeActive: false }), false)
  assert.equal(sweepDemotedMirror({ ...base, wsHealthy: false }), false)
  assert.equal(
    sweepDemotedMirror({ ...base, lastFullCycleAt: 0 }),
    false,
    'the boot full sweep must never be demoted',
  )
  assert.equal(
    sweepDemotedMirror({ ...base, now: 1_000 + 24 * 3600_000 }),
    false,
    'the daily reconciliation still runs',
  )
})

// ── The 5.7 contract wiring ─────────────────────────────────────────────────

test('the stream cursor is flushed synchronously, never on the 5s coalescer', () => {
  assert.ok(
    serverSource.includes(
      'saveStreamCursorFile(streamCursorFilePath, cursor, streamTokenFingerprint)',
    ),
  )
})

test('stream applies feed the per-chat cursor through the parking-aware advance', () => {
  const body = serverSource.slice(
    serverSource.indexOf('function advanceStreamChatCursor('),
  )
  assert.ok(body.includes('pendingEmptyIds: heldIds'), 'held wakes park the cursor')
  assert.ok(
    body.indexOf('advanceChatCursor(') !== -1,
    'every write still goes through the single cursor write path',
  )
  assert.ok(serverSource.includes('streamCoveredChats.add(chatId)'))
})

test('the wsCursorSafe interlock accepts stream-covered chats', () => {
  assert.ok(serverSource.includes('streamCoveredChats.has(chatId)'))
})

test('empty wakes are held and their finalize delivers as the wake', () => {
  assert.ok(
    serverSource.includes('streamHeldEmptyChatByMessageId.set(view.messageId, chatId)'),
  )
  assert.ok(
    serverSource.includes('if (held) streamHeldEmptyChatByMessageId.delete(view.messageId)'),
  )
})

test('a stream-announced click marks the shared set and consumes the baseline BEFORE acting', () => {
  const body = serverSource.slice(
    serverSource.indexOf('function applyStreamButtonsAnswered('),
    serverSource.indexOf('async function applyStreamMessage('),
  )
  const gate = body.indexOf('announcedClickIds.has(view.messageId)')
  const mark = body.indexOf('rememberAnnouncedClick(view.messageId)')
  const consume = body.indexOf('chatUnansweredButtons.get(chatId)?.delete(view.messageId)')
  const permission = body.indexOf('pending.resolve(')
  const forward = body.indexOf('buildStreamClickMeta(')
  assert.ok(gate !== -1, 'the decision gates on the announced-ids set')
  assert.ok(mark !== -1 && consume !== -1)
  assert.ok(permission > mark, 'mark precedes the permission resolution')
  assert.ok(forward > mark, 'mark precedes the click forward')
  assert.ok(permission > consume && forward > consume, 'consume precedes acting')
})

test('the poll announce path feeds the shared announced-ids set', () => {
  assert.ok(
    serverSource.includes('for (const id of announced) rememberAnnouncedClick(id)'),
    'poll-announced ids must block a later stream replay of the same tap',
  )
})

test('the announced-ids set is bounded like forwardedMessageIds', () => {
  const body = serverSource.slice(
    serverSource.indexOf('function rememberAnnouncedClick('),
  )
  assert.ok(body.indexOf('announcedClickIds.size > FORWARD_CACHE_MAX') !== -1)
})

test('a rejecting stream handoff un-claims the forwarded id before rethrowing', () => {
  const body = serverSource.slice(
    serverSource.indexOf('async function forwardStreamInbound('),
    serverSource.indexOf('function applyStreamButtonsAnswered('),
  )
  const claim = body.indexOf('rememberForwarded(view.messageId)')
  const unclaim = body.indexOf('forwardedMessageIds.delete(view.messageId)')
  assert.ok(claim !== -1 && unclaim !== -1, 'claim and un-claim must both exist')
  assert.ok(unclaim > claim)
  assert.match(
    body.slice(unclaim),
    /^\s*forwardedMessageIds\.delete\(view\.messageId\)\s*\n\s*throw err/m,
    'the un-claim must rethrow so the chain pins the cursor for redelivery',
  )
})

test('reconcile kinds coalesce to one deferred discoverChats per chain', () => {
  assert.ok(serverSource.includes('streamReconcileNeeded = true'))
  assert.ok(
    serverSource.includes('!consumer.inDifference'),
    'the deferred reconcile waits for the chain to go idle',
  )
})

test('the held-empty wake map is bounded', () => {
  assert.ok(serverSource.includes('STREAM_HELD_EMPTY_MAX'))
  assert.ok(
    serverSource.includes('streamHeldEmptyChatByMessageId.size > STREAM_HELD_EMPTY_MAX'),
  )
})

// ── Boot ordering ───────────────────────────────────────────────────────────

test('the stream boots after the boot sweep and before the WS connects', () => {
  // 2026-08-25: same invariant, new call shape. Both steps are now narrated
  // through startupPhase (a hang between the transport and the poll used to
  // be indistinguishable from a crash), so the ordering is read from the
  // phase calls, and from main() rather than the whole file: streamFullResync
  // also calls pollAllChats and used to be what the first index found.
  const mainSource = serverSource.slice(
    serverSource.indexOf('async function main()'),
  )
  const bootSweep = mainSource.indexOf("phase('boot poll sweep'")
  const streamInit = mainSource.indexOf("phase('update stream init'")
  // The CALL in main (the definition line also contains the bare string).
  const wsConnect = mainSource.indexOf('\n    connectWebsocket()')
  assert.ok(bootSweep !== -1 && streamInit !== -1 && wsConnect !== -1)
  assert.ok(streamInit > bootSweep, 'cursor adoption needs a current state')
  assert.ok(streamInit < wsConnect, 'the consumer must exist before handlers can feed it')
})

test('a failed or absent mint leaves every legacy path running', () => {
  const body = serverSource.slice(
    serverSource.indexOf('async function initUpdateStream('),
  )
  assert.ok(body.includes('mintSession()'))
  assert.ok(body.includes('stream inactive, legacy paths run'))
})
