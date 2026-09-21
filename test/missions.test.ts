/**
 * Eval suite for the mission tool builders (create_mission / tick_mini_goal /
 * complete_mission, BGOS capability #20).
 *
 * Wire contract (user-scoped routes, X-API-Key; the plugin's assistants have
 * pairingId = null so the /integrations twins do not apply here):
 *
 *   POST  assistants/:assistantId/missions                      create
 *   GET   assistants/:assistantId/missions/active               { mission | null }
 *   PATCH assistants/:assistantId/missions/:missionId/tick      { goalId, evidence? }
 *   PATCH assistants/:assistantId/missions/:missionId/complete  { summary? }
 *
 * Create body: { title, miniGoals: [{ name, doneWhen }] }, 2..12 goals
 * (trained flow targets 4 to 10), title <= 200, name <= 120, doneWhen <= 200,
 * evidence <= 200, summary <= 500. Responses embed the full mission snapshot with
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
  MISSION_SUMMARY_MAX,
  buildMissionCreateBody,
  buildMissionTickBody,
  buildMissionCompleteBody,
  buildMissionCreatePath,
  buildMissionActivePath,
  buildMissionTickPath,
  buildMissionCompletePath,
  MISSION_VERDICT_REASON_MAX,
  MISSION_FEED_TEXT_MAX,
  buildMissionFailBody,
  buildMissionFailPath,
  buildMissionProgressBody,
  buildMissionProgressPath,
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

// ── buildMissionCompleteBody ────────────────────────────────────────────────

test('complete: includes a summary when given', () => {
  const result = buildMissionCompleteBody({ summary: '23 drafts waiting for your review' })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.body, {
    summary: '23 drafts waiting for your review',
  })
})

test('complete: trims the summary', () => {
  const result = buildMissionCompleteBody({ summary: '  The migration is ready.  ' })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.body, {
    summary: 'The migration is ready.',
  })
})

test('complete: truncates the summary at 500 chars', () => {
  const result = buildMissionCompleteBody({ summary: 'x'.repeat(MISSION_SUMMARY_MAX + 1) })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.body.summary, 'x'.repeat(MISSION_SUMMARY_MAX))
})

test('complete: drops a lone high surrogate at the 500 unit boundary', () => {
  const prefix = 'x'.repeat(MISSION_SUMMARY_MAX - 1)
  const result = buildMissionCompleteBody({ summary: `${prefix}😀` })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.body.summary, prefix)
})

test('complete: rejects a non-string summary', () => {
  for (const summary of [42, false, {}, []]) {
    assert.deepEqual(buildMissionCompleteBody({ summary }), {
      ok: false,
      error: 'summary must be a string',
    })
  }
})

test('complete: preserves an empty body when summary is absent, null, or whitespace', () => {
  assert.deepEqual(buildMissionCompleteBody(), { ok: true, body: {} })
  assert.deepEqual(buildMissionCompleteBody({ summary: undefined }), { ok: true, body: {} })
  assert.deepEqual(buildMissionCompleteBody({ summary: null }), { ok: true, body: {} })
  assert.deepEqual(buildMissionCompleteBody({ summary: '   ' }), { ok: true, body: {} })
})

// ── path builders ───────────────────────────────────────────────────────────

// ── The goal lane: progress, fail, and the two runtime blocks ──────────────

test('progress: carries the verdict and the run report only when they are supplied', () => {
  const plain = buildMissionProgressBody({
    feedEntry: { kind: 'checked', text: 'Not yet: the file is not there yet.' },
  })
  assert.equal(plain.ok, true)
  if (!plain.ok) return
  assert.deepEqual(plain.body, {
    feedEntry: { kind: 'checked', text: 'Not yet: the file is not there yet.' },
  })
  assert.ok(!('verdict' in plain.body), 'an absent block is an absent KEY, never an empty object')
  assert.ok(!('runReport' in plain.body))

  const full = buildMissionProgressBody({
    feedEntry: { kind: 'checked', text: 'Not yet: the file is not there yet.' },
    verdict: { verdict: 'not_yet', reason: 'The file gate.txt has not been created yet.', by: 'checker', check: 3 },
    runReport: { turnsUsed: 3, turnCap: 20 },
  })
  assert.equal(full.ok, true)
  if (!full.ok) return
  assert.deepEqual(full.body.verdict, {
    verdict: 'not_yet',
    reason: 'The file gate.txt has not been created yet.',
    by: 'checker',
    check: 3,
  })
  assert.deepEqual(full.body.runReport, { turnsUsed: 3, turnCap: 20 })
  assert.ok(!('workingMs' in full.body.runReport!), 'a live goal has no elapsed time, so it sends none')
  assert.ok(!('at' in full.body.verdict!), 'when the check happened is the server word, never the daemon one')
  assert.ok(!('source' in full.body.runReport!), 'and so is whose runtime counted it')
})

test('progress: refuses an unknown verdict word and drops one with no reason', () => {
  const bad = buildMissionProgressBody({
    verdict: { verdict: 'nearly' as unknown as 'met', reason: 'close enough' },
  })
  assert.equal(bad.ok, false, 'a word outside the three is a bug in the caller, not a quiet omission')

  const noReason = buildMissionProgressBody({
    feedEntry: { kind: 'done', text: 'The goal was cleared.' },
    verdict: { verdict: 'met', reason: '   ' },
  })
  assert.equal(noReason.ok, true)
  if (!noReason.ok) return
  assert.ok(!('verdict' in noReason.body), 'the backend requires a reason, so the block is omitted')
  assert.ok('feedEntry' in noReason.body, 'and the rest of the write still lands')
})

test('progress: a run report field the wire cannot carry is DROPPED, never clamped', () => {
  const r = buildMissionProgressBody({
    runReport: { turnsUsed: 4, turnCap: 900, workingMs: -1 },
  })
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.deepEqual(r.body.runReport, { turnsUsed: 4 }, 'a count nobody counted is worse than no count')

  const nothingUsable = buildMissionProgressBody({
    feedEntry: { kind: 'worked', text: 'still going' },
    runReport: { turnsUsed: null, turnCap: null, workingMs: null },
  })
  assert.equal(nothingUsable.ok, true)
  if (!nothingUsable.ok) return
  assert.ok(!('runReport' in nothingUsable.body), 'an empty run report is no run report')
})

test('progress: clips the feed line and the reason to their own wire limits', () => {
  const r = buildMissionProgressBody({
    feedEntry: { kind: 'checked', text: `Not yet: ${'x'.repeat(400)}` },
    verdict: { verdict: 'not_yet', reason: 'y'.repeat(400) },
  })
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.equal(r.body.feedEntry!.text.length, MISSION_FEED_TEXT_MAX)
  assert.equal(r.body.verdict!.reason.length, MISSION_VERDICT_REASON_MAX)
  assert.equal(MISSION_FEED_TEXT_MAX, 200)
  assert.equal(MISSION_VERDICT_REASON_MAX, 240)
})

test('progress: refuses a body that would change nothing', () => {
  const r = buildMissionProgressBody({})
  assert.equal(r.ok, false, 'the backend would answer 200 and do nothing, which reads as a write that worked')
})

test('fail: builds the body and the path this repository did not have', () => {
  assert.deepEqual(buildMissionFailPath('873', 42), {
    ok: true,
    path: 'assistants/873/missions/42/fail',
  })
  assert.equal(buildMissionFailPath('873', 0).ok, false)
  assert.equal(buildMissionFailPath('', 42).ok, false)

  const r = buildMissionFailBody({
    summary: '  The folder is read only, so the file can never be created.  ',
    verdict: { verdict: 'impossible', reason: 'The folder is read only.', by: 'checker' },
    runReport: { turnsUsed: 3, turnCap: 20, workingMs: 12000 },
  })
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.equal(r.body.summary, 'The folder is read only, so the file can never be created.')
  assert.equal(r.body.verdict!.verdict, 'impossible')
  assert.deepEqual(r.body.runReport, { turnsUsed: 3, turnCap: 20, workingMs: 12000 })

  const bare = buildMissionFailBody({})
  assert.equal(bare.ok, true)
  if (!bare.ok) return
  assert.deepEqual(bare.body, {}, 'a fail with nothing to add is still a fail')
})

test('complete: carries a met verdict and the run report the runtime counted', () => {
  const r = buildMissionCompleteBody({
    summary: 'The file gate.txt exists and contains ready.',
    verdict: { verdict: 'met', reason: 'The transcript shows the file was written.', by: 'checker', check: 2 },
    runReport: { turnsUsed: 2, turnCap: 20, workingMs: 9211 },
  })
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.equal(r.body.summary, 'The file gate.txt exists and contains ready.')
  assert.deepEqual(r.body.verdict, {
    verdict: 'met',
    reason: 'The transcript shows the file was written.',
    by: 'checker',
    check: 2,
  })
  assert.deepEqual(r.body.runReport, { turnsUsed: 2, turnCap: 20, workingMs: 9211 })

  const shipped = buildMissionCompleteBody({ summary: 'done' })
  assert.equal(shipped.ok, true)
  if (!shipped.ok) return
  assert.deepEqual(shipped.body, { summary: 'done' }, 'the shipped tool call is byte identical to before')
})

test('snapshot: keepWorking and the turn cap are read off the mission', () => {
  const armed = snapshot({ keepWorking: true, turnCap: 20 })
  assert.equal(armed.keepWorking, true)
  assert.equal(armed.turnCap, 20)

  const legacy = snapshot()
  assert.equal(legacy.keepWorking, undefined, 'a backend older than the column sends neither')
  assert.equal(legacy.turnCap, undefined)

  const off = snapshot({ keepWorking: false, turnCap: null })
  assert.equal(off.keepWorking, false)
  assert.equal(off.turnCap, null)
})

test('paths: build the user-scoped mission routes', () => {
  assert.deepEqual(buildMissionCreatePath('873'), { ok: true, path: 'assistants/873/missions' })
  assert.deepEqual(buildMissionActivePath('873'), { ok: true, path: 'assistants/873/missions/active' })
  assert.deepEqual(buildMissionTickPath('873', 42), { ok: true, path: 'assistants/873/missions/42/tick' })
  assert.deepEqual(buildMissionCompletePath('873', 42), {
    ok: true,
    path: 'assistants/873/missions/42/complete',
  })
  assert.deepEqual(buildMissionProgressPath('873', 42), {
    ok: true,
    path: 'assistants/873/missions/42/progress',
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
