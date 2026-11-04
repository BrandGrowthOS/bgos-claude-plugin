# Timestamp collision gate evidence

Reviewed base: `a2f28a6a88d4422180e632ac84bdd4af8faf3179`.

Stored test output has trailing whitespace removed and typographic dashes converted to ASCII hyphens. Test results, assertion text apart from typography, and counts are preserved.

The remaining REVIEW-2 finding is changed delivered text at equal normalized timestamps. The production change reconciles these ambiguous events through the existing unconditional exact-row read when either version lacks a numeric revision. Timestamp parsing, numeric revision ordering, pending originals, catch-up ordering, deletion and privacy handling are unchanged.

## Reproduction and mutation proof

The new integration cases run the production socket handler, poll function and stream apply function. Event/snapshot text is injected independently from the backend row. Both identical timestamps and `2026-11-03T10:02:00.000100Z` / `2026-11-03T10:02:00.000900Z` reproduce the collision.

- `red.txt`: before the production change, all six stale-replay cases fail by assertion, delivering an unwanted fourth card B while the backend still holds C. The six legitimate-edit controls pass on that same source. The controls are not claimed as red-first regressions.
- `green.txt`: all 67 edit tests pass after the change, including all 12 collision cases and the 55 pre-existing cases.
- `mutations.txt` and `mutation-summary.json`: removing equal-time reconciliation fails each of the six replay cases at the fourth-card assertion. Rejecting all equal timestamps fails each of the six legitimate-edit cases at the missing-C assertion. All 12 selected cases fail by assertion, with no timeout or harness error. Source copies are isolated; original source and test hashes are checked after mutation runs.
- `tsc.txt`: `tsc --noEmit` exits 0.
- `related-initial.txt`: 545 Node tests pass across the related delivery, routing, privacy, paging and catch-up suites. The command also mistakenly includes the Bun-only acting-user suite, which fails to import under Node. `related-bun.txt` records its corrected run under Bun: 19 pass, zero failures. The original runner-selection error is retained rather than removed from the evidence.
- `full-suite.txt` and `summary.json`: the complete mixed-runtime suite exits 0. Node: 8,179 pass and 52 skipped. Chromium: 11 pass and four skipped. Bun: 377 pass and one skipped. Total: 8,567 pass, 57 skipped and zero failures. This run rechecks all related files using the correct runtime.
- `source-sha256.txt`: production and test hashes verified unchanged after the complete suite.

## Commands

```sh
node --import tsx --test --test-concurrency=4 --test-name-pattern='review R4:' test/message-edits.test.ts
node --import tsx --test --test-concurrency=4 test/message-edits.test.ts
node docs/evidence/2026-11-03-editdrop-collisions/mutation-proof.mjs
node node_modules/typescript/bin/tsc --noEmit
node docs/evidence/2026-11-03-editdrop-review/run-suite.mjs
```

The complete-suite runner caps Node and Bun workers at four, and runs real Chromium files serially. It uses a real temporary path with a package boundary for the existing macOS fixture requirements. This is a plugin-only change; there is no frontend package or frontend change requiring chat parity or Android performance gates.

A separate read-only code review found no correctness issues or significant test gaps. It independently ran all 67 edit tests and checked the mutation evidence hashes against the working tree.
