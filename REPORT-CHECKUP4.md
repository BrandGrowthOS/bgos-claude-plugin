# CHECKUP4

Base: `e7f335a`. Checkup is now observation and reporting only, in every process state. The separate owner restart path is unchanged. Commit only; no push.

## Changes

- Removed automatic start and verify execution from `runCheckupJob`, including all absence-confirmation, budget-write, marker and recovery branches.
- Removed `startStoppedAgent`, covering systemd start, launchd kickstart, Windows task Run and launch-recipe fallback. Checkup cannot enter launcher startup or its incumbent cleanup and idle-holder takeover.
- The pure classifier reports stopped agents with Restart now. All findings produce reports; no start, restart, verify or repair actions are planned.
- Kept process observations, transcript and version diagnosis, pairing status checks, progress retries and scrubbed reports. Credential replacement from legacy pairing confirmation was removed to keep checkup read only.
- Updated current job documentation and tests. Existing restart and recipe implementations, launcher scripts and owner job routing are unchanged.

## Evidence

All fixtures use synthetic identifiers and fake filesystems. Process operations are stubbed, and a real-OS sentinel rejects accidental host operations.

Red first, before production edits: `test/checkup-read-only.test.ts` ran 39 tests, 28 passed and 11 failed. Failures included every stopped launch mechanism: systemd, launchd, Windows task, Linux tmux, Linux script, macOS script and Windows hidden recipe. Both unrecorded-process race cases also violated the report-only contract. The exported start-only wrapper and confirmed pairing CLI each failed their removal tests. Raw TAP: `.checkup4/red.log`. Replaying the final fixtures against the base also produced the same 11 failures, recorded in `.checkup4/red-replay.log`; all production files were then restored byte for byte.

Green: the same 39 tests pass. The matrix covers stopped, idle, busy, unresponsive and unclear states for all seven mechanisms. It checks every command runner, zero process signals or detached launches, unchanged agent files and budgets, and report actions containing Restart now. The races create an unrecorded background process during asynchronous cwd queries and during progress reporting. The process need not be rediscovered to prevent a launch because checkup has no launch branch.

The owner-action integration test runs checkup, observes its Restart now report, then submits the existing `restart_only` job for the same target through the real planner and executor. Checkup issues no start or restart; the owner job invokes the existing systemd restart and passes boot-hello verification. No production app UI or notification-delivery claim is made.

Final focused suite, including the clarified target-folder race fixture after baseline replay and mutation restoration: 179 passed, 0 failed across the read-only matrix, watcher checkup, pure classifier and restart ladder tests. Raw TAP: `.checkup4/focused.log`.

Mutation: temporarily inserted `systemctl --user start` into `runCheckupJob` whenever its observation said stopped. The read-only suite failed 10 tests: all seven stopped launch mechanisms, both races and the legacy pairing-confirmation case. The command allowlist assertion caught the automatic start. The other 29 tests passed. The original file was restored byte for byte in a `finally` block. Raw TAP: `.checkup4/mutation.log`.

Static comparison against the base confirms that `restartAgent` and `launchAgentRecipe` are unchanged byte for byte. The launcher scripts, owner planner, executor and verification have no diff. No checkup references to the removed start wrapper, pairing executor, budget writer or confirmation-gap machinery remain.

Full plugin suite: `RUN_TESTS_WORKERS=2 npm test` passed with exit 0: **9,933 passed, 0 failed, 53 skipped, 460 files**, in 1,174.1 seconds. Both Node and Bun families were green. The main Node pool and Bun pool used two workers; runner regressions, Chromium and daemon groups ran serially. The working-tree artifact check passed. Raw output: `.checkup4/full-suite.log`.

Typecheck: `npm run build` passed with exit 0. Raw output: `.checkup4/typecheck.log`. Diff whitespace checks and the scan for em and en dashes passed. Raw logs remain ignored and are not committed.

## Reproduction

Use a temporary directory inside ignored `.checkup4/`, with `TMPDIR`, `TMP` and `TEMP` set to that directory; set `TSX_DISABLE_CACHE=1`, `RUN_TESTS_ALLOW_LOCAL_TMP=1` and `RUN_TESTS_WORKERS=2`.

- Focused: `node --import tsx --test --test-reporter=tap --test-concurrency=2 test/checkup-read-only.test.ts test/watcher-checkup.test.ts test/agent-checkup.test.ts test/agent-restart.test.ts`
- Full plugin suite: `npm test`
- Typecheck: `npm run build`

All test workers are capped at two. Dependencies already existed in this checkout. Raw evidence stays local and ignored, with only this scrubbed report committed.
