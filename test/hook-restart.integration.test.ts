/**
 * End to end, deterministic: a daemon that finds the private turn hook missing
 * registers it in a REAL clone workspace (lib/clone-hooks.mjs on a temp folder),
 * asks for ONE restart through the REAL restart ladder (lib/update-rpc.ts), and
 * the REAL 0.67.x launcher loop (bin/hoai-core.mjs superviseClaude, byte
 * identical to v0.67.5) relaunches claude on the SAME pinned session. The
 * restarted daemon then finds the hook registered (lib/private-hook-presence.ts
 * over the same real files) and never asks again, not even when its own hook
 * detection disagrees and it writes the hook a second time.
 *
 * At main this is red for the true reason: the daemon registers the hook and
 * only logs "restart this agent to load them", so claude keeps its pid and the
 * hook never loads.
 *
 * Run: npx tsx --test test/hook-restart.integration.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { sessionTranscriptPath, superviseClaude } from '../bin/hoai-core.mjs'
import { registerCloneHooks } from '../lib/clone-hooks.mjs'
import { privateHookPresence } from '../lib/private-hook-presence'
import { UpdateRpcHandler } from '../lib/update-rpc'

// Only a missing module reads as missing; a module that does not load is a failure of its own.
const hookRestart: any = await import('../lib/hook-restart.mjs').catch((err) => {
  if (err?.code === 'ERR_MODULE_NOT_FOUND') return null
  throw err
})

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const T0 = 1_800_000_000_000
const HOME = 'C:\\Users\\kc'
const CWD = 'C:\\agents\\vera'
const STATE = `${HOME}\\.bgos-agent\\909`
const MARKER = `${STATE}\\restart-requested.json`
const RECORD = `${STATE}\\hook-restart.json`
const PIN = '0f0e0d0c-1111-4222-8333-444455556666'
const BASE = ['--dangerously-skip-permissions', '--dangerously-load-development-channels', 'server:bgos']
const IDLE = { activeOperations: 0, pendingMessages: 0, pendingPermissions: 0 }

class FakeClaude extends EventEmitter {
  args: string[]
  constructor(args: readonly string[]) {
    super()
    this.args = [...args]
  }
  kill() {
    setTimeout(() => this.emit('exit', null, 'SIGTERM'), 1)
    return true
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 2))
async function until(check: () => boolean, what: string, ms = 3000) {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`)
    await tick()
  }
}

/** A clone workspace of THIS checkout with no hooks yet, and an empty CLI config folder. */
function workspace() {
  const ws = realpathSync(mkdtempSync(join(tmpdir(), 'hook-restart-ws-')))
  writeFileSync(join(ws, '.mcp.json'), JSON.stringify({ mcpServers: { bgos: { command: 'bun', args: [join(repoRoot, 'server.ts')] } } }))
  const configDir = realpathSync(mkdtempSync(join(tmpdir(), 'hook-restart-cfg-')))
  return { ws, configDir }
}

/**
 * `claudeKnown: false` is Vera's Windows daemon (2026-10-13): its PowerShell parent walk missed, so it does not know
 * its claude pid. `unreadable` is a process table that cannot be read at all.
 */
function harness({ forceOutcomes, claudeKnown = true, unreadable = false }: { forceOutcomes?: (boot: number) => string[] | null; claudeKnown?: boolean; unreadable?: boolean } = {}) {
  const { ws, configDir } = workspace()
  const clock = { now: T0 }
  const files = new Map<string, { text: string; mtimeMs: number }>()
  const put = (p: string, text: string) => files.set(p, { text, mtimeMs: clock.now })
  put(`${CWD}\\.bgos-agent-id`, '909\n')
  put(`${STATE}\\session-id`, `${PIN}\n`)
  put(sessionTranscriptPath(HOME, CWD, PIN), '{"type":"summary"}\n')

  type Gen = { claude: number; daemon: number; child: FakeClaude; dead: boolean; controller: any; registeredAtBoot: boolean; outcomes: string[]; bootAtMs: number }
  const gens: Gen[] = []
  const logs: string[] = []
  const prints: string[] = []
  const markersWritten: string[] = []
  const live = () => gens.filter((g) => !g.dead)
  const current = () => live().at(-1) ?? null

  const recordFs = {
    exists: (p: string) => files.has(p),
    readFile: (p: string) => files.get(p)?.text ?? null,
    createExclusive: (p: string, text: string) => {
      if (files.has(p)) return 'exists'
      put(p, text)
      return 'ok'
    },
  }
  // The daemon's restart ladder, exactly as server.ts builds it for a hoai launcher authority.
  const ladderFor = (g: Gen) =>
    new UpdateRpcHandler({
      postAck: async () => ({}),
      postProgress: async () => assert.fail('a self-requested restart posts nothing to the backend'),
      log: (l: string) => logs.push(`daemon ${g.daemon}: ${l}`),
      installMethod: () => 'clone',
      autoUpdateEnabled: () => true,
      updater: () => null,
      pendingRestartVersion: () => null,
      marketplaceUpdate: async () => ({}) as never,
      drainSnapshot: () => IDLE,
      restartAuthority: () => ({ kind: 'launcher', markerPath: MARKER }),
      spawnDetached: () => assert.fail('no service restart for a launcher authority'),
      writeMarker: (p: string) => {
        markersWritten.push(p)
        put(p, JSON.stringify({ requestedAt: new Date(clock.now).toISOString() }))
        return true
      },
      signalProcess: () => assert.fail('no signal for a launcher authority'),
      setDrainMode: () => {},
      requestHeartbeat: () => {},
      serviceOwnership: () => ({ ancestorPids: [], servicePid: null, ownPid: g.daemon }),
      setTimer: () => () => {},
    } as any) as any

  /** What server.ts does at boot: look for the hook, register it when missing, hand the outcomes on. */
  const boot = (g: Gen) => {
    const presence = privateHookPresence({
      installMethod: 'clone',
      pluginRoot: repoRoot,
      folders: [ws],
      configDir,
      env: {},
      readFile: (p) => readFileSync(p, 'utf8'),
      exists: (p) => existsSync(p),
      join,
    })
    g.bootAtMs = clock.now
    g.registeredAtBoot = presence.registered
    g.outcomes = presence.registered ? [] : [registerCloneHooks({ workdir: ws, pluginDir: repoRoot }).outcome]
    // This daemon's index: 0 for the first, 1 for the one the restart brings up.
    const forced = forceOutcomes?.(gens.length - 1)
    if (forced) g.outcomes = forced
    g.controller =
      hookRestart?.createHookRestart({
        outcomes: g.outcomes,
        folders: [ws],
        recordPath: RECORD,
        fs: recordFs,
        bootAtMs: g.bootAtMs,
        now: () => clock.now,
        ownPid: g.daemon,
        active: () => !g.dead,
        draining: () => false,
        updateLockHeld: () => false,
        // The workspace never had the hook rail, so no turn signal: the 30 minute rule.
        safeState: () => ({ turnInFlight: false, turnSignal: 'none', ...IDLE }),
        activityMs: () => [g.bootAtMs],
        claudePid: () => (claudeKnown ? g.claude : null),
        listProcesses: async () => (unreadable ? { ok: false, error: 'powershell_failed:1' } : {
          ok: true,
          processes: live().flatMap((x) => [
            { pid: x.claude, ppid: 4000, command: `claude ${x.child.args.join(' ')}` },
            { pid: x.daemon, ppid: x.claude, command: 'bun C:\\plugins\\bgos-claude-plugin\\server.ts' },
          ]),
        }),
        drain: () => {},
        requestRestart: () => ladderFor(g).restartAfterHookRegistration(),
        log: (l: string) => logs.push(`daemon ${g.daemon}: ${l}`),
        setInterval: () => ({ unref() {} }),
        clearInterval: () => {},
      }) ?? null
    g.controller?.start()
  }

  let nextPid = 5000
  const launch = () =>
    superviseClaude(BASE, {
      platform: 'win32',
      env: {},
      home: HOME,
      cwd: CWD,
      scriptDir: 'C:\\checkouts\\0.67.5\\bin',
      readFile: (p: string) => files.get(p)?.text ?? null,
      listDir: () => [],
      exists: (p: string) => files.has(p),
      writeFile: (p: string, c: string) => {
        put(p, c)
        return true
      },
      removeFile: (p: string) => files.delete(p),
      spawnImpl: ((_file: string, args: readonly string[]) => {
        const child = new FakeClaude(args)
        const g: Gen = { claude: nextPid++, daemon: nextPid++, child, dead: false, controller: null, registeredAtBoot: false, outcomes: [], bootAtMs: clock.now }
        child.on('exit', () => {
          g.dead = true
        })
        gens.push(g)
        boot(g)
        return child
      }) as never,
      spawnGateHelper: () => ({ pid: 1 }),
      writeErr: () => {},
      pollMs: 10,
      now: () => clock.now,
      print: (line: string) => prints.push(line),
      pidAlive: () => true,
      pidProcess: () => null,
      listProcesses: () => [],
      setTimer: (() => 0) as never,
      clearTimer: () => {},
      generateId: () => PIN,
      hasExpect: false,
      keepAlive: false,
      sleep: async (ms: number) => {
        clock.now += ms
        await tick()
      },
    })

  /** Let `ms` of session time pass, the live daemon's controller ticking on its poll. */
  const pass = async (ms: number) => {
    const end = clock.now + ms
    while (clock.now < end) {
      clock.now += 30_000
      await current()?.controller?.tick()
      await tick()
    }
  }
  return { ws, files, gens, live, current, logs, prints, markersWritten, launch, pass }
}

test('a daemon that registered the hook itself gets ONE restart: the 0.67.x launcher resumes the SAME session and the restarted daemon finds the hook and never asks again', async () => {
  const h = harness()
  const run = h.launch()
  await until(() => h.gens.length === 1, 'the first claude')
  const first = h.gens[0]
  assert.equal(first.registeredAtBoot, false, 'the workspace starts without the private turn hook')
  assert.deepEqual(first.outcomes, ['registered'], 'the first daemon registered it in the real workspace')
  await h.pass(29 * 60_000)
  assert.equal(h.gens.length, 1, 'nothing before 30 minutes of quiet: without the hook turn signal a turn may be running unseen')
  await h.pass(2 * 60_000)
  if (!hookRestart) {
    assert.fail(
      `the daemon registered the private turn hook in ${h.ws} and asked for no restart: claude ${first.claude} still runs 31 minutes later, ` +
        'so the hook never loads (server.ts:14783 at main only logs "restart this agent to load them")',
    )
  }
  await until(() => h.gens.length === 2, 'the launcher relaunch')
  assert.deepEqual(h.markersWritten, [`${'C:\\Users\\kc\\.bgos-agent\\909'}\\restart-requested.json`], 'one marker, through the ladder')
  assert.deepEqual(h.gens[1].child.args.slice(-2), ['--resume', PIN], 'the 0.67.x launcher resumes the agent\'s own pinned session')
  assert.ok(h.prints.some((l) => l.startsWith('[hoai] relaunching')), h.prints.join('\n'))
  // The restarted daemon: the hook is on disk, so nothing is registered and nothing is asked.
  assert.equal(h.gens[1].registeredAtBoot, true, 'the restarted daemon finds the hook registered')
  assert.deepEqual(h.gens[1].outcomes, [])
  await h.pass(60 * 60_000)
  assert.equal(h.gens.length, 2, `exactly one restart, got ${h.gens.length - 1}:\n${h.logs.join('\n')}`)
  assert.equal(h.markersWritten.length, 1)
  assert.equal(h.files.has(MARKER), false)
  assert.ok(h.files.has(RECORD), 'the single-use record survived the restart it caused')
  assert.equal(h.live().length, 1)
  h.live()[0].child.emit('exit', 0, null)
  assert.equal(await run, 0)
})

test('the restarted daemon writes the hook AGAIN (its detection disagreed): the record holds, no second restart', async () => {
  const h = harness({ forceOutcomes: (boot) => (boot >= 1 ? ['registered'] : null) })
  const run = h.launch()
  await until(() => h.gens.length === 1, 'the first claude')
  await h.pass(31 * 60_000)
  if (!hookRestart) assert.fail('the daemon registered the private turn hook and asked for no restart (server.ts:14783 at main)')
  await until(() => h.gens.length === 2, 'the launcher relaunch')
  assert.deepEqual(h.gens[1].outcomes, ['registered'])
  await h.pass(60 * 60_000)
  assert.equal(h.gens.length, 2, `a second self-requested restart:\n${h.logs.join('\n')}`)
  assert.equal(h.markersWritten.length, 1)
  assert.ok(h.logs.some((l) => l.includes(`daemon ${h.gens[1].daemon}: hook restart: `) && /already/.test(l)), h.logs.join('\n'))
  h.live()[0].child.emit('exit', 0, null)
  assert.equal(await run, 0)
})

test('Vera: a Windows daemon that cannot name its claude still gets its ONE restart, the table names claude (0.68.6)', async () => {
  // Armed at 07:46:00, "waiting: process_tree_unreadable" at 07:47:00, then nothing: a fresh install still needed a
  // manual second restart. The whole table names claude when the daemon's own parent walk did not.
  const h = harness({ claudeKnown: false })
  const run = h.launch()
  await until(() => h.gens.length === 1, 'the first claude')
  assert.deepEqual(h.gens[0].outcomes, ['registered'])
  await h.pass(31 * 60_000)
  await until(() => h.gens.length === 2, `the launcher relaunch:\n${h.logs.join('\n')}`)
  assert.deepEqual(h.gens[1].child.args.slice(-2), ['--resume', PIN])
  assert.equal(h.markersWritten.length, 1, 'one marker, through the ladder')
  await h.pass(60 * 60_000)
  assert.equal(h.gens.length, 2, 'exactly one restart')
  h.live()[0].child.emit('exit', 0, null)
  assert.equal(await run, 0)
})

test('Vera: a process table that cannot be read at all never restarts the agent, and the daemon says so within the bound', async () => {
  const h = harness({ claudeKnown: false, unreadable: true })
  const run = h.launch()
  await until(() => h.gens.length === 1, 'the first claude')
  await h.pass(4 * 3600_000)
  assert.equal(h.gens.length, 1, 'no restart it cannot prove safe')
  assert.equal(h.markersWritten.length, 0)
  const told = h.logs.filter((l) => /hook restart: waited \d+ min without a readable process table \(powershell_failed:1\)/.test(l))
  assert.equal(told.length, 1, h.logs.join('\n'))
  assert.match(told[0]!, /restart this agent by hand to load the private turn hook/)
  h.live()[0].child.emit('exit', 0, null)
  assert.equal(await run, 0)
})
