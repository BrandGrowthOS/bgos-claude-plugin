/**
 * lib/hook-restart.mjs: the ONE restart a daemon asks for itself, right after
 * it registered the private turn hook at boot (Data via Ares, PR #220).
 *
 * Today the boot path (server.ts, the `!PRIVATE_HOOK.registered` block) writes
 * the hook into the clone workspace and only logs "restart this agent to load
 * them": the CLI reads its hooks once, at launch, so every private call keeps
 * refusing until a person restarts the agent. The rule pinned here: exactly one
 * self-requested restart after a SUCCESSFUL registration, never on a plain
 * fresh start, never when the registration was already in place or failed, and
 * single use across the restart it causes (a durable record in the agent's
 * state folder), so the 2-byte restart loop of 2026-10-12 stays dead.
 *
 * Run: npx tsx --test test/hook-restart.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { UpdateRpcHandler } from '../lib/update-rpc'

// Only a missing module reads as missing; a module that does not load is a failure of its own.
const mod: any = await import('../lib/hook-restart.mjs').catch((err) => {
  if (err?.code === 'ERR_MODULE_NOT_FOUND') return null
  throw err
})

const MISSING =
  'lib/hook-restart.mjs is missing: a daemon that registers the private turn hook itself at boot only logs ' +
  '"restart this agent to load them" (server.ts:14783 at main), so the agent stays refused until a person restarts it'
function need(): any {
  if (!mod) assert.fail(MISSING)
  return mod
}

const T0 = 1_800_000_000_000
const RECORD = 'C:\\Users\\kc\\.bgos-agent\\909\\hook-restart.json'
const FOLDER = 'C:\\agents\\vera'
const IDLE = { activeOperations: 0, pendingMessages: 0, pendingPermissions: 0 }

function memFs(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial))
  let failCreate = false
  return {
    files,
    failNextCreate: () => {
      failCreate = true
    },
    exists: (p: string) => files.has(p),
    readFile: (p: string) => files.get(p) ?? null,
    createExclusive: (p: string, text: string) => {
      if (failCreate) {
        failCreate = false
        return 'error'
      }
      if (files.has(p)) return 'exists'
      files.set(p, text)
      return 'ok'
    },
  }
}

const CLAUDE = 7000
const TABLE = [
  { pid: CLAUDE, ppid: 1, command: 'claude --resume 0f0e0d0c-1111-4222-8333-444455556666' },
  { pid: CLAUDE + 1, ppid: CLAUDE, command: 'bun C:\\plugins\\bgos-claude-plugin\\server.ts' },
]
const JOB = { pid: CLAUDE + 2, ppid: CLAUDE, command: 'bash -c source C:\\Users\\kc\\.claude\\shell-snapshots\\snapshot-bash-1.sh && npm run build' }

function rig(o: { outcomes: string[]; fs?: ReturnType<typeof memFs>; took?: boolean | Error; clock?: { now: number }; drainThrows?: boolean }) {
  const m = need()
  const clock = o.clock ?? { now: T0 }
  const fs = o.fs ?? memFs()
  const requests: number[] = []
  const drains: boolean[] = []
  const logs: string[] = []
  const state = {
    active: true,
    draining: false,
    updateLock: false,
    turn: { turnInFlight: false, turnSignal: 'hooks' },
    snapshot: { ...IDLE },
    // What agent-state.json publishes as activityAtMs: boot counts as activity.
    activity: [T0] as Array<number | null>,
    claudePid: CLAUDE as number | null,
    listing: { ok: true, processes: [...TABLE] } as any,
    listings: 0,
    cleared: 0,
    intervals: [] as number[],
  }
  const c = m.createHookRestart({
    outcomes: o.outcomes,
    folders: [FOLDER],
    recordPath: RECORD,
    fs,
    bootAtMs: T0,
    now: () => clock.now,
    ownPid: 4321,
    active: () => state.active,
    draining: () => state.draining,
    updateLockHeld: () => state.updateLock,
    safeState: () => ({ ...state.turn, ...state.snapshot }),
    activityMs: () => state.activity,
    claudePid: () => state.claudePid,
    listProcesses: async () => {
      state.listings += 1
      await new Promise((resolve) => setTimeout(resolve, 1))
      return state.listing
    },
    drain: (on: boolean) => {
      drains.push(on)
      if (on && o.drainThrows) throw new Error('socket disconnect threw')
    },
    requestRestart: async () => {
      requests.push(clock.now)
      if (o.took instanceof Error) throw o.took
      return o.took ?? true
    },
    log: (line: string) => logs.push(line),
    setInterval: (_fn: () => void, ms: number) => {
      state.intervals.push(ms)
      return { unref() {} }
    },
    clearInterval: () => {
      state.cleared += 1
    },
  })
  /** Let `ms` of daemon time pass, the controller ticking on its poll. */
  const pass = async (ms: number) => {
    const end = clock.now + ms
    while (clock.now < end) {
      clock.now += m.HOOK_RESTART_POLL_MS
      await c.tick()
    }
  }
  return { c, clock, fs, requests, drains, logs, state, pass }
}

test('a daemon that registered the private turn hook itself asks for exactly ONE restart, and records it first', async () => {
  const r = rig({ outcomes: ['registered'] })
  r.c.start()
  await r.pass(60 * 60_000)
  assert.equal(r.requests.length, 1, `one restart request after a successful self-registration, got ${r.requests.length}`)
  const record = JSON.parse(r.fs.files.get(RECORD) ?? 'null')
  assert.ok(record, 'the single-use record is on disk')
  assert.equal(record.pid, 4321)
  assert.deepEqual(record.folders, [FOLDER])
  assert.equal(Date.parse(record.requestedAt), r.requests[0], 'written in the same tick, BEFORE the ladder ran')
  assert.deepEqual(r.drains, [true], 'intake drained before the ladder, as the scheduled update does')
  assert.ok(r.state.cleared >= 1, 'its poll stops once it asked')
  assert.ok(r.logs.every((l) => l.startsWith('hook restart: ')))
})

test('not before the daemon has run a minute, even with no activity on record: the floor the marker takeover keeps', async () => {
  const r = rig({ outcomes: ['registered'] })
  r.state.activity = []
  for (const at of [1_000, 30_000, 59_999]) {
    r.clock.now = T0 + at
    await r.c.tick()
  }
  assert.equal(r.requests.length, 0)
  assert.equal(r.fs.files.has(RECORD), false, 'nothing recorded while it waits')
  r.clock.now = T0 + 60_000
  await r.c.tick()
  assert.equal(r.requests.length, 1)
  assert.ok(r.requests[0] - T0 >= need().HOOK_RESTART_MIN_UP_MS)
  assert.ok(need().HOOK_RESTART_MIN_UP_MS > 25_000, 'longer than keepalive.sh\'s 25 s "resumed session died" rule')
})

test('a passive daemon never asks; it asks once it holds the pairing lock', async () => {
  const r = rig({ outcomes: ['registered'] })
  r.state.active = false
  await r.pass(40 * 60_000)
  assert.equal(r.requests.length, 0)
  assert.equal(r.fs.files.has(RECORD), false)
  r.state.active = true
  await r.pass(60_000)
  assert.equal(r.requests.length, 1)
})

test('a live turn, an owed reply, a pending permission or a running delivery holds it, without even listing processes', async () => {
  const r = rig({ outcomes: ['registered'] })
  r.state.turn = { turnInFlight: true, turnSignal: 'hooks' }
  await r.pass(20 * 60_000)
  r.state.turn = { turnInFlight: false, turnSignal: 'hooks' }
  for (const busy of [{ pendingMessages: 2 }, { pendingPermissions: 1 }, { activeOperations: 1 }]) {
    r.state.snapshot = { ...IDLE, ...busy }
    await r.pass(20 * 60_000)
  }
  assert.equal(r.requests.length, 0)
  assert.equal(r.state.listings, 0)
  assert.deepEqual(r.drains, [])
  r.state.snapshot = { ...IDLE }
  await r.pass(60_000)
  assert.equal(r.requests.length, 1)
})

test('recent activity holds it: 10 minutes of quiet with the hook turn signal, 30 without (the watcher\'s own rule)', async () => {
  const hooks = rig({ outcomes: ['registered'] })
  hooks.state.activity = [T0, T0 + 5 * 60_000]
  await hooks.pass(60 * 60_000)
  assert.equal(hooks.requests.length, 1)
  assert.ok(hooks.requests[0] >= T0 + 15 * 60_000 && hooks.requests[0] < T0 + 16 * 60_000, `asked at +${(hooks.requests[0] - T0) / 1000} s`)
  const legacy = rig({ outcomes: ['registered'] })
  legacy.state.turn = { turnInFlight: false, turnSignal: 'none' }
  await legacy.pass(60 * 60_000)
  assert.equal(legacy.requests.length, 1)
  assert.ok(legacy.requests[0] >= T0 + 30 * 60_000 && legacy.requests[0] < T0 + 31 * 60_000, `asked at +${(legacy.requests[0] - T0) / 1000} s`)
})

test('a background job under claude holds it, and so does a process table it cannot read or a claude it cannot name', async () => {
  const r = rig({ outcomes: ['registered'] })
  r.state.listing = { ok: true, processes: [...TABLE, JOB] }
  await r.pass(20 * 60_000)
  r.state.listing = { ok: false, error: 'powershell_failed:1' }
  await r.pass(5 * 60_000)
  r.state.listing = { ok: true, processes: [...TABLE] }
  r.state.claudePid = null
  await r.pass(5 * 60_000)
  assert.equal(r.requests.length, 0)
  assert.ok(r.state.listings > 0, 'it looked')
  assert.equal(r.fs.files.has(RECORD), false)
  r.state.claudePid = CLAUDE
  // The table was read while claude was unnamed (0.68.6), so the next look waits out the listing backoff.
  await r.pass(need().HOOK_RESTART_LIST_BACKOFF_MS + need().HOOK_RESTART_POLL_MS)
  assert.equal(r.requests.length, 1)
})

test('a job that stays under claude is looked at again only every few minutes, not on every poll', async () => {
  const m = need()
  const r = rig({ outcomes: ['registered'] })
  r.state.listing = { ok: true, processes: [...TABLE, JOB] }
  await r.pass(40 * 60_000)
  assert.equal(r.requests.length, 0)
  // Quiet from +10 min to +40 min: at most one listing per backoff, never one per 30 s poll.
  const most = Math.ceil((30 * 60_000) / m.HOOK_RESTART_LIST_BACKOFF_MS) + 1
  assert.ok(r.state.listings >= 2 && r.state.listings <= most, `${r.state.listings} listings in 30 minutes`)
  assert.ok(m.HOOK_RESTART_LIST_BACKOFF_MS >= 5 * 60_000)
  r.state.listing = { ok: true, processes: [...TABLE] }
  await r.pass(m.HOOK_RESTART_LIST_BACKOFF_MS + m.HOOK_RESTART_POLL_MS)
  assert.equal(r.requests.length, 1, 'the job ended: it asks at the next look')
})

test('it says why it waits, once per reason, so a restart that cannot happen is visible', async () => {
  const r = rig({ outcomes: ['registered'] })
  r.state.turn = { turnInFlight: true, turnSignal: 'hooks' }
  await r.pass(15 * 60_000)
  r.state.turn = { turnInFlight: false, turnSignal: 'hooks' }
  r.state.claudePid = null
  await r.pass(15 * 60_000)
  const waits = r.logs.filter((l) => l.startsWith('hook restart: waiting'))
  assert.equal(waits.filter((l) => l.includes('turn_in_flight')).length, 1, r.logs.join('\n'))
  // A claude the daemon cannot name (and the table does not name either) has its own reason since 0.68.6.
  assert.equal(waits.filter((l) => l.includes('claude_not_found')).length, 1, r.logs.join('\n'))
  assert.equal(waits.filter((l) => l.includes('young')).length, 0, 'the first minute is not news')
})

test('an update in flight holds it: the shared checkout\'s update lock, or an update drain', async () => {
  const r = rig({ outcomes: ['registered'] })
  r.state.updateLock = true
  await r.pass(20 * 60_000)
  r.state.updateLock = false
  r.state.draining = true
  await r.pass(20 * 60_000)
  assert.equal(r.requests.length, 0)
  assert.deepEqual(r.drains, [])
  r.state.draining = false
  await r.pass(60_000)
  assert.equal(r.requests.length, 1)
})

test('ticks of one daemon overlapping on the process listing ask once', async () => {
  const r = rig({ outcomes: ['registered'] })
  r.clock.now = T0 + 11 * 60_000
  await Promise.all([r.c.tick(), r.c.tick(), r.c.tick()])
  await r.pass(10 * 60_000)
  assert.equal(r.requests.length, 1)
  assert.equal(r.state.listings, 1)
})

test('a drain that throws is lifted again and nothing is asked', async () => {
  const r = rig({ outcomes: ['registered'], drainThrows: true })
  await r.pass(60 * 60_000)
  assert.equal(r.requests.length, 0)
  assert.deepEqual(r.drains, [true, false])
  assert.ok(r.logs.some((l) => l.includes('by hand')), r.logs.join('\n'))
})

test('control: a plain fresh start (the hook already registered, so nothing was written) never asks and says nothing', async () => {
  const r = rig({ outcomes: [] })
  assert.equal(r.c.armed, false)
  r.c.start()
  await r.pass(30 * 60_000)
  assert.equal(r.requests.length, 0)
  assert.equal(r.fs.files.has(RECORD), false)
  assert.deepEqual(r.logs, [])
  assert.deepEqual(r.state.intervals, [], 'no poll at all')
})

test('control: a registration that was already in place, or a folder that is not this clone, never asks', async () => {
  const r = rig({ outcomes: ['already', 'not_clone'] })
  assert.equal(r.c.armed, false)
  await r.pass(30 * 60_000)
  assert.equal(r.requests.length, 0)
  assert.equal(r.fs.files.has(RECORD), false)
})

test('control: a failed registration never asks', async () => {
  for (const outcomes of [['failed'], ['failed', 'already']]) {
    const r = rig({ outcomes })
    assert.equal(r.c.armed, false)
    await r.pass(30 * 60_000)
    assert.equal(r.requests.length, 0, `outcomes ${outcomes.join(',')}`)
    assert.equal(r.fs.files.has(RECORD), false)
  }
})

test('control: the restarted daemon never asks again, even when it registers again', async () => {
  const first = rig({ outcomes: ['registered'] })
  await first.pass(15 * 60_000)
  assert.equal(first.requests.length, 1)
  const recorded = first.fs.files.get(RECORD)
  // The next daemon on the same disk: the hook detection disagreed and it wrote the hook again.
  const second = rig({ outcomes: ['registered'], fs: first.fs, clock: { now: first.clock.now + 5_000 } })
  assert.equal(second.c.armed, false, 'the durable record disarms it at boot')
  second.c.start()
  await second.pass(60 * 60_000)
  assert.equal(second.requests.length, 0)
  assert.equal(first.fs.files.get(RECORD), recorded, 'the record is left byte for byte')
  assert.ok(second.logs.some((l) => /already/.test(l) && l.includes(RECORD)), second.logs.join('\n'))
})

test('two daemons racing on one agent: only the one that created the record asks', async () => {
  const fs = memFs()
  const clock = { now: T0 }
  const a = rig({ outcomes: ['registered'], fs, clock })
  const b = rig({ outcomes: ['registered'], fs, clock })
  assert.equal(a.c.armed && b.c.armed, true, 'both armed at boot: neither had asked yet')
  clock.now = T0 + 11 * 60_000
  await Promise.all([a.c.tick(), b.c.tick()])
  await a.pass(60_000)
  await b.pass(60_000)
  assert.equal(a.requests.length + b.requests.length, 1)
  const loser = a.requests.length ? b : a
  assert.ok(loser.logs.some((l) => l.includes('another daemon already asked')), loser.logs.join('\n'))
})

test('any answer but ok from the record write means no restart: a record it cannot prove is no single use', async () => {
  for (const answer of [undefined, 'busy', null]) {
    const fs = memFs()
    const r = rig({ outcomes: ['registered'], fs: { ...fs, createExclusive: () => answer as any } })
    await r.pass(60 * 60_000)
    assert.equal(r.requests.length, 0, `answer ${String(answer)}`)
    assert.deepEqual(r.drains, [])
  }
})

test('a record that cannot be written means no restart: one restart could not be guaranteed', async () => {
  const fs = memFs()
  fs.failNextCreate()
  const r = rig({ outcomes: ['registered'], fs })
  await r.pass(30 * 60_000)
  assert.equal(r.requests.length, 0)
  assert.deepEqual(r.drains, [])
  assert.ok(r.logs.some((l) => l.includes('by hand')), r.logs.join('\n'))
})

test('the ladder staged it, or threw: never asked again, the record stays, a throw lifts the drain', async () => {
  const staged = rig({ outcomes: ['registered'], took: false })
  await staged.pass(60 * 60_000)
  assert.equal(staged.requests.length, 1)
  assert.ok(staged.fs.files.has(RECORD))
  assert.ok(staged.logs.some((l) => l.includes('by hand')), staged.logs.join('\n'))
  const threw = rig({ outcomes: ['registered'], took: new Error('authority probe failed') })
  await threw.pass(60 * 60_000)
  assert.equal(threw.requests.length, 1)
  assert.deepEqual(threw.drains, [true, false])
  assert.ok(threw.fs.files.has(RECORD))
})

test('decideHookRestart: only a registration made by this boot arms it, and a record always wins', () => {
  const { decideHookRestart } = need()
  assert.deepEqual(decideHookRestart({ outcomes: ['registered'], recordPresent: false }), { arm: true, reason: 'registered' })
  assert.deepEqual(decideHookRestart({ outcomes: ['already', 'registered'], recordPresent: false }), { arm: true, reason: 'registered' })
  assert.deepEqual(decideHookRestart({ outcomes: [], recordPresent: false }), { arm: false, reason: 'nothing_registered' })
  assert.deepEqual(decideHookRestart({ outcomes: ['failed'], recordPresent: false }), { arm: false, reason: 'nothing_registered' })
  assert.deepEqual(decideHookRestart({ outcomes: ['registered'], recordPresent: true }), { arm: false, reason: 'already_requested' })
})

test('the real record is created exclusively: a second create finds it and leaves it byte for byte; a missing state folder is made', () => {
  const { nodeHookRestartFs } = need()
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'hook-restart-rec-')))
  const path = join(dir, '909', 'hook-restart.json')
  const fs = nodeHookRestartFs()
  assert.equal(fs.exists(path), false)
  assert.equal(fs.readFile(path), null)
  assert.equal(fs.createExclusive(path, '{"pid":1}'), 'ok')
  assert.equal(fs.createExclusive(path, '{"pid":2}'), 'exists')
  assert.equal(fs.readFile(path), '{"pid":1}')
  assert.equal(fs.exists(path), true)
})

// The ladder side: the daemon's own restart ladder (lib/update-rpc.ts), the
// one a scheduled update asks, with nothing posted to the backend.
function ladder(authority: any) {
  const timers: Array<() => void> = []
  const posted: unknown[] = []
  const markers: string[] = []
  const drains: boolean[] = []
  const logs: string[] = []
  const handler = new UpdateRpcHandler({
    postAck: async () => ({}),
    postProgress: async (_id: string, body: unknown) => {
      posted.push(body)
      return {}
    },
    log: (l: string) => logs.push(l),
    installMethod: () => 'clone',
    autoUpdateEnabled: () => true,
    updater: () => null,
    pendingRestartVersion: () => null,
    marketplaceUpdate: async () => ({}) as never,
    drainSnapshot: () => IDLE,
    restartAuthority: () => authority,
    spawnDetached: () => {},
    writeMarker: (p: string) => {
      markers.push(p)
      return true
    },
    signalProcess: () => true,
    setDrainMode: (on: boolean) => drains.push(on),
    requestHeartbeat: () => {},
    serviceOwnership: () => ({ ancestorPids: [], servicePid: null, ownPid: 1 }),
    setTimer: (fn: () => void) => {
      timers.push(fn)
      return () => {}
    },
  } as any)
  return { handler: handler as any, posted, markers, drains, logs, timers }
}

test('the hook restart walks the daemon\'s own restart ladder: a launcher gets its marker, and nothing is posted to the backend', async () => {
  const l = ladder({ kind: 'launcher', markerPath: 'C:\\Users\\kc\\.bgos-agent\\909\\restart-requested.json' })
  assert.equal(typeof l.handler.restartAfterHookRegistration, 'function', 'lib/update-rpc.ts has no restart for a hook registration')
  assert.equal(await l.handler.restartAfterHookRegistration(), true)
  assert.deepEqual(l.markers, ['C:\\Users\\kc\\.bgos-agent\\909\\restart-requested.json'])
  assert.deepEqual(l.posted, [], 'nobody asked, so no progress is posted')
  assert.ok(l.logs.some((x) => x.startsWith('hook registration restart: restarting')), l.logs.join('\n'))
})

test('no restart authority: the ladder stages, un-drains, and says so', async () => {
  const l = ladder({ kind: 'staged' })
  assert.equal(typeof l.handler.restartAfterHookRegistration, 'function', 'lib/update-rpc.ts has no restart for a hook registration')
  assert.equal(await l.handler.restartAfterHookRegistration(), false)
  assert.deepEqual(l.markers, [])
  assert.deepEqual(l.drains, [false])
  assert.deepEqual(l.posted, [])
})

test('a hook restart that never arrives says to restart by hand, not that an update is staged', async () => {
  const l = ladder({ kind: 'launcher', markerPath: 'C:\\Users\\kc\\.bgos-agent\\909\\restart-requested.json' })
  assert.equal(typeof l.handler.restartAfterHookRegistration, 'function', 'lib/update-rpc.ts has no restart for a hook registration')
  assert.equal(await l.handler.restartAfterHookRegistration(), true)
  assert.equal(l.timers.length, 1, 'the watchdog is armed')
  l.timers[0]()
  await new Promise((resolve) => setTimeout(resolve, 5))
  const line = l.logs.find((x) => x.includes('RESTART DID NOT ARRIVE')) ?? ''
  assert.match(line, /restart this agent by hand to load the private turn hook/, l.logs.join('\n'))
  assert.doesNotMatch(line, /pendingRestartVersion/)
  assert.deepEqual(l.drains, [false], 'intake is lifted')
  assert.deepEqual(l.posted, [])
})

// ── Vera, 2026-10-13: armed at 07:46:00, "waiting: process_tree_unreadable" at 07:47:00, then nothing (0.68.6) ──
//
// The daemon did not know its claude pid: on Windows that comes from a PowerShell parent walk with a 5 s limit,
// cached as a miss for 10 minutes (server.ts agentClaudePid), and the walk to the top of the tree measured 3.2 to 5 s
// on an idle PC. With claude unknown the controller never listed the table at all, logged the reason once and waited
// in silence for ever. The whole-table read (lib/process-tree.mjs listProcesses, 30 s limit) took 1.1 to 1.8 s.

/** Claude, the launcher and this daemon (4321), as a Windows clone runs them: claude.exe > node bgos-launch > bun. */
const CHAIN = [
  { pid: CLAUDE, ppid: 1, command: '"C:\\Users\\kc\\.local\\bin\\claude.exe" --resume 0f0e0d0c-1111-4222-8333-444455556666' },
  { pid: 4300, ppid: CLAUDE, command: 'node C:\\plugins\\bgos-claude-plugin\\bin\\bgos-launch.mjs C:\\plugins\\bgos-claude-plugin\\server.ts' },
  { pid: 4321, ppid: 4300, command: 'C:\\Users\\kc\\.bun\\bin\\bun.exe C:\\plugins\\bgos-claude-plugin\\server.ts' },
]
const unknownBound = () => (need() as any).HOOK_RESTART_UNKNOWN_MAX_MS ?? 60 * 60_000

test('Vera: the daemon cannot name its claude, but the whole process table does: it asks once, at the safe moment', async () => {
  const r = rig({ outcomes: ['registered'] })
  r.state.claudePid = null
  r.state.listing = { ok: true, processes: [...CHAIN] }
  r.c.start()
  await r.pass(60 * 60_000)
  assert.equal(r.requests.length, 1, `one restart, got ${r.requests.length}:\n${r.logs.join('\n')}`)
  assert.ok(r.requests[0] >= T0 + 10 * 60_000 && r.requests[0] < T0 + 11 * 60_000, `asked at +${(r.requests[0] - T0) / 1000} s`)
  assert.ok(r.state.listings >= 1, 'it read the table although the daemon did not know its claude')
})

test('Vera: a job under the claude the table names still holds it, and is not a reason to give up', async () => {
  const r = rig({ outcomes: ['registered'] })
  r.state.claudePid = null
  r.state.listing = { ok: true, processes: [...CHAIN, JOB] }
  r.c.start()
  await r.pass(4 * 3600_000)
  assert.equal(r.requests.length, 0)
  assert.ok(!r.logs.some((l) => /waited \d+ min/.test(l)), r.logs.join('\n'))
  assert.ok(r.logs.some((l) => l.includes('waiting: background_job')), r.logs.join('\n'))
  r.state.listing = { ok: true, processes: [...CHAIN] }
  await r.pass(10 * 60_000)
  assert.equal(r.requests.length, 1, 'the job ended: it asks')
})

test('Vera: a process table that stays unreadable is said within a bounded time, never becomes a restart, and is not read on every poll', async () => {
  const bound = unknownBound()
  assert.ok(bound >= 30 * 60_000 && bound <= 2 * 3600_000, `bound ${bound / 60_000} min`)
  const r = rig({ outcomes: ['registered'] })
  r.state.listing = { ok: false, error: 'powershell_failed:1' }
  r.c.start()
  await r.pass(10 * 60_000 + bound + 2 * need().HOOK_RESTART_LIST_BACKOFF_MS)
  assert.equal(r.requests.length, 0, 'never a restart it cannot prove safe')
  assert.equal(r.fs.files.has(RECORD), false, 'no single use record: nothing was asked')
  const waits = r.logs.filter((l) => l.startsWith('hook restart: waiting'))
  assert.ok(waits.some((l) => l.includes('process_tree_unreadable (powershell_failed:1)')), `the reader's error is named:\n${r.logs.join('\n')}`)
  const told = r.logs.filter((l) => /^hook restart: waited \d+ min without a readable process table \(powershell_failed:1\)/.test(l))
  assert.equal(told.length, 1, `said once, within the bound:\n${r.logs.join('\n')}`)
  assert.match(told[0]!, /restart this agent by hand to load the private turn hook\. It looks again every 30 min and asks on its own if the table reads at a safe moment$/)
  // While it waited, the table was read once per backoff, never on every 30 s poll.
  const most = Math.ceil(bound / need().HOOK_RESTART_LIST_BACKOFF_MS) + 3
  assert.ok(r.state.listings >= need().HOOK_RESTART_UNKNOWN_MIN_LOOKS && r.state.listings <= most, `${r.state.listings} listings`)
  // After saying so, once every 30 minutes; still no restart, and nothing said again.
  const listings = r.state.listings
  await r.pass(24 * 3600_000)
  assert.ok(r.state.listings - listings <= 24 * 2 + 1, `${r.state.listings - listings} listings in a day`)
  assert.equal(r.requests.length, 0)
  assert.equal(r.logs.filter((l) => /waited \d+ min/.test(l)).length, 1)
})

test('Vera: after saying so, a table that reads again at a safe moment still gets its one restart', async () => {
  const r = rig({ outcomes: ['registered'] })
  r.state.listing = { ok: false, error: 'powershell_failed:1' }
  r.c.start()
  await r.pass(10 * 60_000 + unknownBound() + 2 * need().HOOK_RESTART_LIST_BACKOFF_MS)
  assert.ok(r.logs.some((l) => /waited \d+ min without a readable process table/.test(l)))
  r.state.listing = { ok: true, processes: [...TABLE] }
  await r.pass(need().HOOK_RESTART_UNKNOWN_RETRY_MS + need().HOOK_RESTART_POLL_MS)
  assert.equal(r.requests.length, 1, r.logs.join('\n'))
})

test('Vera: time the agent was busy is not a spell: two failed looks an hour apart are not said', async () => {
  const r = rig({ outcomes: ['registered'] })
  r.state.listing = { ok: false, error: 'powershell_failed:1' }
  r.c.start()
  await r.pass(11 * 60_000)
  assert.ok(r.state.listings >= 1)
  // A long working turn: nothing is looked at.
  r.state.turn = { turnInFlight: true, turnSignal: 'hooks' }
  for (let i = 0; i < 12; i++) {
    r.state.activity = [T0, r.clock.now]
    await r.pass(10 * 60_000)
  }
  r.state.turn = { turnInFlight: false, turnSignal: 'hooks' }
  r.state.activity = [T0, r.clock.now]
  await r.pass(11 * 60_000)
  assert.ok(!r.logs.some((l) => /waited \d+ min/.test(l)), `two failed looks two hours apart are not a spell:\n${r.logs.join('\n')}`)
  await r.pass(6 * need().HOOK_RESTART_LIST_BACKOFF_MS)
  assert.ok(r.logs.some((l) => /waited \d+ min/.test(l)), 'six failed looks in a row, over the bound, are')
  assert.equal(r.requests.length, 0)
})

test('Vera: claude named nowhere (not by the daemon, not in a readable table) is said within the bound too', async () => {
  const r = rig({ outcomes: ['registered'] })
  r.state.claudePid = null
  r.state.listing = { ok: true, processes: CHAIN.slice(1).map((p) => (p.pid === 4300 ? { ...p, ppid: 1 } : p)) }
  r.c.start()
  await r.pass(10 * 60_000 + unknownBound() + 2 * need().HOOK_RESTART_LIST_BACKOFF_MS)
  assert.equal(r.requests.length, 0)
  assert.ok(r.logs.some((l) => /^hook restart: waited \d+ min without finding claude above this daemon \(pid 4321\) in a table of 2 processes/.test(l)), r.logs.join('\n'))
})

test('Vera: a table unreadable for a while, then readable, still asks; the bound counts only an unbroken spell', async () => {
  const r = rig({ outcomes: ['registered'] })
  r.state.listing = { ok: false, error: 'powershell_failed:null' }
  r.c.start()
  // Quiet from +10 min, so the table is first read then; unreadable for (bound - 5 min), then readable again.
  await r.pass(10 * 60_000 + unknownBound() - 5 * 60_000)
  r.state.listing = { ok: true, processes: [...TABLE] }
  await r.pass(10 * 60_000)
  assert.equal(r.requests.length, 1, r.logs.join('\n'))
  assert.ok(!r.logs.some((l) => /waited \d+ min/.test(l)))
})

test('Vera: the bound counts an unbroken spell: a readable look in between (a job under claude) starts it again', async () => {
  const bound = unknownBound()
  const r = rig({ outcomes: ['registered'] })
  r.state.listing = { ok: false, error: 'powershell_failed:1' }
  r.c.start()
  await r.pass(10 * 60_000 + bound - 15 * 60_000)
  // The table reads again and shows a job: a known reason to wait, not an unknown one.
  r.state.listing = { ok: true, processes: [...TABLE, JOB] }
  await r.pass(20 * 60_000)
  r.state.listing = { ok: false, error: 'powershell_failed:1' }
  await r.pass(bound - 15 * 60_000)
  assert.ok(!r.logs.some((l) => /waited \d+ min/.test(l)), `a new spell, not the old one continued:\n${r.logs.join('\n')}`)
  await r.pass(30 * 60_000)
  assert.ok(r.logs.some((l) => /waited \d+ min/.test(l)), 'and that spell, too, is said within the bound')
  assert.equal(r.requests.length, 0)
})

test('Vera: never mid turn, whatever the table: a long live turn never asks, read or unreadable, named or not', async () => {
  for (const [claudePid, listing] of [[CLAUDE, { ok: false, error: 'powershell_failed:1' }], [null, { ok: false, error: 'powershell_failed:1' }], [null, { ok: true, processes: [...CHAIN] }]] as const) {
    const r = rig({ outcomes: ['registered'] })
    r.state.claudePid = claudePid
    r.state.listing = listing
    r.state.turn = { turnInFlight: true, turnSignal: 'hooks' }
    r.c.start()
    // A six hour turn that keeps working: its tool calls keep the activity fresh.
    for (let i = 0; i < 36; i++) {
      r.state.activity = [T0, r.clock.now]
      await r.pass(10 * 60_000)
    }
    assert.equal(r.requests.length, 0, JSON.stringify(listing))
  }
  // Owed messages, a pending permission and running operations hold it too.
  for (const snapshot of [{ ...IDLE, pendingMessages: 1 }, { ...IDLE, pendingPermissions: 1 }, { ...IDLE, activeOperations: 1 }]) {
    const r = rig({ outcomes: ['registered'] })
    r.state.listing = { ok: false, error: 'powershell_failed:1' }
    r.state.snapshot = snapshot
    r.c.start()
    await r.pass(6 * 3600_000)
    assert.equal(r.requests.length, 0, JSON.stringify(snapshot))
  }
})
