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

function agent(disk: ReturnType<typeof memDisk>, o: { id?: number; running?: string; staged?: string | null; random?: number; authority?: string; ownsUs?: boolean; scale?: number } = {}) {
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
    wake: { ok: true, tasks: [] as Array<{ nextRunAt: string }> } as any,
    wakeReads: 0,
    startupComplete: true,
    heartbeatOkAtMs: null as number | null,
    beaconAtMs: null as number | null,
    deaf: false,
    loginExpired: false,
    tookRestart: true as boolean | Error,
    rollbackOk: true,
  }
  const out = {
    s,
    record,
    drains: [] as boolean[],
    restarts: [] as Array<{ target: string; proof: any }>,
    rollbackRestarts: [] as Array<{ target: string; proof: any }>,
    rollbackInstalls: [] as any[],
    reports: [] as any[],
    logs: [] as string[],
    c: null as any,
  }
  let nonces = 0
  out.c = m.createIdleUpdate({
    assistantId: String(id),
    ownPid: b + 50,
    platform: 'darwin',
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
    launcher: () => ({ pid: b + 20, startedAtMs: T0 - 3 * HOUR, markerPath: MARKER, supervisorMtimeMs: T0 - 3 * HOUR }),
    unattendedInputs: () => ({
      ownSockets: [`hoai-${id}-home-abc`, `hoai-${id}`],
      runShPath: `/Users/a/.bgos-agent/${id}/run.sh`,
      launchStatus: { outcome: null, mtimeMs: null },
      runAgentVbs: { text: null, mtimeMs: null },
    }),
    personAttached: async () => s.attached,
    wakeSchedule: async () => {
      s.wakeReads += 1
      return s.wake
    },
    startupComplete: () => s.startupComplete,
    heartbeatOkAtMs: () => s.heartbeatOkAtMs,
    beaconAtMs: () => s.beaconAtMs,
    deaf: () => s.deaf,
    loginExpired: () => s.loginExpired,
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
  disk.fs.writeAtomic(a.record, JSON.stringify({ schema: 1, target: '0.81.0', state: 'requested', attempts: [], pin: PIN }))
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
  due.s.wake = { ok: true, tasks: [{ nextRunAt: new Date(T0 + 4 * MIN).toISOString() }] }
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
  a.s.session = '11111111-2222-4333-8444-555566667777'
  assert.equal(await a.c.tick(), 'validating')
  assert.equal(lastReport(a)?.code, 'idle_update_context_lost')
  disk.clock.now += 61 * SEC
  a.s.heartbeatOkAtMs = disk.clock.now
  a.s.beaconAtMs = disk.clock.now
  assert.equal(await a.c.tick(), 'validated')
})
