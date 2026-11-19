import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import {
  buildMissionAddGoalsBody,
  buildMissionCreateBody,
  buildMissionSetGoalsBody,
  buildMissionGoalWaitingBody,
  buildMissionGoalChecksPath,
  buildMissionGoalWaitingPath,
  formatMissionSummary,
} from '../lib/missions.ts'

/**
 * The mission tools carry a goal's machine check and a goal's waiting state
 * (mission turn checks). The SERVER validates a check
 * strictly (unknown kind or extra key: a 400 with one sentence), so the tool
 * passes the object through unchanged and only refuses what is not an object
 * at all; it must never drop a key, or the server's refusal would turn into a
 * silent rewrite.
 */

const CHECK = { kind: 'pr_merged', repo: 'example/project', number: 42 }
const goal = { name: 'Merge', done_when: 'PR 42 is merged' }

test('create, fill and add pass a goal check through unchanged, every key kept', () => {
  const odd = { ...CHECK, numbr: 'kept for the server to refuse' }
  const create = buildMissionCreateBody({ title: 'Ship', mini_goals: [{ ...goal, check: odd }, { name: 'B', done_when: 'b' }] })
  assert.ok(create.ok)
  assert.deepEqual(create.body.miniGoals[0], { name: 'Merge', doneWhen: 'PR 42 is merged', check: odd })
  assert.equal('check' in create.body.miniGoals[1], false)

  const fill = buildMissionSetGoalsBody({ mini_goals: [{ ...goal, check: CHECK }, { name: 'B', done_when: 'b' }] })
  assert.ok(fill.ok)
  assert.deepEqual(fill.body.miniGoals[0].check, CHECK)

  const add = buildMissionAddGoalsBody({ mini_goals: [{ ...goal, check: CHECK }] })
  assert.ok(add.ok)
  assert.deepEqual(add.body.miniGoals[0].check, CHECK)
})

test('a check that is not an object is refused before the network, naming the goal', () => {
  for (const check of ['pr_merged', 3, ['pr_merged']]) {
    const built = buildMissionAddGoalsBody({ mini_goals: [{ ...goal, check }] })
    assert.equal(built.ok, false)
    if (!built.ok) assert.match(built.error, /Mini-goal 1/)
  }
  const none = buildMissionAddGoalsBody({ mini_goals: [{ ...goal, check: null }] })
  assert.ok(none.ok)
  if (none.ok) assert.equal('check' in none.body.miniGoals[0], false)
})

test('set_goal_waiting: the body and the pairing path', () => {
  assert.deepEqual(buildMissionGoalWaitingBody({ waiting: { on: 'owner', who: 'Demo Owner', why: 'his merge' } }), {
    ok: true,
    body: { waiting: { on: 'owner', who: 'Demo Owner', why: 'his merge' } },
  })
  assert.deepEqual(buildMissionGoalWaitingBody({ waiting: null }), { ok: true, body: { waiting: null } })
  for (const waiting of [undefined, { on: 'team', who: 'x', why: 'y' }, { on: 'owner', who: '', why: 'y' }, { on: 'owner', who: 'Demo Owner', why: '' }, 'owner']) {
    assert.equal(buildMissionGoalWaitingBody({ waiting }).ok, false, JSON.stringify(waiting))
  }
  assert.deepEqual(buildMissionGoalWaitingPath(7, 12, 3), {
    ok: true,
    path: 'integrations/assistants/7/missions/12/goals/3/waiting',
  })
  assert.equal(buildMissionGoalWaitingPath(7, 12, 0).ok, false)
})

test('the summary shows a goal check, a server tick and a waiting state in one clause each', () => {
  const text = formatMissionSummary({
    id: 12,
    title: 'Ship it',
    status: 'active',
    miniGoals: [
      { id: 1, name: 'Merge', doneWhen: 'merged', done: true, doneAt: 'x', evidence: 'e', check: CHECK, doneBy: 'check' },
      { id: 2, name: 'Live', doneWhen: 'answers', done: false, doneAt: null, evidence: null, check: { kind: 'url_ok', url: 'https://example.invalid/health' } },
      { id: 3, name: 'Date', doneWhen: 'picked', done: false, doneAt: null, evidence: null, waiting: { on: 'owner', who: 'Demo Owner', why: 'his call', since: 'x' } },
    ],
  })
  assert.match(text, /\[x\] 1\. Merge \(done when merged\) \[server check: PR example\/project#42 merged\] \[ticked by the server\]/)
  assert.match(text, /\[ \] 2\. Live \(done when answers\) \[server check: https:\/\/example\.invalid\/health answers 2xx\]/)
  assert.match(text, /\[ \] 3\. Date \(done when picked\) \[waiting on your owner Demo Owner: his call\]/)
  // The next goal is the agent's own, never one that waits on somebody.
  assert.match(text, /Next: 2\. Live/)
})

test('the goal checks read is the pairing family, by mission', () => {
  assert.deepEqual(buildMissionGoalChecksPath(7, 12), {
    ok: true,
    path: 'integrations/assistants/7/missions/12/goal-checks',
  })
  assert.equal(buildMissionGoalChecksPath(7, 0).ok, false)
  assert.equal(buildMissionGoalChecksPath(undefined, 12).ok, false)
})


test('the next suggested goal skips an earlier waiting goal', () => {
  const text = formatMissionSummary({ id: 12, title: 'Demo', status: 'active', miniGoals: [
    { id: 1, name: 'Decision', doneWhen: 'decided', done: false, doneAt: null, evidence: null, waiting: { on: 'owner', who: 'Demo Owner', why: 'choose a date' } },
    { id: 2, name: 'Draft', doneWhen: 'saved', done: false, doneAt: null, evidence: null },
  ] })
  assert.match(text, /Next: 2\. Draft/)
})

test('nested waiting uses current validation and rejects mixed flat and nested calls', () => {
  assert.deepEqual(buildMissionGoalWaitingBody({ waiting: { on: 'agent', who: ' Demo Agent ', why: ' review ' } }), {
    ok: true, body: { waiting: { on: 'agent', who: 'Demo Agent', why: 'review' } },
  })
  for (const waiting of [{ on: 'owner', who: 'bad\nname', why: 'review' }, { on: 'agent', who: 'x'.repeat(81), why: 'review' }, { on: 'agent', who: 'Demo Agent', why: 'x'.repeat(201) }]) {
    assert.equal(buildMissionGoalWaitingBody({ waiting }).ok, false)
  }
  for (const flat of [{ clear: true }, { clear: false }, { on: 'owner' }, { who: 'Demo Owner' }, { why: 'review' }]) {
    assert.equal(buildMissionGoalWaitingBody({ waiting: null, ...flat }).ok, false)
  }
})
