/**
 * Every stand-down site in server.ts, RUN against a fake backend (identity
 * race plan step 3, board row fc75c7c3, plugin 0.65.3).
 *
 * THE SITES. facts.md section 7 of the plan lists 20 places where a daemon
 * refuses, exits, goes passive or switches a duty off. Twelve report, with
 * eight reason codes; eight report nothing (no single pairing to report under,
 * no credentials, a normal shutdown, an update restart that already reports
 * itself, or a refusal the backend itself issued).
 *
 * WHY THIS RUNS THE REAL CODE. server.ts cannot be imported without booting a
 * daemon, and a grep is green on a call that never runs. So each site is
 * found in server.ts by its syntax (the TypeScript parser, not a line number),
 * lifted with the daemon's own stand-down wiring (IDENTITY_ROUTE, the reporter
 * and reportStandDown), transpiled, and run against stubs. The reporter is the
 * real one from lib/stand-down-report.ts, sending real HTTP to a local server
 * that answers as the backend does. test/peer-403-loop.test.ts does the same.
 *
 * Run with: npx tsx --test test/stand-down-sites.test.ts
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

import { resolveAuth } from '../lib/agent-credentials.ts'
import { readOwnVersion } from '../lib/version-heartbeat.ts'
import { normalizeMachineId } from '../lib/machine-id.mjs'

// Absent before 0.65.3: then nothing in server.ts references it either.
const lib: Record<string, any> = await import('../lib/stand-down-report.ts').catch(() => ({}))

const SERVER = readFileSync(new URL('../server.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const SF = ts.createSourceFile('server.ts', SERVER, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS)
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const VERSION = readOwnVersion(ROOT)

const TOKEN = 'pair_SITE_SECRET_51b2'
const MACHINE_ID = 'aaaabbbb-cccc-4ddd-8eee-ffff00001111'

// ── The fake backend ────────────────────────────────────────────────────────

interface Captured {
  path: string
  headers: IncomingHttpHeaders
  body: Record<string, unknown>
}

interface Backend {
  url: string
  /** Every request received so far. */
  captured(): Promise<Captured[]>
}

const servers: Array<{ server: Server; sockets: Set<Socket> }> = []
after(async () => {
  await Promise.all(
    servers.map(
      ({ server, sockets }) =>
        new Promise<void>((resolve) => {
          for (const s of sockets) s.destroy()
          server.close(() => resolve())
        }),
    ),
  )
})

/** In this process: every site but the two exit sites. */
async function startBackend(hang = false): Promise<Backend> {
  const requests: Captured[] = []
  const backend: Backend = { url: '', captured: async () => requests }
  const sockets = new Set<Socket>()
  const server = createServer((req, res) => {
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      let body: Record<string, unknown> = {}
      try {
        body = JSON.parse(raw)
      } catch {}
      requests.push({ path: req.url ?? '', headers: req.headers, body })
      if (hang) return
      res.writeHead(204)
      res.end()
    })
  })
  server.on('connection', (s) => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
  })
  servers.push({ server, sockets })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  backend.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return backend
}

/** In a process of its own (test/fixtures/stand-down-backend.mjs): the exit
 *  sites block this process while they report, so only this one can answer. */
const children: Array<() => void> = []
after(() => children.forEach((close) => close()))
async function startOutOfProcess(hang = false): Promise<Backend> {
  const fixture = fileURLToPath(new URL('./fixtures/stand-down-backend.mjs', import.meta.url))
  const child = spawn(process.execPath, [fixture, hang ? 'hang' : 'validate'], { stdio: ['pipe', 'pipe', 'inherit'] })
  children.push(() => {
    try {
      child.stdin!.end()
      child.kill()
    } catch {}
  })
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
  return { url, captured: async () => (await (await fetch(`${url}/captured`)).json()) as Captured[] }
}

// ── Finding a site by its syntax ────────────────────────────────────────────

function find(pred: (n: ts.Node) => boolean, root: ts.Node = SF): ts.Node[] {
  const out: ts.Node[] = []
  const walk = (n: ts.Node) => {
    if (pred(n)) out.push(n)
    ts.forEachChild(n, walk)
  }
  walk(root)
  return out
}

function one(pred: (n: ts.Node) => boolean, what: string, root: ts.Node = SF): ts.Node {
  const found = find(pred, root)
  assert.equal(found.length, 1, `${what}: expected exactly one in server.ts, found ${found.length}`)
  return found[0]
}

const text = (n: ts.Node) => n.getText(SF)
const ifWith = (cond: string) => (n: ts.Node) => ts.isIfStatement(n) && text(n.expression) === cond
const fnNamed = (name: string) => (n: ts.Node) => ts.isFunctionDeclaration(n) && n.name?.text === name
const varNamed = (name: string) => (n: ts.Node) =>
  ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name
const callOf = (callee: string, firstArg?: string) => (n: ts.Node) =>
  ts.isCallExpression(n) &&
  text(n.expression) === callee &&
  (firstArg === undefined || (n.arguments[0] !== undefined && text(n.arguments[0]) === firstArg))
const isInside = (n: ts.Node, ancestor: ts.Node) => {
  for (let p = n.parent; p; p = p.parent) if (p === ancestor) return true
  return false
}

/** The arrow function body of `const armDelivery = async () => {...}`. */
const armDelivery = () => (one(varNamed('armDelivery'), 'armDelivery') as ts.VariableDeclaration).initializer!
const reArmBranch = () => one(ifWith('deliveryLoopsStarted'), 'the re-arm branch', armDelivery())

/** The daemon's own stand-down wiring, lifted when it exists. */
function wiring(): string {
  const parts: string[] = []
  for (const name of ['IDENTITY_ROUTE', 'standDownReporter']) {
    const found = find(varNamed(name))
    if (found.length === 1) parts.push(text(found[0].parent.parent)) // the whole `const x = ...` statement
  }
  for (const name of ['standDownPhase', 'reportStandDown', 'reportStandDownBeforeExit']) {
    const found = find(fnNamed(name))
    if (found.length === 1) parts.push(text(found[0]))
  }
  return parts.join('\n')
}

// ── Running one site ────────────────────────────────────────────────────────

interface Run {
  backend: Backend
  /** report() calls the site made, deduplicated or not, in order. */
  reports: Array<{ reason: string; phase: string }>
  /** Every report the site started, settled. */
  settled(): Promise<void>
  /** Each exit, when, whether the event loop had turned since the site
   *  started, and what the log said at that moment. */
  exits: Array<{ code: number; atMs: number; loopRan: boolean; logsAtExit: string[] }>
  logs: string[]
  scope: Record<string, any>
  tookMs: number
}

function fakeProcess(exits: Run['exits'], logs: string[], started: () => number, loop: { ran: boolean }) {
  return {
    pid: 4242,
    platform: 'linux',
    env: {} as Record<string, string>,
    exit: (code: number) => void exits.push({ code, atMs: Date.now() - started(), loopRan: loop.ran, logsAtExit: [...logs] }),
    stderr: { write: (s: string) => void logs.push(String(s)) },
    on: () => undefined,
    once: () => undefined,
  }
}

/**
 * Lift `code` (a statement, or an expression when `asExpression`) and run it
 * with the stand-down wiring in a scope of stubs. `via` is how the stubbed
 * resolver found the credentials.
 */
async function runSite(
  code: string,
  opts: {
    via?: string
    hang?: boolean
    scope?: Record<string, unknown>
    asExpression?: boolean
    platform?: string
    /** The backend in a process of its own (the exit sites block this one). */
    outOfProcess?: boolean
  } = {},
): Promise<Run> {
  const backend = opts.outOfProcess ? await startOutOfProcess(opts.hang) : await startBackend(opts.hang)
  const loop = { ran: false }
  const reports: Run['reports'] = []
  const inflight: Promise<unknown>[] = []
  const exits: Run['exits'] = []
  const logs: string[] = []
  let t0 = Date.now()
  const scope: Record<string, any> = {
    // The stand-down library, wrapped only to know when its sends finish.
    ...lib,
    createStandDownReporter: (deps: Record<string, unknown>) => {
      const real = lib.createStandDownReporter(deps)
      return {
        report: (reason: string, phase: string) => {
          reports.push({ reason, phase })
          const p = real.report(reason, phase)
          inflight.push(p)
          return p
        },
        reportSync: (reason: string, phase: string) => {
          reports.push({ reason, phase })
          real.reportSync(reason, phase)
        },
      }
    },
    // What the reporter's providers read in server.ts.
    resolveAuth,
    readOwnVersion,
    __IMPORT_META_DIR: ROOT,
    CREDENTIALS_SELECTION: { kind: 'ok', path: 'credentials-1040.json', via: opts.via ?? 'sole-per-assistant' },
    CREDENTIALS_FILE: { backendUrl: backend.url, pairingToken: TOKEN, userId: 'u-1', assistantId: 1040 },
    // The machine id is READ for a report, never minted (the heartbeat mints it).
    ensureMachineId: () => assert.fail('a report never mints the machine id'),
    machineIdPath: (home: string) => `${home}/.bgos-agent/machine-id`,
    readFileSync: (path: string) => {
      assert.equal(path, 'never-the-real-home/.bgos-agent/machine-id')
      return `${MACHINE_ID}\n`
    },
    normalizeMachineId,
    homedir: () => 'never-the-real-home',
    channelEverArmed: false,
    log: (line: string) => void logs.push(line),
    process: fakeProcess(exits, logs, () => t0, loop),
    ...opts.scope,
  }
  if (opts.platform) scope.process.platform = opts.platform
  const body = opts.asExpression ? `await (${code});` : code
  const source = `async function __site(__scope) {\n with (__scope) {\n${wiring()}\n${body}\n }\n}`
    .replace(/import\.meta\.dir/g, '__IMPORT_META_DIR')
  const js = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, alwaysStrict: false },
  }).outputText
  const site = new Function(`${js}\nreturn __site;`)() as (s: unknown) => Promise<unknown>
  const proxy = new Proxy(scope, {
    has: (t, k) => typeof k === 'string' && k in t,
    get: (t, k) => (t as Record<string | symbol, unknown>)[k],
    set: (t, k, v) => {
      ;(t as Record<string | symbol, unknown>)[k] = v
      return true
    },
  })
  t0 = Date.now()
  setTimeout(() => (loop.ran = true), 0)
  await site(proxy)
  const tookMs = Date.now() - t0
  return {
    backend,
    reports,
    settled: async () => {
      await Promise.all(inflight)
    },
    exits,
    logs,
    scope,
    tookMs,
  }
}

/** The one report a site made, as the backend received it. */
async function assertOneReport(run: Run, reason: string, phase: 'boot' | 'run', route = 'sole-per-assistant') {
  await run.settled()
  assert.deepEqual(run.reports, [{ reason, phase }], `the site reports ${reason} (${phase}) once`)
  const requests = await run.backend.captured()
  assert.equal(requests.length, 1, 'the fake backend received exactly one request')
  const req = requests[0]
  assert.equal(req.path, '/api/v1/integrations/stand-downs')
  assert.equal(req.headers['x-bgos-pairing'], TOKEN)
  assert.deepEqual(Object.keys(req.body), ['reason', 'route', 'phase', 'machineId', 'pluginVersion', 'at'])
  assert.equal(req.body.reason, reason)
  assert.equal(req.body.route, route)
  assert.equal(req.body.phase, phase)
  assert.equal(req.body.machineId, MACHINE_ID)
  assert.equal(req.body.pluginVersion, VERSION)
}

async function assertSilent(run: Run) {
  await run.settled()
  await new Promise((r) => setTimeout(r, 50))
  assert.deepEqual(run.reports, [], 'the site reports nothing')
  assert.equal((await run.backend.captured()).length, 0, 'the fake backend received nothing')
}

// Stubs every lock site needs.
const lockScope = () => ({
  channelArmed: true,
  lockHeld: true,
  lockIoErrorWarned: false,
  standDownIgnoredFrames: new Set<string>(),
  stopHookIntake: () => undefined,
  resumeLockRecheck: () => undefined,
  lockYieldReason: () => '',
  startHookIntakeIfHolder: () => undefined,
  monitoredChatIds: [],
  lastDeliveryHeartbeatAt: null,
})

// ── The twelve sites that report ────────────────────────────────────────────

test('site 1, refuse_home_mismatch: the home refusal reports once (boot), with the route the resolver chose', async () => {
  const site = one(ifWith("HOME_BINDING.action === 'refuse'"), 'the home refusal')
  const run = await runSite(text(site), {
    via: 'legacy',
    scope: {
      HOME_BINDING: { action: 'refuse', assistantId: '1040' },
      formatHomeBindingRefusal: () => 'refused',
      serveHomeRefused: async () => true,
    },
  })
  await assertOneReport(run, 'refuse_home_mismatch', 'boot', 'legacy')
  assert.deepEqual(run.exits.map((e) => e.code), [0], 'it still exits after serving the notice')
})

test('site 2, passive_at_boot: a daemon that finds the lock held at boot reports once (boot)', async () => {
  const site = one(ifWith('lockAtBoot.acquired'), 'the boot lock branch')
  const run = await runSite(text(site), {
    via: 'folder-pin',
    scope: {
      ...lockScope(),
      lockAtBoot: { acquired: false, holderPid: 77 },
      formatPassiveBanner: () => 'passive',
      armDelivery: async () => assert.fail('a passive boot never arms'),
    },
  })
  await assertOneReport(run, 'passive_at_boot', 'boot', 'folder-pin')
})

test('site 3, lock_lost: the poll tick that finds a rival holding the lock reports once (run)', async () => {
  const site = one(ifWith('!refreshed.held'), 'the tick refresh')
  const run = await runSite(text(site), {
    via: 'env-assistant',
    scope: { ...lockScope(), channelEverArmed: true, refreshed: { held: false, holderPid: 9 } },
  })
  await assertOneReport(run, 'lock_lost', 'run', 'env-assistant')
  assert.equal(run.scope.channelArmed, false)
})

test('site 4, lock_lost: the re-arm gate that finds a rival reports once', async () => {
  const gates = find(ifWith('!gateRefresh.held'), armDelivery())
  assert.equal(gates.length, 2, 'two arm gates')
  const site = gates.find((g) => isInside(g, reArmBranch()))!
  assert.ok(site, 'one gate is in the re-arm branch')
  const run = await runSite(text(site), {
    scope: { ...lockScope(), channelEverArmed: true, gateRefresh: { held: false, holderPid: 9 } },
  })
  await assertOneReport(run, 'lock_lost', 'run')
})

test('site 5, lock_lost: a re-arm that finishes without the lock reports once', async () => {
  const sites = find(ifWith('!lockHeld'), armDelivery())
  const site = sites.find((s) => isInside(s, reArmBranch()))!
  assert.ok(site, 'the re-arm branch checks lockHeld')
  const run = await runSite(text(site), { scope: { ...lockScope(), lockHeld: false, channelEverArmed: true } })
  await assertOneReport(run, 'lock_lost', 'run')
})

test('site 6, lock_lost: the end of the first arm that finds a rival reports once (boot, it never armed)', async () => {
  const site = find(ifWith('!gateRefresh.held'), armDelivery()).find((g) => !isInside(g, reArmBranch()))!
  assert.ok(site, 'one gate ends the first arm')
  const run = await runSite(text(site), { scope: { ...lockScope(), gateRefresh: { held: false, holderPid: 9 } } })
  await assertOneReport(run, 'lock_lost', 'boot')
})

test('site 7, lock_lost: the end of the first arm with the lock lost meanwhile reports once', async () => {
  const site = find(ifWith('!lockHeld'), armDelivery()).find((s) => !isInside(s, reArmBranch()))!
  assert.ok(site, 'the first arm checks lockHeld at its end')
  const run = await runSite(text(site), { scope: { ...lockScope(), lockHeld: false } })
  await assertOneReport(run, 'lock_lost', 'boot')
})

test('site 8, arm_failed: an arm that throws after a promotion reports once', async () => {
  const recheck = (one(varNamed('resumeLockRecheck'), 'resumeLockRecheck') as ts.VariableDeclaration).initializer!
  const call = one(callOf('armDelivery().catch'), 'the promotion catch', recheck) as ts.CallExpression
  const run = await runSite(`(${text(call.arguments[0])})(new Error('arm blew up'))`, {
    asExpression: true,
    scope: { ...lockScope(), channelEverArmed: true, pollLoopKicked: true, deliveryLoopsStarted: true },
  })
  await assertOneReport(run, 'arm_failed', 'run')
})

test('site 9, exit_uncaught: an uncaught exception reports once while the process stands still, then exits 1', async () => {
  const call = one(callOf('process.on', "'uncaughtException'"), 'the uncaughtException handler') as ts.CallExpression
  let shutdowns = 0
  const run = await runSite(`(${text(call.arguments[1])})(new Error('boom'))`, {
    asExpression: true,
    outOfProcess: true,
    scope: {
      channelArmed: true,
      channelEverArmed: true,
      shuttingDown: false,
      handlingFault: false,
      isBrokenPipe: () => false,
      shutdown: () => void shutdowns++,
      describeFault: (e: Error) => e.message,
      flushChatCursors: () => undefined,
    },
  })
  await assertOneReport(run, 'exit_uncaught', 'run')
  assert.deepEqual(run.exits.map((e) => [e.code, e.loopRan]), [[1, false]], 'exit 1, and nothing else ran before it')
  assert.ok(run.exits[0].logsAtExit.includes('stand-down exit_uncaught (run) reported (HTTP 204)'), 'the report was in before the exit')
  // Belt and braces, should a runtime ever turn the loop during the send.
  assert.equal(run.scope.channelArmed, false, 'delivery is off before the send')
  assert.equal(run.scope.shuttingDown, true, 'a racing stdin close cannot turn exit 1 into exit 0')
  assert.equal(shutdowns, 0)
})

test('site 10, exit_boot_fatal: main() rejecting reports once while the process stands still, then exits 1', async () => {
  const call = one(callOf('main().catch'), 'the main() catch') as ts.CallExpression
  const run = await runSite(`(${text(call.arguments[0])})(new Error('boot died'))`, {
    asExpression: true,
    outOfProcess: true,
    scope: { channelArmed: true },
  })
  await assertOneReport(run, 'exit_boot_fatal', 'boot')
  assert.deepEqual(run.exits.map((e) => [e.code, e.loopRan]), [[1, false]], 'exit 1, and nothing else ran before it')
  assert.ok(run.exits[0].logsAtExit.includes('stand-down exit_boot_fatal (boot) reported (HTTP 204)'), 'the report was in before the exit')
  assert.equal(run.scope.channelArmed, false, 'delivery is off before the send')
})

const reconcile = () => one(fnNamed('reconcileAlwaysOn'), 'reconcileAlwaysOn')

// Site 11 speaks only when Keep agents running is known to be ON for this
// agent (Data, CI owner, on PR #203): every Windows daemon used to send it once
// per boot whatever the setting. The switch is the assistant row's alwaysOn
// (the computer's switch marks every Claude Code agent on it always-on). The
// whole reconcile runs three times, as a boot, a config event and the 15 min
// tick would run it. The first reconcile runs inside the first arm
// (armDelivery step 7), and that arm sets channelEverArmed while the row is
// still being read, so the report must keep the reconcile's boot phase.
async function runWindowsReconcile(read: { row?: unknown; fails?: boolean }) {
  let answer!: () => void
  const answered = new Promise<void>((resolve) => (answer = resolve))
  const reads: string[] = []
  const pending: Promise<unknown>[] = []
  const run = await runSite(`${text(reconcile())}\nawait reconcileAlwaysOn()\nawait reconcileAlwaysOn()\nawait reconcileAlwaysOn()`, {
    platform: 'win32',
    scope: {
      reconcileBusy: false,
      reconcileDisabledReason: null,
      ASSISTANT_ID: '1040',
      bgosGetCachedOn304: (path: string) => {
        reads.push(path)
        const p = answered.then(() => {
          if (read.fails) throw new Error(`GET ${path}: HTTP 503`)
          return read.row
        })
        pending.push(p.catch(() => undefined))
        return p
      },
    },
  })
  run.scope.channelEverArmed = true // the first arm finishes while the row is read
  answer()
  await Promise.all(pending)
  await new Promise((r) => setTimeout(r, 20))
  return { run, reads }
}

const WINDOWS_LINE = 'always-on reconcile DISABLED on this Windows host'
const saidOnce = (run: Run) =>
  assert.equal(run.logs.filter((l) => l.startsWith(WINDOWS_LINE)).length, 1, 'the local line is logged once, switch or not')

for (const [label, read] of [
  ['the switch is off', { row: { code: 'claude-code', alwaysOn: false } }],
  ['the switch is unknown: the row carries no flag', { row: { code: 'claude-code' } }],
  ['the switch is unknown: the flag is not a boolean', { row: { code: 'claude-code', alwaysOn: 'true' } }],
  ['the switch is unknown: the row could not be read', { fails: true }],
  ['the agent is not a Claude Code one (it keeps itself alive)', { row: { code: 'codex', alwaysOn: true } }],
] as const) {
  test(`site 11, always_on_unsupported: a Windows reconcile reports nothing when ${label}`, async () => {
    const { run, reads } = await runWindowsReconcile(read)
    await assertSilent(run)
    saidOnce(run)
    assert.ok(reads.length <= 1, `the row is read at most once per process, read ${reads.length} times`)
  })
}

test('site 11, always_on_unsupported: with the switch on, a Windows reconcile reports exactly once per boot, as a boot one', async () => {
  const { run, reads } = await runWindowsReconcile({ row: { code: 'claude-code', alwaysOn: true } })
  await assertOneReport(run, 'always_on_unsupported', 'boot')
  saidOnce(run)
  assert.deepEqual(reads, ['assistants/1040'], "the switch is read once, from this agent's own row")
})

test('site 12, always_on_supervisor_missing: a missing supervisor binary reports once', async () => {
  const site = one(ifWith('!existsSync(BGOS_AGENT_BIN)'), 'the missing binary branch', reconcile())
  const run = await runSite(text(site), {
    scope: { reconcileDisabledReason: null, existsSync: () => false, BGOS_AGENT_BIN: 'bgos-agent' },
  })
  await assertOneReport(run, 'always_on_supervisor_missing', 'boot')
})

// ── The eight sites that report nothing ─────────────────────────────────────

test('silent 1: the several-agents refusal reports nothing (no single pairing to report under)', async () => {
  const site = one(ifWith("CREDENTIALS_SELECTION.kind === 'refuse'"), 'the ambiguous host refusal')
  const run = await runSite(text(site), {
    scope: { CREDENTIALS_SELECTION: { kind: 'refuse', candidateIds: ['1', '2'] }, formatCredentialsRefusal: () => 'x' },
  })
  await assertSilent(run)
  assert.deepEqual(run.exits.map((e) => e.code), [1])
})

test('silent 2: the unpaired stub reports nothing (no credentials)', async () => {
  const site = one(ifWith('!AUTH.complete'), 'the unpaired branch')
  const run = await runSite(text(site), {
    scope: {
      AUTH: { complete: false },
      formatAuthResolution: () => 'x',
      PAIRING_REJECTION_WARN: null,
      CREDENTIALS_PATH: 'x',
      missingCredsMessage: () => 'x',
      servePairRequired: async () => true,
    },
  })
  await assertSilent(run)
})

test('silent 3: a normal shutdown (SIGINT, SIGTERM, the session going away) reports nothing', async () => {
  const shutdown = one(varNamed('shutdown'), 'shutdown') as ts.VariableDeclaration
  const run = await runSite(`(${text(shutdown.initializer!)})('SIGTERM', 143)`, {
    asExpression: true,
    scope: {
      shuttingDown: false,
      describeShutdownCause: () => 'x',
      selfUpdater: null,
      stopHookIntake: () => undefined,
      agentStatePublisher: { shutdown: () => undefined },
      flushChatCursors: () => undefined,
      releasePairingLock: () => undefined,
      PAIRING_LOCK_PATH: 'x',
      loginController: { dispose: () => undefined },
      browserHost: null,
    },
  })
  await assertSilent(run)
  assert.deepEqual(run.exits.map((e) => e.code), [143])
})

test('silent 4: the self-update restart exit reports nothing (updateReadiness reports it)', async () => {
  const exit = one(
    (n) => ts.isPropertyAssignment(n) && text(n.name) === 'exit' && text(n.initializer) === '(code) => process.exit(code)',
    'the self-updater exit hook',
  ) as ts.PropertyAssignment
  const run = await runSite(`(${text(exit.initializer)})(0)`, { asExpression: true })
  await assertSilent(run)
  assert.deepEqual(run.exits.map((e) => e.code), [0])
})

test('silent 5: the update stream switched off by a revoked pairing reports nothing (the backend revoked it)', async () => {
  const deactivate = text(one(fnNamed('deactivateStream'), 'deactivateStream'))
  const revoked = find(ifWith('err instanceof PairingRevokedError'))
  assert.equal(revoked.length, 2, 'two revoked catches')
  class PairingRevokedError extends Error {}
  for (const code of [`${deactivate}\ndeactivateStream('pairing revoked')`, ...revoked.map((r) => `${deactivate}\n${text(r)}`)]) {
    const run = await runSite(code, {
      scope: { err: new PairingRevokedError('revoked'), PairingRevokedError, streamFeatureDetected: true, streamAuthority: {} },
    })
    await assertSilent(run)
    assert.equal(run.scope.streamFeatureDetected, false, 'the stream really was switched off')
  }
})

test('silent 6, 7, 8: the per chat refusals the backend issued report nothing', async () => {
  const peer = one(ifWith('peerRefusalOf(err) === PEER_NOT_PARTICIPANT'), 'the reply 403 branch')
  const run6 = await runSite(`${text(peer)}`, {
    scope: {
      err: new Error('403'),
      peerRefusalOf: () => 'peer_not_participant',
      PEER_NOT_PARTICIPANT: 'peer_not_participant',
      pendingInbounds: new Map(),
      resolvedChatId: '5',
      answeringInboundId: 1,
      peerReplyRefusedChats: new Set(),
      clearInbound: () => undefined,
      peerNotParticipantResult: () => ({ content: [] }),
    },
  })
  await assertSilent(run6)
  for (const [name, call] of [
    ['refuseHookRailChat', "refuseHookRailChat('5', new Error('400'))"],
    ['refuseA2aToolPost', "refuseA2aToolPost('5', new Error('400'))"],
  ]) {
    const run = await runSite(`${text(one(fnNamed(name), name))}\n${call}`, {
      scope: {
        peerRefusalOf: () => 'a2a_route_required',
        A2A_ROUTE_REQUIRED: 'a2a_route_required',
        a2aRouteRefusedChats: new Set(),
        hookRailRefusedChats: new Set(),
        peerRefusalStatus: () => 400,
      },
    })
    await assertSilent(run)
  }
})

// ── Never delay boot, never delay an exit past the deadline ─────────────────

test('a boot that goes passive is not delayed by a backend that never answers', async () => {
  const site = one(ifWith('lockAtBoot.acquired'), 'the boot lock branch')
  const run = await runSite(text(site), {
    hang: true,
    scope: { ...lockScope(), lockAtBoot: { acquired: false, holderPid: 77 }, formatPassiveBanner: () => 'p' },
  })
  assert.ok(run.tookMs < 200, `the passive boot took ${run.tookMs} ms`)
  assert.equal(run.reports.length, 1)
  await run.settled()
})

test('the home refusal serves its notice at once and exits within the 2 s deadline when the backend never answers', async () => {
  const site = one(ifWith("HOME_BINDING.action === 'refuse'"), 'the home refusal')
  let servedAtMs = -1
  const t = Date.now()
  const run = await runSite(text(site), {
    hang: true,
    scope: {
      HOME_BINDING: { action: 'refuse', assistantId: '1040' },
      formatHomeBindingRefusal: () => 'refused',
      serveHomeRefused: async () => {
        servedAtMs = Date.now() - t
        return true
      },
    },
  })
  assert.ok(servedAtMs >= 0 && servedAtMs < 200, `the notice was served after ${servedAtMs} ms`)
  assert.equal(run.exits.length, 1)
  assert.ok(run.exits[0].atMs < 2600, `exit after ${run.exits[0].atMs} ms`)
  await run.settled()
})

test('an uncaught exception exits within the 2 s deadline when the backend never answers, and nothing else runs meanwhile', async () => {
  const call = one(callOf('process.on', "'uncaughtException'"), 'the uncaughtException handler') as ts.CallExpression
  const run = await runSite(`(${text(call.arguments[1])})(new Error('boom'))`, {
    asExpression: true,
    hang: true,
    outOfProcess: true,
    scope: {
      channelArmed: true,
      channelEverArmed: true,
      shuttingDown: false,
      handlingFault: false,
      isBrokenPipe: () => false,
      shutdown: () => undefined,
      describeFault: (e: Error) => e.message,
      flushChatCursors: () => undefined,
    },
  })
  assert.equal(run.exits.length, 1)
  const [exit] = run.exits
  assert.equal(exit.code, 1)
  assert.equal(exit.loopRan, false, 'no poll, arm, recheck or socket frame can run between the fault and the exit')
  assert.ok(exit.atMs >= 1500 && exit.atMs < 2800, `exit after ${exit.atMs} ms`)
  assert.ok(run.logs.includes('stand-down exit_uncaught (run) got no answer within 2000 ms, not retried'))
})

// ── The whole file, counted ─────────────────────────────────────────────────

test('server.ts reports from exactly these twelve places, with all eight reasons, and the route is the fine one', () => {
  const calls = find(
    (n) =>
      ts.isCallExpression(n) &&
      ['reportStandDown', 'reportStandDownBeforeExit', 'standDownReporter.report', 'standDownReporter.reportSync'].includes(
        text(n.expression),
      ),
  ) as ts.CallExpression[]
  // The calls with no literal reason are the two helpers passing theirs on.
  const forwarding = calls.filter((c) => !ts.isStringLiteral(c.arguments[0]))
  assert.equal(forwarding.length, 2)
  assert.ok(isInside(forwarding[0], one(fnNamed('reportStandDown'), 'reportStandDown')))
  assert.ok(isInside(forwarding[1], one(fnNamed('reportStandDownBeforeExit'), 'reportStandDownBeforeExit')))
  // The exit sites block on their report; every other site fires and forgets.
  for (const c of calls.filter((c) => ts.isStringLiteral(c.arguments[0]))) {
    const reason = (c.arguments[0] as ts.StringLiteral).text
    const blocking = text(c.expression) === 'reportStandDownBeforeExit'
    assert.equal(blocking, reason === 'exit_uncaught' || reason === 'exit_boot_fatal', `${reason} blocking: ${blocking}`)
  }
  const sites = calls.filter((c) => ts.isStringLiteral(c.arguments[0]))
  const reasons = sites.map((c) => (c.arguments[0] as ts.StringLiteral).text)
  assert.equal(sites.length, 12, `report calls: ${reasons.join(', ')}`)
  assert.deepEqual([...new Set(reasons)].sort(), [...(lib.STAND_DOWN_REASONS ?? [])].sort())
  assert.equal(reasons.filter((r) => r === 'lock_lost').length, 5)
  // The fine route from the resolver, never the lock's three words.
  assert.match(SERVER, /\nconst IDENTITY_ROUTE = reportedIdentityRoute\(CREDENTIALS_SELECTION\.via\)\n/)
  const reporter = text(one(varNamed('standDownReporter'), 'the reporter'))
  assert.match(reporter, /route: IDENTITY_ROUTE,/)
  assert.doesNotMatch(reporter, /:\s*LOCK_ROUTE\b/)
  // Under the pairing token the heartbeat uses, resolved from the same file.
  assert.match(reporter, /credentials: \(\) => pairingCredential\(resolveAuth\(\{ env: process\.env, creds: CREDENTIALS_FILE \}\)\)/)
  // The machine id is read, never minted: a refused stray writes nothing.
  assert.doesNotMatch(reporter, /ensureMachineId/)
  // Nobody posts to the route by hand.
  assert.doesNotMatch(SERVER, /integrations\/stand-downs/)
})

test('the heartbeat carries the fine route and homeConfirmed', () => {
  const call = one(callOf('startVersionHeartbeat'), 'the heartbeat start')
  assert.match(text(call), /\n\s+identityRoute: IDENTITY_ROUTE,\n/)
  assert.match(text(call), /\n\s+homeConfirmed: HOME_CONFIRMED,\n/)
  assert.doesNotMatch(text(call), /:\s*LOCK_ROUTE\b/)
})

test('every arm marks the process as armed, so a later stand-down is a run one', () => {
  const arms = find(
    (n) => ts.isBinaryExpression(n) && text(n.left) === 'channelArmed' && text(n.right) === 'true',
  )
  assert.equal(arms.length, 2)
  for (const arm of arms) {
    const block = arm.parent.parent as ts.Block
    assert.match(text(block), /channelEverArmed = true/, 'the arm also sets channelEverArmed')
  }
})
