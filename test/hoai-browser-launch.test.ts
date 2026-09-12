/**
 * hoai-browser-launch tests: the env mapping, the failure paths, and the real
 * resolver script.
 *
 * The launcher is what turns "this folder's HOAI agent" into the HOAI_RELAY_*
 * environment the browser shim reads, so the things worth pinning are: a
 * pairing result maps to the pairing lane and an api-key result to the legacy
 * lane; an incomplete result adds NOTHING (local mode must keep working); an
 * operator's own HOAI_RELAY_* wins untouched; and the bun-side resolver prints
 * exactly one JSON line for a real credentials file. Every IO is injected
 * except that last case, which runs bun for real and is skipped with a reason
 * when bun is not installed on the machine running the suite.
 *
 * Run: npm test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CREDS_TIMEOUT_MS,
  LOG_PREFIX,
  credentialsScriptPath,
  hasOperatorRelayEnv,
  main,
  parseResolverOutput,
  relayEnvFromResolution,
  relayOffMessage,
  resolveRelayEnv,
  shimPath,
} from '../bin/hoai-browser-launch.mjs'
import { resolveBunPath } from '../bin/bgos-launch.mjs'

const BIN = join(process.cwd(), 'bin')

/** A resolver stub: one JSON line on stdout, exit 0, like the real script. */
const resolverPrinting = (payload: unknown, extra: Partial<{ status: number; signal: string; error: Error }> = {}) =>
  (() => ({ status: 0, signal: null, stdout: JSON.stringify(payload) + '\n', stderr: '', ...extra })) as any

const existsAll = () => true

// ── the pure mapping ─────────────────────────────────────────────────────────

test('relayEnvFromResolution: a complete pairing result becomes the pairing lane', () => {
  const { env, reason } = relayEnvFromResolution({
    backendUrl: 'https://api.brandgrowthos.ai/',
    pairingToken: 'pair-abc',
    apiKey: '',
    assistantId: '7',
    mode: 'pairing',
    complete: true,
  })
  assert.equal(reason, null)
  assert.deepEqual(env, { HOAI_RELAY_BACKEND_URL: 'https://api.brandgrowthos.ai', HOAI_RELAY_PAIRING_TOKEN: 'pair-abc' })
  assert.ok(!('HOAI_RELAY_API_KEY' in (env as any)), 'the pairing lane never carries an api key')
  assert.ok(!('HOAI_RELAY_ASSISTANT_ID' in (env as any)), 'the pairing lane never needs the assistant id')
})

test('relayEnvFromResolution: a complete api-key result becomes the legacy lane, assistant id included', () => {
  const { env, reason } = relayEnvFromResolution({
    backendUrl: 'https://api.brandgrowthos.ai',
    pairingToken: '',
    apiKey: 'key-123',
    assistantId: '42',
    mode: 'apikey',
    complete: true,
  })
  assert.equal(reason, null)
  assert.deepEqual(env, {
    HOAI_RELAY_BACKEND_URL: 'https://api.brandgrowthos.ai',
    HOAI_RELAY_API_KEY: 'key-123',
    HOAI_RELAY_ASSISTANT_ID: '42',
  })
  assert.ok(!('HOAI_RELAY_PAIRING_TOKEN' in (env as any)))
})

test('relayEnvFromResolution: incomplete, empty and unknown results add no relay env and say why', () => {
  for (const resolution of [
    { backendUrl: 'https://api.brandgrowthos.ai', pairingToken: 'pair-abc', mode: 'pairing', complete: false },
    { backendUrl: '', pairingToken: 'pair-abc', mode: 'pairing', complete: true },
    { backendUrl: 'https://api.brandgrowthos.ai', pairingToken: '', mode: 'pairing', complete: true },
    { backendUrl: 'https://api.brandgrowthos.ai', apiKey: 'key-123', assistantId: '', mode: 'apikey', complete: true },
    { backendUrl: 'https://api.brandgrowthos.ai', mode: 'something-else', complete: true },
    null,
  ]) {
    const { env, reason } = relayEnvFromResolution(resolution as any)
    assert.equal(env, null, `no relay env for ${JSON.stringify(resolution)}`)
    assert.ok(reason && reason.length > 10, 'a reason a human can read')
    assert.ok(!/pair-abc|key-123/.test(reason as string), 'the reason never quotes a credential')
  }
})

test('relayOffMessage: one attributable line that says local still works and holds no secret', () => {
  const line = relayOffMessage('this agent has no complete HOAI credentials on this machine yet (pair it with hoai-pair)')
  assert.ok(line.startsWith(LOG_PREFIX))
  assert.ok(!line.includes('\n'), 'one line')
  assert.match(line, /relay off/)
  assert.match(line, /desktop app runs on this machine/)
})

test('parseResolverOutput: the last JSON object line wins and noise is ignored', () => {
  assert.deepEqual(parseResolverOutput('{"mode":"pairing"}\n'), { mode: 'pairing' })
  assert.deepEqual(parseResolverOutput('bun: installed 3 packages\n{"mode":"apikey"}\n'), { mode: 'apikey' })
  assert.equal(parseResolverOutput('not json at all\n'), null)
  assert.equal(parseResolverOutput(''), null)
})

test('hasOperatorRelayEnv: only a non-empty backend url counts', () => {
  assert.equal(hasOperatorRelayEnv({ HOAI_RELAY_BACKEND_URL: 'https://x' }), true)
  assert.equal(hasOperatorRelayEnv({ HOAI_RELAY_BACKEND_URL: '   ' }), false)
  assert.equal(hasOperatorRelayEnv({ HOAI_RELAY_PAIRING_TOKEN: 'pair-abc' }), false)
  assert.equal(hasOperatorRelayEnv({}), false)
})

// ── resolveRelayEnv, with the resolver injected ──────────────────────────────

test('resolveRelayEnv: a pre-set HOAI_RELAY_BACKEND_URL wins and the resolver never runs', () => {
  let ran = false
  const r = resolveRelayEnv({
    env: { HOAI_RELAY_BACKEND_URL: 'https://staging.example', HOAI_RELAY_PAIRING_TOKEN: 'operator-token', PATH: '/usr/bin' },
    home: '/home/kc',
    platform: 'linux',
    exists: existsAll,
    dir: BIN,
    spawnSyncImpl: (() => {
      ran = true
      return { status: 0, stdout: '{}', stderr: '', signal: null }
    }) as any,
  })
  assert.equal(ran, false, 'an operator override is never second-guessed')
  assert.deepEqual(r.env, {}, 'nothing is added, so the operator values pass through untouched')
  assert.equal(r.reason, null)
  assert.equal(r.via, 'operator')
})

test('resolveRelayEnv: no bun means no relay, with a reason that names bun', () => {
  const r = resolveRelayEnv({ env: { PATH: '/usr/bin' }, home: '/home/kc', platform: 'linux', exists: () => false, dir: BIN })
  assert.equal(r.env, null)
  assert.match(r.reason as string, /bun was not found/)
  assert.equal(r.via, 'no-bun')
})

test('resolveRelayEnv: a pairing credentials line becomes the pairing lane, and the resolver is run with bun and never given stdin', () => {
  const calls: any[] = []
  const r = resolveRelayEnv({
    env: { PATH: '/usr/bin' },
    home: '/home/kc',
    platform: 'linux',
    exists: existsAll,
    dir: BIN,
    spawnSyncImpl: ((cmd: string, args: string[], opts: any) => {
      calls.push({ cmd, args, opts })
      return { status: 0, signal: null, stdout: JSON.stringify({ backendUrl: 'https://api.brandgrowthos.ai', pairingToken: 'pair-abc', apiKey: '', assistantId: '7', mode: 'pairing', complete: true }) + '\n', stderr: '' }
    }) as any,
  })
  assert.deepEqual(r.env, { HOAI_RELAY_BACKEND_URL: 'https://api.brandgrowthos.ai', HOAI_RELAY_PAIRING_TOKEN: 'pair-abc' })
  assert.equal(r.via, 'resolved')
  assert.equal(calls.length, 1)
  assert.match(calls[0].cmd, /bun(\.exe)?$/)
  assert.deepEqual(calls[0].args, [credentialsScriptPath(BIN)])
  assert.equal(calls[0].opts.timeout, CREDS_TIMEOUT_MS)
  assert.deepEqual(calls[0].opts.stdio, ['ignore', 'pipe', 'pipe'], 'the MCP client owns this process stdin')
})

test('resolveRelayEnv: a timeout, a non-zero exit, a spawn error and unparseable output each turn the relay off with a reason', () => {
  const base = { env: { PATH: '/usr/bin' }, home: '/home/kc', platform: 'linux', exists: existsAll, dir: BIN }
  const timedOut = resolveRelayEnv({ ...base, spawnSyncImpl: (() => ({ status: null, signal: 'SIGTERM', stdout: '', stderr: '' })) as any })
  assert.equal(timedOut.env, null)
  assert.equal(timedOut.via, 'timeout')
  assert.match(timedOut.reason as string, /10 seconds/)

  const failed = resolveRelayEnv({ ...base, spawnSyncImpl: (() => ({ status: 1, signal: null, stdout: '', stderr: 'boom' })) as any })
  assert.equal(failed.env, null)
  assert.equal(failed.via, 'resolver-failed')

  const errored = resolveRelayEnv({ ...base, spawnSyncImpl: (() => ({ error: new Error('ENOENT'), status: null, signal: null, stdout: '', stderr: '' })) as any })
  assert.equal(errored.env, null)
  assert.equal(errored.via, 'spawn-failed')

  const threw = resolveRelayEnv({
    ...base,
    spawnSyncImpl: (() => {
      throw new Error('EACCES')
    }) as any,
  })
  assert.equal(threw.env, null)
  assert.equal(threw.via, 'spawn-failed')

  const garbage = resolveRelayEnv({ ...base, spawnSyncImpl: (() => ({ status: 0, signal: null, stdout: 'hello\n', stderr: '' })) as any })
  assert.equal(garbage.env, null)
  assert.equal(garbage.via, 'unparseable')
  assert.match(garbage.reason as string, /no JSON line/)
})

// ── main: what the shim is actually spawned with ─────────────────────────────

/** A spawn stub that records the call and lets the test end the child. */
function spawnRecorder() {
  const calls: any[] = []
  const impl = ((cmd: string, args: string[], opts: any) => {
    const child: any = new EventEmitter()
    child.kill = (signal: string) => calls[calls.length - 1].signals.push(signal)
    calls.push({ cmd, args, opts, child, signals: [] as string[] })
    return child
  }) as any
  return { calls, impl }
}

test('main: the shim is spawned with node, the relay env, inherited stdio, and the child exit code is forwarded', async () => {
  const { calls, impl } = spawnRecorder()
  const errs: string[] = []
  const pending = main([], {
    env: { PATH: '/usr/bin', EXISTING: 'keep-me' },
    home: '/home/kc',
    platform: 'linux',
    exists: existsAll,
    dir: BIN,
    nodePath: '/usr/bin/node',
    spawnImpl: impl,
    writeErr: (t: string) => errs.push(t),
    onSignal: () => {},
    spawnSyncImpl: resolverPrinting({ backendUrl: 'https://api.brandgrowthos.ai', pairingToken: 'pair-abc', apiKey: '', assistantId: '7', mode: 'pairing', complete: true }),
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].cmd, '/usr/bin/node')
  assert.deepEqual(calls[0].args, [shimPath(BIN)])
  assert.equal(calls[0].opts.stdio, 'inherit')
  assert.equal(calls[0].opts.env.HOAI_RELAY_BACKEND_URL, 'https://api.brandgrowthos.ai')
  assert.equal(calls[0].opts.env.HOAI_RELAY_PAIRING_TOKEN, 'pair-abc')
  assert.equal(calls[0].opts.env.EXISTING, 'keep-me', 'the inherited env survives')
  assert.deepEqual(errs, [], 'a working relay says nothing at all')
  calls[0].child.emit('exit', 3, null)
  assert.equal(await pending, 3)
})

test('main: an incomplete agent still gets the shim, with no relay env and one stderr line', async () => {
  const { calls, impl } = spawnRecorder()
  const errs: string[] = []
  const pending = main([], {
    env: { PATH: '/usr/bin' },
    home: '/home/kc',
    platform: 'linux',
    exists: existsAll,
    dir: BIN,
    nodePath: '/usr/bin/node',
    spawnImpl: impl,
    writeErr: (t: string) => errs.push(t),
    onSignal: () => {},
    spawnSyncImpl: resolverPrinting({ backendUrl: '', pairingToken: '', apiKey: '', assistantId: '', mode: 'apikey', complete: false }),
  })
  assert.equal(calls.length, 1, 'local mode must still work, so the shim runs anyway')
  for (const key of ['HOAI_RELAY_BACKEND_URL', 'HOAI_RELAY_PAIRING_TOKEN', 'HOAI_RELAY_API_KEY', 'HOAI_RELAY_ASSISTANT_ID']) {
    assert.ok(!(key in calls[0].opts.env), `${key} is absent`)
  }
  assert.equal(errs.length, 1)
  assert.match(errs[0], /browser relay off/)
  calls[0].child.emit('exit', 0, null)
  assert.equal(await pending, 0)
})

test('main: an operator HOAI_RELAY_* env reaches the shim exactly as it was set', async () => {
  const { calls, impl } = spawnRecorder()
  const errs: string[] = []
  const pending = main([], {
    env: { PATH: '/usr/bin', HOAI_RELAY_BACKEND_URL: 'https://staging.example/', HOAI_RELAY_PAIRING_TOKEN: 'operator-token' },
    home: '/home/kc',
    platform: 'linux',
    exists: existsAll,
    dir: BIN,
    nodePath: '/usr/bin/node',
    spawnImpl: impl,
    writeErr: (t: string) => errs.push(t),
    onSignal: () => {},
    spawnSyncImpl: resolverPrinting({ backendUrl: 'https://api.brandgrowthos.ai', pairingToken: 'pair-abc', apiKey: '', assistantId: '7', mode: 'pairing', complete: true }),
  })
  assert.equal(calls[0].opts.env.HOAI_RELAY_BACKEND_URL, 'https://staging.example/', 'not trimmed, not replaced')
  assert.equal(calls[0].opts.env.HOAI_RELAY_PAIRING_TOKEN, 'operator-token')
  assert.deepEqual(errs, [])
  calls[0].child.emit('exit', 0, null)
  assert.equal(await pending, 0)
})

test('main: a signal death maps to 128 + n, and SIGTERM is forwarded to the shim', async () => {
  const { calls, impl } = spawnRecorder()
  const handlers: Record<string, () => void> = {}
  const pending = main([], {
    env: { PATH: '/usr/bin' },
    home: '/home/kc',
    platform: 'linux',
    exists: () => false,
    dir: BIN,
    nodePath: '/usr/bin/node',
    spawnImpl: impl,
    writeErr: () => {},
    onSignal: (signal: string, handler: () => void) => {
      handlers[signal] = handler
    },
  })
  handlers.SIGTERM()
  assert.deepEqual(calls[0].signals, ['SIGTERM'])
  calls[0].child.emit('exit', null, 'SIGTERM')
  assert.equal(await pending, 143)
})

test('main: a shim that cannot be spawned reports 1 with a plain line, not a stack', async () => {
  const { calls, impl } = spawnRecorder()
  const errs: string[] = []
  const pending = main([], {
    env: { PATH: '/usr/bin' },
    home: '/home/kc',
    platform: 'linux',
    exists: () => false,
    dir: BIN,
    nodePath: '/usr/bin/node',
    spawnImpl: impl,
    writeErr: (t: string) => errs.push(t),
    onSignal: () => {},
  })
  calls[0].child.emit('error', new Error('EACCES'))
  assert.equal(await pending, 1)
  assert.ok(errs.some((e) => e.includes('could not start the browser shim')))
})

// ── the real resolver script, under bun ──────────────────────────────────────

const bun = resolveBunPath({ env: process.env as any, home: homedir() })

test(
  'hoai-browser-creds prints exactly one JSON line for a pairing credentials file',
  { skip: bun ? false : 'bun is not installed on this machine, so the bun-only resolver script cannot be run here' },
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'hoai-creds-'))
    const agentDir = join(dir, '.bgos-agent')
    mkdirSync(agentDir, { recursive: true })
    const credentialsPath = join(agentDir, 'credentials.json')
    writeFileSync(
      credentialsPath,
      JSON.stringify({
        backendUrl: 'https://api.brandgrowthos.ai',
        pairingToken: 'pair-from-file',
        pairingId: 11,
        userId: 'user_abc',
        assistantId: 77,
      }),
    )
    const result = spawnSync((bun as any).path, [credentialsScriptPath(BIN)], {
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...process.env,
        BGOS_CREDENTIALS_PATH: credentialsPath,
        BGOS_LAUNCH_CWD: dir,
        BGOS_PAIRING_TOKEN: '',
        BGOS_API_KEY: '',
        BGOS_ASSISTANT_ID: '',
        BGOS_BACKEND_URL: '',
        BGOS_USER_ID: '',
      },
    })
    assert.equal(result.status, 0, `resolver exited ${result.status}: ${result.stderr}`)
    const lines = String(result.stdout).split('\n').filter((l) => l.trim())
    assert.equal(lines.length, 1, `exactly one line, got: ${result.stdout}`)
    const parsed = JSON.parse(lines[0])
    assert.deepEqual(parsed, {
      backendUrl: 'https://api.brandgrowthos.ai',
      pairingToken: 'pair-from-file',
      apiKey: '',
      assistantId: '77',
      mode: 'pairing',
      complete: true,
    })
    // And the launcher turns that exact line into the pairing lane.
    assert.deepEqual(relayEnvFromResolution(parsed).env, {
      HOAI_RELAY_BACKEND_URL: 'https://api.brandgrowthos.ai',
      HOAI_RELAY_PAIRING_TOKEN: 'pair-from-file',
    })
  },
)
