/**
 * Which backend refusal is permanent, read narrowly (lib/peer-refusal.ts).
 *
 * The behaviour it buys, run against the daemon's own code and a mocked
 * backend, is in test/peer-403-loop.test.ts. These pin the classifier itself:
 * only a 403 whose `message` is the participant reason, whole, or whose `code`
 * says so, and only a 400 whose `message` is the a2a route reason, whole, or
 * whose `code` says so. Never a substring, never the path, never a number in
 * a URL, never one reason on the other's status.
 *
 * Run with: npx tsx --test test/peer-refusal.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  A2A_WRONG_ROUTE_CODE,
  pickPermissionChat,
  createRefusedChats as makeRefused,
  A2A_ROUTE_REQUIRED,
  A2A_ROUTE_REQUIRED_MESSAGE,
  PEER_NOT_PARTICIPANT,
  PEER_NOT_PARTICIPANT_MESSAGE,
  a2aRouteRequiredResult,
  classifyPeerRefusal,
  createRefusedChats,
  peerNotParticipantResult,
  peerRefusalOf,
  peerRefusalStatus,
} from '../lib/peer-refusal.ts'

/** HttpExceptionAdvicer's body, key for key. */
function body(message: unknown, path = '/api/v1/messages', extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ statusCode: 403, message, path, timestamp: '2026-10-07T09:00:00.000Z', ...extra })
}

test('the backend reason text is byte for byte what BGOS throws', () => {
  assert.equal(PEER_NOT_PARTICIPANT_MESSAGE, 'Caller assistant is not a participant of this peer conversation.')
})

test('the exact 403 body is the permanent peer refusal', () => {
  assert.equal(classifyPeerRefusal(403, body(PEER_NOT_PARTICIPANT_MESSAGE)), PEER_NOT_PARTICIPANT)
  assert.equal(
    classifyPeerRefusal(403, body(PEER_NOT_PARTICIPANT_MESSAGE, '/api/v1/send-message')),
    PEER_NOT_PARTICIPANT,
  )
})

test('the same words on any other status are not', () => {
  for (const status of [400, 401, 404, 409, 429, 500, 502, 503]) {
    assert.equal(classifyPeerRefusal(status, body(PEER_NOT_PARTICIPANT_MESSAGE)), null, String(status))
  }
})

test('every other 403 keeps its old reading', () => {
  for (const message of [
    'Caller does not own this conversation.',
    'Peer conversation belongs to another user.',
    'Forbidden resource',
    '',
  ]) {
    assert.equal(classifyPeerRefusal(403, body(message)), null, message)
  }
})

test('the reason is matched whole, anchored at both ends, never as a substring', () => {
  for (const message of [
    `Note: ${PEER_NOT_PARTICIPANT_MESSAGE}`,
    `${PEER_NOT_PARTICIPANT_MESSAGE} Retry later.`,
    PEER_NOT_PARTICIPANT_MESSAGE.toLowerCase(),
    ` ${PEER_NOT_PARTICIPANT_MESSAGE}`,
    [PEER_NOT_PARTICIPANT_MESSAGE],
  ]) {
    assert.equal(classifyPeerRefusal(403, body(message)), null, JSON.stringify(message))
  }
})

test('the path, a chat number in a URL, or a bare text body never classify', () => {
  // A chat numbered 4403 once read as a permanent 403 because a sentence was
  // searched. Here the reason sits everywhere except the `message` field.
  assert.equal(
    classifyPeerRefusal(403, body('Forbidden resource', `/api/v1/chats/4403/${PEER_NOT_PARTICIPANT_MESSAGE}`)),
    null,
  )
  assert.equal(classifyPeerRefusal(403, PEER_NOT_PARTICIPANT_MESSAGE), null)
  assert.equal(classifyPeerRefusal(403, `POST 403: ${body(PEER_NOT_PARTICIPANT_MESSAGE)}`), null)
  assert.equal(classifyPeerRefusal(403, body(PEER_NOT_PARTICIPANT_MESSAGE).slice(0, 60)), null)
  assert.equal(classifyPeerRefusal(403, 'null'), null)
  assert.equal(classifyPeerRefusal(403, ''), null)
})

test('a stable code, the day the backend sends one, classifies without the words', () => {
  assert.equal(classifyPeerRefusal(403, body('anything', '/api/v1/messages', { code: PEER_NOT_PARTICIPANT })), PEER_NOT_PARTICIPANT)
  assert.equal(classifyPeerRefusal(403, body('anything', '/api/v1/messages', { code: 'other_code' })), null)
  assert.equal(classifyPeerRefusal(500, body('anything', '/api/v1/messages', { code: PEER_NOT_PARTICIPANT })), null)
})

test('a thrown failure carries the refusal as a field, and nothing else does', () => {
  const refused = Object.assign(new Error('POST 403: ...'), { status: 403, peerRefusal: PEER_NOT_PARTICIPANT })
  assert.equal(peerRefusalOf(refused), PEER_NOT_PARTICIPANT)
  assert.equal(peerRefusalOf(Object.assign(new Error('POST 403'), { status: 403, peerRefusal: null })), null)
  assert.equal(peerRefusalOf(new Error(`POST 403: ${body(PEER_NOT_PARTICIPANT_MESSAGE)}`)), null)
  assert.equal(peerRefusalOf({ peerRefusal: PEER_NOT_PARTICIPANT }), null, 'not an Error, not a failure')
  assert.equal(peerRefusalOf(null), null)
  assert.equal(peerRefusalOf(undefined), null)
})

test('the refused chats are bounded, oldest out first', () => {
  const chats = createRefusedChats(3)
  for (const id of ['1', '2', '3', '4']) chats.add(id)
  assert.equal(chats.size, 3)
  assert.equal(chats.has('1'), false)
  assert.equal(chats.has('4'), true)
  assert.equal(chats.delete('4'), true)
  assert.equal(chats.has('4'), false)
})

test('the model is told plainly: typed, why, and not to retry', () => {
  const result = peerNotParticipantResult('33017')
  assert.equal(result.isError, true)
  assert.equal(result.content.length, 1)
  const text = result.content[0]!.text
  assert.match(text, /^peer_not_participant: /)
  assert.match(text, /chat 33017/)
  assert.match(text, /not one you are in: yours there has closed, or you were never in it/)
  assert.match(text, /Do not retry it\./)
  assert.match(text, /Tell your owner only if it matters to them\./)
  assert.doesNotMatch(text, /[\u2013\u2014]/, 'no en or em dashes')
})

// ── the closed side-thread 400 ──────────────────────────────────────────────

/** A ServiceException as HttpExceptionAdvicer writes it: 400, plus `operation`. */
function body400(message: unknown, path = '/api/v1/messages', extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    statusCode: 400,
    message,
    path,
    timestamp: '2026-10-07T09:00:00.000Z',
    operation: 'MESSAGE',
    ...extra,
  })
}

test('the a2a route reason is byte for byte what BGOS throws', () => {
  assert.equal(A2A_ROUTE_REQUIRED_MESSAGE, 'A2A messages must use /send-message')
})

test('the exact 400 body is the permanent a2a route refusal, and says its status', () => {
  assert.equal(classifyPeerRefusal(400, body400(A2A_ROUTE_REQUIRED_MESSAGE)), A2A_ROUTE_REQUIRED)
  assert.equal(peerRefusalStatus(A2A_ROUTE_REQUIRED), 400)
  assert.equal(peerRefusalStatus(PEER_NOT_PARTICIPANT), 403)
})

test('each reason classifies only on its own status', () => {
  for (const status of [401, 403, 404, 409, 429, 500, 502]) {
    assert.equal(classifyPeerRefusal(status, body400(A2A_ROUTE_REQUIRED_MESSAGE)), null, String(status))
  }
  assert.equal(classifyPeerRefusal(400, body400(PEER_NOT_PARTICIPANT_MESSAGE)), null)
  assert.equal(classifyPeerRefusal(403, body400(A2A_ROUTE_REQUIRED_MESSAGE)), null)
})

test('every other 400 keeps its old reading', () => {
  for (const message of [
    'Missing or invalid required fields for message creation: chatId (> 0), sender, and content (text, files, or options) are required.',
    'Service error',
    'A2A messages must use /send-message.',
    `Note: ${A2A_ROUTE_REQUIRED_MESSAGE}`,
    A2A_ROUTE_REQUIRED_MESSAGE.toUpperCase(),
    ` ${A2A_ROUTE_REQUIRED_MESSAGE}`,
    [A2A_ROUTE_REQUIRED_MESSAGE],
    '',
  ]) {
    assert.equal(classifyPeerRefusal(400, body400(message)), null, JSON.stringify(message))
  }
  // The reason in the path, a bare text body or a cut excerpt never classify.
  assert.equal(classifyPeerRefusal(400, body400('Service error', `/api/v1/${A2A_ROUTE_REQUIRED_MESSAGE}`)), null)
  assert.equal(classifyPeerRefusal(400, A2A_ROUTE_REQUIRED_MESSAGE), null)
  assert.equal(classifyPeerRefusal(400, body400(A2A_ROUTE_REQUIRED_MESSAGE).slice(0, 50)), null)
})

test('a stable a2a code, the day the backend sends one, classifies without the words', () => {
  assert.equal(classifyPeerRefusal(400, body400('anything', '/api/v1/messages', { code: A2A_ROUTE_REQUIRED })), A2A_ROUTE_REQUIRED)
  assert.equal(classifyPeerRefusal(400, body400('anything', '/api/v1/messages', { code: PEER_NOT_PARTICIPANT })), null)
  assert.equal(classifyPeerRefusal(403, body400('anything', '/api/v1/messages', { code: A2A_ROUTE_REQUIRED })), null)
})

test('a thrown failure carries either refusal, and nothing else', () => {
  const refused = Object.assign(new Error('POST 400: ...'), { status: 400, peerRefusal: A2A_ROUTE_REQUIRED })
  assert.equal(peerRefusalOf(refused), A2A_ROUTE_REQUIRED)
  assert.equal(peerRefusalOf(Object.assign(new Error('POST 400'), { peerRefusal: 'something_else' })), null)
  assert.equal(peerRefusalOf({ peerRefusal: A2A_ROUTE_REQUIRED }), null, 'not an Error, not a failure')
})

test('the model is told plainly for the a2a 400: typed, why, and not to retry', () => {
  const result = a2aRouteRequiredResult('33017', 'this card')
  assert.equal(result.isError, true)
  assert.equal(result.content.length, 1)
  const text = result.content[0]!.text
  assert.match(text, /^a2a_route_required: /)
  assert.match(text, /this card/)
  assert.match(text, /chat 33017/)
  assert.match(text, /400: "A2A messages must use \/send-message"/)
  assert.match(text, /peer side-thread/)
  assert.match(text, /Do not retry it\./)
  // Where the thing belongs, and what a reply here would really do.
  assert.match(text, /Anything for your owner belongs in your owner's chat\./)
  assert.match(text, /reaches the peer agent, not your owner, and reopens a closed conversation/)
  assert.doesNotMatch(text, /say it with reply instead/)
  assert.doesNotMatch(text, /[\u2013\u2014]/, 'no en or em dashes')
})

// BGOS #2038 ships the a2a route refusal with code a2a_wrong_route.
test('the backend\'s real code a2a_wrong_route classifies on a 400, with any message', () => {
  const body = JSON.stringify({ statusCode: 400, code: A2A_WRONG_ROUTE_CODE, message: 'reworded later' })
  assert.equal(classifyPeerRefusal(400, body), A2A_ROUTE_REQUIRED)
})

test('a2a_wrong_route never counts on a 403', () => {
  const body = JSON.stringify({ statusCode: 403, code: A2A_WRONG_ROUTE_CODE, message: 'x' })
  assert.equal(classifyPeerRefusal(403, body), null)
})

// The permission card skipped no refused chat and re-posted per request.
test('the permission card skips a chat that refused this agent for good', () => {
  const refused = makeRefused()
  refused.add('side-1')
  assert.equal(pickPermissionChat(['side-1', 'main-9'], [refused]), 'main-9')
})

test('the permission card checks every refused set it is given', () => {
  const rail = makeRefused()
  const a2a = makeRefused()
  a2a.add('side-2')
  assert.equal(pickPermissionChat(['side-2', 'main-9'], [rail, a2a]), 'main-9')
})

test('the permission card has no chat when every monitored chat refused', () => {
  const refused = makeRefused()
  refused.add('side-1')
  assert.equal(pickPermissionChat(['side-1'], [refused]), undefined)
})

test('with nothing refused the first monitored chat still wins, as before', () => {
  assert.equal(pickPermissionChat(['main-9', 'other'], [makeRefused()]), 'main-9')
})
