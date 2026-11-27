/**
 * ADMISSION TO THE OWNER'S SESSION, for every row a chat can hold (fix round
 * 377, re-review C, items D, E and F).
 *
 * The rule: whatever a share recipient can write on a row (its sender kind,
 * its author stamp, its message type, its event meta) may only ever refuse a
 * row here, never admit one. Which chat the row sits in is not theirs to
 * write, so:
 *   - in a chat known to be another person's private chat, the owner's
 *     session takes no row at all: not a person's row, not a system or event
 *     row (a call's transcript included), and not a row whose stamp names the
 *     owner, since the backend files every person row of a main chat under
 *     that chat's own person;
 *   - a system or event row is read as a machine row, and a machine row whose
 *     author stamp names a person other than the owner is that person's row,
 *     judged like any other row of theirs (the socket's stamp is the chat
 *     row's own person, so this holds from a chat's first row there);
 *   - a machine row never makes a chat the owner's own;
 *   - a peer agent, another agent in a room and an email keep their own rules.
 *
 * WHAT THESE TESTS HOLD.
 *   - admissionReading, the one reading every intake site hands the check;
 *   - ownerTurnRefused on the owner's stamp in another person's private chat;
 *   - the intake run out of server.ts: system rows (D), rows stamped with the
 *     owner (E) and a call's transcript (F), on the poll, the stream, the
 *     socket and an edit;
 *   - each site passes its reading, never a bare boolean.
 *
 * Run with: npx tsx --test test/owner-admission-rows.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import * as laneCore from '../lib/lane-core.mjs'
import { createChatOwnership } from '../lib/chat-ownership.ts'

const core: any = laneCore
const ROOT = join(import.meta.dirname, '..')
const server = readFileSync(join(ROOT, 'server.ts'), 'utf8')
const OWNER = 'user_owner'
const RECIPIENT = 'user_recipient'

/** What each intake site reads of a row, as the site reads it. */
type SiteRow = { senderKind: string; agentOrigin?: boolean; isEmail?: boolean; isSystem?: boolean }

/**
 * The reading a site hands the admission. Until admissionReading exists the
 * sites handed a boolean (a user row, no peer origin, not an email), which is
 * what this falls back to, so the verdicts below are asked of the code as it is.
 */
function readingOf(row: SiteRow): unknown {
  if (typeof core.admissionReading === 'function') return core.admissionReading(row)
  return !row.isSystem && row.senderKind === 'user' && !row.agentOrigin && !row.isEmail
}

const SYSTEM: SiteRow = { senderKind: 'system' }
const PERSON: SiteRow = { senderKind: 'user' }

async function intake() {
  const ts = (await import('typescript')).default
  const privateTurn: any = await import('../lib/private-turn.mjs')
  const { isGroupChatDelivery } = await import('../lib/channel-liveness.ts')
  const body = server.slice(server.indexOf('function noteChatAuthor('), server.indexOf('/** A tap, an ask\'s answer, a card answer or a reaction'))
  const js = ts.transpileModule(`${body}\nreturn ownerSessionRefuses;`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
  const chatOwnership = createChatOwnership(OWNER)
  const groupChatIds = new Set<string>()
  const bindings: Record<string, unknown> = {
    chatOwnership, groupChatIds, meetingChatIds: new Set<string>(), USER_ID: OWNER,
    privateSenderUserId: privateTurn.privateSenderUserId, eventRowOfNobody: privateTurn.eventRowOfNobody,
    eventRowNotesNobody: privateTurn.eventRowNotesNobody, isGroupChatDelivery,
    ownerTurnRefused: core.ownerTurnRefused, log: () => {},
  }
  const refuses = new Function(...Object.keys(bindings), js)(...Object.values(bindings)) as (chatId: string, reading: unknown, record: unknown, transport: string, id: unknown) => boolean
  return { refuses, chatOwnership }
}

const TRANSPORTS = ['poll', 'stream', 'socket', 'poll edit']

// ── the reading every site hands the admission ───────────────────────────────

test('admissionReading: a person, a machine row, and the rows that keep their own rules', () => {
  assert.equal(typeof core.admissionReading, 'function', 'one reading for every site')
  assert.equal(core.admissionReading({ senderKind: 'user' }), 'person')
  // A system row, by its sender kind or by the stream's own flag; an assistant or an unknown kind is no person either.
  assert.equal(core.admissionReading({ senderKind: 'system' }), 'machine')
  assert.equal(core.admissionReading({ senderKind: 'user', isSystem: true }), 'machine')
  assert.equal(core.admissionReading({ senderKind: 'assistant' }), 'machine')
  assert.equal(core.admissionReading({ senderKind: 'unknown' }), 'machine')
  // A peer agent, another agent in a room, an email.
  assert.equal(core.admissionReading({ senderKind: 'agent' }), 'agent')
  assert.equal(core.admissionReading({ senderKind: 'user', agentOrigin: true }), 'agent')
  assert.equal(core.admissionReading({ senderKind: 'system', agentOrigin: true }), 'agent')
  assert.equal(core.admissionReading({ senderKind: 'room_agent' }), 'agent')
  assert.equal(core.admissionReading({ senderKind: 'external_email', isEmail: true }), 'agent')
  assert.equal(core.admissionReading({ senderKind: 'user', isEmail: true }), 'agent')
})

// ── E: the owner's stamp in another person's private chat ────────────────────

test('E: a row stamped with the owner in a chat known to be another person\'s private chat is refused', () => {
  assert.equal(core.ownerTurnRefused({ human: true, authorUserId: OWNER, ownerUserId: OWNER, chatIsOthersPrivate: true }), true)
  // In the owner's own chat, or one nothing is known of, the owner's stamp stays the owner's turn.
  assert.equal(core.ownerTurnRefused({ human: true, authorUserId: OWNER, ownerUserId: OWNER }), false)
  assert.equal(core.ownerTurnRefused({ human: true, authorUserId: OWNER, ownerUserId: OWNER, chatIsMultiParty: true }), false)
})

test('E: on every transport, the owner\'s stamp does not carry a row into the owner\'s session from another person\'s private chat', async () => {
  for (const transport of TRANSPORTS) {
    const g = await intake()
    assert.equal(g.refuses('20', readingOf(PERSON), { senderUserId: RECIPIENT }, transport, 1), true, 'known as the recipient\'s')
    assert.equal(g.refuses('20', readingOf(PERSON), { senderUserId: OWNER, sender: 'user' }, transport, 2), true, `${transport}: a stamp naming the owner`)
    assert.equal(g.refuses('20', readingOf(PERSON), { sender: { userId: OWNER }, senderType: 'user' }, transport, 3), true, `${transport}: the socket's spelling`)
    assert.equal(g.chatOwnership.isOthersPrivate('20'), true, 'and the chat stays the recipient\'s')
  }
})

test('E: once a chat shows itself another person\'s, rows stamped with the owner there are refused from then on', async () => {
  const g = await intake()
  // A chat nothing was known of: a row stamped with the owner reads as the owner's (the server's proof is not on a poll row).
  assert.equal(g.refuses('60', readingOf(PERSON), { senderUserId: OWNER }, 'poll', 1), false)
  // The socket's stamp is the chat row's own person: the recipient.
  assert.equal(g.refuses('60', readingOf(PERSON), { sender: { userId: RECIPIENT, relationship: 'shared_recipient' }, senderType: 'user' }, 'socket', 2), true)
  assert.equal(g.refuses('60', readingOf(PERSON), { senderUserId: OWNER }, 'poll', 3), true, 'the owner\'s stamp no longer admits')
  assert.equal(g.refuses('60', readingOf(PERSON), { senderUserId: OWNER, messageType: 'event' }, 'stream', 4), true)
})

// ── D: a system row a share recipient sends ──────────────────────────────────

test('D: a system row in a chat known to be another person\'s private chat is refused, on every transport', async () => {
  for (const transport of TRANSPORTS) {
    const g = await intake()
    assert.equal(g.refuses('20', readingOf(PERSON), { senderUserId: RECIPIENT }, transport, 1), true)
    for (const shape of [
      { sender: 'system' },
      { sender: 'system', senderType: 'system' },
      { senderType: 'system' },
      { sender_type: 'system', message_type: 'event' },
      { sender: 'system', messageType: 'event' },
      { sender: 'assistant', messageType: 'event', eventMeta: { source: 'browser_session' } },
    ]) {
      assert.equal(g.refuses('20', readingOf(SYSTEM), shape, transport, 2), true, `${transport}: ${JSON.stringify(shape)}`)
    }
  }
})

test('D: on the socket a system row carries the chat\'s own person, so it is refused from the chat\'s first row', async () => {
  const g = await intake()
  const socketSystemRow = { senderType: 'system', userId: RECIPIENT, sender: { userId: RECIPIENT, displayName: 'R', relationship: 'shared_recipient' }, text: 'x' }
  assert.equal(g.refuses('80', readingOf(SYSTEM), socketSystemRow, 'socket', 1), true)
  // ...and it shows whose chat it is: an unstamped system row there on the poll is refused too.
  assert.equal(g.chatOwnership.isOthersPrivate('80'), true)
  assert.equal(g.refuses('80', readingOf(SYSTEM), { sender: 'system' }, 'poll', 2), true)
})

test('D: the owner\'s own system rows, wakes and peers are still delivered', async () => {
  const g = await intake()
  // The owner's own chat, shown by the owner speaking there.
  assert.equal(g.refuses('10', readingOf(PERSON), { senderUserId: OWNER }, 'socket', 1), false)
  assert.equal(g.refuses('10', readingOf(SYSTEM), { senderType: 'system', sender: { userId: OWNER, relationship: 'owner' } }, 'socket', 2), false)
  assert.equal(g.refuses('10', readingOf(SYSTEM), { sender: 'system', messageType: 'event', eventMeta: { source: 'scheduler' } }, 'poll', 3), false)
  // A chat nothing is known of: an unstamped machine row reads as today.
  assert.equal(g.refuses('11', readingOf(SYSTEM), { sender: 'system' }, 'stream', 4), false)
  // A machine row stamped with the owner never makes a chat the owner's own (only a person's row does).
  assert.equal(g.refuses('12', readingOf(SYSTEM), { sender: 'system', senderUserId: OWNER }, 'poll', 5), false)
  assert.equal(g.chatOwnership.isOwners('12'), false)
  // A peer agent and an email keep their own rules.
  assert.equal(g.refuses('10', readingOf({ senderKind: 'agent', agentOrigin: true }), { senderUserId: RECIPIENT, agentOrigin: { assistantId: 9 } }, 'socket', 6), false)
  assert.equal(g.refuses('10', readingOf({ senderKind: 'external_email', isEmail: true }), { senderType: 'external_email' }, 'poll', 7), false)
  assert.equal(g.chatOwnership.isOthers('10'), false, 'neither marks the chat as anybody else\'s')
})

test('D: a machine row stamped with another person in a group stays admitted', async () => {
  const g = await intake()
  g.chatOwnership.noteRow({ chatId: '40', kind: 'group' })
  assert.equal(g.refuses('40', readingOf(SYSTEM), { senderType: 'system', sender: { userId: RECIPIENT, relationship: 'room_member' } }, 'socket', 1), false)
})

// ── F: a voice call's transcript ─────────────────────────────────────────────

const transcriptRow = (extra: Record<string, unknown> = {}) => ({
  sender: 'system',
  messageType: 'event',
  eventMeta: { type: 'voice_call_transcript', source: 'voice-call', title: 'Voice call summary', summary: 's', turns: [] },
  text: 'Voice call summary',
  ...extra,
})

test('F: a voice call\'s transcript in another person\'s private chat is refused, on every transport', async () => {
  for (const transport of TRANSPORTS) {
    const g = await intake()
    assert.equal(g.refuses('20', readingOf(PERSON), { senderUserId: RECIPIENT }, transport, 1), true)
    assert.equal(g.refuses('20', readingOf(SYSTEM), transcriptRow(), transport, 2), true, transport)
    assert.equal(g.refuses('20', readingOf(SYSTEM), { sender_type: 'system', message_type: 'event', event_meta: { source: 'voice-call' } }, transport, 3), true, transport)
  }
})

test('F: on the socket a transcript carries the caller\'s chat, and is refused from the chat\'s first row', async () => {
  const g = await intake()
  assert.equal(g.refuses('81', readingOf(SYSTEM), transcriptRow({ senderType: 'system', sender: { userId: RECIPIENT, relationship: 'shared_recipient' } }), 'socket', 1), true)
  // The owner's own call in the owner's own chat is the owner's.
  assert.equal(g.refuses('82', readingOf(SYSTEM), transcriptRow({ senderType: 'system', sender: { userId: OWNER, relationship: 'owner' } }), 'socket', 2), false)
})

// ── the wiring ───────────────────────────────────────────────────────────────

test('every intake site hands the admission its reading, never a bare boolean', () => {
  assert.match(server, /ownerSessionRefuses\(chatId, admissionReading\(\{ senderKind: pollSenderType, agentOrigin: !!pollAgentOrigin, isEmail: pollIsEmail \}\), msg\.message, 'poll', msg\.message\.id\)\) continue/)
  assert.match(server, /ownerSessionRefuses\(chatId, admissionReading\(\{ senderKind: view\.senderKind, agentOrigin: !!view\.agentOrigin, isEmail: isExternalEmailSenderType\(view\.senderKind\), isSystem \}\), view\.raw, 'stream', view\.messageId\)\) return/)
  assert.match(server, /ownerSessionRefuses\(chatId, admissionReading\(\{ senderKind: wsSenderType, agentOrigin: !!wsAgentOrigin, isEmail: wsIsEmail \}\), payload, 'socket', messageId\)\) return/)
  assert.match(server, /ownerSessionRefuses\(view\.chatId, 'person', view\.raw, `\$\{transport\} edit`, view\.messageId\)\) return false/)
  // The author notes after the admission take the same reading.
  assert.doesNotMatch(server, /noteChatAuthor\(chatId, pollSenderType === 'user'/)
  assert.doesNotMatch(server, /noteChatAuthor\(chatId, !isSystem && view\.senderKind === 'user'/)
  assert.doesNotMatch(server, /noteChatAuthor\(chatId, wsSenderType === 'user'/)
})
