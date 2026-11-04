# Second Windows round: evidence

Everything here ran on Darwin arm64 with Node 24.22.2 and Bun 1.3.14, unless a line says otherwise. No Windows run of this commit exists. The Windows facts are read-only GitHub logs from the last round's run, 41746594543.

This corrects `docs/evidence/2026-11-04-wintest/review.md`, which says top-level throws exit 1 under isolation none. That holds only for a throw before the first test registers.

## Files

| File | What it shows |
| --- | --- |
| `windows-attach-scope-failure.log` | The one failure in the Windows job |
| `win32-homedir.mjs` | A preload giving node children Windows' home lookup, with a decoy as the real profile |
| `attach-scope-red.log` | The old fixture under that model: the same `0 starts` message as CI |
| `attach-scope-green.log` | The fixed file under that model: 39 pass |
| `runner-red.log` | The new tests against the old runner: 8 of 21 fail. A later test was added after this log |
| `runner-green.log` | The first green run of those 21, before the test tightening that mutations asked for |
| `real-file-repro.log` | `session-status.test.ts` with its fixture removed from a scratch copy: 7 pass and PASS before, FAIL by name now |
| `mutations.log` | 14 mutations of the runner and orchestrator, all caught by the final tests |
| `prove-timeout.log` | Deliberate hangs under the new flags and real deadlines: 120 s by test name, 270 s by file name |
| `windows-vs-linux-per-file.log` | Last round's Windows and Linux jobs: the same test count in all 439 files |
| `per-file.py` | The script behind that comparison: `python3 per-file.py <linux log> <windows log>` |
| `final-suite-summary.log` | The final full run, one line per file |
| `typecheck.log` | `npm run build` on the final code |

The full suite log is about 2.3 MB, so only the summary is kept.

## Commands

Set up: `export PATH="$HOME/.bun/bin:<node 24>/bin:$PATH"`

- Full suite: `/usr/bin/time -p npm test`
- Runner tests: `node --import tsx --test-reporter=tap test/run-tests-timeout.test.ts`
- Windows home model: `node --import tsx --import ./docs/evidence/2026-11-04-wintest2/win32-homedir.mjs --test-reporter=tap test/attach-scope.test.ts`
- Hang proof, about 4.5 minutes: `node docs/evidence/2026-11-04-wintest/prove-timeout.mjs`
