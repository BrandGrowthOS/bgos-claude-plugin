# The test run fails on a path it left

`scripts/run-tests.mjs` snapshots the working tree before any file runs and after the last group, and any new path fails the run, by name. It reads the filesystem, not git status, so an ignored file, an empty folder and a folder holding an empty `.git` all count. It does not go into `node_modules` or `.git`, and does not follow a link.

## On a hang

**It still reports.** `runTestFile` always resolves, a hung file as TIMED OUT, so a hang reaches the scan like any other file. Seen on the real 270 s file deadline, on native Linux, with a real test that left a file and then blocked forever: `test/hangs.test.ts: TIMED OUT`, `[run-tests] NEW PATH: "stray-from-the-hang.txt"`, `[run-tests] FAILED`, exit 1, 270 s. A test in `test/run-tests-timeout.test.ts` does the same in 20 s through `RUN_TESTS_FILE_DEADLINE_MS`, so CI's Windows job proves it too.

## Red first

This head's tests on its runner with the guard taken out: 6 of 39 fail in `test/run-tests-timeout.test.ts`, the six that need the guard. With it: 43 of 43, with the scan's own tests in `test/run-tests-litter-guard.test.ts`. These run the real runner with real node and real bun on real test files that leave real files.

## What it does not see

- A stop by SIGINT or SIGTERM exits first and reports nothing.
- A kill is bounded, not sure. A tree still alive, or an orphan the kill could not find, can write after the scan. On Windows an orphan cannot be found. One that removes a folder during the scan fails the run as a tree it could not read.
- A changed file, a deleted file, or a path that was already there. So a second local run with the same stray file left in place passes. CI's checkout is fresh.
- A write inside an existing `node_modules` or `.git`.
- Which test left the path. The run names the path only.
- The branch that fails a run on an unreadable tree is proven on Linux only, CI's one job where a folder can be locked: Windows has no mode bits that stop a read, root reads anything, and no CI job runs on macOS. Its test locks a folder that was there before the run, so the tree is the only thing that can fail that run.
- A scan before the run that fails stops the run as an uncaught error, with no test run. No test holds that.

The whole suite under the guard has not run here, by the host's rule. CI's run on this PR is the first proof that main leaves no path of its own.
