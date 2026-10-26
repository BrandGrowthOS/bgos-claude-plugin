/**
 * Round 3 review M2: the model and effort control's lock held back only the
 * message deliveries (deliverInbound); a voice consult, a voice dispatch, a
 * meeting card, a mission notice, a button click or a nudge reached the CLI
 * through mcp.notification directly and could open a turn between the typed
 * literal and the Enter. server.ts now wraps mcp.notification once with
 * holdChannelCardsWhileBusy (lib/model-effort-control.ts).
 *
 * The wake card contract (the harness silently drops a channel card whose
 * meta holds a non string): the hold sends the SAME object it was given, so a
 * card's all string meta is never touched.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { CHANNEL_CARD_METHOD, holdChannelCardsWhileBusy } from '../lib/model-effort-control.ts'

const server = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'server.ts'), 'utf8')

type Card = { method: string; params: { content: string; meta: Record<string, string> } }

function lock() {
  let waiters: Array<() => void> = []
  const l = {
    busy: false,
    whenIdle: () => (l.busy ? new Promise<void>((r) => waiters.push(r)) : Promise.resolve()),
    release: () => {
      l.busy = false
      const w = waiters
      waiters = []
      for (const r of w) r()
    },
  }
  return l
}

const card = (): Card => ({
  method: CHANNEL_CARD_METHOD,
  params: { content: '[voice_consult] hi', meta: { chat_id: '9', message_id: '42', user_id: 'u', ts: '2026-10-26T00:00:00.000Z' } },
})

const tick = () => new Promise((r) => setImmediate(r))

test('the method held is the channel card\'s', () => {
  assert.equal(CHANNEL_CARD_METHOD, 'notifications/claude/channel')
})

test('a channel card waits while a change is in flight, then goes out as the same object', async () => {
  const l = lock()
  const sent: Card[] = []
  const send = holdChannelCardsWhileBusy(l, async (n: Card) => { sent.push(n) })
  l.busy = true
  const c = card()
  const pending = send(c)
  await tick()
  assert.equal(sent.length, 0, 'held while busy')
  l.release()
  await pending
  assert.equal(sent.length, 1)
  assert.equal(sent[0], c, 'the very object: meta untouched')
  for (const [k, v] of Object.entries(sent[0]!.params.meta)) assert.equal(typeof v, 'string', `meta.${k}`)
})

test('a card waits again when a second change takes the lock first', async () => {
  const l = lock()
  const sent: Card[] = []
  const send = holdChannelCardsWhileBusy(l, async (n: Card) => { sent.push(n) })
  l.busy = true
  // The second change was waiting too, and its turn comes first.
  const w = l.whenIdle().then(() => { l.busy = true })
  const pending = send(card())
  l.release()
  await w
  await tick()
  assert.equal(sent.length, 0, 'still held by the second change')
  l.release()
  await pending
  assert.equal(sent.length, 1)
})

test('with no change in flight a card is sent at once; other methods are never held', async () => {
  const l = lock()
  const sent: string[] = []
  const send = holdChannelCardsWhileBusy(l, async (n: { method: string }) => { sent.push(n.method) })
  await send(card())
  l.busy = true
  await send({ method: 'notifications/claude/channel/permission' })
  assert.deepEqual(sent, [CHANNEL_CARD_METHOD, 'notifications/claude/channel/permission'])
})

test('server.ts installs the hold OUTERMOST, after the private turn record, with the control\'s lock', () => {
  const assignments = [...server.matchAll(/^mcp\.notification = (.*)$/gm)]
  assert.equal(assignments.length, 2, 'the private turn record and the hold, never stacked twice')
  assert.match(assignments[0]![1]!, /^\(\(notification/, 'the private turn record first')
  assert.equal(assignments[1]![1], 'holdChannelCardsWhileBusy(modelEffortControl, mcp.notification.bind(mcp))', 'the hold last, so it runs first')
  assert.ok(server.indexOf('const modelEffortControl: ModelEffortControl = new ModelEffortControl(') < assignments[1]!.index!, 'the lock exists first')
})
