# Mission turn review fixes

Current main de15eda (0.86.3) was merged before the fixes in merge commit 71d135d. All four conflicts were release metadata or changelog conflicts. Main's version stays 0.86.3; mission notes moved to Unreleased. The vault, thread-goal and socket-liveness implementations from main remain unchanged. Merge typecheck passed.

## Behavior

- Each chat stores missions by mission id. Completion removes only its named mission. Prompt context and Stop answers include all relevant missions, with explicit mission_id instructions. Older single-mission state and answers remain readable.
- Cached passing results and freshness survive snapshots only when the checked goal ids and full check objects are unchanged. Goal ordering, object key order, waiting updates and ticks preserve useful reuse. Added, removed or changed checks invalidate it.
- Known missions use explicit goal-check routes. Only an empty cache uses implicit discovery; ambiguity returns no passing result and never invents a mission identity. A failed explicit read does not prevent the next mission's read.
- Per-chat revisions fence each HTTP await. A newer tick, check change, completion or replacement supersedes an old response. Revisions survive an empty cache, so a create/complete pair also fences an initial discovery. The same protection applies after the answer budget expires.
- The watcher assertion counts calls inside main's AST. The hook second-Stop fixture records the session turn, and the empty-answer fixture requires an actual ask.

## Evidence

- baseline.log: the original focused set passed 44 tests before test edits.
- red.log: 12 expected regression failures before production changes, covering all three production findings.
- review-red.log: a reviewer identified cross-mission read failure propagation; its regression failed before adding per-mission error handling.
- targeting-red.log: context and Stop action guidance failed before explicit mission_id instructions were added.
- focused.log: 116 passed, zero failed across mission, hook, chat, private admission and installation wiring tests.
- mutations.log: an unmodified passing control and all 10 targeted mutations caught by named assertion failures.
- original-mutations.log: the prior seven mutations remain caught. Two source targets were updated for the refactored code.
- merge-typecheck.log and typecheck.log: TypeScript checks.
- full-suite.log: 10,054 passed, zero failed, 60 skipped across 473 files in 784.8 seconds. Both Node and Bun families passed, as did the runner cleanup check. Every runner file result is retained; fixture chatter is omitted to keep fixture identities out of public evidence.
- review.txt: independent read-only review, followed by the verified error-isolation correction; no open Critical or Important findings.
- hygiene.log: final diff, identity, release metadata, preserved-main and forbidden-file checks.

The daemon tests execute extracted production functions with controlled HTTP responses; they do not boot a live paired daemon or contact a production backend. Hook cases execute real child processes. Deferred replies exercise the actual await order, including a shortened answer budget. Mutation scripts use disposable copies, one worker, and leave production files untouched.

## Reproduce

Dependencies already existed in this checkout. If needed, install them with a cache inside the checkout. Every test invocation below caps workers at four or fewer.

```sh
mkdir -p .laneenv6-tmp/missions279b/tmp
npm ci --cache .laneenv6-tmp/missions279b/npm-cache --no-audit --no-fund
TMPDIR="$PWD/.laneenv6-tmp/missions279b/tmp" TSX_DISABLE_CACHE=1 RUN_TESTS_WORKERS=4 npm test
npm run build
node docs/evidence/2026-11-06-missions279b/mutations.mjs
node docs/evidence/2026-11-06-missions279/mutations.mjs
```

On macOS, the recorded full suite uses caffeinate to avoid an idle-sleep stall. The suite retains platform and optional-integration skips. Server read failures and budget expiry still allow Stop. Reads share a budget, so a slow stale mission can suppress another mission's fresh result; no late response can overwrite a newer local mutation. A cold ambiguous lookup waits for mission snapshots to supply explicit identities.

No version bump, push, publish, deployment or production call was made. BRIEF, REPORT and .lane files are excluded from commits. Local paths in test output are replaced with [checkout], and typographic dashes are normalized. Exact skip reasons are in full-suite.log.
