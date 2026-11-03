# Threads hardening round 4

Scope: the P1 and two P2 findings in `~/.bgos-reviews/threadsfix3.md`, starting at `8dd14049afd59f690f779055ee51ac5138dc07ac` on `fix/threads-hardening-2`.

## Plan and constraints

Work stays in this checkout. Each finding gets a failing regression first, its smallest implementation fix, affected tests, and one commit. No push or production access. Test commands use at most four workers and a temporary directory under this checkout's ignored `node_modules/.cache/threadsfix4`.

- [x] P1: replace the environment block list in `lib/stream-json-child.ts` with one explicit allow list for runtime and Claude authentication. Test fabricated AWS, GitHub, and unknown tokens against the real spawner; run a real Claude child with local scripted responses and isolated test credentials.
- [x] P2: reserve the root in `exiting` while `sweepClosed` removes it. Pause removal in a regression, reopen concurrently, and verify startup waits and recreates the removed worktree and transcript safely.
- [x] P2: distinguish unknown stamp inspection from confirmed absence or a different process. Test helper failures and manager replacement, delete, and sweep; retain uncertain identity and permit progress after inspection recovers.
- [x] Run all affected suites and typecheck. Record red and green evidence and inspect the final diff. Keep one commit per finding on the requested branch.

## Evidence

### P1: child environment

`LANE_CHILD_ENV_VARS` is the single allow list. It admits runtime paths, locale, TLS roots, Claude configuration, and these explicit Claude authentication variables: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`. `ANTHROPIC_BASE_URL` selects the endpoint. Everything not listed is dropped, including BGOS identity/state settings, parent session variables, `NODE_OPTIONS`, AWS credentials, GitHub credentials, and unknown tokens.

The regression tests were red before the fix. [p1-red.log](docs/evidence/threadsfix4/p1-red.log) records three failures: unwanted BGOS settings, extra environment entries, and an AWS variable surviving into a real spawned process. [p1-claude-red.log](docs/evidence/threadsfix4/p1-claude-red.log) records the installed Claude initializing and its sandboxed Bash exposing the fabricated AWS access key before the fix.

[p1-green.log](docs/evidence/threadsfix4/p1-green.log): 39 tests passed across stream/environment, real Claude sandbox, aside, and real process suites. The Node child regression checks every fabricated AWS/GitHub/unknown variable is absent. The real Claude test uses the production spawner, isolated HOME/config, a local scripted API, and dummy authentication. It initialized, ran three Bash checks, read its attachment, refused a future credential file, and exposed none of the fabricated credentials. No real model service or production agent was used.

P1 typecheck: `./node_modules/.bin/tsc --noEmit` exited 0. See [p1-typecheck.log](docs/evidence/threadsfix4/p1-typecheck.log).

### P2: sweep and reopen ownership

The sweep reserves the root in the existing `exiting` map before awaiting removal and releases it in `finally`. Reopen startup already waits on this map, and close now also waits for its previous owner before loading or mutating state. After successful removal, startup drops the obsolete fork/PID references, recreates the worktree, and forks main with a fresh copied transcript. An overlapping sweep skips a reserved root.

Both regressions were red before the fix: [p2-sweep-red.log](docs/evidence/threadsfix4/p2-sweep-red.log) shows a child starting during paused removal, and two overlapping sweeps both removing the same root. The reopen test also verifies the recreated folder, state/PID, fresh fork arguments, transcript, and delivered answer after removal completes.

Independent review identified a third ordering within this finding: closing during the paused sweep could replace its ownership marker and permit an early reopen. The new regression was red before the correction ([p2-close-red.log](docs/evidence/threadsfix4/p2-close-red.log)), showing one child starting during removal. Waiting for existing ownership in close addresses it in this same finding's commit.

[p2-sweep-green.log](docs/evidence/threadsfix4/p2-sweep-green.log): 81 tests passed across the manager and real Git suites, including all three new overlap regressions.

### P2: uncertain process stamps

`processStamp` now returns a stamp for an identified live process, `null` for confirmed absence or a zombie, and `undefined` for failed inspection of a possibly live process. A failed read uses a signal-0 existence check; only `ESRCH` proves absence. Recovery keeps the saved PID/stamp on an unknown result, refuses replacement/removal, and never signals an unverified identity. Polling after SIGTERM also requires affirmative exit; a failed poll cannot authorize SIGKILL. Initial PID persistence keeps its existing null stamp until a real stamp is available.

All 11 new regressions were red before the fix: [p2-stamp-red.log](docs/evidence/threadsfix4/p2-stamp-red.log). They cover unavailable, failed, timed out, empty and malformed `ps` output; unreadable/malformed Linux stat; stamped recovery during replacement, delete and sweep; and inspection lost after SIGTERM. The manager cases verify retained state and folder, no replacement, no unverified signal, and progress when identity or absence is established later.

[p2-stamp-green.log](docs/evidence/threadsfix4/p2-stamp-green.log): 100 manager and process tests passed. Helper tests use the current live test process for failed inspection and a nonexistent PID for confirmed absence; real process tests also cover start stamps, cwd, group termination and event-loop responsiveness.

## Final validation

The affected suite command was:

```sh
TMPDIR="$PWD/node_modules/.cache/threadsfix4" \
THREADS_SANDBOX_CLAUDE="$(command -v claude)" \
./node_modules/.bin/tsx --test --test-concurrency=4 \
  test/aside-fork.test.ts test/stream-json-child.test.ts \
  test/lane-process.test.ts test/thread-lane-args.test.ts \
  test/thread-lane-sandbox.test.ts test/thread-lanes.test.ts \
  test/thread-lanes.git.test.ts test/thread-lanes-wiring.test.ts \
  test/threads-cli.test.ts test/voice-rpc-threads.test.ts
```

Result: 193 passed, 0 failed, 0 skipped. Full output: [final-affected.log](docs/evidence/threadsfix4/final-affected.log). This includes real Git, real child/process handling and the installed Claude 2.1.317 with a local scripted API. No dependencies needed installation. Runtime was Node v26.0.0, tsx v4.23.0 and TypeScript v6.0.3.

Final typecheck: `TMPDIR="$PWD/node_modules/.cache/threadsfix4" ./node_modules/.bin/tsc --noEmit` exited 0, with no diagnostics. See [final-typecheck.log](docs/evidence/threadsfix4/final-typecheck.log). `git diff --check` passed. These final checks were rerun after the close/sweep correction.

The requesting-code-review skill's independent reviewer inspected the source and red/green evidence without running tests or changing files. It identified the close/sweep ownership interaction described above, then re-reviewed the correction and found no remaining important defects in scope. No additional important defect was found in the environment or process-stamp changes.

Commit split on `fix/threads-hardening-2`:

- `8f6fc2fcf82ad69b8f0edfd2db2301742052b40b`: P1 child environment allow list and regressions.
- `7fa8ddaa6349db0140b5fb6152a970baa5339be5`: P2 sweep/reopen ownership, including close during sweep, and regressions.
- The commit containing this final report update: P2 unknown stamp handling, regressions, and final evidence.

No push, production modification, or real provider authentication was performed.

Scope of evidence: the manager race/recovery scenarios use injected process and Git dependencies to control timing; the real Git and process suites validate those boundaries separately. The Claude test proves thread-mode child startup and sandbox behavior, not an end-to-end production daemon or authenticated remote-model run. Linux stat cases are injected on macOS; no Windows host or Linux sandbox was exercised. The unrelated full repository test suite was not run.
