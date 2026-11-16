# Marketplace Branch Merge Plan

> Execute inline in this checkout. The user has authorized the merge and commit; never push.

**Goal:** Merge local `main` into `fix/daemon-attach-scope-impl`, retaining both branches' work with no new behavior changes.

**Approach:** Use a two-parent Git merge. Resolve version metadata and `REPORT.md` from main, keep the branch changelog text as an unreleased note under main's newest heading, and retain both sides of conflicting tests.

**Tools:** Git, Node, local tsx and TypeScript.

## Constraints

- Work only in `/Users/you/hoai-work/mbmarket`.
- Use main's version and main's `REPORT.md`.
- Preserve `REPORT-ROUND.md`.
- Do not change behavior beyond combining the branches.
- Cap test workers at 4.
- Use no em or en dashes in newly written text.
- Commit the merge and never push.

## Steps

- [x] Capture both parent commits and merge main without committing.
- [x] Resolve all conflicts and verify both sides of each test survive.
- [x] Adapt the attach-scope fixture to main's scratch-folder cleanup after reproducing the integration guard failure.
- [x] Run all attach scope, launcher and marketplace suites with `--test-concurrency=4`, using temporary files inside this checkout. After the initial run exposed the scratch-folder guard failure, rerun all affected suites and prove cleanup in a fresh TMPDIR.
- [x] Run `npm run build` for typecheck.
- [x] Save command logs and structural verification in `docs/evidence/2026-11-03-marketmerge/`.
- [x] Review the resolved merge, confirm no unresolved markers or new whitespace errors, and verify main's report and version exactly.

After verification, commit the two-parent merge, verify the clean worktree and parents, and print `MARKETMERGE READY` followed by the commit SHA.
