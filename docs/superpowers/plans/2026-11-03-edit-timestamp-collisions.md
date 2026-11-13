# Edit timestamp collision implementation plan

**Goal:** Close the remaining REVIEW-2 finding without changing the closed catch-up, deletion, privacy or pending-original behavior.

**Approach:** Keep the existing normalized timestamp and numeric revision guards. Reconcile changed delivered text against the existing exact-row reader when equal timestamps cannot order the versions and both versions do not have numeric revisions.

**Constraints:** Work in the current isolated branch. Never stage review, report or brief files. Commit only, no push. Cap test workers at four. This plugin has no frontend package; frontend heap, chat parity and Android performance gates apply only if frontend changes become necessary.

- [x] Add socket, poll and stream regressions in `test/message-edits.test.ts` using both identical timestamps and `2026-11-03T10:02:00.000100Z` / `2026-11-03T10:02:00.000900Z`. Deliver A, B, C, replay B while the current row stays C, and assert only A, B, C arrive. Add legitimate equal-time edit and revert controls.
- [x] Run `node --import tsx --test --test-concurrency=4 --test-name-pattern='review R4:' test/message-edits.test.ts` against unchanged production code. Record assertion failures before editing production code.
- [x] Extend the reconciliation condition in `lib/message-edits.ts` for equal-time changed text lacking comparable numeric revisions. Reuse the authoritative reader and existing post-read guards.
- [x] Run the focused cases and complete message-edit suite. Prove that removing equal-time reconciliation fails every stale-replay case, and rejecting equality fails every legitimate-edit case. Run mutations only in temporary source copies and verify original hashes remain unchanged.
- [x] Run `tsc --noEmit`, related delivery/catch-up suites, and the complete plugin suite using the existing four-worker evidence runner. Record fresh outputs under `docs/evidence/2026-11-03-editdrop-collisions/`.
- [x] Review the diff and evidence, stage explicit implementation, test and evidence paths, and commit. Verify the final commit and excluded files. End with `EDITDROP3 READY` and the commit SHA.
