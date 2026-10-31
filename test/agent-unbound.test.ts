/**
 * lib/agent-unbound.mjs: what this computer does when the owner deletes one of
 * its agents in HOAI (board row 5b45611f6b0d, the plugin half).
 *
 * The backend (backend/src/integrations/pairing-notices.ts and the gateway's
 * cutUnboundAssistant) tells the PAIRING room `assistant_unbound`
 * {pairingId, assistantId} after the delete commits, and replays the same
 * event, with an ack, on the pairing's next connect for up to 7 days. Every
 * daemon of the pairing hears every agent's notice, so each one acts only on
 * its OWN agent, only for its OWN pairing, and only once the paired server
 * itself answers that the agent row is gone (GET assistants/<id> is 200 and
 * null for a deleted agent). Then it stops the agent's session, removes its
 * auto start entry (launchd plist, systemd unit, Windows logon task), archives
 * ~/.bgos-agent/<id> to ~/.bgos-agent/.removed/<id>-<date> (never deleted) and
 * removes its credentials file. Another agent's folder, file, job and task are
 * never touched, and a replayed notice does nothing new.
 *
 * macOS and Linux run the REAL bin/bgos-agent against faked launchctl,
 * systemctl and tmux (test/helpers/fake-posix-services.mjs), as
 * test/bgos-agent.home-scope.test.ts does. Windows runs against the faked Task
 * Scheduler (test/helpers/fake-agent-tasks.ts) and an in-memory fs. Nothing
 * here touches a real service, task or HOME.
 *
 * Run: npx tsx --test test/agent-unbound.test.ts
 */

import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'

import {
  ASSISTANT_UNBOUND_EVENT,
  REMOVED_DIR_NAME,
  classifyOwnAgentRead,
  cleanUpUnboundAgent,
  createUnboundFrameRouter,
  createUnboundNoticeHandler,
  judgeUnboundNotice,
  removedArchivePath,
  unboundRunStageCommands,
} from '../lib/agent-unbound.mjs'
import { agentTaskSpec, installAgentTask } from '../lib/agent-task-win32.mjs'
import { nodeExec, nodeFs } from '../lib/watcher-bundle.mjs'
import { watcherHomeId } from '../lib/watcher-service.mjs'
import { memoryFs } from './helpers/memory-fs.ts'
import { fakeAgentTasks } from './helpers/fake-agent-tasks.ts'
import { resolvePosixBash } from './helpers/posix-bash.ts'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const agentBin = join(repoRoot, 'bin', 'bgos-agent')
const fakeTool = join(repoRoot, 'test', 'helpers', 'fake-posix-services.mjs')
const BASH = process.platform === 'win32' ? null : resolvePosixBash()
const SLOW = { timeout: 120_000 }
/** The resolved bash as an absolute path, for the `bash` shim the real bin's `env bash` finds. */
const BASH_ABS = BASH && !BASH.includes('/') ? spawnSync('/bin/sh', ['-c', `command -v ${BASH}`], { encoding: 'utf8' }).stdout.trim() : BASH

/** The archive folder's date as the module stamps it: the UTC day of `now`, never a pinned date. */
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10)

// -- the notice: whose, from where ------------------------------------------------------------------

test('the event name is the backend\'s EventType.ASSISTANT_UNBOUND', () => {
  assert.equal(ASSISTANT_UNBOUND_EVENT, 'assistant_unbound')
  assert.equal(REMOVED_DIR_NAME, '.removed')
})

test('judgeUnboundNotice: this agent on this pairing is acted on (numbers or digit strings alike)', () => {
  assert.deepEqual(judgeUnboundNotice({ pairingId: 7, assistantId: 42 }, { assistantId: '42', pairingId: 7 }), { act: true })
  assert.deepEqual(judgeUnboundNotice({ pairingId: '7', assistantId: '42' }, { assistantId: 42, pairingId: '7' }), { act: true })
})

test('judgeUnboundNotice: another agent\'s notice (the pairing room hears every agent\'s) is ignored', () => {
  assert.deepEqual(judgeUnboundNotice({ pairingId: 7, assistantId: 43 }, { assistantId: '42', pairingId: 7 }), { act: false, reason: 'other_agent' })
})

test('judgeUnboundNotice: a forged notice (another pairing, or none named) is ignored', () => {
  assert.deepEqual(judgeUnboundNotice({ pairingId: 8, assistantId: 42 }, { assistantId: '42', pairingId: 7 }), { act: false, reason: 'other_pairing' })
  assert.deepEqual(judgeUnboundNotice({ assistantId: 42 }, { assistantId: '42', pairingId: 7 }), { act: false, reason: 'malformed' })
  assert.deepEqual(judgeUnboundNotice({ pairingId: 7 }, { assistantId: '42', pairingId: 7 }), { act: false, reason: 'malformed' })
  assert.deepEqual(judgeUnboundNotice(null, { assistantId: '42', pairingId: 7 }), { act: false, reason: 'malformed' })
  assert.deepEqual(judgeUnboundNotice('assistant_unbound', { assistantId: '42', pairingId: 7 }), { act: false, reason: 'malformed' })
  assert.deepEqual(judgeUnboundNotice({ pairingId: '7 ', assistantId: '42x' }, { assistantId: '42', pairingId: 7 }), { act: false, reason: 'malformed' })
})

test('judgeUnboundNotice: a daemon that does not know its own pairing cannot prove the notice is its server\'s, so it ignores it', () => {
  assert.deepEqual(judgeUnboundNotice({ pairingId: 7, assistantId: 42 }, { assistantId: '42', pairingId: undefined }), { act: false, reason: 'own_pairing_unknown' })
  assert.deepEqual(judgeUnboundNotice({ pairingId: 7, assistantId: 42 }, { assistantId: '', pairingId: 7 }), { act: false, reason: 'own_pairing_unknown' })
})

test('classifyOwnAgentRead: 200 with an empty or null body is a deleted agent; its row, an error or junk is not', () => {
  assert.equal(classifyOwnAgentRead({ status: 200, body: '' }, '42'), 'deleted')
  assert.equal(classifyOwnAgentRead({ status: 200, body: 'null' }, '42'), 'deleted')
  assert.equal(classifyOwnAgentRead({ status: 200, body: ' null\n' }, '42'), 'deleted')
  assert.equal(classifyOwnAgentRead({ status: 200, body: JSON.stringify({ id: 42, code: 'claude-code' }) }, '42'), 'present')
  assert.equal(classifyOwnAgentRead({ status: 200, body: JSON.stringify({ id: 99 }) }, '42'), 'unknown')
  assert.equal(classifyOwnAgentRead({ status: 200, body: '{not json' }, '42'), 'unknown')
  assert.equal(classifyOwnAgentRead({ status: 200, body: '[]' }, '42'), 'unknown')
  assert.equal(classifyOwnAgentRead({ status: 401, body: '' }, '42'), 'unknown')
  assert.equal(classifyOwnAgentRead({ status: 404, body: 'null' }, '42'), 'unknown')
  assert.equal(classifyOwnAgentRead({ status: 500, body: 'null' }, '42'), 'unknown')
  assert.equal(classifyOwnAgentRead(null, '42'), 'unknown')
})

// -- the handler: verify, then launch once, then ack ------------------------------------------------

function handlerRig(read: Array<{ status: number; body: string } | Error>) {
  const reads: number[] = []
  const launched: string[] = []
  const lines: string[] = []
  let n = 0
  const handle = createUnboundNoticeHandler({
    assistantId: '42',
    pairingId: 7,
    readOwnAgent: async () => {
      reads.push(n)
      const next = read[Math.min(n++, read.length - 1)]
      if (next instanceof Error) throw next
      return next
    },
    launchCleanup: () => {
      launched.push('42')
      return { ok: true, detail: 'pid 4242' }
    },
    log: (line: string) => lines.push(line),
  })
  return { handle, reads, launched, lines }
}

test('handler: a forged notice is never acted on, never even confirmed', async () => {
  const r = handlerRig([{ status: 200, body: 'null' }])
  assert.equal(await r.handle({ pairingId: 8, assistantId: 42 }), 'ignored:other_pairing')
  assert.equal(await r.handle({ assistantId: 42 }), 'ignored:malformed')
  assert.deepEqual(r.reads, [])
  assert.deepEqual(r.launched, [])
})

test('handler: another agent\'s notice is ignored, never confirmed, never launched', async () => {
  const r = handlerRig([{ status: 200, body: 'null' }])
  assert.equal(await r.handle({ pairingId: 7, assistantId: 43 }), 'ignored:other_agent')
  assert.deepEqual(r.reads, [])
  assert.deepEqual(r.launched, [])
})

test('handler: our notice while the server still returns our agent (a re-pair, or a stale notice) does nothing', async () => {
  const r = handlerRig([{ status: 200, body: JSON.stringify({ id: 42 }) }])
  assert.equal(await r.handle({ pairingId: 7, assistantId: 42 }), 'ignored:still_present')
  assert.equal(r.reads.length, 1)
  assert.deepEqual(r.launched, [])
})

test('handler: our notice the server cannot confirm (an error, an outage) does nothing, and the next one asks again', async () => {
  const r = handlerRig([new Error('GET 503'), { status: 500, body: '' }, { status: 200, body: 'null' }])
  assert.equal(await r.handle({ pairingId: 7, assistantId: 42 }), 'ignored:unconfirmed')
  assert.equal(await r.handle({ pairingId: 7, assistantId: 42 }), 'ignored:unconfirmed')
  assert.deepEqual(r.launched, [])
  assert.equal(await r.handle({ pairingId: 7, assistantId: 42 }), 'cleanup_launched')
  assert.deepEqual(r.launched, ['42'])
})

test('handler: our notice, confirmed deleted, launches the cleanup ONCE; a replay launches nothing new', async () => {
  const r = handlerRig([{ status: 200, body: 'null' }])
  assert.equal(await r.handle({ pairingId: 7, assistantId: 42 }), 'cleanup_launched')
  assert.deepEqual(r.launched, ['42'])
  assert.equal(await r.handle({ pairingId: 7, assistantId: 42 }), 'already_handled')
  assert.equal(await r.handle({ pairingId: 7, assistantId: 42 }), 'already_handled')
  assert.deepEqual(r.launched, ['42'])
  assert.equal(r.reads.length, 1, 'the server is asked once')
})

test('handler: a cleanup that could not be launched is launched by the next notice', async () => {
  let launches = 0
  const handle = createUnboundNoticeHandler({
    assistantId: '42',
    pairingId: 7,
    readOwnAgent: async () => ({ status: 200, body: 'null' }),
    launchCleanup: () => {
      launches += 1
      return launches === 1 ? { ok: false, detail: 'spawn ENOENT' } : { ok: true, detail: 'pid 1' }
    },
    log: () => {},
  })
  assert.equal(await handle({ pairingId: 7, assistantId: 42 }), 'cleanup_failed')
  assert.equal(await handle({ pairingId: 7, assistantId: 42 }), 'cleanup_launched')
  assert.equal(launches, 2)
})

test('handler: two notices racing (live emit and replay) confirm and launch once', async () => {
  const r = handlerRig([{ status: 200, body: 'null' }])
  const [a, b] = await Promise.all([r.handle({ pairingId: 7, assistantId: 42 }), r.handle({ pairingId: 7, assistantId: 42 })])
  assert.deepEqual([a, b].sort(), ['already_handled', 'cleanup_launched'])
  assert.deepEqual(r.launched, ['42'])
})

// -- the socket frame: never acked, held until the daemon is armed ----------------------------------

function routerRig() {
  let armed = false
  const handled: unknown[] = []
  const acks: string[] = []
  const router = createUnboundFrameRouter({ isArmed: () => armed, own: { assistantId: '42', pairingId: 7 }, handle: (p: unknown) => handled.push(p) })
  const ack = () => acks.push('ack')
  return { router, handled, acks, ack, arm: () => (armed = true) }
}

test('router: no notice is ever acked (the daemon that launches the cleanup cannot know it finished; unacked, the replay is the retry)', () => {
  const r = routerRig()
  r.router.onFrame({ pairingId: 7, assistantId: 42 }, r.ack)
  r.router.onFrame({ pairingId: 7, assistantId: 43 }, r.ack)
  r.arm()
  r.router.onArmed()
  r.router.onFrame({ pairingId: 7, assistantId: 42 }, r.ack)
  r.router.onFrame({ pairingId: 9, assistantId: 42 }, r.ack)
  assert.deepEqual(r.acks, [])
})

test('router: our notice replayed at connect, before the daemon armed, is held and handled once it arms', () => {
  const r = routerRig()
  assert.equal(r.router.onFrame({ pairingId: 7, assistantId: 42 }, r.ack), 'held')
  // Another agent's notice landing after it never takes its place.
  assert.equal(r.router.onFrame({ pairingId: 7, assistantId: 43 }, r.ack), 'dropped')
  assert.deepEqual(r.handled, [])
  r.arm()
  assert.equal(r.router.onArmed(), true)
  assert.deepEqual(r.handled, [{ pairingId: 7, assistantId: 42 }])
  assert.equal(r.router.onArmed(), false, 'handled once')
})

test('router: an armed daemon hands every frame to the handler (which judges it)', () => {
  const r = routerRig()
  r.arm()
  assert.equal(r.router.onFrame({ pairingId: 7, assistantId: 43 }), 'handled')
  assert.deepEqual(r.handled, [{ pairingId: 7, assistantId: 43 }])
  assert.equal(r.router.onArmed(), false)
})

// -- the archive path -------------------------------------------------------------------------------

test('removedArchivePath: ~/.bgos-agent/.removed/<id>-<date>, a taken name gets -2, -3', () => {
  const now = Date.now()
  const base = `/home/kc/.bgos-agent/.removed/42-${dayOf(now)}`
  assert.equal(removedArchivePath({ home: '/home/kc', assistantId: '42', now, exists: () => false }), base)
  const taken = new Set([base, `${base}-2`])
  assert.equal(removedArchivePath({ home: '/home/kc', assistantId: '42', now, exists: (p: string) => taken.has(p) }), `${base}-3`)
  assert.equal(removedArchivePath({ home: 'C:\\Users\\kc', assistantId: '912', now, exists: () => false }), `C:\\Users\\kc\\.bgos-agent\\.removed\\912-${dayOf(now)}`)
  assert.equal(removedArchivePath({ home: '/home/kc', assistantId: '../42', now, exists: () => false }), null)
})

// -- Windows: the logon task through the watcher's own uninstall ------------------------------------

const WHOME = 'C:\\Users\\kc'
const WNODE = 'C:\\Program Files\\nodejs\\node.exe'
const WROOT = 'C:\\Users\\kc\\.claude\\plugins\\cache\\hoai\\hoai\\0.80.2'
const wstate = (id: string) => `${WHOME}\\.bgos-agent\\${id}`
const wcreds = (id: string) => `${WHOME}\\.bgos-agent\\credentials-${id}.json`

async function windowsRig(queryErrors: Array<{ action: 'probe' | 'probe-legacy'; times?: number; after?: number }> = []) {
  const fs = memoryFs({
    [`${wstate('912')}\\session-id`]: 'pin-912',
    [`${wstate('912')}\\agent.log`]: 'log-912',
    [`${wstate('913')}\\session-id`]: 'pin-913',
    [wcreds('912')]: JSON.stringify({ assistantId: 912, pairingId: 7 }),
    [wcreds('913')]: JSON.stringify({ assistantId: 913, pairingId: 7 }),
  })
  const host = fakeAgentTasks({ fs, queryErrors })
  for (const id of ['912', '913']) {
    const spec = agentTaskSpec({ assistantId: id, home: WHOME, nodePath: WNODE, pluginRoot: WROOT, cwd: `C:\\Users\\kc\\hoai-agents\\${id}` })
    await installAgentTask(spec, { exec: host.exec, fs, start: true })
  }
  const killed: string[] = []
  const alive = new Set([5912, 5913])
  const exec = async (file: string, args: readonly string[], opts?: unknown) => {
    if (file === 'taskkill.exe') {
      killed.push(`${file} ${args.join(' ')}`)
      const pid = Number(args[args.indexOf('/PID') + 1])
      alive.delete(pid)
      // The launcher's tree ends: the task instance with it.
      for (const [name, inst] of host.instances) if (inst.stateDir.toLowerCase() === wstate(String(pid - 5000)).toLowerCase()) host.endInstance(name)
      return { code: 0, stdout: 'SUCCESS', stderr: '', error: null, timedOut: false }
    }
    return host.exec(file, args)
  }
  return { fs, host, exec, killed, alive }
}

test('Windows: a deleted agent\'s logon task is unregistered, its launcher tree ended, its folder archived and its credentials removed; the other agent is untouched', async () => {
  const w = await windowsRig()
  const now = Date.now()
  const task912 = [...w.host.tasks.keys()].find((n) => n.startsWith('HOAI Agent 912 '))!
  const task913 = [...w.host.tasks.keys()].find((n) => n.startsWith('HOAI Agent 913 '))!
  const before913 = [...w.fs.files.entries()].filter(([k]) => k.startsWith(wstate('913')) || k === wcreds('913'))
  // Archive, never delete: nothing inside the agent's folder is ever removed, only moved whole.
  const deleted: string[] = []
  const rm = w.fs.rm
  w.fs.rm = (p: string) => {
    deleted.push(p)
    rm(p)
  }
  const report = await cleanUpUnboundAgent({
    platform: 'win32',
    home: WHOME,
    assistantId: '912',
    fs: w.fs,
    exec: w.exec,
    now: () => now,
    readLauncher: () => ({ pid: 5912, supervisor: 'service' }),
    pidAlive: (pid: number) => w.alive.has(pid),
    sleep: async () => {},
    log: () => {},
  })
  assert.equal(report.ok, true, JSON.stringify(report))
  // The task: unregistered through uninstallAgentTask (read back first), the other agent's still there.
  assert.equal(w.host.tasks.has(task912), false, 'agent 912\'s logon task is gone')
  assert.equal(w.host.tasks.has(task913), true, 'agent 913\'s logon task is untouched')
  // The session: the verified launcher's tree, and nothing else.
  assert.deepEqual(w.killed, ['taskkill.exe /PID 5912 /T /F'])
  assert.equal(w.alive.has(5913), true)
  // The folder: archived whole, never deleted.
  const archive = `${WHOME}\\.bgos-agent\\.removed\\912-${dayOf(now)}`
  assert.equal(report.archivedTo, archive)
  assert.equal(w.fs.exists(wstate('912')), false)
  assert.equal(w.fs.files.get(`${archive}\\session-id`), 'pin-912')
  assert.equal(w.fs.files.get(`${archive}\\agent.log`), 'log-912')
  assert.ok(w.fs.files.has(`${archive}\\run-agent.vbs`), 'the generated launcher is archived with the folder, not deleted')
  assert.ok(w.fs.files.has(`${archive}\\install-agent-task.ps1`), 'the task script the uninstall ran is archived with the folder, not deleted')
  assert.deepEqual(deleted.filter((p) => p.toLowerCase().startsWith(`${wstate('912')}\\`.toLowerCase())), [], 'no file of the agent\'s folder is ever deleted')
  // The credentials: removed, and only this agent's.
  assert.equal(w.fs.exists(wcreds('912')), false)
  assert.deepEqual([...w.fs.files.entries()].filter(([k]) => k.startsWith(wstate('913')) || k === wcreds('913')), before913)
  // Nothing of agent 913 was ever named by a command.
  assert.deepEqual(w.host.calls.filter((c) => c.includes('\\913\\') && /uninstall|retire/.test(c)), [])
})

test('Windows: a replayed cleanup does nothing new (no command, no second archive, no folder made again)', async () => {
  const w = await windowsRig()
  const now = Date.now()
  const deps = {
    platform: 'win32',
    home: WHOME,
    assistantId: '912',
    fs: w.fs,
    exec: w.exec,
    now: () => now,
    readLauncher: () => (w.alive.has(5912) ? { pid: 5912, supervisor: 'service' } : null),
    pidAlive: (pid: number) => w.alive.has(pid),
    sleep: async () => {},
    log: () => {},
  }
  await cleanUpUnboundAgent(deps)
  const calls = w.host.calls.length
  const files = JSON.stringify([...w.fs.files.entries()].sort())
  const again = await cleanUpUnboundAgent(deps)
  assert.equal(again.ok, true)
  assert.equal(again.archivedTo, null)
  assert.deepEqual(again.notes, ['agent 912: nothing of it is left on this computer (already cleaned up)'], 'the run log says the replay found nothing to do')
  assert.equal(w.host.calls.length, calls, 'no command at all on the replay')
  assert.deepEqual(w.killed, ['taskkill.exe /PID 5912 /T /F'])
  assert.equal(JSON.stringify([...w.fs.files.entries()].sort()), files)
  assert.equal(w.fs.exists(wstate('912')), false)
})

test('Windows: a task the read back does not show gone stops the cleanup: no session ended, folder and credentials left for the replay to retry', async () => {
  // Both installs read their task back once each (2 probes); every probe after that fails (a CIM timeout).
  const w = await windowsRig([{ action: 'probe', after: 2 }])
  const now = Date.now()
  const report = await cleanUpUnboundAgent({
    platform: 'win32',
    home: WHOME,
    assistantId: '912',
    fs: w.fs,
    exec: w.exec,
    now: () => now,
    readLauncher: () => ({ pid: 5912, supervisor: 'service' }),
    pidAlive: (pid: number) => w.alive.has(pid),
    sleep: async () => {},
    log: () => {},
  })
  assert.equal(report.ok, false, JSON.stringify(report))
  assert.ok([...w.host.tasks.keys()].some((n) => n.startsWith('HOAI Agent 912 ')), 'the task stays (it could not be read back)')
  assert.deepEqual(w.killed, [], 'no session ended while its task may start it again')
  assert.equal(report.archivedTo, null)
  assert.equal(w.fs.files.get(`${wstate('912')}\\session-id`), 'pin-912', 'the folder stays where the task points')
  assert.equal(w.fs.exists(wcreds('912')), true, 'the credentials stay, so a next life can hear the replay')
})

test('Windows: a run after the folder already moved (its credentials left behind) runs no task command and makes no folder again', async () => {
  const w = await windowsRig()
  const now = Date.now()
  w.fs.rename(wstate('912'), `${WHOME}\\.bgos-agent\\.removed\\912-${dayOf(now)}`)
  const calls = w.host.calls.length
  const report = await cleanUpUnboundAgent({
    platform: 'win32',
    home: WHOME,
    assistantId: '912',
    fs: w.fs,
    exec: w.exec,
    now: () => now,
    readLauncher: () => null,
    pidAlive: () => false,
    sleep: async () => {},
    log: () => {},
  })
  assert.equal(report.ok, true, JSON.stringify(report))
  assert.equal(w.host.calls.length, calls, 'no task command: its script would be written into a folder made again')
  assert.equal(w.fs.exists(wstate('912')), false)
  assert.equal(w.fs.exists(wcreds('912')), false, 'the credentials left behind are removed')
})

test('Windows: a folder still held open (EBUSY) is retried until it moves, never deleted', async () => {
  const w = await windowsRig()
  const now = Date.now()
  let busy = 2
  const rename = w.fs.rename
  w.fs.rename = (from: string, to: string) => {
    if (from === wstate('912') && busy > 0) {
      busy -= 1
      throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
    }
    rename(from, to)
  }
  const sleeps: number[] = []
  const report = await cleanUpUnboundAgent({
    platform: 'win32',
    home: WHOME,
    assistantId: '912',
    fs: w.fs,
    exec: w.exec,
    now: () => now,
    readLauncher: () => null,
    pidAlive: () => false,
    sleep: async (ms: number) => {
      sleeps.push(ms)
    },
    log: () => {},
  })
  assert.equal(report.ok, true, JSON.stringify(report))
  assert.equal(busy, 0)
  assert.ok(sleeps.length >= 2)
  assert.equal(w.fs.files.get(`${WHOME}\\.bgos-agent\\.removed\\912-${dayOf(now)}\\session-id`), 'pin-912')
})

// -- macOS and Linux: the real bin/bgos-agent uninstall, faked launchctl and systemctl -------------

function ready(t: TestContext): boolean {
  if (BASH) return true
  if (process.platform !== 'win32') assert.notEqual(process.env.HOAI_REQUIRE_BASH, '1', 'HOAI_REQUIRE_BASH=1 but no bash')
  t.skip(process.platform === 'win32' ? 'bin/bgos-agent is the macOS and Linux installer' : 'no bash')
  return false
}

type Os = 'Darwin' | 'Linux'
type ServiceState = {
  launchd: Record<string, { plistPath: string; content: string }>
  enabled: string[]
  active: string[]
  tmux: string[]
  calls: Array<{ cmd: string }>
}

/** One HOME with two always-on agents (42 and 43) installed by the real bin/bgos-agent. */
function posixRig(os: Os) {
  const root = mkdtempSync(join(tmpdir(), 'hoai-unbound-'))
  const home = join(root, 'home', 'kc')
  const shims = join(root, 'shims')
  const statePath = join(root, 'services.json')
  for (const dir of [home, shims]) mkdirSync(dir, { recursive: true })
  const uid = Number(spawnSync('id', ['-u'], { encoding: 'utf8' }).stdout.trim())
  writeFileSync(statePath, JSON.stringify({ uid, managerHome: home, launchd: {}, enabled: [], active: [], tmux: [], fail: [], calls: [] }))
  const shim = (name: string, body: string) => {
    writeFileSync(join(shims, name), `#!/bin/sh\n${body}\n`)
    chmodSync(join(shims, name), 0o755)
  }
  for (const tool of ['launchctl', 'systemctl', 'loginctl', 'tmux']) shim(tool, `exec '${process.execPath}' '${fakeTool}' '${statePath}' ${tool} "$@"`)
  shim('uname', `echo ${os}`)
  shim('plutil', 'exit 0')
  shim('claude', 'exit 0')
  shim('expect', 'exit 0')
  shim('bun', `[ "$1" = "install" ] && exit 0\nexec '${process.execPath}' "$@"`)
  shim('node', 'exit 0')
  // bin/bgos-agent through the resolved bash, as the module runs the bin itself.
  shim('hoai-agent', `exec '${BASH}' '${agentBin}' "$@"`)
  // bin/bgos-agent's shebang is `env bash`: the resolved bash, by its absolute path (a bare
  // `bash` here would find this very shim on PATH and exec itself for ever).
  shim('bash', `exec '${BASH_ABS}' "$@"`)
  const env = { HOME: home, USER: 'kc', LOGNAME: 'kc', NO_COLOR: '1', XDG_RUNTIME_DIR: join(root, 'run'), PATH: `${shims}:/usr/bin:/bin:/usr/sbin:/sbin` }
  const install = (id: string) => {
    const dir = join(home, 'agents', id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { bgos: { command: 'bun', args: [join(repoRoot, 'server.ts')] } } }))
    const r = spawnSync(BASH!, [agentBin, 'install', '--assistant', id, '--dir', dir, '--always-on', '--no-clone'], { cwd: home, encoding: 'utf8', timeout: 100_000, env })
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`)
    writeFileSync(join(home, '.bgos-agent', `credentials-${id}.json`), JSON.stringify({ assistantId: Number(id), pairingId: 7 }))
    writeFileSync(join(home, '.bgos-agent', id, 'session-id'), `pin-${id}`)
  }
  install('42')
  install('43')
  const state = (): ServiceState => JSON.parse(readFileSync(statePath, 'utf8'))
  const hid = watcherHomeId(realpathSync(home), 'linux')
  const label = (id: string) => `ai.bgos.agent.${id}.home-${hid}`
  const unit = (id: string) => `bgos-agent-${id}-home-${hid}`
  const serviceFile = (id: string) =>
    os === 'Darwin' ? join(home, 'Library', 'LaunchAgents', `${label(id)}.plist`) : join(home, '.config', 'systemd', 'user', `${unit(id)}.service`)
  const exec = nodeExec()
  const deps = (now: number, extra: Record<string, unknown> = {}) => ({
    platform: os === 'Darwin' ? 'darwin' : 'linux',
    home,
    assistantId: '42',
    fs: nodeFs(),
    exec: (file: string, args: readonly string[], opts: Record<string, unknown> = {}) => exec(file, args, { ...opts, env }),
    bgosAgentBin: join(shims, 'hoai-agent'),
    now: () => now,
    readLauncher: () => null,
    pidAlive: () => false,
    sleep: async () => {},
    log: () => {},
    ...extra,
  })
  return { root, home, env, state, label, unit, serviceFile, deps, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

for (const os of ['Darwin', 'Linux'] as const) {
  test(`${os}: a deleted agent's ${os === 'Darwin' ? 'launchd job' : 'systemd unit'} is removed and stopped, its folder archived whole, its credentials removed; the other agent is untouched`, SLOW, async (t) => {
    if (!ready(t)) return
    const p = posixRig(os)
    t.after(p.cleanup)
    const now = Date.now()
    const runSh = readFileSync(join(p.home, '.bgos-agent', '42', 'run.sh'), 'utf8')
    const other = {
      file: readFileSync(p.serviceFile('43'), 'utf8'),
      runSh: readFileSync(join(p.home, '.bgos-agent', '43', 'run.sh'), 'utf8'),
      creds: readFileSync(join(p.home, '.bgos-agent', 'credentials-43.json'), 'utf8'),
    }
    if (os === 'Darwin') assert.ok(p.state().launchd[p.label('42')], 'agent 42 loaded before')
    else assert.ok(p.state().active.includes(p.unit('42')), 'agent 42 active before')

    const from = p.state().calls.length
    const report = await cleanUpUnboundAgent(p.deps(now))
    assert.equal(report.ok, true, JSON.stringify(report))

    // Auto start: gone and stopped for 42.
    assert.equal(existsSync(p.serviceFile('42')), false, 'agent 42\'s service file is removed')
    if (os === 'Darwin') assert.equal(p.state().launchd[p.label('42')], undefined, 'agent 42\'s job is booted out')
    else assert.equal(p.state().active.includes(p.unit('42')), false, 'agent 42\'s unit is stopped')
    // The folder: archived whole (run.sh and the session pin inside), never deleted.
    const archive = join(p.home, '.bgos-agent', '.removed', `42-${dayOf(now)}`)
    assert.equal(report.archivedTo, archive)
    assert.equal(existsSync(join(p.home, '.bgos-agent', '42')), false)
    assert.equal(readFileSync(join(archive, 'run.sh'), 'utf8'), runSh)
    assert.equal(readFileSync(join(archive, 'session-id'), 'utf8'), 'pin-42')
    // Credentials: removed for 42 only.
    assert.equal(existsSync(join(p.home, '.bgos-agent', 'credentials-42.json')), false)
    // Agent 43: its file, job or unit, folder and credentials exactly as they were, and never named.
    assert.equal(readFileSync(p.serviceFile('43'), 'utf8'), other.file)
    assert.equal(readFileSync(join(p.home, '.bgos-agent', '43', 'run.sh'), 'utf8'), other.runSh)
    assert.equal(readFileSync(join(p.home, '.bgos-agent', 'credentials-43.json'), 'utf8'), other.creds)
    if (os === 'Darwin') assert.ok(p.state().launchd[p.label('43')], 'agent 43 still loaded')
    else assert.ok(p.state().active.includes(p.unit('43')), 'agent 43 still active')
    const cleanupCalls = p.state().calls.slice(from).map((c) => c.cmd)
    assert.ok(cleanupCalls.some((c) => /\b42\b/.test(c) && /bootout|stop/.test(c)), `agent 42's own job was stopped by name: ${cleanupCalls.join(' | ')}`)
    assert.deepEqual(cleanupCalls.filter((c) => /\b43\b/.test(c)), [], 'agent 43 was never named')
  })

  test(`${os}: a replayed cleanup does nothing new (no service call, no second archive)`, SLOW, async (t) => {
    if (!ready(t)) return
    const p = posixRig(os)
    t.after(p.cleanup)
    const now = Date.now()
    await cleanUpUnboundAgent(p.deps(now))
    const calls = p.state().calls.length
    const removed = readdirSync(join(p.home, '.bgos-agent', '.removed')).sort()
    const again = await cleanUpUnboundAgent(p.deps(now))
    assert.equal(again.ok, true)
    assert.equal(again.archivedTo, null)
    assert.equal(p.state().calls.length, calls, 'no service call on the replay')
    assert.deepEqual(readdirSync(join(p.home, '.bgos-agent', '.removed')).sort(), removed)
  })
}

test('macOS: a hand-run hoai launcher of the agent (no service) is stopped with SIGTERM before its folder moves', SLOW, async (t) => {
  if (!ready(t)) return
  const p = posixRig('Darwin')
  t.after(p.cleanup)
  const order: string[] = []
  const alive = new Set([777])
  const report = await cleanUpUnboundAgent(
    p.deps(Date.now(), {
      readLauncher: () => ({ pid: 777, supervisor: 'launcher-live' }),
      kill: (pid: number, signal: string) => {
        order.push(`kill ${pid} ${signal} folder=${existsSync(join(p.home, '.bgos-agent', '42'))}`)
        alive.delete(pid)
      },
      pidAlive: (pid: number) => alive.has(pid),
    }),
  )
  assert.equal(report.ok, true, JSON.stringify(report))
  assert.deepEqual(order, ['kill 777 SIGTERM folder=true'])
})

test('Linux: an auto start the uninstall could not remove keeps the credentials (the folder is still archived first)', async () => {
  const home = '/home/kc'
  const fs = memoryFs({
    [`${home}/.bgos-agent/42/run.sh`]: 'run',
    [`${home}/.bgos-agent/credentials-42.json`]: '{}',
  })
  const now = Date.now()
  const report = await cleanUpUnboundAgent({
    platform: 'linux',
    home,
    assistantId: '42',
    fs,
    exec: async () => ({ code: 1, stdout: '', stderr: 'refused: agent 42\'s service could not be read back; nothing was removed', error: null, timedOut: false }),
    bgosAgentBin: '/x/bgos-agent',
    now: () => now,
    readLauncher: () => null,
    pidAlive: () => false,
    sleep: async () => {},
    log: () => {},
  })
  assert.equal(report.ok, false)
  assert.equal(fs.files.get(`${home}/.bgos-agent/.removed/42-${dayOf(now)}/run.sh`), 'run')
  assert.equal(fs.files.get(`${home}/.bgos-agent/credentials-42.json`), '{}')
  assert.deepEqual(report.credentialsRemoved, [])
})

/** A Linux memory rig for the branches the real bash run does not reach; `exec` records every call. */
function linuxMemoryRig(files: Record<string, string>, opts: { renameFails?: boolean } = {}) {
  const home = '/home/kc'
  const fs = memoryFs(files)
  if (opts.renameFails) {
    fs.rename = () => {
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
    }
  }
  const calls: string[] = []
  const signals: string[] = []
  const now = Date.now()
  const deps = (over: Record<string, unknown> = {}) => ({
    platform: 'linux',
    home,
    assistantId: '42',
    fs,
    exec: async (file: string, args: readonly string[]) => {
      calls.push(`${file} ${args.join(' ')}`)
      return { code: 0, stdout: '', stderr: '', error: null, timedOut: false }
    },
    bgosAgentBin: '/x/bgos-agent',
    now: () => now,
    readLauncher: () => null,
    kill: (pid: number, signal: string) => {
      signals.push(`${pid} ${signal}`)
    },
    pidAlive: () => false,
    sleep: async () => {},
    log: () => {},
    ...over,
  })
  return { home, fs, calls, signals, now, deps }
}

test('Linux: a folder that cannot be moved is never handed to the uninstall (its state wipe would delete it); the credentials stay', async () => {
  const r = linuxMemoryRig({ '/home/kc/.bgos-agent/42/run.sh': 'run', '/home/kc/.bgos-agent/credentials-42.json': '{}' }, { renameFails: true })
  const report = await cleanUpUnboundAgent(r.deps())
  assert.equal(report.ok, false)
  assert.deepEqual(r.calls, [], 'no uninstall while the folder is still in place')
  assert.equal(r.fs.files.get('/home/kc/.bgos-agent/42/run.sh'), 'run')
  assert.equal(r.fs.files.get('/home/kc/.bgos-agent/credentials-42.json'), '{}')
})

test('Windows: a folder that never moves keeps the credentials and is never deleted', async () => {
  const w = await windowsRig()
  const now = Date.now()
  const rename = w.fs.rename
  w.fs.rename = (from: string, to: string) => {
    if (from === wstate('912')) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
    rename(from, to)
  }
  const report = await cleanUpUnboundAgent({
    platform: 'win32',
    home: WHOME,
    assistantId: '912',
    fs: w.fs,
    exec: w.exec,
    now: () => now,
    readLauncher: () => null,
    pidAlive: () => false,
    sleep: async () => {},
    log: () => {},
  })
  assert.equal(report.ok, false)
  assert.equal(report.archivedTo, null)
  assert.equal(w.fs.files.get(`${wstate('912')}\\session-id`), 'pin-912')
  assert.ok(w.fs.exists(wcreds('912')), 'the credentials stay with the folder that could not move')
  assert.deepEqual(report.credentialsRemoved, [])
})

test('the legacy credentials.json is removed only when it names this agent', async () => {
  const ours = linuxMemoryRig({ '/home/kc/.bgos-agent/42/run.sh': 'run', '/home/kc/.bgos-agent/credentials.json': JSON.stringify({ assistantId: 42 }) })
  const mine = await cleanUpUnboundAgent(ours.deps())
  assert.equal(mine.ok, true, JSON.stringify(mine))
  assert.equal(ours.fs.exists('/home/kc/.bgos-agent/credentials.json'), false)

  const theirs = linuxMemoryRig({ '/home/kc/.bgos-agent/42/run.sh': 'run', '/home/kc/.bgos-agent/credentials.json': JSON.stringify({ assistantId: 43 }) })
  const other = await cleanUpUnboundAgent(theirs.deps())
  assert.equal(other.ok, true, JSON.stringify(other))
  assert.equal(theirs.fs.files.get('/home/kc/.bgos-agent/credentials.json'), JSON.stringify({ assistantId: 43 }), 'another agent\'s legacy credentials are untouched')
})

test('Linux: a launcher its service runs is not signalled; the uninstall stops the service', async () => {
  const r = linuxMemoryRig({ '/home/kc/.bgos-agent/42/run.sh': 'run' })
  const report = await cleanUpUnboundAgent(r.deps({ readLauncher: () => ({ pid: 4242, supervisor: 'service' }) }))
  assert.equal(report.ok, true, JSON.stringify(report))
  assert.deepEqual(r.signals, [])
  assert.deepEqual(r.calls, ['/x/bgos-agent uninstall --assistant 42'])
})

test('server.ts: the daemon judges by its own agent and its own pairing, asks its own server, and starts the helper for its own agent', () => {
  const server = readFileSync(join(repoRoot, 'server.ts'), 'utf8').replace(/\r\n/g, '\n')
  // The pairing comes from this daemon's own credentials file, never from the notice.
  assert.match(server, /const UNBOUND_OWN = \{ assistantId: ASSISTANT_ID, pairingId: AUTH\.mode === 'pairing' \? CREDENTIALS_FILE\?\.pairingId : undefined \}/)
  assert.match(server, /const onAssistantUnbound = createUnboundNoticeHandler\(\{\n\s*\.\.\.UNBOUND_OWN,/)
  // The confirming read is its own agent on its own server, with its own auth.
  assert.match(server, /url: `\$\{API_BASE\}\/assistants\/\$\{encodeURIComponent\(ASSISTANT_ID\)\}`,\n\s*init: \{ headers: \{ \.\.\.authHeaders\(AUTH\) \} \},/)
  // The helper is started for this agent and this HOME.
  assert.match(server, /\[UNBOUND_HELPER, '--stage', 'launch', '--assistant', String\(ASSISTANT_ID\), '--home', homedir\(\)\]/)
})

test('a junk assistant id builds no path and touches nothing', async () => {
  const fs = memoryFs({ '/home/kc/.bgos-agent/42/session-id': 'pin' })
  const calls: string[] = []
  const report = await cleanUpUnboundAgent({
    platform: 'linux',
    home: '/home/kc',
    assistantId: '../42',
    fs,
    exec: async (file: string, args: readonly string[]) => {
      calls.push(`${file} ${args.join(' ')}`)
      return { code: 0, stdout: '', stderr: '', error: null, timedOut: false }
    },
    bgosAgentBin: '/x/bgos-agent',
    now: () => Date.now(),
    readLauncher: () => null,
    pidAlive: () => false,
    sleep: async () => {},
    log: () => {},
  })
  assert.equal(report.ok, false)
  assert.deepEqual(calls, [])
  assert.equal(fs.files.get('/home/kc/.bgos-agent/42/session-id'), 'pin')
})

// -- the helper: out of the agent's process tree ----------------------------------------------------

test('unboundRunStageCommands: Linux tries its own transient systemd unit first (a unit stop kills its whole cgroup), then a detached child', () => {
  const cmds = unboundRunStageCommands({ platform: 'linux', execPath: '/usr/bin/node', helperPath: '/p/bin/hoai-agent-unbound.mjs', assistantId: '42', home: '/home/kc', path: '/home/kc/.bun/bin:/usr/bin' })
  const run = ['/p/bin/hoai-agent-unbound.mjs', '--stage', 'run', '--assistant', '42', '--home', '/home/kc']
  // The unit gets the user manager's environment: the daemon's PATH (where bin/bgos-agent finds bun or node) and HOME go with it.
  assert.deepEqual(cmds, [
    { how: 'systemd-run', file: 'systemd-run', args: ['--user', '--collect', '--quiet', '--setenv=HOME=/home/kc', '--setenv=PATH=/home/kc/.bun/bin:/usr/bin', '--', '/usr/bin/node', ...run] },
    { how: 'detached', file: '/usr/bin/node', args: run },
  ])
})

test('unboundRunStageCommands: macOS and Windows run a detached child (the launch stage exits at once, so it is nobody\'s child)', () => {
  for (const platform of ['darwin', 'win32']) {
    const cmds = unboundRunStageCommands({ platform, execPath: 'node', helperPath: 'h.mjs', assistantId: '912', home: 'C:\\Users\\kc' })
    assert.deepEqual(cmds, [{ how: 'detached', file: 'node', args: ['h.mjs', '--stage', 'run', '--assistant', '912', '--home', 'C:\\Users\\kc'] }])
  }
  assert.deepEqual(unboundRunStageCommands({ platform: 'darwin', execPath: 'node', helperPath: 'h.mjs', assistantId: '4x', home: '/h' }), [])
})

test('bin/hoai-agent-unbound.mjs --stage run (macOS, the real bin end to end): agent 42 removed and archived, agent 43 untouched, the log says so', SLOW, (t) => {
  if (!ready(t)) return
  const p = posixRig('Darwin')
  t.after(p.cleanup)
  const r = spawnSync(process.execPath, [join(repoRoot, 'bin', 'hoai-agent-unbound.mjs'), '--stage', 'run', '--assistant', '42', '--home', p.home], {
    encoding: 'utf8',
    timeout: 100_000,
    env: p.env,
  })
  const log = readFileSync(join(p.home, '.bgos-agent', '.removed', '42-unbound.log'), 'utf8')
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}\n${log}`)
  assert.equal(existsSync(p.serviceFile('42')), false)
  assert.equal(p.state().launchd[p.label('42')], undefined)
  assert.equal(existsSync(join(p.home, '.bgos-agent', '42')), false)
  assert.equal(existsSync(join(p.home, '.bgos-agent', 'credentials-42.json')), false)
  const archived = readdirSync(join(p.home, '.bgos-agent', '.removed')).filter((n) => /^42-\d{4}-\d{2}-\d{2}$/.test(n))
  assert.equal(archived.length, 1, readdirSync(join(p.home, '.bgos-agent', '.removed')).join(','))
  assert.equal(readFileSync(join(p.home, '.bgos-agent', '.removed', archived[0]!, 'session-id'), 'utf8'), 'pin-42')
  assert.ok(p.state().launchd[p.label('43')], 'agent 43 still loaded')
  assert.ok(existsSync(join(p.home, '.bgos-agent', '43', 'run.sh')))
  assert.ok(existsSync(join(p.home, '.bgos-agent', 'credentials-43.json')))
  assert.match(log, /agent 42: done$/m)
})
