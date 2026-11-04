# Third Windows round: evidence

The three P2 findings of the review of `32acf02`. Everything here ran on Darwin arm64 with Node 24.22.2 and Bun 1.3.14, unless a line says otherwise. No Windows run of this commit exists.

## Files

| File | What it shows |
| --- | --- |
| `runner-red.log` | The new tests against the old runner: 7 of 32 fail, with the reason for each. One new test was widened to cover bun after this log |
| `mutations.log` | 23 changes to the new rules, each run against the tests that should notice: all caught |
| `real-file-repro.log` | A failing root `after` hook and a focused test in a scratch copy of `test/peer-403-loop.test.ts`, both failing by name |
| `ci-not-ok-scan.log` | The green jobs of `32acf02` (run 41755837913): no `not ok` line on Linux or Windows, so the new rule has nothing to turn red there |
| `first-run-failure.log` | The first full run of the final code: one failed Chromium test, under heavy load |
| `final-suite-summary.log` | The second full run of the same code: green, one line per file |
| `typecheck.log` | `npm run build` on the final code |

Full suite logs are about 2.3 MB, so only summaries are kept.

## Commands

Set up: `export PATH="$HOME/.bun/bin:<node 24>/bin:$PATH"`

- Full suite: `/usr/bin/time -p npm test`
- Runner tests: `node --import tsx --test-reporter=tap test/run-tests-timeout.test.ts`
