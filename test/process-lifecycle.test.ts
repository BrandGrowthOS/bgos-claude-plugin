/**
 * The daemon must die with the session that launched it.
 *
 * The incident shape this guards: the connector is an MCP child of a Claude Code session. When that
 * session is hard-killed, nothing today tells the daemon. server.ts has no reference to
 * process.stdin at all, and four of its timers are not unref'd (the poll loop itself among them), so
 * the process stays alive, keeps polling the backend, and can advance chat cursors past messages the
 * live daemon never delivered.
 *
 * The second thing pinned here is a NEGATIVE. Anthropic's own Telegram plugin shipped a
 * parent-process-id watchdog for this exact problem and then DELETED it, because it misfired on
 * ordinary reparenting and killed the plugin five seconds after every launch. We watch stdin and
 * only stdin. The source contract at the bottom of this file is what stops that lesson being
 * relearned the expensive way.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { EventEmitter } from 'node:events'
import {
  describeShutdownCause,
  installStdinShutdown,
  stdinHasEnded,
  watchStdinEof,
  isBrokenPipe,
  shouldShutdownOnStdin,
  type ShutdownCause,
} from '../lib/process-lifecycle.ts'

const serverSource = readFileSync(new URL('../server.ts', import.meta.url), 'utf8')

test('stdin end means the parent session is gone', () => {
  assert.equal(shouldShutdownOnStdin('end'), true)
})

test('stdin close means the parent session is gone', () => {
  assert.equal(shouldShutdownOnStdin('close'), true)
})

test('a data event is not a shutdown', () => {
  // The MCP transport puts stdin in flowing mode and consumes every data chunk. If a data event
  // were ever read as a shutdown the daemon would exit on its first inbound message.
  assert.equal(shouldShutdownOnStdin('data'), false)
})

test('an error event is not a shutdown on its own', () => {
  // The transport installs its own error handler. A transient stdin error is not proof the parent
  // died, and exiting on it would turn a blip into an outage.
  assert.equal(shouldShutdownOnStdin('error'), false)
})

test('every shutdown names its cause, so a silent exit is never a mystery', () => {
  const causes: ShutdownCause[] = ['stdin-end', 'stdin-close', 'SIGINT', 'SIGTERM']
  for (const cause of causes) {
    const line = describeShutdownCause(cause)
    assert.ok(line.length > 0, `${cause} must produce a log line`)
    assert.match(line, /shutting down/i, `${cause} must say it is shutting down`)
  }
  assert.match(describeShutdownCause('stdin-end'), /session/i)
  assert.match(describeShutdownCause('SIGTERM'), /SIGTERM/)
})

test('an unknown cause still produces a usable line rather than throwing', () => {
  const line = describeShutdownCause('something-new' as ShutdownCause)
  assert.match(line, /something-new/)
})

// --- source contract -------------------------------------------------------
// These assert on server.ts itself. They are cheap, and they are the only thing that catches a
// well-meaning refactor removing the handlers or reintroducing the watchdog Anthropic removed.

/**
 * A stand-in for process.stdin: an EventEmitter plus the three readable flags. Small enough to be
 * obviously honest, which is the reason the wiring moved out of server.ts in the first place. The
 * two tests it replaced grepped server.ts for the listener text, so they passed against an
 * implementation whose callback did nothing.
 */
function fakeStdin(flags: { destroyed?: boolean; closed?: boolean; readableEnded?: boolean } = {}) {
  const em = new EventEmitter()
  return Object.assign(em, flags) as EventEmitter & typeof flags
}

test('an end or a close on stdin reaches the shutdown callback, with the cause named', () => {
  const seen: string[] = []
  const stdin = fakeStdin()
  installStdinShutdown(stdin, (cause) => seen.push(cause))

  stdin.emit('end')
  assert.deepEqual(seen, ['stdin-end'])
  stdin.emit('close')
  assert.deepEqual(seen, ['stdin-end', 'stdin-close'])
})

test('a data or an error event does NOT shut the daemon down', () => {
  // The two events most likely to be added by someone tidying up. 'data' is every inbound message,
  // so shutting down on it exits on the first thing a user says; 'error' is a blip, and the MCP
  // transport installs its own handler for it. This is a behavioural version of a contract that
  // used to be a regex over server.ts.
  const seen: string[] = []
  const stdin = fakeStdin()
  installStdinShutdown(stdin, (cause) => seen.push(cause))

  // The transport owns the error listener in production, so model that: without one an
  // EventEmitter rethrows, which would be testing node rather than testing us.
  stdin.on('error', () => {})
  stdin.emit('data', Buffer.from('{"jsonrpc":"2.0"}'))
  stdin.emit('error', new Error('transient'))
  assert.deepEqual(seen, [], 'neither event is proof the parent is gone')
})

test('installStdinShutdown asks the predicate, so inverting it registers nothing', () => {
  // Before this, shouldShutdownOnStdin was tested four ways and consumed by nothing: server.ts
  // hard-coded 'end' and 'close' at the call site. Asserting the listener count is what makes the
  // predicate load-bearing, because a predicate that no production path consults cannot fail.
  const stdin = fakeStdin()
  installStdinShutdown(stdin, () => {})
  assert.equal(stdin.listenerCount('end'), 1)
  assert.equal(stdin.listenerCount('close'), 1)
  assert.equal(stdin.listenerCount('data'), 0, 'a data listener would run on every inbound message')
  assert.equal(stdin.listenerCount('error'), 0, 'an error listener would compete with the transport')
})

test('an end-of-input during startup is latched, so it is not lost before the handlers exist', () => {
  // The real window: server.ts connects the transport and then awaits three network phases before
  // registering the shutdown listeners. An EOF in those seconds fires into a process with nobody
  // listening, and the event does not come back.
  const stdin = fakeStdin()
  const sawEof = watchStdinEof(stdin)
  assert.equal(sawEof(), false)
  stdin.emit('end')
  assert.equal(sawEof(), true, 'an EOF before the handlers exist must still be visible after them')
})

test('the latch is once-only and cannot interfere with the real handlers', () => {
  const stdin = fakeStdin()
  watchStdinEof(stdin)
  stdin.emit('end')
  stdin.emit('close')
  assert.equal(stdin.listenerCount('end'), 0, 'once listeners must remove themselves')
  assert.equal(stdin.listenerCount('close'), 0)
})

test('stdinHasEnded ORs the three flags, because node and bun disagree about them', () => {
  // node sets destroyed, closed and readableEnded together. bun reports readableEnded false with
  // destroyed and closed true. Requiring agreement would return false on bun, which is the runtime
  // the daemon actually ships on, so the OR is the whole point.
  assert.equal(stdinHasEnded(fakeStdin()), false)
  assert.equal(stdinHasEnded(fakeStdin({ destroyed: true, closed: true, readableEnded: false })), true, 'the bun shape')
  assert.equal(stdinHasEnded(fakeStdin({ destroyed: true, closed: true, readableEnded: true })), true, 'the node shape')
  assert.equal(stdinHasEnded(fakeStdin({ readableEnded: true })), true)
})

test('server.ts installs the shutdown through the module and acts on a startup EOF', () => {
  // A source contract still earns its place, but pointed at the CALL SITE rather than at listener
  // text: deleting the wiring is caught by the behavioural tests above only if server.ts actually
  // calls it, and that is a fact about server.ts alone.
  assert.match(
    serverSource,
    /installStdinShutdown\(\s*process\.stdin/,
    'server.ts must wire stdin shutdown through the tested helper, not by hand',
  )
  assert.match(
    serverSource,
    /watchStdinEof\(\s*process\.stdin\s*\)/,
    'the startup EOF latch must be armed',
  )
  const latchAt = serverSource.indexOf('watchStdinEof(process.stdin)')
  const transportAt = serverSource.indexOf('new StdioServerTransport()')
  assert.ok(
    latchAt !== -1 && latchAt < transportAt,
    'the latch must be armed BEFORE the transport and the awaited startup phases, or it misses them',
  )
})

test('server.ts logs unhandled rejections and uncaught exceptions instead of dying mutely', () => {
  assert.match(serverSource, /process\.on\(\s*'unhandledRejection'/)
  assert.match(serverSource, /process\.on\(\s*'uncaughtException'/)
})

test('server.ts never watches a parent process id', () => {
  // Anthropic shipped this and removed it: it misfired on normal reparenting and self-killed the
  // plugin five seconds after every launch. If a future change wants it back, it needs a new
  // argument, not a quiet reintroduction.
  assert.doesNotMatch(
    serverSource,
    /process\.ppid/,
    'a ppid watchdog misfires on reparenting; watch stdin instead',
  )
})

// --- broken pipe must not become a loop -------------------------------------
// Found by actually running the daemon rather than by a unit test. When the terminal that launched
// it went away, log() threw EPIPE on its unguarded stderr write, which surfaced as an
// uncaughtException, whose handler called log() again, which threw again. An unbounded flood of
// identical exception lines into the agent's log file, forever. Two guards below: recognise a broken
// pipe for what it is (the reader is gone, so shut down) and never let a handler recurse through its
// own logging.

test('a broken pipe is recognised, whatever shape the error arrives in', () => {
  assert.equal(isBrokenPipe(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })), true)
  assert.equal(isBrokenPipe(Object.assign(new Error('x'), { code: 'ERR_STREAM_DESTROYED' })), true)
  assert.equal(isBrokenPipe(Object.assign(new Error('x'), { code: 'ERR_STREAM_WRITE_AFTER_END' })), true)
  // Bun surfaces it as a message without a code on some paths, which is how the real loop escaped.
  assert.equal(isBrokenPipe(new Error('EPIPE: broken pipe, write')), true)
})

test('an ordinary error is NOT treated as a broken pipe', () => {
  // Shutting down on any error would turn a recoverable fault into an outage.
  assert.equal(isBrokenPipe(new Error('ECONNRESET')), false)
  assert.equal(isBrokenPipe(new TypeError('undefined is not a function')), false)
  assert.equal(isBrokenPipe(null), false)
  assert.equal(isBrokenPipe(undefined), false)
  assert.equal(isBrokenPipe('EPIPE'), false)
})

test('server.ts writes to stderr defensively, so logging can never throw into a handler', () => {
  // The precise defect: the file append was wrapped and the stderr write was not.
  const logFn = serverSource.slice(serverSource.indexOf('function log(msg: string)'))
  const body = logFn.slice(0, logFn.indexOf('\n}\n') + 3)
  assert.match(body, /try\s*\{[\s\S]*process\.stderr\.write/, 'the stderr write must be inside a try')
})

test('server.ts guards its exception handlers against re-entering themselves', () => {
  assert.match(
    serverSource,
    /handlingFault/,
    'the fault handlers need a re-entry guard; without one a throw inside a handler loops forever',
  )
})

test('an uncaught exception still ends the process, it is only logged on the way out', () => {
  // Registering ANY uncaughtException handler suppresses Node's default termination. That is a real
  // behaviour change hiding inside what looks like a logging improvement: a daemon that continues
  // past an unknown fault holds chat cursors it may now write wrongly. The handler exists to get the
  // reason into the log first, and then to die anyway.
  const at = serverSource.indexOf("process.on('uncaughtException'")
  assert.notEqual(at, -1, 'the handler must exist')
  const handler = serverSource.slice(at, at + 900)
  assert.match(
    handler,
    /process\.exit\(1\)/,
    'the uncaughtException handler must exit; otherwise adding it turned a crash into a zombie',
  )
})

test('the rejection handler does NOT exit, because floating promises are deliberate here', () => {
  // The asymmetry is the point, so it is pinned. server.ts fires void syncSlashCommands() and
  // friends on purpose; killing the daemon because one settled badly would be worse than the
  // silence the handler replaced.
  const at = serverSource.indexOf("process.on('unhandledRejection'")
  assert.notEqual(at, -1)
  const handler = serverSource.slice(at, serverSource.indexOf("process.on('uncaughtException'"))
  assert.equal(/process\.exit\(/.test(handler), false, 'a rejection must be survivable')
})

test('boot enrolment into marketplace auto-update respects the same brakes as every other update path', () => {
  // The one path that could ignore the stop switch. BGOS_AUTO_UPDATE=0 and a latched rollback both
  // mean "this machine does not take updates right now"; enrolling it into unattended updates at
  // boot would quietly undo a user's or a bad release's decision.
  const at = serverSource.indexOf('ensureMarketplaceAutoUpdate({')
  assert.notEqual(at, -1, 'the enrolment call must exist')
  const before = serverSource.slice(Math.max(0, at - 1200), at)
  assert.match(before, /isAutoUpdateEnabled\(process\.env\.BGOS_AUTO_UPDATE\)/, 'must honour the kill switch')
  assert.match(before, /readRollbackLatch\(/, 'must honour a latched rollback')
  assert.match(before, /updatesAllowed/, 'and the guard must actually gate the call')
})
