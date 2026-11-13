# Mission goal checks carry evidence

Carried PR #279 from feat/mission-goal-checks through f728516 onto base 4630d76, preserving all four source commits in one final commit. Plugin version: 0.86.1.

## Verification

- Full plugin suite: 9952 passed, 0 failed, 58 skipped across 464 files in 714.0 seconds. Node and Bun families both completed. Four workers maximum; runner, Chromium and daemon groups run serially as configured by the existing runner.
- Focused tests: 317 passed. Baseline focused tests: 187 passed. TypeScript: npm run build passed.
- Seven targeted mutations caught by assertion failures, with an unmodified passing control. Run `node docs/evidence/2026-11-06-missions279/mutations.mjs` after installing dependencies to reproduce. The rig modifies only disposable copies under node_modules/.cache/missions279.
- Red evidence precedes production edits and review fixes. Logs retain test results without workstation paths or credentials. The first imported hook test constants were corrected before the green run; their definition errors are excluded from the selected feature failures.

## Port decisions

- Goal check objects and every key pass through create, set and add. Server check grammar stays on the server.
- Current main's waiting tool and working tracker stay in place. Waiting accepts the original flat input and PR #279's nested object/null form, using the same validation and actor headers. Mixed input forms are refused.
- Current main's private tool guards, Artifact/email tools, working selection and thread cleanup remain intact.
- Prompt/Stop hooks are installed for marketplace and clone setups. They use the session's own daemon, ask only about that turn's recorded chat, block once, and fail open on missing answers or errors. Source fixes retain fresh results, reject expired asks and preserve replacement asks.

## Review findings resolved

- Preserve check, doneBy and validated waiting fields through WebSocket parsing, including routine working-goal updates. Sanitize the newly displayed fields in owner-created mission notices.
- Cache snapshot goals only under an explicit snapshot or event-envelope chat id. A legacy snapshot with no chat identity cannot borrow a recipient's live turn chat.
- Reconcile cached passing goals against surviving goals after cancellation.
- Evict old chats by serialized byte size as well as chat count so twenty-goal missions fit the file reader's bound.

An independent read-only review approved these fixes with no remaining findings. The parent agent ran all tests. An unchanged Chromium popup-selection case failed once during a full run, then all seven cases in that file passed on isolated retry; the final full run passed without retry.

## Reproduction

```sh
npm ci --cache .laneenv6-tmp/missions279/npm-cache --no-audit --no-fund
mkdir -p .laneenv6-tmp/missions279/tmp
TMPDIR="$PWD/.laneenv6-tmp/missions279/tmp" TSX_DISABLE_CACHE=1 RUN_TESTS_WORKERS=4 npm test
npm run build
node docs/evidence/2026-11-06-missions279/mutations.mjs
```

All installation caches and temporary fixtures were inside this checkout. A completed full run passed all tests but returned nonzero because tsx left 627 new compilation-cache paths inside the checkout. The final run disables that cache with TSX_DISABLE_CACHE=1 and also passes the runner's working-tree cleanup check. A subsequent attempt suffered simultaneous roughly 900 second stalls and watchdog timeouts, so the final command runs under a temporary caffeinate idle-sleep inhibitor on macOS. A temp root beneath node_modules caused an existing installation test to classify a simulated clone as a package install; moving the temp root out of that directory made all 111 doctor tests pass without a code change.

## Environment limits

The suite's 58 skips are reported, not counted as executed checks. Reasons observed:

- (no reason supplied)
- BGOS source checkout not present; local committed pin is always checked
- HOAI_BROWSER_SHIM_SOURCE is not set: the BGOS tree is a separate repo and is not on this runner, so the cross-tree hash cannot be checked here
- Set HOAI_KEYCHAIN_REAL_TEST=1 on a Mac to run against a throwaway keychain.
- Set HOAI_PROFILE_SYNC_CRYPTO_SOURCE to the shared committed or review source until vendoring lands.
- Windows only
- Windows only (the mocked cases above run everywhere)
- Windows processes and the Windows console
- an 8.3 name and a drive letter exist on Windows only
- powershell parser check runs on Windows
- set BGOS_CLAUDE_CAPABILITY_TOKENS_SOURCE to BGOS backend/src/integrations/claude-capability-tokens.ts
- set HOAI_BROWSER_HOST_CORE_SOURCE to the BGOS agent-browser directory
- the helper drives the Windows console API
- the proof script is PowerShell

No publish, push, deployment or production call was made. No BRIEF or REPORT file belongs to this commit.
