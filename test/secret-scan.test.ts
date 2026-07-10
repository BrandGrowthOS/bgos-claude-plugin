/**
 * Secret scan gate tests (Agent Packs, rules_version 1).
 *
 * Coverage: every detector fires on a representative hit, the placeholder
 * allowlist suppresses template values, excerpts are ALWAYS masked to the
 * first 4 chars + "...", line numbers are 1-based, findings are
 * deterministic, and the canonical rule-name list is pinned as the
 * cross-repo canary (the backend twin
 * backend/src/agent-handoffs/secret-scan.util.ts must export the exact
 * same strings; renaming any is a breaking wire change).
 *
 * Every "secret" below is a fabricated fixture.
 *
 * Run: npm test (node --test) or bun test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  scanText,
  scanFiles,
  maskSecret,
  isPlaceholderValue,
  SECRET_SCAN_RULES_VERSION,
  SECRET_SCAN_RULE_NAMES,
} from '../lib/secret-scan.ts'

// ── Canonical ruleset canary ─────────────────────────────────────────────────

test('rules_version 1 rule names are pinned (cross-repo wire canary)', () => {
  assert.equal(SECRET_SCAN_RULES_VERSION, 1)
  assert.deepEqual(SECRET_SCAN_RULE_NAMES, [
    'aws_access_key_id',
    'aws_secret_access_key',
    'anthropic_api_key',
    'openai_api_key',
    'github_token',
    'slack_token',
    'stripe_live_key',
    'google_api_key',
    'private_key_block',
    'jwt',
    'connection_string_password',
    'bearer_token',
    'generic_secret_assignment',
  ])
})

// ── Per-detector hits ────────────────────────────────────────────────────────

function rulesHit(text: string): string[] {
  return scanText('f.md', text).map((f) => f.rule)
}

test('aws_access_key_id fires on AKIA + 16 uppercase alphanumerics', () => {
  assert.ok(rulesHit('key id AKIAIOSFODNN7EXAMPLE here').includes('aws_access_key_id'))
  assert.equal(rulesHit('AKIAshort').length, 0)
})

test('aws_secret_access_key fires on an aws-ish 40 char assignment', () => {
  const hits = rulesHit(
    'aws_secret_access_key = wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY12',
  )
  assert.ok(hits.includes('aws_secret_access_key'))
})

test('anthropic_api_key fires on sk-ant-', () => {
  const findings = scanText('f.md', 'ANTHROPIC=sk-ant-api03-abcdefghijklmnopqrstuvwx')
  assert.ok(findings.some((f) => f.rule === 'anthropic_api_key'))
})

test('openai_api_key fires on sk- and sk-proj- but never on sk-ant-', () => {
  assert.ok(rulesHit('sk-abcdefghijklmnopqrstuv').includes('openai_api_key'))
  assert.ok(
    rulesHit('sk-proj-abc_defghijklmnopqrstuv').includes('openai_api_key'),
  )
  assert.equal(
    rulesHit('sk-ant-api03-abcdefghijklmnopqrstuvwx').includes('openai_api_key'),
    false,
    'sk-ant- must classify as anthropic, not openai',
  )
})

test('github_token fires on ghp_/gho_/ghu_/ghs_ and github_pat_', () => {
  assert.ok(rulesHit('ghp_abcdefghijklmnopqrst1234').includes('github_token'))
  assert.ok(rulesHit('gho_abcdefghijklmnopqrst1234').includes('github_token'))
  assert.ok(rulesHit('ghu_abcdefghijklmnopqrst1234').includes('github_token'))
  assert.ok(rulesHit('ghs_abcdefghijklmnopqrst1234').includes('github_token'))
  assert.ok(
    rulesHit('github_pat_11ABCDEFG_abcdefghijklmnop').includes('github_token'),
  )
})

test('slack_token fires on xox[baprs]-', () => {
  for (const kind of ['b', 'a', 'p', 'r', 's']) {
    assert.ok(
      rulesHit(`xox${kind}-1234567890-abcdef`).includes('slack_token'),
      `xox${kind}- must hit`,
    )
  }
})

test('stripe_live_key fires on sk_live_ and rk_live_', () => {
  assert.ok(rulesHit('sk_live_abcdefghij1234').includes('stripe_live_key'))
  assert.ok(rulesHit('rk_live_abcdefghij1234').includes('stripe_live_key'))
})

test('google_api_key fires on AIza + 30 more chars', () => {
  assert.ok(
    rulesHit('AIzaSyA1234567890abcdefghijklmnopqrstu').includes('google_api_key'),
  )
})

test('private_key_block fires on PEM BEGIN lines of every flavor', () => {
  for (const flavor of [
    '-----BEGIN PRIVATE KEY-----',
    '-----BEGIN RSA PRIVATE KEY-----',
    '-----BEGIN EC PRIVATE KEY-----',
    '-----BEGIN OPENSSH PRIVATE KEY-----',
    '-----BEGIN PGP PRIVATE KEY BLOCK-----',
  ]) {
    assert.ok(rulesHit(flavor).includes('private_key_block'), flavor)
  }
})

test('jwt fires on three dot-separated base64url segments starting eyJ', () => {
  const jwt =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'
  assert.ok(rulesHit(`token: ${jwt}`).includes('jwt'))
})

test('connection_string_password fires on user:pass@ for every scheme', () => {
  for (const scheme of [
    'postgres',
    'postgresql',
    'mysql',
    'mongodb',
    'mongodb+srv',
    'redis',
    'amqp',
  ]) {
    assert.ok(
      rulesHit(`${scheme}://admin:hunter22@db.example.com/x`).includes(
        'connection_string_password',
      ),
      `${scheme} must hit`,
    )
  }
})

test('connection_string_password allows placeholder passwords', () => {
  assert.equal(
    rulesHit('postgres://admin:${DB_PASSWORD}@db.example.com/x').includes(
      'connection_string_password',
    ),
    false,
  )
})

test('bearer_token fires on long Bearer values', () => {
  assert.ok(
    rulesHit('Authorization: Bearer abcdefghijklmnopqrstuvwx').includes(
      'bearer_token',
    ),
  )
  assert.equal(rulesHit('Bearer short').includes('bearer_token'), false)
})

test('generic_secret_assignment fires on keyword [:=] with a 16+ char value', () => {
  for (const line of [
    'api_key = zzzzzzzzzzzzzzzzzz',
    'api-key: "qqqqqqqqqqqqqqqqqq"',
    "SECRET='wwwwwwwwwwwwwwwwww'",
    'password=supersecretvalue123',
    'authorization: rrrrrrrrrrrrrrrrrr',
  ]) {
    assert.ok(
      rulesHit(line).includes('generic_secret_assignment'),
      `must hit: ${line}`,
    )
  }
  // Values shorter than 16 chars never hit.
  assert.equal(rulesHit('api_key = shortvalue').length, 0)
})

// ── Placeholder allowlist ────────────────────────────────────────────────────

test('placeholder allowlist suppresses template values (docs stay packable)', () => {
  for (const value of [
    '${OPENAI_API_KEY}',
    '$OPENAI_API_KEY',
    '<your-key-goes-here>',
    'your-api-key-here',
    'your_api_key_here_x',
    'xxxxxxxxxxxxxxxxxxxx',
    '********************',
    'TODO',
    'CHANGEME',
    'REDACTED',
    'EXAMPLE_VALUE_ONLY_HERE',
  ]) {
    assert.ok(isPlaceholderValue(value), `${value} must be a placeholder`)
    assert.equal(
      rulesHit(`api_key = ${value}`).includes('generic_secret_assignment'),
      false,
      `placeholder must not hit: ${value}`,
    )
  }
  assert.equal(isPlaceholderValue('zzzzzzzzzzzzzzzzzz'), false)
})

// ── Finding shape ────────────────────────────────────────────────────────────

test('findings carry file, 1-based line, rule, and a MASKED excerpt', () => {
  const text = 'line one is fine\napi_key = zzzzzzzzzzzzzzzzzz\nline three'
  const findings = scanText('.claude/rules/setup.md', text)
  assert.equal(findings.length, 1)
  assert.deepEqual(findings[0], {
    file: '.claude/rules/setup.md',
    line: 2,
    rule: 'generic_secret_assignment',
    excerpt: 'zzzz...',
  })
})

test('maskSecret keeps only the first 4 chars', () => {
  assert.equal(maskSecret('AKIAIOSFODNN7EXAMPLE'), 'AKIA...')
  assert.equal(maskSecret('sk-ant-api03-abcdef'), 'sk-a...')
})

test('the full secret value never appears in any finding', () => {
  const secret = 'sk-ant-api03-abcdefghijklmnopqrstuvwx'
  const findings = scanText('CLAUDE.md', `key: ${secret}`)
  assert.ok(findings.length > 0)
  for (const f of findings) {
    assert.equal(JSON.stringify(f).includes(secret), false)
  }
})

test('multiple rules can hit the same line (one finding per rule)', () => {
  const findings = scanText(
    'f.md',
    'token = sk-abcdefghijklmnopqrstuv',
  )
  const rules = findings.map((f) => f.rule)
  assert.ok(rules.includes('openai_api_key'))
  assert.ok(rules.includes('generic_secret_assignment'))
})

test('scanFiles aggregates in input order and is deterministic', () => {
  const files = [
    { path: 'b.md', text: 'AKIAIOSFODNN7EXAMPLE' },
    { path: 'a.md', text: 'clean\nghp_abcdefghijklmnopqrst1234' },
  ]
  const first = scanFiles(files)
  const second = scanFiles(files)
  assert.deepEqual(first, second)
  assert.deepEqual(
    first.map((f) => `${f.file}:${f.line}:${f.rule}`),
    ['b.md:1:aws_access_key_id', 'a.md:2:github_token'],
  )
})

test('clean prose produces zero findings', () => {
  const text = [
    '# Research agent',
    'Set OPENAI_API_KEY in your environment before running.',
    'Use the reply tool for every answer.',
    'CRLF lines\r\nare fine too.',
    '',
  ].join('\n')
  assert.deepEqual(scanText('CLAUDE.md', text), [])
})

test('CRLF input still reports correct 1-based line numbers', () => {
  const findings = scanText('f.md', 'ok\r\nok\r\nAKIAIOSFODNN7EXAMPLE\r\n')
  assert.equal(findings.length, 1)
  assert.equal(findings[0]!.line, 3)
})
