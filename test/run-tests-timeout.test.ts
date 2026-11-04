// The watchdog lives outside the test process, including when that process
// leaves a detached child behind or blocks its own event loop.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { removeScratchDir } from './helpers/scratch-dirs'

const runner: any = await import('../scripts/run-test-files.mjs').catch((e) => {
  if (e.code === 'ERR_MODULE_NOT_FOUND') return null
  throw e
})

test('a blocked test fails by file name and releases its worker before the deadline', { timeout: 60_000 }, async () => {
  assert.ok(runner, 'the bounded file runner must exist')
  const dir = mkdtempSync(join(tmpdir(), 'runner-hang-'))
  try {
    const file = join(dir, 'deliberate-hang.test.cjs')
    writeFileSync(file, "require('node:test')('deliberate hang', async () => { setInterval(() => {}, 1000); await new Promise(() => {}) })")
    let output = ''
    const start = Date.now()
    const result = await runner.runTestFile(basename(file), {
      command: process.execPath, args: ['--test', '--experimental-test-isolation=none'],
      cwd: dir, timeoutMs: 1500, onOutput: (chunk: string) => { output += chunk },
    })
    assert.notEqual(result.code, 0)
    assert.equal(result.timedOut, true)
    assert.match(output, /TIMEOUT.*deliberate-hang\.test\.cjs/)
    assert.ok(Date.now() - start < 30_000)
  } finally { removeScratchDir(dir) }
})

test('a file stuck after its test passes loses its detached descendant too', { timeout: 60_000 }, async () => {
  assert.ok(runner, 'the bounded file runner must exist')
  const dir = mkdtempSync(join(tmpdir(), 'runner-leak-'))
  const pidFile = join(dir, 'child.pid')
  let pid: number | undefined
  try {
    const file = join(dir, 'leaked-child.test.cjs')
    writeFileSync(file, `
      const { spawn } = require('node:child_process')
      const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })
      require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid))
      require('node:test')('body passed but file leaked a child', () => {})
      setInterval(() => {}, 1000)
    `)
    let output = ''
    const result = await runner.runTestFile(basename(file), {
      command: process.execPath, args: ['--test', '--experimental-test-isolation=none'],
      cwd: dir, timeoutMs: 5000, onOutput: (chunk: string) => { output += chunk },
    })
    assert.ok(existsSync(pidFile), 'the descendant actually started')
    pid = Number(readFileSync(pidFile, 'utf8'))
    assert.equal(result.timedOut, true)
    assert.notEqual(result.code, 0)
    assert.match(output, /TIMEOUT.*leaked-child\.test\.cjs/)
    const alive = () => { try { process.kill(pid!, 0); return true } catch { return false } }
    for (let i = 0; i < 500 && alive(); i++) await new Promise((r) => setTimeout(r, 10))
    assert.equal(alive(), false, 'detached does not mean abandoned on timeout')
  } finally {
    if (pid) { try { process.kill(pid, 'SIGKILL') } catch {} }
    removeScratchDir(dir)
  }
})

test('an unsuccessful file and a missing executable fail without waiting for the watchdog', async () => {
  assert.ok(runner, 'the bounded file runner must exist')
  const dir = mkdtempSync(join(tmpdir(), 'runner-exit-'))
  try {
    const file = join(dir, 'exit.cjs')
    writeFileSync(file, 'process.exit(7)')
    const options = { cwd: dir, timeoutMs: 5000, onOutput: () => {} }
    const exited = await runner.runTestFile(file, { ...options, command: process.execPath, args: [] })
    assert.equal(exited.code, 7)
    assert.equal(exited.timedOut, false)
    const missing = await runner.runTestFile(file, { ...options, command: join(dir, 'missing-executable'), args: [] })
    assert.equal(missing.code, 1)
    assert.equal(missing.timedOut, false)
    // Windows throws at spawn for a .cmd without a shell, a npm bun.cmd for one. A NUL does the same here.
    const refused = await runner.runTestFile('bad\0name', { ...options, command: process.execPath, args: [] })
    assert.equal(refused.code, 1, 'one file fails; the run and its other workers carry on')
    assert.equal(refused.timedOut, false)
  } finally { removeScratchDir(dir) }
})

test('file scheduling caps requested concurrency at four and continues after a failure', async () => {
  assert.ok(runner, 'the bounded file runner must exist')
  const dir = mkdtempSync(join(tmpdir(), 'runner-pool-'))
  try {
    const files = Array.from({ length: 6 }, (_, i) => {
      const file = join(dir, `${i}.cjs`)
      writeFileSync(file, `console.log('started'); setTimeout(() => { console.log('ended'); process.exit(${i === 0 ? 1 : 0}) }, 150)`)
      return file
    })
    let active = 0, peak = 0, finished = 0
    const buffers = new Map<string, string>()
    const results = await runner.runTestFiles(files, {
      command: process.execPath, args: [], cwd: dir, concurrency: 99, timeoutMs: 5000,
      onOutput: (chunk: string, file: string) => {
        const lines = ((buffers.get(file) ?? '') + chunk).split(/\r?\n/)
        buffers.set(file, lines.pop()!)
        for (const line of lines) {
          if (line === 'started') { active++; peak = Math.max(peak, active) }
          if (line === 'ended') { active--; finished++ }
        }
      },
    })
    assert.equal(results.filter((r: { code: number }) => r.code !== 0).length, 1)
    assert.equal(finished, 6)
    assert.equal(active, 0)
    assert.ok(peak > 1 && peak <= 4, `observed ${peak} concurrent workers`)
  } finally { removeScratchDir(dir) }
})

// A synchronous test body gives the reporter no event loop turn, so without the
// runner's preload every TAP line arrives at the end of the file. The watchdog
// would then kill a healthy file of spawnSync tests (bgos-agent.home-scope).
test('a healthy file of blocking tests keeps resetting the deadline', { timeout: 90_000 }, async () => {
  assert.ok(runner, 'the bounded file runner must exist')
  const dir = mkdtempSync(join(tmpdir(), 'runner-sync-'))
  try {
    const file = join(dir, 'blocking.test.cjs')
    writeFileSync(file, `
      const { test } = require('node:test')
      const nap = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000)
      for (const name of ['one', 'two', 'three', 'four', 'five']) test(name, nap)
    `)
    const [group] = runner.testGroups([{ file, source: '' }])
    const result = await runner.runTestFile(basename(file), {
      command: group.command, args: group.args, cwd: dir, timeoutMs: 15_000, onOutput: () => {},
    })
    assert.equal(result.timedOut, false, 'five 5 s tests are 25 s of work, each inside a 15 s deadline')
    assert.equal(result.code, 0)
    assert.deepEqual(result.tally, { pass: 5, fail: 0, skipped: 0 })
  } finally { removeScratchDir(dir) }
})

test('a worker that exits while an orphan holds its pipes finishes without waiting for the deadline', { timeout: 60_000 }, async () => {
  assert.ok(runner, 'the bounded file runner must exist')
  const dir = mkdtempSync(join(tmpdir(), 'runner-pipe-'))
  const pidFile = join(dir, 'orphan.pid')
  let pid: number | undefined
  try {
    const file = join(dir, 'orphan.cjs')
    writeFileSync(file, `
      const { spawn } = require('node:child_process')
      const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'inherit' })
      require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid))
      c.unref()
    `)
    let output = ''
    const start = Date.now()
    const result = await runner.runTestFile(file, {
      command: process.execPath, args: [], cwd: dir, timeoutMs: 45_000, onOutput: (chunk: string) => { output += chunk },
    })
    pid = Number(readFileSync(pidFile, 'utf8'))
    assert.equal(result.timedOut, false)
    assert.equal(result.code, 0, 'the file itself finished and said so')
    assert.ok(Date.now() - start < 30_000, 'nowhere near the file deadline')
    assert.match(output, /LEAK.*orphan\.cjs/, 'the leak is named')
  } finally {
    if (pid) { try { process.kill(pid, 'SIGKILL') } catch {} }
    removeScratchDir(dir)
  }
})

test('a run reports each file whole, then its failures by name and its totals', { timeout: 60_000 }, async () => {
  assert.ok(runner, 'the bounded file runner must exist')
  const dir = mkdtempSync(join(tmpdir(), 'runner-report-'))
  try {
    const good = join(dir, 'good.test.cjs')
    const bad = join(dir, 'bad.test.cjs')
    writeFileSync(good, "const { test } = require('node:test'); test('fine', () => {}); test('later', { skip: 'why' }, () => {})")
    writeFileSync(bad, "const { test } = require('node:test'); test('the named failure', () => { throw new Error('no') })")
    const [group] = runner.testGroups([{ file: good, source: '' }])
    const writes: string[] = []
    const results = await runner.runTestFiles(['good.test.cjs', 'bad.test.cjs'], {
      command: group.command, args: group.args, family: group.family, cwd: dir, concurrency: 2, timeoutMs: 30_000,
      write: (text: string) => { writes.push(text) },
    })
    assert.deepEqual(results.map((r: { code: number }) => r.code), [0, 1])
    // Both START lines come before any result: a job cancelled from outside still shows what was running.
    assert.match(writes[0]!, /^\[run-tests\] START good\.test\.cjs\n$/)
    assert.match(writes[1]!, /^\[run-tests\] START bad\.test\.cjs\n$/)
    // One file's lines stay together, so a failure can be read in context.
    const block = writes.find((text) => /FAIL bad\.test\.cjs/.test(text))!
    assert.match(block, /not ok \d+ - the named failure/)
    assert.doesNotMatch(block, /ok \d+ - fine/)
    const summary = runner.summarize(results, 12.5)
    assert.match(summary, /1 passed, 1 failed, 1 skipped, 2 files, 12\.5 s/)
    assert.match(summary, /bad\.test\.cjs: the named failure/)
    assert.doesNotMatch(summary, /good\.test\.cjs/)
  } finally { removeScratchDir(dir) }
})

test('stopping the run ends a worker in flight, detached or not', { timeout: 60_000 }, async () => {
  assert.ok(runner, 'the bounded file runner must exist')
  const dir = mkdtempSync(join(tmpdir(), 'runner-stop-'))
  try {
    const file = join(dir, 'forever.cjs')
    writeFileSync(file, "console.log('up'); setInterval(() => {}, 1000)")
    let stopped: Promise<void> | undefined
    const result = await runner.runTestFile(file, {
      command: process.execPath, args: [], cwd: dir, timeoutMs: 45_000,
      onOutput: () => { stopped ??= runner.stopActiveTests() },
    })
    await stopped
    assert.equal(result.timedOut, false)
    assert.notEqual(result.code, 0)
  } finally { removeScratchDir(dir) }
})

test('no test asks for longer than the file deadline, or its hang could not fail by its own name', async () => {
  assert.ok(runner, 'the bounded file runner must exist')
  const folder = new URL('.', import.meta.url)
  const over: string[] = []
  for (const name of readdirSync(folder).filter((file) => file.endsWith('.ts'))) {
    const source = readFileSync(new URL(name, folder), 'utf8')
    for (const [, value] of source.matchAll(/\btimeout:\s*([\d_]+)/g)) {
      if (Number(value!.replace(/_/g, '')) >= runner.FILE_IDLE_TIMEOUT_MS) over.push(`${name}: ${value}`)
    }
  }
  assert.deepEqual(over, [])
})

// ── A file that did not complete must fail, by name ─────────────────────────
//
// Under `--test --experimental-test-isolation=none` Node drops a load error once
// the file has registered a test: the rest of the file never registers, and the
// process exits 0 with a clean tally. About 30 files read a fixture at top level
// after their first test, so on Windows a path problem would have read as green.

// Written in two pieces so that this file is not sorted into the bun family.
const BUN_IMPORT = "import { test } from " + "'bun:test';"
const NODE_IMPORT = "import { test } from 'node:test';"
const FINE = "test('fine', () => {});"

type Outcome = { file: string, code: number, tally: unknown, failures: string[] }

/** The real group's flags on the real scheduler, one healthy file alongside as the control. */
async function runDying(family: 'node' | 'bun', fixtures: Record<string, string>, timeoutMs = 60_000) {
  const dir = mkdtempSync(join(tmpdir(), 'runner-died-'))
  const healthy = family === 'node' ? 'control-healthy.test.mjs' : 'control-healthy.test.ts'
  const source = (family === 'node' ? NODE_IMPORT : BUN_IMPORT) + FINE
  try {
    writeFileSync(join(dir, healthy), source)
    for (const [name, body] of Object.entries(fixtures)) writeFileSync(join(dir, name), body)
    const group = runner.testGroups([{ file: 'x', source: family === 'node' ? '' : BUN_IMPORT }])
      .find((candidate: { files: string[] }) => candidate.files.length > 0)
    const { files: _files, label: _label, ...options } = group
    let output = ''
    const results: Outcome[] = await runner.runTestFiles([healthy, ...Object.keys(fixtures)], {
      ...options, cwd: dir, timeoutMs, write: (text: string) => { output += text },
    })
    assert.match(output, new RegExp(`PASS ${healthy}`), `the control must pass:\n${output}`)
    return { output, results, summary: runner.summarize(results, 1) as string, healthy }
  } finally { removeScratchDir(dir) }
}

function assertFailedByName({ output, summary, healthy }: { output: string, summary: string, healthy: string }, name: string) {
  assert.match(output, new RegExp(`\\[run-tests\\] FAIL ${name.replace(/\./g, '\\.')}`), `no FAIL line for ${name}:\n${output}`)
  assert.match(summary, new RegExp(`^  ${name.replace(/\./g, '\\.')}: `, 'm'), `the summary does not name ${name}:\n${summary}`)
  assert.doesNotMatch(summary, new RegExp(healthy.replace(/\./g, '\\.')), 'the healthy control stays out of the failures')
}

test('a file that throws at top level after its first test fails by name, and its error can be read', { timeout: 120_000 }, async () => {
  assert.ok(runner, 'the bounded file runner must exist')
  const name = 'thrown.test.mjs'
  const run = await runDying('node', { [name]: `${NODE_IMPORT}${FINE}throw new Error('thrown at top level');test('never registered', () => {})` })
  assertFailedByName(run, name)
  assert.match(run.output, /thrown at top level/)
})

test('a file whose top level await rejects after its first test fails by name, and its error can be read', { timeout: 120_000 }, async () => {
  assert.ok(runner, 'the bounded file runner must exist')
  const name = 'rejected.test.mjs'
  const run = await runDying('node', { [name]: `${NODE_IMPORT}${FINE}await Promise.reject(new Error('rejected at top level'));test('never registered', () => {})` })
  assertFailedByName(run, name)
  assert.match(run.output, /rejected at top level/)
})

test('the same deaths in TypeScript and CommonJS, as the suite and its fixtures are written', { timeout: 120_000 }, async () => {
  assert.ok(runner, 'the bounded file runner must exist')
  const fixtures = {
    'typed.test.ts': `${NODE_IMPORT}const why: string = 'typed';${FINE}throw new Error(why)`,
    'typed-await.test.ts': `${NODE_IMPORT}const why: string = 'typed';${FINE}await Promise.reject(new Error(why))`,
    'plain.test.cjs': `const { test } = require('node:test');${FINE}throw new Error('plain')`,
  }
  const run = await runDying('node', fixtures)
  for (const name of Object.keys(fixtures)) assertFailedByName(run, name)
})

test('a file that stopped early with a clean exit fails by name', { timeout: 120_000 }, async () => {
  assert.ok(runner, 'the bounded file runner must exist')
  const fixtures = {
    'never-settles.test.mjs': `${NODE_IMPORT}${FINE}await new Promise(() => {});test('never registered', () => {})`,
    'exit-at-top.test.mjs': `${NODE_IMPORT}${FINE}process.exit(0);test('never registered', () => {})`,
    'exit-later.test.mjs': `${NODE_IMPORT}${FINE}await new Promise((r) => setTimeout(r, 100));process.exit(0);test('never registered', () => {})`,
    'exit-in-test.test.mjs': `${NODE_IMPORT}test('quits', () => { process.exit(0) });test('never ran', () => {})`,
    'failed-then-exit.test.mjs': `${NODE_IMPORT}test('bad', () => { throw new Error('no') });test('quits', () => { process.exit(0) })`,
  }
  const run = await runDying('node', fixtures)
  for (const name of Object.keys(fixtures)) assertFailedByName(run, name)
})

test('an exit handler that resets the exit code does not turn a dead or failed file green', { timeout: 120_000 }, async () => {
  assert.ok(runner, 'the bounded file runner must exist')
  const reset = "process.on('exit', () => { process.exitCode = 0 });"
  const fixtures = {
    'reset-after-throw.test.mjs': `${NODE_IMPORT}${reset}${FINE}throw new Error('died')`,
    'reset-after-reject.test.mjs': `${NODE_IMPORT}${reset}${FINE}await Promise.reject(new Error('died'))`,
    // One test passes too, so this can only be caught by the failure, not as a file that ran nothing.
    'reset-after-failure.test.mjs': `${NODE_IMPORT}${reset}${FINE}test('the named failure', () => { throw new Error('no') })`,
  }
  const run = await runDying('node', fixtures)
  for (const name of Object.keys(fixtures)) assertFailedByName(run, name)
  assert.match(run.summary, /reset-after-failure\.test\.mjs: the named failure/)
})

test('a file with no tests ran nothing, so it fails by name', { timeout: 120_000 }, async () => {
  assert.ok(runner, 'the bounded file runner must exist')
  const run = await runDying('node', { 'no-tests.test.mjs': 'export {}' })
  assertFailedByName(run, 'no-tests.test.mjs')
})

test('a file of only skipped tests still counts as run', { timeout: 120_000 }, async () => {
  assert.ok(runner, 'the bounded file runner must exist')
  const run = await runDying('node', { 'all-skipped.test.mjs': `${NODE_IMPORT}test('windows only', { skip: 'why' }, () => {})` })
  assert.match(run.output, /PASS all-skipped\.test\.mjs/)
})

test('a bun file that did not complete fails by name too', { timeout: 120_000 }, async () => {
  assert.ok(runner, 'the bounded file runner must exist')
  const fixtures = {
    'bun-thrown.test.ts': `${BUN_IMPORT}${FINE}throw new Error('thrown at top level')`,
    'bun-rejected.test.ts': `${BUN_IMPORT}${FINE}await Promise.reject(new Error('rejected at top level'))`,
    'bun-exit-at-top.test.ts': `${BUN_IMPORT}${FINE}process.exit(0)`,
    'bun-exit-in-test.test.ts': `${BUN_IMPORT}test('quits', () => { process.exit(0) });test('never ran', () => {})`,
    'bun-no-tests.test.ts': 'export {}',
  }
  const run = await runDying('bun', fixtures)
  for (const name of Object.keys(fixtures)) assertFailedByName(run, name)
})

test('a top level await that never settles under bun meets the file deadline, by name', { timeout: 120_000 }, async () => {
  assert.ok(runner, 'the bounded file runner must exist')
  const name = 'bun-never-settles.test.ts'
  const run = await runDying('bun', { [name]: `${BUN_IMPORT}${FINE}await new Promise(() => {})` }, 15_000)
  assertFailedByName(run, name)
})

test('a test file sees the argv of `node file`, so a main() reading argv finds nothing extra', { timeout: 120_000 }, async () => {
  assert.ok(runner, 'the bounded file runner must exist')
  const run = await runDying('node', {
    'argv.test.mjs': `${NODE_IMPORT}import assert from 'node:assert/strict';import { basename } from 'node:path';test('argv', () => { assert.equal(process.argv.length, 2); assert.equal(basename(process.argv[1]), 'argv.test.mjs') })`,
  })
  assert.match(run.output, /PASS argv\.test\.mjs/, run.output)
})

test('a test that hangs under the real flags fails by its own name, and the file is not called a timeout', { timeout: 120_000 }, async () => {
  assert.ok(runner, 'the bounded file runner must exist')
  const dir = mkdtempSync(join(tmpdir(), 'runner-flag-'))
  try {
    writeFileSync(join(dir, 'async-hang.test.cjs'), `require('node:test')('deliberate async hang', () => new Promise(() => {}))`)
    const [group] = runner.testGroups([{ file: 'x', source: '' }])
    const result = await runner.runTestFile('async-hang.test.cjs', {
      command: group.command, cwd: dir, timeoutMs: 60_000, onOutput: () => {},
      args: group.args.map((arg: string) => (arg.startsWith('--test-timeout=') ? '--test-timeout=1500' : arg)),
    })
    assert.equal(result.timedOut, false)
    assert.notEqual(result.code, 0)
    assert.deepEqual(result.failures, ['deliberate async hang'])
  } finally { removeScratchDir(dir) }
})

// ── The orchestrator itself, run for real ───────────────────────────────────
//
// Every test above calls the runner's functions. These run scripts/run-tests.mjs
// on a folder of fixtures, because its exit code and its temp folder rule were
// held by nothing: either could be removed with the suite still green.

const ORCHESTRATOR = fileURLToPath(new URL('../scripts/run-tests.mjs', import.meta.url))

function runOrchestrator(root: string, env: Record<string, string> = {}) {
  return new Promise<{ code: number, stdout: string, stderr: string }>((resolve) => {
    execFile(process.execPath, [ORCHESTRATOR, root], {
      env: { ...process.env, ...env }, encoding: 'utf8', timeout: 100_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true,
    }, (err: any, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr }))
  })
}

function orchestratorFolder(fixtures: Record<string, string>) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'runner-orchestrator-')))
  mkdirSync(join(root, 'test'))
  for (const [name, body] of Object.entries(fixtures)) writeFileSync(join(root, 'test', name), body)
  return root
}

test('run-tests.mjs exits nonzero for a failing file, names it, and hands its files the real temp folder', { timeout: 120_000 }, async () => {
  assert.ok(runner, 'the bounded file runner must exist')
  const root = orchestratorFolder({
    'good.test.ts': `${NODE_IMPORT}import { tmpdir } from 'node:os';import { writeFileSync } from 'node:fs';test('records its temp folder', () => writeFileSync(process.env.PROBE_OUT!, tmpdir()))`,
    'bad.test.ts': `${NODE_IMPORT}test('the named failure', () => { throw new Error('no') })`,
  })
  try {
    const real = join(root, 'real')
    mkdirSync(real)
    const env: Record<string, string> = { PROBE_OUT: join(root, 'probe.txt') }
    // Windows takes its temp folder from TEMP and TMP, and the rule leaves it alone there.
    if (process.platform !== 'win32') {
      symlinkSync(real, join(root, 'link'))
      env.TMPDIR = join(root, 'link')
    }
    const run = await runOrchestrator(root, env)
    assert.equal(run.code, 1, `${run.stdout}\n${run.stderr}`)
    assert.match(run.stdout, /\[run-tests\] 1 passed, 1 failed, 0 skipped, 2 files/)
    assert.match(run.stdout, /bad\.test\.ts: the named failure/)
    if (process.platform !== 'win32') assert.equal(readFileSync(env.PROBE_OUT!, 'utf8'), real)
  } finally { removeScratchDir(root) }
})

test('run-tests.mjs exits zero only when every file completed', { timeout: 120_000 }, async () => {
  assert.ok(runner, 'the bounded file runner must exist')
  const root = orchestratorFolder({
    'one.test.ts': `${NODE_IMPORT}${FINE}`,
    'two.test.ts': `${NODE_IMPORT}${FINE}`,
    'three.test.ts': `${BUN_IMPORT}${FINE}`,
  })
  try {
    const green = await runOrchestrator(root)
    assert.equal(green.code, 0, `${green.stdout}\n${green.stderr}`)
    assert.match(green.stdout, /3 passed, 0 failed, 0 skipped, 3 files/)
    writeFileSync(join(root, 'test', 'died.test.ts'), `${NODE_IMPORT}${FINE}throw new Error('at top level')`)
    const dead = await runOrchestrator(root)
    assert.equal(dead.code, 1, `${dead.stdout}\n${dead.stderr}`)
    assert.match(dead.stdout, /^ {2}test[\\/]died\.test\.ts: /m)
    assert.match(dead.stderr, /\[run-tests\] FAILED/)
    // Exit 0 from the file itself: the run must not take that at its word.
    writeFileSync(join(root, 'test', 'died.test.ts'), `${NODE_IMPORT}${FINE}process.exit(0)`)
    const quit = await runOrchestrator(root)
    assert.equal(quit.code, 1, `${quit.stdout}\n${quit.stderr}`)
    assert.match(quit.stdout, /^ {2}test[\\/]died\.test\.ts: /m)
  } finally { removeScratchDir(root) }
})
