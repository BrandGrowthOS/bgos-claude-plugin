# Test suite litter guard

Board row 92946637. Codex lane for Ares (agent 1040).

Before: `npm test` ran both test families without inspecting the working tree afterwards. Git status cannot show every leftover: ignored files and folders containing only an empty `.git` can escape it.

After: `scripts/run-tests.mjs` takes filesystem path snapshots before and after both test families. Every surviving new path is named, and any new path fails the run even if the child runners passed. Directories themselves are recorded, including empty directories and nested `.git` entries. Git internals and dependency contents are skipped, and links are recorded without following their targets. A scan error also fails the run. Existing paths form the baseline; this check does not compare file contents.

`test/idle-update.integration.test.ts` now makes its nine scratch homes under `os.tmpdir()` using `mkdtempSync`. Its existing `finally` blocks remove each home on success or assertion failure.

## Proof

- Base: `f47fd6adb2460bcbbe46209f2f0ff241a9833d15`, which includes PR #301. No whole-run guard existed at that commit.
- A throwaway passing test left `litterguard-red-proof.backup` and `litterguard-red-proof/.git`. The full run exited 1 and explicitly named all three new paths, including their parent directory. Before and after scans took 84 ms and 81 ms. The throwaway and its artifacts were removed before this commit.
- Six permanent checks cover ignored files, empty nested repos, symlink cycles, failed scans, existing files, and successful or failing child runners leaving new paths. They execute the real orchestrator in disposable fixtures with stand-in child runners, without starting another full suite or installing packages.
- The PR body and lane report contain the two full runs on this committed tree, their totals, and their comparison against the unchanged base.

## Local environment

Full runs use Linux Node 24.22.1 and Bun 1.3.14 through WSL, each detached and queued through `heavy timeout 1800 npm test`. No packages were installed. This checkout's installed dependencies had Windows shims and esbuild, so an external POSIX tsx shim and `ESBUILD_BINARY_PATH` use those existing files through Linux Node and WSL interop. That environment is identical for baseline and patched runs.

The baseline had four private-turn assertion failures, ten Chromium failures due to the missing Linux browser, and one cancelled OS-store cleanup test. Those tests are outside this change. The lane report names every failing case and records any further base reproductions needed for timing failures.

Local logs and the report are under `E:\bgos-worktrees\_tmp\litterguard`. OS temp leftovers are reported there without changing unrelated tests.
