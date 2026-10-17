/**
 * PERSON LANES, the stamp check in EVERY daemon (shared agents Phase 3, P3;
 * design rule 5, 5.2 "The second lock").
 *
 * The backend stamps every delivery with the lane it is for once lanes are
 * on (`lane: 'owner' | 'person:<userId>'`). The receiving daemon refuses any
 * delivery not stamped for its own lane, so a routing bug needs two
 * independent failures before a turn runs in the wrong lane:
 *
 *   - the OWNER's daemon delivers an unstamped delivery (today's path, the
 *     switch off) and one stamped `owner`; it refuses a person's stamp and
 *     anything unreadable, on the socket, the poll and the stream, BEFORE
 *     the delivery claims its id or reaches the model;
 *   - a PERSON's lane daemon delivers only its own exact stamp, for its own
 *     agent; no stamp, the owner's stamp, another person's, a prefix or a
 *     case variant are all refused, and a refused delivery is never
 *     acknowledged (lane-server.ts acks only after the gate).
 *
 * Run with: npx tsx --test test/lane-stamp.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { ownerAnnounceRefused, ownerLaneVerdict, personLaneStamp, personLaneVerdict, readLaneStamp } from '../lib/lane-core.mjs'
import { laneDeliveryGate } from '../lib/lane-daemon.ts'

const ROOT = join(import.meta.dirname, '..')
const ANA = { userId: 'user_ana', assistantId: '1076' }

test('the owner\'s daemon: no stamp and the owner\'s stamp deliver, as today', () => {
  assert.deepEqual(ownerLaneVerdict({ chatId: 501, messageId: 1, text: 'hi' }), { deliver: true })
  assert.deepEqual(ownerLaneVerdict({ chatId: 501, messageId: 1, lane: null }), { deliver: true })
  assert.deepEqual(ownerLaneVerdict({ chatId: 501, messageId: 1, lane: 'owner' }), { deliver: true })
})

test('the owner\'s daemon refuses a person\'s stamp and anything it cannot read', () => {
  assert.deepEqual(ownerLaneVerdict({ messageId: 1, lane: 'person:user_ana' }), { deliver: false, stamp: 'person:user_ana' })
  for (const lane of ['OWNER', 'owner ', 'person:', 'lane:1:2:3', '', 7, true, { kind: 'owner' }]) {
    const v = ownerLaneVerdict({ messageId: 1, lane })
    assert.equal(v.deliver, false, `stamp ${JSON.stringify(lane)} must be refused`)
  }
  assert.equal(readLaneStamp({ lane: 7 }), 'unreadable:number')
})

test('a person\'s lane delivers only its own exact stamp, for its own agent', () => {
  assert.deepEqual(personLaneVerdict({ messageId: 1, lane: 'person:user_ana', assistantId: 1076 }, ANA), { deliver: true })
  assert.deepEqual(personLaneVerdict({ messageId: 1, lane: 'person:user_ana' }, ANA), { deliver: true })
  const refused: Array<[unknown, string]> = [
    [{ messageId: 1 }, 'stamp'],
    [{ messageId: 1, lane: 'owner' }, 'stamp'],
    [{ messageId: 1, lane: 'person:user_ben' }, 'stamp'],
    [{ messageId: 1, lane: 'person:user_an' }, 'stamp'],
    [{ messageId: 1, lane: 'person:user_ana2' }, 'stamp'],
    [{ messageId: 1, lane: 'person:USER_ANA' }, 'stamp'],
    [{ messageId: 1, lane: ' person:user_ana' }, 'stamp'],
    [{ messageId: 1, lane: 'person:user_ana', assistantId: 1077 }, 'assistant'],
    [{ messageId: 1, lane: 'person:user_ana', assistant_id: '9' }, 'assistant'],
  ]
  for (const [delivery, reason] of refused) {
    const v = personLaneVerdict(delivery, ANA)
    assert.equal(v.deliver, false, JSON.stringify(delivery))
    if (!v.deliver) assert.equal(v.reason, reason)
  }
  assert.equal(personLaneVerdict({ lane: personLaneStamp('x') }, { userId: '../x', assistantId: '1' }).deliver, false)
})

test('the lane daemon\'s gate reads the socket frame and the poll row alike', () => {
  const socketFrame = { assistantId: 1076, chatId: 777, messageId: 42, text: 'hello', lane: 'person:user_ana' }
  const pollRow = { id: 43, message_id: 43, chat_id: 777, text: 'again', chat_kind: 'main', lane: 'person:user_ana', created_at: '2026-10-17T10:00:00Z' }
  const a = laneDeliveryGate(socketFrame, ANA)
  const b = laneDeliveryGate(pollRow, ANA)
  assert.ok(a.deliver && a.delivery.messageId === 42 && a.delivery.chatId === '777')
  assert.ok(b.deliver && b.delivery.messageId === 43 && b.delivery.chatKind === 'main')
  const wrong = laneDeliveryGate({ ...pollRow, lane: 'person:user_ben' }, ANA)
  assert.ok(!wrong.deliver && wrong.reason.startsWith('lane_misroute'))
  assert.equal(laneDeliveryGate({ lane: 'person:user_ana', chatId: 'x', messageId: 1 }, ANA).deliver, false)
})

// ── The wiring: the check runs in every path, before the delivery ───────────

const SERVER = readFileSync(join(ROOT, 'server.ts'), 'utf8').replace(/\r\n/g, '\n')
const LANE_SERVER = readFileSync(join(ROOT, 'lane-server.ts'), 'utf8').replace(/\r\n/g, '\n')

function bodyAfter(source: string, marker: string, length = 1200): string {
  const at = source.indexOf(marker)
  assert.ok(at >= 0, `marker not found: ${marker}`)
  return source.slice(at, at + length)
}

test('owner socket: the check runs before the stream router and the legacy delivery', () => {
  const body = bodyAfter(SERVER, "realtimeSocket.on('inbound_message', whenArmed('inbound_message'")
  const check = body.indexOf('ownerLaneVerdict(payload)')
  assert.ok(check > 0, 'the socket inbound handler asks ownerLaneVerdict')
  assert.ok(check < body.indexOf('routeStampedInbound(payload'), 'before the stamped stream router')
  assert.ok(check < body.indexOf('deliverWsInbound(payload)'), 'before the legacy delivery')
  assert.match(body.slice(check, body.indexOf('routeStampedInbound(payload')), /if \(!laneVerdict\.deliver\) \{[\s\S]*?return\n/)
})

test('owner poll: the check runs before the message claims its id or reaches the model', () => {
  const body = bodyAfter(SERVER, 'for (const msg of newUserMessages) {', 2500)
  const check = body.indexOf('ownerLaneVerdict(msg.message)')
  assert.ok(check > 0)
  assert.ok(check < body.indexOf('lastInboundAtMs = Date.now()'))
  assert.ok(check < body.indexOf('shouldSkipAlreadyForwarded'))
  assert.match(body.slice(check, check + 300), /continue/)
})

test('owner stream: the check runs before the id is claimed', () => {
  const body = bodyAfter(SERVER, 'async function forwardStreamInbound(', 900)
  const check = body.indexOf('ownerLaneVerdict(view.raw)')
  assert.ok(check > 0)
  assert.ok(check < body.indexOf('rememberForwarded(view.messageId)'))
})

test('button taps: once lanes run, a tap in a share recipient\'s chat never reaches the owner\'s session', () => {
  assert.equal(ownerAnnounceRefused({ lanesOn: true, chatIsOthers: true }), true)
  assert.equal(ownerAnnounceRefused({ lanesOn: false, chatIsOthers: true }), false, 'lanes off: today\'s path')
  assert.equal(ownerAnnounceRefused({ lanesOn: true, chatIsOthers: false }), false, 'the owner\'s or an unknown chat: today\'s path')
  const poll = bodyAfter(SERVER, 'const announced = new Set(announce)', 900)
  assert.match(poll, /\n\s*if \(announced\.size > 0 && ownerAnnounceRefused\(\{ lanesOn: lanesOnForThisAgent, chatIsOthers: chatOwnership\.isOthers\(chatId\) \}\)\) \{\n[^\n]*\n\s*announced\.clear\(\)\n/, 'the condition itself guards the clear')
  assert.ok(poll.indexOf('announced.clear()') < poll.indexOf('rememberAnnouncedClick'), 'before the tap is claimed or announced')
  const stream = bodyAfter(SERVER, 'function applyStreamButtonsAnswered(', 2400)
  const gate = stream.indexOf('ownerLaneVerdict(view.raw)')
  assert.ok(gate > 0 && gate < stream.indexOf('decideButtonsAnswered('), 'the stream tap is gated before it is decided')
  assert.match(stream, /\n\s*if \(!tapLaneVerdict\.deliver \|\| ownerAnnounceRefused\(\{ lanesOn: lanesOnForThisAgent, chatIsOthers: chatOwnership\.isOthers\(chatId\) \}\)\) \{\n[^\n]*\n\s*return\n/)
})

test('lane daemon: the gate runs first, and a refused delivery is never acknowledged or delivered', () => {
  const body = bodyAfter(LANE_SERVER, 'async function deliverRaw(', 1800)
  const gate = body.indexOf('laneDeliveryGate(raw, LANE)')
  const refusedReturn = body.indexOf('return', gate)
  assert.ok(gate > 0)
  assert.ok(refusedReturn < body.indexOf('mcp.notification('), 'refused before the channel event')
  assert.ok(refusedReturn < body.indexOf('/ack'), 'refused before any acknowledgement')
  // Both the socket and the poll go through deliverRaw.
  assert.match(LANE_SERVER, /socket\.on\('inbound_message', \(payload: unknown\) => \{\n\s*void deliverRaw\(payload, 'lane-socket'\)/)
  assert.match(LANE_SERVER, /await deliverRaw\(r\.raw, 'lane-poll'/)
})
