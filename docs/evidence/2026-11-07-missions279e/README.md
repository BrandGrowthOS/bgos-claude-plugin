# Mission review fixes

## Changes

The P2 completion regression is fixed using the existing closed-mission contract: the server refuses writes to a closed mission. Two explicit goal-check reports must agree on the known mission id, one of completed/abandoned/failed, and normalized goals. The store requires the original chat binding and keeps a permanent tombstone for this unversioned closure. It does not invent updatedAt. A local update during either read invalidates confirmation through the existing per-chat generation fence. No new endpoint or backend change is needed. Other missions in the chat remain available. Existing versioned-closure ordering is unchanged.

The production report fixture now defaults to missionId, status, checkedAt and goals, without updatedAt. Optional versioned-report tests are explicitly named. Coverage includes an unversioned T2 report followed by a T1 waiting-tool response and frame, and repeated turns after a missed closure frame. A real Stop subprocess exits without an ask after closure.

The equal-timestamp portion of finding 3 is fixed: a repeated report between stable, matching chat-scoped snapshots can repair goals at the held timestamp after the 30 second check reuse window. Ordinary conflicting equal-time frames and versioned reports cannot replace goals. The new terminal-race tests also catch removal of the per-chat generation bump. Older store-protected tests are not cited as proof of that fence.

The P3 changelog conflict is fixed. The fetched main Unreleased section and release history are preserved byte for byte, with mission notes kept only in their separate section. No main code merge is claimed.

## Evidence

- baseline.log: 334 original focused cases passed before changes.
- production-shape-red.log: making the default report unversioned exposes the two existing completion regressions before the fix.
- terminal-red.log: new production-shape terminal regressions fail before the closure fix.
- equal-revision-red.log and equal-revision-green.log: both tick and added-check recovery fail before the fix; the stable-read checks then pass.
- focused.log and related.log: initial expanded focused and related runs pass 357 and 768 cases. The final full run also includes the last inverted-timestamp behavior case.
- mutations.mjs and mutations.log: final real-production controls pass, actual reviewed production fails the final regressions, each production fix is independently reverted and caught, and ten targeted reverts/faults are caught in total. Restored controls pass. One test worker, disposable copies inside this checkout, production files unchanged.
- typecheck.log: final npm run build (tsc --noEmit) exits 0.
- heartbeat.log: 38 Bun cases pass.
- full-suite.log: final npm test exits 0 with 10,394 passed, zero failed and 60 skipped across 473 files in 668.9 seconds. Every file result, final totals and skip lines are retained; passing fixture diagnostics are omitted. Worker cap is four, with serialized groups at one.
- changelog-before.log and changelog-after.log: original content conflict, clean three-way merge after reconciliation, and byte-identical fetched main release history.
- review.txt: independent read-only production and test review found no P1/P2 blocker or new regression.
- hygiene.log: final added-line privacy, forbidden-path, release metadata and whitespace checks.

## Reproduce

Dependencies already existed in this checkout. No dependency or release metadata changed. All temporary project data stays inside the checkout. On macOS the full run used caffeinate to avoid sleep during integration checks.

```sh
mkdir -p .laneenv6-tmp/missions279e/tmp
TMPDIR="$PWD/.laneenv6-tmp/missions279e/tmp" NODE_DISABLE_COMPILE_CACHE=1 TSX_DISABLE_CACHE=1 RUN_TESTS_WORKERS=4 caffeinate -dimsu -t 7200 npm test
npm run build
node docs/evidence/2026-11-07-missions279e/mutations.mjs
```

The related run used node --import tsx --test with --test-concurrency=4 for mission, mission turn, mission chat, hook manifest, capability and preseed suites. The separate version heartbeat run used bun test --max-concurrency=1. Logs containing failure locations use <checkout> in place of the local path.

The initial plain git fetch origin failed because this checkout had no origin remote configured. Fetching with a command-scoped public repository URL succeeded and did not persist remote configuration. Fetched main is 01a6284e34a641a046df5505bb0026b1756771ea, the same main cited by the review. Work stayed on the existing branch.

## Remaining lower findings and limits

Inverted backend timestamps remain rejected even when legacy reads agree. Safely distinguishing those writes needs a monotonic backend revision. A regression records the current fail-open Stop behavior for that limit. The equal-time recovery suggested by the review is implemented.

The canonical per-mission map and terminal tombstones remain for the daemon lifetime. Bounding that memory safely needs a retention design that prevents stale responses from resurrecting evicted closures. Display-cache and file-byte bounds remain in force. This lower-priority memory concern is deferred.

Closure confirmation relies on the existing no-reopen lifecycle for unversioned terminal mission ids. A future backend that supports reopening must provide an ordered revision for that transition. These are local production-function, real-hook, synthetic integration and repository-suite checks, not a paired live-backend verification. No production request, push, publication or deployment was performed. BRIEF, REPORT and .lane files are excluded from the commit.
