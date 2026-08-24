/**
 * update-executor tests.
 *
 * Two tiers, both driving lib/update-executor.mjs end to end with plans
 * produced by the REAL planner (lib/update-planner.mjs) wherever a planner
 * state expresses the case, hand-built plans otherwise:
 *
 *   1. In-memory: an injected fs (a Map keyed by exact path strings), a
 *      scripted cli that mutates that Map the way the real CLI mutates the
 *      config dir, a ticking clock, a recording sleep, fake restart / verify.
 *      Pins the ladder, rollback, the step states and message tokens, the
 *      report contract, stagger order, alias refresh on both platforms,
 *      clone fast-forward, deadlines and the detail scrubber.
 *   2. Sandbox: a throwaway HOME + CLAUDE_CONFIG_DIR (test/helpers/sandbox.ts)
 *      and the REAL test/fixtures/fake-claude.mjs spawned through
 *      runClaudeCli, so the CLI runner, its timeout, the classifiers, the
 *      file observations, the snapshot and the byte-for-byte restore are
 *      exercised against real files. Scenarios live in
 *      test/fixtures/executor-scenarios/*.json. Nothing touches ~/.claude.
 *
 * Run: npx tsx --test test/update-executor.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  SNAPSHOT_FILE,
  SNAPSHOTS_TO_KEEP,
  aliasBreadcrumbPath,
  aliasSymlinkPath,
  dirnameLike,
  executePlan,
  joinLike,
  nodeFs,
  pathWithin,
  rollbackRootFor,
  samePath,
  scrubDetail,
  snapshotStamp,
  withDeadline,
} from '../lib/update-executor.mjs'
import { planMachine } from '../lib/update-planner.mjs'
import {
  installArgs,
  listJsonArgs,
  marketplaceAddArgs,
  marketplaceConfigPaths,
  marketplaceUpdateArgs,
  observeMarketplaceInstall,
  runClaudeCli,
  uninstallArgs,
  updateArgs,
} from '../lib/plugin-cli.mjs'
import { cliRunnerFor, makeSandbox, type Sandbox } from './helpers/sandbox.ts'

type MachineState = Parameters<typeof planMachine>[0]
type Plan = Parameters<typeof executePlan>[0]
type Deps = Parameters<typeof executePlan>[1]
type Result = Awaited<ReturnType<typeof executePlan>>
type StepRecord = Result['steps'][number]
type ReportPayload = { state: string; message?: string; detail?: string }

const SCENARIOS_DIR = fileURLToPath(new URL('./fixtures/executor-scenarios/', import.meta.url))

// -- Shared helpers ------------------------------------------------------------

type CliOut = { code?: number | null; stdout?: string; stderr?: string; timedOut?: boolean }
type CliCall = { args: string[]; timeoutMs: number }
type CliEntry = CliOut | ((call: CliCall) => CliOut | Promise<CliOut>)
type CliScript = Record<string, CliEntry>

const KEY = {
  add: marketplaceAddArgs().join(' '),
  refresh: marketplaceUpdateArgs().join(' '),
  install: installArgs().join(' '),
  update: updateArgs().join(' '),
  uninstall: uninstallArgs().join(' '),
  list: listJsonArgs().join(' '),
}

/** Real Claude Code 2.1.241 phrasings (the classifiers key on these). */
const OUT = {
  registered: { code: 0, stdout: 'Successfully added marketplace: hoai (declared in user settings)\n', stderr: '' },
  alreadyRegistered: { code: 0, stdout: "Marketplace 'hoai' already on disk\n", stderr: '' },
  refreshed: { code: 0, stdout: 'Successfully updated marketplace: hoai\n', stderr: '' },
  installed: { code: 0, stdout: 'Successfully installed plugin: hoai@hoai (scope: user)\n', stderr: '' },
  alreadyInstalled: { code: 0, stdout: 'Plugin "hoai@hoai" is already installed (scope: user)\n', stderr: '' },
  updated: (from: string, to: string) => ({
    code: 0,
    stdout: `Successfully updated plugin: hoai@hoai from ${from} to ${to} (restart required to apply)\n`,
    stderr: '',
  }),
  alreadyLatest: (version: string) => ({ code: 0, stdout: `hoai@hoai is already at the latest version (${version}).\n`, stderr: '' }),
  uninstalled: { code: 0, stdout: 'Successfully uninstalled plugin: hoai@hoai (scope: user)\n', stderr: '' },
  notInstalled: { code: 1, stdout: '', stderr: 'Failed to uninstall plugin "hoai@hoai": Plugin "hoai@hoai" not found in installed plugins\n' },
  failure: (code = 1, stderr = 'Failed to update plugin "hoai@hoai": simulated failure\n') => ({ code, stdout: '', stderr }),
}

const stepView = (steps: StepRecord[]) => steps.map((s) => `${s.id}:${s.state}${s.message ? `:${s.message}` : ''}`)
const stepById = (result: Result, id: string) => {
  const step = result.steps.find((s) => s.id === id)
  assert.ok(step, `step ${id} missing from ${stepView(result.steps).join(' | ')}`)
  return step
}

function recorder() {
  const events: Array<{ id: string; payload: ReportPayload }> = []
  const report = async (id: string, payload: ReportPayload) => {
    events.push({ id, payload: { ...payload } })
  }
  return { events, report }
}

/** Last payload per id, in first-report order. */
function lastReported(events: Array<{ id: string; payload: ReportPayload }>) {
  const order: string[] = []
  const last = new Map<string, ReportPayload>()
  for (const event of events) {
    if (!last.has(event.id)) order.push(event.id)
    last.set(event.id, event.payload)
  }
  return { order, last }
}

// -- In-memory world -----------------------------------------------------------

function memWorld(opts: { home?: string; configDir?: string } = {}) {
  const home = opts.home ?? '/home/kc'
  const configDir = opts.configDir ?? joinLike(home, '.claude')
  const files = new Map<string, string>()
  const links = new Map<string, string>()
  const under = (key: string, dir: string) => key === dir || key.startsWith(`${dir}/`) || key.startsWith(`${dir}\\`)
  const fs = {
    readFile: (p: string) => {
      const value = files.get(p)
      if (value === undefined) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' })
      return value
    },
    writeFile: (p: string, text: string) => {
      files.set(p, text)
    },
    exists: (p: string) => files.has(p),
    mkdir: () => {},
    rm: (p: string) => {
      for (const key of [...files.keys()]) if (under(key, p)) files.delete(key)
      links.delete(p)
    },
    readdir: (p: string) => {
      const names = new Set<string>()
      for (const key of files.keys()) {
        if (key.startsWith(`${p}/`) || key.startsWith(`${p}\\`)) names.add(key.slice(p.length + 1).split(/[\\/]/)[0])
      }
      return [...names]
    },
    readlink: (p: string) => {
      const target = links.get(p)
      if (target === undefined) throw Object.assign(new Error(`EINVAL: ${p}`), { code: 'EINVAL' })
      return target
    },
    symlink: (target: string, p: string) => {
      links.set(p, target)
    },
    unlink: (p: string) => {
      files.delete(p)
      links.delete(p)
    },
  }
  const paths = marketplaceConfigPaths(configDir)
  const world = {
    home,
    configDir,
    files,
    links,
    fs,
    paths,
    cacheDir: paths.cacheDir,
    installPathFor: (version: string) => joinLike(paths.cacheDir, version),
    seedMarketplace(latest: string) {
      files.set(
        paths.knownMarketplaces,
        JSON.stringify({ hoai: { source: { source: 'github', repo: 'BrandGrowthOS/hoai-marketplace' }, installLocation: dirnameLike(dirnameLike(paths.marketplaceJson)), lastUpdated: '2026-08-25T00:00:00.000Z' } }, null, 2),
      )
      world.setLatest(latest)
      const settings = world.readJson(paths.settings) ?? {}
      settings.extraKnownMarketplaces = { hoai: { source: { source: 'github', repo: 'BrandGrowthOS/hoai-marketplace' } } }
      files.set(paths.settings, `${JSON.stringify(settings, null, 2)}\n`)
    },
    setLatest(latest: string) {
      files.set(
        paths.marketplaceJson,
        JSON.stringify({ name: 'hoai', plugins: [{ name: 'hoai', source: { source: 'url', url: 'https://github.com/BrandGrowthOS/bgos-claude-plugin.git', ref: `v${latest}` } }] }, null, 2),
      )
    },
    seedInstalled(version: string) {
      const installPath = world.installPathFor(version)
      files.set(joinLike(installPath, '.claude-plugin', 'plugin.json'), `${JSON.stringify({ name: 'hoai', version }, null, 2)}\n`)
      files.set(
        paths.installedPlugins,
        `${JSON.stringify({ version: 2, plugins: { 'hoai@hoai': [{ scope: 'user', installPath, version, installedAt: '2026-08-25T00:00:00.000Z', lastUpdated: '2026-08-25T00:00:00.000Z', gitCommitSha: 'c0ffee' }] } }, null, 2)}\n`,
      )
      const settings = world.readJson(paths.settings) ?? {}
      settings.enabledPlugins = { 'hoai@hoai': true }
      settings.skipDangerousModePermissionPrompt = true
      files.set(paths.settings, `${JSON.stringify(settings, null, 2)}\n`)
      return installPath
    },
    removeInstalled() {
      const doc = world.readJson(paths.installedPlugins)
      if (doc?.plugins) {
        delete doc.plugins['hoai@hoai']
        files.set(paths.installedPlugins, `${JSON.stringify(doc, null, 2)}\n`)
      }
      const settings = world.readJson(paths.settings)
      if (settings?.enabledPlugins) {
        delete settings.enabledPlugins['hoai@hoai']
        files.set(paths.settings, `${JSON.stringify(settings, null, 2)}\n`)
      }
    },
    readJson(p: string): any {
      const text = files.get(p)
      return text === undefined ? null : JSON.parse(text)
    },
    installedVersion(): string | null {
      const doc = world.readJson(paths.installedPlugins)
      return doc?.plugins?.['hoai@hoai']?.[0]?.version ?? null
    },
    listJson(): CliOut {
      const doc = world.readJson(paths.installedPlugins)
      const entry = doc?.plugins?.['hoai@hoai']?.[0]
      const rows = entry ? [{ id: 'hoai@hoai', version: entry.version, scope: 'user', enabled: true, installPath: entry.installPath }] : []
      return { code: 0, stdout: `${JSON.stringify(rows, null, 2)}\n`, stderr: '' }
    },
  }
  return world
}
type World = ReturnType<typeof memWorld>

/** A cli script that mutates the in-memory world like the real CLI. */
function realisticScript(world: World, latest: string, overrides: CliScript = {}): CliScript {
  return {
    [KEY.add]: () => {
      if (world.files.has(world.paths.knownMarketplaces)) return OUT.alreadyRegistered
      world.seedMarketplace(latest)
      return OUT.registered
    },
    [KEY.refresh]: () => {
      if (!world.files.has(world.paths.knownMarketplaces)) return OUT.failure(1, 'Failed to update marketplace "hoai": Marketplace "hoai" not found\n')
      return OUT.refreshed
    },
    [KEY.install]: () => {
      if (world.installedVersion()) return OUT.alreadyInstalled
      world.seedInstalled(latest)
      return OUT.installed
    },
    [KEY.update]: () => {
      const current = world.installedVersion()
      if (!current) return OUT.failure(1, 'Failed to update plugin "hoai@hoai": Plugin "hoai" not found\n')
      if (current === latest) return OUT.alreadyLatest(current)
      world.seedInstalled(latest)
      return OUT.updated(current, latest)
    },
    [KEY.uninstall]: () => {
      if (!world.installedVersion()) return OUT.notInstalled
      world.removeInstalled()
      return OUT.uninstalled
    },
    [KEY.list]: () => world.listJson(),
    ...overrides,
  }
}

function memDeps(world: World, script: CliScript, over: Partial<Deps> = {}) {
  const calls: string[] = []
  const sleeps: number[] = []
  const restarts: Array<{ id: string; via: string | null; at: number }> = []
  const verifies: Array<{ id: string; since: number }> = []
  let clock = Date.UTC(2026, 7, 25, 1, 0, 0, 0)
  const now = () => (clock += 1000)
  const deps: Deps = {
    cli: async (args, opts) => {
      const key = args.join(' ')
      calls.push(key)
      const entry = script[key]
      if (entry === undefined) throw new Error(`unscripted claude ${key}`)
      return typeof entry === 'function' ? entry({ args, timeoutMs: opts.timeoutMs }) : entry
    },
    fs: world.fs,
    home: world.home,
    configDir: world.configDir,
    platform: 'linux',
    now,
    sleep: async (ms) => {
      sleeps.push(ms)
    },
    staggerMs: 10_000,
    verifyTimeoutMs: 500,
    timeoutsMs: { network: 2_000, list: 1_000, restart: 500 },
    agents: [{ assistantId: '912', cwd: '/home/kc/hoai-agents/912' }],
    restartAgent: async (agent, opts) => {
      restarts.push({ id: agent.assistantId, via: opts.via, at: opts.restartedAtMs })
      return { ok: true, how: opts.via ?? 'marker' }
    },
    verifyAgent: async (agent, opts) => {
      verifies.push({ id: agent.assistantId, since: opts.restartedAtMs })
      return { ok: true, evidence: 'channel-live.json newer than restart' }
    },
    log: () => {},
    ...over,
  }
  return { deps, calls, sleeps, restarts, verifies }
}

const agentState = (id: string, over: Record<string, unknown> = {}) => ({
  assistantId: id,
  cwd: `/home/kc/hoai-agents/${id}`,
  supervisor: 'launcher-live',
  recipe: true,
  running: true,
  ...over,
})

/** A marketplace machine with 0.38.1 installed and 0.38.3 declared. */
function updateState(world: World, over: Record<string, unknown> = {}): MachineState {
  return {
    platform: 'linux',
    installMethod: 'marketplace',
    runningVersion: '0.38.1',
    marketplace: { registered: true, latestVersion: '0.38.3' },
    installed: { present: true, version: '0.38.1', installPath: world.installPathFor('0.38.1') },
    autoUpdateEnabled: true,
    rollbackLatched: false,
    agents: [agentState('912')],
    intent: 'update',
    ...over,
  } as MachineState
}

/** Seed the world for updateState() and return its plan. */
function seededUpdate(world: World, over: Record<string, unknown> = {}) {
  world.seedMarketplace('0.38.3')
  world.seedInstalled('0.38.1')
  const plan = planMachine(updateState(world, over))
  assert.equal(plan.verdict, 'plan')
  return plan
}

// -- Pure helpers ------------------------------------------------------------

test('joinLike / dirnameLike keep the base path separator style', () => {
  assert.equal(joinLike('/home/kc', '.local', 'bin', 'hoai'), '/home/kc/.local/bin/hoai')
  assert.equal(joinLike('C:\\Users\\kc', '.bgos-agent', 'watcher/rollback'), 'C:\\Users\\kc\\.bgos-agent\\watcher\\rollback')
  assert.equal(dirnameLike('/home/kc/.local/bin/hoai'), '/home/kc/.local/bin')
  assert.equal(dirnameLike('C:\\Users\\kc\\x.txt'), 'C:\\Users\\kc')
  assert.equal(dirnameLike('/a'), '/')
})

test('pathWithin / samePath: segment based, mixed separators, win32 case folding, never a prefix collision', () => {
  const cache = '/home/kc/.claude/plugins/cache/hoai/hoai'
  assert.equal(pathWithin(`${cache}/0.38.3`, cache), true)
  assert.equal(pathWithin(cache, cache), false)
  assert.equal(pathWithin('/home/kc/.claude/plugins/cache/hoai/hoaiX/0.38.3', cache), false)
  assert.equal(pathWithin('/home/kc/bgos-claude-plugin', cache), false)
  assert.equal(pathWithin('c:/users/KC/.claude/plugins/cache/hoai/hoai/0.38.3', 'C:\\Users\\kc\\.claude\\plugins\\cache\\hoai\\hoai'), true)
  assert.equal(samePath('C:\\Users\\kc\\x', 'c:/users/kc/x/'), true)
  assert.equal(samePath('/home/kc/x', '/home/kc/X'), false)
})

test('scrubDetail: home becomes ~ in either separator style, 32+ char tokens are redacted, output is capped', () => {
  const token = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEF'
  assert.equal(
    scrubDetail(`token ${token} at /home/kc/.claude/x and /home/kc\\y`, '/home/kc'),
    'token <redacted> at ~/.claude/x and ~\\y',
  )
  assert.equal(scrubDetail('C:/Users/KC/AppData x C:\\Users\\kc\\.claude', 'C:\\Users\\kc'), '~/AppData x ~\\.claude')
  assert.equal(scrubDetail('word '.repeat(100), '/home/kc', 300).length, 300)
  assert.equal(scrubDetail('a'.repeat(400), '/home/kc'), '<redacted>', 'one long token is redacted before the cap')
  assert.equal(scrubDetail('\u001b[31mred\u001b[0m  and\u0007bell', '/home/kc'), 'red andbell')
  assert.equal(scrubDetail('short-token-0123456789', '/home/kc'), 'short-token-0123456789')
})

test('withDeadline: the effect wins when it settles first, the deadline wins when it hangs, and throws become errors', async () => {
  const timers = { setTimeout, clearTimeout }
  assert.deepEqual(await withDeadline(() => Promise.resolve(7), 50, timers), { timedOut: false, value: 7 })
  assert.deepEqual(await withDeadline(() => new Promise(() => {}), 10, timers), { timedOut: true })
  const thrown = await withDeadline(
    () => {
      throw new Error('boom')
    },
    50,
    timers,
  )
  assert.equal(thrown.timedOut, false)
  assert.equal((thrown as { error: Error }).error.message, 'boom')
})

test('snapshotStamp is filename safe and sorts chronologically', () => {
  const a = snapshotStamp(Date.UTC(2026, 7, 25, 1, 2, 3, 456))
  assert.equal(a, '2026-08-25T01-02-03-456Z')
  assert.ok(snapshotStamp(Date.UTC(2026, 7, 25, 1, 2, 4, 0)) > a)
})

// -- Verdicts without steps --------------------------------------------------

test('a blocked plan returns verdict blocked with the planner reason and calls nothing', async () => {
  const world = memWorld()
  const { deps, calls } = memDeps(world, {})
  const plan = planMachine(updateState(world, { rollbackLatched: true }))
  const { events, report } = recorder()
  const result = await executePlan(plan, deps, report)
  assert.equal(result.ok, false)
  assert.equal(result.verdict, 'blocked')
  assert.equal(result.reason, 'rollback_latched')
  assert.deepEqual(result.steps, [])
  assert.deepEqual(calls, [])
  assert.deepEqual(events, [])
})

test('a nothing_to_do plan runs no steps and is ok', async () => {
  const world = memWorld()
  const { deps, calls } = memDeps(world, {})
  const plan = planMachine(updateState(world, { runningVersion: '0.38.3', installed: { present: true, version: '0.38.3', installPath: world.installPathFor('0.38.3') } }))
  assert.equal(plan.verdict, 'nothing_to_do')
  const result = await executePlan(plan, deps)
  assert.equal(result.ok, true)
  assert.equal(result.verdict, 'nothing_to_do')
  assert.deepEqual(calls, [])
})

test('missing cli or fs dependencies block the run instead of throwing', async () => {
  const plan: Plan = { verdict: 'plan', targetVersion: '0.38.3', steps: [{ id: 's01-refresh_marketplace', kind: 'refresh_marketplace', onFailure: 'stop', why: 'x' }] }
  const result = await executePlan(plan, {} as Deps)
  assert.equal(result.verdict, 'blocked')
  assert.equal(result.reason, 'missing_dependencies')
})

// -- The update path -----------------------------------------------------------

test('update ok: refresh, snapshot, update, verify, restart, verify all ok; snapshot on disk; alias untouched when absent', async () => {
  const world = memWorld()
  const plan = seededUpdate(world)
  const { deps, calls, restarts, verifies, sleeps } = memDeps(world, realisticScript(world, '0.38.3'))
  const { events, report } = recorder()
  const before = { ...Object.fromEntries(world.files) }

  const result = await executePlan(plan, deps, report)

  assert.equal(result.verdict, 'done', stepView(result.steps).join(' | '))
  assert.equal(result.ok, true)
  assert.equal(result.rolledBack, false)
  assert.equal(result.failedStep, null)
  assert.equal(result.targetVersion, '0.38.3')
  assert.equal(result.installedVersion, '0.38.3')
  assert.deepEqual(stepView(result.steps), [
    's01-refresh_marketplace:ok:updated',
    's02-snapshot:ok:recorded',
    's03-update_plugin:ok:updated',
    's04-verify_installed:ok:verified',
    's05-restart_agent-912:ok:restarted',
    's06-verify_agent-912:ok:live',
  ])
  assert.deepEqual(calls, [KEY.refresh, KEY.update, KEY.list])
  assert.deepEqual(sleeps, [], 'a single agent never waits')
  assert.equal(restarts.length, 1)
  assert.equal(restarts[0].via, 'marker')
  assert.equal(verifies[0].since, restarts[0].at)
  assert.ok(stepById(result, 's04-verify_installed').detail?.includes('source:list'))
  assert.ok(stepById(result, 's04-verify_installed').detail?.includes('alias:absent'))
  assert.equal(world.installedVersion(), '0.38.3')

  // Snapshot: the three files copied byte for byte plus the record.
  const root = rollbackRootFor(world.home)
  const stamps = world.fs.readdir(root)
  assert.equal(stamps.length, 1)
  const dir = joinLike(root, stamps[0])
  const record = JSON.parse(world.files.get(joinLike(dir, SNAPSHOT_FILE))!)
  assert.equal(record.version, '0.38.1')
  assert.equal(record.installPath, world.installPathFor('0.38.1'))
  assert.deepEqual(record.files.map((f: { name: string; absent: boolean }) => [f.name, f.absent]), [
    ['installed_plugins.json', false],
    ['settings.json', false],
    ['known_marketplaces.json', false],
  ])
  assert.equal(world.files.get(joinLike(dir, 'installed_plugins.json')), before[world.paths.installedPlugins])
  assert.equal(world.files.get(joinLike(dir, 'settings.json')), before[world.paths.settings])

  // Every step's startedAt / endedAt comes from the injected clock.
  for (const step of result.steps) {
    assert.ok(step.startedAt >= 1_700_000_000_000)
    assert.ok(step.endedAt !== null && step.endedAt >= step.startedAt)
  }
  // Report contract: 'running' first, then the terminal state, for every step.
  assert.equal(events[0].id, 's01-refresh_marketplace')
  assert.equal(events[0].payload.state, 'running')
})

test('a report callback that throws never derails the run, and the returned steps equal what was reported', async () => {
  const run = async (report: (id: string, payload: ReportPayload) => Promise<void>) => {
    const world = memWorld()
    const plan = seededUpdate(world)
    const { deps } = memDeps(world, realisticScript(world, '0.38.3'))
    return executePlan(plan, deps, report)
  }
  let throws = 0
  const thrower = async () => {
    throws += 1
    throw new Error('sink is down')
  }
  const { events, report } = recorder()
  const [withThrower, withRecorder] = await Promise.all([run(thrower), run(report)])
  assert.ok(throws >= 12, `report was called ${throws} times`)
  assert.deepEqual(stepView(withThrower.steps), stepView(withRecorder.steps))
  assert.equal(withThrower.verdict, 'done')

  const { order, last } = lastReported(events)
  assert.deepEqual(order, withRecorder.steps.map((s) => s.id))
  for (const step of withRecorder.steps) {
    const payload = last.get(step.id)!
    assert.equal(payload.state, step.state, step.id)
    assert.equal(payload.message, step.message, step.id)
    assert.equal(payload.detail, step.detail, step.id)
  }
})

test('update rc1 -> inline reinstall recovers -> verify ok; detail carries scrubbed stderr, never the home path', async () => {
  const world = memWorld()
  const plan = seededUpdate(world)
  const script = realisticScript(world, '0.38.3', {
    [KEY.update]: OUT.failure(1, `Failed to update plugin "hoai@hoai": cannot write /home/kc/.claude/plugins/cache (token ${'x'.repeat(40)})\n`),
  })
  const { deps, calls } = memDeps(world, script)
  const result = await executePlan(plan, deps)
  assert.equal(result.verdict, 'done', stepView(result.steps).join(' | '))
  assert.deepEqual(stepView(result.steps), [
    's01-refresh_marketplace:ok:updated',
    's02-snapshot:ok:recorded',
    's03-update_plugin:failed:cli_failed:1',
    's03-update_plugin.reinstall:ok:reinstalled',
    's04-verify_installed:ok:verified',
    's05-restart_agent-912:ok:restarted',
    's06-verify_agent-912:ok:live',
  ])
  assert.deepEqual(calls, [KEY.refresh, KEY.update, KEY.uninstall, KEY.install, KEY.list])
  const detail = stepById(result, 's03-update_plugin').detail ?? ''
  assert.ok(detail.includes('~/.claude/plugins/cache'), detail)
  assert.ok(!detail.includes('/home/kc'), detail)
  assert.ok(detail.includes('<redacted>'), detail)
  assert.ok(!detail.includes('x'.repeat(40)), detail)
  assert.equal(result.failedStep, null, 'a recovered ladder is not a failure')
  assert.equal(result.installedVersion, '0.38.3')
})

test('update + reinstall fail -> rollback restores the snapshot byte for byte, failedStep names update_plugin', async () => {
  const world = memWorld()
  const plan = seededUpdate(world)
  const original = {
    installed: world.files.get(world.paths.installedPlugins)!,
    settings: world.files.get(world.paths.settings)!,
    known: world.files.get(world.paths.knownMarketplaces)!,
  }
  const script = realisticScript(world, '0.38.3', {
    [KEY.update]: OUT.failure(1),
    [KEY.install]: OUT.failure(1, 'Failed to install plugin "hoai@hoai": simulated failure\n'),
  })
  const { deps, calls, restarts } = memDeps(world, script)
  const result = await executePlan(plan, deps)
  assert.deepEqual(stepView(result.steps), [
    's01-refresh_marketplace:ok:updated',
    's02-snapshot:ok:recorded',
    's03-update_plugin:failed:cli_failed:1',
    's03-update_plugin.reinstall:failed:cli_failed:1',
    's03-update_plugin.rollback:rolled_back:rolled_back',
    's04-verify_installed:skipped:not_reached',
    's05-restart_agent-912:skipped:not_reached',
    's06-verify_agent-912:skipped:not_reached',
  ])
  assert.equal(result.ok, false)
  assert.equal(result.verdict, 'rolled_back')
  assert.equal(result.rolledBack, true)
  assert.deepEqual(result.failedStep, { id: 's03-update_plugin', kind: 'update_plugin', message: 'update_failed:cli_failed:1' })
  assert.equal(result.installedVersion, '0.38.1')
  assert.deepEqual(calls, [KEY.refresh, KEY.update, KEY.uninstall, KEY.install])
  assert.equal(restarts.length, 0, 'nothing restarted, nothing to bring back')
  assert.equal(world.files.get(world.paths.installedPlugins), original.installed)
  assert.equal(world.files.get(world.paths.settings), original.settings)
  assert.equal(world.files.get(world.paths.knownMarketplaces), original.known)
  assert.ok(stepById(result, 's03-update_plugin.reinstall').detail?.startsWith('install;'))
})

test('rollback is impossible when the snapshot install dir is gone; the run ends failed, not rolled back', async () => {
  const world = memWorld()
  const plan = seededUpdate(world)
  const script = realisticScript(world, '0.38.3', {
    [KEY.update]: OUT.failure(1),
    [KEY.install]: () => {
      // The cache dir of the previous version disappears mid-run.
      world.fs.rm(world.installPathFor('0.38.1'))
      return OUT.failure(1, 'Failed to install plugin "hoai@hoai": simulated failure\n')
    },
  })
  const { deps } = memDeps(world, script)
  const result = await executePlan(plan, deps)
  const rollback = stepById(result, 's03-update_plugin.rollback')
  assert.equal(rollback.state, 'failed')
  assert.equal(rollback.message, 'rollback_impossible')
  assert.equal(rollback.detail, 'install_path_missing')
  assert.equal(result.rolledBack, false)
  assert.equal(result.verdict, 'failed')
  assert.deepEqual(result.failedStep, { id: 's03-update_plugin', kind: 'update_plugin', message: 'update_failed:cli_failed:1' })
  assert.equal(stepById(result, 's04-verify_installed').state, 'skipped')
})

test('rollback is impossible when the snapshot install dir holds a different plugin.json version', async () => {
  const world = memWorld()
  const plan = seededUpdate(world)
  const script = realisticScript(world, '0.38.3', {
    [KEY.update]: OUT.failure(1),
    [KEY.install]: () => {
      world.files.set(joinLike(world.installPathFor('0.38.1'), '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'hoai', version: '0.0.9' }))
      return OUT.failure(1)
    },
  })
  const { deps } = memDeps(world, script)
  const result = await executePlan(plan, deps)
  const rollback = stepById(result, 's03-update_plugin.rollback')
  assert.equal(rollback.message, 'rollback_impossible')
  assert.equal(rollback.detail, 'install_path_version_mismatch:0.0.9')
  assert.equal(result.verdict, 'failed')
})

test('garbage `list --json` falls back to installed_plugins.json for verify_installed', async () => {
  const world = memWorld()
  const plan = seededUpdate(world)
  const script = realisticScript(world, '0.38.3', { [KEY.list]: { code: 0, stdout: '\u0000\u0001 garbage \u00ff', stderr: '' } })
  const { deps } = memDeps(world, script)
  const result = await executePlan(plan, deps)
  assert.equal(result.verdict, 'done', stepView(result.steps).join(' | '))
  const verify = stepById(result, 's04-verify_installed')
  assert.equal(verify.message, 'verified')
  assert.ok(verify.detail?.includes('source:installed_plugins'), verify.detail)
})

test('a "successful" update that lands the wrong version is version_mismatch: ladder once, then an inline re-verify', async () => {
  const world = memWorld()
  const plan = seededUpdate(world)
  const script = realisticScript(world, '0.38.3', {
    [KEY.update]: () => {
      world.seedInstalled('0.0.1')
      return OUT.updated('0.38.1', '0.38.3')
    },
  })
  const { deps, calls } = memDeps(world, script)
  const result = await executePlan(plan, deps)
  assert.deepEqual(stepView(result.steps), [
    's01-refresh_marketplace:ok:updated',
    's02-snapshot:ok:recorded',
    's03-update_plugin:ok:updated',
    's04-verify_installed:failed:version_mismatch',
    's04-verify_installed.reinstall:ok:reinstalled',
    's04-verify_installed.verify:ok:verified',
    's05-restart_agent-912:ok:restarted',
    's06-verify_agent-912:ok:live',
  ])
  assert.equal(result.verdict, 'done')
  assert.equal(stepById(result, 's04-verify_installed').detail, 'installed:0.0.1;target:0.38.3;source:list')
  assert.deepEqual(calls, [KEY.refresh, KEY.update, KEY.list, KEY.uninstall, KEY.install, KEY.list])
})

test('the ladder runs once per run: a mismatch after the inline reinstall goes straight to rollback', async () => {
  const world = memWorld()
  const plan = seededUpdate(world)
  const script = realisticScript(world, '0.38.3', {
    [KEY.update]: OUT.failure(1),
    [KEY.install]: () => {
      world.seedInstalled('0.0.1')
      return OUT.installed
    },
  })
  const { deps, calls } = memDeps(world, script)
  const result = await executePlan(plan, deps)
  assert.deepEqual(stepView(result.steps).slice(2, 5), [
    's03-update_plugin:failed:cli_failed:1',
    's03-update_plugin.reinstall:failed:version_mismatch',
    's03-update_plugin.rollback:rolled_back:rolled_back',
  ])
  assert.equal(result.verdict, 'rolled_back')
  assert.deepEqual(calls, [KEY.refresh, KEY.update, KEY.uninstall, KEY.install])
  assert.equal(world.installedVersion(), '0.38.1')
})

test('update already_latest: ok when the files already show the target, version_mismatch (ladder) otherwise', async () => {
  const okWorld = memWorld()
  okWorld.seedMarketplace('0.38.3')
  okWorld.seedInstalled('0.38.3')
  const okPlan: Plan = { verdict: 'plan', targetVersion: '0.38.3', steps: [{ id: 's01-update_plugin', kind: 'update_plugin', onFailure: 'escalate', why: 'x' }] }
  const ok = memDeps(okWorld, { [KEY.update]: OUT.alreadyLatest('0.38.3') })
  const okResult = await executePlan(okPlan, ok.deps)
  assert.deepEqual(stepView(okResult.steps), ['s01-update_plugin:ok:already_latest'])
  assert.equal(okResult.installedVersion, '0.38.3')

  const world = memWorld()
  const plan = seededUpdate(world)
  const script = realisticScript(world, '0.38.3', { [KEY.update]: OUT.alreadyLatest('0.38.1') })
  const { deps } = memDeps(world, script)
  const result = await executePlan(plan, deps)
  assert.deepEqual(stepView(result.steps).slice(2, 5), [
    's03-update_plugin:failed:version_mismatch',
    's03-update_plugin.reinstall:ok:reinstalled',
    's04-verify_installed:ok:verified',
  ])
  assert.equal(result.verdict, 'done')
})

test('a hanging CLI call ends with the token timeout (the ladder then recovers)', async () => {
  const world = memWorld()
  const plan = seededUpdate(world)
  const script = realisticScript(world, '0.38.3', { [KEY.update]: () => new Promise<CliOut>(() => {}) })
  const { deps, calls } = memDeps(world, script, { timeoutsMs: { network: 20, list: 20, restart: 20 } })
  const started = Date.now()
  const result = await executePlan(plan, deps)
  assert.ok(Date.now() - started < 2_000, 'the deadline is the budget plus a bounded grace')
  const update = stepById(result, 's03-update_plugin')
  assert.equal(update.state, 'failed')
  assert.equal(update.message, 'timeout')
  assert.equal(update.detail, 'timeout:20ms')
  assert.equal(calls.filter((c) => c === KEY.update).length, 1)
  assert.equal(stepById(result, 's03-update_plugin.reinstall').state, 'ok')
  assert.equal(result.verdict, 'done')
})

test('a runner that reports timedOut itself is the same timeout token', async () => {
  const world = memWorld()
  const plan = seededUpdate(world)
  const script = realisticScript(world, '0.38.3', { [KEY.update]: { code: null, stdout: '', stderr: '', timedOut: true } })
  const { deps } = memDeps(world, script)
  const result = await executePlan(plan, deps)
  assert.equal(stepById(result, 's03-update_plugin').message, 'timeout')
})

test('the cli receives the budget for each command: 180s network, 30s list by default', async () => {
  const world = memWorld()
  const plan = seededUpdate(world)
  const budgets: Record<string, number> = {}
  const script = realisticScript(world, '0.38.3')
  const { deps } = memDeps(world, script, { timeoutsMs: undefined })
  const cli = deps.cli
  deps.cli = (args, opts) => {
    budgets[args.join(' ')] = opts.timeoutMs
    return cli(args, opts)
  }
  await executePlan(plan, deps)
  assert.equal(budgets[KEY.update], 180_000)
  assert.equal(budgets[KEY.refresh], 180_000)
  assert.equal(budgets[KEY.list], 30_000)
})

// -- Fresh install and the marketplace steps ---------------------------------

test('converge from nothing: register, refresh (learns the target), snapshot with absent files, install, verify, restart, verify', async () => {
  const world = memWorld()
  const state = updateState(world, {
    runningVersion: null,
    marketplace: { registered: false, latestVersion: null },
    installed: { present: false, version: null, installPath: null },
  })
  const plan = planMachine(state)
  assert.equal(plan.targetVersion, null, 'the planner never guesses')
  const { deps, calls } = memDeps(world, realisticScript(world, '0.38.3'))
  const result = await executePlan(plan, deps)
  assert.deepEqual(stepView(result.steps), [
    's01-register_marketplace:ok:registered',
    's02-refresh_marketplace:ok:updated',
    's03-snapshot:ok:recorded',
    's04-install_plugin:ok:installed',
    's05-verify_installed:ok:verified',
    's06-restart_agent-912:ok:restarted',
    's07-verify_agent-912:ok:live',
  ])
  assert.equal(result.targetVersion, '0.38.3', 'learned from marketplace.json at refresh')
  assert.equal(result.installedVersion, '0.38.3')
  assert.deepEqual(calls, [KEY.add, KEY.refresh, KEY.install, KEY.list])
  assert.equal(stepById(result, 's02-refresh_marketplace').detail, 'latest:0.38.3')
  const root = rollbackRootFor(world.home)
  const record = JSON.parse(world.files.get(joinLike(root, world.fs.readdir(root)[0], SNAPSHOT_FILE))!)
  assert.equal(record.installPath, null)
  assert.deepEqual(record.files.map((f: { name: string; absent: boolean }) => [f.name, f.absent]), [
    ['installed_plugins.json', true],
    ['settings.json', false],
    ['known_marketplaces.json', false],
  ])
})

test('a fresh install that fails and cannot be repaired rolls back to "nothing installed" (the absent file is removed again)', async () => {
  const world = memWorld()
  world.seedMarketplace('0.38.3')
  const plan = planMachine(updateState(world, { runningVersion: null, installed: { present: false, version: null, installPath: null } }))
  const script = realisticScript(world, '0.38.3', {
    [KEY.install]: () => {
      world.seedInstalled('0.38.3')
      return OUT.failure(1, 'Failed to install plugin "hoai@hoai": half written\n')
    },
  })
  const { deps } = memDeps(world, script)
  const result = await executePlan(plan, deps)
  assert.equal(result.verdict, 'rolled_back', stepView(result.steps).join(' | '))
  assert.deepEqual(result.failedStep, { id: 's03-install_plugin', kind: 'install_plugin', message: 'install_failed:cli_failed:1' })
  assert.equal(world.files.has(world.paths.installedPlugins), false, 'restored to absent')
  assert.ok(stepById(result, 's03-install_plugin.rollback').detail?.includes('installed_plugins.json(removed)'))
})

test('register_marketplace failure stops the run with cli_failed:<rc> and skips the rest', async () => {
  const world = memWorld()
  const plan = planMachine(updateState(world, { marketplace: { registered: false, latestVersion: null }, installed: { present: false, version: null, installPath: null } }))
  const { deps } = memDeps(world, { [KEY.add]: OUT.failure(2, 'Failed to add marketplace: network unreachable\n') })
  const result = await executePlan(plan, deps)
  assert.equal(result.verdict, 'failed')
  assert.deepEqual(result.failedStep, { id: 's01-register_marketplace', kind: 'register_marketplace', message: 'cli_failed:2' })
  assert.ok(result.steps.slice(1).every((s) => s.state === 'skipped' && s.message === 'not_reached'))
})

test('refresh_marketplace failure is ok-with-warning when the target is known, marketplace_latest_unknown when it is not', async () => {
  const known = memWorld()
  const knownPlan = seededUpdate(known)
  const knownRun = memDeps(known, realisticScript(known, '0.38.3', { [KEY.refresh]: OUT.failure(1, 'Failed to update marketplace "hoai": offline\n') }))
  const knownResult = await executePlan(knownPlan, knownRun.deps)
  assert.equal(knownResult.verdict, 'done')
  const refresh = stepById(knownResult, 's01-refresh_marketplace')
  assert.equal(refresh.state, 'ok')
  assert.equal(refresh.message, 'refresh_failed')
  assert.ok(refresh.detail?.startsWith('cli_failed:1;'))

  const unknown = memWorld()
  unknown.seedMarketplace('0.38.3')
  unknown.seedInstalled('0.38.1')
  unknown.files.delete(unknown.paths.marketplaceJson)
  const unknownPlan = planMachine(updateState(unknown, { marketplace: { registered: true, latestVersion: null } }))
  assert.deepEqual(
    unknownPlan.steps.map((s) => s.kind),
    ['refresh_marketplace', 'verify_installed'],
  )
  const unknownRun = memDeps(unknown, realisticScript(unknown, '0.38.3'))
  const unknownResult = await executePlan(unknownPlan, unknownRun.deps)
  assert.equal(unknownResult.verdict, 'failed')
  assert.deepEqual(unknownResult.failedStep, { id: 's01-refresh_marketplace', kind: 'refresh_marketplace', message: 'marketplace_latest_unknown' })
  assert.equal(stepById(unknownResult, 's02-verify_installed').state, 'skipped')
})

test('marketplace missing but the plugin present: register, refresh learns the target, verify passes with no mutation and no snapshot', async () => {
  const world = memWorld()
  world.seedInstalled('0.38.3')
  const plan = planMachine(
    updateState(world, {
      runningVersion: '0.38.3',
      marketplace: { registered: false, latestVersion: null },
      installed: { present: true, version: '0.38.3', installPath: world.installPathFor('0.38.3') },
    }),
  )
  const { deps, calls } = memDeps(world, realisticScript(world, '0.38.3'))
  const result = await executePlan(plan, deps)
  assert.deepEqual(stepView(result.steps), ['s01-register_marketplace:ok:registered', 's02-refresh_marketplace:ok:updated', 's03-verify_installed:ok:verified'])
  assert.deepEqual(calls, [KEY.add, KEY.refresh, KEY.list])
  assert.equal(result.verdict, 'done')
  assert.equal(world.fs.readdir(rollbackRootFor(world.home)).length, 0)
})

test('snapshots are pruned to the newest three', async () => {
  const world = memWorld()
  const root = rollbackRootFor(world.home)
  for (const stamp of ['2026-08-01T00-00-00-000Z', '2026-08-02T00-00-00-000Z', '2026-08-03T00-00-00-000Z', 'not-a-snapshot']) {
    world.files.set(joinLike(root, stamp, SNAPSHOT_FILE), '{}')
  }
  const plan = seededUpdate(world)
  const { deps } = memDeps(world, realisticScript(world, '0.38.3'))
  await executePlan(plan, deps)
  const names = world.fs.readdir(root).sort()
  assert.equal(names.length, SNAPSHOTS_TO_KEEP + 1)
  assert.ok(!names.includes('2026-08-01T00-00-00-000Z'))
  assert.ok(names.includes('2026-08-02T00-00-00-000Z'))
  assert.ok(names.includes('not-a-snapshot'), 'foreign entries are never touched')
})

test('repair intent: the plan-level reinstall_plugin runs uninstall + install and a failure rolls back directly (no second ladder)', async () => {
  const world = memWorld()
  world.seedMarketplace('0.38.3')
  world.seedInstalled('0.38.3')
  const plan = planMachine(updateState(world, { intent: 'repair', runningVersion: '0.38.3', installed: { present: true, version: '0.38.3', installPath: world.installPathFor('0.38.3') } }))
  assert.equal(plan.steps[2].kind, 'reinstall_plugin')
  const okRun = memDeps(world, realisticScript(world, '0.38.3'))
  const okResult = await executePlan(plan, okRun.deps)
  assert.equal(okResult.verdict, 'done', stepView(okResult.steps).join(' | '))
  assert.equal(stepById(okResult, 's03-reinstall_plugin').detail, 'uninstall:uninstalled;install:installed;version:0.38.3')
  assert.deepEqual(okRun.calls, [KEY.refresh, KEY.uninstall, KEY.install, KEY.list])

  const failWorld = memWorld()
  failWorld.seedMarketplace('0.38.3')
  failWorld.seedInstalled('0.38.3')
  const failRun = memDeps(failWorld, realisticScript(failWorld, '0.38.3', { [KEY.install]: OUT.failure(1) }))
  const failResult = await executePlan(plan, failRun.deps)
  assert.deepEqual(stepView(failResult.steps).slice(2, 4), ['s03-reinstall_plugin:failed:cli_failed:1', 's03-reinstall_plugin.rollback:rolled_back:rolled_back'])
  assert.deepEqual(failResult.failedStep, { id: 's03-reinstall_plugin', kind: 'reinstall_plugin', message: 'reinstall_failed:cli_failed:1' })
  assert.deepEqual(failRun.calls, [KEY.refresh, KEY.uninstall, KEY.install], 'exactly one reinstall attempt')
  assert.equal(failWorld.installedVersion(), '0.38.3', 'restored')
})

// -- Agents ------------------------------------------------------------------

test('six agents restart in ascending id order with a stagger sleep between each pair, and each verify uses its own restart time', async () => {
  const world = memWorld()
  const ids = ['918', '7', '300', '55', '1001', '912']
  const plan = seededUpdate(world, { agents: ids.map((id) => agentState(id)) })
  const { deps, sleeps, restarts, verifies } = memDeps(world, realisticScript(world, '0.38.3'), {
    agents: ids.map((id) => ({ assistantId: id, cwd: `/home/kc/hoai-agents/${id}` })),
    staggerMs: 7_500,
  })
  const result = await executePlan(plan, deps)
  assert.equal(result.verdict, 'done', stepView(result.steps).join(' | '))
  assert.deepEqual(restarts.map((r) => r.id), ['7', '55', '300', '912', '918', '1001'])
  assert.deepEqual(sleeps, [7_500, 7_500, 7_500, 7_500, 7_500])
  assert.equal(verifies.length, 6)
  for (let i = 0; i < 6; i++) {
    assert.equal(verifies[i].id, restarts[i].id)
    assert.equal(verifies[i].since, restarts[i].at, 'verify is scoped to this agent restart')
  }
  assert.deepEqual(
    result.steps.filter((s) => s.kind === 'restart_agent').map((s) => s.target),
    ['7', '55', '300', '912', '918', '1001'],
  )
})

test('verify_agent fails -> rollback + one retry on the restored version -> later agents restart on it -> rolled_back; alias re-pointed', async () => {
  const world = memWorld()
  const plan = seededUpdate(world, { agents: [agentState('912'), agentState('918')], refreshWatcher: true })
  assert.equal(plan.steps.at(-1)?.kind, 'refresh_watcher')
  const link = aliasSymlinkPath(world.home)
  world.links.set(link, joinLike(world.installPathFor('0.38.1'), 'bin', 'hoai'))
  let verify912 = 0
  const { deps, restarts, verifies } = memDeps(world, realisticScript(world, '0.38.3'), {
    agents: [
      { assistantId: '912', cwd: '/home/kc/hoai-agents/912' },
      { assistantId: '918', cwd: '/home/kc/hoai-agents/918' },
    ],
    verifyAgent: async (agent, opts) => {
      verifies.push({ id: agent.assistantId, since: opts.restartedAtMs })
      if (agent.assistantId === '912') {
        verify912 += 1
        return verify912 === 1 ? { ok: false, message: 'no channel-live marker newer than restart' } : { ok: true, evidence: 'marker' }
      }
      return { ok: true, evidence: 'marker' }
    },
  })
  const result = await executePlan(plan, deps)
  assert.deepEqual(stepView(result.steps), [
    's01-refresh_marketplace:ok:updated',
    's02-snapshot:ok:recorded',
    's03-update_plugin:ok:updated',
    's04-verify_installed:ok:verified',
    's05-restart_agent-912:ok:restarted',
    's06-verify_agent-912:failed:agent_deaf_after_update',
    's06-verify_agent-912.rollback:rolled_back:rolled_back',
    's06-verify_agent-912.retry:ok:live',
    's07-restart_agent-918:ok:restarted',
    's08-verify_agent-918:ok:live',
    's09-refresh_watcher:skipped:rolled_back',
  ])
  assert.equal(result.ok, false)
  assert.equal(result.verdict, 'rolled_back')
  assert.equal(result.rolledBack, true)
  assert.deepEqual(result.failedStep, { id: 's06-verify_agent-912', kind: 'verify_agent', target: '912', message: 'agent_deaf_after_update' })
  assert.equal(result.installedVersion, '0.38.1')
  assert.equal(world.installedVersion(), '0.38.1', 'files restored')
  assert.deepEqual(restarts.map((r) => r.id), ['912', '912', '918'])
  assert.equal(verifies[1].since, restarts[1].at, 'the retry verifies against the retry restart time')
  assert.equal(stepById(result, 's06-verify_agent-912').detail, 'no channel-live marker newer than restart')
  // The alias followed the install forward at verify and back at rollback.
  assert.equal(world.links.get(link), joinLike(world.installPathFor('0.38.1'), 'bin', 'hoai'))
  assert.ok(stepById(result, 's04-verify_installed').detail?.includes('alias:symlink_updated'))
  assert.ok(stepById(result, 's06-verify_agent-912.rollback').detail?.includes('alias:symlink_updated'))
})

test('a second deaf agent after the rollback does not roll back twice; the first deaf agent stays the named cause', async () => {
  const world = memWorld()
  const plan = seededUpdate(world, { agents: [agentState('912'), agentState('918')] })
  const { deps, restarts } = memDeps(world, realisticScript(world, '0.38.3'), {
    agents: [
      { assistantId: '912', cwd: null },
      { assistantId: '918', cwd: null },
    ],
    verifyAgent: async () => ({ ok: false, message: 'deaf' }),
  })
  const result = await executePlan(plan, deps)
  assert.deepEqual(stepView(result.steps).slice(5), [
    's06-verify_agent-912:failed:agent_deaf_after_update',
    's06-verify_agent-912.rollback:rolled_back:rolled_back',
    's06-verify_agent-912.retry:failed:agent_deaf_after_rollback',
    's07-restart_agent-918:ok:restarted',
    's08-verify_agent-918:failed:agent_deaf_after_update',
  ])
  assert.equal(result.steps.filter((s) => s.kind === 'rollback').length, 1)
  assert.equal(result.failedStep?.target, '912')
  assert.deepEqual(restarts.map((r) => r.id), ['912', '912', '918'])
  assert.equal(result.verdict, 'rolled_back')
})

test('verify_agent failure with no snapshot is rollback_impossible and aborts the run', async () => {
  const world = memWorld()
  world.seedMarketplace('0.38.3')
  world.seedInstalled('0.38.3')
  const plan: Plan = {
    verdict: 'plan',
    targetVersion: '0.38.3',
    steps: [
      { id: 's01-restart_agent-912', kind: 'restart_agent', target: '912', via: 'marker', onFailure: 'continue', why: 'x' },
      { id: 's02-verify_agent-912', kind: 'verify_agent', target: '912', onFailure: 'rollback', why: 'x' },
      { id: 's03-restart_agent-918', kind: 'restart_agent', target: '918', via: 'marker', onFailure: 'continue', why: 'x' },
      { id: 's04-verify_agent-918', kind: 'verify_agent', target: '918', onFailure: 'rollback', why: 'x' },
    ],
  }
  const { deps, restarts } = memDeps(world, {}, { verifyAgent: async () => ({ ok: false }) })
  const result = await executePlan(plan, deps)
  assert.deepEqual(stepView(result.steps), [
    's01-restart_agent-912:ok:restarted',
    's02-verify_agent-912:failed:agent_deaf_after_update',
    's02-verify_agent-912.rollback:failed:rollback_impossible',
    's03-restart_agent-918:skipped:not_reached',
    's04-verify_agent-918:skipped:not_reached',
  ])
  assert.equal(stepById(result, 's02-verify_agent-912.rollback').detail, 'no_snapshot')
  assert.equal(result.verdict, 'failed')
  assert.equal(result.rolledBack, false)
  assert.deepEqual(restarts.map((r) => r.id), ['912'], 'no retry without a restore')
})

test('verify_agent failure on a restart-only run (policy continue) is agent_deaf_after_restart, no rollback, run failed, others continue', async () => {
  const world = memWorld()
  world.seedMarketplace('0.38.3')
  world.seedInstalled('0.38.3')
  const plan = planMachine(
    updateState(world, {
      intent: 'restart_only',
      runningVersion: '0.38.3',
      installed: { present: true, version: '0.38.3', installPath: world.installPathFor('0.38.3') },
      agents: [agentState('912'), agentState('918')],
    }),
  )
  assert.deepEqual(
    plan.steps.map((s) => `${s.kind}:${s.onFailure}`),
    ['restart_agent:continue', 'verify_agent:continue', 'restart_agent:continue', 'verify_agent:continue'],
  )
  const { deps, restarts } = memDeps(world, {}, {
    verifyAgent: async (agent) => (agent.assistantId === '912' ? { ok: false } : { ok: true, evidence: 'marker' }),
  })
  const result = await executePlan(plan, deps)
  assert.deepEqual(stepView(result.steps), [
    's01-restart_agent-912:ok:restarted',
    's02-verify_agent-912:failed:agent_deaf_after_restart',
    's03-restart_agent-918:ok:restarted',
    's04-verify_agent-918:ok:live',
  ])
  assert.equal(result.verdict, 'failed')
  assert.equal(result.rolledBack, false)
  assert.deepEqual(result.failedStep, { id: 's02-verify_agent-912', kind: 'verify_agent', target: '912', message: 'agent_deaf_after_restart' })
  assert.deepEqual(restarts.map((r) => r.id), ['912', '918'])
})

test('a failed restart skips that agent verify (restart_failed), the others continue, the run is failed', async () => {
  const world = memWorld()
  const plan = seededUpdate(world, { agents: [agentState('912'), agentState('918')] })
  const { deps } = memDeps(world, realisticScript(world, '0.38.3'), {
    restartAgent: async (agent) => (agent.assistantId === '912' ? { ok: false, how: 'marker', message: 'marker write failed: EACCES /home/kc/.bgos-agent/912' } : { ok: true, how: 'marker' }),
  })
  const result = await executePlan(plan, deps)
  assert.deepEqual(stepView(result.steps).slice(4), [
    's05-restart_agent-912:failed:restart_failed',
    's06-verify_agent-912:skipped:restart_failed',
    's07-restart_agent-918:ok:restarted',
    's08-verify_agent-918:ok:live',
  ])
  assert.equal(stepById(result, 's05-restart_agent-912').detail, 'marker;marker write failed: EACCES ~/.bgos-agent/912')
  assert.equal(result.verdict, 'failed')
  assert.equal(result.rolledBack, false)
  assert.deepEqual(result.failedStep, { id: 's05-restart_agent-912', kind: 'restart_agent', target: '912', message: 'restart_failed' })
})

test('a hanging restartAgent is a timeout; a throwing verifyAgent is a deaf agent with the error in detail', async () => {
  const world = memWorld()
  const plan = seededUpdate(world, { agents: [agentState('912'), agentState('918')] })
  const { deps } = memDeps(world, realisticScript(world, '0.38.3'), {
    timeoutsMs: { network: 2_000, list: 1_000, restart: 20 },
    restartAgent: async (agent) => (agent.assistantId === '912' ? new Promise(() => {}) : { ok: true, how: 'marker' }),
    verifyAgent: async (agent) => {
      if (agent.assistantId === '918') throw new Error('marker unreadable at /home/kc/.bgos-plugin-state/918')
      return { ok: true }
    },
  })
  const result = await executePlan(plan, deps)
  assert.equal(stepById(result, 's05-restart_agent-912').message, 'timeout')
  assert.equal(stepById(result, 's05-restart_agent-912').detail, 'timeout:20ms')
  const deaf = stepById(result, 's08-verify_agent-918')
  assert.equal(deaf.message, 'agent_deaf_after_update')
  assert.equal(deaf.detail, 'marker unreadable at ~/.bgos-plugin-state/918')
  assert.equal(result.verdict, 'rolled_back')
})

test('manual_restart_required is skipped (never fails the run), stage_pending_restart is ok/staged, refresh_watcher is ok/deferred', async () => {
  const world = memWorld()
  const plan = seededUpdate(world, {
    agents: [agentState('912', { supervisor: 'none', recipe: false }), agentState('918', { supervisor: 'none', recipe: true, cwd: null })],
    refreshWatcher: true,
  })
  assert.deepEqual(
    plan.steps.map((s) => s.kind).slice(4),
    ['manual_restart_required', 'manual_restart_required', 'stage_pending_restart', 'refresh_watcher'],
  )
  const { deps, restarts } = memDeps(world, realisticScript(world, '0.38.3'))
  const result = await executePlan(plan, deps)
  assert.deepEqual(stepView(result.steps).slice(4), [
    's05-manual_restart_required-912:skipped:manual_restart_required',
    's06-manual_restart_required-918:skipped:manual_restart_required',
    's07-stage_pending_restart:ok:staged',
    's08-refresh_watcher:ok:deferred',
  ])
  assert.equal(stepById(result, 's05-manual_restart_required-912').detail, 'no supervisor and no launch recipe: after install of 0.38.3')
  assert.equal(stepById(result, 's07-stage_pending_restart').detail, 'staged')
  assert.equal(stepById(result, 's08-refresh_watcher').detail, 'deferred')
  assert.equal(result.verdict, 'done')
  assert.equal(result.ok, true)
  assert.equal(restarts.length, 0)
})

test('an unknown step kind fails that step with unknown_step_kind and stops', async () => {
  const world = memWorld()
  const plan = { verdict: 'plan', targetVersion: null, steps: [{ id: 's01-teleport', kind: 'teleport', onFailure: 'continue', why: 'x' }, { id: 's02-refresh_watcher', kind: 'refresh_watcher', onFailure: 'continue', why: 'x' }] } as Plan
  const { deps } = memDeps(world, {})
  const result = await executePlan(plan, deps)
  assert.deepEqual(stepView(result.steps), ['s01-teleport:failed:unknown_step_kind', 's02-refresh_watcher:skipped:not_reached'])
  assert.equal(result.verdict, 'failed')
})

test('an effect that throws unexpectedly becomes internal_error on that step, never an executor throw', async () => {
  const world = memWorld()
  const plan = seededUpdate(world)
  const { deps } = memDeps(world, realisticScript(world, '0.38.3'), {
    fs: { ...world.fs, readdir: () => { throw new Error('EIO /home/kc/.bgos-agent') } },
  })
  // pruneSnapshots swallows readdir errors; make the snapshot itself fail instead.
  deps.fs = { ...world.fs, mkdir: () => { throw new Error('EROFS /home/kc/.bgos-agent') } }
  const result = await executePlan(plan, deps)
  const snapshot = stepById(result, 's02-snapshot')
  assert.equal(snapshot.state, 'failed')
  assert.equal(snapshot.message, 'snapshot_failed')
  assert.equal(snapshot.detail, 'EROFS ~/.bgos-agent')
  assert.equal(result.verdict, 'failed')
  assert.deepEqual(result.failedStep, { id: 's02-snapshot', kind: 'snapshot', message: 'snapshot_failed' })
  assert.equal(stepById(result, 's03-update_plugin').state, 'skipped', 'never mutate without a snapshot')
})

// -- The hoai alias (design 7.3) ----------------------------------------------

test('alias refresh on win32: a breadcrumb into the cache is rewritten (CRLF), a clone breadcrumb is untouched, absent is reported', async () => {
  const home = 'C:\\Users\\kc'
  const localAppData = 'C:\\Users\\kc\\AppData\\Local'
  const run = async (setup: (world: World, crumb: string) => void, over: Partial<Deps> = {}) => {
    const world = memWorld({ home })
    const crumb = aliasBreadcrumbPath(localAppData)
    setup(world, crumb)
    const plan = planMachine(updateState(world, { platform: 'win32', agents: [] }))
    const { deps } = memDeps(world, realisticScript(world, '0.38.3'), { platform: 'win32', localAppData, ...over })
    const result = await executePlan(plan, deps)
    assert.equal(result.verdict, 'done', stepView(result.steps).join(' | '))
    return { world, crumb, detail: stepById(result, 's04-verify_installed').detail ?? '' }
  }
  const updated = await run((world, crumb) => {
    world.seedMarketplace('0.38.3')
    world.seedInstalled('0.38.1')
    world.files.set(crumb, `${world.installPathFor('0.38.1')}\r\n`)
  })
  assert.equal(updated.world.files.get(updated.crumb), `${updated.world.installPathFor('0.38.3')}\r\n`)
  assert.equal(updated.world.installPathFor('0.38.3'), 'C:\\Users\\kc\\.claude\\plugins\\cache\\hoai\\hoai\\0.38.3')
  assert.ok(updated.detail.includes('alias:breadcrumb_updated'), updated.detail)

  const clone = await run((world, crumb) => {
    world.seedMarketplace('0.38.3')
    world.seedInstalled('0.38.1')
    world.files.set(crumb, 'C:\\Users\\kc\\bgos-claude-plugin\r\n')
  })
  assert.equal(clone.world.files.get(clone.crumb), 'C:\\Users\\kc\\bgos-claude-plugin\r\n')
  assert.ok(clone.detail.includes('alias:untouched(clone)'), clone.detail)

  const absent = await run((world) => {
    world.seedMarketplace('0.38.3')
    world.seedInstalled('0.38.1')
  })
  assert.ok(absent.detail.includes('alias:absent'), absent.detail)

  const noAppData = await run(
    (world) => {
      world.seedMarketplace('0.38.3')
      world.seedInstalled('0.38.1')
    },
    { localAppData: null },
  )
  assert.ok(noAppData.detail.includes('alias:skipped(no_local_app_data)'), noAppData.detail)
})

test('alias refresh on posix: a symlink into the cache (absolute or relative) is re-pointed, a clone symlink is untouched', async () => {
  const run = async (target: string | null) => {
    const world = memWorld()
    world.seedMarketplace('0.38.3')
    world.seedInstalled('0.38.1')
    const link = aliasSymlinkPath(world.home)
    if (target) world.links.set(link, target)
    const plan = planMachine(updateState(world, { agents: [] }))
    const { deps } = memDeps(world, realisticScript(world, '0.38.3'))
    const result = await executePlan(plan, deps)
    assert.equal(result.verdict, 'done', stepView(result.steps).join(' | '))
    return { link: world.links.get(link), detail: stepById(result, 's04-verify_installed').detail ?? '' }
  }
  const absolute = await run('/home/kc/.claude/plugins/cache/hoai/hoai/0.38.1/bin/hoai')
  assert.equal(absolute.link, '/home/kc/.claude/plugins/cache/hoai/hoai/0.38.3/bin/hoai')
  assert.ok(absolute.detail.includes('alias:symlink_updated'), absolute.detail)

  const relative = await run('../../.claude/plugins/cache/hoai/hoai/0.38.1/bin/hoai')
  assert.equal(relative.link, '/home/kc/.claude/plugins/cache/hoai/hoai/0.38.3/bin/hoai')

  const clone = await run('/home/kc/bgos-claude-plugin/bin/hoai')
  assert.equal(clone.link, '/home/kc/bgos-claude-plugin/bin/hoai')
  assert.ok(clone.detail.includes('alias:untouched(clone)'), clone.detail)

  const none = await run(null)
  assert.equal(none.link, undefined)
  assert.ok(none.detail.includes('alias:absent'), none.detail)
})

// -- Clone installs ----------------------------------------------------------

function cloneWorld() {
  const world = memWorld()
  const pluginRoot = '/home/kc/bgos-claude-plugin'
  const pkg = joinLike(pluginRoot, 'package.json')
  world.files.set(pkg, JSON.stringify({ name: 'claude-channel-bgos', version: '0.38.1' }))
  const gitCalls: string[][] = []
  let head = 'a'.repeat(40)
  const git = async (args: string[]) => {
    gitCalls.push(args)
    if (args[0] === 'rev-parse') return { code: 0, stdout: `${head}\n`, stderr: '' }
    if (args[0] === 'fetch') return { code: 0, stdout: '', stderr: '' }
    if (args[0] === 'merge') {
      if (git.failMerge) return { code: 128, stdout: '', stderr: 'fatal: Not possible to fast-forward, aborting.\n' }
      head = 'b'.repeat(40)
      world.files.set(pkg, JSON.stringify({ name: 'claude-channel-bgos', version: '0.38.3' }))
      return { code: 0, stdout: 'Fast-forward\n', stderr: '' }
    }
    if (args[0] === 'checkout') {
      head = args[2]
      world.files.set(pkg, JSON.stringify({ name: 'claude-channel-bgos', version: '0.38.1' }))
      return { code: 0, stdout: '', stderr: '' }
    }
    return { code: 1, stdout: '', stderr: `unexpected git ${args.join(' ')}` }
  }
  git.failMerge = false
  const state = {
    platform: 'linux',
    installMethod: 'clone',
    runningVersion: '0.38.1',
    clone: { latestVersion: '0.38.3', dirty: false, canFastForward: true, currentCommit: 'a'.repeat(40), targetCommit: 'b'.repeat(40) },
    autoUpdateEnabled: true,
    rollbackLatched: false,
    agents: [agentState('912')],
    intent: 'update',
  } as MachineState
  return { world, pluginRoot, pkg, git, gitCalls, state, currentHead: () => head }
}

test('clone: snapshot records HEAD, fast-forward runs fetch + merge --ff-only <target> in the plugin root, verify reads package.json', async () => {
  const c = cloneWorld()
  const plan = planMachine(c.state)
  assert.deepEqual(
    plan.steps.map((s) => s.kind),
    ['snapshot', 'git_fast_forward', 'verify_installed', 'restart_agent', 'verify_agent'],
  )
  const { deps, calls } = memDeps(c.world, {}, { git: c.git, pluginRoot: c.pluginRoot, clone: { targetCommit: 'b'.repeat(40) } })
  const result = await executePlan(plan, deps)
  assert.deepEqual(stepView(result.steps), [
    's01-snapshot:ok:recorded',
    's02-git_fast_forward:ok:fast_forwarded',
    's03-verify_installed:ok:verified',
    's04-restart_agent-912:ok:restarted',
    's05-verify_agent-912:ok:live',
  ])
  assert.deepEqual(c.gitCalls, [
    ['rev-parse', 'HEAD'],
    ['fetch', '--quiet', 'origin', 'main'],
    ['merge', '--ff-only', 'b'.repeat(40)],
    ['rev-parse', 'HEAD'],
  ])
  assert.deepEqual(calls, [], 'no claude CLI for a clone')
  assert.equal(result.installedVersion, '0.38.3')
  assert.equal(stepById(result, 's01-snapshot').detail, `head:${'a'.repeat(12)};version:0.38.1`)
  assert.ok(stepById(result, 's03-verify_installed').detail?.includes('source:package_json'))
  assert.ok(stepById(result, 's03-verify_installed').detail?.includes('alias:untouched(clone)'))
})

test('clone: a failed merge rolls back with git checkout --detach <previous sha>, never git clean', async () => {
  const c = cloneWorld()
  c.git.failMerge = true
  const plan = planMachine(c.state)
  const { deps } = memDeps(c.world, {}, { git: c.git, pluginRoot: c.pluginRoot })
  const result = await executePlan(plan, deps)
  assert.deepEqual(stepView(result.steps).slice(0, 3), [
    's01-snapshot:ok:recorded',
    's02-git_fast_forward:failed:git_failed:128',
    's02-git_fast_forward.rollback:rolled_back:rolled_back',
  ])
  assert.equal(result.verdict, 'rolled_back')
  assert.deepEqual(result.failedStep, { id: 's02-git_fast_forward', kind: 'git_fast_forward', message: 'fast_forward_failed:git_failed:128' })
  assert.deepEqual(c.gitCalls.at(-1), ['checkout', '--detach', 'a'.repeat(40)])
  assert.ok(c.gitCalls.every((args) => args[0] !== 'clean'))
  assert.equal(c.currentHead(), 'a'.repeat(40))
  assert.equal(result.installedVersion, '0.38.1')
})

// -- Sandbox: the real fake CLI against real files ---------------------------

function scenario(name: string) {
  return JSON.parse(readFileSync(join(SCENARIOS_DIR, name), 'utf8'))
}

async function sandboxState(sandbox: Sandbox, agents: MachineState['agents']): Promise<MachineState> {
  const observed = await observeMarketplaceInstall({ configDir: sandbox.configDir })
  return {
    platform: process.platform,
    installMethod: 'marketplace',
    runningVersion: observed.installed.version,
    marketplace: { registered: observed.marketplaceRegistered, latestVersion: observed.marketplaceLatest?.version ?? null },
    installed: observed.installed,
    autoUpdateEnabled: true,
    rollbackLatched: false,
    agents,
    intent: 'update',
  } as MachineState
}

function sandboxDeps(sandbox: Sandbox, over: Partial<Deps> = {}) {
  const sleeps: number[] = []
  const restarts: Array<{ id: string; via: string | null; at: number }> = []
  const verifies: Array<{ id: string; since: number }> = []
  const localAppData = join(sandbox.root, 'LocalAppData')
  const deps: Deps = {
    cli: (args, opts) => runClaudeCli(args, { runner: cliRunnerFor(sandbox), timeoutMs: opts.timeoutMs }),
    fs: nodeFs(),
    home: sandbox.home,
    configDir: sandbox.configDir,
    platform: process.platform,
    localAppData,
    sleep: async (ms) => {
      sleeps.push(ms)
    },
    staggerMs: 10_000,
    verifyTimeoutMs: 500,
    timeoutsMs: { restart: 500 },
    agents: [{ assistantId: '912', cwd: join(sandbox.home, 'hoai-agents', '912') }],
    restartAgent: async (agent, opts) => {
      restarts.push({ id: agent.assistantId, via: opts.via, at: opts.restartedAtMs })
      return { ok: true, how: opts.via ?? 'marker' }
    },
    verifyAgent: async (agent, opts) => {
      verifies.push({ id: agent.assistantId, since: opts.restartedAtMs })
      return { ok: true, evidence: 'channel-live.json newer than restart' }
    },
    log: () => {},
    ...over,
  }
  return { deps, sleeps, restarts, verifies, localAppData }
}

const ONE_AGENT: MachineState['agents'] = [agentState('912') as MachineState['agents'][number]]

function argvLog(sandbox: Sandbox) {
  return sandbox.readCallLog().map((entry) => entry.argv.join(' '))
}

test('sandbox: happy converge from nothing against the real fake CLI and real files', async () => {
  const sandbox = makeSandbox()
  try {
    sandbox.writeScenario(scenario('happy-converge.json'))
    const plan = planMachine(await sandboxState(sandbox, ONE_AGENT))
    assert.equal(plan.targetVersion, null)
    const { deps, restarts, verifies } = sandboxDeps(sandbox)
    const { events, report } = recorder()
    const result = await executePlan(plan, deps, report)
    assert.deepEqual(stepView(result.steps), [
      's01-register_marketplace:ok:registered',
      's02-refresh_marketplace:ok:updated',
      's03-snapshot:ok:recorded',
      's04-install_plugin:ok:installed',
      's05-verify_installed:ok:verified',
      's06-restart_agent-912:ok:restarted',
      's07-verify_agent-912:ok:live',
    ])
    assert.equal(result.ok, true)
    assert.equal(result.targetVersion, '0.38.3')
    assert.equal(result.installedVersion, '0.38.3')
    assert.deepEqual(argvLog(sandbox), [KEY.add, KEY.refresh, KEY.install, KEY.list])
    const installed = sandbox.readJson<any>(sandbox.paths.installedPlugins)
    assert.equal(installed.plugins['hoai@hoai'][0].version, '0.38.3')
    assert.ok(existsSync(join(installed.plugins['hoai@hoai'][0].installPath, '.claude-plugin', 'plugin.json')))
    assert.equal(restarts.length, 1)
    assert.equal(verifies[0].since, restarts[0].at)
    // Snapshot on the real disk: marketplace files existed, installed_plugins.json did not.
    const root = rollbackRootFor(sandbox.home)
    const stamps = readdirSync(root)
    assert.equal(stamps.length, 1)
    const record = JSON.parse(readFileSync(join(root, stamps[0], SNAPSHOT_FILE), 'utf8'))
    assert.deepEqual(record.files.map((f: { name: string; absent: boolean }) => [f.name, f.absent]), [
      ['installed_plugins.json', true],
      ['settings.json', false],
      ['known_marketplaces.json', false],
    ])
    const { order, last } = lastReported(events)
    assert.deepEqual(order, result.steps.map((s) => s.id))
    for (const step of result.steps) assert.equal(last.get(step.id)?.state, step.state)
  } finally {
    sandbox.cleanup()
  }
})

test('sandbox: update ok, and the hoai alias of this host platform follows the new version dir', async () => {
  const sandbox = makeSandbox()
  try {
    sandbox.writeScenario(scenario('update-ok.json'))
    sandbox.seedMarketplace('0.38.3')
    const oldInstall = sandbox.seedInstalled('0.38.1')
    const { deps, localAppData } = sandboxDeps(sandbox)
    let aliasPath: string
    if (process.platform === 'win32') {
      aliasPath = aliasBreadcrumbPath(localAppData)
      mkdirSync(dirname(aliasPath), { recursive: true })
      writeFileSync(aliasPath, `${oldInstall}\r\n`)
    } else {
      aliasPath = aliasSymlinkPath(sandbox.home)
      mkdirSync(dirname(aliasPath), { recursive: true })
      symlinkSync(join(oldInstall, 'bin', 'hoai'), aliasPath)
    }
    const plan = planMachine(await sandboxState(sandbox, ONE_AGENT))
    assert.equal(plan.targetVersion, '0.38.3')
    const result = await executePlan(plan, deps)
    assert.deepEqual(stepView(result.steps), [
      's01-refresh_marketplace:ok:updated',
      's02-snapshot:ok:recorded',
      's03-update_plugin:ok:updated',
      's04-verify_installed:ok:verified',
      's05-restart_agent-912:ok:restarted',
      's06-verify_agent-912:ok:live',
    ])
    assert.deepEqual(argvLog(sandbox), [KEY.refresh, KEY.update, KEY.list])
    const newInstall = sandbox.readJson<any>(sandbox.paths.installedPlugins).plugins['hoai@hoai'][0].installPath as string
    assert.notEqual(newInstall, oldInstall)
    assert.ok(existsSync(oldInstall), 'the real CLI keeps the old cache dir; so does the fake')
    if (process.platform === 'win32') {
      assert.equal(readFileSync(aliasPath, 'utf8'), `${newInstall}\r\n`)
      assert.ok(stepById(result, 's04-verify_installed').detail?.includes('alias:breadcrumb_updated'))
    } else {
      assert.equal(readlinkSync(aliasPath), join(newInstall, 'bin', 'hoai'))
      assert.ok(stepById(result, 's04-verify_installed').detail?.includes('alias:symlink_updated'))
    }
  } finally {
    sandbox.cleanup()
  }
})

test('sandbox: update rc1 -> reinstall ok -> verify ok', async () => {
  const sandbox = makeSandbox()
  try {
    sandbox.writeScenario(scenario('update-rc1-reinstall-ok.json'))
    sandbox.seedMarketplace('0.38.3')
    sandbox.seedInstalled('0.38.1')
    const plan = planMachine(await sandboxState(sandbox, ONE_AGENT))
    const { deps } = sandboxDeps(sandbox)
    const result = await executePlan(plan, deps)
    assert.deepEqual(stepView(result.steps), [
      's01-refresh_marketplace:ok:updated',
      's02-snapshot:ok:recorded',
      's03-update_plugin:failed:cli_failed:1',
      's03-update_plugin.reinstall:ok:reinstalled',
      's04-verify_installed:ok:verified',
      's05-restart_agent-912:ok:restarted',
      's06-verify_agent-912:ok:live',
    ])
    assert.deepEqual(argvLog(sandbox), [KEY.refresh, KEY.update, KEY.uninstall, KEY.install, KEY.list])
    assert.equal(result.verdict, 'done')
    assert.equal(result.installedVersion, '0.38.3')
    const detail = stepById(result, 's03-update_plugin').detail ?? ''
    assert.ok(detail.includes('simulated network failure'), detail)
    assert.ok(!detail.includes(sandbox.home), 'home never leaks into detail')
  } finally {
    sandbox.cleanup()
  }
})

test('sandbox: update + reinstall fail -> rollback restores the real files byte for byte', async () => {
  const sandbox = makeSandbox()
  try {
    sandbox.writeScenario(scenario('update-reinstall-fail.json'))
    sandbox.seedMarketplace('0.38.3')
    const oldInstall = sandbox.seedInstalled('0.38.1')
    const before = {
      installed: readFileSync(sandbox.paths.installedPlugins),
      settings: readFileSync(sandbox.paths.settings),
      known: readFileSync(sandbox.paths.knownMarketplaces),
    }
    const plan = planMachine(await sandboxState(sandbox, ONE_AGENT))
    const { deps, restarts } = sandboxDeps(sandbox)
    const result = await executePlan(plan, deps)
    assert.deepEqual(stepView(result.steps).slice(2, 5), [
      's03-update_plugin:failed:cli_failed:1',
      's03-update_plugin.reinstall:failed:cli_failed:1',
      's03-update_plugin.rollback:rolled_back:rolled_back',
    ])
    assert.deepEqual(argvLog(sandbox), [KEY.refresh, KEY.update, KEY.uninstall, KEY.install])
    assert.equal(result.verdict, 'rolled_back')
    assert.equal(result.rolledBack, true)
    assert.deepEqual(result.failedStep, { id: 's03-update_plugin', kind: 'update_plugin', message: 'update_failed:cli_failed:1' })
    // installed_plugins.json and settings.json are exactly the pre-run bytes.
    assert.ok(readFileSync(sandbox.paths.installedPlugins).equals(before.installed))
    assert.ok(readFileSync(sandbox.paths.settings).equals(before.settings))
    // known_marketplaces.json is legitimately rewritten by the refresh step
    // (lastUpdated) BEFORE the snapshot, so the restore target is the
    // snapshot copy, not the pre-run bytes.
    const root = rollbackRootFor(sandbox.home)
    const snapshotDir = join(root, readdirSync(root)[0])
    assert.ok(readFileSync(sandbox.paths.knownMarketplaces).equals(readFileSync(join(snapshotDir, 'known_marketplaces.json'))))
    assert.ok(!readFileSync(sandbox.paths.knownMarketplaces).equals(before.known), 'the refresh step really did touch it')
    assert.ok(readFileSync(join(snapshotDir, 'installed_plugins.json')).equals(before.installed))
    assert.ok(existsSync(join(oldInstall, '.claude-plugin', 'plugin.json')))
    assert.equal(restarts.length, 0)
  } finally {
    sandbox.cleanup()
  }
})

test('sandbox: rollback impossible when the snapshot install dir is removed mid-run', async () => {
  const sandbox = makeSandbox()
  try {
    sandbox.writeScenario(scenario('update-reinstall-fail.json'))
    sandbox.seedMarketplace('0.38.3')
    const oldInstall = sandbox.seedInstalled('0.38.1')
    const plan = planMachine(await sandboxState(sandbox, ONE_AGENT))
    const { deps } = sandboxDeps(sandbox)
    const report = async (id: string, payload: ReportPayload) => {
      if (id === 's03-update_plugin.reinstall' && payload.state === 'running') rmSync(oldInstall, { recursive: true, force: true })
    }
    const result = await executePlan(plan, deps, report)
    const rollback = stepById(result, 's03-update_plugin.rollback')
    assert.equal(rollback.state, 'failed')
    assert.equal(rollback.message, 'rollback_impossible')
    assert.equal(rollback.detail, 'install_path_missing')
    assert.equal(result.verdict, 'failed')
    assert.equal(result.rolledBack, false)
    assert.deepEqual(result.failedStep, { id: 's03-update_plugin', kind: 'update_plugin', message: 'update_failed:cli_failed:1' })
  } finally {
    sandbox.cleanup()
  }
})

test('sandbox: garbage `list --json` from the real child falls back to installed_plugins.json', async () => {
  const sandbox = makeSandbox()
  try {
    sandbox.writeScenario(scenario('garbage-list.json'))
    sandbox.seedMarketplace('0.38.3')
    sandbox.seedInstalled('0.38.1')
    const plan = planMachine(await sandboxState(sandbox, ONE_AGENT))
    const { deps } = sandboxDeps(sandbox)
    const result = await executePlan(plan, deps)
    assert.equal(result.verdict, 'done', stepView(result.steps).join(' | '))
    const verify = stepById(result, 's04-verify_installed')
    assert.ok(verify.detail?.includes('version:0.38.3;source:installed_plugins'), verify.detail)
  } finally {
    sandbox.cleanup()
  }
})

test('sandbox: a hanging child is killed by the runner and the step ends with the token timeout', async () => {
  const sandbox = makeSandbox()
  try {
    sandbox.writeScenario(scenario('hang-update.json'))
    sandbox.seedMarketplace('0.38.3')
    sandbox.seedInstalled('0.38.1')
    const plan = planMachine(await sandboxState(sandbox, ONE_AGENT))
    const { deps } = sandboxDeps(sandbox, { timeoutsMs: { network: 1_500, restart: 500 } })
    const started = Date.now()
    const result = await executePlan(plan, deps)
    const elapsed = Date.now() - started
    assert.ok(elapsed < 15_000, `took ${elapsed}ms`)
    const update = stepById(result, 's03-update_plugin')
    assert.equal(update.state, 'failed')
    assert.equal(update.message, 'timeout')
    assert.equal(stepById(result, 's03-update_plugin.reinstall').state, 'ok')
    assert.equal(result.verdict, 'done')
    assert.equal(sandbox.readCallLog().filter((entry) => entry.outcome === 'hang').length, 1)
  } finally {
    sandbox.cleanup()
  }
})

test('sandbox: success with the wrong version on disk is version_mismatch, one reinstall, then an inline re-verify', async () => {
  const sandbox = makeSandbox()
  try {
    sandbox.writeScenario(scenario('wrong-version.json'))
    sandbox.seedMarketplace('0.38.3')
    sandbox.seedInstalled('0.38.1')
    const plan = planMachine(await sandboxState(sandbox, ONE_AGENT))
    const { deps } = sandboxDeps(sandbox)
    const result = await executePlan(plan, deps)
    assert.deepEqual(stepView(result.steps), [
      's01-refresh_marketplace:ok:updated',
      's02-snapshot:ok:recorded',
      's03-update_plugin:ok:updated',
      's04-verify_installed:failed:version_mismatch',
      's04-verify_installed.reinstall:ok:reinstalled',
      's04-verify_installed.verify:ok:verified',
      's05-restart_agent-912:ok:restarted',
      's06-verify_agent-912:ok:live',
    ])
    assert.equal(stepById(result, 's04-verify_installed').detail, 'installed:0.0.1;target:0.38.3;source:list')
    assert.deepEqual(argvLog(sandbox), [KEY.refresh, KEY.update, KEY.list, KEY.uninstall, KEY.install, KEY.list])
    assert.equal(result.verdict, 'done')
    assert.equal(sandbox.readJson<any>(sandbox.paths.installedPlugins).plugins['hoai@hoai'][0].version, '0.38.3')
  } finally {
    sandbox.cleanup()
  }
})
