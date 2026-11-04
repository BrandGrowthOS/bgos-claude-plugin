// The watchdog lives outside the test process, including when that process
// leaves a detached child behind or blocks its own event loop.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
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
      command: group.command, args: group.args, cwd: dir, concurrency: 2, timeoutMs: 30_000,
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
