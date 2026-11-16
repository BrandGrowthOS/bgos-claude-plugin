# Edit delivery gate-review evidence

Base commit: `ccaee4ea347b157b3b8147c15241133ddb8b139f`.

`REVIEW-1.md` is an input to this work and remains uncommitted.

## Regression proofs

- `red-r1.txt`: replayed unversioned B after C, independent trackers distinguishing replay from real revert, stale poll snapshot, and stable numeric revision.
- `red-r2.txt`: reconnect catch-up barrier and B-before-correction poll order.
- `red-r3.txt`: message/chat tombstones, pending deletion, deletion during an authoritative read or transport, and legacy deletion.
- `red-original-delete.txt`: deletion during original poll/stream handoff.
- `red-followup.txt`: current-epoch periodic-read barrier, pending revisions, authoritative original row, sign-in privacy and deferred original callbacks.
- `red-preparation.txt`, `red-original-resolution.txt`, `red-early-merge.txt`, `red-empty-original.txt`: pending replay and privacy during original preparation, raw-version preservation, and empty original handling.

Each new regression first failed by assertion on the prior implementation. Guards that already passed remain compatibility coverage and are not counted as red-first proofs. The two old asynchronous checks now assert entry into the handoff after a bounded event-loop turn, so a removed delivery path fails by assertion rather than waiting indefinitely. Replacement metadata is checked to contain only strings.

`mutation-proof.mjs` runs a separate production mutation for each reviewed scenario, including independent tracker cases and each asynchronous deletion boundary. It rejects timeouts and harness exceptions as proof. `mutations.txt` records the assertions, exit codes and unchanged source hashes.

## Reproduce

```sh
node_modules/.bin/tsx --test --test-concurrency=4 test/message-edits.test.ts
node docs/evidence/2026-11-03-editdrop-review/mutation-proof.mjs
node_modules/.bin/tsc --noEmit
node docs/evidence/2026-11-03-editdrop-review/run-suite.mjs
```

The full runner selects all test files using the existing mixed-suite partition. Node has four workers, Chromium files run serially, and Bun concurrency is four. It creates and removes an isolated temporary directory inside this checkout, with a package boundary for fixture scripts. Saved text evidence normalizes en/em dashes in existing test titles to ASCII hyphens; raw outputs stay in the ignored local cache.
