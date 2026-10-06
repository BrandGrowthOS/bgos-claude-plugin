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
    turnSignal: 'hooks',
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
      if (opts.platform === 'linux') files[`${HOME}/.config/systemd/user/bgos-agent-${a.id}.service`] = '[Service]\n'
      else files[`${HOME}/Library/LaunchAgents/ai.bgos.agent.${a.id}.plist`] = '<plist/>'
      if (a.generation !== null) files[`${HOME}/.bgos-agent/${a.id}/supervisor-generation`] = `${a.generation ?? '2'}\n`
    }
    if (a.state) files[`${HOME}/.bgos-plugin-state/${a.id}/agent-state.json`] = stateBody(a.id, T0, a.state)
    if (a.keepalive) {
      files[`${HOME}/.bgos-agent/${a.id}/keepalive.json`] = JSON.stringify({ kind: 'keepalive', pid: a.keepalive.pid, claudePid: a.keepalive.claudePid, capabilities: ['relaunch'], tmuxSession: `agent-${a.id}` })
    }
  }
  return memoryFs(files, dirs)
}

const psLine = (pid: number, ppid: number, cmd: string, start = 'Tue Oct  6 18:00:00 2026', uid = 501) => ` ${pid} ${ppid} ${uid} ${start} ${cmd}`

function recorder(opts: { ps?: string | null; lsof?: string; lsofCode?: number | null; bashCode?: number; launchctlCode?: number; win32Ps?: string; systemctlShow?: string | null } = {}) {
  const calls: Array<{ file: string; args: string[]; opts: any }> = []
  const exec = async (file: string, args: readonly string[], o: any = {}) => {
    calls.push({ file, args: [...args], opts: o })
    if (file === 'powershell.exe' && args.includes('-Command') && opts.win32Ps != null) return { code: 0, stdout: opts.win32Ps, stderr: '', error: null, timedOut: false }
    if (file === 'ps') return opts.ps == null ? { code: 1, stdout: '', stderr: 'ps: denied', error: null, timedOut: false } : { code: 0, stdout: opts.ps, stderr: '', error: null, timedOut: false }
    if (file === 'lsof') return { code: opts.lsofCode === undefined ? 0 : opts.lsofCode, stdout: opts.lsof ?? '', stderr: '', error: null, timedOut: opts.lsofCode === null }
    if (file === 'bash') return { code: opts.bashCode ?? 0, stdout: '', stderr: opts.bashCode ? `x  no .mcp.json in ${GURU} and no creds given` : '', error: null, timedOut: false }
    if (file === 'launchctl') return { code: opts.launchctlCode ?? 0, stdout: '', stderr: '', error: null, timedOut: false }
    if (file === 'systemctl' && args.includes('show')) {
      return opts.systemctlShow == null ? { code: 1, stdout: '', stderr: 'Failed to connect to bus', error: null, timedOut: false } : { code: 0, stdout: opts.systemctlShow, stderr: '', error: null, timedOut: false }
    }
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

/** listAgents' sync probes: no loaded jobs; `ps -o comm=` answers from a table, `ps -A` (the keepalive check's table) from `procs`. */
function execSyncFor(comm: Record<number, string> = {}, procs: Array<[number, number, number, string]> | null = null) {
  return (file: string, args: string[]) => {
    if (file === 'ps' && args[1] === 'comm=') {
      const name = comm[Number(args[3])]
      return name ? { code: 0, stdout: `${name}\n` } : { code: 1, stdout: '' }
    }
    if (file === 'ps' && args[0] === '-A' && procs) return { code: 0, stdout: procs.map((r) => r.join(' ')).join('\n') + '\n' }
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
  assert.equal(rec.calls.length, 0)
  // A 404 (backend not deployed yet) is the same: off, unless a fresh cache exists.
  fs.writeFile(keepAliveCachePath(HOME), buildKeepAliveCache({ enabled: true, enabledAt: 'e', assistantIds: ['912'] }, T0 - 23 * 60 * MIN))
  const notFound = consent({ message: 'Not Found' }, false, 404)
  const second = ctxFor(fs, rec, clock, { fetchKeepAlive: notFound.fetchKeepAlive })
  const report = await runKeepAliveSweep(second.ctx as any)
  assert.equal(report.enabled, true)
  assert.equal(report.source, 'cache')
  assert.equal(rec.calls.filter((c) => c.file === 'bash').length, 1)
})

test('consent: a 401 or 403 (the pairing was revoked) is a definitive OFF, never the cache; the cache is overwritten so a later outage cannot revive it', async () => {
  for (const status of [401, 403]) {
    const fs = machine([{ id: '912', cwd: AVA, service: 'none' }])
    fs.writeFile(keepAliveCachePath(HOME), buildKeepAliveCache({ enabled: true, enabledAt: 'e', assistantIds: ['912'] }, T0 - 2 * 60 * MIN))
    const rec = recorder({ ps: IDLE_PS })
    const clock = fakeClock()
    const refused = consent({ message: 'Invalid pairing token' }, false, status)
    const report = await runKeepAliveSweep(ctxFor(fs, rec, clock, { fetchKeepAlive: refused.fetchKeepAlive }).ctx as any)
    assert.deepEqual(report, { enabled: false, source: 'refused', agents: [] }, String(status))
    assert.deepEqual(rec.calls, [], `${status}: no install, no restart, no task start`)
    assert.equal(JSON.parse(fs.files.get(keepAliveCachePath(HOME))!).enabled, false, `${status}: the ON cache is gone`)
    // The network then goes down: the cache bridges the outage as OFF.
    clock.advance(5 * MIN)
    const down = consent(null, false, 0)
    const later = await runKeepAliveSweep(ctxFor(fs, rec, clock, { fetchKeepAlive: down.fetchKeepAlive }).ctx as any)
    assert.equal(later.enabled, false, `${status}: an outage after a refusal stays off`)
    assert.deepEqual(rec.calls, [])
  }
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

test('supervise (supervisor F3): the install runs with the agent\'s own node dir (its launch recipe) and the watcher\'s node dir FIRST on PATH, so it bakes the node the agent really uses', async () => {
  const NVM = `${HOME}/.nvm/versions/node/v22.1.0/bin`
  const fs = machine([{ id: '912', cwd: AVA, service: 'none' }])
  fs.writeFile(
    `${HOME}/.bgos-agent/912/launch.json`,
    JSON.stringify(buildLaunchRecipe({ assistantId: '912', cwd: AVA, argv: [], installMethod: 'marketplace', pluginRoot: OLD_ROOT, node: `${NVM}/node`, startedAt: 'x', pid: null })),
  )
  fs.writeFile(`${NVM}/node`, '')
  const rec = recorder({ ps: IDLE_PS })
  // An upgraded watcher keeps the fixed service PATH it was installed with: no nvm on it.
  await runKeepAliveSweep(ctxFor(fs, rec, fakeClock(), { nodePath: '/opt/watcher-node/bin/node', env: { PATH: '/usr/local/bin:/usr/bin:/bin' } }).ctx as any)
  const bash = rec.calls.filter((c) => c.file === 'bash')
  assert.equal(bash.length, 1)
  assert.equal(bash[0]!.opts.env.PATH, `${NVM}:/opt/watcher-node/bin:/usr/local/bin:/usr/bin:/bin`)
  // A recipe node that is gone is not put on PATH; a dir already there is not repeated.
  const gone = machine([{ id: '912', cwd: AVA, service: 'none' }])
  gone.writeFile(
    `${HOME}/.bgos-agent/912/launch.json`,
    JSON.stringify(buildLaunchRecipe({ assistantId: '912', cwd: AVA, argv: [], installMethod: 'marketplace', pluginRoot: OLD_ROOT, node: `${NVM}/node`, startedAt: 'x', pid: null })),
  )
  const rec2 = recorder({ ps: IDLE_PS })
  await runKeepAliveSweep(ctxFor(gone, rec2, fakeClock(), { nodePath: '/usr/local/bin/node', env: { PATH: '/usr/local/bin:/usr/bin' } }).ctx as any)
  assert.equal(rec2.calls.find((c) => c.file === 'bash')!.opts.env.PATH, '/usr/local/bin:/usr/bin')
})

test('supervise: no known folder is needs_first_launch; a verified bespoke keepalive is supervised (never a second supervisor, G11)', async () => {
  const fs = machine([{ id: '912', cwd: null, service: 'none' }, { id: '7', cwd: GURU, service: 'none', keepalive: { pid: 47, claudePid: 57 } }])
  const rec = recorder({ ps: IDLE_PS })
  const { ctx } = ctxFor(fs, rec, fakeClock(), { execSync: execSyncFor({ 57: 'claude' }) })
  const report = await runKeepAliveSweep(ctx as any)
  assert.deepEqual(report.agents.map((a: any) => [a.id, a.state, a.reason ?? null]), [['7', 'supervised', 'keepalive'], ['912', 'needs_first_launch', 'no_known_folder']])
  assert.equal(rec.calls.filter((c) => c.file === 'bash').length, 0)
})

test('supervise (G11): a keepalive.json whose script is alive but whose claude is between two relaunches is supervised: no install beside it', async () => {
  // 47 (the script) is alive; 58 (the claude it names) has just exited.
  const fs = machine([{ id: '7', cwd: GURU, service: 'none', keepalive: { pid: 47, claudePid: 58 } }])
  const rec = recorder({ ps: IDLE_PS })
  const { ctx } = ctxFor(fs, rec, fakeClock(), { execSync: execSyncFor({ 57: 'claude' }) })
  const report = await runKeepAliveSweep(ctx as any)
  assert.equal(rec.calls.filter((c) => c.file === 'bash').length, 0, 'no second supervisor racing the bespoke loop')
  assert.deepEqual(report.agents.map((a: any) => [a.id, a.state, a.reason]), [['7', 'supervised', 'keepalive']])
})

test('restart (G11): an update for a keepalive that is declared but NOT verified waits: no SIGTERM, no service kick, no relaunch of our own', async () => {
  // The bespoke loop has relaunched claude as 57; keepalive.json still names the old 58.
  const fs = machine([{ id: '7', cwd: GURU, service: 'none', keepalive: { pid: 47, claudePid: 58 }, state: { pid: 4100, claudePid: 57 } }])
  const ps = [psLine(1, 0, '/sbin/launchd'), psLine(47, 1, '/bin/bash keepalive.sh'), psLine(57, 47, 'claude --x')].join('\n')
  const rec = recorder({ ps })
  const { ctx } = ctxFor(fs, rec, fakeClock(), { execSync: execSyncFor({ 57: 'claude' }) })
  const report = await runKeepAliveSweep(ctx as any)
  assert.deepEqual(rec.kills, [])
  assert.deepEqual(rec.spawns, [], 'never a second session from the recipe')
  assert.deepEqual(rec.calls.filter((c) => c.file !== 'ps'), [])
  assert.deepEqual(report.agents.map((a: any) => [a.state, a.reason]), [['update_pending', 'keepalive_unverified']])
  assert.equal(JSON.parse(fs.files.get(keepAliveStatePath(HOME))!).agents['7'].attempts, 0, 'no attempt spent')
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

test('safe moment: a turn flag that has been quiet for 3 h with no job under claude is stale: the NORMAL restart path, never a kill', async () => {
  const fs = machine([{ id: '912', cwd: AVA, service: 'canonical', state: { turnInFlight: true, lastActivityAt: new Date(T0 - 180 * MIN).toISOString() } }])
  const rec = recorder({ ps: IDLE_PS })
  const clock = fakeClock()
  answerProbes(fs, clock, ['912'])
  const { ctx } = ctxFor(fs, rec, clock)
  const report = await runKeepAliveSweep(ctx as any)
  assert.deepEqual(rec.calls.filter((c) => c.file === 'launchctl').map((c) => c.args), [['kickstart', '-k', 'gui/501/ai.bgos.agent.912']])
  assert.deepEqual(rec.kills, [])
  assert.deepEqual(report.agents.map((a: any) => [a.state, a.reason]), [['restarted', 'service']])
  // The same flag with a job still running under claude is a live turn.
  const busy = machine([{ id: '912', cwd: AVA, service: 'canonical', state: { turnInFlight: true, lastActivityAt: new Date(T0 - 180 * MIN).toISOString() } }])
  const busyRec = recorder({ ps: JOB_PS })
  const held = await runKeepAliveSweep(ctxFor(busy, busyRec, fakeClock()).ctx as any)
  assert.deepEqual(held.agents.map((a: any) => [a.state, a.reason]), [['waiting_idle', 'turn_in_flight']])
  assert.equal(busyRec.calls.some((c) => c.file === 'launchctl'), false)
})

test('safe moment: a fresh state WITHOUT the hook turn signal is judged by the legacy 30 min window (its turnInFlight=false is unknown, not idle)', async () => {
  const quiet15 = { lastActivityAt: new Date(T0 - 15 * MIN).toISOString() }
  const unsignalled = machine([{ id: '912', cwd: AVA, service: 'canonical', state: { ...quiet15, turnSignal: 'none' } }])
  const held = recorder({ ps: IDLE_PS })
  const report = await runKeepAliveSweep(ctxFor(unsignalled, held, fakeClock()).ctx as any)
  assert.deepEqual(report.agents.map((a: any) => [a.state, a.reason]), [['waiting_idle', 'recent_activity']])
  assert.equal(held.calls.some((c) => c.file === 'launchctl'), false)
  // The same quiet with the signal is idle: the 10 min window.
  const signalled = machine([{ id: '912', cwd: AVA, service: 'canonical', state: quiet15 }])
  const rec = recorder({ ps: IDLE_PS })
  const clock = fakeClock()
  answerProbes(signalled, clock, ['912'])
  const ok = await runKeepAliveSweep(ctxFor(signalled, rec, clock).ctx as any)
  assert.deepEqual(ok.agents.map((a: any) => [a.state, a.reason]), [['restarted', 'service']])
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

/** run.sh's singleton wait, as it rewrites launch-status every 5 s (bin/bgos-agent). */
function waitingBehind(fs: MemoryFs, id: string, at: number, outcome = 'waiting-for-incumbent pids=5912 ') {
  const path = `${HOME}/.bgos-agent/${id}/launch-status`
  fs.writeFile(path, `2026-10-06 19:00:00 outcome=${outcome}\n`)
  fs.touch(path, at)
}

test('restart (D4): a live hoai launcher with the canonical supervisor waiting behind it is restarted through the MARKER, never a kickstart of the waiting run.sh', async () => {
  const fs = machine([{ id: '912', cwd: AVA, service: 'canonical', state: {} }])
  // The person's own `hoai` (pid 4100, claude's parent) holds the folder; run.sh waits.
  fs.writeFile(`${HOME}/.bgos-agent/912/supervisor.json`, JSON.stringify({ pid: 4100, capabilities: ['relaunch'], startedAt: 'x' }))
  waitingBehind(fs, '912', T0 - 5_000)
  const rec = recorder({ ps: IDLE_PS })
  const clock = fakeClock()
  answerProbes(fs, clock, ['912'])
  const { ctx } = ctxFor(fs, rec, clock)
  const report = await runKeepAliveSweep(ctx as any)
  assert.equal(fs.files.get(`${HOME}/.bgos-agent/912/restart-requested.json`), '{}')
  assert.equal(rec.calls.some((c) => c.file === 'launchctl'), false)
  assert.deepEqual(rec.kills, [])
  assert.deepEqual(report.agents.map((a: any) => [a.state, a.reason]), [['restarted', 'marker']])
})

test('restart (design): the canonical v2 service\'s OWN live hoai is restarted through the service (hoai itself moves onto the installed code), never only its claude', async () => {
  const fs = machine([{ id: '912', cwd: AVA, service: 'canonical', state: {} }])
  fs.writeFile(`${HOME}/.bgos-agent/912/supervisor.json`, JSON.stringify({ pid: 3000, capabilities: ['relaunch'], startedAt: 'x' }))
  const ps = [
    psLine(1, 0, '/sbin/launchd'),
    psLine(2900, 1, `tmux -L hoai-912 new-session -d -s hoai-912 -x 200 -y 50 -c ${AVA} /usr/bin/env HOAI_SUPERVISED=1 node ${OLD_ROOT}/bin/hoai-core.mjs`),
    psLine(3000, 2900, `node ${OLD_ROOT}/bin/hoai-core.mjs`),
    psLine(5912, 3000, 'claude --resume 8c1f0000-0000-4000-8000-000000000001'),
    psLine(4912, 5912, `node ${OLD_ROOT}/server.ts`),
  ].join('\n')
  const rec = recorder({ ps })
  const clock = fakeClock()
  answerProbes(fs, clock, ['912'])
  const report = await runKeepAliveSweep(ctxFor(fs, rec, clock, { pidAlive: (pid: number) => [3000, 4912, 5912].includes(pid) }).ctx as any)
  assert.deepEqual(rec.calls.filter((c) => c.file === 'launchctl').map((c) => c.args), [['kickstart', '-k', 'gui/501/ai.bgos.agent.912']])
  assert.equal(fs.files.has(`${HOME}/.bgos-agent/912/restart-requested.json`), false)
  assert.equal(rec.calls.filter((c) => c.file === 'ps').length, 1, 'the sweep hands its own listing to the ladder')
  assert.deepEqual(report.agents.map((a: any) => [a.state, a.reason]), [['restarted', 'service']])
})

test('restart (D4): a plain hand-run claude the canonical supervisor waits behind is waiting_idle manual_session: no restart, no kill, no attempt spent', async () => {
  const fs = machine([{ id: '912', cwd: AVA, service: 'canonical', state: {} }])
  waitingBehind(fs, '912', T0 - 5_000)
  const rec = recorder({ ps: IDLE_PS })
  const clock = fakeClock()
  const { ctx } = ctxFor(fs, rec, clock)
  for (let sweep = 0; sweep < 4; sweep++) {
    waitingBehind(fs, '912', clock.now() - 5_000)
    fs.writeFile(`${HOME}/.bgos-plugin-state/912/agent-state.json`, stateBody('912', clock.now()))
    const report = await runKeepAliveSweep(ctx as any)
    assert.deepEqual(report.agents, [{ id: '912', state: 'waiting_idle', reason: 'manual_session', since: new Date(T0).toISOString() }], `sweep ${sweep}`)
    clock.advance(31 * MIN)
  }
  assert.deepEqual(rec.calls.filter((c) => c.file !== 'ps' && c.file !== 'lsof'), [], 'no launchctl, no bash')
  assert.deepEqual(rec.kills, [])
  assert.equal(fs.files.has(`${HOME}/.bgos-agent/912/restart-requested.json`), false)
  assert.equal(JSON.parse(fs.files.get(keepAliveStatePath(HOME))!).agents['912'].attempts, 0)
})

test('restart (D4): a generation 1 supervisor waiting behind a hand-run claude is still UPGRADED (the reinstall never touches that session, and the takeover then resumes the pin)', async () => {
  const fs = machine([{ id: '912', cwd: AVA, service: 'canonical', generation: null, state: { runningVersion: '0.62.1' } }])
  waitingBehind(fs, '912', T0 - 5_000)
  const rec = recorder({ ps: IDLE_PS })
  const clock = fakeClock()
  answerProbes(fs, clock, ['912'])
  const report = await runKeepAliveSweep(ctxFor(fs, rec, clock).ctx as any)
  assert.deepEqual(rec.calls.filter((c) => c.file === 'bash').map((c) => c.args[1]), ['install'])
  assert.deepEqual(rec.kills, [])
  assert.deepEqual(report.agents.map((a: any) => [a.state, a.reason]), [['restarted', 'reinstall']])
})

test('restart (D4): a launch-status that is not a FRESH wait does not hold the restart (run.sh has moved on, or died waiting)', async () => {
  for (const [name, outcome, age] of [
    ['an old wait', 'waiting-for-incumbent pids=5912 ', 10 * MIN],
    ['a fresh status that is not a wait', 'starting compact=on', 5_000],
  ] as Array<[string, string, number]>) {
    const fs = machine([{ id: '912', cwd: AVA, service: 'canonical', state: {} }])
    waitingBehind(fs, '912', T0 - age, outcome)
    const rec = recorder({ ps: IDLE_PS })
    const clock = fakeClock()
    answerProbes(fs, clock, ['912'])
    const report = await runKeepAliveSweep(ctxFor(fs, rec, clock).ctx as any)
    assert.deepEqual(rec.calls.filter((c) => c.file === 'launchctl').map((c) => c.args), [['kickstart', '-k', 'gui/501/ai.bgos.agent.912']], name)
    assert.deepEqual(report.agents.map((a: any) => [a.state, a.reason]), [['restarted', 'service']], name)
  }
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

test('restart (F6): a keepalive.json whose claudePid is a live claude that is NOT this agent\'s (a reused pid) is never signalled: keepalive_unverified', async () => {
  // The agent's own claude is 60 (its daemon says so); the stale marker still names 57, now a person's claude elsewhere.
  const fs = machine([{ id: '7', cwd: GURU, service: 'none', keepalive: { pid: 47, claudePid: 57 }, state: { claudePid: 60, pid: 4100 } }])
  const ps = [psLine(1, 0, '/sbin/launchd'), psLine(47, 1, '/bin/bash keepalive.sh'), psLine(60, 47, 'claude --x'), psLine(4000, 1, 'zsh'), psLine(57, 4000, 'claude --y')].join('\n')
  const rec = recorder({ ps })
  const procs: Array<[number, number, number, string]> = [[1, 0, 0, '9-00:00:00'], [47, 1, 501, '02:00:00'], [60, 47, 501, '01:00:00'], [4000, 1, 501, '03:00:00'], [57, 4000, 501, '01:30:00']]
  const { ctx } = ctxFor(fs, rec, fakeClock(), { execSync: execSyncFor({ 57: 'claude', 60: 'claude' }, procs), pidAlive: (pid: number) => [47, 57, 60, 4100, 4000].includes(pid) })
  const report = await runKeepAliveSweep(ctx as any)
  assert.deepEqual(rec.kills, [], 'never a SIGTERM to a claude that is not provably this agent\'s')
  assert.deepEqual(report.agents.map((a: any) => [a.state, a.reason]), [['update_pending', 'keepalive_unverified']])
})

test('restart (F6): the keepalive is verified again right before its SIGTERM; a claude pid that stopped being this agent\'s while the sweep ran is not signalled', async () => {
  const FIVE = `${HOME}/hoai-agents/five`
  const fs = machine([
    { id: '5', cwd: FIVE, service: 'none' },
    { id: '7', cwd: GURU, service: 'none', keepalive: { pid: 47, claudePid: 57 }, state: { claudePid: 57, pid: 47 } },
  ])
  const ps = [psLine(1, 0, '/sbin/launchd'), psLine(57, 1, 'claude --x'), psLine(47, 1, '/bin/bash keepalive.sh')].join('\n')
  const rec = recorder({ ps })
  // While agent 5's install ran, claude 57 exited and its pid went to a tmux server.
  const before = execSyncFor({ 57: 'claude' })
  const after = execSyncFor({ 57: 'tmux' })
  const execSync = (file: string, args: string[]) => (rec.calls.some((c) => c.file === 'bash') ? after : before)(file, args)
  const { ctx } = ctxFor(fs, rec, fakeClock(), { execSync, fetchKeepAlive: consent({ enabled: true, enabledAt: 'e', assistantIds: [5, 7] }).fetchKeepAlive })
  const report = await runKeepAliveSweep(ctx as any)
  assert.deepEqual(rec.calls.filter((c) => c.file === 'bash').map((c) => c.args[3]), ['5'])
  assert.deepEqual(rec.kills, [])
  assert.deepEqual(report.agents.map((a: any) => [a.id, a.state, a.reason]), [['5', 'installing', 'installed'], ['7', 'update_pending', 'keepalive_unverified']])
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

test('safe moment (F3): the process table is read again after an install: a job started while the install ran is seen, never judged on the old table', async () => {
  const FIVE = `${HOME}/hoai-agents/five`
  // 5: canonical, a daemon too old to publish state (its observe takes the first listing);
  // 7: no supervisor (the install runs here, up to 10 min); 912: fresh state, update pending.
  const fs = machine([
    { id: '5', cwd: FIVE, service: 'canonical', state: null },
    { id: '7', cwd: GURU, service: 'none' },
    { id: '912', cwd: AVA, service: 'canonical', state: {} },
  ])
  const rec = recorder({ ps: IDLE_PS })
  let listings = 0
  const exec = async (file: string, args: readonly string[], o: any = {}) => {
    if (file === 'ps') {
      listings += 1
      // While 7's install ran, 912 started a background monitor.
      const bashRan = rec.calls.some((c) => c.file === 'bash')
      rec.calls.push({ file, args: [...args], opts: o })
      return { code: 0, stdout: bashRan ? JOB_PS : IDLE_PS, stderr: '', error: null, timedOut: false }
    }
    return rec.exec(file, args, o)
  }
  const clock = fakeClock()
  answerProbes(fs, clock, ['912'])
  const { ctx } = ctxFor(fs, rec, clock, { exec, fetchKeepAlive: consent({ enabled: true, enabledAt: 'e', assistantIds: [5, 7, 912] }).fetchKeepAlive })
  const report = await runKeepAliveSweep(ctx as any)
  assert.deepEqual(rec.calls.filter((c) => c.file === 'bash').map((c) => c.args[3]), ['7'])
  assert.ok(listings >= 2, 'a fresh listing after the install')
  assert.equal(rec.calls.some((c) => c.file === 'launchctl'), false, 'no kickstart -k over the live job')
  assert.deepEqual(report.agents.map((a: any) => [a.id, a.state, a.reason]).filter((r: any) => r[0] === '912'), [['912', 'waiting_idle', 'background_job']])
})

test('state (F8): an act is persisted BEFORE its verify, so a watcher killed mid verify keeps the attempt and the 30 min limit', async () => {
  const fs = machine([{ id: '912', cwd: AVA, service: 'canonical', state: {} }])
  const rec = recorder({ ps: IDLE_PS })
  const clock = fakeClock()
  let release: () => void = () => {}
  const parked = new Promise<void>((resolve) => (release = resolve))
  // verify sleeps between probes: park it there, the moment a kill would land.
  const { ctx } = ctxFor(fs, rec, clock, {
    sleep: async (ms: number) => {
      await parked
      clock.advance(ms)
    },
  })
  const running = runKeepAliveSweep(ctx as any)
  try {
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r))
    assert.equal(rec.calls.filter((c) => c.file === 'launchctl').length, 1, 'the restart happened')
    const saved = JSON.parse(fs.files.get(keepAliveStatePath(HOME)) ?? '{}')
    assert.equal(saved.agents?.['912']?.attempts, 1, 'the attempt is on disk while verify runs')
    assert.equal(saved.agents?.['912']?.lastRestartAt, new Date(T0).toISOString())
    assert.equal(saved.agents?.['912']?.target, '0.62.1')
  } finally {
    release()
    await running
  }
})

test('state (F8): a throw during verify still counts the attempt (counted before the act, never rebuilt from the old record)', async () => {
  const fs = machine([{ id: '912', cwd: AVA, service: 'canonical', state: {} }])
  const rec = recorder({ ps: IDLE_PS })
  const { ctx } = ctxFor(fs, rec, fakeClock(), {
    sleep: async () => {
      throw new Error('boom')
    },
  })
  const report = await runKeepAliveSweep(ctx as any)
  assert.match(report.agents[0].reason, /^internal_error:boom/)
  const saved = JSON.parse(fs.files.get(keepAliveStatePath(HOME))!)
  assert.equal(saved.agents['912'].attempts, 1)
  assert.equal(saved.agents['912'].lastRestartAt, new Date(T0).toISOString())
})

test('state (F8): a supervisor install is on disk BEFORE it runs, so a watcher killed mid install waits out the retry hour instead of installing again at once', async () => {
  const fs = machine([{ id: '912', cwd: AVA, service: 'none' }])
  const rec = recorder({ ps: IDLE_PS })
  let duringInstall: string | null = null
  const exec = async (file: string, args: readonly string[], o: any = {}) => {
    // What a kill at this moment (bun install running) would leave on disk.
    if (file === 'bash') duringInstall = fs.files.get(keepAliveStatePath(HOME)) ?? null
    return rec.exec(file, args, o)
  }
  await runKeepAliveSweep(ctxFor(fs, rec, fakeClock(), { exec }).ctx as any)
  assert.equal(rec.calls.filter((c) => c.file === 'bash').length, 1)
  const saved = JSON.parse(duringInstall ?? '{}')
  assert.equal(saved.agents?.['912']?.lastInstallAt, new Date(T0).toISOString(), 'the install is recorded before bgos-agent runs')
  assert.deepEqual([saved.agents?.['912']?.state, saved.agents?.['912']?.reason], ['installing', 'install_in_progress'])
  // The watcher died there: the next start reads that file, and does not install again within the hour.
  const killed = machine([{ id: '912', cwd: AVA, service: 'none' }])
  killed.writeFile(keepAliveStatePath(HOME), duringInstall!)
  const again = recorder({ ps: IDLE_PS })
  const clock = fakeClock()
  clock.advance(5 * MIN)
  const report = await runKeepAliveSweep(ctxFor(killed, again, clock).ctx as any)
  assert.deepEqual(again.calls.filter((c) => c.file === 'bash'), [])
  assert.deepEqual(report.agents.map((a: any) => [a.state, a.reason]), [['installing', 'install_retry_wait']])
})

test('online (F8): a long sweep keeps the watcher online: keepOnline between agents, through a long install, and through verify', { timeout: 10_000 }, async () => {
  const fs = machine([
    { id: '7', cwd: GURU, service: 'none' },
    { id: '912', cwd: AVA, service: 'canonical', state: {} },
  ])
  const rec = recorder({ ps: IDLE_PS })
  const clock = fakeClock()
  // The install takes 5 minutes of (fake) wall time.
  let installDone: () => void = () => {}
  const installAt = { start: 0 }
  clock.onSleep((_ms, at) => {
    if (installAt.start && at - installAt.start >= 5 * MIN) installDone()
  })
  const exec = async (file: string, args: readonly string[], o: any = {}) => {
    if (file === 'bash') {
      rec.calls.push({ file, args: [...args], opts: o })
      installAt.start = clock.now()
      await new Promise<void>((resolve) => (installDone = resolve))
      return { code: 0, stdout: '', stderr: '', error: null, timedOut: false }
    }
    return rec.exec(file, args, o)
  }
  const touches: Array<[string, number]> = []
  let phase = 'start'
  const keepOnline = async () => {
    touches.push([phase, clock.now()])
  }
  answerProbes(fs, clock, [])
  const { ctx } = ctxFor(fs, rec, clock, { exec, keepOnline, verifyTimeoutMs: 120_000, fetchKeepAlive: consent({ enabled: true, enabledAt: 'e', assistantIds: [7, 912] }).fetchKeepAlive })
  clock.onSleep(() => {
    phase = rec.calls.some((c) => c.file === 'launchctl') ? 'verify' : rec.calls.some((c) => c.file === 'bash') ? 'install' : 'start'
  })
  await runKeepAliveSweep(ctx as any)
  assert.equal(rec.calls.filter((c) => c.file === 'bash').length, 1)
  assert.equal(rec.calls.filter((c) => c.file === 'launchctl').length, 1)
  const during = (name: string) => touches.filter(([p]) => p === name).length
  assert.ok(during('install') >= 5, `touched through the 5 min install (${during('install')})`)
  assert.ok(during('verify') >= 1, `touched through the 2 min verify (${during('verify')})`)
  // No gap between two touches (or the sweep start) long enough to leave the backend's 3 min online window.
  const stamps = [T0, ...touches.map(([, at]) => at)]
  for (let i = 1; i < stamps.length; i++) assert.ok(stamps[i]! - stamps[i - 1]! < 3 * MIN, `gap ${i}`)
})

// -- F1: a cwd lookup that failed or spelled the folder differently is never "not running" ----------

test('F1: a cwd lookup that FAILED is unknown, never "stopped": a generation 1 supervisor over a live claude with a job is not reinstalled', async () => {
  for (const [name, lsof] of [
    ['lsof exit 1 with nothing printed', { lsofCode: 1, lsof: '' }],
    ['lsof timed out', { lsofCode: null, lsof: '' }],
    ['lsof answered, but not for our live claude', { lsofCode: 0, lsof: '' }],
  ] as Array<[string, Record<string, unknown>]>) {
    const fs = machine([{ id: '912', cwd: AVA, service: 'canonical', generation: null, state: null }])
    const rec = recorder({ ps: JOB_PS, ...lsof })
    const report = await runKeepAliveSweep(ctxFor(fs, rec, fakeClock()).ctx as any)
    assert.deepEqual(rec.calls.filter((c) => c.file === 'bash'), [], `${name}: no reinstall over the job`)
    assert.deepEqual(report.agents.map((a: any) => [a.state, a.reason]), [['waiting_idle', 'process_tree_unreadable']], name)
  }
})

test('F1: the folder is compared by its realpath (the kernel reports the physical path): the job under that claude is seen', async () => {
  const fs = machine([{ id: '912', cwd: AVA, service: 'canonical', generation: null, state: null }])
  const rec = recorder({ ps: JOB_PS, lsof: `p5912\nfcwd\nn/Volumes/Data${AVA}\n` })
  const realpath = (path: string) => (path === AVA ? `/Volumes/Data${AVA}` : path)
  const report = await runKeepAliveSweep(ctxFor(fs, rec, fakeClock(), { realpath }).ctx as any)
  assert.deepEqual(rec.calls.filter((c) => c.file === 'bash'), [])
  assert.deepEqual(report.agents.map((a: any) => [a.state, a.reason]), [['waiting_idle', 'background_job']])
})

test('F1: another user\'s claude (its cwd is not ours to read) never makes this agent unknown; with no claude of ours it is really stopped', async () => {
  const fs = machine([{ id: '912', cwd: AVA, service: 'canonical', generation: null, state: null }])
  const ps = [psLine(1, 0, '/sbin/launchd', undefined, 0), psLine(1618, 1, 'claude --x', undefined, 502)].join('\n')
  const rec = recorder({ ps, lsofCode: 1, lsof: '' })
  const clock = fakeClock()
  answerProbes(fs, clock, ['912'])
  const report = await runKeepAliveSweep(ctxFor(fs, rec, clock, { pidAlive: (pid: number) => pid === 1618 }).ctx as any)
  assert.deepEqual(rec.calls.filter((c) => c.file === 'bash').map((c) => c.args[1]), ['install'])
  assert.deepEqual(report.agents.map((a: any) => [a.state, a.reason]), [['restarted', 'reinstall']])
})

test('F1: a daemon too old to publish its state still holds the pairing lock: its claude (the one above it) is the agent\'s, no cwd needed', async () => {
  const fs = machine([{ id: '912', cwd: AVA, service: 'canonical', generation: null, state: null }])
  fs.writeFile(`${HOME}/.bgos-agent/credentials-912.json.lock`, JSON.stringify({ pid: 4912, heartbeatAt: T0 - 3_000, bootedAt: T0 - 60 * MIN }))
  // lsof cannot help at all, yet the job under the lock holder's claude is found.
  const rec = recorder({ ps: JOB_PS, lsofCode: 1, lsof: '' })
  const report = await runKeepAliveSweep(ctxFor(fs, rec, fakeClock()).ctx as any)
  assert.deepEqual(report.agents.map((a: any) => [a.state, a.reason]), [['waiting_idle', 'background_job']])
  assert.equal(rec.calls.some((c) => c.file === 'lsof'), false, 'no cwd lookup needed')
  assert.deepEqual(rec.calls.filter((c) => c.file === 'bash'), [])
  // A lock nobody has stamped for 10 minutes names no live daemon (its pid may be anyone's now).
  fs.writeFile(`${HOME}/.bgos-agent/credentials-912.json.lock`, JSON.stringify({ pid: 4912, heartbeatAt: T0 - 10 * MIN }))
  const stale = recorder({ ps: JOB_PS, lsofCode: 1, lsof: '' })
  const staleReport = await runKeepAliveSweep(ctxFor(fs, stale, fakeClock()).ctx as any)
  assert.deepEqual(staleReport.agents.map((a: any) => [a.state, a.reason]), [['waiting_idle', 'process_tree_unreadable']])
  assert.equal(stale.calls.some((c) => c.file === 'lsof'), true, 'back to the cwd lookup')
})

// -- F5: a systemd restart kills the unit's whole cgroup, so a job orphaned out of claude's tree counts --------

const CGROUP = '/user.slice/user-501.slice/user@501.service/app.slice/bgos-agent-912.service'
const UNIT_SHOW = `MainPID=1000\nControlGroup=${CGROUP}\n`

/** A v2 unit: run.sh 1000 (main) waiting on tmux; tmux server 2900 > hoai-core 3000 > claude 5912 > daemon 4912. */
function unitTable(orphan: boolean, tmuxTitle = 'tmux: server (/tmp/tmux-501/hoai-912)') {
  const rows = [
    psLine(1, 0, '/sbin/init', undefined, 0),
    psLine(900, 1, '/lib/systemd/systemd --user'),
    psLine(1000, 900, `/bin/bash ${HOME}/.bgos-agent/912/run.sh`),
    psLine(1100, 1000, 'sleep 5'),
    psLine(2900, 900, tmuxTitle),
    psLine(3000, 2900, `node ${OLD_ROOT}/bin/hoai-core.mjs`),
    psLine(5912, 3000, 'claude --resume x'),
    psLine(4912, 5912, `node ${OLD_ROOT}/server.ts`),
  ]
  // `nohup python monitor.py &` from a Bash tool call: its shell exited, systemd --user reaped it.
  if (orphan) rows.push(psLine(7000, 900, 'python monitor.py'))
  const members = [1000, 1100, 2900, 3000, 5912, 4912, ...(orphan ? [7000] : [])]
  return { ps: rows.join('\n'), procs: `${members.join('\n')}\n` }
}

test('F5 (linux): a background job orphaned out of claude\'s tree but still in the unit\'s cgroup holds a service restart (systemd would kill it): background_job', async () => {
  const busy = unitTable(true)
  const fs = machine([{ id: '912', cwd: AVA, service: 'canonical', state: {} }], { platform: 'linux' })
  fs.writeFile(`/sys/fs/cgroup${CGROUP}/cgroup.procs`, busy.procs)
  const rec = recorder({ ps: busy.ps, systemctlShow: UNIT_SHOW })
  const report = await runKeepAliveSweep(ctxFor(fs, rec, fakeClock(), { platform: 'linux' }).ctx as any)
  assert.equal(rec.calls.some((c) => c.file === 'systemctl' && c.args.includes('restart')), false, 'no systemctl --user restart over the job')
  assert.deepEqual(report.agents.map((a: any) => [a.state, a.reason]), [['waiting_idle', 'background_job']])
  // The same unit with nothing outside the supervisor and claude restarts.
  const idle = unitTable(false)
  const quiet = machine([{ id: '912', cwd: AVA, service: 'canonical', state: {} }], { platform: 'linux' })
  quiet.writeFile(`/sys/fs/cgroup${CGROUP}/cgroup.procs`, idle.procs)
  const ok = recorder({ ps: idle.ps, systemctlShow: UNIT_SHOW })
  const clock = fakeClock()
  answerProbes(quiet, clock, ['912'])
  const done = await runKeepAliveSweep(ctxFor(quiet, ok, clock, { platform: 'linux' }).ctx as any)
  assert.deepEqual(ok.calls.filter((c) => c.file === 'systemctl' && c.args.includes('restart')).map((c) => c.args), [['--user', 'restart', 'bgos-agent-912']])
  assert.deepEqual(done.agents.map((a: any) => [a.state, a.reason]), [['restarted', 'service']])
  // A tmux whose title says nothing about its socket is still claude's ancestor in the group: accounted, not a job.
  const plain = unitTable(false, 'tmux')
  const plainFs = machine([{ id: '912', cwd: AVA, service: 'canonical', state: {} }], { platform: 'linux' })
  plainFs.writeFile(`/sys/fs/cgroup${CGROUP}/cgroup.procs`, plain.procs)
  const plainRec = recorder({ ps: plain.ps, systemctlShow: UNIT_SHOW })
  const plainClock = fakeClock()
  answerProbes(plainFs, plainClock, ['912'])
  const plainReport = await runKeepAliveSweep(ctxFor(plainFs, plainRec, plainClock, { platform: 'linux' }).ctx as any)
  assert.deepEqual(plainReport.agents.map((a: any) => [a.state, a.reason]), [['restarted', 'service']])
})

test('F5 (linux): a generation 1 unit is not reinstalled (its active unit restarted) over an orphaned job; a cgroup that cannot be read is unreadable, never "no job"', async () => {
  const gen1 = [
    psLine(1, 0, '/sbin/init', undefined, 0),
    psLine(900, 1, '/lib/systemd/systemd --user'),
    psLine(1000, 900, `/bin/bash ${HOME}/.bgos-agent/912/run.sh`),
    psLine(1050, 1000, `expect ${HOME}/.bgos-agent/912/run.expect`),
    psLine(5912, 1050, 'claude --x'),
    psLine(7000, 900, 'python monitor.py'),
  ].join('\n')
  const fs = machine([{ id: '912', cwd: AVA, service: 'canonical', generation: null, state: { runningVersion: '0.62.1' } }], { platform: 'linux' })
  fs.writeFile(`/sys/fs/cgroup${CGROUP}/cgroup.procs`, '1000\n1050\n5912\n7000\n')
  const rec = recorder({ ps: gen1, systemctlShow: UNIT_SHOW })
  const report = await runKeepAliveSweep(ctxFor(fs, rec, fakeClock(), { platform: 'linux' }).ctx as any)
  assert.deepEqual(rec.calls.filter((c) => c.file === 'bash'), [])
  assert.deepEqual(report.agents.map((a: any) => [a.state, a.reason]), [['waiting_idle', 'background_job']])
  const blind = machine([{ id: '912', cwd: AVA, service: 'canonical', state: {} }], { platform: 'linux' })
  const noBus = recorder({ ps: unitTable(false).ps, systemctlShow: null })
  const unread = await runKeepAliveSweep(ctxFor(blind, noBus, fakeClock(), { platform: 'linux' }).ctx as any)
  assert.equal(noBus.calls.some((c) => c.file === 'systemctl' && c.args.includes('restart')), false)
  assert.deepEqual(unread.agents.map((a: any) => [a.state, a.reason]), [['waiting_idle', 'process_tree_unreadable']])
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

test('gates: once 3 attempts at a target are spent the row is failed attempts_exhausted, busy or idle, and its since holds still', async () => {
  const fs = machine([{ id: '912', cwd: AVA, service: 'canonical', state: {} }])
  const spentAt = new Date(T0 - 5 * 60 * MIN).toISOString()
  fs.writeFile(
    keepAliveStatePath(HOME),
    JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      consentSource: 'live',
      agents: { '912': { state: 'failed', reason: 'attempts_exhausted', since: spentAt, target: '0.62.1', attempts: 3, lastRestartAt: new Date(T0 - 6 * 60 * MIN).toISOString() } },
    }),
  )
  const clock = fakeClock()
  const busy = recorder({ ps: JOB_PS })
  const first = await runKeepAliveSweep(ctxFor(fs, busy, clock).ctx as any)
  assert.deepEqual(first.agents, [{ id: '912', state: 'failed', reason: 'attempts_exhausted', since: spentAt }], 'a background job does not turn it back into waiting_idle')
  clock.advance(1 * MIN)
  fs.writeFile(`${HOME}/.bgos-plugin-state/912/agent-state.json`, stateBody('912', clock.now(), { turnInFlight: true }))
  const turn = await runKeepAliveSweep(ctxFor(fs, recorder({ ps: IDLE_PS }), clock).ctx as any)
  assert.deepEqual(turn.agents, [{ id: '912', state: 'failed', reason: 'attempts_exhausted', since: spentAt }], 'nor does a turn in flight')
  clock.advance(1 * MIN)
  fs.writeFile(`${HOME}/.bgos-plugin-state/912/agent-state.json`, stateBody('912', clock.now()))
  const idle = recorder({ ps: IDLE_PS })
  const quiet = await runKeepAliveSweep(ctxFor(fs, idle, clock).ctx as any)
  assert.deepEqual(quiet.agents, [{ id: '912', state: 'failed', reason: 'attempts_exhausted', since: spentAt }])
  assert.equal([...busy.calls, ...idle.calls].some((c) => c.file === 'launchctl'), false, 'never a fourth attempt')
})

// -- Windows ----------------------------------------------------------------------------------------

const WHOME = 'C:\\Users\\kc'
const WCWD = 'C:\\Users\\kc\\hoai-agents\\ava'
const WROOT = 'C:\\Users\\kc\\.claude\\plugins\\cache\\hoai\\hoai\\0.62.1'
const WSTATE = 'C:\\Users\\kc\\.bgos-agent\\912'

/** The hoai-core.mjs text a --keep-alive launcher carries (bin/hoai-core.mjs RUN_KEEP_ALIVE_FLAGS); an older one never mentions it. */
const HOAI_CORE_KEEP_ALIVE = "export const RUN_KEEP_ALIVE_FLAGS = Object.freeze(['--keep-alive'])\n"
const HOAI_CORE_OLD = "export const RUN_FRESH_FLAGS = Object.freeze(['--new'])\n"

function windowsMachine(extra: Record<string, string> = {}) {
  return memoryFs(
    {
      [`${WROOT}\\bin\\hoai-core.mjs`]: HOAI_CORE_KEEP_ALIVE,
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

test('win32: a dead launcher gets the restart limits (1 task start per 30 min, 3 per death episode, then failed task_start_failed); 10 min alive ends the episode', async () => {
  const fs = windowsMachine({
    [`${WSTATE}\\run-agent.vbs`]: "' old launcher\r\n",
    [`${WSTATE}\\supervisor-generation`]: '2\n',
    [`${WSTATE}\\supervisor.json`]: JSON.stringify({ pid: 777, capabilities: ['relaunch'] }),
  })
  const rec = recorder()
  const clock = fakeClock()
  let launcherAlive = false
  const ctx = windowsCtx(fs, rec, { now: clock.now, sleep: clock.sleep, pidAlive: (pid: number) => launcherAlive && pid === 777 })
  const starts = () => rec.calls.filter((c) => c.file === 'schtasks.exe').length
  const sweep = async () => (await runKeepAliveSweep(ctx as any)).agents.map((a: any) => [a.state, a.reason])
  assert.deepEqual(await sweep(), [['supervised', 'task_started']])
  assert.equal(starts(), 1)
  clock.advance(1 * MIN)
  assert.deepEqual(await sweep(), [['supervised', 'task_start_rate_limited']])
  assert.equal(starts(), 1, 'not a schtasks /Run every sweep')
  clock.advance(30 * MIN)
  await sweep()
  assert.equal(starts(), 2)
  clock.advance(31 * MIN)
  await sweep()
  assert.equal(starts(), 3)
  clock.advance(31 * MIN)
  assert.deepEqual(await sweep(), [['failed', 'task_start_failed']])
  clock.advance(60 * MIN)
  assert.deepEqual(await sweep(), [['failed', 'task_start_failed']])
  assert.equal(starts(), 3, 'never a fourth start in one launcher death episode')
  const failedSince = JSON.parse(fs.files.get(keepAliveStatePath(WHOME))!).agents['912'].since
  assert.equal(failedSince, new Date(clock.now() - 60 * MIN).toISOString(), 'the failed row holds still')
  // The launcher comes back (a logon, the task's own RestartCount) and stays up 10 minutes: the episode is over.
  launcherAlive = true
  assert.deepEqual(await sweep(), [['supervised', 'canonical']])
  clock.advance(10 * MIN)
  await sweep()
  launcherAlive = false
  clock.advance(1 * MIN)
  assert.deepEqual(await sweep(), [['supervised', 'task_started']])
  assert.equal(starts(), 4)
})

test('win32: a launcher that dies again within 10 minutes of coming back is the SAME death episode', async () => {
  const fs = windowsMachine({
    [`${WSTATE}\\run-agent.vbs`]: "' old launcher\r\n",
    [`${WSTATE}\\supervisor.json`]: JSON.stringify({ pid: 777, capabilities: ['relaunch'] }),
  })
  const rec = recorder()
  const clock = fakeClock()
  let launcherAlive = false
  const ctx = windowsCtx(fs, rec, { now: clock.now, sleep: clock.sleep, pidAlive: (pid: number) => launcherAlive && pid === 777 })
  const starts = () => rec.calls.filter((c) => c.file === 'schtasks.exe').length
  for (let i = 0; i < 3; i++) {
    launcherAlive = false
    await runKeepAliveSweep(ctx as any)
    clock.advance(1 * MIN)
    launcherAlive = true
    await runKeepAliveSweep(ctx as any)
    clock.advance(30 * MIN)
  }
  assert.equal(starts(), 3)
  launcherAlive = false
  const report = await runKeepAliveSweep(ctx as any)
  assert.deepEqual(report.agents.map((a: any) => [a.state, a.reason]), [['failed', 'task_start_failed']])
  assert.equal(starts(), 3)
})

test('win32: a CURRENT root whose hoai-core has no --keep-alive gets no task registered (supervisor_v2_unavailable)', async () => {
  const old = { [`${WROOT}\\bin\\hoai-core.mjs`]: HOAI_CORE_OLD }
  // No supervisor yet: no files, no Register-ScheduledTask.
  const fresh = windowsMachine(old)
  const rec = recorder()
  const report = await runKeepAliveSweep(windowsCtx(fresh, rec) as any)
  assert.deepEqual(rec.calls.filter(notListing), [])
  assert.equal(fresh.files.has(`${WSTATE}\\run-agent.vbs`), false)
  assert.equal(fresh.files.has(`${WSTATE}\\install-agent-task.ps1`), false)
  assert.deepEqual(report.agents.map((a: any) => [a.state, a.reason]), [['failed', 'supervisor_v2_unavailable']])
})

test('win32: a task whose launcher is dead is never started onto a hoai-core with no --keep-alive, nor repointed at it', async () => {
  const old = { [`${WROOT}\\bin\\hoai-core.mjs`]: HOAI_CORE_OLD }
  // The agent stopped: not started, its vbs left alone.
  const stale = "' old launcher pointing at 0.62.0\r\n"
  const dead = windowsMachine({ ...old, [`${WSTATE}\\run-agent.vbs`]: stale, [`${WSTATE}\\supervisor-generation`]: '2\n' })
  const deadRec = recorder()
  const deadReport = await runKeepAliveSweep(windowsCtx(dead, deadRec) as any)
  assert.deepEqual(deadRec.calls.filter(notListing), [])
  assert.equal(dead.files.get(`${WSTATE}\\run-agent.vbs`), stale)
  assert.deepEqual(deadReport.agents.map((a: any) => [a.state, a.reason]), [['failed', 'supervisor_v2_unavailable']])
})

test('win32: an update at an idle moment with the launcher dead (a schtasks /Run too) is not made onto a hoai-core with no --keep-alive', async () => {
  const old = { [`${WROOT}\\bin\\hoai-core.mjs`]: HOAI_CORE_OLD }
  const stale = "' old launcher pointing at 0.62.0\r\n"
  const pending = windowsMachine({
    ...old,
    [`${WSTATE}\\run-agent.vbs`]: stale,
    ['C:\\Users\\kc\\.bgos-plugin-state\\912\\agent-state.json']: stateBody('912', T0),
  })
  const listing = JSON.stringify([
    { ProcessId: 4100, ParentProcessId: 1, CreationDate: T0 - 120 * MIN, CommandLine: 'cmd.exe' },
    { ProcessId: 5912, ParentProcessId: 4100, CreationDate: T0 - 120 * MIN, CommandLine: '"C:\\Users\\kc\\.local\\bin\\claude.exe" --x' },
    { ProcessId: 4912, ParentProcessId: 5912, CreationDate: T0 - 120 * MIN, CommandLine: 'node server.ts' },
  ])
  const pendingRec = recorder({ win32Ps: listing })
  const pendingReport = await runKeepAliveSweep(windowsCtx(pending, pendingRec) as any)
  assert.deepEqual(pendingRec.calls.filter(notListing), [])
  assert.deepEqual(pendingReport.agents.map((a: any) => [a.state, a.reason]), [['failed', 'supervisor_v2_unavailable']])
})

// -- F2: Windows finds the agent's claude above its daemon ----------------------------------------------

/** The CIM listing of a Windows agent: claude.exe 5912 > bgos-launch 6000 > daemon 4912, optionally a job. */
function winListing(withJob = false) {
  return JSON.stringify([
    { ProcessId: 4100, ParentProcessId: 1, CreationDate: T0 - 120 * MIN, CommandLine: 'C:\\Windows\\System32\\cmd.exe' },
    { ProcessId: 5912, ParentProcessId: 4100, CreationDate: T0 - 120 * MIN, CommandLine: '"C:\\Users\\kc\\.local\\bin\\claude.exe" --resume 8c1f0000-0000-4000-8000-000000000001' },
    { ProcessId: 6000, ParentProcessId: 5912, CreationDate: T0 - 120 * MIN, CommandLine: 'node C:\\x\\bin\\bgos-launch.mjs C:\\x\\server.ts' },
    { ProcessId: 4912, ParentProcessId: 6000, CreationDate: T0 - 120 * MIN, CommandLine: 'bun C:\\x\\server.ts' },
    ...(withJob
      ? [{ ProcessId: 7100, ParentProcessId: 5912, CreationDate: T0 - 5 * MIN, CommandLine: 'C:\\Program Files\\Git\\bin\\bash.exe -c source C:\\Users\\kc\\.claude\\shell-snapshots\\snapshot-bash-1.sh && python monitor.py' }]
      : []),
  ])
}

test('F2 (win32): with claudePid null (the daemon has no ps there) the claude above the daemon is found: an idle agent restarts onto the staged update, a job still waits', async () => {
  const files = {
    [`${WSTATE}\\run-agent.vbs`]: "' launcher\r\n",
    [`${WSTATE}\\supervisor-generation`]: '2\n',
    [`${WSTATE}\\supervisor.json`]: JSON.stringify({ pid: 777, capabilities: ['relaunch'] }),
    ['C:\\Users\\kc\\.bgos-plugin-state\\912\\agent-state.json']: stateBody('912', T0, { claudePid: null }),
  }
  const alive = (pid: number) => [777, 4912, 5912].includes(pid)
  const idle = windowsMachine(files)
  const rec = recorder({ win32Ps: winListing(false) })
  const clock = fakeClock()
  clock.onSleep((_ms, at) => {
    if (idle.files.has(`${WSTATE}\\probe-requested.json`)) idle.writeFile('C:\\Users\\kc\\.bgos-plugin-state\\912\\channel-live.json', JSON.stringify({ firstLiveAt: 'x', lastLiveAt: new Date(at).toISOString() }))
  })
  const report = await runKeepAliveSweep(windowsCtx(idle, rec, { now: clock.now, sleep: clock.sleep, pidAlive: alive }) as any)
  assert.equal(idle.files.get(`${WSTATE}\\restart-requested.json`), '{}', 'the live launcher restarts claude in place')
  assert.deepEqual(report.agents.map((a: any) => [a.state, a.reason]), [['restarted', 'marker']])
  const busy = windowsMachine(files)
  const busyRec = recorder({ win32Ps: winListing(true) })
  const held = await runKeepAliveSweep(windowsCtx(busy, busyRec, { pidAlive: alive }) as any)
  assert.deepEqual(held.agents.map((a: any) => [a.state, a.reason]), [['waiting_idle', 'background_job']])
  assert.equal(busy.files.has(`${WSTATE}\\restart-requested.json`), false)
})

// -- F4: Windows never starts a second session beside a live one ------------------------------------------

test('F4 (win32): an update for an agent whose launcher died but whose claude still runs waits (session_without_launcher): no schtasks /Run beside it, no attempt spent', async () => {
  const fs = windowsMachine({
    [`${WSTATE}\\run-agent.vbs`]: "' launcher\r\n",
    [`${WSTATE}\\supervisor-generation`]: '2\n',
    ['C:\\Users\\kc\\.bgos-plugin-state\\912\\agent-state.json']: stateBody('912', T0),
  })
  const rec = recorder({ win32Ps: winListing(false) })
  const report = await runKeepAliveSweep(windowsCtx(fs, rec, { pidAlive: (pid: number) => [4912, 5912].includes(pid) }) as any)
  assert.equal(rec.calls.some((c) => c.file === 'schtasks.exe'), false)
  assert.deepEqual(report.agents.map((a: any) => [a.state, a.reason]), [['waiting_idle', 'session_without_launcher']])
  assert.equal(JSON.parse(fs.files.get(keepAliveStatePath(WHOME))!).agents['912'].attempts, 0)
})

test('F4 (win32): a daemon too old to publish state but holding the pairing lock (a person\'s plain claude) is running: the task is registered, never started beside it', async () => {
  const lock = { ['C:\\Users\\kc\\.bgos-agent\\credentials-912.json.lock']: JSON.stringify({ pid: 4912, heartbeatAt: T0 - 3_000 }) }
  // No task yet: registered for the next logon, not started.
  const fresh = windowsMachine(lock)
  const rec = recorder({ win32Ps: winListing(false) })
  const report = await runKeepAliveSweep(windowsCtx(fresh, rec, { pidAlive: (pid: number) => [4912, 5912].includes(pid) }) as any)
  assert.deepEqual(rec.calls.filter(notListing).map((c) => [c.file, c.args[c.args.length - 1]]), [['powershell.exe', 'install']])
  assert.deepEqual(report.agents.map((a: any) => [a.state, a.reason]), [['installing', 'installed']])
  // Task installed, launcher dead: still not started.
  const installed = windowsMachine({ ...lock, [`${WSTATE}\\run-agent.vbs`]: "' launcher\r\n", [`${WSTATE}\\supervisor-generation`]: '2\n' })
  const quiet = recorder({ win32Ps: winListing(false) })
  const later = await runKeepAliveSweep(windowsCtx(installed, quiet, { pidAlive: (pid: number) => [4912, 5912].includes(pid) }) as any)
  assert.equal(quiet.calls.some((c) => c.file === 'schtasks.exe'), false)
  // Not a refused start either (no task start spent): that claude started before the
  // install landed, so it is an update waiting for the session to end.
  assert.deepEqual(later.agents.map((a: any) => [a.state, a.reason]), [['waiting_idle', 'session_without_launcher']])
  assert.equal(JSON.parse(installed.files.get(keepAliveStatePath(WHOME))!).agents['912'].taskStarts, 0)
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

/** ps's lstart for an instant, in this machine's local time (what ps prints). */
function lstartFor(isoString: string) {
  return new Date(Date.parse(isoString))
    .toString()
    .replace(/^(\w{3}) (\w{3}) (\d{2}) (\d{4}) (\d{2}:\d{2}:\d{2}).*$/, (_m, wd, mon, d, y, t) => `${wd} ${mon} ${String(Number(d)).padStart(2, ' ')} ${t} ${y}`)
}

test('an agent with its own CLAUDE_CONFIG_DIR is judged against ITS installed plugin, and restarted onto that root', async () => {
  const ALT = `${HOME}/.claude-alt`
  const ALT_ROOT = `${ALT}/plugins/cache/hoai/hoai/0.70.0`
  const fs = machine([{ id: '912', cwd: AVA, service: 'canonical', state: { runningVersion: '0.62.1' } }])
  fs.writeFile(
    `${HOME}/.bgos-agent/912/launch.json`,
    JSON.stringify(buildLaunchRecipe({ assistantId: '912', cwd: AVA, argv: [], installMethod: 'marketplace', pluginRoot: ALT_ROOT, node: '/usr/local/bin/node', claudeConfigDir: ALT, startedAt: 'x', pid: null } as any)),
  )
  fs.writeFile(`${ALT}/plugins/installed_plugins.json`, JSON.stringify({ plugins: { 'hoai@hoai': [{ scope: 'user', version: '0.70.0', installPath: ALT_ROOT, lastUpdated: '2026-10-06T18:40:00.000Z' }] } }))
  const rec = recorder({ ps: IDLE_PS })
  const clock = fakeClock()
  answerProbes(fs, clock, ['912'])
  const { ctx } = ctxFor(fs, rec, clock)
  const report = await runKeepAliveSweep(ctx as any)
  assert.deepEqual(report.agents.map((a: any) => [a.state, a.reason]), [['restarted', 'service']])
  assert.equal(JSON.parse(fs.files.get(keepAliveStatePath(HOME))!).agents['912'].target, '0.70.0', "its own install, not the watcher's 0.62.1")
})

test("a stale state's claudePid that now belongs to some other process is not the agent's claude (pid reuse)", async () => {
  const fs = machine([{ id: '912', cwd: AVA, service: 'canonical', state: { updatedAt: new Date(T0 - 10 * MIN).toISOString() } }])
  // 5912 was the agent's claude and is now a python worker started before the
  // install landed; the agent's real claude is 7000, started after it.
  const ps = [
    psLine(1, 0, '/sbin/launchd'),
    psLine(5912, 1, 'python worker.py', lstartFor('2026-10-06T17:00:00.000Z')),
    psLine(7000, 1, 'claude --x', lstartFor('2026-10-06T18:45:00.000Z')),
  ].join('\n')
  const rec = recorder({ ps, lsof: `p7000\nfcwd\nn${AVA}\n` })
  const { ctx } = ctxFor(fs, rec, fakeClock())
  const report = await runKeepAliveSweep(ctx as any)
  assert.deepEqual(report.agents.map((a: any) => [a.state, a.reason]), [['supervised', 'canonical']])
  assert.equal(rec.calls.some((c) => c.file === 'launchctl'), false)
})

// -- a null claudePid (claude run as `node cli.js`, or Windows): the cwd fallback -----------------------

/** claude hosted by node: comm is `node`, so the daemon's ancestor walk publishes claudePid null. */
const NODE_CLAUDE = 'node /Users/kc/.npm-global/lib/node_modules/@anthropic-ai/claude-code/cli.js --dangerously-skip-permissions'
const SNAPSHOT_JOB = `/bin/zsh -c source ${HOME}/.claude/shell-snapshots/snapshot-zsh-1.sh && eval 'python monitor.py'`

test('null claudePid, fresh state: the background job scan walks the claude found by its working directory (a live shell-snapshot child is background_job)', async () => {
  const fs = machine([{ id: '912', cwd: AVA, service: 'canonical', state: { claudePid: null } }])
  // The daemon is not listed under it (the walk above the daemon finds nothing): the cwd is the evidence.
  const ps = [psLine(1, 0, '/sbin/launchd'), psLine(7000, 4100, NODE_CLAUDE), psLine(4912, 1, `node ${OLD_ROOT}/server.ts`), psLine(7100, 7000, SNAPSHOT_JOB)].join('\n')
  const rec = recorder({ ps, lsof: `p7000\nfcwd\nn${AVA}\n` })
  const report = await runKeepAliveSweep(ctxFor(fs, rec, fakeClock()).ctx as any)
  assert.deepEqual(rec.calls.filter((c) => c.file === 'lsof').map((c) => c.args), [['-a', '-d', 'cwd', '-p', '7000', '-Fn']])
  assert.deepEqual(report.agents.map((a: any) => [a.state, a.reason]), [['waiting_idle', 'background_job']])
  assert.equal(rec.calls.some((c) => c.file === 'launchctl'), false)
  assert.deepEqual(rec.kills, [])
})

test('null claudePid, stale state: the not-running decision also uses the cwd claude (running, with a job: background_job, never not_running)', async () => {
  const fs = machine([{ id: '912', cwd: AVA, service: 'canonical', state: { claudePid: null, updatedAt: new Date(T0 - 10 * MIN).toISOString() } }])
  // Started before the install landed (the legacy pending rule), a job running under it.
  const ps = [psLine(1, 0, '/sbin/launchd'), psLine(7000, 4100, NODE_CLAUDE, lstartFor('2026-10-06T17:00:00.000Z')), psLine(7100, 7000, SNAPSHOT_JOB)].join('\n')
  const rec = recorder({ ps, lsof: `p7000\nfcwd\nn${AVA}\n` })
  const report = await runKeepAliveSweep(ctxFor(fs, rec, fakeClock()).ctx as any)
  assert.deepEqual(report.agents.map((a: any) => [a.state, a.reason]), [['waiting_idle', 'background_job']])
  assert.equal(rec.calls.some((c) => c.file === 'launchctl'), false)
})

test('null claudePid, fresh state, no claude found by cwd (Windows has no cwd lookup): unreadable, never "not running"', async () => {
  const fs = machine([{ id: '912', cwd: AVA, service: 'canonical', state: { claudePid: null } }])
  const rec = recorder({ ps: [psLine(1, 0, '/sbin/launchd'), psLine(4912, 1, `node ${OLD_ROOT}/server.ts`)].join('\n') })
  const report = await runKeepAliveSweep(ctxFor(fs, rec, fakeClock()).ctx as any)
  assert.deepEqual(report.agents.map((a: any) => [a.state, a.reason]), [['waiting_idle', 'process_tree_unreadable']])
  assert.equal(rec.calls.some((c) => c.file === 'launchctl'), false)
})

test('an upgrade with no known folder is reported, and spends neither an attempt nor the sweep restart', async () => {
  const fs = machine([
    { id: '7', cwd: null, service: 'canonical', generation: null, state: { pid: 47, claudePid: 57 } },
    { id: '912', cwd: AVA, service: 'canonical', state: {} },
  ])
  const rec = recorder({ ps: [IDLE_PS, psLine(57, 1, 'claude --y')].join('\n') })
  const clock = fakeClock()
  answerProbes(fs, clock, ['912'])
  const { ctx } = ctxFor(fs, rec, clock)
  const report = await runKeepAliveSweep(ctx as any)
  assert.deepEqual(report.agents.map((a: any) => [a.id, a.state, a.reason]), [['7', 'upgrade_pending', 'no_known_folder'], ['912', 'restarted', 'service']])
  assert.equal(JSON.parse(fs.files.get(keepAliveStatePath(HOME))!).agents['7'].attempts, undefined)
})
