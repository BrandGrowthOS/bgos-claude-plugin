/**
 * Home-folder identity binding tests (board 01a068f7).
 *
 * THE DEFECT UNDER TEST. On a host with one paired agent, every process under
 * that OS user resolves to that agent's credentials by elimination, so a
 * `claude` session started in any folder becomes that agent and answers in its
 * name. The 0.38.6 pairing lock guarantees one daemon per pairing but not the
 * RIGHT one, so it cannot close this.
 *
 * The tests below pin the three properties that make the binding safe to roll
 * to a live fleet, because each one is a way this could take the fleet down:
 *   - explicit pins are never constrained (the env-pinned Windows hosts),
 *   - an unbound agent self-migrates rather than refusing (upgrade safety),
 *   - the kill-switch works (a wedge is one variable from cleared).
 * and the one property that makes it worth shipping: a session in a foreign
 * folder REFUSES instead of speaking as the agent.
 *
 * Run: npm test (node --test) or bun test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  decideHomeBinding,
  formatHomeBindingRefusal,
  normalizeHomeDir,
  recordHomeDir,
  ALLOW_ANY_FOLDER_ENV,
  FOLDER_PIN_FILE,
} from '../lib/agent-credentials.ts'

const HOME = '/Users/kc/agents/ares'
const STRAY = '/Users/kc/BGOS'

// ── The defect itself ────────────────────────────────────────────────────────

test('a session in a foreign folder refuses instead of answering as the agent', () => {
  for (const via of ['sole-per-assistant', 'legacy'] as const) {
    const d = decideHomeBinding({
      via,
      cwd: STRAY,
      recordedHomeDir: HOME,
      assistantId: '1040',
      platform: 'linux',
    })
    assert.equal(d.action, 'refuse', `via ${via} must refuse a foreign folder`)
    if (d.action === 'refuse') {
      assert.equal(d.recordedHomeDir, HOME)
      assert.equal(d.cwd, STRAY)
      assert.equal(d.assistantId, '1040')
    }
  }
})

test('the agent booting from its own folder is allowed', () => {
  const d = decideHomeBinding({
    via: 'sole-per-assistant',
    cwd: HOME,
    recordedHomeDir: HOME,
    platform: 'linux',
  })
  assert.deepEqual(d, { action: 'allow', reason: 'match' })
})

// ── The three fleet-safety properties ────────────────────────────────────────

test('explicit per-process pins are never constrained, whatever the folder', () => {
  // The 12-agent env-pinned Windows host: it launches from anywhere and must
  // keep booting. An explicit pin IS an identity signal; nothing to second-guess.
  for (const via of ['env-path', 'env-assistant', 'folder-pin'] as const) {
    const d = decideHomeBinding({
      via,
      cwd: STRAY,
      recordedHomeDir: HOME,
      platform: 'linux',
    })
    assert.deepEqual(d, { action: 'allow', reason: 'explicit-pin' }, `via ${via}`)
  }
})

test('an agent with nothing recorded self-migrates rather than refusing', () => {
  // Upgrade safety: every existing agent has no homeDir on the day this ships.
  // If this returned refuse, the upgrade would stop the entire fleet.
  const d = decideHomeBinding({
    via: 'sole-per-assistant',
    cwd: HOME,
    recordedHomeDir: null,
    platform: 'linux',
  })
  assert.deepEqual(d, { action: 'record', homeDir: HOME })
})

test('the kill-switch clears the binding for one boot', () => {
  for (const value of ['1', 'true', 'TRUE']) {
    const d = decideHomeBinding({
      via: 'sole-per-assistant',
      cwd: STRAY,
      recordedHomeDir: HOME,
      env: { [ALLOW_ANY_FOLDER_ENV]: value },
      platform: 'linux',
    })
    assert.deepEqual(d, { action: 'allow', reason: 'override' }, `value ${value}`)
  }
  // An unrelated value must NOT disable the guard.
  const off = decideHomeBinding({
    via: 'sole-per-assistant',
    cwd: STRAY,
    recordedHomeDir: HOME,
    env: { [ALLOW_ANY_FOLDER_ENV]: '0' },
    platform: 'linux',
  })
  assert.equal(off.action, 'refuse')
})

// ── False-refusal guards (a guard that fires wrongly gets disabled) ──────────

test('a trailing separator or a case difference is not a foreign folder', () => {
  const withSlash = decideHomeBinding({
    via: 'sole-per-assistant',
    cwd: `${HOME}/`,
    recordedHomeDir: HOME,
    platform: 'linux',
  })
  assert.equal(withSlash.action, 'allow')

  // Windows and macOS are case-insensitive; Linux is not, and must stay strict.
  const winCase = decideHomeBinding({
    via: 'sole-per-assistant',
    cwd: 'C:\\Agents\\Ares',
    recordedHomeDir: 'c:\\agents\\ares',
    platform: 'win32',
  })
  assert.equal(winCase.action, 'allow')

  const linuxCase = decideHomeBinding({
    via: 'sole-per-assistant',
    cwd: '/agents/Ares',
    recordedHomeDir: '/agents/ares',
    platform: 'linux',
  })
  assert.equal(linuxCase.action, 'refuse')
})

test('an empty launch folder allows rather than fails closed', () => {
  // No cwd says nothing about identity, so refusing on it would be a guard
  // firing on a condition it cannot actually read.
  const d = decideHomeBinding({
    via: 'sole-per-assistant',
    cwd: '',
    recordedHomeDir: HOME,
    platform: 'linux',
  })
  assert.deepEqual(d, { action: 'allow', reason: 'no-cwd' })
})

test('normalizeHomeDir keeps a root path from collapsing to nothing', () => {
  assert.equal(normalizeHomeDir('/', { platform: 'linux' }), '/')
  assert.equal(normalizeHomeDir('  ', { platform: 'linux' }), '')
})

// ── The refusal message has to be actionable without reading the source ──────

test('the refusal names the agent, both folders, and every escape', () => {
  const d = decideHomeBinding({
    via: 'legacy',
    cwd: STRAY,
    recordedHomeDir: HOME,
    assistantId: '1040',
    platform: 'linux',
  })
  const msg = formatHomeBindingRefusal(d)
  assert.match(msg, /1040/)
  assert.ok(msg.includes(HOME), 'names the home folder')
  assert.ok(msg.includes(STRAY), 'names the folder it was launched from')
  assert.ok(msg.includes(FOLDER_PIN_FILE), 'names the folder-pin escape')
  assert.match(msg, /BGOS_ASSISTANT_ID/)
  assert.match(msg, new RegExp(ALLOW_ANY_FOLDER_ENV))
  assert.equal(formatHomeBindingRefusal({ action: 'allow', reason: 'match' }), '')
})

// ── The writer: preserve everything, claim once, never throw ─────────────────

test('recordHomeDir preserves every other field and never rewrites a claim', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'home-binding-'))
  try {
    const path = join(dir, 'credentials-1040.json')
    const original = {
      backendUrl: 'https://api.example.test',
      pairingToken: 'secret-token-value',
      pairingId: 113,
      userId: 'user_abc',
      assistantId: 1040,
      pairedAt: '2026-08-01T00:00:00.000Z',
    }
    writeFileSync(path, JSON.stringify(original, null, 2))

    assert.equal(recordHomeDir({ path, homeDir: HOME }), true)
    const after = JSON.parse(readFileSync(path, 'utf8'))
    assert.equal(after.homeDir, HOME)
    for (const [k, v] of Object.entries(original)) {
      assert.deepEqual(after[k], v, `field ${k} must survive the write`)
    }

    // A second call must NOT move the binding: recording is a one-time
    // migration, not something a later boot can quietly relocate.
    assert.equal(recordHomeDir({ path, homeDir: STRAY }), false)
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).homeDir, HOME)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('recordHomeDir degrades quietly when it cannot write', () => {
  // A read-only credentials file must leave the agent unbound and WORKING.
  // A guard that cannot write its state must never fail the boot.
  assert.equal(
    recordHomeDir({ path: join(tmpdir(), 'definitely-absent-creds.json'), homeDir: HOME }),
    false,
  )
  assert.equal(
    recordHomeDir({
      path: '/x',
      homeDir: HOME,
      io: {
        readText: () => '{"assistantId":1040}',
        writeFile: () => {
          throw new Error('EROFS')
        },
      },
    }),
    false,
  )
  assert.equal(recordHomeDir({ path: '/x', homeDir: '   ' }), false)
})
