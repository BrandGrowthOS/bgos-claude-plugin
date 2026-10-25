/**
 * The helper that carries out a restart-marker takeover (Windows): spawned
 * detached and hidden by the daemon (lib/marker-takeover.mjs), it proves from
 * the process table that the hoai launcher named in supervisor.json holds this
 * daemon's claude, plans how the agent comes back BEFORE it changes anything,
 * claims the marker, records the takeover, ends claude, and then either lets
 * a --keep-alive launcher relaunch the pinned session by itself or, once an
 * old interactive launcher has exited, starts the agent through the unchanged
 * restart ladder (lib/agent-restart.mjs restartAgent: the "HOAI Agent <id>"
 * task, else the hidden recipe launch). It never writes a restart marker and
 * never starts anything while a launcher or a daemon of the agent is live.
 *
 * Driven here over a fake Windows process world (pids, parents, creation
 * times, command lines) and a fake clock.
 *
 * Run: npx tsx --test test/restart-handoff.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { supervisorFileBody } from '../bin/hoai-core.mjs'
import { restartAgent } from '../lib/agent-restart.mjs'
import { fakeAgentTasks } from './helpers/fake-agent-tasks.ts'

const MISSING =
  'lib/restart-handoff.mjs is missing: nothing carries out a restart the hoai launcher refused (bin/hoai-core.mjs:2295-2299), ' +
  'so the agent is never restarted'
const mod: any = await import('../lib/restart-handoff.mjs').catch(() => null)
const h = () => {
  assert.ok(mod, MISSING)
  return mod
}

const T0 = 1_800_000_000_000
const HOME = 'C:\\Users\\kc'
const STATE = `${HOME}\\.bgos-agent\\909`
const MARKER = `${STATE}\\restart-requested.json`
const CLAIMED = `${STATE}\\restart-requested.claimed.json`
const REFUSED = `${STATE}\\restart-requested.refused.json`
const SUPERVISOR = `${STATE}\\supervisor.json`
const LEDGER = `${STATE}\\restart-takeovers.json`
const LOCK = `${STATE}\\restart-handoff.lock`
const TASK_VBS = `${STATE}\\run-agent.vbs`
const PIN_FILE = `${STATE}\\session-id`
const PLUGIN_STATE = `${HOME}\\.bgos-plugin-state\\909`
const AGENT_STATE = `${PLUGIN_STATE}\\agent-state.json`
const CREDS = `${HOME}\\.bgos-agent\\credentials-909.json`
const CWD = 'C:\\agents\\vera'
const ROOT = 'C:\\plugins\\bgos-claude-plugin'
const NODE = 'C:\\Program Files\\nodejs\\node.exe'
const PIN = '0f0e0d0c-1111-4222-8333-444455556666'
// The agent task as lib/agent-inventory.mjs names it (board row d6198bb6): this HOME's name, the old
// one carried for the read-back. 66ede649 = watcherHomeId('C:\\Users\\kc', 'win32') (hashed as c:\users\kc).
const TASK_NAME = 'HOAI Agent 909 home-66ede649'
const LEGACY_TASK_NAME = 'HOAI Agent 909'
const MARKER_TEXT = '{"reason":"proof","requestedBy":"mark"}'

const LAUNCHER = 48480
const CLAUDE = 68444
const DAEMON = 70001
const HELPER = 90001

type Proc = { pid: number; ppid: number; startedAtMs: number; command: string }

/** One agent, its launcher, claude and daemon, on a Windows machine. */
function world(opts: { keepAlive?: boolean; task?: boolean; recipe?: boolean; wrapper?: boolean; launcherCommand?: string; abrupt?: boolean; launcherLingers?: boolean; exitsInBackoff?: boolean } = {}) {
  const clock = { now: T0 }
  const files = new Map<string, { text: string; mtimeMs: number }>()
  const put = (p: string, text: string, mtimeMs = clock.now) => files.set(p, { text, mtimeMs })
  const launcherCommand = opts.launcherCommand ?? `"${NODE}" C:\\checkouts\\0.66.1\\bin\\hoai-core.mjs${opts.keepAlive ? ' --keep-alive' : ''}`
  const procs: Proc[] = [
    { pid: 4000, ppid: 1, startedAtMs: T0 - 9_000_000, command: 'C:\\Windows\\explorer.exe' },
    { pid: LAUNCHER, ppid: 4000, startedAtMs: T0 - 3_600_000, command: launcherCommand },
  ]
  let claudeParent = LAUNCHER
  if (opts.wrapper) {
    procs.push({ pid: 50000, ppid: LAUNCHER, startedAtMs: T0 - 600_000, command: 'C:\\Windows\\system32\\cmd.exe /c claude.cmd --resume ' + PIN })
    claudeParent = 50000
  }
  procs.push({ pid: CLAUDE, ppid: claudeParent, startedAtMs: T0 - 600_000, command: `claude --dangerously-skip-permissions --dangerously-load-development-channels server:bgos --resume ${PIN}` })
  procs.push({ pid: DAEMON, ppid: CLAUDE, startedAtMs: T0 - 599_000, command: `bun ${ROOT}\\server.ts` })
  const supRaw = (startedAt = T0 - 3_600_000) => JSON.stringify({ pid: LAUNCHER, capabilities: ['relaunch'], startedAt: new Date(startedAt).toISOString() })
  put(SUPERVISOR, supRaw())
  put(PIN_FILE, `${PIN}\n`)
  put(MARKER, MARKER_TEXT, T0 - 20_000)
  put(`${CREDS}.lock`, JSON.stringify({ pid: DAEMON, heartbeatAt: T0 - 1000 }))
  put(AGENT_STATE, JSON.stringify({ schemaVersion: 1, assistantId: '909', pid: DAEMON, updatedAt: new Date(T0 - 500).toISOString() }))
  // The plugin manifest's injected env (the real .claude-plugin/plugin.json shape): the helper drops these keys.
  put(`${ROOT}\\.claude-plugin\\plugin.json`, JSON.stringify({ mcpServers: { bgos: { command: 'bun', env: { BGOS_BACKEND_URL: 'x', BGOS_API_KEY: '${user_config.api_key}', BGOS_USER_ID: 'x', BGOS_ASSISTANT_ID: 'x', BGOS_AUTO_APPROVE: 'x' } } } }))
  if (opts.task) put(TASK_VBS, `Set shell = CreateObject("WScript.Shell")\r\nshell.CurrentDirectory = "${CWD}"\r\n`)

  const kills: Array<[number, string]> = []
  const restarts: Array<{ row: any; deps: any }> = []
  const logs: string[] = []
  const events: string[] = []
  // What the launcher does when its claude is ended from outside.
  const onClaudeEnded = () => {
    remove(DAEMON)
    // A daemon killed with claude's job never runs its graceful release: its lock and state stay on disk.
    if (!opts.abrupt) {
      files.delete(`${CREDS}.lock`)
      files.delete(AGENT_STATE)
    }
    if (opts.keepAlive) {
      // As bin/hoai-core.mjs does: the moment claude has exited, the claim names the relaunch deadline of
      // the backoff (decideKeepAliveBackoff); after it, supervisor.json is re-stamped and claude relaunched
      // with --resume <pin>.
      later(100, () => put(SUPERVISOR, supervisorFileBody(LAUNCHER, new Date(clock.now).toISOString(), null, { relaunchBy: new Date(clock.now + 5_000).toISOString() })))
      if (opts.exitsInBackoff) {
        // ...but it is gone before that relaunch (a stop, a crash, a kill): no new claude, ever.
        later(2_000, () => remove(LAUNCHER))
      } else {
        later(5_000, () => {
          put(SUPERVISOR, supRaw(clock.now))
          procs.push({ pid: 70500, ppid: LAUNCHER, startedAtMs: clock.now, command: `claude --resume ${PIN}` })
        })
      }
    } else {
      later(300, () => {
        files.delete(SUPERVISOR)
        if (!opts.launcherLingers) remove(LAUNCHER)
      })
    }
  }
  const timers: Array<{ at: number; fn: () => void }> = []
  const later = (ms: number, fn: () => void) => timers.push({ at: clock.now + ms, fn })
  const remove = (pid: number) => {
    const i = procs.findIndex((p) => p.pid === pid)
    if (i >= 0) procs.splice(i, 1)
  }
  const alive = (pid: number) => procs.some((p) => p.pid === pid) || pid === HELPER
  const flags = { noReturn: false }
  // What the hidden launch (or the task) does: a NEW hoai-core arms, starts claude, whose daemon takes the lock.
  const bringBack = () =>
    later(2_000, () => {
      procs.push({ pid: 61001, ppid: 4000, startedAtMs: clock.now, command: `"${NODE}" ${ROOT}\\bin\\hoai-core.mjs` })
      put(SUPERVISOR, JSON.stringify({ pid: 61001, capabilities: ['relaunch'], startedAt: new Date(clock.now + 1).toISOString() }))
      procs.push({ pid: 61002, ppid: 61001, startedAtMs: clock.now + 10, command: `claude --resume ${PIN}` })
      procs.push({ pid: 61003, ppid: 61002, startedAtMs: clock.now + 20, command: `bun ${ROOT}\\server.ts` })
      put(`${CREDS}.lock`, JSON.stringify({ pid: 61003, heartbeatAt: clock.now + 30 }))
    })
  const row = (live: boolean) => ({
    assistantId: '909',
    cwd: CWD,
    recipe: opts.recipe === false ? null : { cwd: CWD, node: NODE, pluginRoot: 'C:\\checkouts\\0.66.1', argv: [] },
    supervisor: opts.task ? 'service' : live ? 'launcher-live' : 'none',
    service: opts.task ? { kind: 'schtasks', handle: TASK_NAME, legacyHandle: LEGACY_TASK_NAME, via: 'canonical-file', file: TASK_VBS } : null,
    keepalive: null,
    launcherLive: live,
    stateDir: STATE,
    pluginStateDir: 'C:\\wrong\\from\\inventory',
    credentialsPath: 'C:\\wrong\\creds.json',
    notes: [],
  })
  const fs = {
    readFile: (p: string) => files.get(p)?.text ?? null,
    stat: (p: string) => (files.has(p) ? { mtimeMs: files.get(p)!.mtimeMs } : null),
    rename: (a: string, b: string) => {
      const f = files.get(a)
      if (!f) return 'gone'
      files.delete(a)
      files.set(b, f)
      events.push(`rename ${a.split('\\').pop()} -> ${b.split('\\').pop()}`)
      return 'ok'
    },
    writeAtomic: (p: string, text: string) => {
      put(p, text)
      events.push(`write ${p.split('\\').pop()}`)
      return true
    },
    openExclusive: (p: string, text: string) => {
      if (files.has(p)) return 'exists'
      put(p, text)
      return 'ok'
    },
    unlink: (p: string) => files.delete(p),
  }
  const deps: Record<string, any> = {
    ownPid: HELPER,
    now: () => clock.now,
    sleep: async (ms: number) => {
      clock.now += ms
      for (const t of [...timers]) {
        if (t.at <= clock.now) {
          timers.splice(timers.indexOf(t), 1)
          t.fn()
        }
      }
    },
    log: (line: string) => logs.push(line),
    pidAlive: alive,
    kill: (pid: number, signal: string) => {
      kills.push([pid, signal])
      events.push(`kill ${pid}`)
      remove(pid)
      if (pid === CLAUDE) onClaudeEnded()
      return true
    },
    fs,
    env: { PATH: 'C:\\Windows', CLAUDECODE: '1', BGOS_API_KEY: 'secret', USERPROFILE: HOME },
    listProcesses: async () => ({ ok: true, processes: procs.map((p) => ({ ...p, uid: null })) }),
    listAgents: () => [row(Boolean(files.get(SUPERVISOR)) && alive(LAUNCHER))],
    readLauncherProcesses: (pids: number[]) => new Map(procs.filter((p) => pids.includes(p.pid)).map((p) => [p.pid, { command: p.command, startedAtMs: p.startedAtMs }])),
    restartAgent: async (r: any, d: any) => {
      restarts.push({ row: r, deps: d })
      events.push('restartAgent')
      if (!flags.noReturn) bringBack()
      return { ok: true, how: r.service?.kind === 'schtasks' ? 'task' : 'recipe-hidden', message: 'started' }
    },
    // mkdir: the task tier writes its task script into the state dir before it reads the task back (directories are implicit here).
    restartDeps: { exec: async () => ({ code: 0, stdout: '', stderr: '' }), spawnDetached: () => ({ pid: 1 }), fs: { writeFile: (p: string, t: string) => put(p, t), readFile: (p: string) => files.get(p)?.text ?? null, exists: (p: string) => files.has(p), mkdir: () => {} } },
  }
  const params = {
    assistantId: '909', kind: 'stranded', markerMtimeMs: T0 - 20_000, bootAtMs: T0 - 599_000, daemonPid: DAEMON, claudePid: CLAUDE,
    launcherPid: LAUNCHER, stateDir: STATE, home: HOME, launchCwd: CWD, logPath: `${HOME}\\.bgos-agent\\logs\\bgos-plugin-909.log`,
    pluginStateDir: PLUGIN_STATE, credentialsPath: CREDS, pluginRoot: ROOT,
  }
  return { clock, files, put, procs, kills, restarts, logs, events, deps, params, later, remove, supRaw, flags }
}

const run = (w: ReturnType<typeof world>, over: Record<string, any> = {}) => h().runRestartHandoff({ ...w.params, ...over }, w.deps)

test('interactive launcher: claim, ledger, identity check, end claude, wait for the launcher to exit, settle, then ONE restart through the ladder', async () => {
  const w = world()
  const out = await run(w)
  assert.equal(out.outcome, 'restarted', w.logs.join('\n'))
  assert.deepEqual(w.events.filter((e) => e !== 'write restart-handoff.lock').slice(0, 4), ['rename restart-requested.json -> restart-requested.claimed.json', 'write restart-takeovers.json', `kill ${CLAUDE}`, 'restartAgent'])
  assert.equal(w.files.get(CLAIMED)?.text, MARKER_TEXT, 'the claimed marker keeps the writer\'s bytes')
  assert.deepEqual(w.kills, [[CLAUDE, 'SIGTERM']])
  assert.equal(w.restarts.length, 1)
  const ledger = JSON.parse(w.files.get(LEDGER)!.text)
  assert.equal(ledger.takeovers.length, 1)
  assert.equal(ledger.takeovers[0].markerMtimeMs, T0 - 20_000)
  assert.equal(ledger.takeovers[0].route, 'recipe-hidden')
  assert.equal(ledger.takeovers[0].pin, PIN)
  assert.equal(w.restarts[0].row.supervisor, 'none', 'the hidden recipe row')
  assert.equal(w.restarts[0].row.pluginStateDir, PLUGIN_STATE, 'the daemon\'s exact paths, not the inventory\'s guess')
  assert.equal(w.restarts[0].deps.pluginRoot, ROOT)
  assert.equal(w.restarts[0].deps.platform, 'win32')
  assert.equal(w.restarts[0].deps.env.CLAUDECODE, undefined, 'a nested-session marker never reaches the relaunched claude')
  assert.equal(w.restarts[0].deps.env.BGOS_API_KEY, undefined)
  assert.equal(w.restarts[0].deps.env.PATH, 'C:\\Windows')
  assert.equal(w.files.has(LOCK), false, 'the lock is released')
  assert.ok(w.logs.some((l) => l.includes(`ending claude ${CLAUDE}`)), w.logs.join('\n'))
})

test('the REAL ladder: the hidden recipe launch runs the current root\'s hoai-core for agent 909 with a scrubbed env, and passes no session id', async () => {
  const w = world()
  const spawned: Array<{ file: string; args: string[]; opts: any }> = []
  w.deps.restartAgent = (row: any, d: any) => restartAgent(row, d)
  w.deps.restartDeps.spawnDetached = (file: string, args: string[], opts: any) => {
    spawned.push({ file, args, opts })
    return { pid: 4242 }
  }
  await run(w)
  assert.equal(spawned.length, 1, w.logs.join('\n'))
  assert.equal(spawned[0].file, 'wscript.exe')
  const vbs = w.files.get(`${STATE}\\launch-hidden.vbs`)!.text
  assert.match(vbs, /env\("HOAI_SUPERVISED_ASSISTANT_ID"\) = "909"/)
  assert.ok(vbs.includes(`${ROOT}\\bin\\hoai-core.mjs`), vbs)
  assert.ok(!/--resume|--session-id|--continue/.test(vbs + spawned[0].args.join(' ')))
  assert.equal(spawned[0].opts.env.CLAUDECODE, undefined)
  assert.equal(spawned[0].opts.env.BGOS_API_KEY, undefined)
})

test('the REAL ladder, task route: schtasks /Run /TN "HOAI Agent 909" when the task is registered in the same folder', async () => {
  // The ladder reads the task back first (lib/agent-task-win32.mjs runAgentTask, the task script's
  // probe), on a faked Task Scheduler that answers from the script it writes: this HOME's task under
  // its own name (as the current install registers it), and an agent not renamed yet whose task is
  // still the old "HOAI Agent 909" this HOME registered (0.69.2: no description, its launcher in this
  // HOME's state dir).
  const probe = (action: string) => ['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', `${STATE}\\install-agent-task.ps1`, '-Action', action]
  const cases: Array<[string, string, string, string[][]]> = [
    ['this HOME\'s task', TASK_NAME, `HOAI agent 909, installed from home=${HOME}`, [probe('probe'), ['schtasks.exe', '/Run', '/TN', TASK_NAME]]],
    ['not renamed yet', LEGACY_TASK_NAME, '', [probe('probe'), probe('probe-legacy'), ['schtasks.exe', '/Run', '/TN', LEGACY_TASK_NAME]]],
  ]
  for (const [name, taskName, description, expected] of cases) {
    const w = world({ task: true })
    const tasks = fakeAgentTasks({ fs: { readFile: (p: string) => w.files.get(p)?.text ?? null } as any })
    tasks.seed.task(taskName, TASK_VBS, { description })
    const execs: string[][] = []
    w.deps.restartAgent = (row: any, d: any) => restartAgent(row, d)
    w.deps.restartDeps.exec = async (file: string, args: string[]) => {
      execs.push([file, ...args])
      return tasks.exec(file, args)
    }
    const out = await run(w)
    assert.deepEqual(execs, expected, `${name}: ${w.logs.join('\n')}`)
    assert.notEqual(out.outcome, 'launcher_live_again', name)
  }
})

test('keep-alive launcher: it relaunches the pinned session by itself; the helper starts nothing', async () => {
  const w = world({ keepAlive: true })
  const out = await run(w)
  assert.equal(out.outcome, 'relaunched_by_launcher', w.logs.join('\n'))
  assert.deepEqual(w.kills, [[CLAUDE, 'SIGTERM']])
  assert.equal(w.restarts.length, 0)
})

test('keep-alive launcher that names its relaunch deadline and then exits in its backoff: no relaunch, so the fallback brings the agent back', async () => {
  const w = world({ keepAlive: true, exitsInBackoff: true })
  const out = await run(w)
  assert.equal(out.outcome, 'restarted', w.logs.join('\n'))
  assert.deepEqual(w.kills, [[CLAUDE, 'SIGTERM']])
  assert.equal(w.restarts.length, 1, 'exactly one restart, through the planned fallback')
  assert.equal(w.restarts[0].row.supervisor, 'none', 'the hidden recipe row')
  assert.ok(w.procs.some((p) => p.command === `claude --resume ${PIN}`), 'the agent is back on its pinned session')
})

test('a live helper already holds restart-handoff.lock: nothing is killed', async () => {
  const w = world()
  w.put(LOCK, JSON.stringify({ pid: 88888, at: new Date(T0 - 1000).toISOString() }))
  w.procs.push({ pid: 88888, ppid: 4000, startedAtMs: T0 - 2000, command: 'node hoai-restart-handoff.mjs' })
  const out = await run(w)
  assert.equal(out.outcome, 'another_handoff_running')
  assert.deepEqual(w.kills, [])
  assert.ok(w.files.has(MARKER))
})

test('an orphaned claude (its claude.cmd wrapper gone, the launcher already runs another one) is not ours to end', async () => {
  const w = world({ wrapper: true })
  w.remove(50000) // the launcher killed cmd.exe; claude survived under a dead parent pid
  const out = await run(w)
  assert.equal(out.outcome, 'not_our_launcher', w.logs.join('\n'))
  assert.deepEqual(w.kills, [])
  assert.ok(w.files.has(MARKER), 'the marker is left on disk')
  assert.equal(w.files.has(LEDGER), false, 'no budget spent')
})

test('a launcher reached through a live cmd.exe wrapper is ours', async () => {
  const w = world({ wrapper: true })
  const out = await run(w)
  assert.equal(out.outcome, 'restarted', w.logs.join('\n'))
})

test('the launcher in supervisor.json must run hoai-core.mjs and be the writer of supervisor.json', async () => {
  const notHoai = world({ launcherCommand: `"${NODE}" C:\\tools\\other.mjs` })
  assert.equal((await run(notHoai)).outcome, 'not_our_launcher')
  assert.deepEqual(notHoai.kills, [])
  const reused = world()
  // supervisor.json was stamped BEFORE this process started: the pid was taken over by a later launcher.
  reused.put(SUPERVISOR, JSON.stringify({ pid: LAUNCHER, capabilities: ['relaunch'], startedAt: new Date(T0 - 7_200_000).toISOString() }))
  assert.equal((await run(reused)).outcome, 'not_our_launcher')
  assert.deepEqual(reused.kills, [])
})

test('another claude of this agent (its pin on the command line) is running: nothing is ended', async () => {
  const w = world()
  w.procs.push({ pid: 77777, ppid: 4000, startedAtMs: T0 - 100, command: `claude --resume ${PIN}` })
  const out = await run(w)
  assert.equal(out.outcome, 'another_session_running')
  assert.deepEqual(w.kills, [])
})

test('no way back (no task, no usable recipe): claude is left running and the marker untouched', async () => {
  const w = world({ recipe: false })
  const out = await run(w)
  assert.equal(out.outcome, 'no_way_back', w.logs.join('\n'))
  assert.deepEqual(w.kills, [])
  assert.ok(w.files.has(MARKER))
  assert.equal(w.files.has(LEDGER), false)
})

test('a task registered for a differently spelled folder falls back to the recipe; neither matching refuses', async () => {
  const w = world({ task: true })
  w.put(TASK_VBS, 'shell.CurrentDirectory = "C:\\hoai-agents\\vera"\r\n')
  assert.equal((await run(w)).outcome, 'restarted')
  assert.equal(w.restarts[0].row.supervisor, 'none', 'recipe-hidden, not the task')
  const none = world({ task: true, recipe: false })
  none.put(TASK_VBS, 'shell.CurrentDirectory = "C:\\hoai-agents\\vera"\r\n')
  assert.equal((await run(none)).outcome, 'no_way_back')
  assert.deepEqual(none.kills, [])
})

test('claude replaced between the listing and the kill (another creation time) or the daemon gone: nothing is killed', async () => {
  const w = world()
  w.deps.readLauncherProcesses = (pids: number[]) => new Map(pids.map((pid) => [pid, { command: 'claude', startedAtMs: T0 }]))
  assert.equal((await run(w)).outcome, 'session_changed')
  assert.deepEqual(w.kills, [])
  const gone = world()
  gone.deps.readLauncherProcesses = (pids: number[]) => new Map(pids.filter((p) => p !== DAEMON).map((pid) => [pid, { command: 'claude', startedAtMs: T0 - 600_000 }]))
  assert.equal((await run(gone)).outcome, 'session_changed')
  assert.deepEqual(gone.kills, [])
})

test('the daemon no longer holds the pairing lock at the kill: nothing is killed', async () => {
  const w = world()
  w.put(`${CREDS}.lock`, JSON.stringify({ pid: 12345, heartbeatAt: T0 }))
  assert.equal((await run(w)).outcome, 'daemon_lost_pairing_lock')
  assert.deepEqual(w.kills, [])
})

test('claude still alive 30 s after the kill: nothing is started', async () => {
  const w = world()
  w.deps.kill = (pid: number, signal: string) => {
    w.kills.push([pid, signal])
    return true
  }
  const out = await run(w)
  assert.equal(out.outcome, 'session_did_not_end')
  assert.equal(w.restarts.length, 0)
})

test('the launcher still holds the agent after 5 minutes (a frozen console): nothing is started', async () => {
  const w = world()
  const kill = w.deps.kill
  w.deps.kill = (pid: number, signal: string) => {
    w.kills.push([pid, signal])
    w.remove(pid)
    w.remove(DAEMON)
    return true
  }
  void kill
  const out = await run(w)
  assert.equal(out.outcome, 'launcher_held', w.logs.join('\n'))
  assert.equal(w.restarts.length, 0)
})

test('someone else starts the agent during the settle (a fleet script, the watcher, a person): nothing is started', async () => {
  const w = world()
  w.later(5_000, () => {
    w.procs.push({ pid: 61000, ppid: 4000, startedAtMs: w.clock.now, command: `"${NODE}" C:\\checkouts\\0.66.1\\bin\\hoai-core.mjs` })
    w.put(SUPERVISOR, JSON.stringify({ pid: 61000, capabilities: ['relaunch'], startedAt: new Date(w.clock.now + 1).toISOString() }))
  })
  const out = await run(w)
  assert.equal(out.outcome, 'already_running', w.logs.join('\n'))
  assert.equal(w.restarts.length, 0)
})

test('a launcher live again at the restart (a task is registered, so the row says service): no restart, never a marker', async () => {
  const w = world({ task: true })
  let calls = 0
  w.deps.listAgents = () => {
    calls += 1
    const live = calls > 1
    return [{ assistantId: '909', cwd: CWD, recipe: { cwd: CWD, node: NODE }, supervisor: 'service', service: { kind: 'schtasks', handle: 'HOAI Agent 909', via: 'canonical-file', file: TASK_VBS }, keepalive: null, launcherLive: live, stateDir: STATE, pluginStateDir: PLUGIN_STATE, credentialsPath: CREDS, notes: [] }]
  }
  const out = await run(w)
  assert.equal(out.outcome, 'launcher_live_again', w.logs.join('\n'))
  assert.equal(w.restarts.length, 0)
  assert.equal(w.files.has(MARKER), false)
})

test('the ladder the helper hands restartAgent can never write a restart marker', async () => {
  const w = world()
  await run(w)
  const fs = w.restarts[0].deps.fs
  assert.throws(() => fs.writeFile(MARKER, '{}'), /never writes a restart marker/)
  fs.writeFile(`${STATE}\\launch-hidden.vbs`, 'x')
  assert.equal(w.files.get(`${STATE}\\launch-hidden.vbs`)?.text, 'x')
})

test('the task started but nothing came back in 90 s, and nothing is live: exactly one fallback through the hidden recipe', async () => {
  const w = world({ task: true })
  w.flags.noReturn = true
  const out = await run(w)
  assert.equal(out.outcome, 'not_back', w.logs.join('\n'))
  assert.equal(w.restarts.length, 2)
  assert.equal(w.restarts[0].row.service.kind, 'schtasks')
  assert.equal(w.restarts[1].row.supervisor, 'none')
})

test('the loop guard is checked again under the lock: 3 takeovers this hour refuse, set the marker aside, end nothing', async () => {
  const w = world()
  w.put(LEDGER, JSON.stringify({ schemaVersion: 1, takeovers: [1, 2, 3].map((i) => ({ at: new Date(T0 - i * 60_000).toISOString(), kind: 'stranded', markerMtimeMs: i })) }))
  const out = await run(w)
  assert.equal(out.outcome, 'cap')
  assert.deepEqual(w.kills, [])
  assert.equal(w.files.has(MARKER), false)
  assert.equal(w.files.get(REFUSED)?.text, MARKER_TEXT)
})

test('the same marker twice (already in the ledger) is refused; a stale marker (written before the daemon) is never claimed', async () => {
  const twice = world()
  twice.put(LEDGER, JSON.stringify({ schemaVersion: 1, takeovers: [{ at: new Date(T0 - 60_000).toISOString(), kind: 'stranded', markerMtimeMs: T0 - 20_000 }] }))
  assert.equal((await run(twice)).outcome, 'already_taken_over')
  assert.deepEqual(twice.kills, [])
  const stale = world()
  const out = await run(stale, { bootAtMs: T0 - 10_000 })
  assert.equal(out.outcome, 'claimed_by_other')
  assert.ok(stale.files.has(MARKER), 'a stale marker is left exactly where it was')
  assert.deepEqual(stale.kills, [])
})

test('swallowed: there is nothing to claim, the takeover still runs and is recorded by the marker mtime', async () => {
  const w = world()
  w.files.delete(MARKER)
  const out = await run(w, { kind: 'swallowed' })
  assert.equal(out.outcome, 'restarted', w.logs.join('\n'))
  assert.equal(JSON.parse(w.files.get(LEDGER)!.text).takeovers[0].kind, 'swallowed')
})

test('sessionChain, planHandoffRoute and decideLauncherStep are exported for review', () => {
  const { sessionChain, planHandoffRoute, decideLauncherStep, sameFolder, taskFolderIs } = h()
  assert.equal(typeof sessionChain, 'function')
  assert.equal(typeof planHandoffRoute, 'function')
  assert.equal(typeof decideLauncherStep, 'function')
  // The same live launcher's stamp for its backoff (relaunchBy) is no relaunch yet; its plain re-stamp is.
  const step = (rawNow: string) => decideLauncherStep({ launcherPid: LAUNCHER, rawAtKill: '{}', rawNow, launcherAlive: true, otherAlive: false, waitedMs: 1_000, maxMs: 300_000 })
  const at = new Date(T0).toISOString()
  assert.equal(step(supervisorFileBody(LAUNCHER, at, null, { relaunchBy: new Date(T0 + 5_000).toISOString() })), 'wait')
  assert.equal(step(supervisorFileBody(LAUNCHER, at, null)), 'relaunched')
  assert.equal(sameFolder('C:\\Agents\\Vera\\', 'c:/agents/vera'), true)
  assert.equal(sameFolder('C:\\agents\\vera', 'C:\\hoai-agents\\vera'), false)
  assert.equal(taskFolderIs(`x\r\nshell.CurrentDirectory = "${CWD}"\r\n`, 'c:\\agents\\vera\\'), true)
  assert.equal(taskFolderIs('shell.CurrentDirectory = "C:\\other"', CWD), false)
})

test('the old daemon\'s pid reused during the settle (an abrupt end left its lock and state on disk) does not stop the restart', async () => {
  const w = world({ abrupt: true })
  w.later(2_000, () => w.procs.push({ pid: DAEMON, ppid: 4000, startedAtMs: w.clock.now, command: 'C:\\Windows\\System32\\svchost.exe -k netsvcs' }))
  const out = await run(w)
  assert.equal(out.outcome, 'restarted', w.logs.join('\n'))
  assert.equal(w.restarts[0].deps.pidAlive(DAEMON), false, 'the ladder is told the ended daemon is dead, whatever reuses its pid')
})

test('a launcher still running after its supervisor.json vanished is not released: nothing starts beside it', async () => {
  const w = world({ launcherLingers: true })
  const out = await run(w)
  assert.equal(out.outcome, 'launcher_held', w.logs.join('\n'))
  assert.equal(w.restarts.length, 0)
})

test('a refusal at the last check before the kill spends no ledger slot and leaves the stranded marker where it was', async () => {
  const w = world()
  w.put(`${CREDS}.lock`, JSON.stringify({ pid: 12345, heartbeatAt: T0 }))
  assert.equal((await run(w)).outcome, 'daemon_lost_pairing_lock')
  assert.equal(w.files.has(LEDGER), false)
  assert.equal(w.files.get(MARKER)?.text, MARKER_TEXT)
})

test('a claude carrying the pin that appears during the settle (started by hand) means nothing is started', async () => {
  const w = world()
  w.later(5_000, () => w.procs.push({ pid: 77001, ppid: 4000, startedAtMs: w.clock.now, command: `claude --resume ${PIN}` }))
  const out = await run(w)
  assert.equal(out.outcome, 'already_running', w.logs.join('\n'))
  assert.equal(w.restarts.length, 0)
})

test('two helpers racing for a stale lock: the one whose pid is not in the lock after taking it stands down', async () => {
  const w = world()
  const open = w.deps.fs.openExclusive
  w.deps.fs.openExclusive = (p: string, text: string) => {
    const r = open(p, text)
    // Another helper replaced the lock right after us.
    if (p === LOCK && r === 'ok') w.put(LOCK, JSON.stringify({ pid: 88888, at: new Date(T0).toISOString() }))
    return r
  }
  w.procs.push({ pid: 88888, ppid: 4000, startedAtMs: T0 - 2000, command: 'node hoai-restart-handoff.mjs' })
  const out = await run(w)
  assert.equal(out.outcome, 'another_handoff_running')
  assert.deepEqual(w.kills, [])
})
