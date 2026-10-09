/**
 * The texts this daemon posts UNPROMPTED are marked as its own (HOAI board row
 * 9c3d6b2c, session liveness).
 *
 * WHY. This daemon posts some texts AS the agent through /send-message, with
 * sender 'assistant', exactly like the session's replies. Its "Heads up ...
 * has not answered a direct check" warning was read by the server as the
 * agent answering, so the warning that a session was NOT answering reset the
 * hourly stall sweep and hid the agent. That warning, and the other texts the
 * daemon posts on its own initiative (the goal and plan notices), now carry
 * `postedBy: 'connection'` (lib/session-status-contract.ts), which the server
 * stores and the sweep skips.
 *
 * WHAT IS NOT MARKED, ON PURPOSE (review finding 2). An answer to the owner's
 * own command (/status, /login, /compact, a typed /stop's "Asked to stop.")
 * answers a row the owner wrote. Marked, that row would wait for ever and the
 * sweep would flag a healthy, idle agent 30 minutes later. And the session's
 * own replies (the `reply` tool) are exactly what the sweep must keep seeing.
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
  const body = { chatId: 7, assistantId: 901, text: 'Heads up', sender: 'assistant' }
  const marked = markConnectionText(body)
  assert.deepEqual(marked, { ...body, [POSTED_BY_FIELD]: POSTED_BY_CONNECTION })
  assert.equal(marked.postedBy, 'connection')
  assert.equal('postedBy' in body, false, 'the caller body is not mutated')
})

test('the texts the daemon posts unprompted are marked', () => {
  for (const signature of ['async function sendConnectionNotice(', 'function postPlanVerifierLine(']) {
    assert.match(
      functionBody(signature),
      /bgosPost\('send-message', markConnectionText\(\{/,
      `${signature} is not marked`,
    )
  }
  // The deaf warning and both goal notices go out through the marked sender.
  assert.match(server, /void sendConnectionNotice\(chatId, deafSessionChatMessage\(fixCommand\)\)/)
  assert.match(server, /await sendConnectionNotice\(chatId, GOAL_ARM_REFUSED_TEXT\)/)
  assert.match(server, /await sendConnectionNotice\(chatId, GOAL_ARM_UNCONFIRMED_TEXT\)/)
  assert.doesNotMatch(server, /sendDaemonText\(chatId, (deafSessionChatMessage|GOAL_ARM_)/)
})

test('an answer to the owner own command stays unmarked (review finding 2)', () => {
  for (const signature of ['async function sendDaemonText(', 'async function sendLoginText(']) {
    const body = functionBody(signature)
    assert.match(body, /bgosPost\('send-message', \{/, `${signature} moved`)
    assert.doesNotMatch(body, /markConnectionText|postedBy/, `${signature} must not be marked`)
  }
  // The stop confirmation ("Asked to stop.") rides the voice rpc handler's
  // sendChatMessage, which is a property, not a function.
  const at = server.indexOf('sendChatMessage: (chatId, text) =>')
  assert.ok(at >= 0, 'the stop confirmation sender moved')
  assert.doesNotMatch(server.slice(at, at + 300), /markConnectionText|postedBy/)
})

test('exactly the two unprompted senders mark, and the session reply never does', () => {
  assert.equal((server.match(/markConnectionText\(/g) ?? []).length, 2)
  const replyAt = server.indexOf("const result = await bgosPost('send-message', body)")
  assert.ok(replyAt >= 0, 'the reply tool send moved')
  assert.doesNotMatch(server.slice(replyAt - 2000, replyAt + 60), /markConnectionText|postedBy/)
})
