/**
 * The agent 867 shape with REAL processes (Linux only): a launcher whose event
 * loop has stopped, so the claude it started is a real zombie (state Z, never
 * reaped) and the SIGTERM handler hoai's main() wires never runs. The fake
 * claude is a two-line shell script and every launch's spawn is injected, so
 * no real claude ever starts; every file lives in a scratch HOME under the
 * OS temp folder.
 *
 *   - the next launch, with the real process readers and the real kill, ends
 *     that holder (TERM, then KILL) and launches the agent; on main it exited
 *     3 behind it forever;
 *   - control: a holder whose claude is alive is left alone, exit 3;
 *   - the watchdog: a wedged launcher whose claude has exited releases its own
 *     claim and ends itself; one whose claude is still alive does nothing.
 *
 * Run: npx tsx --test test/hoai-core.launcher-zombie.real.test.ts
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { EXIT_ALREADY_SUPERVISED, SUPERVISOR_FILE_NAME, superviseClaude } from '../bin/hoai-core.mjs'

const LINUX = process.platform === 'linux'
const REPO = join(import.meta.dirname, '..')
const ID = '999'

function scratch() {
  const root = mkdtempSync(join(tmpdir(), 'hoai-zombie-real-'))
  const home = join(root, 'home')
  const cwd = join(root, 'agent')
  const bin = join(root, 'fake', 'bin')
  mkdirSync(join(home, '.bgos-agent', ID), { recursive: true })
  mkdirSync(cwd, { recursive: true })
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(cwd, '.bgos-agent-id'), `${ID}\n`)
  const claim = join(home, '.bgos-agent', ID, SUPERVISOR_FILE_NAME)
  return { root, home, cwd, bin, claim, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

/** A fake claude that lives `seconds`, then exits. Its name is what ps shows. */
function fakeClaude(bin: string, seconds: number) {
  const path = join(bin, 'claude')
  writeFileSync(path, `#!/bin/sh\n# fake claude for a test, never the real one\nsleep ${seconds}\nexit 0\n`)
  chmodSync(path, 0o755)
  return path
}

/**
 * A fake launcher at <bin>/hoai-core.mjs (the script name the writer check reads):
 * it claims the agent with the real supervisorFileBody, starts the fake claude,
 * wires SIGTERM the way main() does, optionally arms the real watchdog, then
 * blocks its own event loop for a minute.
 */
function fakeLauncher(s: ReturnType<typeof scratch>, watchdog: boolean, folder = s.cwd) {
  const path = join(s.bin, 'hoai-core.mjs')
  const core = pathToFileURL(join(REPO, 'bin', 'hoai-core.mjs')).href
  const inventory = pathToFileURL(join(REPO, 'lib', 'agent-inventory.mjs')).href
  writeFileSync(
    path,
    [
      `import { spawn } from 'node:child_process'`,
      `import { writeFileSync } from 'node:fs'`,
      `const core = await import(${JSON.stringify(core)})`,
      `const { readBootClock } = await import(${JSON.stringify(inventory)})`,
      `const claim = ${JSON.stringify(s.claim)}`,
      `writeFileSync(claim, core.supervisorFileBody(process.pid, new Date().toISOString(), readBootClock({ platform: 'linux' })))`,
      `const child = spawn(${JSON.stringify(join(s.bin, 'claude'))}, [], { stdio: 'ignore' })`,
      `process.once('SIGTERM', () => {})`,
      watchdog ? `core.startLauncherWatchdog({ claimPath: claim, pid: process.pid, platform: 'linux', wedgeMs: 1500, checkMs: 200 })` : '',
      `setTimeout(() => { process.stdout.write('child ' + child.pid + '\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000) }, 100)`,
    ].join('\n'),
  )
  // In the agent's folder, as hoai always runs: the takeover proves the holder is THIS agent's by it.
  const proc = spawn(process.execPath, [path], { cwd: folder, stdio: ['ignore', 'pipe', 'inherit'] })
  let out = ''
  proc.stdout!.on('data', (d) => (out += String(d)))
  const childPid = async () => {
    await until(() => /child (\d+)/.test(out), 'the fake launcher to start its claude')
    return Number(/child (\d+)/.exec(out)![1])
  }
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => proc.on('exit', (code, signal) => resolve({ code, signal })))
  return { proc, childPid, exited }
}

function stateOf(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] ?? null
  } catch {
    return null
  }
}

async function until(check: () => boolean, what: string, ms = 10_000) {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

function alive(proc: ChildProcess) {
  return proc.exitCode === null && proc.signalCode === null
}

/** Ends a fake claude a test left behind (its parent's KILL orphans it). */
function endPid(pid: number | null) {
  if (pid === null) return
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // Already gone.
  }
}

async function launchAgainst(s: ReturnType<typeof scratch>) {
  const spawns: string[][] = []
  const prints: string[] = []
  const code = await superviseClaude(['--dangerously-load-development-channels', 'server:bgos'], {
    platform: 'linux',
    env: { HOAI_SUPERVISED: '1', HOAI_SUPERVISED_ASSISTANT_ID: ID },
    home: s.home,
    cwd: s.cwd,
    scriptDir: join(REPO, 'bin'),
    hasExpect: true,
    listProcesses: () => [],
    print: (l: string) => prints.push(l),
    writeErr: () => {},
    takeoverConfirmMs: 1_000,
    takeoverPollMs: 250,
    takeoverTermWaitMs: 1_000,
    startWatchdog: () => ({ stop() {} }),
    spawnImpl: ((_file: string, args: readonly string[]) => {
      spawns.push([...args])
      const child = new EventEmitter() as EventEmitter & { kill: () => void; pid: number }
      child.pid = 0
      child.kill = () => setImmediate(() => child.emit('exit', null, 'SIGTERM'))
      setImmediate(() => child.emit('exit', 0, null))
      return child
    }) as never,
  } as never)
  return { code, spawns, prints }
}

test('real processes, agent 867: a wedged launcher whose claude is a zombie and that ignores TERM is ended with KILL, and the agent launches', { skip: !LINUX }, async () => {
  const s = scratch()
  const holder = (() => {
    fakeClaude(s.bin, 1)
    return fakeLauncher(s, false)
  })()
  try {
    const childPid = await holder.childPid()
    await until(() => stateOf(childPid) === 'Z', 'the fake claude to become a zombie')
    const r = await launchAgainst(s)
    assert.equal(r.code, 0, r.prints.join('\n'))
    assert.equal(r.spawns.length, 1, r.prints.join('\n'))
    assert.deepEqual(await holder.exited, { code: null, signal: 'SIGKILL' }, 'TERM was ignored, KILL ended it')
    assert.equal(stateOf(childPid), null, 'the zombie went with its parent')
    assert.ok(r.prints.some((l) => /SIGKILL/.test(l)), r.prints.join('\n'))
  } finally {
    if (alive(holder.proc)) holder.proc.kill('SIGKILL')
    s.cleanup()
  }
})

test('real processes, control: a wedged launcher whose claude is ALIVE stays the owner: exit 3, never signalled', { skip: !LINUX }, async () => {
  const s = scratch()
  fakeClaude(s.bin, 30)
  const holder = fakeLauncher(s, false)
  let claudePid: number | null = null
  try {
    const childPid = await holder.childPid()
    claudePid = childPid
    assert.notEqual(stateOf(childPid), 'Z')
    const r = await launchAgainst(s)
    assert.equal(r.code, EXIT_ALREADY_SUPERVISED, r.prints.join('\n'))
    assert.equal(r.spawns.length, 0)
    assert.ok(alive(holder.proc), 'the owner is untouched')
    assert.ok(existsSync(s.claim))
  } finally {
    holder.proc.kill('SIGKILL')
    endPid(claudePid)
    s.cleanup()
  }
})

test('real processes, control: the same wedged idle holder running in ANOTHER folder (a reused pid) is never signalled', { skip: !LINUX }, async () => {
  const s = scratch()
  fakeClaude(s.bin, 1)
  const holder = fakeLauncher(s, false, s.root)
  try {
    const childPid = await holder.childPid()
    await until(() => stateOf(childPid) === 'Z', 'the fake claude to become a zombie')
    const r = await launchAgainst(s)
    assert.equal(r.code, EXIT_ALREADY_SUPERVISED, r.prints.join('\n'))
    assert.equal(r.spawns.length, 0)
    assert.ok(alive(holder.proc), 'never signalled')
  } finally {
    holder.proc.kill('SIGKILL')
    s.cleanup()
  }
})

test('real processes, watchdog: a wedged launcher whose claude has exited releases its own claim and ends itself', { skip: !LINUX }, async () => {
  const s = scratch()
  fakeClaude(s.bin, 1)
  const holder = fakeLauncher(s, true)
  try {
    await holder.childPid()
    const ended = await Promise.race([holder.exited, new Promise((resolve) => setTimeout(() => resolve('still running'), 10_000))])
    assert.deepEqual(ended, { code: null, signal: 'SIGKILL' })
    assert.equal(existsSync(s.claim), false, 'the claim is released')
    assert.match(readFileSync(join(s.home, '.bgos-agent', ID, 'launch-status'), 'utf8'), /outcome=launcher-wedged/)
  } finally {
    if (alive(holder.proc)) holder.proc.kill('SIGKILL')
    s.cleanup()
  }
})

test('real processes, watchdog control: a wedged launcher whose claude is alive is left running with its claim', { skip: !LINUX }, async () => {
  const s = scratch()
  fakeClaude(s.bin, 30)
  const holder = fakeLauncher(s, true)
  let claudePid: number | null = null
  try {
    claudePid = await holder.childPid()
    await new Promise((resolve) => setTimeout(resolve, 4_000))
    assert.ok(alive(holder.proc), 'a stuck loop over a live claude is not ended')
    assert.ok(existsSync(s.claim))
  } finally {
    holder.proc.kill('SIGKILL')
    endPid(claudePid)
    s.cleanup()
  }
})
