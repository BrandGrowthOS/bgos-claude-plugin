/**
 * lib/watcher-keepalive.mjs: the watcher's keep-alive sweep (design 5), run in a
 * fully faked machine: an in-memory fake HOME (no real ~ is read or written), a
 * recording exec that answers ps / lsof / launchctl / bash, a recording kill, a
 * fake clock, and a fake backend answer for the keep-alive list. What it pins:
 *
 *   consent     disabled (or no answer and no fresh cache) => NO effect at all;
 *               a failed fetch acts on a cache younger than 24 h
 *   supervise   a cleared agent with no supervisor => exactly one
 *               `bash <CURRENT root>/bin/bgos-agent install ... --always-on --no-clone`;
 *               an uncleared one, one with no folder, a bespoke keepalive => none
 *   safe moment a background job under claude => waiting_idle background_job and
 *               NO restart (finding 9); an unreadable process table => no restart
 *   restart     idle + update_pending => restart through the service, then verify;
 *               a verified keepalive => SIGTERM to its claudePid only; a
 *               generation 1 supervisor => reinstall (upgrade) then verify
 *   gates       one restart per sweep, one per agent per 30 min, 3 attempts per
 *               target then failed, a failed install retried hourly
 *   state       ~/.bgos-agent/watcher/keepalive-state.json and the per agent
 *               heartbeat entries (waitingSince after 24 h)
 *
 * Run: npx tsx --test test/watcher-keepalive.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  INSTALL_TIMEOUT_MS,
  hookSpoolPathFor,
  keepAliveCachePath,
  mungeCwd,
  transcriptPathFor,
  keepAliveStatePath,
  readKeepAliveReport,
  runKeepAliveSweep,
  supervisorInstallCommand,
} from '../lib/watcher-keepalive.mjs'
import { buildLaunchRecipe } from '../lib/agent-inventory.mjs'
import { buildKeepAliveCache } from '../lib/keepalive-plan.mjs'
import { memoryFs, type MemoryFs } from './helpers/memory-fs.ts'

const HOME = '/Users/kc'
const CONFIG = `${HOME}/.claude`
const OLD_ROOT = `${CONFIG}/plugins/cache/hoai/hoai/0.62.0`
const ROOT = `${CONFIG}/plugins/cache/hoai/hoai/0.62.1`
const T0 = Date.parse('2026-10-06T19:00:00.000Z')
const MIN = 60_000
const AVA = `${HOME}/hoai-agents/ava`
const GURU = `${HOME}/hoai-agents/guru`

// -- the fake machine --------------------------------------------------------------------------

function fakeClock(start = T0) {
  let nowMs = start
  const hooks: Array<(ms: number, at: number) => void> = []
  return {
    now: () => nowMs,
    sleep: async (ms: number) => {
      nowMs += ms
      for (const h of hooks) h(ms, nowMs)
    },
    advance: (ms: number) => {
      nowMs += ms
    },
    onSleep: (h: (ms: number, at: number) => void) => hooks.push(h),
  }
}

type AgentSpec = {
  id: string
  cwd: string | null
  service?: 'canonical' | 'none'
  generation?: string | null
  state?: Record<string, unknown> | null
  keepalive?: { pid: number; claudePid: number } | null
}

function stateBody(id: string, at: number, overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    schemaVersion: 1,
    assistantId: id,
    pid: Number(`4${id}`),
    claudePid: Number(`5${id}`),
    runningVersion: '0.62.0',
    pendingRestartVersion: null,
    turnInFlight: false,
    pendingMessages: 0,
    pendingPermissions: 0,
    activeOperations: 0,
    lastActivityAt: new Date(at - 60 * MIN).toISOString(),
    sessionId: null,
    updatedAt: new Date(at - 10_000).toISOString(),
    ...overrides,
  })
}

/** The v2 bin/bgos-agent stamps <statedir>/supervisor-generation; v1 never mentions it. */
const BGOS_AGENT_V2 = '#!/usr/bin/env bash\nprintf "%s\\n" "$SUPERVISOR_GENERATION" > "$statedir/supervisor-generation"\n'
const BGOS_AGENT_V1 = '#!/usr/bin/env bash\nwrite_run_expect "$statedir/run.expect"\n'

function machine(agents: AgentSpec[], opts: { platform?: string; installedVersion?: string; lastUpdated?: string; bgosAgent?: string } = {}): MemoryFs {
  const files: Record<string, string> = {
    [`${ROOT}/bin/bgos-agent`]: opts.bgosAgent ?? BGOS_AGENT_V2,
    [`${HOME}/.bgos-agent/watcher/manifest.json`]: JSON.stringify({ version: '0.62.1', fingerprint: 'f', installedAt: 'x', pluginRoot: OLD_ROOT, files: [] }),
    [`${CONFIG}/plugins/installed_plugins.json`]: JSON.stringify({
      version: 2,
      plugins: { 'hoai@hoai': [{ scope: 'user', version: opts.installedVersion ?? '0.62.1', installPath: ROOT, lastUpdated: opts.lastUpdated ?? '2026-10-06T18:30:00.000Z' }] },
    }),
  }
  const dirs: string[] = []
  for (const a of agents) {
    files[`${HOME}/.bgos-agent/credentials-${a.id}.json`] = '{"pairingToken":"agent-secret"}'
    if (a.cwd) {
      files[`${HOME}/.bgos-agent/${a.id}/launch.json`] = JSON.stringify(
        buildLaunchRecipe({ assistantId: a.id, cwd: a.cwd, argv: [], installMethod: 'marketplace', pluginRoot: OLD_ROOT, node: '/usr/local/bin/node', startedAt: 'x', pid: null }),
      )
      files[`${a.cwd}/.bgos-agent-id`] = `${a.id}\n`
      dirs.push(a.cwd)
    }
    if (a.service === 'canonical') {
      files[`${HOME}/Library/LaunchAgents/ai.bgos.agent.${a.id}.plist`] = '<plist/>'
      if (a.generation !== null) files[`${HOME}/.bgos-agent/${a.id}/supervisor-generation`] = `${a.generation ?? '2'}\n`
    }
    if (a.state) files[`${HOME}/.bgos-plugin-state/${a.id}/agent-state.json`] = stateBody(a.id, T0, a.state)
    if (a.keepalive) {
      files[`${HOME}/.bgos-agent/${a.id}/keepalive.json`] = JSON.stringify({ kind: 'keepalive', pid: a.keepalive.pid, claudePid: a.keepalive.claudePid, capabilities: ['relaunch'], tmuxSession: `agent-${a.id}` })
    }
  }
  return memoryFs(files, dirs)
}

const psLine = (pid: number, ppid: number, cmd: string, start = 'Tue Oct  6 18:00:00 2026') => ` ${pid} ${ppid} ${start} ${cmd}`

function recorder(opts: { ps?: string | null; lsof?: string; bashCode?: number; launchctlCode?: number } = {}) {
  const calls: Array<{ file: string; args: string[]; opts: any }> = []
  const exec = async (file: string, args: readonly string[], o: any = {}) => {
    calls.push({ file, args: [...args], opts: o })
    if (file === 'ps') return opts.ps == null ? { code: 1, stdout: '', stderr: 'ps: denied', error: null, timedOut: false } : { code: 0, stdout: opts.ps, stderr: '', error: null, timedOut: false }
    if (file === 'lsof') return { code: 0, stdout: opts.lsof ?? '', stderr: '', error: null, timedOut: false }
    if (file === 'bash') return { code: opts.bashCode ?? 0, stdout: '', stderr: opts.bashCode ? `x  no .mcp.json in ${GURU} and no creds given` : '', error: null, timedOut: false }
    if (file === 'launchctl') return { code: opts.launchctlCode ?? 0, stdout: '', stderr: '', error: null, timedOut: false }
    return { code: 0, stdout: '', stderr: '', error: null, timedOut: false }
  }
  const kills: Array<[number, string]> = []
  const kill = (pid: number, signal: string) => {
    kills.push([pid, signal])
    return true
  }
  const spawns: any[] = []
  const spawnDetached = (file: string, args: readonly string[]) => {
    spawns.push({ file, args: [...args] })
    return { pid: 1 }
  }
  return { calls, exec, kills, kill, spawns, spawnDetached }
}

/** listAgents' sync probes: no loaded jobs; `ps -o comm=` answers from a table. */
function execSyncFor(comm: Record<number, string> = {}) {
  return (file: string, args: string[]) => {
    if (file === 'ps' && args[1] === 'comm=') {
      const name = comm[Number(args[3])]
      return name ? { code: 0, stdout: `${name}\n` } : { code: 1, stdout: '' }
    }
    return { code: 1, stdout: '' }
  }
}

function consent(json: unknown, ok = true, status = 200) {
  const calls: number[] = []
  return {
    calls,
    fetchKeepAlive: async () => {
      calls.push(1)
      return { ok, status, json, text: JSON.stringify(json), error: ok ? null : 'down' }
    },
  }
}

function ctxFor(fs: MemoryFs, rec: ReturnType<typeof recorder>, clock: ReturnType<typeof fakeClock>, extra: Record<string, unknown> = {}) {
  const logs: string[] = []
  return {
    logs,
    ctx: {
      home: HOME,
      env: { PATH: '/usr/bin' },
      platform: 'darwin',
      fs,
      exec: rec.exec,
      execSync: execSyncFor(),
      spawnDetached: rec.spawnDetached,
      kill: rec.kill,
      now: clock.now,
      sleep: clock.sleep,
      log: (l: string) => logs.push(l),
      pidAlive: (pid: number) => [4912, 5912, 47, 57, 4100].includes(pid),
      nodePath: '/usr/local/bin/node',
      uid: 501,
      manifest: { version: '0.62.1', fingerprint: 'f', installedAt: 'x', pluginRoot: OLD_ROOT, files: [], claudeConfigDir: null },
      hasTmux: true,
      hasScript: true,
      hasCommand: () => false,
      verifyTimeoutMs: 30_000,
      fetchKeepAlive: consent({ enabled: true, enabledAt: 'e', assistantIds: [912, 7] }).fetchKeepAlive,
      ...extra,
    },
  }
}

/** The daemon answers the liveness probe right after a restart (agent-verify). */
function answerProbes(fs: MemoryFs, clock: ReturnType<typeof fakeClock>, ids: string[]) {
  clock.onSleep((_ms, at) => {
    for (const id of ids) {
      if (fs.files.has(`${HOME}/.bgos-agent/${id}/probe-requested.json`)) {
        fs.writeFile(`${HOME}/.bgos-plugin-state/${id}/channel-live.json`, JSON.stringify({ firstLiveAt: 'x', lastLiveAt: new Date(at).toISOString() }))
      }
    }
  })
}

const IDLE_PS = [psLine(1, 0, '/sbin/launchd'), psLine(5912, 4100, 'claude --dangerously-skip-permissions'), psLine(4912, 5912, `node ${OLD_ROOT}/server.ts`)].join('\n')
const JOB_PS = `${IDLE_PS}\n${psLine(6000, 5912, `/bin/zsh -c source ${HOME}/.claude/shell-snapshots/snapshot-zsh-1.sh && eval 'python monitor.py'`)}\n${psLine(6001, 6000, 'python monitor.py')}`

function agentWrites(fs: MemoryFs) {
  return [...fs.files.keys()].filter((p) => p.startsWith(`${HOME}/.bgos-agent/`) && !p.startsWith(`${HOME}/.bgos-agent/watcher/`))
}

// -- consent ---------------------------------------------------------------------------------------

test('disabled: the switch off means NO effect at all (no exec, no kill, no spawn, no agent file), even with work to do', async () => {
  const fs = machine([{ id: '912', cwd: AVA, service: 'none' }])
  const before = agentWrites(fs).sort()
  const rec = recorder({ ps: IDLE_PS })
  const clock = fakeClock()
  const { ctx } = ctxFor(fs, rec, clock, { fetchKeepAlive: consent({ enabled: false, enabledAt: null, assistantIds: [912] }).fetchKeepAlive })
  const report = await runKeepAliveSweep(ctx as any)
  assert.deepEqual(report, { enabled: false, source: 'live', agents: [] })
  assert.deepEqual(rec.calls, [])
  assert.deepEqual(rec.kills, [])
  assert.deepEqual(rec.spawns, [])
  assert.deepEqual(agentWrites(fs).sort(), before)
})

test('consent: a failed fetch with no cache is OFF; with a cache younger than 24 h the cached list is acted on', async () => {
  const fs = machine([{ id: '912', cwd: AVA, service: 'none' }])
  const rec = recorder({ ps: IDLE_PS })
  const clock = fakeClock()
  const down = consent(null, false, 0)
  const { ctx } = ctxFor(fs, rec, clock, { fetchKeepAlive: down.fetchKeepAlive })
  assert.deepEqual(await runKeepAliveSweep(ctx as any), { enabled: false, source: 'none', agents: [] })
  assert.deepEqual(rec.calls, [])
  // A 404 (backend not deployed yet) is the same: off, unless a fresh cache exists.
  fs.writeFile(keepAliveCachePath(HOME), buildKeepAliveCache({ enabled: true, enabledAt: 'e', assistantIds: ['912'] }, T0 - 23 * 60 * MIN))
  const notFound = consent({ message: 'Not Found' }, false, 404)
  const second = ctxFor(fs, rec, clock, { fetchKeepAlive: notFound.fetchKeepAlive })
  const report = await runKeepAliveSweep(second.ctx as any)
  assert.equal(report.enabled, true)
  assert.equal(report.source, 'cache')
  assert.equal(rec.calls.filter((c) => c.file === 'bash').length, 1)
})

test('consent: a live answer is cached in ~/.bgos-agent/watcher/keepalive.json (design 3.4 shape)', async () => {
  const fs = machine([])
  const { ctx } = ctxFor(fs, recorder(), fakeClock())
  await runKeepAliveSweep(ctx as any)
  assert.deepEqual(JSON.parse(fs.files.get(keepAliveCachePath(HOME))!), {
    schemaVersion: 1,
    enabled: true,
    enabledAt: 'e',
    assistantIds: ['7', '912'],
    fetchedAt: new Date(T0).toISOString(),
  })
})

// -- supervise -----------------------------------------------------------------------------------

test('supervise: a cleared agent with no supervisor gets exactly ONE bgos-agent install from the CURRENT plugin root', async () => {
  const fs = machine([{ id: '912', cwd: AVA, service: 'none' }, { id: '300', cwd: GURU, service: 'none' }])
  const rec = recorder({ ps: IDLE_PS })
  const { ctx } = ctxFor(fs, rec, fakeClock())
  const report = await runKeepAliveSweep(ctx as any)
  const bash = rec.calls.filter((c) => c.file === 'bash')
  assert.deepEqual(bash.map((c) => c.args), [[`${ROOT}/bin/bgos-agent`, 'install', '--assistant', '912', '--dir', AVA, '--always-on', '--no-clone']])
  assert.equal(bash[0]!.opts.timeoutMs, INSTALL_TIMEOUT_MS)
  assert.deepEqual(supervisorInstallCommand({ pluginRoot: ROOT, assistantId: '912', cwd: AVA }), { file: 'bash', args: bash[0]!.args })
  // 300 is on disk but the backend did not clear it: nothing, not even a report row.
  assert.deepEqual(report.agents.map((a: any) => [a.id, a.state, a.reason ?? null]), [['912', 'installing', 'installed']])
  assert.deepEqual(rec.kills, [])
})

test('supervise: no known folder is needs_first_launch; a verified bespoke keepalive is supervised (never a second supervisor, G11)', async () => {
  const fs = machine([{ id: '912', cwd: null, service: 'none' }, { id: '7', cwd: GURU, service: 'none', keepalive: { pid: 47, claudePid: 57 } }])
  const rec = recorder({ ps: IDLE_PS })
  const { ctx } = ctxFor(fs, rec, fakeClock(), { execSync: execSyncFor({ 57: 'claude' }) })
  const report = await runKeepAliveSweep(ctx as any)
  assert.deepEqual(report.agents.map((a: any) => [a.id, a.state, a.reason ?? null]), [['7', 'supervised', 'keepalive'], ['912', 'needs_first_launch', 'no_known_folder']])
  assert.equal(rec.calls.filter((c) => c.file === 'bash').length, 0)
})

test('supervise: a failed install is reported (scrubbed, bounded) and retried at most once an hour; one install per sweep', async () => {
  const fs = machine([{ id: '912', cwd: AVA, service: 'none' }, { id: '7', cwd: GURU, service: 'none' }])
  const rec = recorder({ ps: IDLE_PS, bashCode: 1 })
  const clock = fakeClock()
  const { ctx } = ctxFor(fs, rec, clock, { scrub: (l: string) => l.split(HOME).join('~') })
  const first = await runKeepAliveSweep(ctx as any)
  assert.equal(rec.calls.filter((c) => c.file === 'bash').length, 1, 'one install per sweep')
  const byId = Object.fromEntries(first.agents.map((a: any) => [a.id, a]))
  assert.equal(byId['7'].state, 'failed')
  assert.match(byId['7'].reason, /^install_failed:bgos-agent install rc 1: x no \.mcp\.json in ~\/hoai-agents\/guru/)
  assert.equal(byId['7'].reason.includes(HOME), false, 'the home path never leaves the machine')
  assert.ok(byId['7'].reason.length <= 120)
  assert.equal(byId['912'].reason, 'one_install_per_sweep')
  clock.advance(30 * MIN)
  await runKeepAliveSweep(ctx as any)
  // 7 waits out its hour; 912 gets its turn.
  assert.deepEqual(rec.calls.filter((c) => c.file === 'bash').map((c) => c.args[3]), ['7', '912'])
  clock.advance(31 * MIN)
  await runKeepAliveSweep(ctx as any)
  assert.deepEqual(rec.calls.filter((c) => c.file === 'bash').map((c) => c.args[3]), ['7', '912', '7'], 'retried after an hour')
})

// -- the safe moment ----------------------------------------------------------------------------

test('safe moment: a background job under claude => waiting_idle background_job and NO restart (finding 9)', async () => {
  const fs = machine([{ id: '912', cwd: AVA, service: 'canonical', state: {} }])
  const rec = recorder({ ps: JOB_PS })
  const { ctx } = ctxFor(fs, rec, fakeClock())
  const report = await runKeepAliveSweep(ctx as any)
  assert.deepEqual(report.agents, [{ id: '912', state: 'waiting_idle', reason: 'background_job', since: new Date(T0).toISOString() }])
  assert.deepEqual(rec.calls.filter((c) => c.file !== 'ps').map((c) => c.file), [], 'no launchctl, no bash')
  assert.deepEqual(rec.kills, [])
})

test('safe moment: an unreadable process table never restarts (process_tree_unreadable)', async () => {
  const fs = machine([{ id: '912', cwd: AVA, service: 'canonical', state: {} }])
  const rec = recorder({ ps: null })
  const { ctx } = ctxFor(fs, rec, fakeClock())
  const report = await runKeepAliveSweep(ctx as any)
  assert.equal(report.agents[0].reason, 'process_tree_unreadable')
  assert.equal(rec.calls.some((c) => c.file === 'launchctl'), false)
})

test('safe moment: a turn in flight waits; after 24 h of waiting the entry carries waitingSince ("or ask")', async () => {
  const fs = machine([{ id: '912', cwd: AVA, service: 'canonical', state: { turnInFlight: true } }])
  const rec = recorder({ ps: IDLE_PS })
  const clock = fakeClock()
  const { ctx } = ctxFor(fs, rec, clock)
  const first = await runKeepAliveSweep(ctx as any)
  assert.deepEqual(first.agents[0], { id: '912', state: 'waiting_idle', reason: 'turn_in_flight', since: new Date(T0).toISOString() })
  clock.advance(25 * 60 * MIN)
  fs.writeFile(`${HOME}/.bgos-plugin-state/912/agent-state.json`, stateBody('912', clock.now(), { turnInFlight: true }))
  const later = await runKeepAliveSweep(ctx as any)
  assert.equal(later.agents[0].waitingSince, new Date(T0).toISOString())
  assert.equal(rec.calls.some((c) => c.file === 'launchctl'), false)
})

// -- restart -------------------------------------------------------------------------------------

test('restart: idle + update_pending => restart through the canonical service, then verify the channel is live', async () => {
  const fs = machine([{ id: '912', cwd: AVA, service: 'canonical', state: {} }])
  const rec = recorder({ ps: IDLE_PS })
  const clock = fakeClock()
  answerProbes(fs, clock, ['912'])
  const { ctx } = ctxFor(fs, rec, clock)
  const report = await runKeepAliveSweep(ctx as any)
  assert.deepEqual(rec.calls.filter((c) => c.file === 'launchctl').map((c) => c.args), [['kickstart', '-k', 'gui/501/ai.bgos.agent.912']])
  assert.equal(fs.files.has(`${HOME}/.bgos-agent/912/probe-requested.json`), true, 'the boot hello probe was asked for')
  assert.deepEqual(report.agents.map((a: any) => [a.state, a.reason]), [['restarted', 'service']])
  const saved = JSON.parse(fs.files.get(keepAliveStatePath(HOME))!)
  assert.equal(saved.agents['912'].attempts, 1)
  assert.equal(saved.agents['912'].target, '0.62.1')
  assert.equal(saved.agents['912'].lastRestartAt, new Date(T0).toISOString())
  assert.deepEqual(rec.kills, [])
})

test('restart: a verified keepalive is restarted by SIGTERM to its claudePid ONLY', async () => {
  const fs = machine([{ id: '7', cwd: GURU, service: 'none', keepalive: { pid: 47, claudePid: 57 }, state: { claudePid: 57, pid: 47 } }])
  const ps = [psLine(1, 0, '/sbin/launchd'), psLine(57, 1, 'claude --x'), psLine(47, 1, '/bin/bash keepalive.sh')].join('\n')
  const rec = recorder({ ps })
  const clock = fakeClock()
  answerProbes(fs, clock, ['7'])
  const { ctx } = ctxFor(fs, rec, clock, { execSync: execSyncFor({ 57: 'claude' }) })
  const report = await runKeepAliveSweep(ctx as any)
  assert.deepEqual(rec.kills, [[57, 'SIGTERM']])
  assert.deepEqual(rec.calls.filter((c) => c.file !== 'ps').map((c) => c.file), [], 'no launchctl, no bash, no lsof')
  assert.deepEqual(report.agents.map((a: any) => [a.state, a.reason]), [['restarted', 'keepalive']])
})

test('restart: a canonical generation 1 supervisor is upgraded by a reinstall at an idle moment, then verified', async () => {
  const fs = machine([{ id: '912', cwd: AVA, service: 'canonical', generation: null, state: { runningVersion: '0.62.1' } }])
  const rec = recorder({ ps: IDLE_PS })
  const clock = fakeClock()
  answerProbes(fs, clock, ['912'])
  const { ctx } = ctxFor(fs, rec, clock)
  const report = await runKeepAliveSweep(ctx as any)
  assert.deepEqual(rec.calls.filter((c) => c.file === 'bash').map((c) => c.args), [[`${ROOT}/bin/bgos-agent`, 'install', '--assistant', '912', '--dir', AVA, '--always-on', '--no-clone']])
  assert.equal(rec.calls.some((c) => c.file === 'launchctl'), false)
  assert.deepEqual(report.agents.map((a: any) => [a.state, a.reason]), [['restarted', 'reinstall']])
})

test('a v1 bin/bgos-agent at the current root is never used: no install, no upgrade (it would restart onto a FRESH session, finding 7)', async () => {
  const fs = machine([{ id: '912', cwd: AVA, service: 'canonical', generation: null, state: { runningVersion: '0.62.1' } }, { id: '7', cwd: GURU, service: 'none' }], { bgosAgent: BGOS_AGENT_V1 })
  const rec = recorder({ ps: IDLE_PS })
  const { ctx } = ctxFor(fs, rec, fakeClock())
  const report = await runKeepAliveSweep(ctx as any)
  assert.equal(rec.calls.some((c) => c.file === 'bash'), false)
  assert.deepEqual(report.agents.map((a: any) => [a.id, a.state, a.reason]), [
    ['7', 'failed', 'supervisor_v2_unavailable'],
    ['912', 'upgrade_pending', 'supervisor_v2_unavailable'],
  ])
})

test('restart: a daemon too old to publish its state is judged by time (claude found by cwd, started before the install landed, 30 min quiet)', async () => {
  const fs = machine([{ id: '912', cwd: AVA, service: 'canonical', state: null }], { lastUpdated: '2026-10-06T18:30:00.000Z' })
  // claude 5912 started 18:00 local, the install landed 18:30Z: the test pins local
  // time to the same instant as the fixture's lstart so the comparison is exact.
  const startLocal = new Date(Date.parse('2026-10-06T18:00:00.000Z'))
  const lstart = startLocal.toString().replace(/^(\w{3}) (\w{3}) (\d{2}) (\d{4}) (\d{2}:\d{2}:\d{2}).*$/, (_m, wd, mon, d, y, t) => `${wd} ${mon} ${String(Number(d)).padStart(2, ' ')} ${t} ${y}`)
  const ps = [psLine(1, 0, '/sbin/launchd'), psLine(5912, 4100, 'claude --x', lstart)].join('\n')
  const rec = recorder({ ps, lsof: `p5912\nfcwd\nn${AVA}\n` })
  const clock = fakeClock()
  answerProbes(fs, clock, ['912'])
  const { ctx } = ctxFor(fs, rec, clock)
  const report = await runKeepAliveSweep(ctx as any)
  assert.deepEqual(rec.calls.filter((c) => c.file === 'lsof').map((c) => c.args), [['-a', '-d', 'cwd', '-p', '5912', '-Fn']])
  assert.deepEqual(rec.calls.filter((c) => c.file === 'launchctl').map((c) => c.args), [['kickstart', '-k', 'gui/501/ai.bgos.agent.912']])
  assert.deepEqual(report.agents.map((a: any) => [a.state, a.reason]), [['restarted', 'service']])
})

test('restart: a legacy daemon with recent activity and no claude visible is NOT treated as stopped', async () => {
  const fs = machine([{ id: '912', cwd: AVA, service: 'canonical', generation: null, state: null }])
  fs.writeFile(`${HOME}/.bgos-agent/912/session-id`, '8c1f0000-0000-4000-8000-000000000001\n')
  const events = `${HOME}/.bgos-plugin-state/hooks/8c1f0000-0000-4000-8000-000000000001/events.jsonl`
  fs.writeFile(events, '{}\n')
  fs.touch(events, T0 - 5 * MIN)
  const rec = recorder({ ps: [psLine(1, 0, '/sbin/launchd')].join('\n') })
  const { ctx } = ctxFor(fs, rec, fakeClock())
  const report = await runKeepAliveSweep(ctx as any)
  assert.deepEqual(report.agents.map((a: any) => [a.state, a.reason]), [['waiting_idle', 'recent_activity']])
  assert.equal(rec.calls.some((c) => c.file === 'bash'), false, 'no reinstall over a session we could not see')
})

// -- gates -------------------------------------------------------------------------------------------

test('gates: one restart per sweep; the second pending agent waits its turn', async () => {
  const fs = machine([
    { id: '912', cwd: AVA, service: 'canonical', state: {} },
    { id: '7', cwd: GURU, service: 'canonical', state: { pid: 47, claudePid: 57 } },
  ])
  const ps = [IDLE_PS, psLine(57, 1, 'claude --y')].join('\n')
  const rec = recorder({ ps })
  const clock = fakeClock()
  answerProbes(fs, clock, ['912', '7'])
  const { ctx } = ctxFor(fs, rec, clock)
  const report = await runKeepAliveSweep(ctx as any)
  assert.deepEqual(rec.calls.filter((c) => c.file === 'launchctl').map((c) => c.args[2]), ['gui/501/ai.bgos.agent.7'])
  assert.deepEqual(report.agents.map((a: any) => [a.id, a.state, a.reason]), [['7', 'restarted', 'service'], ['912', 'update_pending', 'one_restart_per_sweep']])
})

test('gates: at most one restart per agent per 30 min, 3 attempts per target version, then failed (visible)', async () => {
  const fs = machine([{ id: '912', cwd: AVA, service: 'canonical', state: {} }])
  const rec = recorder({ ps: IDLE_PS })
  const clock = fakeClock()
  // The daemon never comes back on the new version: verify times out every time.
  const { ctx } = ctxFor(fs, rec, clock, { verifyTimeoutMs: 3_000 })
  const kicks = () => rec.calls.filter((c) => c.file === 'launchctl').length
  const sweepAt = async () => {
    fs.writeFile(`${HOME}/.bgos-plugin-state/912/agent-state.json`, stateBody('912', clock.now()))
    return runKeepAliveSweep(ctx as any)
  }
  const first = await sweepAt()
  assert.equal(kicks(), 1)
  assert.deepEqual(first.agents.map((a: any) => [a.state, a.reason]), [['failed', 'agent_deaf_after_restart']])
  clock.advance(10 * MIN)
  const limited = await sweepAt()
  assert.equal(kicks(), 1)
  assert.deepEqual(limited.agents.map((a: any) => [a.state, a.reason]), [['update_pending', 'restart_rate_limited']])
  clock.advance(21 * MIN)
  await sweepAt()
  clock.advance(31 * MIN)
  await sweepAt()
  assert.equal(kicks(), 3)
  clock.advance(31 * MIN)
  const exhausted = await sweepAt()
  assert.equal(kicks(), 3, 'never a fourth attempt at the same target')
  assert.deepEqual(exhausted.agents.map((a: any) => [a.state, a.reason]), [['failed', 'attempts_exhausted']])
})

// -- Windows ----------------------------------------------------------------------------------------

const WHOME = 'C:\\Users\\kc'
const WCWD = 'C:\\Users\\kc\\hoai-agents\\ava'
const WROOT = 'C:\\Users\\kc\\.claude\\plugins\\cache\\hoai\\hoai\\0.62.1'
const WSTATE = 'C:\\Users\\kc\\.bgos-agent\\912'

function windowsMachine(extra: Record<string, string> = {}) {
  return memoryFs(
    {
      [`${WHOME}\\.bgos-agent\\credentials-912.json`]: '{}',
      [`${WSTATE}\\launch.json`]: JSON.stringify(buildLaunchRecipe({ assistantId: '912', cwd: WCWD, argv: [], installMethod: 'marketplace', pluginRoot: WROOT, node: 'node', startedAt: 'x', pid: null })),
      [`${WCWD}\\.bgos-agent-id`]: '912\n',
      [`${WHOME}\\.claude\\plugins\\installed_plugins.json`]: JSON.stringify({ plugins: { 'hoai@hoai': [{ scope: 'user', version: '0.62.1', installPath: WROOT, lastUpdated: '2026-10-06T18:30:00.000Z' }] } }),
      ...extra,
    },
    [WCWD],
  )
}

function windowsCtx(fs: MemoryFs, rec: ReturnType<typeof recorder>, extra: Record<string, unknown> = {}) {
  return ctxFor(fs, rec, fakeClock(), {
    home: WHOME,
    platform: 'win32',
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    manifest: { version: '0.62.1', fingerprint: 'f', installedAt: 'x', pluginRoot: WROOT, files: [], claudeConfigDir: null },
    execSync: execSyncFor(),
    ...extra,
  }).ctx
}

const notListing = (c: { file: string; args: string[] }) => c.file !== 'powershell.exe' || !c.args.includes('-Command')

test('win32: a cleared agent with no supervisor gets the HOAI Agent <id> logon task (files + Register-ScheduledTask), started when it is not running', async () => {
  const fs = windowsMachine()
  const rec = recorder()
  const report = await runKeepAliveSweep(windowsCtx(fs, rec) as any)
  assert.equal(fs.files.get(`${WHOME}\\.bgos-agent\\912\\supervisor-generation`), '2\n')
  assert.ok(fs.files.get(`${WHOME}\\.bgos-agent\\912\\run-agent.vbs`)!.includes(`${WROOT}\\bin\\hoai-core.mjs"" --keep-alive`))
  assert.deepEqual(rec.calls.filter(notListing).map((c) => [c.file, c.args[c.args.length - 1]]), [
    ['powershell.exe', 'install'],
    ['schtasks.exe', 'HOAI Agent 912'],
  ])
  assert.deepEqual(report.agents.map((a: any) => [a.state, a.reason]), [['installing', 'installed']])
})

test('win32: the task is registered but NOT started while the agent may be running by hand (fresh state); never a second session', async () => {
  const fs = windowsMachine({ ['C:\\Users\\kc\\.bgos-plugin-state\\912\\agent-state.json']: stateBody('912', T0) })
  const rec = recorder()
  await runKeepAliveSweep(windowsCtx(fs, rec) as any)
  assert.deepEqual(rec.calls.filter(notListing).map((c) => [c.file, c.args[c.args.length - 1]]), [['powershell.exe', 'install']])
})

test('win32: a canonical task whose launcher is dead and agent stopped is started (schtasks /Run); its launcher follows the CURRENT plugin root', async () => {
  const stale = "' old launcher pointing at 0.62.0\r\n"
  const fs = windowsMachine({ [`${WSTATE}\\run-agent.vbs`]: stale, [`${WSTATE}\\supervisor-generation`]: '2\n' })
  const rec = recorder()
  const report = await runKeepAliveSweep(windowsCtx(fs, rec) as any)
  assert.deepEqual(rec.calls.filter(notListing).map((c) => [c.file, ...c.args]), [['schtasks.exe', '/Run', '/TN', 'HOAI Agent 912']])
  assert.ok(fs.files.get(`${WSTATE}\\run-agent.vbs`)!.includes(`${WROOT}\\bin\\hoai-core.mjs`), 'the vbs was rewritten for the current root')
  assert.deepEqual(report.agents.map((a: any) => [a.state, a.reason]), [['supervised', 'task_started']])
  // A live launcher is left alone.
  const live = windowsMachine({ [`${WSTATE}\\run-agent.vbs`]: stale, [`${WSTATE}\\supervisor.json`]: JSON.stringify({ pid: 777, capabilities: ['relaunch'] }) })
  const quiet = recorder()
  await runKeepAliveSweep(windowsCtx(live, quiet, { pidAlive: (pid: number) => pid === 777 }) as any)
  assert.equal(quiet.calls.some((c) => c.file === 'schtasks.exe'), false)
})

// -- the report --------------------------------------------------------------------------------------

test('readKeepAliveReport: the persisted state as the heartbeat block (bounded to 64 agents)', () => {
  const fs = memoryFs()
  const agents: Record<string, unknown> = {}
  for (let i = 1; i <= 70; i++) agents[String(i)] = { state: 'supervised', reason: 'canonical', since: new Date(T0).toISOString() }
  fs.writeFile(keepAliveStatePath(HOME), JSON.stringify({ schemaVersion: 1, enabled: true, agents }))
  const report = readKeepAliveReport({ home: HOME, fs, now: T0 })
  assert.equal(report.enabled, true)
  assert.equal(report.agents.length, 64)
  assert.deepEqual(report.agents[0], { id: '1', state: 'supervised', reason: 'canonical', since: new Date(T0).toISOString() })
  assert.deepEqual(readKeepAliveReport({ home: HOME, fs: memoryFs(), now: T0 }), { enabled: false, agents: [] })
})

test('activity paths mirror their writers: the transcript (bin/hoai-core.mjs) and the hook spool (bin/hoai-hook.mjs)', async () => {
  const core = await import('../bin/hoai-core.mjs')
  const hook = await import('../bin/hoai-hook.mjs')
  const sid = '8c1f0000-0000-4000-8000-000000000001'
  assert.equal(mungeCwd('/Users/kc/hoai agents/ava.x'), core.mungeSessionCwd('/Users/kc/hoai agents/ava.x'))
  assert.equal(transcriptPathFor({ configDir: CONFIG, cwd: AVA, sessionId: sid }), core.sessionTranscriptPath(HOME, AVA, sid, CONFIG))
  assert.equal(hookSpoolPathFor({ env: {}, home: HOME, sessionId: sid }), hook.spoolPath(sid, {}, HOME))
  assert.equal(hookSpoolPathFor({ env: { BGOS_PLUGIN_STATE_DIR: '/s' }, home: HOME, sessionId: sid }), hook.spoolPath(sid, { BGOS_PLUGIN_STATE_DIR: '/s' }, HOME))
})
