import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// The repo idiom for a source scan: an import.meta.url URL resolves identically
// under bun and under the tsx runner the canonical `npm test` orchestrator uses,
// where import.meta.dir does not exist.
const server = readFileSync(new URL('../server.ts', import.meta.url), 'utf8')

test('losing the pairing lock stands the daemon down, it does not merely warn', () => {
  // The detailed form must be what the poll tick calls: the boolean form
  // cannot name the rival holder.
  assert.match(server, /refreshPairingLockDetailed\(/)
  // There must be a real consequence, not only a log line.
  assert.match(server, /channelArmed\s*=\s*false/)
  // And the daemon must be able to come back if the rival dies.
  assert.match(server, /lockRecheck|resumeLockRecheck/)
})

test('the poll tick refuses to forward while not armed', () => {
  assert.match(server, /if\s*\(\s*!channelArmed\s*\)/)
})

// A stood-down daemon must behave like a daemon that was passive from boot. A
// passive daemon never joins the pairing room, so it never receives ANY of
// these frames; one that keeps its socket open must therefore refuse to act on
// them. Round one of this bug was every voice_rpc frame handled two to four
// times, N duplicate consult cards, and "late/unknown voice_rpc result"
// warnings, which is what gating only the poll tick would leave in place.
const PAIRING_FRAMES = [
  'voice_rpc',
  'export_pack',
  'export_pack_manifest',
  'voice_task_dispatch',
  'update_rpc',
  'watcher_install_rpc',
  'inbound_message',
  'peer_conversation_closed',
  'peer_turn_yielded',
  'meeting_invitation',
  'meeting_message',
  'meeting_turn_changed',
  'meeting_state_resync',
  'meeting_closed',
  'meeting_participant_left',
  'meeting_participant_added',
  'meeting_policy_changed',
  'stream_authority',
  'update_state',
]

// Transport bookkeeping, not work done on the pairing's behalf: a passive
// daemon still needs its own connection state to be correct, so these stay
// unwrapped on purpose.
const TRANSPORT_FRAMES = ['connect', 'disconnect', 'connect_error']

test('the stand-down gate wraps every socket handler that acts for the pairing', () => {
  assert.match(server, /const whenArmed\s*=/)
  for (const frame of PAIRING_FRAMES) {
    assert.match(
      server,
      new RegExp(`realtimeSocket\\.on\\('${frame}', whenArmed\\('${frame}',`),
      `${frame} must be registered through whenArmed, or a stood-down daemon still acts on it`,
    )
  }
})

test('the wrapped set is exactly the handlers minus the transport ones', () => {
  // Counting, not just spot-checking, so a NEW handler added later cannot slip
  // in unwrapped and unnoticed: this fails the moment the two lists disagree.
  // The character class must stay WIDER than the frame names in use today. It
  // was [a-z_]+, and a future realtimeSocket.on('meeting_v2', ...) would have
  // matched neither pattern (the closing quote has to follow the class
  // directly), so it would never enter `registered`, both assertions below
  // would still pass, and the handler would ship ungated with the suite green.
  const registered = [...server.matchAll(/realtimeSocket\.on\('([A-Za-z0-9_]+)'/g)].map((m) => m[1])
  const wrapped = [...server.matchAll(/whenArmed\('([A-Za-z0-9_]+)'/g)].map((m) => m[1])
  assert.deepEqual(
    [...new Set(registered)].sort(),
    [...PAIRING_FRAMES, ...TRANSPORT_FRAMES].sort(),
    'server.ts registers a socket handler this test does not classify; wrap it or list it as transport',
  )
  assert.deepEqual([...new Set(wrapped)].sort(), [...PAIRING_FRAMES].sort())
  for (const frame of TRANSPORT_FRAMES) {
    assert.ok(!wrapped.includes(frame), `${frame} must not be gated on channelArmed`)
  }
})

test('the poll tick reschedules itself from a finally, so standing down cannot kill the loop', () => {
  // The stand-down guard returns from INSIDE the tick's try block, and a return
  // skips everything after a try/catch. If the reschedule sits after the block
  // rather than in a finally, the tick that stands the daemon down is the last
  // tick the process ever runs: no lock heartbeat (so a reclaim later goes
  // stale and is taken by a rival with nothing left to notice), no beacon
  // heartbeat, no stream gap deadlines, no WS-down catch-up. The daemon looks
  // healthy for hours. Nothing else in this file can see that, because the
  // guard's PLACEMENT is right and only its control flow is wrong.
  // Whitespace and comment lines only between the finally and the reschedule,
  // so this cannot be satisfied by some unrelated finally elsewhere in the file
  // that merely happens to precede the scheduler.
  assert.match(server, /finally\s*\{(?:\s|\/\/[^\n]*\n)*setTimeout\(tick,/)
  // And the reschedule must not ALSO sit bare after the catch, which would
  // double the scheduler on every tick.
  assert.doesNotMatch(server, /\}\s*catch\s*\(err\)\s*\{[^}]*\}\s*setTimeout\(tick,/)
})

test('standing down does not disconnect the socket, so re-arming stays cheap', () => {
  // The stand-down block itself must not tear the transport down: the re-arm
  // path relies on the connection still being there, and connectWebsocket is
  // one-shot per process.
  // Anchored on the refresh branch, not on the first 'channelArmed = false' in
  // the file: that one is the module-scope declaration, and slicing from there
  // swallows the whole of connectWebsocket.
  const start = server.indexOf('if (!refreshed.held)')
  const end = server.indexOf('resumeLockRecheck()', start)
  assert.ok(start !== -1 && end > start, 'the stand-down branch must be findable')
  const standDown = server.slice(start, end)
  assert.doesNotMatch(standDown, /realtimeSocket\?\.(disconnect|close)\(/)
  assert.doesNotMatch(standDown, /process\.exit\(/)
})
