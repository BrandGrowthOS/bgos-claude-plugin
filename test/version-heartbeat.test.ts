import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
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
    const timer = startVersionHeartbeat({
      authMode: 'pairing',
      rootDir: dirWithPackage('0.22.0'),
      post: async (path, body) => {
        calls.push({ path, body })
        return {}
      },
      log: () => {},
    })
    expect(timer).not.toBeNull()
    await Bun.sleep(0)
    expect(calls).toEqual([
      { path: 'integrations/heartbeat', body: { daemonVersion: '0.22.0' } },
    ])
    expect(VERSION_HEARTBEAT_INTERVAL_MS).toBe(6 * 60 * 60 * 1000)
    clearInterval(timer!)
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
    const timer = startVersionHeartbeat({
      authMode: 'pairing',
      rootDir: dirWithPackage('0.22.0'),
      post: async () => {
        throw new Error('backend down')
      },
      log: () => {},
    })
    await Bun.sleep(0)
    clearInterval(timer!)
  })
})
