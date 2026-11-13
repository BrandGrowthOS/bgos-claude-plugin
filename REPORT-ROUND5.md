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

## Finding 2: proxy and certificate configuration

The child environment now preserves `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY`, `ALL_PROXY` and all four lowercase forms. The existing `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE` and `SSL_CERT_DIR` entries remain. The explicit certificate entries now also include `CLAUDE_CODE_CERT_STORE`, `CLAUDE_CODE_CLIENT_CERT`, `CLAUDE_CODE_CLIENT_KEY` and `CLAUDE_CODE_CLIENT_KEY_PASSPHRASE`.

The proxy and CA names cover the network entries in `lib/lane-core.mjs:436`, with `ALL_PROXY` and `all_proxy` added as required by the brief. The certificate additions follow [Claude Code's network configuration documentation](https://code.claude.com/docs/en/network-config), checked during this work. No wildcard or prefix-based environment copying was introduced.

An authenticated proxy URL can include a username and password. Passing that URL through intentionally makes those credentials visible to the child and its tools. The client-key passphrase is also an intentionally allowed secret. These settings should be treated as credentials and kept out of logs. The tests and saved evidence use fabricated values only. AWS credentials, GitHub tokens, unknown tokens, daemon credentials, session identity, messaging bridges and `NODE_OPTIONS` remain excluded.

Both the new allow-list regression and the extended real-child regression were red before the fix. The first showed the missing proxy and client-certificate entries; the second showed `HTTPS_PROXY` absent in an actual spawned Node process. After the fix, all 11 stream tests passed, including the existing AWS, GitHub, unknown-token and process-group checks.

- Red evidence: `docs/evidence/threadsfix5/finding-2-red.txt` (9 passed, 2 failed).
- Green evidence: `docs/evidence/threadsfix5/finding-2-green.txt` (11 passed).

```sh
TMPDIR="$PWD/.threadsfix5-tmp" node --import tsx --test --test-concurrency=4 test/stream-json-child.test.ts
```

## Fresh-eye review

A separate read-only reviewer inspected the touched lifecycle and environment code. The same stale-fork problem was found in explicit deletion, a queued close after a sweep, and a delayed reply delivery that recreated the state file. All now have regression coverage in finding 1. Invalidation occurs only after the orphan guard allows cleanup, so unknown or still-live orphan processes keep their state and block removal. The reviewer checked the refinement and reported no remaining findings within this scope. The reviewer did not execute tests or change files.

The environment review confirmed exact-name copying for both capitalization forms and certificate settings, with unrelated credentials still excluded. The intentional proxy-password and client-key-passphrase exposure is documented above and in the source comment.

## Final verification

Executed on Node v26.0.0 with the existing local dependencies. The final combined run had **198 tests: 197 passed, 0 failed, 1 skipped**. The skipped test requires the opt-in `THREADS_SANDBOX_CLAUDE` real-Claude binary. Real Git integration and the real Node child/process-group tests ran. No real Claude resume, proxy-only network connection, or TLS handshake was exercised.

Typecheck passed with exit code 0. `git diff --check` passed. The final checks cover both fixes together.
Trailing whitespace emitted by Node on blank assertion-diff lines was trimmed from saved logs; test results and messages are unchanged.

Evidence:

- `docs/evidence/threadsfix5/thread-suites.txt`: final combined thread, argument, CLI, wiring, RPC, aside, process and stream tests.
- `docs/evidence/threadsfix5/typecheck.txt`: exact typecheck command and successful exit code.
- `docs/evidence/threadsfix5/thread-suites-temp-boundary.txt`: the first combined run, 194 passed, 1 failed, 1 skipped. Its extensionless fake-Claude script inherited this repository's ES-module mode because temporary files were kept inside the repository.
- `docs/evidence/threadsfix5/aside-temp-boundary-green.txt`: all 15 aside tests passed after adding a CommonJS boundary in the disposable temporary directory, matching normal system-temp behavior. No source change was needed for this test-harness issue.

Reproduce the final checks from this folder:

```sh
mkdir -p .threadsfix5-tmp
printf '{"type":"commonjs"}\n' > .threadsfix5-tmp/package.json
TMPDIR="$PWD/.threadsfix5-tmp" node --import tsx --test --test-concurrency=4 \
  test/thread-lanes.test.ts test/thread-lanes.git.test.ts \
  test/thread-lane-args.test.ts test/thread-lane-sandbox.test.ts \
  test/thread-lanes-wiring.test.ts test/threads-cli.test.ts \
  test/voice-rpc-threads.test.ts test/stream-json-child.test.ts \
  test/aside-fork.test.ts test/lane-process.test.ts
node node_modules/typescript/bin/tsc --noEmit
git diff --check
```

The disposable test directory was removed after verification. No dependencies or lockfiles changed. The branch is kept locally with one commit per finding; nothing was pushed and no production system was touched. Finding 1 is commit `e1951d49b31d9f5783d5b444d13cb87da24d71d5`. Finding 2 includes this final report and the combined verification evidence.
