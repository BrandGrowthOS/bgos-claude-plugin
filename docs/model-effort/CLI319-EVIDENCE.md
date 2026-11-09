# Claude Code 2.1.319 picker evidence

Baseline: `3bf390a`. Red-test commit: `38f6f11`.

## Red first

Command: `bun test --max-concurrency=2 test/model-effort-cli319.test.ts`.

At the tests-only commit: 2 pass, 5 fail. The failures were:

- Empty fresh and after-turn prompts: expected empty, got unknown.
- The exact switch question: expected success, got not_confirmed.
- A switch question without a newer matching status: expected one confirmation response after submission, got none.
- Exact-id catalog: the required exact ids were absent.
- Exact model apply: expected success, got unsupported_value.

The other-dialog and uncertain-cursor refusal cases already passed.

The final sanitized crops were also checked directly against the immutable reader at `3bf390a`: both `afterTurn` and `settled` return unknown there and empty with the fixed reader and terminal cursor. The original catalog yields 3 aliases from the installed help; the fixed catalog yields 22 exact ids.

## Transport

`node --import tsx --test --test-concurrency=1 test/model-effort-tmux-rig.test.ts`: 10 pass, 0 fail. Each private tmux server uses a socket inside the checkout's temporary folder. All are cleaned up by the test. The new case uses the terminal cursor, model-switch confirmation and the real status bridge for two distinct Opus releases and an effort change.

## Captured screens and installed catalog

The five supplied captures were read as source material only. The tests retain the three composer rows or the model question, with headers, paths and session links removed. Both captured blank after-turn prompts are unknown without the cursor and empty with a visible cursor at column 2 on the prompt row. The typed literal remains a draft. The fresh dim hint remains unknown under the brief's strict blank-row condition.

A manual probe against the recorded switch screen returned false before the capture correction: its explanation and target-specific Yes choice differ from the brief's shorthand. The corrected reader requires the recorded explanation, the same known target in both places, Yes selected, and no other UI below it. The transaction also checks that target against its selection.

`claude --version` reports 2.1.319. Its baked registry contains 22 records with id, family and display_name. Those factual names were copied into frozen literal and label tables. The four ids named in the brief and the other registry releases, including Haiku and Mythos, are distinct selectable rows. No provider prefixes, arbitrary binary strings or user text are accepted as model commands.

## Full validation

The final focused six-file Bun run passed 80 tests, 0 fail, including the actual captures and all registry literal guards. The final capture and catalog cases also passed in the full mixed-suite run. Type checking passed.

The direct command `bun test --parallel=2 --max-concurrency=2 --timeout=120000 --no-orphans` was attempted. It produced 1363 pass lines and 8 failures before being stopped: Node mock incompatibilities and lane timeouts in unchanged files. It did not complete the suite. This repository explicitly partitions Node tests and Bun tests in `scripts/run-tests.mjs`; the final whole-suite result uses that runner with `RUN_TESTS_WORKERS=2`. The complete mixed run reported **11,625 passed, 0 failed, 62 skipped, 513 files**, in 2072.0 seconds. Node files used at most two workers; browser and daemon files ran serially; the Bun family used two file workers.

The full runner exited 1 solely because its working-tree artifact guard saw 218 new `tsx` compiler-cache files under the required in-checkout temporary folder. There were no other new paths and no failed test files. The cache was moved into the local dependency cache and linked from its original temporary location. Rechecking the exact snapshot guard against the original reported additions then found **0 new paths**.

With that cache layout, a final Node run over all ten model-and-effort test files passed **153 tests, 0 failed, 0 skipped**, exit 0. A before/after snapshot using the repository's artifact guard again found **0 new paths**, including after fresh compilation and the real tmux cases. The original full-run log retains its cache-only exit failure; it is not represented as an exit-0 run.

`./node_modules/.bin/tsc --noEmit` passed after the final source changes. `git diff --check` passed. Dependencies were installed with `bun install --frozen-lockfile` using a cache inside the checkout. Runtime versions: Node 26.4.0, Bun 1.3.14, TypeScript 6.0.2.

## Code map and scope

The requested `node scripts/codegraph/query.mjs <file>` was attempted before each edited source, test and report file. The script is absent from this checkout, so each exits with MODULE_NOT_FOUND. No graph guard, mirror, test or contract names can be returned. `origin/main` is also absent locally. No fetch was attempted.

The manual dependency review covers the injection literal guard, pane reader, control transaction, catalog, RPC result, picker contract, original tests and real tmux transport mirror. Their relevant tests and fixtures are included in this change. Before the last commit, `node scripts/codegraph/query.mjs --changed origin/main` was also attempted and failed with MODULE_NOT_FOUND. A separate ref check confirmed that `origin/main` is absent. No graph-named dependency could be returned to add; the manual review and corresponding guards, mirror, tests and contract above provide the available coverage.

The brief's explicitly named captures and the installed CLI were read only as inputs. All authored content, dependencies, temporary folders and test logs stay inside this checkout. Public evidence omits machine paths and raw host-specific test output. All 22 exact ids come from the installed CLI's registry; no release id is inferred from a family alias.
