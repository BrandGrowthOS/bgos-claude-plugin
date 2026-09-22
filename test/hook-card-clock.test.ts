/**
 * The wire body of one tool card: the turn's clock as ISO 8601, and the per
 * card output budget spent before EVERY write (stage 7, task C2).
 *
 * Why this is a module of its own and not a closure inside server.ts: the card
 * is written from two places, the 600 ms coalescer and the turn end, and the
 * property that matters is that BOTH go through the same builder. A builder
 * that only the daemon can reach is a builder only a source scan can check,
 * and a source scan cannot tell you what a running card actually puts on the
 * wire. test/hook-clock-wiring.test.ts holds the other half: that server.ts
 * really calls this from both paths, and with the hook's receipt time.
 *
 * Mutations these tests are proven against (task C2):
 *   - spend the budget only on a done card   -> the running card case goes red
 *   - send the epoch number, not the string  -> the ISO case goes red
 *   - emit startedAt: undefined when absent  -> the "absent means absent" case red
 *   - drop the range guard before toISOString -> the impossible clock case red
 *   - reuse the caller's rows array           -> the not mutated case goes red
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import { CARD_OUTPUT_BUDGET, type ToolRow } from '../lib/hook-events.ts'
import { hookCardWireBody, isoFromReceipt } from '../lib/hook-card-body.ts'

/** 2026-09-21T09:15:00.000Z and 2026-09-21T09:27:30.000Z: a twelve and a half
 *  minute turn, which is the shape the folded head was drawn for. */
const STARTED = Date.UTC(2026, 8, 21, 9, 15, 0)
const FINISHED = Date.UTC(2026, 8, 21, 9, 27, 30)

const shellRow = (name: string, output: string): ToolRow => ({
  icon: '💻',
  name,
  status: 'done',
  exitCode: 0,
  output,
})

test('the turn clock reaches the wire as ISO 8601, which is what the card takes', () => {
  const body = hookCardWireBody({
    state: 'done',
    tools: [shellRow('Bash', 'ok')],
    text: 'Used 1 tool · Bash',
    startedAt: STARTED,
    finishedAt: FINISHED,
  })
  assert.equal(body.text, 'Used 1 tool · Bash')
  assert.equal(body.toolProgress.state, 'done')
  assert.equal(body.toolProgress.startedAt, '2026-09-21T09:15:00.000Z')
  assert.equal(body.toolProgress.finishedAt, '2026-09-21T09:27:30.000Z')
  assert.ok(body.toolProgress.startedAt!.length <= 40, 'the field is capped at 40 characters')
})

test('a running card carries the start it already knows and no finish', () => {
  const body = hookCardWireBody({
    state: 'running',
    tools: [shellRow('Bash', 'ok')],
    text: 'Working… · Bash',
    startedAt: STARTED,
  })
  assert.equal(body.toolProgress.startedAt, '2026-09-21T09:15:00.000Z')
  assert.equal('finishedAt' in body.toolProgress, false, 'the turn is not over yet')
})

test('a card with no clock carries no clock fields at all: absent means absent', () => {
  const body = hookCardWireBody({
    state: 'done',
    tools: [shellRow('Bash', 'ok')],
    text: 'Used 1 tool · Bash',
  })
  assert.equal('startedAt' in body.toolProgress, false)
  assert.equal('finishedAt' in body.toolProgress, false)
  assert.deepEqual(Object.keys(body.toolProgress), ['state', 'tools'])
})

test('an impossible clock is dropped, and the rail never throws for one', () => {
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 253_402_300_800_000]) {
    assert.equal(isoFromReceipt(bad), null, `${bad} is not a moment this turn happened`)
  }
  assert.equal(isoFromReceipt('2026-09-21T09:15:00.000Z'), null, 'a string is not a receipt')
  assert.equal(isoFromReceipt(undefined), null)
  const body = hookCardWireBody({
    state: 'done',
    tools: [],
    text: 'No tools used',
    startedAt: Number.NaN,
    finishedAt: Number.POSITIVE_INFINITY,
  })
  assert.equal('startedAt' in body.toolProgress, false)
  assert.equal('finishedAt' in body.toolProgress, false)
})

test('EVERY card body spends the output budget, not only the last one', () => {
  // The whole tools array rides every coalesced PATCH, one per 600 ms while
  // the turn is live, and every WS frame to every viewer of a shared agent.
  // A budget applied only to the final write is a budget that never runs on
  // the writes there are most of.
  const tools = [1, 2, 3, 4, 5].map((n) => shellRow(`Bash${n}`, `${n}`.repeat(2048)))
  const body = hookCardWireBody({ state: 'running', tools, text: 'Working…' })
  const kept = body.toolProgress.tools
  assert.equal(kept.length, 5, 'the budget spends output, it never drops a row')
  assert.equal(kept[0]!.output, undefined, 'the oldest output is the one that goes')
  assert.equal(kept[0]!.exitCode, 0, 'and its exit code stays, so the chip survives')
  const total = kept.reduce((sum, row) => sum + (row.output?.length ?? 0), 0)
  assert.ok(total <= CARD_OUTPUT_BUDGET, `${total} characters of output rode a running PATCH`)
})

test('the builder never edits the card it was handed', () => {
  const tools = [1, 2, 3, 4, 5].map((n) => shellRow(`Bash${n}`, `${n}`.repeat(2048)))
  const pending = { state: 'running' as const, tools, text: 'Working…', startedAt: STARTED }
  hookCardWireBody(pending)
  assert.equal(pending.tools.length, 5)
  for (const row of pending.tools) {
    assert.equal(row.output?.length, 2048, 'the turn state keeps what it had')
  }
})
