import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { declaredCapabilities } from '../lib/declared-capabilities'
import {
  heartbeatEnv,
  readOwnVersion,
  shouldSendVersionHeartbeat,
  startVersionHeartbeat,
  VERSION_HEARTBEAT_INTERVAL_MS,
} from '../lib/version-heartbeat'
import {
  SESSION_STATUS_BUSY_MS,
  SESSION_STATUS_CHANGE_MS,
  type SessionStatusReport,
} from '../lib/session-status-contract'
import { SESSION_STATUS_MIN_GAP_MS, SESSION_STATUS_TICK_MS } from '../lib/session-status'

function dirWithPackage(version: unknown): string {
  const d = mkdtempSync(join(tmpdir(), 'vhb-'))
  writeFileSync(join(d, 'package.json'), JSON.stringify({ version }))
  return d
}

describe('readOwnVersion', () => {
  test('reads a prerelease or build version, the shape the backend and the watcher accept (finding F1)', () => {
    expect(readOwnVersion(dirWithPackage('0.62.1-local'))).toBe('0.62.1-local')
    expect(readOwnVersion(dirWithPackage('1.2.3-rc.1'))).toBe('1.2.3-rc.1')
  })

  test('still refuses junk, a leading v, and an over-long value', () => {
    expect(readOwnVersion(dirWithPackage('v0.62.1'))).toBeNull()
    expect(readOwnVersion(dirWithPackage('0.62'))).toBeNull()
    expect(readOwnVersion(dirWithPackage('0.62.1-' + 'x'.repeat(40)))).toBeNull()
  })

  test('reads a valid semver', () => {
    expect(readOwnVersion(dirWithPackage('0.22.0'))).toBe('0.22.0')
  })
  test('rejects non-semver and missing values', () => {
    expect(readOwnVersion(dirWithPackage('not-a-version'))).toBeNull()
    expect(readOwnVersion(dirWithPackage(undefined))).toBeNull()
  })
  test('missing package.json returns null, never throws', () => {
    expect(readOwnVersion(join(tmpdir(), 'vhb-definitely-missing'))).toBeNull()
  })
})

describe('shouldSendVersionHeartbeat', () => {
  test('pairing mode with a version sends', () => {
    expect(shouldSendVersionHeartbeat('pairing', '0.22.0')).toBe(true)
  })
  test('apikey mode never sends (no pairing row to write)', () => {
    expect(shouldSendVersionHeartbeat('apikey', '0.22.0')).toBe(false)
  })
  test('missing version never sends', () => {
    expect(shouldSendVersionHeartbeat('pairing', null)).toBe(false)
  })
})

describe('startVersionHeartbeat', () => {
  test('pairing mode posts daemonVersion at boot and arms the 6h timer', async () => {
    const calls: Array<{ path: string; body: Record<string, unknown> }> = []
    const handle = startVersionHeartbeat({
      authMode: 'pairing',
      rootDir: dirWithPackage('0.22.0'),
      post: async (path, body) => {
        calls.push({ path, body })
        return {}
      },
      log: () => {},
    })
    expect(handle).not.toBeNull()
    await Bun.sleep(0)
    expect(calls.length).toBe(1)
    expect(calls[0]!.path).toBe('integrations/heartbeat')
    expect(calls[0]!.body.daemonVersion).toBe('0.22.0')
    // The body now also carries the daemon's own environment so the owner can
    // see WHERE the agent is running. Asserted by shape, not by deep equality,
    // so adding a future env field does not break this contract test.
    expect(calls[0]!.body.env).toBeDefined()
    // Without an updateStatus provider the one-click fields stay absent, so
    // an older wiring cannot accidentally send updateReadiness: undefined.
    expect('latestKnownVersion' in calls[0]!.body).toBe(false)
    expect('updateReadiness' in calls[0]!.body).toBe(false)
    expect(VERSION_HEARTBEAT_INTERVAL_MS).toBe(6 * 60 * 60 * 1000)
    clearInterval(handle!.timer)
  })

  test('updateStatus providers ride the body and sendNow posts immediately', async () => {
    const calls: Array<{ path: string; body: Record<string, unknown> }> = []
    const readiness = {
      supervised: 'launcher' as const,
      autoUpdateEnabled: true,
      rollbackLatched: false,
      pendingRestartVersion: '0.39.0',
    }
    const handle = startVersionHeartbeat({
      authMode: 'pairing',
      rootDir: dirWithPackage('0.38.0'),
      post: async (path, body) => {
        calls.push({ path, body })
        return {}
      },
      log: () => {},
      updateStatus: {
        latestKnownVersion: () => '0.39.0',
        updateReadiness: () => readiness,
      },
    })
    await Bun.sleep(0)
    expect(calls.length).toBe(1)
    expect(calls[0]!.body.latestKnownVersion).toBe('0.39.0')
    expect(calls[0]!.body.updateReadiness).toEqual(readiness)
    handle!.sendNow()
    await Bun.sleep(0)
    expect(calls.length).toBe(2)
    expect(calls[1]!.body.daemonVersion).toBe('0.38.0')
    clearInterval(handle!.timer)
  })

  test('a throwing updateStatus provider never blocks the heartbeat', async () => {
    const calls: Array<{ path: string; body: Record<string, unknown> }> = []
    const handle = startVersionHeartbeat({
      authMode: 'pairing',
      rootDir: dirWithPackage('0.38.0'),
      post: async (path, body) => {
        calls.push({ path, body })
        return {}
      },
      log: () => {},
      updateStatus: {
        latestKnownVersion: () => {
          throw new Error('git exploded')
        },
        updateReadiness: () => {
          throw new Error('fs exploded')
        },
      },
    })
    await Bun.sleep(0)
    expect(calls.length).toBe(1)
    expect(calls[0]!.body.daemonVersion).toBe('0.38.0')
    expect('latestKnownVersion' in calls[0]!.body).toBe(false)
    expect('updateReadiness' in calls[0]!.body).toBe(false)
    clearInterval(handle!.timer)
  })
  test('apikey mode is a no-op', () => {
    expect(
      startVersionHeartbeat({
        authMode: 'apikey',
        rootDir: dirWithPackage('0.22.0'),
        post: async () => ({}),
        log: () => {},
      }),
    ).toBeNull()
  })
  test('a rejecting post never throws', async () => {
    const handle = startVersionHeartbeat({
      authMode: 'pairing',
      rootDir: dirWithPackage('0.22.0'),
      post: async () => {
        throw new Error('backend down')
      },
      log: () => {},
    })
    await Bun.sleep(0)
    clearInterval(handle!.timer)
  })
})

describe('heartbeatEnv', () => {
  test('reports the working directory the daemon is actually in', () => {
    const env = heartbeatEnv({ cwd: () => '/Users/kc/agents/athena', platform: 'darwin' })
    expect(env.cwd).toBe('/Users/kc/agents/athena')
    expect(env.platform).toBe('darwin')
  })

  test('omits cwd rather than sending a truncated path', () => {
    // The backend caps cwd at 512. Half a path shown as fact is worse than an
    // honest blank, so an over-long path is dropped, not cut.
    const long = '/' + 'a'.repeat(512)
    const env = heartbeatEnv({ cwd: () => long, platform: 'linux' })
    expect(env.cwd).toBeUndefined()
    expect(env.platform).toBe('linux')
  })

  test('still reports platform when cwd cannot be read', () => {
    const env = heartbeatEnv({
      cwd: () => {
        throw new Error('no cwd')
      },
      platform: 'linux',
    })
    expect(env.cwd).toBeUndefined()
    expect(env.platform).toBe('linux')
  })

  test('never throws, whatever the process looks like', () => {
    expect(() =>
      heartbeatEnv({
        cwd: () => {
          throw new Error('boom')
        },
        platform: '',
      }),
    ).not.toThrow()
  })

  test('sends cwd in the heartbeat body', async () => {
    const bodies: Array<Record<string, unknown>> = []
    startVersionHeartbeat({
      authMode: 'pairing',
      rootDir: import.meta.dir + '/..',
      post: async (_p, body) => {
        bodies.push(body)
        return null
      },
      log: () => {},
    })
    await new Promise((r) => setTimeout(r, 10))
    expect(bodies.length).toBeGreaterThan(0)
    const env = bodies[0]!.env as { cwd?: string }
    expect(typeof env.cwd).toBe('string')
  })
})

describe('heartbeatEnv machine identity (zero-terminal lifecycle)', () => {
  const MACHINE_ID = '0f8a7b6c-1234-4abc-8def-0123456789ab'

  test('carries the provider machineId and role agent', () => {
    const env = heartbeatEnv({ cwd: () => '/x', platform: 'linux' }, { machineId: () => MACHINE_ID })
    expect(env.machineId).toBe(MACHINE_ID)
    expect(env.role).toBe('agent')
    expect(env.cwd).toBe('/x')
  })

  test('no provider: role still rides, machineId is absent rather than guessed', () => {
    const env = heartbeatEnv({ cwd: () => '/x', platform: 'linux' })
    expect(env.role).toBe('agent')
    expect('machineId' in env).toBe(false)
  })

  test('a throwing provider never breaks the env', () => {
    const env = heartbeatEnv(
      { cwd: () => '/x', platform: 'darwin' },
      {
        machineId: () => {
          throw new Error('home unreadable')
        },
      },
    )
    expect(env.platform).toBe('darwin')
    expect(env.role).toBe('agent')
    expect('machineId' in env).toBe(false)
  })

  test('an empty or malformed id is omitted, never sent', () => {
    for (const bad of ['', 'short', 'has spaces here', 'x'.repeat(65)]) {
      const env = heartbeatEnv({ cwd: () => '/x', platform: 'linux' }, { machineId: () => bad })
      expect('machineId' in env).toBe(false)
    }
  })

  test('startVersionHeartbeat threads the provider into the body', async () => {
    const calls: Array<Record<string, unknown>> = []
    const handle = startVersionHeartbeat({
      authMode: 'pairing',
      rootDir: dirWithPackage('0.38.3'),
      post: async (_path, body) => {
        calls.push(body)
        return {}
      },
      log: () => {},
      machineId: () => MACHINE_ID,
    })
    await Bun.sleep(0)
    const env = calls[0]!.env as { machineId?: string; role?: string }
    expect(env.machineId).toBe(MACHINE_ID)
    expect(env.role).toBe('agent')
    clearInterval(handle!.timer)
  })

  test('a throwing machineId provider never blocks the send', async () => {
    const calls: Array<Record<string, unknown>> = []
    const handle = startVersionHeartbeat({
      authMode: 'pairing',
      rootDir: dirWithPackage('0.38.3'),
      post: async (_path, body) => {
        calls.push(body)
        return {}
      },
      log: () => {},
      machineId: () => {
        throw new Error('disk on fire')
      },
    })
    await Bun.sleep(0)
    expect(calls.length).toBe(1)
    expect(calls[0]!.daemonVersion).toBe('0.38.3')
    const env = calls[0]!.env as { machineId?: string; role?: string }
    expect('machineId' in env).toBe(false)
    expect(env.role).toBe('agent')
    clearInterval(handle!.timer)
  })
})

// Board row 01a061fb (2026-09-02): the readiness block rode ONLY the 6h version
// heartbeat (plus the update path's explicit sendNow), so a latch cleared under
// a running daemon reached the app's "updates paused" badge up to six hours
// later; ten Windows daemons showed it for an afternoon. Readiness is now
// polled cheaply and re-sent only when it changes.
describe('readiness resend on change', () => {
  test('a changed readiness snapshot is re-sent on the next poll; an unchanged one is not', async () => {
    const calls: { path: string; body: Record<string, unknown> }[] = []
    const readiness = { supervised: 'launcher' as const, autoUpdateEnabled: true, rollbackLatched: true, pendingRestartVersion: null }
    const handle = startVersionHeartbeat({
      authMode: 'pairing',
      rootDir: dirWithPackage('0.22.0'),
      post: async (path, body) => {
        calls.push({ path, body })
        return {}
      },
      log: () => {},
      updateStatus: { latestKnownVersion: () => null, updateReadiness: () => ({ ...readiness }) },
      machineId: () => 'm',
      readinessPollMs: 60_000,
    })
    expect(handle).not.toBeNull()
    await new Promise((r) => setImmediate(r))
    expect(calls.length).toBe(1)
    await handle!.pollReadiness()
    expect(calls.length).toBe(1)
    readiness.rollbackLatched = false
    await handle!.pollReadiness()
    expect(calls.length).toBe(2)
    expect((calls[1]!.body.updateReadiness as { rollbackLatched: boolean }).rollbackLatched).toBe(false)
    await handle!.pollReadiness()
    expect(calls.length).toBe(2)
    clearInterval(handle!.timer)
    clearInterval(handle!.readinessTimer)
  })

  test('a readiness provider that throws never breaks the poll', async () => {
    const handle = startVersionHeartbeat({
      authMode: 'pairing',
      rootDir: dirWithPackage('0.22.0'),
      post: async () => ({}),
      log: () => {},
      updateStatus: {
        latestKnownVersion: () => null,
        updateReadiness: () => {
          throw new Error('probe down')
        },
      },
      machineId: () => 'm',
    })
    await expect(handle!.pollReadiness()).resolves.toBeUndefined()
    clearInterval(handle!.timer)
    clearInterval(handle!.readinessTimer)
  })
})

describe('declared capabilities on the heartbeat', () => {
  // The heartbeat is the REFRESH path: an already-paired daemon that updates
  // starts declaring here on its next beat, no re-pair required, and an array
  // replaces the stored declaration wholesale. That is what lets the backend
  // decide, per daemon, whether the owner sees a Pause button at all.
  test('the declaration rides EVERY beat, not only the first', async () => {
    const calls: Array<Record<string, unknown>> = []
    const handle = startVersionHeartbeat({
      authMode: 'pairing',
      rootDir: dirWithPackage('0.41.0'),
      post: async (_path, body) => {
        calls.push(body)
        return {}
      },
      log: () => {},
      capabilities: () => [...declaredCapabilities({ canInjectGoal: true, floorHook: true, authMode: 'pairing' })],
    })
    await Bun.sleep(0)
    handle!.sendNow()
    await Bun.sleep(0)
    expect(calls.length).toBe(2)
    for (const body of calls) {
      expect(body.capabilities).toEqual([...declaredCapabilities({ canInjectGoal: true, floorHook: true, authMode: 'pairing' })])
    }
    clearInterval(handle!.timer)
  })

  test('what rides the beat is what THIS host can do, computed per beat', () => {
    // Until 0.42.0 this asserted one token and that mission_pause was absent,
    // because nothing here could enforce a pause. The goal lane is the pause
    // this daemon can enforce: clearing the native goal stops the loop after
    // the current turn. It is host shaped, so the beat carries a different
    // answer on a machine that cannot type into its own session, and the
    // heartbeat evaluates the thunk on every beat precisely so a late tmux
    // upgrade starts declaring without a restart. stop_pauses_mission (P6
    // stage 3) rides with mission_pause: the Stop pause it promises is the
    // same goal clear, so it is host shaped too. sessions_library (P6 stage
    // 3) is a read of the agent folder, so every host declares it.
    // permission_card (0.49.0) rides every beat on every host: the relay
    // speaks the channel's own permission notification, which has no
    // platform limit. plan_card (0.50.0) likewise: propose_plan is a typed
    // tool on every host.
    // hard_floor (0.53.0) likewise: the floor hook is a plain node script and
    // its hold rides the permission relay. It is declared on a pairing
    // connection only, and only a pairing connection beats
    // (shouldSendVersionHeartbeat), so every beat carries it.
    // boards_playbook (0.56.0) rides every beat on every host: the column
    // lines tool is typed and has no platform limit. boards_playbook_does
    // (0.57.0, Kanban phase 2) rides beside it for the same reason: a line's
    // instruction part is an argument of the same tool. boards_runs (Kanban
    // phase 3) rides beside them on every host: it is a sentence the model
    // reads and needs no tool.
    // changes_rpc (P7 stage 3) likewise: every host can read its own folder
    // with Git, so it rides every beat after memory_rpc.
    expect([...declaredCapabilities({ canInjectGoal: true, floorHook: true, authMode: 'pairing' })]).toEqual([
      'mission_events',
      'mission_goal_checks',
      'mission_set_goals',
      'permission_card',
      'plan_card',
      'memory_rpc',
      'boards_playbook',
      'boards_playbook_does',
      'boards_runs',
      'sessions_library',
      'changes_rpc',
      'hard_floor',
      'hard_floor_rules_2',
      'mission_goal_loop',
      'mission_goal_uncapped',
      'mission_pause',
      'stop_pauses_mission',
    ])
    expect([...declaredCapabilities({ canInjectGoal: false, floorHook: true, authMode: 'pairing' })]).toEqual([
      'mission_events',
      'mission_goal_checks',
      'mission_set_goals',
      'permission_card',
      'plan_card',
      'memory_rpc',
      'boards_playbook',
      'boards_playbook_does',
      'boards_runs',
      'sessions_library',
      'changes_rpc',
      'hard_floor',
      'hard_floor_rules_2',
    ])
  })

  test('no provider means no key at all, never an empty array', async () => {
    const calls: Array<Record<string, unknown>> = []
    const handle = startVersionHeartbeat({
      authMode: 'pairing',
      rootDir: dirWithPackage('0.41.0'),
      post: async (_path, body) => {
        calls.push(body)
        return {}
      },
      log: () => {},
    })
    await Bun.sleep(0)
    expect('capabilities' in calls[0]!).toBe(false)
    clearInterval(handle!.timer)
  })

  test('an empty declaration is omitted rather than clearing the stored one', async () => {
    const calls: Array<Record<string, unknown>> = []
    const handle = startVersionHeartbeat({
      authMode: 'pairing',
      rootDir: dirWithPackage('0.41.0'),
      post: async (_path, body) => {
        calls.push(body)
        return {}
      },
      log: () => {},
      capabilities: () => [],
    })
    await Bun.sleep(0)
    expect('capabilities' in calls[0]!).toBe(false)
    clearInterval(handle!.timer)
  })

  test('a throwing capabilities provider never drops the beat or daemonVersion', async () => {
    const calls: Array<Record<string, unknown>> = []
    const handle = startVersionHeartbeat({
      authMode: 'pairing',
      rootDir: dirWithPackage('0.41.0'),
      post: async (_path, body) => {
        calls.push(body)
        return {}
      },
      log: () => {},
      capabilities: () => {
        throw new Error('capability probe exploded')
      },
    })
    await Bun.sleep(0)
    expect(calls.length).toBe(1)
    expect(calls[0]!.daemonVersion).toBe('0.41.0')
    expect('capabilities' in calls[0]!).toBe(false)
    clearInterval(handle!.timer)
  })

  test('a legacy X-API-Key install still declares nothing at all', () => {
    // It has no pairing row to carry a declaration, so the whole loop is
    // skipped. The backend must read "no declaration" as "enforces nothing".
    expect(shouldSendVersionHeartbeat('apikey', '0.41.0')).toBe(false)
  })
})

// HOAI board row 9c3d6b2c, session liveness: the session status rides the
// existing heartbeat. On every full beat, and on its own small beat within a
// minute of a change and every 2 minutes while work is owed, so the server can
// tell a long job from a frozen session long before the next 6 hourly beat.
describe('session status on the heartbeat', () => {
  const T0 = Date.parse('2026-10-09T12:00:00.000Z')
  const report = (over: Partial<SessionStatusReport> = {}): SessionStatusReport => ({
    v: 1,
    at: new Date(T0).toISOString(),
    busy: false,
    lastActivityAt: new Date(T0 - 60_000).toISOString(),
    taskOpen: false,
    questionsWaiting: 0,
    messagesWaiting: 0,
    oldestMessageAt: null,
    running: 0,
    ...over,
  })

  function arm(opts: {
    status: () => SessionStatusReport | null
    clock: { now: number }
    post?: (path: string, body: Record<string, unknown>) => Promise<unknown>
  }) {
    const calls: { path: string; body: Record<string, unknown> }[] = []
    const handle = startVersionHeartbeat({
      authMode: 'pairing',
      rootDir: dirWithPackage('0.64.0'),
      post:
        opts.post ??
        (async (path, body) => {
          calls.push({ path, body })
          return {}
        }),
      log: () => {},
      machineId: () => 'm',
      sessionStatus: opts.status,
      now: () => opts.clock.now,
    })
    expect(handle).not.toBeNull()
    const stop = () => {
      clearInterval(handle!.timer)
      clearInterval(handle!.readinessTimer)
      clearInterval(handle!.statusTimer)
    }
    return { handle: handle!, calls, stop }
  }

  test('rides the boot beat, and every full beat after it', async () => {
    const clock = { now: T0 }
    let current = report()
    const { handle, calls, stop } = arm({ status: () => current, clock })
    await new Promise((r) => setImmediate(r))
    expect(calls).toHaveLength(1)
    expect(calls[0]!.body.sessionStatus).toEqual(current)
    current = report({ busy: true, taskOpen: true })
    handle.sendNow()
    await new Promise((r) => setImmediate(r))
    expect(calls[1]!.body.sessionStatus).toEqual(current)
    stop()
  })

  test('no report (not the pairing lock holder), no key; a throwing provider never drops the beat', async () => {
    const clock = { now: T0 }
    const a = arm({ status: () => null, clock })
    await new Promise((r) => setImmediate(r))
    expect('sessionStatus' in a.calls[0]!.body).toBe(false)
    a.stop()
    const b = arm({
      status: () => {
        throw new Error('state exploded')
      },
      clock,
    })
    await new Promise((r) => setImmediate(r))
    expect(b.calls[0]!.body.daemonVersion).toBe('0.64.0')
    expect('sessionStatus' in b.calls[0]!.body).toBe(false)
    await expect(b.handle.pollSessionStatus()).resolves.toBeUndefined()
    b.stop()
  })

  test('a change goes out on its own small beat once the minute gap allows, idle news is not repeated', async () => {
    const clock = { now: T0 }
    let current = report()
    const { handle, calls, stop } = arm({ status: () => current, clock })
    await new Promise((r) => setImmediate(r))
    expect(calls).toHaveLength(1)
    // Idle and unchanged: nothing, for hours.
    clock.now = T0 + 6 * 60 * 60_000
    await handle.pollSessionStatus()
    expect(calls).toHaveLength(1)
    // A change right after a send waits for the gap...
    clock.now = T0 + 6 * 60 * 60_000
    current = report({ busy: true, taskOpen: true, at: new Date(clock.now).toISOString() })
    await handle.pollSessionStatus()
    expect(calls).toHaveLength(2)
    // Status only (review finding 9): no daemonVersion, so the backend's
    // telemetry write has nothing to write and returns before the database.
    expect(calls[1]!.body).toEqual({ sessionStatus: current })
    current = report({ busy: true, taskOpen: true, running: 1 })
    clock.now += SESSION_STATUS_MIN_GAP_MS - 1
    await handle.pollSessionStatus()
    expect(calls).toHaveLength(2)
    // ...and goes out the moment it does: within a minute of the change.
    clock.now += 1
    await handle.pollSessionStatus()
    expect(calls).toHaveLength(3)
    expect((calls[2]!.body.sessionStatus as SessionStatusReport).running).toBe(1)
    stop()
  })

  test('while work is owed the report is renewed every 2 minutes, unchanged or not', async () => {
    const clock = { now: T0 }
    const current = report({ busy: true, taskOpen: true })
    const { handle, calls, stop } = arm({ status: () => current, clock })
    await new Promise((r) => setImmediate(r))
    expect(calls).toHaveLength(1)
    clock.now = T0 + SESSION_STATUS_BUSY_MS - 1
    await handle.pollSessionStatus()
    expect(calls).toHaveLength(1)
    clock.now = T0 + SESSION_STATUS_BUSY_MS
    await handle.pollSessionStatus()
    expect(calls).toHaveLength(2)
    clock.now = T0 + 2 * SESSION_STATUS_BUSY_MS
    await handle.pollSessionStatus()
    expect(calls).toHaveLength(3)
    stop()
  })

  test('a status beat the server never took is tried again after the gap, not on every tick', async () => {
    const clock = { now: T0 }
    let fail = true
    const calls: Record<string, unknown>[] = []
    const { handle, stop } = arm({
      status: () => report({ messagesWaiting: 1, oldestMessageAt: new Date(T0).toISOString(), busy: true }),
      clock,
      post: async (_path, body) => {
        calls.push(body)
        if (fail) throw new Error('offline')
        return {}
      },
    })
    await new Promise((r) => setImmediate(r))
    expect(calls).toHaveLength(1)
    clock.now = T0 + 5_000
    await handle.pollSessionStatus()
    expect(calls).toHaveLength(1)
    fail = false
    clock.now = T0 + SESSION_STATUS_MIN_GAP_MS
    await handle.pollSessionStatus()
    expect(calls).toHaveLength(2)
    clock.now += 5_000
    await handle.pollSessionStatus()
    expect(calls).toHaveLength(2)
    stop()
  })

  test('the status tick is armed at the contract cadence and never holds the process open', () => {
    const clock = { now: T0 }
    const { handle, stop } = arm({ status: () => report(), clock })
    expect(typeof handle.statusTimer.hasRef).toBe('function')
    expect(handle.statusTimer.hasRef()).toBe(false)
    expect(SESSION_STATUS_TICK_MS + SESSION_STATUS_MIN_GAP_MS).toBe(SESSION_STATUS_CHANGE_MS)
    stop()
  })
})
