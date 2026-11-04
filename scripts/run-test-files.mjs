/**
 * Bounded file workers for scripts/run-tests.mjs. The watchdog lives outside the
 * process under test, so a blocked event loop or a leaked handle cannot stop it.
 *
 * Why this exists: on Windows one file that never finished (a test fixture that
 * deadlocked, thread-lanes.test.ts) held the whole job silent until the 30 minute
 * cancel, and the cancel also lost the failure details of every file in its batch.
 * Here a stuck file fails by name, and every other file still reports.
 */
import { spawn, execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const MAX_TEST_WORKERS = 4
/** Applies to a test that yields. The slowest test on a green Windows job took 41 s. */
export const TEST_TIMEOUT_MS = 120_000
/**
 * The time a file may go without completing a test: for what TEST_TIMEOUT_MS
 * cannot stop (a blocked event loop, a handle left open after the last test).
 * Longer than any explicit test timeout in the suite (test/run-tests-timeout.test.ts
 * holds that), so such a test still fails by its own name. With the cleanup bound
 * this stays under 5 minutes.
 */
export const FILE_IDLE_TIMEOUT_MS = 270_000
const CLEANUP_BOUND_MS = 10_000
/** How long the pipes of an exited worker may stay open before an orphan is assumed to hold them. */
const PIPE_DRAIN_MS = 3_000
/** Printed by scripts/test-file-entry.mjs after a node:test file's last top level statement. */
export const FILE_BODY_FINISHED = '[run-tests] file body finished'

/**
 * Without --test, Node honours a focused test and neither runs nor counts the rest
 * of the file, and bun does the same: the file passes with a smaller total. Neither
 * runner says so, so this reads the source of the test file itself. A computed key,
 * an option that is not a literal true, or a focus inside a helper gets past it.
 * `...only(x)` is a spread of a local helper, not a focus.
 */
const FOCUS = [
  /(?<!\.\.)\.only\b/,
  /\bonly['"]?\s*:\s*true\b/,
  /\{[^{}]*\bonly\b[^{}]*\}\s*(?:from\s*|=\s*require\(\s*)['"](?:node|bun):test['"]/,
]

export function focusesATest(source) {
  return FOCUS.some((pattern) => pattern.test(source))
}

export function partitionTests(entries) {
  const parallelFiles = [], chromiumFiles = [], runnerFiles = [], daemonFiles = [], bunFiles = []
  for (const { file, source } of entries) {
    // No node loader serves the `bun:` scheme, so these need bun's own runner.
    if (/from\s+['"]bun:test['"]/.test(source)) bunFiles.push(file)
    // Real Chromium files fight over the machine when run side by side (two of
    // remote-browser-controls.chromium's tests fail) and pass one at a time.
    else if (file.endsWith('.chromium.test.ts')) chromiumFiles.push(file)
    // This regression suite starts its own workers, so give it the machine.
    else if (file.replace(/\\/g, '/').endsWith('/run-tests-timeout.test.ts')) runnerFiles.push(file)
    // Files that boot real daemons, one at a time after the pool: four of them
    // inside it pushed the fixed 15 s limits in browser-profile-node-runtime past their time.
    else if (file.endsWith('.daemon.test.ts')) daemonFiles.push(file)
    else parallelFiles.push(file)
  }
  return { parallelFiles, chromiumFiles, runnerFiles, daemonFiles, bunFiles }
}

export function testGroups(entries) {
  const { parallelFiles, chromiumFiles, runnerFiles, daemonFiles, bunFiles } = partitionTests(entries)
  // Absolute loader and preload: --import is inherited by a child that reuses
  // execArgv, and a bare name would resolve against that child's own folder.
  // No --test: this process is already the one for this file. Under --test with
  // process isolation --test-timeout bounds the whole file, not each test, and
  // with isolation none a load error after the first test() is dropped.
  const nodeArgs = [
    '--import', import.meta.resolve('tsx'),
    '--import', import.meta.resolve('./test-progress.mjs'),
    '--test-reporter=tap', `--test-timeout=${TEST_TIMEOUT_MS}`,
    fileURLToPath(import.meta.resolve('./test-file-entry.mjs')),
  ]
  return [
    { label: 'node:test family', files: parallelFiles, command: process.execPath, args: nodeArgs, concurrency: 4, family: 'node' },
    { label: 'runner regression tests', files: runnerFiles, command: process.execPath, args: nodeArgs, concurrency: 1, family: 'node' },
    { label: 'real Chromium files, one at a time', files: chromiumFiles, command: process.execPath, args: nodeArgs, concurrency: 1, family: 'node' },
    { label: 'real daemon files, one at a time', files: daemonFiles, command: process.execPath, args: nodeArgs, concurrency: 1, family: 'node' },
    { label: 'bun:test family', files: bunFiles, command: 'bun', args: ['test', '--max-concurrency=1', `--timeout=${TEST_TIMEOUT_MS}`], concurrency: 4, family: 'bun' },
  ]
}

async function killTree(child) {
  if (!child.pid) return
  if (process.platform === 'win32') {
    // SIGTERM/child.kill() only ends one Windows process. No cmd.exe or shell
    // quoting: taskkill receives separate arguments and ends descendants too.
    await new Promise((resolve) => execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'],
      { windowsHide: true, timeout: 5000 }, () => resolve()))
    return
  }
  // A lane may detach into its own process group. Snapshot descendants before
  // ending their parent; killing only -child.pid misses those detached tools.
  const rows = await new Promise((resolve) => execFile('ps', ['-A', '-o', 'pid=,ppid='],
    { encoding: 'utf8', timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? [] : stdout.trim().split('\n').map((line) => line.trim().split(/\s+/).map(Number)))
    }))
  const owned = [child.pid]
  for (let i = 0; i < owned.length; i++) {
    for (const [pid, parent] of rows) {
      if (parent === owned[i] && pid > 1 && !owned.includes(pid)) owned.push(pid)
    }
  }
  for (const pid of owned.slice(1).reverse()) {
    try { process.kill(pid, 'SIGKILL') } catch {}
  }
  try { process.kill(-child.pid, 'SIGKILL') } catch { try { child.kill('SIGKILL') } catch {} }
}

const active = new Set()

/** Workers are detached from the runner's process group, so ctrl-c must reach them from here. */
export async function stopActiveTests() {
  await Promise.all([...active].map((child) => killTree(child)))
}

const NODE_TALLY = /^# (pass|fail|cancelled|skipped) (\d+)\s*$/
const BUN_TALLY = /^\s*(\d+) (pass|fail|skip)\s*$/
const NODE_FAILURE = /^\s*not ok \d+ - (.*?)\s*$/
/** A failing todo test is expected to fail. A `#` in a test's own name reaches TAP escaped, as `\#`. */
const NODE_TODO = /\s# TODO\b/
const BUN_FAILURE = /^\(fail\) (.*?)(?: \[[\d.]+ms\])?\s*$/

/** Read one output line into the file's totals and its failing test names. */
function noteLine(line, seen) {
  if (line === FILE_BODY_FINISHED) {
    seen.bodyFinished = true
    return
  }
  const node = NODE_TALLY.exec(line)
  if (node) {
    const name = node[1] === 'cancelled' ? 'fail' : node[1]
    seen.tally ??= { pass: 0, fail: 0, skipped: 0 }
    seen.tally[name] += Number(node[2])
    return
  }
  const bun = BUN_TALLY.exec(line)
  if (bun) {
    const name = bun[2] === 'skip' ? 'skipped' : bun[2]
    seen.tally ??= { pass: 0, fail: 0, skipped: 0 }
    seen.tally[name] += Number(bun[1])
    return
  }
  const notOk = NODE_FAILURE.exec(line)
  if (notOk) {
    if (NODE_TODO.test(notOk[1])) return
    seen.notOk = true
    seen.failures.push(notOk[1])
    return
  }
  const bunFailure = BUN_FAILURE.exec(line)
  if (bunFailure) seen.failures.push(bunFailure[1])
}

/**
 * Why a file's run does not count as a pass, or null when it does. For a test
 * family (`family`), exit 0 is not enough: the file must have reached its end,
 * reported totals, failed nothing and run something. Without a family the command
 * is any process, and only its exit code can speak.
 */
function findProblem({ code, timedOut, tally, bodyFinished, notOk }, family) {
  if (timedOut) return 'TIMED OUT'
  const incomplete = family === 'node' && !bodyFinished
  if (code !== 0) return incomplete ? `did not complete: its top level stopped, exited ${code}` : `exited ${code}`
  if (!family) return null
  if (incomplete) return 'did not complete: its top level stopped, though it exited 0'
  if (!tally) return 'did not complete: exited 0 with no totals, so it stopped early'
  if (tally.fail > 0) return 'a test failed, though it exited 0'
  // A root hook that fails is `not ok` in the output, and in neither the totals nor the exit code.
  if (family === 'node' && notOk) return 'it printed not ok, as a failing root hook does, though its totals count no failure and it exited 0'
  if (tally.pass + tally.skipped === 0) return 'ran no tests'
  return null
}

/**
 * Fail a silent file within the deadline, including blocked JS and leaked
 * handles after the last test. Completed TAP tests reset the deadline, so a
 * long file of individually bounded tests remains valid. Arbitrary child
 * chatter does not reset it. The final cleanup wait is also bounded.
 */
export function runTestFile(file, {
  command, args, cwd, timeoutMs = FILE_IDLE_TIMEOUT_MS, family = null,
  onOutput = (chunk) => { process.stdout.write(chunk) },
}) {
  return new Promise((resolve) => {
    let settled = false, timedOut = false, exitCode = null, timer, cleanupTimer, drainTimer
    const buffers = { stdout: '', stderr: '' }
    const seen = { tally: null, failures: [], bodyFinished: false, notOk: false }
    const emit = (text) => onOutput(text, file)
    // A runner started from inside `node --test` must not make its workers talk
    // that parent's private protocol instead of TAP.
    const { NODE_TEST_CONTEXT: _parentProtocol, ...env } = process.env
    let child
    try {
      child = spawn(command, [...args, file], {
        cwd, env, stdio: ['ignore', 'pipe', 'pipe'], shell: false,
        windowsHide: true, detached: process.platform !== 'win32',
      })
    } catch (err) {
      // Windows refuses a .cmd without a shell by throwing here, not by an 'error' event.
      emit(`[run-tests] FAILED ${file}: ${err.code ?? err.message}\n`)
      resolve({ file, code: 1, timedOut: false, tally: null, failures: seen.failures, problem: `could not start: ${err.code ?? err.message}` })
      return
    }
    active.add(child)
    const finish = (code) => {
      if (settled) return
      settled = true
      active.delete(child)
      clearTimeout(timer)
      clearTimeout(cleanupTimer)
      clearTimeout(drainTimer)
      for (const stream of ['stdout', 'stderr']) if (buffers[stream]) noteLine(buffers[stream], seen)
      const result = { file, code: timedOut ? 1 : (code ?? 1), timedOut, tally: seen.tally, failures: seen.failures }
      resolve({ ...result, problem: findProblem({ ...result, bodyFinished: seen.bodyFinished, notOk: seen.notOk }, family) })
    }
    const letGoOfPipes = () => {
      child.stdout.destroy()
      child.stderr.destroy()
      child.unref()
    }
    const arm = () => {
      clearTimeout(timer)
      timer = setTimeout(async () => {
        timedOut = true
        emit(`[run-tests] TIMEOUT ${file}: no test completed for ${timeoutMs}ms\n`)
        // Bound even OS process inspection/termination, or inherited pipes
        // whose owner has already exited. A failed kill must not hang us too.
        cleanupTimer = setTimeout(() => {
          try { child.kill('SIGKILL') } catch {}
          letGoOfPipes()
          finish(1)
        }, CLEANUP_BOUND_MS)
        await killTree(child)
      }, timeoutMs)
    }
    for (const stream of ['stdout', 'stderr']) {
      child[stream].setEncoding('utf8')
      child[stream].on('data', (chunk) => {
        emit(chunk)
        const lines = (buffers[stream] + chunk).split('\n')
        buffers[stream] = lines.pop().slice(-4096)
        for (const line of lines) noteLine(line.replace(/\r$/, ''), seen)
        if (!timedOut && lines.some((line) => /^\s*(?:not )?ok \d+\b/.test(line))) arm()
      })
    }
    child.on('error', (err) => {
      emit(`[run-tests] FAILED ${file}: ${err.code ?? err.message}\n`)
      finish(1)
    })
    // The worker has said all it will. If something it started holds the pipes
    // open, 'close' may never come: name the leak rather than wait for the deadline.
    child.on('exit', (code) => {
      exitCode = code
      drainTimer = setTimeout(() => {
        emit(`[run-tests] LEAK ${file}: exited ${code}, a process it started still holds its output\n`)
        // Its group outlives its leader off Windows. On Windows an orphan cannot be found from here.
        if (process.platform !== 'win32') { try { process.kill(-child.pid, 'SIGKILL') } catch {} }
        letGoOfPipes()
        finish(code)
      }, PIPE_DRAIN_MS)
    })
    child.on('close', (code) => finish(code ?? exitCode))
    arm()
  })
}

/**
 * Run files on at most MAX_TEST_WORKERS workers. `onOutput(text, file)` sees
 * output live. Without it each file's output goes to `write` as one block once
 * the file is done, because four files writing at once cannot be read.
 */
export async function runTestFiles(files, options) {
  const count = Math.min(MAX_TEST_WORKERS, Math.max(1, Math.floor(options.concurrency ?? MAX_TEST_WORKERS)))
  const write = options.write ?? ((text) => { process.stdout.write(text) })
  const results = new Array(files.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(count, files.length) }, async () => {
    for (;;) {
      const index = next++
      if (index >= files.length) return
      const file = files[index]
      // At once, not with the block: a job cancelled from outside still shows what was running.
      const start = `[run-tests] START ${file}\n`
      if (options.onOutput) options.onOutput(start, file)
      else write(start)
      let block = ''
      const onOutput = options.onOutput ?? ((text) => { block += text })
      const started = performance.now()
      const result = await runTestFile(file, { ...options, onOutput })
      results[index] = result
      const seconds = ((performance.now() - started) / 1000).toFixed(3)
      const line = `[run-tests] ${result.problem ? 'FAIL' : 'PASS'} ${file} (${seconds}s)\n`
      if (options.onOutput) options.onOutput(line, file)
      else write(`${block}${block === '' || block.endsWith('\n') ? '' : '\n'}${line}`)
    }
  }))
  return results
}

/** The end of a run: what happened, and what failed by name, after thousands of lines of output. */
export function summarize(results, seconds) {
  const total = { pass: 0, fail: 0, skipped: 0 }
  const rows = []
  for (const result of results) {
    for (const key of Object.keys(total)) total[key] += result.tally?.[key] ?? 0
    if (!result.problem) continue
    for (const name of result.failures) rows.push(`  ${result.file}: ${name}`)
    // A named failure already explains a plain nonzero exit. Anything else is news.
    if (result.failures.length === 0 || result.problem !== `exited ${result.code}`) rows.push(`  ${result.file}: ${result.problem}`)
  }
  const line = `[run-tests] ${total.pass} passed, ${total.fail} failed, ${total.skipped} skipped, ${results.length} files, ${seconds} s`
  return [line, ...rows].join('\n')
}
