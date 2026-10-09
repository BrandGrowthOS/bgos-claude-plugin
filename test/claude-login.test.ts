/**
 * The shared Claude login state (lib/claude-login.ts, BGOS board row
 * e5d0fb3a). Fixture texts are the EXACT strings found in real transcripts on
 * 2026-10-09 (90 authentication_failed records, the 2026-09-03 outage among
 * them), in the envelope the CLI writes them in.
 *
 * Run with:  npm test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CLAUDE_LOGIN_EXPIRED_CODE,
  CLAUDE_USAGE_LIMIT_CODE,
  ClaudeLoginWatcher,
  LOGIN_OK,
  LOGIN_STALE_MS,
  claudeAccountFile,
  claudeAccountKey,
  extractLoginSignal,
  heartbeatClaudeAccountError,
  pickAccountAwareLastError,
  readClaudeAccountLabel,
  reduceLoginState,
} from '../lib/claude-login.ts'
import { mungeCwd } from '../lib/usage-report.ts'
import { heartbeatEnv } from '../lib/version-heartbeat.ts'

const NOW = Date.parse('2026-10-09T12:00:00.000Z')
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString()

const REAL_TEXTS = [
  'Login expired · Please run /login',
  'Failed to authenticate: OAuth session expired and could not be refreshed',
  'Please run /login · API Error: 401 OAuth access token has expired. Re-authenticate to continue.',
  'Not logged in · Please run /login',
  'Please run /login · API Error: 401 Invalid authentication credentials',
]

function apiError(error: string, text: string, msAgo = 1000, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'assistant',
    isApiErrorMessage: true,
    error,
    timestamp: iso(msAgo),
    message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text }] },
    ...extra,
  })
}
function turn(msAgo = 500, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: iso(msAgo),
    message: { model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
    ...extra,
  })
}

test('every real login failure text is a login_failed signal, keyed on the error field', () => {
  for (const text of REAL_TEXTS) {
    const s = extractLoginSignal(apiError('authentication_failed', text) + '\n', NOW)
    assert.equal(s?.type, 'login_failed', text)
    assert.equal(s?.type === 'login_failed' && s.text, text)
  }
})

test('a usage cap, a server error and a transient 429 are NOT login failures', () => {
  for (const [error, text] of [
    ['rate_limit', "You've hit your session limit · resets 7:40pm (Asia/Dubai)"],
    ['rate_limit', 'API Error: Request rejected (429) · Rate limited'],
    ['server_error', 'API Error: 500'],
    ['invalid_request', 'Please run /login'],
  ]) {
    assert.equal(extractLoginSignal(apiError(error!, text!) + '\n', NOW), null, `${error}: ${text}`)
  }
})

test('the last signal wins: a real turn after the failure is activity', () => {
  const chunk = [apiError('authentication_failed', REAL_TEXTS[0]!, 5000), turn(1000)].join('\n') + '\n'
  assert.equal(extractLoginSignal(chunk, NOW)?.type, 'activity')
  const back = [turn(5000), apiError('authentication_failed', REAL_TEXTS[0]!, 1000)].join('\n') + '\n'
  assert.equal(extractLoginSignal(back, NOW)?.type, 'login_failed')
})

test('stale records never signal (a resumed session replays history with old times)', () => {
  assert.equal(extractLoginSignal(apiError('authentication_failed', REAL_TEXTS[0]!, LOGIN_STALE_MS + 1000) + '\n', NOW), null)
  assert.equal(extractLoginSignal(turn(LOGIN_STALE_MS + 1000) + '\n', NOW), null)
})

test('sidechain activity and synthetic records are not activity; a sidechain failure still counts', () => {
  assert.equal(extractLoginSignal(turn(500, { isSidechain: true }) + '\n', NOW), null)
  assert.equal(
    extractLoginSignal(apiError('authentication_failed', REAL_TEXTS[0]!, 500, { isSidechain: true }) + '\n', NOW)?.type,
    'login_failed',
  )
  const synthetic = JSON.stringify({
    type: 'assistant',
    timestamp: iso(500),
    message: { model: '<synthetic>', content: [{ type: 'text', text: 'x' }] },
  })
  assert.equal(extractLoginSignal(synthetic + '\n', NOW), null)
})

test('a control character in the text cannot reach the backend as a second line', () => {
  const s = extractLoginSignal(apiError('authentication_failed', 'Login expired\nINJECTED') + '\n', NOW)
  assert.equal(s?.type === 'login_failed' && s.text, 'Login expired INJECTED')
})

test('reduceLoginState keeps the FIRST failure time and clears only on activity', () => {
  const a = reduceLoginState(LOGIN_OK, { type: 'login_failed', at: NOW - 5000, text: 'Login expired' })
  assert.deepEqual(a, { failing: true, since: NOW - 5000, text: 'Login expired' })
  const b = reduceLoginState(a, { type: 'login_failed', at: NOW - 1000, text: 'Not logged in' })
  assert.equal(b.since, NOW - 5000, 'a retry does not walk the outage start forward')
  assert.equal(reduceLoginState(b, null), b, 'silence changes nothing: a dead login stays dead')
  assert.deepEqual(reduceLoginState(b, { type: 'activity', at: NOW }), LOGIN_OK)
})

test('heartbeat error: an expired login, then a live usage cap, then nothing', () => {
  const failing = { failing: true, since: NOW - 60_000, text: 'Login expired · Please run /login' }
  const cap = { resetAt: new Date(NOW + 3_600_000).toISOString(), synthetic: false }
  const e1 = heartbeatClaudeAccountError({ login: failing, resting: cap, now: NOW })
  assert.equal(e1?.code, CLAUDE_LOGIN_EXPIRED_CODE, 'the expiry outranks the cap')
  assert.equal(e1?.at, new Date(NOW - 60_000).toISOString())
  assert.match(e1!.message, /run \/login/)
  assert.ok(e1!.message.length <= 300)

  const e2 = heartbeatClaudeAccountError({ login: LOGIN_OK, resting: cap, now: NOW })
  assert.equal(e2?.code, CLAUDE_USAGE_LIMIT_CODE)
  assert.match(e2!.message, new RegExp(cap.resetAt))

  const over = { resetAt: new Date(NOW - 1).toISOString(), synthetic: false }
  assert.equal(heartbeatClaudeAccountError({ login: LOGIN_OK, resting: over, now: NOW }), null, 'an elapsed cap is over')
  assert.equal(heartbeatClaudeAccountError({ login: LOGIN_OK, resting: null, now: NOW }), null)

  const long = { failing: true, since: NOW, text: 'x'.repeat(400) }
  assert.ok(heartbeatClaudeAccountError({ login: long, resting: null, now: NOW })!.message.length <= 300)
})

test('lastError order: refused BGOS credential, then Claude account, then deafness', () => {
  const auth = { code: 'auth_rejected', message: 'a', at: 'x' }
  const acct = { code: CLAUDE_LOGIN_EXPIRED_CODE, message: 'b', at: 'x' }
  const deaf = { code: 'session_unresponsive', message: 'c', at: 'x' }
  assert.equal(pickAccountAwareLastError(auth, acct, deaf), auth)
  assert.equal(pickAccountAwareLastError(null, acct, deaf), acct)
  assert.equal(pickAccountAwareLastError(null, null, deaf), deaf)
  assert.equal(pickAccountAwareLastError(null, null, null), null)
})

test('the account key is stable, 12 hex, and differs per credential store', () => {
  const a = claudeAccountKey('/Users/kc/.claude')
  assert.match(a, /^[a-f0-9]{12}$/)
  assert.equal(claudeAccountKey('/Users/kc/.claude'), a)
  assert.notEqual(claudeAccountKey('/Users/kc/.claude-workhorse'), a)
})

test('the account file is ~/.claude.json by default and inside CLAUDE_CONFIG_DIR when set', () => {
  // path.join, not a literal: on Windows the separator is a backslash.
  assert.equal(claudeAccountFile({ env: {}, home: '/h', configDir: '/h/.claude' }), join('/h', '.claude.json'))
  assert.equal(
    claudeAccountFile({ env: { CLAUDE_CONFIG_DIR: '/h/.w' }, home: '/h', configDir: '/h/.w' }),
    join('/h/.w', '.claude.json'),
  )
})

test('the account label is the email, bounded, and never a throw', () => {
  const read = (body: string) => () => body
  assert.equal(readClaudeAccountLabel('x', read(JSON.stringify({ oauthAccount: { emailAddress: 'kc@example.com' } }))), 'kc@example.com')
  assert.equal(readClaudeAccountLabel('x', read(JSON.stringify({ oauthAccount: {} }))), null)
  assert.equal(readClaudeAccountLabel('x', read('not json')), null)
  assert.equal(readClaudeAccountLabel('x', () => { throw new Error('ENOENT') }), null)
  assert.equal(readClaudeAccountLabel('x', read(JSON.stringify({ oauthAccount: { emailAddress: 'a\nb' + 'c'.repeat(300) } })))!.length, 120)
})

test('heartbeatEnv carries the account only in the shapes the backend accepts', () => {
  const proc = { cwd: () => '/a', platform: 'darwin' }
  const env = heartbeatEnv(proc, { claudeAccount: () => ({ key: 'abcdef012345', label: 'kc@example.com' }) })
  assert.equal(env.claudeAccountKey, 'abcdef012345')
  assert.equal(env.claudeAccountLabel, 'kc@example.com')
  const bad = heartbeatEnv(proc, { claudeAccount: () => ({ key: '/Users/kc', label: 'kc@example.com' }) })
  assert.equal(bad.claudeAccountKey, undefined)
  assert.equal(bad.claudeAccountLabel, undefined, 'no label without a key to group it under')
  const throws = heartbeatEnv(proc, { claudeAccount: () => { throw new Error('x') } })
  assert.equal(throws.platform, 'darwin', 'an unreadable account never costs the rest of the env')
  assert.equal(heartbeatEnv(proc).claudeAccountKey, undefined)
})

test('ClaudeLoginWatcher reads only appended bytes, from a fresh startup tail', () => {
  const home = mkdtempSync(join(tmpdir(), 'claude-login-'))
  const cwd = '/Users/kc/agents/athena'
  const dir = join(home, 'projects', mungeCwd(cwd))
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 's1.jsonl')
  // A failure from BEFORE this process, still fresh: the startup tail sees it.
  writeFileSync(file, apiError('authentication_failed', REAL_TEXTS[0]!, 2000) + '\n')
  const w = new ClaudeLoginWatcher(cwd, home)
  assert.equal(w.scan(NOW)?.type, 'login_failed')
  assert.equal(w.scan(NOW), null, 'nothing new, nothing reported')
  // A partial line is left for the next scan.
  appendFileSync(file, turn(500).slice(0, 20))
  assert.equal(w.scan(NOW), null)
  appendFileSync(file, turn(500).slice(20) + '\n')
  assert.equal(w.scan(NOW)?.type, 'activity')
  // A second session file in the same folder is read too.
  writeFileSync(join(dir, 's2.jsonl'), apiError('authentication_failed', REAL_TEXTS[3]!, 100) + '\n')
  assert.equal(w.scan(NOW)?.type, 'login_failed')
})

test('a missing project folder is null, never a throw', () => {
  assert.equal(new ClaudeLoginWatcher('/nowhere', '/definitely/not/here').scan(NOW), null)
})

test('server.ts wires it: a 30s sweep, an immediate beat on a change, the env provider, the /login clear', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../server.ts', import.meta.url), 'utf8')
  assert.match(src, /setInterval\(sweepClaudeLogin, 30_000\)/)
  assert.match(
    src,
    /function sweepClaudeLogin\(\)[\s\S]{0,600}?if \(code !== reportedAccountCode\)[\s\S]{0,300}?versionHeartbeat\?\.sendNow\(\)/,
    'a changed code must be sent at once: the next regular beat is six hours away',
  )
  assert.match(src, /new ClaudeLoginWatcher\(LAUNCH_CWD, CLAUDE_CONFIG_DIR\)/, 'the same folder and config dir as the resting watcher')
  assert.match(src, /resting: observedResting/, 'the usage cap is the resting episode, never classified twice')
  assert.match(src, /claudeAccount: claudeAccountIdentity,/)
  assert.match(src, /onSignedIn: \(\) => \{\s*claudeLoginState = LOGIN_OK\s*sweepClaudeLogin\(\)/)
})
