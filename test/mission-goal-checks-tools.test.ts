import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import {
  buildMissionAddGoalsBody,
  buildMissionCreateBody,
  buildMissionGoalChecksPath,
  buildMissionSetGoalsBody,
  buildMissionWaitingBody,
  buildMissionWaitingPath,
  formatMissionSummary,
} from '../lib/missions.ts'

/**
 * The mission tools carry a goal's machine check and a goal's waiting state
 * (missions that stay true, board row 01a177c7). The SERVER validates a check
 * strictly (unknown kind or extra key: a 400 with one sentence), so the tool
 * passes the object through unchanged and only refuses what is not an object
 * at all; it must never drop a key, or the server's refusal would turn into a
 * silent rewrite.
 */

const CHECK = { kind: 'pr_merged', repo: 'BrandGrowthOS/BGOS', number: 3306 }
const goal = { name: 'Merge', done_when: 'PR 3306 is merged' }

test('create, fill and add pass a goal check through unchanged, every key kept', () => {
  const odd = { ...CHECK, numbr: 'kept for the server to refuse' }
  const create = buildMissionCreateBody({ title: 'Ship', mini_goals: [{ ...goal, check: odd }, { name: 'B', done_when: 'b' }] })
  assert.ok(create.ok)
  assert.deepEqual(create.body.miniGoals[0], { name: 'Merge', doneWhen: 'PR 3306 is merged', check: odd })
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
  assert.deepEqual(buildMissionWaitingBody({ waiting: { on: 'owner', who: 'KC', why: 'his merge' } }), {
    ok: true,
    body: { waiting: { on: 'owner', who: 'KC', why: 'his merge' } },
  })
  assert.deepEqual(buildMissionWaitingBody({ waiting: null }), { ok: true, body: { waiting: null } })
  for (const waiting of [undefined, { on: 'team', who: 'x', why: 'y' }, { on: 'owner', who: '', why: 'y' }, { on: 'owner', who: 'KC', why: '' }, 'owner']) {
    assert.equal(buildMissionWaitingBody({ waiting }).ok, false, JSON.stringify(waiting))
  }
  assert.deepEqual(buildMissionWaitingPath(7, 12, 3), {
    ok: true,
    path: 'integrations/assistants/7/missions/12/goals/3/waiting',
  })
  assert.equal(buildMissionWaitingPath(7, 12, 0).ok, false)
})

test('the summary shows a goal check, a server tick and a waiting state in one clause each', () => {
  const text = formatMissionSummary({
    id: 12,
    title: 'Ship it',
    status: 'active',
    miniGoals: [
      { id: 1, name: 'Merge', doneWhen: 'merged', done: true, doneAt: 'x', evidence: 'e', check: CHECK, doneBy: 'check' },
      { id: 2, name: 'Live', doneWhen: 'answers', done: false, doneAt: null, evidence: null, check: { kind: 'url_ok', url: 'https://hoai.app/health' } },
      { id: 3, name: 'Date', doneWhen: 'picked', done: false, doneAt: null, evidence: null, waiting: { on: 'owner', who: 'KC', why: 'his call', since: 'x' } },
    ],
  })
  assert.match(text, /\[x\] 1\. Merge \(done when merged\) \[server check: PR BrandGrowthOS\/BGOS#3306 merged\] \[ticked by the server\]/)
  assert.match(text, /\[ \] 2\. Live \(done when answers\) \[server check: https:\/\/hoai\.app\/health answers 2xx\]/)
  assert.match(text, /\[ \] 3\. Date \(done when picked\) \[waiting on your owner KC: his call\]/)
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
