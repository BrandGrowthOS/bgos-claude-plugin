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

import { freeLimitResult, runWatcher } from '../lib/watcher-core.mjs'
import { checkupTarget, endOldClaudes, isOwnerChannelText, parseTranscriptTail } from '../lib/watcher-checkup.mjs'
import { agentServiceNamesFor, buildLaunchRecipe } from '../lib/agent-inventory.mjs'
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
  // agent per 30 min) holds it. Not fixed yet, with the reason, nothing written (helperwedge finding 2:
  // a held fix is never a result the app reads as healthy).
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
  assert.deepEqual(held.actions.map((a: any) => [a.cause, a.did, a.outcome]), [['wedged_session', 'restart_agent', 'not_fixed']])
  assert.match(held.actions[0].detail, /^Not fixed yet \(restart_rate_limited: /)
  assert.match(held.message, /not fixed yet 1 \(held: restart_rate_limited\)/)
  assert.equal(restartRequested(fs), false, 'restarted once, not twice')
  assert.equal(keepAliveRecord(fs).attempts, 1)
  assertDtoShape([...backend.progress('chk-1'), ...again.progress('chk-2')])
})

test('a wedged session outside the safe window waits with the reason, and nothing is touched', async () => {
  // Outside the safe window for a WEDGE means still making progress (a hook event 2 min ago) or a job
  // under claude: a turn flag alone no longer holds it (helperwedge finding 1).
  for (const [reason, stateOver, extraPs] of [
    ['turn_in_flight', { turnInFlight: true }, ''],
    ['background_job', {}, `\n${psLine(6000, 5912, `/bin/zsh -c source ${HOME}/.claude/shell-snapshots/snapshot-zsh-1.sh && eval 'python monitor.py'`)}`],
  ] as const) {
    const fs = agentFs({ [`${PLUGIN_STATE}/agent-state.json`]: agentState(stateOver) })
    writeTranscript(fs, [assistantTurn(T0 - 20 * MIN), ownerMessage(T0 - 15 * MIN)], T0 - 15 * MIN)
    fs.writeFile(`${HOME}/.bgos-plugin-state/hooks/${SID}/events.jsonl`, '{}\n')
    fs.touch(`${HOME}/.bgos-plugin-state/hooks/${SID}/events.jsonl`, T0 - 2 * MIN)
    const ps = [psLine(1, 0, '/sbin/init'), psLine(3000, 4242, `node ${ROOT}/bin/hoai-core.mjs`), psLine(5912, 3000, `claude --resume ${SID}`), psLine(4912, 5912, `node ${ROOT}/server.ts`)].join('\n') + extraPs
    const backend = fakeBackend(checkupJob())
    const clock = fakeClock()
    const run = rig(fs, backend, clock, ps, { alive: [3000, 5912, 4912, 6000] })
    await runWatcher(run.deps as any)
    const terminal = terminalOf(backend)
    assert.equal(terminal.state, 'done', reason)
    assert.deepEqual(terminal.findings.map((f: any) => f.cause), ['wedged_session'], reason)
    assert.deepEqual(terminal.actions.map((a: any) => [a.cause, a.did, a.outcome]), [['wedged_session', 'restart_agent', 'not_fixed']], reason)
    assert.match(terminal.actions[0].detail, new RegExp(`^Not fixed yet \\(${reason}: `))
    assert.match(terminal.actions[0].detail, /Nothing was restarted/)
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

// -- C9 with usage back: one Enter on the limit screen (Kc 2026-11-01) -----------------------------------

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
const LIMIT_SCREEN = [
  "  ⎿  You've hit your session limit · resets 7:40pm (Asia/Dubai)",
  '',
  '╭──────────────────────────────────────────────────╮',
  '│ What do you want to do?                          │',
  '│                                                  │',
  '│ ❯ 1. Stop and wait for limit to reset            │',
  '│   2. Add funds to continue with usage credits    │',
  '│                                                  │',
  '│ Enter to confirm · Esc to cancel                 │',
  '╰──────────────────────────────────────────────────╯',
].join('\n')
const SOCKET = agentServiceNamesFor('912', HOME, 'linux')!.current.tmuxSocket

/** ps for the live claude and daemon of agent 912, and a fake tmux on its socket whose pane is the limit screen until ONE Enter. */
function limitExec(ps: string) {
  const tmux: string[][] = []
  const state = { entered: 0 }
  const exec = async (file: string, args: string[]) => {
    if (file === 'ps') return { code: 0, stdout: `${ps}\n`, stderr: '', error: null, timedOut: false }
    if (file === 'tmux') {
      tmux.push([...args])
      if (args[1] !== SOCKET) return { code: 1, stdout: '', stderr: 'no server running', error: null, timedOut: false }
      if (args[2] === 'capture-pane') return { code: 0, stdout: state.entered ? '│ > \n' : `${LIMIT_SCREEN}\n`, stderr: '', error: null, timedOut: false }
      if (args[2] === 'send-keys') {
        state.entered += 1
        return { code: 0, stdout: '', stderr: '', error: null, timedOut: false }
      }
    }
    return { code: 1, stdout: '', stderr: '', error: null, timedOut: false }
  }
  return { exec, tmux, state }
}

test('a usage limit with usage back (the login changed after it): the checkup presses ONE Enter on the limit screen, verified by a fresh turn', async () => {
  const fs = agentFs({ [`${PLUGIN_STATE}/agent-state.json`]: agentState() })
  writeTranscript(fs, [assistantTurn(T0 - 40 * MIN), ownerMessage(T0 - 31 * MIN), limitEnvelope(T0 - 30 * MIN, T0 + 3 * 60 * MIN), ownerMessage(T0 - 15 * MIN)], T0 - 15 * MIN)
  // The owner switched the Claude account 10 minutes ago: the credential file moved (its mtime only; never opened).
  fs.writeFile(`${CONFIG}/.credentials.json`, 'NEVER-READ')
  fs.touch(`${CONFIG}/.credentials.json`, T0 - 10 * MIN)
  const ps = [psLine(1, 0, '/sbin/init'), psLine(3000, 4242, `node ${ROOT}/bin/hoai-core.mjs`), psLine(5912, 3000, `claude --resume ${SID}`), psLine(4912, 5912, `node ${ROOT}/server.ts`)].join('\n')
  const fake = limitExec(ps)
  const backend = fakeBackend(checkupJob())
  const clock = fakeClock()
  clock.onSleep((_ms, nowMs) => {
    if (fake.state.entered === 1 && !fs.readFile(TRANSCRIPT)!.includes('"On it."', fs.readFile(TRANSCRIPT)!.indexOf('usage_limit_reached'))) {
      fs.writeFile(TRANSCRIPT, `${fs.readFile(TRANSCRIPT)}${assistantTurn(nowMs)}\n`)
    }
  })
  const run = rig(fs, backend, clock, ps, { alive: [3000, 5912, 4912], exec: fake.exec })
  await runWatcher(run.deps as any)
  const terminal = terminalOf(backend)
  assert.equal(terminal.state, 'done')
  assert.deepEqual(terminal.findings.map((f: any) => [f.cause, f.status]), [['usage_limit', 'WARN']])
  assert.deepEqual(terminal.actions.map((a: any) => [a.cause, a.did, a.outcome]), [['usage_limit', 'free_limit', 'fixed']])
  assert.match(terminal.actions[0].detail, /Enter once/)
  assert.equal(fake.state.entered, 1, 'exactly one Enter')
  for (const args of fake.tmux) {
    const verb = args[2]
    if (verb === 'capture-pane') assert.deepEqual(args, ['-L', SOCKET, 'capture-pane', '-p', '-t', `=${SOCKET}:`])
    else assert.deepEqual(args, ['-L', SOCKET, 'send-keys', '-t', `=${SOCKET}:`, 'Enter'])
  }
  assert.equal(restartRequested(fs), false, 'a usage limit is never restarted')
  assert.deepEqual(run.spawns, [])
  assert.deepEqual(run.kills, [])
  assertDtoShape(backend.progress('chk-1'))
})

test('a usage limit with usage back but a corrupt Enter record: the checkup reads and presses nothing for the hour, and keeps the bad copy', async () => {
  const fs = agentFs({ [`${PLUGIN_STATE}/agent-state.json`]: agentState() })
  writeTranscript(fs, [assistantTurn(T0 - 40 * MIN), ownerMessage(T0 - 31 * MIN), limitEnvelope(T0 - 30 * MIN, T0 + 3 * 60 * MIN), ownerMessage(T0 - 15 * MIN)], T0 - 15 * MIN)
  fs.writeFile(`${CONFIG}/.credentials.json`, 'NEVER-READ')
  fs.touch(`${CONFIG}/.credentials.json`, T0 - 10 * MIN)
  // A torn write: the record may have held an Enter a minute ago, so it counts as one just now.
  const watchFile = `${HOME}/.bgos-agent/watcher/limit-watch.json`
  const torn = '{"schemaVersion":1,"agents":{"912":{"lastEnterAt":"'
  fs.writeFile(watchFile, torn)
  const ps = [psLine(1, 0, '/sbin/init'), psLine(3000, 4242, `node ${ROOT}/bin/hoai-core.mjs`), psLine(5912, 3000, `claude --resume ${SID}`), psLine(4912, 5912, `node ${ROOT}/server.ts`)].join('\n')
  const fake = limitExec(ps)
  const backend = fakeBackend(checkupJob())
  const clock = fakeClock()
  const run = rig(fs, backend, clock, ps, { alive: [3000, 5912, 4912], exec: fake.exec })
  await runWatcher(run.deps as any)
  const terminal = terminalOf(backend)
  assert.equal(terminal.state, 'done')
  assert.deepEqual(terminal.actions.map((a: any) => [a.cause, a.did, a.outcome]), [['usage_limit', 'free_limit', 'skipped']])
  assert.equal(fake.state.entered, 0, 'no Enter on a record that cannot be read')
  assert.deepEqual(fake.tmux, [], 'the screen is not even read')
  assert.equal(fs.readFile(`${watchFile}.lost`), torn, 'the bad copy is kept for a person')
  assert.equal(restartRequested(fs), false)
  assertDtoShape(backend.progress('chk-1'))
})

test('a usage limit still in force: the checkup reports it and never reads or presses the screen', async () => {
  const fs = agentFs({ [`${PLUGIN_STATE}/agent-state.json`]: agentState() })
  writeTranscript(fs, [assistantTurn(T0 - 40 * MIN), limitEnvelope(T0 - 30 * MIN, T0 + 3 * 60 * MIN)], T0 - 30 * MIN)
  // The login did not change since the limit.
  fs.writeFile(`${CONFIG}/.credentials.json`, 'NEVER-READ')
  fs.touch(`${CONFIG}/.credentials.json`, T0 - 5 * 60 * MIN)
  const ps = [psLine(1, 0, '/sbin/init'), psLine(3000, 4242, `node ${ROOT}/bin/hoai-core.mjs`), psLine(5912, 3000, `claude --resume ${SID}`), psLine(4912, 5912, `node ${ROOT}/server.ts`)].join('\n')
  const fake = limitExec(ps)
  const backend = fakeBackend(checkupJob())
  const clock = fakeClock()
  const run = rig(fs, backend, clock, ps, { alive: [3000, 5912, 4912], exec: fake.exec })
  await runWatcher(run.deps as any)
  const terminal = terminalOf(backend)
  assert.deepEqual(terminal.actions.map((a: any) => [a.cause, a.did, a.outcome]), [['usage_limit', 'report', 'not_fixed']])
  assert.deepEqual(fake.tmux, [], 'nothing read, nothing pressed')
  assertDtoShape(backend.progress('chk-1'))
})

test('the checkup words for an Enter not pressed name the real reason, and a still limited one says the watcher waits for the reset', () => {
  const unsaved = freeLimitResult({ outcome: 'not_pressed', reason: 'record_unsaved' })
  assert.match(unsaved.detail, /could not be recorded on disk/)
  assert.doesNotMatch(unsaved.detail, /screen changed/)
  assert.match(freeLimitResult({ outcome: 'not_pressed', reason: 'screen_changed' }).detail, /screen changed before the key/)
  // A helper that timed out may or may not have delivered the key: never claim it was not sent.
  const timedOut = freeLimitResult({ outcome: 'not_pressed', reason: 'helper_timed_out' })
  assert.match(timedOut.detail, /may have reached/)
  assert.doesNotMatch(timedOut.detail, /Did not press|screen changed/)
  // A tmux send-keys that timed out is reported as inject_failed: the key may have gone out too.
  const injectFailed = freeLimitResult({ outcome: 'not_pressed', reason: 'inject_failed' })
  assert.match(injectFailed.detail, /could not be confirmed/)
  assert.doesNotMatch(injectFailed.detail, /Did not press/)
  for (const r of ['record_unsaved', 'screen_changed', 'helper_timed_out', 'inject_failed']) assert.equal(freeLimitResult({ outcome: 'not_pressed', reason: r }).outcome, 'not_fixed')
  const still = freeLimitResult({ outcome: 'still_limited', how: 'login_changed' })
  assert.match(still.detail, /waits for the limit to reset/)
  assert.doesNotMatch(still.detail, /send|another Claude account|sign it in/i)
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

// -- helperwedge: the production test on KC's MacBook (2026-11-12, REPORT-HELPERTESTMAC-1112.md) ------
//
// Findings 1 to 3 of that report, and item 5 (KC, msg 1048 220142: a Restart the owner can always run).

const SPOOL = `${HOME}/.bgos-plugin-state/hooks/${SID}/events.jsonl`
const BUSY_TOKENS = new Set(['turn_in_flight', 'pending_messages', 'background_job', 'recent_activity'])
const HELD_TOKEN = /\(([a-z][a-z0-9_]{0,39}):/

/**
 * Mirror of the backend's readCheckup (BGOS backend src/integrations/helper/helper-state.ts): a
 * finished pass whose open causes are all fixed, or one that holds a step because it SAW the agent
 * at work (a busy token in a skipped action), reads as clean. A clean row loses its break signature,
 * and the app then pops "<name> is running again." (helperLoopModel.ts, note "fixed").
 */
function appSaysRunningAgain(terminal: any): boolean {
  const fixed = new Set(terminal.actions.filter((a: any) => a.outcome === 'fixed').map((a: any) => a.cause))
  const open = terminal.findings.filter((f: any) => !fixed.has(f.cause))
  const holds = terminal.actions.filter((a: any) => a.outcome === 'skipped').map((a: any) => HELD_TOKEN.exec(a.detail)?.[1] ?? null)
  if (holds.some((t: string | null) => t !== null && BUSY_TOKENS.has(t))) return true
  return terminal.state === 'done' && open.length === 0
}

/** Claude Code 2.1.322's queue line for a message it took in, written about 100 ms before its user entry. */
const enqueueLine = (atMs: number, content = `<channel source="bgos" chat_id="c1" message_id="9" sender_type="user">\nare you there?\n</channel>`) =>
  JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: new Date(atMs).toISOString(), sessionId: SID, content })

const PS_912 = [psLine(1, 0, '/sbin/init'), psLine(3000, 4242, `node ${ROOT}/bin/hoai-core.mjs`), psLine(5912, 3000, `claude --resume ${SID}`), psLine(4912, 5912, `node ${ROOT}/server.ts`)].join('\n')

/** Run C of step 4: the owner message is in the transcript, claude froze 0.3 s later, the daemon owes the reply. */
function runCFs(stateOver: Record<string, unknown> = {}) {
  const fs = agentFs({
    [`${PLUGIN_STATE}/agent-state.json`]: agentState({ turnInFlight: true, pendingMessages: 1, activeOperations: 1, lastActivityAt: new Date(T0 - 15 * MIN).toISOString(), ...stateOver }),
  })
  writeTranscript(fs, [assistantTurn(T0 - 16 * MIN), enqueueLine(T0 - 15 * MIN - 100), ownerMessage(T0 - 15 * MIN)], T0 - 15 * MIN)
  fs.writeFile(SPOOL, '{"hook_event_name":"UserPromptSubmit"}\n')
  fs.touch(SPOOL, T0 - 15 * MIN)
  fs.writeFile(`${PLUGIN_STATE}/channel-beacon.json`, '{}')
  fs.touch(`${PLUGIN_STATE}/channel-beacon.json`, T0 - 5_000)
  return fs
}

/** pidAlive over a set the test controls; the launcher hook ends claude once it sees the restart marker. */
function liveSet(fs: MemoryFs, clock: ReturnType<typeof fakeClock>, opts: { launcherEndsClaude: boolean }) {
  const live = new Set([4242, 3000, 5912, 4912])
  clock.onSleep(() => {
    if (opts.launcherEndsClaude && fs.files.has(`${STATE_DIR}/restart-requested.json`)) {
      live.delete(5912)
      live.delete(4912)
    }
  })
  return live
}

test('finding 1 (run C): a wedged session is restarted in the same conversation, never held for turn_in_flight', async () => {
  const fs = runCFs()
  const backend = fakeBackend(checkupJob())
  const clock = fakeClock()
  const live = liveSet(fs, clock, { launcherEndsClaude: true })
  daemonAnswersProbe(fs, clock)
  const run = rig(fs, backend, clock, PS_912, { pidAlive: (pid: number) => live.has(pid) })
  await runWatcher(run.deps as any)

  const terminal = terminalOf(backend)
  assert.equal(terminal.state, 'done')
  assert.deepEqual(terminal.findings.map((f: any) => f.cause), ['wedged_session'])
  assert.deepEqual(terminal.actions.map((a: any) => [a.cause, a.did, a.outcome]), [['wedged_session', 'restart_agent', 'fixed']])
  // The launcher's marker: it relaunches claude RESUMING the agent's pinned session.
  assert.equal(restartRequested(fs), true)
  assert.equal(fs.readFile(`${STATE_DIR}/session-id`)?.trim(), SID)
  // A stopped claude never acts on the launcher's SIGTERM: it is woken first. Only its claude.
  assert.deepEqual(run.kills, [[5912, 'SIGCONT']])
  assert.equal(appSaysRunningAgain(terminal), true, 'fixed and verified: running again is the truth here')
  assertDtoShape(backend.progress('chk-1'))
})

test('finding 1: a wedged claude that does not end for the launcher is ended (SIGKILL), and only that claude', async () => {
  const fs = runCFs()
  const backend = fakeBackend(checkupJob())
  const clock = fakeClock()
  const live = liveSet(fs, clock, { launcherEndsClaude: false })
  // The relaunched session answers the probe once the old claude is gone.
  clock.onSleep((_ms, nowMs) => {
    if (!live.has(5912) && fs.files.has(`${STATE_DIR}/probe-requested.json`)) {
      fs.writeFile(`${PLUGIN_STATE}/channel-live.json`, JSON.stringify({ firstLiveAt: 'x', lastLiveAt: new Date(nowMs).toISOString() }))
    }
  })
  const run = rig(fs, backend, clock, PS_912, {
    pidAlive: (pid: number) => live.has(pid),
    kill: (pid: number, signal: string) => {
      run.kills.push([pid, signal])
      if (signal === 'SIGKILL') live.delete(pid)
    },
  })
  await runWatcher(run.deps as any)
  const terminal = terminalOf(backend)
  assert.deepEqual(terminal.actions.map((a: any) => [a.cause, a.did, a.outcome]), [['wedged_session', 'restart_agent', 'fixed']])
  assert.deepEqual(run.kills, [
    [5912, 'SIGCONT'],
    [5912, 'SIGCONT'],
    [5912, 'SIGKILL'],
  ])
})

test('finding 1: a turn that is still making progress keeps the hold', async () => {
  const fs = runCFs()
  fs.touch(SPOOL, T0 - 2 * MIN) // a hook event 2 minutes ago: a subagent or a tool is working
  const backend = fakeBackend(checkupJob())
  const clock = fakeClock()
  const run = rig(fs, backend, clock, PS_912, { alive: [3000, 5912, 4912] })
  await runWatcher(run.deps as any)
  const terminal = terminalOf(backend)
  assert.deepEqual(terminal.findings.map((f: any) => f.cause), ['wedged_session'])
  assert.equal(restartRequested(fs), false)
  assert.deepEqual(run.kills, [])
  assert.match(terminal.actions[0].detail, /turn_in_flight/)
})

test('finding 2: a held check up reports "not fixed yet", never a result the app reads as running again', async () => {
  const cases: Array<[string, () => { fs: MemoryFs; ps: string; alive: number[] }]> = [
    [
      'a wedge whose turn still makes progress',
      () => {
        const fs = runCFs()
        fs.touch(SPOOL, T0 - 2 * MIN)
        return { fs, ps: PS_912, alive: [3000, 5912, 4912] }
      },
    ],
    [
      'a wedge with a job under claude',
      () => ({
        fs: runCFs(),
        ps: `${PS_912}\n${psLine(6000, 5912, `/bin/zsh -c source ${HOME}/.claude/shell-snapshots/snapshot-zsh-1.sh && eval 'npm test'`)}`,
        alive: [3000, 5912, 4912, 6000],
      }),
    ],
    [
      'a dead connector under a session that was active minutes ago',
      () => {
        const fs = agentFs()
        writeTranscript(fs, [assistantTurn(T0 - 5 * MIN)], T0 - 5 * MIN)
        const ps = [psLine(1, 0, '/sbin/init'), psLine(3000, 4242, `node ${ROOT}/bin/hoai-core.mjs`), psLine(5912, 3000, `claude --resume ${SID}`)].join('\n')
        return { fs, ps, alive: [3000, 5912] }
      },
    ],
  ]
  for (const [name, make] of cases) {
    const { fs, ps, alive } = make()
    const backend = fakeBackend(checkupJob())
    const run = rig(fs, backend, fakeClock(), ps, { alive })
    await runWatcher(run.deps as any)
    const terminal = terminalOf(backend)
    assert.equal(terminal.findings.length, 1, name)
    const [held] = terminal.actions
    assert.equal(held.outcome, 'not_fixed', `${name}: ${held.outcome}`)
    assert.match(held.detail, /^Not fixed yet/, name)
    assert.equal(appSaysRunningAgain(terminal), false, `${name}: the app would pop "running again"`)
    assert.match(terminal.message, /not fixed yet 1/, name)
    assert.equal(restartRequested(fs), false, name)
    assertDtoShape(backend.progress('chk-1'))
  }
})

test('finding 2: a hold the app shows as the owner step or as restarts used up stays a skipped step', async () => {
  // pending_permission is the owner's question (the app shows it); attempts_exhausted offers "Restart once more".
  for (const [reason, stateOver, attempts] of [
    ['pending_permission', { pendingPermissions: 1 }, 0],
    ['attempts_exhausted', {}, 3],
  ] as const) {
    const fs = runCFs(stateOver)
    if (attempts) {
      fs.writeFile(KEEPALIVE_STATE, JSON.stringify({ schemaVersion: 1, agents: { '912': { target: 'checkup', attempts, lastRestartAt: new Date(T0 - 60 * MIN).toISOString() } } }))
    }
    const backend = fakeBackend(checkupJob())
    const run = rig(fs, backend, fakeClock(), PS_912, { alive: [3000, 5912, 4912] })
    await runWatcher(run.deps as any)
    const terminal = terminalOf(backend)
    assert.deepEqual(terminal.actions.map((a: any) => [a.did, a.outcome]), [['restart_agent', 'skipped']], reason)
    assert.equal(HELD_TOKEN.exec(terminal.actions[0].detail)?.[1], reason)
    assert.equal(appSaysRunningAgain(terminal), false, reason)
    assert.match(terminal.message, /not fixed yet 1/, reason)
  }
})

test('finding 3: a message Claude Code queued (enqueue) but never turned into a user entry is a delivery', async () => {
  // The hang between the queue line and the turn: no user entry, no turn flag, the reply owed.
  const fs = agentFs({ [`${PLUGIN_STATE}/agent-state.json`]: agentState({ pendingMessages: 1, lastActivityAt: new Date(T0 - 15 * MIN).toISOString() }) })
  writeTranscript(fs, [assistantTurn(T0 - 20 * MIN), enqueueLine(T0 - 15 * MIN)], T0 - 15 * MIN)
  fs.writeFile(SPOOL, '{"hook_event_name":"Stop"}\n')
  fs.touch(SPOOL, T0 - 20 * MIN)
  const backend = fakeBackend(checkupJob())
  const clock = fakeClock()
  const live = liveSet(fs, clock, { launcherEndsClaude: true })
  daemonAnswersProbe(fs, clock)
  const run = rig(fs, backend, clock, PS_912, { pidAlive: (pid: number) => live.has(pid) })
  await runWatcher(run.deps as any)
  const terminal = terminalOf(backend)
  assert.deepEqual(terminal.findings.map((f: any) => [f.cause, f.detail]), [['wedged_session', 'no reply to a message delivered 15 min ago']])
  assert.deepEqual(terminal.actions.map((a: any) => [a.cause, a.did, a.outcome]), [['wedged_session', 'restart_agent', 'fixed']])
})

test('finding 3: stop then send (claude frozen before the message): the daemon says what it owes since when', async () => {
  // Nothing in the transcript after the last turn: the frozen claude wrote neither line. The daemon
  // pushed the owner message 15 min ago and still owes the reply.
  const fs = agentFs({
    [`${PLUGIN_STATE}/agent-state.json`]: agentState({ pendingMessages: 1, lastActivityAt: new Date(T0 - 15 * MIN).toISOString(), ownerWaitingSince: new Date(T0 - 15 * MIN).toISOString() }),
  })
  writeTranscript(fs, [assistantTurn(T0 - 20 * MIN)], T0 - 20 * MIN)
  // The previous turn's Stop hook: the spool was read, and the session did nothing since (review F1).
  fs.writeFile(SPOOL, '{"hook_event_name":"Stop"}\n')
  fs.touch(SPOOL, T0 - 20 * MIN)
  const backend = fakeBackend(checkupJob())
  const clock = fakeClock()
  const live = liveSet(fs, clock, { launcherEndsClaude: true })
  daemonAnswersProbe(fs, clock)
  const run = rig(fs, backend, clock, PS_912, { pidAlive: (pid: number) => live.has(pid) })
  await runWatcher(run.deps as any)
  const terminal = terminalOf(backend)
  assert.deepEqual(terminal.findings.map((f: any) => f.cause), ['wedged_session'])
  assert.deepEqual(terminal.actions.map((a: any) => [a.did, a.outcome]), [['restart_agent', 'fixed']])
})

test('finding 3: parseTranscriptTail reads an owner enqueue as a delivery, and nothing else from the queue', () => {
  const owner = enqueueLine(T0 - 10 * MIN)
  assert.equal(parseTranscriptTail(owner, T0).ownerDeliveredAtMs, T0 - 10 * MIN)
  for (const line of [
    enqueueLine(T0 - 10 * MIN, '<task-notification>\n<task-id>x</task-id>\n</task-notification>'),
    enqueueLine(T0 - 10 * MIN, `<channel source="bgos" chat_id="c1" event_type="reaction">x</channel>`),
    enqueueLine(T0 - 10 * MIN, `<channel source="bgos" chat_id="c1" sender_type="agent">x</channel>`),
    JSON.stringify({ type: 'queue-operation', operation: 'dequeue', timestamp: new Date(T0 - 10 * MIN).toISOString(), sessionId: SID }),
    JSON.stringify({ type: 'queue-operation', operation: 'remove', timestamp: new Date(T0 - 10 * MIN).toISOString(), sessionId: SID, content: `<channel source="bgos" chat_id="c1" sender_type="user">x</channel>` }),
  ]) {
    assert.equal(parseTranscriptTail(line, T0).ownerDeliveredAtMs, null, line.slice(0, 120))
  }
  // A queue line is never model activity.
  assert.equal(parseTranscriptTail(owner, T0).lastActivityAtMs, null)
})

// -- item 5: the owner's Restart, which the Helper always carries out ---------------------------------

function ownerRestartJob(rpcId = 'rst-1', body: Record<string, unknown> = {}) {
  return {
    frames: [{ rpcId, op: 'restart_agent' }],
    jobs: { [rpcId]: { rpcId, op: 'restart_agent', intent: 'restart_agent', machineId: MACHINE_ID, requestedBy: 'owner', targets: [{ pairingId: 3, assistantId: 912 }], ...body } },
  }
}

test('item 5: the owner Restart restarts an agent that looks healthy and busy: no health gate, no turn hold, same conversation', async () => {
  // Busy by every signal: a turn in flight, a reply owed, activity a minute ago, a job under claude.
  const fs = agentFs({ [`${PLUGIN_STATE}/agent-state.json`]: agentState({ turnInFlight: true, pendingMessages: 1, lastActivityAt: new Date(T0 - MIN).toISOString() }) })
  writeTranscript(fs, [ownerMessage(T0 - 2 * MIN), assistantTurn(T0 - MIN)], T0 - MIN)
  const ps = `${PS_912}\n${psLine(6000, 5912, `/bin/zsh -c source ${HOME}/.claude/shell-snapshots/snapshot-zsh-1.sh && eval 'npm run dev'`)}`
  const backend = fakeBackend(ownerRestartJob())
  const clock = fakeClock()
  const live = liveSet(fs, clock, { launcherEndsClaude: true })
  daemonAnswersProbe(fs, clock)
  let planned = false
  const run = rig(fs, backend, clock, ps, { pidAlive: (pid: number) => live.has(pid), modules: stubModules({ onPlan: () => (planned = true) }) })
  await runWatcher(run.deps as any)

  const terminal = terminalOf(backend, 'rst-1')
  assert.equal(terminal.state, 'done', JSON.stringify(terminal))
  assert.deepEqual(terminal.steps.map((s: any) => `${s.kind}:${s.state}`), ['observe:ok', 'restart_agent:ok', 'verify_agent:ok'])
  assert.match(terminal.message, /^restarted 912/)
  assert.equal(restartRequested(fs), true, 'through the launcher, which resumes the pinned session')
  assert.deepEqual(run.kills, [[5912, 'SIGCONT']])
  assert.equal(planned, false, 'never the reconcile planner')
  // Not a Helper restart: the budget the sweep and the check up share is not spent, but the sweep
  // sees the restart so it does not add its own on top.
  const record = keepAliveRecord(fs)
  assert.equal(record.attempts ?? 0, 0)
  assert.equal(record.lastRestartAt, new Date(T0).toISOString())
  assert.equal(record.reason, 'owner_restart')
  assertDtoShape(backend.progress('rst-1'))
})

test('item 5: only an owner job, for exactly one agent on this computer; anything else is refused and touches nothing', async () => {
  const rows: Array<[string, Record<string, unknown>]> = [
    ['restart_needs_owner', { requestedBy: undefined }],
    ['restart_needs_owner', { requestedBy: 'helper' }],
    ['restart_needs_one_agent:0', { targets: [] }],
    ['restart_needs_one_agent:2', { targets: [{ assistantId: 912 }, { assistantId: 913 }] }],
    ['agent_not_on_this_machine:999', { targets: [{ assistantId: 999 }] }],
  ]
  for (const [message, body] of rows) {
    const fs = agentFs({ [`${PLUGIN_STATE}/agent-state.json`]: agentState() })
    const backend = fakeBackend(ownerRestartJob('rst-1', body))
    const run = rig(fs, backend, fakeClock(), PS_912, { alive: [3000, 5912, 4912] })
    await runWatcher(run.deps as any)
    const terminal = terminalOf(backend, 'rst-1')
    assert.equal(terminal.state, 'failed', message)
    assert.equal(terminal.message, message)
    assert.equal(restartRequested(fs), false, message)
    assert.deepEqual(run.kills, [], message)
    assert.deepEqual(run.spawns, [], message)
  }
})

test('item 5: a reconcile frame carrying the restart intent is the owner Restart too, never a reconcile of the computer', async () => {
  const fs = agentFs({ [`${PLUGIN_STATE}/agent-state.json`]: agentState() })
  const backend = fakeBackend({ frames: [{ rpcId: 'rst-1', op: 'reconcile' }], jobs: { 'rst-1': { rpcId: 'rst-1', op: 'reconcile', intent: 'restart_agent', targets: [{ assistantId: 912 }] } } })
  let planned = false
  const run = rig(fs, backend, fakeClock(), PS_912, { alive: [3000, 5912, 4912], modules: stubModules({ onPlan: () => (planned = true) }) })
  await runWatcher(run.deps as any)
  assert.equal(terminalOf(backend, 'rst-1').message, 'restart_needs_owner')
  assert.equal(planned, false)
})

test('item 5: a frozen claude is woken and ended, and when the launcher does not bring it back the agent is started again', async () => {
  // The launcher has used its 3 relaunches this hour and ignores the marker: claude stays frozen.
  const fs = agentFs({ [`${PLUGIN_STATE}/agent-state.json`]: agentState({ turnInFlight: true, pendingMessages: 1 }) })
  writeTranscript(fs, [assistantTurn(T0 - 30 * MIN), ownerMessage(T0 - 20 * MIN)], T0 - 20 * MIN)
  const clock = fakeClock()
  const live = new Set([4242, 3000, 5912, 4912])
  let ps = PS_912
  const backend = fakeBackend(ownerRestartJob())
  const run = rig(fs, backend, clock, ps, {
    pidAlive: (pid: number) => live.has(pid),
    exec: async (file: string, args: string[]) => {
      if (file === 'ps') return { code: 0, stdout: `${ps}\n`, stderr: '', error: null, timedOut: false }
      return { code: 1, stdout: '', stderr: '', error: null, timedOut: false }
    },
    kill: (pid: number, signal: string) => {
      run.kills.push([pid, signal])
      if (signal === 'SIGKILL' && pid === 5912) {
        // claude ends; its daemon with it; the launcher sees a plain exit and stops supervising.
        for (const gone of [5912, 4912, 3000, 4242]) live.delete(gone)
        ps = psLine(1, 0, '/sbin/init')
        fs.rm(`${STATE_DIR}/restart-requested.json`)
      }
    },
  })
  // Only a session started by the second step answers the probe.
  clock.onSleep((_ms, nowMs) => {
    if (run.spawns.length > 0 && fs.files.has(`${STATE_DIR}/probe-requested.json`)) {
      fs.writeFile(`${PLUGIN_STATE}/channel-live.json`, JSON.stringify({ firstLiveAt: 'x', lastLiveAt: new Date(nowMs).toISOString() }))
    }
  })
  await runWatcher(run.deps as any)
  const terminal = terminalOf(backend, 'rst-1')
  assert.equal(terminal.state, 'done', JSON.stringify(terminal))
  assert.deepEqual(terminal.steps.map((s: any) => `${s.kind}:${s.state}`), ['observe:ok', 'restart_agent:ok', 'verify_agent:skipped', 'start_agent:ok', 'verify_agent:ok'])
  assert.deepEqual(run.kills, [
    [5912, 'SIGCONT'],
    [5912, 'SIGCONT'],
    [5912, 'SIGKILL'],
  ])
  // Started hidden from its recipe: hoai-core in the agent's folder, which resumes its pinned session.
  assert.equal(run.spawns.length, 1)
  assert.equal(run.spawns[0]!.file, 'tmux')
  assert.ok(run.spawns[0]!.args.join(' ').includes(`${ROOT}/bin/hoai-core.mjs`))
  assert.ok(run.spawns[0]!.args.includes(AVA))
  assertDtoShape(backend.progress('rst-1'))
})

test('item 5: an agent that does not come back is reported failed, by name, inside the deadline', async () => {
  const fs = agentFs({ [`${PLUGIN_STATE}/agent-state.json`]: agentState() })
  writeTranscript(fs, [assistantTurn(T0 - 30 * MIN)], T0 - 30 * MIN)
  const backend = fakeBackend(ownerRestartJob())
  const clock = fakeClock()
  const live = liveSet(fs, clock, { launcherEndsClaude: true })
  const run = rig(fs, backend, clock, PS_912, { pidAlive: (pid: number) => live.has(pid) })
  await runWatcher(run.deps as any)
  const terminal = terminalOf(backend, 'rst-1')
  assert.equal(terminal.state, 'failed')
  assert.match(terminal.message, /^not back: /)
  assert.ok(clock.now() - T0 <= 180_000, `took ${clock.now() - T0} ms`)
  assertDtoShape(backend.progress('rst-1'))
})

test('item 5: a restart nothing here can carry out leaves the session as it was and says so (never killed with nothing to start it)', async () => {
  // No launcher, no service, no recipe: the restart ladder has no authority for this agent.
  const fs = agentFs({ [`${PLUGIN_STATE}/agent-state.json`]: agentState() })
  fs.rm(`${STATE_DIR}/launch.json`)
  fs.rm(`${STATE_DIR}/supervisor.json`)
  const backend = fakeBackend(ownerRestartJob())
  const run = rig(fs, backend, fakeClock(), PS_912, { alive: [3000, 5912, 4912] })
  await runWatcher(run.deps as any)
  const terminal = terminalOf(backend, 'rst-1')
  assert.equal(terminal.state, 'failed')
  assert.match(terminal.message, /^not back: the restart failed \(manual_restart_required/)
  assert.deepEqual(run.kills, [[5912, 'SIGCONT']], 'woken, never ended')
  assert.deepEqual(run.spawns, [])
  assertDtoShape(backend.progress('rst-1'))
})

test('review F1: an owed reply with no readable transcript or spool is never a wedge restart (scenario A, the real job)', async () => {
  // The daemon owes the owner since 25 min ago; the watcher finds no transcript and no hook spool.
  const fs = agentFs({
    [`${PLUGIN_STATE}/agent-state.json`]: agentState({ turnInFlight: true, pendingMessages: 1, lastActivityAt: new Date(T0 - 25 * MIN).toISOString(), ownerWaitingSince: new Date(T0 - 25 * MIN).toISOString() }),
  })
  const backend = fakeBackend(checkupJob())
  const run = rig(fs, backend, fakeClock(), PS_912, { alive: [3000, 5912, 4912] })
  await runWatcher(run.deps as any)
  const terminal = terminalOf(backend)
  assert.equal(restartRequested(fs), false, 'a working turn is never restarted on missing evidence')
  assert.deepEqual(run.kills, [])
  assert.deepEqual(terminal.actions.map((a: any) => [a.did, a.outcome]), [['restart_agent', 'not_fixed']])
  assert.match(terminal.actions[0].detail, /^Not fixed yet \(turn_in_flight: /)
})

// -- REVIEW-0432 F2: the guards on SIGKILL and on a second start, pinned ------------------------------

test('review F2 (M8): SIGKILL only reaches the SAME claude: a reused pid or a changed command line is left alone', async () => {
  const old = { pid: 5912, command: `claude --resume ${SID}`, startedAtMs: T0 - 60 * MIN }
  const run = async (row: Record<string, unknown> | null) => {
    const kills: Array<[number, string]> = []
    const clock = fakeClock()
    const out = await endOldClaudes({
      claudes: [old],
      kill: (pid: number, signal: string) => void kills.push([pid, signal]),
      pidAlive: () => true,
      sleep: clock.sleep,
      now: clock.now,
      relist: async () => (row ? [row as any] : []),
      id: '912',
      platform: 'linux',
    })
    return { kills, out }
  }
  const reused = await run({ pid: 5912, command: old.command, startedAtMs: T0 })
  assert.deepEqual(reused.kills, [], 'a later start is another process on a reused pid')
  const changed = await run({ pid: 5912, command: '/usr/bin/vim notes.md', startedAtMs: old.startedAtMs })
  assert.deepEqual(changed.kills, [], 'another program on that pid')
  assert.deepEqual((await run(null)).kills, [], 'gone from the listing')
  const same = await run({ ...old })
  assert.deepEqual(same.kills, [[5912, 'SIGCONT'], [5912, 'SIGKILL']])
})

test('review F2 (M10): a claude tied to the folder only by a cwd lookup (a person\'s own session) is never signalled', async () => {
  // A hand-run `claude` in the agent's folder, no pin on its command line, no state naming it. An
  // owner message 40 min ago is unanswered, so the check up restarts the agent; it must not touch 6100.
  const fs = agentFs()
  writeTranscript(fs, [assistantTurn(T0 - 45 * MIN), ownerMessage(T0 - 40 * MIN)], T0 - 40 * MIN)
  const ps = [psLine(1, 0, '/sbin/init'), psLine(3000, 4242, `node ${ROOT}/bin/hoai-core.mjs`), psLine(6100, 900, 'claude')].join('\n')
  const backend = fakeBackend(checkupJob())
  const clock = fakeClock()
  const run = rig(fs, backend, clock, ps, {
    alive: [3000, 6100],
    exec: async (file: string, args: string[]) => {
      if (file === 'ps') return { code: 0, stdout: `${ps}\n`, stderr: '', error: null, timedOut: false }
      if (file === 'readlink' && args[0] === '/proc/6100/cwd') return { code: 0, stdout: `${AVA}\n`, stderr: '', error: null, timedOut: false }
      return { code: 1, stdout: '', stderr: '', error: null, timedOut: false }
    },
  })
  await runWatcher(run.deps as any)
  const terminal = terminalOf(backend)
  assert.deepEqual(terminal.findings.map((f: any) => f.cause), ['daemon_down', 'wedged_session'], JSON.stringify(terminal.findings))
  assert.equal(restartRequested(fs), true, 'the agent itself is restarted through its launcher')
  assert.deepEqual(run.kills, [], 'the cwd-only claude is never woken or killed')
})

/** Owner Restart where claude ends at its SIGKILL, the launcher stands down, and `after` says what is left. */
async function ownerRestartWhenLeft(after: { daemonLives: boolean; psReadable: boolean }) {
  const fs = agentFs({ [`${PLUGIN_STATE}/agent-state.json`]: agentState({ turnInFlight: true }) })
  writeTranscript(fs, [assistantTurn(T0 - 30 * MIN)], T0 - 30 * MIN)
  const clock = fakeClock()
  const live = new Set([4242, 3000, 5912, 4912])
  let ps = PS_912
  let psOk = true
  const backend = fakeBackend(ownerRestartJob())
  const run = rig(fs, backend, clock, ps, {
    pidAlive: (pid: number) => live.has(pid),
    exec: async (file: string) => {
      if (file === 'ps') return psOk ? { code: 0, stdout: `${ps}\n`, stderr: '', error: null, timedOut: false } : { code: 1, stdout: '', stderr: 'ps: busy', error: null, timedOut: false }
      return { code: 1, stdout: '', stderr: '', error: null, timedOut: false }
    },
    kill: (pid: number, signal: string) => {
      run.kills.push([pid, signal])
      if (signal === 'SIGKILL' && pid === 5912) {
        for (const gone of [5912, 3000, 4242]) live.delete(gone)
        fs.rm(`${STATE_DIR}/restart-requested.json`)
        if (after.daemonLives) {
          // The daemon outlived its claude (orphaned under init) and keeps its fresh state.
          ps = [psLine(1, 0, '/sbin/init'), psLine(4912, 1, `node ${ROOT}/server.ts`)].join('\n')
          clock.onSleep((_ms, nowMs) => fs.writeFile(`${PLUGIN_STATE}/agent-state.json`, agentState({ updatedAt: new Date(nowMs - 1_000).toISOString() })))
        } else {
          live.delete(4912)
          ps = psLine(1, 0, '/sbin/init')
        }
        if (!after.psReadable) psOk = false
      }
    },
  })
  await runWatcher(run.deps as any)
  return { terminal: terminalOf(backend, 'rst-1'), run }
}

test('review F2 (M15): the owner Restart never starts a second session beside a live daemon', async () => {
  const { terminal, run } = await ownerRestartWhenLeft({ daemonLives: true, psReadable: true })
  assert.equal(terminal.state, 'failed')
  assert.match(terminal.message, /^not back: /)
  assert.deepEqual(run.spawns, [], 'no start beside the live daemon')
})

test('review F2 (M15): the owner Restart never starts a session on a process table it could not read', async () => {
  const { terminal, run } = await ownerRestartWhenLeft({ daemonLives: false, psReadable: false })
  assert.equal(terminal.state, 'failed')
  assert.deepEqual(run.spawns, [], 'unknown is not down')
})

test('review F2 (M18/M19): ownerWaitingSince from a stale state is no delivery', async () => {
  // The state is 10 minutes old (its daemon gone): what it said it owed proves nothing now.
  const fs = agentFs({
    [`${PLUGIN_STATE}/agent-state.json`]: agentState({ pendingMessages: 1, updatedAt: new Date(T0 - 10 * MIN).toISOString(), ownerWaitingSince: new Date(T0 - 15 * MIN).toISOString() }),
  })
  writeTranscript(fs, [assistantTurn(T0 - 20 * MIN)], T0 - 20 * MIN)
  const backend = fakeBackend(checkupJob())
  const run = rig(fs, backend, fakeClock(), PS_912, { alive: [3000, 5912] })
  await runWatcher(run.deps as any)
  const terminal = terminalOf(backend)
  assert.equal(terminal.findings.some((f: any) => f.cause === 'wedged_session'), false, JSON.stringify(terminal.findings))
})

test('review F2 (M20): a fix held by the pass deadline is "Not fixed yet", never a skipped step', async () => {
  const fs = runCFs()
  const backend = fakeBackend(checkupJob())
  const run = rig(fs, backend, fakeClock(), PS_912, { alive: [3000, 5912, 4912], checkupDeadlineMs: 10_000 })
  await runWatcher(run.deps as any)
  const terminal = terminalOf(backend)
  assert.deepEqual(terminal.actions.map((a: any) => [a.cause, a.did, a.outcome]), [['wedged_session', 'restart_agent', 'not_fixed']])
  assert.match(terminal.actions[0].detail, /^Not fixed yet \(pass_deadline: /)
  assert.match(terminal.message, /not fixed yet 1 \(held: pass_deadline\)/)
  assert.equal(restartRequested(fs), false)
})
