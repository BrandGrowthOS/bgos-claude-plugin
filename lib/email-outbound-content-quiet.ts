// ── Agent email files, outbound: the content Worker's silence (review round 8) ──
//
// Imported FIRST by lib/email-outbound-content-worker.ts, so it runs before any other module of the Worker. Under bun
// a Worker's console and process.stdout are the daemon's own (bun ignores the Worker's stdout option), and the
// daemon's stdout is the MCP channel: one stray line there breaks the daemon's talk with Claude Code. Every console
// method and every write to process.stdout and process.stderr in the Worker is dropped. Under node the Worker's
// streams are its own, which the main thread leaves unread (round 9: this said they were read; they are not, since a
// stream being read keeps the process alive), and this silences them too, so nothing is written to them.
//
// No em or en dashes in this file.

const drop = (): void => {}
const console_ = globalThis.console as unknown as Record<string, unknown>
for (const key of Object.keys(console_)) {
  if (typeof console_[key] === 'function') console_[key] = drop
}
for (const key of ['log', 'info', 'warn', 'error', 'debug', 'trace', 'dir', 'dirxml', 'table', 'group', 'groupCollapsed', 'assert', 'count', 'time', 'timeEnd', 'timeLog']) {
  console_[key] = drop
}
/** A write that is dropped: it says it wrote, and calls back as a stream would. */
function droppedWrite(...args: unknown[]): boolean {
  const done = args.find((arg) => typeof arg === 'function') as (() => void) | undefined
  if (done) queueMicrotask(done)
  return true
}
for (const stream of [process.stdout, process.stderr]) {
  try {
    ;(stream as unknown as { write: typeof droppedWrite }).write = droppedWrite
  } catch {
    // A stream whose write cannot be replaced; console is silenced above either way.
  }
}

export {}
