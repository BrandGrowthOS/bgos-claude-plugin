/**
 * browser-host-supervisor tests: the daemon starts this machine's browser host.
 *
 * The four things the daemon owes (and what each would cost if it broke):
 *
 *   1. It SPAWNS THE HOST ONCE, detached from its stdio (the daemon's stdout
 *      is its MCP channel) and scoped to its own pairing.
 *   2. It does NOT SPAWN A SECOND for the same pairing: two daemons of one
 *      pairing on a machine share one host (the per-pairing lock of
 *      lib/pairing-lock.ts), and the waiting daemon takes over when the
 *      holder is gone.
 *   3. It SURVIVES THE CHILD CRASHING: a crash, a spawn error, a spawn that
 *      throws and a missing node are logged and otherwise ignored, never an
 *      exception into the daemon, and the host is not restarted by the daemon
 *      that saw it die.
 *   4. It SKIPS THE SPAWN when the kill switch HOAI_BROWSER_HOST=off is set.
 *
 * The unit cases drive a fake spawn over the real lock files; the end to end
 * cases spawn the real bin/hoai-browser-host.mjs under node against the fake
 * relay (helpers/fake-browser-relay.ts). server.ts itself is pinned by source,
 * the way the other daemon wiring tests in this folder are.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  BROWSER_HOST_KILL_SWITCH_ENV,
  HOST_ENV,
  browserHostKillSwitchOn,
  browserHostLockPath,
  browserHostLogPath,
  browserHostPairingKey,
  hostEnv,
  startBrowserHostSupervisor,
  type BrowserHostSupervisor,
  type BrowserHostSupervisorOptions,
} from '../lib/browser-host-supervisor.ts'
import { resolveNodePath } from '../lib/watcher-install.mjs'
import { STOP_ON_STDIN_EOF_ENV, pidAlive } from '../bin/hoai-browser-host.mjs'
import { startFakeRelay } from './helpers/fake-browser-relay.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const HOST_BIN = join(HERE, '..', 'bin', 'hoai-browser-host.mjs')
const AUTH = { mode: 'pairing', complete: true, backendUrl: 'https://api.test/api/v1', pairingToken: 'tok-1', assistantId: '900' }
/** A pid that is certainly not a live process, for a second "daemon". */
const OTHER_DAEMON_PID = 2_000_000_001

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function until(what: string, check: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await sleep(25)
  }
}

type FakeStdin = { ended: boolean; end(): void; on(): FakeStdin; unref(): void }
type FakeChild = EventEmitter & { pid: number; exitCode: number | null; signalCode: string | null; signals: string[]; stdin: FakeStdin; kill(sig?: string): boolean; unref(): void }

function fakeChild(pid = 4242): FakeChild {
  const c = new EventEmitter() as FakeChild
  c.pid = pid
  c.exitCode = null
  c.signalCode = null
  c.signals = []
  c.stdin = {
    ended: false,
    end() {
      this.ended = true
    },
    on() {
      return this
    },
    unref() {},
  }
  c.kill = (sig = 'SIGTERM') => {
    c.signals.push(sig)
    return true
  }
  c.unref = () => {}
  return c
}

function fakeSpawn(make: () => FakeChild = () => fakeChild()) {
  const calls: Array<{ command: string; args: string[]; options: any; child: FakeChild }> = []
  const spawnFn = ((command: string, args: string[], options: any) => {
    const child = make()
    calls.push({ command, args, options, child })
    return child as unknown as ChildProcess
  }) as NonNullable<BrowserHostSupervisorOptions['spawn']>
  return { spawnFn, calls }
}

function harness(overrides: Partial<BrowserHostSupervisorOptions> = {}) {
  const agentRoot = overrides.agentRoot ?? mkdtempSync(join(tmpdir(), 'bh-sup-'))
  const logs: string[] = []
  const { spawnFn, calls } = fakeSpawn()
  const sup = startBrowserHostSupervisor({
    env: {},
    auth: AUTH,
    agentRoot,
    hostScript: '/plugin/bin/hoai-browser-host.mjs',
    nodePath: '/usr/local/bin/node',
    log: (line) => logs.push(line),
    spawn: spawnFn,
    openLog: () => 'ignore',
    recheckMs: 40,
    heartbeatMs: 40,
    // The posix lifecycle unless a case asks for Windows, whatever the host running the test.
    platform: 'linux',
    ...overrides,
  })
  return { sup, calls, logs, agentRoot, lockPath: browserHostLockPath(agentRoot, browserHostPairingKey(AUTH.backendUrl, AUTH.pairingToken)) }
}

// ── 1. It spawns the host once ──────────────────────────────────────────────

test('the daemon spawns the host once, detached from its stdio, scoped to its pairing, and stops it on exit', async () => {
  const h = harness()
  assert.equal(h.calls.length, 1)
  const [call] = h.calls
  assert.equal(call.command, '/usr/local/bin/node')
  assert.deepEqual(call.args, ['/plugin/bin/hoai-browser-host.mjs'])
  assert.equal(call.options.stdio[0], 'pipe', 'stdin is a pipe this daemon holds, never its MCP channel: closing it is the stop')
  assert.equal(call.options.env[HOST_ENV.stopOnStdinEof], '1', 'and the host is told so')
  assert.equal(HOST_ENV.stopOnStdinEof, STOP_ON_STDIN_EOF_ENV, 'under the very name the host reads')
  assert.equal(call.options.detached, false, 'off Windows the host stays in the daemon process group')
  assert.ok(!['inherit', 'pipe'].includes(call.options.stdio[1]) && !['inherit', 'pipe'].includes(call.options.stdio[2]), 'stdout and stderr never reach the daemon stdio')
  assert.equal(call.options.env[HOST_ENV.pairingToken], 'tok-1')
  assert.equal(call.options.env[HOST_ENV.backendUrl], 'https://api.test/api/v1')
  assert.equal(call.options.env[HOST_ENV.assistantId], '900')
  assert.equal(call.options.env[HOST_ENV.parentPid], String(process.pid))
  assert.equal(h.sup.state, 'running')
  assert.ok(existsSync(h.lockPath), 'the pairing lock is held')
  assert.ok(!readFileSync(h.lockPath, 'utf8').includes('tok-1'), 'no token in the lock')
  await sleep(200) // several heartbeats and would-be rechecks
  assert.equal(h.calls.length, 1, 'still exactly one spawn')
  h.sup.stop()
  assert.equal(call.child.stdin.ended, true, 'stopped with the daemon: its stdin closed')
  assert.deepEqual(call.child.signals, ['SIGTERM'], 'and, where a process can handle it, SIGTERM')
  assert.ok(!existsSync(h.lockPath), 'and the lock released')
  h.sup.stop()
  assert.deepEqual(call.child.signals, ['SIGTERM'], 'stop is idempotent')
})

test('on Windows the host is started detached and stopped through its stdin, never cut off with TerminateProcess', async () => {
  // On Windows kill('SIGTERM') is TerminateProcess: no handler runs, so Chrome is cut off mid
  // write. And a host left in the daemon's libuv job is killed the moment the daemon exits.
  const h = harness({ platform: 'win32', stopBackstopMs: 80 })
  const [call] = h.calls
  assert.equal(call.options.detached, true, 'out of the daemon job, so it can close Chrome after the daemon has gone')
  assert.equal(call.options.stdio[0], 'pipe')
  h.sup.stop()
  assert.equal(call.child.stdin.ended, true, 'the stop is the closed stdin')
  assert.deepEqual(call.child.signals, [], 'and no TerminateProcess')
  // Only a host that is still running well past its own stop deadline is killed, as a backstop
  // while this daemon is alive to do it.
  await sleep(250)
  assert.equal(call.child.signals.length, 1, 'a wedged host is killed late')

  const clean = harness({ platform: 'win32', stopBackstopMs: 80 })
  clean.sup.stop()
  const child = clean.calls[0].child
  child.exitCode = 0
  child.emit('exit', 0, null)
  await sleep(250)
  assert.deepEqual(child.signals, [], 'a host that stopped cleanly is never killed')
})

test('with the real log opener, the host writes to its own log file, never the daemon stdio', () => {
  const h = harness({ openLog: undefined })
  const [call] = h.calls
  assert.equal(typeof call.options.stdio[1], 'number')
  assert.equal(call.options.stdio[1], call.options.stdio[2])
  assert.ok(existsSync(join(h.agentRoot, `browser-host-${browserHostPairingKey(AUTH.backendUrl, AUTH.pairingToken)}.log`)))
  h.sup.stop()
})

// ── 2. Not a second host for the same pairing ───────────────────────────────

test('a second daemon of the same pairing does not spawn a second host, and takes over when the first is gone', async () => {
  const a = harness()
  const b = harness({ agentRoot: a.agentRoot, selfPid: OTHER_DAEMON_PID })
  assert.equal(a.calls.length, 1)
  assert.equal(b.calls.length, 0, 'the same pairing is already served')
  assert.equal(b.sup.state, 'waiting')
  assert.ok(b.logs.some((l) => /already run by the daemon with pid/.test(l)))
  await sleep(200)
  assert.equal(b.calls.length, 0, 'rechecks do not spawn while the holder lives')
  // Another pairing on the same machine gets its own host.
  const c = harness({ agentRoot: a.agentRoot, selfPid: OTHER_DAEMON_PID + 1, auth: { ...AUTH, pairingToken: 'tok-2' } })
  assert.equal(c.calls.length, 1)
  // The holder goes; the waiting daemon of that pairing takes the host over.
  a.sup.stop()
  await until('the waiting daemon to take over', () => b.calls.length === 1)
  assert.equal(b.sup.state, 'running')
  b.sup.stop()
  c.sup.stop()
})

test('a daemon whose pairing lock was taken stands its host down, then takes the host back when it can', async () => {
  const h = harness()
  // Another live daemon (our parent stands in for it) holds the lock now.
  writeFileSync(h.lockPath, JSON.stringify({ pid: process.ppid, heartbeatAt: Date.now() }))
  await until('the stand down', () => h.sup.state === 'waiting')
  assert.deepEqual(h.calls[0].child.signals, ['SIGTERM'], 'its host went: two hosts for one pairing is what the lock stops')
  assert.ok(h.logs.some((l) => /took this pairing's host over; stopping ours and waiting to take it back/.test(l)))
  // The old host exiting later does not end this daemon's part.
  h.calls[0].child.emit('exit', null, 'SIGTERM')
  assert.equal(h.sup.state, 'waiting')
  // That other holder goes: this daemon takes the pairing's host back.
  writeFileSync(h.lockPath, JSON.stringify({ pid: OTHER_DAEMON_PID, heartbeatAt: Date.now() }))
  await until('the take back', () => h.calls.length === 2)
  assert.equal(h.sup.state, 'running')
  h.sup.stop()
})

test('a live holder that is only late (a machine waking from sleep) keeps its lock; one that stays silent loses it', async () => {
  const agentRoot = mkdtempSync(join(tmpdir(), 'bh-sleep-'))
  const lockPath = browserHostLockPath(agentRoot, browserHostPairingKey(AUTH.backendUrl, AUTH.pairingToken))
  // The holder is alive (this very process) but its last beat is 60 s old.
  const lastBeat = Date.now() - 60_000
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, heartbeatAt: lastBeat }))
  const b = harness({ agentRoot, selfPid: OTHER_DAEMON_PID, recheckMs: 300 })
  assert.equal(b.calls.length, 0, 'not taken at first sight')
  // The holder's own timer fires on wake before the next recheck.
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, heartbeatAt: Date.now() }))
  await sleep(1_000)
  assert.equal(b.calls.length, 0, 'a holder that beat again keeps its host')
  // Now it goes silent for good: the same stale beat, a recheck apart.
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, heartbeatAt: Date.now() - 60_000 }))
  await until('the reclaim', () => b.calls.length === 1, 5_000)
  b.sup.stop()
})

test('the daemon starts the host with the allow-listed environment plus its own pairing token (the list itself: test/browser-env.test.ts)', () => {
  const env = { PATH: '/usr/bin', HOME: '/home/kc', DISPLAY: ':0', XAUTHORITY: '/x', HOAI_BROWSER_EXECUTABLE: '/c', SSH_AUTH_SOCK: '/tmp/agent.sock', GH_PAT: 'k6', BGOS_API_KEY: 'k1', BGOS_PAIRING_TOKEN: 't1', OPENAI_API_KEY: 'k2', GITHUB_TOKEN: 'k3', AWS_SECRET_ACCESS_KEY: 'k4', DB_PASSWORD: 'k5' }
  assert.deepEqual(hostEnv(env, { platform: 'linux' }), { PATH: '/usr/bin', HOME: '/home/kc', HOAI_BROWSER_EXECUTABLE: '/c' })
  const h = harness({ env })
  const spawned = h.calls[0].options.env
  assert.ok(!('SSH_AUTH_SOCK' in spawned), 'the ssh-agent socket is not handed to the host')
  for (const secret of ['k1', 't1', 'k2', 'k3', 'k4', 'k5', 'k6']) assert.ok(!Object.values(spawned).includes(secret), `${secret} is not handed to the host`)
  assert.equal(spawned[HOST_ENV.pairingToken], 'tok-1', 'the one secret it needs, explicitly')
  assert.equal(spawned.HOAI_BROWSER_EXECUTABLE, '/c')
  h.sup.stop()
})

// ── 3. It survives the child crashing ───────────────────────────────────────

test('the daemon survives its host crashing, logs it, releases the pairing, and does not restart it', async () => {
  const h = harness()
  const child = h.calls[0].child
  child.exitCode = 1
  child.emit('exit', 1, null)
  assert.equal(h.sup.state, 'ended')
  assert.ok(h.logs.some((l) => /exited \(code 1, signal -\); the daemon carries on without it/.test(l)), h.logs.join('\n'))
  assert.ok(!existsSync(h.lockPath), 'a sibling daemon may take the pairing over')
  await sleep(200)
  assert.equal(h.calls.length, 1, 'not restarted by this daemon')
  h.sup.stop()
})

test('the daemon survives a spawn error event, a spawn that throws, and a missing node', () => {
  const errored = harness()
  errored.calls[0].child.emit('error', Object.assign(new Error('spawn /usr/local/bin/node ENOENT'), { code: 'ENOENT' }))
  assert.equal(errored.sup.state, 'ended')
  assert.ok(errored.logs.some((l) => /failed \(spawn .* ENOENT\)/.test(l)))

  const threw = harness({
    spawn: (() => {
      throw new Error('EACCES')
    }) as any,
  })
  assert.equal(threw.sup.state, 'ended')
  assert.ok(threw.logs.some((l) => /could not start \(EACCES\)/.test(l)))
  assert.ok(!existsSync(threw.lockPath))

  const noNode = harness({ nodePath: null })
  assert.equal(noNode.calls.length, 0)
  assert.equal(noNode.sup.state, 'off')
  assert.ok(noNode.logs.some((l) => /node was not found/.test(l)))
})

test('a real spawn of a binary that does not exist is logged, not thrown into the daemon', async () => {
  const h = harness({ spawn: undefined, nodePath: join(tmpdir(), 'no-such-node-binary') })
  await until('the spawn error', () => h.sup.state === 'ended')
  assert.ok(h.logs.some((l) => /failed \(.*ENOENT/.test(l)), h.logs.join('\n'))
})

// ── 4. The kill switch ──────────────────────────────────────────────────────

test('HOAI_BROWSER_HOST=off skips the spawn entirely', () => {
  for (const value of ['off', 'OFF', ' Off ', '0', 'false', 'no']) {
    const h = harness({ env: { [BROWSER_HOST_KILL_SWITCH_ENV]: value } })
    assert.equal(h.calls.length, 0, `${BROWSER_HOST_KILL_SWITCH_ENV}=${value} spawns nothing`)
    assert.equal(h.sup.state, 'off')
    assert.ok(!existsSync(h.lockPath), 'and takes no lock')
    assert.ok(h.logs.some((l) => l.includes('HOAI_BROWSER_HOST=')))
  }
  for (const value of [undefined, '', 'on', '1']) {
    assert.equal(browserHostKillSwitchOn({ [BROWSER_HOST_KILL_SWITCH_ENV]: value }), false, `${value} leaves it on`)
  }
  const on = harness({ env: { [BROWSER_HOST_KILL_SWITCH_ENV]: 'on' } })
  assert.equal(on.calls.length, 1)
  on.sup.stop()
})

test('a daemon with no pairing token starts nothing: the host handshake needs a pairing', () => {
  for (const auth of [{ ...AUTH, mode: 'apikey', pairingToken: '' }, { ...AUTH, complete: false }]) {
    const h = harness({ auth })
    assert.equal(h.calls.length, 0)
    assert.equal(h.sup.state, 'off')
  }
})

// ── End to end: the real host binary, spawned by the supervisor ─────────────

const nodePath = resolveNodePath({ env: process.env, platform: process.platform, execPath: process.execPath, exists: existsSync })
const e2eSkip = nodePath ? false : 'node is not on PATH'

test(
  'END TO END: two daemons of one pairing start exactly one real host, a crash of it hands the pairing to the other, and the kill switch starts none',
  { timeout: 120_000, skip: e2eSkip },
  async () => {
    if (e2eSkip) return // bun ignores the skip option; this is the same skip
    const TOKEN = 'tok-sup-e2e'
    const relay = await startFakeRelay({ token: TOKEN, admissible: [900] })
    const home = mkdtempSync(join(tmpdir(), 'bh-sup-e2e-'))
    const agentRoot = join(home, '.bgos-agent')
    const auth = { ...AUTH, backendUrl: relay.backendUrl, pairingToken: TOKEN }
    const logs: string[] = []
    // Every host the supervisors start, tracked by its own process handle, so "none left behind"
    // is a fact about these processes rather than a pgrep (which Windows does not have, and whose
    // match on the home folder never named a host anyway: the folder is only in the env).
    const spawned: ChildProcess[] = []
    const track: NonNullable<BrowserHostSupervisorOptions['spawn']> = (command, args, options) => {
      const child = spawn(command, args, options)
      spawned.push(child)
      return child
    }
    const daemon = (selfPid: number, env: Record<string, string> = {}) =>
      startBrowserHostSupervisor({ env: { ...process.env, HOME: home, USERPROFILE: home, ...env }, auth, agentRoot, hostScript: HOST_BIN, nodePath, log: (l) => logs.push(`[${selfPid}] ${l}`), selfPid, recheckMs: 200, spawn: track })
    const hostHandshakes = () => relay.handshakes.filter((h) => h.auth.role === 'browser_host')
    const sups: BrowserHostSupervisor[] = []
    // The second daemon's pid must be LIVE: a host whose daemon pid is dead stops itself within
    // seconds (the watchdog), which would race the stop this case is about.
    const standIn = spawn(nodePath!, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    try {
      const a = daemon(process.pid)
      const b = daemon(standIn.pid!)
      sups.push(a, b)
      assert.equal(a.state, 'running')
      assert.equal(b.state, 'waiting')
      await relay.waitForHost(30_000)
      assert.deepEqual(hostHandshakes()[0].auth.agents, [900], 'scoped to the daemon pairing and agent')
      assert.equal(hostHandshakes()[0].query.pairingToken, TOKEN)
      await sleep(1_500)
      assert.equal(hostHandshakes().length, 1, `one pairing, one host: ${logs.join('\n')}`)

      // The host crashes. The daemon that ran it carries on; the other daemon
      // of the pairing takes the host over.
      const firstHost = a.child!
      firstHost.kill('SIGKILL')
      await until('the first daemon to see the crash', () => a.state === 'ended')
      assert.ok(logs.some((l) => /exited \(code -, signal SIGKILL\)/.test(l)), logs.join('\n'))
      await until('the second daemon to take over', () => b.state === 'running', 20_000)
      await until('a new host socket', () => hostHandshakes().length === 2, 30_000)

      // The kill switch: a third daemon of another pairing starts nothing.
      const off = daemon(OTHER_DAEMON_PID + 1, { [BROWSER_HOST_KILL_SWITCH_ENV]: 'off' })
      sups.push(off)
      assert.equal(off.state, 'off')

      // The daemon exits: its host goes with it.
      const secondHost = b.child!
      const exited = new Promise<number | null>((r) => secondHost.once('exit', (code) => r(code)))
      b.stop()
      // Within the host's own stop deadline, and exit 0: a clean close, not a deadline or a kill.
      assert.equal(await Promise.race([exited, sleep(12_000).then(() => 'still running' as const)]), 0, 'the stopped daemon took its host with it, cleanly')
      await sleep(1_000)
      assert.equal(hostHandshakes().length, 2, 'the kill switch and the stop started nothing new')
    } finally {
      for (const s of sups) s.stop()
      standIn.kill('SIGKILL')
      await relay.close()
    }
    assert.equal(spawned.length, 2, 'exactly two hosts were ever started: one, then its takeover')
    await until('every host to be gone', () => spawned.every((c) => c.exitCode !== null || c.signalCode !== null), 20_000)
  },
)

test('END TO END: a host whose daemon is killed outright stops itself', { timeout: 60_000, skip: e2eSkip }, async () => {
  if (e2eSkip) return
  const TOKEN = 'tok-parent'
  const relay = await startFakeRelay({ token: TOKEN, admissible: [900] })
  const home = mkdtempSync(join(tmpdir(), 'bh-parent-'))
  // A stand-in daemon that is SIGKILLed: it cannot send its host a SIGTERM.
  const standIn = spawn(nodePath!, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  const host = spawn(nodePath!, [HOST_BIN], {
    stdio: 'ignore',
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      [HOST_ENV.pairingToken]: TOKEN,
      [HOST_ENV.backendUrl]: relay.backendUrl,
      [HOST_ENV.assistantId]: '900',
      [HOST_ENV.parentPid]: String(standIn.pid),
    },
  })
  try {
    await relay.waitForHost(30_000)
    const exited = new Promise<number | null>((r) => host.once('exit', (code) => r(code)))
    standIn.kill('SIGKILL')
    const code = await Promise.race([exited, sleep(15_000).then(() => 'still running' as const)])
    assert.equal(code, 0, 'the host noticed its daemon was gone and stopped cleanly')
  } finally {
    standIn.kill('SIGKILL')
    host.kill('SIGKILL')
    await relay.close()
  }
})

for (const stopPlatform of [undefined, 'win32'] as const) {
test(`END TO END: stopping the daemon closes its host cleanly, on Windows too: exit 0, and the host says it stopped${stopPlatform ? ' (the Windows stop, stdin alone, on this host)' : ''}`, { timeout: 60_000, skip: e2eSkip }, async () => {
  if (e2eSkip) return
  // With stopPlatform 'win32' the stop is the closed stdin ALONE (no SIGTERM), so every CI leg,
  // Linux included, proves the pipe stop end to end; detached is harmless off Windows.
  // On Windows the old stop was kill('SIGTERM'), which is TerminateProcess there: the host never
  // ran its stop, so its Chrome was cut off mid write on every daemon stop or restart.
  const TOKEN = 'tok-stop'
  const relay = await startFakeRelay({ token: TOKEN, admissible: [900] })
  const home = mkdtempSync(join(tmpdir(), 'bh-stop-'))
  const agentRoot = join(home, '.bgos-agent')
  const auth = { ...AUTH, backendUrl: relay.backendUrl, pairingToken: TOKEN }
  const sup = startBrowserHostSupervisor({ env: { ...process.env, HOME: home, USERPROFILE: home }, auth, agentRoot, hostScript: HOST_BIN, nodePath, log: () => {}, platform: stopPlatform })
  try {
    await relay.waitForHost(30_000)
    const host = sup.child!
    const exited = new Promise<number | null>((r) => host.once('exit', (code) => r(code)))
    sup.stop()
    // Well inside the host's own 15 s stop deadline and the 20 s backstop.
    const code = await Promise.race([exited, sleep(12_000).then(() => 'still running' as const)])
    const log = readFileSync(browserHostLogPath(agentRoot, browserHostPairingKey(auth.backendUrl, TOKEN)), 'utf8')
    assert.equal(code, 0, `the host must close its browsers and sockets, not be cut off:\n${log}`)
    assert.match(log, /closing the browsers/)
    assert.match(log, /stopped cleanly/)
  } finally {
    sup.stop()
    sup.child?.kill('SIGKILL')
    await relay.close()
  }
})
}

const bunOk = spawnSync('bun', ['--version'], { windowsHide: true }).status === 0
const standInSkip = e2eSkip || (bunOk ? false : 'bun is not on PATH (the daemon runs under bun)')

/**
 * A real daemon process under bun, production's runtime, running the real supervisor and driven
 * over its own stdin: `stop` stops the host and exits at once (what server.ts shutdown() does),
 * `stop-stay` stops the host and stays up (a lock handover), `exit` just exits.
 */
async function bunStandIn(token: string, platform?: string) {
  const relay = await startFakeRelay({ token, admissible: [900] })
  const home = mkdtempSync(join(tmpdir(), 'bh-standin-'))
  const agentRoot = join(home, '.bgos-agent')
  const auth = { ...AUTH, backendUrl: relay.backendUrl, pairingToken: token }
  const script = join(home, 'stand-in-daemon.ts')
  writeFileSync(
    script,
    [
      `import { startBrowserHostSupervisor } from ${JSON.stringify(pathToFileURL(join(HERE, '..', 'lib', 'browser-host-supervisor.ts')).href)}`,
      'const e = process.env',
      'const sup = startBrowserHostSupervisor({ env: e, auth: JSON.parse(e.STANDIN_AUTH!), agentRoot: e.STANDIN_AGENT_ROOT!, hostScript: e.STANDIN_HOST_BIN!, nodePath: e.STANDIN_NODE!, log: (l) => console.log(l), platform: e.STANDIN_PLATFORM || undefined })',
      "process.stdin.on('data', (d) => {",
      "  const cmd = String(d).trim()",
      "  if (cmd === 'stop') { sup.stop(); process.exit(0) }",
      "  if (cmd === 'stop-stay') sup.stop()",
      "  if (cmd === 'exit') process.exit(0)",
      '})',
      '',
    ].join('\n'),
  )
  const daemon = spawn('bun', [script], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, HOME: home, USERPROFILE: home, STANDIN_AUTH: JSON.stringify(auth), STANDIN_AGENT_ROOT: agentRoot, STANDIN_HOST_BIN: HOST_BIN, STANDIN_NODE: nodePath!, STANDIN_PLATFORM: platform ?? '' },
    windowsHide: true,
  })
  let out = ''
  daemon.stdout!.on('data', (c: Buffer) => (out += c.toString()))
  daemon.stderr!.on('data', (c: Buffer) => (out += c.toString()))
  const logPath = browserHostLogPath(agentRoot, browserHostPairingKey(auth.backendUrl, token))
  const hostLog = () => (existsSync(logPath) ? readFileSync(logPath, 'utf8') : '')
  await relay.waitForHost(30_000)
  const hostPid = Number(/started \(pid (\d+)\)/.exec(out)?.[1] ?? 0)
  assert.ok(hostPid > 0, `the stand-in daemon started a host:\n${out}`)
  return {
    daemon,
    hostPid,
    hostLog,
    send: (cmd: string) => daemon.stdin!.write(`${cmd}\n`),
    async cleanup() {
      daemon.kill('SIGKILL')
      if (pidAlive(hostPid)) process.kill(hostPid, 'SIGKILL')
      await relay.close()
    },
  }
}

test('END TO END: a daemon that stops its host and exits AT ONCE, as server.ts shutdown() does, still gets a clean close', { timeout: 90_000, skip: standInSkip }, async () => {
  if (standInSkip) return
  // server.ts shutdown() calls browserHost.stop() and then process.exit() on the next line. On
  // Windows libuv puts every child that is not detached into a job object that kills it when the
  // parent exits, so a host left in the daemon's job would be killed before it could close Chrome.
  const s = await bunStandIn('tok-standin')
  try {
    const daemonGone = new Promise((r) => s.daemon.once('exit', r))
    s.send('stop')
    await daemonGone
    // The daemon has exited. Its host must still finish the whole stop on its own.
    await until(`the host to finish its stop after its daemon exited:\n${s.hostLog()}`, () => /stopped cleanly/.test(s.hostLog()), 20_000)
    await until('the host process to end', () => !pidAlive(s.hostPid), 20_000)
  } finally {
    await s.cleanup()
  }
})

test('END TO END: a bun daemon that stays up stops its host through stdin ALONE, and the host stays up until then', { timeout: 90_000, skip: standInSkip }, async () => {
  if (standInSkip) return
  // The Windows stop (no SIGTERM, injected here on every OS) under bun, with the daemon ALIVE, as
  // in a lock handover: so the end of input the host reads comes from bun's child.stdin.end(), not
  // from the pipe closing when the daemon dies.
  const s = await bunStandIn('tok-standin-stay', 'win32')
  try {
    await sleep(3_000)
    assert.ok(pidAlive(s.hostPid), 'a bun daemon holding the pipe keeps its host up')
    assert.doesNotMatch(s.hostLog(), /let go/, 'nothing told the host to stop yet')
    s.send('stop-stay')
    await until(`the host to stop cleanly while its daemon is still up:\n${s.hostLog()}`, () => /stopped cleanly/.test(s.hostLog()), 12_000)
    await until('the host process to end, inside its own stop deadline', () => !pidAlive(s.hostPid), 12_000)
    assert.equal(s.daemon.exitCode, null, 'and the daemon is still running')
    s.send('exit')
  } finally {
    await s.cleanup()
  }
})

// ── server.ts: the daemon really does this ──────────────────────────────────

test('server.ts starts the supervisor in main, unconditionally, and stops it on every exit path', () => {
  const src = readFileSync(join(HERE, '..', 'server.ts'), 'utf8')
  assert.match(src, /import \{ startBrowserHostSupervisor, type BrowserHostSupervisor \} from '\.\/lib\/browser-host-supervisor\.js'/)
  const mainAt = src.indexOf('async function main(): Promise<void> {')
  // At main's own indentation: not inside an if, a flag or a callback.
  const startAt = src.indexOf('\n  browserHost = startBrowserHostSupervisor({')
  const lockAt = src.indexOf('// ── Single-instance pairing lock (0.38.6, board 01a05185)')
  assert.ok(mainAt > 0 && startAt > mainAt && startAt < lockAt, 'called in main, before the channel lock decides anything')
  const call = src.slice(startAt, src.indexOf('\n  })', startAt))
  assert.match(call, /auth: AUTH,/)
  assert.match(call, /hostScript: pathJoin\(PLUGIN_ROOT, 'bin', 'hoai-browser-host\.mjs'\)/)
  assert.match(call, /nodePath: resolveNodePath\(/)
  const shutdownBody = src.slice(src.indexOf('const shutdown = (cause'), src.indexOf("process.on('exit', () => {"))
  assert.match(shutdownBody, /browserHost\?\.stop\(\)\n\s+process\.exit\(code\)/, 'shutdown() stops the host before it exits')
  const exitHook = src.slice(src.indexOf("process.on('exit', () => {"), src.indexOf("for (const signal of ['SIGINT', 'SIGTERM'] as const)"))
  assert.match(exitHook, /browserHost\?\.stop\(\)/, 'and so does the exit hook, for every other exit')
})
