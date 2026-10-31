/**
 * lib/idle-update.mjs createIdleUpdate: the daemon's controller for an idle
 * agent loading its staged plugin update by itself (docs/idle-update/DESIGN.md).
 *
 * Every effect is a fake here (an in-memory disk shared by every controller
 * of one test, so fifteen agents of one computer share their lease and canary
 * files exactly as they do on a real HOME), driven by hand with tick().
 *
 * Run: npx tsx --test test/idle-update.controller.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'

const mod: any = await import('../lib/idle-update.mjs').catch((err) => {
  if (err?.code === 'ERR_MODULE_NOT_FOUND') return null
  throw err
})

function need(): any {
  if (!mod || typeof mod.createIdleUpdate !== 'function') {
    assert.fail(
      'lib/idle-update.mjs createIdleUpdate is missing: the rules exist but nothing in the daemon applies them, so an idle ' +
        'agent with a staged build still runs the old version until someone quits it',
    )
  }
  return mod
}

const T0 = Date.parse('2026-10-28T12:00:00.000Z')
const SEC = 1000
const MIN = 60 * SEC
const HOUR = 60 * MIN
const MACHINE = join('/home/a/.bgos-agent', 'idle-update')
const PIN = '0f0e0d0c-1111-4222-8333-444455556666'
const MARKER = '/home/a/.bgos-agent/912/restart-requested.json'

/** One computer's disk: every controller of a test shares it. */
function memDisk() {
  const files = new Map<string, { text: string; mtimeMs: number }>()
  const clock = { now: T0 }
  const disk = {
    files,
    clock,
    fs: {
      readFile: (p: string) => files.get(p)?.text ?? null,
      mtimeMs: (p: string) => files.get(p)?.mtimeMs ?? null,
      createExclusive: (p: string, text: string) => {
        if (files.has(p)) return 'exists'
        files.set(p, { text, mtimeMs: clock.now })
        return 'ok'
      },
      writeAtomic: (p: string, text: string) => {
        files.set(p, { text, mtimeMs: clock.now })
        return true
      },
      rename: (from: string, to: string) => {
        const f = files.get(from)
        if (!f) return false
        files.delete(from)
        files.set(to, f)
        return true
      },
      remove: (p: string) => files.delete(p),
      listDir: (dir: string) => {
        const prefix = dir.endsWith('/') || dir.endsWith('\\') ? dir : `${dir}${join('a', 'b').slice(1, 2)}`
        const names = new Set<string>()
        for (const p of files.keys()) if (p.startsWith(prefix)) names.add(p.slice(prefix.length).split(/[\\/]/)[0])
        return [...names]
      },
    },
  }
  return disk
}

/** A gen-2 Mac agent: launchd > tmux server (own socket) > sh > hoai > expect > claude > this daemon. */
function table(id: number, extra: Array<{ pid: number; ppid: number; command: string }> = []) {
  const b = id * 100
  return [
    { pid: 1, ppid: 0, command: '/sbin/launchd' },
    { pid: b, ppid: 1, command: `tmux -f /dev/null -L hoai-${id}-home-abc new-session -d -s hoai-${id}-home-abc` },
    { pid: b + 10, ppid: b, command: '/bin/sh -c exec "$@" hoai-stderr' },
    { pid: b + 20, ppid: b + 10, command: '/usr/local/bin/node /Users/a/plugin/bin/hoai-core.mjs' },
    { pid: b + 30, ppid: b + 20, command: 'expect -c spawn claude' },
    { pid: b + 40, ppid: b + 30, command: `/Users/a/.local/bin/claude --dangerously-skip-permissions --resume ${PIN}` },
    { pid: b + 50, ppid: b + 40, command: 'bun /Users/a/plugin/server.ts' },
    ...extra,
  ]
}

type Rig = ReturnType<typeof agent>

function agent(
  disk: ReturnType<typeof memDisk>,
  o: { id?: number; running?: string; staged?: string | null; random?: number; authority?: string; ownsUs?: boolean; scale?: number; platform?: string; launcher?: any; unattended?: any; installMethod?: string } = {},
) {
  const m = need()
  const id = o.id ?? 912
  const b = id * 100
  const record = join('/home/a/.bgos-agent', String(id), 'idle-update.json')
  const s = {
    autoUpdate: true,
    running: o.running ?? '0.80.0',
    staged: o.staged === undefined ? '0.81.0' : o.staged,
    active: true,
    watcher: false,
    authority: o.authority ?? 'service',
    ownsUs: o.ownsUs ?? false,
    draining: false,
    updateLock: false,
    markerMtimeMs: null as number | null,
    safe: { turnInFlight: false, turnSignal: 'hooks', pendingMessages: 0, pendingPermissions: 0, activeOperations: 0 },
    activity: [T0 - 2 * HOUR] as number[],
    openAsks: 0,
    goalRunning: false,
    call: { pendingConsults: 0, openContinuations: 0, lastVoiceAtMs: null as number | null, openMeetings: 0 },
    browserAt: null as number | null,
    sessionWakeAt: null as number | null,
    claudePid: b + 40 as number | null,
    session: PIN as string | null,
    listing: { ok: true, processes: table(id) } as any,
    listings: 0,
    attached: false as boolean | null,
    wake: { ok: true, tasks: [] as Array<{ nextFireAt: string }> } as any,
    wakeReads: 0,
    strays: { ok: true, strays: [] as number[] } as any,
    strayReads: 0,
    startupComplete: true,
    heartbeatOkAtMs: null as number | null,
    beaconAtMs: null as number | null,
    deaf: false,
    loginExpired: false,
    tookRestart: true as boolean | Error,
    rollbackOk: true,
    unreachable: false,
    slept: 0,
    installGate: null as Promise<void> | null,
    /** The launcher rung: the ask leaves a restart marker on disk. */
    askWritesMarker: false,
  }
  const out = {
    s,
    clock: disk.clock,
    record,
    drains: [] as boolean[],
    restarts: [] as Array<{ target: string; proof: any }>,
    rollbackRestarts: [] as Array<{ target: string; proof: any }>,
    rollbackInstalls: [] as any[],
    badAtInstall: [] as boolean[],
    reports: [] as any[],
    heartbeatRequests: 0,
    logs: [] as string[],
    guards: [] as boolean[],
    markerRemovals: 0,
    c: null as any,
  }
  let nonces = 0
  out.c = m.createIdleUpdate({
    assistantId: String(id),
    ownPid: b + 50,
    platform: o.platform ?? 'darwin',
    bootAtMs: T0 - 2 * HOUR,
    runningVersion: s.running,
    installMethod: o.installMethod ?? 'marketplace',
    fromRoot: `/c/plugins/cache/hoai/hoai/${s.running}`,
    fromCommit: null,
    durations: m.scaledDurations(o.scale ?? 1),
    paths: { record, machineDir: MACHINE },
    fs: disk.fs,
    now: () => disk.clock.now,
    random: () => o.random ?? 0.5,
    nonce: () => `${id}-n${(nonces += 1)}`,
    autoUpdateEnabled: () => s.autoUpdate,
    stagedVersion: () => s.staged,
    active: () => s.active,
    holdsLock: () => s.active,
    watcherSweepActive: () => s.watcher,
    authorityKind: () => s.authority,
    serviceOwnsUs: () => s.ownsUs,
    draining: () => s.draining,
    updateLockHeld: () => s.updateLock,
    markerMtimeMs: () => s.markerMtimeMs,
    removeMarker: () => {
      out.markerRemovals += 1
      s.markerMtimeMs = null
      return true
    },
    safeState: () => s.safe,
    activityMs: () => s.activity,
    openAsks: () => s.openAsks,
    goalRunning: () => s.goalRunning,
    call: () => s.call,
    lastBrowserToolAtMs: () => s.browserAt,
    sessionWakeAtMs: () => s.sessionWakeAt,
    claudePid: () => s.claudePid,
    sessionId: async () => s.session,
    listProcesses: async () => {
      s.listings += 1
      return s.listing
    },
    launcher: () => o.launcher ?? { pid: b + 20, startedAtMs: T0 - 3 * HOUR, markerPath: MARKER, supervisorMtimeMs: T0 - 3 * HOUR },
    unattendedInputs: () => o.unattended ?? ({
      ownSockets: [`hoai-${id}-home-abc`, `hoai-${id}`],
      runShPath: `/Users/a/.bgos-agent/${id}/run.sh`,
      launchStatus: { outcome: null, mtimeMs: null },
      runAgentVbs: { text: null, mtimeMs: null },
    }),
    requestHeartbeat: () => {
      out.heartbeatRequests += 1
    },
    personAttached: async () => s.attached,
    wakeSchedule: async () => {
      s.wakeReads += 1
      return s.wake
    },
    serviceStrays: async (_processes: any, _claudePid: any) => {
      s.strayReads += 1
      return s.strays
    },
    startupComplete: () => s.startupComplete,
    heartbeatOkAtMs: () => s.heartbeatOkAtMs,
    beaconAtMs: () => s.beaconAtMs,
    deaf: () => s.deaf,
    loginExpired: () => s.loginExpired,
    backendUnreachable: () => s.unreachable,
    monotonicNow: () => disk.clock.now - s.slept,
    drain: (on: boolean) => out.drains.push(on),
    restart: async (target: string, proof: any) => {
      out.restarts.push({ target, proof })
      if (s.tookRestart instanceof Error) throw s.tookRestart
      if (s.askWritesMarker) s.markerMtimeMs = disk.clock.now
      return s.tookRestart
    },
    restartRollback: async (target: string, proof: any) => {
      out.rollbackRestarts.push({ target, proof })
      if (s.askWritesMarker) s.markerMtimeMs = disk.clock.now
      return true
    },
    rollbackInstall: async (rec: any) => {
      out.rollbackInstalls.push(rec)
      out.badAtInstall.push(disk.fs.readFile(join(MACHINE, String(rec.target), 'bad')) !== null)
      if (s.installGate) await s.installGate
      return s.rollbackOk ? { ok: true } : { ok: false, reason: 'from_root_missing' }
    },
    report: (err: any) => out.reports.push(err),
    guardCleanEnd: (open: boolean) => out.guards.push(open),
    log: (line: string) => out.logs.push(line),
    setInterval: () => ({ unref() {} }),
    clearInterval: () => {},
  })
  return out
}

function readJson(disk: ReturnType<typeof memDisk>, p: string) {
  const text = disk.fs.readFile(p)
  return text === null ? null : JSON.parse(text)
}

const lastReport = (a: Rig) => (a.reports.length ? a.reports[a.reports.length - 1] : undefined)
/** Each agent here owns its disk's clock through the controller's now(). */
function disk_advance(a: Rig, ms: number) {
  a.clock.now += ms
}

// -- The restart --------------------------------------------------------------------------------

test('idle, quiet past the jitter, a newer build staged: it takes the lease, is the canary, records, drains and asks ONCE', async () => {
  const disk = memDisk()
  const a = agent(disk)
  assert.equal(await a.c.tick(), 'requested')
  assert.deepEqual(a.restarts.map((r) => r.target), ['0.81.0'])
  assert.deepEqual(a.restarts[0].proof, { markerPath: MARKER, launcherPid: 91220 })
  assert.deepEqual(a.drains, [true])
  const lease = readJson(disk, join(MACHINE, 'lease.json'))
  assert.equal(lease.assistantId, '912')
  assert.equal(lease.target, '0.81.0')
  assert.ok(disk.files.has(join(MACHINE, '0.81.0', 'canary-1')))
  const rec = readJson(disk, a.record)
  assert.equal(rec.state, 'requested')
  assert.equal(rec.target, '0.81.0')
  assert.equal(rec.from, '0.80.0')
  assert.equal(rec.pin, PIN)
  assert.equal(rec.canaryN, 1)
  assert.equal(rec.nonce, lease.nonce)
  assert.equal(await a.c.tick(), 'requested')
  assert.equal(a.restarts.length, 1, 'one ask, then it waits for the restart')
})

test('updates off: never reads the process table or the schedule, never asks', async () => {
  const disk = memDisk()
  const a = agent(disk)
  a.s.autoUpdate = false
  assert.equal(await a.c.tick(), 'updates_disabled')
  assert.equal(a.s.listings, 0)
  assert.equal(a.s.wakeReads, 0)
  assert.equal(a.restarts.length, 0)
})

test('a passive daemon never settles a record or acts', async () => {
  const disk = memDisk()
  const a = agent(disk)
  a.s.active = false
  disk.fs.writeAtomic(a.record, JSON.stringify({ schema: 1, target: '0.81.0', from: '0.80.0', state: 'requested', attempts: [], pin: PIN }))
  assert.equal(await a.c.tick(), 'passive')
  assert.equal(readJson(disk, a.record).state, 'requested')
  assert.equal(a.restarts.length, 0)
})

test('each busy case waits, and each reason is logged once', async () => {
  const cases: Array<[string, (s: any) => void]> = [
    ['turn_in_flight', (s) => (s.safe = { ...s.safe, turnInFlight: true, }) && (s.activity = [T0 - 5 * MIN])],
    ['pending_messages', (s) => (s.safe = { ...s.safe, pendingMessages: 1 })],
    ['open_ask', (s) => (s.openAsks = 1)],
    ['goal_running', (s) => (s.goalRunning = true)],
    ['call_active', (s) => (s.call = { ...s.call, lastVoiceAtMs: T0 - 5 * MIN })],
    ['browser_in_use', (s) => (s.browserAt = T0 - 5 * MIN)],
    ['session_wake', (s) => (s.sessionWakeAt = T0 - 5 * MIN)],
    ['recent_activity', (s) => (s.activity = [T0 - 2 * MIN])],
  ]
  for (const [reason, set] of cases) {
    const disk = memDisk()
    const a = agent(disk)
    set(a.s)
    assert.equal(await a.c.tick(), reason, reason)
    assert.equal(await a.c.tick(), reason, reason)
    assert.equal(a.restarts.length, 0, reason)
    assert.equal(a.logs.filter((l) => l.includes(`waiting: ${reason}`)).length, 1, `${reason}: ${a.logs.join(' | ')}`)
  }
})

test('the tree, a person and the schedule are read last; each says wait, and the table is not read again before the back-off', async () => {
  const disk = memDisk()
  const job = agent(disk)
  job.s.listing = { ok: true, processes: table(912, [{ pid: 91260, ppid: 91240, command: '/bin/zsh -c source /Users/a/.claude/shell-snapshots/snapshot-zsh-1.sh && npm run dev' }]) }
  assert.equal(await job.c.tick(), 'background_job')
  assert.equal(await job.c.tick(), 'busy')
  assert.equal(job.s.listings, 1)
  disk.clock.now += 5 * MIN
  job.s.listing = { ok: true, processes: table(912) }
  assert.equal(await job.c.tick(), 'requested')

  const person = agent(memDisk())
  person.s.attached = true
  assert.equal(await person.c.tick(), 'person_attached')
  const unknown = agent(memDisk())
  unknown.s.attached = null
  assert.equal(await unknown.c.tick(), 'person_attached')
})

test('a wake due within 10 min, read fresh just before the act, waits; an unreadable schedule fails closed', async () => {
  const due = agent(memDisk())
  due.s.wake = { ok: true, tasks: [{ nextFireAt: new Date(T0 + 4 * MIN).toISOString() }] }
  assert.equal(await due.c.tick(), 'wake_due')
  assert.equal(due.s.wakeReads, 1)
  assert.equal(due.restarts.length, 0)
  const unreadable = agent(memDisk())
  unreadable.s.wake = { ok: false }
  assert.equal(await unreadable.c.tick(), 'wake_schedule_unknown')
  assert.equal(unreadable.restarts.length, 0)
})

test('a launch not proven unattended (a person\'s own hoai in Terminal) never restarts', async () => {
  const a = agent(memDisk())
  a.s.listing = {
    ok: true,
    processes: [
      { pid: 1, ppid: 0, command: '/sbin/launchd' },
      { pid: 300, ppid: 1, command: '/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal' },
      { pid: 310, ppid: 300, command: '-zsh' },
      { pid: 91220, ppid: 310, command: 'node /Users/a/plugin/bin/hoai-core.mjs' },
      { pid: 91240, ppid: 91220, command: `claude --resume ${PIN}` },
      { pid: 91250, ppid: 91240, command: 'bun /Users/a/plugin/server.ts' },
    ],
  }
  assert.equal(await a.c.tick(), 'no_unattended_authority')
  assert.equal(a.restarts.length, 0)
})

test('a job that owns the daemon restarts through the job: no own launcher proof is needed or passed', async () => {
  const a = agent(memDisk(), { ownsUs: true })
  a.s.listing = { ok: true, processes: table(912) }
  assert.equal(await a.c.tick(), 'requested')
  assert.equal(a.restarts[0].proof, null)
})

test('a job that owns the daemon restarts claude only when claude resumes a pinned session: a gen-1 job would start it fresh', async () => {
  const fresh = agent(memDisk(), { ownsUs: true })
  fresh.s.listing = { ok: true, processes: table(912).map((p) => (p.pid === 91240 ? { ...p, command: '/Users/a/.local/bin/claude --dangerously-skip-permissions' } : p)) }
  assert.equal(await fresh.c.tick(), 'no_unattended_authority')
  assert.equal(fresh.restarts.length, 0)
  const pinned = agent(memDisk(), { ownsUs: true })
  assert.equal(await pinned.c.tick(), 'requested')
})

test('a restart through an owning service waits for a stray job in its group, or a group it cannot read; a launcher restart never reads it', async () => {
  const stray = agent(memDisk(), { ownsUs: true })
  stray.s.strays = { ok: true, strays: [4242] }
  assert.equal(await stray.c.tick(), 'background_job')
  assert.equal(stray.restarts.length, 0)
  const unreadable = agent(memDisk(), { ownsUs: true })
  unreadable.s.strays = { ok: false, strays: [] }
  assert.equal(await unreadable.c.tick(), 'process_tree_unreadable')
  assert.equal(unreadable.restarts.length, 0)
  const launcher = agent(memDisk())
  launcher.s.strays = { ok: true, strays: [4242] }
  assert.equal(await launcher.c.tick(), 'requested')
  assert.equal(launcher.s.strayReads, 0)
})

test('a person is read after the wake schedule call, so one who attaches during that call still holds the restart', async () => {
  const a = agent(memDisk())
  Object.defineProperty(a.s, 'wake', {
    get() {
      a.s.attached = true
      return { ok: true, tasks: [] }
    },
  })
  assert.equal(await a.c.tick(), 'person_attached')
  assert.equal(a.restarts.length, 0)
})

test('another agent creating the lease between the read and the create wins: this one never acts', async () => {
  const disk = memDisk()
  const a = agent(disk)
  const create = disk.fs.createExclusive
  disk.fs.createExclusive = (p: string, text: string) => {
    if (p === join(MACHINE, 'lease.json') && !disk.files.has(p)) {
      create(p, JSON.stringify({ assistantId: '913', target: '0.81.0', nonce: '913-n1', at: new Date(disk.clock.now).toISOString() }))
      return 'exists'
    }
    return create(p, text)
  }
  assert.equal(await a.c.tick(), 'machine_busy')
  assert.equal(a.restarts.length, 0)
  assert.deepEqual(a.drains, [])
})

test('a record that cannot be written: no restart, no drain, the lease released and the canary voided', async () => {
  const disk = memDisk()
  const a = agent(disk)
  const write = disk.fs.writeAtomic
  disk.fs.writeAtomic = (p: string, text: string) => (p === a.record ? false : write(p, text))
  assert.equal(await a.c.tick(), 'record_failed')
  assert.equal(a.restarts.length, 0)
  assert.deepEqual(a.drains, [])
  assert.equal(disk.files.has(join(MACHINE, 'lease.json')), false)
  assert.ok(disk.files.has(join(MACHINE, '0.81.0', 'void-1')))
})

test('a released.json stamped further ahead than the spacing (a clock that jumped) never holds the spacing for hours', async () => {
  const disk = memDisk()
  disk.fs.writeAtomic(join(MACHINE, 'released.json'), JSON.stringify({ assistantId: '913', at: new Date(T0 + 3 * HOUR).toISOString() }))
  const a = agent(disk)
  assert.equal(await a.c.tick(), 'requested')
})

test('staged authority: waits without ever reading the process table', async () => {
  const a = agent(memDisk(), { authority: 'staged' })
  assert.equal(await a.c.tick(), 'no_unattended_authority')
  assert.equal(a.s.listings, 0)
})

// -- Fifteen agents, one computer ------------------------------------------------------------------

test('fifteen agents on one computer: one lease at a time, the canary first, the rest wait for it to confirm', async () => {
  const disk = memDisk()
  const agents = Array.from({ length: 15 }, (_, i) => agent(disk, { id: 900 + i, random: 0 }))
  const first = await Promise.all(agents.map((a) => a.c.tick()))
  assert.equal(first.filter((r) => r === 'requested').length, 1, first.join(','))
  const others = first.filter((r) => r !== 'requested')
  assert.ok(others.every((r) => r === 'machine_busy' || r === 'canary_unconfirmed'), others.join(','))
  assert.equal(agents.reduce((n, a) => n + a.restarts.length, 0), 1)
})

test('a lease released by another agent under 2 min ago keeps the spacing', async () => {
  const disk = memDisk()
  disk.fs.writeAtomic(join(MACHINE, 'released.json'), JSON.stringify({ assistantId: '913', at: new Date(T0 - 1 * MIN).toISOString() }))
  proven(disk)
  const a = agent(disk)
  assert.equal(await a.c.tick(), 'spacing')
  disk.clock.now += 2 * MIN
  assert.equal(await a.c.tick(), 'requested')
  assert.equal(readJson(disk, a.record).canaryN, null, 'a validated version needs no canary')
})

// -- Failures of the ask ---------------------------------------------------------------------------

test('the ladder could only stage: recorded as a failed attempt, lease released, canary voided, reported, backed off', async () => {
  const disk = memDisk()
  const a = agent(disk)
  a.s.tookRestart = false
  assert.equal(await a.c.tick(), 'staged')
  const rec = readJson(disk, a.record)
  assert.equal(rec.state, 'no_authority')
  assert.equal(disk.files.has(join(MACHINE, 'lease.json')), false)
  assert.ok(disk.files.has(join(MACHINE, '0.81.0', 'void-1')))
  assert.equal(lastReport(a)?.code, 'scheduled_update_failed')
  disk.clock.now += 3 * MIN
  assert.equal(await a.c.tick(), 'attempted')
})

test('no hook signal: never restarts, says so on the heartbeat once it is the only thing in the way, and a turn clears it', async () => {
  const disk = memDisk()
  const a = agent(disk)
  a.s.safe = { ...a.s.safe, turnSignal: 'none' }
  assert.equal(await a.c.tick(), 'no_turn_signal')
  assert.equal(a.restarts.length, 0)
  assert.equal(lastReport(a)?.code, 'idle_update_no_turn_signal')
  assert.ok(a.logs.some((line) => line.includes('waiting: no_turn_signal')))
  // Its first hook event: an ordinary quiet wait again, and the app no longer shows the report.
  a.s.safe = { ...a.s.safe, turnSignal: 'hooks' }
  a.s.activity = [disk.clock.now - MIN]
  assert.equal(await a.c.tick(), 'recent_activity')
  assert.equal(lastReport(a), null)
})

test('a restart that never arrives: did_not_arrive after 3.5 min, lease released, canary voided, reported, backed off', async () => {
  const disk = memDisk()
  const a = agent(disk)
  assert.equal(await a.c.tick(), 'requested')
  disk.clock.now += 3 * MIN
  assert.equal(await a.c.tick(), 'requested')
  disk.clock.now += 31 * SEC
  assert.equal(await a.c.tick(), 'did_not_arrive')
  assert.equal(readJson(disk, a.record).state, 'did_not_arrive')
  assert.equal(disk.files.has(join(MACHINE, 'lease.json')), false)
  assert.ok(disk.files.has(join(MACHINE, '0.81.0', 'void-1')))
  assert.equal(lastReport(a)?.code, 'scheduled_update_failed')
  disk.clock.now += 10 * MIN
  assert.equal(await a.c.tick(), 'attempted')
})

test('a restart that never arrives takes back the marker hoai never took: its next poll would kill claude with no turn check', async () => {
  const disk = memDisk()
  const a = agent(disk)
  a.s.askWritesMarker = true
  assert.equal(await a.c.tick(), 'requested')
  disk.clock.now += 3.5 * MIN + SEC
  assert.equal(await a.c.tick(), 'did_not_arrive')
  assert.equal(a.markerRemovals, 1)
  assert.equal(a.s.markerMtimeMs, null)
  assert.equal(readJson(disk, a.record).markerStranded, true)
  // The marker was what said the launcher stopped taking them: the record says it now.
  assert.equal(lastReport(a)?.code, 'idle_update_launcher_latched')
})

test('a marker hoai took leaves nothing to take back: the launcher works, and the report is the ordinary failed attempt', async () => {
  const disk = memDisk()
  const a = agent(disk)
  a.s.askWritesMarker = true
  assert.equal(await a.c.tick(), 'requested')
  a.s.markerMtimeMs = null
  disk.clock.now += 3.5 * MIN + SEC
  assert.equal(await a.c.tick(), 'did_not_arrive')
  assert.equal(a.markerRemovals, 0)
  assert.notEqual(readJson(disk, a.record).markerStranded, true)
  assert.equal(lastReport(a)?.code, 'scheduled_update_failed')
})

test('a marker another writer left since is never taken back: a person\'s restart writes the same file, and nothing in it names the writer', async () => {
  const disk = memDisk()
  const a = agent(disk)
  a.s.askWritesMarker = true
  assert.equal(await a.c.tick(), 'requested')
  disk.clock.now += MIN
  const theirs = disk.clock.now
  a.s.markerMtimeMs = theirs
  disk.clock.now += 2.5 * MIN + SEC
  assert.equal(await a.c.tick(), 'did_not_arrive')
  assert.equal(a.markerRemovals, 0)
  assert.equal(a.s.markerMtimeMs, theirs)
})

test('no marker was asked for (a keepalive or an owning service): nothing is taken back, whatever waits there', async () => {
  const disk = memDisk()
  const a = agent(disk)
  assert.equal(await a.c.tick(), 'requested')
  a.s.markerMtimeMs = disk.clock.now
  disk.clock.now += 3.5 * MIN + SEC
  assert.equal(await a.c.tick(), 'did_not_arrive')
  assert.equal(a.markerRemovals, 0)
})

// -- After the restart: the new daemon -------------------------------------------------------------

/** The disk after agent 912 asked to restart onto 0.81.0 as canary 1. */
async function afterAsk() {
  const disk = memDisk()
  const old = agent(disk)
  assert.equal(await old.c.tick(), 'requested')
  disk.clock.now += 40 * SEC
  return disk
}

test('back on the new version with the same session: validated on live proof, lease released, canary confirmed, said once', async () => {
  const disk = await afterAsk()
  const a = agent(disk, { running: '0.81.0', staged: null })
  assert.equal(await a.c.tick(), 'validating')
  assert.equal(readJson(disk, a.record).state, 'arrived')
  disk.clock.now += 20 * SEC
  a.s.heartbeatOkAtMs = disk.clock.now - 10 * SEC
  a.s.beaconAtMs = disk.clock.now - 5 * SEC
  assert.equal(await a.c.tick(), 'validating', 'the first live reading starts the 5 min hold')
  disk.clock.now += 5 * MIN + SEC
  a.s.heartbeatOkAtMs = disk.clock.now - 10 * SEC
  a.s.beaconAtMs = disk.clock.now - 5 * SEC
  assert.equal(await a.c.tick(), 'validated')
  assert.equal(readJson(disk, a.record).state, 'validated')
  assert.ok(disk.files.has(join(MACHINE, '0.81.0', 'validated')))
  assert.equal(disk.files.has(join(MACHINE, 'lease.json')), false)
  assert.ok(disk.files.has(join(MACHINE, 'released.json')))
  assert.ok(a.logs.some((l) => /restarted onto 0\.81\.0 from 0\.80\.0/.test(l) && l.includes(PIN)), a.logs.join('\n'))
  assert.equal(lastReport(a), null)
})

test('a deaf new build never validates: at the deadline the canary rolls back, latches the version bad, and restarts onto the old one when quiet', async () => {
  const disk = await afterAsk()
  const a = agent(disk, { running: '0.81.0', staged: null })
  assert.equal(await a.c.tick(), 'validating')
  a.s.deaf = true
  a.s.heartbeatOkAtMs = disk.clock.now
  a.s.beaconAtMs = disk.clock.now
  disk.clock.now += 15 * MIN + SEC
  a.s.activity = [disk.clock.now - 3 * MIN]
  assert.equal(await a.c.tick(), 'rollback')
  assert.equal(a.rollbackInstalls.length, 1)
  assert.equal(a.rollbackInstalls[0].from, '0.80.0')
  assert.ok(disk.files.has(join(MACHINE, '0.81.0', 'bad')))
  assert.equal(readJson(disk, a.record).state, 'rolled_back')
  assert.equal(a.rollbackRestarts.length, 0)
  assert.equal(await a.c.tick(), 'rollback_requested')
  assert.deepEqual(a.rollbackRestarts.map((r) => r.target), ['0.80.0'])
})

test('the rollback restart waits for a quiet moment, never cutting a turn', async () => {
  const disk = await afterAsk()
  const a = agent(disk, { running: '0.81.0', staged: null })
  await a.c.tick()
  disk.clock.now += 15 * MIN + SEC
  a.s.safe = { ...a.s.safe, turnInFlight: true }
  a.s.activity = [disk.clock.now - 10 * SEC]
  assert.equal(await a.c.tick(), 'rollback')
  assert.equal(await a.c.tick(), 'rollback_waiting')
  assert.equal(a.rollbackRestarts.length, 0)
  a.s.safe = { ...a.s.safe, turnInFlight: false }
  disk.clock.now += 3 * MIN
  assert.equal(await a.c.tick(), 'rollback_requested')
})

/** The canary, back on the new build and past the validation deadline: its rollback install is done. */
async function rolledBackCanary() {
  const disk = await afterAsk()
  const a = agent(disk, { running: '0.81.0', staged: null })
  assert.equal(await a.c.tick(), 'validating')
  disk.clock.now += 15 * MIN + SEC
  a.s.activity = [disk.clock.now - 3 * MIN]
  assert.equal(await a.c.tick(), 'rollback')
  return { disk, a }
}

test('the rollback restart never goes through a launch not proven unattended: it asks for a restart by hand instead', async () => {
  const { a } = await rolledBackCanary()
  a.s.authority = 'staged'
  assert.equal(await a.c.tick(), 'rollback_staged')
  assert.equal(a.rollbackRestarts.length, 0)
  assert.equal(lastReport(a)?.code, 'idle_update_rollback_failed')
  assert.match(lastReport(a)?.message ?? '', /by hand/)
})

test('the rollback restart waits for an open ask, a running goal, a call, the browser and a wake due, as the update does', async () => {
  const { disk, a } = await rolledBackCanary()
  a.s.openAsks = 1
  assert.equal(await a.c.tick(), 'rollback_waiting')
  a.s.openAsks = 0
  a.s.goalRunning = true
  assert.equal(await a.c.tick(), 'rollback_waiting')
  a.s.goalRunning = false
  a.s.wake = { ok: true, tasks: [{ nextFireAt: new Date(disk.clock.now + 3 * MIN).toISOString() }] }
  assert.equal(await a.c.tick(), 'rollback_waiting')
  assert.equal(a.rollbackRestarts.length, 0)
  a.s.wake = { ok: true, tasks: [] }
  assert.equal(await a.c.tick(), 'rollback_requested')
  assert.ok(a.logs.some((l) => /waiting: rollback_open_ask/.test(l)), a.logs.join('\n'))
})

test('a passive daemon neither validates nor rolls back', async () => {
  const disk = await afterAsk()
  const a = agent(disk, { running: '0.81.0', staged: null })
  assert.equal(await a.c.tick(), 'validating')
  a.s.active = false
  disk.clock.now += 15 * MIN + SEC
  assert.equal(await a.c.tick(), 'passive')
  assert.equal(a.rollbackInstalls.length, 0)
  // Passive after the rollback install: the restart stage does nothing at all, not even a wait.
  const later = await rolledBackCanary()
  later.a.s.active = false
  later.disk.clock.now += 3 * MIN
  assert.equal(await later.a.c.tick(), 'passive')
  assert.equal(later.a.rollbackRestarts.length, 0)
  later.a.s.active = true
  assert.equal(await later.a.c.tick(), 'rollback_requested')
})

test('a slow rollback install holds the busy guard: a tick meanwhile is busy, the install runs once, the version is held bad first', async () => {
  const disk = await afterAsk()
  const a = agent(disk, { running: '0.81.0', staged: null })
  assert.equal(await a.c.tick(), 'validating')
  let open = () => {}
  a.s.installGate = new Promise<void>((resolve) => {
    open = resolve
  })
  disk.clock.now += 15 * MIN + SEC
  const first = a.c.tick()
  await new Promise((resolve) => setImmediate(resolve))
  // Raced, so a second install waiting on the same gate fails here instead of hanging the file.
  const second = await Promise.race([a.c.tick(), new Promise((resolve) => setTimeout(() => resolve('still installing'), 200))])
  open()
  assert.equal(second, 'busy')
  assert.equal(await first, 'rollback')
  assert.equal(a.rollbackInstalls.length, 1)
  assert.deepEqual(a.badAtInstall, [true], 'the version is latched bad before the install is touched')
})

test('a canary whose attempt was voided, or a version another agent validated meanwhile, goes back like any agent: it spends its one way back', async () => {
  for (const mark of ['void-1', 'validated']) {
    const disk = await afterAsk()
    const a = agent(disk, { running: '0.81.0', staged: null })
    assert.equal(await a.c.tick(), 'validating')
    disk.fs.createExclusive(join(MACHINE, '0.81.0', mark), JSON.stringify({ assistantId: '913', at: new Date(disk.clock.now).toISOString() }))
    disk.clock.now += 15 * MIN + SEC
    assert.equal(await a.c.tick(), 'rollback', mark)
    assert.equal(a.rollbackInstalls.length, 1, mark)
    assert.ok(disk.files.has(join(MACHINE, 'went-back-912')), mark)
  }
})

test('the canary\'s own verdict spends nothing: it may fail on the next version too', async () => {
  const disk = await afterAsk()
  const a = agent(disk, { running: '0.81.0', staged: null })
  assert.equal(await a.c.tick(), 'validating')
  disk.clock.now += 15 * MIN + SEC
  assert.equal(await a.c.tick(), 'rollback')
  assert.equal(disk.files.has(join(MACHINE, 'went-back-912')), false)
})

/** A latch is written once it has stood for a validation's whole deadline, in polls in a row. */
async function latches(disk: ReturnType<typeof memDisk>, a: Rig) {
  for (let poll = 0; poll < 30; poll += 1) {
    assert.equal(await a.c.tick(), 'version_held_bad')
    assert.equal(disk.files.has(join(MACHINE, '0.81.0', 'bad')), false, `poll ${poll + 1}`)
  }
  assert.equal(await a.c.tick(), 'version_held_bad')
}

test('two canaries that never came back latch the version bad on disk, for every reader of the latch', async () => {
  const disk = memDisk()
  for (const [n, id, age] of [[1, '913', 3 * 24 * HOUR], [2, '914', 101 * MIN]] as const) {
    disk.fs.createExclusive(join(MACHINE, '0.81.0', `canary-${n}`), JSON.stringify({ assistantId: id, at: new Date(T0 - age).toISOString() }))
  }
  const a = agent(disk)
  await latches(disk, a)
  assert.equal(readJson(disk, join(MACHINE, '0.81.0', 'bad'))?.reason, 'canaries_silent')
  assert.equal(a.restarts.length, 0)
})

test('a second canary still validating past its lease is not latched bad by the others', async () => {
  const disk = memDisk()
  for (const [n, id, age] of [[1, '913', 3 * 24 * HOUR], [2, '914', 30 * MIN]] as const) {
    disk.fs.createExclusive(join(MACHINE, '0.81.0', `canary-${n}`), JSON.stringify({ assistantId: id, at: new Date(T0 - age).toISOString() }))
  }
  const a = agent(disk)
  assert.equal(await a.c.tick(), 'canary_unconfirmed')
  assert.equal(disk.fs.readFile(join(MACHINE, '0.81.0', 'bad')), null)
})

test('a keepalive restart only when claude resumes a pinned session: a bare --continue relaunch is never unattended', async () => {
  const cont = agent(memDisk(), { authority: 'keepalive' })
  cont.s.listing = { ok: true, processes: table(912).map((p) => (p.pid === 91240 ? { ...p, command: '/Users/a/.local/bin/claude --dangerously-skip-permissions --continue' } : p)) }
  assert.equal(await cont.c.tick(), 'no_unattended_authority')
  const short = agent(memDisk(), { authority: 'keepalive' })
  short.s.listing = { ok: true, processes: table(912).map((p) => (p.pid === 91240 ? { ...p, command: `/Users/a/.local/bin/claude --resume ${PIN} -c` } : p)) }
  assert.equal(await short.c.tick(), 'no_unattended_authority')
  const pinned = agent(memDisk(), { authority: 'keepalive' })
  assert.equal(await pinned.c.tick(), 'requested')
  assert.equal(cont.restarts.length + short.restarts.length, 0)
})

test('an activity reading that throws is read as activity now, never as quiet', async () => {
  const a = agent(memDisk())
  Object.defineProperty(a.s, 'activity', {
    get() {
      throw new Error('transcript unreadable')
    },
  })
  assert.notEqual(await a.c.tick(), 'requested')
  assert.equal(a.restarts.length, 0)
})

test('this daemon\'s own startup not complete: no restart yet', async () => {
  const a = agent(memDisk())
  a.s.startupComplete = false
  assert.equal(await a.c.tick(), 'young')
  assert.equal(a.restarts.length, 0)
})

test('a backend outage during validation holds the deadline; the minutes it was down are not counted', async () => {
  const disk = await afterAsk()
  const a = agent(disk, { running: '0.81.0', staged: null })
  assert.equal(await a.c.tick(), 'validating')
  a.s.unreachable = true
  for (let i = 0; i < 20; i += 1) {
    disk.clock.now += 30 * SEC
    assert.equal(await a.c.tick(), 'validating')
  }
  a.s.unreachable = false
  disk.clock.now += 13 * MIN
  assert.equal(await a.c.tick(), 'validating', 'ten minutes down, thirteen up: not yet fifteen minutes of chance')
  disk.clock.now += 2 * MIN + SEC
  assert.equal(await a.c.tick(), 'rollback')
})

test('a computer asleep during validation holds the deadline: the wall clock jumped, the monotonic one did not', async () => {
  const disk = await afterAsk()
  const a = agent(disk, { running: '0.81.0', staged: null })
  assert.equal(await a.c.tick(), 'validating')
  disk.clock.now += 40 * MIN
  a.s.slept += 40 * MIN
  assert.equal(await a.c.tick(), 'validating')
  assert.equal(a.rollbackInstalls.length, 0)
})

test('a build that proved live and then booted once more (a person\'s restart) validates on that boot, never rolls back', async () => {
  const disk = await afterAsk()
  const first = agent(disk, { running: '0.81.0', staged: null })
  assert.equal(await first.c.tick(), 'validating')
  disk.clock.now += 20 * SEC
  first.s.heartbeatOkAtMs = disk.clock.now - 5 * SEC
  first.s.beaconAtMs = disk.clock.now - 2 * SEC
  assert.equal(await first.c.tick(), 'validating')
  assert.ok(readJson(disk, first.record).liveAt, 'live before the hold is on the record')
  disk.clock.now += 20 * SEC
  const second = agent(disk, { running: '0.81.0', staged: null })
  assert.equal(await second.c.tick(), 'validating')
  assert.equal(second.rollbackInstalls.length, 0)
  disk.clock.now += 20 * SEC
  second.s.heartbeatOkAtMs = disk.clock.now - 5 * SEC
  second.s.beaconAtMs = disk.clock.now - 2 * SEC
  assert.equal(await second.c.tick(), 'validating')
  disk.clock.now += 5 * MIN + SEC
  second.s.heartbeatOkAtMs = disk.clock.now - 5 * SEC
  second.s.beaconAtMs = disk.clock.now - 2 * SEC
  assert.equal(await second.c.tick(), 'validated')
})

test('a slow startup is not a broken build: the deadline counts from this boot\'s startup complete, the hold from the first live reading', async () => {
  const disk = await afterAsk()
  const a = agent(disk, { running: '0.81.0', staged: null })
  a.s.startupComplete = false
  assert.equal(await a.c.tick(), 'validating')
  disk.clock.now += 6 * MIN
  assert.equal(await a.c.tick(), 'validating', 'six minutes starting up is not the 5 min deadline')
  a.s.startupComplete = true
  assert.equal(await a.c.tick(), 'validating')
  disk.clock.now += 4 * MIN
  assert.equal(await a.c.tick(), 'validating', 'four minutes since startup complete')
  a.s.heartbeatOkAtMs = disk.clock.now - 5 * SEC
  a.s.beaconAtMs = disk.clock.now - 2 * SEC
  assert.equal(await a.c.tick(), 'validating', 'the first live reading starts the hold')
  disk.clock.now += 5 * MIN + SEC
  a.s.heartbeatOkAtMs = disk.clock.now - 5 * SEC
  a.s.beaconAtMs = disk.clock.now - 2 * SEC
  assert.equal(await a.c.tick(), 'validated')
  assert.equal(a.rollbackInstalls.length, 0)
})

test('a startup that never completes is the build failing: the canary rolls back 15 min after it arrived', async () => {
  const disk = await afterAsk()
  const a = agent(disk, { running: '0.81.0', staged: null })
  a.s.startupComplete = false
  assert.equal(await a.c.tick(), 'validating')
  disk.clock.now += 14 * MIN
  assert.equal(await a.c.tick(), 'validating')
  disk.clock.now += MIN + SEC
  assert.equal(await a.c.tick(), 'rollback')
  assert.equal(a.rollbackInstalls.length, 1)
})

test('hoai relaunching a slow new build whose daemon ended cleanly (its claude went away) is a re-arrival, once; a third boot is a failed build', async () => {
  const disk = await afterAsk()
  const first = agent(disk, { running: '0.81.0', staged: null })
  first.s.startupComplete = false
  assert.equal(await first.c.tick(), 'validating')
  for (let i = 0; i < 5; i += 1) {
    disk.clock.now += 30 * SEC
    assert.equal(await first.c.tick(), 'validating')
  }
  // 3 min with no beacon: hoai ends claude (SIGTERM); the daemon's clean shutdown says so.
  disk.clock.now += 30 * SEC
  first.c.noteEnded(true)
  assert.ok(readJson(disk, first.record).endedAt, 'a clean end is on the record')
  disk.clock.now += 20 * SEC
  const second = agent(disk, { running: '0.81.0', staged: null })
  assert.equal(await second.c.tick(), 'validating')
  assert.equal(second.rollbackInstalls.length, 0)
  assert.equal(readJson(disk, second.record).rearrived, true)
  disk.clock.now += 30 * SEC
  second.c.noteEnded(true)
  disk.clock.now += 20 * SEC
  const third = agent(disk, { running: '0.81.0', staged: null })
  assert.equal(await third.c.tick(), 'rollback', 'one re-arrival per record, never a loop')
})

test('a new build whose daemon crashed (no clean end) a minute before hoai relaunched it is a failed build, however recently it polled', async () => {
  const disk = await afterAsk()
  const first = agent(disk, { running: '0.81.0', staged: null })
  first.s.startupComplete = false
  assert.equal(await first.c.tick(), 'validating')
  for (let i = 0; i < 4; i += 1) {
    disk.clock.now += 30 * SEC
    assert.equal(await first.c.tick(), 'validating')
  }
  // The daemon dies here (no shutdown): claude stays up, and hoai relaunches at 3 min.
  disk.clock.now += 70 * SEC
  const second = agent(disk, { running: '0.81.0', staged: null })
  assert.equal(await second.c.tick(), 'rollback')
  assert.equal(second.rollbackInstalls.length, 1)
})

const FRESH = '33333333-4444-4555-8666-777788889999'
function onFreshSession(a: ReturnType<typeof agent>) {
  a.s.session = FRESH
  a.s.listing = { ok: true, processes: table(912).map((p) => (p.pid === 91240 ? { ...p, command: `claude --session-id ${FRESH}` } : p)) }
  return a
}

test('a boot on a new session after a clean end that then crashes is a failed build: the clean end was the boot before\'s', async () => {
  const disk = await afterAsk()
  const first = agent(disk, { running: '0.81.0', staged: null })
  first.s.startupComplete = false
  assert.equal(await first.c.tick(), 'validating')
  disk.clock.now += 3 * MIN
  first.c.noteEnded(true)
  assert.ok(readJson(disk, first.record).endedAt)
  // hoai's resume died, so it retried fresh: a new session, whose daemon crashes (no end of its own).
  disk.clock.now += 20 * SEC
  const second = onFreshSession(agent(disk, { running: '0.81.0', staged: null }))
  second.s.startupComplete = false
  assert.equal(await second.c.tick(), 'validating')
  assert.equal(readJson(disk, second.record).endedAt, null)
  disk.clock.now += 3 * MIN
  const third = onFreshSession(agent(disk, { running: '0.81.0', staged: null }))
  assert.equal(await third.c.tick(), 'rollback')
  assert.equal(third.rollbackInstalls.length, 1)
})

test('a clean end never overwrites a record another boot settled since, or another attempt\'s', async () => {
  const disk = await afterAsk()
  const old = agent(disk, { running: '0.81.0', staged: null })
  assert.equal(await old.c.tick(), 'validating')
  old.s.active = false
  disk.clock.now += 10 * SEC
  assert.equal(await old.c.tick(), 'passive')
  // Another session of this agent took the lock and settled the record on its own boot.
  disk.clock.now += 10 * SEC
  const other = onFreshSession(agent(disk, { running: '0.81.0', staged: null }))
  assert.equal(await other.c.tick(), 'validating')
  const settled = disk.fs.readFile(old.record)
  // The lock comes back to this daemon, and it ends before its next poll: it holds the lock, so only the record on
  // disk stops it.
  other.s.active = false
  old.s.active = true
  old.c.noteEnded(true)
  assert.equal(disk.fs.readFile(old.record), settled, 'a later boot\'s record is kept')
  // A newer attempt on disk (another version) is kept too.
  const newer = { ...readJson(disk, old.record), nonce: '912-other', target: '0.82.0', from: '0.81.0', state: 'requested', attempts: [] }
  delete newer.arrivedAt
  disk.fs.writeAtomic(old.record, `${JSON.stringify(newer, null, 2)}\n`)
  const before = disk.fs.readFile(old.record)
  old.c.noteEnded(true)
  assert.equal(disk.fs.readFile(old.record), before, 'another attempt\'s record is kept')
})

/**
 * D1 validating (with the backend `down` for a while first), then passive (for `away` before the other boot) while
 * another session of the agent settles the same attempt on its own boot (and, with `meanwhile`, proves what it can)
 * and goes away.
 */
async function lockMovedAndBack({ away = 10 * SEC, down = 0, meanwhile }: { away?: number; down?: number; meanwhile?: (other: ReturnType<typeof agent>, disk: ReturnType<typeof memDisk>) => Promise<void> } = {}) {
  const disk = await afterAsk()
  const old = agent(disk, { running: '0.81.0', staged: null })
  assert.equal(await old.c.tick(), 'validating')
  if (down) {
    old.s.unreachable = true
    for (let t = 0; t < down; t += MIN) {
      disk.clock.now += MIN
      assert.equal(await old.c.tick(), 'validating')
    }
    old.s.unreachable = false
  }
  old.s.active = false
  disk.clock.now += 10 * SEC
  assert.equal(await old.c.tick(), 'passive')
  disk.clock.now += away
  const other = onFreshSession(agent(disk, { running: '0.81.0', staged: null }))
  assert.equal(await other.c.tick(), 'validating')
  if (meanwhile) await meanwhile(other, disk)
  const settled = disk.fs.readFile(old.record) as string
  // The other session ends; the old daemon, polling passively meanwhile, holds the lock again.
  for (let i = 0; i < 10; i += 1) {
    disk.clock.now += MIN
    assert.equal(await old.c.tick(), 'passive')
  }
  old.s.active = true
  return { disk, old, other, settled }
}

test('a daemon that holds the lock again after another boot settled the same attempt keeps validating on that record: a deaf build still rolls back, nothing overwritten', async () => {
  // However long this daemon was without the lock, or without the backend, before the other boot arrived, the
  // deadline counts from that arrival only once: the time before it is not taken off again.
  for (const { away, down } of [{ away: 10 * SEC, down: 0 }, { away: 3 * HOUR, down: 0 }, { away: 10 * SEC, down: 30 * MIN }]) {
    const { disk, old, settled } = await lockMovedAndBack({ away, down })
    assert.equal(await old.c.tick(), 'validating', 'the attempt has no verdict yet, and this boot is the one to give it')
    assert.equal(disk.fs.readFile(old.record), settled)
    let result = 'validating'
    let active = 0
    while (result === 'validating' && active < 20 * MIN) {
      disk.clock.now += 30 * SEC
      active += 30 * SEC
      result = await old.c.tick()
    }
    assert.equal(result, 'rollback', `away ${away}, down ${down}`)
    assert.ok(active >= 15 * MIN, 'the deadline counts the time this boot held the lock, not the passive minutes')
    assert.equal(old.rollbackInstalls.length, 1)
    const after = readJson(disk, old.record)
    assert.equal(after.pin, FRESH, 'the newer record, extended, never the old copy written over it')
    assert.equal(after.contextLost, true)
  }
})

test('a daemon that adopts the record another boot settled drops that boot\'s clean end and live proof: its own crash is still a failed build', async () => {
  const { disk, old } = await lockMovedAndBack({
    meanwhile: async (other, disk) => {
      disk.clock.now += 20 * SEC
      other.s.heartbeatOkAtMs = disk.clock.now
      other.s.beaconAtMs = disk.clock.now
      assert.equal(await other.c.tick(), 'validating')
      assert.ok(readJson(disk, other.record).liveAt, 'the other boot proved live')
      other.c.noteEnded(true)
      assert.ok(readJson(disk, other.record).endedAt, 'and ended cleanly')
    },
  })
  assert.equal(await old.c.tick(), 'validating')
  const adopted = readJson(disk, old.record)
  assert.equal(adopted.liveAt, null, 'the other boot\'s live proof is not this one\'s')
  assert.equal(adopted.endedAt, null, 'nor is its clean end')
  assert.equal(adopted.pin, FRESH)
  // This daemon dies with no end of its own; the next boot on the same session finds no proof, so the build failed.
  disk.clock.now += 3 * MIN
  const next = onFreshSession(agent(disk, { running: '0.81.0', staged: null }))
  assert.equal(await next.c.tick(), 'rollback')
  assert.equal(next.rollbackInstalls.length, 1)
})

test('a daemon that holds the lock again validates a healthy build on the record the other boot settled', async () => {
  const { disk, old } = await lockMovedAndBack()
  assert.equal(await old.c.tick(), 'validating')
  disk.clock.now += 20 * SEC
  old.s.heartbeatOkAtMs = disk.clock.now
  old.s.beaconAtMs = disk.clock.now
  assert.equal(await old.c.tick(), 'validating')
  disk.clock.now += 5 * MIN + SEC
  old.s.heartbeatOkAtMs = disk.clock.now
  old.s.beaconAtMs = disk.clock.now
  assert.equal(await old.c.tick(), 'validated')
  const after = readJson(disk, old.record)
  assert.equal(after.state, 'validated')
  assert.equal(after.pin, FRESH)
})

test('the other boot, alive and holding the lock again after this daemon gave the adopted attempt its verdict, writes nothing over it', async () => {
  const { disk, old, other } = await lockMovedAndBack()
  other.s.active = false
  assert.equal(await old.c.tick(), 'validating')
  disk.clock.now += 20 * SEC
  old.s.heartbeatOkAtMs = disk.clock.now
  old.s.beaconAtMs = disk.clock.now
  assert.equal(await old.c.tick(), 'validating')
  disk.clock.now += 5 * MIN + SEC
  old.s.heartbeatOkAtMs = disk.clock.now
  old.s.beaconAtMs = disk.clock.now
  assert.equal(await old.c.tick(), 'validated')
  const verdict = disk.fs.readFile(old.record)
  // The lock goes back to the other boot, whose copy of the attempt has no verdict and the same arrival.
  old.s.active = false
  other.s.active = true
  disk.clock.now += 30 * SEC
  assert.equal(await other.c.tick(), 'superseded')
  other.c.noteEnded(true)
  for (let i = 0; i < 10; i += 1) {
    disk.clock.now += MIN
    await other.c.tick()
  }
  assert.equal(disk.fs.readFile(old.record), verdict, 'the verdict stands')
  assert.equal(other.rollbackInstalls.length, 0)
})

test('a clean end from a daemon that no longer holds the lock writes nothing, after another daemon adopted the attempt', async () => {
  const { disk, old, other } = await lockMovedAndBack()
  other.s.active = false
  assert.equal(await old.c.tick(), 'validating')
  const adopted = disk.fs.readFile(old.record)
  other.c.noteEnded(true)
  assert.equal(disk.fs.readFile(old.record), adopted, 'the record is the lock holder\'s to write')
})

test('a daemon whose own failed boot is the last attempt adopts a later boot\'s settle of it: no rollback ran, so the verdict is still its to give', async () => {
  const disk = await afterAsk()
  const first = agent(disk, { running: '0.81.0', staged: null })
  assert.equal(await first.c.tick(), 'validating')
  // That daemon dies with no end of its own; the next boot is a failed one, under an expired login: no rollback.
  disk.clock.now += 3 * MIN
  const old = agent(disk, { running: '0.81.0', staged: null })
  old.s.loginExpired = true
  assert.equal(await old.c.tick(), 'validating')
  assert.equal(readJson(disk, old.record).attempts.at(-1).outcome, 'second_boot')
  assert.equal(old.rollbackInstalls.length, 0)
  old.s.loginExpired = false
  disk.clock.now += 20 * SEC
  old.s.heartbeatOkAtMs = disk.clock.now
  old.s.beaconAtMs = disk.clock.now
  assert.equal(await old.c.tick(), 'validating')
  assert.ok(readJson(disk, old.record).liveAt)
  old.s.active = false
  disk.clock.now += 10 * SEC
  assert.equal(await old.c.tick(), 'passive')
  // Another session on the same conversation re-arrives (it appends no attempt) and goes away.
  disk.clock.now += 10 * SEC
  const other = agent(disk, { running: '0.81.0', staged: null })
  assert.equal(await other.c.tick(), 'validating')
  assert.equal(readJson(disk, other.record).attempts.at(-1).outcome, 'second_boot')
  other.s.active = false
  old.s.active = true
  disk.clock.now += MIN
  assert.equal(await old.c.tick(), 'validating', 'its own failed boot is no rollback under way')
})

test('a lock that moved and came back between two polls still lets a live build hold from the adopted arrival', async () => {
  const disk = await afterAsk()
  const old = agent(disk, { running: '0.81.0', staged: null })
  const beat = () => {
    old.s.heartbeatOkAtMs = disk.clock.now
    old.s.beaconAtMs = disk.clock.now
  }
  assert.equal(await old.c.tick(), 'validating')
  disk.clock.now += 20 * SEC
  beat()
  assert.equal(await old.c.tick(), 'validating', 'live: its hold has started')
  // Between two of its polls another session takes the lock, settles the attempt on its own boot, and goes away.
  disk.clock.now += 10 * SEC
  const other = onFreshSession(agent(disk, { running: '0.81.0', staged: null }))
  assert.equal(await other.c.tick(), 'validating')
  other.s.active = false
  let result = 'validating'
  for (let i = 0; i < 20 && result === 'validating'; i += 1) {
    disk.clock.now += 30 * SEC
    beat()
    result = await old.c.tick()
  }
  assert.equal(result, 'validated', 'the hold starts again from the adopted arrival')
})

test('a daemon that holds the lock again stands down, writing nothing, when the record on disk is another attempt or already has its verdict', async () => {
  // A failed boot or a missed deadline is a verdict too, given while the record still says arrived: the boot that gave
  // it was rolling back, and the next boot of this agent finishes that.
  for (const kind of ['another attempt', 'another attempt on this version', 'a verdict', 'second_boot', 'deadline'] as const) {
    const { disk, old, settled } = await lockMovedAndBack()
    const onDisk = JSON.parse(settled)
    const at = new Date(disk.clock.now).toISOString()
    const next =
      kind === 'another attempt'
        ? { ...onDisk, nonce: '912-other', target: '0.82.0', from: '0.81.0', state: 'requested', arrivedAt: null, attempts: [] }
        : kind === 'another attempt on this version'
          ? { ...onDisk, nonce: '912-other', arrivedAt: at }
          : kind === 'a verdict'
            ? { ...onDisk, state: 'validated', validatedAt: at }
            : { ...onDisk, attempts: [...onDisk.attempts, { at, outcome: kind }] }
    disk.fs.writeAtomic(old.record, `${JSON.stringify(next, null, 2)}\n`)
    const before = disk.fs.readFile(old.record)
    assert.equal(await old.c.tick(), 'superseded', kind)
    assert.equal(old.c.phase(), 'watch', kind)
    disk.clock.now += 10 * MIN
    assert.notEqual(await old.c.tick(), 'validating', kind)
    assert.equal(disk.fs.readFile(old.record), before, kind)
    assert.equal(old.rollbackInstalls.length, 0, kind)
  }
})

test('a disk that refused the settle write leaves this daemon validating on the record it kept', async () => {
  const disk = await afterAsk()
  const a = agent(disk, { running: '0.81.0', staged: null })
  const write = disk.fs.writeAtomic
  disk.fs.writeAtomic = (p: string, text: string) => (p === a.record ? false : write(p, text))
  assert.equal(await a.c.tick(), 'validating')
  assert.equal(readJson(disk, a.record).state, 'requested', 'the disk kept the older state')
  disk.clock.now += 20 * SEC
  a.s.heartbeatOkAtMs = disk.clock.now
  a.s.beaconAtMs = disk.clock.now
  assert.equal(await a.c.tick(), 'validating')
  disk.clock.now += 5 * MIN + SEC
  a.s.heartbeatOkAtMs = disk.clock.now
  a.s.beaconAtMs = disk.clock.now
  assert.equal(await a.c.tick(), 'validated')
})

test('the clean end signals are open only from arrival to the first live proof, so every other daemon keeps main\'s signals', async () => {
  const disk = await afterAsk()
  const a = agent(disk, { running: '0.81.0', staged: null })
  assert.deepEqual(a.guards, [])
  assert.equal(await a.c.tick(), 'validating')
  assert.deepEqual(a.guards, [true], 'open from the arrival')
  disk.clock.now += 20 * SEC
  assert.equal(await a.c.tick(), 'validating')
  assert.deepEqual(a.guards, [true], 'said once')
  a.s.heartbeatOkAtMs = disk.clock.now
  a.s.beaconAtMs = disk.clock.now
  assert.equal(await a.c.tick(), 'validating')
  // Past liveAt a death re-arrives whatever it was, so the daemon is back to main's signals for the rest of the hold.
  assert.ok(readJson(disk, a.record).liveAt)
  assert.deepEqual(a.guards, [true, false])
})

test('the clean end signals stay shut for a daemon with no attempt, and close when an attempt ends another way', async () => {
  const idleDisk = memDisk()
  const quiet = agent(idleDisk)
  quiet.s.activity = [idleDisk.clock.now]
  assert.equal(await quiet.c.tick(), 'recent_activity')
  assert.deepEqual(quiet.guards, [], 'an agent with nothing to prove never touches a signal')
  const stopped = await afterAsk()
  const b = agent(stopped, { running: '0.81.0', staged: null })
  await b.c.tick()
  b.c.stop()
  assert.deepEqual(b.guards, [true, false], 'a stopped controller closes them')
  const dead = await afterAsk()
  const c = agent(dead, { running: '0.81.0', staged: null })
  await c.c.tick()
  c.s.deaf = true
  dead.clock.now += 16 * MIN
  await c.c.tick()
  assert.equal(c.c.phase(), 'rollback')
  assert.deepEqual(c.guards, [true, false], 'a failed build has no clean end left to note')

  const d = agent(await afterAsk(), { running: '0.81.0', staged: null })
  assert.equal(await d.c.tick(), 'validating')
  d.s.active = false
  assert.equal(await d.c.tick(), 'passive')
  assert.deepEqual(d.guards, [true, false], 'a daemon that lost the lock writes no clean end, so it borrows nothing for one')
  d.s.active = true
  assert.equal(await d.c.tick(), 'validating')
  assert.deepEqual(d.guards, [true, false, true], 'and it borrows them again with the lock')
})

test('a clean end outside validation writes nothing', async () => {
  const disk = memDisk()
  const a = agent(disk)
  assert.equal(await a.c.tick(), 'requested')
  const before = disk.fs.readFile(a.record)
  a.c.noteEnded(true)
  assert.equal(disk.fs.readFile(a.record), before)
})

test('an end that is not a clean one (a fault in the broken-pipe class, stdin still open) writes nothing while validating', async () => {
  const disk = await afterAsk()
  const a = agent(disk, { running: '0.81.0', staged: null })
  assert.equal(await a.c.tick(), 'validating')
  const before = disk.fs.readFile(a.record)
  a.c.noteEnded(false)
  assert.equal(disk.fs.readFile(a.record), before)
  assert.equal(readJson(disk, a.record).endedAt ?? null, null)
})

test('time spent passive during validation is not counted toward the deadline', async () => {
  const disk = await afterAsk()
  const a = agent(disk, { running: '0.81.0', staged: null })
  assert.equal(await a.c.tick(), 'validating')
  a.s.active = false
  for (let i = 0; i < 8; i += 1) {
    disk.clock.now += 30 * SEC
    assert.equal(await a.c.tick(), 'passive')
  }
  a.s.active = true
  disk.clock.now += 12 * MIN
  assert.equal(await a.c.tick(), 'validating', 'four minutes passive, twelve holding the lock: not yet fifteen minutes of chance')
  disk.clock.now += 3 * MIN + SEC
  assert.equal(await a.c.tick(), 'rollback')
})

test('one unproven authority reading never gives up the rollback restart: it waits, and asks for a restart by hand only after 10 min unproven', async () => {
  const blip = await rolledBackCanary()
  blip.a.s.listing = { ok: false }
  assert.equal(await blip.a.c.tick(), 'rollback_waiting')
  assert.notEqual(lastReport(blip.a)?.code, 'idle_update_rollback_failed')
  blip.disk.clock.now += 5 * MIN
  blip.a.s.listing = { ok: true, processes: table(912) }
  assert.equal(await blip.a.c.tick(), 'rollback_requested', 'a proven reading clears it')

  const gone = await rolledBackCanary()
  gone.a.s.listing = { ok: false }
  assert.equal(await gone.a.c.tick(), 'rollback_waiting')
  gone.disk.clock.now += 9 * MIN
  assert.equal(await gone.a.c.tick(), 'rollback_waiting')
  gone.disk.clock.now += MIN + SEC
  assert.equal(await gone.a.c.tick(), 'rollback_staged')
  assert.equal(lastReport(gone.a)?.code, 'idle_update_rollback_failed')
  assert.match(lastReport(gone.a)?.message ?? '', /by hand/)
  assert.equal(gone.a.rollbackRestarts.length, 0)
})

test('the rollback restart through an owning service waits for a stray job in its group', async () => {
  const { a } = await rolledBackCanary()
  a.s.ownsUs = true
  a.s.strays = { ok: true, strays: [4242] }
  assert.equal(await a.c.tick(), 'rollback_waiting')
  assert.equal(a.rollbackRestarts.length, 0)
  a.s.strays = { ok: true, strays: [] }
  assert.equal(await a.c.tick(), 'rollback_requested')
})

test('an outage before startup completed is not subtracted again from the deadline after it', async () => {
  const disk = await afterAsk()
  const a = agent(disk, { running: '0.81.0', staged: null })
  a.s.startupComplete = false
  a.s.unreachable = true
  assert.equal(await a.c.tick(), 'validating')
  for (let i = 0; i < 10; i += 1) {
    disk.clock.now += 30 * SEC
    assert.equal(await a.c.tick(), 'validating')
  }
  a.s.unreachable = false
  a.s.startupComplete = true
  assert.equal(await a.c.tick(), 'validating')
  disk.clock.now += 15 * MIN + SEC
  assert.equal(await a.c.tick(), 'rollback', 'five minutes since startup completed, none of them down')
})

test('an expired login before startup completed is not subtracted again from the deadline after it', async () => {
  const disk = await afterAsk()
  const a = agent(disk, { running: '0.81.0', staged: null })
  a.s.startupComplete = false
  a.s.loginExpired = true
  assert.equal(await a.c.tick(), 'validating')
  for (let i = 0; i < 10; i += 1) {
    disk.clock.now += 30 * SEC
    assert.equal(await a.c.tick(), 'validating')
  }
  a.s.loginExpired = false
  a.s.startupComplete = true
  assert.equal(await a.c.tick(), 'validating')
  disk.clock.now += 15 * MIN + SEC
  assert.equal(await a.c.tick(), 'rollback', 'five minutes since startup completed, none of them expired')
})

test('a break in liveness restarts the 5 min hold', async () => {
  const disk = await afterAsk()
  const a = agent(disk, { running: '0.81.0', staged: null })
  const live = () => {
    a.s.heartbeatOkAtMs = disk.clock.now - 5 * SEC
    a.s.beaconAtMs = disk.clock.now - 2 * SEC
  }
  assert.equal(await a.c.tick(), 'validating')
  disk.clock.now += 10 * SEC
  live()
  assert.equal(await a.c.tick(), 'validating')
  disk.clock.now += 5 * MIN + 30 * SEC
  a.s.deaf = true
  assert.equal(await a.c.tick(), 'validating')
  disk.clock.now += 40 * SEC
  a.s.deaf = false
  live()
  assert.equal(await a.c.tick(), 'validating', 'past the hold since the first live reading, but live again only now')
  disk.clock.now += 5 * MIN + SEC
  live()
  assert.equal(await a.c.tick(), 'validated')
})

test('a proven reading between unproven ones restarts the 10 min the rollback restart waits', async () => {
  const { disk, a } = await rolledBackCanary()
  a.s.listing = { ok: false }
  assert.equal(await a.c.tick(), 'rollback_waiting')
  disk.clock.now += 6 * MIN
  a.s.listing = { ok: true, processes: table(912) }
  a.s.openAsks = 1
  assert.equal(await a.c.tick(), 'rollback_waiting', 'proven, but an ask is open')
  a.s.openAsks = 0
  a.s.listing = { ok: false }
  disk.clock.now += 6 * MIN
  assert.equal(await a.c.tick(), 'rollback_waiting', 'six minutes unproven since the proven reading')
  assert.equal(a.rollbackRestarts.length, 0)
})

test('a process listing that fails is not remembered as a launch not proven unattended: the next close look proves it', async () => {
  for (const o of [{ authority: 'keepalive' }, { ownsUs: true }]) {
    const a = agent(memDisk(), o)
    a.s.listing = { ok: false }
    assert.notEqual(await a.c.tick(), 'requested', JSON.stringify(o))
    a.s.listing = { ok: true, processes: table(912) }
    disk_advance(a, 6 * MIN)
    assert.equal(await a.c.tick(), 'requested', JSON.stringify(o))
  }
})

test('an outage during validation is forgiven for an hour at most; past that its minutes count', async () => {
  const disk = await afterAsk()
  const a = agent(disk, { running: '0.81.0', staged: null })
  assert.equal(await a.c.tick(), 'validating')
  a.s.unreachable = true
  for (let i = 0; i < 122; i += 1) {
    disk.clock.now += 30 * SEC
    assert.equal(await a.c.tick(), 'validating', `minute ${(i + 1) / 2}`)
  }
  // 61 min down so far, one of them past the cap.
  disk.clock.now += 13 * MIN
  assert.equal(await a.c.tick(), 'validating', 'seventy-four minutes down, still down: fourteen of them counted')
  disk.clock.now += MIN + SEC
  assert.equal(await a.c.tick(), 'rollback')
})

test('minutes under an expired login are not counted toward the deadline once it lifts', async () => {
  const disk = await afterAsk()
  const a = agent(disk, { running: '0.81.0', staged: null })
  assert.equal(await a.c.tick(), 'validating')
  a.s.loginExpired = true
  for (let i = 0; i < 60; i += 1) {
    disk.clock.now += 30 * SEC
    assert.equal(await a.c.tick(), 'validating')
  }
  a.s.loginExpired = false
  disk.clock.now += 30 * SEC
  assert.equal(await a.c.tick(), 'validating', 'thirty minutes expired, thirty seconds since')
  disk.clock.now += 15 * MIN
  assert.equal(await a.c.tick(), 'rollback')
})

test('the hold needs the beacon touched again during it: one beacon still fresh from the first live reading never validates', async () => {
  const disk = await afterAsk()
  // A beacon stays fresh 30 s at this scale, past the 15 s hold. At scale 1 it goes stale first, and that alone breaks the hold.
  const a = agent(disk, { running: '0.81.0', staged: null, scale: 20 })
  assert.equal(await a.c.tick(), 'validating')
  disk.clock.now += SEC
  a.s.heartbeatOkAtMs = disk.clock.now
  a.s.beaconAtMs = disk.clock.now
  assert.equal(await a.c.tick(), 'validating')
  disk.clock.now += 16 * SEC
  a.s.heartbeatOkAtMs = disk.clock.now
  assert.equal(await a.c.tick(), 'validating', 'the beacon stopped after one touch')
  a.s.beaconAtMs = disk.clock.now
  assert.equal(await a.c.tick(), 'validated')
})

test('validation asks for a heartbeat while none has landed since the hold began', async () => {
  const disk = await afterAsk()
  const a = agent(disk, { running: '0.81.0', staged: null })
  assert.equal(await a.c.tick(), 'validating')
  disk.clock.now += 10 * SEC
  a.s.heartbeatOkAtMs = disk.clock.now - 5 * SEC
  a.s.beaconAtMs = disk.clock.now
  assert.equal(await a.c.tick(), 'validating')
  const asked = a.heartbeatRequests
  disk.clock.now += 30 * SEC
  a.s.beaconAtMs = disk.clock.now
  assert.equal(await a.c.tick(), 'validating')
  assert.equal(a.heartbeatRequests, asked + 1, 'the beat before the hold proves nothing about the hold')
})

test('the rollback restart waits 10 min at most for a stray in its owning unit\'s group, then asks for a restart by hand', async () => {
  const { disk, a } = await rolledBackCanary()
  a.s.ownsUs = true
  a.s.strays = { ok: true, strays: [4242] }
  assert.equal(await a.c.tick(), 'rollback_waiting')
  disk.clock.now += 9 * MIN
  assert.equal(await a.c.tick(), 'rollback_waiting')
  disk.clock.now += MIN + SEC
  assert.equal(await a.c.tick(), 'rollback_staged')
  assert.match(lastReport(a)?.message ?? '', /by hand/)
  assert.equal(a.rollbackRestarts.length, 0)
})

test('an expired shared login holds validation: no rollback for a failure that is not the build\'s', async () => {
  const disk = await afterAsk()
  const a = agent(disk, { running: '0.81.0', staged: null })
  await a.c.tick()
  a.s.loginExpired = true
  disk.clock.now += 10 * MIN
  assert.equal(await a.c.tick(), 'validating')
  assert.equal(a.rollbackInstalls.length, 0)
})

test('a second boot of the new build before it validated is a failed build: the canary rolls back', async () => {
  const disk = await afterAsk()
  const first = agent(disk, { running: '0.81.0', staged: null })
  assert.equal(await first.c.tick(), 'validating')
  disk.clock.now += 3 * MIN
  const second = agent(disk, { running: '0.81.0', staged: null })
  assert.equal(await second.c.tick(), 'rollback')
  assert.equal(second.rollbackInstalls.length, 1)
})

test('a rollback that cannot be done is said, the version still held bad, and nothing is tried again', async () => {
  const disk = await afterAsk()
  const a = agent(disk, { running: '0.81.0', staged: null })
  await a.c.tick()
  a.s.rollbackOk = false
  disk.clock.now += 15 * MIN + SEC
  assert.equal(await a.c.tick(), 'rollback_failed')
  assert.ok(disk.files.has(join(MACHINE, '0.81.0', 'bad')))
  assert.equal(readJson(disk, a.record).state, 'rollback_failed')
  assert.equal(lastReport(a)?.code, 'idle_update_rollback_failed')
  assert.equal(a.rollbackRestarts.length, 0)
})

test('back on the old version after a rollback: reported, the lease released; other agents hold the version', async () => {
  const disk = await afterAsk()
  const a = agent(disk, { running: '0.81.0', staged: null })
  await a.c.tick()
  disk.clock.now += 15 * MIN + SEC
  assert.equal(await a.c.tick(), 'rollback')
  assert.equal(await a.c.tick(), 'rollback_requested')
  disk.clock.now += 40 * SEC
  const back = agent(disk, { running: '0.80.0', staged: null })
  assert.equal(await back.c.tick(), 'nothing_staged')
  assert.equal(lastReport(back)?.code, 'idle_update_rolled_back')
  assert.equal(disk.files.has(join(MACHINE, 'lease.json')), false)
  const other = agent(disk, { id: 913 })
  disk.clock.now += 3 * MIN
  assert.equal(await other.c.tick(), 'version_held_bad')
  assert.equal(lastReport(other)?.code, 'idle_update_held')
})

test('came back on the old version: a failed attempt, the canary voided for the next agent, lease released', async () => {
  const disk = await afterAsk()
  const a = agent(disk, { running: '0.80.0' })
  assert.equal(await a.c.tick(), 'attempted')
  assert.equal(readJson(disk, a.record).state, 'came_back_old')
  assert.ok(disk.files.has(join(MACHINE, '0.81.0', 'void-1')))
  assert.equal(disk.files.has(join(MACHINE, 'lease.json')), false)
  assert.equal(lastReport(a)?.code, 'scheduled_update_failed')
})

test('a nonce read from disk never names a path: one that climbs out of the machine folder moves and deletes nothing there', async () => {
  const disk = await afterAsk()
  const climb = 'x/../../victim'
  const rec = readJson(disk, join('/home/a/.bgos-agent', '912', 'idle-update.json'))
  disk.fs.writeAtomic(join('/home/a/.bgos-agent', '912', 'idle-update.json'), JSON.stringify({ ...rec, nonce: climb }))
  const lease = readJson(disk, join(MACHINE, 'lease.json'))
  disk.fs.writeAtomic(join(MACHINE, 'lease.json'), JSON.stringify({ ...lease, nonce: climb }))
  const victim = join('/home/a/.bgos-agent', 'victim.json')
  disk.fs.writeAtomic(victim, '{"keep":true}')
  const a = agent(disk, { running: '0.80.0' })
  await a.c.tick()
  assert.equal(disk.fs.readFile(victim), '{"keep":true}', 'a file outside the machine folder is neither replaced nor deleted')
})

test('a new session on the new version: the lost conversation is said, and the build is still validated', async () => {
  const disk = await afterAsk()
  const a = agent(disk, { running: '0.81.0', staged: null })
  const fresh = '11111111-2222-4333-8444-555566667777'
  a.s.session = fresh
  a.s.listing = { ok: true, processes: table(912).map((p) => (p.pid === 91240 ? { ...p, command: `claude --session-id ${fresh}` } : p)) }
  assert.equal(await a.c.tick(), 'validating')
  assert.equal(lastReport(a)?.code, 'idle_update_context_lost')
  disk.clock.now += 20 * SEC
  a.s.heartbeatOkAtMs = disk.clock.now
  a.s.beaconAtMs = disk.clock.now
  assert.equal(await a.c.tick(), 'validating')
  disk.clock.now += 5 * MIN + SEC
  a.s.heartbeatOkAtMs = disk.clock.now
  a.s.beaconAtMs = disk.clock.now
  assert.equal(await a.c.tick(), 'validated')
})

test('the session at boot is read from claude\'s command line first: a fresh retry is caught before hoai repins it', async () => {
  const disk = await afterAsk()
  const a = agent(disk, { running: '0.81.0', staged: null })
  a.s.session = PIN
  const fresh = '22222222-3333-4444-8555-666677778888'
  a.s.listing = { ok: true, processes: table(912).map((p) => (p.pid === 91240 ? { ...p, command: `/Users/a/.local/bin/claude --dangerously-skip-permissions --session-id ${fresh}` } : p)) }
  assert.equal(await a.c.tick(), 'validating')
  assert.equal(lastReport(a)?.code, 'idle_update_context_lost')
  assert.equal(readJson(disk, a.record).pin, fresh)
})

const VBS = 'WScript.Quit shell.Run("""C:\\node.exe"" ""C:\\plugin\\bin\\hoai-core.mjs"" --keep-alive", 0, True)\r\n'
function winTable(launcherStartedAtMs: number) {
  return [
    { pid: 4, ppid: 0, command: 'System' },
    { pid: 900, ppid: 4, command: 'C:\\WINDOWS\\system32\\svchost.exe -k netsvcs -p -s Schedule' },
    { pid: 910, ppid: 900, command: '"C:\\WINDOWS\\System32\\WScript.exe" //B "C:\\Users\\kc\\.bgos-agent\\912\\run-agent.vbs"' },
    { pid: 920, ppid: 910, startedAtMs: launcherStartedAtMs, command: '"C:\\node.exe" C:\\plugin\\bin\\hoai-core.mjs --keep-alive' },
    { pid: 940, ppid: 920, command: `"C:\\Users\\kc\\.local\\bin\\claude.exe" --resume ${PIN}` },
    { pid: 91250, ppid: 940, command: 'C:\\Users\\kc\\.bun\\bin\\bun.exe C:\\plugin\\server.ts' },
  ]
}

test('Windows: the launcher\'s own process start, not the claim hoai rewrites at every relaunch, dates the hidden run-agent.vbs', async () => {
  const unattended = { ownSockets: [], runShPath: null, launchStatus: { outcome: null, mtimeMs: null }, runAgentVbs: { text: VBS, mtimeMs: T0 - 2 * HOUR }, runAgentVbsPath: 'C:\\Users\\kc\\.bgos-agent\\912\\run-agent.vbs' }
  // supervisor.json says T0 - 1 h (a relaunch rewrote it); the launcher process itself started at T0 - 3 h, BEFORE the
  // vbs was rewritten hidden: that launcher may have shown a console, so it is not proven unattended.
  const launcher = { pid: 920, startedAtMs: T0 - HOUR, markerPath: 'C:\\Users\\kc\\.bgos-agent\\912\\restart-requested.json', supervisorMtimeMs: T0 - HOUR }
  const before = agent(memDisk(), { platform: 'win32', authority: 'launcher', launcher, unattended })
  before.s.claudePid = 940
  before.s.listing = { ok: true, processes: winTable(T0 - 3 * HOUR) }
  assert.equal(await before.c.tick(), 'no_unattended_authority')
  const after = agent(memDisk(), { platform: 'win32', authority: 'launcher', launcher, unattended })
  after.s.claudePid = 940
  after.s.listing = { ok: true, processes: winTable(T0 - 90 * MIN) }
  assert.equal(await after.c.tick(), 'requested')
  assert.equal(after.restarts[0].proof, null, 'a launcher authority uses its own marker rung')
})

test('Windows: a launch proof refused on an input it could not read (run-agent.vbs mid-scan) is read again an hour on, not held for the daemon\'s life', async () => {
  const unattended: any = { ownSockets: [], runShPath: null, launchStatus: { outcome: null, mtimeMs: null }, runAgentVbs: { text: null, mtimeMs: null }, runAgentVbsPath: 'C:\\Users\\kc\\.bgos-agent\\912\\run-agent.vbs' }
  const launcher = { pid: 920, startedAtMs: T0 - HOUR, markerPath: 'C:\\Users\\kc\\.bgos-agent\\912\\restart-requested.json', supervisorMtimeMs: T0 - HOUR }
  const a = agent(memDisk(), { platform: 'win32', authority: 'launcher', launcher, unattended })
  a.s.claudePid = 940
  a.s.listing = { ok: true, processes: winTable(T0 - 90 * MIN) }
  assert.equal(await a.c.tick(), 'no_unattended_authority')
  unattended.runAgentVbs = { text: VBS, mtimeMs: T0 - 2 * HOUR }
  const listed = a.s.listings
  disk_advance(a, 6 * MIN)
  assert.equal(await a.c.tick(), 'no_unattended_authority', 'a refusal is not read again every 5 min')
  assert.equal(a.s.listings, listed)
  disk_advance(a, 55 * MIN)
  assert.equal(await a.c.tick(), 'requested', 'an hour on it is read again, and proves')
})

test('a person\'s own hoai (typed in a console, not the agent\'s hidden task) is refused once an hour at most, not listed every 5 min', async () => {
  const unattended: any = { ownSockets: [], runShPath: null, launchStatus: { outcome: null, mtimeMs: null }, runAgentVbs: { text: VBS, mtimeMs: T0 - 2 * HOUR }, runAgentVbsPath: 'C:\\Users\\kc\\.bgos-agent\\912\\run-agent.vbs' }
  const launcher = { pid: 920, startedAtMs: T0 - HOUR, markerPath: 'C:\\Users\\kc\\.bgos-agent\\912\\restart-requested.json', supervisorMtimeMs: T0 - HOUR }
  const a = agent(memDisk(), { platform: 'win32', authority: 'launcher', launcher, unattended })
  a.s.claudePid = 940
  a.s.listing = { ok: true, processes: winTable(T0 - 90 * MIN).map((p) => (p.pid === 910 ? { ...p, command: 'C:\\WINDOWS\\system32\\cmd.exe' } : p)) }
  assert.equal(await a.c.tick(), 'no_unattended_authority')
  const listed = a.s.listings
  for (let i = 0; i < 11; i += 1) {
    disk_advance(a, 5 * MIN)
    assert.equal(await a.c.tick(), 'no_unattended_authority')
  }
  assert.equal(a.s.listings, listed, 'no listing, schedule read or person probe for 55 min')
})

test('a launch proof refused on a row missing from the table is read again an hour on; one refused on what the table shows stays refused', async () => {
  const unattended: any = { ownSockets: [], runShPath: null, launchStatus: { outcome: null, mtimeMs: null }, runAgentVbs: { text: VBS, mtimeMs: T0 - 2 * HOUR }, runAgentVbsPath: 'C:\\Users\\kc\\.bgos-agent\\912\\run-agent.vbs' }
  const launcher = { pid: 920, startedAtMs: T0 - HOUR, markerPath: 'C:\\Users\\kc\\.bgos-agent\\912\\restart-requested.json', supervisorMtimeMs: T0 - HOUR }
  const gap = agent(memDisk(), { platform: 'win32', authority: 'launcher', launcher, unattended })
  gap.s.claudePid = 940
  gap.s.listing = { ok: true, processes: winTable(T0 - 90 * MIN).filter((p) => p.pid !== 940) }
  assert.equal(await gap.c.tick(), 'no_unattended_authority')
  gap.s.listing = { ok: true, processes: winTable(T0 - 90 * MIN) }
  disk_advance(gap, 61 * MIN)
  assert.equal(await gap.c.tick(), 'requested', 'claude\'s row was missing from one listing')
  // A launcher pid whose process is not hoai (a stale claim, a pid reused) stays refused without a listing every 5 min.
  const other = agent(memDisk(), { platform: 'win32', authority: 'launcher', launcher, unattended })
  other.s.claudePid = 940
  other.s.listing = { ok: true, processes: winTable(T0 - 90 * MIN).map((p) => (p.pid === 920 ? { ...p, command: '"C:\\node.exe" C:\\tools\\other.mjs' } : p)) }
  assert.equal(await other.c.tick(), 'no_unattended_authority')
  const listed = other.s.listings
  disk_advance(other, 6 * MIN)
  assert.equal(await other.c.tick(), 'no_unattended_authority')
  assert.equal(other.s.listings, listed)
})

test('validation asks for a heartbeat while none has gone out since the new build arrived (the boot beat may have gone first)', async () => {
  const disk = await afterAsk()
  const a = agent(disk, { running: '0.81.0', staged: null })
  a.s.heartbeatOkAtMs = disk.clock.now - 5 * SEC
  a.s.beaconAtMs = disk.clock.now
  assert.equal(await a.c.tick(), 'validating')
  assert.equal(a.heartbeatRequests, 1)
  disk.clock.now += 30 * SEC
  a.s.heartbeatOkAtMs = disk.clock.now
  assert.equal(await a.c.tick(), 'validating')
  assert.equal(a.heartbeatRequests, 1, 'no more once one went out at the new version')
})

test('a rollback restart that never arrives takes back its marker too: a late take would land at a moment nobody checked', async () => {
  const { disk, a } = await rolledBackCanaryAsked()
  disk.clock.now += 3.5 * MIN + SEC
  assert.equal(await a.c.tick(), 'rollback_staged')
  assert.equal(a.markerRemovals, 1)
  assert.equal(a.s.markerMtimeMs, null)
  assert.equal(lastReport(a)?.code, 'idle_update_rollback_failed')
})

/** The canary rolled the install back and asked hoai for the restart onto the old build: the marker waits. */
async function rolledBackCanaryAsked() {
  const disk = await afterAsk()
  const a = agent(disk, { running: '0.81.0', staged: null })
  a.s.askWritesMarker = true
  assert.equal(await a.c.tick(), 'validating')
  a.s.deaf = true
  a.s.heartbeatOkAtMs = disk.clock.now
  a.s.beaconAtMs = disk.clock.now
  disk.clock.now += 15 * MIN + SEC
  a.s.activity = [disk.clock.now - 3 * MIN]
  assert.equal(await a.c.tick(), 'rollback')
  assert.equal(await a.c.tick(), 'rollback_requested')
  return { disk, a }
}

// -- A failed non-canary's way back ----------------------------------------------------------------

/** Agent 912 restarted onto a version agent 913 validated from `canaryFrom`, and failed there at the deadline. */
async function failedFollower(o: { running?: string; canaryFrom?: string; installMethod?: string; wentBack?: string; held?: string; swept?: boolean } = {}) {
  const disk = memDisk()
  const from = o.canaryFrom ?? '0.80.0'
  if (!o.swept) disk.fs.writeAtomic(join(`/c/plugins/cache/hoai/hoai/${from}`, '.claude-plugin', 'plugin.json'), JSON.stringify({ version: from }))
  if (o.held) disk.fs.writeAtomic(join(MACHINE, o.held, 'bad'), JSON.stringify({ reason: 'canary_failed' }))
  proven(disk)
  disk.fs.writeAtomic(join(MACHINE, '0.81.0', 'validated'), JSON.stringify({ assistantId: '913', at: new Date(T0 - HOUR).toISOString(), canary: 1, from, fromRoot: `/c/plugins/cache/hoai/hoai/${from}` }))
  if (o.wentBack) disk.fs.writeAtomic(join(MACHINE, 'went-back-912'), JSON.stringify({ target: o.wentBack }))
  const old = agent(disk, { running: o.running, installMethod: o.installMethod })
  assert.equal(await old.c.tick(), 'requested')
  assert.equal(readJson(disk, old.record).canaryN, null)
  disk.clock.now += 40 * SEC
  const a = agent(disk, { running: '0.81.0', staged: null, installMethod: o.installMethod })
  assert.equal(await a.c.tick(), 'validating')
  disk.clock.now += 15 * MIN + SEC
  a.s.activity = [disk.clock.now - 3 * MIN]
  return { disk, a }
}

test('a failed non-canary has a way back: it takes the shared install back and restarts onto it, never left on a failing build', async () => {
  const { disk, a } = await failedFollower()
  assert.equal(await a.c.tick(), 'rollback')
  assert.equal(a.rollbackInstalls.length, 1)
  assert.equal(readJson(disk, a.record).state, 'rolled_back')
  assert.ok(disk.files.has(join(MACHINE, '0.81.0', 'bad')), 'no other agent follows it now')
  assert.equal(lastReport(a)?.code, 'idle_update_rolled_back')
  assert.equal(await a.c.tick(), 'rollback_requested')
  assert.deepEqual(a.rollbackRestarts.map((r) => r.target), ['0.80.0'])
  assert.ok(disk.files.has(join(MACHINE, 'went-back-912')), 'on the record for the next version')
})

test('an agent that came from an older build goes back to the canary\'s: never one agent\'s old build for the whole computer', async () => {
  const { disk, a } = await failedFollower({ running: '0.79.0', canaryFrom: '0.80.0' })
  assert.equal(await a.c.tick(), 'rollback')
  assert.equal(a.rollbackInstalls[0].from, '0.80.0')
  assert.equal(a.rollbackInstalls[0].fromRoot, '/c/plugins/cache/hoai/hoai/0.80.0')
  assert.equal(readJson(disk, a.record).from, '0.80.0', 'the report and the old daemon read this')
  assert.equal(await a.c.tick(), 'rollback_requested')
  assert.deepEqual(a.rollbackRestarts.map((r) => r.target), ['0.80.0'])
})

test('a follower passes over a canary build held bad since, and over a folder swept since: its own build is still a way back', async () => {
  for (const o of [{ held: '0.80.0' }, { swept: true }]) {
    const { disk, a } = await failedFollower({ running: '0.79.0', canaryFrom: '0.80.0', ...o })
    assert.equal(await a.c.tick(), 'rollback')
    assert.equal(a.rollbackInstalls[0].from, '0.79.0')
    assert.equal(a.rollbackInstalls[0].fromRoot, '/c/plugins/cache/hoai/hoai/0.79.0')
    assert.equal(readJson(disk, a.record).from, '0.79.0')
  }
})

test('a way back onto a version held bad still goes back: it is the build this agent ran, and the one it is on just failed', async () => {
  const disk = await afterAsk()
  disk.fs.writeAtomic(join(MACHINE, '0.80.0', 'bad'), JSON.stringify({ reason: 'canary_failed' }))
  const a = agent(disk, { running: '0.81.0', staged: null })
  assert.equal(await a.c.tick(), 'validating')
  disk.clock.now += 15 * MIN + SEC
  assert.equal(await a.c.tick(), 'rollback')
  assert.deepEqual(a.rollbackInstalls.map((r) => r.from), ['0.80.0'])
  assert.equal(lastReport(a)?.code, 'idle_update_rolled_back')
})

/** Agent 912 on a version agent 913 proved here, on its first boot there. */
async function followerArrived() {
  const disk = memDisk()
  proven(disk)
  const old = agent(disk)
  assert.equal(await old.c.tick(), 'requested')
  disk.clock.now += 40 * SEC
  const first = agent(disk, { running: '0.81.0', staged: null })
  assert.equal(await first.c.tick(), 'validating')
  disk.clock.now += 3 * MIN
  return disk
}

test('on a version the canary proved, a second boot is a verdict too: hoai relaunches once, so no third boot comes, and the latch is what stops the next follower', async () => {
  const disk = await followerArrived()
  const second = agent(disk, { running: '0.81.0', staged: null })
  assert.equal(await second.c.tick(), 'rollback')
  assert.equal(second.rollbackInstalls.length, 1)
  assert.ok(disk.files.has(join(MACHINE, '0.81.0', 'bad')))
  assert.ok(disk.files.has(join(MACHINE, 'went-back-912')))
})

test('a missed deadline leaves no live proof behind: the boot after a crash before the repoint finishes the way back', async () => {
  const disk = await afterAsk()
  const a = agent(disk, { running: '0.81.0', staged: null })
  assert.equal(await a.c.tick(), 'validating')
  a.s.heartbeatOkAtMs = disk.clock.now
  a.s.beaconAtMs = disk.clock.now
  assert.equal(await a.c.tick(), 'validating')
  assert.ok(readJson(disk, a.record).liveAt)
  disk.clock.now += 15 * MIN + SEC
  a.s.installGate = new Promise(() => {})
  void a.c.tick()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(readJson(disk, a.record).attempts.at(-1).outcome, 'deadline')
  const next = agent(disk, { running: '0.81.0', staged: null })
  assert.equal(await next.c.tick(), 'rollback')
  assert.equal(next.rollbackInstalls.length, 1)
})

test('a rollback that finds no quiet moment for 3 h stops saying it went back, and asks for a person', async () => {
  const disk = await afterAsk()
  const a = agent(disk, { running: '0.81.0', staged: null })
  assert.equal(await a.c.tick(), 'validating')
  disk.clock.now += 15 * MIN + SEC
  a.s.openAsks = 1
  assert.equal(await a.c.tick(), 'rollback')
  assert.equal(await a.c.tick(), 'rollback_waiting')
  assert.equal(lastReport(a)?.code, 'idle_update_rolled_back')
  disk.clock.now += 3 * HOUR - MIN
  assert.equal(await a.c.tick(), 'rollback_waiting')
  disk.clock.now += MIN + SEC
  assert.equal(await a.c.tick(), 'rollback_staged')
  assert.equal(a.rollbackRestarts.length, 0)
  assert.equal(lastReport(a)?.code, 'idle_update_rollback_failed')
})

test('a poison agent takes the computer back once: on the next failure it stays and asks for a person, so no release is held for ever', async () => {
  const { disk, a } = await failedFollower({ wentBack: '0.79.0' })
  assert.equal(await a.c.tick(), 'failed')
  assert.equal(a.rollbackInstalls.length, 0)
  assert.equal(disk.files.has(join(MACHINE, '0.81.0', 'bad')), false)
  assert.equal(readJson(disk, a.record).state, 'failed')
  assert.equal(lastReport(a)?.code, 'idle_update_failed')
})

test('a way back a crash cut short is not spent: the next boot finishes it, and gate 7 keeps that from being a loop', async () => {
  const { disk, a } = await failedFollower({ wentBack: '0.81.0' })
  assert.equal(await a.c.tick(), 'rollback')
  assert.equal(a.rollbackInstalls.length, 1)
  assert.equal(readJson(disk, a.record).state, 'rolled_back')
})

test('a validated build clears it: an agent that proved healthy may go back again on a later bad build', async () => {
  const disk = await afterAsk()
  disk.fs.writeAtomic(join(MACHINE, 'went-back-912'), '{}')
  const a = agent(disk, { running: '0.81.0', staged: null })
  assert.equal(await a.c.tick(), 'validating')
  a.s.heartbeatOkAtMs = disk.clock.now
  a.s.beaconAtMs = disk.clock.now
  assert.equal(await a.c.tick(), 'validating')
  disk.clock.now += 5 * MIN + SEC
  a.s.heartbeatOkAtMs = disk.clock.now
  a.s.beaconAtMs = disk.clock.now
  assert.equal(await a.c.tick(), 'validated')
  assert.equal(disk.files.has(join(MACHINE, 'went-back-912')), false)
})

test('the canary\'s validated file carries where it came from, so a later failure knows the way back', async () => {
  const disk = await afterAsk()
  const a = agent(disk, { running: '0.81.0', staged: null })
  assert.equal(await a.c.tick(), 'validating')
  a.s.heartbeatOkAtMs = disk.clock.now
  a.s.beaconAtMs = disk.clock.now
  assert.equal(await a.c.tick(), 'validating')
  disk.clock.now += 5 * MIN + SEC
  a.s.heartbeatOkAtMs = disk.clock.now
  a.s.beaconAtMs = disk.clock.now
  assert.equal(await a.c.tick(), 'validated')
  const body = readJson(disk, join(MACHINE, '0.81.0', 'validated'))
  assert.equal(body.from, '0.80.0')
  assert.equal(body.fromRoot, '/c/plugins/cache/hoai/hoai/0.80.0')
})

// -- An agent that goes silent past its lease --------------------------------------------------------

const silentFiles = (disk: ReturnType<typeof memDisk>) => [...disk.files.keys()].filter((p) => /silent-/.test(p))

/** Agent 913 proved this version here an hour ago, and has delivered since. */
function proven(disk: ReturnType<typeof memDisk>, target = '0.81.0') {
  disk.fs.writeAtomic(join(MACHINE, target, 'validated'), JSON.stringify({ assistantId: '913', at: new Date(disk.clock.now - HOUR).toISOString(), canary: 1 }))
  disk.fs.writeAtomic(join(MACHINE, target, 'alive'), JSON.stringify({ assistantId: '913', at: new Date(disk.clock.now).toISOString(), provedMs: 60 * MIN }))
}

/** A follower restarts onto the version and is never heard from again: its lease stands with no outcome. */
async function goesSilent(disk: ReturnType<typeof memDisk>, id: number) {
  const gone = agent(disk, { id })
  assert.equal(await gone.c.tick(), 'requested')
  assert.equal(readJson(disk, gone.record).canaryN, null, 'a follower')
  return readJson(disk, join(MACHINE, 'lease.json'))
}

test('a follower that never came back: the next agent writes silent-1 as it breaks the lease, and does not walk on', async () => {
  const disk = memDisk()
  proven(disk)
  const lease = await goesSilent(disk, 912)
  disk.clock.now += 25 * MIN + SEC
  const next = agent(disk, { id: 914 })
  assert.equal(await next.c.tick(), 'canary_unconfirmed')
  assert.equal(next.restarts.length, 0)
  assert.deepEqual(next.drains, [])
  const silent = readJson(disk, join(MACHINE, '0.81.0', 'silent-1'))
  assert.equal(silent.assistantId, '912')
  assert.equal(silent.nonce, lease.nonce)
  assert.equal(silent.by, '914')
  assert.equal(disk.files.has(join(MACHINE, 'lease.json')), false, 'the breaker holds no lease it will not use')
})

test('one silent agent holds the version 24 h for everyone, then the next agent may try', async () => {
  const disk = memDisk()
  proven(disk)
  await goesSilent(disk, 912)
  disk.clock.now += 25 * MIN + SEC
  const next = agent(disk, { id: 914 })
  assert.equal(await next.c.tick(), 'canary_unconfirmed')
  disk.clock.now += 3 * MIN
  assert.equal(await next.c.tick(), 'silent_hold')
  assert.equal(await agent(disk, { id: 915 }).c.tick(), 'silent_hold')
  disk.clock.now += 23 * HOUR
  assert.equal(await next.c.tick(), 'silent_hold')
  disk.clock.now += HOUR
  proven(disk)
  assert.equal(await next.c.tick(), 'requested')
  assert.equal(next.restarts.length, 1)
})

test('two silent agents mark the build bad where every reader looks, and no third agent moves', async () => {
  const disk = memDisk()
  proven(disk)
  await goesSilent(disk, 912)
  disk.clock.now += 25 * MIN + SEC
  assert.equal(await agent(disk, { id: 914 }).c.tick(), 'canary_unconfirmed')
  disk.clock.now += 24 * HOUR + MIN
  proven(disk)
  await goesSilent(disk, 915)
  disk.clock.now += 25 * MIN + SEC
  const third = agent(disk, { id: 916 })
  assert.equal(await third.c.tick(), 'canary_unconfirmed')
  assert.equal(readJson(disk, join(MACHINE, '0.81.0', 'silent-2')).assistantId, '915')
  disk.clock.now += 3 * MIN
  assert.equal(await third.c.tick(), 'silent_hold', 'it may still be a slow start')
  disk.clock.now += 75 * MIN
  await latches(disk, third)
  assert.equal(readJson(disk, join(MACHINE, '0.81.0', 'bad')).reason, 'canaries_silent')
  assert.equal(third.restarts.length, 0)
  assert.equal(lastReport(third)?.code, 'idle_update_held')
})

test('a canary\'s expired lease leaves no silent: its own file is the record, so the hold stays 24 h and never counts twice', async () => {
  const disk = memDisk()
  const canary = agent(disk, { id: 912 })
  assert.equal(await canary.c.tick(), 'requested')
  disk.clock.now += 24 * HOUR + SEC
  const next = agent(disk, { id: 914 })
  assert.equal(await next.c.tick(), 'requested')
  assert.equal(readJson(disk, next.record).canaryN, 2)
  assert.deepEqual(silentFiles(disk), [])
})

test('a voided canary that went back on as a follower is a follower: its silence is on the record', async () => {
  const disk = memDisk()
  proven(disk)
  disk.fs.writeAtomic(join(MACHINE, '0.81.0', 'canary-1'), JSON.stringify({ assistantId: '912', at: new Date(disk.clock.now - HOUR).toISOString() }))
  disk.fs.writeAtomic(join(MACHINE, '0.81.0', 'void-1'), JSON.stringify({ assistantId: '912', at: new Date(disk.clock.now - HOUR).toISOString() }))
  await goesSilent(disk, 912)
  disk.clock.now += 25 * MIN + SEC
  assert.equal(await agent(disk, { id: 914 }).c.tick(), 'canary_unconfirmed')
  assert.equal(readJson(disk, join(MACHINE, '0.81.0', 'silent-1')).assistantId, '912')
})

test('a lease on another version goes on that version\'s record, and the agent breaking it carries on to its own', async () => {
  const disk = memDisk()
  disk.fs.writeAtomic(join(MACHINE, 'lease.json'), JSON.stringify({ assistantId: '913', target: '0.81.0', nonce: 'n-913', at: new Date(disk.clock.now - HOUR).toISOString() }))
  const a = agent(disk, { id: 912, staged: '0.82.0' })
  assert.equal(await a.c.tick(), 'requested')
  assert.deepEqual(a.restarts.map((r) => r.target), ['0.82.0'])
  assert.deepEqual(silentFiles(disk), [join(MACHINE, '0.81.0', 'silent-1')])
})

test('a lease that names no plain version leaves no file anywhere: what it reads from disk never names a folder', async () => {
  for (const target of ['../../evil', '..', 'latest', 42, null]) {
    const disk = memDisk()
    disk.fs.writeAtomic(join(MACHINE, 'lease.json'), JSON.stringify({ assistantId: '913', target, nonce: 'n-913', at: new Date(disk.clock.now - HOUR).toISOString() }))
    const a = agent(disk, { id: 912 })
    assert.equal(await a.c.tick(), 'requested', String(target))
    assert.deepEqual(silentFiles(disk), [], String(target))
  }
})

test('a lease that does not parse names no holder: it is broken with nothing on the record', async () => {
  const disk = memDisk()
  disk.fs.writeAtomic(join(MACHINE, 'lease.json'), '{"assist')
  disk.clock.now += 26 * MIN
  const a = agent(disk, { id: 912 })
  assert.equal(await a.c.tick(), 'requested')
  assert.deepEqual(silentFiles(disk), [])
})

test('a silence that cannot be written stops the agent where it stands: the lease stays, and nothing walks past it', async () => {
  const disk = memDisk()
  proven(disk)
  await goesSilent(disk, 912)
  disk.clock.now += 25 * MIN + SEC
  const create = disk.fs.createExclusive
  disk.fs.createExclusive = (p: string, text: string) => (/silent-/.test(p) ? 'error' : create(p, text))
  const next = agent(disk, { id: 914 })
  assert.equal(await next.c.tick(), 'machine_busy')
  assert.equal(next.restarts.length, 0)
  assert.ok(disk.files.has(join(MACHINE, 'lease.json')), 'the next look tries again')
})

test('two agents breaking one lease write one silent: the one that lost the file has nothing to add', async () => {
  const disk = memDisk()
  proven(disk)
  await goesSilent(disk, 912)
  disk.clock.now += 25 * MIN + SEC
  const create = disk.fs.createExclusive
  disk.fs.createExclusive = (p: string, text: string) => {
    if (/silent-1$/.test(p) && !disk.files.has(p)) create(p, JSON.stringify({ assistantId: '912', nonce: '912-n1', by: '915', at: new Date(disk.clock.now).toISOString() }))
    return create(p, text)
  }
  const next = agent(disk, { id: 914 })
  assert.equal(await next.c.tick(), 'canary_unconfirmed')
  assert.deepEqual(silentFiles(disk), [join(MACHINE, '0.81.0', 'silent-1')])
  assert.equal(next.restarts.length, 0)
})

test('a lease that could not be moved is one silence however many looks it takes: never two, which would latch the build', async () => {
  const disk = memDisk()
  proven(disk)
  await goesSilent(disk, 912)
  disk.clock.now += 25 * MIN + SEC
  const rename = disk.fs.rename
  disk.fs.rename = () => false
  const next = agent(disk, { id: 914 })
  assert.equal(await next.c.tick(), 'machine_busy')
  disk.fs.rename = rename
  disk.clock.now += 24 * HOUR + MIN
  proven(disk)
  assert.equal(await next.c.tick(), 'requested', 'its hold ran out, and this look moves the lease')
  assert.deepEqual(silentFiles(disk), [join(MACHINE, '0.81.0', 'silent-1')])
  assert.equal(disk.files.has(join(MACHINE, '0.81.0', 'bad')), false)
})

test('an agent breaking its own old lease is alive: it writes no silence about itself', async () => {
  const disk = memDisk()
  proven(disk)
  disk.fs.writeAtomic(join(MACHINE, 'lease.json'), JSON.stringify({ assistantId: '912', target: '0.81.0', nonce: '912-old', at: new Date(disk.clock.now - HOUR).toISOString() }))
  const a = agent(disk, { id: 912 })
  assert.equal(await a.c.tick(), 'requested')
  assert.deepEqual(silentFiles(disk), [])
})

test('a follower past its lease that then validates takes its silence back: a slow start is no silence, and the others move on', async () => {
  const disk = memDisk()
  proven(disk)
  await goesSilent(disk, 912)
  disk.clock.now += 40 * SEC
  const slow = agent(disk, { id: 912, running: '0.81.0', staged: null })
  slow.s.unreachable = true
  assert.equal(await slow.c.tick(), 'validating')
  disk.clock.now += 25 * MIN
  assert.equal(await slow.c.tick(), 'validating', 'an outage is forgiven, and past the lease it still runs')
  const next = agent(disk, { id: 914 })
  assert.equal(await next.c.tick(), 'canary_unconfirmed')
  assert.equal(silentFiles(disk).length, 1)
  slow.s.unreachable = false
  slow.s.heartbeatOkAtMs = disk.clock.now
  slow.s.beaconAtMs = disk.clock.now
  assert.equal(await slow.c.tick(), 'validating')
  disk.clock.now += 5 * MIN + SEC
  slow.s.heartbeatOkAtMs = disk.clock.now
  slow.s.beaconAtMs = disk.clock.now
  assert.equal(await slow.c.tick(), 'validated')
  assert.deepEqual(silentFiles(disk), [])
  proven(disk)
  assert.equal(await next.c.tick(), 'requested')
})

test('a slow follower after an earlier silence takes its own back in time: a healthy build is not latched', async () => {
  const disk = memDisk()
  proven(disk)
  await goesSilent(disk, 911)
  disk.clock.now += 25 * MIN + SEC
  const next = agent(disk, { id: 914 })
  assert.equal(await next.c.tick(), 'canary_unconfirmed')
  disk.clock.now += 24 * HOUR + MIN
  proven(disk)
  await goesSilent(disk, 912)
  disk.clock.now += 40 * SEC
  const slow = agent(disk, { id: 912, running: '0.81.0', staged: null })
  slow.s.unreachable = true
  assert.equal(await slow.c.tick(), 'validating')
  disk.clock.now += 25 * MIN
  assert.equal(await slow.c.tick(), 'validating')
  assert.equal(await next.c.tick(), 'canary_unconfirmed')
  assert.equal(silentFiles(disk).length, 2)
  disk.clock.now += 3 * MIN
  assert.equal(await next.c.tick(), 'silent_hold')
  assert.equal(disk.files.has(join(MACHINE, '0.81.0', 'bad')), false, 'a second silence is not two strikes until it can no longer be a slow start')
  slow.s.unreachable = false
  slow.s.heartbeatOkAtMs = disk.clock.now
  slow.s.beaconAtMs = disk.clock.now
  assert.equal(await slow.c.tick(), 'validating')
  disk.clock.now += 5 * MIN + SEC
  slow.s.heartbeatOkAtMs = disk.clock.now
  slow.s.beaconAtMs = disk.clock.now
  assert.equal(await slow.c.tick(), 'validated')
  assert.deepEqual(silentFiles(disk), [join(MACHINE, '0.81.0', 'silent-1')])
  disk.clock.now += 75 * MIN
  proven(disk)
  assert.equal(await next.c.tick(), 'requested')
  assert.equal(disk.files.has(join(MACHINE, '0.81.0', 'bad')), false)
})

test('validating takes back only its own silence, never another agent\'s', async () => {
  const disk = memDisk()
  proven(disk)
  await goesSilent(disk, 912)
  disk.clock.now += 40 * SEC
  disk.fs.writeAtomic(join(MACHINE, '0.81.0', 'silent-1'), JSON.stringify({ assistantId: '915', nonce: 'n-915', by: '914', at: new Date(disk.clock.now).toISOString() }))
  const a = agent(disk, { id: 912, running: '0.81.0', staged: null })
  assert.equal(await a.c.tick(), 'validating')
  a.s.heartbeatOkAtMs = disk.clock.now
  a.s.beaconAtMs = disk.clock.now
  assert.equal(await a.c.tick(), 'validating')
  disk.clock.now += 5 * MIN + SEC
  a.s.heartbeatOkAtMs = disk.clock.now
  a.s.beaconAtMs = disk.clock.now
  assert.equal(await a.c.tick(), 'validated')
  assert.equal(silentFiles(disk).length, 1)
})

// -- Followers wait, and read the canary when the wait ends --------------------------------------------

function deliver(a: Rig) {
  a.s.heartbeatOkAtMs = a.clock.now
  a.s.beaconAtMs = a.clock.now
}

/** This agent is back on the version with a live channel, and validated just now. */
async function provesIt(disk: ReturnType<typeof memDisk>, id: number) {
  const back = agent(disk, { id, running: '0.81.0', staged: null })
  assert.equal(await back.c.tick(), 'validating')
  deliver(back)
  assert.equal(await back.c.tick(), 'validating')
  disk.clock.now += 5 * MIN + SEC
  deliver(back)
  assert.equal(await back.c.tick(), 'validated')
  return back
}

/** Agent 913 is the canary, and validated just now. */
async function canaryProved(disk: ReturnType<typeof memDisk>) {
  const old = agent(disk, { id: 913 })
  assert.equal(await old.c.tick(), 'requested')
  disk.clock.now += 40 * SEC
  return provesIt(disk, 913)
}

const waitOf = (id: number) => need().followerWaitMs({ assistantId: String(id), target: '0.81.0' })
const aliveAt = (disk: ReturnType<typeof memDisk>) => readJson(disk, join(MACHINE, '0.81.0', 'alive'))?.at ?? null
const proved = (disk: ReturnType<typeof memDisk>) => readJson(disk, join(MACHINE, '0.81.0', 'alive'))?.provedMs ?? 0

/** The canary delivers, one poll at a time, for this long. */
async function lives(canary: Rig, ms: number) {
  const end = canary.clock.now + ms
  while (canary.clock.now < end) {
    canary.clock.now = Math.min(end, canary.clock.now + 30 * SEC)
    deliver(canary)
    await canary.c.tick()
  }
}

test('the canary stamps alive at every poll while it delivers, until it has proved the longest wait: that stamp is the last', async () => {
  const disk = memDisk()
  const canary = await canaryProved(disk)
  await lives(canary, 30 * SEC)
  assert.equal(aliveAt(disk), new Date(disk.clock.now).toISOString())
  assert.equal(proved(disk), 30 * SEC)
  await lives(canary, 59 * MIN)
  assert.equal(aliveAt(disk), new Date(disk.clock.now).toISOString())
  await lives(canary, 30 * SEC)
  const last = aliveAt(disk)
  assert.equal(last, new Date(disk.clock.now).toISOString())
  assert.equal(proved(disk), 60 * MIN)
  await lives(canary, MIN)
  assert.equal(aliveAt(disk), last, 'no file is written for ever')
})

test('a sleep proves nothing: a stamp adds two polls at most, whatever the clock did', async () => {
  const disk = memDisk()
  const canary = await canaryProved(disk)
  await lives(canary, 6 * MIN)
  disk.clock.now += 9 * HOUR
  deliver(canary)
  await canary.c.tick()
  assert.equal(aliveAt(disk), new Date(disk.clock.now).toISOString())
  assert.equal(proved(disk), 7 * MIN)
})

test('a clock set back proves nothing either, and takes nothing away', async () => {
  const disk = memDisk()
  const canary = await canaryProved(disk)
  await lives(canary, 6 * MIN)
  disk.clock.now -= 3 * HOUR
  deliver(canary)
  await canary.c.tick()
  assert.equal(proved(disk), 6 * MIN)
})

test('minutes the canary was not live prove nothing: they are not made up by the next stamp', async () => {
  const disk = memDisk()
  const canary = await canaryProved(disk)
  await lives(canary, 6 * MIN)
  disk.clock.now += 10 * MIN
  deliver(canary)
  canary.s.deaf = true
  await canary.c.tick()
  canary.s.deaf = false
  disk.clock.now += 30 * SEC
  deliver(canary)
  await canary.c.tick()
  assert.equal(proved(disk), 7 * MIN)
})

test('a canary stamps only under its own proof: withdrawn, or another canary\'s since, its life says nothing about that one', async () => {
  for (const proof of ['withdrawn', 'another']) {
    const disk = memDisk()
    const canary = await canaryProved(disk)
    disk.clock.now += 3 * MIN
    const validated = join(MACHINE, '0.81.0', 'validated')
    if (proof === 'withdrawn') disk.fs.remove(validated)
    else disk.fs.writeAtomic(validated, JSON.stringify({ assistantId: '914', at: new Date(disk.clock.now).toISOString(), canary: 2 }))
    deliver(canary)
    await canary.c.tick()
    assert.equal(aliveAt(disk), null, proof)
  }
})

test('a canary that is no longer live stamps nothing: deaf, its beacon stale, or not the lock holder', async () => {
  for (const fault of ['deaf', 'beacon', 'passive']) {
    const disk = memDisk()
    const canary = await canaryProved(disk)
    disk.clock.now += 3 * MIN
    deliver(canary)
    if (fault === 'deaf') canary.s.deaf = true
    if (fault === 'beacon') canary.s.beaconAtMs = disk.clock.now - 3 * MIN
    if (fault === 'passive') canary.s.active = false
    await canary.c.tick()
    assert.equal(aliveAt(disk), null, fault)
  }
})

test('a canary no longer on the version stamps nothing: its life proves nothing about a build it left', async () => {
  const disk = memDisk()
  await canaryProved(disk)
  disk.clock.now += 3 * MIN
  const left = agent(disk, { id: 913, running: '0.80.0', staged: null })
  deliver(left)
  await left.c.tick()
  assert.equal(aliveAt(disk), null)
})

test('a canary restarted inside the wait goes on from what it proved: the proof lives on the disk, not in the daemon', async () => {
  const disk = memDisk()
  const canary = await canaryProved(disk)
  await lives(canary, 3 * MIN)
  const again = agent(disk, { id: 913, running: '0.81.0', staged: null })
  await lives(again, MIN)
  assert.equal(aliveAt(disk), new Date(disk.clock.now).toISOString())
  assert.equal(proved(disk), 4 * MIN)
})

test('a follower stamps nothing: only the canary\'s life is what the others wait to read', async () => {
  const disk = memDisk()
  proven(disk)
  const before = aliveAt(disk)
  const old = agent(disk, { id: 912 })
  assert.equal(await old.c.tick(), 'requested')
  disk.clock.now += 40 * SEC
  const a = agent(disk, { id: 912, running: '0.81.0', staged: null })
  assert.equal(await a.c.tick(), 'validating')
  deliver(a)
  assert.equal(await a.c.tick(), 'validating')
  disk.clock.now += 5 * MIN + SEC
  deliver(a)
  assert.equal(await a.c.tick(), 'validated')
  disk.clock.now += 30 * SEC
  deliver(a)
  await a.c.tick()
  assert.equal(aliveAt(disk), before)
})

test('a follower waits out its own wait holding no lease, and goes the moment it ends', async () => {
  const disk = memDisk()
  const canary = await canaryProved(disk)
  const provedAt = disk.clock.now
  const f = agent(disk, { id: 914 })
  const wait = waitOf(914)
  await lives(canary, 3 * MIN)
  assert.equal(await f.c.tick(), 'follower_wait')
  assert.equal(disk.files.has(join(MACHINE, 'lease.json')), false, 'a wait holds nothing other agents need')
  while (disk.clock.now + MIN < provedAt + wait) {
    await lives(canary, MIN)
    assert.equal(await f.c.tick(), 'follower_wait', `${(disk.clock.now - provedAt) / MIN} min`)
  }
  assert.equal(f.restarts.length, 0)
  await lives(canary, provedAt + wait - disk.clock.now)
  assert.equal(await f.c.tick(), 'requested')
})

test('a daemon restart neither resets a follower\'s wait nor redraws it', async () => {
  const disk = memDisk()
  const canary = await canaryProved(disk)
  const wait = waitOf(914)
  await lives(canary, wait - SEC)
  assert.equal(await agent(disk, { id: 914, random: 0 }).c.tick(), 'follower_wait', 'a new boot still waits, with another draw of its jitter')
  await lives(canary, SEC)
  assert.equal(await agent(disk, { id: 914, random: 0.99 }).c.tick(), 'requested', 'and goes on time: its wait did not start again')
})

test('a follower busy past its own wait reads the canary as it stands: a stamp that stopped sends nobody', async () => {
  const disk = memDisk()
  const canary = await canaryProved(disk)
  const id = [914, 915, 916, 917, 918, 919].find((n) => waitOf(n) < 50 * MIN)!
  await lives(canary, waitOf(id) + 7 * MIN)
  disk.clock.now += 4 * MIN
  const f = agent(disk, { id })
  assert.equal(await f.c.tick(), 'canary_quiet')
  assert.equal(f.restarts.length, 0)
})

test('the canary dies at minute 20: not one of fourteen followers moves, and one silence is on the record', async () => {
  const disk = memDisk()
  const canary = await canaryProved(disk)
  const provedAt = disk.clock.now
  const followers = Array.from({ length: 14 }, (_, i) => agent(disk, { id: 920 + i }))
  while (disk.clock.now < provedAt + 20 * MIN) {
    disk.clock.now += MIN
    deliver(canary)
    await canary.c.tick()
    for (const f of followers) await f.c.tick()
  }
  // It stamps no more. Every follower's wait runs out, each reads it quiet, and the polls count up.
  const seen = new Set<string>()
  for (let t = 0; t < 45 * 2; t += 1) {
    disk.clock.now += 30 * SEC
    for (const f of followers) seen.add(await f.c.tick())
  }
  assert.equal(followers.reduce((n, f) => n + f.restarts.length, 0), 0)
  assert.deepEqual(silentFiles(disk), [join(MACHINE, '0.81.0', 'silent-1')])
  assert.equal(readJson(disk, join(MACHINE, '0.81.0', 'silent-1')).assistantId, '913')
  assert.ok(seen.has('canary_quiet') && seen.has('silent_hold'), [...seen].join(','))
  assert.equal(disk.files.has(join(MACHINE, 'lease.json')), false)
})

test('a stale stamp at a wake is no silence, and no proof: nine polls of it write nothing, and the follower waits for what the canary proves next', async () => {
  const disk = memDisk()
  const canary = await canaryProved(disk)
  const f = agent(disk, { id: 914 })
  disk.clock.now += 2 * HOUR
  for (let poll = 0; poll < 9; poll += 1) {
    assert.equal(await f.c.tick(), 'canary_quiet')
    disk.clock.now += 30 * SEC
  }
  assert.deepEqual(silentFiles(disk), [])
  await lives(canary, 30 * SEC)
  assert.equal(await f.c.tick(), 'follower_wait', 'the computer slept through the wait')
  await lives(canary, waitOf(914))
  assert.equal(await f.c.tick(), 'requested')
  assert.equal(canary.restarts.length, 0)
})

test('a canary that dies soon after the wake is quiet: the sleep proved nothing, and nobody went', async () => {
  const disk = memDisk()
  const canary = await canaryProved(disk)
  const followers = [914, 915, 916].map((id) => agent(disk, { id }))
  await lives(canary, 6 * MIN)
  disk.clock.now += 9 * HOUR
  await lives(canary, 5 * MIN)
  for (const f of followers) assert.equal(await f.c.tick(), 'follower_wait')
  disk.clock.now += 3 * MIN
  for (let poll = 0; poll < 10; poll += 1) for (const f of followers) await f.c.tick()
  assert.equal(readJson(disk, join(MACHINE, '0.81.0', 'silent-1')).assistantId, '913')
  assert.equal(followers.reduce((n, f) => n + f.restarts.length, 0), 0)
})

test('the count needs polls in a row: a fresh stamp starts it again', async () => {
  const disk = memDisk()
  const canary = await canaryProved(disk)
  const f = agent(disk, { id: 914 })
  f.s.goalRunning = true
  disk.clock.now += 2 * HOUR
  for (let poll = 0; poll < 9; poll += 1) {
    await f.c.tick()
    disk.clock.now += 30 * SEC
  }
  deliver(canary)
  await canary.c.tick()
  await f.c.tick()
  disk.clock.now += 3 * MIN
  for (let poll = 0; poll < 9; poll += 1) {
    await f.c.tick()
    disk.clock.now += 30 * SEC
  }
  assert.deepEqual(silentFiles(disk), [], 'a busy follower counts too, and nine in a row is not ten')
  await f.c.tick()
  assert.equal(silentFiles(disk).length, 1)
})

test('polls hours apart are not in a row: a computer that wakes for a moment at a time writes no silence', async () => {
  const disk = memDisk()
  await canaryProved(disk)
  const f = agent(disk, { id: 914 })
  for (let poll = 0; poll < 12; poll += 1) {
    disk.clock.now += HOUR
    await f.c.tick()
  }
  assert.deepEqual(silentFiles(disk), [])
})

test('an outage on this agent counts nothing: the canary stops stamping in one too, and that says nothing about the build', async () => {
  const disk = memDisk()
  await canaryProved(disk)
  const f = agent(disk, { id: 914 })
  f.s.unreachable = true
  disk.clock.now += 2 * HOUR
  for (let poll = 0; poll < 12; poll += 1) {
    await f.c.tick()
    disk.clock.now += 30 * SEC
  }
  assert.deepEqual(silentFiles(disk), [])
  f.s.unreachable = false
  for (let poll = 0; poll < 9; poll += 1) {
    await f.c.tick()
    disk.clock.now += 30 * SEC
  }
  assert.deepEqual(silentFiles(disk), [])
  await f.c.tick()
  assert.equal(silentFiles(disk).length, 1)
})

test('a latch waits out a validation: a wake that finds two canaries past their time lets the one validating finish', async () => {
  const disk = memDisk()
  await canaryProved(disk)
  const first = agent(disk, { id: 914 })
  const other = agent(disk, { id: 915 })
  disk.clock.now += 2 * HOUR
  for (let poll = 0; poll < 10; poll += 1) await first.c.tick()
  disk.clock.now += 24 * HOUR + MIN
  assert.equal(await first.c.tick(), 'requested')
  disk.clock.now += 40 * SEC
  const back = agent(disk, { id: 914, running: '0.81.0', staged: null })
  assert.equal(await back.c.tick(), 'validating')
  disk.clock.now += 3 * HOUR
  back.s.slept += 3 * HOUR
  for (let poll = 0; poll < 12; poll += 1) {
    disk.clock.now += 30 * SEC
    await other.c.tick()
    deliver(back)
    await back.c.tick()
  }
  assert.equal(readJson(disk, back.record).state, 'validated')
  assert.equal(disk.files.has(join(MACHINE, '0.81.0', 'bad')), false)
  await lives(back, 2 * MIN + SEC)
  assert.equal(await other.c.tick(), 'follower_wait')
})

test('a canary that went quiet gives up its proof: past the hold the next agent is canary 2, and the rest wait for that one', async () => {
  const disk = memDisk()
  await canaryProved(disk)
  const first = agent(disk, { id: 914 })
  const second = agent(disk, { id: 915 })
  disk.clock.now += 2 * HOUR
  for (let poll = 0; poll < 10; poll += 1) await first.c.tick()
  assert.equal(silentFiles(disk).length, 1)
  assert.equal(disk.files.has(join(MACHINE, '0.81.0', 'validated')), false, 'a canary that stopped short proves nothing')
  assert.equal(await first.c.tick(), 'silent_hold')
  disk.clock.now += 24 * HOUR + MIN
  assert.equal(await first.c.tick(), 'requested')
  assert.equal(readJson(disk, first.record).canaryN, 2, 'a follower only passes the five minutes this build passed already')
  assert.equal(await second.c.tick(), 'machine_busy')
  disk.clock.now += 40 * SEC
  const back = await provesIt(disk, 914)
  const provedAt = disk.clock.now
  assert.equal(readJson(disk, join(MACHINE, '0.81.0', 'validated')).assistantId, '914')
  await lives(back, 2 * MIN + SEC)
  assert.equal(await second.c.tick(), 'follower_wait', 'the rest wait from this validation, and read this canary')
  await lives(back, provedAt + waitOf(915) - disk.clock.now)
  assert.equal(await second.c.tick(), 'requested')
  assert.equal(readJson(disk, second.record).canaryN, null)
  assert.equal(silentFiles(disk).length, 1)
})

test('canary 2 going quiet as well is the second silence: the build is bad, and two agents are all it reached', async () => {
  const disk = memDisk()
  await canaryProved(disk)
  const followers = [914, 915, 916, 917].map((id) => agent(disk, { id }))
  disk.clock.now += 2 * HOUR
  for (let poll = 0; poll < 10; poll += 1) for (const f of followers) await f.c.tick()
  disk.clock.now += 24 * HOUR + MIN
  const [second, ...rest] = followers
  assert.equal(await second.c.tick(), 'requested')
  disk.clock.now += 40 * SEC
  await provesIt(disk, 914)
  disk.clock.now += 2 * HOUR
  for (let poll = 0; poll < 10; poll += 1) for (const f of rest) await f.c.tick()
  assert.equal(readJson(disk, join(MACHINE, '0.81.0', 'silent-2')).assistantId, '914')
  assert.equal(await rest[0].c.tick(), 'silent_hold')
  disk.clock.now += 75 * MIN
  await latches(disk, rest[0])
  assert.equal(readJson(disk, join(MACHINE, '0.81.0', 'bad')).reason, 'canaries_silent')
  assert.equal(rest.reduce((n, f) => n + f.restarts.length, 0), 0)
})

test('canary 2 starts from nothing: what canary 1 proved is not its proof', async () => {
  const disk = memDisk()
  const canary = await canaryProved(disk)
  const first = agent(disk, { id: 914 })
  await lives(canary, 20 * MIN)
  disk.clock.now += 2 * HOUR
  for (let poll = 0; poll < 10; poll += 1) await first.c.tick()
  disk.clock.now += 24 * HOUR + MIN
  assert.equal(await first.c.tick(), 'requested')
  disk.clock.now += 40 * SEC
  const back = await provesIt(disk, 914)
  await lives(back, MIN)
  assert.equal(proved(disk), MIN)
  assert.equal(readJson(disk, join(MACHINE, '0.81.0', 'alive')).assistantId, '914')
})

test('canary 2 that fails gives its verdict as a canary: no proof is left to lean on, and no way back is spent', async () => {
  const disk = memDisk()
  await canaryProved(disk)
  const first = agent(disk, { id: 914 })
  disk.clock.now += 2 * HOUR
  for (let poll = 0; poll < 10; poll += 1) await first.c.tick()
  disk.clock.now += 24 * HOUR + MIN
  assert.equal(await first.c.tick(), 'requested')
  disk.clock.now += 40 * SEC
  const back = agent(disk, { id: 914, running: '0.81.0', staged: null })
  assert.equal(await back.c.tick(), 'validating')
  disk.clock.now += 15 * MIN + SEC
  assert.equal(await back.c.tick(), 'rollback')
  assert.equal(disk.files.has(join(MACHINE, 'went-back-914')), false)
  assert.ok(disk.files.has(join(MACHINE, '0.81.0', 'bad')))
})

test('a silence that cannot be written keeps the proof: with nothing on the record the next agent would walk on, and the next poll tries again', async () => {
  const disk = memDisk()
  await canaryProved(disk)
  const f = agent(disk, { id: 914 })
  disk.clock.now += 2 * HOUR
  const create = disk.fs.createExclusive
  disk.fs.createExclusive = (p: string, text: string) => (/silent-/.test(p) ? 'error' : create(p, text))
  for (let poll = 0; poll < 10; poll += 1) await f.c.tick()
  assert.ok(disk.files.has(join(MACHINE, '0.81.0', 'validated')))
  disk.fs.createExclusive = create
  await f.c.tick()
  assert.equal(silentFiles(disk).length, 1)
  assert.equal(disk.files.has(join(MACHINE, '0.81.0', 'validated')), false)
})

test('the act reads the wait again under the lease: a proof that moved since the gate sends nobody', async () => {
  const disk = memDisk()
  proven(disk)
  const create = disk.fs.createExclusive
  disk.fs.createExclusive = (p: string, text: string) => {
    const made = create(p, text)
    if (p.endsWith('lease.json')) disk.fs.writeAtomic(join(MACHINE, '0.81.0', 'validated'), JSON.stringify({ assistantId: '913', at: new Date(disk.clock.now).toISOString(), canary: 1 }))
    return made
  }
  const a = agent(disk, { id: 912 })
  assert.equal(await a.c.tick(), 'canary_unconfirmed')
  assert.equal(a.restarts.length, 0)
  assert.equal(disk.files.has(join(MACHINE, 'lease.json')), false)
})

test('a proof that cannot be removed stays quiet past the hold: nobody follows it, and the next look removes it', async () => {
  const disk = memDisk()
  await canaryProved(disk)
  const f = agent(disk, { id: 914 })
  disk.clock.now += 2 * HOUR
  const remove = disk.fs.remove
  disk.fs.remove = () => false
  for (let poll = 0; poll < 10; poll += 1) await f.c.tick()
  disk.clock.now += 24 * HOUR + MIN
  for (let poll = 0; poll < 9; poll += 1) assert.equal(await f.c.tick(), 'canary_quiet')
  disk.fs.remove = remove
  assert.equal(await f.c.tick(), 'canary_quiet')
  assert.equal(disk.files.has(join(MACHINE, '0.81.0', 'validated')), false)
  assert.equal(silentFiles(disk).length, 1)
  assert.equal(await f.c.tick(), 'requested')
  assert.equal(readJson(disk, f.record).canaryN, 2)
})
