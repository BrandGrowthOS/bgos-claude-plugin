# helperwedge (0.87.5): the Helper restarts a really frozen agent, and the owner can always restart one

From the production test on KC's MacBook, 2026-11-12 (`REPORT-HELPERTESTMAC-1112.md`), and KC's item 5 (msg 1048 220142).

## 1. A wedge is restarted in the same conversation

C5 `wedged_session` is a turn in flight by definition, and the daemon still owes the reply it was sent. The check up used to hold its restart for `turn_in_flight` until the turn was 2 hours stale. Now, for C5 only, the turn flag, `pendingMessages` and `activeOperations` hold the restart only while the session is still making progress: its newest model turn or its newest hook event (the spool's mtime) inside the 10 min wedge window (`isWedgedTurn`, `lib/keepalive-plan.mjs`). No evidence is not "no progress" (REVIEW-0432 F1): the hold lifts only when both sources were actually read (a model turn stamp from the transcript and a hook stamp from the spool), from a fresh state whose hooks reach the daemon (`turnSignal: 'hooks'`), and both are older than the window. A transcript or spool the watcher cannot find, a hookless agent or a stale state keeps the turn and owed reply holds. The daemon's `lastActivityAt` and the transcript mtime are not progress, because they also move when the owner writes again. A question for the owner (`pending_permission`), a job under claude (`background_job`), an unreadable process table and the restart budget still hold it. The restart goes through the agent's own authority (the launcher's marker, the service, the keepalive script), which resumes the pinned session. Before it, the agent's claude gets SIGCONT (a stopped process keeps SIGTERM and SIGHUP pending). If the same claude (pid, command line and start time, from a fresh listing) is still there 10 s later, it gets SIGKILL.

## 2. A held fix says "Not fixed yet"

See `p3-watcher-result.md`, decision 1. A held restart or start is `outcome: not_fixed` with words starting `Not fixed yet (<reason>: ...)`, so the backend keeps the break open, the app does not say "running again", and the Helper's loop goes on to the known fixes and "Logged for the team" when nothing helps.

## 3. Delivery read from the queue line, and from the daemon

`parseTranscriptTail` reads Claude Code's `{"type":"queue-operation","operation":"enqueue","content":"<channel ...>"}` as a delivery when the content is an owner channel message. The daemon publishes `ownerWaitingSince` (agent-state.json): when the first owner message it still owes a reply to reached it. The check up takes the newer of the two as the delivery. This covers a claude frozen before the message arrived (stop, then send), which writes neither line.

## 4. An agent never borrows another agent's pairing

When an agent is named (`BGOS_ASSISTANT_ID`, or a `.bgos-agent-id` folder pin) and its own `credentials-<id>.json` is missing, the shared `credentials.json` is read only when it holds that same agent's pairing. Otherwise the selection is the agent's own missing file, under the route that named it (`env-assistant` or `folder-pin`, both routes the backend's stand-down contract already lists), and the daemon has no pairing rather than another agent's. A folder pin never falls to another agent's sole file. The pairing CLI's read mirror and the doctor's resolver follow the same rule (pinned against the daemon over 2560 combinations).

## 5. The owner's Restart (always carried out)

A watcher job of its own: `op: 'restart_agent'`, `intent: 'restart_agent'`, `requestedBy: 'owner'`, `targets: [{ pairingId, assistantId }]` (exactly one). It is its own op, never a reconcile intent, because an older watcher runs an unknown reconcile intent as a full reconcile of the computer; an older watcher answers `unknown_op:restart_agent` and touches nothing.

What the watcher does (`runOwnerRestartJob`, `lib/watcher-core.mjs`), with no check up, no safe moment, no turn hold and no restart budget:

1. `observe`: the agent's row and its own claude processes.
2. `restart_agent`: SIGCONT to its claude, the restart through its own authority (resumes the pinned session), SIGKILL to the same claude if it outlives 10 s.
3. `verify_agent`: the boot hello, up to 75 s.
4. Only if that did not answer and a readable listing shows nothing of the agent running: `start_agent` through what is left (the service, the task, or the hidden recipe launch), then `verify_agent` again.

Terminal: `done` with `message: "restarted <id> via <how>; it answered at <iso>"`, or `failed` with `message` starting `not back: `. Refusals, with nothing touched: `restart_needs_owner`, `restart_needs_one_agent:<n>`, `login_file_missing:<id>` (no login file, this computer keeps the agent's own records, and the server places its pairing here: lib/lost-login.mjs, board row 23415823), `agent_not_on_this_machine:<id>` (no record of it here at all). The whole job ends inside 170 s. The keep-alive record gets `lastRestartAt` and `restarted / owner_restart`; attempts are not spent.
