import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import ts from 'typescript'
import { floorKey, markFloorAttached } from '../lib/floor-state.mjs'
import { createMissionSelfWriteLedger, parseMissionEvent } from '../lib/mission-events.ts'
import * as turn from '../lib/mission-turn.mjs'
import * as missions from '../lib/missions.ts'

// Execute the daemon's real state and HTTP functions without booting a paired
// production daemon. Only the HTTP boundary, disk writer and chat admission
// are substituted; deferred replies control the actual await ordering.
const source = readFileSync('server.ts', 'utf8')
const start = source.indexOf('const missionSelfWrites =')
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
    ...turn, ...missions, createMissionSelfWriteLedger, FORWARD_CACHE_MAX: 100,
    ASSISTANT_ID: '7', FLOOR_KEYS: [], FLOOR_STATE_ROOT: '', lockHeld: true,
    turnChat: { deliveredRecently: (chatId: string) => chatId === '12' },
    bgosGetCachedOn304: read, writeMissionTurnJson: () => {}, log: () => {},
    ...overrides,
  }
  return new Function(...Object.keys(deps), block + `
    return { snapshot: noteMissionTurnSnapshot, selfWrite: rememberMissionSelfWrite, refresh: refreshMissionTurnChat,
      answer: missionTurnAnswerFor, answerAsks: answerMissionTurnAsks,
      state: () => missionTurnState };
  `)(...Object.values(deps))
}

// Run the real waiting tool case, including its HTTP await and self-write
// callback. The controlled PATCH returns a captured server snapshot later.
const waitingStart = source.indexOf("    case 'set_goal_waiting': {")
const waitingEnd = source.indexOf("    case 'complete_mission': {", waitingStart)
assert.ok(waitingStart > 0 && waitingEnd > waitingStart)
const waitingCase = ts.transpileModule(`return async function(rawArgs) {
  switch ('set_goal_waiting') { ${source.slice(waitingStart, waitingEnd)} }
}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText

function waitingTool(d: any, patch: (path: string, body: any) => Promise<any>) {
  const deps = {
    ...missions, ASSISTANT_ID: '7', privateCall: { headers: {} },
    resolveMissionToolChat: () => ({ ok: true, chatId: '12' }),
    resolveMissionId: async () => 101, bgosPatch: patch,
    rememberMissionSelfWrite: d.selfWrite, log: () => {},
  }
  const call = new Function(...Object.keys(deps), waitingCase)(...Object.values(deps))
  return call({ mission_id: 101, goal_id: 1, on: 'owner', who: 'Demo Owner', why: 'choose a date' })
}

const OLD = '2026-11-06T10:00:00.000Z'
const NEW = '2026-11-06T10:00:01.000Z'
const unchecked = (extra: any = {}) => mission(101, {
  updatedAt: OLD,
  miniGoals: [
    { id: 1, name: 'Date', doneWhen: 'chosen', done: false },
    { id: 2, name: 'Draft', doneWhen: 'written', done: false },
  ],
  ...extra,
})
const withCheck = () => unchecked({ updatedAt: NEW, miniGoals: [
  ...unchecked().miniGoals, { id: 3, name: 'Merge release', doneWhen: 'merged', done: false, check: CHECK },
] })

function frame(d: any, snapshot: any) {
  const event = parseMissionEvent('mission_updated', { mission: snapshot, chat_id: 12 })!
  assert.ok(event, 'the server frame parses')
  d.snapshot(event.mission, event.chatId)
}

for (const order of ['HTTP first', 'frame first'] as const) {
  test(`self-write ordering: ${order} retains a newer checked goal and Stop asks and blocks`, { timeout: 15_000 }, async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'mission-self-write-'))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    const cwd = join(root, 'agent')
    mkdirSync(cwd)
    markFloorAttached({ root, folders: [cwd] })
    const key = floorKey(cwd)
    const d = daemon(async () => report(withCheck()), {
      FLOOR_KEYS: [key], FLOOR_STATE_ROOT: root, writeMissionTurnJson: turn.writeMissionTurnJson,
    })
    frame(d, unchecked({ updatedAt: '2026-11-06T09:59:59.000Z' }))
    const pending = deferred<any>()
    const entered = deferred<void>()
    const writing = waitingTool(d, async (path, body) => {
      assert.equal(path, 'integrations/assistants/7/missions/101/goals/1/waiting')
      assert.deepEqual(body, { waiting: { on: 'owner', who: 'Demo Owner', why: 'choose a date' } })
      entered.resolve()
      return pending.promise
    })
    await entered.promise
    const deliverHttp = async () => {
      pending.resolve({ mission: unchecked({ miniGoals: [
        { ...unchecked().miniGoals[0], waiting: { on: 'owner', who: 'Demo Owner', why: 'choose a date' } },
        unchecked().miniGoals[1],
      ] }) })
      assert.equal((await writing).isError, undefined, 'the waiting request succeeds')
    }
    if (order === 'HTTP first') await deliverHttp()
    frame(d, withCheck())
    const latest = structuredClone(d.state())
    if (order === 'frame first') await deliverHttp()
    assert.deepEqual(d.state(), latest, 'an older tool response cannot write the state')
    assert.match(turn.missionTurnContext(d.state().chats['12'])!, /3\. Merge release/)
    assert.equal(turn.missionTurnNeedsAsk(d.state(), '12'), true)

    turn.writeMissionTurnJson(turn.missionTurnTurnPath(root, key), turn.missionTurnRecord({ sessionId: 'demo', chatId: '12', now: Date.now() }))
    const child = spawn(process.execPath, ['bin/hoai-mission-turn-hook.mjs'], {
      env: { ...process.env, BGOS_PLUGIN_STATE_DIR: root, CLAUDE_PROJECT_DIR: cwd },
    })
    t.after(() => { if (child.exitCode === null) child.kill() })
    let stdout = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    const closed = new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject) })
    child.stdin.end(JSON.stringify({ hook_event_name: 'Stop', session_id: 'demo', cwd }))
    const deadline = Date.now() + 3000
    let ask: any
    while (Date.now() < deadline && !(ask = turn.readMissionTurnJson(turn.missionTurnAskPath(root, key)))) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.ok(ask?.askId, 'the real Stop hook writes an ask after the older response')
    assert.equal(ask.chatId, '12')
    const answer = await d.answer(ask)
    turn.writeMissionTurnJson(turn.missionTurnAnswerPath(root, key), { ...answer, askId: ask.askId, at: Date.now() })
    assert.equal(await closed, 0)
    const decision = JSON.parse(stdout)
    assert.equal(decision.decision, 'block')
    assert.match(decision.reason, /3\. Merge release/)
  })

  test(`self-write ordering: ${order} cannot resurrect a newer completed mission`, async () => {
    const d = daemon(async () => { throw new Error('snapshots never fetch') })
    frame(d, unchecked({ updatedAt: '2026-11-06T09:59:59.000Z' }))
    const pending = deferred<any>()
    const entered = deferred<void>()
    const writing = waitingTool(d, async () => { entered.resolve(); return pending.promise })
    await entered.promise
    const deliverHttp = async () => {
      pending.resolve({ mission: unchecked() })
      assert.equal((await writing).isError, undefined)
    }
    if (order === 'HTTP first') await deliverHttp()
    frame(d, unchecked({ status: 'completed', updatedAt: NEW }))
    const latest = structuredClone(d.state())
    if (order === 'frame first') await deliverHttp()
    assert.deepEqual(d.state(), latest, 'the closed mission keeps its version after removal')
    assert.equal(turn.missionTurnContext(d.state().chats['12']), null)
    assert.equal(turn.missionTurnNeedsAsk(d.state(), '12'), false)
  })
}

test('self-write ordering: an older frame cannot erase a newer self-write checked goal', () => {
  const d = daemon(async () => { throw new Error('snapshots never fetch') })
  d.selfWrite(withCheck())
  const latest = structuredClone(d.state())
  frame(d, unchecked())
  assert.deepEqual(d.state(), latest)
  assert.equal(turn.missionTurnNeedsAsk(d.state(), '12'), true)
})

test('self-write ordering: an older frame cannot resurrect a newer self-write completion', () => {
  const d = daemon(async () => { throw new Error('snapshots never fetch') })
  d.selfWrite(unchecked({ status: 'completed', updatedAt: NEW }))
  frame(d, unchecked())
  assert.equal(turn.missionTurnContext(d.state().chats['12']), null)
})

test('self-write ordering: timestamps compare instants across time zones', () => {
  const d = daemon(async () => { throw new Error('snapshots never fetch') })
  // The older offset timestamp sorts later as text than the newer UTC one.
  d.selfWrite(withCheck())
  frame(d, unchecked({ updatedAt: '2026-11-06T14:00:00.000+04:00' }))
  assert.equal(turn.missionTurnNeedsAsk(d.state(), '12'), true)
})

test('self-write ordering: unversioned legacy snapshots work until a server version is known', () => {
  const d = daemon(async () => { throw new Error('snapshots never fetch') })
  const legacy = unchecked({ updatedAt: undefined })
  d.selfWrite(legacy)
  assert.match(turn.missionTurnContext(d.state().chats['12'])!, /Date/)
  frame(d, withCheck())
  const latest = structuredClone(d.state())
  for (const updatedAt of [undefined, '', 'invalid', NEW]) {
    d.selfWrite(unchecked({ updatedAt }))
    assert.deepEqual(d.state(), latest, 'unknown or duplicate versions cannot overwrite a versioned snapshot')
  }
})

test('self-write ordering: versions are per mission and allow later server writes after closure', () => {
  const d = daemon(async () => { throw new Error('snapshots never fetch') })
  frame(d, unchecked({ status: 'completed', updatedAt: NEW }))
  d.selfWrite(mission(102, { updatedAt: OLD }))
  assert.match(turn.missionTurnContext(d.state().chats['12'])!, /Mission #102/)
  d.selfWrite(unchecked({ updatedAt: '2026-11-06T10:00:02.000Z' }))
  assert.match(turn.missionTurnContext(d.state().chats['12'])!, /Mission #101/)
  frame(d, unchecked({ status: 'completed', updatedAt: NEW }))
  assert.match(turn.missionTurnContext(d.state().chats['12'])!, /Mission #101/)
  assert.match(turn.missionTurnContext(d.state().chats['12'])!, /Mission #102/)
})

test('self-write ordering: newer cold discovery prevents an older waiting response from erasing checks', async () => {
  const d = daemon(async (path) => path.includes('/active?') ? { mission: withCheck() } : report(withCheck()))
  const pending = deferred<any>()
  const entered = deferred<void>()
  const writing = waitingTool(d, async () => { entered.resolve(); return pending.promise })
  await entered.promise
  await d.refresh('12')
  assert.equal(turn.missionTurnNeedsAsk(d.state(), '12'), true)
  const latest = structuredClone(d.state())
  pending.resolve({ mission: unchecked() })
  assert.equal((await writing).isError, undefined)
  assert.deepEqual(d.state(), latest)
  assert.match(turn.missionTurnContext(d.state().chats['12'])!, /3\. Merge release/)
  assert.equal(turn.missionTurnStopDecision({ answer: await d.answer({ chatId: '12' }) }).block, true)
})

test('self-write ordering: a remembered completion rejects an older cold discovery without checking it', async () => {
  let checks = 0
  const d = daemon(async (path) => {
    if (path.includes('/active?')) return { mission: withCheck() }
    checks++
    return report(withCheck())
  })
  d.selfWrite(unchecked({ status: 'completed', updatedAt: '2026-11-06T10:00:02.000Z' }))
  const latest = structuredClone(d.state())
  const answer = await d.answer({ chatId: '12' })
  assert.deepEqual(d.state(), latest)
  assert.equal(checks, 0, 'rejected discovery cannot start an explicit check that restores it')
  assert.equal(turn.missionTurnStopDecision({ answer }).block, false)
})

test('self-write ordering: an unchanged open discovery can restore a mission after chat cache eviction', async () => {
  let now = Date.now()
  const d = daemon(async (path) => path.includes('/active?') ? { mission: withCheck() } : report(withCheck()), {
    Date: { now: () => now, parse: Date.parse },
  })
  frame(d, withCheck())
  // Advance the clock so eviction does not depend on millisecond resolution.
  for (let i = 0; i < turn.MISSION_TURN_MAX_CHATS; i++) {
    now++
    d.snapshot(mission(200 + i, { chatId: 200 + i, updatedAt: NEW }))
  }
  assert.equal(d.state().chats['12'], undefined, 'the bounded cache evicted this chat')
  now++
  await d.refresh('12')
  assert.match(turn.missionTurnContext(d.state().chats['12'])!, /3\. Merge release/)
  assert.equal(turn.missionTurnStopDecision({ answer: await d.answer({ chatId: '12' }) }).block, true)
})

test('self-write ordering: a goal-check completion cannot be mistaken for chat cache eviction', async () => {
  const d = daemon(async () => report({ ...withCheck(), status: 'completed' }))
  frame(d, withCheck())
  await d.refresh('12')
  assert.equal(turn.missionTurnContext(d.state().chats['12']), null)
  const latest = structuredClone(d.state())
  d.selfWrite(withCheck())
  assert.deepEqual(d.state(), latest, 'a duplicate active response cannot undo a goal-check completion')
})

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
