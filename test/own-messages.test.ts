/**
 * The record of messages this agent sent (lib/own-messages.ts), which edit_message asks before it edits.
 *
 * Round 2 of the edit_message fix (review F1): PATCH /api/v1/messages/:id admits any row the owner may edit, so with
 * the owner's credential the tool could rewrite the owner's own lines and the lines of the owner's other agents. The
 * backend has no read of one row by id, so the plugin keeps the ids the SERVER answered as this agent's own rows when
 * the daemon created them, and edit_message edits only those.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  OWN_MESSAGES_FILE_NAME,
  OwnMessages,
  ownMessageIdFromAnswer,
  ownMessageRefusal,
  ownMessagesFilePath,
} from '../lib/own-messages'

const AGENT = '1'

/** What POST /send-message answers for the agent's reply in its main chat (senderAssistantId is null there). */
const replyAnswer = (id: number) => ({ message: { id, chatId: 1, sender: 'assistant', senderAssistantId: null, text: 'hi' } })
/** What POST /messages answers for the agent's ask or plan card. */
const cardAnswer = (id: number) => ({ id, chatId: 1, sender: 'assistant', messageType: 'ask_user_input' })

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'own-messages-'))
  return { dir, file: join(dir, '1', OWN_MESSAGES_FILE_NAME), done: () => rmSync(dir, { recursive: true, force: true }) }
}

test('the server\'s answer names this agent\'s own row: the reply shape and the card shape', () => {
  assert.equal(ownMessageIdFromAnswer(replyAnswer(11), AGENT), 11)
  assert.equal(ownMessageIdFromAnswer(cardAnswer(12), AGENT), 12)
  assert.equal(ownMessageIdFromAnswer({ message: { id: '13', sender: 'assistant' } }, AGENT), 13, 'a numeric string id')
  assert.equal(ownMessageIdFromAnswer({ message: { id: 14, sender: 'assistant', senderAssistantId: 1 } }, AGENT), 14, 'its own id named')
  assert.equal(ownMessageIdFromAnswer({ message: { id: 15, sender: 'assistant', senderAssistantId: '1' } }, AGENT), 15)
})

test('the server\'s answer for anything else names no own row', () => {
  assert.equal(ownMessageIdFromAnswer({ message: { id: 20, sender: 'user' } }, AGENT), null, 'the owner\'s own line')
  assert.equal(ownMessageIdFromAnswer({ message: { id: 21, sender: 'assistant', senderAssistantId: 2 } }, AGENT), null, 'another agent\'s line')
  assert.equal(ownMessageIdFromAnswer({ id: 22, sender: 'system' }, AGENT), null)
  assert.equal(ownMessageIdFromAnswer({ id: 23 }, AGENT), null, 'no sender')
  for (const id of [0, -1, 1.5, 'abc', '0123', null, undefined, '1234567890123456789']) {
    assert.equal(ownMessageIdFromAnswer({ id, sender: 'assistant' }, AGENT), null, `id ${String(id)}`)
  }
  for (const answer of [null, undefined, 'x', 7, [], { message: null }, { status: 'ok' }]) {
    assert.equal(ownMessageIdFromAnswer(answer, AGENT), null, JSON.stringify(answer))
  }
  assert.equal(ownMessageIdFromAnswer(replyAnswer(24), ''), 24, 'no agent id: the row is still the daemon\'s own create')
  assert.equal(ownMessageIdFromAnswer({ id: 25, sender: 'assistant', senderAssistantId: 2 }, ''), null)
})

test('only the two create routes are read: messages and send-message', () => {
  const own = new OwnMessages({ filePath: null, assistantId: AGENT })
  assert.equal(own.noteCreate('send-message', replyAnswer(31)), 31)
  assert.equal(own.noteCreate('messages', cardAnswer(32)), 32)
  assert.equal(own.noteCreate('/messages', cardAnswer(33)), 33)
  assert.equal(own.noteCreate('messages/40/callback', cardAnswer(40)), null)
  assert.equal(own.noteCreate('messages/bulk-ish', cardAnswer(41)), null)
  assert.equal(own.noteCreate('peers/send', replyAnswer(42)), null)
  assert.equal(own.noteCreate('send-message', { message: { id: 43, sender: 'user' } }), null)
  assert.deepEqual([31, 32, 33, 40, 41, 42, 43].map((id) => own.has(id)), [true, true, true, false, false, false, false])
})

test('has() reads an id as edit_message gets it: a string, trimmed, or a number', () => {
  const own = new OwnMessages({ filePath: null, assistantId: AGENT })
  own.note(replyAnswer(901))
  assert.equal(own.has('901'), true)
  assert.equal(own.has(901), true)
  assert.equal(own.has(' 901 '), true)
  assert.equal(own.has('9010'), false)
  assert.equal(own.has('abc'), false)
  assert.equal(own.has(null), false)
})

test('the record survives a restart: a new daemon reads the file the last one wrote', () => {
  const s = scratch()
  try {
    const first = new OwnMessages({ filePath: s.file, assistantId: AGENT })
    first.note(replyAnswer(51))
    first.note(cardAnswer(52))
    const second = new OwnMessages({ filePath: s.file, assistantId: AGENT })
    assert.equal(second.has(51), true)
    assert.equal(second.has(52), true)
    assert.equal(second.has(53), false)
    const body = JSON.parse(readFileSync(s.file, 'utf8'))
    assert.deepEqual(body, { v: 1, ids: [51, 52] })
  } finally {
    s.done()
  }
})

test('the record is bounded: the oldest id goes first, and a noted id again is newest', () => {
  const own = new OwnMessages({ filePath: null, assistantId: AGENT, limit: 3 })
  for (const id of [1, 2, 3]) own.note(replyAnswer(id))
  own.note(replyAnswer(1))
  own.note(replyAnswer(4))
  assert.deepEqual([1, 2, 3, 4].map((id) => own.has(id)), [true, false, true, true])
  assert.equal(own.size, 3)
})

test('a missing, corrupt or odd file loads as an empty record, and keeps only good ids', () => {
  const s = scratch()
  try {
    assert.equal(new OwnMessages({ filePath: s.file, assistantId: AGENT }).size, 0, 'missing')
    mkdirSync(join(s.dir, '1'), { recursive: true })
    writeFileSync(s.file, '{ not json')
    assert.equal(new OwnMessages({ filePath: s.file, assistantId: AGENT }).size, 0, 'corrupt')
    writeFileSync(s.file, JSON.stringify({ v: 1, ids: [7, 'x', -2, 8.5, 9] }))
    const own = new OwnMessages({ filePath: s.file, assistantId: AGENT })
    assert.deepEqual([7, 9].map((id) => own.has(id)), [true, true])
    assert.equal(own.size, 2)
  } finally {
    s.done()
  }
})

test('a write that fails never throws: the id is still known in memory, and the failure is logged', () => {
  const s = scratch()
  const lines: string[] = []
  try {
    mkdirSync(join(s.dir, 'ro'), { recursive: true })
    chmodSync(join(s.dir, 'ro'), 0o500)
    const own = new OwnMessages({ filePath: join(s.dir, 'ro', 'deep', OWN_MESSAGES_FILE_NAME), assistantId: AGENT, log: (l) => lines.push(l) })
    assert.equal(own.note(replyAnswer(61)), 61)
    assert.equal(own.has(61), true)
    if (process.getuid?.() !== 0) assert.equal(lines.length, 1, 'one log line for the failed write')
  } finally {
    chmodSync(join(s.dir, 'ro'), 0o700)
    s.done()
  }
})

test('the file sits beside the chat cursors, per agent', () => {
  assert.equal(ownMessagesFilePath(join('state', '1', 'chat-cursors.json')), join('state', '1', OWN_MESSAGES_FILE_NAME))
})

test('the refusal is one plain line naming the id', () => {
  const line = ownMessageRefusal('42')
  assert.doesNotMatch(line, /\n/)
  assert.match(line, /^Error: /)
  assert.match(line, /\b42\b/)
  assert.match(line, /only a message this agent sent/)
})
