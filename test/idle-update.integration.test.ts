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
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { pendingMarketplaceRestartVersion } from '../lib/marketplace-update.mjs'
import { RESTART_WATCHDOG_MS, UpdateRpcHandler } from '../lib/update-rpc'
import type { RestartAuthority } from '../lib/update-readiness'
import { ThreadLaneManager, type ThreadLaneDeps } from '../lib/thread-lanes'
import { AsideForks, runAside } from '../lib/aside-fork'
import { sessionTranscriptPath } from '../bin/hoai-core.mjs'
import type { StreamJsonChild } from '../lib/stream-json-child'

const m: any = await import('../lib/idle-update.mjs')
const host: any = await import('../lib/idle-update-host.mjs')
const lanesLib: any = await import('../lib/thread-lanes')

const PIN = '0d6f2a8e-3c1b-4e7a-9f20-5b8c7d6e4f31'
const T0 = Date.parse('2026-10-28T12:00:00.000Z')
const MIN = 60_000
const HOUR = 60 * MIN

function scratchHome(): string {
  return mkdtempSync(join(tmpdir(), 'idle-update-int-'))
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

function agent(w: ReturnType<typeof world>, id: number, opts: { threadWork?: () => number; onCloseLook?: () => void; running?: string; staged?: string; stagedVersion?: () => string | null; fromRoot?: string; rollbackInstall?: (record: any) => Promise<any> } = {}) {
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
    stagedVersion: opts.stagedVersion ?? (() => opts.staged ?? '0.81.0'),
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
    threadWork: opts.threadWork ?? (() => 0),
    call: () => ({ pendingConsults: 0, openContinuations: 0, openMeetings: 0, lastVoiceAtMs: null }),
    lastBrowserToolAtMs: () => null,
    claudePid: () => b + 40,
    sessionId: async () => PIN,
    listProcesses: async () => ({ ok: true, processes: gen2Table(id, inputs.ownSockets[0]) }),
    launcher: () => host.readLauncherClaim({ stateDir, fs, alive: () => true }),
    unattendedInputs: () => host.readUnattendedInputs({ platform: 'darwin', home: w.home, assistantId: String(id), stateDir, fs }),
    personAttached: async () => {
      opts.onCloseLook?.()
      return false
    },
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
    const end = provedAt + m.followerWaitMs({ assistantId: '913', target: '0.81.0' })
    while (w.clock.now < end) {
      w.clock.now = Math.min(end, w.clock.now + 30_000)
      next.facts.beaconAtMs = w.clock.now
      await next.controller.tick()
    }
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
    writeFileSync(join(w.machineDir, '0.81.0', 'alive'), JSON.stringify({ assistantId: '913', at: new Date(T0).toISOString(), provedMs: 60 * MIN }))
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
    assert.equal(readFileSync(installed, 'utf8').includes('gitCommitSha'), false, 'the failed build\'s commit left with it')
    assert.ok(existsSync(join(w.machineDir, '0.81.0', 'bad')))
    assert.ok(existsSync(join(w.machineDir, 'went-back-912')))
  } finally {
    rmSync(w.home, { recursive: true, force: true })
  }
})

test('two silences on the real disk: the agent on the old build points the real install at its own build, and the next launch has nothing else to load', async () => {
  const w = world(scratchHome())
  try {
    const cache = join(w.home, '.claude', 'plugins', 'cache', 'hoai', 'hoai')
    for (const version of ['0.80.0', '0.81.0']) {
      mkdirSync(join(cache, version, '.claude-plugin'), { recursive: true })
      writeFileSync(join(cache, version, '.claude-plugin', 'plugin.json'), JSON.stringify({ version }))
    }
    const installed = join(w.home, '.claude', 'plugins', 'installed_plugins.json')
    writeFileSync(installed, JSON.stringify({ version: 2, plugins: { 'hoai@hoai': [{ scope: 'user', version: '0.81.0', installPath: join(cache, '0.81.0'), lastUpdated: new Date(T0).toISOString(), gitCommitSha: 'the-marked-build' }] } }))
    mkdirSync(join(w.machineDir, '0.81.0'), { recursive: true })
    for (const [n, id] of [[1, '913'], [2, '914']]) {
      writeFileSync(join(w.machineDir, '0.81.0', `silent-${n}`), JSON.stringify({ assistantId: id, nonce: `n${n}`, by: '915', at: new Date(T0 - 3 * HOUR).toISOString() }))
    }
    const stagedNow = () => {
      const entry = JSON.parse(readFileSync(installed, 'utf8')).plugins['hoai@hoai'][0]
      return entry.version === '0.80.0' ? null : entry.version
    }
    const switched: boolean[] = []
    const rollbackInstall = (record: any) =>
      host.rollbackMarketplaceInstall({
        record,
        installedPluginsPath: installed,
        holdPath: join(w.machineDir, 'enrolment-hold.json'),
        marketplace: 'hoai',
        configDir: join(w.home, '.claude'),
        fs: m.nodeIdleUpdateFs(),
        setAutoUpdate: (enabled: boolean) => (switched.push(enabled), { changed: true, reason: 'set' }),
        now: w.clock.now,
      })
    const old = agent(w, 915, { fromRoot: join(cache, '0.80.0'), stagedVersion: stagedNow, rollbackInstall })
    for (let poll = 0; poll < 31; poll += 1) {
      await old.controller.tick()
      w.clock.now += 30_000
    }
    assert.equal(JSON.parse(readFileSync(join(w.machineDir, '0.81.0', 'bad'), 'utf8')).reason, 'canaries_silent')
    const entry = JSON.parse(readFileSync(installed, 'utf8')).plugins['hoai@hoai'][0]
    assert.deepEqual([entry.version, entry.installPath], ['0.80.0', join(cache, '0.80.0')])
    assert.equal(entry.gitCommitSha, undefined, 'the marked build\'s commit left with it')
    assert.deepEqual(switched, [false])
    assert.equal(JSON.parse(readFileSync(join(w.machineDir, 'enrolment-hold.json'), 'utf8')).version, '0.81.0')
    assert.equal(existsSync(old.marker), false, 'it restarted nobody')
    assert.deepEqual(old.out.drains, [])
    assert.equal(await old.controller.tick(), 'nothing_staged')
  } finally {
    rmSync(w.home, { recursive: true, force: true })
  }
})

test('a mixed fleet on the real disk: the oldest agent takes the install first, and the newest good build raises it, through the real reader and the real rollback', async () => {
  const w = world(scratchHome())
  try {
    const cache = join(w.home, '.claude', 'plugins', 'cache', 'hoai', 'hoai')
    for (const version of ['0.74.0', '0.80.0', '0.81.0']) {
      mkdirSync(join(cache, version, '.claude-plugin'), { recursive: true })
      writeFileSync(join(cache, version, '.claude-plugin', 'plugin.json'), JSON.stringify({ version }))
    }
    const installed = join(w.home, '.claude', 'plugins', 'installed_plugins.json')
    writeFileSync(installed, JSON.stringify({ version: 2, plugins: { 'hoai@hoai': [{ scope: 'user', version: '0.81.0', installPath: join(cache, '0.81.0'), lastUpdated: new Date(T0).toISOString() }] } }))
    mkdirSync(join(w.machineDir, '0.81.0'), { recursive: true })
    writeFileSync(join(w.machineDir, '0.81.0', 'bad'), JSON.stringify({ assistantId: '913', at: new Date(T0).toISOString(), reason: 'canaries_silent' }))
    const onInstall = () => JSON.parse(readFileSync(installed, 'utf8')).plugins['hoai@hoai'][0]
    const stagedFor = (running: string) => () => pendingMarketplaceRestartVersion({ installed: { present: true, version: onInstall().version }, runningVersion: running })
    const switched: boolean[] = []
    const rollbackInstall = (record: any) =>
      host.rollbackMarketplaceInstall({
        record,
        installedPluginsPath: installed,
        holdPath: join(w.machineDir, host.enrolmentHoldFileName(join(w.home, '.claude'))),
        marketplace: 'hoai',
        configDir: join(w.home, '.claude'),
        fs: m.nodeIdleUpdateFs(),
        setAutoUpdate: (enabled: boolean) => (switched.push(enabled), { changed: switched.length === 1, reason: 'set' }),
        now: w.clock.now,
      })
    const oldest = agent(w, 914, { running: '0.74.0', fromRoot: join(cache, '0.74.0'), stagedVersion: stagedFor('0.74.0'), rollbackInstall })
    const newest = agent(w, 915, { running: '0.80.0', fromRoot: join(cache, '0.80.0'), stagedVersion: stagedFor('0.80.0'), rollbackInstall })
    await oldest.controller.tick()
    assert.equal(onInstall().version, '0.74.0')
    await newest.controller.tick()
    assert.deepEqual([onInstall().version, onInstall().installPath], ['0.80.0', join(cache, '0.80.0')])
    assert.equal(JSON.parse(readFileSync(join(w.machineDir, 'install-back.json'), 'utf8')).target, '0.81.0')
    assert.equal(existsSync(newest.marker), false, 'it restarted nobody')
    assert.equal(await newest.controller.tick(), 'nothing_staged')
  } finally {
    rmSync(w.home, { recursive: true, force: true })
  }
})

test('a follower never heard from again: on the real disk its lease goes, silent-1 stays, and the next agent stays where it is', async () => {
  const w = world(scratchHome())
  try {
    mkdirSync(join(w.machineDir, '0.81.0'), { recursive: true })
    writeFileSync(join(w.machineDir, '0.81.0', 'validated'), JSON.stringify({ assistantId: '913', at: new Date(T0 - HOUR).toISOString(), canary: 1 }))
    writeFileSync(join(w.machineDir, '0.81.0', 'alive'), JSON.stringify({ assistantId: '913', at: new Date(T0).toISOString(), provedMs: 60 * MIN }))
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
    // Another agent is the one that moves the install: this one finds nothing to write.
    const a = agent(w, 912, { rollbackInstall: async () => ({ ok: true, moved: false }) })
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

// -- Thread lanes and By the way forks: an update must never stop one (Data's ruling, 4 Nov) ----------------------

class StandInChild implements StreamJsonChild {
  pid?: number
  private out: Array<(c: string) => void> = []
  private exits: Array<(code: number | null, signal: string | null) => void> = []
  write() {}
  end() {}
  kill() {}
  onStdout(cb: (c: string) => void) { this.out.push(cb) }
  onExit(cb: (code: number | null, signal: string | null) => void) { this.exits.push(cb) }
  frame(f: Record<string, unknown>) { for (const cb of this.out) cb(`${JSON.stringify(f)}\n`) }
  exit() { for (const cb of this.exits) cb(0, null) }
}

/** The real lane manager and the real forks, the two the daemon asks. Only the child processes, git and the disk are stand-ins. */
function threadWorld() {
  const FORK = 'dbd3b62b-f099-4f95-be1d-4687b4af9042'
  const children: StandInChild[] = []
  const spawn = () => {
    const child = new StandInChild()
    child.pid = 4000 + children.length
    children.push(child)
    return child
  }
  // Native absolute paths: on Windows the lane refuses a folder with no drive letter, and no turn starts.
  const HOME = resolve('/h')
  const FOLDER = resolve('/a')
  const STATE_DIR = join(HOME, 'threads')
  const EMPTY_MCP = join(STATE_DIR, 'empty.json')
  const files = new Map<string, string>([[sessionTranscriptPath(HOME, FOLDER, PIN, ''), '{}\n']])
  const deps: ThreadLaneDeps = {
    spawn,
    claudeBin: () => '/bin/claude',
    cliProblem: () => null,
    mainSessionId: () => PIN,
    agentFolder: FOLDER,
    stateDir: STATE_DIR,
    home: HOME,
    configDir: '',
    emptyMcpConfigPath: () => EMPTY_MCP,
    processes: { stamp: async () => 'S', runsIn: async () => true, kill: () => {} },
    shellSandbox: () => true,
    platform: 'darwin',
    git: async () => ({ ok: false, stdout: '' }),
    fs: {
      exists: (p) => files.has(p),
      mkdir: () => {},
      readFile: (p) => { const v = files.get(p); if (v === undefined) throw new Error(`ENOENT ${p}`); return v },
      writeFile: (p, c) => { files.set(p, c) },
      appendFile: (p, c) => { files.set(p, (files.get(p) ?? '') + c) },
      copyFile: (a, b) => { files.set(b, files.get(a) ?? '') },
      unlink: (p) => { files.delete(p) },
      rmrf: () => {},
      createExclusive: (p, c) => { if (files.has(p)) throw new Error(`EEXIST ${p}`); files.set(p, c) },
      rename: (a, b) => { files.set(b, files.get(a) ?? ''); files.delete(a) },
      list: () => [],
    },
    post: async () => ({}),
    now: () => T0,
    setTimer: () => ({}),
    clearTimer: () => {},
    log: () => {},
  }
  const lanes = new ThreadLaneManager(deps)
  const forks = new AsideForks()
  const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((done) => setImmediate(done)) }
  return {
    lanes,
    forks,
    children,
    flush,
    work: () => lanesLib.liveThreadWork(lanes, forks) as number,
    startTurn: (rootId: string) => lanes.turn({ chatId: '55', rootId, replyId: `${rootId}0`, mode: 'start', text: 'work', title: 'T', rootText: 'root' }),
    finishTurn: (child: StandInChild) => {
      child.frame({ type: 'system', subtype: 'init', session_id: FORK })
      // The CLI's assistant frame comes first: a lane skips a result before it.
      child.frame({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'the answer' }] } })
      child.frame({ type: 'result', subtype: 'success', is_error: false, result: 'the answer' })
    },
    startFork: () => runAside({ question: 'why?', quote: '', history: [] }, {
      spawn,
      claudeBin: () => '/bin/claude',
      cliProblem: () => null,
      mainSessionId: () => PIN,
      mainFolder: FOLDER,
      home: HOME,
      configDir: '',
      emptyMcpConfigPath: () => EMPTY_MCP,
      unlink: () => {},
      onDelta: () => {},
      setTimer: () => ({}),
      clearTimer: () => {},
      forks,
    }).catch(() => ({ text: '' })),
  }
}

test('a running thread turn holds the restart off, and the restart goes ahead once the turn is over', async () => {
  const w = world(scratchHome())
  try {
    const t = threadWorld()
    t.startTurn('101')
    await t.flush()
    assert.equal(t.children.length, 1, 'the turn has its process')
    const a = agent(w, 931, { threadWork: t.work })
    assert.equal(await a.controller.tick(), 'thread_work', a.out.logs.join('\n'))
    assert.ok(!existsSync(a.marker), 'no restart was asked over the turn')
    assert.deepEqual(a.out.drains, [], 'intake stays open while the agent waits')
    t.finishTurn(t.children[0]!)
    await t.flush()
    assert.equal(t.lanes.liveChildren(), 1, 'the lane still sits idle on its process, and that is not work')
    assert.equal(await a.controller.tick(), 'requested', a.out.logs.join('\n'))
    assert.ok(existsSync(a.marker))
  } finally {
    rmSync(w.home, { recursive: true, force: true })
  }
})

test('a running By the way fork holds the restart off, and the restart goes ahead once it has exited', async () => {
  const w = world(scratchHome())
  try {
    const t = threadWorld()
    const answered = t.startFork()
    await t.flush()
    assert.equal(t.forks.size(), 1)
    const a = agent(w, 932, { threadWork: t.work })
    assert.equal(await a.controller.tick(), 'thread_work', a.out.logs.join('\n'))
    assert.ok(!existsSync(a.marker))
    t.children[0]!.frame({ type: 'result', subtype: 'success', is_error: false, result: 'because' })
    await answered
    assert.equal(await a.controller.tick(), 'thread_work', 'answered, but its process has not exited and a restart would kill it')
    t.children[0]!.exit()
    assert.equal(await a.controller.tick(), 'requested', a.out.logs.join('\n'))
  } finally {
    rmSync(w.home, { recursive: true, force: true })
  }
})

test('with a turn and a fork both running, the restart waits for the last of them', async () => {
  const w = world(scratchHome())
  try {
    const t = threadWorld()
    t.startTurn('101')
    await t.flush()
    void t.startFork()
    await t.flush()
    const a = agent(w, 933, { threadWork: t.work })
    assert.equal(await a.controller.tick(), 'thread_work')
    t.finishTurn(t.children[0]!)
    await t.flush()
    assert.equal(await a.controller.tick(), 'thread_work', 'the fork still runs')
    t.children[1]!.exit()
    assert.equal(await a.controller.tick(), 'requested', a.out.logs.join('\n'))
  } finally {
    rmSync(w.home, { recursive: true, force: true })
  }
})

test('the race: a turn that starts while the controller takes its close look stops the restart before anything drains', async () => {
  const w = world(scratchHome())
  try {
    const t = threadWorld()
    const a = agent(w, 934, { threadWork: t.work, onCloseLook: () => t.startTurn('101') })
    assert.equal(await a.controller.tick(), 'thread_work', a.out.logs.join('\n'))
    assert.ok(!existsSync(a.marker))
    assert.deepEqual(a.out.drains, [])
  } finally {
    rmSync(w.home, { recursive: true, force: true })
  }
})

test('thread work that cannot be read counts as work', async () => {
  const w = world(scratchHome())
  try {
    const a = agent(w, 935, { threadWork: () => { throw new Error('unreadable') } })
    assert.equal(await a.controller.tick(), 'thread_work', a.out.logs.join('\n'))
    assert.ok(!existsSync(a.marker))
  } finally {
    rmSync(w.home, { recursive: true, force: true })
  }
})
