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
import * as secretScan from '../lib/secret-scan.ts'

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

// ── Email files review round 7: linear time ─────────────────────────────────

/** The jwt rule's regex, as both twins write it (backend/src/agent-handoffs/secret-scan.util.ts). */
const JWT_TWIN = /\beyJ[A-Za-z0-9_=-]{8,}\.[A-Za-z0-9_=-]{8,}\.[A-Za-z0-9_=-]{8,}/

test('jwt: the rule keeps the twin regex source, and a long run of -eyJ is scanned in linear time', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../lib/secret-scan.ts', import.meta.url), 'utf8')
  assert.ok(src.includes(`pattern: ${String(JWT_TWIN)},`), 'the jwt rule keeps the backend twin regex source')
  for (const n of [20000, 200000]) {
    const line = '-eyJ'.repeat(n)
    const started = performance.now()
    assert.deepEqual(scanText('f.txt', line), [])
    const ms = performance.now() - started
    assert.ok(ms < 500, `${n} x -eyJ took ${Math.round(ms)} ms`)
  }
  // Still found inside such a run, at the same place the regex finds it.
  const tail = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'
  assert.deepEqual(rulesHit(`${'-eyJ'.repeat(20000)}-${tail}`), ['jwt'])
})

test('jwt: the linear match finds exactly what the twin regex finds, on many generated lines', () => {
  const jwtMatch = (secretScan as Record<string, unknown>).jwtMatch as ((line: string) => string | null) | undefined
  assert.equal(typeof jwtMatch, 'function', 'lib/secret-scan.ts exports jwtMatch')
  // A small seeded generator, so a failure repeats.
  let seed = 7
  const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
  const pieces = ['eyJ', 'eyJ', 'a', 'Z', '0', '_', '=', '-', '.', '.', ' ', '/', 'abcdefgh', 'ABCDEFGHIJ', 'é', 'xeyJ', '_eyJ']
  let found = 0
  for (let n = 0; n < 60000; n++) {
    let line = ''
    const length = 1 + Math.floor(next() * 40)
    for (let k = 0; k < length; k++) line += pieces[Math.floor(next() * pieces.length)]
    const want = JWT_TWIN.exec(line)?.[0] ?? null
    if (want !== null) found++
    assert.equal(jwtMatch!(line), want, JSON.stringify(line))
  }
  assert.ok(found > 100, `only ${found} generated lines hold a jwt`)
  for (const line of ['eyJabcdefgh.abcdefgh.abcdefgh', 'xeyJabcdefgh.abcdefgh.abcdefgh', '-eyJabcdefgh.abcdefgh.abcdefg', 'eyJabcdefg.abcdefgh.abcdefgh', '=eyJ12345678.12345678.12345678.12345678', 'a.eyJ--------.========.________ tail']) {
    assert.equal(jwtMatch!(line), JWT_TWIN.exec(line)?.[0] ?? null, line)
  }
})

test('scanText: 23 MB of one digit per line is scanned in under 2 s; lines are split on \\n, a lone \\r stays in its line', () => {
  const text = Array.from({ length: 1000 }, (_, i) => String(i % 10)).join('\n').concat('\n').repeat(12060)
  assert.ok(text.length > 23 * 1024 * 1024)
  const started = performance.now()
  assert.deepEqual(scanText('f.csv', text), [])
  const ms = performance.now() - started
  assert.ok(ms < 2000, `23 MB of short lines took ${Math.round(ms)} ms`)
  const findings = scanText('f.md', 'one\rAKIAIOSFODNN7EXAMPLE\n\nshort\r\nAKIAIOSFODNN7EXAMPLE')
  assert.deepEqual(findings.map((f) => `${f.line}:${f.rule}`), ['1:aws_access_key_id', '4:aws_access_key_id'])
})

test('scanText builds no RegExp per line (each rule\'s global copy is built once)', () => {
  const Original = globalThis.RegExp
  let built = 0
  globalThis.RegExp = new Proxy(Original, {
    construct(target, args, newTarget) {
      built++
      return Reflect.construct(target, args, newTarget)
    },
  })
  try {
    const findings = scanText('f.txt', 'password = ${DB_PASSWORD_VALUE}\nabcdefghij\n'.repeat(1000))
    assert.equal(findings.length, 0)
  } finally {
    globalThis.RegExp = Original
  }
  assert.equal(built, 0)
})

// ── email files review round 8: bun's regex engine, and the rules a text cannot hit ──

const PRIVATE_KEY_TWIN = /-----BEGIN\s+(?:[A-Z0-9]+\s+)*PRIVATE\s+KEY(?:\s+BLOCK)?-----/

test('round 8: private_key_block keeps the twin regex source, and its linear match finds exactly what the regex finds', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../lib/secret-scan.ts', import.meta.url), 'utf8')
  assert.ok(src.includes(`pattern: ${String(PRIVATE_KEY_TWIN)},`), 'the private_key_block rule keeps the backend twin regex source')
  const privateKeyBlockMatch = (secretScan as Record<string, unknown>).privateKeyBlockMatch as ((line: string) => string | null) | undefined
  assert.equal(typeof privateKeyBlockMatch, 'function', 'lib/secret-scan.ts exports privateKeyBlockMatch')
  let seed = 11
  const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
  const pieces = ['-----BEGIN', '-----BEGIN', '-----', '-', ' ', ' ', '\t', ' ', '　', 'PRIVATE', 'KEY', 'BLOCK', 'RSA', 'A', '9', 'a', 'PRIVATE KEY', 'KEY-----', 'BLOCK-----', 'x']
  let found = 0
  for (let n = 0; n < 60000; n++) {
    let line = ''
    const length = 1 + Math.floor(next() * 24)
    for (let k = 0; k < length; k++) line += pieces[Math.floor(next() * pieces.length)]
    const want = PRIVATE_KEY_TWIN.exec(line)?.[0] ?? null
    if (want !== null) found++
    assert.equal(privateKeyBlockMatch!(line), want, JSON.stringify(line))
  }
  assert.ok(found > 100, `only ${found} generated lines hold an armour line`)
  for (const line of ['-----BEGIN RSA PRIVATE KEY-----', '-----BEGIN PGP PRIVATE KEY BLOCK-----', '------BEGIN  EC   PRIVATE\tKEY-----', '-----BEGIN PRIVATE KEY BLOCK PRIVATE KEY-----', '-----BEGINPRIVATE KEY-----', '-----BEGIN PRIVATE KEY BLOCK-', '-----BEGIN rsa PRIVATE KEY-----']) {
    assert.equal(privateKeyBlockMatch!(line), PRIVATE_KEY_TWIN.exec(line)?.[0] ?? null, line)
  }
  // Three million groups on one line: found, in linear time (bun's regex engine finds nothing there; run this file
  // with bun test to see it).
  const started = performance.now()
  assert.deepEqual(rulesHit(`-----BEGIN ${'A '.repeat(3_000_000)}PRIVATE KEY-----`), ['private_key_block'])
  assert.ok(performance.now() - started < 2000, 'three million groups took too long')
})

test('round 8: a rule whose hint the text does not hold is not tried on its lines; every fixture is still found', () => {
  const exec = RegExp.prototype.exec
  let calls = 0
  RegExp.prototype.exec = function (this: RegExp, text: string) {
    calls++
    return exec.call(this, text)
  }
  try {
    // 2000 lines of prose that hold none of the rules' hints.
    assert.deepEqual(scanText('f.txt', 'The quarterly report shows revenue growth across all regions this year.\n'.repeat(2000)), [])
  } finally {
    RegExp.prototype.exec = exec
  }
  assert.ok(calls < 100, `2000 lines of prose ran ${calls} regex execs`)
  // Each rule still hits its line when the text holds it (the fixtures below are those of the rule tests above).
  for (const [line, rule] of [
    ['key AKIAIOSFODNN7EXAMPLE', 'aws_access_key_id'],
    ['AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'aws_secret_access_key'],
    ['token sk-ant-api03-abcdefghijklmnopqrstuvwxyz', 'anthropic_api_key'],
    ['k sk-proj-abcdefghijklmnopqrstuvwx', 'openai_api_key'],
    ['ghp_abcdefghijklmnopqrstuvwxyz012345', 'github_token'],
    ['xoxb-1234567890-abcdefghij', 'slack_token'],
    ['sk_live_abcdefghijklmnop', 'stripe_live_key'],
    ['AIzaSyAbcdefghijklmnopqrstuvwxyz0123456', 'google_api_key'],
    ['-----BEGIN OPENSSH PRIVATE KEY-----', 'private_key_block'],
    ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U', 'jwt'],
    ['postgres://admin:hunter2secret@db.example.com/app', 'connection_string_password'],
    ['Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456', 'bearer_token'],
    ['client_secret = "abcdefghijklmnopqrstu"', 'generic_secret_assignment'],
  ] as const) {
    assert.ok(rulesHit(`The quarterly report.\n${line}\n`).includes(rule), `${rule}: ${line}`)
  }
})

// ── aws_secret_access_key: its own match, in linear time ─────────────────────

/** The aws_secret_access_key rule's regex, as both twins write it (backend/src/agent-handoffs/secret-scan.util.ts). */
const AWS_SECRET_TWIN = /\baws.{0,30}?['"=:\s]([A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])/i
const AWS_SECRET_TWIN_ALL = new RegExp(AWS_SECRET_TWIN.source, 'gi')

/** What the scan finds for the rule through its regex: each match in turn, the first value that is not a placeholder. */
function awsSecretByRegex(line: string): string | null {
  for (const match of line.matchAll(AWS_SECRET_TWIN_ALL)) {
    if (!isPlaceholderValue(match[1]!)) return match[1]!
  }
  return null
}

function exportedAwsSecretMatch(): (line: string) => string | null {
  const awsSecretMatch = (secretScan as Record<string, unknown>).awsSecretMatch as ((line: string) => string | null) | undefined
  assert.equal(typeof awsSecretMatch, 'function', 'lib/secret-scan.ts exports awsSecretMatch')
  return awsSecretMatch!
}

/** A fabricated 40 character value of the rule's class (the documentation example). */
const AWS_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'

/**
 * `count` lines from a seeded generator, so a failure repeats. Most lines hold one to four tries at the rule: what
 * comes before aws (a word character, =, the line start, a letter look-alike), aws in several cases, 0 to 31
 * characters to the separator (now and then a line break among them, and up to 33 UTF-16 units when letters outside
 * the basic set are among them), each separator and some that are not, then a run of 39, 40, 41 or 80 value
 * characters, a placeholder, or a run broken by a character outside the class. The rest are a soup of the same
 * pieces in any order.
 */
function awsLines(count: number, seed: number): string[] {
  let state = seed
  const next = () => (state = (Math.imul(state, 1103515245) + 12345) & 0x7fffffff) / 2147483648
  function pick<T>(list: readonly T[]): T {
    return list[Math.floor(next() * list.length)]!
  }
  const VALUE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789/+=/+='
  const run = (length: number, alphabet = VALUE) => {
    let out = ''
    for (let k = 0; k < length; k++) out += alphabet[Math.floor(next() * alphabet.length)]
    return out
  }
  // Characters that are not \s, though some look like spaces or count as spaces elsewhere. Then odd ones: letters whose
  // case changes length, a dotless i, a letter outside the basic set (two UTF-16 units), a lone half of such a pair,
  // and the ASCII characters just outside A-Z and a-z.
  const NOT_SPACES = ['\u180e', '\u0085', '\u200b', '\u001c', '\u001f', '\u2060', '\u00ad']
  const ODD = ['\u0130', '\u00df', '\ufb00', '\u0131', '\ud835\udc00', '\ud800', '@', '[', '`', '{']
  const BEFORE = ['', '', '', 'x', '_', '7', '=', '=', ' ', '"', '-', '/', '+', '\u017f', '\u212a', '\r', ...ODD]
  const NAMES = ['aws', 'aws', 'AWS', 'aWs', 'Aws', 'awS', 'aw\u017f', 'awz']
  const WINDOW = `abcXYZ019_-.,;#()=:"' \t\u00a0\u3000/+=\u017f\v\f\u1680\u2000\u2005\u200a\u202f\u205f\ufeff${NOT_SPACES.join('')}${ODD.join('')}`
  const WINDOWS = ['_secret_access_key ', '_SECRET_ACCESS_KEY', '_secret_access_key\r', '.secretAccessKey', ' secret key is', '_secret\u2028']
  const SEPARATORS = ["'", '"', '=', ':', ' ', '\t', '\u00a0', '\u2028', '\u2029', '\r', '\n', '\v', '\f', '\u1680', '\u202f', '\u205f', '\u3000', '\ufeff', ';', '-', '_', 'a', '/', '', '*', '<', '>', ',', ...NOT_SPACES]
  const separator = () => (next() < 0.1 ? String.fromCharCode(0x2000 + Math.floor(next() * 12)) : pick(SEPARATORS))
  const window = () => {
    if (next() < 0.2) return pick(WINDOWS)
    // The regex counts UTF-16 units: 14 to 16 letters outside the basic set are 28 to 32 units.
    if (next() < 0.05) return '\ud835\udc00'.repeat(14 + Math.floor(next() * 3)) + pick(['', 'a', '\ud800'])
    let out = run(Math.floor(next() * 32), WINDOW)
    if (out.length > 0 && next() < 0.15) {
      const at = Math.floor(next() * out.length)
      out = out.slice(0, at) + pick(['\r', '\u2028', '\u2029', '\n', '\v', '\f', '\u0085']) + out.slice(at + 1)
    }
    return out
  }
  const mixedCase = (word: string) => [...word].map((c) => (next() < 0.5 ? c.toUpperCase() : c.toLowerCase())).join('')
  const value = () => {
    switch (Math.floor(next() * 16)) {
      case 0: return run(39)
      case 1: return run(41)
      case 2: return run(80)
      case 3: return run(Math.floor(next() * 46))
      case 4: return run(40, '/+=')
      case 5: return run(40, 'xX')
      case 6: return `${mixedCase('example')}${run(33)}`
      case 7: {
        // A placeholder that holds an aws of its own, anywhere in it.
        const k = Math.floor(next() * 30)
        return `${mixedCase('example')}${run(k)}${pick(['=', '/', '+'])}${pick(NAMES)}${run(29 - k)}`
      }
      case 8: return `${run(20)}${pick(['\u017f', '\u212a', '_', '-', '\u00e9', ' ', ...ODD])}${run(19)}`
      // Values that only look like placeholders.
      case 9: return pick([`${run(39, 'xX')}${pick(['y', '0', '/', '='])}`, `${run(3, 'xX')}${run(37)}`, `EXAMPL${run(34)}`, `${run(1)}EXAMPLE${run(32)}`])
      default: return run(40)
    }
  }
  const TAIL = ['', '', '', ' ', '.', ';', '/', '+', '=', 'a', '_', '\r', '\u017f', '"', "'", ':', '@', '[', '`', '{', '*', '<', '>', ',']
  const SOUP = ['=aws', 'aws', 'AWS', ' ', '=', ':', '"', "'", '\t', '\r', '\u2028', '\u00a0', 'x', '_', '9', '/', '+', '\u017f', '\u212a', '\v', '\f', '\u2005', '\u202f', ...NOT_SPACES, ...ODD]
  const soup = (pieces: number) => {
    let out = ''
    for (let k = 0; k < pieces; k++) out += next() < 0.2 ? run(1 + Math.floor(next() * 45)) : pick(SOUP)
    return out
  }
  const lines: string[] = []
  for (let n = 0; n < count; n++) {
    let line = soup(Math.floor(next() * 3))
    if (next() < 0.25) {
      line += soup(1 + Math.floor(next() * 40))
    } else {
      const tries = 1 + Math.floor(next() * 4)
      for (let k = 0; k < tries; k++) {
        line += pick(BEFORE) + pick(NAMES) + window() + separator() + value() + pick(TAIL) + soup(Math.floor(next() * 3))
      }
    }
    lines.push(line)
  }
  return lines
}

test('aws_secret_access_key: the rule keeps the twin regex source, and its own match finds exactly what the regex finds, on 200000 generated lines and on long lines made of them', { timeout: 120_000 }, async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../lib/secret-scan.ts', import.meta.url), 'utf8')
  assert.ok(src.includes(`pattern: ${String(AWS_SECRET_TWIN)},`), 'the aws_secret_access_key rule keeps the backend twin regex source')
  const awsSecretMatch = exportedAwsSecretMatch()
  const lines = awsLines(200_000, 2026)
  const keyed: string[] = []
  const keyless: string[] = []
  const wrong: string[] = []
  for (const line of lines) {
    const want = awsSecretByRegex(line)
    ;(want === null ? keyless : keyed).push(line)
    if (awsSecretMatch(line) !== want) wrong.push(JSON.stringify(line))
  }
  assert.deepEqual(wrong.slice(0, 5), [], `${wrong.length} of ${lines.length} generated lines differ`)
  assert.ok(keyed.length > 1000, `only ${keyed.length} generated lines hold a key`)
  // Long lines, so both read far: 1000 lines with no key joined by a space, then one with a key.
  const wrongLong: string[] = []
  let longLines = 0
  for (let k = 0; k + 1000 <= keyless.length; k += 1000) {
    const line = `${keyless.slice(k, k + 1000).join(' ')} ${keyed[longLines % keyed.length]}`
    longLines++
    if (awsSecretMatch(line) !== awsSecretByRegex(line)) wrongLong.push(`${JSON.stringify(line.slice(0, 60))}... (${line.length})`)
  }
  assert.ok(longLines >= 100, `only ${longLines} long lines`)
  assert.deepEqual(wrongLong.slice(0, 3), [], `${wrongLong.length} of ${longLines} long lines differ`)
  // Through scanText too: the rule reports the lines the regex finds a key on, with the same excerpt.
  const text = lines.slice(0, 20_000).join('\n')
  const want = text.split(/\r?\n/).flatMap((line, i) => {
    const key = awsSecretByRegex(line)
    return key === null ? [] : [`${i + 1}:${maskSecret(key)}`]
  })
  const got = scanText('f.txt', text).filter((f) => f.rule === 'aws_secret_access_key').map((f) => `${f.line}:${f.excerpt}`)
  assert.ok(want.length > 100)
  assert.deepEqual(got, want)
})

test('aws_secret_access_key: keys and near misses give the same answer through its own match and through the regex', () => {
  const awsSecretMatch = exportedAwsSecretMatch()
  const K = AWS_KEY
  const cases: [string, string | null][] = [
    [`aws_secret_access_key = ${K}`, K],
    [`AWS_SECRET_ACCESS_KEY=${K}`, K],
    [`"aws_secret_access_key": "${K}",`, K],
    [`"AWS_SECRET_ACCESS_KEY" : "${K}"`, K],
    [`export AWS_SECRET_ACCESS_KEY='${K}'`, K],
    [`aws_secret_access_key:\t${K}`, K],
    [`aws secret ${K}`, K],
    [`=aws=${K}`, K],
    [`aws_secret_access_key = ${K}_old`, K],
    [`aws${'.'.repeat(30)}=${K}`, K],
    [`aws\r${K}`, K],
    [`aws\u00a0${K}`, K],
    [`aws\u2028${K}`, K],
    [`\u017faws=${K}`, K],
    [`aws=${'x'.repeat(40)} aws=${K}`, K],
    [`AWS_SECRET_ACCESS_KEY=${K} AWS_SECRET_ACCESS_KEY=${'x'.repeat(40)}`, K],
    [`aws ${'a'.repeat(40)} ${K}`, 'a'.repeat(40)],
    [`aws=${'xX'.repeat(20)} aws=${K}`, K],
    [`aws=${'x'.repeat(39)}y`, `${'x'.repeat(39)}y`],
    [`aws=${'x'.repeat(40)}/aws=${K}`, K],
    [`aws${'='.repeat(71)}.`, '='.repeat(40)],
    [`aws\v${K}`, K],
    [`aws\u2005${K}`, K],
    [`aws\u202f${K}`, K],
    [`aws\u205f${K}`, K],
    [`aws\ufeff${K}`, K],
    // The regex counts UTF-16 units: 15 letters outside the basic set are 30.
    [`aws${'\ud835\udc00'.repeat(15)}=${K}`, K],
    [`\u0130aws=${K}`, K],
    // Many placeholders, then a key.
    [`${`aws=${'x'.repeat(40)} `.repeat(2000)}aws=${K}`, K],
    // Near misses.
    [`aws${'\ud835\udc00'.repeat(15)}.=${K}`, null],
    [`aws\u180e${K}`, null],
    [`aws\u0085${K}`, null],
    [`aws\u200b${K}`, null],
    [`aws${'='.repeat(72)}.`, null],
    [`aws_secret_access_key = ${K.slice(1)}`, null],
    [`aws_secret_access_key = ${K}A`, null],
    [`aws key=${K}/`, null],
    [`xaws = ${K}`, null],
    [`_aws = ${K}`, null],
    [`9aws = ${K}`, null],
    [`aws${'.'.repeat(31)}=${K}`, null],
    [`aws\r=${K}`, null],
    [`aws_\r ${K}`, null],
    [`aws;${K}`, null],
    [`aw\u017f=${K}`, null],
    [`aws=${K.slice(0, 20)}\u212a${K.slice(21)}`, null],
    [`aws=${'x'.repeat(40)}`, null],
    [`aws=EXAMPLE${'A'.repeat(33)}`, null],
    // A placeholder that holds aws: the regex looks for its next match after the placeholder, not inside it.
    [`aws=EXAMPLE=aws${'b'.repeat(29)}:${K}`, null],
    // The same, with the inner aws 3 characters from the placeholder's end: a search that starts again anywhere before
    // that end finds the key.
    [`aws=EXAMPLE${'b'.repeat(29)}=aws ${K}`, null],
    [`${K}aws`, null],
  ]
  for (const [line, want] of cases) {
    assert.equal(awsSecretByRegex(line), want, `the regex on ${JSON.stringify(line)}`)
    assert.equal(awsSecretMatch(line), want, JSON.stringify(line))
  }
})

/** The least time of `runs` runs of each call, the calls taken in turn (a busy machine only slows a run down, and the calls share whatever load there is). */
function leastMs(runs: number, ...calls: (() => unknown)[]): number[] {
  const best = calls.map(() => Number.POSITIVE_INFINITY)
  for (let run = 0; run < runs; run++) {
    for (const [k, call] of calls.entries()) {
      const started = performance.now()
      call()
      best[k] = Math.min(best[k]!, performance.now() - started)
    }
  }
  return best
}

/** A call under this many ms is read as this many, so a ratio is not judged on the noise of a few ms. */
const AWS_FLOOR_MS = 10
/** The long line of =aws against ordinary text of the same length. */
const AWS_CRAFTED_RATIO_MAX = 2
/** 4 times as much text: linear work takes about 4 times as long, quadratic work 16 times. */
const AWS_GROWTH_RATIO_MAX = 8

/** Ordinary text that talks about aws, so the rule reads every line of it. */
const AWS_PROSE = [
  'Set the aws region to eu-west-1 before the first deploy, then check the bill on Monday.',
  'The quarterly report shows revenue growth across all regions this year.',
  'Our aws account holds three buckets: reports, invoices and backups.',
  'Ask the team lead before you change a shared setting or a schedule.',
  'Copy the files with aws s3 cp, then compare the counts on both sides.',
  'Never paste a password or an access key into a chat; keep them in the vault.',
  'Meeting notes: launch moved to Thursday, design review stays on Friday.',
  'The aws bill for October came to about the same as September.',
].join('\n')

test('aws_secret_access_key: a long line of =aws before a key is scanned about as fast as ordinary text of its length, and 4 times as much in about 4 times as long', { timeout: 120_000 }, () => {
  const MB = 1024 * 1024
  // Every aws here has a separator after it every 4 characters, each followed by more than 40 value characters, and
  // the key at the end is too far from all of them but the last.
  const crafted = (bytes: number) => `${'=aws'.repeat(bytes / 4)} aws=${AWS_KEY}`
  // 4 MB and 16 MB, so the shorter text alone takes longer than the floor.
  const short = crafted(4 * MB)
  const long = crafted(16 * MB)
  const prose = `${AWS_PROSE}\n`.repeat(Math.ceil(long.length / (AWS_PROSE.length + 1))).slice(0, long.length)
  assert.equal(prose.length, long.length)
  // A placeholder after every aws: the rule reads past each one to the next.
  const placeholders = (bytes: number) => `${`aws=${'x'.repeat(40)} `.repeat(Math.floor(bytes / 45))}aws=${AWS_KEY}`
  const fewer = placeholders(4 * MB)
  const more = placeholders(16 * MB)
  const [proseMs, shortMs, longMs, fewerMs, moreMs] = leastMs(
    3,
    () => scanText('f.txt', prose),
    () => scanText('f.txt', short),
    () => scanText('f.txt', long),
    () => scanText('f.txt', fewer),
    () => scanText('f.txt', more),
  )
  const ms = (value: number | undefined) => Math.round(value!)
  const timings = `ordinary ${ms(proseMs)} ms; =aws ${ms(shortMs)} ms, 4 times as much ${ms(longMs)} ms; placeholders ${ms(fewerMs)} ms, 4 times as many ${ms(moreMs)} ms`
  assert.ok(longMs! / Math.max(proseMs!, AWS_FLOOR_MS) < AWS_CRAFTED_RATIO_MAX, timings)
  assert.ok(longMs! / Math.max(shortMs!, AWS_FLOOR_MS) < AWS_GROWTH_RATIO_MAX, timings)
  assert.ok(moreMs! / Math.max(fewerMs!, AWS_FLOOR_MS) < AWS_GROWTH_RATIO_MAX, timings)
  // The key at the end of each long text is found.
  assert.deepEqual(scanText('f.txt', long).map((f) => `${f.rule} ${f.excerpt}`), [`aws_secret_access_key ${maskSecret(AWS_KEY)}`])
  assert.deepEqual(scanText('f.txt', more).map((f) => `${f.rule} ${f.excerpt}`), [`aws_secret_access_key ${maskSecret(AWS_KEY)}`])
})

test('aws_secret_access_key: scanText takes the rule\'s own match, not the walk over the regex matches', () => {
  const matchAll = String.prototype.matchAll
  let walks = 0
  String.prototype.matchAll = function (this: string, regexp: RegExp) {
    walks++
    return matchAll.call(this, regexp)
  } as typeof String.prototype.matchAll
  let rules: string[] = []
  try {
    // No other rule's hint is in this text.
    rules = rulesHit(`aws = ${AWS_KEY}`)
  } finally {
    String.prototype.matchAll = matchAll
  }
  assert.deepEqual(rules, ['aws_secret_access_key'])
  assert.equal(walks, 0)
})
