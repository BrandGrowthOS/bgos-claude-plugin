# Threads hardening round 4

Scope: the P1 and two P2 findings in `~/.bgos-reviews/threadsfix3.md`, starting at `8dd14049afd59f690f779055ee51ac5138dc07ac` on `fix/threads-hardening-2`.

## Plan and constraints

Work stays in this checkout. Each finding gets a failing regression first, its smallest implementation fix, affected tests, and one commit. No push or production access. Test commands use at most four workers and a temporary directory under this checkout's ignored `node_modules/.cache/threadsfix4`.

- [x] P1: replace the environment block list in `lib/stream-json-child.ts` with one explicit allow list for runtime and Claude authentication. Test fabricated AWS, GitHub, and unknown tokens against the real spawner; run a real Claude child with local scripted responses and isolated test credentials.
- [ ] P2: reserve the root in `exiting` while `sweepClosed` removes it. Pause removal in a regression, reopen concurrently, and verify startup waits and recreates the removed worktree and transcript safely.
- [ ] P2: distinguish unknown stamp inspection from confirmed absence or a different process. Test helper failures and manager replacement, delete, and sweep; retain uncertain identity and permit progress after inspection recovers.
- [ ] Run all affected suites and typecheck. Record red and green evidence, inspect the final diff, and verify the three commits and clean status.

## Evidence

### P1: child environment

`LANE_CHILD_ENV_VARS` is the single allow list. It admits runtime paths, locale, TLS roots, Claude configuration, and these explicit Claude authentication variables: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`. `ANTHROPIC_BASE_URL` selects the endpoint. Everything not listed is dropped, including BGOS identity/state settings, parent session variables, `NODE_OPTIONS`, AWS credentials, GitHub credentials, and unknown tokens.

The regression tests were red before the fix. [p1-red.log](docs/evidence/threadsfix4/p1-red.log) records three failures: unwanted BGOS settings, extra environment entries, and an AWS variable surviving into a real spawned process. [p1-claude-red.log](docs/evidence/threadsfix4/p1-claude-red.log) records the installed Claude initializing and its sandboxed Bash exposing the fabricated AWS access key before the fix.

[p1-green.log](docs/evidence/threadsfix4/p1-green.log): 39 tests passed across stream/environment, real Claude sandbox, aside, and real process suites. The Node child regression checks every fabricated AWS/GitHub/unknown variable is absent. The real Claude test uses the production spawner, isolated HOME/config, a local scripted API, and dummy authentication. It initialized, ran three Bash checks, read its attachment, refused a future credential file, and exposed none of the fabricated credentials. No real model service or production agent was used.

P1 typecheck: `./node_modules/.bin/tsc --noEmit` exited 0. See [p1-typecheck.log](docs/evidence/threadsfix4/p1-typecheck.log).
