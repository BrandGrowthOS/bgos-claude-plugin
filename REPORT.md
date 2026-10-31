# set_goal_working and set_goal_waiting (plugin 0.81.0)

Board row 9d7880bf, KC 1048 msg 170414 ("it is a must"). Branch `feat/set-goal-working`, committed, not pushed.

## Outcome

An agent on this plugin can now mark every mission goal it is working on, so the card animates them all at once. It can also say a goal waits on its owner or another agent. The backend and app already shipped both routes in BGOS #3575 (5.26.0); the plugin had no tool for either.

## What changed

- **`set_goal_working { goal_ids, working, mission_id?, chat_id? }`** (server.ts). It sends `PATCH integrations/assistants/:id/missions/:missionId/goals/:goalId/working` with `{ working }`, one request per goal, in the order given. It uses the same `bgosPatch` client and the same caller headers (`privateCall.headers`) as `tick_mini_goal`, `add_mission_goals` and `cancel_mission_goal`.
  - Every id and the flag are judged before anything is read or written, so a bad id refuses the whole call with no request. A repeated id is one goal and one request. The cap is 12, a mission's own goal cap.
  - A goal the server refuses (a ticked goal, a paused mission) is named with the server's own words. The other goals are still sent, and the result is an error.
  - The refresh rule is in the description, the result text and the instructions: the mark lapses after 30 minutes, so call again within 30 minutes for every goal still being worked on, and send `working: false` when stopping.
- **`set_goal_waiting { goal_id, on: "owner" | "agent", who, why, clear?, mission_id?, chat_id? }`**. It sends `PATCH .../goals/:goalId/waiting` with `{ waiting: { on, who, why } }`, the same pattern.
  - `clear: true` is an addition to the brief's schema. It sends `{ waiting: null }`. Without it an agent could set a waiting mark but never take it off; the DTO and the served canon both define null as the clear.
  - The goal id and the shape are judged as the backend's `parseMissionGoalWaiting` judges them, before any request: on is owner or agent; who is 1 to 80 characters with no control or line separator characters; why is 1 to 200 characters.
- **Builders in `lib/missions.ts`:** `buildMissionGoalWorkingPath`, `buildMissionGoalWaitingPath`, `buildMissionGoalWorkingInput`, `buildMissionGoalWaitingBody`, `missionGoalIdError`, `MISSION_GOAL_WORKING_REFRESH_MINUTES` and `MISSION_MARK_TOOLS`.
- **Wiring, so the new tools are mission tools like the others:**
  - the turn aware admission list in server.ts;
  - `PRIVATE_TOOL_MATCHER` in all three installs (`lib/private-turn.mjs`, `lib/claude-preseed.mjs`, `hooks/hooks.json`) and its test copy. An installed settings file is repaired, not duplicated: the preseed drops the old HOAI entry and writes the new matcher.
  - `OWN_MCP_TOOLS` in `lib/hook-events.ts`.
- **Canon (brief item 3):**
  - The MCP instructions' Missions section gains item 7, naming both tools and the 30 minute rule.
  - The bundled fallback canon (`lib/capabilities.ts`) gains a Missions bullet naming both.
  - The daemon now declares `mission_goal_working` on every host (`lib/declared-capabilities.ts`). That is the token BGOS's served canon gates `MISSION_GOAL_WORKING_PARAGRAPH` on, so connected agents are now told the backend's own working mark rule.
  - Channel parity: this plugin carries no markdown mirror of the canon. The mirror (`hermes-channel-bgos/docs/bgos-agent-capabilities.md`) and the served canon live in BGOS, and the working paragraph is already there (BGOS #3575). See the follow ups below.
- **Version:** 0.80.2 to 0.81.0, a minor bump for new tools. It is set in package.json, package-lock.json (both entries) and .claude-plugin/plugin.json, with a CHANGELOG entry. `scripts/check-version-bump.mjs` against origin/main answers `ok` (see Verification).

## Tests

New file `test/goal-marks.test.ts`, 22 cases. It runs the real server.ts cases with fake HTTP helpers, using the rig `test/mission-private.test.ts` uses, so the code under test is the shipped handler.

- **Path, method and body:** one PATCH per goal id, in order, to `integrations/assistants/900/missions/77/goals/<id>/working`, with `{ working: true }` or `{ working: false }`. The waiting route gets `{ waiting: {...} }` or `{ waiting: null }`.
- **Headers:** on a share recipient's turn every request carries `X-BGOS-Acting-User`. On the owner's turn there are none, exactly as for every other mission write.
- **Refusals on a bad id:** 0, -1, 1.5, "3", "x", an empty list, 13 ids, a non boolean flag, and for waiting "3", " 3", "0x10", "1e1" and a bad on, who or why. Each is refused with the value named, and no request is sent.
- **The error surfaced:** the backend's 409 sentence reaches the agent word for word, the other goals are still sent, and the result is an error. With every goal refused, each reason is named.
- **No open mission:** no write, and a sentence that says so.
- **The self write ledger:** after a mark, the owner's Pause and Resume are still heard, and the mark's own echo is still recognised.
- **Declarations:** the schema, the 30 minute sentence in the description itself, the admission gate, the helper guard in all three installs, `OWN_MCP_TOOLS`, the instructions, the fallback and the declared token.

Existing tests extended:
- `test/mission-private.test.ts` and `test/turn-aware-tools.test.ts` now run both new tools through every private turn case, including a recipient's foreign `mission_id` being refused.
- `test/mission-ws-wiring.test.ts` gains a test that the mark tools take no pending stamp but do take the landed one.
- The exact declared token lists in `test/declared-capabilities.test.ts`, `test/capabilities.test.ts` and `test/version-heartbeat.test.ts` now include `mission_goal_working`.

**Red first.** Before any implementation all 19 original cases failed (`ℹ tests 19, pass 0, fail 19`). The three review cases were added red: 5 failing, 17 passing, before the fix.

## Mutations

Each mutation was applied alone to a scratch copy of the tree. The copy then ran `goal-marks`, `mission-private`, `mission-ws-wiring` and `turn-aware-tools`, and the file was restored. The baseline and the post restore run had 0 failing. **All 22 mutations were killed.**

| # | Mutation | Result |
|---|---|---|
| M1 | clear sends `working: true` | killed (1) |
| M2 | only the first goal id is sent | killed (4) |
| M3 | user family path instead of `integrations/` | killed (6) |
| M4 | caller headers dropped on the working write | killed (2) |
| M5 | stop at the first refused goal | killed (2) |
| M6 | a refusal is not an error | killed (2) |
| M7 | goal id 0 accepted | killed (2) |
| M8 | duplicate ids not merged | killed (1) |
| M9 | the refusal reason swallowed | killed (2) |
| M10 | clear sends `{}` instead of `null` | killed (2) |
| M11 | waiting goal id judged only after the mission read | killed (2) |
| M12 | caller headers dropped on the waiting write | killed (2) |
| M13 | waiting error replaced by a generic line | killed (1) |
| M14 | who limit loosened to 81 | killed (1) |
| M15 | `mission_goal_working` not declared | killed (1) |
| M16 | helper guard matcher misses `set_goal_working` | killed (3) |
| M17 | admission gate misses `set_goal_waiting` | killed (3) |
| M18 | the 30 minute refresh sentence cut from the description | killed (1) |
| M19 | pending stamp put back in `set_goal_working` | killed (3) |
| M20 | pending stamp put back in `set_goal_waiting` | killed (3) |
| M21 | waiting goal id loosened to `Number()` | killed (1) |
| M22 | line and paragraph separators allowed in who | killed (1) |

M18 survived on the first pass: the test then matched "30 minutes" anywhere in the declaration, and the schema hint still said it. The test now reads the description text itself, and M18 was rerun and killed. The M12 anchor first matched twice, because `complete_mission` shares the line; it was narrowed and rerun.

## Code review (one delegated review)

The reviewer found no blocker. It confirmed the routes, method, bodies and headers against the BGOS DTOs, the controller and `parseMissionGoalWaiting`. It confirmed the agent-only rule for `working: true` holds on the pairing route, since `missionWriteActor` answers agent. It found no missed enumeration of the mission tools.

| Finding | Severity | Disposition |
|---|---|---|
| A pending self write stamp taken for a mark is never spent, because marks only emit `mission_updated`, so the owner's next Pause or Resume (no `cleared_by`) would be swallowed as the agent's own | should fix | **Fixed.** Verified first against `lib/mission-events.ts` (`MISSION_SELF_WRITE_FRAMES`) and BGOS `mission.service.ts` (marks emit only `mission_updated`; pause and resume emit no `cleared_by`). Both tools now take no pending stamp and keep the landed stamp. A red test with the real ledger proves it, the exemption is named (`MISSION_MARK_TOOLS`), and M19 and M20 prove it. |
| `missionGoalIdError` was inserted under the cancel builder's doc comment | nit | **Fixed.** The docs are back on their functions. |
| The waiting goal id accepted numeric strings such as " 3" or "0x10" | nit | **Fixed.** `set_goal_waiting` now takes a number only, as `set_goal_working` does. Red test; M21. `cancel_mission_goal` has the same pre-existing looseness and was left as it was, out of scope. |
| who did not refuse U+2028 or U+2029, which the backend refuses | nit | **Fixed.** Red test; M22. |

The reviewer noted the same lingering pending stamp exists already after a non final `tick_mini_goal`. That is pre-existing and was not changed here; see the follow ups.

## Verification

- `npx tsc --noEmit`: clean.
- **The full suite is green: 0 failures.** The run used the same file selection and order as `npm test` (`scripts/run-tests.mjs`), with node:test files capped at 4 at a time and a realpath TMPDIR:
  - node family: 7841 tests, 7794 pass, 47 skipped, 0 fail;
  - real Chromium files: 15 tests, 11 pass, 4 skipped, 0 fail;
  - bun family: 375 tests, 374 pass, 0 fail;
  - "both families green", exit 0.

  The cap was needed because the shared Mac ran at a load average of about 30 on 18 cores, from processes outside this work. The cap was applied in a scratch copy of the runner, which differs only in the repo root line and `--test-concurrency=4`. The repo's runner is unchanged.
- Uncapped `npm test` with a realpath TMPDIR ran three times. The node family failed 2, 1 and 3 timing tests, a different set each time:
  - two in `browser-profile-downloads-failure`;
  - one in `duplicate-copy.e2e` (twice);
  - two attachment stand-down lane tests;
  - one owner browser tab test.

  Every one passed in the capped run. Run alone, `browser-profile-downloads-failure` passes 10 of 10, twice on this branch and twice on clean origin/main, and `duplicate-copy.e2e` passes 3 of 3. The bun family was 374 of 374 in every run, and all 22 goal-marks cases passed in every run.
- `duplicate-copy.e2e` "control: a session that names THIS copy as its channel" is the flake that remains, and it is in origin/main too:
  - What the test does: it boots a real daemon, sends `initialize` at 3.5 s and closes stdin at 6.5 s, on fixed timers. Under full-suite load the daemon sometimes has not answered by then.
  - On this branch, uncapped `npm test` failed it in 5 of 6 runs.
  - On clean origin/main, the same command passed once and then failed this same test (7770 pass, 1 fail) under the same load.
  - Under 18 artificial busy loops it passed 3 of 3 alone on both trees.
  - The new and changed test files cost 1 to 2 s of CPU each.
  - Nothing here points to this change.
  - With the default macOS TMPDIR, plain `npm test` fails in browser tests that compare `tmpdir()` (`/var/...`) with its realpath (`/private/var/...`). `browser-bootstrap.test.ts` fails, and `browser-profile-active-backup.test.ts` and `browser-profile-companion-backups.test.ts` fail and hang. A first plain run stalled for over 3 hours in those two files and was stopped. The same files fail the same way on clean origin/main (9 failures there), and all 54 tests in the three files pass on this branch with a realpath TMPDIR.
  - This change does not touch any browser file.
- `node scripts/check-version-bump.mjs` against origin/main: `ok: Version advances 0.80.2 -> 0.81.0.` (exit 0); package.json and plugin.json agree.
- No live call to the production backend was made. The BGOS contract was read with `git -C /Users/bgos/BGOS show origin/main:<path>` only.
- No em or en dashes in any added line.

## Follow ups (not done here)

- **BGOS served canon, Claude delta.** The working paragraph describes the HTTP route, and its Claude delta line names `create_mission`, `tick_mini_goal` and `complete_mission` only. Naming `set_goal_working` and `set_goal_waiting` there, with a `CAPABILITY_CANON_VERSION` bump and the markdown mirror, is a BGOS change.
- **The waiting paragraph is not told to this agent.** BGOS gates the waiting goals paragraph on `mission_server_checks`, which this plugin does not declare (that paragraph also covers machine checks on goals). The tool description and the MCP instructions carry the waiting rule meanwhile.
- **Pre-existing:** a non final `tick_mini_goal` also leaves a pending stamp that only a later lifecycle frame spends. A ledger `clearPending(id)` once the response lands would close it for every tool.
