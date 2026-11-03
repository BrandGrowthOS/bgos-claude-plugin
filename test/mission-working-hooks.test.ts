import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { startHookIntake } from '../lib/hook-intake.ts'

const moduleUrl = new URL('../lib/mission-working.ts', import.meta.url)
const working: any = existsSync(moduleUrl) ? await import(moduleUrl.href) : {}
const minute = 60_000
const scope = { sessionId: 'session-a', missionId: 77, goalId: 3, headers: { 'X-BGOS-Acting-User': 'user_recipient' } }

async function rig(t: any) {
  assert.equal(typeof working.createMissionWorkingTracker, 'function', 'working hooks must expose the production tracker')
  let now = 1_000_000
  let armed = true
  let failure = 0
  let loseResponse = false
  let responseBody: any = { mission: { id: 77, status: 'active', miniGoals: [] } }
  let hold: (() => void) | null = null
  let entered: (() => void) | null = null
  const calls: Array<{ path: string; body: any; actor: string | undefined }> = []
  const server = createServer(async (req, res) => {
    const status = failure
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk)
    calls.push({ path: req.url!, body: JSON.parse(Buffer.concat(chunks).toString()), actor: req.headers['x-bgos-acting-user'] as string })
    if (loseResponse) { loseResponse = false; req.socket.destroy(); return }
    entered?.()
    entered = null
    if (hold) await new Promise<void>((resolve) => { hold = resolve })
    res.writeHead(status || 200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(status ? { error: 'refused' } : responseBody))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())))
  const address: any = server.address()
  const tracker = working.createMissionWorkingTracker({
    now: () => now, isArmed: () => armed,
    patch: async (s: any, value: boolean) => {
      const response = await fetch(`http://127.0.0.1:${address.port}/integrations/assistants/900/missions/${s.missionId}/goals/${s.goalId}/working`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json', ...s.headers }, body: JSON.stringify({ working: value }),
      })
      if (!response.ok) throw Object.assign(new Error('private response must never be logged'), { status: response.status })
      return response.json()
    },
  })
  const event = (name = 'PreToolUse', sessionId = scope.sessionId, at = now) => tracker.onHook({ hook_event_name: name, session_id: sessionId, tool_name: 'Bash' }, at)
  return { tracker, calls, event, setNow: (value: number) => { now = value }, advance: (ms: number) => { now += ms },
    loseResponse: () => { loseResponse = true }, setFailure: (status: number) => { failure = status }, setResponse: (body: any) => { responseBody = body }, setArmed: (value: boolean) => { armed = value },
    block: () => { hold = () => {}; return new Promise<void>(resolve => { entered = resolve }) },
    release: () => { const release = hold; hold = null; release?.() },
  }
}

test('busy session refreshes every selected goal with the original actor and exact working route', async t => {
  const r = await rig(t)
  await r.tracker.mark({ ...scope, working: true })
  await r.tracker.mark({ ...scope, goalId: 4, working: true })
  r.advance(10 * minute)
  await r.event()
  assert.deepEqual(r.calls.map(c => [c.path, c.body, c.actor]), [
    ['/integrations/assistants/900/missions/77/goals/3/working', { working: true }, 'user_recipient'],
    ['/integrations/assistants/900/missions/77/goals/4/working', { working: true }, 'user_recipient'],
    ['/integrations/assistants/900/missions/77/goals/3/working', { working: true }, 'user_recipient'],
    ['/integrations/assistants/900/missions/77/goals/4/working', { working: true }, 'user_recipient'],
  ])
})

test('idle sweep clears without another hook and activity resumes only the selected goals', async t => {
  const r = await rig(t)
  await r.tracker.mark({ ...scope, working: true })
  r.advance(15 * minute - 1)
  await r.tracker.sweep()
  assert.equal(r.calls.at(-1)?.body.working, true)
  r.advance(1)
  await r.tracker.sweep()
  assert.equal(r.calls.at(-1)?.body.working, false)
  await r.event()
  assert.equal(r.calls.at(-1)?.body.working, true)
  await r.tracker.mark({ ...scope, working: false })
  r.advance(10 * minute)
  await r.event()
  assert.equal(r.calls.at(-1)?.body.working, false, 'explicit deselection must not be resurrected')
})

for (const boundary of ['Stop', 'SessionEnd', 'UserPromptSubmit']) {
  test(`${boundary} clears and forgets this session without clearing another session`, async t => {
    const r = await rig(t)
    await r.tracker.mark({ ...scope, working: true })
    await r.event(boundary, 'unrelated')
    assert.equal(r.calls.length, 1)
    await r.event(boundary)
    assert.deepEqual(r.calls.map(c => c.body.working), [true, false])
    r.advance(10 * minute)
    await r.event()
    assert.equal(r.calls.length, 2)
  })
}

test('409 drops a ticked goal so later activity and stop do not retry it', async t => {
  const r = await rig(t)
  await r.tracker.mark({ ...scope, working: true })
  r.setFailure(409)
  r.advance(10 * minute)
  await r.event()
  r.setFailure(0)
  r.advance(10 * minute)
  await r.event()
  await r.event('Stop')
  assert.equal(r.calls.length, 2)
})

test('refresh failures resolve normally, preserve other goals, and reserve the rate limit', async t => {
  const r = await rig(t)
  await r.tracker.mark({ ...scope, working: true })
  await r.tracker.mark({ ...scope, goalId: 4, working: true })
  r.setFailure(500)
  r.advance(10 * minute)
  await assert.doesNotReject(r.event())
  assert.equal(r.calls.length, 4, 'a failure for one goal must not prevent the other attempt')
  r.setFailure(0)
  r.advance(10 * minute - 1)
  await r.event()
  assert.equal(r.calls.length, 4, 'failed refresh still consumes the window')
  r.advance(1)
  await r.event()
  assert.equal(r.calls.length, 6)
})

test('parallel hook bursts cannot refresh any goal more than once in ten minutes', async t => {
  const r = await rig(t)
  await r.tracker.mark({ ...scope, working: true })
  r.advance(10 * minute - 1)
  await Promise.all(Array.from({ length: 20 }, () => r.event()))
  assert.equal(r.calls.length, 1)
  r.advance(1)
  await Promise.all(Array.from({ length: 20 }, () => r.event()))
  assert.equal(r.calls.length, 2)
})

test('stop queued behind an in-flight refresh wins and a failed clear is retried', async t => {
  const r = await rig(t)
  await r.tracker.mark({ ...scope, working: true })
  r.advance(10 * minute)
  const started = r.block()
  const refresh = r.event()
  await started
  const stop = r.event('Stop')
  r.release()
  await Promise.all([refresh, stop])
  assert.deepEqual(r.calls.map(c => c.body.working), [true, true, false])
  await r.tracker.mark({ ...scope, working: true })
  r.setFailure(503)
  await r.event('SessionEnd')
  r.setFailure(0)
  await r.tracker.sweep()
  assert.deepEqual(r.calls.slice(-3).map(c => c.body.working), [true, false, false])
})

test('a stop while the initial selection is in flight clears the landed mark', async t => {
  const r = await rig(t)
  const started = r.block()
  const marked = r.tracker.mark({ ...scope, working: true })
  await started
  const stopped = r.event('Stop')
  r.release()
  await Promise.all([marked, stopped])
  assert.deepEqual(r.calls.map(c => c.body.working), [true, false])
  r.advance(10 * minute)
  await r.event()
  assert.equal(r.calls.length, 2)
})

test('unarmed daemon and stale spool activity cannot refresh a working mark', async t => {
  const r = await rig(t)
  await r.tracker.mark({ ...scope, working: true })
  r.advance(16 * minute)
  await r.event('PreToolUse', scope.sessionId, 1_000_000)
  assert.equal(r.calls.at(-1)?.body.working, false)
  r.setArmed(false)
  r.advance(10 * minute)
  await r.event()
  await r.tracker.sweep()
  assert.equal(r.calls.length, 2)
})

test('real forwarder and admitted spool drive refresh and stop; hook failure never blocks a tool', async t => {
  const r = await rig(t)
  const root = mkdtempSync(join(tmpdir(), 'working-hooks-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const transcript = join(root, 'session-a.jsonl')
  const pending: Promise<void>[] = []
  const intake = startHookIntake({ stateRoot: root, projectDir: root, isArmed: () => true,
    provenTranscript: () => transcript, onEvent: payload => { pending.push(r.tracker.onHook(payload, 1_600_000)) },
    watch: () => null, setIntervalFn: () => ({}), clearIntervalFn: () => {},
  })
  t.after(() => intake.stop())
  await r.tracker.mark({ ...scope, working: true })
  r.advance(10 * minute)
  for (const name of ['PreToolUse', 'Stop']) {
    const result = spawnSync(process.execPath, ['bin/hoai-hook.mjs'], { encoding: 'utf8', env: { ...process.env, BGOS_PLUGIN_STATE_DIR: root },
      input: JSON.stringify({ hook_event_name: name, session_id: scope.sessionId, transcript_path: transcript, tool_name: 'Bash' }),
    })
    assert.deepEqual([result.status, result.stdout, result.stderr], [0, '', ''])
    intake.pump()
    await Promise.all(pending.splice(0))
  }
  assert.deepEqual(r.calls.map(c => c.body.working), [true, true, false])
  const blocked = join(root, 'not-a-directory')
  writeFileSync(blocked, 'blocked spool')
  const failed = spawnSync(process.execPath, ['bin/hoai-hook.mjs'], { encoding: 'utf8', env: { ...process.env, BGOS_PLUGIN_STATE_DIR: blocked }, input: '{"hook_event_name":"PreToolUse","session_id":"s"}' })
  assert.deepEqual([failed.status, failed.stdout, failed.stderr], [0, '', ''])
})

test('a late boundary from an older turn cannot clear a newer explicit selection', async t => {
  const r = await rig(t)
  r.advance(100)
  await r.tracker.mark({ ...scope, working: true })
  await r.event('UserPromptSubmit', scope.sessionId, 1_000_000)
  await r.event('Stop', scope.sessionId, 1_000_050)
  assert.deepEqual(r.calls.map(c => c.body.working), [true])
  r.advance(10 * minute)
  await r.event()
  assert.deepEqual(r.calls.map(c => c.body.working), [true, true])
})

test('a failed explicit selection does not become a hook-owned goal', async t => {
  const r = await rig(t)
  r.setFailure(503)
  await assert.rejects(r.tracker.mark({ ...scope, working: true }))
  r.setFailure(0)
  r.advance(10 * minute)
  await r.event()
  assert.equal(r.calls.filter(c => c.body.working).length, 1)
  assert.equal(r.calls.at(-1)?.body.working, false, 'an uncertain write is cleared without adopting it')
})


test('a response with no mission is never adopted as a successful goal selection', async t => {
  const r = await rig(t)
  r.setResponse({})
  await r.tracker.mark({ ...scope, working: true })
  r.advance(10 * minute)
  await r.event()
  assert.equal(r.calls.filter(c => c.body.working).length, 1)
})

test('sweep cannot forget a new selection queued while its previous clear finishes', async t => {
  const r = await rig(t)
  await r.tracker.mark({ ...scope, working: true })
  await r.event('Stop')
  const sweep = r.tracker.sweep()
  const queuedSweeps = Array.from({ length: 4 }, () => r.tracker.sweep())
  const started = r.block()
  const fresh = r.tracker.mark({ ...scope, working: true })
  await started
  await Promise.all([sweep, ...queuedSweeps])
  r.release()
  await fresh
  r.advance(10 * minute)
  await r.event()
  assert.deepEqual(r.calls.map(c => c.body.working), [true, false, true, true])
})

test('one captured tool call cannot select its later goals after a Stop or session rebind', async t => {
  const r = await rig(t)
  assert.equal(typeof r.tracker.capture, 'function')
  const context = r.tracker.capture(scope.sessionId)
  await r.tracker.mark({ ...scope, context, working: true })
  await r.event('Stop')
  await assert.rejects(r.tracker.mark({ ...scope, goalId: 4, context, working: true }), /session ended/i)
  assert.deepEqual(r.calls.map(c => c.body.working), [true, false])
  const duringLookup = r.tracker.capture(scope.sessionId)
  await r.event('SessionEnd')
  await assert.rejects(r.tracker.mark({ ...scope, context: duringLookup, working: true }), /session ended/i)
})

test('a newer session owns the shared goal even if the old session clear failed', async t => {
  const r = await rig(t)
  await r.tracker.mark({ ...scope, working: true })
  r.setFailure(503)
  await r.event('SessionEnd')
  r.setFailure(0)
  await r.tracker.mark({ ...scope, sessionId: 'session-b', working: true })
  await r.tracker.sweep()
  assert.deepEqual(r.calls.map(c => c.body.working), [true, false, true])
  await r.event('Stop')
  assert.equal(r.calls.length, 3, 'a late old-session Stop cannot clear the new owner')
  await r.event('Stop', 'session-b')
  assert.equal(r.calls.at(-1)?.body.working, false)
})

test('a true write with a lost response remains eligible for Stop cleanup', async t => {
  const r = await rig(t)
  r.loseResponse()
  await assert.rejects(r.tracker.mark({ ...scope, working: true }))
  await r.event('Stop')
  assert.deepEqual(r.calls.map(c => c.body.working), [true, false])
})

test('hook refresh errors produce no stdout or stderr and exit normally', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import { createMissionWorkingTracker } from ${JSON.stringify(moduleUrl.href)};
    let now = 0, fail = false;
    const tracker = createMissionWorkingTracker({ now: () => now, isArmed: () => true,
      patch: async () => { if (fail) throw new Error('private upstream response'); return { mission: { id: 77 } }; } });
    await tracker.mark({ sessionId: 's', missionId: 77, goalId: 3, headers: {}, working: true });
    now = 600000; fail = true;
    await tracker.onHook({ hook_event_name: 'PreToolUse', session_id: 's' });
  `], { encoding: 'utf8' })
  assert.deepEqual([result.status, result.stdout, result.stderr], [0, '', ''])
})


test('failed reselection preserves the previously confirmed selection', async t => {
  const r = await rig(t)
  await r.tracker.mark({ ...scope, working: true })
  r.setFailure(503)
  await assert.rejects(r.tracker.mark({ ...scope, working: true }))
  r.setFailure(0)
  r.advance(10 * minute)
  await r.event()
  assert.deepEqual(r.calls.map(c => c.body.working), [true, true, true])
})

test('an older 409 cannot invalidate a newer successful queued selection', async t => {
  const r = await rig(t)
  await r.tracker.mark({ ...scope, working: true })
  r.advance(10 * minute)
  r.setFailure(409)
  const started = r.block()
  const refreshing = r.event()
  await started
  r.setFailure(0)
  const reselecting = r.tracker.mark({ ...scope, working: true })
  r.release()
  await Promise.all([refreshing, reselecting])
  r.advance(10 * minute)
  await r.event()
  assert.deepEqual(r.calls.map(c => c.body.working), [true, true, true, true])
})

test('failed handover preserves the confirmed owner and original actor', async t => {
  const r = await rig(t)
  await r.tracker.mark({ ...scope, working: true })
  r.setFailure(503)
  await assert.rejects(r.tracker.mark({ ...scope, sessionId: 'session-b', headers: {}, working: true }))
  r.setFailure(0)
  r.advance(10 * minute)
  await r.event()
  assert.equal(r.calls.at(-1)?.body.working, true)
  assert.equal(r.calls.at(-1)?.actor, 'user_recipient')
})
