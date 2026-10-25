/**
 * The launcher's singleton guard against a holder that supervises nothing
 * (board row fabeef45, kc-server agent 867, 2026-10-22: down two days, 5,393
 * restarts of the service, every one of them exit 3).
 *
 * The holder in supervisor.json was alive and was the hoai launcher that
 * wrote the file, so every new launch read "already supervised" and stopped.
 * But its claude was a zombie: the launcher's loop had stopped, it never
 * reaped its child, never relaunched it, never released the claim, and a
 * SIGTERM did nothing (only SIGKILL ended it). Pinned here, with fake
 * processes in a scratch HOME:
 *   1. already-supervised proves the holder's CHILD is alive, not only the
 *      holder's pid;
 *   2. a launcher between children says so (the keep-alive backoff names its
 *      relaunch deadline), and a wedged one releases its own claim
 *      (decideWatchdogAction);
 *   3. a holder proven to supervise nothing is ended, TERM first and KILL when
 *      it ignores TERM, and only then is the agent launched;
 *   4. an empty lock is stale;
 *   5. a fresh session a launcher started is pinned for the next launch even
 *      when that launcher never reached its health window.
 * And the controls: a live child stays supervised, there is never a double
 * launch, a healthy holder is never taken over.
 *
 * Run: npx tsx --test test/hoai-core.launcher-zombie.test.ts
 */

import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import * as core from '../bin/hoai-core.mjs'

const {
  EXIT_ALREADY_SUPERVISED,
  LAUNCH_STATUS_FILE_NAME,
  SESSION_ID_FILE_NAME,
  SUPERVISOR_FILE_NAME,
  decideSupervisorArming,
  sessionTranscriptPath,
  superviseClaude,
  supervisorFileBody,
} = core

const ID = '900'
const SUPERVISED = { HOAI_SUPERVISED: '1', HOAI_SUPERVISED_ASSISTANT_ID: ID }
const HOLDER = 4242
const OTHER = 5151
const STAMP = '2026-10-20T08:00:00.000Z'
const STAMP_MS = Date.parse(STAMP)
const HOAI_CMD = '/usr/bin/node /home/kc/bgos-claude-plugin/bin/hoai-core.mjs'
const ARGS = ['--dangerously-load-development-channels', 'server:bgos']

type Child = { pid: number; zombie: boolean; name: string; startedAtMs: number | null }

function sandbox() {
  const home = mkdtempSync(join(tmpdir(), 'hoai-zombie-home-'))
  const cwd = mkdtempSync(join(tmpdir(), 'hoai-zombie-agent-'))
  writeFileSync(join(cwd, '.bgos-agent-id'), `${ID}\n`)
  const stateDir = join(home, '.bgos-agent', ID)
  mkdirSync(stateDir, { recursive: true })
  const claim = join(stateDir, SUPERVISOR_FILE_NAME)
  const status = () => (existsSync(join(stateDir, LAUNCH_STATUS_FILE_NAME)) ? readFileSync(join(stateDir, LAUNCH_STATUS_FILE_NAME), 'utf8') : '')
  const cleanup = () => {
    rmSync(home, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
  return { home, cwd, stateDir, claim, status, cleanup }
}

/** A fake holder process: alive or not, what it runs, its children, how it takes signals. */
function fakeHolder(over: Partial<{ alive: boolean; command: string | null; children: Child[] | null; diesOn: string[] }> = {}) {
  return {
    alive: true,
    command: HOAI_CMD as string | null,
    children: [{ pid: 4300, zombie: true, name: 'claude', startedAtMs: STAMP_MS + 5_000 }] as Child[] | null,
    diesOn: ['SIGKILL'],
    ...over,
  }
}

function childStaysUp() {
  const child = new EventEmitter() as EventEmitter & { kill: () => void; pid: number }
  child.pid = 7777
  child.kill = () => setImmediate(() => child.emit('exit', null, 'SIGTERM'))
  setImmediate(() => child.emit('exit', 0, null))
  return child
}

async function launch(sb: ReturnType<typeof sandbox>, holder: ReturnType<typeof fakeHolder>, extra: Record<string, unknown> = {}) {
  let clock = STAMP_MS + 2 * 86_400_000
  const signals: Array<[number, string]> = []
  const spawns: string[][] = []
  const prints: string[] = []
  const code = await superviseClaude(ARGS, {
    platform: 'linux',
    env: SUPERVISED,
    home: sb.home,
    cwd: sb.cwd,
    scriptDir: '/home/kc/bgos-claude-plugin/bin',
    hasExpect: true,
    listProcesses: () => [],
    bootClock: () => null,
    print: (l: string) => prints.push(l),
    writeErr: () => {},
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms
    },
    healthyMs: 60_000,
    pidAlive: (pid: number) => (pid === HOLDER ? holder.alive : false),
    pidProcess: (pid: number) => (pid === HOLDER && holder.alive ? { command: holder.command, startedAtMs: STAMP_MS - 1_000 } : null),
    holderChildren: (pid: number) => (pid === HOLDER ? holder.children : null),
    signalPid: (pid: number, signal: string) => {
      signals.push([pid, signal])
      if (pid === HOLDER && holder.diesOn.includes(signal)) holder.alive = false
      return true
    },
    startWatchdog: () => ({ stop() {} }),
    spawnImpl: ((_file: string, args: readonly string[]) => {
      spawns.push([...args])
      return childStaysUp()
    }) as never,
    ...extra,
  } as never)
  return { code, signals, spawns, prints }
}

// -- 1 and 3: a holder that supervises nothing is taken over -------------------

test('agent 867: a live holder whose claude is a zombie and which ignores TERM is ended with KILL, then the agent launches', async () => {
  const sb = sandbox()
  try {
    writeFileSync(sb.claim, supervisorFileBody(HOLDER, STAMP))
    const holder = fakeHolder({ diesOn: ['SIGKILL'] })
    const r = await launch(sb, holder)
    assert.deepEqual(r.signals, [
      [HOLDER, 'SIGTERM'],
      [HOLDER, 'SIGKILL'],
    ], r.prints.join('\n'))
    assert.equal(r.spawns.length, 1, 'the agent is launched once the holder is gone')
    assert.equal(r.code, 0)
    assert.ok(r.prints.some((l) => /took over assistant 900 from launcher pid 4242/.test(l)), r.prints.join('\n'))
  } finally {
    sb.cleanup()
  }
})

test('a live holder with no child at all is ended (TERM is enough when it takes it) and the agent launches', async () => {
  const sb = sandbox()
  try {
    writeFileSync(sb.claim, supervisorFileBody(HOLDER, STAMP))
    const holder = fakeHolder({ children: [], diesOn: ['SIGTERM', 'SIGKILL'] })
    const r = await launch(sb, holder)
    assert.deepEqual(r.signals, [[HOLDER, 'SIGTERM']])
    assert.equal(r.spawns.length, 1)
  } finally {
    sb.cleanup()
  }
})

// -- controls: a live child stays supervised, a healthy holder is never taken over

test('control: a holder whose claude is alive stays the owner: exit 3, no signal, no second session', async () => {
  const sb = sandbox()
  try {
    writeFileSync(sb.claim, supervisorFileBody(HOLDER, STAMP))
    const holder = fakeHolder({ children: [{ pid: 4300, zombie: false, name: 'claude', startedAtMs: STAMP_MS + 5_000 }] })
    const r = await launch(sb, holder)
    assert.equal(r.code, EXIT_ALREADY_SUPERVISED)
    assert.deepEqual(r.signals, [])
    assert.equal(r.spawns.length, 0)
    assert.equal(readFileSync(sb.claim, 'utf8'), supervisorFileBody(HOLDER, STAMP), 'the owner\'s claim is left alone')
    assert.match(sb.status(), /outcome=already-supervised owner=4242/)
  } finally {
    sb.cleanup()
  }
})

test('control: a holder whose children cannot be read keeps the claim (unknown is never stale)', async () => {
  const sb = sandbox()
  try {
    writeFileSync(sb.claim, supervisorFileBody(HOLDER, STAMP))
    const r = await launch(sb, fakeHolder({ children: null }))
    assert.equal(r.code, EXIT_ALREADY_SUPERVISED)
    assert.deepEqual(r.signals, [])
    assert.equal(r.spawns.length, 0)
  } finally {
    sb.cleanup()
  }
})

test('control: a holder whose command line cannot be read is never signalled, whatever its children', async () => {
  const sb = sandbox()
  try {
    writeFileSync(sb.claim, supervisorFileBody(HOLDER, STAMP))
    const r = await launch(sb, fakeHolder({ command: null }))
    assert.equal(r.code, EXIT_ALREADY_SUPERVISED)
    assert.deepEqual(r.signals, [])
    assert.equal(r.spawns.length, 0)
  } finally {
    sb.cleanup()
  }
})

test('control: a holder that is only between two children (its claude comes back inside the confirm window) is never signalled', async () => {
  const sb = sandbox()
  try {
    writeFileSync(sb.claim, supervisorFileBody(HOLDER, STAMP))
    const holder = fakeHolder({ children: [] })
    let reads = 0
    const r = await launch(sb, holder, {
      holderChildren: (pid: number) => {
        if (pid !== HOLDER) return null
        reads += 1
        return reads < 3 ? [] : [{ pid: 4301, zombie: false, name: 'claude', startedAtMs: STAMP_MS + 9_000 }]
      },
    })
    assert.equal(r.code, EXIT_ALREADY_SUPERVISED)
    assert.deepEqual(r.signals, [])
    assert.equal(r.spawns.length, 0)
  } finally {
    sb.cleanup()
  }
})

// -- never a double launch --------------------------------------------------------

test('never another agent\'s launcher: an idle hoai holder that runs in another folder (a reused pid) is never signalled', async () => {
  const sb = sandbox()
  try {
    writeFileSync(sb.claim, supervisorFileBody(HOLDER, STAMP))
    const r = await launch(sb, fakeHolder(), { holderInFolder: () => false })
    assert.equal(r.code, EXIT_ALREADY_SUPERVISED)
    assert.deepEqual(r.signals, [])
    assert.equal(r.spawns.length, 0)
  } finally {
    sb.cleanup()
  }
})

test('where the folder cannot be read, only a holder that started before its own stamp is taken over', () => {
  const idle = (startedAtMs: number) =>
    decideSupervisorArming({
      existingRaw: supervisorFileBody(HOLDER, STAMP),
      ownPid: 1,
      pidAlive: () => true,
      pidProcess: () => ({ command: HOAI_CMD, startedAtMs }),
      holderChildren: () => [],
      holderInFolder: () => null,
      now: STAMP_MS + 86_400_000,
    } as never) as { takeover?: boolean }
  assert.equal(idle(STAMP_MS - 5_000).takeover, true, 'the writer itself')
  assert.equal(idle(STAMP_MS + 20_000).takeover, undefined, 'inside the writer slack: maybe a reused pid, left alone')
})

test('never a double launch: a holder that survives KILL keeps the agent (named outcome, exit 3, nothing spawned)', async () => {
  const sb = sandbox()
  try {
    writeFileSync(sb.claim, supervisorFileBody(HOLDER, STAMP))
    const r = await launch(sb, fakeHolder({ diesOn: [] }))
    assert.deepEqual(r.signals, [
      [HOLDER, 'SIGTERM'],
      [HOLDER, 'SIGKILL'],
    ])
    assert.equal(r.code, EXIT_ALREADY_SUPERVISED)
    assert.equal(r.spawns.length, 0)
    assert.match(sb.status(), /outcome=stale-launcher-unkillable owner=4242/)
  } finally {
    sb.cleanup()
  }
})

test('never a double launch: while another launcher holds the takeover lock, this one stands down without a signal', async () => {
  const sb = sandbox()
  try {
    writeFileSync(sb.claim, supervisorFileBody(HOLDER, STAMP))
    writeFileSync(`${sb.claim}.takeover`, JSON.stringify({ pid: OTHER, startedAt: new Date(STAMP_MS + 2 * 86_400_000 - 1_000).toISOString() }))
    const r = await launch(sb, fakeHolder(), { pidAlive: (pid: number) => pid === HOLDER || pid === OTHER })
    assert.equal(r.code, EXIT_ALREADY_SUPERVISED)
    assert.deepEqual(r.signals, [])
    assert.equal(r.spawns.length, 0)
    assert.match(sb.status(), /outcome=takeover-in-progress/)
    assert.ok(existsSync(`${sb.claim}.takeover`), 'the other launcher\'s lock is not ours to remove')
  } finally {
    sb.cleanup()
  }
})

// -- 4: an empty lock is stale -----------------------------------------------------

test('an empty takeover lock (a launcher that died before writing it) is stale: the takeover proceeds and the lock is gone after', async () => {
  const sb = sandbox()
  try {
    writeFileSync(sb.claim, supervisorFileBody(HOLDER, STAMP))
    writeFileSync(`${sb.claim}.takeover`, '')
    const r = await launch(sb, fakeHolder({ diesOn: ['SIGTERM', 'SIGKILL'] }))
    assert.deepEqual(r.signals, [[HOLDER, 'SIGTERM']])
    assert.equal(r.spawns.length, 1)
    assert.equal(existsSync(`${sb.claim}.takeover`), false)
  } finally {
    sb.cleanup()
  }
})

test('an empty, blank or zero-filled supervisor.json is stale: the agent launches', async () => {
  for (const body of ['', '\n', '\u0000\u0000\u0000\u0000']) {
    const sb = sandbox()
    try {
      writeFileSync(sb.claim, body)
      const r = await launch(sb, fakeHolder({ alive: false }))
      assert.equal(r.spawns.length, 1, JSON.stringify(body))
      assert.deepEqual(r.signals, [])
    } finally {
      sb.cleanup()
    }
  }
})

// -- 2: a launcher between children says so ----------------------------------------

test('a keep-alive launcher in its backoff names its relaunch deadline, so a reader never takes it over for having no child', async () => {
  const sb = sandbox()
  try {
    let clock = STAMP_MS
    const seen: string[] = []
    let n = 0
    const controller = new AbortController()
    const code = await superviseClaude(ARGS, {
      platform: 'linux',
      env: {},
      keepAlive: true,
      signal: controller.signal,
      home: sb.home,
      cwd: sb.cwd,
      scriptDir: '/home/kc/bgos-claude-plugin/bin',
      hasExpect: true,
      listProcesses: () => [],
      bootClock: () => null,
      print: () => {},
      writeErr: () => {},
      now: () => clock,
      healthyMs: 60_000,
      startWatchdog: () => ({ stop() {} }),
      sleep: async (ms: number) => {
        seen.push(readFileSync(sb.claim, 'utf8'))
        clock += ms
        controller.abort()
      },
      spawnImpl: (() => {
        n += 1
        const child = new EventEmitter() as EventEmitter & { kill: () => void; pid: number }
        child.pid = 8000 + n
        child.kill = () => setImmediate(() => child.emit('exit', null, 'SIGTERM'))
        setImmediate(() => child.emit('exit', 1, null))
        return child
      }) as never,
    } as never)
    assert.equal(code, 1)
    assert.equal(seen.length, 1, 'one backoff')
    const during = seen[0]!
    const parsed = JSON.parse(during)
    assert.equal(parsed.pid, process.pid)
    const deadline = Date.parse(parsed.relaunchBy)
    assert.ok(Number.isFinite(deadline) && deadline > STAMP_MS && deadline <= STAMP_MS + 60_000, during)
    // What another launcher reads during that backoff: the holder has no child, and is not stale.
    const owner = { command: HOAI_CMD, startedAtMs: STAMP_MS - 1_000 }
    const atBackoff = decideSupervisorArming({ existingRaw: during, ownPid: 1, pidAlive: () => true, pidProcess: () => owner, holderChildren: () => [], now: STAMP_MS + 1_000 } as never)
    assert.deepEqual(atBackoff, { arm: false, ownerPid: process.pid })
    // The same holder with no deadline named, past its window, supervises nothing.
    const plain = decideSupervisorArming({ existingRaw: supervisorFileBody(process.pid, STAMP), ownPid: 1, pidAlive: () => true, pidProcess: () => owner, holderChildren: () => [], now: STAMP_MS + 1_000 } as never)
    assert.equal((plain as { takeover?: boolean }).takeover, true)
  } finally {
    sb.cleanup()
  }
})

test('a relaunch deadline is honoured only inside the backoff it can be: one past its time, or further out than any backoff (a clock that jumped), is not', () => {
  const owner = { command: HOAI_CMD, startedAtMs: STAMP_MS - 1_000 }
  const decide = (relaunchBy: string, now: number) =>
    decideSupervisorArming({
      existingRaw: JSON.stringify({ pid: HOLDER, capabilities: ['relaunch'], startedAt: STAMP, relaunchBy }),
      ownPid: 1,
      pidAlive: () => true,
      pidProcess: () => owner,
      holderChildren: () => [],
      now,
    } as never) as { arm: boolean; takeover?: boolean }
  assert.equal(decide(new Date(STAMP_MS + 30_000).toISOString(), STAMP_MS + 10_000).takeover, undefined, 'inside: kept')
  assert.equal(decide(new Date(STAMP_MS + 30_000).toISOString(), STAMP_MS + 10 * 60_000).takeover, true, 'long past: stale')
  assert.equal(decide(new Date(STAMP_MS + 3 * 86_400_000).toISOString(), STAMP_MS).takeover, true, 'days ahead: no backoff is that long')
})

// -- 5: the pin follows a fresh session the launcher started ------------------------

function transcriptOf(sb: ReturnType<typeof sandbox>, id: string) {
  return sessionTranscriptPath(sb.home, sb.cwd, id, '')
}

async function runFreshRetryThenDie(sb: ReturnType<typeof sandbox>, at: number) {
  // A: resumes the pin S0, which is rejected at once; the fresh retry S1 starts and
  // stays up, and A never gets any further (its loop stopped, a KILL, a power cut):
  // its promise is simply left pending here, its timers unref'd, its claim behind it.
  const fresh = '11111111-1111-4111-8111-111111111111'
  const spawns: string[][] = []
  void superviseClaude(ARGS, {
    platform: 'linux',
    env: SUPERVISED,
    home: sb.home,
    cwd: sb.cwd,
    scriptDir: '/home/kc/bgos-claude-plugin/bin',
    hasExpect: true,
    listProcesses: () => [],
    bootClock: () => null,
    print: () => {},
    writeErr: () => {},
    now: () => at,
    healthyMs: 60_000,
    generateId: () => fresh,
    startWatchdog: () => ({ stop() {} }),
    spawnImpl: ((_file: string, args: readonly string[]) => {
      spawns.push([...args])
      const child = new EventEmitter() as EventEmitter & { kill: () => void; pid: number }
      child.pid = 9000 + spawns.length
      child.kill = () => {}
      if (spawns.length === 1) setImmediate(() => child.emit('exit', 1, null))
      return child
    }) as never,
  } as never)
  const deadline = Date.now() + 3_000
  while (spawns.length < 2) {
    if (Date.now() > deadline) assert.fail('the fresh retry never started')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  return { spawns, fresh }
}

async function nextLaunchArgs(sb: ReturnType<typeof sandbox>, at: number) {
  const spawns: string[][] = []
  await superviseClaude(ARGS, {
    platform: 'linux',
    env: SUPERVISED,
    home: sb.home,
    cwd: sb.cwd,
    scriptDir: '/home/kc/bgos-claude-plugin/bin',
    hasExpect: true,
    listProcesses: () => [],
    bootClock: () => null,
    print: () => {},
    writeErr: () => {},
    now: () => at,
    healthyMs: 60_000,
    startWatchdog: () => ({ stop() {} }),
    spawnImpl: ((_file: string, args: readonly string[]) => {
      spawns.push([...args])
      return childStaysUp()
    }) as never,
  } as never)
  return spawns[0]!.join(' ')
}

test('agent 867 second bug: a fresh session the launcher started and that outlived the health window is what the next launch resumes, even when the launcher never got to pin it', async () => {
  const sb = sandbox()
  try {
    const old = '00000000-0000-4000-8000-000000000010'
    writeFileSync(join(sb.stateDir, SESSION_ID_FILE_NAME), `${old}\n`)
    const t0 = transcriptOf(sb, old)
    mkdirSync(join(t0, '..'), { recursive: true })
    writeFileSync(t0, '{}\n')
    const at = STAMP_MS
    const a = await runFreshRetryThenDie(sb, at)
    assert.match(a.spawns[0]!.join(' '), new RegExp(`--resume\\} \\{${old}`))
    assert.match(a.spawns[1]!.join(' '), new RegExp(`--session-id\\} \\{${a.fresh}`))
    // The fresh session ran on for two days without its launcher: its transcript says so.
    const t1 = transcriptOf(sb, a.fresh)
    writeFileSync(t1, '{}\n')
    const lastWrite = new Date(at + 2 * 86_400_000)
    utimesSync(t1, lastWrite, lastWrite)
    const next = await nextLaunchArgs(sb, at + 2 * 86_400_000 + 60_000)
    assert.match(next, new RegExp(`--resume\\} \\{${a.fresh}`), next)
    assert.equal(readFileSync(join(sb.stateDir, SESSION_ID_FILE_NAME), 'utf8').trim(), a.fresh)
  } finally {
    sb.cleanup()
  }
})

test('control (zaid 2026-09-02): a fresh session that died inside the health window never takes the pin; the next launch resumes the old session', async () => {
  const sb = sandbox()
  try {
    const old = '00000000-0000-4000-8000-000000000010'
    writeFileSync(join(sb.stateDir, SESSION_ID_FILE_NAME), `${old}\n`)
    const t0 = transcriptOf(sb, old)
    mkdirSync(join(t0, '..'), { recursive: true })
    writeFileSync(t0, '{}\n')
    const at = STAMP_MS
    const a = await runFreshRetryThenDie(sb, at)
    const t1 = transcriptOf(sb, a.fresh)
    writeFileSync(t1, '{}\n')
    const lastWrite = new Date(at + 5_000)
    utimesSync(t1, lastWrite, lastWrite)
    const next = await nextLaunchArgs(sb, at + 86_400_000)
    assert.match(next, new RegExp(`--resume\\} \\{${old}`), next)
    assert.equal(readFileSync(join(sb.stateDir, SESSION_ID_FILE_NAME), 'utf8').trim(), old)
  } finally {
    sb.cleanup()
  }
})

// -- 2: a wedged launcher releases its own claim ------------------------------------

test('decideWatchdogAction: only a launcher whose loop has stopped AND whose claude is gone releases its claim', () => {
  const { decideWatchdogAction } = core as unknown as {
    decideWatchdogAction: (input: { beatAgeMs: number; wedgeMs: number; children: Array<{ zombie: boolean }> | null }) => 'release' | 'none'
  }
  assert.equal(typeof decideWatchdogAction, 'function')
  const zombie = [{ zombie: true }]
  const live = [{ zombie: false }]
  assert.equal(decideWatchdogAction({ beatAgeMs: 120_000, wedgeMs: 60_000, children: zombie }), 'release', 'the 867 shape')
  assert.equal(decideWatchdogAction({ beatAgeMs: 120_000, wedgeMs: 60_000, children: [] }), 'release', 'no child at all')
  assert.equal(decideWatchdogAction({ beatAgeMs: 1_000, wedgeMs: 60_000, children: zombie }), 'none', 'a loop that still runs reaps and relaunches by itself')
  assert.equal(decideWatchdogAction({ beatAgeMs: 120_000, wedgeMs: 60_000, children: live }), 'none', 'a stuck loop over a live claude: the agent is up, leave it')
  assert.equal(decideWatchdogAction({ beatAgeMs: 120_000, wedgeMs: 60_000, children: null }), 'none', 'unreadable children prove nothing')
})

test('superviseClaude arms the watchdog once it holds the claim, and stops it on the way out', async () => {
  const sb = sandbox()
  try {
    const calls: Array<{ claimPath: string; pid: number }> = []
    let stopped = 0
    const r = await launch(sb, fakeHolder({ alive: false }), {
      startWatchdog: (opts: { claimPath: string; pid: number }) => {
        calls.push({ claimPath: opts.claimPath, pid: opts.pid })
        return { stop: () => (stopped += 1) }
      },
    })
    assert.equal(r.spawns.length, 1)
    assert.deepEqual(calls, [{ claimPath: sb.claim, pid: process.pid }])
    assert.equal(stopped, 1)
  } finally {
    sb.cleanup()
  }
})
