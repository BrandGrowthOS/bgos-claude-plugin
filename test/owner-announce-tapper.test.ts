/**
 * A TAP IS READ BY ITS TAPPER TOO (fix round 377, re-review C, nit 3).
 *
 * The rule: the server stamps who tapped a card (`answeredByUserId`, from the
 * authenticated caller) and who reacted (`reactorUserId`). A tap, a card
 * answer, an ask's answer or a reaction whose stamp names a person other than
 * the owner, in a chat not known to be multi party, is that person's turn and
 * is never announced into the owner's session, even in a chat the daemon has
 * not yet learned is theirs. A tap that names nobody keeps today's rule.
 *
 * Run with: npx tsx --test test/owner-announce-tapper.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import * as laneCore from '../lib/lane-core.mjs'

const refused = (s: unknown) => (laneCore as any).ownerAnnounceRefused(s)
const server = readFileSync(join(import.meta.dirname, '..', 'server.ts'), 'utf8')
const OWNER = 'user_owner'
const RECIPIENT = 'user_recipient'

test('a tap stamped with another person is refused in a chat not known to be anybody\'s', () => {
  assert.equal(refused({ lanesOn: false, chatIsOthers: false, chatIsOthersPrivate: false, tapperUserId: RECIPIENT, ownerUserId: OWNER }), true)
  assert.equal(refused({ lanesOn: true, chatIsOthers: false, chatIsOthersPrivate: false, tapperUserId: RECIPIENT, ownerUserId: OWNER }), true)
})

test('the owner\'s own tap, a tap naming nobody, and another person\'s tap in a group keep today\'s rule', () => {
  assert.equal(refused({ lanesOn: false, chatIsOthers: false, chatIsOthersPrivate: false, tapperUserId: OWNER, ownerUserId: OWNER }), false)
  assert.equal(refused({ lanesOn: false, chatIsOthers: false, chatIsOthersPrivate: false, tapperUserId: null, ownerUserId: OWNER }), false)
  assert.equal(refused({ lanesOn: false, chatIsOthers: false, chatIsOthersPrivate: false }), false)
  assert.equal(refused({ lanesOn: false, chatIsOthers: true, chatIsOthersPrivate: false, chatIsMultiParty: true, tapperUserId: RECIPIENT, ownerUserId: OWNER }), false)
  // The server's own standing for the tapper says the chat is a room.
  assert.equal(refused({ lanesOn: false, chatIsOthers: false, chatIsOthersPrivate: false, tapperUserId: RECIPIENT, tapperStanding: 'room_member', ownerUserId: OWNER }), false)
  assert.equal(refused({ lanesOn: false, chatIsOthers: false, chatIsOthersPrivate: false, tapperUserId: RECIPIENT, tapperStanding: 'shared_recipient', ownerUserId: OWNER }), true)
  // A chat known to be another person's private chat is refused whoever tapped.
  assert.equal(refused({ lanesOn: false, chatIsOthers: true, chatIsOthersPrivate: true, tapperUserId: OWNER, ownerUserId: OWNER }), true)
  // An owner the daemon cannot name matches nobody.
  assert.equal(refused({ lanesOn: false, chatIsOthers: false, chatIsOthersPrivate: false, tapperUserId: OWNER, ownerUserId: '' }), true)
})

test('announceRefusedIn passes the tapper, the owner and the chat kind', () => {
  const helper = server.slice(server.indexOf('function announceRefusedIn('), server.indexOf('\n}\n', server.indexOf('function announceRefusedIn(')))
  assert.match(helper, /function announceRefusedIn\(chatId: string, tapperUserId: string \| null = null, tapperStanding: unknown = null\): boolean/)
  assert.match(helper, /tapperUserId,/)
  assert.match(helper, /tapperStanding,/)
  assert.match(helper, /ownerUserId: USER_ID,/)
  assert.match(helper, /chatIsMultiParty: chatOwnership\.isMultiParty\(chatId\) \|\| meetingChatIds\.has\(chatId\) \|\| groupChatIds\.has\(chatId\),/)
})

test('every door that reads a tapper hands it over', () => {
  // The poll's taps and ask answers, one row at a time.
  assert.match(server, /if \(announceRefusedIn\(chatId, pollTapperOf\(id\), tapStandingOf\(pollAnswerOf\(id\)\)\)\) \{/)
  assert.match(server, /askAnswered\.filter\(\(id\) => announceRefusedIn\(chatId, pollTapperOf\(id\), tapStandingOf\(pollAnswerOf\(id\)\)\)\)/)
  // The stream's tap.
  assert.match(server, /if \(!tapLaneVerdict\.deliver \|\| announceRefusedIn\(chatId, view\.answerPayload\?\.tapperUserId \?\? null, tapStandingOf\(view\.raw\.answerPayload \?\? view\.raw\.answer_payload\)\)\) \{/)
  // A posted card's answer.
  assert.match(server, /if \(!lane\.deliver \|\| announceRefusedIn\(chatId, readTapperUserId\(mm\.answerPayload\), tapStandingOf\(mm\.answerPayload\)\)\) \{/)
  // A reaction, by the reactor and the standing the server named.
  assert.match(server, /if \(announceRefusedIn\(String\(frame\.chatId\), card\.meta\.user_id \?\? null, card\.meta\.sender_relationship\)\) \{/)
})
