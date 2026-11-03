# Threads hardening round 5

Scope: the two P2 findings in `~/.bgos-reviews/threadsfix4.md`, on branch `fix/threads-hardening-2`. Project changes, test temporary files and evidence stay in this folder. No production access or push is part of this work. Existing local dependencies are sufficient. Every test command uses at most four workers.

## Finding 1: queued reopen after cleanup

The old startup code invalidated a saved fork only when it found an active cleanup promise. Cleanup could finish while both process slots were occupied, leaving a queued lane with the deleted fork ID and no cleanup promise to wait on.

Startup now checks for the missing state file after awaiting any cleanup, whether or not that promise still exists. It clears the stale fork and PID fields before preparing a new worktree. The check remains before the closed-lane early return. Successful cleanup also clears those fields on any queued reopened lane, so another close or a delayed reply delivery cannot persist the deleted fork again. An orphan that cannot safely be stopped still prevents cleanup and keeps its state.

The regression was written first and was red before the fix. It fills both slots, pauses cleanup of thread 101, queues its reply with the old fork, completes cleanup, and only then releases a slot. It asserts a new main-session fork, a copied main transcript, delivery of the queued prompt, and persistence of the new fork. Both sweep and explicit deletion exercise this ordering. The fresh-eye review identified the queued close and delayed-delivery variants. Both were reproduced with failing tests before the cleanup refinement.

Evidence:

- `docs/evidence/threadsfix5/baseline.txt`: 91 existing manager and stream tests passed before edits.
- `docs/evidence/threadsfix5/finding-1-red.txt`: both new tests failed with the deleted fork UUID in `--resume` instead of the main UUID.
- `docs/evidence/threadsfix5/finding-1-intermediate.txt`: moving invalidation after the closed-lane return exposed the existing close-during-sweep regression, 82 passed and 1 failed. Keeping the original early-return ordering resolved it.
- `docs/evidence/threadsfix5/finding-1-green.txt`: all 83 manager tests passed, including both new regressions and the existing immediate reopen, concurrent close, overlapping sweep and unknown PID-stamp cases.
- `docs/evidence/threadsfix5/finding-1-review-red.txt`: the original two queue tests passed, while a queued close and a delayed delivery each restored the old fork and failed.
- `docs/evidence/threadsfix5/finding-1-review-green.txt`: all 85 manager tests passed after successful cleanup also invalidated queued state.

Commands, from this folder:

```sh
TMPDIR="$PWD/.threadsfix5-tmp" node --import tsx --test --test-concurrency=4 test/thread-lanes.test.ts test/stream-json-child.test.ts
TMPDIR="$PWD/.threadsfix5-tmp" node --import tsx --test --test-concurrency=4 --test-name-pattern='a reopen queued behind busy slots' test/thread-lanes.test.ts
TMPDIR="$PWD/.threadsfix5-tmp" node --import tsx --test --test-concurrency=4 --test-name-pattern='a reopen queued behind busy slots|late delivery cannot' test/thread-lanes.test.ts
TMPDIR="$PWD/.threadsfix5-tmp" node --import tsx --test --test-concurrency=4 test/thread-lanes.test.ts
```

## Finding 2 and final verification

The proxy and certificate environment fix, its red and green evidence, the final thread-suite run, typecheck and final review will be recorded in the second finding's commit.
