import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ts from 'typescript'
import { createMissionWorkingTracker } from '../lib/mission-working.ts'
import { createMissionWorkingGeneration, createMissionWorkingWriteLock, hasUnconfirmedWorkingWrite } from '../lib/mission-working-lock.ts'
import * as workingWrites from '../lib/mission-working-lock.ts'
import { buildMissionGoalWorkingPath } from '../lib/missions.ts'
import { parseHookEvent } from '../lib/hook-events.ts'

const source = readFileSync(new URL('../server.ts', import.meta.url), 'utf8')
const parsed = ts.createSourceFile('server.ts', source, ts.ScriptTarget.Latest, true)
const standDownPaths: string[] = []
let trackerArmedCheck = ''
let trackerInitializer = ''
function findLifecycle(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(parsed) === 'missionWorking' && node.initializer && ts.isCallExpression(node.initializer)) {
    trackerInitializer = node.initializer.getText(parsed)
    const options = node.initializer.arguments[0] as ts.ObjectLiteralExpression
    const armed = options.properties.find(p => p.name?.getText(parsed) === 'isArmed') as ts.PropertyAssignment
    trackerArmedCheck = armed.initializer.getText(parsed)
  }
  if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) && node.expression.expression.getText(parsed) === 'stopHookIntake' && ts.isBlock(node.parent)) {
    const siblings = node.parent.statements
    const index = siblings.indexOf(node)
    const disarm = siblings.slice(index - 2, index)
    if (disarm.length === 2 && disarm.every(statement => ts.isExpressionStatement(statement) && ts.isBinaryExpression(statement.expression) &&
      ['channelArmed', 'lockHeld'].includes(statement.expression.left.getText(parsed)))) {
      standDownPaths.push([...disarm, node].map(statement => statement.getText(parsed)).join('\n'))
    }
  }
  ts.forEachChild(node, findLifecycle)
}
findLifecycle(parsed)
function runFunction(name: string, bindings: Record<string, any>, args: any[] = []) {
  const start = source.indexOf(`function ${name}(`)
  assert.ok(start > 0)
  const next = source.indexOf('\n}\n', start) + 3
  const js = ts.transpileModule(source.slice(start, next), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
  return new Function(...Object.keys(bindings), `${js}\nreturn ${name}(...args);`)(...Object.values(bindings), ...[])
}
const scope = { sessionId: 'session-a', missionId: 77, goalId: 3, headers: {} }
for (const working of [true, false]) {
  test(`the real passive daemon accepts an unbound explicit working=${working} call`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'working-passive-'))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    const writes: boolean[] = []
    const headers = { 'X-Actor': 'passive-session' }
    const bindings = {
      createMissionWorkingTracker, createMissionWorkingGeneration, createMissionWorkingWriteLock, hasUnconfirmedWorkingWrite, buildMissionGoalWorkingPath,
      PAIRING_LOCK_PATH: join(root, 'pairing.lock'), ASSISTANT_ID: '900',
      // Another daemon owns the pairing. This one still serves MCP tools.
      pairingLockNamesThisDaemon: () => false,
      rememberMissionSelfWrite: () => {},
      bgosPatch: async (path: string, body: { working: boolean }, sentHeaders: Record<string, string>) => {
        assert.equal(path, 'integrations/assistants/900/missions/77/goals/3/working')
        assert.deepEqual(sentHeaders, headers)
        writes.push(body.working)
        return { mission: { id: 77 } }
      },
    }
    const js = ts.transpileModule(`
      const channelArmed = false, lockHeld = false;
      return ${trackerInitializer};
    `, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
    const tracker = new Function(...Object.keys(bindings), js)(...Object.values(bindings)) as ReturnType<typeof createMissionWorkingTracker>
    const context = tracker.capture('')
    await assert.doesNotReject(tracker.mark({ ...scope, sessionId: '', context, headers, working }))
    await tracker.sweep()
    await tracker.stop()
    assert.deepEqual(writes, [working], 'manual intent sends once and does not become automatic cleanup')
    await assert.rejects(tracker.mark({ ...scope, sessionId: '', context, headers, working }), /session ended/i)
    assert.deepEqual(writes, [working], 'shutdown still invalidates old explicit intent')
  })
}

for (const scenario of [
  { name: 'failed clear retry', working: true, writes: ['A:true', 'A:false:503', 'B:true'] },
  { name: 'normal Stop', working: true, writes: ['A:true', 'B:true'] },
  { name: 'automatic refresh', working: false, writes: ['A:true', 'B:false'] },
  { name: 'Stop queued behind manual write', working: true, writes: ['A:true', 'B:true'] },
  { name: 'failed reselection', working: true, writes: ['A:true', 'B:true', 'A:true:503'] },
]) {
  test(`a passive manual write survives the active daemon's ${scenario.name}`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'working-passive-peer-'))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    let now = 1_000_000, backend = false, failClear = false, failReselect = false
    let entered!: () => void, release!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const waiting = new Promise<void>(resolve => { release = resolve })
    const writes: string[] = []
    const make = (name: string) => {
      const bindings = {
        ...workingWrites, buildMissionGoalWorkingPath,
        createMissionWorkingTracker: (options: Parameters<typeof createMissionWorkingTracker>[0]) =>
          createMissionWorkingTracker({ ...options, now: () => now }),
        PAIRING_LOCK_PATH: join(root, 'pairing.lock'), ASSISTANT_ID: '900',
        pairingLockNamesThisDaemon: () => name === 'A',
        rememberMissionSelfWrite: () => {},
        bgosPatch: async (_path: string, body: { working: boolean }) => {
          if (name === 'B' && scenario.name === 'Stop queued behind manual write') { entered(); await waiting }
          if (name === 'A' && body.working && failReselect) {
            writes.push('A:true:503')
            throw Object.assign(new Error('unavailable'), { status: 503 })
          }
          if (name === 'A' && !body.working && failClear) {
            writes.push('A:false:503')
            throw Object.assign(new Error('unavailable'), { status: 503 })
          }
          writes.push(`${name}:${body.working}`)
          backend = body.working
          return { mission: { id: 77 } }
        },
      }
      const js = ts.transpileModule(`
        const channelArmed = ${name === 'A'}, lockHeld = ${name === 'A'};
        return ${trackerInitializer};
      `, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
      return new Function(...Object.keys(bindings), js)(...Object.values(bindings)) as ReturnType<typeof createMissionWorkingTracker>
    }
    const a = make('A'), b = make('B')
    await a.mark({ ...scope, working: true })
    if (scenario.name === 'failed clear retry') {
      failClear = true
      await a.onHook({ hook_event_name: 'Stop', session_id: scope.sessionId })
      failClear = false
    }
    const selecting = b.mark({ ...scope, sessionId: '', working: scenario.working })
    if (scenario.name === 'Stop queued behind manual write') {
      await started
      const clearing = a.onHook({ hook_event_name: 'Stop', session_id: scope.sessionId })
      await new Promise(resolve => setImmediate(resolve))
      release()
      await Promise.all([selecting, clearing])
    } else {
      await selecting
      if (scenario.name === 'failed reselection') {
        failReselect = true
        await assert.rejects(a.mark({ ...scope, working: true }), /unavailable/)
      }
      if (scenario.name === 'failed clear retry') {
        now += 30_000
        await a.sweep()
      } else {
        now += 600_000
        await a.onHook({ hook_event_name: scenario.name === 'automatic refresh' ? 'PreToolUse' : 'Stop', session_id: scope.sessionId })
      }
    }
    assert.equal(backend, scenario.working, 'the passive manual choice must survive while A still owns the pairing')
    await a.stop()
    await b.stop()
    assert.equal(backend, scenario.working, 'retired automatic ownership must stay retired on shutdown')
    assert.deepEqual(writes, scenario.writes)
  })
}

function stopIntake(tracker: ReturnType<typeof createMissionWorkingTracker>) {
  return runFunction('stopHookIntake', { args: [], hookIntake: { stop: () => {} },
    missionWorking: tracker, missionWorkingTimer: null, clearInterval: () => {},
    clearFloorAttachedMarker: () => {}, hookCardTimer: null, hookCardPending: { clear: () => {} }, hookTurnCardKey: null,
    hookCardIds: new Map(), stopHookStepsHeartbeat: () => {},
  })
}

for (const delayed of [false, true]) {
  test(`the real daemon transport protects a successor across handover, delayed clear=${delayed}`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'working-daemons-'))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    let owner = 'A', backend = false
    let release!: () => void, entered!: () => void
    const waiting = new Promise<void>(resolve => { release = resolve })
    const started = new Promise<void>(resolve => { entered = resolve })
    const writes: string[] = []
    const make = (name: string) => {
      const bindings = {
        createMissionWorkingTracker, createMissionWorkingGeneration, createMissionWorkingWriteLock, hasUnconfirmedWorkingWrite, buildMissionGoalWorkingPath,
        PAIRING_LOCK_PATH: join(root, 'pairing.lock'), ASSISTANT_ID: '900',
        pairingLockNamesThisDaemon: () => owner === name,
        rememberMissionSelfWrite: () => {},
        bgosPatch: async (_path: string, body: { working: boolean }) => {
          if (name === 'A' && !body.working && delayed) { entered(); await waiting }
          writes.push(`${name}:${body.working}`)
          backend = body.working
          return { mission: { id: 77 } }
        },
      }
      const js = ts.transpileModule(`
        let channelArmed = true, lockHeld = true;
        const tracker = ${trackerInitializer};
        return { tracker, disarm() { channelArmed = false; lockHeld = false; } };
      `, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
      return new Function(...Object.keys(bindings), js)(...Object.values(bindings))
    }
    const a = make('A'), b = make('B')
    await a.tracker.mark({ ...scope, working: true })
    let clearing: Promise<void> | undefined
    if (delayed) { clearing = stopIntake(a.tracker); await started }
    owner = 'B'
    a.disarm()
    const selecting = b.tracker.mark({ ...scope, sessionId: 'session-b', working: true })
    if (delayed) {
      await new Promise(resolve => setImmediate(resolve))
      release()
      await clearing
    }
    await selecting
    if (!delayed) await stopIntake(a.tracker)
    await b.tracker.onHook({ hook_event_name: 'PreToolUse', session_id: 'session-b' })
    assert.equal(backend, true)
    assert.deepEqual(writes, delayed ? ['A:true', 'A:false', 'B:true'] : ['A:true', 'B:true'])
  })
}

test('the actual admitted hook handler refreshes selected goals and clears them on Stop', async () => {
  let now = 1_000_000
  const writes: boolean[] = []
  const pending: Promise<void>[] = []
  const tracker = createMissionWorkingTracker({ now: () => now, isArmed: () => true,
    patch: async (_scope, value) => { writes.push(value); return { mission: { id: 77 } } },
  })
  await tracker.mark({ ...scope, working: true })
  now += 600_000
  const handle = (event: string) => {
    const args = [{ hook_event_name: event, session_id: 'session-a', tool_name: 'Bash', tool_use_id: 'call-1' }, { receivedAt: now, startedAt: now }]
    runFunction('onHookPayload', { args, parseHookEvent,
      missionWorking: { onHook: (...input: any[]) => { const p = (tracker.onHook as any)(...input); pending.push(p); return p } },
      sessionBinder: { noteHookSession: () => {} }, lastHookEventAtMs: null, hookEndedSessionId: null,
      liveSessionId: 'session-a', liveSessionSeenAtMs: 0, floorEntrySession: () => '', floorEntrySessionWritten: '', markFloorAttachedIfHolder: () => {},
      privateTurns: { end: () => {} }, hookTurn: {}, applyHookEventToTurn: () => ({ next: {}, effects: [] }),
      sessionWakePending: () => null, sessionWakeAtMs: null,
      hookLineAt: null, hookLineStartedAt: null, runHookEffects: () => {}, agentStatePublisher: { tick: () => {} }, publishBrowserPrivateTurn: () => {},
    })
  }
  handle('PreToolUse')
  await Promise.all(pending.splice(0))
  handle('Stop')
  await Promise.all(pending.splice(0))
  assert.deepEqual(writes, [true, true, false])
})

test('the actual PATCH transport preserves HTTP 409 for the hook tracker', async () => {
  const start = source.indexOf('async function bgosPatch(')
  const end = source.indexOf('\nasync function bgosDelete', start)
  const js = ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
  class HttpError extends Error { constructor(message: string, public status: number) { super(message) } }
  const patch = new Function('API_BASE', 'bgosCall', 'HTTP_TIMEOUT_MS', 'authHeaders', 'AUTH', 'errorBodyText', 'HttpError', `${js}; return bgosPatch;`)(
    'http://unused', async (_req: any, consume: any) => consume({ ok: false, status: 409, text: async () => 'ticked' }), 100, () => ({}), {}, (s: string) => s, HttpError,
  )
  await assert.rejects(patch('path', { working: true }), (error: any) => error.status === 409)
})

test('the daemon starts an unrefed idle sweep and stops it on stand-down', async () => {
  let now = 1_000_000
  const writes: boolean[] = []
  const tracker = createMissionWorkingTracker({ now: () => now, isArmed: () => true,
    patch: async (_scope, value) => { writes.push(value); return { mission: { id: 77 } } },
  })
  await tracker.mark({ ...scope, working: true })
  let callback: (() => void) | undefined
  let unrefed = false
  const timer = { unref: () => { unrefed = true } }
  runFunction('startHookIntakeIfHolder', { args: [], lockHeld: true, markFloorAttachedIfHolder: () => {}, hookIntake: null,
    hookStateRoot: () => '/unused', startHookIntake: () => ({}), sessionBinder: { projectDirectory: '/unused' }, LAUNCH_CWD: '/unused',
    channelArmed: true, log: () => {}, hooksRoot: () => '/unused/hooks', missionWorking: tracker, missionWorkingTimer: null,
    MISSION_WORKING_SWEEP_MS: 30_000, setInterval: (fn: () => void, ms: number) => { assert.equal(ms, 30_000); callback = fn; return timer },
  })
  assert.equal(unrefed, true)
  assert.ok(callback)
  now += 900_000
  callback()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(writes, [true, false])
  await tracker.mark({ ...scope, working: true })
  let cleared = false
  await runFunction('stopHookIntake', { args: [], hookIntake: { stop: () => {} },
    missionWorking: tracker, missionWorkingTimer: timer, clearInterval: (handle: unknown) => { assert.equal(handle, timer); cleared = true },
    clearFloorAttachedMarker: () => {}, hookCardTimer: null, hookCardPending: { clear: () => {} }, hookTurnCardKey: null,
    hookCardIds: new Map(), stopHookStepsHeartbeat: () => {},
  })
  assert.equal(cleared, true)
  assert.deepEqual(writes, [true, false, true, false])
})

test('each real stand-down path clears marks after changing the actual armed flags', async t => {
  assert.equal(standDownPaths.length, 4)
  assert.ok(trackerArmedCheck)
  for (const [index, standDown] of standDownPaths.entries()) {
    await t.test(`stand-down path ${index + 1}`, async () => {
      const writes: boolean[] = []
      let pending: Promise<void> | undefined
      const js = ts.transpileModule(`
        let channelArmed = true, lockHeld = true;
        const tracker = makeTracker(${trackerArmedCheck});
        const stopHookIntake = () => onStop(tracker);
        return { tracker, standDown() { ${standDown}; return [channelArmed, lockHeld]; } };
      `, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
      const harness = new Function('makeTracker', 'onStop', js)(
        (isArmed: () => boolean) => createMissionWorkingTracker({ isArmed,
          patch: async (_scope, value) => { writes.push(value); return { mission: { id: 77 } } },
        }),
        (tracker: ReturnType<typeof createMissionWorkingTracker>) => {
          pending = stopIntake(tracker)
          return pending
        },
      )
      await harness.tracker.mark({ ...scope, working: true })
      assert.deepEqual(harness.standDown(), [false, false])
      await pending
      assert.deepEqual(writes, [true, false], 'stand-down must clear despite both armed flags being false')
      await harness.tracker.onHook({ hook_event_name: 'PreToolUse', session_id: scope.sessionId })
      await harness.tracker.sweep()
      assert.deepEqual(writes, [true, false], 'passive activity must not refresh a retired selection')
    })
  }
})

test('stand-down makes a final clear attempt during an earlier failure backoff', async () => {
  let armed = true
  let failure = false
  const writes: boolean[] = []
  const tracker = createMissionWorkingTracker({ now: () => 1_000_000, isArmed: () => armed,
    patch: async (_scope, working) => {
      writes.push(working)
      if (failure) throw Object.assign(new Error('unavailable'), { status: 503 })
      return { mission: { id: 77 } }
    },
  })
  await tracker.mark({ ...scope, working: true })
  failure = true
  await tracker.onHook({ hook_event_name: 'Stop', session_id: scope.sessionId })
  await tracker.sweep()
  assert.deepEqual(writes, [true, false], 'ordinary sweeps must respect the backoff')
  failure = false
  armed = false
  await stopIntake(tracker)
  assert.deepEqual(writes, [true, false, false], 'stand-down gets a final chance before its sweep timer is removed')
  await stopIntake(tracker)
  assert.deepEqual(writes, [true, false, false], 'a successful final clear is not repeated')
})

test('graceful shutdown keeps authority until clears finish, with a bounded fallback', async () => {
  const start = source.indexOf('  const shutdown = (cause: ShutdownCause')
  const end = source.indexOf('  // Sync backstop', start)
  assert.ok(start > 0 && end > start)
  const js = ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
  for (const [useFallback, hasThreadChildren] of [[false, false], [false, true], [true, false], [true, true]]) {
    const steps: string[] = []
    let finishClear!: () => void
    let finishChildren!: () => void
    let timeout!: () => void
    const clearing = new Promise<void>(resolve => { finishClear = resolve })
    const childrenDown = new Promise<void>(resolve => { finishChildren = resolve })
    const bindings = {
      shuttingDown: false, log: () => {}, describeShutdownCause: () => '', selfUpdater: null,
      idleUpdate: { noteEnded: () => {} }, isCleanEnd: () => true,
      stopHookIntake: () => { steps.push('hooks'); return clearing },
      stopThreadChildren: () => { steps.push('threads'); return hasThreadChildren ? childrenDown : null },
      agentStatePublisher: { shutdown: () => {} }, flushChatCursors: () => {},
      releasePairingLock: () => { steps.push('release') }, PAIRING_LOCK_PATH: '/unused',
      process: { pid: 1, exit: () => { steps.push('exit') } }, loginController: { dispose: () => {} },
      browserHost: { stop: () => { steps.push('browser') } },
      setTimeout: (cb: () => void, ms: number) => { assert.equal(ms, 2000); timeout = cb },
    }
    const shutdown = new Function(...Object.keys(bindings), `${js}; return shutdown;`)(...Object.values(bindings))
    shutdown('stdin_end', 0)
    assert.deepEqual(steps, ['hooks'], 'intake stops immediately; authority remains until clear completion or deadline')
    if (useFallback) timeout()
    else finishClear()
    await new Promise(resolve => setImmediate(resolve))
    if (hasThreadChildren) {
      assert.deepEqual(steps, ['hooks', 'release', 'threads'], 'exit must also wait for thread children')
      finishChildren()
      await new Promise(resolve => setImmediate(resolve))
    }
    assert.deepEqual(steps, ['hooks', 'release', 'threads', 'browser', 'exit'])
  }
})
