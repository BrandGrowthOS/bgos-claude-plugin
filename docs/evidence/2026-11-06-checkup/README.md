# Watcher checkup verification

Prepared plugin version: 0.85.6. Base: `d5ea580`.

See [the job contract](../../checkup/watcher-job.md) for the repairs, confirmation fields and reporting boundary. [history.txt](history.txt) records why PR #273 was closed and confirms that its head was integrated into main.

| Check | Result | Evidence |
|---|---|---|
| Initial tests before implementation | 96 passed, 10 failed as expected | [red.txt](red.txt) |
| Review tests before the two final fixes | 33 passed, 2 failed as expected | [red-review.txt](red-review.txt) |
| Focused classifier, watcher and worker-limit tests | 112 passed, 0 failed | [focused.txt](focused.txt) |
| Unchanged lane, mission and rollback checks on CI runtime | 80 passed, 0 failed | [environment-review.txt](environment-review.txt) |
| Full plugin suite | 9,900 passed, 0 failed, 58 skipped, 459 files (1050.6 s) | [full-suite.txt](full-suite.txt) |
| Typecheck | `npm run build`, exit 0 | [typecheck.txt](typecheck.txt) |
| Source equality | 1,525 matching repository files | [source-tree.txt](source-tree.txt) |
| Resource cap | 2 file workers, niceness 20 | [resources.txt](resources.txt) |

The full run uses Node 24.22.2, matching CI's Node 24 major, and Bun 1.3.14. The official Node archive was installed in the workspace and checked against its SHA-256 checksum. The original Mac runtime, Node 26, reversed the arrival order of two parallel HTTP requests in an unchanged mission test. No mission code or assertion was changed.

All work stayed in the workspace. The full suite ran from a temporary nested worktree with identical final sources and shared installed dependencies. Its scratch folder was a sibling inside the workspace, outside the test checkout. This preserves the existing rollback test's guard against in-tree scratch files. An earlier run from the primary checkout also detected a thread-probe scratch file there. The final runner still checks its own working tree for new paths; that check was not bypassed.

The nested shell did not inherit Bun availability. Bun 1.3.14 was made available in the workspace and supplied explicitly to the final run. The lane fixtures passed before restarting the full suite. Temporary diagnostic edits were restored, and the source comparison was repeated successfully.

The full-suite command, run from that nested checkout, was equivalent to:

```sh
mkdir -p "$CHECKUP_WORKSPACE/.checkup-tmp"
nice -n 10 env \
  PATH="$CHECKUP_WORKSPACE/node_modules/.checkup-runtime24/bin:$CHECKUP_WORKSPACE/node_modules/.checkup-bun/bin:$PATH" \
  BUN_INSTALL="$CHECKUP_WORKSPACE/node_modules/.checkup-bun" \
  TMPDIR="$CHECKUP_WORKSPACE/.checkup-tmp" \
  NODE_COMPILE_CACHE="$CHECKUP_WORKSPACE/node_modules/.checkup-node-cache" \
  TSX_DISABLE_CACHE=1 \
  npm_config_cache="$CHECKUP_WORKSPACE/node_modules/.checkup-cache" \
  RUN_TESTS_WORKERS=2 npm test
```

`CHECKUP_WORKSPACE` denotes the enclosing task folder. The focused command uses `node --import tsx --test --test-reporter=tap --test-concurrency=2` with `test/agent-checkup.test.ts`, `test/watcher-checkup.test.ts` and `test/run-tests-worker-limit.test.ts`. Both red runs used the same explicit limit of two workers.

The evidence files contain selected result lines, file results and counters. Raw logs remain in the local dependency folder. No production repair or live app confirmation flow was exercised. The watcher tests use an in-memory filesystem, fake backend and real-OS sentinel. Existing tests and assertions remain intact; no new skip or focus was introduced.
