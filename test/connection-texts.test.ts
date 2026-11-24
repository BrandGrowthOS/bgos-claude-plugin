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
 * WHAT IS NOT MARKED AS THE CONNECTION, ON PURPOSE (review finding 2). An
 * answer to the owner's own command (/status, /login, /compact, a typed
 * /stop's "Asked to stop.") answers a row the owner wrote. Marked as the
 * connection, that row would wait for ever and the sweep would flag a healthy,
 * idle agent 30 minutes later. And the session's own replies (the `reply`
 * tool) are exactly what the sweep must keep seeing.
 *
 * COMMAND ANSWERS CARRY THEIR OWN MARK. Unmarked, the answer to a /login
 * typed after a usage limit report read as the agent answering, so the
 * server's limit hold cleared and the agent's row read Running while it was
 * still on its limit. Each command answer now carries
 * `postedBy: 'command_answer'`: the server still counts it as answering the
 * owner's row, and its limit hold waits for the agent's own reply.
 *
 * Run: npx tsx --test test/connection-texts.test.ts
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'

import { POSTED_BY_COMMAND_ANSWER, markCommandAnswer, markConnectionText } from '../lib/connection-texts.ts'
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
  // The deaf warning goes to the owner's own chat (deafNoticeChat, board row 59a6d097).
  assert.match(server, /void sendConnectionNotice\(noticeChat, deafSessionChatMessage\(fixCommand\)\)/)
  assert.match(server, /await sendConnectionNotice\(chatId, GOAL_ARM_REFUSED_TEXT\)/)
  assert.match(server, /await sendConnectionNotice\(chatId, GOAL_ARM_UNCONFIRMED_TEXT\)/)
  assert.doesNotMatch(server, /sendDaemonText\((chatId|noticeChat), (deafSessionChatMessage|GOAL_ARM_)/)
})

test('an answer to the owner own command is never marked as the connection (review finding 2)', () => {
  for (const signature of ['async function sendDaemonText(', 'async function sendLoginText(']) {
    const body = functionBody(signature)
    assert.match(body, /bgosPost\('send-message', markCommandAnswer\(\{/, `${signature} moved`)
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

test('the command answer mark is its own word, added beside the body as it was', () => {
  assert.equal(POSTED_BY_COMMAND_ANSWER, 'command_answer')
  assert.notEqual(POSTED_BY_COMMAND_ANSWER, POSTED_BY_CONNECTION)
  const body = { chatId: 7, assistantId: 901, text: 'Agent status', sender: 'assistant' }
  const marked = markCommandAnswer(body)
  assert.deepEqual(marked, { ...body, [POSTED_BY_FIELD]: POSTED_BY_COMMAND_ANSWER })
  assert.equal('postedBy' in body, false, 'the caller body is not mutated')
})

test('every answer to the owner own command carries the command answer mark', () => {
  // /status and /compact (sendDaemonText), /login (sendLoginText).
  for (const signature of ['async function sendDaemonText(', 'async function sendLoginText(']) {
    assert.match(
      functionBody(signature),
      /bgosPost\('send-message', markCommandAnswer\(\{/,
      `${signature} is not marked as a command answer`,
    )
  }
  // The owner's Stop confirmation ("Asked to stop.").
  const at = server.indexOf('sendChatMessage: (chatId, text) =>')
  assert.match(server.slice(at, at + 120), /bgosPost\('send-message', markCommandAnswer\(\{/)
  // The login controller sends through sendLoginText only.
  assert.match(server, /\n  send: sendLoginText,\n/)
})

test('the command answer mark goes nowhere else: never the unprompted notices, never the session reply', () => {
  assert.equal((server.match(/markCommandAnswer\(/g) ?? []).length, 3)
  for (const signature of ['async function sendConnectionNotice(', 'function postPlanVerifierLine(']) {
    assert.doesNotMatch(functionBody(signature), /markCommandAnswer/)
  }
  const replyAt = server.indexOf("const result = await bgosPost('send-message', body)")
  assert.doesNotMatch(server.slice(replyAt - 2000, replyAt + 60), /markCommandAnswer|command_answer/)
})
