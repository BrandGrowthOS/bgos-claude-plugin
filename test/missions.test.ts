/**
 * Eval suite for the mission tool builders (create_mission / tick_mini_goal /
 * complete_mission, BGOS capability #19).
 *
 * Wire contract (user-scoped routes, X-API-Key; the plugin's assistants have
 * pairingId = null so the /integrations twins do not apply here):
 *
 *   POST  assistants/:assistantId/missions                      create
 *   GET   assistants/:assistantId/missions/active               { mission | null }
 *   PATCH assistants/:assistantId/missions/:missionId/tick      { goalId, evidence? }
 *   PATCH assistants/:assistantId/missions/:missionId/complete
 *
 * Create body: { title, miniGoals: [{ name, doneWhen }] }, 2..12 goals
 * (trained flow targets 4 to 10), title <= 200, name <= 120, doneWhen <= 200,
 * evidence <= 200. Responses embed the full mission snapshot with
 * server-assigned goal ids 1..n.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import {
  MISSION_MIN_GOALS,
  MISSION_MAX_GOALS,
  MISSION_TITLE_MAX,
  MISSION_GOAL_NAME_MAX,
  MISSION_DONE_WHEN_MAX,
  MISSION_EVIDENCE_MAX,
  buildMissionCreateBody,
  buildMissionTickBody,
  buildMissionCreatePath,
  buildMissionActivePath,
  buildMissionTickPath,
  buildMissionCompletePath,
  formatMissionSummary,
  type MissionSnapshot,
} from '../lib/missions.ts'

const goals = (n: number) =>
  Array.from({ length: n }, (_v, i) => ({
    name: `Goal ${i + 1}`,
    done_when: `check ${i + 1} passes`,
  }))

const snapshot = (overrides: Partial<MissionSnapshot> = {}): MissionSnapshot => ({
  id: 42,
  title: 'Launch the newsletter',
  status: 'active',
  miniGoals: [
    { id: 1, name: 'Segments', doneWhen: 'doc has 3 personas', done: true, doneAt: 'x', evidence: null },
    { id: 2, name: 'Landing page', doneWhen: 'URL returns 200', done: false, doneAt: null, evidence: null },
    { id: 3, name: 'Signup form', doneWhen: 'test signup lands', done: false, doneAt: null, evidence: null },
  ],
  ...overrides,
})

// ── buildMissionCreateBody ──────────────────────────────────────────────────

test('create: builds a camelCase body from snake_case tool args', () => {
  const r = buildMissionCreateBody({ title: ' Launch the newsletter ', mini_goals: goals(4) })
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.equal(r.body.title, 'Launch the newsletter')
  assert.equal(r.body.miniGoals.length, 4)
  assert.deepEqual(r.body.miniGoals[0], { name: 'Goal 1', doneWhen: 'check 1 passes' })
})

test('create: accepts doneWhen alias key on goals', () => {
  const r = buildMissionCreateBody({
    title: 'T',
    mini_goals: [
      { name: 'A', doneWhen: 'a done' },
      { name: 'B', done_when: 'b done' },
    ],
  })
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.deepEqual(
    r.body.miniGoals.map((g) => g.doneWhen),
    ['a done', 'b done'],
  )
})

test('create: rejects a missing or empty title', () => {
  for (const title of [undefined, '', '   ', 42]) {
    const r = buildMissionCreateBody({ title, mini_goals: goals(4) })
    assert.equal(r.ok, false)
    if (r.ok) continue
    assert.match(r.error, /title/i)
  }
})

test('create: rejects an over-long title with the cap in the message', () => {
  const r = buildMissionCreateBody({ title: 'x'.repeat(MISSION_TITLE_MAX + 1), mini_goals: goals(4) })
  assert.equal(r.ok, false)
  if (r.ok) return
  assert.match(r.error, new RegExp(String(MISSION_TITLE_MAX)))
})

test('create: rejects too few and too many goals, teaching the 4..10 target', () => {
  for (const n of [0, MISSION_MIN_GOALS - 1, MISSION_MAX_GOALS + 1]) {
    const r = buildMissionCreateBody({ title: 'T', mini_goals: goals(n) })
    assert.equal(r.ok, false, `expected reject for ${n} goals`)
    if (r.ok) continue
    assert.match(r.error, /4 to 10/)
  }
})

test('create: boundary counts pass (2 and 12)', () => {
  assert.equal(buildMissionCreateBody({ title: 'T', mini_goals: goals(MISSION_MIN_GOALS) }).ok, true)
  assert.equal(buildMissionCreateBody({ title: 'T', mini_goals: goals(MISSION_MAX_GOALS) }).ok, true)
})

test('create: rejects a goal without a done_when check', () => {
  const r = buildMissionCreateBody({
    title: 'T',
    mini_goals: [{ name: 'A', done_when: 'ok' }, { name: 'B' }],
  })
  assert.equal(r.ok, false)
  if (r.ok) return
  assert.match(r.error, /done_when/)
  assert.match(r.error, /2/) // names the offending goal position
})

test('create: rejects over-long goal fields with caps in the message', () => {
  const long = buildMissionCreateBody({
    title: 'T',
    mini_goals: [
      { name: 'x'.repeat(MISSION_GOAL_NAME_MAX + 1), done_when: 'ok' },
      { name: 'B', done_when: 'ok' },
    ],
  })
  assert.equal(long.ok, false)
  const longCheck = buildMissionCreateBody({
    title: 'T',
    mini_goals: [
      { name: 'A', done_when: 'x'.repeat(MISSION_DONE_WHEN_MAX + 1) },
      { name: 'B', done_when: 'ok' },
    ],
  })
  assert.equal(longCheck.ok, false)
})

test('create: rejects a non-array mini_goals', () => {
  const r = buildMissionCreateBody({ title: 'T', mini_goals: 'do things' })
  assert.equal(r.ok, false)
})

// ── buildMissionTickBody ────────────────────────────────────────────────────

test('tick: builds { goalId } and trims evidence', () => {
  const r = buildMissionTickBody({ goal_id: 3, evidence: '  URL returned 200  ' })
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.deepEqual(r.body, { goalId: 3, evidence: 'URL returned 200' })
})

test('tick: omits empty evidence', () => {
  const r = buildMissionTickBody({ goal_id: 1, evidence: '   ' })
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.deepEqual(r.body, { goalId: 1 })
})

test('tick: rejects a missing or non-positive-integer goal_id', () => {
  for (const goalId of [undefined, 0, -1, 1.5, 'three']) {
    const r = buildMissionTickBody({ goal_id: goalId })
    assert.equal(r.ok, false, `expected reject for ${JSON.stringify(goalId)}`)
  }
})

test('tick: rejects over-long evidence', () => {
  const r = buildMissionTickBody({ goal_id: 1, evidence: 'x'.repeat(MISSION_EVIDENCE_MAX + 1) })
  assert.equal(r.ok, false)
})

// ── path builders ───────────────────────────────────────────────────────────

test('paths: build the user-scoped mission routes', () => {
  assert.deepEqual(buildMissionCreatePath('873'), { ok: true, path: 'assistants/873/missions' })
  assert.deepEqual(buildMissionActivePath('873'), { ok: true, path: 'assistants/873/missions/active' })
  assert.deepEqual(buildMissionTickPath('873', 42), { ok: true, path: 'assistants/873/missions/42/tick' })
  assert.deepEqual(buildMissionCompletePath('873', 42), {
    ok: true,
    path: 'assistants/873/missions/42/complete',
  })
})

test('paths: reject a bad mission id', () => {
  for (const id of [0, -3, 1.2, 'abc', undefined]) {
    const r = buildMissionTickPath('873', id)
    assert.equal(r.ok, false, `expected reject for ${JSON.stringify(id)}`)
  }
})

// ── formatMissionSummary ────────────────────────────────────────────────────

test('summary: reports progress, the goal ledger with ids, and the next goal', () => {
  const s = formatMissionSummary(snapshot())
  assert.match(s, /Mission #42/)
  assert.match(s, /Launch the newsletter/)
  assert.match(s, /1 of 3/)
  assert.match(s, /\[x\] 1\. Segments/)
  assert.match(s, /\[ \] 2\. Landing page/)
  assert.match(s, /Next: 2\. Landing page/)
})

test('summary: completed mission says so and has no next goal', () => {
  const s = formatMissionSummary(
    snapshot({
      status: 'completed',
      miniGoals: snapshot().miniGoals.map((g) => ({ ...g, done: true, doneAt: 'x' })),
    }),
  )
  assert.match(s, /completed/i)
  assert.doesNotMatch(s, /Next:/)
})
