import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  OPEN_CARD_WATCH_INTERVAL_MS,
  OPEN_CARD_WATCH_MAX_READS,
  dueOpenCardReads,
} from '../lib/open-cards.ts'

// A TAP ON A CARD IN A CHAT THE POLL DOES NOT WATCH STILL HAS A SECOND ROUTE.
//
// The poll reads only the chats whose agent is this one. A card this agent
// posts in a channel or room someone else's agent founded is read once right
// after the post and then only the stream would bring its answer: when the
// stream silently missed one, the tap was lost. Every open card this daemon
// posted in such a chat is now read again about once a minute, by its exact id,
// until it is answered (then it settles) or ages out of the open card list.
//
// No em or en dashes in this file.

const NOW = Date.parse('2026-11-25T12:00:00Z')
const card = (id: number, chatId: string, settled = false) => ({ id, chatId, settled })

test('an open card in a chat the poll does not watch is read again once its interval has passed', () => {
  const lastReadAt = new Map([[7, NOW - OPEN_CARD_WATCH_INTERVAL_MS]])
  assert.deepEqual(dueOpenCardReads({ cards: [card(7, '900')], monitored: new Set(['501']), lastReadAt, nowMs: NOW }), [card(7, '900')])
})

test('not before its interval', () => {
  const lastReadAt = new Map([[7, NOW - OPEN_CARD_WATCH_INTERVAL_MS + 1]])
  assert.deepEqual(dueOpenCardReads({ cards: [card(7, '900')], monitored: new Set(), lastReadAt, nowMs: NOW }), [])
})

test('a card never read by the watch is due at once', () => {
  assert.deepEqual(dueOpenCardReads({ cards: [card(7, '900')], monitored: new Set(), lastReadAt: new Map(), nowMs: NOW }), [card(7, '900')])
})

test("a card in a chat the poll watches is the poll's, and a settled card is nobody's", () => {
  assert.deepEqual(dueOpenCardReads({ cards: [card(7, '501'), card(8, '900', true)], monitored: new Set(['501']), lastReadAt: new Map(), nowMs: NOW }), [])
})

test('at most a bounded number of reads per tick, the least recently read first', () => {
  const cards = Array.from({ length: OPEN_CARD_WATCH_MAX_READS + 5 }, (_, i) => card(100 + i, '900'))
  const lastReadAt = new Map(cards.map((c, i) => [c.id, NOW - OPEN_CARD_WATCH_INTERVAL_MS - i]))
  const due = dueOpenCardReads({ cards, monitored: new Set(), lastReadAt, nowMs: NOW })
  assert.equal(due.length, OPEN_CARD_WATCH_MAX_READS)
  assert.equal(due[0].id, 100 + OPEN_CARD_WATCH_MAX_READS + 4, 'the longest unread goes first')
})

test('the daemon runs the watch on its poll tick, through the exact card read', () => {
  const source = readFileSync(new URL('../server.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  const start = source.indexOf('\nfunction watchOpenCards(')
  assert.ok(start > 0, 'watchOpenCards exists')
  const body = source.slice(start, source.indexOf('\n}\n', start))
  assert.match(body, /dueOpenCardReads\(/)
  assert.match(body, /monitored: new Set\(monitoredChatIds\)/)
  assert.match(body, /readPostedButtonCard\(/)
  assert.match(source, /\n {8}watchOpenCards\(Date\.now\(\)\)\n/, 'called on the poll tick')
})
