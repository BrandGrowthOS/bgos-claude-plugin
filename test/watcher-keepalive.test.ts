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

import { test as nodeTest, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { normalize } from 'node:path'

import {
  INSTALL_TIMEOUT_MS,
  KEEP_ONLINE_TICK_MS,
  TASK_CHECK_RETRY_MS,
  hookSpoolPathFor,
  installProductSupervisor,
  keepAliveCachePath,
  mungeCwd,
  transcriptPathFor,
  keepAliveStatePath,
  readKeepAliveReport,
  runKeepAliveSweep,
  supervisorInstallCommand,
} from '../lib/watcher-keepalive.mjs'
import { buildLaunchRecipe } from '../lib/agent-inventory.mjs'
import { agentTaskSpec } from '../lib/agent-task-win32.mjs'
import { RESTART_EXEC_TIMEOUT_MS } from '../lib/agent-restart.mjs'
import { buildKeepAliveCache } from '../lib/keepalive-plan.mjs'
import { memoryFs, type MemoryFs } from './helpers/memory-fs.ts'
import { fakeAgentTasks, type FakeAgentTaskOptions, type FakeAgentTasks } from './helpers/fake-agent-tasks.ts'

const HOME = '/Users/kc'
const CONFIG = `${HOME}/.claude`
const OLD_ROOT = `${CONFIG}/plugins/cache/hoai/hoai/0.62.0`
const ROOT = `${CONFIG}/plugins/cache/hoai/hoai/0.62.1`
const T0 = Date.parse('2026-10-06T19:00:00.000Z')
const MIN = 60_000
const AVA = `${HOME}/hoai-agents/ava`
const GURU = `${HOME}/hoai-agents/guru`
// The HOME ids the per-agent service names carry (board row d6198bb6): watcherHomeId in
// lib/watcher-service.mjs, the first 8 hex of sha256 of the canonical HOME, computed once and
// pinned here so a change to that hashing fails by name. '/Users/kc' (darwin, linux) -> 5156882f;
// 'C:\Users\kc' (win32, hashed as c:\users\kc) -> 66ede649.
const HID = '5156882f'
const WHID = '66ede649'
/** The Windows HOME the win32 tests run in (its id is WHID). */
const WHOME = 'C:\\Users\\kc'

/**
 * Every test here is bounded. node:test's default timeout is INFINITE, so a
 * sweep left awaiting something that never settles would hold `tsx --test`
 * open for good. A loop that never yields at all is a different hang no timer
 * can stop (an F8 run sat at 100% CPU for 50 minutes): verify's polls and the
 * keepOnline ticks are bounded in the code for that.
 */
const TEST_TIMEOUT_MS = 20_000
function test(name: string, fn: (t: TestContext) => void | Promise<void>): Promise<void>
function test(name: string, options: { timeout?: number }, fn: (t: TestContext) => void | Promise<void>): Promise<void>
function test(name: string, a: unknown, b?: unknown) {
  if (typeof a === 'function') return nodeTest(name, { timeout: TEST_TIMEOUT_MS }, a as (t: TestContext) => void | Promise<void>)
  return nodeTest(name, { timeout: TEST_TIMEOUT_MS, ...(a as { timeout?: number }) }, b as (t: TestContext) => void | Promise<void>)
}

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
  const running = 'runningVersion' in overrides ? overrides.runningVersion : '0.62.0'
  return JSON.stringify({
    schemaVersion: 1,
    assistantId: id,
    pid: Number(`4${id}`),
    claudePid: Number(`5${id}`),
    runningVersion: '0.62.0',
    // What the daemon itself reads from the installed_plugins.json machine() writes
    // (0.62.1): a fresh daemon's answer is the one the sweep acts on (daemon F7).
    pendingRestartVersion: running === '0.62.1' ? null : '0.62.1',
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

/**
 * A canonical service is written under the OLD names by default (ai.bgos.agent.<id>,
 * bgos-agent-<id>: an agent 0.69.2 installed, not renamed yet, which the sweep still supervises
 * under that name); `scoped` writes the names bin/bgos-agent installs now, which carry this
 * HOME's id (ai.bgos.agent.<id>.home-<hid>, bgos-agent-<id>-home-<hid>).
 */
function machine(agents: AgentSpec[], opts: { platform?: string; installedVersion?: string; lastUpdated?: string; bgosAgent?: string; scoped?: boolean } = {}): MemoryFs {
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
      // As bin/bgos-agent writes it, the unit records the HOME it was installed from and this
      // agent's run.sh: what the read back before a restart judges, with its fragment path.
      if (opts.platform === 'linux') {
        files[`${HOME}/.config/systemd/user/bgos-agent-${a.id}${opts.scoped ? `-home-${HID}` : ''}.service`] =
          `[Service]\nWorkingDirectory=${a.cwd ?? HOME}\nExecStart=/bin/bash "${HOME}/.bgos-agent/${a.id}/run.sh"\nEnvironment=HOME=${HOME}\n`
      } else files[`${HOME}/Library/LaunchAgents/ai.bgos.agent.${a.id}${opts.scoped ? `.home-${HID}` : ''}.plist`] = '<plist/>'
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

/**
 * The Windows agents whose logon task this HOME (C:\Users\kc) has registered in the default
 * win32 world (`recorder()`'s `win32Task: 'own'`): agent 912, and agent 913 of the "two crashed
 * together" test. Each is seeded exactly as lib/agent-task-win32.mjs registers it from this HOME
 * (board row d6198bb6): the name carrying WHID, the description naming the HOME, the action
 * running that HOME's run-agent.vbs. Literals, never derived from the script a test probes.
 */
const WIN32_AGENT_IDS = ['912', '913']

/** What this HOME's Task Scheduler holds for one agent, by the `win32Task` the recorder was given. */
function seedWin32Task(tasks: FakeAgentTasks, id: string, world: 'own' | 'absent' | 'legacy') {
  const vbs = `${WHOME}\\.bgos-agent\\${id}\\run-agent.vbs`
  // This HOME's task under its own name, as 0.69.3 registers it.
  if (world === 'own') tasks.seed.task(`HOAI Agent ${id} home-${WHID}`, vbs, { description: `HOAI agent ${id}, installed from home=${WHOME}` })
  // This HOME's task as 0.69.2 registered it: the old name, no description, the same launcher.
  if (world === 'legacy') tasks.seed.task(`HOAI Agent ${id}`, vbs)
}

/** `launchctl print gui/<uid>/<label>` of a job loaded from THIS HOME's plist (the shape test/helpers/fake-service-host.ts prints). */
function ownLaunchdPrint(target: string) {
  const label = target.split('/').slice(2).join('/')
  const id = /^ai\.bgos\.agent\.(\d+)/.exec(label)?.[1] ?? ''
  return [
    `${target} = {`,
    '\tactive count = 1',
    `\tpath = ${HOME}/Library/LaunchAgents/${label}.plist`,
    '\ttype = LaunchAgent',
    '\tstate = running',
    '',
    '\tprogram = /bin/bash',
    '\targuments = {',
    '\t\t/bin/bash',
    `\t\t${HOME}/.bgos-agent/${id}/run.sh`,
    '\t}',
    '',
    '\tenvironment = {',
    `\t\tHOME => ${HOME}`,
    `\t\tXPC_SERVICE_NAME => ${label}`,
    '\t}',
    '}',
    '',
  ].join('\n')
}

/** `systemctl --user show --property=LoadState,...` of a loaded unit whose fragment is THIS HOME's unit file. */
function ownUnitShow(unit: string) {
  return [`Environment=HOME=${HOME}`, 'WorkingDirectory=', `FragmentPath=${HOME}/.config/systemd/user/${unit}.service`, 'LoadState=loaded', 'ActiveState=active'].join('\n') + '\n'
}

/** The read-only probes every act now makes first (board row d6198bb6): no act of its own. */
const readOnlyProbe = (c: { file: string; args: string[] }) =>
  (c.file === 'powershell.exe' && c.args.includes('-File') && ['probe', 'probe-legacy'].includes(c.args[c.args.length - 1] ?? '')) ||
  (c.file === 'launchctl' && c.args[0] === 'print') ||
  (c.file === 'systemctl' && c.args.some((a) => a.startsWith('--property=LoadState')))

/**
 * The recording exec. Every act on an agent service reads the registration back first (board row
 * d6198bb6); the recorder answers those read-only probes as a real host answers them, so the act
 * under test proceeds:
 *   - win32: the task script's actions (`powershell.exe ... -File <install-agent-task.ps1> -Action
 *     <a>`) and `schtasks.exe /Run` go to a faked Task Scheduler (test/helpers/fake-agent-tasks.ts)
 *     bound to the machine's fs (`useTaskHost`, which windowsCtx calls). It reads $name,
 *     $legacyName, $vbs and $description from the script on disk when the command runs, and
 *     answers `-Action probe` / `probe-legacy` only for a task registered under THAT name: this
 *     HOME's tasks for WIN32_AGENT_IDS (`win32Task: 'own'`, the default), none (`'absent'`: none
 *     until the script's `-Action install` registers one), or the old 0.69.2 ones (`'legacy'`).
 *     A script that probes another name, or another HOME's, is answered "task absent". `fail`
 *     makes a task command fail as the faked Task Scheduler's own `fail` entries do ({ match,
 *     code, stderr, times }, matched as a substring of the command line).
 *   - `launchctl print` the job of this HOME's plist, `systemctl --user show
 *     --property=LoadState,...` a loaded unit from this HOME's unit file. With the user bus down
 *     (`systemctlShow` null) every `systemctl --user show` fails alike, the read back included.
 */
function recorder(opts: { ps?: string | null; lsof?: string; lsofCode?: number | null; bashCode?: number; launchctlCode?: number; win32Ps?: string; systemctlShow?: string | null; win32Task?: 'own' | 'absent' | 'legacy'; fail?: FakeAgentTaskOptions['fail'] } = {}) {
  const calls: Array<{ file: string; args: string[]; opts: any }> = []
  let tasks: FakeAgentTasks | null = null
  let tasksFs: MemoryFs | null = null
  /** Bind the faked Task Scheduler to the machine whose task scripts it reads (once per recorder). */
  const useTaskHost = (fs: MemoryFs) => {
    if (tasksFs === fs) return tasks!
    if (tasksFs) throw new Error('recorder: its task host is already bound to another machine')
    tasksFs = fs
    tasks = fakeAgentTasks({ fs, fail: opts.fail })
    for (const id of WIN32_AGENT_IDS) seedWin32Task(tasks, id, opts.win32Task ?? 'own')
    return tasks
  }
  const busDown = { code: 1, stdout: '', stderr: 'Failed to connect to bus', error: null, timedOut: false }
  const exec = async (file: string, args: readonly string[], o: any = {}) => {
    calls.push({ file, args: [...args], opts: o })
    if ((file === 'powershell.exe' && args.includes('-File')) || file === 'schtasks.exe') {
      if (!tasks) return { code: 1, stdout: '', stderr: 'recorder: no task host bound (windowsCtx binds one to the machine fs)', error: null, timedOut: false }
      return tasks.exec(file, args)
    }
    if (file === 'powershell.exe' && args.includes('-Command') && opts.win32Ps != null) return { code: 0, stdout: opts.win32Ps, stderr: '', error: null, timedOut: false }
    if (file === 'ps') return opts.ps == null ? { code: 1, stdout: '', stderr: 'ps: denied', error: null, timedOut: false } : { code: 0, stdout: opts.ps, stderr: '', error: null, timedOut: false }
    if (file === 'lsof') return { code: opts.lsofCode === undefined ? 0 : opts.lsofCode, stdout: opts.lsof ?? '', stderr: '', error: null, timedOut: opts.lsofCode === null }
    if (file === 'bash') return { code: opts.bashCode ?? 0, stdout: '', stderr: opts.bashCode ? `x  no .mcp.json in ${GURU} and no creds given` : '', error: null, timedOut: false }
    if (file === 'launchctl' && args[0] === 'print') return { code: 0, stdout: ownLaunchdPrint(String(args[1])), stderr: '', error: null, timedOut: false }
    if (file === 'launchctl') return { code: opts.launchctlCode ?? 0, stdout: '', stderr: '', error: null, timedOut: false }
    if (file === 'systemctl' && args.includes('show')) {
      // The user bus down fails every show alike: the cgroup read and the read back.
      if (opts.systemctlShow == null) return busDown
      if (args.some((a) => a.startsWith('--property=LoadState'))) return { code: 0, stdout: ownUnitShow(String(args[args.length - 1])), stderr: '', error: null, timedOut: false }
      return { code: 0, stdout: opts.systemctlShow, stderr: '', error: null, timedOut: false }
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
  return { calls, exec, kills, kill, spawns, spawnDetached, useTaskHost }
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

/**
 * A canonical launchd restart of agent 912 (the plist machine() writes, under its OLD label): its
 * registration is read back first (`launchctl print`, read only; board row d6198bb6), then kicked.
 */
const KICKSTART_912 = [['print', 'gui/501/ai.bgos.agent.912'], ['kickstart', '-k', 'gui/501/ai.bgos.agent.912']]

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
  assert.deepEqual(report, { enabled: false, source: 'live', agents: [], showAgentWindows: false })
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
  assert.deepEqual(await runKeepAliveSweep(ctx as any), { enabled: false, source: 'none', agents: [], showAgentWindows: false })
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
    assert.deepEqual(report, { enabled: false, source: 'refused', agents: [], showAgentWindows: false }, String(status))
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
    switchState: 'on',
    showAgentWindows: false,
    fetchedAt: new Date(T0).toISOString(),
  })
})

test('consent: the owner Show agent windows setting rides the sweep report whether the switch is on or off (board row d133ddb2), and an answer without it reads as off', async () => {
  for (const enabled of [true, false]) {
    const fs = machine([])
    const on = consent({ enabled, enabledAt: enabled ? 'e' : null, assistantIds: [], showAgentWindows: true })
    const report = await runKeepAliveSweep(ctxFor(fs, recorder(), fakeClock(), { fetchKeepAlive: on.fetchKeepAlive }).ctx as any)
    assert.equal(report.showAgentWindows, true, `switch ${enabled}`)
    const older = consent({ enabled, enabledAt: enabled ? 'e' : null, assistantIds: [] })
    const plain = await runKeepAliveSweep(ctxFor(machine([]), recorder(), fakeClock(), { fetchKeepAlive: older.fetchKeepAlive }).ctx as any)
    assert.equal(plain.showAgentWindows, false, `switch ${enabled}, older backend`)
  }
})

// -- supervise -----------------------------------------------------------------------------------

test('installProductSupervisor (shared by the sweep and create_agent): win32 registers the agent task (hidden launcher) and starts it only when asked; posix runs bgos-agent install --always-on from the given root, node dirs first on PATH; no root is a named failure', async () => {
  // No task registered yet: the read back finds none under either name, then the install registers it.
  const rec = recorder({ win32Task: 'absent' })
  const { calls, exec } = rec
  const fs = memoryFs()
  const host = rec.useTaskHost(fs)
  const base = { assistantId: '55', home: 'C:\\Users\\kc', env: { PATH: 'C:\\Windows' }, fs, exec, nodePath: 'C:\\Program Files\\nodejs\\node.exe', pluginRoot: 'C:\\root', cwd: 'C:\\Users\\kc\\hoai-agents\\wolf' }
  // `run` is how the sweep keeps the watcher online through the install: the win32 install goes
  // through it once, as the posix one does.
  let wrapped = 0
  const run = (w: Promise<unknown>) => (wrapped++, w)
  /** The task script's action (powershell.exe ... -Action <a>) or schtasks' verb, to name a command in a message. */
  const actionOf = (c: { file: string; args: string[] }) => `${c.file} ${c.file === 'schtasks.exe' ? c.args[0] : c.args[c.args.length - 1]}`
  const started = await installProductSupervisor({ ...base, platform: 'win32', start: true, run } as any)
  assert.equal(started.ok, true, started.message)
  // Read back first (this HOME's name, then the old one), then registered and started under this HOME's name.
  assert.deepEqual(calls.map((c) => [c.file, c.args[c.args.length - 1]]), [
    ['powershell.exe', 'probe'],
    ['powershell.exe', 'probe-legacy'],
    ['powershell.exe', 'install'],
    ['schtasks.exe', `HOAI Agent 55 home-${WHID}`],
  ])
  // Every one of those commands is bounded on its own, and the install as a whole went through `run`.
  for (const c of calls) assert.equal(c.opts?.timeoutMs, RESTART_EXEC_TIMEOUT_MS, `${actionOf(c)} is bounded`)
  assert.equal(wrapped, 1, 'the win32 install (start) runs inside run, once')
  // The one task now registered is this HOME's, started: its name carries WHID, its description
  // names C:\Users\kc, its action runs that HOME's launcher. The result names it for the sweep's record.
  assert.deepEqual([...host.tasks], [
    [`HOAI Agent 55 home-${WHID}`, { description: 'HOAI agent 55, installed from home=C:\\Users\\kc', action: 'wscript.exe //B "C:\\Users\\kc\\.bgos-agent\\55\\run-agent.vbs"', state: 'Running' }],
  ])
  // (The cast: installProductSupervisor's JSDoc @returns is { ok, message } only, which is the type
  // tsc gives `started`; its win32 branch returns installAgentTask's result, whose @returns does
  // list taskName.)
  assert.equal((started as { taskName?: string }).taskName, `HOAI Agent 55 home-${WHID}`)
  assert.match(fs.files.get('C:\\Users\\kc\\.bgos-agent\\55\\run-agent.vbs')!, /--keep-alive", 0, True\)\r\n$/)
  calls.length = 0
  wrapped = 0
  const registered = await installProductSupervisor({ ...base, platform: 'win32', start: false, run } as any)
  assert.equal(registered.ok, true)
  assert.deepEqual(calls.map((c) => [c.file, c.args[c.args.length - 1]]), [['powershell.exe', 'probe'], ['powershell.exe', 'probe-legacy'], ['powershell.exe', 'install']], 'registered, not started')
  for (const c of calls) assert.equal(c.opts?.timeoutMs, RESTART_EXEC_TIMEOUT_MS, `${actionOf(c)} is bounded (no start)`)
  assert.equal(wrapped, 1, 'the win32 install (no start) runs inside run, once')
  calls.length = 0
  const posix = await installProductSupervisor({ ...base, platform: 'darwin', home: '/Users/kc', env: { PATH: '/usr/bin' }, nodePath: '/opt/homebrew/bin/node', pluginRoot: '/root', cwd: '/Users/kc/hoai-agents/wolf' } as any)
  // bgos-agent printed no `service note:` line: no notes ride out.
  assert.deepEqual(posix, { ok: true, message: 'installed', notes: [] })
  assert.deepEqual(calls.map((c) => [c.file, ...c.args]), [['bash', '/root/bin/bgos-agent', 'install', '--assistant', '55', '--dir', '/Users/kc/hoai-agents/wolf', '--always-on', '--no-clone']])
  assert.equal(calls[0]!.opts.env.PATH, '/opt/homebrew/bin:/usr/bin')
  assert.equal(calls[0]!.opts.timeoutMs, INSTALL_TIMEOUT_MS)
  assert.deepEqual(await installProductSupervisor({ ...base, platform: 'linux', pluginRoot: null } as any), { ok: false, message: 'plugin_root_unknown' })
})

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
  assert.deepEqual(report.agents, [{ id: '912', state: 'waiting_idle', reason: 'background_job', since: new Date(T0).toISOString(), pending: 'update' }])
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
  // `pending: update` (design 6 and 13): the app offers Restart now only for an
  // entry that says the wait is for an update.
  assert.deepEqual(first.agents[0], { id: '912', state: 'waiting_idle', reason: 'turn_in_flight', since: new Date(T0).toISOString(), pending: 'update' })
  clock.advance(25 * 60 * MIN)
  fs.writeFile(`${HOME}/.bgos-plugin-state/912/agent-state.json`, stateBody('912', clock.now(), { turnInFlight: true }))
  const later = await runKeepAliveSweep(ctx as any)
  assert.equal(later.agents[0].waitingSince, new Date(T0).toISOString())
  assert.equal(later.agents[0].pending, 'update')
  // The heartbeat between sweeps reads the same entry from the saved state.
  assert.deepEqual(readKeepAliveReport({ home: HOME, fs, now: clock.now() }).agents[0], later.agents[0])
  assert.equal(rec.calls.some((c) => c.file === 'launchctl'), false)
})

test('safe moment: a turn flag that has been quiet for 3 h with no job under claude is stale: the NORMAL restart path, never a kill', async () => {
  const fs = machine([{ id: '912', cwd: AVA, service: 'canonical', state: { turnInFlight: true, lastActivityAt: new Date(T0 - 180 * MIN).toISOString() } }])
  const rec = recorder({ ps: IDLE_PS })
  const clock = fakeClock()
  answerProbes(fs, clock, ['912'])
  const { ctx } = ctxFor(fs, rec, clock)
  const report = await runKeepAliveSweep(ctx as any)
  assert.deepEqual(rec.calls.filter((c) => c.file === 'launchctl').map((c) => c.args), KICKSTART_912)
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
  assert.deepEqual(rec.calls.filter((c) => c.file === 'launchctl').map((c) => c.args), KICKSTART_912)
  assert.equal(fs.files.has(`${HOME}/.bgos-agent/912/probe-requested.json`), true, 'the boot hello probe was asked for')
  assert.deepEqual(report.agents.map((a: any) => [a.state, a.reason]), [['restarted', 'service']])
  const saved = JSON.parse(fs.files.get(keepAliveStatePath(HOME))!)
  assert.equal(saved.agents['912'].attempts, 1)
  assert.equal(saved.agents['912'].target, '0.62.1')
  assert.equal(saved.agents['912'].lastRestartAt, new Date(T0).toISOString())
  assert.deepEqual(rec.kills, [])
  // The job bin/bgos-agent installs now carries this HOME's id (board row d6198bb6): the same
  // restart, read back and kicked under that label.
  const scoped = machine([{ id: '912', cwd: AVA, service: 'canonical', state: {} }], { scoped: true })
  const scopedRec = recorder({ ps: IDLE_PS })
  const scopedClock = fakeClock()
  answerProbes(scoped, scopedClock, ['912'])
  const scopedReport = await runKeepAliveSweep(ctxFor(scoped, scopedRec, scopedClock).ctx as any)
  assert.deepEqual(scopedRec.calls.filter((c) => c.file === 'launchctl').map((c) => c.args), [['print', `gui/501/ai.bgos.agent.912.home-${HID}`], ['kickstart', '-k', `gui/501/ai.bgos.agent.912.home-${HID}`]])
  assert.deepEqual(scopedReport.agents.map((a: any) => [a.state, a.reason]), [['restarted', 'service']])
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
  assert.deepEqual(rec.calls.filter((c) => c.file === 'launchctl').map((c) => c.args), KICKSTART_912)
  assert.equal(fs.files.has(`${HOME}/.bgos-agent/912/restart-requested.json`), false)
  assert.equal(rec.calls.filter((c) => c.file === 'ps').length, 1, 'the sweep hands its own listing to the ladder')
  assert.deepEqual(report.agents.map((a: any) => [a.state, a.reason]), [['restarted', 'service']])
  // The job bin/bgos-agent installs now carries this HOME's id, and so does the tmux socket and
  // session its run.sh starts hoai on (board row d6198bb6). HID is watcherHomeId('/Users/kc',
  // 'darwin'), pinned as the literal 5156882f: the sweep judges the socket for the ROW's platform
  // (launcherIsServiceChild takes it), whatever host runs this file. The same own live hoai is
  // read back and kicked under that label, never only its claude.
  const scoped = machine([{ id: '912', cwd: AVA, service: 'canonical', state: {} }], { scoped: true })
  scoped.writeFile(`${HOME}/.bgos-agent/912/supervisor.json`, JSON.stringify({ pid: 3000, capabilities: ['relaunch'], startedAt: 'x' }))
  const scopedPs = [
    psLine(1, 0, '/sbin/launchd'),
    psLine(2900, 1, `tmux -L hoai-912-home-5156882f new-session -d -s hoai-912-home-5156882f -x 200 -y 50 -c ${AVA} /usr/bin/env HOAI_SUPERVISED=1 node ${OLD_ROOT}/bin/hoai-core.mjs`),
    psLine(3000, 2900, `node ${OLD_ROOT}/bin/hoai-core.mjs`),
    psLine(5912, 3000, 'claude --resume 8c1f0000-0000-4000-8000-000000000001'),
    psLine(4912, 5912, `node ${OLD_ROOT}/server.ts`),
  ].join('\n')
  const scopedRec = recorder({ ps: scopedPs })
  const scopedClock = fakeClock()
  answerProbes(scoped, scopedClock, ['912'])
  const scopedReport = await runKeepAliveSweep(ctxFor(scoped, scopedRec, scopedClock, { pidAlive: (pid: number) => [3000, 4912, 5912].includes(pid) }).ctx as any)
  assert.deepEqual(scopedRec.calls.filter((c) => c.file === 'launchctl').map((c) => c.args), [['print', 'gui/501/ai.bgos.agent.912.home-5156882f'], ['kickstart', '-k', 'gui/501/ai.bgos.agent.912.home-5156882f']])
  assert.equal(scoped.files.has(`${HOME}/.bgos-agent/912/restart-requested.json`), false, 'scoped: no marker')
  assert.equal(scopedRec.calls.filter((c) => c.file === 'ps').length, 1, 'scoped: the sweep hands its own listing to the ladder')
  assert.deepEqual(scopedReport.agents.map((a: any) => [a.state, a.reason]), [['restarted', 'service']])
})

test('restart (design): a job the agent started on its OWN tmux server (`tmux new-session -d`, outside claude\'s tree) keeps the marker: the service restart would kill that server, and the job with it', async () => {
  for (const platform of ['darwin', 'linux']) {
    const fs = machine([{ id: '912', cwd: AVA, service: 'canonical', state: {} }], { platform })
    fs.writeFile(`${HOME}/.bgos-agent/912/supervisor.json`, JSON.stringify({ pid: 3000, capabilities: ['relaunch'], startedAt: 'x' }))
    const ps = [
      psLine(1, 0, platform === 'linux' ? '/sbin/init' : '/sbin/launchd', undefined, 0),
      psLine(2900, 1, platform === 'linux' ? 'tmux: server (/tmp/tmux-501/hoai-912)' : `tmux -L hoai-912 new-session -d -s hoai-912 -x 200 -y 50 -c ${AVA} /usr/bin/env HOAI_SUPERVISED=1 node ${OLD_ROOT}/bin/hoai-core.mjs`),
      psLine(3000, 2900, `node ${OLD_ROOT}/bin/hoai-core.mjs`),
      psLine(5912, 3000, 'claude --resume 8c1f0000-0000-4000-8000-000000000001'),
      psLine(4912, 5912, `node ${OLD_ROOT}/server.ts`),
      psLine(6100, 2900, 'npm run dev'),
    ].join('\n')
    const rec = recorder({ ps, systemctlShow: `MainPID=1000\nControlGroup=/user.slice/bgos-agent-912.service\n` })
    const clock = fakeClock()
    answerProbes(fs, clock, ['912'])
    const report = await runKeepAliveSweep(ctxFor(fs, rec, clock, { platform, pidAlive: (pid: number) => [3000, 4912, 5912, 6100].includes(pid) }).ctx as any)
    assert.equal(rec.calls.some((c) => c.file === 'launchctl' || (c.file === 'systemctl' && c.args.includes('restart'))), false, `${platform}: no service restart over the job`)
    assert.equal(fs.files.get(`${HOME}/.bgos-agent/912/restart-requested.json`), '{}', `${platform}: claude alone restarts`)
    assert.deepEqual(report.agents.map((a: any) => [a.state, a.reason]), [['restarted', 'marker']], platform)
  }
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
    // No pending (review 3 F3): a plain restart cannot end this wait, so the app offers none.
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
    assert.deepEqual(rec.calls.filter((c) => c.file === 'launchctl').map((c) => c.args), KICKSTART_912, name)
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
  assert.deepEqual(rec.calls.filter((c) => c.file === 'launchctl').map((c) => c.args), KICKSTART_912)
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
    assert.deepEqual(rec.calls.filter((c) => c.file === 'launchctl').map((c) => c.args), KICKSTART_912, 'the restart happened (read back, then kicked)')
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
    phase = rec.calls.some((c) => c.file === 'launchctl' && c.args[0] === 'kickstart') ? 'verify' : rec.calls.some((c) => c.file === 'bash') ? 'install' : 'start'
  })
  await runKeepAliveSweep(ctx as any)
  assert.equal(rec.calls.filter((c) => c.file === 'bash').length, 1)
  assert.deepEqual(rec.calls.filter((c) => c.file === 'launchctl').map((c) => c.args), KICKSTART_912)
  const during = (name: string) => touches.filter(([p]) => p === name).length
  assert.ok(during('install') >= 5, `touched through the 5 min install (${during('install')})`)
  assert.ok(during('verify') >= 1, `touched through the 2 min verify (${during('verify')})`)
  // No gap between two touches (or the sweep start) long enough to leave the backend's 3 min online window.
  const stamps = [T0, ...touches.map(([, at]) => at)]
  for (let i = 1; i < stamps.length; i++) assert.ok(stamps[i]! - stamps[i - 1]! < 3 * MIN, `gap ${i}`)
})

test('online (F8): an install that ends on a later event loop turn (a real child process) still ends the sweep when the sleep resolves at once: the keepOnline ticks are bounded, never a microtask loop that starves it', async () => {
  const fs = machine([{ id: '7', cwd: GURU, service: 'none' }])
  const rec = recorder({ ps: IDLE_PS })
  const clock = fakeClock()
  let ticks = 0
  const sleep = async (ms: number) => {
    ticks += 1
    // Only so the defect fails this test instead of hanging the file.
    if (ticks > 2000) throw new Error('keepOnline never stopped ticking')
    await clock.sleep(ms)
  }
  const exec = async (file: string, args: readonly string[], o: any = {}) => {
    if (file !== 'bash') return rec.exec(file, args, o)
    rec.calls.push({ file, args: [...args], opts: o })
    // Settles on a macrotask, as a real child's exit does: a loop that only
    // ever awaits resolved promises never lets this run.
    return new Promise((resolve) => setImmediate(() => resolve({ code: 0, stdout: '', stderr: '', error: null, timedOut: false })))
  }
  let touches = 0
  const keepOnline = async () => {
    touches += 1
  }
  const report = await runKeepAliveSweep(ctxFor(fs, rec, clock, { exec, sleep, keepOnline, fetchKeepAlive: consent({ enabled: true, enabledAt: 'e', assistantIds: [7] }).fetchKeepAlive }).ctx as any)
  assert.deepEqual(report.agents.map((a: any) => [a.state, a.reason]), [['installing', 'installed']])
  assert.equal(ticks, Math.ceil(INSTALL_TIMEOUT_MS / KEEP_ONLINE_TICK_MS) + 1, 'ticks for as long as the install may take, then only waits')
  assert.ok(touches >= ticks, `kept online through every tick (${touches})`)
})

test('online (F8): a service restart that takes long (systemd stopping a slow cgroup, up to 90 s) keeps the watcher online through it, and the bound is the restart\'s own', async () => {
  const fs = machine([{ id: '912', cwd: AVA, service: 'canonical', state: {} }])
  const rec = recorder({ ps: IDLE_PS })
  const clock = fakeClock()
  // The read back (launchctl print) and then the kickstart each return 100 s
  // (fake) after they started, or, for a sweep that never ticks the clock while
  // it waits (the defect), after a real 200 ms, so the defect fails this test
  // instead of hanging it. Both run inside one keep-online wait (the restart's),
  // whose bound must cover both: a bound of one command's time limit (7 ticks of
  // 20 s) stops ticking 40 s into the kickstart.
  let release: (() => void) | null = null
  let commandAt = 0
  clock.onSleep((_ms, at) => {
    if (release && at - commandAt >= 100_000) release()
  })
  /** When each slow command started and returned, on the fake clock. */
  const spans: Record<string, { from: number; to: number }> = {}
  const slow = async (name: string) => {
    commandAt = clock.now()
    await new Promise<void>((resolve) => {
      release = resolve
      setTimeout(resolve, 200)
    })
    release = null
    spans[name] = { from: commandAt, to: clock.now() }
  }
  const exec = async (file: string, args: readonly string[], o: any = {}) => {
    if (file === 'launchctl' && args[0] === 'print') {
      await slow('print')
      // Then answered (and recorded) as the recorder answers it: this HOME's own job.
      return rec.exec(file, args, o)
    }
    if (file !== 'launchctl' || args[0] !== 'kickstart') return rec.exec(file, args, o)
    rec.calls.push({ file, args: [...args], opts: o })
    await slow('kickstart')
    return { code: 0, stdout: '', stderr: '', error: null, timedOut: false }
  }
  const touches: number[] = []
  const keepOnline = async () => {
    touches.push(clock.now())
  }
  answerProbes(fs, clock, ['912'])
  const report = await runKeepAliveSweep(ctxFor(fs, rec, clock, { exec, keepOnline }).ctx as any)
  assert.deepEqual(rec.calls.filter((c) => c.file === 'launchctl').map((c) => c.args), KICKSTART_912)
  // Every command of the restart is bounded on its own: the read back (launchctl print) and the kickstart.
  for (const c of rec.calls.filter((c) => c.file === 'launchctl')) assert.equal(c.opts?.timeoutMs, RESTART_EXEC_TIMEOUT_MS, `launchctl ${c.args[0]} is bounded`)
  const { print, kickstart } = spans
  assert.ok(print && kickstart, `both commands ran slow (${JSON.stringify(spans)})`)
  const within = (from: number, to: number) => touches.filter((at) => at > from && at <= to).length
  const inPrint = within(print.from, kickstart.from)
  const inKick = within(kickstart.from, kickstart.to)
  assert.ok(inPrint + inKick >= 9, `touched through both commands, about 200 s (${inPrint} + ${inKick})`)
  assert.ok(inPrint >= 4, `touched every 20 s through the 100 s read back (${inPrint})`)
  assert.ok(inKick >= 4, `touched every 20 s through the 100 s kickstart (${inKick})`)
  // Each one took its 100 s on the fake clock: the sweep kept ticking through both.
  assert.ok(print.to - print.from >= 100_000, `the read back took its 100 s (${print.to - print.from} ms)`)
  assert.ok(kickstart.to - kickstart.from >= 100_000, `the kickstart took its 100 s (${kickstart.to - kickstart.from} ms)`)
  assert.deepEqual(report.agents.map((a: any) => [a.state, a.reason]), [['restarted', 'service']])
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
  // The wait is for the generation 2 upgrade: the app never offers it a plain restart.
  assert.equal(report.agents[0].pending, 'upgrade')
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

test('F1 hardening: a LIVE pairing-lock daemon with no recognisable claude above it and none in its folder is UNKNOWN (waits), never stopped: nothing is reinstalled under it', async () => {
  const fs = machine([{ id: '912', cwd: AVA, service: 'canonical', generation: null, state: null }])
  fs.writeFile(`${HOME}/.bgos-agent/credentials-912.json.lock`, JSON.stringify({ pid: 4300, heartbeatAt: T0 - 3_000, bootedAt: T0 - 60 * MIN }))
  // The daemon runs under something the watcher does not recognise as claude.
  const ps = [psLine(1, 0, '/sbin/launchd', undefined, 0), psLine(4200, 1, '/opt/tools/agent-wrapper --session'), psLine(4300, 4200, `node ${OLD_ROOT}/server.ts`)].join('\n')
  const rec = recorder({ ps, lsofCode: 1, lsof: '' })
  const clock = fakeClock()
  answerProbes(fs, clock, ['912'])
  const report = await runKeepAliveSweep(ctxFor(fs, rec, clock, { pidAlive: (pid: number) => pid === 4300 || pid === 4200 }).ctx as any)
  assert.deepEqual(rec.calls.filter((c) => c.file === 'bash' || c.file === 'launchctl'), [], 'no reinstall, no restart under a live daemon')
  assert.deepEqual(report.agents.map((a: any) => [a.state, a.reason]), [['waiting_idle', 'process_tree_unreadable']])
  // The same table with a lock nobody stamps any more: no live daemon, really stopped.
  fs.writeFile(`${HOME}/.bgos-agent/credentials-912.json.lock`, JSON.stringify({ pid: 4300, heartbeatAt: T0 - 10 * MIN }))
  const stale = recorder({ ps, lsofCode: 1, lsof: '' })
  const staleClock = fakeClock()
  answerProbes(fs, staleClock, ['912'])
  const stopped = await runKeepAliveSweep(ctxFor(fs, stale, staleClock, { pidAlive: (pid: number) => pid === 4300 || pid === 4200 }).ctx as any)
  assert.deepEqual(stale.calls.filter((c) => c.file === 'bash').map((c) => c.args[1]), ['install'])
  assert.deepEqual(stopped.agents.map((a: any) => [a.state, a.reason]), [['restarted', 'reinstall']])
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
  // Its cgroup is read, then its registration is read back (read only, board row d6198bb6), then it restarts.
  assert.deepEqual(ok.calls.filter((c) => c.file === 'systemctl').map((c) => c.args), [
    ['--user', 'show', '-p', 'MainPID', '-p', 'ControlGroup', 'bgos-agent-912'],
    ['--user', 'show', '--property=LoadState,ActiveState,FragmentPath,WorkingDirectory,Environment', 'bgos-agent-912'],
    ['--user', 'restart', 'bgos-agent-912'],
  ])
  assert.deepEqual(done.agents.map((a: any) => [a.state, a.reason]), [['restarted', 'service']])
  // The unit bin/bgos-agent installs now carries this HOME's id (board row d6198bb6), and so does
  // the tmux socket its run.sh starts hoai on: the same cgroup read, read back and restart, under that name.
  const SCOPED_CGROUP = `/user.slice/user-501.slice/user@501.service/app.slice/bgos-agent-912-home-${HID}.service`
  const scopedTable = unitTable(false, `tmux: server (/tmp/tmux-501/hoai-912-home-${HID})`)
  const scopedFs = machine([{ id: '912', cwd: AVA, service: 'canonical', state: {} }], { platform: 'linux', scoped: true })
  scopedFs.writeFile(`/sys/fs/cgroup${SCOPED_CGROUP}/cgroup.procs`, scopedTable.procs)
  const scopedRec = recorder({ ps: scopedTable.ps, systemctlShow: `MainPID=1000\nControlGroup=${SCOPED_CGROUP}\n` })
  const scopedClock = fakeClock()
  answerProbes(scopedFs, scopedClock, ['912'])
  const scopedDone = await runKeepAliveSweep(ctxFor(scopedFs, scopedRec, scopedClock, { platform: 'linux' }).ctx as any)
  assert.deepEqual(scopedRec.calls.filter((c) => c.file === 'systemctl').map((c) => c.args), [
    ['--user', 'show', '-p', 'MainPID', '-p', 'ControlGroup', `bgos-agent-912-home-${HID}`],
    ['--user', 'show', '--property=LoadState,ActiveState,FragmentPath,WorkingDirectory,Environment', `bgos-agent-912-home-${HID}`],
    ['--user', 'restart', `bgos-agent-912-home-${HID}`],
  ])
  assert.deepEqual(scopedDone.agents.map((a: any) => [a.state, a.reason]), [['restarted', 'service']])
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
  // The bus is down for every `systemctl --user show` (the recorder fails the read back too): the
  // cgroup read is the one systemctl call, and its failure alone holds the restart.
  assert.deepEqual(noBus.calls.filter((c) => c.file === 'systemctl').map((c) => c.args), [['--user', 'show', '-p', 'MainPID', '-p', 'ControlGroup', 'bgos-agent-912']])
  assert.deepEqual(unread.agents.map((a: any) => [a.state, a.reason]), [['waiting_idle', 'process_tree_unreadable']])
})

test('F5 (linux): a stray in the cgroup of a unit whose OWN hoai is live restarts claude through the MARKER (the stray lives on), never waits for good', async () => {
  // A daemonized process the agent left behind (an ssh ControlPersist master,
  // a gpg-agent, a `nohup` dev server): reparented to systemd --user, still in
  // the unit's cgroup, and it may live for ever. The service restart would
  // kill it; the marker SIGTERMs only claude, exactly as for a person's hoai.
  const busy = unitTable(true)
  const fs = machine([{ id: '912', cwd: AVA, service: 'canonical', state: {} }], { platform: 'linux' })
  fs.writeFile(`/sys/fs/cgroup${CGROUP}/cgroup.procs`, busy.procs)
  fs.writeFile(`${HOME}/.bgos-agent/912/supervisor.json`, JSON.stringify({ pid: 3000, capabilities: ['relaunch'], startedAt: 'x' }))
  const rec = recorder({ ps: busy.ps, systemctlShow: UNIT_SHOW })
  const clock = fakeClock()
  answerProbes(fs, clock, ['912'])
  const report = await runKeepAliveSweep(ctxFor(fs, rec, clock, { platform: 'linux', pidAlive: (pid: number) => [3000, 4912, 5912, 7000].includes(pid) }).ctx as any)
  assert.equal(rec.calls.some((c) => c.file === 'systemctl' && c.args.includes('restart')), false, 'no systemctl --user restart over the stray')
  assert.equal(fs.files.get(`${HOME}/.bgos-agent/912/restart-requested.json`), '{}', 'claude alone restarts')
  assert.deepEqual(rec.kills, [], 'the stray is never signalled')
  assert.deepEqual(report.agents.map((a: any) => [a.state, a.reason]), [['restarted', 'marker']])
  // The same group with nothing outside the supervisor and claude keeps the service restart (hoai itself moves).
  const idle = unitTable(false)
  const quiet = machine([{ id: '912', cwd: AVA, service: 'canonical', state: {} }], { platform: 'linux' })
  quiet.writeFile(`/sys/fs/cgroup${CGROUP}/cgroup.procs`, idle.procs)
  quiet.writeFile(`${HOME}/.bgos-agent/912/supervisor.json`, JSON.stringify({ pid: 3000, capabilities: ['relaunch'], startedAt: 'x' }))
  const ok = recorder({ ps: idle.ps, systemctlShow: UNIT_SHOW })
  const okClock = fakeClock()
  answerProbes(quiet, okClock, ['912'])
  const done = await runKeepAliveSweep(ctxFor(quiet, ok, okClock, { platform: 'linux', pidAlive: (pid: number) => [3000, 4912, 5912].includes(pid) }).ctx as any)
  assert.deepEqual(ok.calls.filter((c) => c.file === 'systemctl' && c.args.includes('restart')).map((c) => c.args), [['--user', 'restart', 'bgos-agent-912']])
  assert.deepEqual(done.agents.map((a: any) => [a.state, a.reason]), [['restarted', 'service']])
  // The unit bin/bgos-agent installs now carries this HOME's id, and so does the tmux socket its
  // run.sh starts hoai on (board row d6198bb6). The hid 5156882f is watcherHomeId('/Users/kc',
  // 'linux'), pinned as a literal: the sweep judges the socket for the ROW's platform
  // (launcherIsServiceChild takes it), whatever host runs this file. The same two cases, under that name.
  const SCOPED_UNIT = 'bgos-agent-912-home-5156882f'
  const SCOPED_CGROUP = `/user.slice/user-501.slice/user@501.service/app.slice/${SCOPED_UNIT}.service`
  const SCOPED_TMUX = 'tmux: server (/tmp/tmux-501/hoai-912-home-5156882f)'
  const scopedBusy = unitTable(true, SCOPED_TMUX)
  const scopedFs = machine([{ id: '912', cwd: AVA, service: 'canonical', state: {} }], { platform: 'linux', scoped: true })
  scopedFs.writeFile(`/sys/fs/cgroup${SCOPED_CGROUP}/cgroup.procs`, scopedBusy.procs)
  scopedFs.writeFile(`${HOME}/.bgos-agent/912/supervisor.json`, JSON.stringify({ pid: 3000, capabilities: ['relaunch'], startedAt: 'x' }))
  const scopedRec = recorder({ ps: scopedBusy.ps, systemctlShow: `MainPID=1000\nControlGroup=${SCOPED_CGROUP}\n` })
  const scopedClock = fakeClock()
  answerProbes(scopedFs, scopedClock, ['912'])
  const scopedReport = await runKeepAliveSweep(ctxFor(scopedFs, scopedRec, scopedClock, { platform: 'linux', pidAlive: (pid: number) => [3000, 4912, 5912, 7000].includes(pid) }).ctx as any)
  // Its cgroup is read under the scoped name; the stray holds the service restart, so nothing is read back or restarted.
  assert.deepEqual(scopedRec.calls.filter((c) => c.file === 'systemctl').map((c) => c.args), [['--user', 'show', '-p', 'MainPID', '-p', 'ControlGroup', SCOPED_UNIT]])
  assert.equal(scopedFs.files.get(`${HOME}/.bgos-agent/912/restart-requested.json`), '{}', 'scoped: claude alone restarts')
  assert.deepEqual(scopedRec.kills, [], 'scoped: the stray is never signalled')
  assert.deepEqual(scopedReport.agents.map((a: any) => [a.state, a.reason]), [['restarted', 'marker']])
  const scopedIdle = unitTable(false, SCOPED_TMUX)
  const scopedQuiet = machine([{ id: '912', cwd: AVA, service: 'canonical', state: {} }], { platform: 'linux', scoped: true })
  scopedQuiet.writeFile(`/sys/fs/cgroup${SCOPED_CGROUP}/cgroup.procs`, scopedIdle.procs)
  scopedQuiet.writeFile(`${HOME}/.bgos-agent/912/supervisor.json`, JSON.stringify({ pid: 3000, capabilities: ['relaunch'], startedAt: 'x' }))
  const scopedOk = recorder({ ps: scopedIdle.ps, systemctlShow: `MainPID=1000\nControlGroup=${SCOPED_CGROUP}\n` })
  const scopedOkClock = fakeClock()
  answerProbes(scopedQuiet, scopedOkClock, ['912'])
  const scopedDone = await runKeepAliveSweep(ctxFor(scopedQuiet, scopedOk, scopedOkClock, { platform: 'linux', pidAlive: (pid: number) => [3000, 4912, 5912].includes(pid) }).ctx as any)
  assert.deepEqual(scopedOk.calls.filter((c) => c.file === 'systemctl').map((c) => c.args), [
    ['--user', 'show', '-p', 'MainPID', '-p', 'ControlGroup', SCOPED_UNIT],
    ['--user', 'show', '--property=LoadState,ActiveState,FragmentPath,WorkingDirectory,Environment', SCOPED_UNIT],
    ['--user', 'restart', SCOPED_UNIT],
  ])
  assert.equal(scopedQuiet.files.has(`${HOME}/.bgos-agent/912/restart-requested.json`), false, 'scoped: no marker')
  assert.deepEqual(scopedDone.agents.map((a: any) => [a.state, a.reason]), [['restarted', 'service']])
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
  // Agent 7 alone is read back and kicked; 912 is not even read back.
  assert.deepEqual(rec.calls.filter((c) => c.file === 'launchctl').map((c) => c.args), [['print', 'gui/501/ai.bgos.agent.7'], ['kickstart', '-k', 'gui/501/ai.bgos.agent.7']])
  assert.deepEqual(report.agents.map((a: any) => [a.id, a.state, a.reason]), [['7', 'restarted', 'service'], ['912', 'update_pending', 'one_restart_per_sweep']])
})

test('gates: at most one restart per agent per 30 min, 3 attempts per target version, then failed (visible)', async () => {
  const fs = machine([{ id: '912', cwd: AVA, service: 'canonical', state: {} }])
  const rec = recorder({ ps: IDLE_PS })
  const clock = fakeClock()
  // The daemon never comes back on the new version: verify times out every time.
  const { ctx } = ctxFor(fs, rec, clock, { verifyTimeoutMs: 3_000 })
  const kicks = () => rec.calls.filter((c) => c.file === 'launchctl' && c.args[0] === 'kickstart').length
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
  // Each attempt read its job back first; a limited or exhausted sweep runs no launchctl at all.
  assert.deepEqual(rec.calls.filter((c) => c.file === 'launchctl').map((c) => c.args[0]), ['print', 'kickstart', 'print', 'kickstart', 'print', 'kickstart'])
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

/** A win32 sweep's context; the recorder's faked Task Scheduler reads this machine's task scripts. */
function windowsCtx(fs: MemoryFs, rec: ReturnType<typeof recorder>, extra: Record<string, unknown> = {}) {
  rec.useTaskHost(fs)
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
/** What acts on the task: neither the process listing nor the read-only read back (the task script's probe, probe-legacy). */
const acting = (c: { file: string; args: string[] }) => notListing(c) && !readOnlyProbe(c)
/** This HOME's task name for agent 912 (board row d6198bb6; WHID is the id of C:\Users\kc). */
const WTASK = `HOAI Agent 912 home-${WHID}`

test('win32: a cleared agent with no supervisor gets the HOAI Agent <id> logon task (files + Register-ScheduledTask), started when it is not running', async () => {
  const fs = windowsMachine()
  // No task registered yet (no supervisor): the read back finds none under either name.
  const rec = recorder({ win32Task: 'absent' })
  const report = await runKeepAliveSweep(windowsCtx(fs, rec) as any)
  assert.equal(fs.files.get(`${WHOME}\\.bgos-agent\\912\\supervisor-generation`), '2\n')
  assert.ok(fs.files.get(`${WHOME}\\.bgos-agent\\912\\run-agent.vbs`)!.includes(`${WROOT}\\bin\\hoai-core.mjs"" --keep-alive`))
  // Read back first (this HOME's name, then the old one), then registered and started under this HOME's name.
  assert.deepEqual(rec.calls.filter(notListing).map((c) => [c.file, c.args[c.args.length - 1]]), [
    ['powershell.exe', 'probe'],
    ['powershell.exe', 'probe-legacy'],
    ['powershell.exe', 'install'],
    ['schtasks.exe', WTASK],
  ])
  assert.deepEqual(report.agents.map((a: any) => [a.state, a.reason]), [['installing', 'installed']])
})

test('win32: the task is registered but NOT started while the agent may be running by hand (fresh state); never a second session', async () => {
  const fs = windowsMachine({ ['C:\\Users\\kc\\.bgos-plugin-state\\912\\agent-state.json']: stateBody('912', T0) })
  const rec = recorder({ win32Task: 'absent' })
  await runKeepAliveSweep(windowsCtx(fs, rec) as any)
  assert.deepEqual(rec.calls.filter(notListing).map((c) => [c.file, c.args[c.args.length - 1]]), [['powershell.exe', 'probe'], ['powershell.exe', 'probe-legacy'], ['powershell.exe', 'install']])
})

test('win32 (board row d6198bb6): a task the sweep\'s own install registered is recorded by name, so the next sweep reads nothing back (no task script runs at all)', async () => {
  const fs = windowsMachine()
  const rec = recorder({ win32Task: 'absent' })
  const clock = fakeClock()
  const ctx = windowsCtx(fs, rec, { now: clock.now, sleep: clock.sleep, pidAlive: (pid: number) => pid === 777 })
  const first = await runKeepAliveSweep(ctx as any)
  assert.deepEqual(first.agents.map((a: any) => [a.state, a.reason]), [['installing', 'installed']])
  assert.deepEqual(rec.calls.filter(notListing).map((c) => [c.file, c.args[c.args.length - 1]]), [
    ['powershell.exe', 'probe'],
    ['powershell.exe', 'probe-legacy'],
    ['powershell.exe', 'install'],
    ['schtasks.exe', WTASK],
  ])
  // The install read this HOME's name back on the way: the once-per-agent check is done.
  assert.equal(JSON.parse(fs.files.get(keepAliveStatePath(WHOME))!).agents['912'].taskName, WTASK)
  // The launcher that /Run started is up by the next sweep.
  fs.writeFile(`${WSTATE}\\supervisor.json`, JSON.stringify({ pid: 777, capabilities: ['relaunch'] }))
  clock.advance(5 * MIN)
  rec.calls.length = 0
  const second = await runKeepAliveSweep(ctx as any)
  assert.deepEqual(rec.calls.filter((c) => c.file === 'powershell.exe' && c.args.includes('-File')), [], 'no probe, probe-legacy or install on the next sweep')
  assert.deepEqual(rec.calls.filter(notListing), [], 'nothing acts on the task either')
  assert.deepEqual(second.agents.map((a: any) => [a.state, a.reason]), [['supervised', 'canonical']])
  assert.equal(JSON.parse(fs.files.get(keepAliveStatePath(WHOME))!).agents['912'].taskName, WTASK, 'the name stays on the record')
})

test('win32 (board row d6198bb6): a sweep install whose read back of the OLD name failed records no task name (that old task may be this HOME\'s): a sweep after TASK_CHECK_RETRY_MS reads both names back again and records the name once the old one answers', async () => {
  const fs = windowsMachine()
  // No task registered yet, and the install's read back of the old name "HOAI Agent 912" fails once.
  const rec = recorder({ win32Task: 'absent', fail: [{ match: '-Action probe-legacy', code: 1, stderr: 'Get-ScheduledTask : Access is denied.', times: 1 }] })
  const clock = fakeClock()
  const logs: string[] = []
  const ctx = windowsCtx(fs, rec, { now: clock.now, sleep: clock.sleep, pidAlive: (pid: number) => pid === 777, log: (l: string) => logs.push(l) })
  const record = () => JSON.parse(fs.files.get(keepAliveStatePath(WHOME))!).agents['912']
  const first = await runKeepAliveSweep(ctx as any)
  assert.deepEqual(first.agents.map((a: any) => [a.state, a.reason]), [['installing', 'installed']])
  // This HOME's own name is free, so the install registers and starts it; the old one is left alone, said.
  assert.deepEqual(rec.calls.filter(notListing).map((c) => [c.file, c.args[c.args.length - 1]]), [
    ['powershell.exe', 'probe'],
    ['powershell.exe', 'probe-legacy'],
    ['powershell.exe', 'install'],
    ['schtasks.exe', WTASK],
  ])
  assert.ok(logs.some((l) => l.includes('left the Scheduled Task "HOAI Agent 912" alone: its record could not be read')), logs.join('\n'))
  assert.equal(record().taskName, undefined, 'the old task could not be read back: the once-per-agent check is not done')
  // The launcher that /Run started is up; the next sweep is an hour on.
  fs.writeFile(`${WSTATE}\\supervisor.json`, JSON.stringify({ pid: 777, capabilities: ['relaunch'] }))
  clock.advance(TASK_CHECK_RETRY_MS)
  rec.calls.length = 0
  const second = await runKeepAliveSweep(ctx as any)
  // The check reads both names back again: this HOME's task is kept as it is (nothing registered
  // again, nothing started), and the old name now answers (no task under it).
  assert.deepEqual(rec.calls.filter(notListing).map((c) => [c.file, c.args[c.args.length - 1]]), [
    ['powershell.exe', 'probe'],
    ['powershell.exe', 'probe-legacy'],
  ])
  assert.deepEqual(second.agents.map((a: any) => [a.state, a.reason]), [['supervised', 'canonical']])
  assert.equal(record().taskName, WTASK, 'checked: the name is on the record')
  assert.equal(record().lastTaskCheckError, null)
  // Done: the sweep after it reads nothing back.
  clock.advance(5 * MIN)
  rec.calls.length = 0
  await runKeepAliveSweep(ctx as any)
  assert.deepEqual(rec.calls.filter((c) => c.file === 'powershell.exe' && c.args.includes('-File')), [], 'no probe, probe-legacy or install once the name is recorded')
})

test('win32: a canonical task whose launcher is dead and agent stopped is started (schtasks /Run); its launcher follows the CURRENT plugin root', async () => {
  const stale = "' old launcher pointing at 0.62.0\r\n"
  const fs = windowsMachine({ [`${WSTATE}\\run-agent.vbs`]: stale, [`${WSTATE}\\supervisor-generation`]: '2\n' })
  const rec = recorder()
  const report = await runKeepAliveSweep(windowsCtx(fs, rec) as any)
  assert.deepEqual(rec.calls.filter(acting).map((c) => [c.file, ...c.args]), [['schtasks.exe', '/Run', '/TN', WTASK]])
  // Board row d6198bb6: the sweep's once-per-agent check reads the task back (this HOME's own, so it
  // is kept as it is: nothing registered again), and the start reads it back again right before /Run.
  assert.deepEqual(rec.calls.filter(notListing).map((c) => [c.file, c.args[c.args.length - 1]]), [
    ['powershell.exe', 'probe'],
    ['powershell.exe', 'probe-legacy'],
    ['powershell.exe', 'probe'],
    ['schtasks.exe', WTASK],
  ])
  assert.ok(fs.files.get(`${WSTATE}\\run-agent.vbs`)!.includes(`${WROOT}\\bin\\hoai-core.mjs`), 'the vbs was rewritten for the current root')
  assert.deepEqual(report.agents.map((a: any) => [a.state, a.reason]), [['supervised', 'task_started']])
  // A live launcher is left alone.
  const live = windowsMachine({ [`${WSTATE}\\run-agent.vbs`]: stale, [`${WSTATE}\\supervisor.json`]: JSON.stringify({ pid: 777, capabilities: ['relaunch'] }) })
  const quiet = recorder()
  await runKeepAliveSweep(windowsCtx(live, quiet, { pidAlive: (pid: number) => pid === 777 }) as any)
  assert.equal(quiet.calls.some((c) => c.file === 'schtasks.exe'), false)
})

test('online (F8, win32): a task start is kept online through its read backs and its command like a service restart', async () => {
  const fs = windowsMachine({ [`${WSTATE}\\run-agent.vbs`]: "' launcher\r\n", [`${WSTATE}\\supervisor-generation`]: '2\n' })
  // This HOME's task under its OLD name (an agent 0.69.2 installed, not renamed yet). The sweep's
  // once-per-agent rename check failed ten minutes ago (the old task's record could not be read
  // then), so this sweep does not repeat it (TASK_CHECK_RETRY_MS): the start reads both names back
  // itself, this HOME's own (none yet), then the old one (this HOME's now), and starts that.
  fs.writeFile(
    keepAliveStatePath(WHOME),
    JSON.stringify({ schemaVersion: 1, enabled: true, agents: { '912': { lastTaskCheckAt: new Date(T0 - 10 * MIN).toISOString(), lastTaskCheckError: 'old task "HOAI Agent 912" could not be read back' } } }),
  )
  const rec = recorder({ win32Task: 'legacy' })
  const clock = fakeClock()
  // Each read back (probe, then probe-legacy) returns 100 s (fake) after it
  // started and schtasks /Run 60 s (three ticks), or, for a sweep that never
  // ticks the clock while it waits (the defect), after a real 200 ms, so the
  // defect fails this test instead of hanging it. All three run inside one
  // keep-online wait (the start's), whose bound must cover all three: a bound
  // of one command's time limit (7 ticks of 20 s) stops ticking 40 s into the
  // second read back.
  let release: (() => void) | null = null
  let commandAt = 0
  let takes = 0
  clock.onSleep((_ms, at) => {
    if (release && at - commandAt >= takes) release()
  })
  /** When each slow command started and returned, on the fake clock, in order. */
  const spans: Array<{ name: string; from: number; to: number }> = []
  const slow = async (name: string, ms: number) => {
    commandAt = clock.now()
    takes = ms
    await new Promise<void>((resolve) => {
      release = resolve
      setTimeout(resolve, 200)
    })
    release = null
    spans.push({ name, from: commandAt, to: clock.now() })
  }
  const exec = async (file: string, args: readonly string[], o: any = {}) => {
    if (readOnlyProbe({ file, args: [...args] })) await slow(String(args[args.length - 1]), 100_000)
    else if (file === 'schtasks.exe' && args[0] === '/Run') await slow('/Run', 60_000)
    // Then answered (and recorded) by the faked Task Scheduler.
    return rec.exec(file, args, o)
  }
  const touches: number[] = []
  const keepOnline = async () => {
    touches.push(clock.now())
  }
  const report = await runKeepAliveSweep(windowsCtx(fs, rec, { exec, now: clock.now, sleep: clock.sleep, keepOnline }) as any)
  // No rename check this sweep: only the start's read backs, then the old task started by its name.
  assert.deepEqual(rec.calls.filter(notListing).map((c) => [c.file, c.args[c.args.length - 1]]), [
    ['powershell.exe', 'probe'],
    ['powershell.exe', 'probe-legacy'],
    ['schtasks.exe', 'HOAI Agent 912'],
  ])
  assert.deepEqual(rec.calls.filter(acting).map((c) => [c.file, ...c.args]), [['schtasks.exe', '/Run', '/TN', 'HOAI Agent 912']])
  // Every command of the start is bounded on its own.
  for (const c of rec.calls.filter(notListing)) assert.equal(c.opts?.timeoutMs, RESTART_EXEC_TIMEOUT_MS, `${c.file} ${c.args[c.args.length - 1]} is bounded`)
  assert.deepEqual(spans.map((s) => s.name), ['probe', 'probe-legacy', '/Run'])
  const [probe, legacy, run] = spans
  const within = (from: number, to: number) => touches.filter((at) => at > from && at <= to).length
  const inProbe = within(probe.from, legacy.from)
  const inLegacy = within(legacy.from, run.from)
  const inRun = within(run.from, run.to)
  assert.ok(inProbe + inLegacy >= 9, `touched through both read backs, about 200 s (${inProbe} + ${inLegacy})`)
  assert.ok(inProbe >= 4, `touched every 20 s through the 100 s probe (${inProbe})`)
  assert.ok(inLegacy >= 4, `touched every 20 s through the 100 s probe-legacy (${inLegacy})`)
  assert.ok(inRun >= 2, `touched while schtasks ran (${inRun})`)
  // Each one took its time on the fake clock: the sweep kept ticking through all three.
  assert.ok(probe.to - probe.from >= 100_000 && legacy.to - legacy.from >= 100_000, `the read backs took their 100 s (${JSON.stringify(spans)})`)
  assert.ok(run.to - run.from >= 60_000, `schtasks /Run took its 60 s (${run.to - run.from} ms)`)
  assert.deepEqual(report.agents.map((a: any) => [a.state, a.reason]), [['supervised', 'task_started']])
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
  // Board row 69337efa: a start that waits is a wait (with when), never `supervised`.
  assert.deepEqual(await sweep(), [['waiting_idle', 'task_start_rate_limited']])
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

// Review 3 F3: the wait above is the Windows twin of D4. The sweep writes it on
// the record that carries the update's target, so after 24 h its entry carried
// both waitingSince and pending 'update', and the app offered Restart now. That
// restart is the task tier, which refuses session_without_launcher for as long
// as that daemon lives: the job failed every time. A wait a plain restart cannot
// end says nothing about what it waits for (no pending, so no button).
test('review 3 F3 (win32): a session_without_launcher wait carries no pending even after 24 h, so the app never offers a Restart now the task tier must refuse', async () => {
  const fs = windowsMachine({
    [`${WSTATE}\\run-agent.vbs`]: "' launcher\r\n",
    [`${WSTATE}\\supervisor-generation`]: '2\n',
    ['C:\\Users\\kc\\.bgos-plugin-state\\912\\agent-state.json']: stateBody('912', T0),
  })
  const clock = fakeClock()
  const alive = (pid: number) => [4912, 5912].includes(pid)
  const first = await runKeepAliveSweep(windowsCtx(fs, recorder({ win32Ps: winListing(false) }), { now: clock.now, sleep: clock.sleep, pidAlive: alive }) as any)
  assert.deepEqual(first.agents, [{ id: '912', state: 'waiting_idle', reason: 'session_without_launcher', since: new Date(T0).toISOString() }])
  clock.advance(25 * 60 * MIN)
  fs.writeFile('C:\\Users\\kc\\.bgos-plugin-state\\912\\agent-state.json', stateBody('912', clock.now()))
  const rec = recorder({ win32Ps: winListing(false) })
  const later = await runKeepAliveSweep(windowsCtx(fs, rec, { now: clock.now, sleep: clock.sleep, pidAlive: alive }) as any)
  assert.equal(rec.calls.some((c) => c.file === 'schtasks.exe'), false)
  assert.deepEqual(later.agents, [{ id: '912', state: 'waiting_idle', reason: 'session_without_launcher', since: new Date(T0).toISOString(), waitingSince: new Date(T0).toISOString() }])
  assert.equal(JSON.parse(fs.files.get(keepAliveStatePath(WHOME))!).agents['912'].target, '0.62.1', 'the target still rides on the record: the update lands with the task start')
})

test('F4 (win32): a daemon too old to publish state but holding the pairing lock (a person\'s plain claude) is running: the task is registered, never started beside it', async () => {
  const lock = { ['C:\\Users\\kc\\.bgos-agent\\credentials-912.json.lock']: JSON.stringify({ pid: 4912, heartbeatAt: T0 - 3_000 }) }
  // No task yet: registered for the next logon, not started.
  const fresh = windowsMachine(lock)
  const rec = recorder({ win32Ps: winListing(false), win32Task: 'absent' })
  const report = await runKeepAliveSweep(windowsCtx(fresh, rec, { pidAlive: (pid: number) => [4912, 5912].includes(pid) }) as any)
  assert.deepEqual(rec.calls.filter(notListing).map((c) => [c.file, c.args[c.args.length - 1]]), [['powershell.exe', 'probe'], ['powershell.exe', 'probe-legacy'], ['powershell.exe', 'install']])
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

// -- Board row 69337efa: a crashed Windows agent is started at once ---------------------------------------

const PIN = '8c1f0000-0000-4000-8000-000000000912'
const OTHER_PIN = '8c1f0000-0000-4000-8000-000000000077'
const WPLUGIN_STATE = 'C:\\Users\\kc\\.bgos-plugin-state\\912'
const WLOCK = 'C:\\Users\\kc\\.bgos-agent\\credentials-912.json.lock'
const WNODE = 'C:\\Program Files\\nodejs\\node.exe'

/**
 * The install-agent-task.ps1 0.69.2 wrote beside an agent's launcher (byte for byte what
 * test/agent-task-win32.test.ts pinned at v0.69.2): four actions, the old unscoped name, no probe.
 * A HOME upgraded from 0.69.2 holds it until the first act on the task rewrites it.
 */
function taskScript0692(id: string) {
  return [
    `# HOAI Agent ${id}: logon task that keeps this agent running (generated by lib/agent-task-win32.mjs).`,
    'param([Parameter(Mandatory = $true)][ValidateSet("install", "run", "uninstall", "status")][string]$Action)',
    `$name = 'HOAI Agent ${id}'`,
    `$vbs = 'C:\\Users\\kc\\.bgos-agent\\${id}\\run-agent.vbs'`,
    'function Register-Task {',
    '  $action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "//B `"$vbs`""',
    '  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME',
    '  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew',
    '  $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited',
    '  Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force -ErrorAction Stop | Out-Null',
    '}',
    'switch ($Action) {',
    '  "install" {',
    '    try { Register-Task; Write-Output "task registered"; exit 0 }',
    '    catch { Write-Output ("task registration refused: " + $_.Exception.Message); exit 1 }',
    '  }',
    '  "run" {',
    '    try { Start-ScheduledTask -TaskName $name -ErrorAction Stop; Write-Output "task started"; exit 0 }',
    '    catch { Write-Output ("task start refused: " + $_.Exception.Message); exit 1 }',
    '  }',
    '  "uninstall" {',
    '    try { Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction Stop } catch {}',
    '    Write-Output "unregistered"; exit 0',
    '  }',
    '  "status" {',
    '    $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue',
    '    if ($task) { Write-Output ("task " + $task.State); exit 0 }',
    '    Write-Output "not registered"; exit 1',
    '  }',
    '}',
    '',
  ].join('\r\n')
}

/**
 * Agent 1078 on AlienAres, 2026-10-11 07:54:15Z, as agent 912 here: its task is installed (and its
 * launcher file current), its launcher (a plain hoai, pid 777) exited with claude, and the daemon
 * (pid 4912) died with them. Its last state, its pairing lock and its transcript were all written a
 * minute ago, so by the activity stamps it "was active a minute ago".
 *
 * `world` is the recorder's `win32Task` the machine goes with, and the task script beside the
 * launcher is the one that world's task was registered with: 'own' (the default, as the recorder's)
 * this HOME's task as 0.69.3 registers it, so the current install-agent-task.ps1; 'legacy' the old
 * task 0.69.2 registered, so the 0.69.2 script (taskScript0692), which a HOME upgraded from 0.69.2
 * holds until the first act on the task rewrites it.
 */
function crashedMachine(extra: Record<string, string> = {}, opts: { activityAt?: number; id?: string; cwd?: string; pin?: string; world?: 'own' | 'legacy' } = {}) {
  const id = opts.id ?? '912'
  const cwd = opts.cwd ?? WCWD
  const pin = opts.pin ?? PIN
  const state = `C:\\Users\\kc\\.bgos-agent\\${id}`
  const activityAt = opts.activityAt ?? T0 - 1 * MIN
  const spec = agentTaskSpec({ assistantId: id, home: WHOME, nodePath: WNODE, pluginRoot: WROOT, cwd })
  const fs = windowsMachine({
    [`${WHOME}\\.bgos-agent\\credentials-${id}.json`]: '{}',
    [`${state}\\launch.json`]: JSON.stringify(buildLaunchRecipe({ assistantId: id, cwd, argv: [], installMethod: 'marketplace', pluginRoot: WROOT, node: 'node', startedAt: 'x', pid: null })),
    [`${cwd}\\.bgos-agent-id`]: `${id}\n`,
    [spec.files[0].path]: spec.files[0].content,
    // The task script of the world's registration (see above): every act on the task rewrites it
    // before its read back, so in the 'legacy' world the first one after the upgrade changes this
    // file (and only this one); in the 'own' world it rewrites the same bytes.
    [spec.files[1].path]: (opts.world ?? 'own') === 'legacy' ? taskScript0692(id) : spec.files[1].content,
    [`${state}\\supervisor-generation`]: '2\n',
    [`${state}\\supervisor.json`]: JSON.stringify({ pid: 777, capabilities: ['relaunch'] }),
    [`${state}\\session-id`]: `${pin}\n`,
    [`C:\\Users\\kc\\.bgos-plugin-state\\${id}\\agent-state.json`]: stateBody(id, activityAt + 10_000, { lastActivityAt: new Date(activityAt).toISOString(), sessionId: pin, claudePid: null, runningVersion: '0.62.1' }),
    [`${WHOME}\\.bgos-agent\\credentials-${id}.json.lock`]: JSON.stringify({ pid: Number(`4${id}`), heartbeatAt: activityAt + 5_000 }),
    ...extra,
  })
  fs.dirs.add(cwd)
  const transcript = transcriptPathFor({ configDir: `${WHOME}\\.claude`, cwd, sessionId: pin })
  fs.writeFile(transcript, '{"type":"assistant"}\n')
  fs.touch(transcript, activityAt)
  return fs
}

/** What runs on the computer after the crash: the watcher, and another agent's claude on its own pin. */
const AFTER_CRASH: Array<Record<string, unknown>> = [
  { ProcessId: 4, ParentProcessId: 0, CreationDate: null, CommandLine: null },
  { ProcessId: 4100, ParentProcessId: 1, CreationDate: T0 - 600 * MIN, CommandLine: 'C:\\Windows\\explorer.exe' },
  { ProcessId: 3100, ParentProcessId: 4100, CreationDate: T0 - 300 * MIN, CommandLine: `"${WNODE}" C:\\Users\\kc\\.bgos-agent\\watcher\\bundle\\watcher.mjs` },
  { ProcessId: 8100, ParentProcessId: 4100, CreationDate: T0 - 120 * MIN, CommandLine: `"C:\\Users\\kc\\.local\\bin\\claude.exe" --resume ${OTHER_PIN}` },
  { ProcessId: 8200, ParentProcessId: 8100, CreationDate: T0 - 120 * MIN, CommandLine: 'bun C:\\x\\server.ts' },
]
const listed = (extra: Array<Record<string, unknown>> = []) => JSON.stringify([...AFTER_CRASH, ...extra])
const aliveIn = (extra: Array<Record<string, unknown>> = []) => (pid: number) => [...AFTER_CRASH, ...extra].some((p) => p.ProcessId === pid && pid !== 4)
const starts = (rec: ReturnType<typeof recorder>) => rec.calls.filter((c) => c.file === 'schtasks.exe').map((c) => c.args.join(' '))

test('board row 69337efa (win32): a crashed agent (launcher dead, lock holder dead, no claude of its own listed, activity a minute ago) is started in the SAME sweep', async () => {
  const fs = crashedMachine()
  const before = new Map(fs.files)
  /** Every path the sweep writes outside the watcher's own folder, in order (a rewrite of the same bytes too). */
  const recordWrites = (machine: MemoryFs) => {
    const writes: string[] = []
    const write = machine.writeFile
    machine.writeFile = (path, text, o) => {
      if (!path.startsWith(`${WHOME}\\.bgos-agent\\watcher\\`)) writes.push(path)
      write(path, text, o)
    }
    return writes
  }
  const writes = recordWrites(fs)
  const rec = recorder({ win32Ps: listed() })
  const report = await runKeepAliveSweep(windowsCtx(fs, rec, { pidAlive: aliveIn() }) as any)
  assert.deepEqual(starts(rec), [`/Run /TN ${WTASK}`], 'started now, not 30 minutes after its own last writes')
  assert.deepEqual(report.agents.map((a: any) => [a.state, a.reason]), [['supervised', 'task_started']])
  assert.equal(JSON.parse(fs.files.get(keepAliveStatePath(WHOME))!).agents['912'].taskStarts, 1, 'the start is counted')
  // This HOME's task was registered by 0.69.3 (the 'own' world), and its files are the current ones.
  // What the sweep writes outside the watcher's own folder: the once-per-agent check
  // (installAgentTask, keep) writes the task script before its read back, then the launcher and the
  // generation stamp once the read back allows it (and registers nothing: the task is this HOME's
  // own); the start (runAgentTask) writes the task script again before its own read back. Every one
  // of those writes is the same bytes as on disk, so nothing outside the watcher's folder changed.
  const script = `${WSTATE}\\install-agent-task.ps1`
  assert.deepEqual(writes, [script, `${WSTATE}\\run-agent.vbs`, `${WSTATE}\\supervisor-generation`, script])
  const changed = [...fs.files.keys()].filter((p) => before.get(p) !== fs.files.get(p))
  assert.deepEqual(changed.filter((p) => !p.startsWith(`${WHOME}\\.bgos-agent\\watcher\\`)), [], 'no file outside the watcher folder changed')
  assert.equal(fs.files.get(script), agentTaskSpec({ assistantId: '912', home: WHOME, nodePath: WNODE, pluginRoot: WROOT, cwd: WCWD }).files[1].content)
  // The same crash in a HOME 0.69.2 left as it was, its task too (the old name, no description,
  // this HOME's launcher): the sweep's once-per-agent check renames it in place (the new task
  // registered, then the old one retired, the agent neither stopped nor started), then the start
  // reads the new one back and starts it, in the same sweep. Only the task script changed.
  const upgraded = crashedMachine({}, { world: 'legacy' })
  const upgradedBefore = new Map(upgraded.files)
  assert.equal(upgradedBefore.get(script), taskScript0692('912'), 'it held the 0.69.2 script')
  const upgradedWrites = recordWrites(upgraded)
  const upgradedRec = recorder({ win32Ps: listed(), win32Task: 'legacy' })
  const upgradedReport = await runKeepAliveSweep(windowsCtx(upgraded, upgradedRec, { pidAlive: aliveIn() }) as any)
  assert.deepEqual(upgradedRec.calls.filter(notListing).map((c) => [c.file, c.args[c.args.length - 1]]), [
    ['powershell.exe', 'probe'],
    ['powershell.exe', 'probe-legacy'],
    ['powershell.exe', 'install'],
    ['powershell.exe', 'retire-legacy-task'],
    ['powershell.exe', 'probe'],
    ['schtasks.exe', WTASK],
  ])
  const host = upgradedRec.useTaskHost(upgraded)
  assert.equal(host.tasks.has('HOAI Agent 912'), false, 'the old task is retired')
  assert.deepEqual(host.tasks.get(WTASK), { description: 'HOAI agent 912, installed from home=C:\\Users\\kc', action: `wscript.exe //B "${WSTATE}\\run-agent.vbs"`, state: 'Running' })
  assert.deepEqual(upgradedReport.agents.map((a: any) => [a.state, a.reason]), [['supervised', 'task_started']])
  assert.equal(JSON.parse(upgraded.files.get(keepAliveStatePath(WHOME))!).agents['912'].taskName, WTASK, 'renamed: the check is not repeated')
  // The same writes as in the 'own' world (the check's script, launcher and stamp, the start's
  // script); the rename itself is the Task Scheduler's, no file.
  assert.deepEqual(upgradedWrites, [script, `${WSTATE}\\run-agent.vbs`, `${WSTATE}\\supervisor-generation`, script])
  const upgradedChanged = [...upgraded.files.keys()].filter((p) => upgradedBefore.get(p) !== upgraded.files.get(p))
  assert.deepEqual(upgradedChanged.filter((p) => !p.startsWith(`${WHOME}\\.bgos-agent\\watcher\\`)), [script])
  assert.equal(upgraded.files.get(script), agentTaskSpec({ assistantId: '912', home: WHOME, nodePath: WNODE, pluginRoot: WROOT, cwd: WCWD }).files[1].content, 'now the current script')
})

test('board row 69337efa (win32): a live claude carrying the agent\'s pinned session id still blocks the start (its daemon dead, recent activity or none)', async () => {
  const own = [{ ProcessId: 5912, ParentProcessId: 4100, CreationDate: T0 - 30 * MIN, CommandLine: `"C:\\Users\\kc\\.local\\bin\\claude.exe" --resume ${PIN} --dangerously-load-development-channels server:hoai` }]
  for (const activityAt of [T0 - 1 * MIN, T0 - 40 * MIN]) {
    const fs = crashedMachine({}, { activityAt })
    const rec = recorder({ win32Ps: listed(own) })
    const report = await runKeepAliveSweep(windowsCtx(fs, rec, { pidAlive: aliveIn(own) }) as any)
    assert.deepEqual(starts(rec), [], `never a second session on its pin (activity ${(T0 - activityAt) / MIN} min ago)`)
    assert.deepEqual(report.agents, [{ id: '912', state: 'waiting_idle', reason: 'session_without_launcher', since: new Date(T0).toISOString() }], 'no time: it waits for that session to end')
  }
})

test('board row 69337efa (win32): a live pairing lock holder still blocks the start (F4), and so does a hung one whose claude still runs; a reused pid does not', async () => {
  // A plain claude (no pin on its command line) whose daemon holds the lock: a person's own session.
  const session = [
    { ProcessId: 5912, ParentProcessId: 4100, CreationDate: T0 - 30 * MIN, CommandLine: '"C:\\Users\\kc\\.local\\bin\\claude.exe"' },
    { ProcessId: 6000, ParentProcessId: 5912, CreationDate: T0 - 29 * MIN, CommandLine: 'node C:\\x\\bin\\bgos-launch.mjs C:\\x\\server.ts' },
    { ProcessId: 4912, ParentProcessId: 6000, CreationDate: T0 - 29 * MIN, CommandLine: 'bun C:\\x\\server.ts' },
  ]
  // The daemon's last state is 10 minutes old (not fresh), so the LOCK is what says it lives;
  // the transcript, written a minute ago, is the recent activity.
  const oldState = { [`${WPLUGIN_STATE}\\agent-state.json`]: stateBody('912', T0 - 10 * MIN + 10_000, { lastActivityAt: new Date(T0 - 10 * MIN).toISOString(), sessionId: PIN, claudePid: null, runningVersion: '0.62.1' }) }
  const live = crashedMachine({ ...oldState, [WLOCK]: JSON.stringify({ pid: 4912, heartbeatAt: T0 - 3_000 }) })
  const liveRec = recorder({ win32Ps: listed(session) })
  const liveReport = await runKeepAliveSweep(windowsCtx(live, liveRec, { pidAlive: aliveIn(session) }) as any)
  assert.deepEqual(starts(liveRec), [])
  assert.deepEqual(liveReport.agents.map((a: any) => [a.state, a.reason]), [['waiting_idle', 'session_without_launcher']])
  // Its heartbeat stale (a hung daemon), the same process still under its claude: still a session.
  const hung = crashedMachine({ ...oldState, [WLOCK]: JSON.stringify({ pid: 4912, heartbeatAt: T0 - 10 * MIN }) })
  const hungRec = recorder({ win32Ps: listed(session) })
  const hungReport = await runKeepAliveSweep(windowsCtx(hung, hungRec, { pidAlive: aliveIn(session) }) as any)
  assert.deepEqual(starts(hungRec), [])
  assert.deepEqual(hungReport.agents.map((a: any) => [a.state, a.reason]), [['waiting_idle', 'session_without_launcher']])
  // Its pid now names a process started after the last heartbeat (another agent's daemon): not this agent.
  const reused = [{ ProcessId: 4912, ParentProcessId: 8100, CreationDate: T0 - 2 * MIN, CommandLine: 'bun C:\\x\\server.ts' }]
  const gone = crashedMachine({ ...oldState, [WLOCK]: JSON.stringify({ pid: 4912, heartbeatAt: T0 - 10 * MIN }) })
  const goneRec = recorder({ win32Ps: listed(reused) })
  await runKeepAliveSweep(windowsCtx(gone, goneRec, { pidAlive: aliveIn(reused) }) as any)
  assert.deepEqual(starts(goneRec), [`/Run /TN ${WTASK}`])
})

test('board row 69337efa (win32): an update for an agent whose launcher died waits (session_without_launcher) for a claude its last state named, though its daemon is gone: never a schtasks /Run beside it', async () => {
  // The daemon died (pid 4912 gone) but claude 5912, which its last state named, still runs: started before
  // the installed version landed, so an update is pending, and the agent has been quiet for 40 minutes.
  const own = [{ ProcessId: 5912, ParentProcessId: 4100, CreationDate: T0 - 120 * MIN, CommandLine: '"C:\\Users\\kc\\.local\\bin\\claude.exe"' }]
  const fs = crashedMachine({ [`${WPLUGIN_STATE}\\agent-state.json`]: stateBody('912', T0 - 40 * MIN + 10_000, { lastActivityAt: new Date(T0 - 40 * MIN).toISOString(), sessionId: PIN, claudePid: 5912, runningVersion: '0.62.0' }) }, { activityAt: T0 - 40 * MIN })
  const rec = recorder({ win32Ps: listed(own) })
  const report = await runKeepAliveSweep(windowsCtx(fs, rec, { pidAlive: aliveIn(own) }) as any)
  assert.deepEqual(starts(rec), [], 'the task tier would start a second session on the pin beside it')
  assert.deepEqual(report.agents.map((a: any) => [a.state, a.reason]), [['waiting_idle', 'session_without_launcher']])
  assert.equal(JSON.parse(fs.files.get(keepAliveStatePath(WHOME))!).agents['912'].attempts, 0, 'no attempt spent')
})

// Review: an agent whose folder is the home folder (the pairing default before 2026-09-21) holds
// every claude installed under it on a command line; none of them is a session run in it.
test('board row 69337efa (win32): an agent whose folder holds the claude install (a home folder agent) is still started at once', async () => {
  const fs = crashedMachine({}, { cwd: WHOME })
  const rec = recorder({ win32Ps: listed() })
  const report = await runKeepAliveSweep(windowsCtx(fs, rec, { pidAlive: aliveIn() }) as any)
  assert.deepEqual(starts(rec), [`/Run /TN ${WTASK}`], 'C:\\Users\\kc\\.local\\bin\\claude.exe is not a claude run in C:\\Users\\kc')
  assert.deepEqual(report.agents.map((a: any) => [a.state, a.reason]), [['supervised', 'task_started']])
})

// Review: "the pairing lock holder pid is dead (or no lock)". A holder that still runs as itself (started
// before its last heartbeat) with no claude visible above it (an orphaned or hung daemon, or a claude this
// watcher cannot read) is not a dead one: the session is not ruled out, so the quiet window holds.
test('board row 69337efa (win32): a lock holder that still runs as itself with no claude above it keeps the quiet window (never an immediate start)', async () => {
  const daemon = [{ ProcessId: 4912, ParentProcessId: 4100, CreationDate: T0 - 60 * MIN, CommandLine: 'bun C:\\x\\server.ts' }]
  const stale = (at: number) => ({
    [`${WPLUGIN_STATE}\\agent-state.json`]: stateBody('912', at + 10_000, { lastActivityAt: new Date(at).toISOString(), sessionId: PIN, claudePid: null, runningVersion: '0.62.1' }),
    [WLOCK]: JSON.stringify({ pid: 4912, heartbeatAt: at }),
  })
  // Its heartbeat 10 minutes old, the transcript written a minute ago.
  const fs = crashedMachine(stale(T0 - 10 * MIN))
  const rec = recorder({ win32Ps: listed(daemon) })
  const report = await runKeepAliveSweep(windowsCtx(fs, rec, { pidAlive: aliveIn(daemon) }) as any)
  assert.deepEqual(starts(rec), [])
  assert.deepEqual(report.agents, [{ id: '912', state: 'waiting_idle', reason: 'quiet_window', since: new Date(T0).toISOString(), restartAt: new Date(T0 + 29 * MIN).toISOString() }])
  // Quiet for 40 minutes: the legacy rule starts it, as before.
  const quiet = crashedMachine(stale(T0 - 40 * MIN), { activityAt: T0 - 40 * MIN })
  const quietRec = recorder({ win32Ps: listed(daemon) })
  await runKeepAliveSweep(windowsCtx(quiet, quietRec, { pidAlive: aliveIn(daemon) }) as any)
  assert.deepEqual(starts(quietRec), [`/Run /TN ${WTASK}`])
})

test('board row 69337efa (win32): a process table that cannot be read keeps the 30 min quiet window, reported as waiting_idle quiet_window with restartAt', async () => {
  const fs = crashedMachine()
  const clock = fakeClock()
  const rec = recorder() // powershell answers nothing parseable: the table is unreadable
  const ctx = windowsCtx(fs, rec, { now: clock.now, sleep: clock.sleep, pidAlive: aliveIn() })
  const first = await runKeepAliveSweep(ctx as any)
  assert.deepEqual(starts(rec), [], 'a session it cannot see is not ruled out')
  const restartAt = new Date(T0 - 1 * MIN + 30 * MIN).toISOString()
  assert.deepEqual(first.agents, [{ id: '912', state: 'waiting_idle', reason: 'quiet_window', since: new Date(T0).toISOString(), restartAt }])
  assert.deepEqual(readKeepAliveReport({ home: WHOME, fs, now: clock.now() }).agents, first.agents, 'the heartbeat carries the same entry')
  clock.advance(28 * MIN)
  assert.deepEqual((await runKeepAliveSweep(ctx as any)).agents.map((a: any) => [a.state, a.reason, a.restartAt]), [['waiting_idle', 'quiet_window', restartAt]])
  assert.deepEqual(starts(rec), [])
  clock.advance(1 * MIN)
  const started = await runKeepAliveSweep(ctx as any)
  assert.deepEqual(starts(rec), [`/Run /TN ${WTASK}`], 'started when the window it named ends')
  assert.deepEqual(started.agents, [{ id: '912', state: 'supervised', reason: 'task_started', since: new Date(clock.now()).toISOString() }], 'no stale restartAt')
})

test('board row 69337efa (win32): the gates still bound a crash loop (1 start per 30 min, 3 per death episode, then failed), and each wait says when', async () => {
  const fs = crashedMachine()
  const clock = fakeClock()
  const rec = recorder({ win32Ps: listed() })
  const ctx = windowsCtx(fs, rec, { now: clock.now, sleep: clock.sleep, pidAlive: aliveIn() })
  // Every session the task starts crashes within the minute: its stamps are always a minute old.
  const crashAgain = () => {
    const at = clock.now() - 1 * MIN
    fs.writeFile(`${WPLUGIN_STATE}\\agent-state.json`, stateBody('912', at + 10_000, { lastActivityAt: new Date(at).toISOString(), sessionId: PIN, claudePid: null, runningVersion: '0.62.1' }))
  }
  const sweep = async () => {
    crashAgain()
    return (await runKeepAliveSweep(ctx as any)).agents.map((a: any) => [a.state, a.reason, a.restartAt ?? null])
  }
  assert.deepEqual(await sweep(), [['supervised', 'task_started', null]])
  clock.advance(1 * MIN)
  assert.deepEqual(await sweep(), [['waiting_idle', 'task_start_rate_limited', new Date(T0 + 30 * MIN).toISOString()]])
  clock.advance(30 * MIN)
  assert.deepEqual(await sweep(), [['supervised', 'task_started', null]])
  clock.advance(31 * MIN)
  assert.deepEqual(await sweep(), [['supervised', 'task_started', null]])
  clock.advance(31 * MIN)
  assert.deepEqual(await sweep(), [['failed', 'task_start_failed', null]])
  clock.advance(120 * MIN)
  assert.deepEqual(await sweep(), [['failed', 'task_start_failed', null]])
  assert.equal(starts(rec).length, 3, 'never a fourth start in one death episode')
})

test('board row 69337efa (win32): one start per sweep: two agents that crashed together are started one sweep apart', async () => {
  const fs = crashedMachine()
  const second = crashedMachine({}, { id: '913', cwd: 'C:\\Users\\kc\\hoai-agents\\guru', pin: '8c1f0000-0000-4000-8000-000000000913' })
  for (const [path, text] of second.files) if (!fs.files.has(path)) fs.writeFile(path, text)
  fs.touch(transcriptPathFor({ configDir: `${WHOME}\\.claude`, cwd: 'C:\\Users\\kc\\hoai-agents\\guru', sessionId: '8c1f0000-0000-4000-8000-000000000913' }), T0 - 1 * MIN)
  fs.dirs.add('C:\\Users\\kc\\hoai-agents\\guru')
  const clock = fakeClock()
  const rec = recorder({ win32Ps: listed() })
  const fetchKeepAlive = consent({ enabled: true, enabledAt: 'e', assistantIds: [912, 913] }).fetchKeepAlive
  const ctx = windowsCtx(fs, rec, { now: clock.now, sleep: clock.sleep, pidAlive: aliveIn(), fetchKeepAlive })
  const first = await runKeepAliveSweep(ctx as any)
  assert.deepEqual(starts(rec), [`/Run /TN ${WTASK}`])
  assert.deepEqual(first.agents.map((a: any) => [a.id, a.state, a.reason]), [['912', 'supervised', 'task_started'], ['913', 'waiting_idle', 'one_restart_per_sweep']])
  clock.advance(1 * MIN)
  await runKeepAliveSweep(ctx as any)
  assert.deepEqual(starts(rec), [`/Run /TN ${WTASK}`, `/Run /TN HOAI Agent 913 home-${WHID}`])
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
  // The hook joins with the HOST's separator and the watcher with the home's own, so a POSIX
  // home on a Windows runner differs only in the separator; the same file either way.
  assert.equal(normalize(hookSpoolPathFor({ env: {}, home: HOME, sessionId: sid })), normalize(hook.spoolPath(sid, {}, HOME)))
  assert.equal(
    normalize(hookSpoolPathFor({ env: { BGOS_PLUGIN_STATE_DIR: '/s' }, home: HOME, sessionId: sid })),
    normalize(hook.spoolPath(sid, { BGOS_PLUGIN_STATE_DIR: '/s' }, HOME)),
  )
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
  // The agent's daemon reads ITS config dir, so it is the one that names 0.70.0.
  const fs = machine([{ id: '912', cwd: AVA, service: 'canonical', state: { runningVersion: '0.62.1', pendingRestartVersion: '0.70.0' } }])
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

test('daemon F7: a FRESH daemon that reports nothing pending is not restarted, whatever installed version the watcher itself reads', async () => {
  // The daemon runs under another CLAUDE_CONFIG_DIR the watcher knows nothing of
  // (no launch recipe says so), and there its plugin is current: it publishes null.
  const fs = machine([{ id: '912', cwd: AVA, service: 'canonical', state: { runningVersion: '0.62.0', pendingRestartVersion: null } }])
  const rec = recorder({ ps: IDLE_PS })
  const clock = fakeClock()
  answerProbes(fs, clock, ['912'])
  const report = await runKeepAliveSweep(ctxFor(fs, rec, clock).ctx as any)
  assert.deepEqual(report.agents.map((a: any) => [a.state, a.reason]), [['supervised', 'canonical']])
  assert.deepEqual(rec.calls.filter((c) => c.file === 'launchctl'), [], 'no restart onto the watcher\'s 0.62.1')
  // The same daemon naming its own pending version is restarted onto THAT version.
  const named = machine([{ id: '912', cwd: AVA, service: 'canonical', state: { runningVersion: '0.62.0', pendingRestartVersion: '0.62.3' } }])
  const rec2 = recorder({ ps: IDLE_PS })
  const clock2 = fakeClock()
  answerProbes(named, clock2, ['912'])
  const restarted = await runKeepAliveSweep(ctxFor(named, rec2, clock2).ctx as any)
  assert.deepEqual(restarted.agents.map((a: any) => [a.state, a.reason]), [['restarted', 'service']])
  assert.equal(JSON.parse(named.files.get(keepAliveStatePath(HOME))!).agents['912'].target, '0.62.3')
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

// -- a failed agent stays failed until something proves it is up (board row 84296679, fix 4) ----------------------

const NO_CLAUDE_PS = [psLine(1, 0, '/sbin/launchd')].join('\n')

function seedFailed(fs: MemoryFs, id: string, reasonText: string) {
  fs.writeFile(
    keepAliveStatePath(HOME),
    JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      consentSource: 'live',
      agents: { [id]: { state: 'failed', reason: reasonText, since: new Date(T0 - 60_000).toISOString(), attempts: 1, lastRestartAt: new Date(T0 - 60_000).toISOString() } },
    }),
  )
}

test('fix 4 (kc-server 871, 10:42:33 failed then 10:42:59 supervised): the sweep AFTER a failed verify keeps the agent failed while nothing runs', async () => {
  // Up to date (nothing pending), its unit file present, its launch crash looping: the old code
  // classified it by the unit file alone and wrote `supervised canonical`.
  const fs = machine([{ id: '912', cwd: AVA, service: 'canonical', state: null }], { installedVersion: '0.62.0' })
  seedFailed(fs, '912', 'agent_deaf_after_restart')
  const rec = recorder({ ps: NO_CLAUDE_PS })
  const clock = fakeClock()
  const report = await runKeepAliveSweep(ctxFor(fs, rec, clock).ctx as any)
  assert.deepEqual(report.agents.map((a: any) => [a.id, a.state, a.reason]), [['912', 'failed', 'agent_deaf_after_restart']])
})

test('fix 4: a launch that is itself failing is failed with no earlier record, and a live daemon ends the hold', async () => {
  const fs = machine([{ id: '912', cwd: AVA, service: 'canonical', state: null }], { installedVersion: '0.62.0' })
  const statusPath = `${HOME}/.bgos-agent/912/launch-status`
  fs.writeFile(statusPath, "2026-10-12 10:41:03 outcome=exited-during-startup answered=[] screen=\"error: unknown option\" rc=1\n")
  fs.writeFile(`${HOME}/.bgos-agent/912/failcount`, '9\n')
  const clock = fakeClock()
  fs.touch(statusPath, clock.now() - 20_000)
  const looping = await runKeepAliveSweep(ctxFor(fs, recorder({ ps: NO_CLAUDE_PS }), clock).ctx as any)
  assert.deepEqual(looping.agents.map((a: any) => [a.state, a.reason]), [['failed', 'launch_failing:exited-during-startup']])

  // The daemon comes up and publishes a fresh state: proof, so it is supervised again.
  clock.advance(60_000)
  fs.writeFile(`${HOME}/.bgos-plugin-state/912/agent-state.json`, stateBody('912', clock.now(), { runningVersion: '0.62.1' }))
  const up = await runKeepAliveSweep(ctxFor(fs, recorder({ ps: IDLE_PS }), clock).ctx as any)
  assert.deepEqual(up.agents.map((a: any) => a.state), ['supervised'])
})

// -- A fresh start is never restarted again (Mark, agent 909, 2026-10-12 17:17:10) ----------------
//
// A marker restart leaves a gap: the old daemon removes agent-state.json on its
// clean stop and the new one publishes only once it holds the pairing lock, so a
// sweep in that gap judges the agent by time ('started_before_install'). The
// launcher had just started claude, yet nothing the sweep counted as activity
// said so: a hand restart was followed 9 s later by a '{}' marker and a second,
// unrequested restart.

function freshStartMachine(ageMs: number, landedAgoMs: number) {
  const startedAt = T0 - ageMs
  return windowsMachine({
    [`${WSTATE}\\run-agent.vbs`]: "' launcher\r\n",
    [`${WSTATE}\\supervisor-generation`]: '2\n',
    [`${WSTATE}\\supervisor.json`]: JSON.stringify({ pid: 777, capabilities: ['relaunch'] }),
    // hoai-core rewrites launch.json right before the claude it starts.
    [`${WSTATE}\\launch.json`]: JSON.stringify(buildLaunchRecipe({ assistantId: '912', cwd: WCWD, argv: [], installMethod: 'marketplace', pluginRoot: WROOT, node: 'node', startedAt: new Date(startedAt - 200).toISOString(), pid: 777 })),
    // The new daemon holds the lock; it has not published agent-state.json yet.
    [`${WHOME}\\.bgos-agent\\credentials-912.json.lock`]: JSON.stringify({ pid: 4912, heartbeatAt: T0 - 1000 }),
    [`${WHOME}\\.claude\\plugins\\installed_plugins.json`]: JSON.stringify({ plugins: { 'hoai@hoai': [{ scope: 'user', version: '0.62.1', installPath: WROOT, lastUpdated: new Date(T0 - landedAgoMs).toISOString() }] } }),
  })
}

function freshStartListing(ageMs: number) {
  return JSON.stringify([
    { ProcessId: 777, ParentProcessId: 1, CreationDate: T0 - 120 * MIN, CommandLine: `"C:\\Program Files\\nodejs\\node.exe" ${WROOT}\\bin\\hoai-core.mjs --keep-alive` },
    { ProcessId: 5912, ParentProcessId: 777, CreationDate: T0 - ageMs, CommandLine: '"C:\\Users\\kc\\.local\\bin\\claude.exe" --resume 8c1f0000-0000-4000-8000-000000000001' },
    { ProcessId: 4912, ParentProcessId: 5912, CreationDate: T0 - ageMs + 500, CommandLine: 'bun C:\\x\\server.ts' },
  ])
}

test('win32: a session the launcher started 9 s ago is never restarted by the sweep, whatever the time rule says (the relaunch gap)', async () => {
  const alive = (pid: number) => [777, 4912, 5912].includes(pid)
  const fresh = freshStartMachine(9_000, 5_000)
  const report = await runKeepAliveSweep(windowsCtx(fresh, recorder({ win32Ps: freshStartListing(9_000) }), { pidAlive: alive }) as any)
  assert.equal(fresh.files.has(`${WSTATE}\\restart-requested.json`), false, 'a fresh start must never request another restart')
  assert.deepEqual(report.agents.map((a: any) => [a.state, a.reason]), [['waiting_idle', 'fresh_start']])
  // Control: the same session two hours old (and the install landed after it) restarts as before.
  const old = freshStartMachine(120 * MIN, 30 * MIN)
  const clock = fakeClock()
  clock.onSleep((_ms, at) => {
    if (old.files.has(`${WSTATE}\\probe-requested.json`)) old.writeFile('C:\\Users\\kc\\.bgos-plugin-state\\912\\channel-live.json', JSON.stringify({ firstLiveAt: 'x', lastLiveAt: new Date(at).toISOString() }))
  })
  await runKeepAliveSweep(windowsCtx(old, recorder({ win32Ps: freshStartListing(120 * MIN) }), { pidAlive: alive, now: clock.now, sleep: clock.sleep }) as any)
  assert.equal(old.files.get(`${WSTATE}\\restart-requested.json`), '{}')
})

test('fresh start (agent 909, 2026-10-12): a restart judged on the session before a relaunch is never written onto the session after it', async () => {
  const statePath = 'C:\\Users\\kc\\.bgos-plugin-state\\912\\agent-state.json'
  const fs = windowsMachine({
    [`${WSTATE}\\run-agent.vbs`]: "' launcher\r\n",
    [`${WSTATE}\\supervisor-generation`]: '2\n',
    [`${WSTATE}\\supervisor.json`]: JSON.stringify({ pid: 777, capabilities: ['relaunch'] }),
    // The OLD daemon's fresh state: an update is pending and the session has been quiet an hour.
    [statePath]: stateBody('912', T0, { claudePid: null }),
  })
  const clock = fakeClock()
  const alive = new Set([777, 4912, 5912])
  const rec = recorder({ win32Ps: winListing(false) })
  let relaunched = false
  const exec = async (file: string, args: readonly string[], o: any = {}) => {
    if (file === 'powershell.exe' && args.includes('-Command') && !relaunched) {
      // While the sweep's listing runs, a person's marker restarts claude: the
      // old daemon removes its state, the launcher rewrites launch.json and
      // starts a new claude, whose daemon takes the lock and publishes.
      relaunched = true
      for (const pid of [4912, 5912]) alive.delete(pid)
      for (const pid of [4913, 6912]) alive.add(pid)
      fs.rm(statePath)
      fs.writeFile(`${WSTATE}\\launch.json`, JSON.stringify(buildLaunchRecipe({ assistantId: '912', cwd: WCWD, argv: [], installMethod: 'marketplace', pluginRoot: WROOT, node: 'node', startedAt: new Date(T0 + 1_158).toISOString(), pid: 777 })))
      fs.writeFile(`${WHOME}\\.bgos-agent\\credentials-912.json.lock`, JSON.stringify({ pid: 4913, heartbeatAt: T0 + 2_000 }))
      fs.writeFile(statePath, stateBody('912', T0 + 9_400, { pid: 4913, claudePid: null, pendingRestartVersion: null, lastActivityAt: new Date(T0 + 1_500).toISOString() }))
      clock.advance(9_400)
      return {
        code: 0,
        stdout: JSON.stringify([
          { ProcessId: 4100, ParentProcessId: 1, CreationDate: T0 - 120 * MIN, CommandLine: 'C:\\Windows\\System32\\cmd.exe' },
          { ProcessId: 6912, ParentProcessId: 4100, CreationDate: T0 + 1_100, CommandLine: '"C:\\Users\\kc\\.local\\bin\\claude.exe" --resume 8c1f0000-0000-4000-8000-000000000001' },
          { ProcessId: 6001, ParentProcessId: 6912, CreationDate: T0 + 1_200, CommandLine: 'node C:\\x\\bin\\bgos-launch.mjs C:\\x\\server.ts' },
          { ProcessId: 4913, ParentProcessId: 6001, CreationDate: T0 + 1_300, CommandLine: 'bun C:\\x\\server.ts' },
        ]),
        stderr: '',
        error: null,
        timedOut: false,
      }
    }
    return rec.exec(file, args, o)
  }
  const report = await runKeepAliveSweep(windowsCtx(fs, rec, { exec, now: clock.now, sleep: clock.sleep, pidAlive: (pid: number) => alive.has(pid) }) as any)
  assert.ok(relaunched, 'the relaunch happened during the listing')
  assert.equal(fs.files.has(`${WSTATE}\\restart-requested.json`), false, 'the judgement was about the session before the relaunch; it is never written onto the new one')
  assert.equal(fs.files.has(`${WSTATE}\\probe-requested.json`), false)
  assert.deepEqual(report.agents.map((a: any) => [a.state, a.reason]), [['waiting_idle', 'fresh_start']])
})

test('a restart marker already on disk (a person\'s, or one the takeover still owes) is never rewritten and spends nothing', async () => {
  const mark = '{"reason":"marker proof","requestedBy":"mark"}' + ' '.repeat(22)
  const fs = windowsMachine({
    [`${WSTATE}\\run-agent.vbs`]: "' launcher\r\n",
    [`${WSTATE}\\supervisor-generation`]: '2\n',
    [`${WSTATE}\\supervisor.json`]: JSON.stringify({ pid: 777, capabilities: ['relaunch'] }),
    ['C:\\Users\\kc\\.bgos-plugin-state\\912\\agent-state.json']: stateBody('912', T0, { claudePid: null }),
    [`${WSTATE}\\restart-requested.json`]: mark,
  })
  // Written 20 s ago: a pending request the launcher or the takeover is about to act on.
  fs.touch(`${WSTATE}\\restart-requested.json`, T0 - 20_000)
  const report = await runKeepAliveSweep(windowsCtx(fs, recorder({ win32Ps: winListing(false) }), { pidAlive: (pid: number) => [777, 4912, 5912].includes(pid) }) as any)
  assert.equal(fs.files.get(`${WSTATE}\\restart-requested.json`), mark, 'byte for byte')
  assert.deepEqual(report.agents.map((a: any) => [a.state, a.reason]), [['waiting_idle', 'restart_already_requested']])
})

test('a marker stranded longer than anyone takes to act on it does not block the restart: the sweep rewrites it', async () => {
  const fs = windowsMachine({
    [`${WSTATE}\\run-agent.vbs`]: "' launcher\r\n",
    [`${WSTATE}\\supervisor-generation`]: '2\n',
    [`${WSTATE}\\supervisor.json`]: JSON.stringify({ pid: 777, capabilities: ['relaunch'] }),
    ['C:\\Users\\kc\\.bgos-plugin-state\\912\\agent-state.json']: stateBody('912', T0, { claudePid: null }),
    [`${WSTATE}\\restart-requested.json`]: '{"left":"by an exhausted launcher"}',
  })
  fs.touch(`${WSTATE}\\restart-requested.json`, T0 - 10 * MIN)
  const clock = fakeClock()
  clock.onSleep((_ms, at) => {
    if (fs.files.has(`${WSTATE}\\probe-requested.json`)) fs.writeFile('C:\\Users\\kc\\.bgos-plugin-state\\912\\channel-live.json', JSON.stringify({ firstLiveAt: 'x', lastLiveAt: new Date(at).toISOString() }))
  })
  const report = await runKeepAliveSweep(windowsCtx(fs, recorder({ win32Ps: winListing(false) }), { now: clock.now, sleep: clock.sleep, pidAlive: (pid: number) => [777, 4912, 5912].includes(pid) }) as any)
  assert.equal(fs.files.get(`${WSTATE}\\restart-requested.json`), '{}')
  assert.deepEqual(report.agents.map((a: any) => [a.state, a.reason]), [['restarted', 'marker']])
})

test('off the marker tier a marker on disk never blocks the restart (a canonical service restarts through the service)', async () => {
  const fs = machine([{ id: '912', cwd: AVA, service: 'canonical', state: {} }])
  fs.writeFile(`${HOME}/.bgos-agent/912/supervisor.json`, JSON.stringify({ pid: 3000, capabilities: ['relaunch'], startedAt: 'x' }))
  fs.writeFile(`${HOME}/.bgos-agent/912/restart-requested.json`, '{"left":"by an exhausted launcher"}')
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
  assert.deepEqual(rec.calls.filter((c) => c.file === 'launchctl').map((c) => c.args), KICKSTART_912)
  assert.deepEqual(report.agents.map((a: any) => [a.state, a.reason]), [['restarted', 'service']])
})
