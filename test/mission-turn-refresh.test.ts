import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import ts from 'typescript'
import * as turn from '../lib/mission-turn.mjs'
import { buildMissionActivePath, buildMissionGoalChecksPath } from '../lib/missions.ts'

// Execute the daemon's real state and HTTP functions without booting a paired
// production daemon. Only the HTTP boundary, disk writer and chat admission
// are substituted; deferred replies control the actual await ordering.
const source = readFileSync('server.ts', 'utf8')
const start = source.indexOf('let missionTurnState:')
const end = source.indexOf('const GOAL_FLOOR_MS', start)
assert.ok(start > 0 && end > start)
const block = ts.transpileModule(source.slice(start, end), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText

const CHECK = { kind: 'pr_merged', repo: 'example/project', number: 42 }
const mission = (id = 101, extra: any = {}) => ({
  id, chatId: 12, title: `Demo ${id}`, status: 'active',
  miniGoals: [{ id: 1, name: `Merge ${id}`, doneWhen: 'merged', done: false, check: CHECK }],
  ...extra,
})
const report = (m: any) => ({ missionId: m.id, status: m.status, goals: m.miniGoals.map((g: any) => ({
  ...g, result: { outcome: 'pass', evidence: `merged for ${m.id}` },
})) })

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function daemon(read: (path: string) => Promise<any>, overrides: any = {}) {
  const deps = {
    ...turn, buildMissionActivePath, buildMissionGoalChecksPath,
    ASSISTANT_ID: '7', FLOOR_KEYS: [], FLOOR_STATE_ROOT: '', lockHeld: true,
    turnChat: { deliveredRecently: (chatId: string) => chatId === '12' },
    bgosGetCachedOn304: read, writeMissionTurnJson: () => {}, log: () => {},
    ...overrides,
  }
  return new Function(...Object.keys(deps), block + `
    return { snapshot: noteMissionTurnSnapshot, refresh: refreshMissionTurnChat,
      answer: missionTurnAnswerFor, answerAsks: answerMissionTurnAsks,
      state: () => missionTurnState };
  `)(...Object.values(deps))
}

test('closing one of two missions preserves the other in prompt context and Stop eligibility', () => {
  const d = daemon(async () => { throw new Error('snapshots never fetch') })
  d.snapshot(mission(101))
  d.snapshot(mission(102))
  const context = turn.missionTurnContext(d.state().chats['12'])!
  assert.match(context, /Mission #101/)
  assert.match(context, /Mission #102/)
  assert.match(context, /mission_id: 101/)
  assert.match(context, /mission_id: 102/)
  d.snapshot(mission(101, { status: 'completed' }))
  assert.match(turn.missionTurnContext(d.state().chats['12'])!, /Mission #102/)
  assert.equal(turn.missionTurnNeedsAsk(d.state(), '12'), true)
  d.snapshot(mission(103, { status: 'abandoned' }))
  assert.equal(turn.missionTurnNeedsAsk(d.state(), '12'), true, 'an unknown closed id cannot clear this chat')
})

test('a completion removes only its mission when another open mission was most recently seen', () => {
  const d = daemon(async () => { throw new Error('snapshots never fetch') })
  d.snapshot(mission(101))
  d.snapshot(mission(102))
  d.snapshot(mission(101, { status: 'completed' }))
  assert.match(turn.missionTurnContext(d.state().chats['12'])!, /Mission #102/)
  assert.equal(turn.missionTurnNeedsAsk(d.state(), '12'), true)
})

test('multiple cached missions are checked by explicit id and Stop names every passing mission', async () => {
  const reads: string[] = []
  const d = daemon(async (path) => {
    reads.push(path)
    if (path.endsWith('/101/goal-checks')) return report(mission(101))
    if (path.endsWith('/102/goal-checks')) return report(mission(102))
    throw new Error('409: ambiguous implicit mission lookup')
  })
  d.snapshot(mission(101))
  d.snapshot(mission(102))
  const answer = await d.answer({ chatId: '12' })
  assert.deepEqual(reads.sort(), [
    'integrations/assistants/7/missions/101/goal-checks',
    'integrations/assistants/7/missions/102/goal-checks',
  ])
  const decision = turn.missionTurnStopDecision({ answer })
  assert.equal(decision.block, true)
  assert.match(decision.reason!, /Mission #101/)
  assert.match(decision.reason!, /Mission #102/)
  assert.match(decision.reason!, /mission_id: 101/)
  assert.match(decision.reason!, /mission_id: 102/)
  reads.length = 0
  assert.equal(turn.missionTurnStopDecision({ answer: await d.answer({ chatId: '12' }) }).block, true)
  assert.deepEqual(reads, [], 'unchanged fresh reports are reused for all missions')
})

test('a failed check read for one mission does not prevent verification of another mission', async () => {
  const reads: string[] = []
  const d = daemon(async (path) => {
    reads.push(path)
    if (path.endsWith('/101/goal-checks')) throw new Error('404: mission no longer available')
    return report(mission(102))
  })
  d.snapshot(mission(101))
  d.snapshot(mission(102))
  const decision = turn.missionTurnStopDecision({ answer: await d.answer({ chatId: '12' }) })
  assert.equal(reads.length, 2)
  assert.equal(decision.block, true)
  assert.match(decision.reason!, /Mission #102/)
  assert.doesNotMatch(decision.reason!, /Mission #101/)
})

test('a cold implicit lookup can discover one mission, and ambiguity produces an empty answer', async () => {
  const reads: string[] = []
  const d = daemon(async (path) => {
    reads.push(path)
    return path.includes('/active?') ? { mission: mission() } : report(mission())
  })
  assert.equal(turn.missionTurnStopDecision({ answer: await d.answer({ chatId: '12' }) }).block, true)
  assert.deepEqual(reads, ['assistants/7/missions/active?chatId=12', 'integrations/assistants/7/missions/101/goal-checks'])
  const ambiguous = daemon(async () => { throw new Error('409: ambiguous; name a mission id') })
  assert.deepEqual((await ambiguous.answer({ chatId: '12' })).passing, [])
  assert.equal(ambiguous.state()?.chats?.['12'], undefined)
})

test('adding a checked goal after a fresh empty report performs a new verification before Stop', async () => {
  let current = mission(101, { miniGoals: [] })
  let checks = 0
  const d = daemon(async (path) => {
    if (path.includes('/active?')) return { mission: current }
    checks++
    return report(current)
  })
  await d.refresh('12')
  current = mission()
  d.snapshot(current)
  assert.equal(turn.missionTurnNeedsAsk(d.state(), '12'), true)
  const decision = turn.missionTurnStopDecision({ answer: await d.answer({ chatId: '12' }) })
  assert.equal(checks, 2)
  assert.equal(decision.block, true)
  assert.match(decision.reason!, /Merge 101/)
})

test('a closed explicit report removes only that mission and a wrong report id is ignored', async () => {
  const d = daemon(async (path) => path.endsWith('/101/goal-checks')
    ? report(mission(101, { status: 'completed' }))
    : report(mission(999)))
  d.snapshot(mission(101))
  d.snapshot(mission(102))
  const answer = await d.answer({ chatId: '12' })
  const context = turn.missionTurnContext(d.state().chats['12'])!
  assert.doesNotMatch(context, /Mission #101|Mission #999/)
  assert.match(context, /Mission #102/)
  assert.equal(turn.missionTurnStopDecision({ answer }).block, false)
})

for (const change of ['tick', 'complete', 'replace', 'change check'] as const) {
  test(`a late HTTP report cannot overwrite a newer ${change} snapshot or produce a stale Stop block`, async () => {
    const pending = deferred<any>()
    const entered = deferred<void>()
    const d = daemon(async (path) => {
      if (path.includes('/active?')) return { mission: mission() }
      entered.resolve()
      return pending.promise
    })
    d.snapshot(mission())
    const answering = d.answer({ chatId: '12' })
    await entered.promise
    if (change === 'tick') d.snapshot(mission(101, { miniGoals: [{ ...mission().miniGoals[0], done: true }] }))
    if (change === 'complete' || change === 'replace') d.snapshot(mission(101, { status: 'completed' }))
    if (change === 'replace') d.snapshot(mission(102))
    if (change === 'change check') d.snapshot(mission(101, { miniGoals: [{ ...mission().miniGoals[0], check: { ...CHECK, number: 43 } }] }))
    const latest = structuredClone(d.state())
    pending.resolve(report(mission()))
    const answer = await answering
    assert.deepEqual(d.state(), latest, 'the older HTTP work must not change the newer snapshot')
    assert.equal(turn.missionTurnStopDecision({ answer }).block, false)
  })
}

test('a cold discovery cannot resurrect a mission created and completed while the read was pending', async () => {
  const active = deferred<any>()
  let checks = 0
  const d = daemon(async (path) => {
    if (path.includes('/active?')) return active.promise
    checks++
    return report(mission())
  })
  const answering = d.answer({ chatId: '12' })
  d.snapshot(mission())
  d.snapshot(mission(101, { status: 'completed' }))
  const latest = structuredClone(d.state())
  active.resolve({ mission: mission() })
  const answer = await answering
  assert.deepEqual(d.state(), latest)
  assert.equal(checks, 0, 'superseded discovery does not start a goal check')
  assert.equal(turn.missionTurnStopDecision({ answer }).block, false)
})

test('HTTP work completing after the daemon answer budget cannot resurrect a completed mission', async () => {
  const pending = deferred<any>()
  const entered = deferred<void>()
  let diskAnswer: any
  const d = daemon(async (path) => {
    if (path.includes('/active?')) return { mission: mission() }
    entered.resolve()
    return pending.promise
  }, {
    FLOOR_KEYS: ['demo'], MISSION_TURN_ANSWER_BUDGET_MS: 20,
    existsSync: () => true,
    answerMissionTurnAsk: async ({ compute }: any) => {
      try { diskAnswer = await compute({ chatId: '12' }) }
      catch { diskAnswer = { passing: [] } }
      return 'demo-ask'
    },
  })
  d.snapshot(mission())
  const keepAlive = setTimeout(() => {}, 1000)
  try {
    const answering = d.answerAsks()
    await entered.promise
    await answering
    assert.deepEqual(diskAnswer.passing, [])
    d.snapshot(mission(101, { status: 'completed' }))
    const latest = structuredClone(d.state())
    pending.resolve(report(mission()))
    await new Promise((done) => setImmediate(done))
    assert.deepEqual(d.state(), latest)
  } finally {
    clearTimeout(keepAlive)
  }
})
