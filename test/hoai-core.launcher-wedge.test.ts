/**
 * The kc-server wedge of 2026-10-29/30 (David 873, Ava 871, nono 1104: dark
 * about 8 h, about 400 restarts each), with fake processes in a scratch HOME.
 * The real-process proof is test/hoai-core.launcher-wedge.real.test.ts; this
 * file pins each decision on its own, on every platform:
 *
 *   1. a launcher never waits for good on its own child: a stop (or a
 *      relaunch) is TERM, then KILL (the claude under expect first), then no
 *      more waiting, and the claim goes either way;
 *   2. an expect that runs no live claude any more is ended by its own
 *      launcher, which then goes on (relaunches or lets go);
 *   3. "already supervised" needs a LIVE claude: a holder whose expect runs
 *      none (a zombie, or nothing) is taken over, its expect ended with it,
 *      but only an expect whose script names THIS agent's state dir.
 * And the controls: a live claude under expect is never touched, children
 * that cannot be read prove nothing, a child that ends on TERM gets no KILL.
 *
 * Run: npx tsx --test test/hoai-core.launcher-wedge.test.ts
 */

import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import * as core from '../bin/hoai-core.mjs'

const { EXIT_ALREADY_SUPERVISED, LAUNCH_STATUS_FILE_NAME, SUPERVISOR_FILE_NAME, decideSupervisorArming, superviseClaude, supervisorFileBody, tclQuote } = core

const ID = '873'
const SUPERVISED = { HOAI_SUPERVISED: '1', HOAI_SUPERVISED_ASSISTANT_ID: ID }
const ARGS = ['--dangerously-load-development-channels', 'server:bgos']
const HOLDER = 1422734
const EXPECT = 1422790
const ZOMBIE = 1422823
const STAMP = '2026-10-29T22:27:22.000Z'
const STAMP_MS = Date.parse(STAMP)
const HOAI_CMD = '/usr/bin/node /home/karim/bgos-claude-plugin/bin/hoai-core.mjs'

type Row = { pid: number; zombie: boolean; name: string; startedAtMs: number | null }

function sandbox() {
  const home = mkdtempSync(join(tmpdir(), 'hoai-wedge-home-'))
  const cwd = mkdtempSync(join(tmpdir(), 'hoai-wedge-agent-'))
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

/** The command line ps shows for the supervised expect of `stateDir` (its script's first line). */
const expectCommand = (stateDir: string) => `expect -c set hoai_statedir ${tclQuote(stateDir)}\\012set hoai_extra_settle 0\\012...`

// -- 3: the verdict -------------------------------------------------------------------

function verdict(under: Row[] | null, { command = (sd: string) => expectCommand(sd), stateDir = '/home/karim/.bgos-agent/873' } = {}) {
  return decideSupervisorArming({
    existingRaw: supervisorFileBody(HOLDER, STAMP),
    ownPid: 1,
    pidAlive: () => true,
    pidProcess: (pid: number) =>
      pid === HOLDER ? { command: HOAI_CMD, startedAtMs: STAMP_MS - 1_000 } : pid === EXPECT ? { command: command(stateDir), startedAtMs: STAMP_MS } : null,
    holderChildren: (pid: number) =>
      pid === HOLDER ? [{ pid: EXPECT, zombie: false, name: 'expect', startedAtMs: null }] : pid === EXPECT ? under : null,
    holderInFolder: () => true,
    stateDir,
    now: STAMP_MS + 8 * 3_600_000,
  } as never)
}

test('verdict: a holder whose expect runs a ZOMBIE claude supervises nothing: takeover, reason claude-zombie, its expect named', () => {
  assert.deepEqual(verdict([{ pid: ZOMBIE, zombie: true, name: 'claude', startedAtMs: null }]), {
    arm: false,
    ownerPid: HOLDER,
    takeover: true,
    reason: 'claude-zombie',
    stuckExpects: [EXPECT],
  })
})

test('verdict: a holder whose expect runs NO claude at all supervises nothing: takeover, reason claude-missing', () => {
  assert.deepEqual(verdict([]), { arm: false, ownerPid: HOLDER, takeover: true, reason: 'claude-missing', stuckExpects: [EXPECT] })
})

test('verdict control: a LIVE claude under the expect is supervising, beside a zombie or not', () => {
  assert.deepEqual(verdict([{ pid: 1422900, zombie: false, name: 'claude', startedAtMs: null }]), { arm: false, ownerPid: HOLDER })
  assert.deepEqual(
    verdict([
      { pid: ZOMBIE, zombie: true, name: 'claude', startedAtMs: null },
      { pid: 1422900, zombie: false, name: 'claude', startedAtMs: null },
    ]),
    { arm: false, ownerPid: HOLDER },
  )
})

test('verdict control: what runs under the expect cannot be read: it proves nothing, the claim stands', () => {
  assert.deepEqual(verdict(null), { arm: false, ownerPid: HOLDER })
})

test('verdict control: an idle expect is ended only when its script names THIS agent\'s state dir', () => {
  const zombie = [{ pid: ZOMBIE, zombie: true, name: 'claude', startedAtMs: null }]
  // Another agent's (a prefix of this one's state dir included), none, or unreadable: not proven this agent's.
  assert.deepEqual(verdict(zombie, { command: () => expectCommand('/home/karim/.bgos-agent/1104') }), { arm: false, ownerPid: HOLDER })
  assert.deepEqual(verdict(zombie, { command: () => expectCommand('/home/karim/.bgos-agent/87') }), { arm: false, ownerPid: HOLDER })
  assert.deepEqual(verdict(zombie, { command: () => 'expect -c spawn claude' }), { arm: false, ownerPid: HOLDER })
  assert.deepEqual(verdict(zombie, { command: () => null as never }), { arm: false, ownerPid: HOLDER })
  assert.deepEqual(verdict(zombie, { stateDir: '' }), { arm: false, ownerPid: HOLDER }, 'no state dir to compare: never')
})

test('verdict control: a live child that is not an expect (claude itself, a Windows launch) is supervising whatever runs under it', () => {
  const v = decideSupervisorArming({
    existingRaw: supervisorFileBody(HOLDER, STAMP),
    ownPid: 1,
    pidAlive: () => true,
    // Even a command line that names this state dir: only an expect is judged by what runs under it.
    pidProcess: (pid: number) =>
      pid === HOLDER ? { command: HOAI_CMD, startedAtMs: STAMP_MS - 1_000 } : { command: expectCommand('/home/karim/.bgos-agent/873'), startedAtMs: null },
    holderChildren: (pid: number) => (pid === HOLDER ? [{ pid: 4300, zombie: false, name: 'claude', startedAtMs: null }] : []),
    holderInFolder: () => true,
    stateDir: '/home/karim/.bgos-agent/873',
    now: STAMP_MS + 8 * 3_600_000,
  } as never)
  assert.deepEqual(v, { arm: false, ownerPid: HOLDER })
})

// -- 3: the takeover itself ----------------------------------------------------------------

function staysUp() {
  const child = new EventEmitter() as EventEmitter & { kill: () => void; pid: number }
  child.pid = 7777
  child.kill = () => setImmediate(() => child.emit('exit', null, 'SIGTERM'))
  setImmediate(() => child.emit('exit', 0, null))
  return child
}

async function takeOver(sb: ReturnType<typeof sandbox>, under: Row[] | ((termed: boolean) => Row[]), { ownerDiesOnTerm = false } = {}) {
  let clock = STAMP_MS + 8 * 3_600_000
  const world = { holder: true, expect: true }
  const signals: Array<[number, string]> = []
  const spawns: string[][] = []
  const prints: string[] = []
  const code = await superviseClaude(ARGS, {
    platform: 'linux',
    env: SUPERVISED,
    home: sb.home,
    cwd: sb.cwd,
    scriptDir: '/home/karim/bgos-claude-plugin/bin',
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
    pidAlive: (pid: number) => (pid === HOLDER ? world.holder : pid === EXPECT ? world.expect : false),
    pidProcess: (pid: number) =>
      pid === HOLDER && world.holder
        ? { command: HOAI_CMD, startedAtMs: STAMP_MS - 1_000 }
        : pid === EXPECT && world.expect
          ? { command: expectCommand(sb.stateDir), startedAtMs: STAMP_MS }
          : null,
    holderChildren: (pid: number) =>
      pid === HOLDER
        ? world.expect
          ? [{ pid: EXPECT, zombie: false, name: 'expect', startedAtMs: null }]
          : []
        : pid === EXPECT
          ? typeof under === 'function'
            ? under(signals.some(([p, sig]) => p === HOLDER && sig === 'SIGTERM'))
            : under
          : null,
    holderInFolder: () => true,
    signalPid: (pid: number, signal: string) => {
      signals.push([pid, signal])
      // The kc-server owner: its stop is spent (TERM changes nothing), it lets go once its expect
      // exits, and its expect ignores everything but KILL.
      if (pid === EXPECT && signal === 'SIGKILL') {
        world.expect = false
        world.holder = false
      }
      if (pid === HOLDER && (signal === 'SIGKILL' || (signal === 'SIGTERM' && ownerDiesOnTerm))) world.holder = false
      return true
    },
    startWatchdog: () => ({ stop() {} }),
    spawnImpl: ((_file: string, args: readonly string[]) => {
      spawns.push([...args])
      return staysUp()
    }) as never,
  } as never)
  return { code, signals, spawns, prints, world }
}

test('takeover: the kc-server owner (its expect over a zombie claude, its stop spent) is TERMed, its expect KILLed, and the agent launches', { timeout: 10_000 }, async () => {
  const sb = sandbox()
  try {
    writeFileSync(sb.claim, supervisorFileBody(HOLDER, STAMP))
    const r = await takeOver(sb, [{ pid: ZOMBIE, zombie: true, name: 'claude', startedAtMs: null }])
    assert.deepEqual(r.signals, [
      [HOLDER, 'SIGTERM'],
      [EXPECT, 'SIGKILL'],
    ], r.prints.join('\n'))
    assert.equal(r.code, 0, r.prints.join('\n'))
    assert.equal(r.spawns.length, 1)
    assert.ok(r.prints.some((l) => l.includes(`launcher pid ${HOLDER} holds assistant ${ID} but supervises nothing (its claude has exited and was never reaped)`)), r.prints.join('\n'))
    assert.ok(r.prints.some((l) => l.includes(`ending its expect (pid ${EXPECT}), which runs no live claude, with SIGKILL`)), r.prints.join('\n'))
    assert.match(sb.status(), new RegExp(`outcome=took-over owner=${HOLDER} reason=claude-zombie`))
  } finally {
    sb.cleanup()
  }
})

test('takeover: an owner whose expect runs no claude at all is taken over the same way (reason claude-missing)', { timeout: 10_000 }, async () => {
  const sb = sandbox()
  try {
    writeFileSync(sb.claim, supervisorFileBody(HOLDER, STAMP))
    const r = await takeOver(sb, [])
    assert.deepEqual(r.signals, [
      [HOLDER, 'SIGTERM'],
      [EXPECT, 'SIGKILL'],
    ])
    assert.equal(r.spawns.length, 1)
    assert.ok(r.prints.some((l) => l.includes('(its expect runs no claude)')), r.prints.join('\n'))
    assert.match(sb.status(), /reason=claude-missing/)
  } finally {
    sb.cleanup()
  }
})

test('takeover: an owner that dies of the TERM does not leave its stuck expect behind, orphaned over the zombie', { timeout: 10_000 }, async () => {
  const sb = sandbox()
  try {
    writeFileSync(sb.claim, supervisorFileBody(HOLDER, STAMP))
    const r = await takeOver(sb, [{ pid: ZOMBIE, zombie: true, name: 'claude', startedAtMs: null }], { ownerDiesOnTerm: true })
    assert.deepEqual(r.signals, [
      [HOLDER, 'SIGTERM'],
      [EXPECT, 'SIGKILL'],
    ], r.prints.join('\n'))
    assert.equal(r.world.expect, false)
    assert.equal(r.spawns.length, 1)
  } finally {
    sb.cleanup()
  }
})

test('takeover control: an expect that runs a live claude again by the time of the KILL is not killed (it is read again first)', { timeout: 10_000 }, async () => {
  const sb = sandbox()
  try {
    writeFileSync(sb.claim, supervisorFileBody(HOLDER, STAMP))
    const r = await takeOver(sb, (termed) =>
      termed ? [{ pid: 1422901, zombie: false, name: 'claude', startedAtMs: null }] : [{ pid: ZOMBIE, zombie: true, name: 'claude', startedAtMs: null }],
    )
    assert.ok(!r.signals.some(([pid]) => pid === EXPECT), JSON.stringify(r.signals))
    assert.equal(r.world.expect, true)
    assert.equal(r.spawns.length, 0, 'and no second session beside it')
  } finally {
    sb.cleanup()
  }
})

test('takeover control: an owner whose expect runs a LIVE claude is never signalled: exit 3, no second session', { timeout: 10_000 }, async () => {
  const sb = sandbox()
  try {
    writeFileSync(sb.claim, supervisorFileBody(HOLDER, STAMP))
    const r = await takeOver(sb, [{ pid: 1422900, zombie: false, name: 'claude', startedAtMs: null }])
    assert.equal(r.code, EXIT_ALREADY_SUPERVISED)
    assert.deepEqual(r.signals, [])
    assert.equal(r.spawns.length, 0)
    assert.match(sb.status(), new RegExp(`outcome=already-supervised owner=${HOLDER}`))
  } finally {
    sb.cleanup()
  }
})

// -- 1 and 2: the launcher's own child --------------------------------------------------

/** A child that ends only on the signals it is told to, recording every one it gets. */
function stubborn(endsOn: string[]) {
  const child = new EventEmitter() as EventEmitter & { kill: (signal?: string) => boolean; unref: () => void; pid: number; got: string[]; unrefed: boolean }
  child.pid = 7000
  child.got = []
  child.unrefed = false
  child.unref = () => {
    child.unrefed = true
  }
  child.kill = (signal?: string) => {
    const sig = signal ?? 'SIGTERM'
    child.got.push(sig)
    if (endsOn.includes(sig)) setImmediate(() => child.emit('exit', null, sig))
    return true
  }
  return child
}

function ownLaunch(sb: ReturnType<typeof sandbox>, child: ReturnType<typeof stubborn>, under: () => Row[] | null, extra: Record<string, unknown> = {}) {
  const killed: Array<[number, string]> = []
  const prints: string[] = []
  const done = superviseClaude(ARGS, {
    platform: 'linux',
    env: SUPERVISED,
    home: sb.home,
    cwd: sb.cwd,
    scriptDir: '/home/karim/bgos-claude-plugin/bin',
    hasExpect: true,
    listProcesses: () => [],
    bootClock: () => null,
    print: (l: string) => prints.push(l),
    writeErr: () => {},
    pidAlive: () => false,
    pidProcess: () => null,
    startWatchdog: () => ({ stop() {} }),
    pollMs: 10,
    childTermWaitMs: 40,
    childKillWaitMs: 40,
    expectIdleConfirmMs: 60,
    readChildren: (pid: number) => (pid === child.pid ? under() : null),
    killPid: (pid: number, signal: string) => {
      killed.push([pid, signal])
      return true
    },
    spawnImpl: (() => child) as never,
    ...extra,
  } as never)
  return { done, killed, prints }
}

async function until(check: () => boolean, what: string) {
  const deadline = Date.now() + 5_000
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

test('stop: an expect that ignores the stop is KILLed (the live claude under it first), and the launch returns and lets go of the claim', { timeout: 10_000 }, async () => {
  const sb = sandbox()
  const stop = new AbortController()
  const child = stubborn(['SIGKILL'])
  try {
    const r = ownLaunch(sb, child, () => [{ pid: 7001, zombie: false, name: 'claude', startedAtMs: null }], { signal: stop.signal })
    await until(() => existsSync(sb.claim), 'the claim')
    stop.abort()
    const code = await r.done
    assert.deepEqual(child.got, ['SIGTERM', 'SIGKILL'])
    assert.deepEqual(r.killed, [[7001, 'SIGKILL']], 'its claude is not left to outlive it in the folder')
    assert.equal(code, 1)
    assert.equal(existsSync(sb.claim), false, 'the claim goes with the launch')
    assert.ok(r.prints.some((l) => /expect \(pid 7000\) is still there 0s after SIGTERM; ending it and the claude under it with SIGKILL/.test(l)), r.prints.join('\n'))
  } finally {
    child.emit('exit', 0, null)
    sb.cleanup()
  }
})

test('stop: a child that even KILL does not end is no longer waited for: the launch returns and the claim goes', { timeout: 10_000 }, async () => {
  const sb = sandbox()
  const stop = new AbortController()
  const child = stubborn([])
  try {
    const r = ownLaunch(sb, child, () => [{ pid: ZOMBIE, zombie: true, name: 'claude', startedAtMs: null }], { signal: stop.signal })
    await until(() => existsSync(sb.claim), 'the claim')
    stop.abort()
    const code = await r.done
    assert.deepEqual(child.got, ['SIGTERM', 'SIGKILL'])
    assert.deepEqual(r.killed, [], 'a zombie is no live claude to kill')
    assert.equal(code, 1)
    assert.equal(existsSync(sb.claim), false)
    assert.ok(r.prints.some((l) => /is still there after SIGKILL; not waiting for it any longer/.test(l)), r.prints.join('\n'))
    assert.equal(child.unrefed, true, 'and its handle no longer keeps the launcher process up')
  } finally {
    child.emit('exit', 0, null)
    sb.cleanup()
  }
})

test('stop control: a child that ends on TERM gets nothing more', { timeout: 10_000 }, async () => {
  const sb = sandbox()
  const stop = new AbortController()
  const child = stubborn(['SIGTERM', 'SIGKILL'])
  try {
    const r = ownLaunch(sb, child, () => [{ pid: 7001, zombie: false, name: 'claude', startedAtMs: null }], { signal: stop.signal })
    await until(() => existsSync(sb.claim), 'the claim')
    stop.abort()
    assert.equal(await r.done, 143)
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.deepEqual(child.got, ['SIGTERM'])
    assert.deepEqual(r.killed, [])
  } finally {
    sb.cleanup()
  }
})

test('a restart marker\'s relaunch is bounded the same way: an expect that ignores TERM is KILLed and the relaunch goes on', { timeout: 10_000 }, async () => {
  const sb = sandbox()
  const stop = new AbortController()
  const children: Array<ReturnType<typeof stubborn>> = []
  try {
    const killed: Array<[number, string]> = []
    const done = superviseClaude(ARGS, {
      platform: 'linux',
      env: SUPERVISED,
      home: sb.home,
      cwd: sb.cwd,
      scriptDir: '/home/karim/bgos-claude-plugin/bin',
      hasExpect: true,
      listProcesses: () => [],
      bootClock: () => null,
      print: () => {},
      writeErr: () => {},
      pidAlive: () => false,
      pidProcess: () => null,
      startWatchdog: () => ({ stop() {} }),
      pollMs: 10,
      childTermWaitMs: 40,
      childKillWaitMs: 40,
      readChildren: () => [{ pid: 7001, zombie: false, name: 'claude', startedAtMs: null }],
      killPid: (pid: number, signal: string) => {
        killed.push([pid, signal])
        return true
      },
      signal: stop.signal,
      spawnImpl: (() => {
        const child = stubborn(['SIGKILL'])
        children.push(child)
        return child
      }) as never,
    } as never)
    await until(() => existsSync(sb.claim), 'the claim')
    writeFileSync(join(sb.stateDir, 'restart-requested.json'), '{}')
    await until(() => children.length === 2, 'the relaunch')
    assert.deepEqual(children[0]!.got, ['SIGTERM', 'SIGKILL'])
    stop.abort()
    await done
  } finally {
    for (const child of children) child.emit('exit', 0, null)
    sb.cleanup()
  }
})

for (const [label, rows] of [
  ['its claude a zombie it never reaped', [{ pid: ZOMBIE, zombie: true, name: 'claude', startedAtMs: null }]],
  ['no claude under it at all', []],
] as const) {
  test(`idle expect (${label}): the launcher ends its own expect and goes on, instead of holding the agent for good`, { timeout: 10_000 }, async () => {
    const sb = sandbox()
    const child = stubborn(['SIGTERM'])
    try {
      const r = ownLaunch(sb, child, () => rows.map((row) => ({ ...row })))
      const code = await r.done
      assert.deepEqual(child.got, ['SIGTERM'])
      assert.equal(code, 143)
      assert.equal(existsSync(sb.claim), false, 'the claim goes with the launch')
      assert.ok(r.prints.some((l) => l.includes('its expect (pid 7000) has not; ending expect so this launch can go on')), r.prints.join('\n'))
    } finally {
      child.emit('exit', 0, null)
      sb.cleanup()
    }
  })
}

for (const [label, under] of [
  ['a live claude under it', () => [{ pid: 7001, zombie: false, name: 'claude', startedAtMs: null }]],
  ['what runs under it cannot be read', () => null],
] as const) {
  test(`idle expect control (${label}): the expect is never ended`, { timeout: 10_000 }, async () => {
    const sb = sandbox()
    const stop = new AbortController()
    const child = stubborn(['SIGTERM'])
    try {
      const r = ownLaunch(sb, child, under as () => Row[] | null, { signal: stop.signal })
      await until(() => existsSync(sb.claim), 'the claim')
      // Well past the confirm window, polled every 10 ms.
      await new Promise((resolve) => setTimeout(resolve, 300))
      assert.deepEqual(child.got, [], 'nothing was sent')
      stop.abort()
      assert.equal(await r.done, 143)
    } finally {
      sb.cleanup()
    }
  })
}

test('idle expect control: a live claude seen between idle reads starts the clock over, so short gaps never add up to an end', { timeout: 10_000 }, async () => {
  const sb = sandbox()
  const stop = new AbortController()
  const child = stubborn(['SIGTERM'])
  let reads = 0
  try {
    // Two idle reads, then a live one, over and over: each idle stretch (about 40 ms) is shorter
    // than the 60 ms confirm window, their sum is far longer.
    const r = ownLaunch(
      sb,
      child,
      () => (++reads % 3 === 0 ? [{ pid: 7001, zombie: false, name: 'claude', startedAtMs: null }] : []),
      { signal: stop.signal },
    )
    await until(() => existsSync(sb.claim), 'the claim')
    await new Promise((resolve) => setTimeout(resolve, 400))
    assert.ok(reads >= 9, `looked often enough (${reads})`)
    assert.deepEqual(child.got, [], 'nothing was sent')
    stop.abort()
    assert.equal(await r.done, 143)
  } finally {
    sb.cleanup()
  }
})
