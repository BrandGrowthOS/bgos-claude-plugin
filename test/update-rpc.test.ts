import { describe, expect, test } from 'bun:test'

import type { UpdateNowOutcome } from '../lib/self-update'
import {
  DRAIN_TIMEOUT_PROCEEDING,
  INSTALLING_STEP_KINDS,
  PROGRESS_MESSAGE_MAX_CHARS,
  RESTART_DID_NOT_ARRIVE,
  RESTART_WATCHDOG_MS,
  UpdateRpcHandler,
  clipProgressMessage,
  normalizeUpdateRpc,
  type MarketplaceStepReport,
  type MarketplaceUpdateOutcome,
  type UpdateRpcDeps,
} from '../lib/update-rpc'
import type { RestartAuthority, ServiceOwnershipReading } from '../lib/update-readiness'
import { failureToken } from '../lib/update-diagnostics.mjs'

describe('normalizeUpdateRpc', () => {
  test('accepts exactly {rpcId, op: update_now} and drops everything else', () => {
    expect(normalizeUpdateRpc({ rpcId: 'r1', op: 'update_now' })).toEqual({
      rpcId: 'r1',
      op: 'update_now',
    })
    expect(normalizeUpdateRpc({ rpcId: 'r1', op: 'self_destruct' })).toBeNull()
    expect(normalizeUpdateRpc({ op: 'update_now' })).toBeNull()
    expect(normalizeUpdateRpc({ rpcId: 42, op: 'update_now' })).toBeNull()
    expect(normalizeUpdateRpc(null)).toBeNull()
    expect(normalizeUpdateRpc('update_now')).toBeNull()
  })

  test('SECURITY: extra fields are ignored, the frame can never carry a payload', () => {
    const frame = normalizeUpdateRpc({
      rpcId: 'r1',
      op: 'update_now',
      version: '9.9.9',
      url: 'https://evil.example',
      script: 'rm -rf /',
    })
    expect(frame).toEqual({ rpcId: 'r1', op: 'update_now' })
  })
})

type Snapshot = { activeOperations: number; pendingMessages: number; pendingPermissions: number }
const IDLE: Snapshot = { activeOperations: 0, pendingMessages: 0, pendingPermissions: 0 }
const BUSY: Snapshot = { activeOperations: 1, pendingMessages: 0, pendingPermissions: 0 }

interface HarnessOverrides {
  installMethod?: 'marketplace' | 'clone'
  autoUpdateEnabled?: boolean
  updater?: UpdateRpcDeps['updater']
  marketplaceUpdate?: UpdateRpcDeps['marketplaceUpdate']
  drainSnapshot?: () => Snapshot
  authority?: RestartAuthority
  ackError?: boolean
  progressError?: boolean
  markerWriteOk?: boolean
  /** Does the SIGTERM to the keepalive's session land? */
  signalOk?: boolean
  diagnosticsError?: boolean
  now?: () => number
  /** Ownership readings for a service authority; the default says the job
   *  holds this process (the healthy case), so every pre-existing service
   *  test keeps its meaning. */
  ownership?: ServiceOwnershipReading
}

/** Live control taken on the dev Mac on 2026-09-12: argus's daemon (pid 240)
 *  chains 240 > 99845 > 99827 > 99136 > 1, and 99136 is the main pid of the
 *  launchd job ai.bgos.agent.1050, so that job OWNS the daemon. */
const LAUNCHD_JOB = { kind: 'launchd' as const, handle: 'ai.bgos.agent.1050' }
const SYSTEMD_UNIT = { kind: 'systemd' as const, handle: 'bgos-agent-871' }
const OWNED: ServiceOwnershipReading = {
  ownPid: 240,
  ancestorPids: [240, 99845, 99827, 99136, 1],
  servicePid: 99136,
}
/** The muted nine (2026-09-11): the daemon runs under a detached tmux server
 *  (pid 798, reparented to launchd) while the declared job is the keepalive
 *  SCRIPT (pid 97998), which is nowhere in the chain. A kickstart at that job
 *  kills nothing; the daemon drains and stays deaf. */
const UNOWNED: ServiceOwnershipReading = {
  ownPid: 52214,
  ancestorPids: [52214, 52034, 52030, 798, 1],
  servicePid: 97998,
}

function fakeUpdater(overrides?: {
  latched?: boolean
  pending?: string | null
  outcome?: UpdateNowOutcome
}) {
  const calls: Array<{ stage: string; targetVersion: string | null }> = []
  const updater = {
    updateNowCalls: 0,
    reported: calls,
    isRollbackLatched: () => overrides?.latched === true,
    pendingRestartVersion: () => overrides?.pending ?? null,
    updateNow: async (
      report: (stage: 'draining' | 'installing', targetVersion: string | null) => Promise<void>,
    ): Promise<UpdateNowOutcome> => {
      updater.updateNowCalls += 1
      const outcome =
        overrides?.outcome ?? ({ kind: 'installed', targetVersion: '0.39.0' } as const)
      if (outcome.kind === 'installed') {
        await report('draining', outcome.targetVersion)
        await report('installing', outcome.targetVersion)
      }
      return outcome
    },
  }
  return updater
}

/** A scripted marketplace run: reports the given steps as 'running' then
 *  returns the outcome. Records how often it ran. */
function fakeMarketplace(opts?: {
  steps?: Array<{ id: string; kind: string; state?: string; message?: string; targetVersion?: string | null }>
  outcome?: MarketplaceUpdateOutcome
  throws?: Error
}) {
  const run = {
    calls: 0,
    fn: (async (report: (step: MarketplaceStepReport) => Promise<void>) => {
      run.calls += 1
      if (opts?.throws) throw opts.throws
      const steps = opts?.steps ?? [
        { id: 's1', kind: 'snapshot' },
        { id: 's2', kind: 'refresh_marketplace' },
        { id: 's3', kind: 'update_plugin' },
        { id: 's4', kind: 'verify_installed' },
        { id: 's5', kind: 'restart_agent' },
        { id: 's6', kind: 'verify_agent' },
      ]
      for (const step of steps) {
        await report({
          id: step.id,
          kind: step.kind,
          state: step.state ?? 'running',
          ...(step.message ? { message: step.message } : {}),
          targetVersion: step.targetVersion === undefined ? '0.39.0' : step.targetVersion,
        })
      }
      return opts?.outcome ?? { kind: 'installed', targetVersion: '0.39.0' }
    }) as UpdateRpcDeps['marketplaceUpdate'],
  }
  return run
}

function harness(overrides: HarnessOverrides = {}) {
  const acks: string[] = []
  const progress: Array<Record<string, unknown>> = []
  const logs: string[] = []
  const spawned: Array<{ file: string; args: string[] }> = []
  const markers: string[] = []
  const signals: Array<{ pid: number; signal: string }> = []
  const drainModes: boolean[] = []
  const diagnostics: Array<Record<string, unknown>> = []
  const ownershipCalls: Array<{ kind: string; handle: string }> = []
  const timers: Array<{ ms: number; fn: () => void; cancelled: boolean }> = []
  let heartbeats = 0
  const handler = new UpdateRpcHandler({
    postAck: async (rpcId) => {
      if (overrides.ackError) throw new Error('ack 500')
      acks.push(rpcId)
      return {}
    },
    postProgress: async (_rpcId, body) => {
      if (overrides.progressError) throw new Error('progress 500')
      progress.push(body)
      return {}
    },
    log: (msg) => logs.push(msg),
    installMethod: () => overrides.installMethod ?? 'clone',
    autoUpdateEnabled: () => overrides.autoUpdateEnabled ?? true,
    updater: overrides.updater ?? (() => fakeUpdater()),
    marketplaceUpdate: overrides.marketplaceUpdate ?? fakeMarketplace().fn,
    drainSnapshot: overrides.drainSnapshot ?? (() => IDLE),
    // Default authority differs by install method on purpose: a CLONE update
    // now fails a pre-flight (no_restart_authority) when nothing can restart
    // it, so a clone flow test that wants to exercise draining/installing must
    // start from a real authority; a MARKETPLACE update still stages into a
    // versioned cache the next launch picks up, so its default stays 'staged'.
    // Tests that specifically exercise the no-authority abort set it to
    // { kind: 'staged' } explicitly.
    restartAuthority: () =>
      overrides.authority ??
      ((overrides.installMethod ?? 'clone') === 'clone'
        ? { kind: 'launcher', markerPath: '/state/871/restart-requested.json' }
        : { kind: 'staged' }),
    spawnDetached: (file, args) => spawned.push({ file, args }),
    writeMarker: (path) => {
      if (overrides.markerWriteOk === false) return false
      markers.push(path)
      return true
    },
    signalProcess: (pid, signal) => {
      if (overrides.signalOk === false) return false
      signals.push({ pid, signal })
      return true
    },
    setDrainMode: (enabled) => drainModes.push(enabled),
    requestHeartbeat: () => {
      heartbeats += 1
    },
    serviceOwnership: (service) => {
      ownershipCalls.push({ kind: service.kind, handle: service.handle })
      return overrides.ownership ?? OWNED
    },
    setTimer: (fn, ms) => {
      const timer = { ms, fn, cancelled: false }
      timers.push(timer)
      return () => {
        timer.cancelled = true
      }
    },
    postFailureDiagnostics: async (bundle) => {
      if (overrides.diagnosticsError) throw new Error('intake 500')
      diagnostics.push(bundle)
      return {}
    },
    now: overrides.now,
    sleep: async () => {},
  })
  return {
    handler,
    acks,
    progress,
    logs,
    spawned,
    markers,
    signals,
    drainModes,
    diagnostics,
    heartbeats: () => heartbeats,
    ownershipCalls,
    timers,
    /** Fire every live watchdog, as the clock would, and let its async
     *  recovery settle. */
    fireWatchdog: async () => {
      for (const timer of timers) if (!timer.cancelled) timer.fn()
      await Bun.sleep(0)
    },
  }
}

const FRAME = { rpcId: 'rpc-1', op: 'update_now' as const }

describe('UpdateRpcHandler decision table (clone)', () => {
  test('kill switch off reports updates_disabled', async () => {
    const h = harness({ autoUpdateEnabled: false })
    await h.handler.handle(FRAME)
    expect(h.progress).toEqual([{ stage: 'error', message: 'updates_disabled' }])
  })

  test('no updater reports updater_unavailable', async () => {
    const h = harness({ updater: () => null })
    await h.handler.handle(FRAME)
    expect(h.progress).toEqual([{ stage: 'error', message: 'updater_unavailable' }])
  })

  test('a rollback latch reports rollback_latched and never runs the update', async () => {
    const updater = fakeUpdater({ latched: true })
    const h = harness({ updater: () => updater })
    await h.handler.handle(FRAME)
    expect(h.progress).toEqual([{ stage: 'error', message: 'rollback_latched' }])
    expect(updater.updateNowCalls).toBe(0)
  })

  test('outcome mapping: no-update, dirty, not-ff, busy are all descriptive errors', async () => {
    const cases: Array<[UpdateNowOutcome, string]> = [
      [{ kind: 'no-update', latestVersion: '0.38.0', reason: 'not-newer' }, 'no_update_available'],
      [{ kind: 'dirty-tree' }, 'dirty_tree'],
      [{ kind: 'not-fast-forward' }, 'not_fast_forward'],
      [{ kind: 'busy' }, 'update_in_flight'],
      [{ kind: 'latched' }, 'rollback_latched'],
    ]
    for (const [outcome, message] of cases) {
      const h = harness({ updater: () => fakeUpdater({ outcome }) })
      await h.handler.handle({ ...FRAME, rpcId: `rpc-${message}` })
      expect(h.progress).toEqual([{ stage: 'error', message }])
    }
  })

  test('a failed outcome surfaces its message verbatim', async () => {
    const h = harness({
      updater: () =>
        fakeUpdater({ outcome: { kind: 'failed', message: 'git blew up', latched: false } }),
    })
    await h.handler.handle(FRAME)
    expect(h.progress).toEqual([{ stage: 'error', message: 'git blew up' }])
  })

  test('a clone drain timeout surfaces as error drain_timeout (the updater already un-drained)', async () => {
    const h = harness({
      updater: () =>
        fakeUpdater({ outcome: { kind: 'failed', message: 'drain_timeout', latched: false } }),
    })
    await h.handler.handle(FRAME)
    expect(h.progress).toEqual([{ stage: 'error', message: 'drain_timeout' }])
    expect(h.spawned).toEqual([])
    expect(h.markers).toEqual([])
  })

  test('the clone path never touches the marketplace runner', async () => {
    const market = fakeMarketplace()
    // A real (launcher) authority so the pre-flight passes and the clone flow
    // runs through to a restart; the point of the test is market.calls === 0.
    const h = harness({ marketplaceUpdate: market.fn })
    await h.handler.handle(FRAME)
    expect(market.calls).toBe(0)
    expect(h.progress.map((p) => p.stage)).toEqual(['draining', 'installing', 'restarting'])
  })
})

describe('UpdateRpcHandler restart ladder', () => {
  test('service authority: draining, installing, restarting, then the detached restart', async () => {
    const command = {
      file: 'systemd-run',
      args: ['--user', '--on-active=2', 'systemctl', '--user', 'restart', 'bgos-agent-871'],
    }
    const h = harness({ authority: { kind: 'service', service: SYSTEMD_UNIT, command } })
    await h.handler.handle(FRAME)
    expect(h.progress).toEqual([
      { stage: 'draining', targetVersion: '0.39.0' },
      { stage: 'installing', targetVersion: '0.39.0' },
      { stage: 'restarting', targetVersion: '0.39.0' },
    ])
    expect(h.spawned).toEqual([command])
    // Drain stays as the updater left it: no un-drain before the restart.
    expect(h.drainModes).toEqual([])
    expect(h.heartbeats()).toBe(0)
  })

  test('launcher authority: restarting, then the marker (in that order)', async () => {
    const h = harness({ authority: { kind: 'launcher', markerPath: '/state/871/restart-requested.json' } })
    await h.handler.handle(FRAME)
    expect(h.progress.map((p) => p.stage)).toEqual(['draining', 'installing', 'restarting'])
    expect(h.markers).toEqual(['/state/871/restart-requested.json'])
    expect(h.spawned).toEqual([])
    expect(h.drainModes).toEqual([])
  })

  test('launcher marker write failure degrades to staged', async () => {
    const h = harness({
      authority: { kind: 'launcher', markerPath: '/state/871/restart-requested.json' },
      markerWriteOk: false,
    })
    await h.handler.handle(FRAME)
    expect(h.progress.map((p) => p.stage)).toEqual([
      'draining',
      'installing',
      'restarting',
      'staged',
    ])
    expect(h.drainModes).toEqual([false])
    expect(h.heartbeats()).toBe(1)
  })

  test('clone with NO restart authority aborts no_restart_authority before draining or pulling', async () => {
    // The core of the one-click-update fix: a clone update that cannot be
    // restarted into is limbo, not a stage. It must fail LOUDLY and keep
    // serving the CURRENT version, never drain, never pull, never install.
    const updater = fakeUpdater()
    const h = harness({ authority: { kind: 'staged' }, updater: () => updater })
    await h.handler.handle(FRAME)
    expect(h.progress).toEqual([{ stage: 'error', message: 'no_restart_authority' }])
    expect(updater.updateNowCalls).toBe(0)
    expect(h.drainModes).toEqual([])
    expect(h.spawned).toEqual([])
    expect(h.markers).toEqual([])
    expect(h.heartbeats()).toBe(0)
  })

  test('a pending installed version skips the pull and goes straight to the ladder', async () => {
    const updater = fakeUpdater({ pending: '0.39.0' })
    const h = harness({ updater: () => updater })
    await h.handler.handle(FRAME)
    expect(updater.updateNowCalls).toBe(0)
    // A real (launcher) authority, so the pending install restarts rather than
    // sitting in limbo: restart + marker, no pull.
    expect(h.progress).toEqual([{ stage: 'restarting', targetVersion: '0.39.0' }])
    expect(h.markers).toEqual(['/state/871/restart-requested.json'])
    expect(h.heartbeats()).toBe(0)
  })
})

describe('restart authority ownership: a job that does not hold this process is no authority', () => {
  // Measured 2026-09-11: after a forced update_now, 9 of 21 daemons reported
  // 'restarting', drained, and stayed deaf for 50 minutes. Their declared
  // launchd job was the keepalive SCRIPT, whose singleton guard saw the
  // claude session alive and waited; the daemon was never its child, so the
  // kickstart killed nothing. The check that separates the two cases is pid
  // ancestry: the job's main pid must be an ancestor of this process.
  const KEEPALIVE = { kind: 'launchd' as const, handle: 'ai.bgos.session.930' }
  const KICKSTART = { file: '/bin/sh', args: ['-c', 'sleep 2 && launchctl kickstart -k gui/501/ai.bgos.session.930'] }

  test('clone: a service whose pid is not an ancestor fails no_restart_authority before draining or pulling', async () => {
    const updater = fakeUpdater()
    const h = harness({
      authority: { kind: 'service', service: KEEPALIVE, command: KICKSTART },
      ownership: UNOWNED,
      updater: () => updater,
    })
    await h.handler.handle(FRAME)
    expect(h.progress).toEqual([{ stage: 'error', message: 'no_restart_authority' }])
    expect(updater.updateNowCalls).toBe(0)
    expect(h.drainModes).toEqual([])
    expect(h.spawned).toEqual([])
    expect(h.timers).toEqual([])
    expect(h.heartbeats()).toBe(0)
    expect(h.ownershipCalls).toEqual([{ kind: 'launchd', handle: 'ai.bgos.session.930' }])
    // The log names the handle and BOTH pids, so an operator can see which
    // job was declared and what actually holds the process.
    const line = h.logs.find((l) => l.includes('does not own this process'))
    expect(line).toBeDefined()
    expect(line).toContain('ai.bgos.session.930')
    expect(line).toContain('97998')
    expect(line).toContain('52214')
  })

  test('clone: a service whose pid IS an ancestor restarts as today (restarting, then the detached spawn)', async () => {
    const command = { file: '/bin/sh', args: ['-c', 'sleep 2 && launchctl kickstart -k gui/501/ai.bgos.agent.1050'] }
    const h = harness({ authority: { kind: 'service', service: LAUNCHD_JOB, command }, ownership: OWNED })
    await h.handler.handle(FRAME)
    expect(h.progress.map((p) => p.stage)).toEqual(['draining', 'installing', 'restarting'])
    expect(h.spawned).toEqual([command])
    expect(h.drainModes).toEqual([])
    expect(h.heartbeats()).toBe(0)
  })

  test('the pending-version shortcut runs AFTER the ownership pre-flight: an unowned job never spawns', async () => {
    const updater = fakeUpdater({ pending: '0.39.1' })
    const h = harness({
      authority: { kind: 'service', service: KEEPALIVE, command: KICKSTART },
      ownership: UNOWNED,
      updater: () => updater,
    })
    await h.handler.handle(FRAME)
    expect(h.progress).toEqual([{ stage: 'error', message: 'no_restart_authority' }])
    expect(h.spawned).toEqual([])
    expect(h.drainModes).toEqual([])
  })

  test('a job that is not running (no main pid) does not own us either', async () => {
    const h = harness({
      authority: { kind: 'service', service: LAUNCHD_JOB, command: KICKSTART },
      ownership: { ...OWNED, servicePid: null },
    })
    await h.handler.handle(FRAME)
    expect(h.progress).toEqual([{ stage: 'error', message: 'no_restart_authority' }])
    expect(h.spawned).toEqual([])
  })

  test('marketplace: an unowned service stages instead of restarting through it (un-drained, heartbeat)', async () => {
    // The marketplace install lands in a versioned cache the next launch picks
    // up, so 'staged' is its legitimate outcome; what must never happen is a
    // kickstart at a job that does not hold us, followed by a drain nobody lifts.
    const h = harness({
      installMethod: 'marketplace',
      authority: { kind: 'service', service: KEEPALIVE, command: KICKSTART },
      ownership: UNOWNED,
    })
    await h.handler.handle(FRAME)
    expect(h.progress[h.progress.length - 1]).toEqual({ stage: 'staged', targetVersion: '0.39.0' })
    expect(h.progress.some((p) => p.stage === 'restarting')).toBe(false)
    expect(h.spawned).toEqual([])
    expect(h.drainModes).toEqual([true, false])
    expect(h.heartbeats()).toBe(1)
    expect(h.timers).toEqual([])
    expect(h.logs.some((l) => l.includes('does not own this process'))).toBe(true)
  })
})

describe('the un-drain watchdog: a restart that never arrives must not leave the daemon deaf', () => {
  const OWNED_SERVICE: RestartAuthority = {
    kind: 'service',
    service: LAUNCHD_JOB,
    command: { file: 'launchctl', args: ['kickstart', '-k', 'gui/501/ai.bgos.agent.1050'] },
  }

  test('armed for RESTART_WATCHDOG_MS (3 minutes) once the service restart is spawned', async () => {
    const h = harness({ authority: OWNED_SERVICE })
    await h.handler.handle(FRAME)
    expect(RESTART_WATCHDOG_MS).toBe(3 * 60 * 1000)
    expect(h.timers.map((t) => t.ms)).toEqual([RESTART_WATCHDOG_MS])
    expect(h.timers[0]!.cancelled).toBe(false)
  })

  test('service path: restarting, then the watchdog fires: drain off, error restart_did_not_arrive, heartbeat', async () => {
    const h = harness({ authority: OWNED_SERVICE })
    await h.handler.handle(FRAME)
    expect(h.progress.map((p) => p.stage)).toEqual(['draining', 'installing', 'restarting'])
    expect(h.drainModes).toEqual([])
    expect(h.heartbeats()).toBe(0)
    await h.fireWatchdog()
    expect(h.drainModes).toEqual([false])
    expect(h.progress[h.progress.length - 1]).toEqual({ stage: 'error', message: RESTART_DID_NOT_ARRIVE })
    expect(h.heartbeats()).toBe(1)
    expect(h.logs.some((l) => l.includes('RESTART DID NOT ARRIVE'))).toBe(true)
  })

  test('launcher path: the same watchdog, the same recovery', async () => {
    const h = harness({ authority: { kind: 'launcher', markerPath: '/state/871/restart-requested.json' } })
    await h.handler.handle(FRAME)
    expect(h.markers).toEqual(['/state/871/restart-requested.json'])
    expect(h.timers.map((t) => t.ms)).toEqual([RESTART_WATCHDOG_MS])
    await h.fireWatchdog()
    expect(h.drainModes).toEqual([false])
    expect(h.progress[h.progress.length - 1]).toEqual({ stage: 'error', message: RESTART_DID_NOT_ARRIVE })
    expect(h.heartbeats()).toBe(1)
  })

  test('marketplace path: both restart rungs arm it too', async () => {
    const service = harness({ installMethod: 'marketplace', authority: OWNED_SERVICE })
    await service.handler.handle(FRAME)
    expect(service.timers.map((t) => t.ms)).toEqual([RESTART_WATCHDOG_MS])
    await service.fireWatchdog()
    expect(service.drainModes).toEqual([true, false])
    expect(service.progress[service.progress.length - 1]).toEqual({ stage: 'error', message: RESTART_DID_NOT_ARRIVE })
    const launcher = harness({ installMethod: 'marketplace', authority: { kind: 'launcher', markerPath: '/m' } })
    await launcher.handler.handle(FRAME)
    expect(launcher.timers.map((t) => t.ms)).toEqual([RESTART_WATCHDOG_MS])
  })

  test('no watchdog without a restart: a degraded marker, a refusal, and a failed pull arm nothing', async () => {
    const staged = harness({ authority: { kind: 'launcher', markerPath: '/m' }, markerWriteOk: false })
    await staged.handler.handle(FRAME)
    expect(staged.timers).toEqual([])
    const refused = harness({ authority: { kind: 'staged' } })
    await refused.handler.handle(FRAME)
    expect(refused.timers).toEqual([])
    const failed = harness({ updater: () => fakeUpdater({ outcome: { kind: 'dirty-tree' } }) })
    await failed.handler.handle(FRAME)
    expect(failed.timers).toEqual([])
  })

  test('a second restart re-arms: the earlier watchdog is cancelled, only the latest can fire', async () => {
    const h = harness({ updater: () => fakeUpdater({ pending: '0.39.1' }) })
    await h.handler.handle(FRAME)
    await h.handler.handle({ ...FRAME, rpcId: 'rpc-2' })
    expect(h.timers.map((t) => t.cancelled)).toEqual([true, false])
    await h.fireWatchdog()
    // One recovery, for the live rpc only.
    expect(h.drainModes).toEqual([false])
    expect(h.progress.filter((p) => p.stage === 'error')).toEqual([
      { stage: 'error', message: RESTART_DID_NOT_ARRIVE },
    ])
  })

  test('the token is a machine word the failure classifier passes through unchanged', () => {
    expect(RESTART_DID_NOT_ARRIVE).toBe('restart_did_not_arrive')
    expect(failureToken(RESTART_DID_NOT_ARRIVE)).toBe('restart_did_not_arrive')
    expect(failureToken('restart did not arrive within 180s')).toBe('restart_did_not_arrive')
  })
})

describe('UpdateRpcHandler marketplace path', () => {
  test('happy path: draining, one installing per install step kind (with the target), then the ladder', async () => {
    const market = fakeMarketplace()
    const updater = fakeUpdater()
    const h = harness({ installMethod: 'marketplace', marketplaceUpdate: market.fn, updater: () => updater })
    await h.handler.handle(FRAME)
    expect(h.acks).toEqual(['rpc-1'])
    expect(market.calls).toBe(1)
    expect(updater.updateNowCalls).toBe(0)
    expect(h.progress).toEqual([
      { stage: 'draining' },
      { stage: 'installing', message: 'refresh_marketplace', targetVersion: '0.39.0' },
      { stage: 'installing', message: 'update_plugin', targetVersion: '0.39.0' },
      { stage: 'installing', message: 'verify_installed', targetVersion: '0.39.0' },
      { stage: 'staged', targetVersion: '0.39.0' },
    ])
    // Drained for the run, un-drained for 'staged', heartbeat requested.
    expect(h.drainModes).toEqual([true, false])
    expect(h.heartbeats()).toBe(1)
    expect(h.diagnostics).toEqual([])
  })

  test('the exact set of step kinds that surface as installing', () => {
    expect([...INSTALLING_STEP_KINDS].sort()).toEqual(
      [
        'install_plugin',
        'refresh_marketplace',
        'register_marketplace',
        'reinstall_plugin',
        'rollback',
        'update_plugin',
        'verify_installed',
      ].sort(),
    )
  })

  test('only running states emit; ok/failed transitions and unknown kinds stay silent', async () => {
    const market = fakeMarketplace({
      steps: [
        { id: 's2', kind: 'register_marketplace', state: 'running' },
        { id: 's2', kind: 'register_marketplace', state: 'ok' },
        { id: 's3', kind: 'install_plugin', state: 'running', targetVersion: null },
        { id: 's3', kind: 'install_plugin', state: 'failed', message: 'exit 1' },
        { id: 's4', kind: 'reinstall_plugin', state: 'running' },
        { id: 's9', kind: 'refresh_watcher', state: 'running' },
        { id: 's5', kind: 'rollback', state: 'running' },
      ],
    })
    const h = harness({ installMethod: 'marketplace', marketplaceUpdate: market.fn })
    await h.handler.handle(FRAME)
    expect(h.progress.slice(1, -1)).toEqual([
      { stage: 'installing', message: 'register_marketplace', targetVersion: '0.39.0' },
      { stage: 'installing', message: 'install_plugin' },
      { stage: 'installing', message: 'reinstall_plugin', targetVersion: '0.39.0' },
      { stage: 'installing', message: 'rollback', targetVersion: '0.39.0' },
    ])
  })

  test('service authority after a marketplace install: restarting, detached restart, drain stays on', async () => {
    const command = { file: '/bin/sh', args: ['-c', 'sleep 2 && launchctl kickstart -k gui/501/ai.bgos.agent.871'] }
    const h = harness({
      installMethod: 'marketplace',
      authority: { kind: 'service', service: { kind: 'launchd', handle: 'ai.bgos.agent.871' }, command },
    })
    await h.handler.handle(FRAME)
    expect(h.progress[h.progress.length - 1]).toEqual({ stage: 'restarting', targetVersion: '0.39.0' })
    expect(h.spawned).toEqual([command])
    expect(h.drainModes).toEqual([true])
    expect(h.heartbeats()).toBe(0)
  })

  test('launcher authority after a marketplace install: restarting and the marker, drain stays on', async () => {
    const h = harness({
      installMethod: 'marketplace',
      authority: { kind: 'launcher', markerPath: '/state/871/restart-requested.json' },
    })
    await h.handler.handle(FRAME)
    expect(h.progress[h.progress.length - 1]).toEqual({ stage: 'restarting', targetVersion: '0.39.0' })
    expect(h.markers).toEqual(['/state/871/restart-requested.json'])
    expect(h.drainModes).toEqual([true])
  })

  test('installed with no known version stages without a targetVersion field', async () => {
    const market = fakeMarketplace({ steps: [], outcome: { kind: 'installed', targetVersion: null } })
    const h = harness({ installMethod: 'marketplace', marketplaceUpdate: market.fn })
    await h.handler.handle(FRAME)
    expect(h.progress).toEqual([{ stage: 'draining' }, { stage: 'staged' }])
  })

  test('kill switch off reports updates_disabled before any drain', async () => {
    const market = fakeMarketplace()
    const h = harness({ installMethod: 'marketplace', autoUpdateEnabled: false, marketplaceUpdate: market.fn })
    await h.handler.handle(FRAME)
    expect(h.progress).toEqual([{ stage: 'error', message: 'updates_disabled' }])
    expect(market.calls).toBe(0)
    expect(h.drainModes).toEqual([])
  })

  test('no update available: error no_update_available and intake restored', async () => {
    const market = fakeMarketplace({ steps: [], outcome: { kind: 'no-update', latestVersion: '0.38.3' } })
    const h = harness({ installMethod: 'marketplace', marketplaceUpdate: market.fn })
    await h.handler.handle(FRAME)
    expect(h.progress).toEqual([{ stage: 'draining' }, { stage: 'error', message: 'no_update_available' }])
    expect(h.drainModes).toEqual([true, false])
    expect(h.heartbeats()).toBe(0)
  })

  test('blocked: the planner reason is the error token', async () => {
    for (const reason of ['rollback_latched', 'updates_disabled', 'major_version_blocked']) {
      const market = fakeMarketplace({ steps: [], outcome: { kind: 'blocked', reason } })
      const h = harness({ installMethod: 'marketplace', marketplaceUpdate: market.fn })
      await h.handler.handle({ ...FRAME, rpcId: `rpc-${reason}` })
      expect(h.progress).toEqual([{ stage: 'draining' }, { stage: 'error', message: reason }])
      expect(h.drainModes).toEqual([true, false])
    }
  })

  test('failed: error <failedStep.kind>:<token>, diagnostics posted, intake restored', async () => {
    const bundle = { signature: { cause: 'update_plugin:exit_1' }, steps: [], context: {} }
    const market = fakeMarketplace({
      steps: [
        { id: 's3', kind: 'update_plugin' },
        { id: 's4', kind: 'reinstall_plugin' },
        { id: 's5', kind: 'rollback' },
      ],
      outcome: {
        kind: 'failed',
        failedStep: { id: 's4', kind: 'reinstall_plugin', message: 'claude exited with code 1: install refused' },
        rolledBack: true,
        diagnostics: bundle,
      },
    })
    const h = harness({ installMethod: 'marketplace', marketplaceUpdate: market.fn })
    await h.handler.handle(FRAME)
    expect(h.progress).toEqual([
      { stage: 'draining' },
      { stage: 'installing', message: 'update_plugin', targetVersion: '0.39.0' },
      { stage: 'installing', message: 'reinstall_plugin', targetVersion: '0.39.0' },
      { stage: 'installing', message: 'rollback', targetVersion: '0.39.0' },
      { stage: 'error', message: 'reinstall_plugin:exit_1' },
    ])
    expect(h.drainModes).toEqual([true, false])
    expect(h.diagnostics).toEqual([bundle])
    expect(h.spawned).toEqual([])
    expect(h.markers).toEqual([])
    expect(h.logs.some((l) => l.includes('rolled back'))).toBe(true)
  })

  test('failed with no diagnostics bundle posts nothing and still names the cause', async () => {
    const market = fakeMarketplace({
      steps: [],
      outcome: {
        kind: 'failed',
        failedStep: { id: 's4', kind: 'verify_installed', message: 'version_mismatch: expected 0.39.0, installed 0.38.3' },
        rolledBack: false,
        diagnostics: null,
      },
    })
    const h = harness({ installMethod: 'marketplace', marketplaceUpdate: market.fn })
    await h.handler.handle(FRAME)
    expect(h.progress[h.progress.length - 1]).toEqual({ stage: 'error', message: 'verify_installed:version_mismatch' })
    expect(h.diagnostics).toEqual([])
  })

  test('a failing diagnostics intake is logged and never changes the outcome', async () => {
    const market = fakeMarketplace({
      steps: [],
      outcome: {
        kind: 'failed',
        failedStep: { id: 's3', kind: 'update_plugin', message: 'timed out' },
        rolledBack: false,
        diagnostics: { signature: { cause: 'update_plugin:timeout' } },
      },
    })
    const h = harness({ installMethod: 'marketplace', marketplaceUpdate: market.fn, diagnosticsError: true })
    await h.handler.handle(FRAME)
    await Bun.sleep(0)
    expect(h.progress[h.progress.length - 1]).toEqual({ stage: 'error', message: 'update_plugin:timeout' })
    expect(h.logs.some((l) => l.includes('diagnostics post failed'))).toBe(true)
  })

  test('a throwing marketplace runner yields a terminal error and restores intake', async () => {
    const market = fakeMarketplace({ throws: new Error('planner exploded') })
    const h = harness({ installMethod: 'marketplace', marketplaceUpdate: market.fn })
    await h.handler.handle(FRAME)
    expect(h.progress).toEqual([{ stage: 'draining' }, { stage: 'error', message: 'planner exploded' }])
    expect(h.drainModes).toEqual([true, false])
  })

  test('progress messages are clipped to the backend cap', async () => {
    const longKind = 'k'.repeat(400)
    const market = fakeMarketplace({
      steps: [],
      outcome: {
        kind: 'failed',
        failedStep: { id: 's3', kind: longKind, message: 'x' },
        rolledBack: false,
        diagnostics: null,
      },
    })
    const h = harness({ installMethod: 'marketplace', marketplaceUpdate: market.fn })
    await h.handler.handle(FRAME)
    const last = h.progress[h.progress.length - 1]!
    expect(last.stage).toBe('error')
    expect((last.message as string).length).toBe(PROGRESS_MESSAGE_MAX_CHARS)
    expect(clipProgressMessage('short')).toBe('short')
    expect(clipProgressMessage('y'.repeat(301)).length).toBe(300)
  })

  test('bounded drain: intake that never settles proceeds after the deadline with drain_timeout_proceeding', async () => {
    let clock = 1_000_000
    const market = fakeMarketplace({ steps: [{ id: 's3', kind: 'update_plugin' }] })
    const h = harness({
      installMethod: 'marketplace',
      marketplaceUpdate: market.fn,
      drainSnapshot: () => BUSY,
      // Every poll (sleep is a no-op in the harness) advances ten seconds.
      now: () => (clock += 10_000),
    })
    await h.handler.handle(FRAME)
    expect(market.calls).toBe(1)
    expect(h.progress).toEqual([
      { stage: 'draining' },
      { stage: 'installing', message: DRAIN_TIMEOUT_PROCEEDING },
      { stage: 'installing', message: 'update_plugin', targetVersion: '0.39.0' },
      { stage: 'staged', targetVersion: '0.39.0' },
    ])
    expect(DRAIN_TIMEOUT_PROCEEDING).toBe('drain_timeout_proceeding')
    expect(h.logs.some((l) => l.includes('did not drain'))).toBe(true)
  })

  test('bounded drain: intake that settles before the deadline never mentions a timeout', async () => {
    let polls = 0
    const h = harness({
      installMethod: 'marketplace',
      drainSnapshot: () => (polls++ < 3 ? BUSY : IDLE),
    })
    await h.handler.handle(FRAME)
    expect(h.progress.some((p) => p.message === DRAIN_TIMEOUT_PROCEEDING)).toBe(false)
    expect(h.progress[0]).toEqual({ stage: 'draining' })
    expect(polls).toBeGreaterThan(3)
  })

  test('a duplicate frame re-acks and never re-runs the marketplace update', async () => {
    const market = fakeMarketplace()
    const h = harness({ installMethod: 'marketplace', marketplaceUpdate: market.fn })
    await h.handler.handle(FRAME)
    await h.handler.handle(FRAME)
    expect(market.calls).toBe(1)
    expect(h.acks).toEqual(['rpc-1', 'rpc-1'])
  })
})

describe('the never-mute invariant', () => {
  // After EVERY terminal outcome except a real restart, the LAST drain call
  // is setDrainMode(false). A daemon left drained is the outage wearing a
  // healthier-looking process list.
  const terminalMarketplaceOutcomes: Array<[string, MarketplaceUpdateOutcome | Error]> = [
    ['no-update', { kind: 'no-update', latestVersion: '0.38.3' }],
    ['blocked', { kind: 'blocked', reason: 'rollback_latched' }],
    [
      'failed',
      {
        kind: 'failed',
        failedStep: { id: 's3', kind: 'update_plugin', message: 'exit 1' },
        rolledBack: false,
        diagnostics: null,
      },
    ],
    ['throws', new Error('boom')],
    ['installed+staged', { kind: 'installed', targetVersion: '0.39.0' }],
  ]

  test('marketplace: every terminal outcome that does not restart ends un-drained', async () => {
    for (const [name, outcome] of terminalMarketplaceOutcomes) {
      const market =
        outcome instanceof Error
          ? fakeMarketplace({ throws: outcome })
          : fakeMarketplace({ steps: [], outcome })
      const h = harness({ installMethod: 'marketplace', marketplaceUpdate: market.fn })
      await h.handler.handle({ ...FRAME, rpcId: `rpc-${name}` })
      expect(h.drainModes.length).toBeGreaterThan(0)
      expect(h.drainModes[h.drainModes.length - 1]).toBe(false)
    }
  })

  test('marketplace: a launcher marker that cannot be written degrades to staged, un-drained', async () => {
    const h = harness({
      installMethod: 'marketplace',
      authority: { kind: 'launcher', markerPath: '/state/871/restart-requested.json' },
      markerWriteOk: false,
    })
    await h.handler.handle(FRAME)
    expect(h.progress.map((p) => p.stage)).toEqual(['draining', 'installing', 'installing', 'installing', 'restarting', 'staged'])
    expect(h.drainModes).toEqual([true, false])
  })

  test('marketplace: a real restart is the one outcome that keeps the drain on', async () => {
    const service = harness({
      installMethod: 'marketplace',
      authority: { kind: 'service', service: SYSTEMD_UNIT, command: { file: 'systemd-run', args: ['x'] } },
    })
    await service.handler.handle(FRAME)
    expect(service.drainModes).toEqual([true])
    const launcher = harness({
      installMethod: 'marketplace',
      authority: { kind: 'launcher', markerPath: '/m' },
    })
    await launcher.handler.handle(FRAME)
    expect(launcher.drainModes).toEqual([true])
  })

  test('the watchdog: a restart that never arrives ends un-drained too', async () => {
    const h = harness({
      authority: { kind: 'service', service: LAUNCHD_JOB, command: { file: 'launchctl', args: ['x'] } },
    })
    await h.handler.handle(FRAME)
    expect(h.drainModes).toEqual([])
    await h.fireWatchdog()
    expect(h.drainModes.length).toBeGreaterThan(0)
    expect(h.drainModes[h.drainModes.length - 1]).toBe(false)
  })

  test('clone: no-authority aborts un-drained, thrown ends un-drained, the ladder restart keeps it on', async () => {
    // No authority never drains at all now (it aborts before the drain), which
    // is the strongest form of never-muted: the daemon was never touched.
    const noAuthority = harness({ authority: { kind: 'staged' } })
    await noAuthority.handler.handle(FRAME)
    expect(noAuthority.progress).toEqual([{ stage: 'error', message: 'no_restart_authority' }])
    expect(noAuthority.drainModes).toEqual([])
    const thrown = harness({
      updater: () => ({
        isRollbackLatched: () => false,
        pendingRestartVersion: () => null,
        updateNow: async () => {
          throw new Error('unexpected explosion')
        },
      }),
    })
    await thrown.handler.handle(FRAME)
    expect(thrown.drainModes).toEqual([false])
    const restarted = harness({ authority: { kind: 'launcher', markerPath: '/m' } })
    await restarted.handler.handle(FRAME)
    expect(restarted.drainModes).toEqual([])
  })
})

describe('UpdateRpcHandler dedupe and failure posture', () => {
  test('a duplicate frame re-acks and never re-runs the update', async () => {
    const updater = fakeUpdater()
    const h = harness({ updater: () => updater })
    await h.handler.handle(FRAME)
    await h.handler.handle(FRAME)
    expect(updater.updateNowCalls).toBe(1)
    expect(h.acks).toEqual(['rpc-1', 'rpc-1'])
    expect(h.logs.some((l) => l.includes('duplicate frame re-acked'))).toBe(true)
  })

  test('a failed ack is non-fatal and the update still runs', async () => {
    const updater = fakeUpdater()
    const h = harness({ updater: () => updater, ackError: true })
    await h.handler.handle(FRAME)
    expect(updater.updateNowCalls).toBe(1)
    expect(h.progress.map((p) => p.stage)).toContain('restarting')
    expect(h.logs.some((l) => l.includes('ack failed'))).toBe(true)
  })

  test('progress POST failures are logged, never thrown, and never stop the flow', async () => {
    const h = harness({ progressError: true })
    await h.handler.handle(FRAME)
    expect(h.progress).toEqual([])
    // The flow still reaches the restart: the marker is written even though
    // every progress POST threw.
    expect(h.markers).toEqual(['/state/871/restart-requested.json'])
    expect(h.logs.filter((l) => l.includes('progress')).length).toBeGreaterThan(0)
  })

  test('progress POST failures on the marketplace path never stop the flow either', async () => {
    const market = fakeMarketplace()
    const h = harness({ installMethod: 'marketplace', marketplaceUpdate: market.fn, progressError: true })
    await h.handler.handle(FRAME)
    expect(h.progress).toEqual([])
    expect(market.calls).toBe(1)
    expect(h.drainModes).toEqual([true, false])
    expect(h.heartbeats()).toBe(1)
  })

  test('an updater that throws yields a terminal error and restores intake', async () => {
    const h = harness({
      updater: () => ({
        isRollbackLatched: () => false,
        pendingRestartVersion: () => null,
        updateNow: async () => {
          throw new Error('unexpected explosion')
        },
      }),
    })
    await h.handler.handle(FRAME)
    // Tokenized, never the raw text: an fs error would carry the home path.
    expect(h.progress).toEqual([{ stage: 'error', message: 'update_failed:failed' }])
    expect(h.drainModes).toEqual([false])
  })
})

// ---------------------------------------------------------------------------
// The keepalive authority (2026-09-13). The nine sessions on KC's Mac are
// launched by a keepalive script into a DETACHED tmux, so no launchd job holds
// them and every one-click landed on 'restart pending'. The restart that does
// work is the one five of them were recovered by hand with: SIGTERM the claude
// session, and the keepalive relaunches it on the new version.
// ---------------------------------------------------------------------------

/** The marker's readings for session 910, measured live on 2026-09-13. */
const KEEPALIVE: RestartAuthority = {
  kind: 'keepalive',
  sessionPid: 35759,
  keepalivePid: 33108,
  tmuxSession: 'agent-910',
}

describe('the keepalive authority: signal the session, never kickstart the script', () => {
  test('draining, installing, restarting, then SIGTERM to the session the marker names', async () => {
    const h = harness({ authority: KEEPALIVE })
    await h.handler.handle(FRAME)
    expect(h.progress).toEqual([
      { stage: 'draining', targetVersion: '0.39.0' },
      { stage: 'installing', targetVersion: '0.39.0' },
      { stage: 'restarting', targetVersion: '0.39.0' },
    ])
    expect(h.signals).toEqual([{ pid: 35759, signal: 'SIGTERM' }])
    // NEVER a kickstart: killing the keepalive script is the 2026-09-11 mute.
    expect(h.spawned).toEqual([])
    expect(h.markers).toEqual([])
    // Drain stays on until the restart lands; the watchdog lifts it if not.
    expect(h.drainModes).toEqual([])
    expect(h.heartbeats()).toBe(0)
    expect(h.timers.length).toBe(1)
    expect(h.timers[0]!.ms).toBe(RESTART_WATCHDOG_MS)
  })

  test('a clone pre-flight accepts a keepalive authority and runs the update', async () => {
    const updater = fakeUpdater()
    const h = harness({ authority: KEEPALIVE, updater: () => updater })
    await h.handler.handle(FRAME)
    expect(updater.updateNowCalls).toBe(1)
    expect(h.progress.some((p) => p.stage === 'error')).toBe(false)
    // It restarts rather than staging: 'staged' here would be the limbo the
    // pre-flight exists to prevent.
    expect(h.progress.at(-1)?.stage).toBe('restarting')
  })

  test('a SIGTERM that does not land degrades to staged, never to a muted daemon', async () => {
    const h = harness({ authority: KEEPALIVE, signalOk: false })
    await h.handler.handle(FRAME)
    expect(h.progress.map((p) => p.stage)).toEqual([
      'draining',
      'installing',
      'restarting',
      'staged',
    ])
    expect(h.drainModes).toEqual([false])
    expect(h.heartbeats()).toBe(1)
    expect(h.spawned).toEqual([])
  })

  test('the watchdog un-drains a keepalive restart that never arrived', async () => {
    const h = harness({ authority: KEEPALIVE })
    await h.handler.handle(FRAME)
    expect(h.drainModes).toEqual([])
    await h.fireWatchdog()
    expect(h.drainModes).toEqual([false])
    expect(h.progress.at(-1)).toEqual({ stage: 'error', message: RESTART_DID_NOT_ARRIVE })
    expect(h.heartbeats()).toBe(1)
  })

  test('marketplace: a keepalive restart keeps the drain on, like every real restart', async () => {
    // The marketplace path drains explicitly (the clone path drains inside the
    // updater), so it is the arm where an un-drain bug would show as a daemon
    // that keeps taking work while its session is being replaced.
    const h = harness({ installMethod: 'marketplace', authority: KEEPALIVE })
    await h.handler.handle(FRAME)
    expect(h.progress.at(-1)?.stage).toBe('restarting')
    expect(h.signals).toEqual([{ pid: 35759, signal: 'SIGTERM' }])
    expect(h.drainModes).toEqual([true])
  })

  test('the session pid is never the ownership probe: a keepalive asks no launchctl', async () => {
    const h = harness({ authority: KEEPALIVE })
    await h.handler.handle(FRAME)
    expect(h.ownershipCalls).toEqual([])
  })
})
