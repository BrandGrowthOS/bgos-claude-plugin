/** Checkup integration with a fake OS, clock and backend. No real agent operations. */

// First: any real process listing, signal or launch from the loop fails this file instead of
// acting on the computer it runs on (board row afa70b0c, test/watcher-real-os.guard.test.ts).
import './helpers/real-os-sentinel.ts'

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { runWatcher } from '../lib/watcher-core.mjs'
import { STOPPED_CONFIRM_GAP_MS, checkupTarget, isOwnerChannelText, parseTranscriptTail } from '../lib/watcher-checkup.mjs'
import { buildLaunchRecipe } from '../lib/agent-inventory.mjs'
import { bundleFingerprint } from '../lib/watcher-bundle.mjs'
import { supervisorFileBody } from '../bin/hoai-core.mjs'
import { memoryFs, type MemoryFs } from './helpers/memory-fs.ts'

const HOME = '/home/kc'
const USER = 'kc'
const TOKEN = 'bgp_' + 'S3cretPairingTokenValue0123456789'
const CONFIG = '/home/kc/.claude'
const ROOT = `${CONFIG}/plugins/cache/hoai/hoai/0.38.4`
const T0 = Date.parse('2026-08-25T12:00:00.000Z')
const MIN = 60_000
const MACHINE_ID = '0f3b3c1e-7d3a-4d0c-9a4c-1f2e3d4c5b6a'
const SID = '8c1f0000-0000-4000-8000-000000000001'
const AVA = `${HOME}/hoai-agents/ava`
const TRANSCRIPT = `${CONFIG}/projects/${AVA.replace(/[^a-zA-Z0-9]/g, '-')}/${SID}.jsonl`
const STATE_DIR = `${HOME}/.bgos-agent/912`
const PLUGIN_STATE = `${HOME}/.bgos-plugin-state/912`
const KEEPALIVE_STATE = `${HOME}/.bgos-agent/watcher/keepalive-state.json`

// The backend's DTO bounds (BGOS backend src/dto/integrations/machine-rpc.dto.ts, packet P1).
const TOKEN_RE = /^[a-z][a-z0-9_]{0,39}$/
const AGENT_ID_RE = /^\d{1,16}$/
const OUTCOMES = new Set(['fixed', 'not_fixed', 'skipped'])
const STATUSES = new Set(['OK', 'WARN', 'FAIL'])
const STEP_STATES = new Set(['pending', 'running', 'ok', 'failed', 'skipped'])

// -- the rig ---------------------------------------------------------------------------

function fakeClock(start = T0) {
  let nowMs = start
  const sleeps: number[] = []
  const hooks: Array<(ms: number, nowMs: number) => void> = []
  return {
    now: () => nowMs,
    sleep: async (ms: number) => {
      sleeps.push(ms)
      nowMs += ms
      for (const hook of hooks) hook(ms, nowMs)
    },
    sleeps,
    onSleep: (hook: (ms: number, nowMs: number) => void) => hooks.push(hook),
    advance: (ms: number) => {
      nowMs += ms
    },
  }
}

type Call = { method: string; path: string; body: any }

/** An in-process fake backend: serves the given frames once, the job bodies, records every call. */
function fakeBackend(opts: { frames?: any[]; jobs?: Record<string, any> } = {}) {
  const calls: Call[] = []
  let served = false
  const respond = (status: number, json: any) => ({ ok: status < 400, status, text: async () => JSON.stringify(json) })
  const fetch = async (url: string, init: any) => {
    const u = new URL(url)
    const path = u.pathname + u.search
    calls.push({ method: init?.method ?? 'GET', path, body: init?.body ? JSON.parse(init.body) : undefined })
    if (path.includes('/machine-rpc/pending')) {
      if (served) return respond(200, { frames: [] })
      served = true
      return respond(200, { frames: opts.frames ?? [] })
    }
    const m = /\/machine-rpc\/([^/]+)$/.exec(u.pathname)
    if (m && init?.method === 'GET') return respond(200, opts.jobs?.[decodeURIComponent(m[1]!)] ?? {})
    if (u.pathname.endsWith('/progress')) {
      try {
        assertDtoShape([calls.at(-1)!.body])
      } catch {
        return respond(400, { message: 'invalid_progress' })
      }
    }
    return respond(200, {})
  }
  const progress = (rpcId: string) => calls.filter((c) => c.path.endsWith(`/machine-rpc/${rpcId}/progress`)).map((c) => c.body)
  return { calls, fetch, progress }
}

/** One `ps -o pid=,ppid=,uid=,lstart=,args=` line. */
const psLine = (pid: number, ppid: number, cmd: string, start = 'Tue Aug 25 08:00:00 2026') => ` ${pid} ${ppid} 501 ${start} ${cmd}`

/** Agent 912 in ~/hoai-agents/ava: paired, a launch recipe, a live hoai launcher (pid 4242), its pinned session. */
function agentFs(extra: Record<string, string> = {}): MemoryFs {
  const recipe = JSON.stringify(buildLaunchRecipe({ assistantId: '912', cwd: AVA, argv: ['--x'], installMethod: 'marketplace', pluginRoot: ROOT, node: '/usr/bin/node', startedAt: 'x', pid: 4242 }))
  const fs = memoryFs(
    {
      [`${HOME}/.bgos-agent/watcher/credentials.json`]: JSON.stringify({ pairingId: 77, token: TOKEN, backendUrl: 'https://api.example.test', machineId: MACHINE_ID }),
      [`${HOME}/.bgos-agent/credentials-912.json`]: JSON.stringify({ pairingToken: 'agent-secret-912', backendUrl: 'x' }),
      [`${STATE_DIR}/launch.json`]: recipe,
      [`${STATE_DIR}/supervisor.json`]: supervisorFileBody(4242, 'x'),
      [`${STATE_DIR}/session-id`]: `${SID}\n`,
      [`${AVA}/.bgos-agent-id`]: '912\n',
      ...extra,
    },
    [AVA],
  )
  fs.writeFile(`${HOME}/.bgos-agent/watcher/manifest.json`, JSON.stringify({ version: '0.38.4', fingerprint: bundleFingerprint(ROOT, fs), installedAt: 'x', pluginRoot: ROOT, files: [] }))
  return fs
}

/** The daemon's published agent-state.json, fresh at T0 (turnSignal hooks). */
function agentState(over: Record<string, unknown> = {}) {
  return JSON.stringify({
    schemaVersion: 1,
    assistantId: '912',
    pid: 4912,
    claudePid: 5912,
    runningVersion: '0.38.4',
    pendingRestartVersion: null,
    turnInFlight: false,
    pendingMessages: 0,
    pendingPermissions: 0,
    activeOperations: 0,
    lastActivityAt: new Date(T0 - 20 * MIN).toISOString(),
    sessionId: SID,
    updatedAt: new Date(T0 - 5_000).toISOString(),
    turnSignal: 'hooks',
    ...over,
  })
}

// Transcript records in the CLI's own envelopes (lib/claude-login.ts, lib/resting.ts, lib/session-library.ts).
const ownerMessage = (atMs: number) =>
  JSON.stringify({ type: 'user', isMeta: true, timestamp: new Date(atMs).toISOString(), message: { role: 'user', content: `<channel source="bgos" chat_id="c1" message_id="9" sender_type="user">\nare you there?\n</channel>` } })
const assistantTurn = (atMs: number) =>
  JSON.stringify({ type: 'assistant', timestamp: new Date(atMs).toISOString(), message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'On it.' }] } })
const apiError = (atMs: number, error: string, text: string) =>
  JSON.stringify({ type: 'assistant', isApiErrorMessage: true, error, timestamp: new Date(atMs).toISOString(), message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text }] } })

function writeTranscript(fs: MemoryFs, lines: string[], mtimeMs: number) {
  fs.writeFile(TRANSCRIPT, `${lines.join('\n')}\n`)
  fs.touch(TRANSCRIPT, mtimeMs)
}

/** The checkup job as the backend enqueues it (P1: op reconcile, intent checkup, one target, a numeric id). */
function checkupJob(rpcId = 'chk-1', targets: any[] = [{ pairingId: 3, assistantId: 912 }]) {
  return { frames: [{ rpcId, op: 'reconcile' }], jobs: { [rpcId]: { rpcId, op: 'reconcile', machineId: MACHINE_ID, intent: 'checkup', targets } } }
}

/** The installed plugin and the marketplace both at 0.38.4 (nothing stale), unless a test says otherwise. */
function stubModules(opts: { latest?: string; onPlan?: (state: any) => void } = {}) {
  return {
    planMachine: (state: any) => {
      opts.onPlan?.(state)
      return { verdict: 'nothing_to_do', targetVersion: null, steps: [] }
    },
    executePlan: async () => {
      throw new Error('executePlan must not run in this test')
    },
    observeMarketplaceInstall: async () => ({
      marketplaceRegistered: true,
      marketplaceInstallLocation: null,
      marketplaceLatest: { version: opts.latest ?? '0.38.4', ref: `v${opts.latest ?? '0.38.4'}` },
      installed: { present: true, version: '0.38.4', installPath: ROOT },
      enabled: true,
    }),
    runClaudeCli: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false }),
  }
}

function rig(fs: MemoryFs, backend: ReturnType<typeof fakeBackend>, clock: ReturnType<typeof fakeClock>, ps: string, overrides: Record<string, unknown> = {}) {
  const logs: string[] = []
  const spawns: Array<{ file: string; args: string[] }> = []
  const kills: Array<[number, string]> = []
  const execCalls: string[] = []
  const live = new Set([4242, ...((overrides.alive as number[] | undefined) ?? [])])
  const deps = {
    home: HOME,
    env: { USER },
    platform: 'linux',
    fetch: backend.fetch as any,
    fs,
    exec: async (file: string, args: string[]) => {
      execCalls.push(`${file} ${args.join(' ')}`)
      if (file === 'ps') return { code: 0, stdout: `${ps}\n`, stderr: '', error: null, timedOut: false }
      return { code: 1, stdout: '', stderr: '', error: null, timedOut: false }
    },
    spawnDetached: (file: string, args: readonly string[]) => {
      spawns.push({ file, args: [...args] })
      return { pid: 4343 }
    },
    now: clock.now,
    sleep: clock.sleep,
    once: true,
    nodePath: '/usr/local/bin/node',
    uid: 501,
    username: USER,
    pidAlive: (pid: number) => live.has(pid),
    execSync: () => ({ code: 1, stdout: '' }),
    kill: (pid: number, signal: string) => void kills.push([pid, signal]),
    hasTmux: true,
    hasScript: true,
    echo: (line: string) => logs.push(line),
    modules: stubModules(),
    // The sweep and the windows pass are other packets; here they never act.
    keepAliveSweep: async () => ({ enabled: false, agents: [] }),
    windowsPass: async () => ({ memory: {}, report: { mode: 'none', reason: 'unsupported' } }),
    ...overrides,
  }
  delete (deps as any).alive
  return { deps, logs, spawns, kills, execCalls }
}

/** The daemon answers the boot hello probe: the first sleep after a probe lands writes a newer lastLiveAt. */
function daemonAnswersProbe(fs: MemoryFs, clock: ReturnType<typeof fakeClock>) {
  clock.onSleep((_ms, nowMs) => {
    if (fs.files.has(`${STATE_DIR}/probe-requested.json`)) {
      fs.writeFile(`${PLUGIN_STATE}/channel-live.json`, JSON.stringify({ firstLiveAt: 'x', lastLiveAt: new Date(nowMs).toISOString() }))
    }
  })
}

const terminalOf = (backend: ReturnType<typeof fakeBackend>, rpcId = 'chk-1') => backend.progress(rpcId).at(-1)!

/** Every progress body fits the backend's DTO (P1), so the terminal report can never be a 400. */
function assertDtoShape(bodies: any[]) {
  for (const body of bodies) {
    assert.ok(['planning', 'running', 'done', 'failed', 'rolled_back'].includes(body.state), `state ${body.state}`)
    for (const s of body.steps ?? []) {
      assert.ok(s.id.length <= 64 && s.kind.length <= 64, `step ${s.id}`)
      assert.ok(STEP_STATES.has(s.state), `step state ${s.state}`)
      if (s.message != null) assert.ok(s.message.length <= 300)
    }
    if (body.message != null) assert.ok(body.message.length <= 300, 'message over 300')
    assert.ok((body.findings ?? []).length <= 24 && (body.actions ?? []).length <= 24)
    for (const f of body.findings ?? []) {
      assert.match(f.cause, TOKEN_RE)
      if (f.target != null) assert.match(f.target, AGENT_ID_RE)
      assert.ok(STATUSES.has(f.status), `status ${f.status}`)
      assert.ok(typeof f.detail === 'string' && f.detail.length <= 400)
      if (f.fix != null) assert.ok(typeof f.fix === 'string' && f.fix.length <= 400)
    }
    for (const a of body.actions ?? []) {
      assert.match(a.cause, TOKEN_RE)
      assert.match(a.did, TOKEN_RE)
      if (a.target != null) assert.match(a.target, AGENT_ID_RE)
      assert.ok(OUTCOMES.has(a.outcome), `outcome ${a.outcome}`)
      assert.ok(typeof a.detail === 'string' && a.detail.length <= 400)
    }
  }
}

function assertNoSecrets(texts: string[], what: string) {
  for (const text of texts) {
    for (const secret of [TOKEN, 'agent-secret-912', HOME]) assert.equal(text.includes(secret), false, `${what} leaked ${secret}: ${text.slice(0, 200)}`)
  }
}

const keepAliveRecord = (fs: MemoryFs) => JSON.parse(fs.readFile(KEEPALIVE_STATE) ?? '{"agents":{}}').agents?.['912'] ?? null
const restartRequested = (fs: MemoryFs) => fs.files.has(`${STATE_DIR}/restart-requested.json`)

test('stopped-only policy: a live idle or busy target is reported with Restart now and never restarted', async () => {
  for (const turnInFlight of [false, true]) {
    const fs = agentFs({ [`${PLUGIN_STATE}/agent-state.json`]: agentState({ turnInFlight }) })
    writeTranscript(fs, [assistantTurn(T0 - 20 * MIN), ownerMessage(T0 - 15 * MIN)], T0 - 15 * MIN)
    const backend = fakeBackend(checkupJob())
    const run = rig(fs, backend, fakeClock(), IDLE_PS, { alive: [3000, 5912, 4912] })
    await runWatcher(run.deps as any)
    const terminal = terminalOf(backend)
    assert.equal(restartRequested(fs), false)
    assert.deepEqual(run.kills, [])
    assert.deepEqual(run.spawns, [])
    assert.equal(keepAliveRecord(fs), null)
    assert.ok(terminal.actions.some((a: any) => a.did === 'report' && /Restart now/.test(a.detail)))
    assert.match(terminal.findings[0].fix, /Restart now/)
  }
})

test('stopped-only policy: an unreadable process table is reported, never acted on', async () => {
  const fs = agentFs({ [`${STATE_DIR}/supervisor.json`]: '' })
  const backend = fakeBackend(checkupJob())
  const run = rig(fs, backend, fakeClock(), '', { pidAlive: () => false })
  await runWatcher(run.deps as any)
  const terminal = terminalOf(backend)
  assert.ok(terminal.findings.some((f: any) => f.cause === 'process_unknown'))
  assert.ok(terminal.actions.some((a: any) => a.did === 'report' && /Restart now/.test(a.detail)))
  assert.equal(restartRequested(fs), false)
  assert.deepEqual(run.kills, [])
  assert.deepEqual(run.spawns, [])
  assert.equal(keepAliveRecord(fs), null)
})

test('stopped-only policy: a stopped target is checked twice across a short gap and started once', async () => {
  const fs = agentFs({ [`${STATE_DIR}/supervisor.json`]: '' })
  const backend = fakeBackend(checkupJob())
  const clock = fakeClock()
  daemonAnswersProbe(fs, clock)
  const run = rig(fs, backend, clock, psLine(1, 0, '/sbin/init'), { pidAlive: () => false })
  const checks: number[] = []
  const exec = run.deps.exec
  run.deps.exec = async (file: string, args: string[]) => {
    if (file === 'ps') checks.push(clock.now())
    return exec(file, args)
  }
  await runWatcher(run.deps as any)
  assert.ok(checks.length >= 2)
  assert.ok(checks.at(-1)! - checks.at(-2)! >= STOPPED_CONFIRM_GAP_MS, 'two stopped snapshots need a real gap')
  assert.equal(run.spawns.length, 1)
  assert.deepEqual(run.kills, [])
  assert.equal(restartRequested(fs), false)
  assert.equal(keepAliveRecord(fs).attempts, 1)
  assert.equal(terminalOf(backend).actions.find((a: any) => a.did === 'start_agent').outcome, 'fixed')
})

for (const username of ['agent', 'daemon', 'running', 'observe', 'restart', 'ok', 'fixed', 'FAIL', 'done', '912']) {
  test(`report scrubbing preserves protocol fields for username ${username}`, async () => {
    const fs = agentFs()
    writeTranscript(fs, [apiError(T0 - 45 * MIN, 'authentication_failed', 'Please run /login')], T0 - 45 * MIN)
    const ps = [psLine(3000, 4242, `node ${ROOT}/bin/hoai-core.mjs`), psLine(5912, 3000, `claude --resume ${SID}`)].join('\n')
    const backend = fakeBackend(checkupJob())
    const clock = fakeClock()
    daemonAnswersProbe(fs, clock)
    const run = rig(fs, backend, clock, ps, { alive: [3000, 5912], username, env: { USER: username } })
    await runWatcher(run.deps as any)
    const terminal = terminalOf(backend)
    assert.equal(terminal.state, 'done', 'the backend must accept every progress body, including after the repair')
    assert.deepEqual(terminal.findings.map((f: any) => [f.cause, f.status, f.target]), [
      ['daemon_down', 'FAIL', '912'], ['login_expired', 'FAIL', '912'],
    ])
    assert.deepEqual(terminal.actions.map((a: any) => [a.cause, a.target, a.did, a.outcome]), [
      ['login_expired', '912', 'report', 'not_fixed'], ['daemon_down', '912', 'report', 'not_fixed'],
    ])
    assert.deepEqual(terminal.steps.map((s: any) => [s.id, s.kind, s.state]), [
      ['observe', 'observe', 'ok'], ['a1-report', 'report', 'ok'],
      ['a2-report', 'report', 'ok'],
    ])
    assert.equal(restartRequested(fs), false)
    assertDtoShape(backend.progress('chk-1'))
    assertNoSecrets([...run.logs, ...backend.progress('chk-1').map((p: any) => JSON.stringify(p))], 'scrubbed report')
    if (username === 'agent') {
      assert.match(terminal.findings[1].fix, /<user>/)
      assert.match(terminal.actions[0].detail, /<user>/)
    }
    if (username === 'daemon') assert.match(terminal.findings[0].detail, /<user>/)
    if (username === 'fixed') assert.match(terminal.message, /<user>/)
  })
}

test('report scrubbing removes secrets from a failed stopped start while preserving protocol fields', async () => {
  const fs = agentFs({ [`${STATE_DIR}/supervisor.json`]: '' })
  const backend = fakeBackend(checkupJob())
  const run = rig(fs, backend, fakeClock(), psLine(1, 0, '/sbin/init'), {
    pidAlive: () => false, username: 'agent',
    spawnDetached: () => { throw new Error(`agent ${HOME} ${TOKEN} agent-secret-912`) },
  })
  await runWatcher(run.deps as any)
  const terminal = terminalOf(backend)
  assert.equal(terminal.state, 'failed')
  assert.deepEqual([terminal.failedStep?.id, terminal.failedStep?.kind, terminal.failedStep?.target], ['a1-start_agent', 'start_agent', '912'])
  assert.match(terminal.failedStep.message, /<user> ~ <redacted> <redacted>/)
  assert.match(terminal.actions[0].detail, /<user> ~ <redacted> <redacted>/)
  assertDtoShape(backend.progress('chk-1'))
  assertNoSecrets([...run.logs, JSON.stringify(terminal)], 'failed step')
})

// -- the brief's three cases --------------------------------------------------------------------

test('a live Claude with a dead connector and expired login reports both without recovery', async () => {
  const fs = agentFs()
  writeTranscript(fs, [apiError(T0 - 45 * MIN, 'authentication_failed', 'Please run /login')], T0 - 45 * MIN)
  const ps = [psLine(3000, 4242, `node ${ROOT}/bin/hoai-core.mjs`), psLine(5912, 3000, `claude --resume ${SID}`)].join('\n')
  const backend = fakeBackend(checkupJob())
  const run = rig(fs, backend, fakeClock(), ps, { alive: [3000, 5912] })
  await runWatcher(run.deps as any)
  const terminal = terminalOf(backend)
  assert.deepEqual(terminal.actions.map((a: any) => [a.cause, a.did, a.outcome]), [
    ['login_expired', 'report', 'not_fixed'], ['daemon_down', 'report', 'not_fixed'],
  ])
  assert.match(terminal.findings[0].fix, /Restart now/)
  assert.match(terminal.findings[1].fix, /\/login/)
  assert.equal(restartRequested(fs), false)
  assert.equal(keepAliveRecord(fs), null)
  assert.deepEqual(run.kills, [])
  assert.deepEqual(run.spawns, [])
  assertDtoShape(backend.progress('chk-1'))
})

test('repeated checkups of a wedged idle session only report and never spend a restart attempt', async () => {
  const fs = agentFs({ [`${PLUGIN_STATE}/agent-state.json`]: agentState() })
  writeTranscript(fs, [assistantTurn(T0 - 20 * MIN), ownerMessage(T0 - 15 * MIN)], T0 - 15 * MIN)
  fs.writeFile(`${PLUGIN_STATE}/channel-beacon.json`, '{}')
  fs.touch(`${PLUGIN_STATE}/channel-beacon.json`, T0 - 5_000)
  for (const rpcId of ['chk-1', 'chk-2']) {
    const backend = fakeBackend(checkupJob(rpcId))
    const run = rig(fs, backend, fakeClock(), IDLE_PS, { alive: [3000, 5912, 4912] })
    await runWatcher(run.deps as any)
    const terminal = terminalOf(backend, rpcId)
    assert.deepEqual(terminal.actions.map((a: any) => [a.cause, a.did, a.outcome]), [['wedged_session', 'report', 'not_fixed']])
    assert.match(terminal.findings[0].fix, /Restart now/)
    assert.equal(restartRequested(fs), false)
    assert.equal(keepAliveRecord(fs), null)
    assert.deepEqual(run.kills, [])
    assert.deepEqual(run.spawns, [])
  }
})

test('a busy or background session is reported without any automatic action', async () => {
  for (const [reason, stateOver, extraPs] of [
    ['turn_in_flight', { turnInFlight: true }, ''],
    ['background_job', {}, `\n${psLine(6000, 5912, `/bin/zsh -c source ${HOME}/.claude/shell-snapshots/snapshot-zsh-1.sh && eval 'python monitor.py'`)}`],
  ] as const) {
    const fs = agentFs({ [`${PLUGIN_STATE}/agent-state.json`]: agentState(stateOver) })
    writeTranscript(fs, [assistantTurn(T0 - 20 * MIN), ownerMessage(T0 - 15 * MIN)], T0 - 15 * MIN)
    const ps = [psLine(1, 0, '/sbin/init'), psLine(3000, 4242, `node ${ROOT}/bin/hoai-core.mjs`), psLine(5912, 3000, `claude --resume ${SID}`), psLine(4912, 5912, `node ${ROOT}/server.ts`)].join('\n') + extraPs
    const backend = fakeBackend(checkupJob())
    const clock = fakeClock()
    const run = rig(fs, backend, clock, ps, { alive: [3000, 5912, 4912, 6000] })
    await runWatcher(run.deps as any)
    const terminal = terminalOf(backend)
    assert.equal(terminal.state, 'done', reason)
    assert.deepEqual(terminal.findings.map((f: any) => f.cause), ['wedged_session'], reason)
    assert.deepEqual(terminal.actions.map((a: any) => [a.cause, a.did, a.outcome]), [['wedged_session', 'report', 'not_fixed']], reason)
    assert.match(terminal.actions[0].detail, /Restart now/)
    assert.equal(restartRequested(fs), false, reason)
    assert.equal(fs.files.has(`${STATE_DIR}/probe-requested.json`), false, `${reason}: no verify without a restart`)
    assert.equal(keepAliveRecord(fs), null, `${reason}: no attempt spent`)
    assert.deepEqual(run.kills, [])
    assertDtoShape(backend.progress('chk-1'))
  }
})

test('a usage limit is reported with its reset time and never restarted, even when the silence looks like a wedge', async () => {
  const fs = agentFs({ [`${PLUGIN_STATE}/agent-state.json`]: agentState() })
  writeTranscript(
    fs,
    [assistantTurn(T0 - 40 * MIN), ownerMessage(T0 - 30 * MIN), apiError(T0 - 30 * MIN, 'rate_limit', "You've hit your session limit · resets 7:40pm (Asia/Dubai)"), ownerMessage(T0 - 15 * MIN)],
    T0 - 15 * MIN,
  )
  const ps = [psLine(1, 0, '/sbin/init'), psLine(3000, 4242, `node ${ROOT}/bin/hoai-core.mjs`), psLine(5912, 3000, `claude --resume ${SID}`), psLine(4912, 5912, `node ${ROOT}/server.ts`)].join('\n')
  const backend = fakeBackend(checkupJob())
  const clock = fakeClock()
  const run = rig(fs, backend, clock, ps, { alive: [3000, 5912, 4912] })
  await runWatcher(run.deps as any)
  const terminal = terminalOf(backend)
  assert.equal(terminal.state, 'done')
  assert.deepEqual(terminal.findings.map((f: any) => [f.cause, f.status]), [['usage_limit', 'WARN']])
  assert.match(terminal.findings[0].fix, /resets at 7:40pm \(Asia\/Dubai\)/)
  assert.deepEqual(terminal.actions.map((a: any) => [a.cause, a.did, a.outcome]), [['usage_limit', 'report', 'not_fixed']])
  assert.equal(restartRequested(fs), false)
  assert.equal(fs.files.has(`${STATE_DIR}/probe-requested.json`), false)
  assert.equal(keepAliveRecord(fs), null)
  assert.deepEqual(run.spawns, [])
  assert.deepEqual(run.kills, [])
  assertDtoShape(backend.progress('chk-1'))
})

// -- Usage limits remain reports, including after a login change ---------------------------------

/** The CLI's own limit envelope, with the machine readable reset (apiErrorParams.rate_limit_info.resetsAt, Unix seconds). */
const limitEnvelope = (atMs: number, resetsAtMs: number) =>
  JSON.stringify({
    type: 'assistant',
    isApiErrorMessage: true,
    error: 'rate_limit',
    apiError: 'usage_limit_reached',
    apiErrorStatus: 429,
    apiErrorParams: { rate_limit_info: { status: 'rejected', resetsAt: resetsAtMs / 1000, rateLimitType: 'five_hour' } },
    timestamp: new Date(atMs).toISOString(),
    message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: "You've hit your session limit · resets 7:40pm (Asia/Dubai)" }] },
  })
test('usage limits stay report only even after login changes, with no screen reads, keys or limit-record writes', async () => {
  for (const corrupt of [false, true]) {
    const fs = agentFs({ [`${PLUGIN_STATE}/agent-state.json`]: agentState() })
    writeTranscript(fs, [limitEnvelope(T0 - 30 * MIN, T0 + 3 * 60 * MIN)], T0 - 30 * MIN)
    fs.writeFile(`${CONFIG}/.credentials.json`, 'NEVER-READ')
    fs.touch(`${CONFIG}/.credentials.json`, T0 - 10 * MIN)
    const watchFile = `${HOME}/.bgos-agent/watcher/limit-watch.json`
    const torn = '{"schemaVersion":1'
    if (corrupt) fs.writeFile(watchFile, torn)
    const backend = fakeBackend(checkupJob())
    const run = rig(fs, backend, fakeClock(), IDLE_PS, { alive: [3000, 5912, 4912] })
    await runWatcher(run.deps as any)
    assert.deepEqual(terminalOf(backend).actions.map((a: any) => [a.did, a.outcome]), [['report', 'not_fixed']])
    assert.ok(run.execCalls.every((c) => c.startsWith('ps ')))
    assert.equal(fs.readFile(watchFile), corrupt ? torn : null)
    assert.equal(restartRequested(fs), false)
    assert.deepEqual(run.kills, [])
    assert.deepEqual(run.spawns, [])
  }
})

// -- the job's own rules ------------------------------------------------------------------------------

test('a checkup job never runs the reconcile planner: an intent this watcher knows is never widened into a reconcile', async () => {
  const fs = agentFs({ [`${PLUGIN_STATE}/agent-state.json`]: agentState() })
  writeTranscript(fs, [ownerMessage(T0 - 30 * MIN), assistantTurn(T0 - 29 * MIN)], T0 - 29 * MIN)
  const ps = [psLine(1, 0, '/sbin/init'), psLine(3000, 4242, `node ${ROOT}/bin/hoai-core.mjs`), psLine(5912, 3000, `claude --resume ${SID}`), psLine(4912, 5912, `node ${ROOT}/server.ts`)].join('\n')
  let planned = 0
  const backend = fakeBackend(checkupJob())
  const clock = fakeClock()
  const run = rig(fs, backend, clock, ps, { alive: [3000, 5912, 4912], modules: stubModules({ onPlan: () => void planned++ }) })
  await runWatcher(run.deps as any)
  const terminal = terminalOf(backend)
  assert.equal(planned, 0, 'no reconcile plan for a healthy agent')
  assert.equal(terminal.state, 'done')
  assert.deepEqual(terminal.findings, [])
  assert.deepEqual(terminal.actions, [])
  assert.match(terminal.message, /no cause found/)
  assert.equal(restartRequested(fs), false)
})

test('a checkup with no agent, or with several, is refused by name and touches nothing (never the whole computer)', async () => {
  for (const [targets, message] of [
    [[], /checkup_needs_one_agent/],
    [[{ pairingId: 3, assistantId: 912 }, { pairingId: 4, assistantId: 913 }], /checkup_needs_one_agent/],
    [[{ pairingId: 9, assistantId: 999 }], /agent_not_on_this_machine/],
  ] as const) {
    const fs = agentFs()
    const backend = fakeBackend(checkupJob('chk-1', [...targets]))
    const clock = fakeClock()
    const run = rig(fs, backend, clock, psLine(1, 0, '/sbin/init'), { pidAlive: () => false })
    await runWatcher(run.deps as any)
    const terminal = terminalOf(backend)
    assert.equal(terminal.state, 'failed', JSON.stringify(targets))
    assert.match(terminal.message, message)
    assert.equal(restartRequested(fs), false)
    assert.equal(run.execCalls.some((c) => c.startsWith('ps ')), false, 'nothing observed for a refused job')
  }
})

test('the op checkup is a checkup too', async () => {
  const fs = agentFs()
  const backend = fakeBackend({ frames: [{ rpcId: 'chk-1', op: 'checkup' }], jobs: { 'chk-1': { op: 'checkup', targets: [] } } })
  const clock = fakeClock()
  const run = rig(fs, backend, clock, psLine(1, 0, '/sbin/init'), { pidAlive: () => false })
  await runWatcher(run.deps as any)
  assert.match(terminalOf(backend).message, /checkup_needs_one_agent/)
})

test('a dead session with a supervisor is started and verified; a named launch failure is reported, never retried', async () => {
  // No Claude, daemon or launcher. The start-only path uses the launch recipe (tmux here).
  const fs = agentFs({ [`${STATE_DIR}/supervisor.json`]: '' })
  writeTranscript(fs, [ownerMessage(T0 - 50 * MIN), assistantTurn(T0 - 49 * MIN)], T0 - 49 * MIN)
  const backend = fakeBackend(checkupJob())
  const clock = fakeClock()
  daemonAnswersProbe(fs, clock)
  const run = rig(fs, backend, clock, psLine(1, 0, '/sbin/init'), { pidAlive: () => false })
  await runWatcher(run.deps as any)
  const terminal = terminalOf(backend)
  assert.deepEqual(terminal.findings.map((f: any) => f.cause), ['dead_session'])
  assert.deepEqual(terminal.actions.map((a: any) => [a.cause, a.did, a.outcome]), [['dead_session', 'start_agent', 'fixed']])
  assert.equal(run.spawns.length, 1)
  assert.equal(run.spawns[0]!.file, 'tmux')

  const failed = agentFs({ [`${STATE_DIR}/supervisor.json`]: '', [`${STATE_DIR}/launch-status`]: '2026-08-25 11:50:00 outcome=exited-during-startup rc=1\n' })
  const backend2 = fakeBackend(checkupJob())
  const run2 = rig(failed, backend2, fakeClock(), psLine(1, 0, '/sbin/init'), { pidAlive: () => false })
  await runWatcher(run2.deps as any)
  const t2 = terminalOf(backend2)
  assert.deepEqual(t2.findings.map((f: any) => [f.cause, f.status]), [['dead_session', 'FAIL']])
  assert.match(t2.findings[0].fix, /exited-during-startup/)
  assert.deepEqual(t2.actions.map((a: any) => [a.cause, a.did, a.outcome]), [['dead_session', 'report', 'not_fixed']])
  assert.deepEqual(run2.spawns, [])
})

test('the pass deadline bounds verification of a stopped start inside 75 seconds', async () => {
  const fs = agentFs({ [`${STATE_DIR}/supervisor.json`]: '' })
  const backend = fakeBackend(checkupJob())
  const clock = fakeClock()
  const run = rig(fs, backend, clock, psLine(1, 0, '/sbin/init'), { pidAlive: () => false })
  await runWatcher(run.deps as any)
  const terminal = terminalOf(backend)
  assert.equal(terminal.state, 'failed')
  assert.deepEqual(terminal.actions.map((a: any) => [a.cause, a.did, a.outcome]), [['dead_session', 'start_agent', 'not_fixed']])
  assert.equal(terminal.failedStep.kind, 'verify_agent')
  assert.ok(clock.now() - T0 <= 75_000)
  assert.equal(keepAliveRecord(fs).state, 'failed')
})

// -- Explicit pairing confirmation never authorizes a live restart -------------------------------

const IDLE_PS = [psLine(1, 0, '/sbin/init'), psLine(3000, 4242, `node ${ROOT}/bin/hoai-core.mjs`), psLine(5912, 3000, `claude --resume ${SID}`), psLine(4912, 5912, `node ${ROOT}/server.ts`)].join('\n')

const PAIR_CODE = 'ABCDEF123456'
const AGENT_CREDS = `${HOME}/.bgos-agent/credentials-912.json`
const pairingCredentials = (token = 'agent-secret-912') => JSON.stringify({ assistantId: '912', pairingId: 3, pairingToken: token, backendUrl: 'https://api.example.test' })

function pairingBackend(job: ReturnType<typeof checkupJob>, verdict: { status: number; body: any }) {
  const backend = fakeBackend(job)
  const probes: any[] = []
  const fetch = async (url: string, init: any) => {
    if (new URL(url).pathname.endsWith('/integrations/session')) {
      assert.equal(init.method, 'POST')
      assert.equal(init.redirect, 'error', 'never send an agent credential across a redirect')
      probes.push({ url, headers: init.headers })
      return { ok: verdict.status < 400, status: verdict.status, text: async () => JSON.stringify(verdict.body) }
    }
    return backend.fetch(url, init)
  }
  return { ...backend, fetch, probes }
}

test('revocation is reported to the owner without re-pairing, restarting, or exposing credentials', async () => {
  const fs = agentFs({ [AGENT_CREDS]: pairingCredentials(), [`${PLUGIN_STATE}/agent-state.json`]: agentState() })
  const backend = pairingBackend(checkupJob(), { status: 401, body: { code: 'pairing_revoked' } })
  const run = rig(fs, backend, fakeClock(), IDLE_PS, { alive: [3000, 5912, 4912] })
  await runWatcher(run.deps as any)
  const terminal = terminalOf(backend)
  assert.deepEqual(terminal.findings.map((f: any) => f.cause), ['pairing_revoked'])
  assert.match(terminal.findings[0].fix, /confirm/i)
  assert.deepEqual(terminal.actions.map((a: any) => [a.did, a.outcome]), [['report', 'not_fixed']])
  assert.equal(backend.probes.length, 1)
  assert.equal(backend.probes[0].headers['X-BGOS-Pairing'], 'agent-secret-912')
  assert.equal(fs.readFile(AGENT_CREDS), pairingCredentials())
  assert.equal(restartRequested(fs), false)
  assert.deepEqual(run.kills, [])
  assert.deepEqual(run.spawns, [])
  assertDtoShape(backend.progress('chk-1'))
  assertNoSecrets(run.logs, 'log')
  assertNoSecrets(backend.calls.map((c) => JSON.stringify(c.body ?? {})), 'owner report')
})

test('confirmed re-pairing repairs credentials and reports Restart now without a live reload', async () => {
  const fs = agentFs({ [AGENT_CREDS]: pairingCredentials(), [`${PLUGIN_STATE}/agent-state.json`]: agentState(), [`${ROOT}/bin/bgos-pair.mjs`]: '// pair' })
  const job = checkupJob()
  Object.assign(job.jobs['chk-1']!, { pairingRepair: { confirmed: true, assistantId: '912', pairingId: 3, pairCode: PAIR_CODE } })
  const backend = pairingBackend(job, { status: 401, body: { code: 'pairing_revoked' } })
  const clock = fakeClock()
  daemonAnswersProbe(fs, clock)
  const run = rig(fs, backend, clock, IDLE_PS, { alive: [3000, 5912, 4912] })
  const exec = run.deps.exec
  const pairs: any[] = []
  run.deps.exec = async (file: string, args: string[], opts?: any) => {
    if (args[0] === `${ROOT}/bin/bgos-pair.mjs`) {
      pairs.push({ file, args, opts })
      fs.writeFile(AGENT_CREDS, pairingCredentials('replacement-secret-912'))
      return { code: 0, stdout: PAIR_CODE, stderr: '', error: null, timedOut: false }
    }
    return exec(file, args)
  }
  await runWatcher(run.deps as any)
  const terminal = terminalOf(backend)
  assert.equal(terminal.state, 'done')
  assert.equal(pairs.length, 1)
  assert.equal(pairs[0].opts.cwd, AVA)
  assert.ok(pairs[0].args.includes('--no-install-cli'))
  assert.deepEqual(pairs[0].args.slice(2, 4), ['--assistant-id', '912'])
  assert.equal(restartRequested(fs), false)
  assert.deepEqual(terminal.actions.map((a: any) => [a.cause, a.did, a.outcome]), [
    ['pairing_revoked', 're_pair', 'fixed'], ['pairing_revoked', 'report', 'not_fixed'],
  ])
  const progress = backend.progress('chk-1')
  assert.ok(progress.some((p: any) => p.steps.some((s: any) => s.kind === 're_pair' && s.state === 'ok')))
  assertDtoShape(progress)
  assertNoSecrets([...run.logs, ...progress.map((p: any) => JSON.stringify(p))], 'report')
  for (const secret of [PAIR_CODE, 'replacement-secret-912']) assert.ok(!JSON.stringify([...run.logs, ...progress]).includes(secret))
})

function keepalivePairRig() {
  const markerPath = `${STATE_DIR}/keepalive.json`
  const marker = (claudePid: number) => JSON.stringify({ kind: 'keepalive', pid: 33108, claudePid, capabilities: ['relaunch'], startedAt: new Date(T0 - 5 * MIN).toISOString() })
  const fs = agentFs({
    [AGENT_CREDS]: pairingCredentials(),
    [`${PLUGIN_STATE}/agent-state.json`]: agentState(),
    [`${ROOT}/bin/bgos-pair.mjs`]: '// pair',
    [markerPath]: marker(5912),
  })
  fs.rm(`${STATE_DIR}/supervisor.json`)
  const job = checkupJob()
  Object.assign(job.jobs['chk-1']!, { pairingRepair: { confirmed: true, assistantId: '912', pairingId: 3, pairCode: PAIR_CODE } })
  const backend = pairingBackend(job, { status: 401, body: { code: 'pairing_revoked' } })
  const clock = fakeClock()
  daemonAnswersProbe(fs, clock)
  let currentPid = 5912
  const run = rig(fs, backend, clock, '', { alive: [33108, 5912, 6912, 4912], execSync: (file: string, args: string[]) => {
    if (file === 'ps' && args[0] === '-A') return { code: 0, stdout: `33108 1 501 01:00:00\n${currentPid} 33108 501 10:00\n` }
    if (file === 'ps' && args[1] === 'comm=') return { code: 0, stdout: Number(args[3]) === currentPid ? 'claude\n' : 'sleep\n' }
    return { code: 1, stdout: '' }
  } })
  const exec = run.deps.exec
  run.deps.exec = async (file: string, args: string[]) => {
    if (args[0] === `${ROOT}/bin/bgos-pair.mjs`) {
      fs.writeFile(AGENT_CREDS, pairingCredentials('replacement-secret-912'))
      return { code: 0, stdout: '', stderr: '', error: null, timedOut: false }
    }
    if (file === 'ps') return { code: 0, stdout: [
      psLine(33108, 1, 'bash keepalive.sh'),
      psLine(currentPid, 33108, `claude --resume ${SID}`),
      psLine(4912, currentPid, `node ${ROOT}/server.ts`),
      ...(currentPid === 5912 ? [] : [psLine(5912, 1, 'sleep 1000')]),
    ].join('\n'), stderr: '', error: null, timedOut: false }
    return exec(file, args)
  }
  const replaceClaude = (busy = false) => {
    currentPid = 6912
    fs.writeFile(markerPath, marker(currentPid))
    fs.writeFile(`${PLUGIN_STATE}/agent-state.json`, agentState({ claudePid: currentPid, turnInFlight: busy }))
  }
  return { fs, backend, run, replaceClaude }
}

test('a keepalive replacement during confirmed pairing is never signalled, idle or busy', async () => {
  for (const busy of [false, true]) {
    const { fs, backend, run, replaceClaude } = keepalivePairRig()
    const exec = run.deps.exec
    run.deps.exec = async (file: string, args: string[]) => {
      const result = await exec(file, args)
      if (args[0] === `${ROOT}/bin/bgos-pair.mjs`) replaceClaude(busy)
      return result
    }
    await runWatcher(run.deps as any)
    assert.deepEqual(run.kills, [])
    assert.deepEqual(run.spawns, [])
    assert.equal(restartRequested(fs), false)
    assert.equal(keepAliveRecord(fs), null)
    assert.match(terminalOf(backend).actions.at(-1).detail, /Restart now/)
  }
})



test('confirmation is bound to this agent and pairing, and cannot authorize a repair without a revoked finding', async () => {
  for (const repair of [
    undefined,
    { confirmed: 'true', assistantId: '912', pairingId: 3, pairCode: PAIR_CODE },
    { confirmed: true, assistantId: '913', pairingId: 3, pairCode: PAIR_CODE },
    { confirmed: true, assistantId: '912', pairingId: 4, pairCode: PAIR_CODE },
    { confirmed: true, assistantId: '912', pairingId: 3, pairCode: '--help' },
  ]) {
    const fs = agentFs({ [AGENT_CREDS]: pairingCredentials(), [`${PLUGIN_STATE}/agent-state.json`]: agentState() })
    const job = checkupJob()
    Object.assign(job.jobs['chk-1']!, { pairingRepair: repair })
    const backend = pairingBackend(job, { status: 401, body: { code: 'pairing_revoked' } })
    const run = rig(fs, backend, fakeClock(), IDLE_PS, { alive: [3000, 5912, 4912] })
    await runWatcher(run.deps as any)
    assert.deepEqual(terminalOf(backend).actions.map((a: any) => a.did), ['report'])
    assert.equal(restartRequested(fs), false)
    assert.ok(!run.execCalls.some((c) => c.includes('bgos-pair')))
  }
  for (const verdict of [
    { status: 200, body: {} }, { status: 401, body: { code: 'session_expired' } },
    { status: 403, body: { code: 'pairing_revoked' } }, { status: 503, body: {} },
  ]) {
    const fs = agentFs({ [AGENT_CREDS]: pairingCredentials(), [`${PLUGIN_STATE}/agent-state.json`]: agentState() })
    const job = checkupJob()
    Object.assign(job.jobs['chk-1']!, { pairingRepair: { confirmed: true, assistantId: '912', pairingId: 3, pairCode: PAIR_CODE } })
    const backend = pairingBackend(job, verdict)
    const run = rig(fs, backend, fakeClock(), IDLE_PS, { alive: [3000, 5912, 4912] })
    await runWatcher(run.deps as any)
    assert.deepEqual(terminalOf(backend).actions, [])
    assert.equal(restartRequested(fs), false)
    assert.ok(!run.execCalls.some((c) => c.includes('bgos-pair')))
  }
})



test('a failed pairing repair never reloads the agent and keeps command output out of the owner report', async () => {
  const fs = agentFs({ [AGENT_CREDS]: pairingCredentials(), [`${PLUGIN_STATE}/agent-state.json`]: agentState(), [`${ROOT}/bin/bgos-pair.mjs`]: '// pair' })
  const job = checkupJob()
  Object.assign(job.jobs['chk-1']!, { pairingRepair: { confirmed: true, assistantId: '912', pairingId: 3, pairCode: PAIR_CODE } })
  const backend = pairingBackend(job, { status: 401, body: { code: 'pairing_revoked' } })
  const run = rig(fs, backend, fakeClock(), IDLE_PS, { alive: [3000, 5912, 4912] })
  const exec = run.deps.exec
  run.deps.exec = async (file: string, args: string[]) => args[0]?.endsWith('/bgos-pair.mjs')
    ? { code: 2, stdout: '', stderr: `${PAIR_CODE} agent-secret-912 ${HOME}`, error: null, timedOut: false }
    : exec(file, args)
  await runWatcher(run.deps as any)
  const terminal = terminalOf(backend)
  assert.equal(terminal.state, 'failed')
  assert.equal(terminal.failedStep.kind, 're_pair')
  assert.deepEqual(terminal.actions.map((a: any) => [a.did, a.outcome]), [['re_pair', 'not_fixed'], ['report', 'not_fixed']])
  assert.equal(restartRequested(fs), false)
  assertNoSecrets([...run.logs, JSON.stringify(terminal)], 'failed pair report')
  assert.ok(!JSON.stringify(terminal).includes(PAIR_CODE))
})

test('a stopped start cannot act if its shared budget record cannot be saved', async () => {
  const fs = agentFs({ [`${STATE_DIR}/supervisor.json`]: '' })
  const write = fs.writeFile
  fs.writeFile = (path, text, opts) => {
    if (path === KEEPALIVE_STATE) throw new Error('disk full')
    return write(path, text, opts)
  }
  const backend = fakeBackend(checkupJob())
  const run = rig(fs, backend, fakeClock(), psLine(1, 0, '/sbin/init'), { pidAlive: () => false })
  await runWatcher(run.deps as any)
  assert.equal(restartRequested(fs), false)
  assert.equal(terminalOf(backend).state, 'failed')
  assert.match(terminalOf(backend).actions.at(-1).detail, /restart_record_unsaved/)
  assert.deepEqual(run.spawns, [])
  assert.deepEqual(run.kills, [])
})

test('a transient terminal report failure is retried so the owner receives the result', async () => {
  const fs = agentFs({ [`${PLUGIN_STATE}/agent-state.json`]: agentState() })
  const backend = fakeBackend(checkupJob())
  let refused = false
  const delivered: any[] = []
  const fetch = backend.fetch
  backend.fetch = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : null
    if (url.endsWith('/chk-1/progress') && body?.state === 'done') {
      if (!refused) {
        refused = true
        return { ok: false, status: 503, text: async () => '{}' }
      }
      delivered.push(body)
    }
    return fetch(url, init)
  }
  const run = rig(fs, backend, fakeClock(), IDLE_PS, { alive: [3000, 5912, 4912] })
  await runWatcher(run.deps as any)
  assert.equal(refused, true)
  assert.equal(delivered.length, 1)
  assert.deepEqual(delivered[0].findings, [])
  assert.deepEqual(delivered[0].actions, [])
})

test('an undeliverable progress step holds the repair before it changes credentials or restarts', async () => {
  const fs = agentFs({ [AGENT_CREDS]: pairingCredentials(), [`${PLUGIN_STATE}/agent-state.json`]: agentState(), [`${ROOT}/bin/bgos-pair.mjs`]: '// pair' })
  const job = checkupJob()
  Object.assign(job.jobs['chk-1']!, { pairingRepair: { confirmed: true, assistantId: '912', pairingId: 3, pairCode: PAIR_CODE } })
  const backend = pairingBackend(job, { status: 401, body: { code: 'pairing_revoked' } })
  const fetch = backend.fetch
  backend.fetch = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : null
    if (url.endsWith('/chk-1/progress') && body?.steps?.some((s: any) => s.kind === 're_pair' && s.state === 'running')) {
      return { ok: false, status: 503, text: async () => '{}' }
    }
    return fetch(url, init)
  }
  const run = rig(fs, backend, fakeClock(), IDLE_PS, { alive: [3000, 5912, 4912] })
  await runWatcher(run.deps as any)
  assert.equal(terminalOf(backend).state, 'failed')
  assert.equal(fs.readFile(AGENT_CREDS), pairingCredentials())
  assert.ok(!run.execCalls.some((c) => c.includes('bgos-pair')))
  assert.equal(restartRequested(fs), false)
})

test('a credential rotation after observation invalidates the pairing confirmation', async () => {
  const fs = agentFs({ [AGENT_CREDS]: pairingCredentials(), [`${PLUGIN_STATE}/agent-state.json`]: agentState(), [`${ROOT}/bin/bgos-pair.mjs`]: '// pair' })
  const job = checkupJob()
  Object.assign(job.jobs['chk-1']!, { pairingRepair: { confirmed: true, assistantId: '912', pairingId: 3, pairCode: PAIR_CODE } })
  const backend = pairingBackend(job, { status: 401, body: { code: 'pairing_revoked' } })
  const fetch = backend.fetch
  backend.fetch = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : null
    if (body?.steps?.some((s: any) => s.kind === 're_pair' && s.state === 'running')) fs.writeFile(AGENT_CREDS, pairingCredentials('rotated-secret-912'))
    return fetch(url, init)
  }
  const run = rig(fs, backend, fakeClock(), IDLE_PS, { alive: [3000, 5912, 4912] })
  await runWatcher(run.deps as any)
  assert.equal(terminalOf(backend).failedStep.message, 'pairing_changed')
  assert.ok(!run.execCalls.some((c) => c.includes('bgos-pair')))
  assert.equal(restartRequested(fs), false)
})

test('a successful pair command must replace verified credentials before any reload', async () => {
  for (const mode of ['unchanged', 'wrong_agent', 'timed_out', 'spawn_failed', 'missing_script', 'unverified_folder']) {
    const fs = agentFs({ [AGENT_CREDS]: pairingCredentials(), [`${PLUGIN_STATE}/agent-state.json`]: agentState(), [`${ROOT}/bin/bgos-pair.mjs`]: '// pair' })
    if (mode === 'missing_script') fs.rm(`${ROOT}/bin/bgos-pair.mjs`)
    const job = checkupJob()
    Object.assign(job.jobs['chk-1']!, { pairingRepair: { confirmed: true, assistantId: '912', pairingId: 3, pairCode: PAIR_CODE } })
    const backend = pairingBackend(job, { status: 401, body: { code: 'pairing_revoked' } })
    const fetch = backend.fetch
    backend.fetch = async (url, init) => {
      if (mode === 'unverified_folder' && init?.body && JSON.parse(init.body).steps?.some((s: any) => s.kind === 're_pair' && s.state === 'running')) fs.rm(`${AVA}/.bgos-agent-id`)
      return fetch(url, init)
    }
    const run = rig(fs, backend, fakeClock(), IDLE_PS, { alive: [3000, 5912, 4912] })
    const exec = run.deps.exec
    run.deps.exec = async (file: string, args: string[]) => {
      if (!args[0]?.endsWith('/bgos-pair.mjs')) return exec(file, args)
      if (mode === 'spawn_failed') throw new Error(`${PAIR_CODE} agent-secret-912 ${HOME}`)
      if (mode === 'wrong_agent') fs.writeFile(AGENT_CREDS, JSON.stringify({ ...JSON.parse(pairingCredentials('new-secret-912')), assistantId: '913' }))
      return { code: 0, stdout: '', stderr: '', error: null, timedOut: mode === 'timed_out' }
    }
    await runWatcher(run.deps as any)
    const terminal = terminalOf(backend)
    assert.equal(terminal.state, 'failed', mode)
    assert.equal(terminal.failedStep.kind, 're_pair', mode)
    assert.equal(restartRequested(fs), false, mode)
    assert.equal(keepAliveRecord(fs), null, mode)
    assertNoSecrets([...run.logs, JSON.stringify(terminal)], mode)
  }
})

test('pairing credentials for another backend or agent are never sent in a probe', async () => {
  for (const over of [{ backendUrl: 'https://other.example.test' }, { assistantId: '913' }]) {
    const fs = agentFs({ [AGENT_CREDS]: JSON.stringify({ ...JSON.parse(pairingCredentials()), ...over }), [`${PLUGIN_STATE}/agent-state.json`]: agentState() })
    const backend = pairingBackend(checkupJob(), { status: 401, body: { code: 'pairing_revoked' } })
    const run = rig(fs, backend, fakeClock(), IDLE_PS, { alive: [3000, 5912, 4912] })
    await runWatcher(run.deps as any)
    assert.equal(backend.probes.length, 0)
    assert.deepEqual(terminalOf(backend).actions, [])
    assert.equal(restartRequested(fs), false)
  }
})

for (const problem of ['stale', 'stuck', 'both']) {
  test(`a live target with ${problem} update state is reported without running the file executor`, async () => {
    const fs = agentFs({ [`${PLUGIN_STATE}/agent-state.json`]: agentState({ runningVersion: problem === 'stuck' ? '0.38.4' : '0.38.3' }) })
    if (problem !== 'stale') fs.writeFile(`${PLUGIN_STATE}/auto-update.json`, JSON.stringify({ validationPending: true, validationBootStartedAt: T0 - 30 * MIN }))
    const backend = fakeBackend(checkupJob())
    let plans = 0
    const run = rig(fs, backend, fakeClock(), IDLE_PS, { alive: [3000, 5912, 4912], modules: stubModules({ onPlan: () => { plans++ } }) })
    await runWatcher(run.deps as any)
    const terminal = terminalOf(backend)
    assert.equal(terminal.state, 'done')
    assert.equal(terminal.findings.length, problem === 'both' ? 2 : 1)
    assert.ok(terminal.actions.every((a: any) => a.did === 'report' && /Restart now/.test(a.detail)))
    assert.equal(plans, 0)
    assert.equal(restartRequested(fs), false)
    assert.equal(keepAliveRecord(fs), null)
    assert.deepEqual(run.kills, [])
    assert.deepEqual(run.spawns, [])
  })
}

// -- the transcript tail and the target, pure ------------------------------------------------------

test('parseTranscriptTail: a real turn after an error ends it (the login works again, the cap lifted)', () => {
  const login = parseTranscriptTail([apiError(T0 - 30 * MIN, 'authentication_failed', 'Not logged in · Please run /login'), assistantTurn(T0 - 10 * MIN)].join('\n'), T0)
  assert.equal(login.error, null)
  assert.equal(login.lastActivityAtMs, T0 - 10 * MIN)
  const still = parseTranscriptTail([assistantTurn(T0 - 40 * MIN), apiError(T0 - 30 * MIN, 'authentication_failed', 'Login expired · Please run /login')].join('\n'), T0)
  assert.deepEqual(still.error, { kind: 'authentication_failed', resetAt: null, atMs: T0 - 30 * MIN, resetsAtMs: null })
})

test('parseTranscriptTail: a session cap older than its 5 h window says nothing; a weekly one holds for days', () => {
  const old = parseTranscriptTail(apiError(T0 - 6 * 60 * MIN, 'rate_limit', "You've hit your session limit · resets 4am (Asia/Dubai)"), T0)
  assert.equal(old.error, null)
  const weekly = parseTranscriptTail(apiError(T0 - 3 * 24 * 60 * MIN, 'rate_limit', "You've hit your weekly limit · resets Jul 10 at 10pm (Asia/Dubai)"), T0)
  assert.equal(weekly.error?.kind, 'rate_limit')
  assert.equal(weekly.error?.resetAt, 'Jul 10 at 10pm (Asia/Dubai)')
})

test('parseTranscriptTail: the machine readable reset time rides along (rate_limit_info.resetsAt, else quotaLimits.resetsAt)', () => {
  const resetsAtMs = T0 + 2 * 60 * MIN
  const info = parseTranscriptTail(limitEnvelope(T0 - 30 * MIN, resetsAtMs), T0)
  assert.equal(info.error?.resetsAtMs, resetsAtMs)
  const quota = JSON.stringify({ ...JSON.parse(apiError(T0 - 30 * MIN, 'rate_limit', "You've hit your session limit · resets 4pm")), quotaLimits: { resetsAt: resetsAtMs / 1000 } })
  assert.equal(parseTranscriptTail(quota, T0).error?.resetsAtMs, resetsAtMs)
  for (const bad of ['soon', -1, 0, null, 1e20]) {
    const junk = JSON.stringify({ ...JSON.parse(limitEnvelope(T0 - 30 * MIN, resetsAtMs)), apiErrorParams: { rate_limit_info: { resetsAt: bad } } })
    assert.equal(parseTranscriptTail(junk, T0).error?.resetsAtMs, null, String(bad))
  }
  assert.equal(parseTranscriptTail(apiError(T0 - 30 * MIN, 'authentication_failed', 'Please run /login'), T0).error?.resetsAtMs, null)
})

test('parseTranscriptTail: a session cap stays an error until an hour past its own reset, so the watcher has time to free it', () => {
  // Hit early in its window: the reset is 4 h 59 min later, a minute before the old 5 h staleness edge.
  const atMs = T0 - 5 * 60 * MIN + 30_000
  const tail = limitEnvelope(atMs, atMs + 5 * 60 * MIN - 60_000)
  assert.equal(parseTranscriptTail(tail, T0 + 30 * MIN).error?.kind, 'rate_limit')
  assert.equal(parseTranscriptTail(tail, atMs + 6 * 60 * MIN).error, null)
})

test('parseTranscriptTail: only an OWNER channel message is a delivery; events, peers, the system, sidechains and synthetic turns are not', () => {
  const event = JSON.stringify({ type: 'user', timestamp: new Date(T0 - 5 * MIN).toISOString(), message: { content: '<channel source="bgos" event_type="reaction">x</channel>' } })
  const peer = JSON.stringify({ type: 'user', timestamp: new Date(T0 - 4 * MIN).toISOString(), message: { content: '<channel source="bgos" sender_type="agent">x</channel>' } })
  const system = JSON.stringify({ type: 'user', timestamp: new Date(T0 - 3 * MIN).toISOString(), message: { content: '<channel source="bgos">\n[System message from BGOS] wake</channel>' } })
  const side = JSON.stringify({ type: 'assistant', isSidechain: true, timestamp: new Date(T0 - 2 * MIN).toISOString(), message: { model: 'claude-opus-5-5', content: [] } })
  const synthetic = JSON.stringify({ type: 'assistant', timestamp: new Date(T0 - 1 * MIN).toISOString(), message: { model: '<synthetic>', content: [] } })
  const tail = parseTranscriptTail([ownerMessage(T0 - 20 * MIN), assistantTurn(T0 - 19 * MIN), event, peer, system, side, synthetic, 'not json'].join('\n'), T0)
  assert.equal(tail.ownerDeliveredAtMs, T0 - 20 * MIN)
  assert.equal(tail.lastActivityAtMs, T0 - 19 * MIN)
  assert.equal(isOwnerChannelText('<channel source="bgos" chat_id="1">hi</channel>'), true)
  assert.equal(isOwnerChannelText('hello from the terminal'), false)
})

test('checkupTarget: exactly one agent, by number or by digits string', () => {
  assert.deepEqual(checkupTarget({ targets: [{ assistantId: 912 }] }), { ok: true, assistantId: '912' })
  assert.deepEqual(checkupTarget({ targets: [{ assistantId: '912' }, { assistantId: 912 }] }), { ok: true, assistantId: '912' })
  assert.equal(checkupTarget({ targets: [] }).ok, false)
  assert.equal(checkupTarget({}).ok, false)
  assert.equal(checkupTarget({ targets: [{ assistantId: '../x' }] }).ok, false)
})

test('a malformed target alongside a valid agent is refused whole', () => {
  assert.equal(checkupTarget({ targets: [{ assistantId: '912' }, { assistantId: '../x' }] }).ok, false)
})

for (const [name, extra, alive] of [
  ['stale daemon state', { [`${PLUGIN_STATE}/agent-state.json`]: agentState({ updatedAt: new Date(T0 - 24 * 60 * MIN).toISOString() }) }, [4912]],
  ['stale launcher recipe', {}, [4242]],
  ['stale pairing lock', { [`${HOME}/.bgos-agent/credentials-912.json.lock`]: JSON.stringify({ pid: 4912, heartbeatAt: T0 - 24 * 60 * MIN }) }, [4912]],
  ['keepalive marker', { [`${STATE_DIR}/keepalive.json`]: JSON.stringify({ kind: 'keepalive', pid: 33108, claudePid: 5912, capabilities: ['relaunch'] }) }, [33108]],
] as Array<[string, Record<string, string>, number[]]>) {
  test(`stopped-only policy: ${name} with a live PID prevents all automatic recovery`, async () => {
    const fs = agentFs({ [`${STATE_DIR}/supervisor.json`]: '', ...extra })
    const backend = fakeBackend(checkupJob())
    const run = rig(fs, backend, fakeClock(), psLine(1, 0, '/sbin/init'), { pidAlive: (pid: number) => alive.includes(pid) })
    await runWatcher(run.deps as any)
    const terminal = terminalOf(backend)
    assert.equal(terminal.state, 'done')
    assert.ok(terminal.actions.some((a: any) => a.did === 'report' && /Restart now/.test(a.detail)))
    assert.deepEqual(run.spawns, [])
    assert.deepEqual(run.kills, [])
    assert.equal(restartRequested(fs), false)
    assert.equal(keepAliveRecord(fs), null)
  })
}

for (const cwd of [AVA, `${AVA}/jobs`, null]) {
  test(`stopped-only policy: an orphaned background process with cwd ${cwd ?? 'unreadable'} prevents a start`, async () => {
    const fs = agentFs({ [`${STATE_DIR}/supervisor.json`]: '' })
    const backend = fakeBackend(checkupJob())
    const run = rig(fs, backend, fakeClock(), psLine(6000, 1, 'python monitor.py'), { pidAlive: (pid: number) => pid === 6000 })
    const exec = run.deps.exec
    run.deps.exec = async (file: string, args: string[]) => file === 'readlink' && cwd
      ? { code: 0, stdout: cwd, stderr: '', error: null, timedOut: false } : exec(file, args)
    await runWatcher(run.deps as any)
    const terminal = terminalOf(backend)
    assert.equal(terminal.state, 'done')
    assert.ok(terminal.findings.some((f: any) => f.cause === (cwd ? 'daemon_down' : 'process_unknown')))
    assert.ok(terminal.actions.every((a: any) => a.did === 'report' && /Restart now/.test(a.detail)))
    assert.deepEqual(run.spawns, [])
    assert.deepEqual(run.kills, [])
    assert.equal(keepAliveRecord(fs), null)
  })
}

for (const nextState of ['alive', 'unknown']) {
  test(`stopped-only policy: becoming ${nextState} in the confirmation gap reports without spending the budget`, async () => {
    const fs = agentFs({ [`${STATE_DIR}/supervisor.json`]: '' })
    const backend = fakeBackend(checkupJob())
    const clock = fakeClock()
    let changed = false
    clock.onSleep((ms) => { if (ms === STOPPED_CONFIRM_GAP_MS) changed = true })
    const run = rig(fs, backend, clock, psLine(1, 0, '/sbin/init'), { pidAlive: () => false })
    const exec = run.deps.exec
    run.deps.exec = async (file: string, args: string[]) => file === 'ps' && changed
      ? { code: 0, stdout: nextState === 'alive' ? psLine(6000, 1, `python ${AVA}/monitor.py`) : '', stderr: '', error: null, timedOut: false }
      : exec(file, args)
    await runWatcher(run.deps as any)
    const terminal = terminalOf(backend)
    assert.equal(changed, true, 'a second check follows the confirmation gap')
    assert.equal(terminal.state, 'done')
    assert.ok(terminal.actions.some((a: any) => a.did === 'start_agent' && a.outcome === 'skipped'))
    assert.ok(terminal.actions.some((a: any) => a.did === 'report' && /Restart now/.test(a.detail)))
    assert.match(terminal.findings[0].fix, /Restart now/)
    assert.deepEqual(run.spawns, [])
    assert.deepEqual(run.kills, [])
    assert.equal(restartRequested(fs), false)
    assert.equal(keepAliveRecord(fs), null)
  })
}

test('stopped-only policy: repeated stopped checkups share one recovery attempt within 30 minutes', async () => {
  const fs = agentFs({ [`${STATE_DIR}/supervisor.json`]: '' })
  const clock = fakeClock()
  daemonAnswersProbe(fs, clock)
  for (const [rpcId, starts] of [['chk-1', 1], ['chk-2', 0]] as const) {
    const backend = fakeBackend(checkupJob(rpcId))
    const run = rig(fs, backend, clock, psLine(1, 0, '/sbin/init'), { pidAlive: () => false })
    await runWatcher(run.deps as any)
    assert.equal(run.spawns.length, starts)
    assert.equal(keepAliveRecord(fs).attempts, 1)
    if (starts === 0) assert.ok(terminalOf(backend, rpcId).actions.some((a: any) => a.did === 'report'))
  }
})

test('stopped-only policy: the real job starts an owned systemd unit without calling restart', async () => {
  const unitPath = `${HOME}/.config/systemd/user/bgos-agent-912.service`
  const fs = agentFs({
    [`${STATE_DIR}/supervisor.json`]: '',
    [unitPath]: `[Service]\nWorkingDirectory=${AVA}\nExecStart=/bin/bash "${STATE_DIR}/run.sh"\nEnvironment=HOME=${HOME}\n`,
  })
  const backend = fakeBackend(checkupJob())
  const clock = fakeClock()
  daemonAnswersProbe(fs, clock)
  const run = rig(fs, backend, clock, psLine(1, 0, '/sbin/init'), { pidAlive: () => false })
  const exec = run.deps.exec
  const services: string[][] = []
  run.deps.exec = async (file: string, args: string[]) => {
    if (file !== 'systemctl') return exec(file, args)
    services.push(args)
    return { code: 0, stdout: args[1] === 'show'
      ? `LoadState=loaded\nActiveState=inactive\nFragmentPath=${unitPath}\nWorkingDirectory=${AVA}\nEnvironment=HOME=${HOME}\n`
      : '', stderr: '', error: null, timedOut: false }
  }
  await runWatcher(run.deps as any)
  assert.equal(terminalOf(backend).state, 'done')
  assert.deepEqual(services.filter((args) => args[1] !== 'show'), [['--user', 'start', 'bgos-agent-912']])
  assert.deepEqual(run.spawns, [])
  assert.deepEqual(run.kills, [])
  assert.equal(restartRequested(fs), false)
  assert.equal(keepAliveRecord(fs).attempts, 1)
  assert.equal(terminalOf(backend).actions.find((a: any) => a.did === 'start_agent').outcome, 'fixed')
})
