/**
 * Never a second copy of this plugin inside an owner's full access thread
 * (lib/thread-lane-marker.mjs, 0.88.0), and never a plugin kept out anywhere
 * else: the mark is the path of the thread's own lane state file, believed
 * only by a process that file's own CLI started, and by a hook of that
 * file's own session.
 */

import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import * as marker from '../lib/thread-lane-marker.mjs'
import { startedByThreadLane as wrapperStartedByThreadLane } from '../bin/bgos-daemon-wrapper.mjs'

const { THREAD_LANE_ENV } = marker
const FORK = 'dbd3b62b-f099-4f95-be1d-4687b4af9042'
const OTHER = '060f0349-719c-4450-aab2-189517f87a76'
const repo = (rel: string) => fileURLToPath(new URL(`../${rel}`, import.meta.url))
const state = (over: Record<string, unknown> = {}) => JSON.stringify({ rootId: '101', pid: 4242, forkSessionId: FORK, ...over })
const reader = (files: Record<string, string>) => (path: string) => {
  const v = files[path]
  if (v === undefined) throw new Error('ENOENT')
  return v
}

test('a process is the thread\'s own plugin copy only when the lane state the mark names holds its parent', () => {
  const files = { '/state/101.json': state() }
  const env = { [THREAD_LANE_ENV]: '/state/101.json' }
  const readFile = reader(files)
  assert.equal(marker.startedByThreadLane({ env, ppid: 4242, readFile }), true)
  assert.equal(marker.startedByThreadLane({ env, ppid: 4243, readFile }), false, 'an agent the thread launched from its Bash has another parent')
  assert.equal(marker.startedByThreadLane({ env: {}, ppid: 4242, readFile }), false, 'no mark')
  assert.equal(marker.startedByThreadLane({ env: { [THREAD_LANE_ENV]: '  ' }, ppid: 4242, readFile }), false)
  assert.equal(marker.startedByThreadLane({ env: { [THREAD_LANE_ENV]: '/state/gone.json' }, ppid: 4242, readFile }), false, 'a mark whose file is gone names no thread')
  assert.equal(marker.startedByThreadLane({ env, ppid: 4242, readFile: () => 'not json' }), false)
  assert.equal(marker.startedByThreadLane({ env, ppid: 4242, readFile: () => state({ pid: null }) }), false, 'a state with no process yet')
  assert.equal(marker.startedByThreadLane({ env, ppid: 4242, readFile: () => '[4242]' }), false)
})

test('server.ts also accepts the thread\'s CLI one level up (a wrapper started it), and no further', () => {
  const env = { [THREAD_LANE_ENV]: '/state/101.json' }
  const readFile = reader({ '/state/101.json': state() })
  const chain: Record<number, number> = { 900: 800, 800: 4242, 700: 600, 600: 500, 500: 4242 }
  const parentOf = (pid: number) => chain[pid] ?? null
  assert.equal(marker.startedByThreadLane({ env, ppid: 800, readFile, parentOf }), true, 'CLI, wrapper, server')
  assert.equal(marker.startedByThreadLane({ env, ppid: 600, readFile, parentOf }), false, 'CLI, shell, another agent, server: that agent\'s own server starts')
  assert.equal(marker.startedByThreadLane({ env, ppid: 800, readFile }), false, 'a launcher looks at its own parent only')
})

test('the installed wrapper\'s own copy of the check answers the same', () => {
  const files = { '/state/101.json': state() }
  for (const [env, ppid] of [
    [{ [THREAD_LANE_ENV]: '/state/101.json' }, 4242], [{ [THREAD_LANE_ENV]: '/state/101.json' }, 1], [{}, 4242],
    [{ [THREAD_LANE_ENV]: '/state/gone.json' }, 4242], [{ [THREAD_LANE_ENV]: '' }, 4242],
  ] as const) {
    assert.equal(wrapperStartedByThreadLane(env, ppid, reader(files)), marker.startedByThreadLane({ env, ppid, readFile: reader(files) }), JSON.stringify([env, ppid]))
  }
  // The wrapper is copied out of the plugin: it may import nothing from it.
  const source = readFileSync(repo('bin/bgos-daemon-wrapper.mjs'), 'utf8')
  assert.doesNotMatch(source, /from '\.\.\/lib\//)
  assert.match(source, /if \(parsed\.kind === 'run' && startedByThreadLane\(\)\) return 0/)
})

test('only the plugin\'s Stop hooks are skipped, and only for the thread\'s own session', () => {
  const env = { [THREAD_LANE_ENV]: '/state/101.json' }
  const readFile = reader({ '/state/101.json': state() })
  assert.equal(marker.threadLaneSkipsHook({ env, event: 'Stop', sessionId: FORK, readFile }), true)
  assert.equal(marker.threadLaneSkipsHook({ env, event: 'Stop', sessionId: FORK.toUpperCase(), readFile }), true)
  assert.equal(marker.threadLaneSkipsHook({ env, event: 'Stop', sessionId: OTHER, readFile }), false, 'an agent the thread launched keeps its own Stop hooks')
  for (const event of ['PreToolUse', 'UserPromptSubmit', 'SessionStart', 'SessionEnd', 'SubagentStart', 'PostToolUse']) {
    assert.equal(marker.threadLaneSkipsHook({ env, event, sessionId: FORK, readFile }), false, `${event} runs in a thread: the floor and the private boundary stay`)
  }
  assert.equal(marker.threadLaneSkipsHook({ env: {}, event: 'Stop', sessionId: FORK, readFile }), false, 'the main session, with no mark')
  assert.equal(marker.threadLaneSkipsHook({ env, event: 'Stop', sessionId: '', readFile }), false)
  assert.equal(marker.threadLaneSkipsHook({ env, event: 'Stop', sessionId: FORK, readFile: () => state({ forkSessionId: null }) }), false)
})

// -- the real files, as the CLI starts them ---------------------------------

/** A node process whose child is `script`: the child's parent id is known, as a thread's CLI is to its servers. */
function runAsChildOf(parentWrites: (ppid: number) => void, script: string, args: string[], env: Record<string, string>, stdin = ''): { status: number | null; stdout: string; stderr: string } {
  // The parent is this test process: spawnSync starts the script as its direct child.
  parentWrites(process.pid)
  const out = spawnSync(process.execPath, [script, ...args], { env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env }, input: stdin, encoding: 'utf8', timeout: 30_000 })
  return { status: out.status, stdout: out.stdout ?? '', stderr: out.stderr ?? '' }
}

/**
 * A copy of the two launchers whose children are stubs: the browser launcher's
 * MCP shim and the channel launcher's server only write a marker and exit. The
 * real shim starts the Agent Browser host, which outlives this test and, on a
 * test runner, keeps running through every later Chromium file (it doubled one
 * of them on Linux CI). `lib/` is the real one, linked.
 */
function launcherCopy(dir: string): { bin: string; started: (name: string) => boolean } {
  const bin = join(dir, 'bin')
  mkdirSync(bin, { recursive: true })
  for (const name of ['bgos-launch.mjs', 'hoai-browser-launch.mjs']) copyFileSync(repo(`bin/${name}`), join(bin, name))
  symlinkSync(repo('lib'), join(dir, 'lib'), 'dir')
  const stub = (name: string) => `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(join(dir, `${name}.started`))}, 'started')\n`
  writeFileSync(join(bin, 'hoai-browser-mcp.mjs'), stub('hoai-browser-mcp'))
  writeFileSync(join(dir, 'server.ts'), stub('server'))
  return { bin, started: (name) => existsSync(join(dir, `${name}.started`)) }
}

test('bgos-launch and hoai-browser-launch exit 0 at once, with no output, when the thread\'s own CLI started them, and start as usual otherwise', { skip: process.platform === 'win32' ? 'threads do not run on Windows' : false }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'thread-mark-'))
  try {
    const lane = join(dir, '101.json')
    const copy = launcherCopy(dir)
    const server = join(dir, 'server.ts')
    for (const [launcher, child] of [['bgos-launch.mjs', 'server'], ['hoai-browser-launch.mjs', 'hoai-browser-mcp']] as const) {
      const script = join(copy.bin, launcher)
      const inThread = runAsChildOf((pid) => writeFileSync(lane, state({ pid })), script, [server], { [THREAD_LANE_ENV]: lane })
      assert.equal(inThread.status, 0, `${launcher}: ${inThread.stderr}`)
      assert.equal(inThread.stdout, '', 'nothing on stdout: it is an MCP pipe')
      assert.equal(inThread.stderr, '')
      assert.equal(copy.started(child), false, `${launcher} started nothing`)
      // The same mark, but its lane names another process: a different agent's own launcher goes on and starts its child.
      const elsewhere = runAsChildOf((pid) => writeFileSync(lane, state({ pid: pid + 100_000 })), script, [server], { [THREAD_LANE_ENV]: lane })
      if (child === 'server' && !copy.started(child)) {
        // The channel launcher needs bun to start its server: with none on this computer it says so, past the mark all the same.
        assert.match(elsewhere.stderr, /bun/i, `${launcher} did not stop at the mark: ${elsewhere.status} ${elsewhere.stderr}`)
      } else {
        assert.equal(copy.started(child), true, `${launcher} went past the mark and started its child: ${elsewhere.status} ${elsewhere.stderr}`)
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('server.ts checks the mark as its first statement, before any credential, lock or socket', () => {
  const source = readFileSync(repo('server.ts'), 'utf8')
  const guard = source.indexOf('if (startedByThreadLane({ parentOf: parentPid })) process.exit(0)')
  assert.ok(guard > 0, 'the guard is there')
  // Everything before it is a comment, an import or a blank line.
  const before = source.slice(0, guard).replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('//'))
  let inImport = false
  for (const line of before) {
    if (inImport) {
      if (/from\s+['"][^'"]+['"]\s*;?$/.test(line) || /^['"][^'"]+['"]\s*;?$/.test(line)) inImport = false
      continue
    }
    assert.match(line, /^import\b/, `a statement runs before the thread guard: ${line}`)
    if (!/from\s+['"][^'"]+['"]\s*;?$/.test(line) && !/^import\s+['"][^'"]+['"]\s*;?$/.test(line)) inImport = true
  }
})

test('the plugin\'s blocking Stop hooks do nothing for the thread\'s own session', { skip: process.platform === 'win32' ? 'threads do not run on Windows' : false }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'thread-mark-'))
  try {
    const lane = join(dir, '101.json')
    writeFileSync(lane, state())
    const stop = (sessionId: string) => JSON.stringify({ hook_event_name: 'Stop', session_id: sessionId, cwd: dir, transcript_path: join(dir, 't.jsonl') })
    const env = { [THREAD_LANE_ENV]: lane, HOME: dir, BGOS_PLUGIN_STATE_DIR: join(dir, 'state') }
    for (const hook of ['bin/hoai-private-turn-hook.mjs', 'bin/hoai-mission-turn-hook.mjs']) {
      const own = spawnSync(process.execPath, [repo(hook)], { env: { PATH: process.env.PATH ?? '', ...env }, input: stop(FORK), encoding: 'utf8', timeout: 30_000 })
      assert.equal(own.status, 0, `${hook}: ${own.stderr}`)
      assert.equal(own.stdout, '', `${hook} says nothing in a thread`)
      assert.equal(own.stderr, '')
    }
    // The source: the skip is the first thing each hook decides, on the event and the session.
    for (const hook of ['bin/hoai-private-turn-hook.mjs', 'bin/hoai-mission-turn-hook.mjs']) {
      assert.match(readFileSync(repo(hook), 'utf8'), /if \(threadLaneSkipsHook\(\{ event: payload\?\.hook_event_name, sessionId: payload\?\.session_id \}\)\) return/)
    }
    // The telemetry forwarder is not touched: it is bound to one session by the daemon already (lib/hook-intake.ts).
    assert.doesNotMatch(readFileSync(repo('bin/hoai-hook.mjs'), 'utf8'), /thread-lane-marker/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
