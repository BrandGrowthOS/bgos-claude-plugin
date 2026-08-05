/**
 * Auth divergence recheck (peer-871-4): the daemon resolves auth ONCE at
 * boot; when the credentials underneath the process change later, the boot
 * log line masquerades as current truth. lib/auth-recheck re-runs the same
 * pure resolution the boot used and emits ONE structured WARN per distinct
 * divergence, including the AGE of the change, plus a recovery line when the
 * resolution reverts. Visibility only: nothing here changes running auth,
 * and no token may ever appear in a message.
 *
 * Run with:  bun test test/auth-recheck.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import { resolveAuth } from '../lib/agent-credentials.ts'
import {
  authSnapshot,
  tokenFingerprint,
  formatAge,
  resolveAuthRecheckIntervalMs,
  AuthRecheckMonitor,
  AUTH_RECHECK_DEFAULT_INTERVAL_MS,
  type AuthSnapshot,
} from '../lib/auth-recheck.ts'

const HOME = '/home/agent/.bgos-agent'
const LEGACY = `${HOME}/credentials.json`
const PER_871 = `${HOME}/credentials-871.json`

const PAIRING_TOKEN = 'bgp_super_secret_pairing_token_value_871'
const API_KEY = 'ak_live_extremely_secret_api_key_value'

function apikeySnapshot(): AuthSnapshot {
  const auth = resolveAuth({
    env: {
      BGOS_API_KEY: API_KEY,
      BGOS_BACKEND_URL: 'https://api.example.com',
      BGOS_USER_ID: 'user_1',
      BGOS_ASSISTANT_ID: '871',
    },
  })
  return authSnapshot(auth, LEGACY)
}

function pairingFileSnapshot(path = PER_871, assistantId = '871'): AuthSnapshot {
  const auth = resolveAuth({
    env: { BGOS_ASSISTANT_ID: assistantId },
    creds: {
      backendUrl: 'https://api.example.com',
      pairingToken: PAIRING_TOKEN,
      userId: 'user_1',
      assistantId,
    },
  })
  return authSnapshot(auth, path)
}

// ── Snapshots and fingerprints ───────────────────────────────────────────────

test('authSnapshot captures mode, source, assistantId, path, and a non-secret fingerprint', () => {
  const snap = pairingFileSnapshot()
  assert.equal(snap.mode, 'pairing')
  assert.equal(snap.source, 'pairing-file')
  assert.equal(snap.assistantId, '871')
  assert.equal(snap.credentialsPath, PER_871)
  const expected = createHash('sha256').update(PAIRING_TOKEN).digest('hex').slice(0, 8)
  assert.equal(snap.tokenFingerprint, expected)
  // The snapshot itself never carries the secret anywhere.
  assert.ok(!JSON.stringify(snap).includes(PAIRING_TOKEN))
})

test('tokenFingerprint of an empty secret is the literal none, never 8 hex chars', () => {
  assert.equal(tokenFingerprint(''), 'none')
  assert.match(tokenFingerprint('abc'), /^[0-9a-f]{8}$/)
})

// ── Age formatting ───────────────────────────────────────────────────────────

test('formatAge renders seconds, minutes, hours, days, and the unknown case', () => {
  assert.equal(formatAge(42_000), '42s ago')
  assert.equal(formatAge(17 * 60_000), '17m ago')
  assert.equal(formatAge(3 * 3_600_000), '3h ago')
  assert.equal(formatAge(2 * 86_400_000), '2d ago')
  assert.equal(formatAge(null), 'at an unknown time')
  assert.equal(formatAge(-5_000), '0s ago')
})

// ── Interval resolution ──────────────────────────────────────────────────────

test('recheck interval defaults to 10 minutes and honors the env override', () => {
  assert.equal(AUTH_RECHECK_DEFAULT_INTERVAL_MS, 600_000)
  assert.equal(resolveAuthRecheckIntervalMs({}), 600_000)
  assert.equal(
    resolveAuthRecheckIntervalMs({ BGOS_AUTH_RECHECK_INTERVAL_MS: '60000' }),
    60_000,
  )
  // Disabled explicitly.
  assert.equal(resolveAuthRecheckIntervalMs({ BGOS_AUTH_RECHECK_INTERVAL_MS: '0' }), 0)
  assert.equal(resolveAuthRecheckIntervalMs({ BGOS_AUTH_RECHECK_INTERVAL_MS: 'off' }), 0)
  // Garbage falls back to the default; tiny values clamp to a sane floor.
  assert.equal(
    resolveAuthRecheckIntervalMs({ BGOS_AUTH_RECHECK_INTERVAL_MS: 'soon' }),
    600_000,
  )
  assert.equal(resolveAuthRecheckIntervalMs({ BGOS_AUTH_RECHECK_INTERVAL_MS: '1' }), 5_000)
})

// ── Divergence detection ─────────────────────────────────────────────────────

test('same outcome as boot stays silent across repeated checks', () => {
  const monitor = new AuthRecheckMonitor(apikeySnapshot())
  for (let i = 0; i < 5; i++) {
    assert.equal(monitor.evaluate(apikeySnapshot(), Date.now(), Date.now()), null)
  }
})

test('a changed outcome emits ONE WARN naming both resolutions and the age', () => {
  const boot = apikeySnapshot()
  const monitor = new AuthRecheckMonitor(boot)
  const now = 1_000_000_000_000
  const mtime = now - 3 * 3_600_000 // file changed 3h ago
  const current = pairingFileSnapshot()

  const warn = monitor.evaluate(current, mtime, now)
  assert.ok(warn, 'first divergent check must produce a WARN line')
  assert.ok(warn.startsWith('WARN credentials resolution changed underneath this process'))
  assert.ok(warn.includes('3h ago'))
  assert.ok(warn.includes('apikey-env for assistant 871'))
  assert.ok(warn.includes('pairing-file credentials-871.json for assistant 871'))
  assert.ok(warn.includes('restart to adopt'))

  // Same divergent state again: silent (once per distinct divergence).
  assert.equal(monitor.evaluate(current, mtime, now + 600_000), null)
  assert.equal(monitor.evaluate(current, mtime, now + 1_200_000), null)
})

test('flapping logs once per DISTINCT divergent state, and recovery when it reverts', () => {
  const boot = apikeySnapshot()
  const monitor = new AuthRecheckMonitor(boot)
  const now = 1_000_000_000_000

  const stateB = pairingFileSnapshot(PER_871, '871')
  const stateC = pairingFileSnapshot(`${HOME}/credentials-872.json`, '872')

  const warnB = monitor.evaluate(stateB, now - 60_000, now)
  assert.ok(warnB && warnB.startsWith('WARN'))
  assert.equal(monitor.evaluate(stateB, now - 60_000, now + 1), null)

  // A DIFFERENT divergent state warns again.
  const warnC = monitor.evaluate(stateC, now - 30_000, now + 2)
  assert.ok(warnC && warnC.startsWith('WARN'))
  assert.ok(warnC.includes('assistant 872'))
  assert.equal(monitor.evaluate(stateC, now - 30_000, now + 3), null)

  // Revert to the boot outcome: one recovery line, then silence.
  const recovered = monitor.evaluate(apikeySnapshot(), now - 10_000, now + 4)
  assert.ok(recovered, 'revert to boot outcome must log recovery')
  assert.ok(recovered.includes('recovered'))
  assert.ok(!recovered.startsWith('WARN'))
  assert.equal(monitor.evaluate(apikeySnapshot(), now - 10_000, now + 5), null)

  // Diverging again after recovery is a new episode: warns again.
  const warnB2 = monitor.evaluate(stateB, now - 5_000, now + 6)
  assert.ok(warnB2 && warnB2.startsWith('WARN'))
})

test('a token rotation in the same file (fingerprint-only change) is a divergence', () => {
  const boot = pairingFileSnapshot()
  const monitor = new AuthRecheckMonitor(boot)
  const rotated: AuthSnapshot = { ...boot, tokenFingerprint: 'deadbeef' }
  const now = 1_000_000_000_000
  const warn = monitor.evaluate(rotated, now - 42_000, now)
  assert.ok(warn && warn.startsWith('WARN'))
  assert.ok(warn.includes('42s ago'))
  assert.ok(warn.includes(`token fp ${boot.tokenFingerprint} -> deadbeef`))
})

test('unknown mtime renders as at an unknown time, not NaN', () => {
  const monitor = new AuthRecheckMonitor(apikeySnapshot())
  const warn = monitor.evaluate(pairingFileSnapshot(), null, Date.now())
  assert.ok(warn)
  assert.ok(warn.includes('at an unknown time'))
  assert.ok(!warn.includes('NaN'))
})

// ── Secrets never in messages ────────────────────────────────────────────────

test('no token ever appears in any WARN or recovery message', () => {
  const boot = apikeySnapshot()
  const monitor = new AuthRecheckMonitor(boot)
  const now = Date.now()
  const messages: string[] = []
  const w1 = monitor.evaluate(pairingFileSnapshot(), now - 1000, now)
  if (w1) messages.push(w1)
  const w2 = monitor.evaluate(apikeySnapshot(), now - 1000, now)
  if (w2) messages.push(w2)
  assert.ok(messages.length >= 2, 'expected a WARN and a recovery message')
  for (const msg of messages) {
    assert.ok(!msg.includes(PAIRING_TOKEN), 'pairing token leaked into a log line')
    assert.ok(!msg.includes(API_KEY), 'api key leaked into a log line')
  }
})
