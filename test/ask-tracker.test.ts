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
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  AskTracker,
  askAnswerFromRow,
  askPendingText,
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
  tracker.hold('ask-1')
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

test('the wait is 0 unless asked for: post, return pending, end the turn', () => {
  assert.equal(askWaitSeconds({}), 0)
  assert.equal(askWaitSeconds({ wait_seconds: 0 }), 0)
  assert.equal(askWaitSeconds({ wait_seconds: -5 }), 0)
  assert.equal(askWaitSeconds({ wait_seconds: 'soon' }), 0)
})

test('wait_seconds blocks up to its value, capped at the old 600 s default', () => {
  assert.equal(askWaitSeconds({ wait_seconds: 90 }), 90)
  assert.equal(askWaitSeconds({ wait_seconds: 5000 }), MAX_ASK_WAIT_SECONDS)
  assert.equal(MAX_ASK_WAIT_SECONDS, 600)
})

test('timeout_seconds keeps its meaning: the upper bound of a blocking wait, uncapped as before', () => {
  assert.equal(askWaitSeconds({ timeout_seconds: 600 }), 600)
  assert.equal(askWaitSeconds({ timeout_seconds: 1200 }), 1200)
  assert.equal(askWaitSeconds({ timeout_seconds: 30, wait_seconds: 10 }), 10, 'wait_seconds wins when both are given')
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
