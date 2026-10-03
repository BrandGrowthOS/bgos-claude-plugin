# A Windows child cannot handle SIGTERM, and dies with its parent unless it is detached

**Date:** 2026-10-04

**Context:** The browser host test "stays up with no live socket, and still stops cleanly on SIGTERM" failed on Windows (exit code null, not 0). It read like a test that assumed POSIX signals. The product used the same call: the daemon's only way to stop its browser host was `child.kill('SIGTERM')`, from `shutdown()`, from the exit hook, and from a lock handover.

**Gotcha / Pattern:** two Windows facts, both silent.

1. `child.kill('SIGTERM')` (node and bun alike) is TerminateProcess. No handler runs. The host's stop, which closes every Chrome through CDP `Browser.close` (Chrome writes its cookies to disk then), never ran on any daemon stop on Windows.
2. libuv puts every child that is NOT spawned `detached` into a job object with KILL_ON_JOB_CLOSE, so the child is killed the moment the parent process exits. `shutdown()` calls `process.exit()` on the line after `stop()`, so even a host that had been asked nicely would have been killed mid close. Measured: with a stdin stop alone, a stand-in daemon under bun that stops its host and exits at once still left the host's stop unfinished; with the host detached, the host finished and logged "stopped cleanly" after the daemon was gone.

What works on every OS: the parent holds the child's stdin and closing it is the stop (the child must be told to treat end of input as a stop, or a child started with stdin ignored stops at once). It also arrives when the parent dies outright, because the OS closes the pipe. A child that has to outlive its parent's exit on Windows must be spawned `detached`, and then it needs its own deadline (a detached child is no longer killed for you), plus a late backstop kill while the parent is still alive.

**How to apply next time:** any `kill()` aimed at a process that is meant to clean up is a Windows bug unless the cleanup does not matter. Give it a channel it can read. And any child expected to finish work after its parent's `process.exit()` must be detached on Windows. A test asserting a clean exit after SIGTERM is not "a POSIX test" to skip on Windows: ask what the product does there first.

**Regression guard:** `test/browser-host-supervisor.test.ts` (the real supervisor stops a real host: exit 0 and "stopped cleanly", red on Windows before the fix; a bun stand-in daemon that stops its host and exits at once still gets a clean close, red on Windows without `detached`; the unit cases for the stdin pipe, `detached` on Windows only, no TerminateProcess, the backstop) and `test/hoai-browser-host.test.ts` (the stdin stop on every OS, the stop deadline). Mutation proven.
