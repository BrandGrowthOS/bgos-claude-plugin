/**
 * The watcher's `checkup` job (check up plan 4.2, packet P3): observe ONE agent from the facts this
 * computer can read, plan with the pure lib/agent-checkup.mjs, execute only the planned safe steps,
 * verify by the boot hello, and post progress whose terminal report carries `findings` and
 * `actions` in the backend's MachineRpcProgressDto shape.
 *
 * The watcher-core rig (test/watcher-core.test.ts): the REAL loop (runWatcher) against an
 * in-process fake backend that records every request, a fake HOME in memory (test/helpers/memory-fs.ts),
 * a fake clock, a fake `ps`, and the REAL restart ladder (lib/agent-restart.mjs) and verify
 * (lib/agent-verify.mjs). Nothing here lists, signals or starts a real process: the real OS sentinel
 * is the first import, and every restart lands as a marker file in the fake HOME.
 *
 * Decisions pinned (Data, from KC's ask that the watcher troubleshoot and fix any reason an agent is
 * offline): the pass auto fixes C3 to C7 (safe restarts and updates only, gated by the safe moment
 * table and the restart budget) and only REPORTS C8 and C9; the wedge window for C5 is 10 minutes of
 * owner messages unanswered with no transcript activity.
 *
 * Run: npx tsx --test test/watcher-checkup.test.ts
 */

// First: any real process listing, signal or launch from the loop fails this file instead of
// acting on the computer it runs on (board row afa70b0c, test/watcher-real-os.guard.test.ts).
import './helpers/real-os-sentinel.ts'

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { runWatcher } from '../lib/watcher-core.mjs'
import { checkupTarget, isOwnerChannelText, parseTranscriptTail } from '../lib/watcher-checkup.mjs'
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

// -- the brief's three cases --------------------------------------------------------------------

test('one pass fixes a dead daemon AND reports a signed out login: the login first, then the connector restarted and verified', async () => {
  // claude runs (its pinned session on the command line) with NO daemon under it: no fresh state, no
  // pairing lock. The transcript ends in the CLI's authentication_failed envelope.
  const fs = agentFs()
  writeTranscript(fs, [assistantTurn(T0 - 50 * MIN), ownerMessage(T0 - 45 * MIN), apiError(T0 - 45 * MIN, 'authentication_failed', 'Login expired · Please run /login')], T0 - 45 * MIN)
  const ps = [psLine(1, 0, '/sbin/init'), psLine(3000, 4242, `node ${ROOT}/bin/hoai-core.mjs`), psLine(5912, 3000, `claude --resume ${SID}`)].join('\n')
  const backend = fakeBackend(checkupJob())
  const clock = fakeClock()
  // What the keep-alive record says WHILE the verify runs: the attempt is on disk before the act, so
  // a watcher killed mid restart still counts it (the sweep's F8 rule).
  const duringVerify: any[] = []
  clock.onSleep(() => duringVerify.push(keepAliveRecord(fs)))
  daemonAnswersProbe(fs, clock)
  const run = rig(fs, backend, clock, ps, { alive: [3000, 5912] })
  assert.equal(await runWatcher(run.deps as any), 0)
  assert.equal(duringVerify[0]?.attempts, 1, 'spent before the act')
  assert.equal(duringVerify[0]?.reason, 'checkup_restarting')

  const terminal = terminalOf(backend)
  assert.equal(terminal.state, 'done')
  assert.deepEqual(
    terminal.findings.map((f: any) => [f.cause, f.status, f.target]),
    [
      ['daemon_down', 'FAIL', '912'],
      ['login_expired', 'FAIL', '912'],
    ],
  )
  assert.match(terminal.findings[1].fix, /\/login/)
  assert.equal(terminal.findings[0].fix, undefined, 'the watcher fixes C3 itself: no owner fix')
  // Reported first, then the one restart, which the boot hello proved.
  assert.deepEqual(
    terminal.actions.map((a: any) => [a.cause, a.did, a.outcome]),
    [
      ['login_expired', 'report', 'not_fixed'],
      ['daemon_down', 'restart_agent', 'fixed'],
    ],
  )
  assert.match(terminal.actions[0].detail, /\/login/)
  assert.match(terminal.actions[1].detail, /marker/)
  // The real restart ladder: the live launcher's marker, nothing killed, nothing spawned.
  assert.equal(restartRequested(fs), true)
  assert.deepEqual(run.kills, [])
  assert.deepEqual(run.spawns, [])
  // The restart is spent on the keep-alive budget the sweep shares (1 per 30 min, 3 attempts).
  const record = keepAliveRecord(fs)
  assert.equal(record.lastRestartAt, new Date(T0).toISOString())
  assert.equal(record.attempts, 1)
  assert.equal(record.state, 'restarted')
  // planning, then running with the steps, then the terminal.
  const progress = backend.progress('chk-1')
  assert.equal(progress[0].state, 'planning')
  assert.deepEqual(
    terminal.steps.map((s: any) => `${s.kind}:${s.state}`),
    ['observe:ok', 'report:ok', 'restart_agent:ok', 'verify_agent:ok'],
  )
  assertDtoShape(progress)
  assertNoSecrets(backend.calls.map((c) => JSON.stringify(c.body ?? {})), 'request body')
  assertNoSecrets(run.logs, 'log line')
})

test('a wedged session inside the safe window is restarted ONCE; the next pass is held by the restart budget', async () => {
  // claude and its daemon alive and idle (fresh state, nothing owed, hooks), an owner message
  // delivered 15 min ago, newer than any model activity (20 min ago): past the 10 min wedge window.
  const fs = agentFs({ [`${PLUGIN_STATE}/agent-state.json`]: agentState() })
  writeTranscript(fs, [assistantTurn(T0 - 20 * MIN), ownerMessage(T0 - 15 * MIN)], T0 - 15 * MIN)
  fs.writeFile(`${PLUGIN_STATE}/channel-beacon.json`, '{}')
  fs.touch(`${PLUGIN_STATE}/channel-beacon.json`, T0 - 5_000)
  const ps = [psLine(1, 0, '/sbin/init'), psLine(3000, 4242, `node ${ROOT}/bin/hoai-core.mjs`), psLine(5912, 3000, `claude --resume ${SID}`), psLine(4912, 5912, `node ${ROOT}/server.ts`)].join('\n')
  const backend = fakeBackend(checkupJob())
  const clock = fakeClock()
  daemonAnswersProbe(fs, clock)
  const run = rig(fs, backend, clock, ps, { alive: [3000, 5912, 4912] })
  await runWatcher(run.deps as any)

  const terminal = terminalOf(backend)
  assert.equal(terminal.state, 'done')
  assert.deepEqual(terminal.findings.map((f: any) => f.cause), ['wedged_session'])
  assert.match(terminal.findings[0].detail, /15 min/)
  assert.deepEqual(terminal.actions.map((a: any) => [a.cause, a.did, a.outcome]), [['wedged_session', 'restart_agent', 'fixed']])
  assert.equal(restartRequested(fs), true)
  assert.equal(keepAliveRecord(fs).attempts, 1)

  // The same tap again a minute later: still wedged in the fixture, but the budget (one restart per
  // agent per 30 min) holds it. Skipped with the reason, nothing written.
  fs.rm(`${STATE_DIR}/restart-requested.json`)
  fs.writeFile(`${PLUGIN_STATE}/agent-state.json`, agentState({ updatedAt: new Date(clock.now() + MIN - 5_000).toISOString() }))
  fs.writeFile(`${PLUGIN_STATE}/channel-beacon.json`, '{}')
  fs.touch(`${PLUGIN_STATE}/channel-beacon.json`, clock.now() + MIN - 5_000)
  clock.advance(MIN)
  const again = fakeBackend(checkupJob('chk-2'))
  const second = rig(fs, again, clock, ps, { alive: [3000, 5912, 4912] })
  await runWatcher(second.deps as any)
  const held = terminalOf(again, 'chk-2')
  assert.equal(held.state, 'done')
  assert.deepEqual(held.actions.map((a: any) => [a.cause, a.did, a.outcome]), [['wedged_session', 'restart_agent', 'skipped']])
  assert.match(held.actions[0].detail, /restart_rate_limited/)
  assert.equal(restartRequested(fs), false, 'restarted once, not twice')
  assert.equal(keepAliveRecord(fs).attempts, 1)
  assertDtoShape([...backend.progress('chk-1'), ...again.progress('chk-2')])
})

test('a wedged session outside the safe window waits with the reason, and nothing is touched', async () => {
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
    assert.deepEqual(terminal.actions.map((a: any) => [a.cause, a.did, a.outcome]), [['wedged_session', 'restart_agent', 'skipped']], reason)
    assert.match(terminal.actions[0].detail, new RegExp(reason))
    assert.match(terminal.actions[0].detail, /did not interrupt/)
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
    const run = rig(fs, backend, clock, psLine(1, 0, '/sbin/init'))
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
  const run = rig(fs, backend, clock, psLine(1, 0, '/sbin/init'))
  await runWatcher(run.deps as any)
  assert.match(terminalOf(backend).message, /checkup_needs_one_agent/)
})

test('a dead session with a supervisor is started and verified; a named launch failure is reported, never retried', async () => {
  // No claude, no daemon. With a launch recipe the start goes through the ladder (a tmux one shot here).
  const fs = agentFs({ [`${STATE_DIR}/supervisor.json`]: '' })
  writeTranscript(fs, [ownerMessage(T0 - 50 * MIN), assistantTurn(T0 - 49 * MIN)], T0 - 49 * MIN)
  const backend = fakeBackend(checkupJob())
  const clock = fakeClock()
  daemonAnswersProbe(fs, clock)
  const run = rig(fs, backend, clock, psLine(1, 0, '/sbin/init'))
  await runWatcher(run.deps as any)
  const terminal = terminalOf(backend)
  assert.deepEqual(terminal.findings.map((f: any) => f.cause), ['dead_session'])
  assert.deepEqual(terminal.actions.map((a: any) => [a.cause, a.did, a.outcome]), [['dead_session', 'start_agent', 'fixed']])
  assert.equal(run.spawns.length, 1)
  assert.equal(run.spawns[0]!.file, 'tmux')

  const failed = agentFs({ [`${STATE_DIR}/supervisor.json`]: '', [`${STATE_DIR}/launch-status`]: '2026-08-25 11:50:00 outcome=exited-during-startup rc=1\n' })
  const backend2 = fakeBackend(checkupJob())
  const run2 = rig(failed, backend2, fakeClock(), psLine(1, 0, '/sbin/init'))
  await runWatcher(run2.deps as any)
  const t2 = terminalOf(backend2)
  assert.deepEqual(t2.findings.map((f: any) => [f.cause, f.status]), [['dead_session', 'FAIL']])
  assert.match(t2.findings[0].fix, /exited-during-startup/)
  assert.deepEqual(t2.actions.map((a: any) => [a.cause, a.did, a.outcome]), [['dead_session', 'report', 'not_fixed']])
  assert.deepEqual(run2.spawns, [])
})

test('the pass deadline bounds the verify: a deaf agent is not_fixed inside 75 s, never a 120 s wait', async () => {
  const fs = agentFs()
  writeTranscript(fs, [assistantTurn(T0 - 50 * MIN)], T0 - 50 * MIN)
  const ps = [psLine(1, 0, '/sbin/init'), psLine(3000, 4242, `node ${ROOT}/bin/hoai-core.mjs`), psLine(5912, 3000, `claude --resume ${SID}`)].join('\n')
  const backend = fakeBackend(checkupJob())
  const clock = fakeClock()
  const run = rig(fs, backend, clock, ps, { alive: [3000, 5912] })
  await runWatcher(run.deps as any)
  const terminal = terminalOf(backend)
  assert.equal(terminal.state, 'failed')
  assert.deepEqual(terminal.actions.map((a: any) => [a.cause, a.did, a.outcome]), [['daemon_down', 'restart_agent', 'not_fixed']])
  assert.match(terminal.actions[0].detail, /agent_deaf_after_restart/)
  assert.equal(terminal.failedStep.kind, 'verify_agent')
  assert.ok(clock.now() - T0 <= 75_000, `the pass took ${clock.now() - T0} ms`)
  assert.equal(keepAliveRecord(fs).state, 'failed')
})

// -- C6 and C7: file level first, then the gated restart ------------------------------------------

/** A planner that answers like the real one for one agent, and an executor that records what it was handed. */
function updateModules(opts: { latest?: string; verdict?: string; reason?: string; onPlan?: (state: any) => void; ran?: any[][] } = {}) {
  return {
    ...stubModules({ latest: opts.latest }),
    planMachine: (state: any) => {
      opts.onPlan?.(state)
      if (opts.verdict === 'blocked') return { verdict: 'blocked', reason: opts.reason ?? 'rollback_latched', targetVersion: null, steps: [] }
      const install = state.intent === 'repair' ? 'reinstall_plugin' : 'update_plugin'
      return {
        verdict: 'plan',
        targetVersion: opts.latest ?? '0.38.4',
        steps: [
          { id: 's01-refresh_marketplace', kind: 'refresh_marketplace', onFailure: 'stop', why: 'x' },
          { id: 's02-snapshot', kind: 'snapshot', onFailure: 'stop', why: 'x' },
          { id: `s03-${install}`, kind: install, onFailure: 'escalate', why: 'x' },
          { id: 's04-verify_installed', kind: 'verify_installed', onFailure: 'rollback', why: 'x' },
          ...state.agents.flatMap((a: any) => [
            { id: `s05-restart_agent:${a.assistantId}`, kind: 'restart_agent', target: a.assistantId, via: 'marker', onFailure: 'continue', why: 'x' },
            { id: `s06-verify_agent:${a.assistantId}`, kind: 'verify_agent', target: a.assistantId, onFailure: 'rollback', why: 'x' },
          ]),
        ],
      }
    },
    executePlan: async (plan: any, deps: any, report: any) => {
      opts.ran?.push(plan.steps.map((s: any) => s.kind))
      for (const step of plan.steps) {
        if (step.kind === 'restart_agent' || step.kind === 'verify_agent') throw new Error('the checkup restarts through its own gate, never the executor')
        await report(step.id, { state: 'running' })
        await report(step.id, { state: 'ok', message: step.kind })
      }
      return { ok: true, verdict: 'done', failedStep: null, rolledBack: false, targetVersion: plan.targetVersion, installedVersion: plan.targetVersion, steps: plan.steps.map((s: any) => ({ ...s, state: 'ok', message: s.kind })) }
    },
  }
}

const IDLE_PS = [psLine(1, 0, '/sbin/init'), psLine(3000, 4242, `node ${ROOT}/bin/hoai-core.mjs`), psLine(5912, 3000, `claude --resume ${SID}`), psLine(4912, 5912, `node ${ROOT}/server.ts`)].join('\n')

test('C6 stale plugin: the update runs FILE steps only (no executor restart), then the one gated restart applies it, verified', async () => {
  const fs = agentFs({ [`${PLUGIN_STATE}/agent-state.json`]: agentState({ runningVersion: '0.38.3', lastActivityAt: new Date(T0 - 40 * MIN).toISOString() }) })
  writeTranscript(fs, [ownerMessage(T0 - 41 * MIN), assistantTurn(T0 - 40 * MIN)], T0 - 40 * MIN)
  const ran: any[][] = []
  const planned: any[] = []
  const backend = fakeBackend(checkupJob())
  const clock = fakeClock()
  daemonAnswersProbe(fs, clock)
  const run = rig(fs, backend, clock, IDLE_PS, { alive: [3000, 5912, 4912], modules: updateModules({ ran, onPlan: (s) => planned.push(s) }) })
  await runWatcher(run.deps as any)
  const terminal = terminalOf(backend)
  assert.equal(terminal.state, 'done')
  assert.deepEqual(terminal.findings.map((f: any) => [f.cause, f.status]), [['stale_plugin', 'WARN']])
  assert.match(terminal.findings[0].detail, /0\.38\.3/)
  assert.deepEqual(terminal.actions.map((a: any) => [a.cause, a.did, a.outcome]), [
    ['stale_plugin', 'update', 'fixed'],
    ['stale_plugin', 'restart_agent', 'fixed'],
  ])
  assert.deepEqual(ran, [['refresh_marketplace', 'snapshot', 'update_plugin', 'verify_installed']])
  assert.deepEqual(planned.map((s) => [s.intent, s.agents.map((a: any) => a.assistantId)]), [['update', ['912']]], 'planned for this agent alone')
  assert.equal(restartRequested(fs), true)
  assertDtoShape(backend.progress('chk-1'))
})

test('C6 with updates latched: the update is not_fixed by name and the restart it needed is skipped, nothing touched', async () => {
  const fs = agentFs({ [`${PLUGIN_STATE}/agent-state.json`]: agentState({ runningVersion: '0.38.3', lastActivityAt: new Date(T0 - 40 * MIN).toISOString() }) })
  writeTranscript(fs, [ownerMessage(T0 - 41 * MIN), assistantTurn(T0 - 40 * MIN)], T0 - 40 * MIN)
  const backend = fakeBackend(checkupJob())
  const clock = fakeClock()
  const run = rig(fs, backend, clock, IDLE_PS, { alive: [3000, 5912, 4912], modules: updateModules({ verdict: 'blocked', reason: 'rollback_latched' }) })
  await runWatcher(run.deps as any)
  const terminal = terminalOf(backend)
  assert.equal(terminal.state, 'failed')
  assert.deepEqual(terminal.actions.map((a: any) => [a.cause, a.did, a.outcome]), [
    ['stale_plugin', 'update', 'not_fixed'],
    ['stale_plugin', 'restart_agent', 'skipped'],
  ])
  assert.match(terminal.actions[0].detail, /rollback_latched/)
  assert.match(terminal.actions[1].detail, /update_not_applied/)
  assert.equal(restartRequested(fs), false)
  assert.equal(keepAliveRecord(fs), null)
})

test('C7 stuck update (validation stalled): ONE repair, file steps only, then the gated restart and verify', async () => {
  const fs = agentFs({
    [`${PLUGIN_STATE}/agent-state.json`]: agentState({ lastActivityAt: new Date(T0 - 40 * MIN).toISOString() }),
    [`${PLUGIN_STATE}/auto-update.json`]: JSON.stringify({ schemaVersion: 1, disabled: false, validationPending: true, validationBootStartedAt: T0 - 30 * MIN }),
  })
  writeTranscript(fs, [ownerMessage(T0 - 41 * MIN), assistantTurn(T0 - 40 * MIN)], T0 - 40 * MIN)
  const ran: any[][] = []
  const planned: any[] = []
  const backend = fakeBackend(checkupJob())
  const clock = fakeClock()
  daemonAnswersProbe(fs, clock)
  const run = rig(fs, backend, clock, IDLE_PS, { alive: [3000, 5912, 4912], modules: updateModules({ ran, onPlan: (s) => planned.push(s) }) })
  await runWatcher(run.deps as any)
  const terminal = terminalOf(backend)
  assert.equal(terminal.state, 'done')
  assert.deepEqual(terminal.findings.map((f: any) => f.cause), ['stuck_update'])
  assert.deepEqual(terminal.actions.map((a: any) => [a.cause, a.did, a.outcome]), [
    ['stuck_update', 'repair', 'fixed'],
    ['stuck_update', 'restart_agent', 'fixed'],
  ])
  assert.deepEqual(planned.map((s) => s.intent), ['repair'])
  assert.deepEqual(ran, [['refresh_marketplace', 'snapshot', 'reinstall_plugin', 'verify_installed']])
  assertDtoShape(backend.progress('chk-1'))
})

// -- the transcript tail and the target, pure ------------------------------------------------------

test('parseTranscriptTail: a real turn after an error ends it (the login works again, the cap lifted)', () => {
  const login = parseTranscriptTail([apiError(T0 - 30 * MIN, 'authentication_failed', 'Not logged in · Please run /login'), assistantTurn(T0 - 10 * MIN)].join('\n'), T0)
  assert.equal(login.error, null)
  assert.equal(login.lastActivityAtMs, T0 - 10 * MIN)
  const still = parseTranscriptTail([assistantTurn(T0 - 40 * MIN), apiError(T0 - 30 * MIN, 'authentication_failed', 'Login expired · Please run /login')].join('\n'), T0)
  assert.deepEqual(still.error, { kind: 'authentication_failed', resetAt: null, atMs: T0 - 30 * MIN })
})

test('parseTranscriptTail: a session cap older than its 5 h window says nothing; a weekly one holds for days', () => {
  const old = parseTranscriptTail(apiError(T0 - 6 * 60 * MIN, 'rate_limit', "You've hit your session limit · resets 4am (Asia/Dubai)"), T0)
  assert.equal(old.error, null)
  const weekly = parseTranscriptTail(apiError(T0 - 3 * 24 * 60 * MIN, 'rate_limit', "You've hit your weekly limit · resets Jul 10 at 10pm (Asia/Dubai)"), T0)
  assert.equal(weekly.error?.kind, 'rate_limit')
  assert.equal(weekly.error?.resetAt, 'Jul 10 at 10pm (Asia/Dubai)')
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
