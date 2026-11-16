# RESULT: check up plan, packet P2 (plugin)

Branch `feat/agent-checkup-classifier` off the plugin's main 457210c. Board row 1357b07a. Not pushed (no GitHub here); fetch the branch over ssh.

## What was built

`lib/agent-checkup.mjs`: a PURE classifier and planner. No file, process, clock or network access; `now` is a field of the observation. Its only import is the pure `lib/keepalive-plan.mjs`, whose safe table (`decideSafeMoment`) and restart budget (`decideRestartBudget`) it reuses, so the check up and the keep-alive sweep can never disagree about what is safe.

- `diagnoseAgent(obs)` returns findings, each `{ cause, code, fixable, evidence, ... }`.
- `planRepairs(findings, gates)` returns ordered actions `{ action, causes, outcome: 'planned' | 'skipped', reason, state?, ownerAction?, via?, deadlineMs? }`.
- `buildGates(obs)` builds the gates (safe moment, last restart, attempts); `checkupPass(obs)` is classify plus plan in one call, what the watcher will post as `findings` and `actions`.

## The cause table

| Cause | Code(s) | Detected from the observation | Plan |
|---|---|---|---|
| C3 daemon down, session alive | `daemon_down`, `beacon_stale` | claude alive and daemon dead; or beacon heartbeat older than 5 min while claude runs | restart (gated), verify |
| C4 dead session | `not_running` | no claude, no daemon, a supervisor or launch recipe exists | start (gated), verify |
| | `launch_failed` | launch-status outcome is a named failure (`exited-during-startup`, `plugin-root-missing`, `node-missing`, `hoai-exited-without-status`, `tmux-failed`, `gate-*`) | report only, never retried |
| | `needs_first_launch` | no claude, no daemon, no supervisor, no recipe | report only |
| C5 wedged session | `no_reply` | owner messages delivered, newer than any transcript activity, older than the 10 min wedge window | restart if the safe table allows, else `waiting_idle` with the reason |
| | `stuck_screen` | a named screen nobody can answer | same |
| C6 stale plugin | `stale_plugin` | running version below the installed, published or pending version, or below the backend floor (numeric compare) | `update`, then restart, verify |
| C7 stuck update | `job_past_deadline`, `validation_stalled`, `drain_too_long`, `staged_not_applied` | update state past its deadline or window | one `repair` (covers C6 too), then restart, verify |
| C8 expired login | `login_expired` | transcript `authentication_failed`, or launch outcome `live-but-not-signed-in` | report only, owner types /login. No restart. |
| C9 usage limit | `usage_limit` | transcript `rate_limit`, with the reset time | report only, owner waits. No restart. |

Plan order: reports (C8, C9, then C4 unfixable), then update or repair, then ONE restart or start, then ONE verify (boot hello, 75 s deadline) only if a restart or start was planned. A held restart is `skipped` with `reason` and `state` (`waiting_idle`, `failed` after 3 attempts, or `blocked`).

Rules that the tests pin:
- Never a restart or start while C8 or C9 is a finding (`blocked_by_login`, `blocked_by_usage_limit`), nor after a named launch failure or an agent never started.
- Never a restart of a live session unless `decideSafeMoment` says safe; unknown (unreadable process tree) is unsafe.
- `update` and `repair` are file level and touch no process, so only `restart` and `start` ever touch one. An unsafe moment stages the update and holds the restart.
- C5 is not also named when C8 or C9 already explains the silence.
- An unreadable process table names no C3, C4 or C5 (unknown is not a diagnosis).

## Red first proof

Commit `021634c` is the test file alone, run with the module missing: `test/agent-checkup.test.ts` fails to load (`tests 1, fail 1`). The green commit then adds the module. (Two fixtures in my own test were wrong on first green run and were corrected in the green commit: "activity 25 min ago" is after a delivery "30 min ago", which is an agent that answered, not a wedge; and an escaped dash in a regex.)

Mutants checked, each turned named rows red: drop the C8 block (3 fail), drop the C9 block (3), drop the safe gate (12), drop the restart budget (2), wedge window changed (4), do not suppress C5 when explained (1), restart for unfixable C4 (23), drop the named launch failure block (1, after adding the row below).

## Results

- `npx tsx --test test/agent-checkup.test.ts`: 64 tests, 64 pass.
- With `test/keepalive-plan.test.ts` and `test/watcher-keepalive.test.ts`: 195 pass, 0 fail.
- `npm run build` (`tsc --noEmit`, the repo's typecheck): clean.
- `npm ci` was run first (no `frontend/` or `backend/` in this repo, so no yarn step).

## Test names (test/agent-checkup.test.ts)

Healthy and unreadable: `healthy agent: no findings, no actions`; `an unreadable process table names no process cause`.
C3: `C3: a live claude with no live daemon is daemon_down, fixable`; `C3: a stale beacon heartbeat while claude runs is beacon_stale`; `C3: a fresh beacon and an unknown beacon are not stale`; `C3 plan: restart then verify, when the safe table says safe`; `C3 plan: a turn in flight holds the restart as waiting_idle with the reason`.
C4: `C4: no claude and no daemon is not_running, fixable with a supervisor`; `C4: a launch recipe is as good as a supervisor`; `C4 plan: a dead session is started, then verified`; `C4: a named launch failure is reported, never retried in a loop`; `C4: a launch that is merely starting or waiting is not a failure`; `C4: no supervisor and no recipe is needs_first_launch, reported not started`; `C4: live-but-not-signed-in is the login cause C8, not a dead session`.
C5: `C5: owner messages delivered and no transcript activity for the wedge window`; `C5: delivered less than the wedge window ago is a think, not a wedge`; `C5: transcript activity after the delivery is an agent that answered`; `C5: nothing delivered means nothing is owed`; `C5: an unanswerable screen is stuck_screen, with the screen named`; `C5 plan: a wedged idle session is restarted and verified`; `C5 plan: it looks busy, so it is not interrupted (waiting_idle, reason named)`; `C5: a silence that the login or the usage limit explains is not also called a wedge`.
C6: `C6: a daemon running below the installed version is stale_plugin`; `C6: the published version counts when it is newer than the installed one`; `C6: versions compare as numbers, not text (0.9.0 is below 0.10.0)`; `C6: a running version at or above everything known is current`; `C6: a restart the daemon says is pending, and the backend floor, also name it`; `C6: an unparseable version is unknown, not stale`; `C6 plan: update, then restart to apply it, then verify`; `C6 plan: an unsafe moment still stages the update but holds the restart`.
C7: one test per code (`C7: job_past_deadline | validation_stalled | drain_too_long | staged_not_applied is a stuck update, repaired`); `C7: an update inside its windows is in progress, not stuck`; `C6 and C7 together get ONE repair, not an update and a repair`.
C8 and C9: `C8: authentication_failed in the transcript is login_expired, not fixable`; `C8 plan: report only, the owner types /login`; `C9: rate_limit in the transcript is usage_limit, with the reset time`; `C9 plan: report only, the reset time is in the words`; `C9: a limit with no known reset time still reports`; `C8 and C9 are reported FIRST, before any other action, in the same pass`.
Never a restart for C8 or C9: `never a restart or a start for C8: even when every other gate is open`; `never a restart or a start for C9: even when every other gate is open`; `C8 with a stale plugin: the update is still staged, nothing is restarted`; `a signed out launch is C8 and starts nothing, even with a supervisor`; `a named launch failure with a stale plugin: the update is staged, the agent is not restarted into the same failure`.
Never a kill when unsafe: one test per unsafe reason (`turn_in_flight`, `pending_messages`, `pending_permission`, `background_job`, `process_tree_unreadable`, `recent_activity`); `a restart gate that says no is a skipped step with its reason and state`; `a restart exactly at the rate limit edge is allowed`; `one restart per pass, however many causes want one`; `the order is: reports, then update or repair, then restart or start, then verify`; `verify is planned only when something was actually changed`; `invariant: no planned restart or start under C8, C9, an unsafe moment or a closed gate (every combination)` (7 cause flags x 7 safety states x 3 budgets, 2688 cases).
Purity and style: `purity: the input is not mutated, and the same input gives the same answer`; `planRepairs takes findings and gates alone`; `purity: the module imports nothing but the pure keepalive plan, and uses no I/O`; `house style: no em or en dashes anywhere in the module or this test`; `every report string is bounded for the backend`.

## Not done, and decisions for P3 and KC

- **Not done (by design, P2 is pure):** the observers that build the observation, the executor, `machine-rpc` progress posting and the 75 s deadline enforcement are P3. `PASS_DEADLINE_MS` is exported and carried on the verify action only.
- **Not covered by a cause in the plan:** a daemon alive with no claude (`claudeAlive: false`, `daemonAlive: true`). It names no finding today. P3 should decide whether that is C4 or C3.
- **Wedge restart and the 30 min legacy window.** C5 restarts go through the same safe table as the keep-alive sweep. An agent whose daemon does not publish hook turn signals uses the 30 min quiet window, so a wedged agent without hooks is held up to 30 min of silence before the pass restarts it; with hooks it is the 10 min window. Plan risk 2 (the 10 min wedge window) is a constant, `WEDGE_WINDOW_MS`, for KC to confirm.
- **Constants I chose where the plan said "N":** `BEACON_STALE_MS` 5 min, `VALIDATION_WINDOW_MS` 10 min, `DRAIN_MAX_MS` 15 min.
- **Restart attempts are counted per target by the keep-alive state**; the check up reads `lastRestartAtMs` and `attempts` from the same record (P3 must pass them and write back), so a check up cannot get around the 30 min and 3 attempt limits.
- Did not run the whole plugin suite (`npm test`), only this file, its two neighbours and the typecheck.
