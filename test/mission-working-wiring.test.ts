import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { createMissionWorkingTracker } from '../lib/mission-working.ts'
import { parseHookEvent } from '../lib/hook-events.ts'

const source = readFileSync(new URL('../server.ts', import.meta.url), 'utf8')
function runFunction(name: string, bindings: Record<string, any>, args: any[] = []) {
  const start = source.indexOf(`function ${name}(`)
  assert.ok(start > 0)
  const next = source.indexOf('\n}\n', start) + 3
  const js = ts.transpileModule(source.slice(start, next), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
  return new Function(...Object.keys(bindings), `${js}\nreturn ${name}(...args);`)(...Object.values(bindings), ...[])
}
const scope = { sessionId: 'session-a', missionId: 77, goalId: 3, headers: {} }

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
