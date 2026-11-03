import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { createMissionWorkingTracker } from '../lib/mission-working.ts'
import { parseHookEvent } from '../lib/hook-events.ts'

const source = readFileSync(new URL('../server.ts', import.meta.url), 'utf8')
const parsed = ts.createSourceFile('server.ts', source, ts.ScriptTarget.Latest, true)
const standDownPaths: string[] = []
let trackerArmedCheck = ''
function findLifecycle(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(parsed) === 'missionWorking' && node.initializer && ts.isCallExpression(node.initializer)) {
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
function stopIntake(tracker: ReturnType<typeof createMissionWorkingTracker>) {
  return runFunction('stopHookIntake', { args: [], hookIntake: { stop: () => {} },
    missionWorking: tracker, missionWorkingTimer: null, clearInterval: () => {},
    clearFloorAttachedMarker: () => {}, hookCardTimer: null, hookCardPending: { clear: () => {} }, hookTurnCardKey: null,
    hookCardIds: new Map(), stopHookStepsHeartbeat: () => {},
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
  for (const useFallback of [false, true]) {
    const steps: string[] = []
    let finishClear!: () => void
    let timeout!: () => void
    const clearing = new Promise<void>(resolve => { finishClear = resolve })
    const bindings = {
      shuttingDown: false, log: () => {}, describeShutdownCause: () => '', selfUpdater: null,
      stopHookIntake: () => clearing,
      agentStatePublisher: { shutdown: () => {} }, flushChatCursors: () => {},
      releasePairingLock: () => { steps.push('release') }, PAIRING_LOCK_PATH: '/unused',
      process: { pid: 1, exit: () => { steps.push('exit') } }, loginController: { dispose: () => {} }, browserHost: null,
      setTimeout: (cb: () => void, ms: number) => { assert.equal(ms, 2000); timeout = cb },
    }
    const shutdown = new Function(...Object.keys(bindings), `${js}; return shutdown;`)(...Object.values(bindings))
    shutdown('stdin_end', 0)
    assert.deepEqual(steps, [], 'authority must remain until clear completion or deadline')
    if (useFallback) timeout()
    else finishClear()
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(steps, ['release', 'exit'])
  }
})
