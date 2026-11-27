/**
 * One reading of a card's row id, wherever it is read: the card post's
 * answer, the poll's row and the update stream's click. A row id is a
 * positive safe integer, written as a number or as its decimal digits;
 * anything else is no row. When the stream's envelope and its row both name
 * the card and disagree, the click names no row, so it settles nothing.
 *
 * Run with: npx tsx --test test/permission-card-row-id.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import * as relay from '../lib/permission-relay.ts'
import * as streamApply from '../lib/stream-apply.ts'

const SRC = readFileSync('server.ts', 'utf8')
const parse = (relay as Record<string, unknown>).parseCardRowId as ((value: unknown) => number | null) | undefined
const streamRow = (streamApply as Record<string, unknown>).streamCardRowId as ((update: unknown) => number | null) | undefined

const ROWS: Array<[unknown, number | null]> = [
  [501, 501],
  ['501', 501],
  [1, 1],
  [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
  [0, null],
  [-3, null],
  [1.5, null],
  ['1.5', null],
  ['-3', null],
  ['0501', null],
  [' 501', null],
  ['501 ', null],
  ['', null],
  ['0x1f5', null],
  ['5e2', null],
  [Number.NaN, null],
  [Number.POSITIVE_INFINITY, null],
  [2 ** 53, null],
  [String(2 ** 53), null],
  [true, null],
  [null, null],
  [undefined, null],
  [{}, null],
  [[501], null],
]

test('one parser reads a row id: a positive safe integer, or its decimal digits', () => {
  assert.ok(parse, 'lib/permission-relay.ts exports parseCardRowId')
  for (const [value, expected] of ROWS) assert.equal(parse!(value), expected, `row id ${JSON.stringify(value) ?? String(value)}`)
})

test('the card post is read with the same parser', () => {
  for (const [value, expected] of ROWS) {
    assert.equal(relay.cardMessageIdFrom({ id: value }), expected, `posted id ${JSON.stringify(value) ?? String(value)}`)
  }
  assert.equal(relay.cardMessageIdFrom(null), null)
  assert.equal(relay.cardMessageIdFrom('501'), null)
})

test('the click resolver reads the clicked row with the same parser', () => {
  for (const [value, expected] of ROWS) {
    const answered: string[] = []
    const pending = new Map([['abcde', { requesterUserId: 'owner', cardMessageId: 501, resolve: (c: string) => answered.push(c) }]])
    const outcome = relay.resolvePermissionClick({
      callbackData: 'ea:once:abcde',
      clickerUserId: 'owner',
      pending: pending as never,
      cardMessageId: value,
    })
    assert.equal(outcome.kind, expected === 501 ? 'resolved' : 'other_card', `clicked row ${JSON.stringify(value) ?? String(value)}`)
  }
})

test('stream: the click names its row only when the envelope and the row agree', () => {
  assert.ok(streamRow, 'lib/stream-apply.ts exports streamCardRowId')
  const update = (envelope: unknown, row: Record<string, unknown> | null) =>
    ({ messageId: envelope, chatId: '10', payload: row === null ? {} : { message: row } }) as never
  assert.equal(streamRow!(update(501, { id: 501 })), 501, 'both name the card')
  assert.equal(streamRow!(update('501', { id: 501 })), 501, 'digits and number are one row')
  assert.equal(streamRow!(update(501, null)), 501, 'the envelope alone')
  assert.equal(streamRow!(update(undefined, { id: 501 })), 501, 'the row alone')
  assert.equal(streamRow!(update(undefined, { messageId: '501' })), 501)
  assert.equal(streamRow!(update(501, { id: 777 })), null, 'two different rows name no row')
  assert.equal(streamRow!(update(501, { id: 501, messageId: 777 })), null, 'two different ids in the row name no row')
  assert.equal(streamRow!(update(501, { id: 1.5 })), null, 'a malformed id is not ignored in favour of the other')
  assert.equal(streamRow!(update(1.5, { id: 501 })), null)
  assert.equal(streamRow!(update(undefined, null)), null)
  // The flat live push shape.
  assert.equal(streamRow!({ messageId: 501, payload: { messageId: 501, text: 'x' } } as never), 501)
  assert.equal(streamRow!({ messageId: 501, payload: { messageId: 777, text: 'x' } } as never), null)
})

test('server.ts: the stream click hands the resolver the agreed row, and the poll its row as read', () => {
  const stream = SRC.slice(SRC.indexOf('resolvePermissionClick({', SRC.indexOf("  if (decision === 'permission') {")))
  assert.match(stream.slice(0, stream.indexOf('})')), /cardMessageId: streamCardRowId\(update\),/)
  const poll = SRC.slice(SRC.indexOf('const permOutcome = resolvePermissionClick({'))
  assert.match(poll.slice(0, poll.indexOf('})')), /cardMessageId: mm\.id,/)
})

test('server.ts: a post with no id says that no click can settle the request', () => {
  const relaySource = SRC.slice(SRC.indexOf('function relayPermissionToOwner('), SRC.indexOf('\n/**\n * A request the hard floor matched'))
  assert.match(relaySource, /no ` \+\n\s*`click on the card can settle this request/)
  assert.doesNotMatch(relaySource, /only a click ` \+\n\s*`or the local backstop can end it/)
})
