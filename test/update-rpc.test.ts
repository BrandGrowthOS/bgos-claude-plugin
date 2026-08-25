import { describe, expect, test } from 'bun:test'

import type { UpdateNowOutcome } from '../lib/self-update'
import {
  DRAIN_TIMEOUT_PROCEEDING,
  INSTALLING_STEP_KINDS,
  PROGRESS_MESSAGE_MAX_CHARS,
  UpdateRpcHandler,
  clipProgressMessage,
  normalizeUpdateRpc,
  type MarketplaceStepReport,
  type MarketplaceUpdateOutcome,
  type UpdateRpcDeps,
} from '../lib/update-rpc'
import type { RestartAuthority } from '../lib/update-readiness'

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
  diagnosticsError?: boolean
  now?: () => number
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
  const drainModes: boolean[] = []
  const diagnostics: Array<Record<string, unknown>> = []
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
    restartAuthority: () => overrides.authority ?? { kind: 'staged' },
    spawnDetached: (file, args) => spawned.push({ file, args }),
    writeMarker: (path) => {
      if (overrides.markerWriteOk === false) return false
      markers.push(path)
      return true
    },
    setDrainMode: (enabled) => drainModes.push(enabled),
    requestHeartbeat: () => {
      heartbeats += 1
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
    drainModes,
    diagnostics,
    heartbeats: () => heartbeats,
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
    const h = harness({ marketplaceUpdate: market.fn })
    await h.handler.handle(FRAME)
    expect(market.calls).toBe(0)
    expect(h.progress.map((p) => p.stage)).toEqual(['draining', 'installing', 'staged'])
  })
})

describe('UpdateRpcHandler restart ladder', () => {
  test('service authority: draining, installing, restarting, then the detached restart', async () => {
    const command = {
      file: 'systemd-run',
      args: ['--user', '--on-active=2', 'systemctl', '--user', 'restart', 'bgos-agent-871'],
    }
    const h = harness({ authority: { kind: 'service', command } })
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

  test('no authority: staged, un-drained, and an immediate heartbeat', async () => {
    const h = harness()
    await h.handler.handle(FRAME)
    expect(h.progress).toEqual([
      { stage: 'draining', targetVersion: '0.39.0' },
      { stage: 'installing', targetVersion: '0.39.0' },
      { stage: 'staged', targetVersion: '0.39.0' },
    ])
    expect(h.drainModes).toEqual([false])
    expect(h.heartbeats()).toBe(1)
  })

  test('a pending installed version skips the pull and goes straight to the ladder', async () => {
    const updater = fakeUpdater({ pending: '0.39.0' })
    const h = harness({ updater: () => updater })
    await h.handler.handle(FRAME)
    expect(updater.updateNowCalls).toBe(0)
    expect(h.progress).toEqual([{ stage: 'staged', targetVersion: '0.39.0' }])
    expect(h.heartbeats()).toBe(1)
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
    const h = harness({ installMethod: 'marketplace', authority: { kind: 'service', command } })
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
      authority: { kind: 'service', command: { file: 'systemd-run', args: ['x'] } },
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

  test('clone: staged and thrown outcomes end un-drained; the ladder restart keeps it on', async () => {
    const staged = harness()
    await staged.handler.handle(FRAME)
    expect(staged.drainModes[staged.drainModes.length - 1]).toBe(false)
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
    expect(h.progress.map((p) => p.stage)).toContain('staged')
    expect(h.logs.some((l) => l.includes('ack failed'))).toBe(true)
  })

  test('progress POST failures are logged, never thrown, and never stop the flow', async () => {
    const h = harness({ progressError: true })
    await h.handler.handle(FRAME)
    expect(h.progress).toEqual([])
    // The staged path still restores intake and requests the heartbeat.
    expect(h.drainModes).toEqual([false])
    expect(h.heartbeats()).toBe(1)
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
    expect(h.progress).toEqual([{ stage: 'error', message: 'unexpected explosion' }])
    expect(h.drainModes).toEqual([false])
  })
})
