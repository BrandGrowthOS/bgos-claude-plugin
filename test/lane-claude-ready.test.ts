/**
 * PERSON LANES, when the lane daemon may hand Claude a turn
 * (lib/lane-daemon.ts LaneClaudeReady; mission 161 goal 9, 0.71.1).
 *
 * Claude Code 2.1.302 puts a server's tools into its tool pool on a 16 ms
 * batch after the server connects, and a turn built before that has no
 * `reply` for the rest of the session. So the daemon holds every turn until:
 *   - Claude asked for the tool list (the handshake alone is not enough);
 *   - a ping sent AFTER that answer came back (Claude read the answer), or
 *     failed or took too long;
 *   - the settle (2 s, over a hundred times the batch) passed after that.
 * A Claude that never asks for the list still gets its turns after 30 s, the
 * CLI's own MCP connect timeout, so a turn is never held forever.
 *
 * test/lane-first-turn.test.ts holds the same rule end to end, on the real
 * lane daemon.
 *
 * Run with: npx tsx --test test/lane-claude-ready.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  LaneClaudeReady,
  LANE_CLAUDE_PING_TIMEOUT_MS,
  LANE_CLAUDE_READY_MAX_MS,
  LANE_CLAUDE_SETTLE_MS,
} from '../lib/lane-daemon.ts'

/** A clock the test moves by hand. */
function fakeClock() {
  let now = 0
  let timers: Array<{ at: number; fn: () => void }> = []
  const flush = async () => { for (let i = 0; i < 10; i += 1) await Promise.resolve() }
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number) => { timers.push({ at: now + ms, fn }) },
    async advance(ms: number) {
      const end = now + ms
      await flush()
      for (;;) {
        const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0]
        if (!due) break
        timers = timers.filter((t) => t !== due)
        now = due.at
        due.fn()
        await flush()
      }
      now = end
      await flush()
    },
  }
}

function rig(ping: () => Promise<unknown> = async () => ({})) {
  const clock = fakeClock()
  const logs: string[] = []
  let pings = 0
  const ready = new LaneClaudeReady({
    ping: () => { pings += 1; return ping() },
    setTimer: clock.setTimer,
    log: (line) => logs.push(line),
  })
  let released = false
  const watch = () => { void ready.whenReady().then(() => { released = true }) }
  return { clock, logs, ready, watch, released: () => released, pings: () => pings }
}

test('the measured numbers: a 2 s settle, a 5 s ping limit, and 30 s for a Claude that never lists', () => {
  assert.equal(LANE_CLAUDE_SETTLE_MS, 2_000)
  assert.equal(LANE_CLAUDE_PING_TIMEOUT_MS, 5_000)
  assert.equal(LANE_CLAUDE_READY_MAX_MS, 30_000)
})

test('no turn before Claude asked for the tool list, however long the handshake has been done', async () => {
  const r = rig()
  r.ready.start()
  r.watch()
  await r.clock.advance(LANE_CLAUDE_READY_MAX_MS - 1)
  assert.equal(r.released(), false)
  assert.equal(r.ready.isReady, false)
  assert.equal(r.pings(), 0, 'no probe before the list')
})

test('after the list: the ping goes out after the answer, and the turn only a full settle after the ping came back', async () => {
  const r = rig()
  r.ready.start()
  r.watch()
  r.ready.noteToolsListed()
  // Inside the tools/list handler the answer has not been written yet, so a
  // ping sent here would reach Claude BEFORE the answer.
  assert.equal(r.pings(), 0, 'the ping waits for the answer to go out first')
  await r.clock.advance(0)
  assert.equal(r.pings(), 1)
  await r.clock.advance(LANE_CLAUDE_SETTLE_MS - 1)
  assert.equal(r.released(), false, 'still settling')
  await r.clock.advance(1)
  assert.equal(r.released(), true)
  assert.equal(r.ready.isReady, true)
  assert.deepEqual(r.logs, [], 'the normal path logs nothing')
})

test('the settle starts when the ping came back, not when it was sent', async () => {
  let answer: () => void = () => {}
  const r = rig(() => new Promise<void>((resolve) => { answer = resolve }))
  r.ready.start()
  r.watch()
  r.ready.noteToolsListed()
  await r.clock.advance(1_500)
  answer()
  await r.clock.advance(LANE_CLAUDE_SETTLE_MS - 1)
  assert.equal(r.released(), false)
  await r.clock.advance(1)
  assert.equal(r.released(), true)
})

test('a ping that fails or never comes back: the settle still runs, after the ping limit at most', async () => {
  const failing = rig(async () => { throw new Error('no ping here') })
  failing.ready.start()
  failing.watch()
  failing.ready.noteToolsListed()
  await failing.clock.advance(LANE_CLAUDE_SETTLE_MS - 1)
  assert.equal(failing.released(), false)
  await failing.clock.advance(1)
  assert.equal(failing.released(), true)
  assert.ok(failing.logs.some((l) => /ping/.test(l)), 'the failed ping is logged')

  const silent = rig(() => new Promise(() => {}))
  silent.ready.start()
  silent.watch()
  silent.ready.noteToolsListed()
  await silent.clock.advance(LANE_CLAUDE_PING_TIMEOUT_MS + LANE_CLAUDE_SETTLE_MS - 1)
  assert.equal(silent.released(), false)
  await silent.clock.advance(1)
  assert.equal(silent.released(), true)
})

test('a Claude that never lists the tools still gets its turns after 30 s, and it is logged', async () => {
  const r = rig()
  r.ready.start()
  r.watch()
  await r.clock.advance(LANE_CLAUDE_READY_MAX_MS)
  assert.equal(r.released(), true)
  assert.ok(r.logs.some((l) => /did not ask for the tool list/.test(l)))
})

test('ready stays ready: a later list probes nothing, and every later turn goes at once', async () => {
  const r = rig()
  r.ready.start()
  r.ready.noteToolsListed()
  await r.clock.advance(LANE_CLAUDE_SETTLE_MS)
  assert.equal(r.ready.isReady, true)
  r.ready.noteToolsListed()
  await r.clock.advance(LANE_CLAUDE_SETTLE_MS)
  assert.equal(r.pings(), 1)
  let now = false
  void r.ready.whenReady().then(() => { now = true })
  await Promise.resolve()
  assert.equal(now, true)
})

test('every turn waiting is released together, in the order it waited', async () => {
  const r = rig()
  r.ready.start()
  const order: number[] = []
  for (const n of [1, 2, 3]) void r.ready.whenReady().then(() => { order.push(n) })
  r.ready.noteToolsListed()
  await r.clock.advance(LANE_CLAUDE_SETTLE_MS)
  assert.deepEqual(order, [1, 2, 3])
})
