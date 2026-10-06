/**
 * hoai's singleton guard and the supervisor.json pid identity (plugin-supervisor
 * review F1).
 *
 * Every stop of the v2 service used to leave supervisor.json behind, and any
 * unclean stop (a power cut, a panic, a SIGKILL) still does. After a reboot its
 * pid can be ANY process, and decideSupervisorArming refused to arm behind any
 * live pid: run.sh then lapped on exit 3 (already-supervised) for as long as
 * that unrelated process ran, and the agent stayed down. A recorded pid is a
 * live owner only when it is alive AND still runs hoai-core.mjs; a command line
 * that cannot be read keeps the liveness answer (fail toward not
 * double-launching). The query is lib/agent-inventory.mjs's, so the watcher's
 * launcherLive judges the same pid the same way.
 *
 * Every OS effect is a fake: spawnSync, spawn and the fs are injected.
 *
 * Run: npx tsx --test test/hoai-core.identity.test.ts
 */

import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  EXIT_ALREADY_SUPERVISED,
  SUPERVISOR_FILE_NAME,
  decideSupervisorArming,
  defaultPidCommandLine,
  superviseClaude,
  supervisorFileBody,
} from '../bin/hoai-core.mjs'

const HOAI_CMD = '/opt/homebrew/bin/node /Users/kc/.claude/plugins/cache/hoai/hoai/0.62.0/bin/hoai-core.mjs'
const HOME = '/home/kc'
const CWD = '/agents/athena'
const SCRIPT_DIR = '/home/kc/bgos-claude-plugin/bin'
const SUPERVISOR_PATH = `${HOME}/.bgos-agent/871/${SUPERVISOR_FILE_NAME}`
const BASE = ['--dangerously-skip-permissions', '--dangerously-load-development-channels', 'server:bgos']
const STALE = supervisorFileBody(626, '2026-10-06T00:00:00.000Z')

// -- the decision ---------------------------------------------------------------

test('decideSupervisorArming: a live pid that still runs hoai-core.mjs refuses; a live pid running something else is a stale file, reclaimed', () => {
  const asked: number[] = []
  const commandOf = (cmd: string | null) => (pid: number) => {
    asked.push(pid)
    return cmd
  }
  assert.deepEqual(
    decideSupervisorArming({ existingRaw: STALE, ownPid: 100, pidAlive: () => true, pidCommandLine: commandOf(HOAI_CMD) }),
    { arm: false, ownerPid: 626 },
  )
  assert.deepEqual(
    decideSupervisorArming({ existingRaw: STALE, ownPid: 100, pidAlive: () => true, pidCommandLine: commandOf('/usr/libexec/rapportd') }),
    { arm: true, reclaimedStale: true },
  )
  // Cannot be read at all: the liveness answer stands, never a double launch on a guess.
  assert.deepEqual(
    decideSupervisorArming({ existingRaw: STALE, ownPid: 100, pidAlive: () => true, pidCommandLine: commandOf(null) }),
    { arm: false, ownerPid: 626 },
  )
  assert.deepEqual(asked, [626, 626, 626])
  // A dead pid is reclaimed without spending a process on its command line.
  asked.length = 0
  assert.deepEqual(
    decideSupervisorArming({ existingRaw: STALE, ownPid: 100, pidAlive: () => false, pidCommandLine: commandOf(HOAI_CMD) }),
    { arm: true, reclaimedStale: true },
  )
  assert.deepEqual(asked, [])
  // No reader given: liveness only, exactly as before.
  assert.deepEqual(decideSupervisorArming({ existingRaw: STALE, ownPid: 100, pidAlive: () => true }), { arm: false, ownerPid: 626 })
})

// -- the default reader -----------------------------------------------------------

function fakeSpawnSync(answer: { status: number | null; stdout?: string } | 'throw') {
  const calls: Array<{ file: string; args: string[]; opts: Record<string, unknown> }> = []
  const spawn = (file: string, args: string[], opts: Record<string, unknown>) => {
    calls.push({ file, args: [...args], opts })
    if (answer === 'throw') throw new Error('spawn failed')
    return { status: answer.status, stdout: answer.stdout ?? '' }
  }
  // Typed as the spawnSync it stands in for (its many overloads accept no plain fake).
  return { calls, spawn: spawn as never }
}

test('defaultPidCommandLine: posix asks ps for that pid at unlimited width, bounded by a timeout, and answers the command line', () => {
  const ps = fakeSpawnSync({ status: 0, stdout: `  4242 ${HOAI_CMD}\n` })
  assert.equal(defaultPidCommandLine(4242, 'darwin', { spawn: ps.spawn }), HOAI_CMD)
  assert.equal(ps.calls.length, 1)
  assert.equal(ps.calls[0]!.file, 'ps')
  assert.deepEqual(ps.calls[0]!.args, ['-ww', '-o', 'pid=,command=', '-p', '4242'])
  assert.equal(typeof ps.calls[0]!.opts.timeout, 'number')
  assert.equal(ps.calls[0]!.opts.windowsHide, true)
})

test('defaultPidCommandLine: win32 asks Win32_Process for that pid\'s CommandLine', () => {
  const ps = fakeSpawnSync({ status: 0, stdout: JSON.stringify({ ProcessId: 777, CommandLine: '"C:\\node.exe" "C:\\p\\bin\\hoai-core.mjs" --keep-alive' }) })
  assert.equal(defaultPidCommandLine(777, 'win32', { spawn: ps.spawn }), '"C:\\node.exe" "C:\\p\\bin\\hoai-core.mjs" --keep-alive')
  assert.equal(ps.calls[0]!.file, 'powershell.exe')
  assert.match(ps.calls[0]!.args.at(-1)!, /Get-CimInstance Win32_Process -Filter 'ProcessId=777'/)
})

test('defaultPidCommandLine: anything it cannot read is null (gone, failed, timed out, thrown, not a pid)', () => {
  assert.equal(defaultPidCommandLine(4242, 'linux', { spawn: fakeSpawnSync({ status: 1, stdout: '' }).spawn }), null)
  assert.equal(defaultPidCommandLine(4242, 'linux', { spawn: fakeSpawnSync({ status: null, stdout: '' }).spawn }), null, 'a timed-out spawnSync has status null')
  assert.equal(defaultPidCommandLine(4242, 'linux', { spawn: fakeSpawnSync('throw').spawn }), null)
  assert.equal(defaultPidCommandLine(4242, 'win32', { spawn: fakeSpawnSync({ status: 0, stdout: JSON.stringify({ ProcessId: 4242, CommandLine: null }) }).spawn }), null, 'another session\'s process')
  const never = fakeSpawnSync({ status: 0, stdout: HOAI_CMD })
  for (const pid of [0, -1, 1.5, Number.NaN]) assert.equal(defaultPidCommandLine(pid, 'linux', { spawn: never.spawn }), null)
  assert.equal(never.calls.length, 0, 'nothing that is not a pid reaches a process')
})

// -- the loop -------------------------------------------------------------------

class FakeChild extends EventEmitter {
  args: string[]
  constructor(args: readonly string[]) {
    super()
    this.args = [...args]
  }
  kill() {
    setTimeout(() => this.emit('exit', null, 'SIGTERM'), 1)
    return true
  }
  exit(code: number) {
    this.emit('exit', code, null)
  }
}

function loop(pidCommandLine: (pid: number) => string | null) {
  const files = new Map<string, string>([[SUPERVISOR_PATH, STALE]])
  const spawns: FakeChild[] = []
  const prints: string[] = []
  const done = superviseClaude(BASE, {
    platform: 'linux',
    env: {},
    home: HOME,
    cwd: CWD,
    scriptDir: SCRIPT_DIR,
    readFile: (p: string) => (p === `${CWD}/.bgos-agent-id` ? '871' : files.get(p) ?? null),
    listDir: () => [],
    spawnImpl: ((_file: string, args: readonly string[]) => {
      const child = new FakeChild(args)
      spawns.push(child)
      return child
    }) as never,
    writeErr: () => {},
    exists: (p: string) => files.has(p),
    writeFile: (p: string, c: string) => {
      files.set(p, c)
      return true
    },
    removeFile: (p: string) => files.delete(p),
    pollMs: 5,
    print: (l: string) => prints.push(l),
    now: () => 1_000,
    listProcesses: () => [],
    hasExpect: false,
    // The stale file's pid is ALIVE: after a reboot it belongs to someone else.
    pidAlive: (pid: number) => pid === 626,
    pidCommandLine,
  } as never)
  return { files, spawns, prints, done }
}

async function until(check: () => boolean, what: string) {
  const deadline = Date.now() + 3000
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}

test('superviseClaude: a supervisor.json left by an unclean stop, whose pid is now an unrelated process, no longer keeps the agent down', async () => {
  const h = loop((pid) => (pid === 626 ? '/usr/libexec/rapportd' : null))
  await until(() => h.spawns.length === 1, 'the launch')
  const armed = JSON.parse(h.files.get(SUPERVISOR_PATH)!)
  assert.equal(armed.pid, process.pid, 'this launcher took the file over')
  assert.ok(h.prints.some((l) => l.includes('restart supervisor armed for assistant 871')))
  h.spawns[0]!.exit(0)
  assert.equal(await h.done, 0)
  assert.equal(h.files.has(SUPERVISOR_PATH), false)
})

test('superviseClaude: the same file whose pid still runs hoai-core.mjs is a live owner: no second session', async () => {
  const h = loop((pid) => (pid === 626 ? HOAI_CMD : null))
  assert.equal(await h.done, EXIT_ALREADY_SUPERVISED)
  assert.equal(h.spawns.length, 0)
  assert.equal(h.files.get(SUPERVISOR_PATH), STALE, 'the owner\'s file is left alone')
})
