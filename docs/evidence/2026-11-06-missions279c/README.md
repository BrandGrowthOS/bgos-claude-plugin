# Mission snapshot ordering evidence

The mission turn cache compares the server's per-write `updatedAt` before accepting HTTP self-write responses, WebSocket frames or cold discovery snapshots. Older and unversioned responses cannot replace a known newer version. Closing a mission preserves its version after the goals are removed. A closed goal-check report marks the remembered version closed too.

Equal versions cannot overwrite cached goals or undo completion. An equal open discovery can restore an evicted chat. Comparison uses parsed instants rather than lexical timestamp order. Version memory is per mission and lasts for this daemon's lifetime.

## Tests and evidence

- `baseline.log`: 61 existing focused tests passed before edits.
- `red.log`: six expected assertion failures and fifteen passes before the first production change. Both in-order controls passed; late responses lost checked goals or restored completed missions.
- `review-red.log`: two expected assertion failures before discovery used the shared gate; two controls passed.
- `completion-red.log`: the report-closure regression failed before a closed report preserved its tombstone.
- `focused.log`: 128 passed, zero failed across mission, frame, tool admission, refresh, hook and wiring tests.
- `mutations.log`: unmodified control passes; all 10 targeted faults produce named assertion failures with one worker. `mutations.mjs` reproduces this audit in disposable copies under local dependencies.
- `typecheck.log`: `npm run build` passes without output files.
- `full-suite.log`: 10,067 passed, zero failed, 60 skipped across 473 files in 773.6 seconds. Every file result and exact unique skip reasons are retained. Both Node and Bun families passed, along with the runner cleanup check.
- `environment-attempt.log`: interrupted initial attempt with TMPDIR under `node_modules`. An installation classifier recognized the clone fixture as a package-runner install. No full-suite success is claimed for that attempt; the runner and its workers were stopped.
- `environment-check.log`: all 111 doctor tests pass with TMPDIR outside `node_modules`, before the complete corrected rerun.
- `review.txt`: independent read-only review and verification of both follow-up corrections.
- `hygiene.log`: final staged-path, release metadata, whitespace and public-data checks.

The new cases defer the real waiting tool case's PATCH response, execute `rememberMissionSelfWrite` and the daemon cache functions, parse server frames, write actual state files, and run the production Stop hook as a child process. Both delivery orders preserve the checked goal in prompt context, write a Stop ask and block on a passing check. Completion, reverse source order, timezone offsets, legacy/invalid/duplicate versions, per-mission scope, cold discovery and cache restoration are covered.

## Reproduce

Dependencies were already installed. If needed, install with a cache inside the checkout. Every test invocation caps workers at four or fewer.

```sh
mkdir -p .laneenv6-tmp/missions279c/tmp
npm ci --cache .laneenv6-tmp/missions279c/npm-cache --no-audit --no-fund
TMPDIR="$PWD/.laneenv6-tmp/missions279c/tmp" NODE_DISABLE_COMPILE_CACHE=1 TSX_DISABLE_CACHE=1 RUN_TESTS_WORKERS=4 npm test
npm run build
node docs/evidence/2026-11-06-missions279c/mutations.mjs
```

The recorded macOS full run uses `caffeinate -i` to prevent idle sleep. Local paths in public logs are replaced with `[checkout]`, typographic dashes are normalized, and full-suite fixture chatter is omitted. All runner file results and summary totals are retained.

## Scope and limits

The new ordering tests do not boot a paired daemon or contact a production backend. They replace HTTP transport and admission boundaries while executing production functions; the Stop hook runs as a real subprocess. Ordering relies on server `updatedAt`, documented as changing on every write. Unversioned legacy snapshots retain existing behavior until a comparable version is known. The version memory lasts for the daemon lifetime; pending responses do not survive its restart. Goal-check reports have no write timestamp and retain the existing per-chat revision fences. Network errors and answer-budget expiry still allow Stop.

No version bump, push, publish, deployment or production call was made. BRIEF, REPORT and .lane files are excluded from this commit.
