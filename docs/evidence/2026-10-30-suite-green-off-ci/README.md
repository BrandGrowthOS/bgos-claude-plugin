# The suite runs green off CI (split out of fix/clone-follows-published)

At c636ded CI's Linux and Windows jobs are green, but the suite is not green on a stock Mac or on a fast arm64 Linux
box. These four test-only commits fix that; none touches product code. They were found while proving board row
01a0db74 (clone installs follow the published version) green on macOS and Linux, and split out so that branch stays in
its scope.

| Commit here | Was on the clone branch | Where | What was wrong |
|---|---|---|---|
| `11d015d` | `59ea0a8` | `test/private-turn-late-line.test.ts` | its helper's Stop could be stamped before the delivery it followed (the coarse Linux file clock) |
| `46db295` | `ffb2b3c` | `scripts/run-tests.mjs`, `scripts/run-tests-env.mjs` | macOS `$TMPDIR` is a link into `/private/var`, which the browser profile code refuses on purpose: 45 failures and two hung files on a stock Mac |
| `1f35897` | `212aa54` | `test/helpers/file-clock.ts`, `test/helpers/private-turn-host.ts` | `settle()` waited 2 ms of wall clock, not the file clock: `owner-authority` failed 6 to 7 of 10 runs on Linux arm64 |
| `8137fec` | `5ae786e` | `test/browser-profile-runtime.test.ts` | a 30 ms fake protocol timeout tripped under a loaded full run (3 or 4 of 16 parallel runs) |

Red first at each commit's parent and the mutants of every changed line: `test-fix-proof.txt` (the commit ids there
are the clone branch's; the changes are the same). The clock checks ran in a clean Debian 12 arm64 VM with
`clockproof.sh`.

For the owners of `lib/private-turn.mjs`: the tracker orders a `Date.now()` moment against a marker file's mtime. In
the field a Stop comes seconds after a delivery, so it is not a live bug, but the two clocks are mixed.
