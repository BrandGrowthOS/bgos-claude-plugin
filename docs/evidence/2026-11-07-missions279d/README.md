# Shared mission revision acceptance

Every production goal-state writer reaches setMissionTurnEntry and createMissionTurnStore. Each accepted canonical entry carries server updatedAt. Only a newer server write changes goals/status/title. Completion tombstones and the full canonical open entry survive display eviction. Equal revisions attach newer check observations only when mission id/status/normalized goals match. Rehydration copies held state rather than accepting stale input.

Goal-check reports use mission updatedAt when provided. Unversioned reports refresh checks for exactly the held state. Changed legacy goals are reconciled by a repeated report between two chat-scoped active snapshots with the same valid revision and matching goals/status. Missing, changing, conflicting, wrong-mission and wrong-chat reads are rejected. checkedAt and local receipt clocks never order goal state.

## Evidence

- baseline.log: 58 pre-change focused cases pass.
- red.log: initial regressions before production edits: 46 passes, 57 failures, including named report-then-intermediate-snapshot assertion failures. The first wrapper ended with tail; TAP records failure but its shell exit was not separately captured.
- matching-legacy-red.log: exact-state legacy multi-mission regression exits 1 with a named assertion failure before correction.
- mutations.log and mutations.mjs: final unmodified control, final regressions against pre-fix production, and 15 independently caught faults. Each fault exits 1 with named assertion failures. One worker; disposable copies under local dependencies.
- focused.log: 446 passes, zero failures, including the 288-row source-pair table and real Stop subprocess cases.
- typecheck.log: npm run build exits 0.
- full-suite.log: 10,370 passed, zero failed, 60 skipped across 473 files in 698.5 seconds; exit 0, both Node and Bun families green. Fixture chatter is omitted; every file result, summary and unique skip reason is retained.
- changelog.log: original three-way conflict, clean resolved merge and byte-identical reviewed release history. Mission notes use a separate Unreleased mission changes section to avoid main additions.
- review.txt: independent review and corrected legacy observation case.
- initial-run.log: deliberately interrupted earlier full run; no success claimed.
- environment-timeouts.log and environment-check.log: host sleep/wake timeouts, followed by 75 passing checks. The final run uses temporary macOS wake assertions.
- hygiene.log: final path, privacy, version and whitespace checks.

## Reproduce

Run from the checkout root. Dependencies were already installed. If absent, install with npm ci and a cache under this checkout.

```sh
mkdir -p .laneenv6-tmp/missions279d/tmp
TMPDIR="$PWD/.laneenv6-tmp/missions279d/tmp" NODE_DISABLE_COMPILE_CACHE=1 TSX_DISABLE_CACHE=1 RUN_TESTS_WORKERS=4 caffeinate -dimsu -t 7200 npm test
npm run build
node docs/evidence/2026-11-07-missions279d/mutations.mjs
```

## Limits

These are local production-function, real-hook subprocess and repository-suite tests, not a paired-daemon/backend integration run. A report's updatedAt must be the mission server write revision. When unversioned changed/completed reports cannot be reconciled through the documented active endpoint, they are rejected until a versioned report or snapshot arrives. Multiple matching legacy reports continue to verify by explicit mission id. No timestamp or unsupported endpoint is invented. Revision memory lasts for the daemon lifetime. Display-cache and file-byte bounds remain in force. Tests use synthetic values.

Only the changelog was reconciled with reviewed main; no main code merge is claimed. No release metadata change, production call, push, publication or deployment. REPORT, BRIEF and .lane files are excluded.
