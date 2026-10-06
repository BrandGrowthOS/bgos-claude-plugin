/**
 * Stopping a SUPERVISED hoai (HOAI_SUPERVISED=1, bin/bgos-agent run.sh v2)
 * cleans up after itself (plugin-supervisor review F1, the signal half).
 *
 * Every stop of the v2 service is a signal: run.sh's on_stop kills the
 * agent's tmux server, which hangs up hoai (SIGHUP); without tmux it TERMs
 * hoai's process group; systemd and launchd TERM it at shutdown. main() wired
 * SIGTERM and SIGHUP only for --keep-alive, so a supervised hoai died on the
 * default action and superviseClaude's `finally { removeFile(supervisorPath) }`
 * never ran: supervisor.json was left behind on EVERY stop, and after a reboot
 * its pid could be any live process, which kept the agent down. Now a
 * supervised launch handles both signals exactly as --keep-alive does: the
 * live claude is stopped, nothing is relaunched, and supervisor.json goes.
 * A stop that lands before anything is armed (during the incumbent wait)
 * returns at once and arms nothing.
 *
 * Every OS effect is a fake: the signals are an EventEmitter handed to main(),
 * the children are fakes, HOME and the agent folder are temp dirs.
 *
 * Run: npx tsx --test test/hoai-core.stop.test.ts
 */

import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { FOLDER_PIN_FILE, SUPERVISOR_FILE_NAME, main, superviseClaude } from '../bin/hoai-core.mjs'

const CLONE_SCRIPT_DIR = '/home/kc/bgos-claude-plugin/bin'

class FakeChild extends EventEmitter {
  killed: string | null = null
  kill(signal?: string) {
    this.killed = signal ?? 'SIGTERM'
    setTimeout(() => this.emit('exit', null, 'SIGTERM'), 1)
    return true
  }
}

async function until(check: () => boolean, what: string) {
  const deadline = Date.now() + 5000
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}

function sandbox() {
  const home = mkdtempSync(join(tmpdir(), 'hoai-stop-home-'))
  const cwd = mkdtempSync(join(tmpdir(), 'hoai-stop-agent-'))
  // An expect on this pretend host's PATH (hostHasExpect only checks that the file is there).
  const bin = mkdtempSync(join(tmpdir(), 'hoai-stop-bin-'))
  writeFileSync(join(bin, 'expect'), '')
  writeFileSync(join(cwd, FOLDER_PIN_FILE), '900\n')
  mkdirSync(join(home, '.bgos-agent', '900'), { recursive: true })
  const supervisorPath = join(home, '.bgos-agent', '900', SUPERVISOR_FILE_NAME)
  const cleanup = () => {
    for (const dir of [home, cwd, bin]) rmSync(dir, { recursive: true, force: true })
  }
  return { home, cwd, bin, supervisorPath, cleanup }
}

for (const name of ['SIGHUP', 'SIGTERM'] as const) {
  test(`supervised: ${name} (${name === 'SIGHUP' ? 'run.sh killed the tmux server' : 'no tmux, systemd or launchd stop'}) stops claude, relaunches nothing, and REMOVES supervisor.json`, async () => {
    const sb = sandbox()
    const signals = new EventEmitter()
    const spawns: FakeChild[] = []
    try {
      const done = main([], {
        platform: 'linux',
        env: { HOAI_SUPERVISED: '1', HOAI_SUPERVISED_ASSISTANT_ID: '900', PATH: sb.bin },
        home: sb.home,
        cwd: sb.cwd,
        scriptDir: CLONE_SCRIPT_DIR,
        listProcesses: () => [],
        print: () => {},
        registerHooks: () => {},
        preseedTrust: () => {},
        signals,
        spawnImpl: (() => {
          const child = new FakeChild()
          spawns.push(child)
          return child
        }) as never,
      } as never)
      await until(() => spawns.length === 1, 'the supervised launch')
      assert.ok(existsSync(sb.supervisorPath), 'armed: supervisor.json names this launcher')
      assert.equal(signals.listenerCount(name), 1, `a supervised launch handles ${name} (it used to die on the default action)`)
      signals.emit(name)
      const code = await done
      assert.equal(spawns[0]!.killed, 'SIGTERM', 'the live session was stopped')
      assert.equal(spawns.length, 1, 'and nothing was relaunched')
      assert.equal(code, 143)
      assert.equal(existsSync(sb.supervisorPath), false, 'the finally block ran: no supervisor.json is left to outlive the service')
      assert.equal(signals.listenerCount('SIGHUP') + signals.listenerCount('SIGTERM'), 0, 'and the handlers are gone with the launch')
    } finally {
      // A red run must still end the launch, or its poller holds the test process open.
      for (const child of spawns) child.emit('exit', 0, null)
      sb.cleanup()
    }
  })
}

test('a person-facing hoai (not supervised, no --keep-alive) still leaves both signals to their default action', async () => {
  const sb = sandbox()
  const signals = new EventEmitter()
  const spawns: FakeChild[] = []
  try {
    const done = main([], {
      platform: 'linux',
      env: { PATH: sb.bin },
      home: sb.home,
      cwd: sb.cwd,
      scriptDir: CLONE_SCRIPT_DIR,
      listProcesses: () => [],
      print: () => {},
      registerHooks: () => {},
      preseedTrust: () => {},
      signals,
      spawnImpl: (() => {
        const child = new FakeChild()
        spawns.push(child)
        return child
      }) as never,
    } as never)
    await until(() => spawns.length === 1, 'the launch')
    assert.equal(signals.listenerCount('SIGHUP') + signals.listenerCount('SIGTERM'), 0)
    spawns[0]!.emit('exit', 0, null)
    assert.equal(await done, 0)
  } finally {
    sb.cleanup()
  }
})

function preArm(signal: AbortSignal, listProcesses: () => Array<Record<string, unknown>>) {
  const files = new Map<string, string>()
  const spawns: FakeChild[] = []
  const done = superviseClaude(['--dangerously-skip-permissions'], {
    platform: 'linux',
    env: { HOAI_SUPERVISED: '1', HOAI_SUPERVISED_ASSISTANT_ID: '871' },
    home: '/home/kc',
    cwd: '/agents/athena',
    scriptDir: CLONE_SCRIPT_DIR,
    readFile: (p: string) => (p === '/agents/athena/.bgos-agent-id' ? '871' : files.get(p) ?? null),
    listDir: () => [],
    spawnImpl: (() => {
      const child = new FakeChild()
      spawns.push(child)
      // A red run (a launch that should not have happened) ends at once instead of hanging.
      setTimeout(() => child.emit('exit', 0, null), 5)
      return child
    }) as never,
    writeErr: () => {},
    exists: (p: string) => files.has(p),
    writeFile: (p: string, c: string) => {
      files.set(p, c)
      return true
    },
    removeFile: (p: string) => files.delete(p),
    print: () => {},
    hasExpect: true,
    listProcesses,
    pollMs: 250,
    // Short, so a wait that ignores the stop fails in seconds rather than hanging.
    incumbentTimeoutMs: 5_000,
    signal,
  } as never)
  return { files, spawns, done }
}

test('a stop that lands before anything is armed returns at once: no supervisor.json, no claude', async () => {
  const stop = new AbortController()
  stop.abort()
  const h = preArm(stop.signal, () => [])
  assert.equal(await h.done, 143)
  assert.equal(h.spawns.length, 0)
  assert.equal(h.files.size, 0, 'nothing written, so nothing is left behind')
})

test('a stop during the incumbent wait ends the wait at once instead of sitting out its timeout, and arms nothing', async () => {
  const stop = new AbortController()
  // A claude of ours that sits in this folder for good: the wait would last until its timeout.
  const incumbent = () => [{ pid: 4243, ppid: 1, uid: typeof process.getuid === 'function' ? process.getuid() : null, comm: 'claude', cwd: '/agents/athena' }]
  const started = Date.now()
  const h = preArm(stop.signal, incumbent)
  setTimeout(() => stop.abort(), 50)
  assert.equal(await h.done, 143)
  assert.ok(Date.now() - started < 3000, `the wait ended on the stop (${Date.now() - started} ms)`)
  assert.equal(h.spawns.length, 0)
  assert.equal(h.files.size, 0)
})
