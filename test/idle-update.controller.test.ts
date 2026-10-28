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
  o: { id?: number; running?: string; staged?: string | null; random?: number; authority?: string; ownsUs?: boolean; scale?: number; platform?: string; launcher?: any; unattended?: any } = {},
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
  }
  const out = {
    s,
    record,
    drains: [] as boolean[],
    restarts: [] as Array<{ target: string; proof: any }>,
    rollbackRestarts: [] as Array<{ target: string; proof: any }>,
    rollbackInstalls: [] as any[],
    badAtInstall: [] as boolean[],
    reports: [] as any[],
    heartbeatRequests: 0,
    logs: [] as string[],
    c: null as any,
  }
  let nonces = 0
  out.c = m.createIdleUpdate({
    assistantId: String(id),
    ownPid: b + 50,
    platform: o.platform ?? 'darwin',
    bootAtMs: T0 - 2 * HOUR,
    runningVersion: s.running,
    installMethod: 'marketplace',
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
    watcherSweepActive: () => s.watcher,
    authorityKind: () => s.authority,
    serviceOwnsUs: () => s.ownsUs,
    draining: () => s.draining,
    updateLockHeld: () => s.updateLock,
    markerMtimeMs: () => s.markerMtimeMs,
    safeState: () => s.safe,
    activityMs: () => s.activity,
    openAsks: () => s.openAsks,
    goalRunning: () => s.goalRunning,
    call: () => s.call,
    lastBrowserToolAtMs: () => s.browserAt,
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
      return s.tookRestart
    },
    restartRollback: async (target: string, proof: any) => {
      out.rollbackRestarts.push({ target, proof })
      return true
    },
    rollbackInstall: async (rec: any) => {
      out.rollbackInstalls.push(rec)
      out.badAtInstall.push(disk.fs.readFile(join(MACHINE, String(rec.target), 'bad')) !== null)
      if (s.installGate) await s.installGate
      return s.rollbackOk ? { ok: true } : { ok: false, reason: 'from_root_missing' }
    },
    report: (err: any) => out.reports.push(err),
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
  disk.fs.writeAtomic(join(MACHINE, '0.81.0', 'validated'), JSON.stringify({ assistantId: '913', at: new Date(T0 - 1 * MIN).toISOString() }))
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
  assert.equal(await a.c.tick(), 'validating', 'the first live reading starts the 60 s hold')
  disk.clock.now += 61 * SEC
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
  disk.clock.now += 5 * MIN + SEC
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
  disk.clock.now += 5 * MIN + SEC
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
  disk.clock.now += 5 * MIN + SEC
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
  disk.clock.now += 5 * MIN + SEC
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
  disk.clock.now += 5 * MIN + SEC
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

test('a canary whose attempt was voided, or a version another agent validated meanwhile, reports and never rolls back the shared install', async () => {
  for (const mark of ['void-1', 'validated']) {
    const disk = await afterAsk()
    const a = agent(disk, { running: '0.81.0', staged: null })
    assert.equal(await a.c.tick(), 'validating')
    disk.fs.createExclusive(join(MACHINE, '0.81.0', mark), JSON.stringify({ assistantId: '913', at: new Date(disk.clock.now).toISOString() }))
    disk.clock.now += 5 * MIN + SEC
    assert.equal(await a.c.tick(), 'failed', mark)
    assert.equal(a.rollbackInstalls.length, 0, mark)
  }
})

test('two canaries that never came back latch the version bad on disk, for every reader of the latch', async () => {
  const disk = memDisk()
  for (const [n, id, age] of [[1, '913', 3 * 24 * HOUR], [2, '914', 11 * MIN]] as const) {
    disk.fs.createExclusive(join(MACHINE, '0.81.0', `canary-${n}`), JSON.stringify({ assistantId: id, at: new Date(T0 - age).toISOString() }))
  }
  const a = agent(disk)
  assert.equal(await a.c.tick(), 'version_held_bad')
  assert.equal(readJson(disk, join(MACHINE, '0.81.0', 'bad'))?.reason, 'canaries_silent')
  assert.equal(a.restarts.length, 0)
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
  disk.clock.now += 3 * MIN
  assert.equal(await a.c.tick(), 'validating', 'ten minutes down, three up: not yet five minutes of chance')
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
  disk.clock.now += 61 * SEC
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
  disk.clock.now += 61 * SEC
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

test('hoai relaunching a new build whose daemon was still alive is a re-arrival, once; a boot after a silent predecessor is a failed build', async () => {
  const disk = await afterAsk()
  const first = agent(disk, { running: '0.81.0', staged: null })
  first.s.startupComplete = false
  assert.equal(await first.c.tick(), 'validating')
  for (let i = 0; i < 6; i += 1) {
    disk.clock.now += 30 * SEC
    assert.equal(await first.c.tick(), 'validating')
  }
  assert.ok(readJson(disk, first.record).aliveAt, 'each validating tick says the boot is alive')
  disk.clock.now += 30 * SEC
  const second = agent(disk, { running: '0.81.0', staged: null })
  assert.equal(await second.c.tick(), 'validating')
  assert.equal(second.rollbackInstalls.length, 0)
  assert.equal(readJson(disk, second.record).rearrived, true)
  disk.clock.now += 30 * SEC
  const third = agent(disk, { running: '0.81.0', staged: null })
  assert.equal(await third.c.tick(), 'rollback', 'one re-arrival per record, never a loop')
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
  disk.clock.now += 2 * MIN
  assert.equal(await a.c.tick(), 'validating', 'four minutes passive, two holding the lock: not yet five minutes of chance')
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
  disk.clock.now += 5 * MIN + SEC
  assert.equal(await a.c.tick(), 'rollback', 'five minutes since startup completed, none of them down')
})

test('a break in liveness restarts the 60 s hold', async () => {
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
  disk.clock.now += 30 * SEC
  a.s.deaf = true
  assert.equal(await a.c.tick(), 'validating')
  disk.clock.now += 40 * SEC
  a.s.deaf = false
  live()
  assert.equal(await a.c.tick(), 'validating', 'seventy seconds since the first live reading, but live again only now')
  disk.clock.now += 61 * SEC
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

test('a non-canary that fails on a version reports and stays: it never rolls back the shared install', async () => {
  const disk = memDisk()
  disk.fs.writeAtomic(join(MACHINE, '0.81.0', 'validated'), JSON.stringify({ assistantId: '913', at: new Date(T0 - HOUR).toISOString() }))
  const old = agent(disk)
  assert.equal(await old.c.tick(), 'requested')
  assert.equal(readJson(disk, old.record).canaryN, null)
  disk.clock.now += 40 * SEC
  const a = agent(disk, { running: '0.81.0', staged: null })
  assert.equal(await a.c.tick(), 'validating')
  disk.clock.now += 5 * MIN + SEC
  assert.equal(await a.c.tick(), 'failed')
  assert.equal(a.rollbackInstalls.length, 0)
  assert.equal(readJson(disk, a.record).state, 'failed')
  assert.equal(lastReport(a)?.code, 'idle_update_failed')
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
  disk.clock.now += 5 * MIN + SEC
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
  disk.clock.now += 5 * MIN + SEC
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
  disk.clock.now += 61 * SEC
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
