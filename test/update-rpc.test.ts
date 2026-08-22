import { describe, expect, test } from 'bun:test'

import type { UpdateNowOutcome } from '../lib/self-update'
import {
  UpdateRpcHandler,
  normalizeUpdateRpc,
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

interface HarnessOverrides {
  installMethod?: 'marketplace' | 'clone'
  autoUpdateEnabled?: boolean
  updater?: UpdateRpcDeps['updater']
  authority?: RestartAuthority
  ackError?: boolean
  progressError?: boolean
  markerWriteOk?: boolean
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

function harness(overrides: HarnessOverrides = {}) {
  const acks: string[] = []
  const progress: Array<Record<string, unknown>> = []
  const logs: string[] = []
  const spawned: Array<{ file: string; args: string[] }> = []
  const markers: string[] = []
  const drainModes: boolean[] = []
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
  })
  return {
    handler,
    acks,
    progress,
    logs,
    spawned,
    markers,
    drainModes,
    heartbeats: () => heartbeats,
  }
}

const FRAME = { rpcId: 'rpc-1', op: 'update_now' as const }

describe('UpdateRpcHandler decision table', () => {
  test('marketplace installs get the manual-update error, after the ack', async () => {
    const h = harness({ installMethod: 'marketplace' })
    await h.handler.handle(FRAME)
    expect(h.acks).toEqual(['rpc-1'])
    expect(h.progress).toEqual([
      { stage: 'error', message: 'marketplace_install_manual_update' },
    ])
  })

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
