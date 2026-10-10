/**
 * Stand-down reports, the wire (identity race plan step 3, board row fc75c7c3,
 * plugin 0.65.3). The backend can see a daemon stand down since BGOS #2189
 * (56e1156): POST /api/v1/integrations/stand-downs under the pairing token,
 * a body of exactly six listed fields, 204. This file holds the plugin to that
 * contract against a REAL local HTTP server that validates every request the
 * way the backend does, from the token lists copied below.
 *
 * DATA'S RULE (CI owner). The lists below are copied from the backend and
 * pinned. The test fails if the plugin's own lists drift from them, if a report
 * or a heartbeat ever sends `pin`, `env` or `elimination` (the pairing lock's
 * coarse words) as a route, or if either sends a key outside its list. A
 * backend change to these tokens has to land here in the same reviewed change.
 *
 * The site by site wiring in server.ts is test/stand-down-sites.test.ts.
 *
 * Run with: npx tsx --test test/stand-down-report.test.ts
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { fileURLToPath } from 'node:url'

import { heartbeatEnv, startVersionHeartbeat } from '../lib/version-heartbeat.ts'

// Absent before 0.65.3: the red run fails on the behaviour, not on an import.
const lib: Record<string, any> = await import('../lib/stand-down-report.ts').catch(() => ({}))

// ── The backend's contract, copied and pinned ──────────────────────────────
// BGOS backend/src/integrations/stand-down-contract.ts, stand-down.dto.ts and
// heartbeat.dto.ts at origin/main 56e1156 (#2189).

const BACKEND_REASONS = [
  'refuse_home_mismatch',
  'passive_at_boot',
  'lock_lost',
  'arm_failed',
  'exit_uncaught',
  'exit_boot_fatal',
  'always_on_unsupported',
  'always_on_supervisor_missing',
]
const BACKEND_ROUTES = ['env-path', 'env-assistant', 'folder-pin', 'sole-per-assistant', 'legacy', 'unknown']
const BACKEND_PHASES = ['boot', 'run']
const BACKEND_BODY_KEYS = ['reason', 'route', 'phase', 'machineId', 'pluginVersion', 'at']
/** MACHINE_ID_REGEX, backend/src/integrations/machine-identity.ts */
const BACKEND_MACHINE_ID_RE = /^[A-Za-z0-9-]{8,64}$/
/** STAND_DOWN_VERSION_REGEX, plus the DTO's MaxLength(32) */
const BACKEND_VERSION_RE = /^\d{1,6}\.\d{1,6}\.\d{1,6}[-\w.]{0,20}$/
/** REPORT_TIMESTAMP_REGEX, stand-down.dto.ts, plus MaxLength(40) */
const BACKEND_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/
/** Every key HeartbeatEnvDto declares. Anything else is stripped by the
 *  whitelist pipe, so a plugin that sends one is sending it nowhere. */
const BACKEND_HEARTBEAT_ENV_KEYS = [
  'platform',
  'cwd',
  'python',
  'hermes',
  'machineId',
  'role',
  'agents',
  'watcherHealth',
  'claudeAccountKey',
  'claudeAccountLabel',
  'identityRoute',
  'homeConfirmed',
]
/** The pairing lock's three words. Never a reported route. */
const COARSE_ROUTES = ['pin', 'env', 'elimination']

/** The backend's whole check of one request, from the copies above. */
function contractProblems(body: unknown, headers: IncomingHttpHeaders): string[] {
  const problems: string[] = []
  if (headers['x-bgos-pairing'] !== TOKEN) problems.push('pairing header')
  if (!String(headers['content-type'] ?? '').startsWith('application/json')) problems.push('content type')
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return [...problems, 'not an object']
  const b = body as Record<string, unknown>
  for (const key of Object.keys(b)) if (!BACKEND_BODY_KEYS.includes(key)) problems.push(`unexpected key ${key}`)
  for (const key of BACKEND_BODY_KEYS) if (typeof b[key] !== 'string') problems.push(`${key} missing`)
  if (!BACKEND_REASONS.includes(b.reason as string)) problems.push('reason')
  if (!BACKEND_ROUTES.includes(b.route as string)) problems.push('route')
  if (!BACKEND_PHASES.includes(b.phase as string)) problems.push('phase')
  if (!BACKEND_MACHINE_ID_RE.test(String(b.machineId))) problems.push('machineId')
  if (!BACKEND_VERSION_RE.test(String(b.pluginVersion)) || String(b.pluginVersion).length > 32) problems.push('pluginVersion')
  if (!BACKEND_AT_RE.test(String(b.at)) || String(b.at).length > 40) problems.push('at')
  return problems
}

// ── The fake backend ────────────────────────────────────────────────────────

const TOKEN = 'pair_SECRET_7f3a9c'
const MACHINE_ID = 'c0ffee00-1234-4abc-8def-0123456789ab'
const VERSION = '0.65.3'

type Mode = 'validate' | 'hang' | 307 | 400 | 401 | 500

interface Captured {
  method: string
  path: string
  headers: IncomingHttpHeaders
  body: Record<string, unknown>
  problems: string[]
}

interface Backend {
  url: string
  mode: Mode
  requests: Captured[]
  close(): Promise<void>
}

const backends: Backend[] = []
after(async () => {
  await Promise.all(backends.map((b) => b.close()))
})

async function startBackend(mode: Mode = 'validate'): Promise<Backend> {
  const sockets = new Set<Socket>()
  const backend: Backend = { url: '', mode, requests: [], close: async () => {} }
  const server: Server = createServer((req, res) => {
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      let body: Record<string, unknown> = {}
      try {
        body = JSON.parse(raw)
      } catch {}
      const captured: Captured = {
        method: req.method ?? '',
        path: req.url ?? '',
        headers: req.headers,
        body,
        problems: contractProblems(body, req.headers),
      }
      backend.requests.push(captured)
      if (backend.mode === 'hang') return // never answers
      if (typeof backend.mode === 'number') {
        res.writeHead(backend.mode, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ statusCode: backend.mode, message: 'refused' }))
      }
      const ok = captured.method === 'POST' && captured.path === '/api/v1/integrations/stand-downs' && captured.problems.length === 0
      res.writeHead(ok ? 204 : 400)
      res.end(ok ? undefined : JSON.stringify({ statusCode: 400, message: captured.problems.join('; ') }))
    })
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  backend.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  backend.close = () =>
    new Promise<void>((resolve) => {
      for (const s of sockets) s.destroy()
      server.close(() => resolve())
    })
  backends.push(backend)
  return backend
}

function reporterFor(
  backend: { url: string },
  over: Record<string, unknown> = {},
): {
  report: (reason: string, phase: string) => Promise<void>
  reportSync: (reason: string, phase: string) => void
  logs: string[]
} {
  assert.equal(typeof lib.createStandDownReporter, 'function', 'lib/stand-down-report.ts exports createStandDownReporter')
  const logs: string[] = []
  const reporter = lib.createStandDownReporter({
    credentials: () => ({ backendUrl: backend.url, pairingToken: TOKEN }),
    route: 'folder-pin',
    machineId: () => MACHINE_ID,
    pluginVersion: () => VERSION,
    log: (line: string) => logs.push(line),
    ...over,
  })
  return {
    report: (reason, phase) => reporter.report(reason, phase),
    reportSync: (reason, phase) => {
      assert.equal(typeof reporter.reportSync, 'function', 'the reporter has a blocking send for exit sites')
      reporter.reportSync(reason, phase)
    },
    logs,
  }
}

/** The fake backend in a process of its own (test/fixtures/stand-down-backend.mjs),
 *  for the exit path, which blocks this process's event loop while it sends. */
async function startOutOfProcess(
  mode: string = 'validate',
  location?: string,
): Promise<{ url: string; captured: () => Promise<Captured[]>; close: () => void }> {
  const fixture = fileURLToPath(new URL('./fixtures/stand-down-backend.mjs', import.meta.url))
  const child = spawn(process.execPath, [fixture, mode, ...(location ? [location] : [])], { stdio: ['pipe', 'pipe', 'inherit'] })
  const port = await new Promise<string>((resolve, reject) => {
    let out = ''
    child.stdout!.setEncoding('utf8')
    child.stdout!.on('data', (c: string) => {
      out += c
      if (out.includes('\n')) resolve(out.trim())
    })
    child.on('error', reject)
  })
  const url = `http://127.0.0.1:${port}`
  const close = () => {
    try {
      child.stdin!.end()
      child.kill()
    } catch {}
  }
  backends.push({ url, mode: 'validate', requests: [], close: async () => close() })
  return {
    url,
    close,
    captured: async () => {
      const raw = (await (await fetch(`${url}/captured`)).json()) as Array<{ method: string; path: string; headers: IncomingHttpHeaders; body: Record<string, unknown> }>
      return raw.map((r) => ({ ...r, problems: contractProblems(r.body, r.headers) }))
    },
  }
}

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// ── Contract parity ─────────────────────────────────────────────────────────

test("the plugin's token lists are the backend's, word for word and in order", () => {
  assert.deepEqual([...(lib.STAND_DOWN_REASONS ?? [])], BACKEND_REASONS)
  assert.deepEqual([...(lib.IDENTITY_ROUTES ?? [])], BACKEND_ROUTES)
  assert.deepEqual([...(lib.STAND_DOWN_PHASES ?? [])], BACKEND_PHASES)
  assert.deepEqual([...(lib.STAND_DOWN_BODY_KEYS ?? [])], BACKEND_BODY_KEYS)
  assert.equal(String(lib.STAND_DOWN_VERSION_RE), String(BACKEND_VERSION_RE))
  assert.equal(lib.STAND_DOWN_PATH, 'integrations/stand-downs')
  assert.equal(lib.STAND_DOWN_REPORT_TIMEOUT_MS, 2000)
})

test("every way the resolver can choose credentials is a backend route, so no route is reported as unknown by accident", () => {
  const source = readFileSync(new URL('../lib/agent-credentials.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  const union = /export type CredentialsVia =([\s\S]*?)\n\n/.exec(source)
  assert.ok(union, 'CredentialsVia is declared')
  const vias = [...union![1].matchAll(/'([a-z-]+)'/g)].map((m) => m[1])
  assert.deepEqual(vias, BACKEND_ROUTES.filter((r) => r !== 'unknown'))
  for (const via of vias) assert.equal(lib.reportedIdentityRoute?.(via), via, via)
})

test('the coarse lock words and anything unlisted are reported as unknown, never as themselves', () => {
  for (const junk of [...COARSE_ROUTES, 'Folder-Pin', 'folder-pin ', '', 'C:\\agents\\ares', '/home/kc/agent', null, undefined, 7, {}]) {
    assert.equal(lib.reportedIdentityRoute?.(junk), 'unknown', String(junk))
  }
})

// ── One report, exactly the contract ────────────────────────────────────────

test('a report is one POST to /api/v1/integrations/stand-downs with the pairing header and exactly the six fields, and the backend takes it (204)', async () => {
  const backend = await startBackend()
  for (const [i, reason] of BACKEND_REASONS.entries()) {
    const r = reporterFor(backend, { route: BACKEND_ROUTES[i % BACKEND_ROUTES.length] })
    await r.report(reason, i % 2 ? 'run' : 'boot')
  }
  assert.equal(backend.requests.length, BACKEND_REASONS.length)
  for (const [i, req] of backend.requests.entries()) {
    assert.equal(req.method, 'POST')
    assert.equal(req.path, '/api/v1/integrations/stand-downs')
    assert.deepEqual(req.problems, [], JSON.stringify(req.body))
    assert.deepEqual(Object.keys(req.body), BACKEND_BODY_KEYS, 'exactly the six keys, in the contract order')
    assert.equal(req.body.reason, BACKEND_REASONS[i])
    assert.equal(req.body.route, BACKEND_ROUTES[i % BACKEND_ROUTES.length])
    assert.equal(req.body.phase, i % 2 ? 'run' : 'boot')
    assert.equal(req.body.machineId, MACHINE_ID)
    assert.equal(req.body.pluginVersion, VERSION)
    assert.ok(Math.abs(Date.parse(String(req.body.at)) - Date.now()) < 60_000, 'at is now')
  }
})

test('a backend URL that already ends in /api/v1, or carries a trailing slash, still reaches the one route', async () => {
  const backend = await startBackend()
  await reporterFor(backend, { credentials: () => ({ backendUrl: `${backend.url}/api/v1/`, pairingToken: TOKEN }) }).report('lock_lost', 'run')
  await reporterFor(backend, { credentials: () => ({ backendUrl: `${backend.url}/`, pairingToken: TOKEN }) }).report('lock_lost', 'run')
  assert.deepEqual(backend.requests.map((r) => r.path), ['/api/v1/integrations/stand-downs', '/api/v1/integrations/stand-downs'])
})

test("Data's rule: a report never sends pin, env or elimination as a route, nor a key outside the list, whatever route it is handed", async () => {
  const backend = await startBackend()
  for (const route of [...BACKEND_ROUTES, ...COARSE_ROUTES, 'junk', undefined]) {
    await reporterFor(backend, { route }).report('passive_at_boot', 'boot')
  }
  for (const req of backend.requests) {
    assert.ok(!COARSE_ROUTES.includes(req.body.route as string), `route ${String(req.body.route)}`)
    assert.ok(BACKEND_ROUTES.includes(req.body.route as string), `route ${String(req.body.route)}`)
    assert.deepEqual(Object.keys(req.body), BACKEND_BODY_KEYS)
  }
  assert.deepEqual(
    backend.requests.slice(BACKEND_ROUTES.length).map((r) => r.body.route),
    ['unknown', 'unknown', 'unknown', 'unknown', 'unknown'],
  )
})

// ── At most one per (reason, phase) per process; a flapping lock is quiet ───

test('at most one report per reason and phase: a lock that flaps fifty times sends one lock_lost per phase', async () => {
  const backend = await startBackend()
  const r = reporterFor(backend)
  const all: Promise<void>[] = []
  for (let i = 0; i < 50; i++) all.push(r.report('lock_lost', 'run'))
  await Promise.all(all)
  for (let i = 0; i < 50; i++) await r.report('lock_lost', 'run')
  await r.report('lock_lost', 'boot')
  await r.report('lock_lost', 'boot')
  await r.report('passive_at_boot', 'boot')
  assert.deepEqual(
    backend.requests.map((q) => `${q.body.reason}/${q.body.phase}`),
    ['lock_lost/run', 'lock_lost/boot', 'passive_at_boot/boot'],
  )
})

// ── Never retried ───────────────────────────────────────────────────────────

test('a 400 is never retried: that report is dropped, the next reason still goes', async () => {
  const backend = await startBackend(400)
  const r = reporterFor(backend)
  await r.report('lock_lost', 'run')
  await settle(50)
  await r.report('lock_lost', 'run')
  assert.equal(backend.requests.length, 1, 'one attempt, no retry')
  await r.report('arm_failed', 'run')
  assert.equal(backend.requests.length, 2)
})

test('a 401 is never retried, and the refused token sends nothing more for the life of the process', async () => {
  const backend = await startBackend(401)
  const r = reporterFor(backend)
  await r.report('passive_at_boot', 'boot')
  await settle(50)
  await r.report('passive_at_boot', 'boot')
  await r.report('lock_lost', 'run')
  await r.report('exit_uncaught', 'run')
  assert.equal(backend.requests.length, 1)
})

test('a 500 or a refused connection is not retried either: one attempt per reason and phase, whatever happens', async () => {
  const backend = await startBackend(500)
  const r = reporterFor(backend)
  await r.report('lock_lost', 'run')
  await r.report('lock_lost', 'run')
  assert.equal(backend.requests.length, 1)
  const dead = await startBackend()
  await dead.close()
  const gone = reporterFor(dead)
  await gone.report('lock_lost', 'run') // resolves, never throws
})

// ── Fire and forget, bounded ────────────────────────────────────────────────

test('a backend that never answers costs at most the 2 s deadline, and the report resolves rather than throws', async () => {
  const backend = await startBackend('hang')
  const r = reporterFor(backend)
  const started = Date.now()
  await r.report('exit_uncaught', 'run')
  const took = Date.now() - started
  assert.ok(took >= 1500 && took < 3000, `took ${took} ms`)
  await settle(100)
  assert.equal(backend.requests.length, 1, 'no retry after the deadline')
})

test('settleWithin lets an exit wait for the report, never past its deadline, and never throws', async () => {
  assert.equal(typeof lib.settleWithin, 'function')
  let t = Date.now()
  await lib.settleWithin(new Promise(() => {}), 200)
  assert.ok(Date.now() - t < 1000 && Date.now() - t >= 150, 'a report that never settles is waited for 200 ms')
  t = Date.now()
  await lib.settleWithin(Promise.reject(new Error('C:\\Users\\karim boom')), 2000)
  assert.ok(Date.now() - t < 200, 'a rejection releases at once')
  t = Date.now()
  await lib.settleWithin(settle(20), 2000)
  assert.ok(Date.now() - t < 500, 'a settled report releases at once')
})

test('a report never throws, even when every provider does', async () => {
  const backend = await startBackend()
  const boom = () => {
    throw new Error('C:\\Users\\karim\\.bgos-agent\\credentials.json unreadable')
  }
  for (const over of [{ credentials: boom }, { machineId: boom }, { pluginVersion: boom }, { log: boom }]) {
    const r = reporterFor(backend, over)
    await r.report('lock_lost', 'run')
  }
})

// ── No credentials, nothing sent ────────────────────────────────────────────

test('a site with no pairing credentials sends nothing: no credentials, an empty token, no backend, an API key install', async () => {
  const backend = await startBackend()
  for (const credentials of [
    () => null,
    () => ({ backendUrl: backend.url, pairingToken: '' }),
    () => ({ backendUrl: '', pairingToken: TOKEN }),
  ]) {
    await reporterFor(backend, { credentials }).report('lock_lost', 'run')
  }
  assert.equal(backend.requests.length, 0)
  assert.equal(typeof lib.pairingCredential, 'function')
  assert.equal(lib.pairingCredential({ mode: 'apikey', backendUrl: backend.url, pairingToken: '', apiKey: 'k' }), null)
  assert.deepEqual(lib.pairingCredential({ mode: 'pairing', backendUrl: backend.url, pairingToken: TOKEN }), {
    backendUrl: backend.url,
    pairingToken: TOKEN,
  })
})

test('a value the backend would refuse is never sent: no machine id, a bad version, a reason or phase off the list', async () => {
  const backend = await startBackend()
  await reporterFor(backend, { machineId: () => '' }).report('lock_lost', 'run')
  await reporterFor(backend, { machineId: () => 'C:\\Users\\karim' }).report('lock_lost', 'run')
  await reporterFor(backend, { pluginVersion: () => null }).report('lock_lost', 'run')
  await reporterFor(backend, { pluginVersion: () => '0.65.3-' + 'x'.repeat(40) }).report('lock_lost', 'run')
  await reporterFor(backend).report('lock_lost because C:\\agents', 'run')
  await reporterFor(backend).report('lock_lost', 'later')
  assert.equal(backend.requests.length, 0)
})

// ── Nothing but tokens, in the body and in the log ──────────────────────────

test('no folder, path, pid, session id, error text or token in any body or log line', async () => {
  const secrets = [TOKEN, 'karim', 'C:\\', '/home/', 'unreadable', 'refused', 'statusCode']
  const lines: string[] = []
  for (const mode of ['validate', 400, 401, 500, 'hang'] as Mode[]) {
    const backend = await startBackend(mode)
    const r = reporterFor(backend, { credentials: () => ({ backendUrl: `${backend.url}/api/v1`, pairingToken: TOKEN }) })
    await r.report('exit_boot_fatal', 'boot')
    lines.push(...r.logs)
    for (const req of backend.requests) {
      const text = JSON.stringify(req.body)
      for (const s of [...secrets, backend.url, '127.0.0.1', String(process.pid)]) assert.ok(!text.includes(s), `body carries ${s}`)
    }
  }
  const dead = await startBackend()
  await dead.close()
  const refusedConnection = reporterFor(dead)
  await refusedConnection.report('exit_boot_fatal', 'boot')
  lines.push(...refusedConnection.logs)
  const quiet = reporterFor(await startBackend(), { credentials: () => null })
  await quiet.report('lock_lost', 'run')
  lines.push(...quiet.logs)
  assert.equal(lines.length, 7, `every outcome says one line: ${JSON.stringify(lines)}`)
  // Tokens only: every line is one of these shapes, word for word, so no error
  // text (not even a bare "fetch failed"), path, URL or token can ride along.
  const shapes = [
    / reported \(HTTP \d{3}\)$/,
    / not taken \(HTTP \d{3}\), not retried$/,
    / got no answer within \d+ ms, not retried$/,
    / could not be sent, not retried$/,
    / not sent: no pairing credentials$/,
    / not sent: no valid (reason|route|phase|machineId|pluginVersion|at)$/,
  ]
  for (const line of lines) {
    for (const s of [...secrets, '127.0.0.1', 'http']) assert.ok(!line.includes(s), `log line carries ${s}: ${line}`)
    const rest = /^stand-down (exit_boot_fatal \(boot\)|lock_lost \(run\))( .*)$/.exec(line)
    assert.ok(rest, `log line starts with the reason and phase: ${line}`)
    assert.ok(shapes.some((shape) => shape.test(rest![2]) && rest![2].replace(shape, '') === ''), `log line shape: ${line}`)
  }
  assert.ok(lines.some((l) => l.endsWith(' could not be sent, not retried')), 'the refused connection says so')
})

// ── The exit path: sent while the caller blocks ─────────────────────────────
// An exit site (the uncaught exception handler, main() failing) must not let
// the daemon run on while it reports: the old code exited at once. So it sends
// from a child and BLOCKS on it, 2 s at most; nothing else in the daemon runs
// between the fault and the exit.

test('an exit report is sent while the caller blocks: one POST, the contract body, and no other work runs meanwhile', async () => {
  const backend = await startOutOfProcess('validate')
  const r = reporterFor(backend, { route: 'sole-per-assistant' })
  let ticked = false
  setTimeout(() => (ticked = true), 0)
  r.reportSync('exit_uncaught', 'run')
  assert.equal(ticked, false, 'the event loop did not turn while the report was sent')
  const got = await backend.captured()
  assert.equal(got.length, 1)
  assert.equal(got[0].path, '/api/v1/integrations/stand-downs')
  assert.deepEqual(got[0].problems, [])
  assert.deepEqual(Object.keys(got[0].body), BACKEND_BODY_KEYS)
  assert.equal(got[0].body.reason, 'exit_uncaught')
  assert.equal(got[0].body.route, 'sole-per-assistant')
  assert.deepEqual(r.logs, ['stand-down exit_uncaught (run) reported (HTTP 204)'])
})

test('an exit report never blocks past the 2 s deadline when the backend never answers', async () => {
  const backend = await startOutOfProcess('hang')
  const r = reporterFor(backend)
  const started = Date.now()
  r.reportSync('exit_boot_fatal', 'boot')
  const took = Date.now() - started
  assert.ok(took >= 1500 && took < 2800, `blocked ${took} ms`)
  assert.deepEqual(r.logs, ['stand-down exit_boot_fatal (boot) got no answer within 2000 ms, not retried'])
  assert.equal((await backend.captured()).length, 1, 'one attempt')
})

test('an exit report keeps the once per reason and phase rule and the 401 latch of the fire and forget path', async () => {
  const ok = await startOutOfProcess('validate')
  const r = reporterFor(ok)
  await r.report('exit_uncaught', 'run')
  r.reportSync('exit_uncaught', 'run')
  r.reportSync('exit_uncaught', 'run')
  assert.equal((await ok.captured()).length, 1)
  const refused = await startOutOfProcess('401')
  const q = reporterFor(refused)
  q.reportSync('exit_boot_fatal', 'boot')
  await q.report('lock_lost', 'run')
  q.reportSync('exit_uncaught', 'run')
  assert.equal((await refused.captured()).length, 1, 'nothing after the 401')
  assert.deepEqual(q.logs, ['stand-down exit_boot_fatal (boot) not taken (HTTP 401), not retried'])
})

test('the exit sender gets the token on stdin, never on its command line, and never writes to the daemon stdout', () => {
  const calls: Array<{ cmd: string; args: string[]; opts: Record<string, any> }> = []
  const r = reporterFor(
    { url: 'http://127.0.0.1:9' },
    {
      spawnSyncImpl: (cmd: string, args: string[], opts: Record<string, any>) => {
        calls.push({ cmd, args, opts })
        return spawnSync(cmd, args, opts as never)
      },
    },
  )
  r.reportSync('exit_uncaught', 'run')
  assert.equal(calls.length, 1)
  const { cmd, args, opts } = calls[0]
  assert.equal(cmd, process.execPath, 'the runtime this daemon runs on')
  assert.ok(!JSON.stringify(args).includes(TOKEN), 'no token in argv')
  assert.ok(String(opts.input).includes(TOKEN), 'the token goes on stdin')
  assert.equal(opts.timeout, 2000)
  assert.notEqual(opts.stdio?.[1], 'inherit', 'the child never writes to the MCP stdout')
  assert.notEqual(opts.stdio?.[2], 'inherit')
  assert.equal(opts.windowsHide, true)
  assert.deepEqual(r.logs, ['stand-down exit_uncaught (run) could not be sent, not retried'])
})

test('an exit report that cannot even start its sender never throws', () => {
  const r = reporterFor({ url: 'http://127.0.0.1:9' }, { execPath: 'E:\\nowhere\\missing-runtime.exe' })
  r.reportSync('exit_uncaught', 'run')
  const s = reporterFor({ url: 'http://127.0.0.1:9' }, { spawnSyncImpl: () => { throw new Error('C:\\Users\\karim spawn') } })
  s.reportSync('exit_uncaught', 'run')
  assert.deepEqual([...r.logs, ...s.logs], [
    'stand-down exit_uncaught (run) could not be sent, not retried',
    'stand-down exit_uncaught (run) could not be sent, not retried',
  ])
})

test('a redirect is never followed, so the token never leaves the backend it was paired with', async () => {
  const elsewhere = await startBackend()
  const bounce = await startBackend(307 as never)
  // The in process backend answers 307 with no Location; the out of process
  // one names the other server, which must never see a request.
  const r = reporterFor(bounce)
  await r.report('lock_lost', 'run')
  const away = await startOutOfProcess('307', `${elsewhere.url}/api/v1/integrations/stand-downs`)
  const q = reporterFor(away)
  await q.report('passive_at_boot', 'boot')
  q.reportSync('exit_uncaught', 'run')
  await settle(200)
  assert.equal(elsewhere.requests.length, 0, 'the redirect target never saw the token')
  assert.equal((await away.captured()).length, 2)
  for (const line of [...r.logs, ...q.logs]) assert.match(line, / (could not be sent|not taken \(HTTP 307\)), not retried$/)
})

test('the version is read once, when the reporter is made at boot', async () => {
  const backend = await startBackend()
  let reads = 0
  const r = reporterFor(backend, { pluginVersion: () => (reads++, VERSION) })
  assert.equal(reads, 1, 'read at creation')
  await r.report('lock_lost', 'run')
  await r.report('arm_failed', 'run')
  await r.report('passive_at_boot', 'boot')
  assert.equal(reads, 1, 'never again: a clone updated in place still reports the version that is running')
  assert.equal(backend.requests.length, 3)
})

// ── The heartbeat's two new fields ──────────────────────────────────────────

test('the heartbeat env carries the fine identity route and homeConfirmed, and only listed values', () => {
  const proc = { cwd: () => '/x', platform: 'linux' }
  for (const route of BACKEND_ROUTES) {
    for (const homeConfirmed of [true, false]) {
      const env = heartbeatEnv(proc, { identityRoute: route, homeConfirmed })
      assert.equal(env.identityRoute, route)
      assert.equal(env.homeConfirmed, homeConfirmed)
    }
  }
  for (const junk of [...COARSE_ROUTES, 'junk', '', 3, null]) {
    const env = heartbeatEnv(proc, { identityRoute: junk, homeConfirmed: 'true' } as never)
    assert.equal('identityRoute' in env, false, `identityRoute ${String(junk)} dropped`)
    assert.equal('homeConfirmed' in env, false, 'a string is not a boolean')
  }
})

test("Data's rule on the heartbeat: the beat sends the fine route, never a coarse word, and no env key the backend does not declare", async () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const bodies: Array<Record<string, any>> = []
  for (const [identityRoute, homeConfirmed] of [
    ['sole-per-assistant', false],
    ['folder-pin', true],
    ['elimination', true],
  ] as const) {
    const hb = startVersionHeartbeat({
      authMode: 'pairing',
      rootDir: root,
      post: async (_path: string, body: Record<string, unknown>) => void bodies.push(body),
      log: () => {},
      machineId: () => MACHINE_ID,
      identityRoute,
      homeConfirmed,
    } as never)
    assert.ok(hb)
    clearInterval(hb!.timer)
    clearInterval(hb!.readinessTimer)
    clearInterval(hb!.statusTimer)
  }
  await settle(50)
  assert.equal(bodies.length, 3)
  assert.equal(bodies[0].env.identityRoute, 'sole-per-assistant')
  assert.equal(bodies[0].env.homeConfirmed, false)
  assert.equal(bodies[1].env.identityRoute, 'folder-pin')
  assert.equal(bodies[1].env.homeConfirmed, true)
  assert.equal('identityRoute' in bodies[2].env, false, 'a coarse word is dropped, never sent')
  for (const body of bodies) {
    for (const key of Object.keys(body.env)) assert.ok(BACKEND_HEARTBEAT_ENV_KEYS.includes(key), `env key ${key}`)
    assert.ok(!COARSE_ROUTES.includes(body.env.identityRoute))
  }
})
