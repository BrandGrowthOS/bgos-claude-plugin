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
