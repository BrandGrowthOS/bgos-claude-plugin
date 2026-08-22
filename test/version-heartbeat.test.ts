import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  heartbeatEnv,
  readOwnVersion,
  shouldSendVersionHeartbeat,
  startVersionHeartbeat,
  VERSION_HEARTBEAT_INTERVAL_MS,
} from '../lib/version-heartbeat'

function dirWithPackage(version: unknown): string {
  const d = mkdtempSync(join(tmpdir(), 'vhb-'))
  writeFileSync(join(d, 'package.json'), JSON.stringify({ version }))
  return d
}

describe('readOwnVersion', () => {
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
