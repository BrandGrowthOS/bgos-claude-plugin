# Edit delivery evidence

Run from the repository root after `npm ci`.

- `red.txt`: the three initial regressions against unchanged production code, all failing because the edited message was not delivered.
- `red-revisions.txt`, `red-meeting-pending.txt`, `red-pending-revision.txt`, `red-edit-actor.txt`, `red-meeting-authority.txt`: additional failing regressions captured before their fixes.
- `focused-final.txt`: 218 passing edit, email, authority and delivery-wiring tests.
- `mutations.txt`: socket, poll and stream integrations disabled separately; each matching regression fails with 1 delivered card instead of 2. The script checks that the original source stays unchanged.
- `full-suite.txt`: complete mixed-suite output from the final code, run with the same test partition as `scripts/run-tests.mjs` and explicit concurrency limits.
- `source-sha256.txt`: hashes of the production and test sources under validation.

Reproduce mutation evidence:

```sh
node docs/evidence/2026-11-03-editdrop/mutation-proof.mjs
```

Reproduce the full suite:

```sh
node docs/evidence/2026-11-03-editdrop/run-suite.mjs
```

The runner keeps temporary test data in a unique `.editdrop-test-*` directory directly under this checkout (outside `node_modules`, so topology fixtures retain their intended identity), gives it an empty package boundary for fixture scripts and removes it afterward, runs the Node family with four workers, real Chromium files serially, and Bun with maximum concurrency four. `tsc --noEmit` is run separately. Test logs are plain text; any en/em dash from an existing test's title is normalized to an ASCII hyphen in the saved evidence.

The root report `REPORT-EDITDROP.md` remains uncommitted, as requested.
