# Windows suite evidence

Everything here ran on Darwin arm64. No Windows execution or CI success is claimed. The Windows job facts come from read-only GitHub logs: the cancelled job 126221561764 (run 41723343610) and the last green job 125966154803 (run 41650243695, commit b5c9668b8).

Versions and totals are in `results.json`. Node 24 matched CI, on PATH ahead of the system Node 26, with Bun 1.3.14 on PATH.

## Files

| File | What it shows |
| --- | --- |
| `windows-ci-excerpt.log` | The cancelled job's failures and its silence |
| `win32-paths-before.log` | Main's lane fixtures under the Win32 path model |
| `deadlock-red.log` | Main's retry test deadlocking under that model, failing by name at a 2 s deadline |
| `win32-paths-after.log` | The fixed lane file under that model: 73 pass, 12 explicit skips |
| `marketplace-unit-win32-red.log` | Main's marketplace unit file under the model: the same 13 outcomes as CI |
| `marketplace-unit-win32-green.log` | The fixed file under the model: 13 pass |
| `marketplace-e2e-homedir-repro.log` | The real daemon with Windows' two conditions simulated: the same 13 outcomes as CI |
| `runner-red-1.log`, `runner-red-2.log` | New runner regressions failing before their fixes |
| `runner-green.log` | Runner regressions and both e2e files after the fixes |
| `prove-timeout.log` | Deliberate hangs under the real deadlines |
| `chromium-repeat.log` | The popup flake, five rounds under each invocation, before the wider wait |
| `final-suite-summary.log` | The final full run, one line per file |
| `main-suite-summary.log` | Unchanged main's totals |
| `typecheck.log` | `npm run build` on the final code |

Full suite logs are about 1 MB and 2.3 MB, so only summaries are kept here.

## Commands

Set up: `export PATH="$HOME/.bun/bin:<node 24>/bin:$PATH"`

- Full suite: `/usr/bin/time -p npm test`
- Hang proof, about 4.5 minutes: `node docs/evidence/2026-11-04-wintest/prove-timeout.mjs`
- Win32 path model: `node --import tsx --import ./docs/evidence/2026-11-04-wintest/win32-paths.mjs --test --experimental-test-isolation=none --test-reporter=tap test/thread-lanes.test.ts`, and the same for `test/marketplace-attach.test.ts`. The preload swaps `node:path` for `path.win32` in those tests and the modules they drive, on a synthetic C: drive. No Windows process runs. The marketplace forecast cases then leave files named `\var\folders...` in the repository root; remove them afterward.
- Deadlock red: put main's `test/thread-lanes.test.ts` in place, run the model with `--test-timeout=2000 --test-name-pattern='a failed reply post is retried with backoff and lands'`, then restore the fixed file.
- Daemon simulation: in a temporary copy of main's `test/marketplace-attach.e2e.test.ts`, set the daemon's `HOME` to an empty folder (Windows reads `USERPROFILE`, so `HOME` does not reach `os.homedir()`), and spell `CLAUDE_CONFIG_DIR` through a symlink to the rig's home (standing in for `RUNNER~1`, which Bun's realpath expands and Node's keeps).
