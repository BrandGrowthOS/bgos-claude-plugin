# PR #376 red on Windows (2026-11-14): three tests, their causes, red first

The batch PR #376 (head 7804044e) failed the Windows job of plugin-tests on both attempts of run 43586786959. Plugin main (bce00a7f9) fails other Windows tests in its nightly runs (P1-6, "the copy clears a goal"), never these: none of the three appears in the last nine main runs (ten attempts, 2026-11-09 to 2026-11-14).

| Test | Failed | Brought by | Cause (Windows only) |
|---|---|---|---|
| `test/idle-update.never-arrived.test.ts` "a follower: its one way back is spent ..." | both attempts, and #365's own CI run 43467723355 | #365 | The test's in-memory disk is a Map keyed by the raw string. It stored the canary's `plugin.json` under `${CACHE}/0.80.0/.claude-plugin/plugin.json` (forward slashes); the lib reads `join(fromRoot, '.claude-plugin', 'plugin.json')`, which on Windows is backslashes. The lookup missed, the canary's build looked absent, and the way back chose the agent's own 0.79.0. A real disk on Windows treats both separators as one. |
| `test/own-messages.test.ts` "a write that fails never throws ..." | both attempts, and #372's own CI run 43555035001 | #372 | The test made the write fail with a read only folder (`chmod 0o500`). Windows ignores a folder's POSIX mode bits, so the folder and the file were created, nothing failed and nothing was logged (`0 !== 1`). |
| `test/external-email-label.test.ts` "read attachments, re-armed ..." | attempt 2 only | none: the test and the code it runs are the same as on main (the batch only passes a `quiet` option there, which this harness's channel double ignores) | A fixed `sleep(60)` after the download gate opens, assuming the file is saved and the socket has refused the email by then. On a loaded Windows runner the save took longer: the re-arm ran first, the email was never owed, and the chat was not read (`[]` against `['7001']`). The meeting lane test beside it sleeps the same 60 ms and fails the same way on a slow disk. |

The product code is right in all three; each fix is in the test.

## Fixes

- `test/idle-update.never-arrived.test.ts`: the in-memory disk's keys go through `normalize`, so a path names one file however its separators are spelled, as on a real disk.
- `test/own-messages.test.ts`: the write fails because a plain file stands where the record's folder must go. That fails on every OS, and for root too, so the `getuid` exception is gone.
- `test/external-email-label.test.ts`: the re-armed test waits for the socket's own decision (its hold let go, the email owed); the meeting lane test waits for its un-claim. Both through the file's `until` helper (2 s at most), no fixed sleep.

## Red first, Windows shaped, on macOS

`win32-shape/` gives the named files Windows imports: `node:path` as `path.win32`, or a `chmodSync` that changes nothing. `run-red-green.sh [checkout]` runs the two tests that way.

On 7804044e (before the fix):

```
--- #365 test/idle-update.never-arrived.test.ts, node:path as path.win32 (lib and test)
✖ a follower: its one way back is spent (went-back), and it goes back to the newer of its own build and the canary's
  '0.79.0' !== '0.80.0'
--- #372 test/own-messages.test.ts, chmodSync as on Windows (a no-op)
✖ a write that fails never throws: the id is still known in memory, and the failure is logged
  0 !== 1
```

After the fix: both `✔`, `pass 1, fail 0` each. Both are the exact assertions of the Windows job.

`slow-disk/` makes `lib/email-files.ts`'s `writeFile` take `SLOW_DISK_MS` longer, as a loaded runner's disk can:

```
SLOW_DISK_MS=150 SLOW_DISK_FILES=lib/email-files.ts node --import tsx --import ./docs/evidence/2026-11-14-pluginbatch2/slow-disk/register.mjs --test-name-pattern='read attachments' --test test/external-email-label.test.ts
```

On 7804044e: the re-armed test fails with the Windows diff (`[]` against `['7001']`) on every run at 150 ms and at 1000 ms. The meeting lane test fails in some runs at 150 ms and in every run at 1000 ms. After the fix: 24 of 24 at 0 ms and at 150 ms; the re-armed and meeting lane tests also pass at 1000 ms. At 1000 ms per write four other tests stop at their own bounded 500 ms waits for a delivery; that is past what the job measured and not this race.

## Not from this batch

Linux attempt 1 of the same run failed `test/own-card-fast-tap.e2e.test.ts` "review: cached answered history recovers after the one direct request fails with 503" once (attempt 2 passed). The same subtest failed on #365's own CI run 43467723355, and #365 changes no card, post or server code, so it is not brought by #372 or any batch PR. Left as it is.
