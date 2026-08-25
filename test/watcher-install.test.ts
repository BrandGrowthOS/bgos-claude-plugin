/**
 * lib/watcher-install.mjs: the daemon-side install_watcher job (design 7.6).
 * Every dependency is a fake here, so the suite pins the ORCHESTRATION:
 * ack first, step order and progress bodies, the enroll body, what each
 * failure names, that no bundle or credentials are written before enroll
 * succeeds, and above all that a pairing token never stays on disk for a
 * watcher whose service did not install. server.ts wiring is pinned
 * textually at the end (server.ts cannot be imported in tests).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  WATCHER_INSTALL_OP,
  WATCHER_INSTALL_STEP_IDS,
  WATCHER_PROGRESS_MESSAGE_MAX_CHARS,
  WatcherInstallRpcHandler,
  clipWatcherMessage,
  normalizeWatcherInstallRpc,
  resolveNodePath,
  watcherStepKind,
} from '../lib/watcher-install.mjs'

const serverSource = readFileSync(new URL('../server.ts', import.meta.url), 'utf8')

// ── Frame ────────────────────────────────────────────────────────────────────

test('normalizeWatcherInstallRpc accepts exactly {rpcId, op: install_watcher} and ignores everything else', () => {
  assert.deepEqual(normalizeWatcherInstallRpc({ rpcId: 'r1', op: 'install_watcher' }), { rpcId: 'r1', op: 'install_watcher' })
  assert.equal(WATCHER_INSTALL_OP, 'install_watcher')
  assert.equal(normalizeWatcherInstallRpc({ rpcId: 'r1', op: 'update_now' }), null)
  assert.equal(normalizeWatcherInstallRpc({ op: 'install_watcher' }), null)
  assert.equal(normalizeWatcherInstallRpc({ rpcId: 7, op: 'install_watcher' }), null)
  assert.equal(normalizeWatcherInstallRpc(null), null)
  assert.equal(normalizeWatcherInstallRpc('install_watcher'), null)
  // SECURITY: the frame can never carry a payload.
  assert.deepEqual(
    normalizeWatcherInstallRpc({ rpcId: 'r1', op: 'install_watcher', token: 'x', url: 'https://evil', script: 'rm -rf' }),
    { rpcId: 'r1', op: 'install_watcher' },
  )
})

test('step ids, kinds and the message cap', () => {
  assert.deepEqual([...WATCHER_INSTALL_STEP_IDS], ['enroll', 'bundle', 'credentials', 'service', 'start'])
  assert.equal(watcherStepKind('enroll'), 'watcher_enroll')
  assert.equal(WATCHER_PROGRESS_MESSAGE_MAX_CHARS, 300)
  assert.equal(clipWatcherMessage('x'.repeat(400)).length, 300)
  assert.equal(clipWatcherMessage('short'), 'short')
})

// ── node resolution ──────────────────────────────────────────────────────────

test('resolveNodePath: PATH first, then execPath only when it is node, never bun', () => {
  const posixExists = (p: string) => p === '/usr/local/bin/node'
  assert.equal(
    resolveNodePath({ env: { PATH: '/usr/bin:/usr/local/bin' }, platform: 'darwin', execPath: '/opt/bun/bin/bun', exists: posixExists }),
    '/usr/local/bin/node',
  )
  assert.equal(
    resolveNodePath({ env: { PATH: '/nowhere' }, platform: 'darwin', execPath: '/opt/node/bin/node', exists: () => false }),
    '/opt/node/bin/node',
  )
  assert.equal(resolveNodePath({ env: { PATH: '/nowhere' }, platform: 'linux', execPath: '/opt/bun/bin/bun', exists: () => false }), null)
  assert.equal(resolveNodePath({ env: {}, platform: 'linux', execPath: '', exists: () => false }), null)
  // win32: PATH uses ; and node.exe, quoted entries and trailing separators are tolerated.
  const winExists = (p: string) => p === 'C:\\Program Files\\nodejs\\node.exe'
  assert.equal(
    resolveNodePath({
      env: { Path: 'C:\\Windows;"C:\\Program Files\\nodejs\\"' },
      platform: 'win32',
      execPath: 'C:\\Users\\x\\.bun\\bin\\bun.exe',
      exists: winExists,
    }),
    'C:\\Program Files\\nodejs\\node.exe',
  )
  assert.equal(
    resolveNodePath({ env: { Path: 'C:\\Windows' }, platform: 'win32', execPath: 'C:\\Program Files\\nodejs\\node.exe', exists: () => false }),
    'C:\\Program Files\\nodejs\\node.exe',
  )
  // A throwing exists never escapes.
  assert.equal(
    resolveNodePath({ env: { PATH: '/x' }, platform: 'linux', execPath: '/bun', exists: () => { throw new Error('EACCES') } }),
    null,
  )
})

// ── Handler ──────────────────────────────────────────────────────────────────

interface Overrides {
  ackError?: boolean
  progressError?: boolean
  machineId?: string
  enroll?: (body: Record<string, unknown>) => Promise<unknown>
  bundle?: (args: Record<string, unknown>) => Promise<unknown>
  credentials?: (creds: Record<string, unknown>) => Promise<unknown>
  serviceSpec?: (args: Record<string, unknown>) => unknown
  installService?: (spec: unknown) => Promise<unknown>
  nodePath?: () => string | null
  diagnosticsError?: boolean
}

function harness(over: Overrides = {}) {
  const acks: string[] = []
  const progress: Array<Record<string, unknown>> = []
  const logs: string[] = []
  const enrolls: Array<Record<string, unknown>> = []
  const bundles: Array<Record<string, unknown>> = []
  const credentials: Array<Record<string, unknown>> = []
  const specs: Array<Record<string, unknown>> = []
  const installs: unknown[] = []
  const diagnostics: Array<Record<string, unknown>> = []
  let removals = 0
  let credentialsOnDisk = false
  const handler = new WatcherInstallRpcHandler({
    postAck: async (rpcId) => {
      if (over.ackError) throw new Error('ack 500')
      acks.push(rpcId)
      return {}
    },
    postProgress: async (_rpcId, body) => {
      if (over.progressError) throw new Error('progress 500')
      progress.push(JSON.parse(JSON.stringify(body)))
      return {}
    },
    enroll: async (body) => {
      enrolls.push(body)
      if (over.enroll) return over.enroll(body)
      return { pairingId: 4242, token: 'pair_Zk3xQ9vL2mN8pR4sT7uW1yA5bC6dE0fG9hJ2kL4mN6pQ', backendUrl: 'https://api.example' }
    },
    ensureMachineId: () => over.machineId ?? 'machine-uuid-0001',
    installWatcherBundle: async (args) => {
      bundles.push(args)
      if (over.bundle) return over.bundle(args)
      return { bundleDir: '/home/x/.bgos-agent/watcher', files: [], fingerprint: 'abc', version: '0.38.3' }
    },
    writeWatcherCredentials: async (creds) => {
      if (over.credentials) return over.credentials(creds)
      credentials.push(creds)
      credentialsOnDisk = true
      return '/home/x/.bgos-agent/watcher/credentials.json'
    },
    removeWatcherCredentials: () => {
      removals += 1
      const had = credentialsOnDisk
      credentialsOnDisk = false
      return had
    },
    serviceSpec: (args) => {
      specs.push(args)
      if (over.serviceSpec) return over.serviceSpec(args)
      return { kind: 'launchd', label: 'ai.bgos.watcher', args }
    },
    installWatcherService: async (spec) => {
      installs.push(spec)
      if (over.installService) return over.installService(spec)
      return { ok: true, message: 'started', ran: [] }
    },
    nodePath: over.nodePath ?? (() => '/usr/local/bin/node'),
    hostname: () => 'kc-mac',
    pluginRoot: '/Users/x/.claude/plugins/cache/hoai/hoai/0.38.3',
    ownVersion: '0.38.3',
    home: '/Users/x',
    platform: 'darwin',
    installMethod: 'marketplace',
    nodeVersion: 'v22.1.0',
    username: 'x',
    postFailureDiagnostics: async (bundle) => {
      if (over.diagnosticsError) throw new Error('intake 500')
      diagnostics.push(bundle)
      return {}
    },
    log: (m) => logs.push(m),
  })
  return {
    handler,
    acks,
    progress,
    logs,
    enrolls,
    bundles,
    credentials,
    specs,
    installs,
    diagnostics,
    removals: () => removals,
    credentialsOnDisk: () => credentialsOnDisk,
  }
}

const FRAME = { rpcId: 'rpc-w1', op: 'install_watcher' as const }

function stepStates(body: Record<string, unknown>): Array<[string, string]> {
  return (body.steps as Array<{ id: string; state: string }>).map((s) => [s.id, s.state])
}

test('happy path: ack first, one running report per step, then done with every step ok', async () => {
  const h = harness()
  await h.handler.handle(FRAME)
  assert.deepEqual(h.acks, ['rpc-w1'])
  assert.deepEqual(h.progress.map((p) => p.state), ['running', 'running', 'running', 'running', 'done'])
  assert.deepEqual(stepStates(h.progress[0]!), [['enroll', 'running']])
  assert.deepEqual(stepStates(h.progress[1]!), [['enroll', 'ok'], ['bundle', 'running']])
  assert.deepEqual(stepStates(h.progress[2]!), [['enroll', 'ok'], ['bundle', 'ok'], ['credentials', 'running']])
  assert.deepEqual(stepStates(h.progress[3]!), [['enroll', 'ok'], ['bundle', 'ok'], ['credentials', 'ok'], ['service', 'running']])
  assert.deepEqual(stepStates(h.progress[4]!), [
    ['enroll', 'ok'],
    ['bundle', 'ok'],
    ['credentials', 'ok'],
    ['service', 'ok'],
    ['start', 'ok'],
  ])
  // Every step carries its signature kind on the wire.
  for (const step of h.progress[4]!.steps as Array<{ id: string; kind: string }>) {
    assert.equal(step.kind, `watcher_${step.id}`)
  }
  // The enroll body is exactly {machineId, deviceLabel: hostname, watcherVersion}.
  assert.deepEqual(h.enrolls, [{ machineId: 'machine-uuid-0001', deviceLabel: 'kc-mac', watcherVersion: '0.38.3' }])
  // The bundle is copied from THIS daemon's plugin root.
  assert.deepEqual(h.bundles, [{ pluginRoot: '/Users/x/.claude/plugins/cache/hoai/hoai/0.38.3', home: '/Users/x', pluginVersion: '0.38.3' }])
  // Credentials carry the enroll answer plus the machine id, nothing more.
  assert.deepEqual(h.credentials, [
    { pairingId: 4242, token: 'pair_Zk3xQ9vL2mN8pR4sT7uW1yA5bC6dE0fG9hJ2kL4mN6pQ', backendUrl: 'https://api.example', machineId: 'machine-uuid-0001' },
  ])
  // The service spec gets the resolved node and the bundle dir; the install gets the spec.
  assert.deepEqual(h.specs, [{ nodePath: '/usr/local/bin/node', bundleDir: '/home/x/.bgos-agent/watcher' }])
  assert.equal(h.installs.length, 1)
  assert.equal(h.removals(), 0)
  assert.equal(h.credentialsOnDisk(), true)
  assert.deepEqual(h.diagnostics, [])
  // Nothing in the progress bodies leaks the token.
  assert.ok(!JSON.stringify(h.progress).includes('pair_Zk3x'))
})

test('enroll 4xx: failed at enroll, nothing written, later steps skipped, diagnostics posted', async () => {
  const h = harness({
    enroll: async () => {
      throw new Error('POST 403: {"message":"forbidden"}')
    },
  })
  await h.handler.handle(FRAME)
  const last = h.progress[h.progress.length - 1]!
  assert.equal(last.state, 'failed')
  assert.deepEqual(stepStates(last), [
    ['enroll', 'failed'],
    ['bundle', 'skipped'],
    ['credentials', 'skipped'],
    ['service', 'skipped'],
    ['start', 'skipped'],
  ])
  assert.deepEqual(last.failedStep, { id: 'enroll', kind: 'watcher_enroll', message: 'enroll_failed: POST 403: {"message":"forbidden"}' })
  assert.equal(last.message, 'enroll_failed: POST 403: {"message":"forbidden"}')
  assert.equal(h.bundles.length, 0)
  assert.equal(h.credentials.length, 0)
  assert.equal(h.installs.length, 0)
  assert.equal(h.removals(), 0)
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(h.diagnostics.length, 1)
  const diag = h.diagnostics[0]! as { signature: Record<string, unknown>; steps: unknown[] }
  assert.deepEqual(diag.signature, {
    cause: 'watcher_enroll:enroll_failed',
    installMethod: 'marketplace',
    platform: 'darwin',
    pluginVersion: '0.38.3',
    targetVersion: '0.38.3',
  })
  assert.equal(diag.steps.length, 5)
})

test('no machine id: failed at enroll with machine_id_unwritable, enroll never called', async () => {
  const h = harness({ machineId: '' })
  await h.handler.handle(FRAME)
  const last = h.progress[h.progress.length - 1]!
  assert.equal(last.state, 'failed')
  assert.equal((last.failedStep as { id: string }).id, 'enroll')
  assert.equal(last.message, 'machine_id_unwritable')
  assert.equal(h.enrolls.length, 0)
})

test('an enroll answer without a token, url, or pairing id is refused before anything is written', async () => {
  for (const answer of [{ pairingId: 1, backendUrl: 'https://x' }, { token: 't', backendUrl: 'https://x' }, { pairingId: 1, token: 't' }, null, 'junk']) {
    const h = harness({ enroll: async () => answer })
    await h.handler.handle({ ...FRAME, rpcId: `rpc-${JSON.stringify(answer)}` })
    const last = h.progress[h.progress.length - 1]!
    assert.equal(last.state, 'failed')
    assert.equal(last.message, 'enroll_response_invalid')
    assert.equal(h.bundles.length, 0)
    assert.equal(h.credentials.length, 0)
  }
})

test('bundle failure: failed at bundle, credentials never written', async () => {
  const h = harness({
    bundle: async () => {
      throw new Error('EACCES: permission denied, mkdir')
    },
  })
  await h.handler.handle(FRAME)
  const last = h.progress[h.progress.length - 1]!
  assert.equal(last.state, 'failed')
  assert.deepEqual(stepStates(last), [
    ['enroll', 'ok'],
    ['bundle', 'failed'],
    ['credentials', 'skipped'],
    ['service', 'skipped'],
    ['start', 'skipped'],
  ])
  assert.equal((last.failedStep as { message: string }).message, 'bundle_failed: EACCES: permission denied, mkdir')
  assert.equal(h.credentials.length, 0)
  await new Promise((r) => setTimeout(r, 0))
  assert.equal((h.diagnostics[0] as { signature: { cause: string } }).signature.cause, 'watcher_bundle:bundle_failed')
  const missingDir = harness({ bundle: async () => ({ files: [] }) })
  await missingDir.handler.handle(FRAME)
  assert.equal(missingDir.progress[missingDir.progress.length - 1]!.message, 'bundle_dir_missing')
  assert.equal(missingDir.credentials.length, 0)
})

test('service install failure: failed at service and the credentials file is REMOVED', async () => {
  const h = harness({ installService: async () => ({ ok: false, message: 'launchctl bootstrap exited 5: Input/output error', ran: [] }) })
  await h.handler.handle(FRAME)
  const last = h.progress[h.progress.length - 1]!
  assert.equal(last.state, 'failed')
  assert.deepEqual(stepStates(last), [
    ['enroll', 'ok'],
    ['bundle', 'ok'],
    ['credentials', 'ok'],
    ['service', 'failed'],
    ['start', 'skipped'],
  ])
  assert.equal(last.message, 'service_install_failed: launchctl bootstrap exited 5: Input/output error')
  assert.equal(h.credentials.length, 1, 'the credentials were written before the service step')
  assert.equal(h.removals(), 1)
  assert.equal(h.credentialsOnDisk(), false, 'a token must never stay on disk for a watcher that will not run')
  assert.ok(h.logs.some((l) => l.includes('removed the watcher credentials file')))
  await new Promise((r) => setTimeout(r, 0))
  assert.equal((h.diagnostics[0] as { signature: { cause: string } }).signature.cause, 'watcher_service:service_install_failed')
})

test('a throwing service install, a throwing spec builder, and a missing node all remove the credentials', async () => {
  const cases: Array<[Overrides, string]> = [
    [{ installService: async () => { throw new Error('spawn launchctl ENOENT') } }, 'service_install_failed: spawn launchctl ENOENT'],
    [{ serviceSpec: () => { throw new Error('unsupported platform') } }, 'service_spec_failed: unsupported platform'],
    [{ nodePath: () => null }, 'node_not_found'],
    [{ nodePath: () => { throw new Error('PATH unreadable') } }, 'node_lookup_failed: PATH unreadable'],
  ]
  for (const [over, message] of cases) {
    const h = harness(over)
    await h.handler.handle(FRAME)
    const last = h.progress[h.progress.length - 1]!
    assert.equal(last.state, 'failed', message)
    assert.equal((last.failedStep as { id: string }).id, 'service')
    assert.equal(last.message, message)
    assert.equal(h.removals(), 1, message)
    assert.equal(h.credentialsOnDisk(), false, message)
  }
})

test('a credentials write failure is named and cleans up whatever was left', async () => {
  const h = harness({
    credentials: async () => {
      throw new Error('ENOSPC: no space left on device')
    },
  })
  await h.handler.handle(FRAME)
  const last = h.progress[h.progress.length - 1]!
  assert.equal((last.failedStep as { id: string }).id, 'credentials')
  assert.equal(last.message, 'credentials_failed: ENOSPC: no space left on device')
  assert.equal(h.installs.length, 0)
  assert.equal(h.removals(), 1)
})

test('failure messages are clipped to the backend cap', async () => {
  const h = harness({
    enroll: async () => {
      throw new Error('x'.repeat(1000))
    },
  })
  await h.handler.handle(FRAME)
  const last = h.progress[h.progress.length - 1]!
  assert.equal((last.message as string).length, 300)
  assert.equal((last.failedStep as { message: string }).message.length, 300)
  const step = (last.steps as Array<{ id: string; message?: string }>).find((s) => s.id === 'enroll')!
  assert.equal(step.message!.length, 300)
})

test('a duplicate frame re-acks and never installs twice', async () => {
  const h = harness()
  await h.handler.handle(FRAME)
  await h.handler.handle(FRAME)
  assert.deepEqual(h.acks, ['rpc-w1', 'rpc-w1'])
  assert.equal(h.enrolls.length, 1)
  assert.equal(h.installs.length, 1)
  assert.ok(h.logs.some((l) => l.includes('duplicate frame re-acked')))
  // A different rpc id is a new job.
  await h.handler.handle({ ...FRAME, rpcId: 'rpc-w2' })
  assert.equal(h.enrolls.length, 2)
})

test('a failed ack is non-fatal, progress failures are logged and never stop the install', async () => {
  const h = harness({ ackError: true, progressError: true })
  await h.handler.handle(FRAME)
  assert.deepEqual(h.acks, [])
  assert.deepEqual(h.progress, [])
  assert.equal(h.installs.length, 1)
  assert.ok(h.logs.some((l) => l.includes('ack failed')))
  assert.ok(h.logs.filter((l) => l.includes('progress')).length >= 5)
})

test('a failing diagnostics intake is logged and never changes the outcome', async () => {
  const h = harness({ diagnosticsError: true, installService: async () => ({ ok: false, message: 'no' }) })
  await h.handler.handle(FRAME)
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(h.progress[h.progress.length - 1]!.state, 'failed')
  assert.ok(h.logs.some((l) => l.includes('diagnostics post failed')))
})

test('a throw while building the enroll request is still named at enroll', async () => {
  const progress: Array<Record<string, unknown>> = []
  const thrown = new WatcherInstallRpcHandler({
    ...(harness() as unknown as { handler: { deps: Record<string, unknown> } }).handler.deps,
    hostname: () => {
      throw new Error('os.hostname exploded')
    },
    postProgress: async (_r: string, body: Record<string, unknown>) => {
      progress.push(body)
      return {}
    },
    log: () => {},
  } as never)
  await thrown.handle({ rpcId: 'rpc-x', op: 'install_watcher' })
  const last = progress[progress.length - 1]!
  assert.equal(last.state, 'failed')
  assert.equal((last.failedStep as { id: string }).id, 'enroll')
  assert.equal(last.message, 'enroll_failed: os.hostname exploded')
})

test('an unexpected throw outside any guarded call fails closed at the running step and removes the credentials', async () => {
  const progress: Array<Record<string, unknown>> = []
  let removals = 0
  const thrown = new WatcherInstallRpcHandler({
    ...(harness() as unknown as { handler: { deps: Record<string, unknown> } }).handler.deps,
    ensureMachineId: () => {
      throw new Error('home exploded')
    },
    removeWatcherCredentials: () => {
      removals += 1
      return false
    },
    postProgress: async (_r: string, body: Record<string, unknown>) => {
      progress.push(body)
      return {}
    },
    log: () => {},
  } as never)
  await thrown.handle({ rpcId: 'rpc-y', op: 'install_watcher' })
  const last = progress[progress.length - 1]!
  assert.equal(last.state, 'failed')
  assert.equal((last.failedStep as { id: string }).id, 'enroll')
  assert.equal(last.message, 'unexpected_error: home exploded')
  assert.deepEqual(stepStates(last), [
    ['enroll', 'failed'],
    ['bundle', 'skipped'],
    ['credentials', 'skipped'],
    ['service', 'skipped'],
    ['start', 'skipped'],
  ])
  assert.equal(removals, 1)
})

// ── server.ts wiring pins ────────────────────────────────────────────────────

test('server.ts routes watcher_install_rpc frames through the normalizer into the handler', () => {
  const start = serverSource.indexOf("realtimeSocket.on('watcher_install_rpc'")
  assert.notEqual(start, -1, 'the socket event must be registered')
  const next = serverSource.indexOf('realtimeSocket.on(', start + 1)
  const body = serverSource.slice(start, next === -1 ? serverSource.length : next)
  assert.ok(body.includes('normalizeWatcherInstallRpc(payload)'), body)
  assert.ok(body.includes('watcherInstallRpc.handle(frame)'), body)
  // Like update_rpc: a control rail, never drain-gated.
  assert.ok(!body.includes('if (updateDrainMode) return'))
})

test('server.ts builds the handler against the machine-rpc and enroll routes with real fs and platform pieces', () => {
  const start = serverSource.indexOf('new WatcherInstallRpcHandler({')
  assert.notEqual(start, -1)
  const block = serverSource.slice(start, start + 3000)
  assert.ok(block.includes('integrations/machine-rpc/${encodeURIComponent(rpcId)}/ack'), block)
  assert.ok(block.includes('integrations/machine-rpc/${encodeURIComponent(rpcId)}/progress'), block)
  assert.ok(block.includes("bgosPost('integrations/watchers/enroll', body)"), block)
  assert.ok(block.includes('ensureMachineId({ home: homedir() })'), block)
  assert.ok(block.includes('unlinkSync(watcherCredentialsPath(homedir()))'), block)
  assert.ok(block.includes('resolveNodePath({'), block)
  assert.ok(block.includes('execPath: process.execPath'), block)
  assert.ok(block.includes('postFailureDiagnostics(bgosPost, diagnostics)'), block)
})
