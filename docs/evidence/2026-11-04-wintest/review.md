# Code review

Two read-only reviews ran: one by the first worker, and one independent Windows-focused review of the near-final runner and fixtures. Neither ran tests or changed files. Each finding below was checked against code or an experiment before acting on it.

## First review, resolved

- Keep the unnormalized traversal spelling in the malicious saved-folder fixture.
- Do not treat stdout chunks as complete lines in the concurrency regression.
- A POSIX process-group kill alone misses detached lane descendants, so the watchdog snapshots descendants first.

## Second review

Fixed:

- A test's explicit `timeout: 300_000` outlasted the 270 s file deadline, so its hang could not fail by its own name. Lowered to 240 s (it took 24 s on green Windows); a new test holds the rule for the whole suite.
- `START` lines were held back with the file's output, so a job cancelled from outside hid what was running. They now print at once.
- A synchronous `spawn` throw (Windows refuses a `.cmd` without a shell) rejected the whole run. It now fails that one file.
- The LEAK path left the worker's process group running. It is now killed off Windows.
- Regression fixtures used a cleanup with no retries, and absolute paths as `node --test` arguments, which real runs never use. They now use the retrying helper and relative names.
- Both e2e rigs resolved on `exit`, so stderr might not have arrived. They now resolve on `close`, with a one second limit after the exit.

Checked and not changed:

- "`--test-timeout` caps whole suites": false for `describe` by experiment. It does cap a parent `test()` with subtests; the slowest test of any kind on green Windows took 41 s, against a 120 s limit.
- "A broken file could pass": syntax errors, top-level throws, missing modules, late throws and unhandled rejections all exit 1 under isolation none, by experiment. A file with no tests exits 0, the same as before.
- "`bun test test\x.test.ts` might not match on Windows": the green Windows job ran exactly that form and passed.
- `--experimental-test-isolation` is accepted by Node 24 and 26 here. Node 22.12 was not run.

Left open: a process that outlives its worker on Windows cannot be found once its parent has gone. It is named as a LEAK and the file keeps its own result.
