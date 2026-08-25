/**
 * lib/marketplace-update.mjs: the daemon-side glue that turns a marketplace
 * install's one-click update from a dead end
 * (`marketplace_install_manual_update`) into planner + executor with
 * agents = [self]. Every sibling module (planner, executor, plugin-cli) is
 * injected here through `modules`, so this suite pins the GLUE: state
 * shape, outcome mapping, the stubbed restart/verify hooks, progress
 * mapping, the latest-version refresh, and the tracker's timers.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  HOAI_MARKETPLACE_NAME,
  MARKETPLACE_LATEST_INITIAL_DELAY_MS,
  MARKETPLACE_REFRESH_TIMEOUT_MS,
  buildObservedMarketplaceState,
  createMarketplaceLatestTracker,
  executorFs,
  mapSupervisedKind,
  marketplaceJsonPath,
  observeMarketplaceLatest,
  observeMarketplaceState,
  pendingMarketplaceRestartVersion,
  readLocalMarketplaceLatestSync,
  refreshMarketplaceLatest,
  runMarketplaceUpdate,
} from '../lib/marketplace-update.mjs'

const OBSERVATION = {
  marketplaceRegistered: true,
  marketplaceLatest: { version: '0.39.0', ref: 'v0.39.0' },
  installed: { present: true, version: '0.38.3', installPath: '/cfg/plugins/cache/hoai/hoai/0.38.3' },
  enabled: true,
}

function state(over: Record<string, unknown> = {}) {
  return buildObservedMarketplaceState({
    observation: OBSERVATION,
    platform: 'darwin',
    runningVersion: '0.38.3',
    assistantId: 871,
    cwd: '/agents/athena',
    supervised: 'launcher',
    ...over,
  })
}

const PLAN = {
  verdict: 'plan',
  targetVersion: '0.39.0',
  steps: [
    { id: 's1', kind: 'snapshot', onFailure: 'stop', why: 'x' },
    { id: 's2', kind: 'refresh_marketplace', onFailure: 'continue', why: 'x' },
    { id: 's3', kind: 'update_plugin', onFailure: 'escalate', why: 'x' },
    { id: 's4', kind: 'verify_installed', onFailure: 'rollback', why: 'x' },
    { id: 's5', kind: 'restart_agent', target: '871', onFailure: 'stop', why: 'x' },
    { id: 's6', kind: 'verify_agent', target: '871', onFailure: 'rollback', why: 'x' },
  ],
}

type Report = (stepId: string, info: { state: string; message?: string }) => Promise<void>

function modulesWith(over: Record<string, unknown> = {}) {
  return {
    planMachine: () => PLAN,
    executePlan: async (_plan: unknown, _deps: unknown, _report: Report) => ({
      ok: true,
      installedVersion: '0.39.0',
      targetVersion: '0.39.0',
      rolledBack: false,
      steps: [],
    }),
    observeMarketplaceInstall: () => OBSERVATION,
    readMarketplaceLatest: (text: string) => JSON.parse(text),
    ...over,
  }
}

// ── State shape ──────────────────────────────────────────────────────────────

test('mapSupervisedKind: launcher is live, service files are service, anything else is none', () => {
  assert.equal(mapSupervisedKind('launcher'), 'launcher-live')
  assert.equal(mapSupervisedKind('launchd'), 'service')
  assert.equal(mapSupervisedKind('systemd'), 'service')
  assert.equal(mapSupervisedKind('none'), 'none')
  assert.equal(mapSupervisedKind('pm2'), 'none')
  assert.equal(mapSupervisedKind(null), 'none')
  assert.equal(mapSupervisedKind(undefined), 'none')
})

test('buildObservedMarketplaceState: a marketplace ObservedMachineState with exactly one agent, this daemon', () => {
  assert.deepEqual(state(), {
    platform: 'darwin',
    installMethod: 'marketplace',
    runningVersion: '0.38.3',
    marketplace: { registered: true, latestVersion: '0.39.0' },
    installed: { present: true, version: '0.38.3', installPath: '/cfg/plugins/cache/hoai/hoai/0.38.3' },
    autoUpdateEnabled: true,
    rollbackLatched: false,
    agents: [{ assistantId: '871', cwd: '/agents/athena', supervisor: 'launcher-live', recipe: false, running: true }],
    intent: 'update',
  })
  assert.equal(state({ autoUpdateEnabled: false }).autoUpdateEnabled, false)
  assert.equal(state({ rollbackLatched: true }).rollbackLatched, true)
  assert.equal(state({ intent: 'repair' }).intent, 'repair')
  assert.equal(state({ supervised: 'systemd' }).agents[0]!.supervisor, 'service')
  assert.equal(state({ supervised: 'none', cwd: null }).agents[0]!.cwd, null)
})

test('buildObservedMarketplaceState: tolerates a string latest, a missing latest, and no observation at all', () => {
  assert.equal(state({ observation: { ...OBSERVATION, marketplaceLatest: '0.40.0' } }).marketplace.latestVersion, '0.40.0')
  assert.equal(state({ observation: { ...OBSERVATION, marketplaceLatest: null } }).marketplace.latestVersion, null)
  assert.equal(state({ observation: { ...OBSERVATION, marketplaceLatest: { ref: 'v1' } } }).marketplace.latestVersion, null)
  const bare = state({ observation: null, runningVersion: null })
  assert.deepEqual(bare.marketplace, { registered: false, latestVersion: null })
  assert.deepEqual(bare.installed, { present: false, version: null, installPath: null })
  assert.equal(bare.runningVersion, null)
})

test('observeMarketplaceState: hands plugin-cli a null-on-missing readFile and a never-throwing exists', async () => {
  const seen: Array<Record<string, unknown>> = []
  const observed = await observeMarketplaceState({
    configDir: '/cfg',
    platform: 'linux',
    runningVersion: '0.38.3',
    assistantId: '871',
    supervised: 'systemd',
    fs: {
      readFileSync: (path: string) => {
        if (path === '/cfg/present.json') return '{"ok":true}'
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      },
      existsSync: (path: string) => {
        if (path === '/cfg/boom') throw new Error('EACCES')
        return path === '/cfg/present.json'
      },
    } as never,
    modules: {
      observeMarketplaceInstall: (args: { configDir: string; readFile: (p: string) => string | null; exists: (p: string) => boolean }) => {
        seen.push({
          configDir: args.configDir,
          present: args.readFile('/cfg/present.json'),
          missing: args.readFile('/cfg/missing.json'),
          exists: args.exists('/cfg/present.json'),
          gone: args.exists('/cfg/missing.json'),
          boom: args.exists('/cfg/boom'),
        })
        return OBSERVATION
      },
    },
  })
  assert.deepEqual(seen, [{ configDir: '/cfg', present: '{"ok":true}', missing: null, exists: true, gone: false, boom: false }])
  assert.equal(observed.installMethod, 'marketplace')
  assert.equal(observed.agents[0]!.supervisor, 'service')
  assert.equal(observed.marketplace.latestVersion, '0.39.0')
})

test('pendingMarketplaceRestartVersion: installed differs from running means a restart is all that is missing', () => {
  assert.equal(pendingMarketplaceRestartVersion(state()), null)
  assert.equal(
    pendingMarketplaceRestartVersion(state({ observation: { ...OBSERVATION, installed: { present: true, version: '0.39.0', installPath: '/x' } } })),
    '0.39.0',
  )
  assert.equal(pendingMarketplaceRestartVersion(state({ observation: { ...OBSERVATION, installed: { present: false, version: null, installPath: null } } })), null)
  assert.equal(pendingMarketplaceRestartVersion(state({ runningVersion: null })), null)
  assert.equal(pendingMarketplaceRestartVersion(null), null)
})

// ── runMarketplaceUpdate ─────────────────────────────────────────────────────

const RUN_BASE = { cli: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false }), configDir: '/cfg', platform: 'darwin', home: '/Users/x' }

test('blocked plans map to blocked with the planner reason (or a generic token)', async () => {
  const blocked = await runMarketplaceUpdate({ ...RUN_BASE, state: state(), modules: modulesWith({ planMachine: () => ({ verdict: 'blocked', reason: 'rollback_latched', targetVersion: null, steps: [] }) }) })
  assert.deepEqual(blocked, { kind: 'blocked', reason: 'rollback_latched' })
  const bare = await runMarketplaceUpdate({ ...RUN_BASE, state: state(), modules: modulesWith({ planMachine: () => ({ verdict: 'blocked' }) }) })
  assert.deepEqual(bare, { kind: 'blocked', reason: 'blocked' })
})

test('nothing_to_do maps to no-update with the latest version, unless a newer version is already installed', async () => {
  const modules = modulesWith({ planMachine: () => ({ verdict: 'nothing_to_do', targetVersion: null, steps: [] }) })
  const nothing = await runMarketplaceUpdate({ ...RUN_BASE, state: state(), modules })
  assert.deepEqual(nothing, { kind: 'no-update', latestVersion: '0.39.0' })
  const pending = await runMarketplaceUpdate({
    ...RUN_BASE,
    state: state({ observation: { ...OBSERVATION, installed: { present: true, version: '0.39.0', installPath: '/x' } } }),
    modules,
  })
  assert.deepEqual(pending, { kind: 'installed', targetVersion: '0.39.0' })
})

test('a plan runs through executePlan with the daemon-ladder stubs and maps progress to {id, kind, state, targetVersion}', async () => {
  const reports: unknown[] = []
  let captured: Record<string, unknown> | null = null
  const cli = async () => ({ code: 0, stdout: '', stderr: '', timedOut: false })
  const outcome = await runMarketplaceUpdate({
    ...RUN_BASE,
    cli,
    state: state(),
    report: async (step) => {
      reports.push(step)
    },
    modules: modulesWith({
      executePlan: async (plan: typeof PLAN, deps: Record<string, unknown>, report: Report) => {
        captured = deps
        assert.equal(plan, PLAN)
        await report('s1', { state: 'running' })
        await report('s1', { state: 'ok' })
        await report('s3', { state: 'running', message: 'claude plugin update hoai@hoai' })
        await report('mystery', { state: 'running' })
        return { ok: true, installedVersion: '0.39.0', targetVersion: '0.39.0', rolledBack: false, steps: [] }
      },
    }),
  })
  assert.deepEqual(outcome, { kind: 'installed', targetVersion: '0.39.0' })
  assert.deepEqual(reports, [
    { id: 's1', kind: 'snapshot', state: 'running', targetVersion: '0.39.0' },
    { id: 's1', kind: 'snapshot', state: 'ok', targetVersion: '0.39.0' },
    { id: 's3', kind: 'update_plugin', state: 'running', message: 'claude plugin update hoai@hoai', targetVersion: '0.39.0' },
    { id: 'mystery', kind: 'mystery', state: 'running', targetVersion: '0.39.0' },
  ])
  const deps = captured!
  assert.equal(deps.cli, cli)
  assert.equal(deps.configDir, '/cfg')
  assert.equal(deps.platform, 'darwin')
  assert.equal(deps.home, '/Users/x')
  assert.equal(deps.staggerMs, 0)
  for (const fn of ['readFile', 'writeFile', 'exists', 'copyDir', 'rm', 'mkdir']) {
    assert.equal(typeof (deps.fs as Record<string, unknown>)[fn], 'function', `fs.${fn}`)
  }
  // The restart/verify hooks are satisfied by the daemon's own ladder, run after the outcome.
  const restart = await (deps.restartAgent as (id: string) => Promise<{ ok: boolean; how: string }>)('871')
  assert.equal(restart.ok, true)
  assert.equal(restart.how, 'daemon-ladder')
  const verify = await (deps.verifyAgent as (id: string, since: number) => Promise<{ ok: boolean; evidence: string }>)('871', 0)
  assert.equal(verify.ok, true)
  assert.equal(verify.evidence, 'daemon-ladder')
})

test('installed falls back to the plan target when the executor names no version', async () => {
  const outcome = await runMarketplaceUpdate({
    ...RUN_BASE,
    state: state(),
    modules: modulesWith({ executePlan: async () => ({ ok: true, rolledBack: false, steps: [] }) }),
  })
  assert.deepEqual(outcome, { kind: 'installed', targetVersion: '0.39.0' })
})

test('an executor failure maps to failed with the step, the rollback flag, and scrubbed diagnostics', async () => {
  const outcome = await runMarketplaceUpdate({
    ...RUN_BASE,
    state: state(),
    cliVersion: '2.1.241',
    nodeVersion: 'v22.0.0',
    username: 'fitecho',
    modules: modulesWith({
      executePlan: async () => ({
        ok: false,
        failedStep: { id: 's3', kind: 'update_plugin', message: 'claude exited with code 1: token pair_Zk3xQ9vL2mN8pR4sT7uW1yA5bC6dE0fG9hJ2kL4mN6pQ at /Users/fitecho/.claude' },
        rolledBack: true,
        targetVersion: '0.39.0',
        installedVersion: '0.38.3',
        steps: [
          { id: 's1', kind: 'snapshot', state: 'ok' },
          { id: 's3', kind: 'update_plugin', state: 'failed', message: 'exit 1' },
        ],
      }),
    }),
  })
  assert.equal(outcome.kind, 'failed')
  if (outcome.kind !== 'failed') return
  assert.deepEqual(outcome.failedStep, {
    id: 's3',
    kind: 'update_plugin',
    message: 'claude exited with code 1: token pair_Zk3xQ9vL2mN8pR4sT7uW1yA5bC6dE0fG9hJ2kL4mN6pQ at /Users/fitecho/.claude',
  })
  assert.equal(outcome.rolledBack, true)
  const diag = outcome.diagnostics as { signature: Record<string, unknown>; steps: unknown[]; context: Record<string, unknown> }
  assert.deepEqual(diag.signature, {
    cause: 'update_plugin:exit_1',
    installMethod: 'marketplace',
    platform: 'darwin',
    pluginVersion: '0.38.3',
    targetVersion: '0.39.0',
  })
  assert.equal(diag.steps.length, 2)
  assert.equal(diag.context.cliVersion, '2.1.241')
  const json = JSON.stringify(diag)
  assert.ok(!json.includes('pair_Zk3xQ9vL2mN8pR4sT7uW1yA5bC6dE0fG9hJ2kL4mN6pQ'))
  assert.ok(!json.includes('fitecho'))
})

test('a throwing executor, a throwing planner, or a missing module never escape: they are named failures', async () => {
  const boom = await runMarketplaceUpdate({ ...RUN_BASE, state: state(), modules: modulesWith({ executePlan: async () => { throw new Error('spawn claude ENOENT') } }) })
  assert.equal(boom.kind, 'failed')
  if (boom.kind === 'failed') {
    assert.deepEqual(boom.failedStep, { id: 'execute', kind: 'execute', message: 'spawn claude ENOENT' })
    assert.equal((boom.diagnostics as { signature: { cause: string } }).signature.cause, 'execute:not_found')
  }
  const plan = await runMarketplaceUpdate({ ...RUN_BASE, state: state(), modules: modulesWith({ planMachine: () => { throw new Error('bad state') } }) })
  assert.equal(plan.kind, 'failed')
  if (plan.kind === 'failed') assert.equal(plan.failedStep.id, 'plan')
  const nothing = await runMarketplaceUpdate({ ...RUN_BASE, state: state(), modules: modulesWith({ planMachine: () => null }) })
  assert.equal(nothing.kind, 'failed')
  const unnamed = await runMarketplaceUpdate({ ...RUN_BASE, state: state(), modules: modulesWith({ executePlan: async () => ({ ok: false }) }) })
  assert.equal(unnamed.kind, 'failed')
  if (unnamed.kind === 'failed') assert.equal(unnamed.failedStep.kind, 'unknown')
})

test('a throwing report callback is logged and never breaks the update', async () => {
  const logs: string[] = []
  const outcome = await runMarketplaceUpdate({
    ...RUN_BASE,
    state: state(),
    log: (m) => logs.push(m),
    report: async () => {
      throw new Error('progress 500')
    },
    modules: modulesWith({
      executePlan: async (_p: unknown, _d: unknown, report: Report) => {
        await report('s3', { state: 'running' })
        return { ok: true, installedVersion: '0.39.0', rolledBack: false, steps: [] }
      },
    }),
  })
  assert.deepEqual(outcome, { kind: 'installed', targetVersion: '0.39.0' })
  assert.ok(logs.some((l) => l.includes('progress report failed')))
})

// ── Latest version ───────────────────────────────────────────────────────────

function configDirWithMarketplace(version: string | null): string {
  const configDir = mkdtempSync(join(tmpdir(), 'mp-cfg-'))
  if (version !== null) {
    const path = marketplaceJsonPath(configDir)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify({ version }))
  }
  return configDir
}

test('marketplaceJsonPath follows the Claude Code layout for the hoai marketplace', () => {
  assert.equal(HOAI_MARKETPLACE_NAME, 'hoai')
  assert.equal(marketplaceJsonPath('/cfg'), join('/cfg', 'plugins', 'marketplaces', 'hoai', '.claude-plugin', 'marketplace.json'))
})

test('readLocalMarketplaceLatestSync: the parser decides, a missing or unparseable file is null', () => {
  const parse = (text: string) => JSON.parse(text)
  assert.equal(readLocalMarketplaceLatestSync({ configDir: configDirWithMarketplace('0.39.0'), parse }), '0.39.0')
  assert.equal(readLocalMarketplaceLatestSync({ configDir: configDirWithMarketplace(null), parse }), null)
  assert.equal(readLocalMarketplaceLatestSync({ configDir: configDirWithMarketplace('0.39.0'), parse: () => null }), null)
  assert.equal(readLocalMarketplaceLatestSync({ configDir: configDirWithMarketplace('0.39.0'), parse: () => { throw new Error('junk') } }), null)
})

test('observeMarketplaceLatest: the full observation wins (a directory-source marketplace outside the config dir), the fixed path is the fallback', async () => {
  const configDir = configDirWithMarketplace('0.39.0')
  const observed = await observeMarketplaceLatest({
    configDir,
    modules: { observeMarketplaceInstall: async () => ({ ...OBSERVATION, marketplaceLatest: { version: '0.41.0', ref: 'v0.41.0' } }) },
  })
  assert.equal(observed, '0.41.0')
  const fallback = await observeMarketplaceLatest({
    configDir,
    modules: {
      observeMarketplaceInstall: async () => ({ ...OBSERVATION, marketplaceLatest: null }),
      readMarketplaceLatest: (text: string) => JSON.parse(text),
    },
  })
  assert.equal(fallback, '0.39.0')
  const logs: string[] = []
  const threw = await observeMarketplaceLatest({
    configDir,
    log: (m) => logs.push(m),
    modules: {
      observeMarketplaceInstall: async () => {
        throw new Error('known_marketplaces.json is junk')
      },
      readMarketplaceLatest: (text: string) => JSON.parse(text),
    },
  })
  assert.equal(threw, '0.39.0')
  assert.ok(logs.some((l) => l.includes('observation failed')))
  const nothing = await observeMarketplaceLatest({
    configDir: configDirWithMarketplace(null),
    modules: { observeMarketplaceInstall: async () => null, readMarketplaceLatest: (text: string) => JSON.parse(text) },
  })
  assert.equal(nothing, null)
})

test('refreshMarketplaceLatest: runs the marketplace update with a timeout, then observes the local files; the CLI can fail freely', async () => {
  const calls: Array<{ args: string[]; opts: { timeoutMs?: number } }> = []
  const logs: string[] = []
  const configDir = configDirWithMarketplace('0.39.0')
  const modules = {
    readMarketplaceLatest: (text: string) => JSON.parse(text),
    observeMarketplaceInstall: async () => ({ ...OBSERVATION, marketplaceLatest: null }),
  }
  const ok = await refreshMarketplaceLatest({
    cli: async (args: string[], opts?: { timeoutMs?: number }) => {
      calls.push({ args, opts: opts ?? {} })
      return { code: 0, stdout: 'Successfully updated marketplace: hoai', stderr: '', timedOut: false }
    },
    configDir,
    log: (m) => logs.push(m),
    modules,
  })
  assert.equal(ok, '0.39.0')
  assert.deepEqual(calls, [{ args: ['plugin', 'marketplace', 'update', 'hoai'], opts: { timeoutMs: MARKETPLACE_REFRESH_TIMEOUT_MS } }])
  assert.equal(logs.length, 0)

  const failedCli = await refreshMarketplaceLatest({ cli: async () => ({ code: 1, stdout: '', stderr: 'network down', timedOut: false }), configDir, log: (m) => logs.push(m), modules })
  assert.equal(failedCli, '0.39.0')
  assert.ok(logs.some((l) => l.includes('exited 1') && l.includes('network down')))

  const timedOut = await refreshMarketplaceLatest({ cli: async () => ({ code: null, stdout: '', stderr: '', timedOut: true }), configDir, log: (m) => logs.push(m), modules })
  assert.equal(timedOut, '0.39.0')
  assert.ok(logs.some((l) => l.includes('timed out')))

  const threw = await refreshMarketplaceLatest({ cli: async () => { throw new Error('spawn claude ENOENT') }, configDir, log: (m) => logs.push(m), modules })
  assert.equal(threw, '0.39.0')
  assert.ok(logs.some((l) => l.includes('spawn claude ENOENT')))

  const none = await refreshMarketplaceLatest({ cli: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false }), configDir: configDirWithMarketplace(null), modules })
  assert.equal(none, null)
})

test('createMarketplaceLatestTracker: current() is the local read, the network refresh is delayed, periodic, single-flight, and quiet on failure', async () => {
  let local: string | null = '0.38.3'
  let refreshCalls = 0
  let resolveRefresh: ((v: string | null) => void) | null = null
  const timeouts: Array<{ fn: () => void; ms: number }> = []
  const intervals: Array<{ fn: () => void; ms: number }> = []
  const logs: string[] = []
  let observedLocal: string | null = null
  const tracker = createMarketplaceLatestTracker({
    readLocal: () => local,
    observeLocal: async () => observedLocal,
    refresh: () => {
      refreshCalls += 1
      return new Promise<string | null>((resolve) => {
        resolveRefresh = resolve
      })
    },
    intervalMs: 6 * 60 * 60 * 1000,
    log: (m) => logs.push(m),
    setTimeoutFn: ((fn: () => void, ms: number) => {
      timeouts.push({ fn, ms })
      return { unref() {} }
    }) as never,
    setIntervalFn: ((fn: () => void, ms: number) => {
      intervals.push({ fn, ms })
      return { unref() {} }
    }) as never,
    clearTimeoutFn: (() => {}) as never,
    clearIntervalFn: (() => {}) as never,
  })
  assert.equal(tracker.current(), '0.38.3')
  local = '0.39.0'
  assert.equal(tracker.current(), '0.39.0')
  local = null
  // An unreadable file keeps the last value the file gave us.
  assert.equal(tracker.current(), '0.39.0')
  // The async local observation (no network) updates the cache too, and a
  // null observation keeps what we had.
  assert.equal(await tracker.observeNow(), '0.39.0')
  observedLocal = '0.39.5'
  assert.equal(await tracker.observeNow(), '0.39.5')
  assert.equal(tracker.current(), '0.39.5')
  assert.equal(refreshCalls, 0, 'observation is never a network call')

  tracker.start()
  assert.equal(timeouts.length, 1)
  assert.equal(timeouts[0]!.ms, MARKETPLACE_LATEST_INITIAL_DELAY_MS)
  assert.equal(refreshCalls, 0, 'boot is never slowed by a network call')
  timeouts[0]!.fn()
  assert.equal(refreshCalls, 1)
  assert.equal(intervals.length, 1)
  assert.equal(intervals[0]!.ms, 6 * 60 * 60 * 1000)
  // Single flight: a second refresh while one is running joins it.
  const joined = tracker.refreshNow()
  assert.equal(refreshCalls, 1)
  resolveRefresh!('0.40.0')
  assert.equal(await joined, '0.40.0')
  assert.equal(tracker.current(), '0.40.0')
  // The interval tick refreshes again; a failing refresh is logged and keeps the value.
  intervals[0]!.fn()
  assert.equal(refreshCalls, 2)
  resolveRefresh!(null)
  await Promise.resolve()
  assert.equal(tracker.current(), '0.40.0')
  tracker.start()
  assert.equal(timeouts.length, 1, 'start is idempotent')
  tracker.stop()

  const throwing = createMarketplaceLatestTracker({
    readLocal: () => {
      throw new Error('EACCES')
    },
    refresh: async () => {
      throw new Error('spawn failed')
    },
    log: (m) => logs.push(m),
  })
  assert.equal(throwing.current(), null)
  assert.equal(await throwing.refreshNow(), null)
  assert.ok(logs.some((l) => l.includes('spawn failed')))
})

test('executorFs exposes the executor surface over node fs', () => {
  const fs = executorFs()
  const dir = mkdtempSync(join(tmpdir(), 'mp-fs-'))
  fs.mkdir(join(dir, 'a', 'b'))
  fs.writeFile(join(dir, 'a', 'b', 'f.txt'), 'hello')
  assert.equal(fs.exists(join(dir, 'a', 'b', 'f.txt')), true)
  assert.equal(fs.readFile(join(dir, 'a', 'b', 'f.txt')), 'hello')
  fs.copyDir(join(dir, 'a'), join(dir, 'c'))
  assert.equal(fs.readFile(join(dir, 'c', 'b', 'f.txt')), 'hello')
  fs.copyFile(join(dir, 'a', 'b', 'f.txt'), join(dir, 'g.txt'))
  assert.equal(fs.readFile(join(dir, 'g.txt')), 'hello')
  assert.deepEqual(fs.readdir(join(dir, 'a')), ['b'])
  fs.unlink(join(dir, 'g.txt'))
  assert.equal(fs.exists(join(dir, 'g.txt')), false)
  // The executor passes options through (a non-recursive rm of a file).
  fs.rm(join(dir, 'c', 'b', 'f.txt'), { recursive: false, force: true })
  assert.equal(fs.exists(join(dir, 'c', 'b', 'f.txt')), false)
  fs.rm(join(dir, 'c'))
  assert.equal(fs.exists(join(dir, 'c')), false)
  assert.throws(() => fs.readFile(join(dir, 'missing')))
  // The executor's own adapter has the same surface (mirror pin).
  for (const fn of ['readFile', 'writeFile', 'exists', 'mkdir', 'rm', 'readdir', 'copyFile', 'readlink', 'symlink', 'unlink']) {
    assert.equal(typeof (fs as Record<string, unknown>)[fn], 'function', fn)
  }
})
