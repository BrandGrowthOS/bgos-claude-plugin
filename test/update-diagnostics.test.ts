/**
 * lib/update-diagnostics.mjs: the P3 failure-signature client (design 1.6,
 * 7.5). Two things are pinned here and both are security-relevant:
 *
 *   1. scrubDiagnostics leaves NOTHING secret or identifying in the bundle:
 *      pairing tokens, api keys, bearer/JWT strings, long hex/base64 runs,
 *      values of secret-named keys, the home directory, /Users/<x>,
 *      /home/<x>, C:\Users\<x>, and the OS username. The assertions run on
 *      the SERIALIZED output, because that is what leaves the machine.
 *   2. buildFailureDiagnostics yields a stable signature whose cause is
 *      `<failedStep.kind>:<machine token>`, never free text, so the backend
 *      can hash it into one row per distinct failure rather than one per
 *      click.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DIAGNOSTICS_MAX_BYTES,
  DIAGNOSTICS_MAX_ARRAY_ITEMS,
  DIAGNOSTICS_MAX_STRING_CHARS,
  buildFailureDiagnostics,
  failureToken,
  postFailureDiagnostics,
  scrubDiagnostics,
  scrubString,
} from '../lib/update-diagnostics.mjs'

const HOME_WIN = 'C:\\Users\\karim'
const HOME_MAC = '/Users/fitecho'
const PAIR_TOKEN = 'pair_Zk3xQ9vL2mN8pR4sT7uW1yA5bC6dE0fG9hJ2kL4mN6pQ'
const SESSION_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiI4NzEiLCJpYXQiOjE3MjQ1fQ.s3cr3tS1gnatur3Valu3Here'
const API_KEY = 'sk-ant-api03-Abcdefghijklmnopqrstuvwxyz0123456789abcdefghij'
const HEX_TOKEN = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'
const B64URL_TOKEN = 'Zk3xQ9vL2mN8pR4sT7uW1yA5bC6dE0fG9hJ2kL4mN6pQrS8t'

test('scrubString: secrets from the secret-scan ruleset are masked', () => {
  const opts = { home: HOME_MAC, username: 'fitecho' }
  const cases: Array<[string, string]> = [
    [`key ${API_KEY} in stderr`, API_KEY],
    ['token=' + PAIR_TOKEN, PAIR_TOKEN],
    [`Authorization: Bearer ${B64URL_TOKEN}`, B64URL_TOKEN],
    [`session ${SESSION_TOKEN} expired`, SESSION_TOKEN],
    ['AKIAIOSFODNN7EXAMPLE leaked', 'AKIAIOSFODNN7EXAMPLE'],
    ['ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
    ['postgres://bgos:hunter2pw@db.example/x', 'hunter2pw'],
    [`sha ${HEX_TOKEN}`, HEX_TOKEN],
    [`X-BGOS-Pairing: ${PAIR_TOKEN}`, PAIR_TOKEN],
    ['-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----', 'MIIEow'],
  ]
  for (const [input, secret] of cases) {
    const out = scrubString(input, opts)
    assert.ok(!out.includes(secret), `still contains the secret: ${out}`)
    assert.ok(out.includes('<redacted>'), `no redaction marker: ${out}`)
  }
})

test('scrubString: a bare pairing token anywhere in prose is masked', () => {
  const out = scrubString(`daemon said ${PAIR_TOKEN} was rejected`, { home: HOME_MAC, username: 'fitecho' })
  assert.ok(!out.includes(PAIR_TOKEN))
  assert.equal(out, 'daemon said <redacted> was rejected')
})

test('scrubString: home directories and user folders collapse to ~ and the username to <user>', () => {
  const win = scrubString(
    `cannot write C:\\Users\\karim\\.bgos-agent\\watcher\\credentials.json (user karim)`,
    { home: HOME_WIN, username: 'karim' },
  )
  assert.ok(!win.includes('karim'), win)
  assert.ok(win.includes('~\\.bgos-agent\\watcher\\credentials.json'), win)
  assert.ok(win.includes('<user>'), win)

  const mac = scrubString(`/Users/fitecho/agents/athena and /home/fitecho/x`, {
    home: HOME_MAC,
    username: 'fitecho',
  })
  assert.ok(!mac.includes('fitecho'), mac)
  assert.equal(mac, '~/agents/athena and ~/x')

  // A foreign user folder (not this home) is still collapsed: it identifies someone.
  const other = scrubString('/Users/someoneelse/project', { home: HOME_MAC, username: 'fitecho' })
  assert.equal(other, '~/project')
  const forward = scrubString('C:/Users/Karim/proj', { home: HOME_WIN, username: 'karim' })
  assert.equal(forward, '~/proj')
})

test('scrubString: ordinary text, versions, step tokens and short ids survive untouched', () => {
  const opts = { home: HOME_MAC, username: 'fitecho' }
  for (const plain of [
    'update_plugin: exit 1',
    'already at the latest version (0.38.3)',
    'version_mismatch: expected 0.39.0, installed 0.38.3',
    'hoai@hoai',
    'plugins/cache/hoai/hoai/0.38.3',
    'a8f2c1',
  ]) {
    assert.equal(scrubString(plain, opts), plain)
  }
})

test('scrubString: caps at the string limit with a marker', () => {
  const out = scrubString('x'.repeat(DIAGNOSTICS_MAX_STRING_CHARS + 500), { home: '', username: '' })
  assert.ok(out.length <= DIAGNOSTICS_MAX_STRING_CHARS + 20)
  assert.ok(out.endsWith('[truncated]'))
})

test('scrubDiagnostics: secret-named keys lose their values whatever the shape', () => {
  const out = scrubDiagnostics(
    {
      token: 'short',
      apiKey: 'k',
      api_key: 'k2',
      Authorization: 'Basic abc',
      cookie: 'sid=1',
      clientSecret: 'x',
      password: 'p',
      pairingToken: PAIR_TOKEN,
      nested: { access_token: 'y', keep: 'fine' },
      list: [{ secret: 'z', ok: 1 }],
    },
    { home: HOME_MAC, username: 'fitecho' },
  ) as Record<string, unknown>
  const json = JSON.stringify(out)
  for (const leaked of ['short', '"k"', 'k2', 'Basic abc', 'sid=1', '"x"', '"p"', PAIR_TOKEN, '"y"', '"z"']) {
    assert.ok(!json.includes(leaked), `leaked ${leaked}: ${json}`)
  }
  assert.equal((out.nested as Record<string, unknown>).keep, 'fine')
  assert.equal((out.list as Array<Record<string, unknown>>)[0]!.ok, 1)
  assert.equal(out.token, '<redacted>')
})

test('scrubDiagnostics: the seeded bundle leaves with none of the secrets or identities', () => {
  const bundle = {
    signature: { cause: 'update_plugin:exit_1', installMethod: 'marketplace', platform: 'win32' },
    steps: [
      { id: 's3', kind: 'update_plugin', state: 'failed', message: `stderr: fetch failed for ${API_KEY} at C:\\Users\\karim\\.claude\\plugins` },
      { id: 's4', kind: 'rollback', state: 'ok', message: `restored /Users/fitecho/.claude/plugins/cache using ${PAIR_TOKEN}` },
    ],
    context: {
      cliVersion: '2.1.241',
      env: { HOME: 'C:\\Users\\karim', USERNAME: 'karim', BGOS_PAIRING_TOKEN: PAIR_TOKEN },
      note: `owner karim, jwt ${SESSION_TOKEN}, hex ${HEX_TOKEN}`,
    },
  }
  const out = scrubDiagnostics(bundle, { home: HOME_WIN, username: 'karim' })
  const json = JSON.stringify(out)
  for (const forbidden of [PAIR_TOKEN, API_KEY, SESSION_TOKEN, HEX_TOKEN, 'karim', 'fitecho', 'C:\\\\Users\\\\', '/Users/']) {
    assert.ok(!json.includes(forbidden), `bundle still carries ${forbidden}: ${json}`)
  }
  // The structure and the harmless facts survive.
  const o = out as typeof bundle
  assert.equal(o.signature.cause, 'update_plugin:exit_1')
  assert.equal(o.context.cliVersion, '2.1.241')
  assert.equal(o.steps[0]!.kind, 'update_plugin')
})

test('scrubDiagnostics: arrays cap at the item limit and the total size stays under the byte cap with a marker', () => {
  const many = Array.from({ length: DIAGNOSTICS_MAX_ARRAY_ITEMS + 50 }, (_, i) => ({ id: `s${i}`, kind: 'x', state: 'ok' }))
  const capped = scrubDiagnostics({ steps: many }, { home: '', username: '' }) as { steps: unknown[] }
  assert.equal(capped.steps.length, DIAGNOSTICS_MAX_ARRAY_ITEMS)

  const huge = {
    signature: { cause: 'install_plugin:timeout', installMethod: 'marketplace', platform: 'linux' },
    steps: Array.from({ length: 200 }, (_, i) => ({ id: `s${i}`, kind: 'install_plugin', state: 'failed', message: 'm'.repeat(1500) })),
    context: { blob: 'b'.repeat(1900) },
  }
  const out = scrubDiagnostics(huge, { home: '', username: '' }) as Record<string, unknown>
  const bytes = Buffer.byteLength(JSON.stringify(out), 'utf8')
  assert.ok(bytes <= DIAGNOSTICS_MAX_BYTES, `serialized ${bytes} bytes`)
  assert.equal(out.truncated, true)
  // The signature is the one part that must never be dropped.
  assert.deepEqual(out.signature, huge.signature)
})

test('scrubDiagnostics: non-object values, cycles and odd types never throw', () => {
  const opts = { home: HOME_MAC, username: 'fitecho' }
  assert.equal(scrubDiagnostics(null, opts), null)
  assert.equal(scrubDiagnostics(42, opts), 42)
  assert.equal(scrubDiagnostics(`/Users/fitecho`, opts), '~')
  const cyclic: Record<string, unknown> = { a: 1 }
  cyclic.self = cyclic
  const out = scrubDiagnostics(cyclic, opts) as Record<string, unknown>
  assert.equal(out.a, 1)
  assert.equal(out.self, '<cycle>')
  const odd = scrubDiagnostics({ d: new Date(0), f: () => 1, u: undefined, big: 10n, e: new Error('boom at /Users/fitecho/x') }, opts) as Record<string, unknown>
  assert.equal(typeof odd.d, 'string')
  assert.equal(odd.f, undefined)
  assert.equal(odd.big, '10')
  assert.ok(String(odd.e).includes('~/x'))
})

test('failureToken: a short machine word, never free text', () => {
  const cases: Array<[unknown, string]> = [
    ['version_mismatch: expected 0.39.0 got 0.38.3', 'version_mismatch'],
    ['rollback_impossible', 'rollback_impossible'],
    ['agent_deaf_after_update (871)', 'agent_deaf_after_update'],
    ['command timed out after 120000ms', 'timeout'],
    ['ETIMEDOUT', 'timeout'],
    ['claude exited with code 1: Plugin "nope" not found', 'exit_1'],
    ['Plugin "nope" not found', 'not_found'],
    ['ENOENT: no such file or directory', 'not_found'],
    ['EACCES: permission denied, open x', 'permission_denied'],
    ['spawn claude ENOENT', 'not_found'],
    ['garbage output from claude plugin list', 'garbage_output'],
    ['fetch failed: getaddrinfo ENOTFOUND github.com', 'network'],
    ['ENOSPC: no space left on device', 'disk_full'],
    ['something completely unexpected happened here', 'failed'],
    ['', 'failed'],
    [undefined, 'failed'],
    [null, 'failed'],
    [{ weird: true }, 'failed'],
  ]
  for (const [message, token] of cases) {
    assert.equal(failureToken(message), token, `for ${String(message)}`)
  }
  // Always a bounded snake_case token.
  for (const [message] of cases) {
    assert.match(failureToken(message), /^[a-z][a-z0-9_]{0,48}$/)
  }
})

test('buildFailureDiagnostics: signature + steps + context, cause from the failing step, scrubbed', () => {
  const plan = {
    verdict: 'plan',
    targetVersion: '0.39.0',
    steps: [
      { id: 's1', kind: 'snapshot', onFailure: 'stop', why: 'x' },
      { id: 's2', kind: 'refresh_marketplace', onFailure: 'continue', why: 'x' },
      { id: 's3', kind: 'update_plugin', onFailure: 'escalate', why: 'x' },
    ],
  }
  const result = {
    ok: false,
    failedStep: { id: 's3', kind: 'update_plugin', message: `claude exited with code 1: token ${PAIR_TOKEN} at /Users/fitecho/.claude` },
    rolledBack: true,
    targetVersion: '0.39.0',
    installedVersion: '0.38.3',
    steps: [
      { id: 's1', kind: 'snapshot', state: 'ok' },
      { id: 's2', kind: 'refresh_marketplace', state: 'ok' },
      { id: 's3', kind: 'update_plugin', state: 'failed', message: `exit 1 ${PAIR_TOKEN}` },
    ],
  }
  const diag = buildFailureDiagnostics({
    plan,
    result,
    state: { runningVersion: '0.38.3', agents: [{ assistantId: '871', cwd: '/Users/fitecho/agents/athena' }] },
    platform: 'darwin',
    installMethod: 'marketplace',
    pluginVersion: '0.38.3',
    targetVersion: '0.39.0',
    cliVersion: '2.1.241',
    nodeVersion: 'v22.1.0',
    home: HOME_MAC,
    username: 'fitecho',
  })
  assert.deepEqual(diag.signature, {
    cause: 'update_plugin:exit_1',
    installMethod: 'marketplace',
    platform: 'darwin',
    pluginVersion: '0.38.3',
    targetVersion: '0.39.0',
  })
  assert.deepEqual(
    diag.steps.map((s) => [s.id, s.kind, s.state]),
    [
      ['s1', 'snapshot', 'ok'],
      ['s2', 'refresh_marketplace', 'ok'],
      ['s3', 'update_plugin', 'failed'],
    ],
  )
  assert.equal(diag.context.cliVersion, '2.1.241')
  assert.equal(diag.context.nodeVersion, 'v22.1.0')
  assert.equal(diag.context.rolledBack, true)
  const json = JSON.stringify(diag)
  assert.ok(!json.includes(PAIR_TOKEN))
  assert.ok(!json.includes('fitecho'))
  assert.ok(!json.includes('/Users/'))
})

test('buildFailureDiagnostics: falls back to the plan when the result carries no steps, and to unknowns when fields are missing', () => {
  const diag = buildFailureDiagnostics({
    plan: { steps: [{ id: 'a', kind: 'install_plugin' }] },
    result: { ok: false },
    platform: 'linux',
    installMethod: 'clone',
    home: '',
    username: '',
  })
  assert.equal(diag.signature.cause, 'unknown:failed')
  assert.equal(diag.signature.pluginVersion, null)
  assert.equal(diag.signature.targetVersion, null)
  assert.deepEqual(diag.steps, [{ id: 'a', kind: 'install_plugin', state: 'unknown' }])
  assert.equal(diag.context.watcherVersion, undefined)
})

test('buildFailureDiagnostics: never throws on garbage input', () => {
  const diag = buildFailureDiagnostics({ plan: null, result: 'nope', platform: 7, installMethod: null, home: '', username: '' } as never)
  assert.equal(diag.signature.cause, 'unknown:failed')
  assert.deepEqual(diag.steps, [])
})

test('postFailureDiagnostics: posts to integrations/update-failures and never throws', async () => {
  const calls: Array<{ path: string; body: unknown }> = []
  const ok = await postFailureDiagnostics(async (path: string, body: unknown) => {
    calls.push({ path, body })
    return {}
  }, { signature: { cause: 'x:y' } })
  assert.equal(ok, true)
  assert.equal(calls[0]!.path, 'integrations/update-failures')
  assert.deepEqual(calls[0]!.body, { signature: { cause: 'x:y' } })

  const failed = await postFailureDiagnostics(async () => {
    throw new Error('backend down')
  }, { signature: { cause: 'x:y' } })
  assert.equal(failed, false)
  const nothing = await postFailureDiagnostics(null as never, { signature: { cause: 'x:y' } })
  assert.equal(nothing, false)
})
