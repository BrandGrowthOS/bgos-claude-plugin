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
} from '../lib/ask-tracker.ts'

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

function completeGroupOf(tracker: AskTracker, askId: string, ids: number[], owner?: { pid: number; startedAt: number }, postedAt?: number) {
  const ask = tracker.register(group({ askId, ids }))
  if (owner) (ask as unknown as { owner: unknown }).owner = owner
  if (postedAt !== undefined) ask.postedAt = postedAt
  for (const id of ids) tracker.record(id, { skipped: true })
  return ask
}

test('item 1: a complete group another live daemon posted is never offered for an announce here', () => {
  const self = { pid: 10, startedAt: Date.parse('2026-10-27T09:00:00Z') }
  const tracker = trackerAs(self, [20])
  completeGroupOf(tracker, 'theirs', [801], { pid: 20, startedAt: self.startedAt - MIN }, self.startedAt + MIN)
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
    assert.deepEqual(onDisk.pending[0].owner, self)
    const other = trackerAs({ pid: 7, startedAt: self.startedAt + MIN }, [4242], { filePath })
    assert.deepEqual((other.get('g') as unknown as { owner: unknown }).owner, self)
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

test('second review, Important 2: a session started after the card, beside its live asker, never takes the answers once the asker ends', () => {
  sharedFile(({ filePath, clock, live, at }) => {
    const now = () => clock.at
    const a = trackerAs({ pid: 1, startedAt: at('09:00:00') }, live, { filePath, now })
    a.register(group({ askId: 'g', ids: [901, 902] }))
    live.push(1)
    clock.at = at('10:30:00')
    const b = trackerAs({ pid: 2, startedAt: clock.at }, live, { filePath, now })
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
    clock.at = at('10:10:00')
    const a2 = trackerAs({ pid: 3, startedAt: clock.at }, live, { filePath, now })
    live.splice(live.indexOf(1), 1)
    clock.at = at('10:10:03')
    a2.refresh()
    a2.record(911, { skipped: true })
    assert.deepEqual(a2.completeUndelivered().map((g) => g.askId), ['g'])
  })
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
  assert.match(r.error, /more waits 600/)
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
