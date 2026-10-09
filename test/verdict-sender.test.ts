/**
 * The not responding verdict goes out AT ONCE, and so does its clearing (HOAI
 * board row 9c3d6b2c, rollout step 3). Before, the verdict rode the next 6
 * hourly heartbeat. lib/verdict-sender.ts decides when to send; server.ts
 * reads the verdict through currentUnresponsiveError and sends through the
 * heartbeat's sendNow (test/session-status-wiring.test.ts pins that wiring).
 *
 * Run: npx tsx --test test/verdict-sender.test.ts
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import { createVerdictSender } from '../lib/verdict-sender.ts'

function harness(holder = true) {
  let verdict = false
  let isHolder = holder
  const sent: boolean[] = []
  const logged: string[] = []
  const sweep = createVerdictSender({
    read: () => verdict,
    isHolder: () => isHolder,
    send: () => sent.push(verdict),
    log: (line) => logged.push(line),
  })
  return {
    sweep,
    sent,
    logged,
    set: (v: boolean) => {
      verdict = v
    },
    holder: (h: boolean) => {
      isHolder = h
    },
  }
}

test('sends once when the verdict is reached, and once when it clears', () => {
  const h = harness()
  h.sweep()
  assert.deepEqual(h.sent, [], 'a healthy session sends nothing')
  h.set(true)
  h.sweep()
  h.sweep()
  assert.deepEqual(h.sent, [true], 'reached: sent at once, and not again')
  h.set(false)
  h.sweep()
  h.sweep()
  assert.deepEqual(h.sent, [true, false], 'cleared: sent at once, and not again')
  assert.equal(h.logged.length, 2)
})

test('a daemon that is not the pairing lock holder never sends (review finding 10)', () => {
  const h = harness(false)
  h.set(true)
  h.sweep()
  assert.deepEqual(h.sent, [])
  h.holder(true)
  h.sweep()
  assert.deepEqual(h.sent, [true], 'once it holds the lock, the verdict goes')
})

test('never throws, whatever the reading or the send does', () => {
  const sweep = createVerdictSender({
    read: () => {
      throw new Error('state exploded')
    },
    isHolder: () => true,
    send: () => {
      throw new Error('network exploded')
    },
    log: () => {},
  })
  assert.doesNotThrow(() => sweep())
  let reading = false
  const sends = createVerdictSender({
    read: () => (reading = !reading),
    isHolder: () => true,
    send: () => {
      throw new Error('network exploded')
    },
    log: () => {},
  })
  assert.doesNotThrow(() => sends())
})
