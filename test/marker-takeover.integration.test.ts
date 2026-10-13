/**
 * End to end, deterministic: the REAL launcher loop (bin/hoai-core.mjs
 * superviseClaude, byte identical to v0.66.1, the same budget logic as
 * v0.44.0) spends its 3-per-hour marker budget, and then the REAL daemon side
 * (lib/marker-takeover.mjs), the REAL helper (lib/restart-handoff.mjs), the
 * REAL inventory (lib/agent-inventory.mjs listAgents) and the REAL restart
 * ladder (lib/agent-restart.mjs restartAgent) bring the agent back on its
 * pinned session. One shared fake disk and clock; claude is a fake child; the
 * process table is the one a Windows CIM listing would show.
 *
 * At main this is red for the true reason: the launcher deletes marker 4 and
 * ignores it (bin/hoai-core.mjs:2295-2299), claude keeps its pid, and nothing
 * else reads the marker, so the agent is never restarted.
 *
 * Run: npx tsx --test test/marker-takeover.integration.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { MAX_RELAUNCHES_PER_WINDOW, sessionTranscriptPath, superviseClaude } from '../bin/hoai-core.mjs'
import { listAgents } from '../lib/agent-inventory.mjs'
import { restartAgent } from '../lib/agent-restart.mjs'

const takeover: any = await import('../lib/marker-takeover.mjs').catch(() => null)
const handoff: any = await import('../lib/restart-handoff.mjs').catch(() => null)

const T0 = 1_800_000_000_000
const HOME = 'C:\\Users\\kc'
const CWD = 'C:\\agents\\vera'
const STATE = `${HOME}\\.bgos-agent\\909`
const MARKER = `${STATE}\\restart-requested.json`
const SUPERVISOR = `${STATE}\\supervisor.json`
const CREDS = `${HOME}\\.bgos-agent\\credentials-909.json`
const PLUGIN_STATE = `${HOME}\\.bgos-plugin-state\\909`
const ROOT = 'C:\\plugins\\bgos-claude-plugin'
const PIN = '0f0e0d0c-1111-4222-8333-444455556666'
const BASE = ['--dangerously-skip-permissions', '--dangerously-load-development-channels', 'server:bgos']
const LAUNCHER = process.pid

class FakeClaude extends EventEmitter {
  args: string[]
  constructor(args: readonly string[]) {
    super()
    this.args = [...args]
  }
  kill() {
    setTimeout(() => this.emit('exit', null, 'SIGTERM'), 1)
    return true
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 2))
async function until(check: () => boolean, what: string, ms = 3000) {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`)
    await tick()
  }
}

function harness({ keepAlive = false } = {}) {
  const clock = { now: T0 }
  const files = new Map<string, { text: string; mtimeMs: number }>()
  const dirs = new Set([CWD, `${HOME}\\.bgos-agent`, STATE])
  const put = (p: string, text: string, mtimeMs = clock.now) => files.set(p, { text, mtimeMs })
  put(`${CWD}\\.bgos-agent-id`, '909\n')
  put(`${CWD}\\.mcp.json`, JSON.stringify({ mcpServers: { bgos: { command: 'bun', args: [`${ROOT}\\server.ts`], env: { BGOS_ASSISTANT_ID: '909' } } } }))
  put(`${STATE}\\session-id`, `${PIN}\n`)
  put(sessionTranscriptPath(HOME, CWD, PIN), '{"type":"summary"}\n')
  put(`${ROOT}\\.claude-plugin\\plugin.json`, JSON.stringify({ mcpServers: { bgos: { env: { BGOS_API_KEY: 'x' } } } }))

  // The process table, as a Windows CIM listing reports it.
  type Gen = { claude: number; daemon: number; child: FakeClaude; startedAtMs: number; dead: boolean; controller: any }
  const gens: Gen[] = []
  let launchers = 0
  const procTable = () => {
    const rows: Array<{ pid: number; ppid: number; startedAtMs: number; command: string; uid: null }> = []
    if (launchers > 0) rows.push({ pid: LAUNCHER, ppid: 1, startedAtMs: T0 - 3_600_000, command: `"C:\\Program Files\\nodejs\\node.exe" C:\\checkouts\\0.66.1\\bin\\hoai-core.mjs${keepAlive ? ' --keep-alive' : ''}`, uid: null })
    for (const g of gens) {
      if (g.dead) continue
      rows.push({ pid: g.claude, ppid: LAUNCHER, startedAtMs: g.startedAtMs, command: `claude ${g.child.args.join(' ')}`, uid: null })
      rows.push({ pid: g.daemon, ppid: g.claude, startedAtMs: g.startedAtMs + 500, command: `bun ${ROOT}\\server.ts`, uid: null })
    }
    return rows
  }
  const pidAlive = (pid: number) => procTable().some((p) => p.pid === pid) || pid === 99_999
  const live = () => gens.filter((g) => !g.dead)
  const current = () => live().at(-1) ?? null

  const logs: string[] = []
  const prints: string[] = []
  const helperRuns: Array<Promise<any>> = []
  const recorded: Array<{ file: string; args: string[] }> = []
  const launcherRuns: Array<Promise<number>> = []

  const takeoverFs = {
    stat: (p: string) => (files.has(p) ? { mtimeMs: files.get(p)!.mtimeMs } : null),
    readFile: (p: string) => files.get(p)?.text ?? null,
    rename: (a: string, b: string) => {
      const f = files.get(a)
      if (!f) return 'gone'
      files.delete(a)
      files.set(b, f)
      return 'ok'
    },
  }
  const helperDeps = () => ({
    ownPid: 99_999,
    now: () => clock.now,
    sleep: async (ms: number) => {
      clock.now += ms
      await tick()
    },
    log: (line: string) => logs.push(`helper: ${line}`),
    pidAlive,
    kill: (pid: number) => {
      const g = gens.find((x) => x.claude === pid && !x.dead)
      if (!g) throw Object.assign(new Error('no such process'), { code: 'ESRCH' })
      // TerminateProcess: exit code 1, no signal; the daemon dies with claude and drops its lock.
      g.dead = true
      files.delete(`${CREDS}.lock`)
      g.child.emit('exit', 1, null)
      return true
    },
    fs: {
      ...takeoverFs,
      writeAtomic: (p: string, text: string) => {
        put(p, text)
        return true
      },
      openExclusive: (p: string, text: string) => {
        if (files.has(p)) return 'exists'
        put(p, text)
        return 'ok'
      },
      unlink: (p: string) => files.delete(p),
    },
    env: { PATH: 'C:\\Windows', CLAUDECODE: '1', BGOS_API_KEY: 'secret' },
    listProcesses: async () => ({ ok: true, processes: procTable() }),
    listAgents: ({ includeIds }: { includeIds: string[] }) =>
      listAgents({
        home: HOME,
        env: {},
        platform: 'win32',
        fs: { exists: (p: string) => files.has(p) || dirs.has(p), readFile: (p: string) => files.get(p)?.text ?? null, listDir: () => [] },
        pidAlive,
        execSync: () => ({ code: 1, stdout: '' }),
        now: clock.now,
        includeIds,
      }),
    readLauncherProcesses: (pids: number[]) => new Map(procTable().filter((p) => pids.includes(p.pid)).map((p) => [p.pid, { command: p.command, startedAtMs: p.startedAtMs }])),
    restartAgent,
    restartDeps: {
      exec: async (file: string, args: string[]) => {
        recorded.push({ file, args })
        return { code: 0, stdout: '', stderr: '' }
      },
      spawnDetached: (file: string, args: string[]) => {
        recorded.push({ file, args })
        // What launch-hidden.vbs starts: a new hoai-core in the agent folder.
        launcherRuns.push(launch())
        return { pid: 4242 }
      },
      fs: { writeFile: (p: string, t: string) => put(p, t), readFile: (p: string) => files.get(p)?.text ?? null, exists: (p: string) => files.has(p) },
    },
  })
  const newController = (g: Gen) =>
    takeover?.createMarkerTakeover({
      platform: 'win32',
      assistantId: '909',
      stateDir: STATE,
      bootAtMs: g.startedAtMs + 500,
      now: () => clock.now,
      ownPid: g.daemon,
      active: () => !g.dead,
      claudePid: () => g.claude,
      fs: takeoverFs,
      pidAlive,
      setInterval: () => 0,
      clearInterval: () => {},
      setTimeout: () => 0,
      watch: () => ({ close() {}, on() {} }),
      spawnHelper: (argv: string[], env: Record<string, string>) => {
        const params = takeover.parseHandoffArgv(argv)
        helperRuns.push(handoff.runRestartHandoff(params, { ...helperDeps(), env: { ...helperDeps().env, ...env } }))
        return { pid: 99_999 }
      },
      helperParams: () => ({ home: HOME, launchCwd: CWD, logPath: `${HOME}\\log.txt`, pluginStateDir: PLUGIN_STATE, credentialsPath: CREDS, pluginRoot: ROOT }),
      helperEnv: () => ({ PATH: 'C:\\Windows' }),
      log: (line: string) => logs.push(`daemon ${g.daemon}: ${line}`),
    }) ?? null

  let nextPid = 5000
  const launch = () => {
    launchers += 1
    return superviseClaude(BASE, {
      platform: 'win32',
      env: {},
      home: HOME,
      cwd: CWD,
      scriptDir: 'C:\\checkouts\\0.66.1\\bin',
      readFile: (p: string) => files.get(p)?.text ?? null,
      listDir: () => [],
      exists: (p: string) => files.has(p),
      writeFile: (p: string, c: string) => {
        put(p, c)
        return true
      },
      removeFile: (p: string) => files.delete(p),
      spawnImpl: ((_file: string, args: readonly string[]) => {
        const child = new FakeClaude(args)
        const g: Gen = { claude: nextPid++, daemon: nextPid++, child, startedAtMs: clock.now, dead: false, controller: null }
        child.on('exit', () => {
          g.dead = true
        })
        gens.push(g)
        put(`${CREDS}.lock`, JSON.stringify({ pid: g.daemon, heartbeatAt: clock.now }))
        g.controller = newController(g)
        return child
      }) as never,
      spawnGateHelper: () => ({ pid: 1 }),
      writeErr: () => {},
      pollMs: 10,
      now: () => clock.now,
      print: (line: string) => prints.push(line),
      pidAlive: (pid: number) => pid === LAUNCHER ? launchers > 0 : pidAlive(pid),
      pidProcess: () => null,
      listProcesses: () => [],
      setTimer: (() => 0) as never,
      clearTimer: () => {},
      generateId: () => PIN,
      hasExpect: false,
      keepAlive,
      sleep: async (ms: number) => {
        clock.now += ms
        await tick()
      },
    }).finally(() => {
      launchers -= 1
    })
  }

  /** A marker written by hand, seen by the daemon in the same instant (its folder watch). */
  const writeMarker = (text = '{"reason":"proof","requestedBy":"mark"}') => {
    put(MARKER, text)
    current()?.controller?.tick('watch-named')
  }
  /** Let this much session time pass, the daemon ticking every 500 ms. */
  const pass = async (ms: number) => {
    const end = clock.now + ms
    while (clock.now < end) {
      clock.now += 500
      const g = current()
      // The live daemon re-stamps its pairing lock every 5 s (lib/pairing-lock.ts).
      if (g) put(`${CREDS}.lock`, JSON.stringify({ pid: g.daemon, heartbeatAt: clock.now }))
      g?.controller?.tick('poll')
      await tick()
    }
  }
  return { clock, files, gens, live, current, logs, prints, helperRuns, recorded, launcherRuns, launch, writeMarker, pass }
}

async function spendBudget(h: ReturnType<typeof harness>) {
  await until(() => h.gens.length === 1, 'the first claude')
  await h.pass(61_000)
  for (let i = 1; i <= MAX_RELAUNCHES_PER_WINDOW; i++) {
    const before = h.gens.length
    h.writeMarker()
    await until(() => h.gens.length === before + 1, `relaunch ${i}`)
    assert.deepEqual(h.current()!.child.args.slice(-2), ['--resume', PIN], `relaunch ${i} resumes the pin`)
    await h.pass(61_000)
  }
}

test('interactive launcher, budget spent: marker 4 is swallowed, the daemon takes it over, and ONE new launcher resumes the SAME session', async () => {
  const h = harness()
  const first = h.launch()
  await spendBudget(h)
  const before = h.current()!
  h.writeMarker()
  await until(() => !h.files.has(MARKER), 'the exhausted launcher deletes marker 4')
  assert.ok(h.prints.some((l) => l.includes('restart marker ignored')), 'the launcher refused it (bin/hoai-core.mjs:2299)')
  await h.pass(30_000)
  if (!takeover || !handoff) {
    assert.fail(`marker 4 was swallowed by the exhausted launcher (bin/hoai-core.mjs:2295-2299): claude ${before.claude} still running 30 s later and nothing else reads the marker, so the agent never restarted`)
  }
  await until(() => h.helperRuns.length === 1, 'the daemon hands the takeover to a helper')
  const out = await h.helperRuns[0]
  assert.equal(out.outcome, 'restarted', h.logs.join('\n'))
  assert.equal(await first, 1, 'the old interactive launcher returned when its claude was ended')
  assert.ok(h.recorded.some((r) => r.file === 'wscript.exe'), 'the hidden recipe launch ran')
  const vbs = h.files.get(`${STATE}\\launch-hidden.vbs`)!.text
  assert.match(vbs, /env\("HOAI_SUPERVISED_ASSISTANT_ID"\) = "909"/)
  assert.ok(vbs.includes(`${ROOT}\\bin\\hoai-core.mjs`))
  await until(() => h.live().length === 1 && h.live()[0] !== before, 'the new session')
  assert.deepEqual(h.live()[0].child.args.slice(-2), ['--resume', PIN], 'the new launcher resumes the agent\'s own pinned session')
  assert.equal(h.files.get(`${STATE}\\session-id`)!.text.trim(), PIN)
  assert.equal(JSON.parse(h.files.get(`${STATE}\\restart-takeovers.json`)!.text).takeovers.length, 1)
  assert.equal(h.live().length, 1, 'exactly one claude of the agent')
  // A marker the NEW launcher gets is its own business: no takeover, no second helper.
  h.live()[0].child.emit('exit', 0, null)
  await Promise.all(h.launcherRuns)
})

test('keep-alive launcher, budget spent: a stranded marker is claimed, claude ended, and the SAME launcher relaunches the pin; nothing else is started', async () => {
  const h = harness({ keepAlive: true })
  const run = h.launch()
  await spendBudget(h)
  // Marker 4 is swallowed and taken over; the keep-alive launcher relaunches by itself.
  const before = h.current()!
  h.writeMarker()
  await until(() => !h.files.has(MARKER), 'marker 4 deleted')
  await h.pass(30_000)
  if (!takeover || !handoff) assert.fail(`marker 4 swallowed (bin/hoai-core.mjs:2295-2299): claude ${before.claude} still running, never restarted`)
  await until(() => h.helperRuns.length === 1, 'helper 1')
  assert.equal((await h.helperRuns[0]).outcome, 'relaunched_by_launcher', h.logs.join('\n'))
  await until(() => h.live().length === 1 && h.live()[0] !== before, 'the relaunched session')
  assert.deepEqual(h.live()[0].child.args.slice(-2), ['--resume', PIN])
  // Marker 5 is stranded (the latch never resets): claimed byte for byte, then the same path.
  await h.pass(61_000)
  const second = h.current()!
  h.writeMarker('{"reason":"five"}')
  await h.pass(20_000)
  assert.ok(h.files.has(MARKER) || h.helperRuns.length === 2, 'the exhausted launcher left marker 5 on disk')
  await until(() => h.helperRuns.length === 2, 'helper 2')
  assert.equal((await h.helperRuns[1]).outcome, 'relaunched_by_launcher', h.logs.join('\n'))
  assert.equal(h.files.get(`${STATE}\\restart-requested.claimed.json`)?.text, '{"reason":"five"}')
  await until(() => h.live().length === 1 && h.live()[0] !== second, 'relaunched again')
  assert.equal(h.recorded.length, 0, 'the ladder was never used: the launcher relaunched by itself')
  h.live()[0].child.emit('exit', 0, null)
  void run
})

test('the loop guard caps takeovers at 3 an hour: with 3 already recorded, a swallowed and then a stranded marker leave claude alone', async () => {
  if (!takeover || !handoff) assert.fail('no daemon reads restart-requested.json at main (0.67.x only writes it, server.ts writeMarker)')
  const h = harness({ keepAlive: true })
  void h.launch()
  await spendBudget(h)
  // Three takeovers already this hour (an earlier daemon of this agent recorded them).
  h.files.set(`${STATE}\\restart-takeovers.json`, {
    text: JSON.stringify({ schemaVersion: 1, takeovers: [1, 2, 3].map((i) => ({ at: new Date(h.clock.now - i * 60_000).toISOString(), kind: 'stranded', markerMtimeMs: i })) }),
    mtimeMs: h.clock.now,
  })
  const claude = h.current()!.claude
  h.writeMarker('{"n":4}')
  await until(() => !h.files.has(MARKER), 'marker 4 deleted by the exhausted launcher')
  await h.pass(15_000)
  h.writeMarker('{"n":5}')
  await h.pass(20_000)
  assert.equal(h.helperRuns.length, 0, 'the cap refuses both')
  assert.equal(h.files.get(`${STATE}\\restart-requested.refused.json`)?.text, '{"n":5}', 'the stranded one is set aside, never restarted later')
  assert.ok(h.logs.some((l) => l.includes('REFUSED (loop guard): 3 takeovers in the last hour')), h.logs.join('\n'))
  assert.equal(h.current()!.claude, claude, 'claude untouched')
  h.current()!.child.emit('exit', 0, null)
})
