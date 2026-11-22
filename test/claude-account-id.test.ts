/**
 * Which Claude account is signed in (lib/claude-account-id.mjs): the proof a switch at the limit
 * stands on. Usage counts as back on a login only when the ACCOUNT changed, never when a file moved.
 *
 * Every run of the CLI here is a fake: nothing signs in or out, and no credential is read.
 *
 * Run: node --import tsx --test test/claude-account-id.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ACCOUNT_READ_CACHE_MS, ACCOUNT_READ_TIMEOUT_MS, accountChanged, accountTokenFrom, agentAccountDir, createCachedAccountReader, readClaudeAccount } from '../lib/claude-account-id.mjs'

const A_UUID = '0b6c1f8e-1111-4aaa-8bbb-000000000001'
const B_UUID = '0b6c1f8e-2222-4aaa-8bbb-000000000002'
const ORG = 'f00dfeed-3333-4ccc-8ddd-000000000003'
const status = (o: Record<string, unknown>) => JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', ...o })

// -- the token: one way, kind tagged -------------------------------------------------------------------

test('the account id from claude auth status --json becomes a one way token; the raw id is never kept', () => {
  const a = accountTokenFrom(status({ accountUuid: A_UUID, orgId: ORG }))
  assert.match(a!, /^account:[0-9a-f]{32}$/)
  assert.ok(!a!.includes(A_UUID) && !a!.includes(ORG))
  assert.equal(accountTokenFrom(status({ accountUuid: A_UUID })), a, 'the same account is the same token')
  assert.notEqual(accountTokenFrom(status({ accountUuid: B_UUID })), a)
  // A preamble before the JSON (a wrapped CLI) is read the way the doctor reads it.
  assert.equal(accountTokenFrom(`note: update available\n${status({ accountUuid: A_UUID })}\n`), a)
})

test('without an account id the organization id is the account, tagged so the two never compare', () => {
  const org = accountTokenFrom(status({ orgId: ORG }))
  assert.match(org!, /^org:[0-9a-f]{32}$/)
  assert.equal(accountTokenFrom(status({ organizationUuid: ORG })), org)
})

test('no account: logged out, no id, prose, an empty answer or a non object', () => {
  for (const out of [
    JSON.stringify({ loggedIn: false, accountUuid: A_UUID }),
    status({}),
    status({ accountUuid: '' }),
    status({ accountUuid: 42 }),
    'Logged in as someone',
    '',
    'null',
    '[]',
    undefined,
  ])
    assert.equal(accountTokenFrom(out as any), null, String(out))
})

// -- the rule: changed only on proof -------------------------------------------------------------------

test('the account changed only when both reads name an account of the same kind and they differ', () => {
  const a = accountTokenFrom(status({ accountUuid: A_UUID }))
  const b = accountTokenFrom(status({ accountUuid: B_UUID }))
  const org = accountTokenFrom(status({ orgId: ORG }))
  assert.equal(accountChanged(a, b), true)
  assert.equal(accountChanged(a, a), false, 'the same account again (or a token refresh) is no change')
  assert.equal(accountChanged(a, null), false, 'a failed read now is no proof')
  assert.equal(accountChanged(null, b), false, 'no account seen at the limit is no proof')
  assert.equal(accountChanged(a, org), false, 'an account id against an organization id proves nothing')
  assert.equal(accountChanged('account:x', 'account:y'), false, 'only tokens this module made count')
})

// -- the reader: a fake CLI ------------------------------------------------------------------------------

type Call = { file: string; args: string[]; options: any }
function fakeRun(answers: Record<string, any>) {
  const calls: Call[] = []
  const run: any = (file: string, args: string[], options: any) => {
    calls.push({ file, args, options })
    const key = args.includes('--version') ? 'version' : args.join(' ').includes('auth status --json') ? 'status' : 'other'
    const a = answers[key]
    if (a === undefined) throw new Error(`the reader ran something it may not: ${file} ${args.join(' ')}`)
    return typeof a === 'function' ? a() : a
  }
  return { run, calls }
}
const OK_VERSION = { status: 0, stdout: '2.1.320 (Claude Code)\n' }
const env = { PATH: '/usr/bin', HOME: '/home/kc', CLAUDE_CONFIG_DIR: '/elsewhere', ANTHROPIC_API_KEY: 'sk-never', CLAUDE_CODE_OAUTH_TOKEN: 'never' }

test('a read names the account of the config folder the agent launched with, from home, and only ever asks for status', () => {
  const { run, calls } = fakeRun({ version: OK_VERSION, status: { status: 0, stdout: status({ accountUuid: A_UUID }) } })
  const got = readClaudeAccount({ env, home: '/home/kc', configDir: '/home/kc/.bgos-agent/helper-accounts/x', platform: 'linux', run })
  assert.deepEqual(got, { ok: true, token: accountTokenFrom(status({ accountUuid: A_UUID })) })
  for (const c of calls) {
    assert.ok(['--version', 'auth status --json'].includes(c.args.join(' ')), c.args.join(' '))
    assert.equal(c.options.cwd, '/home/kc')
    assert.equal(c.options.timeout, ACCOUNT_READ_TIMEOUT_MS)
    assert.equal(c.options.env.CLAUDE_CONFIG_DIR, '/home/kc/.bgos-agent/helper-accounts/x')
    assert.equal(c.options.env.ANTHROPIC_API_KEY, undefined, 'a key in the environment never answers for the login')
    assert.equal(c.options.env.CLAUDE_CODE_OAUTH_TOKEN, undefined)
  }
  assert.equal(env.CLAUDE_CONFIG_DIR, '/elsewhere', "the caller's environment is not changed")
})

test('an agent launched without a config folder is read without one (on macOS the folder picks the Keychain item)', () => {
  const { run, calls } = fakeRun({ version: OK_VERSION, status: { status: 0, stdout: status({ accountUuid: A_UUID }) } })
  assert.equal(readClaudeAccount({ env, home: '/home/kc', configDir: null, platform: 'darwin', run }).ok, true)
  assert.ok(calls.every((c) => !('CLAUDE_CONFIG_DIR' in c.options.env)))
})

test('a failed or timed out read names no account, so nothing is pressed', () => {
  const timedOut = { status: null, signal: 'SIGTERM', error: Object.assign(new Error('spawnSync claude ETIMEDOUT'), { code: 'ETIMEDOUT' }), stdout: '' }
  const cases: Array<[string, Record<string, any>, string]> = [
    ['status timed out', { version: OK_VERSION, status: timedOut }, 'timed_out'],
    ['version timed out', { version: timedOut }, 'timed_out'],
    ['status exit 1 (logged out)', { version: OK_VERSION, status: { status: 1, stdout: JSON.stringify({ loggedIn: false }) } }, 'failed'],
    ['status threw', { version: OK_VERSION, status: () => { throw new Error('boom') } }, 'failed'],
    ['status unparsable', { version: OK_VERSION, status: { status: 0, stdout: 'garbage' } }, 'no_account'],
    ['old CLI: auth status is never run', { version: { status: 0, stdout: '2.1.316 (Claude Code)\n' } }, 'unsupported_version'],
    ['no CLI', { version: { status: null, error: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }), stdout: '' } }, 'unsupported_version'],
  ]
  for (const [name, answers, why] of cases) {
    const { run } = fakeRun(answers)
    assert.deepEqual(readClaudeAccount({ env, home: '/home/kc', configDir: null, platform: 'linux', run }), { ok: false, why }, name)
  }
})

test('the login folder of an agent is the one its transcript is read from: the recipe folder, else the inherited one', () => {
  assert.equal(agentAccountDir('/saved/x', { CLAUDE_CONFIG_DIR: '/env' }), '/saved/x')
  assert.equal(agentAccountDir('  ', { CLAUDE_CONFIG_DIR: '/env' }), '/env', 'an empty recipe folder falls back like the transcript does')
  assert.equal(agentAccountDir(null, { CLAUDE_CONFIG_DIR: ' /env ' }), '/env')
  assert.equal(agentAccountDir(undefined, {}), null, 'none: the default folder, not named')
})

test('a slow or failing CLI is run at most once a minute per folder: the answer, failures too, is kept that long', () => {
  let at = 1_000_000
  let runs = 0
  let answer: any = { ok: false, why: 'timed_out' }
  const read = createCachedAccountReader({ read: () => (runs++, answer), now: () => at })
  const one = { configDir: '/a', platform: 'linux' }
  assert.deepEqual(read(one), { ok: false, why: 'timed_out' })
  answer = { ok: true, token: 'account:' + '1'.repeat(32) }
  assert.deepEqual(read(one), { ok: false, why: 'timed_out' }, 'a failure is remembered, so nothing is pressed on it either')
  read({ configDir: '/b', platform: 'linux' })
  assert.equal(runs, 2, 'another folder is its own read')
  at += ACCOUNT_READ_CACHE_MS
  assert.equal(read(one).ok, true)
  assert.equal(runs, 3)
  const throws = createCachedAccountReader({ read: () => { throw new Error('boom') }, now: () => at })
  assert.deepEqual(throws(one), { ok: false, why: 'failed' })
})
