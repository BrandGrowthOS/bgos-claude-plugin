# Marketplace attach evidence

Run from the repository root. All temporary folders and dependency caches used
for this work were inside the worktree. Test credentials are synthetic and
real daemon tests use a dead loopback backend port.

## Commands

```sh
npm ci --cache .cache/npm --no-audit --no-fund
mkdir -p .tmp
PATH="$PWD/node_modules/.bin:$PATH" TMPDIR="$PWD/.tmp" npm_config_cache="$PWD/.cache/npm" npm test
node_modules/.bin/tsc --noEmit
python3 docs/evidence/2026-11-03-market/mutate.py
```

The local `node_modules/.bin/bun` was Bun 1.4.4, downloaded through npm into this
worktree. Node was 26.0.0 and TypeScript was 6.0.3. The final dependency install uses package-lock.json.
The test runner caps Node workers at four and Bun concurrency at four; real
Chromium files retain their existing serial execution.

Captured logs preserve test output with trailing whitespace removed for clean
diffs. No test results or assertions are changed.

## Evidence map

- `red-unit.log`: new unit tests before the module existed.
- `red-e2e.log`: real marketplace boot regressions before startup wiring.
- `review-red.log`: four additional regressions from independent review.
- `review-regressions.log`: scope, credentials and duplicate-copy regressions.
- `mutate.py`: one mutation at a time, compiling it before running its guards,
  restoring the source in a finally block, and requiring an assertion failure.
- `mutations.log` and `M1.log` through `M15.log`: final mutation results.
- `mutations-initial.log` and `mutation-M7-rerun.log`: the original telemetry
  mutant exposed a missing explicit assertion; that assertion was strengthened
  and the mutant rerun. The final run supersedes these intermediate results.
- `full-suite-initial.log`: preliminary suite stopped after an obsolete static
  startup assertion failed and review found additional boundary cases. This is
  not a passing full-suite result.
- `full-suite-before-test-updates.log`: the next complete run found six stale
  startup assertions and twelve CommonJS bootstrap fixtures inheriting this
  repository's ESM scope through local TMPDIR. The assertions now pin the new
  paths, and the fake HOME declares its own CommonJS scope. The focused rerun
  is `suite-regressions.log` (81 passed).
- `full-suite.log`: final full-suite run.
- `tsc.log`: final TypeScript check; an empty log with exit zero is success.

No daemon or launcher was started against production, and nothing was pushed.
