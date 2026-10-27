/**
 * The ask tracker (lib/ask-tracker.ts): every question group ask_user_input
 * posts, kept on disk until the owner has answered or skipped every question,
 * however late, and then delivered ONCE as one ask_answered event.
 *
 * The bug this pins (Kc's card, 2026-10-27): the tool blocked up to 600 s and
 * then reported every unanswered question as skipped. The card stayed
 * answerable forever, the backend accepted a late answer and put it on the
 * agent's update stream, and the plugin dropped it on both transports
 * (decideButtonsAnswered skipped ask_user_input rows; selectClickTransitions
 * skipped them too). Nothing reached the agent.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  AskTracker,
  askAnswerFromRow,
  askPendingText,
  askReadIntervalMs,
  askRetireBody,
  askWaitSeconds,
  buildAskAnsweredEvent,
  MAX_ASK_WAIT_SECONDS,
  pidIsAlive,
  type AskRow,
  type PendingAsk,
} from '../lib/ask-tracker.ts'
import * as askLib from '../lib/ask-tracker.ts'

const MIN = 60_000

function clock(start = Date.parse('2026-10-27T09:00:00Z')) {
  let t = start
  return { now: () => t, advance: (ms: number) => { t += ms } }
}

function group(over: Partial<{ askId: string; chatId: string; ids: number[] }> = {}) {
  const ids = over.ids ?? [101, 102, 103]
  return {
    askId: over.askId ?? 'ask-1',
    chatId: over.chatId ?? '77',
    questions: ids.map((messageId, i) => ({
      messageId,
      text: `Question ${i + 1}?`,
      options: [
        { label: `A${i + 1}`, value: `a${i + 1}` },
        { label: `B${i + 1}`, value: `b${i + 1}` },
      ],
    })),
  }
}

function withDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'ask-tracker-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('a group answered fifteen minutes late completes with every answer', () => {
  const c = clock()
  const tracker = new AskTracker({ filePath: null, now: c.now })
  tracker.register(group())
  c.advance(15 * MIN)
  assert.equal(tracker.record(101, { optionValue: 'a1', optionLabel: 'A1' }).kind, 'partial')
  assert.equal(tracker.record(102, { freeText: 'neither' }).kind, 'partial')
  const done = tracker.record(103, { skipped: true })
  assert.equal(done.kind, 'complete')
  assert.ok(done.kind === 'complete')
  assert.deepEqual(
    done.ask.questions.map((q) => done.ask.answers[String(q.messageId)]),
    [{ optionValue: 'a1', optionLabel: 'A1' }, { freeText: 'neither' }, { skipped: true }],
  )
})

test('a partial answer is not complete; the rest completes it', () => {
  const tracker = new AskTracker({ filePath: null })
  tracker.register(group({ ids: [5, 6] }))
  const first = tracker.record(5, { optionValue: 'a1', optionLabel: 'A1' })
  assert.deepEqual(first, { kind: 'partial', askId: 'ask-1', answered: 1, total: 2 })
  assert.equal(tracker.isComplete('ask-1'), false)
  assert.equal(tracker.record(6, { optionValue: 'b2', optionLabel: 'B2' }).kind, 'complete')
  assert.equal(tracker.isComplete('ask-1'), true)
})

test('skip all completes with every question skipped', () => {
  const tracker = new AskTracker({ filePath: null })
  tracker.register(group({ ids: [8, 9] }))
  tracker.record(8, { skipped: true })
  const done = tracker.record(9, { skipped: true })
  assert.equal(done.kind, 'complete')
})

test('the same answer twice is recorded once', () => {
  const tracker = new AskTracker({ filePath: null })
  tracker.register(group({ ids: [11, 12] }))
  tracker.record(11, { optionValue: 'a1', optionLabel: 'A1' })
  const again = tracker.record(11, { optionValue: 'a1', optionLabel: 'A1' })
  assert.deepEqual(again, { kind: 'duplicate', askId: 'ask-1' })
  assert.equal(tracker.record(12, { skipped: true }).kind, 'complete')
  // A replay of an answer of a complete group never completes it a second time.
  assert.equal(tracker.record(12, { skipped: true }).kind, 'duplicate')
})

test('an answer to a message no group owns is untracked', () => {
  const tracker = new AskTracker({ filePath: null })
  tracker.register(group())
  assert.deepEqual(tracker.record(999, { skipped: true }), { kind: 'untracked' })
  assert.equal(tracker.owns(101), true)
  assert.equal(tracker.owns(999), false)
})

test('a pending group survives a restart and completes after it', () => {
  withDir((dir) => {
    const filePath = join(dir, 'pending-asks.json')
    const before = new AskTracker({ filePath })
    before.register(group({ ids: [21, 22] }))
    before.record(21, { optionValue: 'a1', optionLabel: 'A1' })

    const after = new AskTracker({ filePath })
    assert.equal(after.owns(22), true, 'the group is read back from disk')
    const done = after.record(22, { freeText: 'later' })
    assert.equal(done.kind, 'complete')
    assert.ok(done.kind === 'complete')
    assert.deepEqual(done.ask.answers['21'], { optionValue: 'a1', optionLabel: 'A1' }, 'the answer given before the restart is kept')
  })
})

test('a delivered group is never delivered again, even after a restart', () => {
  withDir((dir) => {
    const filePath = join(dir, 'pending-asks.json')
    const tracker = new AskTracker({ filePath })
    tracker.register(group({ ids: [31] }))
    tracker.record(31, { skipped: true })
    tracker.delivered('ask-1')
    assert.equal(tracker.owns(31), false)
    assert.equal(tracker.wasDelivered('ask-1'), true)

    const after = new AskTracker({ filePath })
    assert.equal(after.owns(31), false)
    assert.equal(after.wasDelivered('ask-1'), true)
    assert.deepEqual(after.record(31, { skipped: true }), { kind: 'untracked' })
    assert.deepEqual(after.pending(), [])
  })
})

test('the file carries no partial write: it is valid JSON after every change', () => {
  withDir((dir) => {
    const filePath = join(dir, 'pending-asks.json')
    const tracker = new AskTracker({ filePath })
    tracker.register(group())
    JSON.parse(readFileSync(filePath, 'utf8'))
    tracker.record(101, { skipped: true })
    JSON.parse(readFileSync(filePath, 'utf8'))
  })
})

test('a held group (a blocking wait) is the waiter\'s, never announced', () => {
  const tracker = new AskTracker({ filePath: null })
  tracker.register(group({ ids: [41] }))
  tracker.hold('ask-1', Date.now() + 60_000)
  tracker.record(41, { skipped: true })
  assert.equal(tracker.isHeld('ask-1'), true)
  assert.deepEqual(tracker.completeUndelivered(), [], 'a held group is not offered for delivery')
  tracker.release('ask-1')
  assert.deepEqual(tracker.completeUndelivered().map((a) => a.askId), ['ask-1'])
})

test('withdraw forgets the group and hands back its rows', () => {
  const tracker = new AskTracker({ filePath: null })
  tracker.register(group({ ids: [51, 52] }))
  const gone = tracker.withdraw('ask-1')
  assert.deepEqual(gone?.questions.map((q) => q.messageId), [51, 52])
  assert.equal(tracker.owns(51), false)
  assert.equal(tracker.withdraw('ask-1'), null)
})

function row(over: Partial<AskRow['message']> = {}, options = [{ id: 7, text: 'Yes', callbackData: 'u:yes' }]): AskRow {
  return {
    message: { id: 101, answeredAt: '2026-10-27T09:15:00Z', answerPayload: null, ...over },
    messageOptions: options,
  }
}

test('a picked option reads back as the agent\'s own value and label', () => {
  assert.deepEqual(askAnswerFromRow(row({ answerPayload: { optionId: 7, skipped: false } })), {
    optionValue: 'yes',
    optionLabel: 'Yes',
  })
})

test('typed words and a skip read back as themselves', () => {
  assert.deepEqual(askAnswerFromRow(row({ answerPayload: { freeText: 'tomorrow', skipped: false } })), {
    freeText: 'tomorrow',
  })
  assert.deepEqual(askAnswerFromRow(row({ answerPayload: { skipped: true } })), { skipped: true })
})

test('an unanswered row is no answer', () => {
  assert.equal(askAnswerFromRow(row({ answeredAt: null })), null)
  assert.equal(askAnswerFromRow(row({ answerPayload: null })), null)
})

test('ask_answered is one event with every answer in question order and all-string meta', () => {
  const tracker = new AskTracker({ filePath: null })
  tracker.register(group({ ids: [61, 62] }))
  tracker.record(62, { skipped: true })
  const done = tracker.record(61, { optionValue: 'b1', optionLabel: 'B1' })
  assert.ok(done.kind === 'complete')
  const ev = buildAskAnsweredEvent(done.ask, { assistantId: '9', ts: '2026-10-27T09:15:00Z' })
  for (const [k, v] of Object.entries(ev.meta)) assert.equal(typeof v, 'string', `meta.${k} is a string`)
  assert.equal(ev.meta.event_type, 'ask_answered')
  assert.equal(ev.meta.ask_id, 'ask-1')
  assert.equal(ev.meta.chat_id, '77')
  assert.equal(ev.meta.message_id, '61')
  assert.ok(ev.content.startsWith('[ask_answered]'))
  assert.deepEqual(JSON.parse(ev.meta.answers), [
    { question: 'Question 1?', picked_option_value: 'b1', picked_option_label: 'B1' },
    { question: 'Question 2?', skipped: true },
  ])
})

test('item 3 of #282: with neither field the call blocks up to the old 600 s; 0 returns pending at once', () => {
  assert.deepEqual(askWaitSeconds({}), { seconds: 600 })
  assert.deepEqual(askWaitSeconds({ wait_seconds: null }), { seconds: 600 }, 'null is not given')
  assert.deepEqual(askWaitSeconds({ wait_seconds: 0 }), { seconds: 0 })
  assert.equal(MAX_ASK_WAIT_SECONDS, 600)
})

test('item 3 of #282: wait_seconds blocks up to its value, capped at 600, and a number written as a string is read', () => {
  assert.deepEqual(askWaitSeconds({ wait_seconds: 90 }), { seconds: 90 })
  assert.deepEqual(askWaitSeconds({ wait_seconds: 5000 }), { seconds: MAX_ASK_WAIT_SECONDS })
  assert.deepEqual(askWaitSeconds({ wait_seconds: '60' }), { seconds: 60 })
  assert.deepEqual(askWaitSeconds({ wait_seconds: ' 45 ' }), { seconds: 45 })
})

test('item 3 of #282: a wait that is not a number of seconds is refused, never read as 0', () => {
  for (const bad of ['soon', '', -5, Number.NaN, Number.POSITIVE_INFINITY, '1e999', true, {}]) {
    const r = askWaitSeconds({ wait_seconds: bad })
    assert.ok('error' in r, `wait_seconds ${String(bad)} is refused`)
    assert.match((r as { error: string }).error, /wait_seconds must be a number of seconds from 0 to 600/)
  }
  const t = askWaitSeconds({ timeout_seconds: 'x' })
  assert.ok('error' in t)
  assert.match((t as { error: string }).error, /timeout_seconds/)
})

test('timeout_seconds keeps its meaning: the upper bound of a blocking wait, uncapped as before', () => {
  assert.deepEqual(askWaitSeconds({ timeout_seconds: 600 }), { seconds: 600 })
  assert.deepEqual(askWaitSeconds({ timeout_seconds: 1200 }), { seconds: 1200 })
  assert.deepEqual(askWaitSeconds({ timeout_seconds: '90' }), { seconds: 90 })
  assert.deepEqual(askWaitSeconds({ timeout_seconds: 30, wait_seconds: 10 }), { seconds: 10 }, 'wait_seconds wins when both are given')
})

test('a pending result names the ask id and the event, and never reports a skip', () => {
  const now = askPendingText({ askId: 'ask-9', total: 3, answered: 0 })
  assert.match(now, /"status": ?"pending"/)
  assert.match(now, /ask-9/)
  assert.match(now, /ask_answered/)
  assert.match(now, /End your turn/)
  assert.doesNotMatch(now, /"skipped"/)

  const late = askPendingText({ askId: 'ask-9', total: 3, answered: 1, waitedSeconds: 600 })
  assert.match(late, /600/)
  assert.match(late, /"answered_so_far": ?1/)
  assert.match(late, /Nothing was skipped/)
  assert.doesNotMatch(late, /"skipped"/)
})

test('a withdrawn card is retired the way Codex retires one: no options, inline', () => {
  // codex-channel-bgos interactions.ts: PATCH messages/{id} { options: [], renderMode: "inline" }.
  // Inline also retires a free-text-only question: removing options alone would
  // leave its answer input active.
  assert.deepEqual(askRetireBody(), { options: [], renderMode: 'inline' })
})

// ── Review of PR 1 (Important 1): two daemons of one assistant share the file ──
// A passive session's daemon serves ask_user_input too, so the file is the
// source of truth: every save merges what is on disk first, a delivered or
// withdrawn group is a tombstone every reader honours, and a blocking wait's
// hold is on disk with its deadline so the armed daemon never announces a
// group another process is still waiting on.

test('two trackers on one file lose no group: each save merges the other\'s', () => {
  withDir((dir) => {
    const filePath = join(dir, 'pending-asks.json')
    const a = new AskTracker({ filePath })
    const b = new AskTracker({ filePath })
    a.register(group({ askId: 'g1', ids: [301] }))
    b.register(group({ askId: 'g2', ids: [302] }))
    const onDisk = new AskTracker({ filePath })
    assert.deepEqual(onDisk.pending().map((g) => g.askId).sort(), ['g1', 'g2'])
    a.refresh()
    assert.equal(a.owns(302), true, 'a adopts the group b posted')
  })
})

test('a group one tracker delivered is never brought back by the other', () => {
  withDir((dir) => {
    const filePath = join(dir, 'pending-asks.json')
    const a = new AskTracker({ filePath })
    a.register(group({ askId: 'g1', ids: [311] }))
    const b = new AskTracker({ filePath })
    a.record(311, { skipped: true })
    a.delivered('g1')
    b.register(group({ askId: 'g2', ids: [312] }))
    assert.equal(b.owns(311), false, 'b dropped it on its own save')
    assert.deepEqual(new AskTracker({ filePath }).pending().map((g) => g.askId), ['g2'])
    assert.deepEqual(b.completeUndelivered(), [])
  })
})

test('a withdrawn group is a tombstone too', () => {
  withDir((dir) => {
    const filePath = join(dir, 'pending-asks.json')
    const a = new AskTracker({ filePath })
    a.register(group({ askId: 'g1', ids: [321] }))
    const b = new AskTracker({ filePath })
    a.withdraw('g1')
    b.refresh()
    assert.equal(b.owns(321), false)
    assert.equal(b.get('g1'), null)
  })
})

test('answers read by either tracker are merged, the first kept', () => {
  withDir((dir) => {
    const filePath = join(dir, 'pending-asks.json')
    const a = new AskTracker({ filePath })
    a.register(group({ askId: 'g1', ids: [331, 332] }))
    const b = new AskTracker({ filePath })
    a.record(331, { optionValue: 'a1', optionLabel: 'A1' })
    b.record(332, { skipped: true })
    a.refresh()
    assert.equal(a.isComplete('g1'), true)
    assert.deepEqual(a.get('g1')?.answers['331'], { optionValue: 'a1', optionLabel: 'A1' })
  })
})

test('another process\'s blocking wait holds the group until its deadline', () => {
  withDir((dir) => {
    const filePath = join(dir, 'pending-asks.json')
    const c = clock()
    const waiter = new AskTracker({ filePath, now: c.now })
    waiter.register(group({ askId: 'g1', ids: [341] }))
    waiter.hold('g1', c.now() + 60_000)
    waiter.record(341, { skipped: true })
    const armed = new AskTracker({ filePath, now: c.now })
    assert.equal(armed.isHeld('g1'), true)
    assert.deepEqual(armed.completeUndelivered(), [], 'the waiter\'s result, never an event')
    waiter.release('g1')
    armed.refresh()
    assert.deepEqual(armed.completeUndelivered().map((g) => g.askId), ['g1'])
  })
})

test('a hold whose process died ends at its deadline', () => {
  withDir((dir) => {
    const filePath = join(dir, 'pending-asks.json')
    const c = clock()
    const waiter = new AskTracker({ filePath, now: c.now })
    waiter.register(group({ askId: 'g1', ids: [351] }))
    waiter.hold('g1', c.now() + 60_000)
    waiter.record(351, { skipped: true })
    const armed = new AskTracker({ filePath, now: c.now })
    c.advance(61_000)
    assert.equal(armed.isHeld('g1'), false)
    assert.deepEqual(armed.completeUndelivered().map((g) => g.askId), ['g1'])
  })
})

// ── Review of PR 1 (Minor 11): a file that cannot be read is kept, and said ──

test('an unreadable file is logged and kept aside, never silently overwritten', () => {
  withDir((dir) => {
    const filePath = join(dir, 'pending-asks.json')
    writeFileSync(filePath, '{ not json')
    const lines: string[] = []
    const tracker = new AskTracker({ filePath, log: (l) => lines.push(l) })
    assert.ok(lines.some((l) => /could not read/.test(l) && /corrupt/.test(l)), lines.join('\n'))
    assert.ok(readdirSync(dir).some((f) => f.startsWith('pending-asks.json.corrupt')), 'a copy is kept')
    tracker.register(group({ askId: 'g1', ids: [361] }))
    assert.deepEqual(new AskTracker({ filePath }).pending().map((g) => g.askId), ['g1'])
  })
})

// ── Review of PR 1 (Important 2): with the stream off, a delta poll never shows an answer ──
// (answering updates an old row), so the reads are the delivery path: often while the owner is
// likely at the card (just posted, or just answered a question of it), then rarely.

test('a young or just answered group is read every 5 s, then every 20 s, then every 2 minutes', () => {
  const c = clock()
  const tracker = new AskTracker({ filePath: null, now: c.now })
  const ask = tracker.register(group({ ids: [371, 372] }))
  assert.equal(askReadIntervalMs(ask, c.now()), 5_000)
  c.advance(3 * MIN)
  assert.equal(askReadIntervalMs(ask, c.now()), 20_000)
  c.advance(13 * MIN)
  assert.equal(askReadIntervalMs(ask, c.now()), 2 * MIN)
  tracker.record(371, { skipped: true })
  assert.equal(askReadIntervalMs(tracker.get('ask-1')!, c.now()), 5_000, 'an answer means the owner is at the card now')
})

// ── Review of PR 1 (Important 3): the ask_answered turn is not the owner's own message ──

test('the pending text says private tools refuse in the ask_answered turn, and when to wait instead', () => {
  const text = askPendingText({ askId: 'ask-9', total: 2, answered: 0 })
  assert.match(text, /not your owner's own message/)
  assert.match(text, /schedule/)
  assert.match(text, /wait_seconds/)
})

// ── Data's review of #282, item 1 (High): answers go only to the session that asked ──

/** A tracker that knows which process it is and which others still run (read by the fix). */
function trackerAs(self: { pid: number; startedAt: number }, live: number[], extra: Record<string, unknown> = {}) {
  return new AskTracker({
    filePath: null,
    now: () => extra.now ? (extra.now as () => number)() : self.startedAt + 30 * MIN,
    ...({ self, isAlive: (pid: number) => pid === self.pid || live.includes(pid) } as object),
    ...(extra.filePath ? { filePath: extra.filePath as string } : {}),
  })
}

function completeGroupOf(tracker: AskTracker, askId: string, ids: number[], owner?: { pid: number; startedAt: number; aliveAt?: number }, postedAt?: number) {
  const ask = tracker.register(group({ askId, ids }))
  if (owner) (ask as unknown as { owner: unknown }).owner = owner
  if (postedAt !== undefined) ask.postedAt = postedAt
  for (const id of ids) tracker.record(id, { skipped: true })
  return ask
}

test('item 1: a complete group another live daemon posted is never offered for an announce here', () => {
  const self = { pid: 10, startedAt: Date.parse('2026-10-27T09:00:00Z') }
  const tracker = trackerAs(self, [20])
  // Pid 20 runs and said so on its last ask tick (the lease, recheck of #282).
  completeGroupOf(tracker, 'theirs', [801], { pid: 20, startedAt: self.startedAt - MIN, aliveAt: self.startedAt + 30 * MIN }, self.startedAt + MIN)
  completeGroupOf(tracker, 'mine', [802])
  assert.deepEqual(tracker.completeUndelivered().map((a) => a.askId), ['mine'])
})

test('item 1: a group whose asker ended is offered only to a daemon that started after it was posted (a restart)', () => {
  const self = { pid: 10, startedAt: Date.parse('2026-10-27T09:00:00Z') }
  const tracker = trackerAs(self, [])
  completeGroupOf(tracker, 'asked-before-i-started', [811], { pid: 30, startedAt: self.startedAt - 60 * MIN }, self.startedAt - 30 * MIN)
  completeGroupOf(tracker, 'asked-while-i-ran', [812], { pid: 31, startedAt: self.startedAt - 60 * MIN }, self.startedAt + 5 * MIN)
  assert.deepEqual(tracker.completeUndelivered().map((a) => a.askId), ['asked-before-i-started'])
})

test('item 1: the process that posted a group is written with it, and read back', () => {
  withDir((dir) => {
    const filePath = join(dir, 'pending-asks.json')
    const self = { pid: 4242, startedAt: Date.parse('2026-10-27T09:00:00Z') }
    trackerAs(self, [], { filePath }).register(group({ askId: 'g', ids: [821] }))
    const onDisk = JSON.parse(readFileSync(filePath, 'utf8'))
    const { pid, startedAt } = onDisk.pending[0].owner
    assert.deepEqual({ pid, startedAt }, self)
    const other = trackerAs({ pid: 7, startedAt: self.startedAt + MIN }, [4242], { filePath })
    const read = (other.get('g') as unknown as { owner: { pid: number; startedAt: number } }).owner
    assert.deepEqual({ pid: read.pid, startedAt: read.startedAt }, self)
  })
})

// ── Second review of #282, Important 2: a session that ran beside the asker never takes its answers ──

/** Two trackers on one file, a clock and a list of live pids both can move. */
function sharedFile(fn: (t: { filePath: string; clock: { at: number }; live: number[]; at: (hhmmss: string) => number }) => void) {
  withDir((dir) => {
    const at = (hhmmss: string) => Date.parse(`2026-10-27T${hhmmss}Z`)
    fn({ filePath: join(dir, 'pending-asks.json'), clock: { at: at('10:00:00') }, live: [], at })
  })
}

/**
 * What the recheck adds to the tracker, read through the module and the
 * instance so each case fails on its own before it exists.
 */
type Recheck = {
  heartbeat?: () => void
  retirable?: (connectedSince?: number) => PendingAsk[]
}
const recheckLib = askLib as unknown as {
  ASK_LEASE_REFRESH_MS?: number
  ASK_LEASE_MS?: number
  ASK_ORPHAN_GRACE_MS?: number
  buildAskWithdrawnEvent?: (ask: PendingAsk, opts: { assistantId: string; withdrawn: number }) => { content: string; meta: Record<string, string> }
}
/** The asker says it still runs, as the ask tick does (a no op before the lease exists). */
const beat = (t: AskTracker) => (t as unknown as Recheck).heartbeat?.()
const retirableIds = (t: AskTracker, connectedSince?: number) =>
  ((t as unknown as Recheck).retirable?.(connectedSince) ?? []).map((g) => g.askId)
/** The clock moves to `to` 5 s at a time (the ask tick), each step running `each`. */
function stepUntil(clock: { at: number }, to: number, each: () => void) {
  while (clock.at < to) {
    clock.at = Math.min(to, clock.at + 5_000)
    each()
  }
}

/** The clock moves to `to` a tick at a time, each tracker saying on its ask tick that it runs. */
function runUntil(clock: { at: number }, to: number, ...trackers: AskTracker[]) {
  stepUntil(clock, to, () => {
    for (const t of trackers) beat(t)
  })
}

test('second review, Important 2: a session started after the card, beside its live asker, never takes the answers once the asker ends', () => {
  sharedFile(({ filePath, clock, live, at }) => {
    const now = () => clock.at
    const a = trackerAs({ pid: 1, startedAt: at('09:00:00') }, live, { filePath, now })
    a.register(group({ askId: 'g', ids: [901, 902] }))
    live.push(1)
    runUntil(clock, at('10:30:00'), a)
    const b = trackerAs({ pid: 2, startedAt: clock.at }, live, { filePath, now })
    // A runs beside B for a quarter of an hour, then ends.
    runUntil(clock, at('10:45:00'), a)
    live.splice(live.indexOf(1), 1)
    clock.at = at('11:00:00')
    b.refresh()
    b.record(901, { skipped: true })
    b.record(902, { skipped: true })
    assert.deepEqual(b.completeUndelivered().map((g) => g.askId), [], 'B saw the asker alive half an hour before it ended: another session')
    assert.equal(b.isOurs(b.get('g')!), false)
  })
})

test('second review, Important 2: a restart whose old daemon ends seconds after the new one starts still gets the answers', () => {
  sharedFile(({ filePath, clock, live, at }) => {
    const now = () => clock.at
    const a = trackerAs({ pid: 1, startedAt: at('09:00:00') }, live, { filePath, now })
    a.register(group({ askId: 'g', ids: [911] }))
    live.push(1)
    runUntil(clock, at('10:10:00'), a)
    const a2 = trackerAs({ pid: 3, startedAt: clock.at }, live, { filePath, now })
    live.splice(live.indexOf(1), 1)
    clock.at = at('10:10:03')
    a2.refresh()
    a2.record(911, { skipped: true })
    assert.deepEqual(a2.completeUndelivered().map((g) => g.askId), ['g'])
  })
})

test('third review, Critical 1: a restart whose old daemon ends seconds after the new one starts gets the answers however late they come', () => {
  sharedFile(({ filePath, clock, live, at }) => {
    const now = () => clock.at
    const a = trackerAs({ pid: 1, startedAt: at('09:00:00') }, live, { filePath, now })
    a.register(group({ askId: 'g', ids: [951] }))
    live.push(1)
    runUntil(clock, at('10:10:00'), a)
    const a2 = trackerAs({ pid: 3, startedAt: clock.at }, live, { filePath, now })
    live.splice(live.indexOf(1), 1)
    clock.at = at('10:10:03')
    a2.refresh()
    clock.at = at('11:00:00')
    a2.refresh()
    a2.record(951, { skipped: true })
    assert.deepEqual(a2.completeUndelivered().map((g) => g.askId), ['g'], 'answered 50 minutes after the restart')
  })
})

test('third review, Important 2: once a session that ran beside the asker has seen it end, no daemon ever takes the answers, its own restart included', () => {
  sharedFile(({ filePath, clock, live, at }) => {
    const now = () => clock.at
    const a = trackerAs({ pid: 1, startedAt: at('09:00:00') }, live, { filePath, now })
    a.register(group({ askId: 'g', ids: [961] }))
    live.push(1)
    runUntil(clock, at('10:30:00'), a)
    const b = trackerAs({ pid: 2, startedAt: clock.at }, live, { filePath, now })
    // A runs beside B for a quarter of an hour, then ends.
    runUntil(clock, at('10:45:00'), a)
    live.splice(live.indexOf(1), 1)
    clock.at = at('11:00:00')
    b.refresh()
    assert.equal((JSON.parse(readFileSync(filePath, 'utf8')).pending[0] as { askerEndedBeside?: number }).askerEndedBeside !== undefined, true, 'the decision is in the file')
    // B's daemon restarts: it never saw A alive and started after the post.
    clock.at = at('11:30:00')
    const b2 = trackerAs({ pid: 4, startedAt: clock.at }, live, { filePath, now })
    b2.record(961, { skipped: true })
    assert.deepEqual(b2.completeUndelivered().map((g) => g.askId), [])
  })
})

test('fourth review, Important 1: a session already running when the card was posted, which first looks after the asker ended, marks it, so its own restart never takes the answers', () => {
  sharedFile(({ filePath, clock, live, at }) => {
    const now = () => clock.at
    clock.at = at('09:30:00')
    const c = trackerAs({ pid: 2, startedAt: clock.at }, live, { filePath, now })
    clock.at = at('10:00:00')
    const a = trackerAs({ pid: 1, startedAt: at('09:00:00') }, live, { filePath, now })
    a.register(group({ askId: 'g', ids: [971] }))
    // A runs an hour beside C, which does not look until A has ended.
    live.push(1)
    runUntil(clock, at('11:00:00'), a)
    live.splice(live.indexOf(1), 1)
    clock.at = at('11:00:05')
    c.refresh()
    assert.notEqual((JSON.parse(readFileSync(filePath, 'utf8')).pending[0] as { askerEndedBeside?: number }).askerEndedBeside, undefined)
    clock.at = at('12:00:00')
    const c2 = trackerAs({ pid: 4, startedAt: clock.at }, live, { filePath, now })
    c2.record(971, { skipped: true })
    assert.deepEqual(c2.completeUndelivered().map((g) => g.askId), [])
  })
})

test('fourth review, Minor 3: a mark that another daemon wrote over is written again at the next read', () => {
  sharedFile(({ filePath, clock, live, at }) => {
    const now = () => clock.at
    const a = trackerAs({ pid: 1, startedAt: at('09:00:00') }, live, { filePath, now })
    a.register(group({ askId: 'g', ids: [981] }))
    live.push(1)
    runUntil(clock, at('10:30:00'), a)
    const b = trackerAs({ pid: 2, startedAt: clock.at }, live, { filePath, now })
    // A runs beside B for a quarter of an hour, then ends.
    runUntil(clock, at('10:45:00'), a)
    live.splice(live.indexOf(1), 1)
    clock.at = at('11:00:00')
    b.refresh()
    const file = JSON.parse(readFileSync(filePath, 'utf8'))
    delete file.pending[0].askerEndedBeside
    writeFileSync(filePath, JSON.stringify(file))
    b.refresh()
    assert.notEqual(JSON.parse(readFileSync(filePath, 'utf8')).pending[0].askerEndedBeside, undefined)
  })
})

test('fourth review, Minor 5: the live asker still delivers its own card if another daemon marked it by mistake', () => {
  const self = { pid: 10, startedAt: Date.parse('2026-10-27T09:00:00Z') }
  const tracker = trackerAs(self, [])
  const ask = completeGroupOf(tracker, 'mine', [991])
  ;(ask as unknown as { askerEndedBeside: number }).askerEndedBeside = self.startedAt + MIN
  assert.deepEqual(tracker.completeUndelivered().map((g) => g.askId), ['mine'])
})

test('second review, Minor 12: a group with no owner (a file from before the owner was written) goes by the post time alone', () => {
  sharedFile(({ filePath, at }) => {
    const ask = { askId: 'old', chatId: '7', postedAt: at('10:00:00'), questions: [{ messageId: 921, text: 'Q?', options: [{ label: 'A', value: 'a' }] }], answers: { '921': { skipped: true } } }
    writeFileSync(filePath, JSON.stringify({ v: 1, pending: [ask], delivered: [] }))
    const restarted = trackerAs({ pid: 5, startedAt: at('10:05:00') }, [], { filePath, now: () => at('10:06:00') })
    assert.deepEqual(restarted.completeUndelivered().map((g) => g.askId), ['old'])
    const older = trackerAs({ pid: 6, startedAt: at('09:55:00') }, [], { filePath, now: () => at('10:06:00') })
    assert.deepEqual(older.completeUndelivered().map((g) => g.askId), [])
  })
})

// ── Data's review of #282, item 4: only a file that read in full and failed to parse is kept aside ──

/** Run with node:fs's readFileSync or renameSync failing as `fault` says (the tracker's own import sees it). */
function withFsFault<T>(
  fault: { read?: (path: string, call: number) => string | null; rename?: (to: string, call: number) => string | null },
  fn: () => T,
): T {
  const read = fs.readFileSync
  const rename = fs.renameSync
  let reads = 0
  let renames = 0
  const err = (code: string) => Object.assign(new Error(`${code}: simulated`), { code })
  ;(fs as unknown as Record<string, unknown>).readFileSync = (path: string, ...rest: unknown[]) => {
    const code = fault.read?.(String(path), reads++) ?? null
    if (code) throw err(code)
    return (read as (...a: unknown[]) => unknown)(path, ...rest)
  }
  ;(fs as unknown as Record<string, unknown>).renameSync = (from: string, to: string) => {
    const code = fault.rename?.(String(to), renames++) ?? null
    if (code) throw err(code)
    return rename(from, to)
  }
  syncBuiltinESMExports()
  try {
    return fn()
  } finally {
    ;(fs as unknown as Record<string, unknown>).readFileSync = read
    ;(fs as unknown as Record<string, unknown>).renameSync = rename
    syncBuiltinESMExports()
  }
}

function fileWith(dir: string, body: unknown): string {
  const filePath = join(dir, 'pending-asks.json')
  writeFileSync(filePath, typeof body === 'string' ? body : JSON.stringify(body))
  return filePath
}

const OTHER = { v: 1, pending: [{ ...group({ askId: 'other', ids: [901] }), postedAt: Date.now(), answers: {} }], delivered: [] }
const asideIn = (dir: string) => readdirSync(dir).filter((f) => f.includes('.corrupt-'))

for (const code of ['EBUSY', 'EPERM', 'EACCES', 'EMFILE', 'ENOENT']) {
  test(`item 4: a read that fails ${code} for a moment is tried again, and the file is never kept aside`, () => {
    withDir((dir) => {
      const filePath = fileWith(dir, OTHER)
      const logs: string[] = []
      const tracker = withFsFault({ read: (p, n) => (p.endsWith('pending-asks.json') && n < 2 ? code : null) }, () =>
        new AskTracker({ filePath, log: (l) => logs.push(l) }),
      )
      assert.deepEqual(asideIn(dir), [], logs.join('\n'))
      assert.ok(tracker.get('other'), 'the other daemon\'s group was read once the file could be')
    })
  })
}

test('item 4: a read that keeps failing is skipped: the file is left as it is, and no save writes over it', () => {
  withDir((dir) => {
    const filePath = fileWith(dir, OTHER)
    const before = readFileSync(filePath, 'utf8')
    const logs: string[] = []
    const tracker = withFsFault({ read: (p) => (p.endsWith('pending-asks.json') ? 'EBUSY' : null) }, () => {
      const t = new AskTracker({ filePath, log: (l) => logs.push(l) })
      t.register(group({ askId: 'mine', ids: [902] }))
      return t
    })
    assert.deepEqual(asideIn(dir), [])
    assert.equal(readFileSync(filePath, 'utf8'), before, 'the other daemon\'s groups were not written over')
    // Once the file reads again, the next save merges both.
    tracker.record(902, { skipped: true })
    const onDisk = JSON.parse(readFileSync(filePath, 'utf8'))
    assert.deepEqual(onDisk.pending.map((a: { askId: string }) => a.askId).sort(), ['mine', 'other'])
  })
})

test('item 4: a file of another version is left alone: not kept aside, not written over', () => {
  withDir((dir) => {
    const newer = { v: 2, pending: [{ askId: 'from-a-newer-plugin' }], delivered: [], more: true }
    const filePath = fileWith(dir, newer)
    const before = readFileSync(filePath, 'utf8')
    const tracker = new AskTracker({ filePath })
    tracker.register(group({ askId: 'mine', ids: [903] }))
    assert.deepEqual(asideIn(dir), [])
    assert.equal(readFileSync(filePath, 'utf8'), before)
    assert.ok(tracker.get('mine'), 'this daemon still tracks its own card, in memory')
  })
})

test('item 4: a file that read in full and does not parse is still kept aside', () => {
  withDir((dir) => {
    fileWith(dir, '{"v":1,"pending":[')
    new AskTracker({ filePath: join(dir, 'pending-asks.json') })
    assert.equal(asideIn(dir).length, 1)
  })
})

test('item 4: a save whose rename fails EPERM for a moment (Windows, the file held open) is tried again, not dropped', () => {
  withDir((dir) => {
    const filePath = join(dir, 'pending-asks.json')
    const logs: string[] = []
    withFsFault({ rename: (to, n) => (to.endsWith('pending-asks.json') && n < 2 ? 'EPERM' : null) }, () => {
      new AskTracker({ filePath, log: (l) => logs.push(l) }).register(group({ askId: 'saved', ids: [904] }))
    })
    const onDisk = JSON.parse(readFileSync(filePath, 'utf8'))
    assert.deepEqual(onDisk.pending.map((a: { askId: string }) => a.askId), ['saved'], logs.join('\n'))
  })
})

test('item 4: a save whose rename keeps failing is dropped with a line in the log and no temp file left', () => {
  withDir((dir) => {
    const filePath = join(dir, 'pending-asks.json')
    const logs: string[] = []
    withFsFault({ rename: (to) => (to.endsWith('pending-asks.json') ? 'EPERM' : null) }, () => {
      new AskTracker({ filePath, log: (l) => logs.push(l) }).register(group({ askId: 'lost', ids: [905] }))
    })
    assert.ok(logs.some((l) => l.includes('could not save')))
    assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith('.tmp')), [])
  })
})

// ── Data's review of #282, item 6 (Low): the cap holds with a file ──

test('item 6: at most 50 groups are kept, in memory and on disk, even though every save merges the file', () => {
  withDir((dir) => {
    const filePath = join(dir, 'pending-asks.json')
    const c = clock()
    const tracker = new AskTracker({ filePath, now: c.now })
    for (let i = 0; i < 55; i++) {
      c.advance(1000)
      tracker.register(group({ askId: `g${i}`, ids: [10_000 + i] }))
    }
    assert.equal(tracker.pending().length, 50)
    const onDisk = JSON.parse(readFileSync(filePath, 'utf8'))
    assert.equal(onDisk.pending.length, 50)
    assert.equal(tracker.get('g0'), null, 'the oldest went first')
    assert.ok(tracker.get('g54'))
    // And a second daemon reading that file never brings the dropped ones back.
    assert.equal(new AskTracker({ filePath, now: c.now }).pending().length, 50)
  })
})

// ── Second review of #282, Minors 4, 5, 6, 8 and 10 ──

test('second review, Minor 4: a pid that is not a real process (0, negative) is never alive', () => {
  assert.equal(pidIsAlive(0), false)
  assert.equal(pidIsAlive(-1), false)
  assert.equal(pidIsAlive(Number.NaN), false)
})

test('second review, Minor 5: a JSON object with no version, or a version that is not a number, is kept aside like any file that does not parse', () => {
  for (const body of [{}, { v: '1', pending: [] }, { v: 0, pending: [] }]) {
    withDir((dir) => {
      const filePath = fileWith(dir, body)
      const tracker = new AskTracker({ filePath })
      assert.equal(asideIn(dir).length, 1, `${JSON.stringify(body)} kept aside`)
      tracker.register(group({ askId: 'mine', ids: [931] }))
      assert.deepEqual(JSON.parse(readFileSync(filePath, 'utf8')).pending.map((a: { askId: string }) => a.askId), ['mine'], 'and this daemon saves again')
    })
  }
})

test('second review, Minor 6: while a read keeps failing, each later pass tries it once, not with every pause again', () => {
  withDir((dir) => {
    const filePath = fileWith(dir, OTHER)
    let reads = 0
    withFsFault({ read: (p) => (p.endsWith('pending-asks.json') ? (reads++, 'EACCES') : null) }, () => {
      const t = new AskTracker({ filePath })
      const first = reads
      t.refresh()
      t.refresh()
      assert.equal(reads - first, 2, `two more passes read ${reads - first} times`)
    })
  })
})

test('second review, Minor 8: a wait written in another number form ("0x10", "1e2") is refused, not read', () => {
  for (const wait_seconds of ['0x10', '1e2', '0b11']) {
    const r = askWaitSeconds({ wait_seconds })
    assert.ok('error' in r, `${wait_seconds} was read as ${JSON.stringify(r)}`)
  }
  assert.deepEqual(askWaitSeconds({ wait_seconds: ' 60 ' }), { seconds: 60 })
  assert.deepEqual(askWaitSeconds({ wait_seconds: '1.5' }), { seconds: 1.5 })
})

test('second review, Minor 8: the refusal says a larger wait is read as 600, which it is', () => {
  const r = askWaitSeconds({ wait_seconds: 'soon' })
  assert.ok('error' in r)
  // Third review, Minor 6: in plain words.
  assert.match(r.error, /a larger number waits 600/)
  assert.deepEqual(askWaitSeconds({ wait_seconds: 900 }), { seconds: MAX_ASK_WAIT_SECONDS })
})

test('second review, Minor 10: a file that does not parse and cannot be kept aside is left alone, never written over', () => {
  withDir((dir) => {
    const filePath = fileWith(dir, '{ not json')
    withFsFault({ rename: (to) => (to.includes('.corrupt-') ? 'EPERM' : null) }, () => {
      const t = new AskTracker({ filePath })
      t.register(group({ askId: 'mine', ids: [941] }))
    })
    assert.equal(readFileSync(filePath, 'utf8'), '{ not json')
  })
})

// ── Fifth review of #282: what a passive daemon's 5 s tick now repeats (Minors 3 and 4) ──

test('fifth review, Minor 3: a group dropped for age is said once, not on every read', () => {
  withDir((dir) => {
    const old = { ...group({ askId: 'old', ids: [1001] }), postedAt: Date.now() - 40 * 24 * 60 * MIN, answers: {} }
    const filePath = fileWith(dir, { v: 1, pending: [old], delivered: [] })
    const logs: string[] = []
    const t = new AskTracker({ filePath, log: (l) => logs.push(l) })
    t.refresh()
    t.refresh()
    assert.equal(logs.filter((l) => /more than 30 days/.test(l)).length, 1, logs.join('\n'))
  })
})

test('fifth review, Minor 3: a save that keeps failing is said once and tried once per pass, not with every pause', () => {
  withDir((dir) => {
    const filePath = join(dir, 'pending-asks.json')
    const logs: string[] = []
    let renames = 0
    withFsFault({ rename: (to) => (to === filePath ? (renames++, 'EPERM') : null) }, () => {
      const t = new AskTracker({ filePath, log: (l) => logs.push(l) })
      t.register(group({ askId: 'a', ids: [1011] }))
      const first = renames
      t.register(group({ askId: 'b', ids: [1012] }))
      assert.equal(renames - first, 1, `the second save renamed ${renames - first} times`)
    })
    assert.equal(logs.filter((l) => /could not save/.test(l)).length, 1, logs.join('\n'))
  })
})

test('fifth review, Minor 4: a session older than the card that sees the asker end within 60 s of the post marks nothing, and the restart gets the card', () => {
  sharedFile(({ filePath, clock, live, at }) => {
    const now = () => clock.at
    clock.at = at('09:30:00')
    const c = trackerAs({ pid: 2, startedAt: clock.at }, live, { filePath, now })
    clock.at = at('10:00:00')
    const a = trackerAs({ pid: 1, startedAt: at('09:00:00') }, live, { filePath, now })
    a.register(group({ askId: 'g', ids: [1021] }))
    clock.at = at('10:00:40')
    c.refresh()
    assert.equal(JSON.parse(readFileSync(filePath, 'utf8')).pending[0].askerEndedBeside, undefined)
    clock.at = at('10:05:00')
    const a2 = trackerAs({ pid: 3, startedAt: clock.at }, live, { filePath, now })
    a2.record(1021, { skipped: true })
    assert.deepEqual(a2.completeUndelivered().map((g) => g.askId), ['g'])
  })
})

// ── Data's recheck of #282 at 4d9ee89: a pid that is reused, and cards nobody retires ──

test('recheck, pid reuse: a dead asker whose pid now belongs to an unrelated process never keeps its card from the restarted asker', () => {
  sharedFile(({ filePath, clock, live, at }) => {
    const now = () => clock.at
    const a = trackerAs({ pid: 1, startedAt: at('09:00:00') }, live, { filePath, now })
    a.register(group({ askId: 'g', ids: [1101] }))
    live.push(1)
    // A runs ten more minutes, saying so on the ask tick, then ends.
    for (let t = at('10:00:15'); t <= at('10:10:00'); t += 15_000) {
      clock.at = t
      beat(a)
    }
    live.splice(live.indexOf(1), 1)
    // Windows hands pid 1 to an unrelated process at once.
    clock.at = at('10:10:02')
    live.push(1)
    clock.at = at('10:10:05')
    const a2 = trackerAs({ pid: 3, startedAt: clock.at }, live, { filePath, now })
    live.push(3)
    runUntil(clock, at('10:40:00'), a2)
    a2.record(1101, { skipped: true })
    assert.deepEqual(a2.completeUndelivered().map((g) => g.askId), ['g'], 'the restart is accepted whatever pid 1 is now')
  })
})

test('recheck, lease: the asker writes on its own groups that it runs, at most every ASK_LEASE_REFRESH_MS, never on another daemon\'s', () => {
  sharedFile(({ filePath, clock, live, at }) => {
    const now = () => clock.at
    assert.equal(recheckLib.ASK_LEASE_REFRESH_MS, 15_000)
    assert.equal(recheckLib.ASK_LEASE_MS, 35_000, 'two refreshes and 5 s for a slow tick')
    const a = trackerAs({ pid: 1, startedAt: at('09:00:00') }, live, { filePath, now })
    const b = trackerAs({ pid: 2, startedAt: at('09:00:00') }, live, { filePath, now })
    a.register(group({ askId: 'a-card', ids: [1111] }))
    b.register(group({ askId: 'b-card', ids: [1112] }))
    const aliveAt = (id: string) =>
      (JSON.parse(readFileSync(filePath, 'utf8')).pending as Array<{ askId: string; owner: { aliveAt?: number } }>).find((g) => g.askId === id)!.owner.aliveAt
    assert.equal(aliveAt('a-card'), at('10:00:00'), 'written with the post')
    clock.at = at('10:00:10')
    beat(a)
    assert.equal(aliveAt('a-card'), at('10:00:00'), 'not again within 15 s')
    clock.at = at('10:00:16')
    beat(a)
    assert.equal(aliveAt('a-card'), at('10:00:16'))
    assert.equal(aliveAt('b-card'), at('10:00:00'), "A never writes B's lease")
  })
})

test('recheck, lease: an asker whose pid reads alive but who stopped saying so for longer than ASK_LEASE_MS has ended', () => {
  sharedFile(({ filePath, clock, live, at }) => {
    const now = () => clock.at
    const a = trackerAs({ pid: 1, startedAt: at('09:00:00') }, live, { filePath, now })
    a.register(group({ askId: 'g', ids: [1121] }))
    live.push(1)
    clock.at = at('10:00:05')
    const a2 = trackerAs({ pid: 3, startedAt: clock.at }, live, { filePath, now })
    a2.record(1121, { skipped: true })
    runUntil(clock, at('10:00:30'), a2)
    assert.deepEqual(a2.completeUndelivered().map((g) => g.askId), [], 'inside the lease the asker runs')
    runUntil(clock, at('10:00:36'), a2)
    assert.deepEqual(a2.completeUndelivered().map((g) => g.askId), ['g'], 'past it, pid 1 is somebody else')
  })
})

test('recheck, item 1: a group marked askerEndedBeside is handed to the connected daemon to retire, never announced', () => {
  sharedFile(({ filePath, clock, live, at }) => {
    const now = () => clock.at
    const a = trackerAs({ pid: 1, startedAt: at('09:00:00') }, live, { filePath, now })
    a.register(group({ askId: 'g', ids: [1131, 1132] }))
    live.push(1)
    clock.at = at('10:00:30')
    const b = trackerAs({ pid: 2, startedAt: clock.at }, live, { filePath, now })
    for (let t = at('10:00:45'); t <= at('10:30:00'); t += 15_000) {
      clock.at = t
      beat(a)
      b.refresh()
    }
    live.splice(live.indexOf(1), 1)
    clock.at = at('10:30:20')
    b.refresh()
    b.record(1131, { skipped: true })
    assert.notEqual(b.get('g')?.askerEndedBeside, undefined, 'B ran beside A for half an hour')
    assert.deepEqual(b.completeUndelivered().map((g) => g.askId), [])
    assert.deepEqual(retirableIds(b), ['g'])
    b.withdraw('g')
    assert.deepEqual(retirableIds(b), [], 'retired once')
  })
})

test('fresh review of the recheck, Critical 1: the connected daemon retires every unheld group of a live asker other than itself once it has seen it so for ASK_LEASE_MS, whatever took the connection; a held one once its wait lets go; never its own', () => {
  sharedFile(({ filePath, clock, live, at }) => {
    const now = () => clock.at
    const h1 = trackerAs({ pid: 1, startedAt: at('09:00:00') }, live, { filePath, now })
    h1.register(group({ askId: 'open', ids: [1141] }))
    h1.register(group({ askId: 'held', ids: [1142] }))
    h1.hold('held', at('10:03:00'))
    live.push(1)
    // H2 holds the connection now. H1 lost it, to a stale lock after a sleep
    // or to a channel or route takeover, and runs on, passive: it can never
    // hand an answer to its session.
    clock.at = at('10:01:00')
    const h2 = trackerAs({ pid: 2, startedAt: clock.at }, live, { filePath, now })
    h2.register(group({ askId: 'mine', ids: [1143] }))
    live.push(2)
    const looks: string[][] = [retirableIds(h2)]
    stepUntil(clock, at('10:01:30'), () => {
      beat(h1)
      beat(h2)
      looks.push(retirableIds(h2))
    })
    assert.ok(looks.every((ids) => ids.length === 0), `within ASK_LEASE_MS of the first look a lock that changed hands for a moment settles: ${JSON.stringify(looks)}`)
    stepUntil(clock, at('10:01:40'), () => {
      beat(h1)
      beat(h2)
    })
    assert.deepEqual(retirableIds(h2), ['open'], 'retired, not lost while both sessions run')
    stepUntil(clock, at('10:03:30'), () => {
      beat(h1)
      beat(h2)
      retirableIds(h2)
    })
    assert.deepEqual(retirableIds(h2), ['open'], 'the held one waits ASK_LEASE_MS after its wait lets go too')
    stepUntil(clock, at('10:03:40'), () => {
      beat(h1)
      beat(h2)
      retirableIds(h2)
    })
    assert.deepEqual(retirableIds(h2).sort(), ['held', 'open'])
  })
})

test('recheck: a group whose asker ended with no restart taking it is retired after ASK_ORPHAN_GRACE_MS, never left live', () => {
  sharedFile(({ filePath, clock, live, at }) => {
    const now = () => clock.at
    assert.equal(recheckLib.ASK_ORPHAN_GRACE_MS, 10 * MIN)
    clock.at = at('09:30:00')
    const c = trackerAs({ pid: 2, startedAt: clock.at }, live, { filePath, now })
    clock.at = at('10:00:00')
    const a = trackerAs({ pid: 1, startedAt: at('09:00:00') }, live, { filePath, now })
    a.register(group({ askId: 'g', ids: [1151] }))
    // A ends 20 s after the post: too short to say C ran beside it, so nothing is marked.
    clock.at = at('10:05:00')
    c.refresh()
    assert.equal(c.get('g')?.askerEndedBeside, undefined)
    assert.deepEqual(retirableIds(c), [], 'its restart may still come')
    clock.at = at('10:10:01')
    assert.deepEqual(retirableIds(c), ['g'], 'none came')
  })
})

test('recheck: the withdrawn event names what was answered and what was withdrawn, every meta value a string', () => {
  const build = recheckLib.buildAskWithdrawnEvent
  assert.equal(typeof build, 'function')
  const c = clock()
  const tracker = new AskTracker({ filePath: null, now: c.now })
  const ask = tracker.register(group({ askId: 'g', ids: [1161, 1162] }))
  tracker.record(1161, { optionValue: 'a1', optionLabel: 'A1' })
  const event = build!(tracker.get('g') ?? ask, { assistantId: '947', withdrawn: 1 })
  assert.equal(event.meta.event_type, 'ask_withdrawn')
  assert.equal(event.meta.ask_id, 'g')
  assert.equal(event.meta.chat_id, '77')
  for (const value of Object.values(event.meta)) assert.equal(typeof value, 'string')
  assert.match(event.content, /Question 1\?/)
  assert.match(event.content, /A1/)
  assert.match(event.content, /Question 2\?/)
  assert.match(event.content, /withdrawn/)
  assert.match(event.content, /ask_user_input/)
  assert.doesNotMatch(event.content, /[–—]/)
})

test('fresh review of the recheck, Important 3: a daemon never writes on a group it did not post, so sessions that may take an ended asker\'s card do not rewrite the file on every tick', () => {
  sharedFile(({ filePath, clock, live, at }) => {
    const now = () => clock.at
    const a = trackerAs({ pid: 1, startedAt: at('09:00:00') }, live, { filePath, now })
    a.register(group({ askId: 'g', ids: [1181] }))
    // A ends; two sessions open an hour later, both able to take the card (started after the post, never beside A).
    clock.at = at('11:00:00')
    const c1 = trackerAs({ pid: 5, startedAt: clock.at }, live, { filePath, now })
    const c2 = trackerAs({ pid: 6, startedAt: clock.at + 2_500 }, live, { filePath, now })
    live.push(5, 6)
    const before = readFileSync(filePath, 'utf8')
    runUntil(clock, at('11:02:00'), c1, c2)
    assert.equal(readFileSync(filePath, 'utf8'), before, 'nothing written')
  })
})

test('fresh review of the recheck, Important 2: a daemon that wakes from a sleep never reads a live asker\'s lease as lapsed before the asker has had time to write it again', () => {
  sharedFile(({ filePath, clock, live, at }) => {
    const now = () => clock.at
    clock.at = at('09:00:00')
    const b = trackerAs({ pid: 2, startedAt: clock.at }, live, { filePath, now })
    clock.at = at('10:00:00')
    const a = trackerAs({ pid: 1, startedAt: at('08:00:00') }, live, { filePath, now })
    a.register(group({ askId: 'g', ids: [1191] }))
    live.push(1, 2)
    runUntil(clock, at('10:30:00'), a, b)
    // The laptop sleeps an hour; on waking, B's tick runs before A's.
    clock.at = at('11:30:00')
    beat(b)
    assert.equal(b.get('g')?.askerEndedBeside, undefined, 'A is alive: its lease is an hour old only because both slept')
    runUntil(clock, at('11:31:00'), a, b)
    assert.equal(b.get('g')?.askerEndedBeside, undefined)
    // Both end, and A restarts alone: its card is its own.
    live.splice(0)
    clock.at = at('11:40:00')
    const a2 = trackerAs({ pid: 3, startedAt: clock.at }, live, { filePath, now })
    a2.record(1191, { skipped: true })
    assert.deepEqual(a2.completeUndelivered().map((x) => x.askId), ['g'])
  })
})

test('fresh review of the recheck, Minor 3: the withdrawn event never says another session posted the card (the connected daemon may be the asker restarted)', () => {
  const build = recheckLib.buildAskWithdrawnEvent
  assert.equal(typeof build, 'function')
  const tracker = new AskTracker({ filePath: null, now: clock().now })
  const ask = tracker.register(group({ askId: 'g', ids: [1201] }))
  const event = build!(ask, { assistantId: '947', withdrawn: 1 })
  assert.doesNotMatch(event.content, /another session/)
  assert.doesNotMatch(event.content, /did not ask/)
  assert.match(event.content, /can no longer receive/)
})

test('second fresh review of the recheck, Minor 2: retire passes 25 s apart (slow reads before them) still retire a live asker\'s card 35 s after it was first seen', () => {
  sharedFile(({ filePath, clock, live, at }) => {
    const now = () => clock.at
    const h1 = trackerAs({ pid: 1, startedAt: at('09:00:00') }, live, { filePath, now })
    h1.register(group({ askId: 'open', ids: [1211] }))
    live.push(1)
    runUntil(clock, at('10:01:00'), h1)
    const h2 = trackerAs({ pid: 2, startedAt: clock.at }, live, { filePath, now })
    live.push(2)
    const looks: Array<[number, string[]]> = [[0, retirableIds(h2)]]
    stepUntil(clock, at('10:01:50'), () => {
      beat(h1)
      beat(h2)
      const since = (clock.at - at('10:01:00')) / 1000
      if (since % 25 === 0) looks.push([since, retirableIds(h2)])
    })
    assert.deepEqual(looks, [[0, []], [25, []], [50, ['open']]])
  })
})

test('second fresh review of the recheck, Minor 2: a daemon that takes the connection again starts the clock again (connectedSince)', () => {
  sharedFile(({ filePath, clock, live, at }) => {
    const now = () => clock.at
    const h1 = trackerAs({ pid: 1, startedAt: at('09:00:00') }, live, { filePath, now })
    h1.register(group({ askId: 'open', ids: [1221] }))
    live.push(1)
    runUntil(clock, at('10:01:00'), h1)
    const h2 = trackerAs({ pid: 2, startedAt: clock.at }, live, { filePath, now })
    live.push(2)
    assert.deepEqual(retirableIds(h2, at('10:01:00')), [], 'seen aside from 10:01:00')
    // H2 stands down: no retire pass while it is passive (both still tick).
    runUntil(clock, at('10:20:00'), h1, h2)
    stepUntil(clock, at('10:20:05'), () => {
      beat(h1)
      beat(h2)
    })
    assert.deepEqual(retirableIds(h2, at('10:20:00')), [], 'connected again 5 s ago')
    stepUntil(clock, at('10:20:40'), () => {
      beat(h1)
      beat(h2)
      retirableIds(h2, at('10:20:00'))
    })
    assert.deepEqual(retirableIds(h2, at('10:20:00')), ['open'])
  })
})

test('third fresh review of the recheck, Minor 2: after a sleep the connected daemon waits ASK_LEASE_MS again before it retires a live asker\'s card it saw aside before', () => {
  sharedFile(({ filePath, clock, live, at }) => {
    const now = () => clock.at
    const h1 = trackerAs({ pid: 1, startedAt: at('09:00:00') }, live, { filePath, now })
    h1.register(group({ askId: 'open', ids: [1231] }))
    live.push(1)
    runUntil(clock, at('10:01:00'), h1)
    const h2 = trackerAs({ pid: 2, startedAt: clock.at }, live, { filePath, now })
    live.push(2)
    stepUntil(clock, at('10:01:20'), () => {
      beat(h1)
      beat(h2)
      retirableIds(h2, at('10:01:00'))
    })
    // Both sleep an hour: nobody looks.
    clock.at = at('11:01:20')
    // The first look after it (11:01:25) is the wake.
    const seen: Array<[number, string[]]> = []
    stepUntil(clock, at('11:02:00'), () => {
      beat(h1)
      beat(h2)
      seen.push([(clock.at - at('11:01:25')) / 1000, retirableIds(h2, at('10:01:00'))])
    })
    assert.deepEqual(
      seen.filter(([, ids]) => ids.length > 0).map(([s]) => s),
      [35],
      `nothing before 35 s after the wake: ${JSON.stringify(seen)}`,
    )
  })
})

/**
 * What the lease follow-up of #282 adds (Data's gate notes), read through the
 * instance so each case fails on its own before it exists.
 */
type LeaseFollowUp = {
  retire?: (askId: string, opts: { withdrawn: number; tellAsker?: boolean }) => PendingAsk | null
  takeRetiredOwn?: () => Array<{ ask: PendingAsk; withdrawn: number }>
}
const leaseOf = (t: AskTracker) => t as unknown as LeaseFollowUp
const fileOf = (filePath: string) =>
  JSON.parse(readFileSync(filePath, 'utf8')) as { pending: PendingAsk[]; retired?: Array<{ ask: PendingAsk }> }

for (const overlapS of [61, 65, 70, 74, 75]) {
  test(`lease follow-up, item 1: a session that ran beside the asker for ${overlapS} s before it ended never takes its answers`, () => {
    sharedFile(({ filePath, clock, live, at }) => {
      const now = () => clock.at
      const a = trackerAs({ pid: 1, startedAt: at('09:00:00') }, live, { filePath, now })
      a.register(group({ askId: 'g', ids: [1401] }))
      live.push(1)
      // B starts after the post, so only the overlap tells it from a restart.
      runUntil(clock, at('10:00:05'), a)
      const b = trackerAs({ pid: 2, startedAt: clock.at }, live, { filePath, now })
      live.push(2)
      // A says it runs every 15 s on its 5 s tick, so its last lease can be up to 15 s older than its end.
      stepUntil(clock, at('10:00:05') + overlapS * 1000, () => {
        beat(a)
        beat(b)
      })
      live.splice(live.indexOf(1), 1)
      stepUntil(clock, clock.at + 5_000, () => beat(b))
      b.record(1401, { skipped: true })
      assert.deepEqual(b.completeUndelivered().map((g) => g.askId), [], `B ran beside A for ${overlapS} s: another session`)
      assert.equal(b.isOurs(b.get('g')!), false)
    })
  })
}

test('lease follow-up, item 1: a real restart, started after the asker ended, still takes its answers; so does one that overlapped it a few seconds', () => {
  for (const startS of [75, 70]) {
    sharedFile(({ filePath, clock, live, at }) => {
      const now = () => clock.at
      const a = trackerAs({ pid: 1, startedAt: at('09:00:00') }, live, { filePath, now })
      a.register(group({ askId: 'g', ids: [1411] }))
      live.push(1)
      runUntil(clock, at('10:00:00') + startS * 1000, a)
      const a2 = trackerAs({ pid: 3, startedAt: clock.at }, live, { filePath, now })
      live.push(3)
      // A ends at 74 s, beside A2 started at 70 s; or as A2 starts, at 75 s.
      if (startS === 70) stepUntil(clock, at('10:01:14'), () => (beat(a), beat(a2)))
      live.splice(live.indexOf(1), 1)
      stepUntil(clock, clock.at + 10_000, () => beat(a2))
      a2.record(1411, { skipped: true })
      assert.deepEqual(a2.completeUndelivered().map((g) => g.askId), ['g'], `the restart started at ${startS} s`)
    })
  }
})

test('lease follow-up, item 2: a card retired while its asker still runs is handed to the asker once, and to no other session', () => {
  sharedFile(({ filePath, clock, live, at }) => {
    const now = () => clock.at
    const a = trackerAs({ pid: 1, startedAt: at('09:00:00') }, live, { filePath, now })
    a.register(group({ askId: 'g', ids: [1421, 1422] }))
    live.push(1)
    runUntil(clock, at('10:01:00'), a)
    const b = trackerAs({ pid: 2, startedAt: clock.at }, live, { filePath, now })
    const c = trackerAs({ pid: 3, startedAt: clock.at }, live, { filePath, now })
    live.push(2, 3)
    runUntil(clock, at('10:01:40'), a, b, c)
    // B holds the connection: it read one answer, retired the open question and withdraws the group.
    b.record(1421, { skipped: true })
    b.beginWithdraw('g')
    const retired = leaseOf(b).retire?.('g', { withdrawn: 1, tellAsker: true }) ?? 'missing'
    assert.notEqual(retired, 'missing')
    runUntil(clock, at('10:01:45'), a, b, c)
    const toA = leaseOf(a).takeRetiredOwn?.() ?? 'missing'
    assert.notEqual(toA, 'missing')
    assert.deepEqual(
      (toA as Array<{ ask: PendingAsk; withdrawn: number }>).map((r) => [r.ask.askId, r.withdrawn, Object.keys(r.ask.answers)]),
      [['g', 1, ['1421']]],
      'the asker gets its group as retired, with the answer read before',
    )
    assert.deepEqual(leaseOf(a).takeRetiredOwn?.(), [], 'once')
    runUntil(clock, at('10:02:00'), a, b, c)
    assert.deepEqual(leaseOf(a).takeRetiredOwn?.(), [], 'still once on later ticks')
    assert.deepEqual(leaseOf(b).takeRetiredOwn?.(), [], 'never the daemon that retired it')
    assert.deepEqual(leaseOf(c).takeRetiredOwn?.(), [], 'never another session')
    assert.equal(a.get('g'), null, 'the asker forgets the group')
    // The record ages out with the orphan grace.
    runUntil(clock, at('10:13:00'), a, b, c)
    b.register(group({ askId: 'later', ids: [1429] }))
    assert.deepEqual(fileOf(filePath).retired ?? [], [], 'dropped at the next save after the grace')
  })
})

test('lease follow-up, item 2: a card whose asker has ended leaves no record when it is retired', () => {
  sharedFile(({ filePath, clock, live, at }) => {
    const now = () => clock.at
    const a = trackerAs({ pid: 1, startedAt: at('09:00:00') }, live, { filePath, now })
    a.register(group({ askId: 'ended', ids: [1431] }))
    live.push(1)
    const b = trackerAs({ pid: 2, startedAt: at('09:30:00') }, live, { filePath, now })
    live.push(2)
    runUntil(clock, at('10:05:00'), a, b)
    live.splice(live.indexOf(1), 1)
    runUntil(clock, at('10:05:30'), b)
    b.beginWithdraw('ended')
    assert.notEqual(leaseOf(b).retire?.('ended', { withdrawn: 1, tellAsker: true }) ?? 'missing', 'missing')
    assert.deepEqual(fileOf(filePath).retired ?? [], [], 'nobody left to tell')
  })
})

test('lease follow-up, item 2: a group handed over to the asker\'s restart is delivered there and never told withdrawn', () => {
  sharedFile(({ filePath, clock, live, at }) => {
    const now = () => clock.at
    const a = trackerAs({ pid: 1, startedAt: at('09:00:00') }, live, { filePath, now })
    a.register(group({ askId: 'handed', ids: [1432] }))
    live.push(1)
    runUntil(clock, at('10:01:00'), a)
    live.splice(live.indexOf(1), 1)
    const a2 = trackerAs({ pid: 4, startedAt: at('10:01:05') }, live, { filePath, now })
    live.push(4)
    runUntil(clock, at('10:01:30'), a2)
    a2.record(1432, { skipped: true })
    assert.deepEqual(a2.completeUndelivered().map((g) => g.askId), ['handed'])
    a2.delivered('handed')
    runUntil(clock, at('10:01:40'), a2)
    assert.deepEqual(leaseOf(a2).takeRetiredOwn?.() ?? 'missing', [], 'the restart is never told')
    assert.deepEqual(fileOf(filePath).retired ?? [], [])
  })
})

test('lease follow-up, item 3: a clock stepped back a minute never stalls the lease refresh', () => {
  sharedFile(({ filePath, clock, live, at }) => {
    const now = () => clock.at
    const a = trackerAs({ pid: 1, startedAt: at('09:00:00') }, live, { filePath, now })
    a.register(group({ askId: 'g', ids: [1441] }))
    live.push(1)
    runUntil(clock, at('10:00:20'), a)
    // The clock steps back a minute.
    clock.at = at('09:59:20')
    const ages: number[] = []
    stepUntil(clock, at('10:00:00'), () => {
      beat(a)
      const leased = fileOf(filePath).pending.find((g) => g.askId === 'g')?.owner?.aliveAt ?? Number.NaN
      ages.push(clock.at - leased)
    })
    assert.ok(
      ages.every((ms) => ms >= 0 && ms <= 15_000 + 5_000),
      `the lease on file stays within a refresh of the clock: ${JSON.stringify(ages)}`,
    )
  })
})

test('lease follow-up review, Important 1: a clock stepped back before the post refreshes the lease at its usual rate, never on every tick', () => {
  sharedFile(({ filePath, clock, live, at }) => {
    const now = () => clock.at
    const a = trackerAs({ pid: 1, startedAt: at('09:00:00') }, live, { filePath, now })
    a.register(group({ askId: 'g', ids: [1451] }))
    live.push(1)
    runUntil(clock, at('10:00:20'), a)
    // Back a minute: the card now reads as posted 40 s in the future.
    clock.at = at('09:59:20')
    const leases = new Set<number>()
    stepUntil(clock, at('10:00:20'), () => {
      beat(a)
      leases.add(fileOf(filePath).pending.find((g) => g.askId === 'g')?.owner?.aliveAt ?? Number.NaN)
    })
    // 60 s at one lease every 15 s on the 5 s tick: 4 writes, never one a tick (12).
    assert.ok(leases.size <= 5, `the asker wrote ${leases.size} leases in 60 s: ${[...leases].map((t) => (t - at('09:59:20')) / 1000)}`)
  })
})

test('lease follow-up review, Important 1: after a clock steps back, another daemon takes the asker\'s corrected lease and never writes the future one back', () => {
  sharedFile(({ filePath, clock, live, at }) => {
    const now = () => clock.at
    const a = trackerAs({ pid: 1, startedAt: at('09:00:00') }, live, { filePath, now })
    a.register(group({ askId: 'g', ids: [1461] }))
    live.push(1)
    const d = trackerAs({ pid: 2, startedAt: at('09:30:00') }, live, { filePath, now })
    live.push(2)
    runUntil(clock, at('10:00:05'), a, d)
    // D asks too, so it saves on its own lease every 15 s.
    d.register(group({ askId: 'h', ids: [1462] }))
    runUntil(clock, at('10:00:20'), a, d)
    clock.at = at('09:59:20')
    const seenByD: number[] = []
    const onFile: number[] = []
    const leases = new Set<number>()
    stepUntil(clock, at('10:00:20'), () => {
      beat(a)
      beat(d)
      seenByD.push(clock.at - ((d.get('g') as PendingAsk | null)?.owner?.aliveAt ?? Number.NaN))
      const leased = fileOf(filePath).pending.find((g) => g.askId === 'g')?.owner?.aliveAt ?? Number.NaN
      onFile.push(clock.at - leased)
      leases.add(leased)
    })
    assert.ok(onFile.every((ms) => ms >= 0), `no future lease is written back to the file: ${JSON.stringify(onFile)}`)
    assert.ok(
      seenByD.every((ms) => ms >= 0 && ms <= 15_000 + 5_000),
      `D reads A's lease within a refresh of the clock: ${JSON.stringify(seenByD)}`,
    )
    assert.ok(leases.size <= 5, `A's lease was written ${leases.size} times in 60 s`)
  })
})

test('second fresh review of the follow-up, Important 1: a session that ran beside the asker never takes its answers after a clock steps back past the post and the asker ends', () => {
  sharedFile(({ filePath, clock, live, at }) => {
    const now = () => clock.at
    const a = trackerAs({ pid: 1, startedAt: at('09:00:00') }, live, { filePath, now })
    a.register(group({ askId: 'g', ids: [1501] }))
    live.push(1)
    runUntil(clock, at('10:00:05'), a)
    // B starts after the post, so only the overlap tells it from a restart.
    const b = trackerAs({ pid: 2, startedAt: clock.at }, live, { filePath, now })
    live.push(2)
    runUntil(clock, at('10:01:30'), a, b)
    // 85 s beside A; then the clock steps back to before the post, A says it runs on the stepped clock, and ends.
    clock.at = at('09:59:30')
    runUntil(clock, at('09:59:45'), a, b)
    live.splice(live.indexOf(1), 1)
    runUntil(clock, at('10:00:30'), b)
    b.record(1501, { skipped: true })
    assert.deepEqual(b.completeUndelivered().map((g) => g.askId), [], 'B ran beside A for 85 s: another session, whatever the clock did since')
    assert.equal(b.isOurs(b.get('g')!), false)
  })
})

test('second fresh review of the follow-up, Minor 4: a retire by a daemon that drew the dead asker\'s pid keeps no record nobody could take', () => {
  sharedFile(({ filePath, clock, live, at }) => {
    const now = () => clock.at
    const a = trackerAs({ pid: 1, startedAt: at('09:00:00') }, live, { filePath, now })
    a.register(group({ askId: 'g', ids: [1521] }))
    live.push(1)
    runUntil(clock, at('10:01:00'), a)
    // A ends; the connected daemon has its pid.
    const b = trackerAs({ pid: 1, startedAt: at('10:01:05') }, live, { filePath, now })
    clock.at = at('10:01:05')
    beat(b)
    b.beginWithdraw('g')
    assert.notEqual(leaseOf(b).retire?.('g', { withdrawn: 1, tellAsker: true }) ?? 'missing', 'missing')
    assert.deepEqual(fileOf(filePath).retired ?? [], [])
  })
})

test('second fresh review of the follow-up, Minor 3: a card the asker\'s restart holds is never retired, however late its answers, so no record is kept for anyone', () => {
  sharedFile(({ filePath, clock, live, at }) => {
    const now = () => clock.at
    const a = trackerAs({ pid: 1, startedAt: at('09:00:00') }, live, { filePath, now })
    a.register(group({ askId: 'kept', ids: [1531, 1532] }))
    live.push(1)
    runUntil(clock, at('10:01:00'), a)
    live.splice(live.indexOf(1), 1)
    const a2 = trackerAs({ pid: 4, startedAt: at('10:01:05') }, live, { filePath, now })
    live.push(4)
    // Past the orphan grace, answers still open.
    runUntil(clock, at('10:01:05') + (recheckLib.ASK_ORPHAN_GRACE_MS ?? 10 * MIN) + 5 * MIN, a2)
    assert.equal(a2.isOurs(a2.get('kept')!), true)
    assert.deepEqual(retirableIds(a2, at('10:01:05')), [])
    assert.deepEqual(fileOf(filePath).retired ?? [], [])
  })
})

test('lease follow-up review, Minor 5: a restart that drew the asker\'s pid again is never handed the asker\'s retired card', () => {
  sharedFile(({ filePath, clock, live, at }) => {
    const now = () => clock.at
    const a = trackerAs({ pid: 1, startedAt: at('09:00:00') }, live, { filePath, now })
    a.register(group({ askId: 'g', ids: [1481] }))
    live.push(1)
    const b = trackerAs({ pid: 2, startedAt: at('09:30:00') }, live, { filePath, now })
    live.push(2)
    runUntil(clock, at('10:01:00'), a, b)
    b.beginWithdraw('g')
    leaseOf(b).retire?.('g', { withdrawn: 1, tellAsker: true })
    assert.equal((fileOf(filePath).retired ?? []).length, 1, 'kept for the asker')
    // The asker ends before its tick; its restart draws the same pid.
    clock.at = at('10:01:05')
    const a2 = trackerAs({ pid: 1, startedAt: clock.at }, live, { filePath, now })
    beat(a2)
    assert.deepEqual(leaseOf(a2).takeRetiredOwn?.() ?? 'missing', [], 'the record names the asker\'s start, not just its pid')
  })
})

test('lease follow-up review, Minor 9: the asker is told how to ask again from a session without the connection (a blocking ask), never to post a card that returns pending', () => {
  const build = recheckLib.buildAskWithdrawnEvent as unknown as (ask: PendingAsk, opts: { assistantId: string; withdrawn: number; toAsker?: boolean }) => { content: string }
  const tracker = new AskTracker({ filePath: null })
  const ask = tracker.register(group({ askId: 'g', ids: [1491] }))
  const toAsker = build(ask, { assistantId: '9', withdrawn: 1, toAsker: true }).content
  assert.match(toAsker, /leave wait_seconds out/)
  assert.doesNotMatch(toAsker, /ask again with ask_user_input\.$/m)
  const toConnected = build(ask, { assistantId: '9', withdrawn: 1 }).content
  assert.match(toConnected, /ask again with ask_user_input\.$/m, 'the connected session asks as it always does')
})

test('lease follow-up review, Important 2: a retire the connected daemon may not tell (a share recipient\'s chat) leaves no record for the asker either', () => {
  sharedFile(({ filePath, clock, live, at }) => {
    const now = () => clock.at
    const a = trackerAs({ pid: 1, startedAt: at('09:00:00') }, live, { filePath, now })
    a.register(group({ askId: 'theirs', ids: [1471] }))
    live.push(1)
    const b = trackerAs({ pid: 2, startedAt: at('09:30:00') }, live, { filePath, now })
    live.push(2)
    runUntil(clock, at('10:01:00'), a, b)
    b.record(1471, { freeText: 'typed by a share recipient' })
    b.beginWithdraw('theirs')
    assert.notEqual(leaseOf(b).retire?.('theirs', { withdrawn: 0, tellAsker: false }) ?? 'missing', 'missing')
    assert.deepEqual(fileOf(filePath).retired ?? [], [], 'nothing kept for the asker')
    beat(a)
    assert.deepEqual(leaseOf(a).takeRetiredOwn?.() ?? [], [])
  })
})

// ── Data's two gaps after #284 ──

/**
 * lib/ask-retired-tell.ts, read through a dynamic import so each case fails
 * on its own before it exists: how a session hears of its own cards that the
 * daemon holding the connection retired.
 */
type RetiredTell = {
  tellRetiredOwnOnTick: (opts: {
    tracker: AskTracker
    channelLoaded: boolean | null
    send: (ask: PendingAsk, withdrawn: number) => Promise<void>
    log: (line: string) => void
  }) => void
  retiredOwnNotes: (opts: {
    tracker: AskTracker
    channelLoaded: boolean | null
    text: (ask: PendingAsk, withdrawn: number) => string | null
  }) => string[]
}
async function retiredTell(): Promise<RetiredTell> {
  const mod = (await import('../lib/ask-retired-tell.ts').catch(() => null)) as RetiredTell | null
  assert.ok(mod, 'lib/ask-retired-tell.ts')
  return mod
}
/** Every send's then and catch has run. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve))
type RetiredBecause = 'asker_disconnected' | 'asker_ended_beside' | 'asker_ended'
type Gap2 = { retiredBecause?: (ask: PendingAsk) => RetiredBecause }
const buildWithdrawn = recheckLib.buildAskWithdrawnEvent as unknown as (
  ask: PendingAsk,
  opts: { assistantId: string; withdrawn: number; toAsker?: boolean; retiredBecause?: RetiredBecause },
) => { content: string; meta: Record<string, string> }

/**
 * A, the holder, posts a card at 10:00:00. At 10:01:00 B takes the connection
 * (a channel takeover: B's channel is loaded, A's is not) and at 10:01:40
 * retires A's card with one answer read, keeping it for A, which runs on
 * passive. C is a third session. `tick` is the next 5 s ask tick for all three.
 */
async function retiredByTakeover(fn: (t: { a: AskTracker; b: AskTracker; c: AskTracker; tick: () => void }) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'ask-tracker-'))
  try {
    const at = (hhmmss: string) => Date.parse(`2026-10-27T${hhmmss}Z`)
    const filePath = join(dir, 'pending-asks.json')
    const clock = { at: at('10:00:00') }
    const live: number[] = []
    const now = () => clock.at
    const a = trackerAs({ pid: 1, startedAt: at('09:00:00') }, live, { filePath, now })
    a.register(group({ askId: 'g', ids: [1501, 1502] }))
    live.push(1)
    runUntil(clock, at('10:01:00'), a)
    const b = trackerAs({ pid: 2, startedAt: clock.at }, live, { filePath, now })
    const c = trackerAs({ pid: 3, startedAt: clock.at }, live, { filePath, now })
    live.push(2, 3)
    runUntil(clock, at('10:01:40'), a, b, c)
    b.record(1501, { skipped: true })
    b.beginWithdraw('g')
    assert.notEqual(leaseOf(b).retire?.('g', { withdrawn: 1, tellAsker: true }) ?? null, null)
    runUntil(clock, at('10:01:45'), a, b, c)
    await fn({ a, b, c, tick: () => runUntil(clock, clock.at + 5_000, a, b, c) })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('gaps after #284, gap 1: a tell whose send failed is sent again on the next tick, and never again once one landed', async () => {
  const { tellRetiredOwnOnTick } = await retiredTell()
  await retiredByTakeover(async ({ a, b, c, tick }) => {
    const sent: string[] = []
    let fail = true
    const send = async (ask: PendingAsk, withdrawn: number) => {
      sent.push(`${ask.askId} ${withdrawn} ${Object.keys(ask.answers).join(',')}`)
      if (fail) throw new Error('the transport is closed')
    }
    const logs: string[] = []
    const onTick = (t: AskTracker) => tellRetiredOwnOnTick({ tracker: t, channelLoaded: null, send, log: (line) => logs.push(line) })
    onTick(a)
    // The same tick again while that send is out: nothing more.
    onTick(a)
    await settle()
    assert.deepEqual(sent, ['g 1 1501'], 'one send while it is out')
    assert.match(logs.join('\n'), /g[\s\S]*failed/, 'the failed send is logged')
    tick()
    onTick(a)
    await settle()
    assert.deepEqual(sent, ['g 1 1501', 'g 1 1501'], 'the next tick sends it again')
    fail = false
    tick()
    onTick(a)
    await settle()
    assert.equal(sent.length, 3)
    for (let i = 0; i < 4; i++) {
      tick()
      for (const t of [a, b, c]) onTick(t)
      await settle()
    }
    assert.equal(sent.length, 3, 'once one landed, never again, and never from another session')
    assert.equal(a.get('g'), null, 'the asker forgets the group')
  })
})

test('gaps after #284, gap 1: the holder a channel takeover moved aside, whose channel is not loaded, gets its one ask_withdrawn on its next tool result', async () => {
  const { tellRetiredOwnOnTick, retiredOwnNotes } = await retiredTell()
  await retiredByTakeover(async ({ a, b, c, tick }) => {
    const sent: string[] = []
    const send = async (ask: PendingAsk) => {
      sent.push(ask.askId)
    }
    const text = (ask: PendingAsk, withdrawn: number) => buildWithdrawn(ask, { assistantId: '9', withdrawn, toAsker: true }).content
    tellRetiredOwnOnTick({ tracker: a, channelLoaded: false, send, log: () => {} })
    await settle()
    assert.deepEqual(sent, [], 'no channel event: a session whose channel is not loaded drops it unseen')
    const notes = retiredOwnNotes({ tracker: a, channelLoaded: false, text })
    assert.equal(notes.length, 1, 'one ask_withdrawn on the next tool result')
    assert.match(notes[0], /^\[ask_withdrawn\] A question card this session posted was retired \(ask_id=g\)/)
    assert.match(notes[0], /Question 1\?/, 'with the answer read before it was retired')
    tick()
    assert.deepEqual(retiredOwnNotes({ tracker: a, channelLoaded: false, text }), [], 'once')
    tellRetiredOwnOnTick({ tracker: a, channelLoaded: false, send, log: () => {} })
    await settle()
    assert.deepEqual(sent, [], 'and never by the channel after it')
    assert.deepEqual(retiredOwnNotes({ tracker: b, channelLoaded: false, text }), [], 'never the daemon that retired it')
    assert.deepEqual(retiredOwnNotes({ tracker: c, channelLoaded: false, text }), [], 'never another session')
  })
})

test('gaps after #284, gap 1: a session whose channel is loaded, or that cannot tell, hears it on the tick, never on a tool result', async () => {
  const { tellRetiredOwnOnTick, retiredOwnNotes } = await retiredTell()
  for (const channelLoaded of [true, null]) {
    await retiredByTakeover(async ({ a, tick }) => {
      const text = (ask: PendingAsk, withdrawn: number) => buildWithdrawn(ask, { assistantId: '9', withdrawn, toAsker: true }).content
      assert.deepEqual(retiredOwnNotes({ tracker: a, channelLoaded, text }), [], `channel loaded: ${channelLoaded}`)
      const sent: string[] = []
      tellRetiredOwnOnTick({ tracker: a, channelLoaded, send: async (ask) => void sent.push(ask.askId), log: () => {} })
      await settle()
      tick()
      tellRetiredOwnOnTick({ tracker: a, channelLoaded, send: async (ask) => void sent.push(ask.askId), log: () => {} })
      await settle()
      assert.deepEqual(sent, ['g'], `channel loaded: ${channelLoaded}`)
      assert.deepEqual(retiredOwnNotes({ tracker: a, channelLoaded: false, text }), [], 'told: the tool result carries nothing')
    })
  }
})

test('gaps after #284, gap 1: a card a tool result may not carry (a share recipient\'s chat) is dropped, never carried later', async () => {
  const { retiredOwnNotes } = await retiredTell()
  await retiredByTakeover(async ({ a, tick }) => {
    assert.deepEqual(retiredOwnNotes({ tracker: a, channelLoaded: false, text: () => null }), [])
    tick()
    const text = (ask: PendingAsk, withdrawn: number) => buildWithdrawn(ask, { assistantId: '9', withdrawn, toAsker: true }).content
    assert.deepEqual(retiredOwnNotes({ tracker: a, channelLoaded: false, text }), [])
  })
})

for (const startS of [5, 10, 15]) {
  test(`gaps after #284, gap 2: a restart that overlapped its asker by ${60 - startS} s never takes its answers, and the connected session is told the card was retired because its asker ended`, () => {
    sharedFile(({ filePath, clock, live, at }) => {
      const now = () => clock.at
      // B, another session, holds the connection all along.
      const b = trackerAs({ pid: 2, startedAt: at('09:30:00') }, live, { filePath, now })
      live.push(2)
      const a = trackerAs({ pid: 1, startedAt: at('09:00:00') }, live, { filePath, now })
      a.register(group({ askId: 'g', ids: [1511, 1512] }))
      live.push(1)
      runUntil(clock, at('10:00:00') + startS * 1000, a, b)
      // A2, A's restart, starts; A writes its lease at 10:01:00 and ends then.
      const a2 = trackerAs({ pid: 3, startedAt: clock.at }, live, { filePath, now })
      live.push(3)
      runUntil(clock, at('10:01:00'), a, a2, b)
      live.splice(live.indexOf(1), 1)
      runUntil(clock, at('10:01:40'), a2, b)
      a2.record(1511, { skipped: true })
      a2.record(1512, { freeText: 'typed late' })
      assert.deepEqual(a2.completeUndelivered().map((g) => g.askId), [], 'a restart cannot be told from a session beside the asker: it never takes the answers')
      assert.deepEqual(retirableIds(b), ['g'], 'the connected session retires it')
      const ask = b.get('g')!
      const because = (b as unknown as Gap2).retiredBecause?.(ask)
      assert.equal(because, 'asker_ended_beside', 'the connected session knows the asker ended beside another session')
      const event = buildWithdrawn(ask, { assistantId: '9', withdrawn: 0, retiredBecause: because })
      assert.match(
        event.content,
        /^\[ask_withdrawn\] A question card this agent posted was retired \(ask_id=g\): the session that asked it has ended after running beside another session of this agent/,
      )
      assert.match(event.content, /a restart of it cannot be told from one/)
      assert.match(event.content, /listed below for the record, not handed to this session as its own/, 'never read as answers to act on')
      assert.doesNotMatch(event.content, /no session may take its answers:/)
      assert.equal(event.meta.retired_because, 'asker_ended_beside')
      b.beginWithdraw('g')
      assert.notEqual(leaseOf(b).retire?.('g', { withdrawn: 0, tellAsker: true }) ?? null, null)
      runUntil(clock, at('10:01:45'), a2, b)
      assert.deepEqual(leaseOf(a2).takeRetiredOwn?.() ?? [], [], 'the restart is handed nothing')
      assert.deepEqual(fileOf(filePath).retired ?? [], [], 'no record for a session nobody can identify')
    })
  })
}

test('gaps after #284, gap 2: a card whose asker runs on without the connection is told as that, never as ended', () => {
  sharedFile(({ filePath, clock, live, at }) => {
    const now = () => clock.at
    const a = trackerAs({ pid: 1, startedAt: at('09:00:00') }, live, { filePath, now })
    a.register(group({ askId: 'g', ids: [1521] }))
    live.push(1)
    runUntil(clock, at('10:01:00'), a)
    const b = trackerAs({ pid: 2, startedAt: clock.at }, live, { filePath, now })
    live.push(2)
    stepUntil(clock, at('10:01:40'), () => {
      beat(a)
      beat(b)
      retirableIds(b, at('10:01:00'))
    })
    assert.deepEqual(retirableIds(b, at('10:01:00')), ['g'])
    const ask = b.get('g')!
    const because = (b as unknown as Gap2).retiredBecause?.(ask)
    assert.equal(because, 'asker_disconnected', 'A runs on, passive')
    const event = buildWithdrawn(ask, { assistantId: '9', withdrawn: 1, retiredBecause: because })
    assert.match(event.content, /the session that asked it runs on without this agent's connection/)
    // Its tell can still miss it (it ends before its next tick, an older plugin): second fresh review of the gaps, Minor 1.
    assert.match(event.content, /that session is told too while it still runs\./)
    assert.equal(event.meta.retired_because, 'asker_disconnected')
  })
})

test('gaps after #284 review, Important 1: an asker that ended with no restart taking the connection within the grace is told as that, never as one that ran beside another session', () => {
  sharedFile(({ filePath, clock, live, at }) => {
    const now = () => clock.at
    // B, another session, holds the connection all along; A runs 20 s after its post, too short to be beside B.
    const b = trackerAs({ pid: 2, startedAt: at('09:30:00') }, live, { filePath, now })
    live.push(2)
    const a = trackerAs({ pid: 1, startedAt: at('09:00:00') }, live, { filePath, now })
    a.register(group({ askId: 'g', ids: [1531, 1532] }))
    live.push(1)
    runUntil(clock, at('10:00:20'), a, b)
    live.splice(live.indexOf(1), 1)
    // A2, A's restart, starts after A ended: it may take the card, but never holds the connection.
    runUntil(clock, at('10:01:00'), b)
    const a2 = trackerAs({ pid: 3, startedAt: clock.at }, live, { filePath, now })
    live.push(3)
    runUntil(clock, at('10:01:30'), a2, b)
    a2.record(1531, { skipped: true })
    a2.record(1532, { skipped: true })
    assert.deepEqual(a2.completeUndelivered().map((g) => g.askId), ['g'], 'A2 is A restarted, and may take it')
    runUntil(clock, at('10:11:00'), a2, b)
    assert.deepEqual(retirableIds(b), ['g'], 'B retires it after the grace')
    const ask = b.get('g')!
    assert.equal(ask.askerEndedBeside, undefined)
    const because = (b as unknown as Gap2).retiredBecause?.(ask)
    assert.equal(because, 'asker_ended')
    const event = buildWithdrawn(ask, { assistantId: '9', withdrawn: 0, retiredBecause: because })
    assert.match(event.content, /: the session that asked it has ended, and no restart of it took this agent's connection within 10 minutes to receive its answers\./)
    assert.doesNotMatch(event.content, /cannot be told from one|beside/, 'here a restart can be told apart; it only lacked the connection')
    assert.match(event.content, /listed below for the record, not handed to this session as its own/)
    assert.equal(event.meta.retired_because, 'asker_ended')
  })
})

test('gaps after #284, second review, Important 1: an asker past its lease whose pid reads alive (Windows hands a dead pid to the next process at once) is told as ended, never as running on; the retire still keeps its record, which only that same process can take', () => {
  sharedFile(({ filePath, clock, live, at }) => {
    const now = () => clock.at
    const b = trackerAs({ pid: 2, startedAt: at('09:30:00') }, live, { filePath, now })
    live.push(2)
    const a = trackerAs({ pid: 1, startedAt: at('09:00:00') }, live, { filePath, now })
    a.register(group({ askId: 'g', ids: [1541] }))
    live.push(1)
    runUntil(clock, at('10:00:30'), a, b)
    // A stops writing its lease, past the grace, and its pid still reads alive: A hung, or A ended and its pid is another process's now.
    runUntil(clock, at('10:11:00'), b)
    assert.deepEqual(retirableIds(b), ['g'])
    const because = (b as unknown as Gap2).retiredBecause?.(b.get('g')!)
    assert.equal(because, 'asker_ended', 'the lease, never the pid alone, says whether the asker runs')
    const event = buildWithdrawn(b.get('g')!, { assistantId: '9', withdrawn: 1, retiredBecause: because })
    assert.doesNotMatch(event.content, /runs on|told too/, 'never tells a session its asker runs on and is told, when that may be another process')
    b.beginWithdraw('g')
    assert.notEqual(leaseOf(b).retire?.('g', { withdrawn: 1, tellAsker: true }) ?? null, null)
    assert.equal((fileOf(filePath).retired ?? []).length, 1, 'the record is kept on the pid, for A if it only hung')
    const samePid = trackerAs({ pid: 1, startedAt: at('10:05:00') }, live, { filePath, now })
    assert.deepEqual(leaseOf(samePid).takeRetiredOwn?.() ?? [], [], 'another process on the same pid takes nothing')
  })
})

test('gaps after #284, third review, Important 1: after a look gap (a sleep) the reason still reads the lease, so a beside card whose asker\'s pid was handed on is never told as running on', () => {
  sharedFile(({ filePath, clock, live, at }) => {
    const now = () => clock.at
    const b = trackerAs({ pid: 2, startedAt: at('09:30:00') }, live, { filePath, now })
    live.push(2)
    const a = trackerAs({ pid: 1, startedAt: at('09:00:00') }, live, { filePath, now })
    a.register(group({ askId: 'g', ids: [1561] }))
    live.push(1)
    runUntil(clock, at('10:00:10'), a, b)
    const a2 = trackerAs({ pid: 3, startedAt: clock.at }, live, { filePath, now })
    live.push(3)
    runUntil(clock, at('10:01:00'), a, a2, b)
    // A ends at 10:01:00; pid 1 stays alive, another process's now.
    runUntil(clock, at('10:01:40'), a2, b)
    assert.notEqual(b.get('g')?.askerEndedBeside, undefined)
    // B sleeps for a minute: on waking it cannot judge a lease for ASK_LEASE_MS.
    clock.at += 60_000
    assert.deepEqual(retirableIds(b), ['g'], 'a beside card is retired whatever the leases say')
    const because = (b as unknown as Gap2).retiredBecause?.(b.get('g')!)
    assert.equal(because, 'asker_ended_beside', 'the words lean to ended when the lease cannot be judged')
  })
})

test('gaps after #284, third review, Minor 1: a card retired while its asker ran, whose asker ends before the retire is done, is told the asker ended beside another session, never that a 10 minute grace passed', () => {
  sharedFile(({ filePath, clock, live, at }) => {
    const now = () => clock.at
    const a = trackerAs({ pid: 1, startedAt: at('09:00:00') }, live, { filePath, now })
    a.register(group({ askId: 'g', ids: [1571] }))
    live.push(1)
    runUntil(clock, at('10:01:00'), a)
    const b = trackerAs({ pid: 2, startedAt: clock.at }, live, { filePath, now })
    live.push(2)
    stepUntil(clock, at('10:01:40'), () => {
      beat(a)
      beat(b)
      retirableIds(b, at('10:01:00'))
    })
    assert.deepEqual(retirableIds(b, at('10:01:00')), ['g'], 'picked while A runs on without the connection')
    // A ends during the retire's read and PATCH.
    live.splice(live.indexOf(1), 1)
    clock.at += 2_000
    const ask = b.get('g')!
    assert.equal(ask.askerEndedBeside, undefined)
    const because = (b as unknown as Gap2).retiredBecause?.(ask)
    assert.equal(because, 'asker_ended_beside', 'A ran beside B and went silent seconds ago')
    const event = buildWithdrawn(ask, { assistantId: '9', withdrawn: 1, retiredBecause: because })
    assert.doesNotMatch(event.content, /within 10 minutes/)
  })
})

test('gaps after #284, second review, Important 1: a restart that overlapped its asker by 50 s never takes its answers, and the connected session is told the asker ended beside another session, also when the asker\'s pid was handed to another process at once', () => {
  sharedFile(({ filePath, clock, live, at }) => {
    const now = () => clock.at
    const b = trackerAs({ pid: 2, startedAt: at('09:30:00') }, live, { filePath, now })
    live.push(2)
    const a = trackerAs({ pid: 1, startedAt: at('09:00:00') }, live, { filePath, now })
    a.register(group({ askId: 'g', ids: [1551] }))
    live.push(1)
    runUntil(clock, at('10:00:10'), a, b)
    const a2 = trackerAs({ pid: 3, startedAt: clock.at }, live, { filePath, now })
    live.push(3)
    runUntil(clock, at('10:01:00'), a, a2, b)
    // A ends at 10:01:00; pid 1 stays alive, another process's now.
    runUntil(clock, at('10:01:40'), a2, b)
    a2.record(1551, { skipped: true })
    assert.deepEqual(a2.completeUndelivered().map((g) => g.askId), [], 'still never the restart\'s')
    assert.deepEqual(retirableIds(b), ['g'])
    const ask = b.get('g')!
    assert.notEqual(ask.askerEndedBeside, undefined)
    const because = (b as unknown as Gap2).retiredBecause?.(ask)
    assert.equal(because, 'asker_ended_beside')
    const event = buildWithdrawn(ask, { assistantId: '9', withdrawn: 0, retiredBecause: because })
    assert.match(event.content, /ended after running beside another session of this agent/)
    assert.doesNotMatch(event.content, /runs on|told too/)
  })
})
