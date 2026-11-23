# Permission card hidden characters

The raw Bash command is available in `PreToolUse.tool_input.command`. The plugin now uses that copy for the permission card when it can confirm the whole command against the CLI preview in the daemon's admitted session. Version: 0.86.20.

## Evidence and input path

`server.ts` registers `notifications/claude/channel/permission_request` with `request_id`, `tool_name`, `description`, and optional `input_preview`. Previously, `relayPermissionToOwner` passed that preview straight to `buildPermissionRequestBody` in `lib/permission-relay.ts`; `permissionCardTool` trims its outside whitespace and caps it at 2000 characters. Those steps do not explain missing characters inside the command. The preview loss in the brief occurs before this handler receives it.

`node scripts/probe-permission-input.mjs` runs the installed Claude Code 2.1.319 against a loopback canned model response, with a synthetic API key and isolated config and scratch files inside this checkout. Its hook receives real CLI stdin and denies the tool, so the command never executes. The fixture in `docs/evidence/2026-11-09-permhidden/payload.json` records the model command and actual `PreToolUse` fields. Only machine paths and the generated session envelope are omitted. The tool use id is the synthetic id supplied by the canned response. Unicode escapes make the invisible characters legible in the fixture.

Both copies contain exactly 227 UTF-8 bytes: one each of U+200B, U+2060, and U+202E, plus 60 U+2028 characters. The regression replays that recorded input through the production synchronous hook, the actual notification handler and interactive relay extracted from `server.ts`, and the production request builder. Its channel preview is a test reconstruction of the space substitution described in the brief, not a captured channel notification. The posted JSON body is serialized and decoded before its command bytes are compared. `red.log` shows the original code losing those bytes; `green.log` shows the corrected path and fallback cases.

No `PermissionRequest` hook or transcript reader is needed. The existing async telemetry forwarder also receives `tool_input`, but its spool can arrive after the permission notification and oversized payloads clip fields. The already synchronous `hoai-floor-hook.mjs` sees Bash input first in both clone and marketplace installs, including unlisted commands. No hook registration or install mirror changes are required.

## Change and limits

`lib/permission-input.mjs` retains short lived command copies under the plugin state root, keyed by project folder, session and tool use. Files are mode 0600 and directories mode 0700 on POSIX. The queue holds at most 64 records per key and a command is limited to 64 KiB. Old records are swept on access. A copy older than 120 seconds is unusable.

The relay requires a known admitted session and valid preview JSON with a string `command`. It compares the entire command after folding display whitespace and the three observed format controls. It never uses the floor's partial probe or oldest-record fallback for display text. Redaction, elision, unrelated text, a different session, invalid records, and ambiguous folded commands all keep the preview. Ambiguous candidates are consumed together, and a unique copy must be deleted successfully before use. Only the command value is restored; other preview fields remain as supplied by the CLI. Plain commands keep their existing preview formatting. Permission decisions, email bindings and floor checks still use their existing inputs.

The existing 2000-character card cap and floor evidence lead remain in force. Commands beyond those limits can still be visibly truncated. Calls that run without asking can leave a copy until expiry or queue eviction; a later indistinguishable call conservatively falls back rather than selecting one. If the session has not yet been admitted or the synchronous hook is unavailable, the preview is retained. No live HOAI backend or app was contacted in this run.

## Validation

The original byte comparison failed before production changes, while the absent-record fallback passed. The focused permission and floor run passed 71 tests. TypeScript checking passed with no diagnostics. The offline browser shim hash check and shipping-version advance check passed.

The first full run completed all 505 files: 11415 tests passed, zero failed, and 62 skipped. Its command nevertheless exited 1 because the runner's final cleanliness check found 214 new compiler-cache files under the temporary directory inside the checkout: 213 TSX files and one Node compile-cache file. An attempted rerun with temporary data under `node_modules` was stopped after a launcher topology fixture treated that ancestor as an npm install and misclassified its simulated clone. No production or test code was changed to accommodate either setup issue.

The original temporary path with `TSX_DISABLE_CACHE=1` passed the launcher and runner checks: 150 tests, zero failures. The final full run used that environment, a local npm cache under `node_modules`, two file workers, and nice priority 15 on macOS with Node 26.4.0 and Bun 1.3.14. It completed all 505 files in 1959.3 seconds: 11414 tests passed, one failed, and 62 skipped. The cleanliness check reported no new paths.

The full command exited 1 for `test/catch-up-after-deploy.e2e.test.ts:638`: the case "the read a live message waits for fails" expected WebSocket delivery (`ws`) and observed polling (`poll`). The same file passed all 32 tests in the first full run. An isolated rerun under the final environment passed all 32 tests with no code changes. This is recorded as an intermittent reconnect assertion; inbound message routing is outside this permission-card change and was left unchanged. The final native CLI probe also passed again on 2.1.319, preserving the same 227 command bytes and denying execution.

`full-suite.log` contains the earlier setup outcomes and the final per-file results, skip reasons and totals; successful TAP bodies are omitted. `green.log` includes the isolated reconnect rerun as well as the permission and environment checks. The full-suite failure is retained rather than reported as a green command.

## Code map and related contracts

Every edited source, test, metadata, report and committed evidence path was submitted to `node scripts/codegraph/query.mjs <file>` before editing. This checkout contains no `scripts/codegraph` directory or query script. Each attempt fails with `MODULE_NOT_FOUND`. Before the final commit, the exact required command `node scripts/codegraph/query.mjs --changed origin/main` was run and exited 1 for the missing script. `git show-ref --verify refs/remotes/origin/main` exited 128: that ref is also absent. The query therefore produced no guard, mirror, test or contract names. The actual errors are recorded in `code-map.log`; the related contracts were audited directly below. No remotes of this checkout were fetched or pushed.

Related guards were inspected directly: `test/hoai-floor-hook.test.ts`, `test/floor-state.test.ts`, `test/floor-check.test.ts`, `test/permission-relay.test.ts`, `test/permission-card-owner-chat.test.ts`, `test/permission-card-email-send.test.ts`, `hooks/hooks.json`, `lib/claude-preseed.mjs`, and `scripts/check-version-bump.mjs`. The floor wiring guard was updated to follow the enriched card parameters. Existing hook behavior, floor records, email permissions, owner placement, install registrations, and the pure request builder need no changes; their existing tests are retained. The new regression covers raw input storage and the posted request body. Package, lockfile and plugin manifest versions advance together for the shipping-code version guard.
