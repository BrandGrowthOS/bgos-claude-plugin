/**
 * lib/room-seats.ts: the seat answer admits only groups and channels, by a
 * positive whole id, and nothing else.
 *
 * Run with: npx tsx --test test/room-seats.test.ts
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { seatChatsFrom, seatsRouteMissing } from '../lib/room-seats.ts'

describe('seatChatsFrom', () => {
  test('a group and a channel are admitted, as string ids, in order', () => {
    assert.deepEqual(
      seatChatsFrom({ chats: [{ id: 33503, kind: 'room' }, { id: '33600', kind: 'channel' }] }),
      [{ chatId: '33503', kind: 'room' }, { chatId: '33600', kind: 'channel' }],
    )
  })

  test('every other kind is dropped: the seat door never admits a main, side thread, meeting or email chat', () => {
    for (const kind of ['main', 'a2a', 'meeting', 'group', 'email', '', 'ROOM', undefined, null, 3]) {
      assert.deepEqual(seatChatsFrom({ chats: [{ id: 5, kind }] }), [], `kind ${String(kind)}`)
    }
  })

  test('an id that is not a positive whole number is dropped', () => {
    for (const id of [0, -4, 1.5, '12a', '', ' ', null, undefined, {}, [], '007', 'NaN', Number.NaN, '1e3']) {
      assert.deepEqual(seatChatsFrom({ chats: [{ id, kind: 'room' }] }), [], `id ${JSON.stringify(id)}`)
    }
    // The positive control in the same shape.
    assert.deepEqual(seatChatsFrom({ chats: [{ id: ' 7 ', kind: 'room' }] }), [{ chatId: '7', kind: 'room' }])
  })

  test('a repeat is listed once', () => {
    assert.deepEqual(seatChatsFrom({ chats: [{ id: 9, kind: 'room' }, { id: '9', kind: 'room' }] }), [{ chatId: '9', kind: 'room' }])
  })

  test('a malformed answer admits nothing and never throws', () => {
    for (const answer of [null, undefined, {}, { chats: null }, { chats: {} }, { chats: 'x' }, [], 'x', 3, { chats: [null, 1, 'x'] }]) {
      assert.deepEqual(seatChatsFrom(answer), [], JSON.stringify(answer))
    }
  })
})

describe('seatsRouteMissing', () => {
  test('a 404 from bgosPeerGet is a backend without the route', () => {
    assert.equal(seatsRouteMissing(new Error('GET 404: Cannot GET /api/v1/peers/seats')), true)
  })
  test('anything else is a real failure', () => {
    for (const err of [new Error('GET 500: boom'), new Error('GET 403: forbidden'), new Error('fetch failed'), 'GET 4040']) {
      assert.equal(seatsRouteMissing(err), false, String(err))
    }
  })
})
