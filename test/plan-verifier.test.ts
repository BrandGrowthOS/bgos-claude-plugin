/**
 * The /plan verifier: the one honest thing a daemon can do about a directive
 * it cannot enforce.
 *
 * `/plan` reaches the model as a directive, so it can be ignored, and the owner
 * who typed it would be left watching silence. The verifier watches this
 * process's own tool chokepoint and says, in the chat, when no plan came. It
 * NEVER blocks anything, and the pins below are mostly about the ways a
 * complaint could be posted WRONGLY: into a chat whose plan is still coming,
 * twice for one arm, or after the owner withdrew the request.
 *
 * Run with: npx tsx --test test/plan-verifier.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  PLAN_VERIFIER_MESSAGE,
  PLAN_VERIFIER_WINDOW_MS,
  armPlanVerifier,
  cancelPlanVerifiers,
  createPlanVerifierState,
  disarmPlanVerifier,
  duePlanVerifiers,
  endTurnPlanVerifiers,
} from '../lib/plan-verifier.ts'

const T0 = 1_700_000_000_000

test('arming records the chat, the /plan message and a deadline', () => {
  const state = createPlanVerifierState()
  const entry = armPlanVerifier(state, { chatId: 12, messageId: 501, nowMs: T0 })
  assert.equal(entry.chatId, '12')
  assert.equal(entry.messageId, 501)
  assert.equal(entry.deadlineMs, T0 + PLAN_VERIFIER_WINDOW_MS)
  assert.equal(state.size, 1)
})

test('a second /plan in the same chat replaces the first, it does not queue', () => {
  // Asking again is one complaint, not two, and two lines would be noise on the
  // surface the owner is already watching.
  const state = createPlanVerifierState()
  armPlanVerifier(state, { chatId: 12, messageId: 501, nowMs: T0 })
  armPlanVerifier(state, { chatId: 12, messageId: 502, nowMs: T0 + 1_000 })
  assert.equal(state.size, 1)
  assert.equal(state.get('12')!.messageId, 502)
})

test('the first propose_plan call settles EVERY armed chat, silently', () => {
  // A turn is one model and one transcript. If it proposed a plan anywhere it
  // answered the directive, and firing "no plan came" into a second chat
  // because the plan landed in the first would be a false report. The cost is a
  // missed complaint, which is the safe direction for a message that interrupts.
  const state = createPlanVerifierState()
  armPlanVerifier(state, { chatId: 12, messageId: 501, nowMs: T0 })
  armPlanVerifier(state, { chatId: 13, messageId: 502, nowMs: T0 })
  const cancelled = cancelPlanVerifiers(state)
  assert.equal(cancelled.length, 2)
  assert.equal(state.size, 0)
  assert.deepEqual(duePlanVerifiers(state, T0 + PLAN_VERIFIER_WINDOW_MS * 10), [])
})

test('the Stop hook fires the line at once for the chat the turn belonged to', () => {
  // The better ending: the turn FINISHED without a plan, which is observed
  // rather than guessed, so the owner hears about it now and not in five
  // minutes.
  const state = createPlanVerifierState()
  armPlanVerifier(state, { chatId: 12, messageId: 501, nowMs: T0 })
  armPlanVerifier(state, { chatId: 13, messageId: 502, nowMs: T0 })
  const fired = endTurnPlanVerifiers(state, '12')
  assert.deepEqual(fired.map((e) => e.chatId), ['12'])
  assert.equal(state.size, 1, 'the other chat keeps its own verifier')
})

test('an UNATTRIBUTED turn end settles nothing, and the timer keeps its job', () => {
  // hookChatId() falls back to the first monitored chat when a turn cannot be
  // attributed. Firing on that guess would post "no plan arrived" into a chat
  // that never asked for one, so a null chat id is a no-op here by contract.
  const state = createPlanVerifierState()
  armPlanVerifier(state, { chatId: 12, messageId: 501, nowMs: T0 })
  assert.deepEqual(endTurnPlanVerifiers(state, null), [])
  assert.deepEqual(endTurnPlanVerifiers(state, undefined), [])
  assert.deepEqual(endTurnPlanVerifiers(state, ''), [])
  assert.equal(state.size, 1)
  assert.equal(duePlanVerifiers(state, T0 + PLAN_VERIFIER_WINDOW_MS).length, 1)
})

test('the window fires exactly once per arm, then the entry is gone', () => {
  const state = createPlanVerifierState()
  armPlanVerifier(state, { chatId: 12, messageId: 501, nowMs: T0 })
  assert.deepEqual(duePlanVerifiers(state, T0 + PLAN_VERIFIER_WINDOW_MS - 1), [])
  const first = duePlanVerifiers(state, T0 + PLAN_VERIFIER_WINDOW_MS)
  assert.equal(first.length, 1)
  assert.deepEqual(duePlanVerifiers(state, T0 + PLAN_VERIFIER_WINDOW_MS * 5), [])
})

test('a clock that jumps BACKWARDS cannot fire one early', () => {
  const state = createPlanVerifierState()
  armPlanVerifier(state, { chatId: 12, messageId: 501, nowMs: T0 })
  assert.deepEqual(duePlanVerifiers(state, T0 - 60_000), [])
  assert.equal(state.size, 1)
})

test('closing the Plan mode chip disarms without a complaint', () => {
  // /code is the owner withdrawing the request. A line saying no plan came
  // would be about a plan nobody is waiting for.
  const state = createPlanVerifierState()
  armPlanVerifier(state, { chatId: 12, messageId: 501, nowMs: T0 })
  assert.equal(disarmPlanVerifier(state, 12), true)
  assert.equal(state.size, 0)
  assert.equal(disarmPlanVerifier(state, 12), false)
})

test('the line the daemon posts claims nothing about the working tree', () => {
  // The daemon is speaking, not the model, and it cannot see what changed. A
  // line promising "nothing was changed" would be a guarantee this channel
  // cannot give, which is the same mistake the card copy avoids.
  assert.match(PLAN_VERIFIER_MESSAGE, /none arrived/)
  assert.ok(
    !/nothing (was|has been) changed/i.test(PLAN_VERIFIER_MESSAGE),
    'the daemon must not claim the tree is untouched; it cannot know',
  )
  assert.ok(PLAN_VERIFIER_MESSAGE.length < 200, 'one line, read on a phone')
})
