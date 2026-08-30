# A fault handler that reports through a logger which can raise the same fault

**Date:** 2026-08-30

**Context:** Adding `unhandledRejection` and `uncaughtException` handlers to the daemon, so a fault
would stop being silent. The daemon was then launched from a terminal that went away.

**Gotcha / Pattern:** An unbounded flood of identical exception lines into the agent's own log file.

`log()` wrapped its file append in `try/catch` and left `process.stderr.write` unguarded. With the
reader gone, the write threw `EPIPE`, which surfaced as an `uncaughtException`, whose brand new
handler called `log()`, which threw again. The asymmetry had been harmless for as long as nothing
called `log()` from a fault path, so adding the handler is what turned a latent bug into a loop.

Three separate lessons, and the third is the one that generalises:

1. **Logging must never be able to fail into the code that reports failures.** Every write in `log()`
   is now guarded, not just the one that looked risky.
2. **A broken pipe is not a fault to report; it is the reader leaving.** It belongs on the shutdown
   path, not the error path. Bun does not always populate `err.code`, surfacing this as
   `"EPIPE: broken pipe, write"`, so `isBrokenPipe` matches the message as well as the code, which is
   exactly how the real loop escaped a code-only check.
3. **Registering an `uncaughtException` handler suppresses Node's default termination.** A change
   that reads as "add logging" silently converts a crash into a process that continues in an unknown
   state. Ours holds chat cursors, so continuing risks writing them wrongly. It logs, flushes, and
   exits 1. `unhandledRejection` deliberately does NOT exit, because this file fires floating
   promises on purpose, and the asymmetry is pinned by a test so it reads as a decision.

**How to apply next time:** When you add a handler for a fault class, ask what that handler CALLS, and
whether any of it can raise the same class. Add a re-entry guard regardless. And when the handler is
for `uncaughtException`, state explicitly whether the process should still die, because registering
one silently answers that question for you.

**Regression guard:**
- `test/stdin-shutdown-runtime.test.ts` spawns the ORIGINAL shape and the fixed shape as real child
  processes and asserts the first does not exit and the second does. The control half is what makes
  it evidence.
- `test/process-lifecycle.test.ts` asserts the stderr write is inside a `try`, that a re-entry guard
  exists, that the `uncaughtException` handler contains `process.exit(1)`, and that the
  `unhandledRejection` handler does not.
