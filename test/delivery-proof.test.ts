/**
 * The delivery proof's rules (lib/delivery-proof.ts): what counts as a message
 * the session is owed, and when one that has not reached it means something.
 * The daemon around it runs in test/canary-delivery.e2e.test.ts.
 *
 * Run: npx tsx --test test/delivery-proof.test.ts
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { createDeliveryProof, isOwedRow } from '../lib/delivery-proof.ts'

const GRACE = 180_000

function proof() {
  const clock = { now: 1_000_000 }
  return { clock, p: createDeliveryProof({ now: () => clock.now, graceMs: GRACE }) }
}
const owed = (id: number) => ({ id, owed: true })
const notOwed = (id: number) => ({ id, owed: false })

describe('when a message has waited too long', () => {
  test('a chat with no traffic never waits on anything, however long it stays quiet', () => {
    const { clock, p } = proof()
    p.noteRead('7', [])
    clock.now += 7 * GRACE
    p.noteRead('7', [])
    assert.equal(p.stuck(), null)
  })

  test('the first read of a chat only takes its tip: what was there on arrival is history', () => {
    const { clock, p } = proof()
    p.noteRead('7', [owed(50)])
    clock.now += 7 * GRACE
    assert.equal(p.stuck(), null)
    assert.deepEqual(p.waitingChats(), [])
  })

  test('a message nothing handed over is stuck at the grace and not a moment before', () => {
    const { clock, p } = proof()
    p.noteRead('7', [])
    p.noteRead('7', [owed(51)])
    clock.now += GRACE - 1
    assert.equal(p.stuck(), null)
    clock.now += 1
    assert.deepEqual(p.stuck(), { chatId: '7', messageId: 51, waitedMs: GRACE })
  })

  test('the grace counts from when the message was first seen, not from every read that sees it again', () => {
    const { clock, p } = proof()
    p.noteRead('7', [])
    p.noteRead('7', [owed(51)])
    clock.now += GRACE - 1
    p.noteRead('7', [owed(51)])
    clock.now += 1
    assert.equal(p.stuck()?.messageId, 51)
  })

  test('a message handed over is settled, before the read saw it and after', () => {
    const { clock, p } = proof()
    p.noteRead('7', [])
    p.noteHanded('7', 51)
    p.noteRead('7', [owed(51)])
    clock.now += 2 * GRACE
    assert.equal(p.stuck(), null, 'handed before the read saw it')
    p.noteRead('7', [owed(52)])
    clock.now += 2 * GRACE
    assert.equal(p.stuck()?.messageId, 52)
    p.noteHanded('7', 52)
    assert.equal(p.stuck(), null, 'handed after')
  })

  test('a later message handed over in the same chat clears an older one: the build delivers', () => {
    const { clock, p } = proof()
    p.noteRead('7', [])
    p.noteRead('7', [owed(51)])
    clock.now += 2 * GRACE
    assert.equal(p.stuck()?.messageId, 51)
    p.noteHanded('7', 60)
    assert.equal(p.stuck(), null)
  })

  test('a hand-off in another chat clears nothing here', () => {
    const { clock, p } = proof()
    p.noteRead('7', [])
    p.noteRead('8', [])
    p.noteRead('7', [owed(51)])
    p.noteHanded('8', 900)
    clock.now += GRACE
    assert.equal(p.stuck()?.chatId, '7')
  })

  test('a row the daemon settled without handing it over never waits, whichever came first', () => {
    const { clock, p } = proof()
    p.noteRead('7', [])
    p.noteSettled(51)
    p.noteRead('7', [owed(51)])
    p.noteRead('7', [owed(52)])
    p.noteSettled(52)
    clock.now += 2 * GRACE
    assert.equal(p.stuck(), null)
  })

  test('a row that is not owed is never waited on, and its id does not clear an older one', () => {
    const { clock, p } = proof()
    p.noteRead('7', [])
    p.noteRead('7', [owed(51), notOwed(52)])
    clock.now += GRACE
    assert.equal(p.stuck()?.messageId, 51)
    const fresh = proof()
    fresh.p.noteRead('7', [])
    fresh.p.noteRead('7', [notOwed(52)])
    fresh.clock.now += 2 * GRACE
    assert.equal(fresh.p.stuck(), null)
  })

  test('an answer above a message clears it: something handled it, as the poll reads a reply sent another way', () => {
    const { clock, p } = proof()
    p.noteRead('7', [])
    p.noteRead('7', [owed(51)])
    clock.now += 2 * GRACE
    assert.equal(p.stuck()?.messageId, 51)
    p.noteRead('7', [owed(51), { id: 52, owed: false, answer: true }])
    assert.equal(p.stuck(), null)
    p.noteRead('7', [{ id: 60, owed: false, answer: true }, owed(61)])
    clock.now += GRACE
    assert.equal(p.stuck()?.messageId, 61, 'an answer below a message says nothing about it')
  })

  test('the oldest message waiting is the one named', () => {
    const { clock, p } = proof()
    p.noteRead('7', [])
    p.noteRead('8', [])
    p.noteRead('7', [owed(51)])
    clock.now += 1000
    p.noteRead('8', [owed(10)])
    clock.now += GRACE
    assert.deepEqual(p.stuck(), { chatId: '7', messageId: 51, waitedMs: GRACE + 1000 })
  })

  test('standing down forgets everything: what another holder delivered is not this daemon\'s to answer for', () => {
    const { clock, p } = proof()
    p.noteRead('7', [])
    p.noteRead('7', [owed(51)])
    p.reset()
    clock.now += 2 * GRACE
    assert.equal(p.stuck(), null)
    assert.equal(p.readPath('7', 'u1'), 'chats/7/messages?userId=u1&limit=1', 'and the next read takes the tip again')
  })

  test('the settled record does not grow for ever', () => {
    const { clock, p } = proof()
    p.noteRead('7', [])
    for (let id = 1; id <= 20_000; id += 1) p.noteSettled(id)
    // The newest stay settled, and the oldest fell off.
    p.noteRead('7', [owed(20_000)])
    clock.now += 2 * GRACE
    assert.equal(p.stuck(), null)
    p.noteRead('7', [owed(20_001)])
    p.noteHanded('7', 20_001)
    const other = createDeliveryProof({ now: () => clock.now, graceMs: GRACE })
    other.noteRead('9', [])
    for (let id = 1; id <= 20_000; id += 1) other.noteSettled(id)
    other.noteRead('9', [owed(1)])
    clock.now += GRACE
    assert.equal(other.stuck()?.messageId, 1, 'the first settled id is long gone')
  })
})

describe('the read that says what the server holds', () => {
  test('asks for the tip once, and from then on only for what is above it', () => {
    const { p } = proof()
    assert.equal(p.readPath('7', 'u1'), 'chats/7/messages?userId=u1&limit=1')
    p.noteRead('7', [notOwed(40)])
    assert.equal(p.readPath('7', 'u1'), 'chats/7/messages?userId=u1&afterId=40')
  })

  test('a chat with no rows has no cursor to send: the route refuses an afterId of 0', () => {
    const { p } = proof()
    p.noteRead('7', [])
    assert.equal(p.readPath('7', 'u1'), 'chats/7/messages?userId=u1')
  })

  test('stays below a message still waiting, so it keeps being read until it is settled', () => {
    const { p } = proof()
    p.noteRead('7', [notOwed(40)])
    p.noteRead('7', [owed(45), notOwed(46)])
    assert.equal(p.readPath('7', 'u1'), 'chats/7/messages?userId=u1&afterId=44')
    p.noteHanded('7', 45)
    assert.equal(p.readPath('7', 'u1'), 'chats/7/messages?userId=u1&afterId=46')
  })

  test('a route that ignores the cursor adds nothing: rows at or below it are not new', () => {
    const { clock, p } = proof()
    p.noteRead('7', [owed(40)])
    p.noteRead('7', [owed(39), owed(40)])
    clock.now += 2 * GRACE
    assert.equal(p.stuck(), null)
  })

  test('names the chats with a message waiting, for the poll to read now', () => {
    const { p } = proof()
    p.noteRead('7', [])
    p.noteRead('8', [])
    p.noteRead('7', [owed(51)])
    assert.deepEqual(p.waitingChats(), ['7'])
  })
})

describe('what the session is owed', () => {
  const ctx = { assistantId: 42, ownerWordAwaited: false }
  const row = (over: Record<string, unknown> = {}) => ({ id: 1, sender: 'user', text: 'hello', ...over })

  test('an owner\'s message, a filled wake and another agent\'s message are owed', () => {
    assert.equal(isOwedRow(row(), null, ctx), true)
    assert.equal(isOwedRow(row({ sender: 'system', text: 'wake up', messageType: 'event' }), null, ctx), true)
    assert.equal(isOwedRow(row({ senderAssistantId: 947 }), { sourceAssistantId: 947, sourceName: 'Milba' }, ctx), true)
  })

  const NOT_OWED: Array<[string, Record<string, unknown>]> = [
    ['the agent\'s own answer', { sender: 'assistant' }],
    ['a row of an unknown sender', { sender: 'tool' }],
    ['a sent row this agent wrote itself', { senderAssistantId: 42 }],
    ['a wake whose body has not landed', { sender: 'system', text: '' }],
    ['an empty row', { text: '   ' }],
    ['a row with no text', { text: null }],
    ['a slash command the daemon answers', { text: '/status', messageType: 'slash_command' }],
    ['a structured slash command with no slash', { text: 'status', message_type: 'slash_command' }],
    ['slash text', { text: '  /compact' }],
    ['a permission verdict', { text: 'yes abcde' }],
    ['a row stamped for another person\'s lane', { lane: 'person:u2' }],
  ]
  for (const [name, over] of NOT_OWED) {
    test(`${name} is not owed`, () => {
      assert.equal(isOwedRow(row(over), null, ctx), false)
    })
  }

  test('its own agent-to-agent row is not owed', () => {
    assert.equal(isOwedRow(row(), { sourceAssistantId: 42, sourceName: 'Me', targetAssistantId: 947 }, ctx), false)
  })

  test('while the owner\'s word is awaited a plain row may be that answer, so it proves nothing', () => {
    assert.equal(isOwedRow(row({ text: 'go ahead' }), null, { ...ctx, ownerWordAwaited: true }), false)
  })
})
