import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  OPEN_CARD_MAX_AGE_MS,
  OPEN_CARD_WATCH_FIRST_MS,
  OPEN_CARD_WATCH_MAX_MS,
  OPEN_CARD_WATCH_MAX_READS,
  createOpenCardWatch,
  readFailureStatus,
} from '../lib/open-cards.ts'

// A TAP ON A CARD IN A CHAT THE POLL DOES NOT WATCH STILL HAS A SECOND ROUTE,
// AND THAT ROUTE CANNOT HAMMER THE SERVER (review of #417, R3).
//
// Each open card this daemon posted in a chat outside the poll's watch is read
// again by its exact id: first after a random part of a minute (so a fleet that
// restarts together does not read together), then at 1, 2, 4 ... minutes, at
// most every 30, and never once the card is older than the open card file keeps
// (7 days). A 429 or a 5xx pauses every read, the pause doubling while they last.
// At most 10 reads a tick, the longest waiting first. A card read back at boot
// gets its one read through the same budget, wherever its chat is.
//
// No em or en dashes in this file.

const NOW = Date.parse('2026-11-25T12:00:00Z')
const card = (id: number, chatId = '900', over: Partial<{ postedAtMs: number; settled: boolean; rehydrated: boolean }> = {}) => ({
  id, chatId, postedAtMs: NOW - 60_000, settled: false, rehydrated: false, ...over,
})
const input = (cards: ReturnType<typeof card>[], nowMs: number, over: Partial<{ monitored: Set<string>; unmonitoredAllowed: boolean }> = {}) => ({
  cards, nowMs, monitored: over.monitored ?? new Set(['501']), unmonitoredAllowed: over.unmonitoredAllowed ?? true,
})

test('a card is first read after a random part of a minute, never at once', () => {
  const watch = createOpenCardWatch({ random: () => 0.5 })
  assert.deepEqual(watch.due(input([card(7)], NOW)).map((c) => c.id), [], 'seen now, scheduled')
  assert.deepEqual(watch.due(input([card(7)], NOW + OPEN_CARD_WATCH_FIRST_MS * 0.5 - 1)).map((c) => c.id), [])
  assert.deepEqual(watch.due(input([card(7)], NOW + OPEN_CARD_WATCH_FIRST_MS * 0.5)).map((c) => c.id), [7])
})

test('the wait doubles after each read and stops growing at 30 minutes', () => {
  const watch = createOpenCardWatch({ random: () => 0 })
  let t = NOW
  watch.due(input([card(7)], t))
  const waits: number[] = []
  for (let i = 0; i < 8; i++) {
    const [due] = watch.due(input([card(7)], t))
    assert.equal(due?.id, 7)
    watch.noteRead(7, t)
    let next = t + 1
    while (watch.due(input([card(7)], next)).length === 0) next += 1000
    waits.push(Math.round((next - t) / 1000) * 1000)
    t = next
  }
  assert.deepEqual(waits.slice(0, 5), [60_000, 120_000, 240_000, 480_000, 960_000])
  assert.equal(Math.max(...waits), OPEN_CARD_WATCH_MAX_MS)
})

test('a card older than the file keeps is never read again', () => {
  const watch = createOpenCardWatch({ random: () => 0 })
  const old = card(7, '900', { postedAtMs: NOW - OPEN_CARD_MAX_AGE_MS - 1 })
  watch.due(input([old], NOW))
  assert.deepEqual(watch.due(input([old], NOW + 10 * OPEN_CARD_WATCH_MAX_MS)), [])
})

test('a 429 or a 5xx pauses every read, the pause doubling; a success ends it', () => {
  const watch = createOpenCardWatch({ random: () => 0 })
  watch.due(input([card(7), card(8)], NOW))
  watch.noteFailure(429, NOW)
  assert.deepEqual(watch.due(input([card(7), card(8)], NOW + 59_000)), [])
  assert.equal(watch.due(input([card(7), card(8)], NOW + 60_000)).length, 2)
  watch.noteFailure(503, NOW + 60_000)
  assert.deepEqual(watch.due(input([card(7), card(8)], NOW + 60_000 + 119_000)), [], 'second pause is two minutes')
  watch.noteSuccess()
  watch.noteFailure(500, NOW + 300_000)
  assert.equal(watch.due(input([card(7), card(8)], NOW + 360_000)).length, 2, 'back to one minute after a success')
  watch.noteFailure(404, NOW + 400_000)
  assert.equal(watch.due(input([card(7), card(8)], NOW + 400_001)).length, 2, 'a 404 pauses nothing')
})

test('at most 10 reads a tick, the longest waiting first', () => {
  const watch = createOpenCardWatch({ random: () => 0 })
  const cards = Array.from({ length: OPEN_CARD_WATCH_MAX_READS + 5 }, (_, i) => card(100 + i))
  watch.due(input(cards, NOW))
  const first = watch.due(input(cards, NOW))
  assert.equal(first.length, OPEN_CARD_WATCH_MAX_READS)
  for (const c of first) watch.noteRead(c.id, NOW)
  const second = watch.due(input(cards, NOW + 1))
  assert.deepEqual(second.map((c) => c.id), [110, 111, 112, 113, 114])
})

test("a monitored chat's card is the poll's, a settled card nobody's, and with group lanes on an unmonitored chat is the group lane's", () => {
  const watch = createOpenCardWatch({ random: () => 0 })
  const cards = [card(7, '501'), card(8, '900', { settled: true }), card(9, '900')]
  watch.due(input(cards, NOW))
  assert.deepEqual(watch.due(input(cards, NOW)).map((c) => c.id), [9])
  assert.deepEqual(watch.due(input(cards, NOW, { unmonitoredAllowed: false })).map((c) => c.id), [])
})

test('a card read back at boot gets one read through the budget, wherever its chat is', () => {
  const watch = createOpenCardWatch({ random: () => 0 })
  const back = card(7, '501', { rehydrated: true })
  watch.due(input([back], NOW))
  assert.deepEqual(watch.due(input([back], NOW)).map((c) => c.id), [7])
  watch.noteRead(7, NOW)
  assert.deepEqual(watch.due(input([{ ...back, rehydrated: false }], NOW + OPEN_CARD_WATCH_MAX_MS)), [], 'then it is the poll\'s')
})

test("a failed read's status is read from the error the client throws", () => {
  assert.equal(readFailureStatus(new Error('GET 429: slow down')), 429)
  assert.equal(readFailureStatus(new Error('GET 503: upstream')), 503)
  assert.equal(readFailureStatus(new Error('socket hang up')), null)
  assert.equal(readFailureStatus('nope'), null)
})

test('the daemon runs the watch on its poll tick, through the exact card read', () => {
  const source = readFileSync(new URL('../server.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  const start = source.indexOf('\nfunction watchOpenCards(')
  assert.ok(start > 0, 'watchOpenCards exists')
  const body = source.slice(start, source.indexOf('\n}\n', start))
  assert.match(body, /openCardWatch\.due\(/)
  assert.match(body, /monitored: new Set\(monitoredChatIds\)/)
  assert.match(body, /unmonitoredAllowed: !groupLanesOn\(\)/)
  assert.match(body, /readPostedButtonCard\(/)
  assert.match(source, /\n {8}watchOpenCards\(Date\.now\(\)\)\n/, 'called on the poll tick')
})

test('F4: a burst of failures in one tick is one pause step, not one per read', () => {
  const watch = createOpenCardWatch({ random: () => 0 })
  const cards = Array.from({ length: OPEN_CARD_WATCH_MAX_READS }, (_, i) => card(100 + i))
  watch.due(input(cards, NOW))
  assert.equal(watch.due(input(cards, NOW)).length, OPEN_CARD_WATCH_MAX_READS)
  for (let i = 0; i < OPEN_CARD_WATCH_MAX_READS; i++) watch.noteFailure(429, NOW + i)
  assert.deepEqual(watch.due(input(cards, NOW + 59_000)), [], 'paused for the first step')
  assert.ok(watch.due(input(cards, NOW + 61_000)).length > 0, 'one minute, not the 30 minute cap')
})
