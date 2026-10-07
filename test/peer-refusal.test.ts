/**
 * Which backend refusal is permanent, read narrowly (lib/peer-refusal.ts).
 *
 * The behaviour it buys, run against the daemon's own code and a mocked
 * backend, is in test/peer-403-loop.test.ts. These pin the classifier itself:
 * only a 403 whose `message` is the participant reason, whole, or whose `code`
 * says so. Never a substring, never the path, never a number in a URL.
 *
 * Run with: npx tsx --test test/peer-refusal.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  PEER_NOT_PARTICIPANT,
  PEER_NOT_PARTICIPANT_MESSAGE,
  classifyPeerRefusal,
  createRefusedChats,
  peerNotParticipantResult,
  peerRefusalOf,
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
  assert.match(text, /closed or you are not in it/)
  assert.match(text, /Do not retry it\./)
  assert.match(text, /Tell your owner only if it matters to them\./)
  assert.doesNotMatch(text, /[\u2013\u2014]/, 'no en or em dashes')
})
