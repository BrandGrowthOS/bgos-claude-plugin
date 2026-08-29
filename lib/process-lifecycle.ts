/**
 * When the launching Claude Code session goes away, this daemon must go with it.
 *
 * THE PROBLEM. This connector runs as an MCP child of a Claude Code session. Until now nothing in
 * server.ts referenced process.stdin, and four of its timers are not unref'd, including the poll loop
 * itself (`setTimeout(tick, POLL_INTERVAL_MS)`). So a session that is hard-killed leaves a daemon
 * that keeps running, keeps polling the backend, and keeps a claim on the agent. Worse than the
 * wasted requests: an orphan can flush chat cursors past messages that the LIVE daemon never
 * delivered, which loses those messages silently.
 *
 * WHY STDIN AND NOTHING ELSE. The parent holds our stdin. When it dies the pipe closes and we get
 * `end` and then `close`. That is a kernel-level fact about the process tree, not an inference.
 *
 * WHY NOT A PARENT-PID WATCHDOG. Anthropic's own Telegram channel plugin shipped exactly that for
 * this exact problem, and then removed it: it misfired on ordinary reparenting and self-killed the
 * plugin five seconds after every launch. Polling `process.ppid` looks equivalent and is not. A
 * source contract in test/process-lifecycle.test.ts fails if `process.ppid` reappears in server.ts.
 *
 * WHY THIS FILE IS PURE. Deciding "is this event a shutdown" and "what do we tell the log" needs no
 * process, no timers and no I/O, so both are unit tested directly. server.ts keeps only the wiring.
 */

/** The causes that can end this daemon, all of which must be named in the log. */
export type ShutdownCause = 'stdin-end' | 'stdin-close' | 'stdout-epipe' | 'SIGINT' | 'SIGTERM'

/**
 * Does this stdin event mean the parent is gone?
 *
 * Only `end` and `close` do. Deliberately NOT `error`: the MCP transport installs its own stdin
 * error handler, and a transient error is not proof the parent died. Treating it as one would turn a
 * blip into an outage. Deliberately NOT `data`, which is every inbound message.
 */
export function shouldShutdownOnStdin(event: string): boolean {
  return event === 'end' || event === 'close'
}

/**
 * The single log line a shutdown emits. Every path names its cause, because the failure this whole
 * module exists to fix was invisible, and an exit with no explanation would trade one silent
 * behaviour for another.
 */
export function describeShutdownCause(cause: ShutdownCause | string): string {
  switch (cause) {
    case 'stdin-end':
    case 'stdin-close':
      return 'the launching Claude Code session closed our input, so it is gone: shutting down'
    case 'stdout-epipe':
      return 'our output pipe broke, so whoever was reading it is gone: shutting down'
    case 'SIGINT':
    case 'SIGTERM':
      return `received ${cause}: shutting down`
    default:
      return `received ${cause}: shutting down`
  }
}

/**
 * Is this error the reader going away?
 *
 * FOUND BY RUNNING IT, not by a test. The daemon was launched from a terminal that then went away.
 * log() wrote to stderr WITHOUT a guard (only its file append was wrapped), so the write threw
 * EPIPE. That surfaced as an uncaughtException, whose handler called log(), which threw again. An
 * unbounded flood of identical exception lines into the agent's own log file.
 *
 * Two lessons are encoded here and in server.ts. A broken pipe is not a fault to report, it is the
 * parent leaving, so it belongs on the shutdown path. And a fault handler must never be able to
 * recurse through its own logging.
 *
 * Matching on the message as well as the code is deliberate: Bun surfaces this as
 * "EPIPE: broken pipe, write" and the code is not always populated, which is exactly how the real
 * loop escaped a code-only check.
 */
export function isBrokenPipe(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const code = (err as { code?: unknown }).code
  if (
    code === 'EPIPE' ||
    code === 'ERR_STREAM_DESTROYED' ||
    code === 'ERR_STREAM_WRITE_AFTER_END'
  ) {
    return true
  }
  const message = (err as { message?: unknown }).message
  return typeof message === 'string' && /\bEPIPE\b/.test(message)
}
