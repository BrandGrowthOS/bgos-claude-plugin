/**
 * ADMISSION TO THE OWNER'S SESSION, and the owner's tool authority, follow the
 * person behind the turn (fix round 377, finding 1).
 *
 * The rule: the owner's session takes a person's turn when the server's author
 * stamp names the owner, or the chat is a multi party one; and the owner's
 * tools answer only the owner's own turns. Neither depends on the lane stamp
 * or on whether person lanes are switched on.
 *
 * WHAT THESE TESTS HOLD.
 *   - ownerTurnRefused: a person's turn reaches the owner's session only when
 *     the server stamp names the owner, or the chat is multi party; a chat
 *     known to be another person's private chat refuses whatever the stamp;
 *     a wake, a peer and an email keep their own rules (not refused here);
 *   - the same answer with the lanes switch off, never activated, on, and
 *     after a revoke, since none of them is an input;
 *   - ownerAnnounceRefused: a tap in a recipient's private chat is refused
 *     with lanes off too; a group keeps the lanes-on rule only;
 *   - ownerToolRefused: a permission request raised in another person's turn
 *     is refused, with auto approve on or off; a turn naming nobody is not;
 *   - the wiring: every inbound site of server.ts asks ownerSessionRefuses
 *     before the sign-in code gate, every announce check goes through
 *     announceRefusedIn, and the permission handler refuses another person's
 *     turn before the floor and auto approve, reading the turn once.
 *
 * Run with: npx tsx --test test/owner-turn-admission.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import * as laneCore from '../lib/lane-core.mjs'
import { createChatOwnership } from '../lib/chat-ownership.ts'

const { ownerAnnounceRefused } = laneCore
const ownerToolRefused = (s: unknown) => (laneCore as any).ownerToolRefused(s)
const ownerTurnRefused = (s: unknown) => (laneCore as any).ownerTurnRefused(s)

const ROOT = join(import.meta.dirname, '..')
const server = readFileSync(join(ROOT, 'server.ts'), 'utf8')
const OWNER = 'user_owner'
const RECIPIENT = 'user_recipient'

test('a recipient turn in a private chat is refused by the owner session, whatever the stamp says', () => {
  // The chat is not known yet: the row's own stamp names the recipient.
  assert.equal(ownerTurnRefused({ human: true, authorUserId: RECIPIENT, ownerUserId: OWNER }), true)
  // Known to be the recipient's private chat, even an unstamped row.
  assert.equal(ownerTurnRefused({ human: true, authorUserId: null, ownerUserId: OWNER, chatIsOthersPrivate: true }), true)
  // The owner's own turn, in the owner's chat or an unknown one.
  assert.equal(ownerTurnRefused({ human: true, authorUserId: OWNER, ownerUserId: OWNER }), false)
  // An unstamped row in a chat nobody else was seen in: an old backend's chat with its owner.
  assert.equal(ownerTurnRefused({ human: true, authorUserId: null, ownerUserId: OWNER }), false)
  assert.equal(ownerTurnRefused({ human: true, authorUserId: '  ', ownerUserId: OWNER }), false)
})

test('a multi party chat admits other people, a private one never does', () => {
  assert.equal(ownerTurnRefused({ human: true, authorUserId: RECIPIENT, ownerUserId: OWNER, chatIsMultiParty: true }), false, 'a group, a room, a meeting')
  // A chat known as the recipient's private chat refuses even if a row once said multi party: private wins.
  assert.equal(ownerTurnRefused({ human: true, authorUserId: RECIPIENT, ownerUserId: OWNER, chatIsOthersPrivate: true, chatIsMultiParty: true }), true)
})

test('not a person turn: a wake, a peer agent and an email keep their own rules', () => {
  for (const authorUserId of [RECIPIENT, OWNER, null]) {
    assert.equal(ownerTurnRefused({ human: false, authorUserId, ownerUserId: OWNER, chatIsOthersPrivate: true }), false)
  }
})

test('an owner the daemon cannot name matches nobody: a stamped person is refused', () => {
  assert.equal(ownerTurnRefused({ human: true, authorUserId: RECIPIENT, ownerUserId: '' }), true)
  assert.equal(ownerTurnRefused({ human: true, authorUserId: OWNER, ownerUserId: '' }), true)
})

test('the lanes switch is no input: legacy, activated and revoked configurations give one answer', () => {
  // ownerTurnRefused takes no lanes flag at all; the announce rule's flag only widens it.
  for (const lanesOn of [false, true]) {
    assert.equal(ownerAnnounceRefused({ lanesOn, chatIsOthers: true, chatIsOthersPrivate: true }), true, `private, lanesOn ${lanesOn}`)
    assert.equal(ownerAnnounceRefused({ lanesOn, chatIsOthers: false, chatIsOthersPrivate: false }), false, `the owner chat, lanesOn ${lanesOn}`)
  }
  // A group another person spoke in: refused only with lanes on, as before.
  assert.equal(ownerAnnounceRefused({ lanesOn: false, chatIsOthers: true, chatIsOthersPrivate: false }), false)
  assert.equal(ownerAnnounceRefused({ lanesOn: true, chatIsOthers: true, chatIsOthersPrivate: false }), true)
})

test('chat ownership tells a recipient private chat from a group another person spoke in', () => {
  const o = createChatOwnership(OWNER)
  o.noteAuthor('20', RECIPIENT)
  o.noteRow({ chatId: '40', kind: 'group' })
  o.noteAuthor('40', RECIPIENT)
  o.noteRow({ chatId: '50', kind: 'main', userId: RECIPIENT })
  o.noteAuthor('10', OWNER)
  assert.equal(o.isOthersPrivate('20'), true, 'a recipient stamp in a chat of unread kind counts as private')
  assert.equal(o.isOthersPrivate('50'), true, 'the backend row says it is the recipient main chat')
  assert.equal(o.isOthersPrivate('40'), false, 'a group')
  assert.equal(o.isMultiParty('40'), true)
  assert.equal(o.isOthersPrivate('10'), false)
  assert.equal(o.isMultiParty('10'), false)
})

test('the owner tools follow the turn actor: another person turn is refused, auto approve or not', () => {
  assert.equal(ownerToolRefused({ actingUserId: RECIPIENT, ownerUserId: OWNER }), true)
  assert.equal(ownerToolRefused({ actingUserId: OWNER, ownerUserId: OWNER }), false)
  // A terminal prompt, a wake or a peer turn names nobody: today's path.
  assert.equal(ownerToolRefused({ actingUserId: null, ownerUserId: OWNER }), false)
  assert.equal(ownerToolRefused({ actingUserId: undefined, ownerUserId: OWNER }), false)
  assert.equal(ownerToolRefused({ actingUserId: RECIPIENT, ownerUserId: '' }), true)
})

// ── the wiring, in server.ts ─────────────────────────────────────────────────

test('every inbound site asks ownerSessionRefuses before the sign-in code gate', () => {
  const sites = [
    { name: 'poll', guard: "ownerSessionRefuses(chatId, pollSenderType === 'user' && !pollAgentOrigin && !pollIsEmail, msg.message, 'poll', msg.message.id)) continue", gate: "via: 'poll'," },
    { name: 'stream', guard: "view.raw, 'stream', view.messageId)) return", gate: "via: 'stream'," },
    { name: 'socket', guard: "ownerSessionRefuses(chatId, wsSenderType === 'user' && !wsAgentOrigin && !wsIsEmail, payload, 'socket', messageId)) return", gate: "via: 'ws'," },
  ]
  for (const site of sites) {
    const at = server.indexOf(site.guard)
    assert.ok(at > 0, `${site.name}: the admission check is wired`)
    const gate = server.indexOf(site.gate, at)
    assert.ok(gate > at, `${site.name}: before the sign-in code gate`)
    // And nothing between them hands the turn over.
    assert.doesNotMatch(server.slice(at, gate), /channelNotify\(|deliverInbound\(/, `${site.name}: nothing delivered before the check`)
  }
  const edit = server.slice(server.indexOf('async function forwardHumanEdit('), server.indexOf('async function applyHumanEdit('))
  assert.match(edit, /ownerSessionRefuses\(view\.chatId, true, view\.raw, `\$\{transport\} edit`, view\.messageId\)\) return false/, 'an edit is admitted like a new message')
})

test('ownerSessionRefuses reads the server stamp only, and notes the author first', () => {
  const body = server.slice(server.indexOf('function ownerSessionRefuses('), server.indexOf('function announceRefusedIn('))
  assert.match(body, /noteChatAuthor\(chatId, human, record\)[\s\S]*ownerTurnRefused\(/)
  assert.match(body, /authorUserId: privateSenderUserId\(record\)/)
  assert.doesNotMatch(body, /senderUserIdOf\(/, 'never the reader whose fallback names the owner')
  assert.match(body, /chatIsMultiParty: chatOwnership\.isMultiParty\(chatId\) \|\| meetingChatIds\.has\(chatId\)/)
})

test('every announce check goes through announceRefusedIn, which passes the private chat rule', () => {
  const calls = server.match(/ownerAnnounceRefused\(/g) ?? []
  assert.equal(calls.length, 1, 'one direct call, inside announceRefusedIn')
  const helper = server.slice(server.indexOf('function announceRefusedIn('), server.indexOf('\n}\n', server.indexOf('function announceRefusedIn(')))
  assert.match(helper, /chatIsOthersPrivate: chatIsOthersPrivate\(chatId\)/)
  assert.ok((server.match(/announceRefusedIn\(/g) ?? []).length >= 9, 'taps, asks and card answers all use it')
})

test('the permission handler refuses another person turn before the floor and auto approve, reading the turn once', () => {
  const handler = server.slice(server.indexOf('mcp.setNotificationHandler(PermissionRequestSchema'), server.indexOf('function relayPermissionToOwner('))
  const refuse = handler.indexOf('if (ownerToolRefused({ actingUserId: requestTurn?.actingUserId, ownerUserId: USER_ID }))')
  assert.ok(refuse > 0, 'the actor check is wired')
  assert.ok(refuse < handler.indexOf('planFloorRequest('), 'before the hard floor')
  assert.ok(refuse < handler.indexOf('if (AUTO_APPROVE) {'), 'before auto approve')
  assert.equal((handler.match(/privateTurns\.current\(/g) ?? []).length, 1, 'the turn is read once')
  assert.match(handler, /return settleFloorRequest\(params, floorPlan, requestTurn\)/)
  assert.match(handler, /return settleElidedFloorRequest\(params, requestTurn\)/)
  assert.match(handler, /return relayPermissionToOwner\(params, requestTurn\)/)
  // A group lane's prompt is no turn of this session.
  assert.match(handler, /const requestTurn = groupPermissionVerdicts\.has\(request_id\) \? null : snapshotPermissionTurn\(/)
  // Nothing after creation reads the turn again.
  const after = server.slice(server.indexOf('function relayPermissionToOwner('), server.indexOf('const FLOOR_STATE_ROOT'))
  assert.doesNotMatch(after, /privateTurns\.current\(/, 'the relay and the floor use the snapshot only')
})
