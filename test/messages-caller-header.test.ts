/**
 * Every generic `POST /messages` this daemon makes names the agent that wrote
 * it (board row 019ff949, the raw-chatId null remainder).
 *
 * The backend's `raw_chatid_shadow` line records `callerAssistantId`, read on
 * that route only from the X-Caller-Assistant-Id header, and this daemon never
 * sent it there (lib/peer-refusal.ts said so). So every hook rail card, plan,
 * question carousel, component card and permission card logged a null caller:
 * on 2026-10-10 3,445 of 3,907 shadow lines, 3,108 of them one agent's hook
 * rail on 0.44.0. A null line cannot say which agent still has to move off raw
 * chat ids, which is the only question that gates turning ALLOW_RAW_CHATID off.
 *
 * Pure pieces are tested directly; the server.ts wiring is pinned textually
 * (server.ts cannot be imported: it exits without credentials at module load,
 * see stream-wiring.test.ts for the convention).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { messagesCallerHeaders } from '../lib/messages-caller-header.ts'

const serverSource = readFileSync(new URL('../server.ts', import.meta.url), 'utf8')

test('a POST to messages carries the agent id as X-Caller-Assistant-Id', () => {
  assert.deepEqual(
    messagesCallerHeaders({
      path: 'messages',
      body: { chatId: 4465, sender: 'assistant' },
      assistantId: '916',
      withholdForChat: () => false,
    }),
    { 'X-Caller-Assistant-Id': '916' },
  )
})

test('a leading slash is the same route', () => {
  assert.deepEqual(
    messagesCallerHeaders({
      path: '/messages',
      body: { chatId: 1 },
      assistantId: '7',
      withholdForChat: () => false,
    }),
    { 'X-Caller-Assistant-Id': '7' },
  )
})

test('every other route is untouched, including ones that start with messages', () => {
  for (const path of [
    'send-message',
    'messages/bulk',
    'messages/callback-result',
    'meetings/12/messages',
    'integrations/upload-url',
  ]) {
    assert.deepEqual(
      messagesCallerHeaders({
        path,
        body: { chatId: 1 },
        assistantId: '7',
        withholdForChat: () => false,
      }),
      {},
      path,
    )
  }
})

test('no header without an assistant id to name', () => {
  for (const assistantId of ['', '   ', undefined, null]) {
    assert.deepEqual(
      messagesCallerHeaders({
        path: 'messages',
        body: { chatId: 1 },
        assistantId,
        withholdForChat: () => false,
      }),
      {},
      String(assistantId),
    )
  }
})

test('an id that is not a positive whole number is not sent', () => {
  for (const assistantId of ['abc', '0', '-3', '1.5', '12abc']) {
    assert.deepEqual(
      messagesCallerHeaders({
        path: 'messages',
        body: { chatId: 1 },
        assistantId,
        withholdForChat: () => false,
      }),
      {},
      assistantId,
    )
  }
})

test('a chat the daemon withholds for (a meeting, a side-thread) gets no header', () => {
  // With a caller id the backend would let a seated agent's hook rail card
  // into the meeting transcript; without one it refuses, as it always has.
  assert.deepEqual(
    messagesCallerHeaders({
      path: 'messages',
      body: { chatId: 8800 },
      assistantId: '916',
      withholdForChat: (id) => id === '8800',
    }),
    {},
  )
  assert.deepEqual(
    messagesCallerHeaders({
      path: 'messages',
      body: { chatId: 8801 },
      assistantId: '916',
      withholdForChat: (id) => id === '8800',
    }),
    { 'X-Caller-Assistant-Id': '916' },
  )
})

test('the predicate is asked with the chat id as a string, and only for a messages post', () => {
  const asked: string[] = []
  const withholdForChat = (id: string) => {
    asked.push(id)
    return false
  }
  messagesCallerHeaders({ path: 'send-message', body: { chatId: 5 }, assistantId: '7', withholdForChat })
  messagesCallerHeaders({ path: 'messages', body: { chatId: 8825 }, assistantId: '7', withholdForChat })
  assert.deepEqual(asked, ['8825'])
})

test('bgosPost withholds the header from known meetings AND known peer side-threads', () => {
  // A side-thread is the sharper case (review of this change): with a caller
  // id, a generic post into a CLOSED side-thread revives the conversation
  // (ChatParticipationService.reviveClosedPeerConversation reopens the row and
  // hands the turn to the peer) and only then is refused 400 a2a_wrong_route.
  // Without one, the revive is skipped and nothing is written. Pairing 123's
  // pattern was exactly this: conversations closed in 25 ms, then hook cards.
  const start = serverSource.indexOf('async function bgosPost(')
  const body = serverSource.slice(start, serverSource.indexOf('\n}\n', start))
  const call = body.slice(body.indexOf('messagesCallerHeaders('))
  for (const set of ['meetingChatIds', 'peerConvByChat', 'closedPeerChats', 'a2aRouteRefusedChats']) {
    assert.match(call.slice(0, call.indexOf('}),')), new RegExp(`${set}\\.has\\(chatId\\)`), set)
  }
})

test('bgosPost merges the caller header for messages, before explicit headers', () => {
  const start = serverSource.indexOf('async function bgosPost(')
  assert.ok(start >= 0, 'bgosPost not found')
  const body = serverSource.slice(start, serverSource.indexOf('\n}\n', start))
  assert.match(
    body,
    /messagesCallerHeaders\(\{\s*path,\s*body,\s*assistantId: ASSISTANT_ID,[\s\S]*?withholdForChat: \(chatId\) =>/,
  )
  // Inside the request's headers object, not merely somewhere in bgosPost.
  const headersAt = body.indexOf('headers: {')
  const bodyAt = body.indexOf('body: JSON.stringify(body)')
  assert.ok(headersAt >= 0 && bodyAt > headersAt, 'headers object not found')
  const inHeaders = body.slice(headersAt, bodyAt)
  assert.ok(inHeaders.includes('...messagesCallerHeaders('), 'the caller header must be spread into headers')
  const callerAt = body.indexOf('messagesCallerHeaders(')
  const explicitAt = body.indexOf('...(opts.headers ?? {})')
  assert.ok(explicitAt > callerAt, 'an explicit header must still win over the default')
})
