/**
 * This daemon's OWN texts are marked as its own (HOAI board row 9c3d6b2c,
 * session liveness).
 *
 * WHY. Some texts this daemon posts AS the agent through /send-message, with
 * sender 'assistant', exactly like the session's replies: the "Heads up ...
 * has not answered a direct check" warning, the /status, /login and /compact
 * answers, the goal and plan notices, the "Asked to stop." line. Everything on
 * the server that asked "did the agent write anything?" read them as the
 * session answering, so the warning that a session was NOT answering reset the
 * hourly stall sweep and hid the agent. Each now carries `postedBy:
 * 'connection'` (lib/session-status-contract.ts), which the server stores and
 * the sweep skips. The session's own replies (the `reply` tool, its questions,
 * its cards) never carry it.
 *
 * Run: npx tsx --test test/connection-texts.test.ts
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'

import { markConnectionText } from '../lib/connection-texts.ts'
import { POSTED_BY_CONNECTION, POSTED_BY_FIELD } from '../lib/session-status-contract.ts'

const server = readFileSync(new URL('../server.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

/** The body of one top level function, from its opening line to the closing
 *  brace in the first column (test/hook-late-card-wiring.test.ts's helper). */
const functionBody = (signature: string): string => {
  const start = server.indexOf(signature)
  assert.ok(start >= 0, `server.ts no longer has ${signature}`)
  const end = server.indexOf('\n}\n', start)
  assert.ok(end > start, `could not find the end of ${signature}`)
  return server.slice(start, end)
}

test('the marker is the contract field and word, added beside the body as it was', () => {
  const body = { chatId: 7, assistantId: 901, text: 'Asked to stop.', sender: 'assistant' }
  const marked = markConnectionText(body)
  assert.deepEqual(marked, { ...body, [POSTED_BY_FIELD]: POSTED_BY_CONNECTION })
  assert.equal(marked.postedBy, 'connection')
  assert.equal('postedBy' in body, false, 'the caller body is not mutated')
})

test('every text the daemon posts as itself is marked', () => {
  for (const signature of [
    'async function sendDaemonText(',
    'async function sendLoginText(',
    'function postPlanVerifierLine(',
  ]) {
    const body = functionBody(signature)
    assert.match(body, /bgosPost\('send-message', markConnectionText\(\{/, `${signature} is not marked`)
  }
  // The stop confirmation ("Asked to stop.") rides the voice rpc handler's
  // sendChatMessage, which is a property, not a function.
  const at = server.indexOf('sendChatMessage: (chatId, text) =>')
  assert.ok(at >= 0, 'the stop confirmation sender moved')
  assert.match(server.slice(at, at + 200), /bgosPost\('send-message', markConnectionText\(\{/)
})

test('the deaf session warning goes out through the marked sender', () => {
  assert.match(server, /void sendDaemonText\(chatId, deafSessionChatMessage\(fixCommand\)\)/)
})

test('nothing else posts to send-message marked, and the session reply is never marked', () => {
  const marked = server.match(/markConnectionText\(/g) ?? []
  assert.equal(marked.length, 4, 'exactly the four daemon senders')
  const sends = server.match(/bgosPost\('send-message'/g) ?? []
  // The four above plus the reply tool's own send, which is the SESSION's
  // answer and must stay unmarked or the sweep would never see an agent reply.
  assert.equal(sends.length, 5)
  const replyAt = server.indexOf("const result = await bgosPost('send-message', body)")
  assert.ok(replyAt >= 0, 'the reply tool send moved')
  assert.doesNotMatch(server.slice(replyAt - 2000, replyAt + 60), /markConnectionText|postedBy/)
})
