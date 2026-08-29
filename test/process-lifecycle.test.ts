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

import {
  describeShutdownCause,
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

test('server.ts shuts down when stdin ends or closes', () => {
  assert.match(
    serverSource,
    /process\.stdin\.on\(\s*'end'/,
    'server.ts must shut down when stdin ends; without it an orphaned daemon polls forever',
  )
  assert.match(
    serverSource,
    /process\.stdin\.on\(\s*'close'/,
    'server.ts must shut down when stdin closes',
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
