/**
 * lib/watcher-core.mjs: the per-machine watcher loop, unit tier. An
 * in-process fake fetch records every request; the lifecycle modules
 * (planner / executor / plugin-cli / diagnostics) are injected as small
 * design-contract stubs so this file pins the WATCHER's wiring: the REST
 * paths and bodies, the ack -> job -> progress -> terminal sequence, the
 * heartbeat shape, backoff, single-flight, the executor deps it hands over
 * (restart via the real lib/agent-restart, verify via the real
 * lib/agent-verify, stagger, deadline), rollback and diagnostics on failure,
 * create_agent's five steps, the self-refresh swap + exit code, and that no
 * request body or log line ever carries the pairing token, a pair code, the
 * home path or the username. The real planner + executor are exercised in
 * test/hoai-watcher.test.ts (sandbox e2e).
 *
 * Run: npx tsx --test test/watcher-core.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  BACKOFF_MAX_MS,
  BACKOFF_MIN_MS,
  EXIT_NO_CREDENTIALS,
  EXIT_SELF_REFRESH,
  StepLedger,
  autoUpdateEnabledFrom,
  buildRpcClient,
  jobFolderName,
  nextBackoff,
  normalizeApiBase,
  readRollbackLatch,
  refreshWatcherIfStale,
  runWatcher,
  scrubLine,
} from '../lib/watcher-core.mjs'
import { WATCHER_BUNDLE_FILES, bundleFingerprint } from '../lib/watcher-bundle.mjs'
import { buildLaunchRecipe } from '../lib/agent-inventory.mjs'
import { supervisorFileBody } from '../bin/hoai-core.mjs'
import { memoryFs, type MemoryFs } from './helpers/memory-fs.ts'

const HOME = '/home/kc'
const USER = 'kc'
const TOKEN = 'bgp_' + 'S3cretPairingTokenValue0123456789'
const PAIR_CODE = 'BGOS-7F3A-2K9Q'
const CONFIG = '/home/kc/.claude'
const ROOT = `${CONFIG}/plugins/cache/hoai/hoai/0.38.3`
const NEW_ROOT = `${CONFIG}/plugins/cache/hoai/hoai/0.38.4`
const T0 = Date.parse('2026-08-25T12:00:00.000Z')
const MACHINE_ID = '0f3b3c1e-7d3a-4d0c-9a4c-1f2e3d4c5b6a'

// -- helpers ---------------------------------------------------------------------------

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

type Call = { method: string; path: string; body: any; headers: Record<string, string> }

/** An in-process fake backend: records every call; serves one batch of frames, then none. */
function fakeBackend(opts: { frames?: any[]; jobs?: Record<string, any>; failPending?: boolean; status?: number } = {}) {
  const calls: Call[] = []
  let served = false
  const respond = (status: number, json: any) => ({ ok: status < 400, status, text: async () => JSON.stringify(json) })
  const fetch = async (url: string, init: any) => {
    const u = new URL(url)
    const path = u.pathname + u.search
    const body = init?.body ? JSON.parse(init.body) : undefined
    calls.push({ method: init?.method ?? 'GET', path, body, headers: init?.headers ?? {} })
    if (opts.failPending && path.includes('/machine-rpc/pending')) throw new Error('ECONNREFUSED 127.0.0.1:1')
    if (opts.status && opts.status >= 400) return respond(opts.status, { error: 'nope' })
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

/** A machine with two paired agents: 912 launcher-live (recipe), 7 recipe-only. */
function machineFs(extra: Record<string, string> = {}): MemoryFs {
  const recipe = (id: string, cwd: string) =>
    JSON.stringify(buildLaunchRecipe({ assistantId: id, cwd, argv: ['--x'], installMethod: 'marketplace', pluginRoot: ROOT, node: '/usr/bin/node', startedAt: 'x', pid: 1 }))
  const fs = memoryFs(
    {
      [`${HOME}/.bgos-agent/watcher/credentials.json`]: JSON.stringify({ pairingId: 77, token: TOKEN, backendUrl: 'https://api.example.test', machineId: MACHINE_ID }),
      [`${HOME}/.bgos-agent/credentials-912.json`]: JSON.stringify({ pairingToken: 'agent-secret-912', backendUrl: 'x' }),
      [`${HOME}/.bgos-agent/credentials-7.json`]: JSON.stringify({ pairingToken: 'agent-secret-7', backendUrl: 'x' }),
      [`${HOME}/.bgos-agent/912/launch.json`]: recipe('912', `${HOME}/hoai-agents/ava`),
      [`${HOME}/.bgos-agent/912/supervisor.json`]: supervisorFileBody(4242, 'x'),
      [`${HOME}/hoai-agents/ava/.bgos-agent-id`]: '912\n',
      [`${HOME}/.bgos-agent/7/launch.json`]: recipe('7', `${HOME}/hoai-agents/old`),
      [`${HOME}/hoai-agents/old/.bgos-agent-id`]: '7\n',
      ...extra,
    },
    [`${HOME}/hoai-agents/ava`, `${HOME}/hoai-agents/old`],
  )
  return fs
}

function manifestFor(fs: MemoryFs, root = ROOT, fingerprint?: string) {
  fs.writeFile(
    `${HOME}/.bgos-agent/watcher/manifest.json`,
    JSON.stringify({ version: '0.38.3', fingerprint: fingerprint ?? bundleFingerprint(root, fs), installedAt: 'x', pluginRoot: root, files: [] }),
  )
}

/** Design-contract stubs for the lifecycle modules. The executor stub walks
 *  the plan, reports running/ok per step, restarts through deps with the
 *  stagger, verifies, and rolls back on a verify failure. */
function stubModules(opts: { plan?: (state: any) => any; observe?: () => any; execute?: any; onCli?: (args: string[]) => void } = {}) {
  const observed = () => ({
    marketplaceRegistered: true,
    marketplaceInstallLocation: null,
    marketplaceLatest: { version: '0.38.4', ref: 'v0.38.4' },
    installed: { present: true, version: '0.38.3', installPath: ROOT },
    enabled: true,
  })
  const contractExecutor = async (plan: any, deps: any, report: any) => {
    const steps: any[] = []
    let restarts = 0
    let failedStep: any = null
    let rolledBack = false
    const restartedAt = new Map<string, number>()
    for (const step of plan.steps) {
      if (failedStep) {
        steps.push({ ...step, state: 'skipped', message: 'rolled_back' })
        continue
      }
      await report(step.id, { state: 'running' })
      let state = 'ok'
      let message = step.kind
      if (step.kind === 'restart_agent') {
        if (restarts > 0) await deps.sleep(deps.staggerMs)
        restarts += 1
        const at = deps.now()
        restartedAt.set(step.target, at)
        const out = await deps.restartAgent({ assistantId: step.target, cwd: null }, { via: step.via ?? null, restartedAtMs: at })
        state = out.ok ? 'ok' : 'failed'
        message = out.ok ? `restarted;how:${out.how}` : `restart_failed:${out.message}`
      } else if (step.kind === 'verify_agent') {
        const out = await deps.verifyAgent({ assistantId: step.target, cwd: null }, { restartedAtMs: restartedAt.get(step.target) ?? deps.now(), timeoutMs: deps.verifyTimeoutMs })
        state = out.ok ? 'ok' : 'failed'
        message = out.ok ? `live;${out.evidence}` : `agent_deaf_after_update;${out.message}`
      } else if (step.kind === 'update_plugin') {
        const cli = await deps.cli(['plugin', 'update', 'hoai@hoai'], { timeoutMs: 1000 })
        state = cli.code === 0 ? 'ok' : 'failed'
        message = cli.code === 0 ? 'updated' : `update_failed:${cli.stderr}`
      }
      await report(step.id, { state, message })
      const rec = { ...step, state, message }
      steps.push(rec)
      if (state === 'failed') {
        failedStep = { id: step.id, kind: step.kind, target: step.target, message }
        rolledBack = step.onFailure === 'rollback'
      }
    }
    return {
      ok: !failedStep,
      verdict: failedStep ? (rolledBack ? 'rolled_back' : 'failed') : 'done',
      failedStep,
      rolledBack,
      targetVersion: plan.targetVersion,
      installedVersion: failedStep ? '0.38.3' : plan.targetVersion,
      steps,
    }
  }
  return {
    planMachine: opts.plan ?? (() => ({ verdict: 'nothing_to_do', targetVersion: null, steps: [] })),
    executePlan: opts.execute ?? contractExecutor,
    observeMarketplaceInstall: async () => (opts.observe ?? observed)(),
    runClaudeCli: async (args: string[]) => {
      opts.onCli?.(args)
      return { code: 0, stdout: 'Successfully updated plugin: hoai@hoai\n', stderr: '', timedOut: false }
    },
    buildFailureDiagnostics: (input: any) => ({
      signature: { cause: `${input.result?.failedStep?.kind ?? 'unknown'}:token`, platform: input.platform, installMethod: input.installMethod },
      steps: [],
      context: { watcherVersion: input.watcherVersion, nodeVersion: input.nodeVersion },
    }),
    postFailureDiagnostics: async (post: any, diagnostics: any) => {
      await post('integrations/update-failures', diagnostics)
      return true
    },
  }
}

/** A two-agent update plan in the planner's shape (design 1.2). */
function updatePlan(state: any) {
  const ids = state.agents.map((a: any) => a.assistantId).sort((a: string, b: string) => Number(a) - Number(b))
  const steps: any[] = [
    { id: 's01-refresh_marketplace', kind: 'refresh_marketplace', onFailure: 'stop', why: 'x' },
    { id: 's02-snapshot', kind: 'snapshot', onFailure: 'stop', why: 'x' },
    { id: 's03-update_plugin', kind: 'update_plugin', onFailure: 'escalate', why: 'x' },
    { id: 's04-verify_installed', kind: 'verify_installed', onFailure: 'rollback', why: 'x' },
  ]
  let n = 5
  for (const id of ids) {
    const agent = state.agents.find((a: any) => a.assistantId === id)
    const via = agent.supervisor === 'launcher-live' ? 'marker' : agent.supervisor === 'service' ? 'service' : 'recipe'
    steps.push({ id: `s${String(n++).padStart(2, '0')}-restart_agent:${id}`, kind: 'restart_agent', target: id, via, onFailure: 'continue', why: 'x' })
    steps.push({ id: `s${String(n++).padStart(2, '0')}-verify_agent:${id}`, kind: 'verify_agent', target: id, onFailure: 'rollback', why: 'x' })
  }
  return { verdict: 'plan', targetVersion: '0.38.4', steps }
}

function spawnRecorder() {
  const spawns: Array<{ file: string; args: string[]; opts: any }> = []
  return {
    spawns,
    spawnDetached: (file: string, args: readonly string[], opts: any) => {
      spawns.push({ file, args: [...args], opts })
      return { pid: 4343 }
    },
  }
}

/** Every string that must never leave the machine. */
function assertNoSecrets(texts: string[], what: string) {
  for (const text of texts) {
    for (const secret of [TOKEN, PAIR_CODE, 'agent-secret-912', 'agent-secret-7']) {
      assert.equal(text.includes(secret), false, `${what} leaked a secret: ${text.slice(0, 200)}`)
    }
  }
}

function baseDeps(fs: MemoryFs, backend: ReturnType<typeof fakeBackend>, clock: ReturnType<typeof fakeClock>, overrides: Record<string, unknown> = {}) {
  const logs: string[] = []
  const exec = async () => ({ code: 0, stdout: '', stderr: '', error: null, timedOut: false })
  return {
    logs,
    deps: {
      home: HOME,
      env: { USER: USER },
      platform: 'linux',
      fetch: backend.fetch as any,
      fs,
      exec,
      spawnDetached: spawnRecorder().spawnDetached,
      now: clock.now,
      sleep: clock.sleep,
      once: true,
      nodePath: '/usr/local/bin/node',
      uid: 501,
      username: USER,
      pidAlive: (pid: number) => pid === 4242,
      hasTmux: true,
      hasScript: true,
      echo: (line: string) => logs.push(line),
      ...overrides,
    },
  }
}

// -- pure pieces ----------------------------------------------------------------------------

test('normalizeApiBase mirrors bgos-pair (exactly one /api/v1)', () => {
  assert.equal(normalizeApiBase('https://api.example.test'), 'https://api.example.test/api/v1')
  assert.equal(normalizeApiBase('https://api.example.test/api/v1/'), 'https://api.example.test/api/v1')
  assert.equal(normalizeApiBase(''), '')
})

test('nextBackoff: 5s doubling to a 60s cap', () => {
  assert.equal(nextBackoff(0), BACKOFF_MIN_MS)
  assert.equal(nextBackoff(5000), 10_000)
  assert.equal(nextBackoff(40_000), BACKOFF_MAX_MS)
  assert.equal(nextBackoff(60_000), BACKOFF_MAX_MS)
})

test('jobFolderName: one safe path segment or null', () => {
  assert.equal(jobFolderName('ava'), 'ava')
  assert.equal(jobFolderName('Ava Agent-2.0'), 'Ava Agent-2.0')
  assert.equal(jobFolderName('../x'), null)
  assert.equal(jobFolderName('a/b'), null)
  assert.equal(jobFolderName('a\\b'), null)
  assert.equal(jobFolderName('.hidden'), null)
  assert.equal(jobFolderName('trailing.'), null)
  assert.equal(jobFolderName(''), null)
})

test('autoUpdateEnabledFrom + readRollbackLatch', () => {
  assert.equal(autoUpdateEnabledFrom({}), true)
  assert.equal(autoUpdateEnabledFrom({ BGOS_AUTO_UPDATE: 'off' }), false)
  assert.equal(autoUpdateEnabledFrom({ BGOS_AUTO_UPDATE: 'OFF ' }), false)
  const fs = memoryFs({ '/s/912/auto-update.json': JSON.stringify({ disabled: true }), '/s/7/auto-update.json': 'junk' })
  assert.equal(readRollbackLatch('/s/912', fs), true)
  assert.equal(readRollbackLatch('/s/7', fs), false)
  assert.equal(readRollbackLatch('/s/none', fs), false)
})

test('scrubLine: token, pair code, header, JWT, assignments, home (both spellings) and username are redacted', () => {
  const opts = { home: 'C:\\Users\\kc', username: 'kc', secrets: [TOKEN, PAIR_CODE] }
  assert.equal(scrubLine(`token ${TOKEN} sent`, opts), 'token <redacted> sent')
  assert.equal(scrubLine(`pairing ${PAIR_CODE} now`, opts), 'pairing <redacted> now')
  assert.equal(scrubLine('X-BGOS-Pairing: abc.def.ghi', opts), 'X-BGOS-Pairing: <redacted>')
  assert.equal(scrubLine('jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop', opts), 'jwt <redacted>')
  assert.equal(scrubLine('pairingToken=abcdefghijklmnop123', opts), 'pairingToken=<redacted>')
  assert.equal(scrubLine('"apiKey": "sk-live-0123456789abcdef"', opts), '"apiKey": "<redacted>"')
  assert.equal(scrubLine('cwd C:\\Users\\kc\\hoai-agents\\ava and C:/Users/kc/x', opts), 'cwd ~\\hoai-agents\\ava and ~/x')
  assert.equal(scrubLine('user kc logged in as KC', opts), 'user <user> logged in as <user>')
  // An unrelated word containing the username is left alone.
  assert.equal(scrubLine('backconnect', opts), 'backconnect')
  // A pair code that was never registered as a secret is still caught by shape.
  assert.equal(scrubLine('code OC-AB12-CD34 issued', { home: '', username: '' }), 'code <redacted> issued')
})

test('StepLedger: ordered, deduped, absorbs executor records, clips messages, caps at 200', () => {
  const ledger = new StepLedger([{ id: 'a', kind: 'snapshot' }, { id: 'b', kind: 'restart_agent', target: '912' }])
  ledger.begin('a')
  ledger.ok('a', 'x'.repeat(400))
  ledger.update('c', { state: 'ok', kind: 'refresh_watcher' })
  ledger.absorb([{ id: 'b', kind: 'restart_agent', target: '912', state: 'failed', message: 'boom' }])
  const view = ledger.view()
  assert.deepEqual(view.map((s) => [s.id, s.state]), [['a', 'ok'], ['b', 'failed'], ['c', 'ok']])
  assert.equal(view[0]!.message!.length, 300)
  assert.equal(view[1]!.message, 'boom')
  assert.equal(view[1]!.target, '912')
  const big = new StepLedger(Array.from({ length: 250 }, (_, i) => ({ id: `s${i}`, kind: 'x' })))
  assert.equal(big.view().length, 200)
})

// -- REST client ---------------------------------------------------------------------------------

test('buildRpcClient: exact paths, pairing header, JSON bodies, abort signal; a network error is ok:false, never a throw', async () => {
  const backend = fakeBackend()
  const client = buildRpcClient({ backendUrl: 'https://api.example.test/', token: TOKEN, fetch: backend.fetch as any })
  assert.equal(client.apiBase, 'https://api.example.test/api/v1')
  await client.pending(25)
  await client.ack('r1')
  await client.job('r1')
  await client.progress('r1', { state: 'running', steps: [] })
  await client.heartbeat({ daemonVersion: '0.38.3' })
  await client.post('integrations/update-failures', { a: 1 })
  assert.deepEqual(
    backend.calls.map((c) => `${c.method} ${c.path}`),
    [
      'GET /api/v1/integrations/machine-rpc/pending?wait=25',
      'POST /api/v1/integrations/machine-rpc/r1/ack',
      'GET /api/v1/integrations/machine-rpc/r1',
      'POST /api/v1/integrations/machine-rpc/r1/progress',
      'POST /api/v1/integrations/heartbeat',
      'POST /api/v1/integrations/update-failures',
    ],
  )
  for (const call of backend.calls) assert.equal(call.headers['X-BGOS-Pairing'], TOKEN)
  assert.deepEqual(backend.calls[3]!.body, { state: 'running', steps: [] })
  assert.equal(backend.calls[2]!.body, undefined)
  const signalled = await new Promise<boolean>((resolve) => {
    const c = buildRpcClient({ backendUrl: 'https://x.test', token: 't', fetch: (async (_u: string, init: any) => { resolve(Boolean(init.signal)); return { ok: true, status: 200, text: async () => '{}' } }) as any })
    void c.ack('x')
  })
  assert.equal(signalled, true)
  const broken = buildRpcClient({ backendUrl: 'https://x.test', token: 't', fetch: (async () => { throw new Error('ECONNREFUSED') }) as any })
  const res = await broken.pending()
  assert.deepEqual(res, { ok: false, status: 0, json: null, text: '', error: 'ECONNREFUSED' })
  assert.throws(() => buildRpcClient({ backendUrl: '', token: 't', fetch: backend.fetch as any }), /backendUrl/)
})

// -- the loop -------------------------------------------------------------------------------------

test('runWatcher: no credentials file means wait (once: exit 78), nothing fetched, state.json written', async () => {
  const fs = memoryFs()
  const backend = fakeBackend()
  const clock = fakeClock()
  const { deps, logs } = baseDeps(fs, backend, clock, { modules: stubModules() })
  assert.equal(await runWatcher(deps as any), EXIT_NO_CREDENTIALS)
  assert.equal(backend.calls.length, 0)
  assert.equal(logs.some((l) => l.includes('no watcher credentials yet')), true)
  assert.equal(JSON.parse(fs.files.get(`${HOME}/.bgos-agent/watcher/state.json`)!).pid, process.pid)
})

test('runWatcher: an idle cycle posts the heartbeat (exact shape) then long-polls; no frames means exit 0 in once mode', async () => {
  const fs = machineFs()
  manifestFor(fs)
  const backend = fakeBackend()
  const clock = fakeClock()
  const { deps } = baseDeps(fs, backend, clock, { modules: stubModules() })
  assert.equal(await runWatcher(deps as any), 0)
  assert.deepEqual(
    backend.calls.map((c) => `${c.method} ${c.path}`),
    ['POST /api/v1/integrations/heartbeat', 'GET /api/v1/integrations/machine-rpc/pending?wait=25'],
  )
  assert.deepEqual(backend.calls[0]!.body, {
    daemonVersion: '0.38.3',
    env: { platform: 'linux', machineId: MACHINE_ID, role: 'watcher', agents: ['7', '912'] },
  })
  const state = JSON.parse(fs.files.get(`${HOME}/.bgos-agent/watcher/state.json`)!)
  assert.equal(state.lastHeartbeatOk, true)
  assert.equal(state.lastPollStatus, 200)
})

test('runWatcher: a poll network failure backs off 5s and never exits (once: returns 1 after the sleep)', async () => {
  const fs = machineFs()
  const backend = fakeBackend({ failPending: true })
  const clock = fakeClock()
  const { deps, logs } = baseDeps(fs, backend, clock, { modules: stubModules() })
  assert.equal(await runWatcher(deps as any), 1)
  assert.equal(logs.some((l) => l.includes('retrying in 5s')), true)
  assert.equal(logs.some((l) => l.includes('ECONNREFUSED')), true)
})

test('runWatcher reconcile: ack, job, planning, per-step progress, marker + recipe restarts with a 10s stagger, verify via the live marker, terminal done', async () => {
  const fs = machineFs()
  manifestFor(fs)
  const backend = fakeBackend({
    frames: [{ rpcId: 'job-1', op: 'reconcile' }],
    jobs: { 'job-1': { op: 'reconcile', intent: 'update', targets: [{ pairingId: 1, assistantId: '912' }, { pairingId: 2, assistantId: '7' }] } },
  })
  const clock = fakeClock()
  // The daemons answer the liveness probe: on the first sleep after a
  // restart the marker gets a lastLiveAt newer than the restart instant.
  clock.onSleep((_ms, nowMs) => {
    for (const id of ['912', '7']) {
      const probe = `${HOME}/.bgos-agent/${id}/probe-requested.json`
      if (fs.files.has(probe)) fs.writeFile(`${HOME}/.bgos-plugin-state/${id}/channel-live.json`, JSON.stringify({ firstLiveAt: 'x', lastLiveAt: new Date(nowMs).toISOString() }))
    }
  })
  const cliCalls: string[][] = []
  const recorder = spawnRecorder()
  const { deps, logs } = baseDeps(fs, backend, clock, { modules: stubModules({ plan: updatePlan, onCli: (a) => cliCalls.push(a) }), spawnDetached: recorder.spawnDetached })
  assert.equal(await runWatcher(deps as any), 0)

  assert.deepEqual(
    backend.calls.map((c) => `${c.method} ${c.path}`).slice(0, 4),
    [
      'POST /api/v1/integrations/heartbeat',
      'GET /api/v1/integrations/machine-rpc/pending?wait=25',
      'POST /api/v1/integrations/machine-rpc/job-1/ack',
      'GET /api/v1/integrations/machine-rpc/job-1',
    ],
  )
  const progress = backend.progress('job-1')
  assert.deepEqual(progress[0], { state: 'planning', steps: [] })
  assert.equal(progress[1]!.state, 'running')
  assert.deepEqual(
    progress[1]!.steps.map((s: any) => `${s.id}:${s.state}`),
    ['s01-refresh_marketplace:pending', 's02-snapshot:pending', 's03-update_plugin:pending', 's04-verify_installed:pending', 's05-restart_agent:7:pending', 's06-verify_agent:7:pending', 's07-restart_agent:912:pending', 's08-verify_agent:912:pending'],
  )
  // Every step transition was posted (running then ok), in plan order.
  const transitions = progress.slice(2, -1).map((p: any) => {
    const active = p.steps.filter((s: any) => s.state !== 'pending')
    const last = active[active.length - 1]
    return `${last.id}:${last.state}`
  })
  assert.deepEqual(transitions, [
    's01-refresh_marketplace:running', 's01-refresh_marketplace:ok',
    's02-snapshot:running', 's02-snapshot:ok',
    's03-update_plugin:running', 's03-update_plugin:ok',
    's04-verify_installed:running', 's04-verify_installed:ok',
    's05-restart_agent:7:running', 's05-restart_agent:7:ok',
    's06-verify_agent:7:running', 's06-verify_agent:7:ok',
    's07-restart_agent:912:running', 's07-restart_agent:912:ok',
    's08-verify_agent:912:running', 's08-verify_agent:912:ok',
  ])
  const terminal = progress[progress.length - 1]!
  assert.equal(terminal.state, 'done')
  assert.equal(terminal.targetVersion, '0.38.4')
  assert.equal(terminal.message, 'updated')
  assert.equal(terminal.steps.every((s: any) => s.state === 'ok'), true)
  assert.equal(terminal.steps.some((s: any) => s.id === 'refresh_watcher'), false, 'bundle fingerprint unchanged: no refresh step')
  // Agent 7 (recipe-only, ascending first) relaunched via tmux in its cwd with the CURRENT root; 912 via the marker.
  assert.equal(recorder.spawns.length, 1)
  assert.equal(recorder.spawns[0]!.file, 'tmux')
  assert.deepEqual(recorder.spawns[0]!.args.slice(0, 6), ['new-session', '-d', '-s', 'hoai-7', '-c', `${HOME}/hoai-agents/old`])
  assert.equal(recorder.spawns[0]!.args[6], `'/usr/local/bin/node' '${ROOT}/bin/hoai-core.mjs'`)
  assert.equal(fs.files.get(`${HOME}/.bgos-agent/912/restart-requested.json`), '{}')
  assert.equal(fs.files.has(`${HOME}/.bgos-agent/7/restart-requested.json`), false)
  assert.equal(terminal.steps.find((s: any) => s.id === 's07-restart_agent:912')!.message, 'restarted;how:marker')
  assert.equal(terminal.steps.find((s: any) => s.id === 's05-restart_agent:7')!.message, 'restarted;how:recipe-tmux')
  assert.match(terminal.steps.find((s: any) => s.id === 's08-verify_agent:912')!.message, /^live;via:lastLiveAt lastLiveAt:2026-/)
  // Stagger: one 10s sleep between the two restarts, plus the 3s verify polls.
  assert.equal(clock.sleeps.filter((ms) => ms === 10_000).length, 1)
  assert.equal(clock.sleeps.filter((ms) => ms === 3000).length, 2)
  // The CLI ran through the injected runner with the env, never a real claude.
  assert.deepEqual(cliCalls, [['plugin', 'update', 'hoai@hoai']])
  // No secrets in any request body or log line.
  assertNoSecrets(backend.calls.map((c) => JSON.stringify(c.body ?? {})), 'request body')
  assertNoSecrets(logs, 'log line')
  assert.equal(logs.some((l) => l.includes(HOME)), false, 'home path in a log line')
  assert.equal(logs.some((l) => l.includes('/home/kc')), false)
  assert.equal(backend.calls.some((c) => JSON.stringify(c.body ?? {}).includes(HOME)), false, 'home path in a request body')
})

test('runWatcher reconcile: targets filter the fleet (only the named agent restarts); unknown targets are logged', async () => {
  const fs = machineFs()
  manifestFor(fs)
  const backend = fakeBackend({ frames: [{ rpcId: 'j', op: 'reconcile' }], jobs: { j: { op: 'reconcile', intent: 'restart_only', targets: [{ pairingId: 1, assistantId: '912' }, { pairingId: 9, assistantId: '999' }] } } })
  const clock = fakeClock()
  clock.onSleep((_ms, nowMs) => {
    if (fs.files.has(`${HOME}/.bgos-agent/912/probe-requested.json`)) fs.writeFile(`${HOME}/.bgos-plugin-state/912/channel-live.json`, JSON.stringify({ lastLiveAt: new Date(nowMs).toISOString() }))
  })
  let planned: any = null
  const plan = (state: any) => {
    planned = state
    return { verdict: 'plan', targetVersion: null, steps: [{ id: 's01-restart_agent:912', kind: 'restart_agent', target: '912', via: 'marker', onFailure: 'continue', why: 'x' }, { id: 's02-verify_agent:912', kind: 'verify_agent', target: '912', onFailure: 'rollback', why: 'x' }] }
  }
  const { deps, logs } = baseDeps(fs, backend, clock, { modules: stubModules({ plan }) })
  assert.equal(await runWatcher(deps as any), 0)
  assert.deepEqual(planned.agents.map((a: any) => a.assistantId), ['912'])
  assert.equal(planned.intent, 'restart_only')
  assert.equal(planned.installMethod, 'marketplace')
  assert.equal(planned.runningVersion, '0.38.3')
  assert.deepEqual(planned.marketplace, { registered: true, latestVersion: '0.38.4' })
  assert.equal(planned.refreshWatcher, false)
  assert.equal(logs.some((l) => l.includes('targets not on this machine: 999')), true)
  assert.equal(backend.progress('j').at(-1)!.state, 'done')
  assert.equal(backend.progress('j').at(-1)!.message, 'reconciled')
  assert.equal(fs.files.has(`${HOME}/.bgos-agent/7/restart-requested.json`), false)
})

test('runWatcher reconcile: blocked plans fail with the reason; nothing_to_do is done', async () => {
  for (const [verdict, expectState, expectMessage] of [
    ['blocked', 'failed', 'rollback_latched'],
    ['nothing_to_do', 'done', 'nothing_to_do'],
  ] as const) {
    const fs = machineFs()
    manifestFor(fs)
    const backend = fakeBackend({ frames: [{ rpcId: 'j', op: 'reconcile' }], jobs: { j: { op: 'reconcile', intent: 'update', targets: [] } } })
    const clock = fakeClock()
    const plan = () => (verdict === 'blocked' ? { verdict, reason: 'rollback_latched', targetVersion: null, steps: [] } : { verdict, targetVersion: '0.38.3', steps: [] })
    const { deps } = baseDeps(fs, backend, clock, { modules: stubModules({ plan }) })
    await runWatcher(deps as any)
    const terminal = backend.progress('j').at(-1)!
    assert.equal(terminal.state, expectState)
    assert.equal(terminal.message, expectMessage)
    assert.deepEqual(terminal.steps, [])
    assert.equal(backend.calls.some((c) => c.path.endsWith('/update-failures')), false)
  }
})

test('runWatcher reconcile: a verify failure rolls back, names the step, posts scrubbed diagnostics', async () => {
  const fs = machineFs()
  manifestFor(fs)
  const backend = fakeBackend({ frames: [{ rpcId: 'j', op: 'reconcile' }], jobs: { j: { op: 'reconcile', intent: 'update', targets: [] } } })
  const clock = fakeClock()
  // Only 7 answers the probe; 912 stays deaf.
  clock.onSleep((_ms, nowMs) => {
    if (fs.files.has(`${HOME}/.bgos-agent/7/probe-requested.json`)) fs.writeFile(`${HOME}/.bgos-plugin-state/7/channel-live.json`, JSON.stringify({ lastLiveAt: new Date(nowMs).toISOString() }))
  })
  const { deps, logs } = baseDeps(fs, backend, clock, { modules: stubModules({ plan: updatePlan }), verifyTimeoutMs: 9000 })
  assert.equal(await runWatcher(deps as any), 0)
  const terminal = backend.progress('j').at(-1)!
  assert.equal(terminal.state, 'rolled_back')
  assert.deepEqual(terminal.failedStep, { id: 's08-verify_agent:912', kind: 'verify_agent', target: '912', message: 'agent_deaf_after_update;agent_deaf_after_restart' })
  assert.equal(terminal.message, 'verify_agent:agent_deaf_after_update;agent_deaf_after_restart')
  assert.equal(terminal.steps.find((s: any) => s.id === 's08-verify_agent:912')!.state, 'failed')
  assert.equal(terminal.steps.find((s: any) => s.id === 's06-verify_agent:7')!.state, 'ok')
  // The probe was re-requested for the deaf agent (file present), and verification polled 3 times (9s / 3s).
  assert.equal(fs.files.has(`${HOME}/.bgos-agent/912/probe-requested.json`), true)
  assert.equal(clock.sleeps.filter((ms) => ms === 3000).length, 4)
  const diag = backend.calls.find((c) => c.path.endsWith('/integrations/update-failures'))!
  assert.ok(diag, 'diagnostics posted')
  assert.equal(diag.method, 'POST')
  assert.equal(diag.headers['X-BGOS-Pairing'], TOKEN)
  assert.equal(diag.body.signature.cause, 'verify_agent:token')
  assert.equal(diag.body.context.watcherVersion, '0.38.3')
  assertNoSecrets(backend.calls.map((c) => JSON.stringify(c.body ?? {})), 'request body')
  assertNoSecrets(logs, 'log line')
})

test('runWatcher reconcile: a stale watcher bundle is staged, swapped and the process asks to restart (75 on posix, successor spawn + 0 on win32)', async () => {
  for (const platform of ['linux', 'win32'] as const) {
    const fs = machineFs()
    // The installed (post-update) root carries a newer bundle than the manifest recorded.
    for (const rel of WATCHER_BUNDLE_FILES) fs.writeFile(`${NEW_ROOT}/${rel}`, `// ${rel} v0.38.4\n`)
    fs.writeFile(`${NEW_ROOT}/package.json`, JSON.stringify({ version: '0.38.4' }))
    manifestFor(fs, ROOT, 'stale-fingerprint')
    fs.writeFile(`${HOME}/.bgos-agent/watcher/run-hidden.vbs`, 'x')
    const backend = fakeBackend({ frames: [{ rpcId: 'j', op: 'reconcile' }], jobs: { j: { op: 'update', intent: 'update', targets: [] } } })
    const clock = fakeClock()
    clock.onSleep((_ms, nowMs) => {
      for (const id of ['912', '7']) {
        if (fs.files.has(`${HOME}/.bgos-agent/${id}/probe-requested.json`)) fs.writeFile(`${HOME}/.bgos-plugin-state/${id}/channel-live.json`, JSON.stringify({ lastLiveAt: new Date(nowMs).toISOString() }))
      }
    })
    let observations = 0
    const observe = () => ({
      marketplaceRegistered: true,
      marketplaceInstallLocation: null,
      marketplaceLatest: { version: '0.38.4', ref: 'v0.38.4' },
      // Before the run the old version is installed; after it, the new one.
      installed: { present: true, version: observations++ === 0 ? '0.38.3' : '0.38.4', installPath: observations === 1 ? ROOT : NEW_ROOT },
      enabled: true,
    })
    const recorder = spawnRecorder()
    const { deps, logs } = baseDeps(fs, backend, clock, { platform, modules: stubModules({ plan: updatePlan, observe }), spawnDetached: recorder.spawnDetached, hasTmux: true })
    const code = await runWatcher(deps as any)
    const terminal = backend.progress('j').at(-1)!
    assert.equal(terminal.state, 'done', platform)
    const refresh = terminal.steps.find((s: any) => s.id === 'refresh_watcher')
    assert.deepEqual(refresh, { id: 'refresh_watcher', kind: 'refresh_watcher', state: 'ok', message: 'watcher_bundle_refreshed:0.38.4' })
    // The live bundle now carries the new files and manifest; staging dirs are gone.
    assert.equal(fs.files.get(`${HOME}/.bgos-agent/watcher/lib/watcher-core.mjs`), '// lib/watcher-core.mjs v0.38.4\n')
    const manifest = JSON.parse(fs.files.get(`${HOME}/.bgos-agent/watcher/manifest.json`)!)
    assert.equal(manifest.version, '0.38.4')
    assert.equal(manifest.pluginRoot, NEW_ROOT)
    assert.equal([...fs.files.keys()].some((k) => k.includes('/watcher/next/')), false)
    // Credentials survived the swap.
    assert.equal(fs.files.has(`${HOME}/.bgos-agent/watcher/credentials.json`), true)
    if (platform === 'linux') {
      assert.equal(code, EXIT_SELF_REFRESH)
      assert.equal(recorder.spawns.some((s) => s.file === 'wscript.exe'), false)
    } else {
      assert.equal(code, 0)
      const successor = recorder.spawns.find((s) => s.file === 'wscript.exe')!
      assert.deepEqual(successor.args, ['//B', `${HOME}/.bgos-agent/watcher/run-hidden.vbs`])
    }
    assert.equal(logs.some((l) => l.includes('exiting with')), true)
    // The terminal progress was posted BEFORE the exit.
    assert.equal(backend.calls.at(-1)!.path.endsWith('/machine-rpc/j/progress'), true)
  }
})

test('runWatcher: an unknown op is acked and failed by name; a job body fetch failure is reported', async () => {
  const fs = machineFs()
  manifestFor(fs)
  const backend = fakeBackend({ frames: [{ rpcId: 'weird', op: 'format_disk' }], jobs: { weird: { op: 'format_disk' } } })
  const clock = fakeClock()
  const { deps } = baseDeps(fs, backend, clock, { modules: stubModules() })
  await runWatcher(deps as any)
  assert.deepEqual(backend.progress('weird'), [{ state: 'failed', steps: [], message: 'unknown_op:format_disk' }])
  assert.equal(backend.calls.some((c) => c.path.endsWith('/machine-rpc/weird/ack')), true)
})

// -- create_agent ----------------------------------------------------------------------------------

test('runWatcher create_agent: folder, preseed, pair (exact argv, cwd = folder), launch from the recipe, verify; steps and terminal done', async () => {
  const fs = machineFs()
  manifestFor(fs)
  const backend = fakeBackend({ frames: [{ rpcId: 'c1', op: 'create_agent' }], jobs: { c1: { op: 'create_agent', pairCode: PAIR_CODE, folderName: 'nicole', assistantId: '55' } } })
  const clock = fakeClock()
  clock.onSleep((_ms, nowMs) => {
    // The boot hello proves the new pairing live.
    if (fs.exists(`${HOME}/.bgos-agent/55/probe-requested.json`)) fs.writeFile(`${HOME}/.bgos-plugin-state/55/channel-live.json`, JSON.stringify({ firstLiveAt: new Date(nowMs).toISOString(), lastLiveAt: new Date(nowMs).toISOString() }))
  })
  const execCalls: Array<{ file: string; args: string[]; opts: any }> = []
  const exec = async (file: string, args: readonly string[], opts: any) => {
    execCalls.push({ file, args: [...args], opts })
    if (String(args[0]).endsWith('bgos-pair.mjs')) {
      // The real pair CLI writes the credentials file and bakes the folder pin.
      fs.writeFile(`${HOME}/.bgos-agent/credentials-55.json`, JSON.stringify({ pairingToken: 'agent-secret-55' }))
      fs.writeFile(`${opts.cwd}/.bgos-agent-id`, '55\n')
      return { code: 3, stdout: '[bgos-pair] paired\n', stderr: '', error: null, timedOut: false }
    }
    return { code: 0, stdout: '', stderr: '', error: null, timedOut: false }
  }
  const recorder = spawnRecorder()
  const { deps, logs } = baseDeps(fs, backend, clock, { modules: stubModules(), exec, spawnDetached: recorder.spawnDetached })
  assert.equal(await runWatcher(deps as any), 0)
  const folder = `${HOME}/hoai-agents/nicole`
  // pair: node <root>/bin/bgos-pair.mjs <code> --assistant-id 55 --backend <watcher backendUrl>, cwd = the folder.
  const pair = execCalls.find((c) => String(c.args[0]).endsWith('bgos-pair.mjs'))!
  assert.equal(pair.file, '/usr/local/bin/node')
  assert.deepEqual(pair.args, [`${ROOT}/bin/bgos-pair.mjs`, PAIR_CODE, '--assistant-id', '55', '--backend', 'https://api.example.test'])
  assert.equal(pair.opts.cwd, folder)
  // preseed: trust entry for the folder + the bypass prompt suppressed.
  const cfg = JSON.parse(fs.files.get(`${CONFIG}/.claude.json`)!)
  assert.equal(cfg.projects[folder].hasTrustDialogAccepted, true)
  assert.equal(JSON.parse(fs.files.get(`${CONFIG}/settings.json`)!).skipDangerousModePermissionPrompt, true)
  // recipe written for the new agent, without a session id.
  const recipe = JSON.parse(fs.files.get(`${HOME}/.bgos-agent/55/launch.json`)!)
  assert.equal(recipe.cwd, folder)
  assert.equal(recipe.pluginRoot, ROOT)
  assert.equal(recipe.launcher, 'hoai')
  assert.equal(JSON.stringify(recipe).includes('--resume'), false)
  // launched via tmux in the folder.
  assert.equal(recorder.spawns.length, 1)
  assert.deepEqual(recorder.spawns[0]!.args.slice(0, 6), ['new-session', '-d', '-s', 'hoai-55', '-c', folder])
  const progress = backend.progress('c1')
  const terminal = progress.at(-1)!
  assert.equal(terminal.state, 'done')
  assert.deepEqual(
    terminal.steps.map((s: any) => [s.id, s.state]),
    [['folder', 'ok'], ['preseed', 'ok'], ['pair', 'ok'], ['launch', 'ok'], ['verify', 'ok']],
  )
  assert.equal(terminal.steps[2]!.message, 'paired (folder pin resolves the identity)')
  assert.equal(terminal.steps[3]!.message, 'launched via recipe-tmux')
  assert.equal(terminal.message, 'agent 55 live in ~/hoai-agents/nicole')
  // Progress was posted at every transition, in order.
  const seen = progress.map((p: any) => `${p.state}:${p.steps.map((s: any) => s.state[0]).join('')}`)
  assert.deepEqual(seen, [
    'running:ppppp',
    'running:opppp',
    'running:ooppp',
    'running:oorpp',
    'running:ooopp',
    'running:ooorp',
    'running:oooop',
    'running:oooor',
    'done:ooooo',
  ])
  assertNoSecrets(backend.calls.map((c) => JSON.stringify(c.body ?? {})), 'request body')
  assertNoSecrets(logs, 'log line')
})

test('runWatcher create_agent: a folder pinned to another agent fails at folder; a pair CLI failure fails at pair with the exit code and stderr line', async () => {
  const fs = machineFs({ [`${HOME}/hoai-agents/taken/.bgos-agent-id`]: '912\n' })
  manifestFor(fs)
  const backend = fakeBackend({
    frames: [{ rpcId: 'a', op: 'create_agent' }, { rpcId: 'b', op: 'create_agent' }],
    jobs: {
      a: { op: 'create_agent', pairCode: PAIR_CODE, folderName: 'taken', assistantId: '55' },
      b: { op: 'create_agent', pairCode: PAIR_CODE, folderName: 'fresh', assistantId: '56' },
    },
  })
  const clock = fakeClock()
  const exec = async (_file: string, args: readonly string[]) =>
    String(args[0]).endsWith('bgos-pair.mjs')
      ? { code: 2, stdout: '', stderr: '[bgos-pair] that code has expired. Codes last 10 minutes.\nsecond line', error: null, timedOut: false }
      : { code: 0, stdout: '', stderr: '', error: null, timedOut: false }
  const { deps } = baseDeps(fs, backend, clock, { modules: stubModules(), exec })
  await runWatcher(deps as any)
  const a = backend.progress('a').at(-1)!
  assert.equal(a.state, 'failed')
  assert.deepEqual(a.failedStep, { id: 'folder', kind: 'folder', message: 'folder_pinned_to_other_agent:912' })
  const b = backend.progress('b').at(-1)!
  assert.equal(b.state, 'failed')
  assert.deepEqual(b.failedStep, { id: 'pair', kind: 'pair', message: 'pair_exit_2:[bgos-pair] that code has expired. Codes last 10 minutes.' })
  assert.deepEqual(b.steps.map((s: any) => [s.id, s.state]), [['folder', 'ok'], ['preseed', 'ok'], ['pair', 'failed'], ['launch', 'pending'], ['verify', 'pending']])
  assert.equal(fs.files.has(`${HOME}/.bgos-agent/56/launch.json`), false, 'no recipe without a pairing')
})

test('runWatcher reconcile: an agent whose recipe names another CLAUDE_CONFIG_DIR fails the job as config_dir_mismatch before any plan', async () => {
  const fs = machineFs()
  manifestFor(fs)
  const recipe = JSON.parse(fs.files.get(`${HOME}/.bgos-agent/912/launch.json`)!)
  recipe.claudeConfigDir = '/home/kc/.claude-b'
  fs.writeFile(`${HOME}/.bgos-agent/912/launch.json`, JSON.stringify(recipe))
  const backend = fakeBackend({ frames: [{ rpcId: 'j', op: 'reconcile' }], jobs: { j: { op: 'reconcile', intent: 'update', targets: [] } } })
  const clock = fakeClock()
  let planned = 0
  const { deps, logs } = baseDeps(fs, backend, clock, {
    modules: stubModules({
      plan: (state: any) => {
        planned += 1
        return updatePlan(state)
      },
    }),
  })
  await runWatcher(deps as any)
  const terminal = backend.progress('j').at(-1)!
  assert.equal(terminal.state, 'failed')
  assert.equal(terminal.message, 'config_dir_mismatch:912')
  assert.equal(planned, 0, 'never planned against the wrong install')
  assert.ok(logs.some((l) => l.includes('config dir mismatch')))
})

test("runWatcher: the manifest's claudeConfigDir beats a disagreeing service env var, with a log line", async () => {
  const fs = machineFs()
  fs.writeFile(
    `${HOME}/.bgos-agent/watcher/manifest.json`,
    JSON.stringify({ version: '0.38.3', fingerprint: bundleFingerprint(ROOT, fs), installedAt: 'x', pluginRoot: ROOT, claudeConfigDir: CONFIG, files: [] }),
  )
  const backend = fakeBackend()
  const clock = fakeClock()
  const env: Record<string, string> = { USER, CLAUDE_CONFIG_DIR: '/tmp/somewhere-else' }
  const { deps, logs } = baseDeps(fs, backend, clock, { env })
  await runWatcher(deps as any)
  assert.equal(env.CLAUDE_CONFIG_DIR, CONFIG)
  assert.ok(logs.some((l) => l.includes('the manifest wins')))
})

// --- a watcher that cannot see the plugin must not call itself healthy -------
// refreshWatcherIfStale returned { needed: false, ok: true } when it could not locate the installed
// plugin. Two things were wrong with that. It claimed health for a state that is really "I cannot
// tell", and because the caller only records a ledger step when `needed` is true, the state did not
// merely look green, it did not appear at all. A watcher permanently stuck on an old bundle
// reported nothing, forever, which is the same class of silence this whole release is about.

test('a watcher that cannot find the plugin reports that, instead of reporting itself current', async () => {
  const fs = machineFs()
  const result = await refreshWatcherIfStale({
    home: HOME,
    fs,
    now: () => T0,
    manifest: null,
    pluginRoot: null,
  })

  assert.equal(result.message, 'watcher_bundle_source_unknown')
  assert.equal(result.ok, false, 'not knowing whether a refresh is needed is not the same as being fine')
  assert.equal(
    result.needed,
    true,
    'must surface as a ledger step: the caller only records a step when needed is true, so false made this invisible',
  )
})

test('a watcher whose bundle already matches the plugin still reports current and needs nothing', async () => {
  // The control. If this ever flips, the test above would pass for the wrong reason.
  const fs = machineFs()
  manifestFor(fs)
  const manifest = JSON.parse(fs.readFile(`${HOME}/.bgos-agent/watcher/manifest.json`) as string)

  const result = await refreshWatcherIfStale({
    home: HOME,
    fs,
    now: () => T0,
    manifest,
    pluginRoot: ROOT,
  })

  assert.equal(result.message, 'watcher_bundle_current')
  assert.equal(result.needed, false)
  assert.equal(result.ok, true)
})
