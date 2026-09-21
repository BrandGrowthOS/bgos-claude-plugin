/**
 * A mission belongs to ONE chat.
 *
 * An agent with two chats holds two missions, one per chat, and an agent with
 * one chat must see NO difference at all: that is the acceptance bar for this
 * change, not a hope. So two halves are pinned here.
 *
 * 1. The create body carries `chatId` only when the caller named a chat, and
 *    NEVER `chatId: null`. The backend's global ValidationPipe runs with
 *    whitelist: true, so an undeclared or wrongly typed field is stripped in
 *    silence and a null would be a lie with no error anywhere.
 * 2. The active read path is BYTE IDENTICAL to today when no chat is named,
 *    and carries `?chatId=` when one is. The daemon's ETag body cache keys on
 *    the path, so the query string is part of the cache key by construction
 *    and two chats can never share one cached snapshot.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import {
  buildMissionActivePath,
  buildMissionCreateBody,
  pickImplicitMissionChat,
} from '../lib/missions.ts'

const GOALS = [
  { name: 'Draft written', done_when: 'the draft doc exists' },
  { name: 'List imported', done_when: 'the list shows 400 subscribers' },
]

test('a named chat rides the create body as a number', () => {
  const built = buildMissionCreateBody({
    title: 'Launch the newsletter',
    mini_goals: GOALS,
    chat_id: '4403',
  })
  assert.ok(built.ok)
  assert.equal(built.body.chatId, 4403)
  // A number is accepted too: the model round-tripping the wire shape is not
  // punished for it.
  const asNumber = buildMissionCreateBody({ title: 'T', mini_goals: GOALS, chat_id: 4403 })
  assert.ok(asNumber.ok)
  assert.equal(asNumber.body.chatId, 4403)
})

test('no chat means NO chatId key at all, never null', () => {
  const built = buildMissionCreateBody({ title: 'Launch the newsletter', mini_goals: GOALS })
  assert.ok(built.ok)
  assert.ok(!('chatId' in built.body), 'an absent chat must not become chatId: null on the wire')
  assert.deepEqual(Object.keys(built.body).sort(), ['miniGoals', 'title'])
})

test('a chat that is not a positive integer is refused with an actionable message', () => {
  for (const bad of ['abc', 0, -1, 1.5]) {
    const built = buildMissionCreateBody({ title: 'T', mini_goals: GOALS, chat_id: bad })
    assert.equal(built.ok, false, `chat_id ${JSON.stringify(bad)} must be refused`)
    if (built.ok) continue
    assert.match(built.error, /chat_id/, 'the error must name the field the agent has to fix')
  }
})

test('an empty or absent chat reads as "the main chat", not as a mistake to shout about', () => {
  for (const blank of ['', null, undefined]) {
    const built = buildMissionCreateBody({ title: 'T', mini_goals: GOALS, chat_id: blank })
    assert.ok(built.ok, `chat_id ${JSON.stringify(blank)} must read as absent`)
    assert.ok(!('chatId' in built.body))
  }
})

test('the active path is byte identical to today when no chat is named', () => {
  const path = buildMissionActivePath(7)
  assert.ok(path.ok)
  assert.equal(path.path, 'assistants/7/missions/active')
})

test('a named chat is appended as a query, so each chat gets its own ETag cache key', () => {
  const withChat = buildMissionActivePath(7, '4403')
  assert.ok(withChat.ok)
  assert.equal(withChat.path, 'assistants/7/missions/active?chatId=4403')

  const other = buildMissionActivePath(7, 5510)
  assert.ok(other.ok)
  assert.equal(other.path, 'assistants/7/missions/active?chatId=5510')
  assert.notEqual(withChat.path, other.path)
})

test('a junk chat on the read is ignored rather than fatal: the agent still gets its main chat mission', () => {
  for (const bad of ['abc', 0, -1, null, undefined]) {
    const path = buildMissionActivePath(7, bad as never)
    assert.ok(path.ok)
    assert.equal(path.path, 'assistants/7/missions/active')
  }
})

// ── which chat an IMPLICIT mission create lands in ────────────────────────
//
// The backend refuses a mission in any chat that is not one of the OWNER's own
// DMs with this agent: a room is refused because a mission is one agent's
// promise and a room has many, and a chat belonging to somebody else is
// refused because the card would be planted in their chat. When the agent
// names no chat, the daemon must not hand the backend a chat it is about to
// refuse: an implicit source that cannot be used is skipped, and when nothing
// is left the answer is null, which MEANS the agent's main chat and is exactly
// what a single chat agent has always got.

const OWNER = 'user_owner'
const NO_ROOMS = () => false
const NO_INBOUND = () => null

test('the turn chat is used when it is one of the owner own chats', () => {
  const chosen = pickImplicitMissionChat({
    turnChatId: '4403',
    monitoredChatIds: ['1000', '4403'],
    ownerUserId: OWNER,
    isRoom: NO_ROOMS,
    lastInboundUserId: () => OWNER,
  })
  assert.equal(chosen, '4403')
})

test('a room is never chosen implicitly, and the search moves on to a chat that works', () => {
  const rooms = new Set(['9001'])
  const chosen = pickImplicitMissionChat({
    turnChatId: '9001',
    monitoredChatIds: ['9001', '4403'],
    ownerUserId: OWNER,
    isRoom: (id) => rooms.has(id),
    lastInboundUserId: NO_INBOUND,
  })
  assert.equal(chosen, '4403', 'a meeting chat would be refused by the create route')
})

test('a chat whose last inbound came from somebody else is never chosen implicitly', () => {
  // A share recipient's DM with a shared agent belongs to the RECIPIENT, so a
  // mission planted there is the one thing stage 3 recorded as a real security
  // finding, and the create route refuses it.
  const senders = new Map([['7788', 'user_recipient'], ['4403', OWNER]])
  const chosen = pickImplicitMissionChat({
    turnChatId: '7788',
    monitoredChatIds: ['7788', '4403'],
    ownerUserId: OWNER,
    isRoom: NO_ROOMS,
    lastInboundUserId: (id) => senders.get(id) ?? null,
  })
  assert.equal(chosen, '4403')
})

test('when nothing is acceptable the answer is null, which means the agent main chat', () => {
  const senders = new Map([['7788', 'user_recipient']])
  const chosen = pickImplicitMissionChat({
    turnChatId: '9001',
    monitoredChatIds: ['9001', '7788'],
    ownerUserId: OWNER,
    isRoom: (id) => id === '9001',
    lastInboundUserId: (id) => senders.get(id) ?? null,
  })
  assert.equal(chosen, null, 'null is the main chat, not a refusal')
})

test('a single chat agent is unchanged: its one chat is the answer', () => {
  const chosen = pickImplicitMissionChat({
    turnChatId: null,
    monitoredChatIds: ['4403'],
    ownerUserId: OWNER,
    isRoom: NO_ROOMS,
    lastInboundUserId: NO_INBOUND,
  })
  assert.equal(chosen, '4403')
  // And with nothing monitored at all, still the main chat.
  assert.equal(
    pickImplicitMissionChat({
      turnChatId: null,
      monitoredChatIds: [],
      ownerUserId: OWNER,
      isRoom: NO_ROOMS,
      lastInboundUserId: NO_INBOUND,
    }),
    null,
  )
})

test('a chat with no inbound seen is not refused for that: silence is not somebody else', () => {
  // A proactive create in a chat this process has only ever written to must
  // keep working; the daemon knows nothing bad about it.
  const chosen = pickImplicitMissionChat({
    turnChatId: '4403',
    monitoredChatIds: ['4403'],
    ownerUserId: OWNER,
    isRoom: NO_ROOMS,
    lastInboundUserId: () => undefined,
  })
  assert.equal(chosen, '4403')
})

test('a blank turn chat falls through to the monitored list rather than becoming a chat id', () => {
  for (const blank of [null, undefined, '', '   ']) {
    const chosen = pickImplicitMissionChat({
      turnChatId: blank,
      monitoredChatIds: ['4403'],
      ownerUserId: OWNER,
      isRoom: NO_ROOMS,
      lastInboundUserId: NO_INBOUND,
    })
    assert.equal(chosen, '4403', `turn chat ${JSON.stringify(blank)} must read as absent`)
  }
})
