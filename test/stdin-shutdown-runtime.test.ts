/**
 * Runtime proof that closing stdin actually ends a process that would otherwise never exit.
 *
 * WHY THIS EXISTS SEPARATELY FROM process-lifecycle.test.ts. That file proves the decision logic and
 * asserts the wiring is present in server.ts. Neither of those proves the mechanism WORKS: whether
 * 'end' and 'close' really fire when a parent closes the pipe is a platform question, and this repo's
 * CI runs Ubuntu while its authors run Windows. A source contract that greps for a handler is worth
 * very little if the handler never fires.
 *
 * So this spawns a real child process, holds its stdin, and closes it.
 *
 * The CONTROL case is the important half. It runs the same child WITHOUT the handlers and asserts it
 * does NOT exit. Without that, a test that passes because the child died for some unrelated reason
 * would look like proof.
 *
 * Both children install a NON-unref'd interval, because that is our real situation: server.ts has
 * four timers that are not unref'd, the poll loop among them, so the daemon never exits on its own.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'

/** A child that would run forever: a non-unref'd interval, exactly like the poll loop. */
const NEVER_EXITS = `
  setInterval(() => {}, 1000)          // not unref'd, holds the event loop open
  process.stdout.write('ready\\n')
`

/** The same child, plus the shutdown wiring under test. */
const EXITS_ON_STDIN_CLOSE = `
  setInterval(() => {}, 1000)          // not unref'd, holds the event loop open
  let down = false
  const shutdown = () => { if (down) return; down = true; process.exit(0) }
  process.stdin.on('end', shutdown)
  process.stdin.on('close', shutdown)
  process.stdin.resume()               // the MCP transport puts stdin in flowing mode; mirror that
  process.stdout.write('ready\\n')
`

function spawnChild(source: string): ChildProcess {
  return spawn(process.execPath, ['-e', source], { stdio: ['pipe', 'pipe', 'pipe'] })
}

/** Resolves with the exit code, or null if the child was still alive at the deadline. */
function exitWithin(child: ChildProcess, ms: number): Promise<number | null> {
  return new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve(null)
    }, ms)
    child.on('exit', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(code ?? 0)
    })
  })
}

/** Waits for the child to say it has installed its handlers, so we never close stdin too early. */
function waitForReady(child: ChildProcess, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false
    const timer = setTimeout(() => {
      if (!done) {
        done = true
        resolve(false)
      }
    }, ms)
    child.stdout?.on('data', (buf: Buffer) => {
      if (done) return
      if (buf.toString().includes('ready')) {
        done = true
        clearTimeout(timer)
        resolve(true)
      }
    })
  })
}

test('closing stdin ends a process that would otherwise run forever', async () => {
  const child = spawnChild(EXITS_ON_STDIN_CLOSE)
  try {
    assert.equal(await waitForReady(child, 10_000), true, 'child never reported ready')
    child.stdin?.end()
    const code = await exitWithin(child, 10_000)
    assert.equal(code, 0, 'child must exit cleanly when its stdin closes')
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL')
  }
})

test('CONTROL: without the handlers the same process survives its stdin closing', async () => {
  // If this ever starts exiting on its own, the test above proves nothing and both need rewriting.
  const child = spawnChild(NEVER_EXITS)
  try {
    assert.equal(await waitForReady(child, 10_000), true, 'child never reported ready')
    child.stdin?.end()
    const code = await exitWithin(child, 3_000)
    assert.equal(code, null, 'without the handlers the child must still be alive; otherwise the positive test is not evidence')
  } finally {
    child.kill('SIGKILL')
  }
})

/**
 * The startup window, which the two tests above structurally cannot reach.
 *
 * Both of them wait for the child to say `ready` before closing its stdin, deliberately, so the
 * handlers always exist first. The real daemon does the opposite: server.ts connects the MCP
 * transport and then AWAITS three network phases (the slash-command registry, chat discovery, the
 * boot sweep) before it registers the shutdown listeners. A parent that dies inside those seconds
 * delivers end and close to a process with nobody listening, and the events never come again.
 *
 * These children model that ordering: print ready, sleep, and only then register. The child WITHOUT
 * the latch must survive, which is the orphan; the child WITH it must exit.
 */

/** Registers late, and has no latch. This is what shipped before the fix. */
const LATE_HANDLERS_NO_LATCH = `
  setInterval(() => {}, 1000)
  process.stdin.resume()
  process.stdout.write('ready\\n')
  setTimeout(() => {
    let down = false
    const shutdown = () => { if (down) return; down = true; process.exit(0) }
    process.stdin.on('end', shutdown)
    process.stdin.on('close', shutdown)
  }, 700)
`

/** Registers just as late, but latches the EOF first and checks the flags after. */
const LATE_HANDLERS_WITH_LATCH = `
  setInterval(() => {}, 1000)
  let sawEof = false
  const note = () => { sawEof = true }
  process.stdin.once('end', note)
  process.stdin.once('close', note)
  process.stdin.resume()
  process.stdout.write('ready\\n')
  setTimeout(() => {
    let down = false
    const shutdown = () => { if (down) return; down = true; process.exit(0) }
    process.stdin.on('end', shutdown)
    process.stdin.on('close', shutdown)
    const ended = process.stdin.destroyed || process.stdin.closed || process.stdin.readableEnded
    if (sawEof || ended) shutdown()
  }, 700)
`

test('an end-of-input during startup still ends the daemon once the handlers arrive', async () => {
  const child = spawnChild(LATE_HANDLERS_WITH_LATCH)
  try {
    assert.equal(await waitForReady(child, 10_000), true, 'child never reported ready')
    child.stdin?.end() // the parent dies while the daemon is still in its awaited startup phases
    const code = await exitWithin(child, 10_000)
    assert.equal(code, 0, 'a startup EOF must not be lost; the daemon has to notice it afterwards')
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL')
  }
})

test('CONTROL: without the latch the same startup EOF is lost and the daemon is orphaned', async () => {
  // This is the defect, reproduced. If this ever starts exiting, the test above proves nothing.
  const child = spawnChild(LATE_HANDLERS_NO_LATCH)
  try {
    assert.equal(await waitForReady(child, 10_000), true, 'child never reported ready')
    child.stdin?.end()
    const code = await exitWithin(child, 3_000)
    assert.equal(code, null, 'the un-latched child polls forever, which is the orphan being fixed')
  } finally {
    child.kill('SIGKILL')
  }
})

/**
 * The broken-pipe loop, reproduced and then shown fixed.
 *
 * This is the defect that a real run found and no unit test could: a fault handler that reports
 * through a logger which can raise the same fault. The control below runs the ORIGINAL shape and
 * counts the flood; the fixed shape must be bounded and must exit.
 *
 * Deliberately a synthetic child rather than server.ts. Running the real daemon from a working tree
 * once picked up live credentials and reached production, which is a mistake worth engineering out of
 * the test suite rather than remembering not to repeat.
 */

/** The original shape: the handler logs, the log throws, the throw re-enters the handler. */
const LOOPS_ON_BROKEN_PIPE = `
  const log = (m) => { process.stderr.write('[x] ' + m + '\\n') }   // unguarded, as it was
  process.on('uncaughtException', (err) => { log('uncaughtException: ' + err.message) })
  setInterval(() => { log('tick') }, 5)
  process.stdout.write('ready\\n')
`

/** The fixed shape: logging cannot throw, the handler cannot re-enter, a broken pipe exits. */
const EXITS_ON_BROKEN_PIPE = `
  const isBrokenPipe = (e) => !!e && typeof e === 'object' &&
    (e.code === 'EPIPE' || e.code === 'ERR_STREAM_DESTROYED' ||
     (typeof e.message === 'string' && /\\bEPIPE\\b/.test(e.message)))
  const log = (m) => { try { process.stderr.write('[x] ' + m + '\\n') } catch {} }
  let handling = false
  const onFault = (err) => {
    if (handling) return
    handling = true
    try { if (isBrokenPipe(err)) { process.exit(0) } log('uncaughtException: ' + err.message) }
    catch {} finally { handling = false }
  }
  process.on('uncaughtException', onFault)
  setInterval(() => { log('tick') }, 5)
  process.stdout.write('ready\\n')
`

test('a broken output pipe exits the process instead of looping', async () => {
  const child = spawnChild(EXITS_ON_BROKEN_PIPE)
  try {
    assert.equal(await waitForReady(child, 10_000), true)
    child.stderr?.destroy() // the reader goes away, exactly as a closing terminal does
    const code = await exitWithin(child, 10_000)
    assert.equal(code, 0, 'a broken pipe must end the process, not spin it')
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL')
  }
})

test('CONTROL: the original shape does NOT exit, which is what made it a flood', async () => {
  // If this ever starts exiting on its own, the test above proves nothing.
  const child = spawnChild(LOOPS_ON_BROKEN_PIPE)
  try {
    assert.equal(await waitForReady(child, 10_000), true)
    child.stderr?.destroy()
    const code = await exitWithin(child, 3_000)
    assert.equal(code, null, 'the unguarded shape keeps running; that is the bug being fixed')
  } finally {
    child.kill('SIGKILL')
  }
})
