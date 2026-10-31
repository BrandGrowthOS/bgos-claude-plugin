/**
 * The idle update end to end inside one process: the real controller
 * (lib/idle-update.mjs), the real ladder (lib/update-rpc.ts UpdateRpcHandler,
 * its own launcher rung), the real readings (lib/idle-update-host.mjs) and the
 * real disk, in a scratch HOME. Only the process table, the clock and the
 * backend are fakes. It is the gen-2 Mac of the report: a launchd job whose
 * run.sh started hoai in a detached tmux server, so the job never owns the
 * daemon and, before this change, the ladder could only stage.
 *
 * The real chain (wscript, hoai, a stand-in claude, bun server.ts against a
 * stub backend) is docs/idle-update/rig; this pins how the pieces meet.
 *
 * Run: npx tsx --test test/idle-update.integration.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { RESTART_WATCHDOG_MS, UpdateRpcHandler } from '../lib/update-rpc'
import type { RestartAuthority } from '../lib/update-readiness'

const m: any = await import('../lib/idle-update.mjs')
const host: any = await import('../lib/idle-update-host.mjs')

const SCRATCH = process.env.TEMP || process.env.TMPDIR || '.'
const PIN = '0d6f2a8e-3c1b-4e7a-9f20-5b8c7d6e4f31'
const T0 = Date.parse('2026-10-28T12:00:00.000Z')
const MIN = 60_000
const HOUR = 60 * MIN

function scratchHome(): string {
  return mkdtempSync(join(SCRATCH, 'idle-update-int-'))
}

/** The gen-2 Mac chain for one agent: launchd, its tmux server on the agent's own socket, hoai, claude, the daemon. */
function gen2Table(id: number, socket: string) {
  const b = id * 100
  return [
    { pid: 1, ppid: 0, command: '/sbin/launchd' },
    { pid: b, ppid: 1, command: `tmux -f /dev/null -L ${socket} new-session -d -s ${socket}` },
    { pid: b + 20, ppid: b, command: '/usr/local/bin/node /Users/a/plugin/bin/hoai-core.mjs' },
    { pid: b + 40, ppid: b + 20, command: `/Users/a/.local/bin/claude --dangerously-skip-permissions --resume ${PIN}` },
    { pid: b + 50, ppid: b + 40, command: 'bun /Users/a/plugin/server.ts' },
  ]
}

function world(home: string) {
  const clock = { now: T0 }
  return { home, clock, machineDir: join(home, '.bgos-agent', m.IDLE_UPDATE_DIR_NAME) }
}

function agent(w: ReturnType<typeof world>, id: number, opts: { running?: string; staged?: string; fromRoot?: string; rollbackInstall?: (record: any) => Promise<any> } = {}) {
  const stateDir = join(w.home, '.bgos-agent', String(id))
  mkdirSync(stateDir, { recursive: true })
  const b = id * 100
  // hoai's claim: it promises to relaunch on a marker, and (this boot) its pid is the launcher's.
  writeFileSync(join(stateDir, 'supervisor.json'), JSON.stringify({ pid: b + 20, capabilities: ['relaunch'], startedAt: new Date(T0 - 3 * HOUR).toISOString() }))
  const fs = m.nodeIdleUpdateFs()
  const inputs = host.readUnattendedInputs({ platform: 'darwin', home: w.home, assistantId: String(id), stateDir, fs })
  const out = { drains: [] as boolean[], timers: [] as Array<{ ms: number; fn: () => void }>, progress: [] as any[], logs: [] as string[], spawned: [] as any[], reports: [] as any[] }
  const authority: RestartAuthority = {
    kind: 'service',
    service: { kind: 'launchd', handle: `ai.bgos.agent.${id}` },
    command: { file: '/bin/launchctl', args: ['kickstart', '-k', `gui/501/ai.bgos.agent.${id}`] },
  }
  const ladder = new UpdateRpcHandler({
    postAck: async () => ({}),
    postProgress: async (_rpc, body) => {
      out.progress.push(body)
      return {}
    },
    log: (line) => out.logs.push(line),
    installMethod: () => 'marketplace',
    autoUpdateEnabled: () => true,
    updater: () => null,
    pendingRestartVersion: () => opts.staged ?? '0.81.0',
    marketplaceUpdate: async () => ({ kind: 'installed', targetVersion: '0.81.0' }) as any,
    drainSnapshot: () => ({ activeOperations: 0, pendingMessages: 0, pendingPermissions: 0 }) as any,
    restartAuthority: () => authority,
    spawnDetached: (file, args) => out.spawned.push({ file, args }),
    // The daemon's own marker write (server.ts updateRpc writeMarker), on the real disk.
    writeMarker: (path) => {
      try {
        writeFileSync(path, JSON.stringify({ requestedAt: new Date(w.clock.now).toISOString() }))
        return true
      } catch {
        return false
      }
    },
    signalProcess: () => false,
    setDrainMode: (on) => out.drains.push(on),
    requestHeartbeat: () => {},
    // The job's main pid is run.sh (b + 1), nowhere in the daemon's ancestry.
    serviceOwnership: () => ({ ownPid: b + 50, ancestorPids: [b + 50, b + 40, b + 20, b, 1], servicePid: b + 1 }),
    setTimer: (fn, ms) => {
      out.timers.push({ ms, fn })
      return () => {}
    },
    sleep: async () => {},
  })
  const facts = { heartbeatOkAtMs: null as number | null, beaconAtMs: null as number | null, activity: [T0 - 2 * HOUR] as number[] }
  const controller = m.createIdleUpdate({
    assistantId: String(id),
    ownPid: b + 50,
    platform: 'darwin',
    bootAtMs: w.clock.now - 2 * HOUR,
    runningVersion: opts.running ?? '0.80.0',
    installMethod: 'marketplace',
    fromRoot: opts.fromRoot ?? '/Users/a/.claude/plugins/cache/hoai/hoai/0.80.0',
    fromCommit: null,
    durations: m.DEFAULT_DURATIONS,
    paths: { record: join(stateDir, m.IDLE_UPDATE_FILE_NAME), machineDir: w.machineDir },
    fs,
    now: () => w.clock.now,
    random: () => 0,
    nonce: () => `${id}-${w.clock.now}`,
    autoUpdateEnabled: () => true,
    stagedVersion: () => opts.staged ?? '0.81.0',
    active: () => true,
    holdsLock: () => true,
    watcherSweepActive: () => host.readWatcherSweepActive({ home: w.home, fs, now: w.clock.now, freshMs: m.DEFAULT_DURATIONS.watcherFreshMs }),
    authorityKind: () => authority.kind,
    serviceOwnsUs: () => false,
    draining: () => out.drains.length > 0 && out.drains[out.drains.length - 1] === true,
    updateLockHeld: () => false,
    markerMtimeMs: () => host.readMarkerMtimeMs({ stateDir, fs }),
    removeMarker: () => host.removeRestartMarker({ stateDir, fs }),
    safeState: () => ({ turnInFlight: false, turnSignal: 'hooks', pendingMessages: 0, pendingPermissions: 0, activeOperations: 0 }),
    activityMs: () => facts.activity,
    openAsks: () => 0,
    goalRunning: () => false,
    call: () => ({ pendingConsults: 0, openContinuations: 0, openMeetings: 0, lastVoiceAtMs: null }),
    lastBrowserToolAtMs: () => null,
    claudePid: () => b + 40,
    sessionId: async () => PIN,
    listProcesses: async () => ({ ok: true, processes: gen2Table(id, inputs.ownSockets[0]) }),
    launcher: () => host.readLauncherClaim({ stateDir, fs, alive: () => true }),
    unattendedInputs: () => host.readUnattendedInputs({ platform: 'darwin', home: w.home, assistantId: String(id), stateDir, fs }),
    personAttached: async () => false,
    wakeSchedule: async () => ({ ok: true, tasks: [] }),
    startupComplete: () => true,
    heartbeatOkAtMs: () => facts.heartbeatOkAtMs,
    beaconAtMs: () => facts.beaconAtMs,
    deaf: () => false,
    loginExpired: () => false,
    requestHeartbeat: () => {},
    drain: (on: boolean) => out.drains.push(on),
    restart: (target: string, proof: any) => ladder.restartForStagedUpdate(target, proof),
    restartRollback: (from: string, proof: any) => ladder.restartForRollback(from, proof),
    rollbackInstall: opts.rollbackInstall ?? (async () => ({ ok: false, reason: 'not_in_this_test' })),
    report: (err: any) => out.reports.push(err),
    log: (line: string) => out.logs.push(line),
    setInterval: () => ({ unref() {} }),
    clearInterval: () => {},
  })
  return { stateDir, controller, facts, out, marker: join(stateDir, 'restart-requested.json'), record: () => JSON.parse(readFileSync(join(stateDir, m.IDLE_UPDATE_FILE_NAME), 'utf8')) }
}

test('a gen-2 Mac agent, idle with a newer build staged: the ladder writes the marker for its own hoai, never a kickstart', async () => {
  const w = world(scratchHome())
  try {
    const a = agent(w, 912)
    assert.equal(await a.controller.tick(), 'requested', a.out.logs.join('\n'))
    assert.ok(existsSync(a.marker), 'the restart marker is on disk where the proven hoai polls it')
    assert.deepEqual(a.out.spawned, [], 'the job that does not own the daemon is never kickstarted (2026-09-11)')
    assert.deepEqual(a.out.drains, [true], 'drained once, and it stays drained until the restart or the watchdog')
    assert.deepEqual(a.out.timers.map((t) => t.ms), [RESTART_WATCHDOG_MS])
    assert.deepEqual(a.out.progress, [], 'nobody asked, so nothing goes to the backend as rpc progress')
    const rec = a.record()
    assert.equal(rec.state, 'requested')
    assert.equal(rec.pin, PIN)
    assert.equal(rec.canaryN, 1)
    assert.ok(existsSync(join(w.machineDir, 'lease.json')))
    assert.ok(existsSync(join(w.machineDir, '0.81.0', 'canary-1')))
    // One attempt per version: the same daemon, still here, asks nothing more.
    assert.equal(await a.controller.tick(), 'requested')
    assert.deepEqual(a.out.drains, [true])
  } finally {
    rmSync(w.home, { recursive: true, force: true })
  }
})

test('the new daemon validates on live evidence and frees the computer; the second agent waits for the canary, then for the canary to last, and follows alone', async () => {
  const w = world(scratchHome())
  try {
    const first = agent(w, 912)
    const second = agent(w, 913)
    assert.equal(await first.controller.tick(), 'requested')
    assert.equal(await second.controller.tick(), 'machine_busy', second.out.logs.join('\n'))

    // hoai took the marker and relaunched claude with --resume <pin>: the new daemon boots on 0.81.0.
    rmSync(first.marker)
    w.clock.now += 2 * MIN
    const next = agent(w, 912, { running: '0.81.0' })
    assert.equal(await next.controller.tick(), 'validating')
    assert.equal(next.record().state, 'arrived')
    next.facts.heartbeatOkAtMs = w.clock.now
    next.facts.beaconAtMs = w.clock.now
    assert.equal(await next.controller.tick(), 'validating', 'the first live reading starts the 5 min hold')
    w.clock.now += 301_000
    next.facts.beaconAtMs = w.clock.now
    assert.equal(await next.controller.tick(), 'validated', next.out.logs.join('\n'))
    assert.ok(existsSync(join(w.machineDir, '0.81.0', 'validated')))
    assert.equal(existsSync(join(w.machineDir, 'lease.json')), false, 'the lease is released')
    assert.ok(next.out.logs.some((l) => /restarted onto 0\.81\.0 from 0\.80\.0, resumed pinned session/.test(l)), next.out.logs.join('\n'))

    // The spacing after a release, then its own wait, read off the canary's stamp on the real disk; then it goes, with no canary of its own.
    const provedAt = w.clock.now
    assert.equal(await second.controller.tick(), 'spacing')
    w.clock.now += 2 * MIN + 1000
    assert.equal(await second.controller.tick(), 'follower_wait', second.out.logs.join('\n'))
    assert.equal(existsSync(second.marker), false)
    w.clock.now = provedAt + m.followerWaitMs({ assistantId: '913', target: '0.81.0' })
    next.facts.beaconAtMs = w.clock.now
    await next.controller.tick()
    assert.equal(await second.controller.tick(), 'requested', second.out.logs.join('\n'))
    assert.ok(existsSync(second.marker))
    assert.equal(second.record().canaryN, null)
  } finally {
    rmSync(w.home, { recursive: true, force: true })
  }
})

test('a restart that never arrives: the real file the real ladder wrote is gone from the real disk, so hoai cannot take it later', async () => {
  const w = world(scratchHome())
  try {
    const a = agent(w, 912)
    assert.equal(await a.controller.tick(), 'requested')
    assert.ok(existsSync(a.marker), 'the ladder wrote it')
    w.clock.now += 3.5 * MIN + 1000
    assert.equal(await a.controller.tick(), 'did_not_arrive', a.out.logs.join('\n'))
    assert.equal(existsSync(a.marker), false)
    assert.equal(a.record().markerStranded, true)
    assert.equal(a.out.reports.at(-1)?.code, 'idle_update_launcher_latched')
  } finally {
    rmSync(w.home, { recursive: true, force: true })
  }
})

test('a follower fails on a build its canary proved: the real rollback points the real install at the build the canary left', async () => {
  const w = world(scratchHome())
  try {
    const cache = join(w.home, '.claude', 'plugins', 'cache', 'hoai', 'hoai')
    for (const version of ['0.79.0', '0.80.0', '0.81.0']) {
      mkdirSync(join(cache, version, '.claude-plugin'), { recursive: true })
      writeFileSync(join(cache, version, '.claude-plugin', 'plugin.json'), JSON.stringify({ version }))
    }
    const installed = join(w.home, '.claude', 'plugins', 'installed_plugins.json')
    writeFileSync(installed, JSON.stringify({ version: 2, plugins: { 'hoai@hoai': [{ scope: 'user', version: '0.81.0', installPath: join(cache, '0.81.0'), lastUpdated: new Date(T0).toISOString(), gitCommitSha: 'the-failed-build' }] } }))
    mkdirSync(join(w.machineDir, '0.81.0'), { recursive: true })
    writeFileSync(
      join(w.machineDir, '0.81.0', 'validated'),
      JSON.stringify({ assistantId: '913', at: new Date(T0 - HOUR).toISOString(), canary: 1, from: '0.80.0', fromRoot: join(cache, '0.80.0') }),
    )
    writeFileSync(join(w.machineDir, '0.81.0', 'alive'), JSON.stringify({ assistantId: '913', at: new Date(T0).toISOString() }))
    const old = agent(w, 912, { running: '0.79.0', fromRoot: join(cache, '0.79.0') })
    assert.equal(await old.controller.tick(), 'requested', old.out.logs.join('\n'))
    assert.equal(old.record().canaryN, null)
    rmSync(old.marker)
    w.clock.now += 2 * MIN
    const next = agent(w, 912, {
      running: '0.81.0',
      fromRoot: join(cache, '0.81.0'),
      rollbackInstall: (record: any) =>
        host.rollbackMarketplaceInstall({
          record,
          installedPluginsPath: installed,
          holdPath: join(w.machineDir, 'enrolment-hold.json'),
          marketplace: 'hoai',
          configDir: join(w.home, '.claude'),
          fs: m.nodeIdleUpdateFs(),
          setAutoUpdate: () => ({ changed: true, reason: 'set' }),
          now: w.clock.now,
        }),
    })
    assert.equal(await next.controller.tick(), 'validating')
    w.clock.now += 16 * MIN
    assert.equal(await next.controller.tick(), 'rollback', next.out.logs.join('\n'))
    assert.equal(next.record().state, 'rolled_back')
    assert.equal(next.record().from, '0.80.0')
    assert.match(readFileSync(installed, 'utf8'), /"version":\s*"0\.80\.0"/)
    assert.ok(readFileSync(installed, 'utf8').includes(JSON.stringify(join(cache, '0.80.0')).slice(1, -1)))
    assert.ok(existsSync(join(w.machineDir, '0.81.0', 'bad')))
    assert.ok(existsSync(join(w.machineDir, 'went-back-912')))
  } finally {
    rmSync(w.home, { recursive: true, force: true })
  }
})

test('a follower never heard from again: on the real disk its lease goes, silent-1 stays, and the next agent stays where it is', async () => {
  const w = world(scratchHome())
  try {
    mkdirSync(join(w.machineDir, '0.81.0'), { recursive: true })
    writeFileSync(join(w.machineDir, '0.81.0', 'validated'), JSON.stringify({ assistantId: '913', at: new Date(T0 - HOUR).toISOString(), canary: 1 }))
    writeFileSync(join(w.machineDir, '0.81.0', 'alive'), JSON.stringify({ assistantId: '913', at: new Date(T0).toISOString() }))
    const gone = agent(w, 912)
    assert.equal(await gone.controller.tick(), 'requested', gone.out.logs.join('\n'))
    const nonce = gone.record().nonce
    w.clock.now += 25 * MIN + 1000
    const next = agent(w, 914)
    assert.equal(await next.controller.tick(), 'canary_unconfirmed', next.out.logs.join('\n'))
    assert.equal(JSON.parse(readFileSync(join(w.machineDir, '0.81.0', 'silent-1'), 'utf8')).nonce, nonce)
    assert.equal(existsSync(join(w.machineDir, 'lease.json')), false)
    assert.equal(existsSync(next.marker), false)
    assert.deepEqual(next.out.drains, [])
    w.clock.now += 3 * MIN
    assert.equal(await next.controller.tick(), 'silent_hold', next.out.logs.join('\n'))
  } finally {
    rmSync(w.home, { recursive: true, force: true })
  }
})

test('a version latched bad on this computer is never asked, and the wait is reported once', async () => {
  const w = world(scratchHome())
  try {
    mkdirSync(join(w.machineDir, '0.81.0'), { recursive: true })
    writeFileSync(join(w.machineDir, '0.81.0', 'bad'), '{}')
    const a = agent(w, 912)
    assert.equal(await a.controller.tick(), 'version_held_bad')
    assert.equal(await a.controller.tick(), 'version_held_bad')
    assert.equal(existsSync(a.marker), false)
    assert.deepEqual(a.out.drains, [])
    assert.deepEqual(a.out.reports.map((r) => r?.code), ['idle_update_held'])
  } finally {
    rmSync(w.home, { recursive: true, force: true })
  }
})

test('the watcher sweeping this HOME owns its updates: the idle update stands down', async () => {
  const w = world(scratchHome())
  try {
    mkdirSync(join(w.home, '.bgos-agent', 'watcher'), { recursive: true })
    writeFileSync(join(w.home, '.bgos-agent', 'watcher', 'keepalive-state.json'), JSON.stringify({ schemaVersion: 1, updatedAt: new Date(T0 - MIN).toISOString(), enabled: true, agents: {} }))
    const a = agent(w, 912)
    assert.equal(await a.controller.tick(), 'watcher_owns_updates')
    assert.equal(existsSync(a.marker), false)
  } finally {
    rmSync(w.home, { recursive: true, force: true })
  }
})
