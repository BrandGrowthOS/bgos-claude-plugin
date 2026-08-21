/**
 * Stable daemon log path (fix 06, one-click onboarding).
 *
 * Bug: server.ts defaulted the log to join(os.tmpdir(), 'bgos-plugin-<id>.log'),
 * and os.tmpdir() is not one place. macOS launchd hands every session its own
 * per-session $TMPDIR while a login shell gives /tmp, so the "predictable"
 * path moved with how the daemon was launched and nobody could reliably find
 * the log. lib/log-path.ts is the fix: one documented location under the
 * plugin state root, <home>/.bgos-agent/logs/bgos-plugin-<assistantId>.log,
 * with BGOS_LOG_FILE still winning as an explicit override.
 *
 * Invariants:
 *   1. Default path is the stable home-rooted location, keyed by assistant id.
 *   2. BGOS_LOG_FILE wins when set, and is trimmed; a whitespace-only value
 *      falls through to the default.
 *   3. A missing, empty, or whitespace-only assistant id keys as 'unknown'.
 *   4. ensureLogDir never throws (logging must never crash the daemon) and
 *      asks its mkdir for a recursive create of the log file's directory.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { ensureLogDir, resolveLogPath } from '../lib/log-path.ts'

const HOME = join('home', 'kc')

// 1. Default path shape

test('default path lives under <home>/.bgos-agent/logs keyed by assistant id', () => {
  const path = resolveLogPath({ env: {}, home: HOME, assistantId: 'asst-42' })
  assert.equal(path, join(HOME, '.bgos-agent', 'logs', 'bgos-plugin-asst-42.log'))
})

test('assistant id is trimmed before keying the file name', () => {
  const path = resolveLogPath({ env: {}, home: HOME, assistantId: '  asst-42  ' })
  assert.equal(path, join(HOME, '.bgos-agent', 'logs', 'bgos-plugin-asst-42.log'))
})

// 2. BGOS_LOG_FILE override

test('BGOS_LOG_FILE wins over the default and is trimmed', () => {
  const path = resolveLogPath({
    env: { BGOS_LOG_FILE: '  /var/log/bgos/agent.log  ' },
    home: HOME,
    assistantId: 'asst-42',
  })
  assert.equal(path, '/var/log/bgos/agent.log')
})

test('whitespace-only BGOS_LOG_FILE falls through to the default', () => {
  const path = resolveLogPath({
    env: { BGOS_LOG_FILE: '   ' },
    home: HOME,
    assistantId: 'asst-42',
  })
  assert.equal(path, join(HOME, '.bgos-agent', 'logs', 'bgos-plugin-asst-42.log'))
})

// 3. Missing assistant id

test('empty, whitespace-only, null, and undefined assistant ids key as unknown', () => {
  const unknownPath = join(HOME, '.bgos-agent', 'logs', 'bgos-plugin-unknown.log')
  for (const assistantId of ['', '   ', null, undefined]) {
    const path = resolveLogPath({ env: {}, home: HOME, assistantId })
    assert.equal(path, unknownPath)
  }
})

// 4. ensureLogDir

test('ensureLogDir swallows a throwing mkdir', () => {
  assert.doesNotThrow(() => {
    ensureLogDir(join(HOME, '.bgos-agent', 'logs', 'x.log'), () => {
      throw new Error('EACCES: permission denied')
    })
  })
})

test('ensureLogDir asks mkdir for a recursive create of the log directory', () => {
  const calls: Array<{ dir: string; opts: { recursive: true } }> = []
  const logPath = join(HOME, '.bgos-agent', 'logs', 'bgos-plugin-asst-42.log')
  ensureLogDir(logPath, (dir, opts) => {
    calls.push({ dir, opts })
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].dir, dirname(logPath))
  assert.equal(calls[0].opts.recursive, true)
})

test('ensureLogDir with the default mkdir really creates the directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'log-path-'))
  const logPath = join(root, '.bgos-agent', 'logs', 'bgos-plugin-x.log')
  ensureLogDir(logPath)
  assert.equal(existsSync(dirname(logPath)), true)
})
