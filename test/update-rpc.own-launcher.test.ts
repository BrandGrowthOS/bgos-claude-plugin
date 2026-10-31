/**
 * The restart ladder's two idle update entry points (lib/update-rpc.ts
 * restartForStagedUpdate, restartForRollback) and the own launcher rung only
 * they may use (docs/idle-update/DESIGN.md, "The own launcher rung").
 *
 * A gen-2 bgos-agent job (launchd or systemd) starts hoai inside a detached
 * tmux server, so the job never owns the daemon and the ladder stages: Alex's
 * 15 agents. For the idle update only, a hoai launcher PROVEN to supervise
 * this very session gets the restart marker instead. No job is kickstarted,
 * ever (the 2026-09-11 mute). A click, the scheduled update and the hook
 * restart keep the ladder exactly as on main: they lack the idle gates.
 *
 * Run: npx tsx --test test/update-rpc.own-launcher.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { RESTART_WATCHDOG_MS, UpdateRpcHandler } from '../lib/update-rpc'
import type { RestartAuthority, ServiceOwnershipReading } from '../lib/update-readiness'

const MARKER = '/Users/a/.bgos-agent/912/restart-requested.json'
const LAUNCHD_GEN2: RestartAuthority = {
  kind: 'service',
  service: { kind: 'launchd', handle: 'ai.bgos.agent.912' },
  command: { file: '/bin/launchctl', args: ['kickstart', '-k', 'gui/501/ai.bgos.agent.912'] },
}
/** Gen-2 on a Mac: the daemon runs under hoai under a tmux server reparented
 *  to launchd (pid 1); the job's main pid is run.sh (500), nowhere in the chain. */
const NOT_OWNED: ServiceOwnershipReading = { ownPid: 650, ancestorPids: [650, 640, 630, 620, 610, 600, 1], servicePid: 500 }
const OWNED: ServiceOwnershipReading = { ownPid: 650, ancestorPids: [650, 640, 620, 500, 1], servicePid: 500 }
const PROOF = { markerPath: MARKER, launcherPid: 620 }

function harness(opts: { authority?: RestartAuthority; ownership?: ServiceOwnershipReading; markerOk?: boolean; signalOk?: boolean } = {}) {
  const progress: Array<Record<string, unknown>> = []
  const logs: string[] = []
  const spawned: Array<{ file: string; args: string[] }> = []
  const markers: string[] = []
  const signals: number[] = []
  const drains: boolean[] = []
  const timers: Array<{ ms: number; fn: () => void; cancelled: boolean }> = []
  let heartbeats = 0
  const handler = new UpdateRpcHandler({
    postAck: async () => ({}),
    postProgress: async (_rpcId, body) => {
      progress.push(body)
      return {}
    },
    log: (line) => logs.push(line),
    installMethod: () => 'marketplace',
    autoUpdateEnabled: () => true,
    updater: () => null,
    pendingRestartVersion: () => '0.81.0',
    marketplaceUpdate: async () => ({ kind: 'installed', targetVersion: '0.81.0' }) as any,
    drainSnapshot: () => ({ activeOperations: 0, pendingInbounds: 0, pendingPermissions: 0 }) as any,
    restartAuthority: () => opts.authority ?? LAUNCHD_GEN2,
    spawnDetached: (file, args) => spawned.push({ file, args }),
    writeMarker: (path) => {
      if (opts.markerOk === false) return false
      markers.push(path)
      return true
    },
    signalProcess: (pid) => {
      if (opts.signalOk === false) return false
      signals.push(pid)
      return true
    },
    setDrainMode: (on) => drains.push(on),
    requestHeartbeat: () => {
      heartbeats += 1
    },
    serviceOwnership: () => opts.ownership ?? NOT_OWNED,
    setTimer: (fn, ms) => {
      const timer = { ms, fn, cancelled: false }
      timers.push(timer)
      return () => {
        timer.cancelled = true
      }
    },
    sleep: async () => {},
  })
  const h: any = handler
  return { handler: h, progress, logs, spawned, markers, signals, drains, timers, heartbeats: () => heartbeats }
}

function needEntry(h: any, name: string): (...args: any[]) => Promise<boolean> {
  if (typeof h[name] !== 'function') {
    assert.fail(
      `UpdateRpcHandler.${name} is missing: a gen-2 agent (run.sh starts hoai in a detached tmux server, so the job never owns ` +
        'the daemon) can only stage, and nothing ever restarts it onto the staged build',
    )
  }
  return h[name].bind(h)
}

test('a gen-2 job that does not own the daemon: the idle update writes the marker for the proven own launcher', async () => {
  const t = harness()
  const restarted = await needEntry(t.handler, 'restartForStagedUpdate')('0.81.0', PROOF)
  assert.equal(restarted, true)
  assert.deepEqual(t.markers, [MARKER])
  assert.deepEqual(t.spawned, [], 'never a kickstart: the job does not hold this process (2026-09-11)')
  assert.equal(t.timers.length, 1)
  assert.equal(t.timers[0].ms, RESTART_WATCHDOG_MS)
  assert.equal(t.drains.includes(false), false, 'the drain stays on until the restart or the watchdog')
  assert.ok(t.logs.some((l) => /own hoai launcher \(pid 620\)/.test(l)), t.logs.join('\n'))
})

test('the rollback restart uses the same rung', async () => {
  const t = harness()
  assert.equal(await needEntry(t.handler, 'restartForRollback')('0.80.0', PROOF), true)
  assert.deepEqual(t.markers, [MARKER])
  assert.deepEqual(t.spawned, [])
})

test('no proof of an own launcher: the idle update stages exactly as today, drain lifted', async () => {
  const t = harness()
  assert.equal(await needEntry(t.handler, 'restartForStagedUpdate')('0.81.0', null), false)
  assert.deepEqual(t.markers, [])
  assert.deepEqual(t.spawned, [])
  assert.deepEqual(t.drains, [false])
  assert.equal(t.heartbeats(), 1)
})

test('a marker that cannot be written stages, drain lifted', async () => {
  const t = harness({ markerOk: false })
  assert.equal(await needEntry(t.handler, 'restartForStagedUpdate')('0.81.0', PROOF), false)
  assert.deepEqual(t.drains, [false])
  assert.equal(t.timers.length, 0)
})

test('a job that owns the daemon is restarted through the job, never the marker', async () => {
  const t = harness({ ownership: OWNED })
  assert.equal(await needEntry(t.handler, 'restartForStagedUpdate')('0.81.0', PROOF), true)
  assert.equal(t.spawned.length, 1)
  assert.deepEqual(t.markers, [])
})

test('a keepalive authority is signalled, a launcher authority gets its own marker, staged stays staged', async () => {
  const k = harness({ authority: { kind: 'keepalive', sessionPid: 4242, keepalivePid: 4000, tmuxSession: null } })
  assert.equal(await needEntry(k.handler, 'restartForStagedUpdate')('0.81.0', PROOF), true)
  assert.deepEqual(k.signals, [4242])
  assert.deepEqual(k.markers, [])
  const l = harness({ authority: { kind: 'launcher', markerPath: 'C:\\Users\\kc\\.bgos-agent\\912\\restart-requested.json' } })
  assert.equal(await needEntry(l.handler, 'restartForStagedUpdate')('0.81.0', null), true)
  assert.deepEqual(l.markers, ['C:\\Users\\kc\\.bgos-agent\\912\\restart-requested.json'])
  const s = harness({ authority: { kind: 'staged' } })
  assert.equal(await needEntry(s.handler, 'restartForStagedUpdate')('0.81.0', PROOF), false)
  assert.deepEqual(s.markers, [])
})

test('the idle update and its rollback report to the log, never to the backend (nobody asked)', async () => {
  const t = harness()
  await needEntry(t.handler, 'restartForStagedUpdate')('0.81.0', PROOF)
  await needEntry(t.handler, 'restartForRollback')('0.80.0', null)
  assert.deepEqual(t.progress, [])
  assert.ok(t.logs.some((l) => /^idle update restart: restarting/.test(l)), t.logs.join('\n'))
  assert.ok(t.logs.some((l) => /^idle update rollback restart: staged/.test(l)), t.logs.join('\n'))
})

test('a backend rpc id that is also an object key (constructor, toString) is the backend\'s: its progress is posted, never taken for a log-only label', async () => {
  for (const rpcId of ['constructor', 'toString', 'hasOwnProperty']) {
    const t = harness()
    await t.handler.handle({ rpcId, op: 'update_now' })
    assert.ok(t.progress.length > 0, `${rpcId}: ${t.logs.join('\n')}`)
  }
})

test('a restart that never arrives un-drains, and says the idle update backs off', async () => {
  const t = harness()
  await needEntry(t.handler, 'restartForStagedUpdate')('0.81.0', PROOF)
  t.timers[0].fn()
  await new Promise((r) => setTimeout(r, 0))
  assert.deepEqual(t.drains, [false])
  assert.equal(t.heartbeats(), 1)
  assert.ok(t.logs.some((l) => /RESTART DID NOT ARRIVE/.test(l) && /idle update records it and backs off/.test(l)), t.logs.join('\n'))
  assert.deepEqual(t.progress, [])
})

test('the scheduled update and the hook restart keep today\'s ladder: a job that does not own the daemon stages', async () => {
  const s = harness()
  assert.equal(await s.handler.restartAfterScheduledUpdate('0.81.0'), false)
  assert.deepEqual(s.markers, [])
  assert.deepEqual(s.spawned, [])
  const h = harness()
  assert.equal(await h.handler.restartAfterHookRegistration(), false)
  assert.deepEqual(h.markers, [])
  assert.deepEqual(h.spawned, [])
})

test('a click keeps today\'s pre-flight: a job that does not own the daemon is no restart authority', async () => {
  const t = harness()
  await t.handler.handle({ rpcId: 'rpc-1', op: 'update_now' })
  assert.deepEqual(t.markers, [])
  assert.deepEqual(t.spawned, [])
})
