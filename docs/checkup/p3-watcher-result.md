# RESULT: check up plan, packet P3 (plugin watcher job `checkup`)

Branch `feat/agent-checkup-watcher` off `feat/agent-checkup-classifier` (P2, c480485). Board row 1357b07a. Not pushed (no GitHub here); fetch the branch over ssh. P2's own RESULT is at c480485 (and `../doctorp2/RESULT.md`).

| Commit | What |
|---|---|
| `90ab487` | test: red first, the watcher checkup job (9 cases) and the C3 under C8 or C9 planner rows (3) |
| `a3273ed` | test: red first, C6 file steps then the gated restart, C6 latched, C7 one repair (3) |
| `cdec301` | feat: the job, its observer, the planner amendment, the bundle list, `readTail` |
| `ffb48b9` | chore(release): 0.74.3 and the CHANGELOG entry |

## What was built

- **`lib/watcher-checkup.mjs`** (new): the observer and the wire mapping. `isCheckupJob`, `checkupTarget`, `parseTranscriptTail`, `isOwnerChannelText`, `readTail`, `observeInstall`, `observeAgentForCheckup`, the keep-alive record read, spend and write, `wireFindings`, `heldDetail`.
- **`lib/watcher-core.mjs`**: `runCheckupJob` beside the reconcile and create_agent jobs, and its file half `runCheckupFileStep`. `handleFrame` dispatches a checkup BEFORE the reconcile ops (P1 found that an unknown intent ran as a full reconcile). `ctx.checkupDeadlineMs` defaults to P2's `PASS_DEADLINE_MS` (75 s).
- **`lib/agent-checkup.mjs`**: one rule changed (below) and `compareVersions` exported.
- **`lib/watcher-bundle.mjs`**: both modules are on the bundle list. The node fs gains `readTail`, so a long transcript is never read whole.

The job: `{ op: 'reconcile', intent: 'checkup', targets: [{ pairingId, assistantId }] }`, as P1's backend enqueues it (`op: 'checkup'` is read the same; a numeric `assistantId` is fine). It must name exactly one agent on this computer. Otherwise it fails by name (`checkup_needs_one_agent:<n>`, `agent_not_on_this_machine:<id>`) with nothing observed or touched.

## What one pass does, per cause

The steps are: observe, then `checkupPass`, then execute only the planned steps, then verify by the boot hello. Progress is posted after every step: `planning`, then `running` with the step rows `observe`, `aN-report|update|repair|restart_agent|start_agent|verify_agent`, then a terminal `done` (or `failed` when an executed step failed, with `failedStep`). The terminal report carries `findings: [{cause, target, status, detail, fix?}]` and `actions: [{cause, target, did, outcome, detail}]` inside P1's DTO caps.

| Cause (token) | Read from | One pass does | Finding status, owner fix |
|---|---|---|---|
| C3 `daemon_down` | claude found in the process table (its pin or folder on the command line, its state's claudePid, the claude above a live daemon), but no live daemon (no fresh agent-state.json, no live pairing lock holder); or the beacon file's mtime is over 5 min old while claude runs | One restart through the real ladder (marker, keepalive, service, recipe), gated by the safe table and the budget, then verify. **Also done under C8 or C9** (see the decision below) | FAIL, no fix (the watcher fixes it) |
| C4 `dead_session` | no claude, no daemon, nothing written in the last 30 min; launch-status names the last exit | With a supervisor or a launch recipe: one start, then verify. A named launch failure, or an agent never started: reported, never retried | FAIL; the fix names the launch outcome, or says to start it once |
| C5 `wedged_session` | the newest owner channel message in the transcript tail is more than 10 min old and newer than the newest real assistant turn; or a `gate-<screen>` launch-status while claude runs | Restarted once if the safe table allows, then verify. Otherwise `skipped` with the reason ("It looks busy (turn_in_flight: ...); I did not interrupt it."). Never named when C8 or C9 explains the silence | FAIL |
| C6 `stale_plugin` | the fresh state's runningVersion is below the installed version or the marketplace's latest (local files) | `update`: the reconcile planner's plan for this agent alone, FILE steps only (the executor never gets `restart_agent`, `verify_agent`, `manual_restart_required` or `refresh_watcher`). Then the gated restart applies it, then verify. If the update does not land, it is `not_fixed` by name and the restart it needed is `skipped (update_not_applied)` | WARN |
| C7 `stuck_update` | auto-update.json `validationPending` older than 10 min; a keep-alive act still marked in flight after 20 min; a restart newer than the install that still runs the old version | ONE `repair` (it also covers C6), file steps only, then the gated restart, then verify | FAIL |
| C8 `login_expired` | the CLI's `authentication_failed` envelope, with no real turn after it; or launch-status `live-but-not-signed-in` | **Reported only**, first: `did: report, outcome: not_fixed`, in the owner's words ("... type /login ..."). Never a restart FOR it | FAIL; the fix says to type /login |
| C9 `usage_limit` | the CLI's `rate_limit` envelope, younger than 5 h (7 days for a weekly or monthly limit), with no real turn after it; the reset words are kept ("7:40pm (Asia/Dubai)") | **Reported only**, first, with the reset time. Never a restart for it | WARN; the fix gives the reset time |

Every restart or start is written onto the agent's keep-alive record before the act (`target: 'checkup'`, `attempts + 1`, `lastRestartAt`, `restarted / checkup_restarting`), then `restarted / checkup:<how>` or `failed / <reason>` after the verify. `lastRestartAt` is the field the sweep reads, so the 30 min rule holds across the check up and the sweep both ways. A restart is not begun with under 15 s left of the pass. The verify gets `min(verifyTimeoutMs, what is left of the 75 s minus 3 s)`.

## The two decisions (Data, from KC's ask that the watcher "troubleshoot and fix any potential reason an agent is offline")

1. **The pass auto fixes C3 to C7 and only reports C8 and C9.** The fixes are safe restarts and updates only, gated by the safe moment table (`decideSafeMoment`) and the restart budget (`decideRestartBudget`). C8, C9 and anything the table holds back are reported. A held restart is a `skipped` action with its reason token and words. P5's "Fix it" button can key on that.
2. **The wedge window for C5 is 10 minutes** of owner messages unanswered with no transcript activity (P2's `WEDGE_WINDOW_MS`). An agent whose daemon publishes no hook turn signal still has the safe table's 30 min quiet window before a restart.

## A change to P2's planner, and why

The brief's first red test is "one pass fixes a dead daemon and reports a signed out login in the same pass". P2 blocked every restart while C8 or C9 was a finding, and pinned that for C3 too. **I changed one rule:** a restart for C3 (claude alive, only the connector down) is allowed under C8 or C9. The reasons: the connector is not the model, so its restart needs no login and no quota. It is what carries the login or limit report, and it is what lets the owner's next message (or /login) reach the agent. It still goes through the safe table and the budget. A C4 start, a C5 restart and an update's restart stay blocked under C8 and C9, so P2's "a restart of a signed out session only adds a failed launch" still holds wherever claude is not already running. P2 test changes: the `{ daemonAlive: false }` row left the two "never a restart for C8 or C9" tables; the cross product invariant now allows a planned restart under C8 or C9 only with C3 among the findings; the order row with C3 + C9 now ends in `restart, verify`. Data should confirm this reading of the brief.

## Other choices I made (worth a look)

- **Daemon alive, no claude visible** (P2's open question): unknown, not C3 or C4. It names no process cause, following the sweep's rule (`claude_not_found_for_live_daemon`). Likewise, no claude visible but the session wrote in the last 30 min is unknown, so nothing is started beside a session the watcher cannot see.
- **Delivery evidence is the transcript, not the chat cursor.** `chat-cursors.json` advances on the agent's own replies too (server.ts `advanceChatCursor` over every row), so its mtime would call every quiet agent wedged. The owner message the CLI recorded is the evidence. If a wedged CLI never records the notification, C5 is not named (a miss, never a false restart).
- **The checkup acts whatever the keep-alive switch says**, like "Restart now" (`restart_only`): the owner tapped it for this agent. It never touches another agent.
- **A login failure does not go stale** (dead until a real turn proves otherwise, as `ClaudeLoginWatcher` does). A usage limit does (5 h, or 7 days for weekly or monthly), because the plain JS watcher has no port of `lib/resting.ts parseResetText`.

## Test names

`test/watcher-checkup.test.ts` (16, the watcher-core rig: the real `runWatcher` loop, an in process fake backend recording every request, a fake HOME in memory, a fake clock and `ps`, the real restart ladder and verify, the real OS sentinel first):
- `one pass fixes a dead daemon AND reports a signed out login: the login first, then the connector restarted and verified`
- `a wedged session inside the safe window is restarted ONCE; the next pass is held by the restart budget`
- `a wedged session outside the safe window waits with the reason, and nothing is touched` (turn_in_flight, background_job)
- `a usage limit is reported with its reset time and never restarted, even when the silence looks like a wedge`
- `a checkup job never runs the reconcile planner: an intent this watcher knows is never widened into a reconcile`
- `a checkup with no agent, or with several, is refused by name and touches nothing (never the whole computer)`
- `the op checkup is a checkup too`
- `a dead session with a supervisor is started and verified; a named launch failure is reported, never retried`
- `the pass deadline bounds the verify: a deaf agent is not_fixed inside 75 s, never a 120 s wait`
- `C6 stale plugin: the update runs FILE steps only (no executor restart), then the one gated restart applies it, verified`
- `C6 with updates latched: the update is not_fixed by name and the restart it needed is skipped, nothing touched`
- `C7 stuck update (validation stalled): ONE repair, file steps only, then the gated restart and verify`
- `parseTranscriptTail: a real turn after an error ends it (the login works again, the cap lifted)`
- `parseTranscriptTail: a session cap older than its 5 h window says nothing; a weekly one holds for days`
- `parseTranscriptTail: only an OWNER channel message is a delivery; events, peers, the system, sidechains and synthetic turns are not`
- `checkupTarget: exactly one agent, by number or by digits string`

Every terminal report in those tests is also checked against P1's DTO (cause and did tokens, outcomes, statuses, detail at most 400, at most 24 each, step states and lengths). No request body or log line may carry the pairing token, the agent's secret or the home path.

`test/agent-checkup.test.ts`, new rows: `C3 under C8 or C9: the dead connector is restarted and verified, the login or limit still reported first`; `C3 under C8 still goes through the safe table and the restart budget`; `C3 under C8 with a stale plugin: the restart that fixes the connector applies the staged update too`.

## Red first, and the proof the tests bite

- At `90ab487`, all 9 watcher cases failed (no `findings` on the terminal report, and the checkup ran as a reconcile), and the 3 planner rows failed. At `a3273ed`, 12 of 12 watcher cases failed. The 4 pure cases at the end of the file (parser and target) and the "spent before the act" assertion were added with the green commit. They came from two mutants that survived the first green run.
- Mutants, each turning named cases red: no C3 exception (5), no checkup dispatch (12), no spend before the act (1), the executor handed the restart steps (2), the verify not bounded by the pass (1), a restart after a failed update (1), activity never ends an error (1), caps never stale (1), a peer counted as the owner (1), no owner delivery evidence (2), several targets accepted (1), claude never found (7).

## Results (all on the final tree)

- `npx tsx --test test/watcher-checkup.test.ts`: 16 pass. `test/agent-checkup.test.ts`: 67 pass. `test/watcher-core.test.ts`: 54 pass.
- Every test file that imports a module or helper I touched (21 files: watcher-core, watcher-keepalive, watcher-bundle, watcher-bundle-repair, watcher-self-refresh, watcher-install, watcher-service, watcher-health, the real OS guard, agent-restart, agent-verify, agent-windows, agent-task-win32, memory and the rest): 571 tests, 569 pass, 0 fail, 2 skipped.
- `test/version-bump.test.ts` 23 pass, `test/hooks-manifest.test.ts` 8 pass.
- `npm run build` (`tsc --noEmit`): clean. `npm ci` was run first.
- `test/version-heartbeat.test.ts` fails to load under node (`bun:` scheme). It does the same at the base without my changes: it is a `bun:test` file the repo runner sends to bun, and bun is not installed here.
- Version 0.74.3 in package.json, .claude-plugin/plugin.json and package-lock.json, with a CHANGELOG entry.

## Not done, and notes for P4 and P5

- **No real machine run** (the plan's section 6 rig with a real agent folder and scripted breaks). Everything here is the in process rig; no real agent or claude process was listed, signalled or started (the only processes I ran were npm, tsc and the test runners).
- **`npm test` was not run whole.** It needs bun for the bun:test family and starts real Chromium for the browser files. I ran the files for what I touched, as the brief says.
- **The drain part of C7 is not observed:** the daemon keeps its drain mode in memory, and the watcher has no durable file to read it from. `drainSinceMs` is null. **`belowFloor` is always false:** the backend's `getJob` strips targets to `{pairingId, assistantId}`, so P4 must add the floor to the job body if C6 should use it. **A clone's published version is not read** (that is a network read); a clone's C6 uses the installed version only.
- **For P4's gate** (P1: send `checkup` only to a watcher that knows it): this watcher declares nothing new on its heartbeat, because I did not want to risk a heartbeat 400 on an env field the backend may not accept. Gate on the watcher bundle version (the heartbeat's `daemonVersion`) being at least 0.74.3.
- **A stuck screen is read only from a `gate-<screen>` launch-status** while claude runs. There is no tmux pane capture.
- **Not checked before a checkup restart:** the sweep's `decideFreshStart` (a person's marker still pending, or a launch inside the quiet window). The budget and the safe table do apply. Worth adding if P4 lets the owner tap repeatedly.
- **For P5:** a held restart is `outcome: 'skipped'` with `detail` starting "It looks busy (<reason>: ...)" or "Not restarted (<reason>: ...)". Owner fixes are in `findings[].fix`. The progress DTO has no `ownerAction` field, so P4 maps it from `fix` and the cause.
