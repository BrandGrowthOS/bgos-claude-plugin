# An idle agent loads its staged plugin update by itself (design)

**Lane:** idleupd, board row 5a455021. **Branch:** `fix/idle-agent-loads-staged-update` from plugin main `2a35928` (0.80.0).
**Gate:** Data (900). Nothing merges or publishes without Data; publishing is Kc's word.
**Written:** 2026-10-28, from a read of the plugin at `2a35928` and the two BGOS specs named in the brief (`2026-09-14-forced-updates-design.md`, `2026-09-16-plugin-self-restart-design.md`). Every claim about today's code names its file.

**Reviewed before any code.** Three independent readers looked at a first draft: a builder check, an adversarial safety reviewer and a requirements auditor. Their findings changed six things, listed at the end.

## Before and after

- **Before:** an update is downloaded and staged, and the agent keeps running the old version until someone quits it.
- **After:** once the agent has been idle for a while, it restarts itself onto the new version, comes back in the same conversation, and reports the version it came back on.

## The four questions

**1. What would a top release engineer also guard?**
- **One computer, one restart at a time.** Use a lease, spacing and per-agent jitter, and make the first agent onto a version its canary that the others wait on. Never during a turn, an owed reply, a blocking ask or plan card, a call, a browser in use, a goal, or a wake due within 10 minutes. Never in a session a person can type into.
- **A bad build stops at the agent that proves it failed, never a loop.** One attempt per version, one rollback, a version latch that every restart path reads, and no downgrade cascade. Respect `BGOS_AUTO_UPDATE` off. Never use a restart path that cannot prove it owns the session (the 2026-09-11 mute).

**2. Where to start?**
- **`lib/hook-restart.mjs`.** It already asks the existing ladder for ONE restart at the watcher's safe moment (`decideSafeMoment`, `lib/keepalive-plan.mjs`). Generalise it into an idle update controller keyed on `pendingRestartVersion`.
- **The ladder (`lib/update-rpc.ts restartLadder`).** It stages every gen-2 launchd or systemd agent, because the job's run.sh is not an ancestor of the daemon (hoai runs in a detached tmux, `bin/bgos-agent`). So it never reaches the hoai marker that would restart the agent.

**3. Which tools?**
- **Existing ones only:** the ladder (keepalive SIGTERM, an owning service, the hoai launcher's `restart-requested.json`), `decideSafeMoment`, the process tree (`lib/process-tree.mjs`), exclusive create files, the heartbeat (`daemonVersion`, `lastError`), and node:test with injected clocks and filesystems.
- **For the proof:** a rig in a scratch HOME on E: with the real daemon, the real `hoai-core.mjs`, a stand-in `claude`, and a stub backend on 127.0.0.1 ports 43000 to 48999. Watcher install is off, and the scheduled tasks are listed before and after each run. `MACOS-PROOF.md` is the launchd run on Data's Mac.

**4. What proves it right, independent of you and me?**
- **Red-first unit tests,** one per rule, each with a recorded mutant that turns it red. Then the rig's own outcome lines, read off the stub backend and the files: the version the restarted daemon reports, one restart per staged version, each busy case still waiting, the broken build back on the old version, 15 agents never overlapping, and scheduled tasks identical before and after.
- **A fresh security reviewer subagent** that did not write the code, Data's own run of `MACOS-PROOF.md` on a real launchd Mac, and CI on Linux and Windows.

## Ground truth this design rests on

1. **Nothing restarts an idle staged agent today unless the per-machine watcher is installed and switched on.**
   - A marketplace install has no self updater. Claude Code's own startup auto-update rewrites `installed_plugins.json`, the daemon reports the difference as `pendingRestartVersion` (`lib/pending-restart.ts`), and nothing asks for a restart.
   - A clone's scheduled update asks the ladder ONCE, right after it installs (`lib/self-update.ts finishScheduledUpdate`). If it is refused it stages, and it never asks again.
   - The watcher's keep-alive sweep (`lib/watcher-keepalive.mjs`) does restart staged agents at a safe moment, but it is opt-in: an owner click installs it, and the computer's "Keep agents running" switch must be on.
2. **Even when asked, a gen-2 launchd or systemd agent stages.**
   - `resolveSupervision` (`lib/update-readiness.ts`) returns the canonical service before the live launcher, and the ladder requires the job's main pid to be an ancestor of the daemon (`serviceOwnsUs`).
   - In gen-2, run.sh starts hoai in `tmux new-session -d`, and the tmux server daemonizes away from run.sh. So the ladder logs "staging instead of restarting through a job that does not own this process".
   - The heartbeat still says `supervised: launchd`. That fits Alex's 15 agents.
3. **The supervisors resume the agent's pinned session, never bare `--continue`.**
   - hoai relaunches with `--resume <pinned id>` (`bin/hoai-core.mjs sessionArgsFor`).
   - `-c`/`--continue` is deliberately not forwarded since the 2026-08-23 identity bleed, when six agents in a shared folder resumed Data's conversation.
4. **The 2026-09-11 path** was `launchctl kickstart -k` on a job that did not hold the session. It left nine daemons drained and deaf for 50 minutes (`docs/learnings/a-declared-restart-authority-must-own-the-process.md`). The guards against it are the ladder's ownership check and its 3 minute un-drain watchdog. This design adds no kickstart, no `process.exit`, and no call to `restartAgent` from the daemon.
5. **hoai latches itself deaf to markers after its fourth marker relaunch inside an hour** (`bin/hoai-core.mjs`, the `exhausted` flag, never reset on posix). Every marker this design writes counts against that budget.

## Shape

Data's shape, with the brief's additions:

> A build is staged and the agent is idle (no turn, no pending inbound, no running goal, no open ask card, no call) for N minutes. Then the supervised session restarts through the existing authority, resuming its pinned session, and reports the new version. Busy agents wait for an idle window. A failed restart rolls back to the old build and reports it. Jitter keeps agents on one machine from restarting together. One attempt per version, then back off. Never an unsupervised interactive session. Respect autoUpdateEnabled off. Cover launchd, the Windows supervisor and Linux where the plugin supports them.

### Components

| Piece | Where | What |
|---|---|---|
| The rules | `lib/idle-update.mjs`, pure | `decideIdleUpdate(facts)` takes every input as a value and returns `{action: 'off' \| 'wait' \| 'restart', reason}`. The jitter draw, the version order, the record transitions, the lease and canary decisions, the back-off, the boot settle and the validation verdict are separate pure functions. |
| The controller | `createIdleUpdate(deps)` in the same file | Polls every 30 s and logs each wait reason once. It reads the process tree and the wake schedule last, then checks every rule again. Then it takes the lease, writes the record, drains, and asks the ladder. |
| The boot settle and validation | `settleRecordAtBoot` and `decideValidation`, driven by the controller | The new daemon reads the record, then validates the new build on live evidence or decides to roll back (below). |
| The ladder | `lib/update-rpc.ts` | New public `restartForStagedUpdate(target)` and `restartForRollback(target)`, each with its own log-only rpc id (added to the `progress()` filter and the watchdog text). |
| The own launcher rung | `lib/update-rpc.ts`, with the proof from `lib/idle-update.mjs proveOwnLauncher` | **Only these two new entry points use it.** A click, the scheduled update and the hook restart keep their behaviour exactly. |
| The version latch | `lib/idle-update.mjs`, read by `lib/pending-restart.ts` | A version latched bad on this computer reads as no pending restart, so the watcher, the heartbeat and a click target never push it again. |
| Clone rollback | `lib/self-update.ts` | Its existing rollback, split from its `exit(0)` so the ladder can restart after it. That gives one checkout state machine, not two. |
| The host readings | `lib/idle-update-host.mjs` | The launcher claim (supervisor.json), the restart marker, the unattended proof's inputs, a person on the agent's tmux sockets, the watcher's sweep state, the wake schedule read, the versions held bad, the marketplace rollback and its enrolment hold. Each through an injected fs or exec; an answer it is unsure of waits. |
| Wiring | `server.ts` | `armIdleUpdate()`, called the moment this daemon holds the pairing lock (at boot and on promotion), before the arm of delivery, so a new build whose startup hangs still meets its validation deadline. Paired agents only: an API key session never arms it. Stamps the busy facts nothing kept (a voice frame, a browser tool, the beacon, startup complete, a heartbeat that landed), adds the fourth `lastError` producer, and holds the marketplace enrolment while the latest version is held bad here. |

### The own launcher rung

The case is: the resolved authority is a service, and `serviceOwnsUs` is false. Today the ladder stages there. Inside `restartForStagedUpdate` and `restartForRollback` only, it will instead write the marker for the agent's own hoai launcher, when `provenOwnLauncher` holds. All of these must hold:

1. supervisor.json declares `relaunch`, and its pid is alive.
2. That pid is a STRICT ancestor of this daemon, and its command line runs `hoai-core.mjs`.
3. **The nearest `claude` above this daemon descends from that launcher, with no other `claude` between them.** A daemon of a nested `claude -p` inside an agent's Bash tool therefore never proves the outer hoai (the pid proven is the pid that is replaced, as in `keepaliveOwnsProcess`).
4. The launch is proven unattended (gate 6 below).
5. No restart marker is already waiting (gate 8).

The launcher then ends claude and relaunches it with `--resume <pin>`, as it does on Windows today. No job is ever kickstarted. `resolveSupervision`, the wire value `supervised` and `service.json` do not change.

### Rules, in the order `decideIdleUpdate` applies them

Each rule has its own test and its own mutant.

| # | Gate | Waits (or stops) with | Notes |
|---|---|---|---|
| 1 | `BGOS_AUTO_UPDATE` is off (the daemon's own `isAutoUpdateEnabled`) | `off: updates_disabled` | Never arms. |
| 2 | Nothing staged, or the staged version is not strictly NEWER than the running one (numeric X.Y.Z) | `off: nothing_staged` | A rollback elsewhere can never pull an agent backwards. |
| 3 | Not the pairing lock holder, or shutting down | `wait: passive` | |
| 4 | The per-machine watcher's keep-alive sweep is active on this HOME (its state file was written in the last 5 min) | `wait: watcher_owns_updates` | One restart authority per computer. |
| 5 | The target is latched bad on this computer | `wait: version_held_bad` | |
| 6 | No unattended authority proven | `wait: no_unattended_authority` | See the proof below. Staged and none never qualify. |
| 7 | Already attempted this version and the back-off has not passed | `wait: attempted` | One attempt per version. The next is allowed after 24 h, doubling, capped at 7 days. A rolled-back version is never retried. |
| 8 | Draining, the update lock held, or a restart marker present | `wait: update_in_flight`, or `wait: launcher_latched` if the marker is older than 5 min | A stranded marker means hoai stopped taking markers; it is reported. |
| 9 | Up for less than 60 s, or "startup complete" not logged yet | `wait: young` | The controller is armed at the lock, before startup completes, so this gate keeps it from acting early. The daemon's boot also counts as activity in gate 16, so a session that just started waits the whole quiet window: a separate fresh start gate is not needed. |
| 10 | Turn in flight, a reply owed, a permission card, an active operation | the `decideSafeMoment` reason | Turns use its 2 h stale rule. Inbounds and operations use the update path's 30 min rule (`updateDrainSnapshot`). |
| 11 | A blocking ask, a plan card, or an own ask card younger than 24 h | `wait: open_ask` | Older non-blocking cards survive a restart (`lib/ask-tracker.ts`). |
| 12 | A goal armed, arming, injecting, or clearing | `wait: goal_running` | |
| 12b | The last Stop's `session_crons` held a one-shot entry, within 2 h | `wait: session_wake` | A self-paced `/loop` (ScheduleWakeup) does not survive a plain `--resume`. See "What a restart does to /loop and scheduled wakes". |
| 13 | Voice consults pending, open continuations, a voice frame in the last 30 min, or an open meeting | `wait: call_active` | |
| 14 | A browser tool used in the last 30 min | `wait: browser_in_use` | The host is the daemon's child, so a restart closes Chrome. |
| 15 | A read-write client attached to the agent's own tmux socket, or (keepalive) to the tmux session the daemon itself runs in, or that reading failed | `wait: person_attached` | A keepalive is asked on the server and pane in the daemon's own `TMUX` and `TMUX_PANE` first, its declared session name only when it runs in no tmux; a session tmux cannot find, or nothing to ask, is unknown and waits. A person at the keyboard. On Windows the unattended proof requires the hidden console instead. |
| 16 | Activity inside the quiet window (N = 10 min with the hook signal, 30 without), and past it, no hook signal | `wait: recent_activity`, then `wait: no_turn_signal` | An unattended restart needs `turnSignal === 'hooks'`: with no hook signal a turn cannot be seen, so quiet proves nothing. Past the 30 min the agent says so (`idle_update_no_turn_signal`) and stays. |
| 17 | Quiet, but this agent's jitter has not elapsed | `wait: jitter` | A uniform draw of 0 to 10 min, per version and per boot. |
| 18 | Another agent holds the lease, or the last release was under 2 min ago | `wait: machine_busy` or `wait: spacing` | |
| 19 | Another agent is the canary for this version and has not confirmed it | `wait: canary_unconfirmed` | |
| 20 | Process tree: a background job under claude, or the tree unreadable. Through an owning systemd unit, also a stray in the unit's cgroup (a job orphaned out of claude's tree), or a group it cannot read | the `decideSafeMoment` reason, or `wait: background_job` / `wait: process_tree_unreadable` | Read last. A systemd restart ends the unit's whole cgroup (KillMode=control-group); the check is the watcher's own (`strayCgroupMembers`), through `readServiceStrays`. |
| 21 | Wake schedule: a wake or call due within 10 min, or the schedule unreadable | `wait: wake_due` or `wait: wake_schedule_unknown` | `GET scheduled-tasks/agent?status=active`, the agent's own view (`AgentScheduledTaskViewDto.nextFireAt`). Re-read just before the act. Fails closed. |
| 22 | Otherwise | `restart` | |

**Unattended proof (gate 6), by authority:**
- **Keepalive** (proven by `resolveKeepalive`): an external script by construction, but only when the claude it relaunches resumes a pinned session (`--resume <id>` or `--session-id <id>`) and never says `--continue` or `-c`. A keepalive that restarts claude with bare `--continue` in a shared folder would resume whoever spoke last there (the 2026-08-23 identity bleed). Gate 15 checks its tmux session.
- **A service whose main pid is our ancestor** (gen-1 run.sh, or a declared owning job): run by launchd or systemd, with no terminal, and only when the claude it restarts resumes a pinned session. A gen-1 job starts claude fresh: the conversation would be lost with nothing to say so, so it never restarts.
- **A launcher on macOS or Linux** (the own launcher rung, or a plain live launcher): it descends from the agent's own tmux server on its own socket, or from its run.sh. Alternatively, launch-status holds an outcome only a supervised launch writes (`live`, `live-but-not-signed-in`, `no-live-marker`), written at or after supervisor.json.
- **A launcher on Windows:** its parent is `wscript` running THIS agent's own `run-agent.vbs` (the full path in the agent's state folder, compared in any case and with either slash; another agent's file or one elsewhere is no proof), and that `run-agent.vbs` launches hidden (style 0) and was written before the launcher started (`lib/agent-windows.mjs` `supervisorConsoleParent`, `startedHidden`). `--keep-alive` alone is not proof, because people type it. An unreadable process table is no proof.

### Lease, spacing and canary (15 agents, one computer)

- **State lives in `~/.bgos-agent/idle-update/`,** shared by every agent under one HOME. Every shared fact is its own file created exclusively; no file is read, modified and written back.
  - `lease.json` holds `{assistantId, target, nonce, at}`. A lease older than 25 min is broken by renaming it aside (atomic, one winner). The holder releases it only if the nonce is still its own.
  - `released.json` (rewritten by the releaser while it holds the lease) holds the last release time, for the 2 min spacing.
  - `<version>/canary-<n>` holds `{assistantId, at}`. `<version>/validated` holds `{assistantId, at, canary, from, fromRoot}`, the last two so a later failure knows the build the canary left. `<version>/bad` holds `{assistantId, at, reason}`.
  - `went-back-<assistantId>` holds `{assistantId, at, target, reason}`: this agent used its way back without being the canary, and has not validated a build since. It is written first, so the rollback may have failed after it.
- **The canary is the first agent to restart onto a version on this computer.**
  - Until it has written `validated`, every other agent waits.
  - If its lease expires with no outcome (the agent never came back), the version is held for 24 h, and then ONE more agent may try (`canary-2`).
  - If that one also goes silent, the version is latched bad. Silent means older than 100 min with no outcome (`canarySilentMs`: the 15 min startup bound, an hour of outage forgiven, the 15 min deadline and a 10 min margin), not the 25 min lease: a canary past its lease may still be validating, and until then the others hold. It is not a hard bound on a validation (see Residuals). Latched bad means `<version>/bad` is written with reason `canaries_silent`, so `pendingRestartVersion`, the watcher and the enrolment hold all see it.
  - A lease or canary stamped further in the future than a lease lives is a clock that jumped, not a holder: the lease reads as expired and the canary as long silent, so no agent waits on it forever.
  - So a build no canary has proved costs at most two agents per install on a computer when it goes silent, never fifteen. Past a canary's proof the bound is weaker (Residuals: a canary on another install, a daemon that dies after its first beacon).
- **Jitter** is drawn per boot, so restarts never re-synchronise. The lease is what forbids two at once.
- **Limit:** another HOME is another computer as far as these files go. Agents of two accounts on one machine are not serialised against each other.

### The attempt, and its record

`~/.bgos-agent/<id>/idle-update.json` holds `{target, from, fromRoot, fromCommit, installMethod, pin, nonce, state, attempts: [{at, outcome}], lockBoots, arrivedAt, endedAt, liveAt, rearrived, validatedAt}`. A record whose `target` or `from` is not a plain X.Y.Z is junk and ignored: both name folders.

- **When it is written:** before the drain. If it cannot be written, there is no restart.
- **`pin`** is the agent's pinned session id, read before the restart.

**States:**
- `requested`: the old daemon asked the ladder.
- `arrived`: a lock-holding daemon on the target booted.
- `validated`.
- `came_back_old`.
- `context_lost`: the pin changed. hoai's fresh retry after a resume that died within 25 s does that. It is reported, and counted as a failed attempt. A later boot of the target on a new session is the same: never a reason to roll back, because a resume that died is claude's or the transcript's, not the build's. The session is read from claude's command line first (`--resume <id>` or `--session-id <id>`), then the pin file.
- `did_not_arrive`: the old daemon is still alive 3.5 min after asking. The ladder's watchdog has already un-drained it.
- `no_authority`: the ladder staged.
- `rolled_back`, `rollback_failed`.

### Validation (the new build proves itself)

A daemon on the target is **validated** when ALL of these hold:
1. "startup complete" has been logged.
2. A heartbeat POST carrying the new `daemonVersion` succeeded. Only a beat that carries this build's own version counts; the status-only beat carries none and proves nothing about the build.
3. This pid has touched the channel beacon, which happens only while delivery is live (`touchBeaconHeartbeat`, `server.ts`), and the touch wrote the file the supervisor watches: a write that failed proves nothing.
4. There is no deaf verdict.
5. It has held all of the above, as the lock holder and without a break, for 5 min on this boot, with the beacon touched again and a version heartbeat landed during the hold (one reading still fresh from before it proves nothing about it). The hold counts from the first live reading, never from the arrival: a slow start validates on five minutes live. Until a beat has landed during the hold, the controller asks the heartbeat for one.

A boot heartbeat can land before the record settles, so until a beat lands after arrival the controller asks the heartbeat for one (`sendNow`), at most once a poll.

**The 15 min deadline counts from this boot's startup complete, and only time this computer could prove anything.** A slow startup is not the build failing. A startup that never completes has its own bound: 15 min after arrival. Either is suspended while the login has expired or a usage cap holds (`currentAccountError`), and those minutes are not counted afterwards either, nor the minutes this daemon was not the lock holder, nor a sleep: the controller keeps a monotonic clock (`performance.now()`) beside the wall clock, and a wall clock that moved further than the monotonic one is time asleep. None of these is the build's fault.

**An outage is forgiven for an hour at most.** While backend calls cannot reach a working backend (no answer, or a 5xx; a 4xx is a backend that answered), the deadline is suspended and those minutes are not counted. That is read off every call to the backend's own base URL (`bgosCall`, `isBackendUrl`), so the calls of a slow startup count, not the heartbeat's alone, and an upload to storage counts for nothing. Past 60 min of outage the minutes count: a build that breaks its own calls (a bad header, a request the backend answers with a 5xx) cannot tell itself apart from an outage, and an hour is long enough that a real one rarely outlasts it and short enough that a broken canary does not sit on a computer for good.

**Live before the hold, or ended cleanly.** Once every proof but the 5 min hold is in, the controller writes `liveAt` on the record. And when the daemon ends cleanly while validating, it writes `endedAt`. Clean means its claude went away (`isCleanEnd`): stdin ended or closed; SIGTERM or SIGINT; SIGHUP, because under expect claude leads its pty's session and when it exits the kernel hangs up its whole process group, this daemon included; or the reader of the daemon's own stdout or stderr gone (EPIPE), which is claude. Every daemon keeps main's signals: `process.once` for SIGINT and SIGTERM, and no SIGHUP handler. Only while its attempt is open (from arrival to the first live proof) does a validating daemon borrow more (`createCleanEndSignals`, `lib/process-lifecycle.ts`): a listener that keeps a second SIGINT or SIGTERM from killing the shutdown (a systemd stop signals the unit's control group and the launch shim forwards the same signal, so two can arrive) and, off Windows, SIGHUP into the shutdown. The bug that needed them is a clean end the record never saw, and past `liveAt` the record no longer needs one. The controller opens and closes this on each poll; the launch shim is main's again. Any other broken pipe (a write after end or to a destroyed stream, on the daemon's own pipes or any other, `broken-pipe`) is as likely a fault in the build and is never clean. hoai relaunching a startup that ran past its 3 min beacon wait ends claude on macOS and Linux (SIGTERM to expect, which kills claude), so the daemon sees one of these. If the target then boots once more after it proved live, or after a clean end of any age (a computer shut down overnight ends cleanly too), that boot validates on its own, once per record (`rearrived`), and is not called a failing build. A clean end or a live proof vouches only for the boot that wrote it: a boot on a new session (`context_lost`) starts with neither on record. Only the lock holder writes the record, and a daemon checks the record on disk before it writes a clean end or validates after holding the lock again (`isRecordSuperseded`: another attempt, another nonce, or a later boot's settle, a later `arrivedAt`, means another session of this agent held the lock meanwhile, and so does a verdict or an appended failed attempt it did not write, from a daemon that adopted the attempt). Its clean end then writes nothing. Its validation carries on with the newer record when that is the same attempt with no verdict yet (the other boot no longer holds the lock, so this boot is the one to give it; every later write extends that record, and the hold starts again, as after any time without the lock). Adopting it, the daemon counts its deadline from that boot's arrival and none of the time since (it held no lock then), and drops that boot's `liveAt` and `endedAt`, which vouch for that boot only. It stands down otherwise: another attempt, or one with its verdict, is not its to act on. A failed boot (`second_boot`) or a missed deadline is a verdict too, though the record still says arrived while the boot that gave it rolls back; the next boot of the agent finishes that rollback. A disk that refused this daemon's own write holds an older state of the same attempt, which supersedes nothing. A recent poll is no such proof: a daemon that crashed (`uncaughtException`, `main().catch`, a write after end on some stream) or hung polled too, until it stopped, and none of those writes `endedAt`. A second boot with neither is `second_boot`, and it restarts the arrival clock, so the deadline counts from the process that is running. On Windows hoai ends claude through its kill-on-close job, which ends the daemon without its shutdown, so a slow startup relaunched there reads as `second_boot`: the conservative side, a healthy build rolled back on that computer, never a broken one kept.

Validation writes `validated` to the record and, for the canary, `<version>/validated`. Then it releases the lease and clears any standing error.

### Rollback

A failed restart falls into one of four cases:

| Failure | Who sees it | What happens |
|---|---|---|
| The ladder staged, or the restart never arrived | The old daemon, still running | Nothing to roll back: the old build never stopped. Take back the marker it wrote, if hoai never took it (the same mtime as this ask's, so never another's). Record it, release the lease, record "no verdict" for the canary, back off, report. |
| The session came back on the old version | The daemon after the restart | Nothing to roll back. Record it, release, no verdict, back off, report. |
| The session came back on the new version with a new pin | The new build's daemon | The conversation is lost and that is said (`idle_update_context_lost`). The new session then validates like any other: a lost conversation is no reason to roll back, but a build that fails validation is. |
| The session came back on the new version and the new build fails validation | The new build's daemon | **Roll back,** as the canary, or once as any other agent (below). The trigger is either a second lock-holding boot on the target with no validation (the first one died, and hoai's unattended `no-channel-heartbeat` relaunch started it again), or no validation within 15 min of a live lock-holding boot. The same on a version the canary already proved: hoai relaunches once, so no third boot comes, and this verdict's latch is what stops the next follower. The deadline's trigger is suppressed while the login has expired, because that failure is the login's, not the build's; a second boot's is not, in practice (Residuals). |

**A failed non-canary has a way back too** (round 2, Data's fix 4). It used to report and stay, so a person was its only way off a build that failed for it. It now takes the same path as the canary: `<target>/bad`, the install pointed back, a restart onto the old build at the next quiet moment, `idle_update_rolled_back`. The canary role is read again at failure time, as before: a canary whose attempt was voided (it came back late), or a version another agent validated meanwhile, is a non-canary, and now has this way back as well.

- **What it goes back to.** The newer of its own `from` and the `from` in `<target>/validated`, the build the canary left. Fifteen agents do not all come from one version, and one agent that came from an older build must not take the whole computer further back than it has to. The canary's counts only where this install can stand on it: a plain X.Y.Z, in the same marketplace cache as this agent's own (another config folder's, or a checkout's, does not), with its folder still holding that version, and not held bad here. Otherwise the agent's own stands. A clone always goes back on its own checkout: another agent's commit names nothing in it. A version held bad is passed over where a good one stands beside it, but the agent's own build is never refused: it ran here until this restart, and the build it is on just failed. A refusal would leave the agent and the shared install on the failed build, where a restart by hand and a reboot both land. A canary goes back to its own `from`, whatever the others run (Residuals). The record takes the source, so the report and the restart both name the build actually installed.
- **Once.** The canary's failure is the version's verdict and is never limited. Any other agent has one go: `went-back-<assistantId>`, created before the install is touched and removed the next time this agent validates a build. A second failure before that stays on the build, reports `idle_update_failed` and asks for a person. It writes no latch and frees the lease at once, so the next follower may walk on after the 2 min spacing and give the verdict itself. The file names its target, so a boot after a crash mid rollback finishes the way back it started: gate 7 never lets the agent onto that target again, so this is no loop. Without this bound an agent broken for its own reasons would take every release back as a follower. It does not cover the canary role: a spent agent that becomes the canary on a later version still gives that version's verdict (Residuals).
- **On a clone it costs more.** A clone's rollback arms the shared safety latch, which pauses updates on that checkout until a person boots it once with `BGOS_AUTO_UPDATE` off and once with it on. So on a clone the first follower failure already asks for a person, for every agent on that checkout, and the report says how. No newer version lifts it. `went-back-<id>` outlives the lifting, so that agent's next failure before it validates a build stays on the build.
- **The cost, stated.** The rollback is shared, so a healthy agent on the target keeps running it, reads `from` as pending (`pendingMarketplaceRestartVersion` uses inequality), and goes back at its next restart, a watcher sweep or a click. If `from` is itself held bad it reads nothing pending, and moves only at its next plain restart, with no record and no validation. Gate 2 never takes it back by itself, and its own card says nothing. That is the design's declared safe side: a healthy release held back, not one agent left on a build that fails. It is not a promise for every failure: a daemon that dies after its first beacon gets no next boot from hoai, and one that dies twice inside its first 2 min goes back on the install but not in the session (Residuals, Calls 19). See Calls, 13.

Validation and rollback both stop (`passive`) while this daemon does not hold the pairing lock or is shutting down.

**The rollback:**
1. **Marketplace:**
   - First write `<target>/bad`, before the install is touched, so no other agent goes onto the build whatever the install does next.
   - Point the `hoai@hoai` entry of `installed_plugins.json` back to `{version: from, installPath: fromRoot}`, only if `fromRoot/.claude-plugin/plugin.json` still says `from`. Write it atomically, read it back, and write it again if a concurrent claude wrote its own snapshot over it, up to three times. One that never holds fails the rollback (`not_persisted`).
   - Turn off Claude Code's startup auto-update for this marketplace (`ensureMarketplaceAutoUpdate({enabled: false})`, `lib/claude-preseed.mjs`), so the relaunch does not reinstall the target. A switch-off that throws or does not persist fails the rollback (`auto_update_still_on`): a restart would only reinstall the build being left.
   - That switch-off is recorded in `~/.bgos-agent/idle-update/enrolment-hold.json`, with the Claude config folder it was made in, only when this call made it. The hold is per HOME and the switch is per config folder, so the reclaim below takes it back only in that same folder; another folder's `false` is a person's. An `autoUpdate: false` a person set stays theirs: today's enrolment never overturns one (`declined`), and nothing here records it.
   - The boot enrolment (`server.ts`) leaves it off while the marketplace's latest version is latched bad on this computer. Once a newer version is published, it takes back its OWN switch-off (`ensureMarketplaceAutoUpdate({reclaim: true})`, passed only with the hold on record) and removes the hold.
2. **Clone:** the self updater's own rollback, split from its `exit(0)`: the shared lock, the dirty tree refusal, `git checkout --detach fromCommit`, a dependency reinstall if needed, and the shared safety latch. It is the existing clone semantics for a bad build: updates paused, and the app says so.
3. (`<target>/bad` was written first, above.)
4. Wait for a short safe moment with the same respect as the update restart: the lock holder, not draining, no turn, nothing owed, no permission card, no open ask, no goal, no call, no browser in use, nobody attached, no background job, a known wake not due within 10 min, 2 min quiet (30 min with no hook signal). A turn flag nothing has backed for 2 h stops counting, as at gate 10, with a readable tree and no job in it: a turn interrupted before the build went deaf never reaches its Stop. A schedule the failing build cannot read does not hold it (that would keep it on the build that fails). No lease or canary wait: neither ever holds a way back, so past a lapsed lease it can overlap another agent's restart (Residuals).
5. `restartForRollback(from)`, only through an authority proven unattended (gate 6). One reading that does not prove it (a listing that failed, a launch-status mid-rewrite) waits; only after 10 min with no proven reading, or with no restart authority at all, is the old build left installed with `idle_update_rollback_failed`, asking for a restart by hand: never a session a person may be typing in. Through an owning systemd unit it also waits for a stray in the unit's cgroup, for 10 min at most (a daemonised process a tool left there may never end), then asks for a restart by hand the same way. Any other wait is bounded at 3 h (`rollbackWaitMaxMs`, past the 2 h of a stale turn): the app already says the agent went back, so past that it reports `idle_update_rollback_failed` and asks for a person.
6. The old version's daemon boots, finds `rolled_back`, and reports it.

If the target boots again after a rollback, the state becomes `rollback_failed`. It is reported, and nothing is tried again: one rollback, never a loop.

**Residual, stated not hidden:** a build so broken that the daemon cannot evaluate at all (a syntax or link error) is not caught by the daemon itself. It costs the canary, and at most one retry 24 h later. hoai raises its own `no-channel-heartbeat` alert, and every other agent holds the version.

### Reporting

- **Restarted onto X:**
  - the new daemon's boot heartbeat carries `daemonVersion` X and `pendingRestartVersion` null, so the app moves from restart pending to up to date;
  - the log says `idle update: restarted onto X from Y, resumed pinned session <pin>; validated Ns after boot`;
  - any standing idle update error is cleared.
- **Failure:** a fourth `lastError` producer, after the login, the usage cap and the deaf verdict. The backend takes any code of at most 64 characters with a message of at most 300 (`HeartbeatErrorDto`), so no backend or app change is needed.
  - `scheduled_update_failed` for did not arrive, came back old or no authority. The app already shows "The automatic update could not finish; it will try again", which is what the back-off does. The message names the versions and the next try.
  - `idle_update_rolled_back`: "X did not come up healthy, so this agent went back to Y." On a marketplace install X is held until a newer version; on a clone the report says how to lift the paused updates.
  - `idle_update_held`: an agent held off a version latched bad here. An unconfirmed canary is a plain wait, with no report.
  - `idle_update_launcher_latched`: a marker that hoai stopped taking, read from the waiting marker, or from the record when the did-not-arrive path took that marker back (`markerStranded`).
  - `idle_update_no_turn_signal`: an agent with no hook signal, past the 30 min quiet window. A hook event ends the wait, and a later gate may still refuse the restart, so the report promises none. If it has no hooks, one restart by hand moves it on.
  - `idle_update_failed`: an agent that already used its one way back failed again, and stays for a person. A restart by hand loads what is installed, and the report says that may be this same build: another agent may have moved the install since.
  - `idle_update_rollback_failed` and `idle_update_context_lost` (the conversation could not be resumed). The last stands until the next update attempt replaces the record: the person should know the conversation was lost.
- **No chat message.** Fifteen agents saying "I updated" is noise, and the app shows the version.

## What a restart does to /loop and scheduled wakes

Data's question, fix 5. hoai relaunches claude with a plain `--resume <pin>`. Read from Claude Code 2.1.314 (the installed binary) and its docs (`code.claude.com/docs/en/scheduled-tasks.md`, `sessions.md`), then tried on the rig where a rig can show it.

| Schedule | Where it lives | Across a restart | What the idle update does |
|---|---|---|---|
| A backend wake (the `schedule` tool) | The backend | Survives: no state on the agent. Its fire reaches the resumed session by push or poll, like any card. | Gate 21 waits for one due within 10 min. |
| An interval `/loop`, or a recurring `CronCreate` task | The session's transcript | Restored by `--resume`: "When you resume with `--resume` or `--continue`, Claude Code restores the tasks scheduled with `CronCreate`, except recurring tasks that have expired and one-shot tasks whose scheduled time has passed." Runs missed while it was down are not caught up. The 7 day expiry still counts from when it was created. | Not held. |
| A one-shot `CronCreate` task | The session's transcript | Restored if its time has not passed. | Held by gate 12b for 2 h from the last Stop, the safe side: nothing separates it from a pending wakeup in what the hook is told. |
| A self-paced `/loop` (ScheduleWakeup) | A pending wakeup in the session | **Lost, with no notice.** "A self-paced `/loop` isn't restored, so run `/loop` again to restart it." The one re-arm in the binary reads `.pending-wakeup` in a job directory, and hoai's claude has none. | **Held by gate 12b.** |
| A durable job (`.claude/scheduled_tasks.json`) | A project file | Survives by design. Feature flagged, and off where this was read. | Not held. |

**Gate 12b.** Claude Code gives every Stop hook `session_crons`: "Session-scoped cron tasks (CronCreate, ScheduleWakeup, /loop) that will wake this session later. Empty array when none are scheduled." Each entry is `{id, schedule, recurring, prompt}`, and a pending wakeup reads `recurring: false`. The hook forwarder keeps the field, the daemon stamps the Stop that showed a one-shot entry (`sessionWakePending`, `sessionWakeAtMs`), and the next Stop that shows none clears the stamp. `session_wake` then holds the restart for `sessionWakeHoldMs`, 2 h from that Stop: a wakeup fires at most an hour on, so a live self-paced loop renews the stamp at every turn and holds the restart for as long as it lives, as a 5 min interval loop does through `recent_activity`. A wakeup that was cancelled or lost with no Stop after it holds for 2 h at most, then the update goes on.

**Why hold and not re-arm.** The daemon cannot arm a wakeup inside claude, and a message telling the agent to run `/loop` again would be a prompt the person never wrote. The hold keeps the schedule whole and costs only time: a loop that ends lets the update through, and a loop that never ends leaves the agent on the old build, which is what any agent busy for ever gets.

**What it does not cover, stated:**
- An older Claude Code that sends no `session_crons` gives no reading: no stamp, the behaviour before this fix.
- The rollback restart does not wait on gate 12b: it leaves a failing build, so it ends a self-paced loop, and the conversation carries on without it.
- `context_lost` loses every session schedule, interval ones too: a new session has no transcript to restore from. It is reported as `idle_update_context_lost`.
- A click, the watcher's sweep, a clone's scheduled update, the hook restart and hoai's own health relaunch do not read gate 12b, as they read none of these gates. Each ends a self-paced loop the same way, as on main.
- The stamp lives in the daemon's memory: a daemon that restarts for another reason forgets it until the next Stop.
- A one-shot is held for 2 h from the last Stop, not until its time. One that falls due inside a later restart can be lost, and only backend wakes reach gate 21.
- The hold has no report: a loop that never ends leaves the agent on the old build, says so once in the log (`waiting: session_wake`), and shows nothing in the app. It needs no person, as a goal that runs for days does not.
- A wakeup armed after the last Stop is not seen until the next Stop. A wakeup is armed inside a turn, so the Stop of that turn sees it.

**On the rig** (scenario `wake`): see Round 2 below. The stand-in claude proves the daemon's handling, never Claude Code's own restore. That rests on the docs and the read of 2.1.314 above.

## Non-goals and anti-goals

- **Not a forced update.** Nothing ever restarts a busy agent; waiting is always the outcome.
- **Not a new restart path.** No kickstart, no `process.exit`, no `restartAgent` from the daemon.
- **Not a change to clicks, the scheduled update or the hook restart.** They keep today's ladder exactly.
- **Not the watcher.** Where its sweep is active, this controller stands down (gate 4). The version latch reaches the watcher through `pendingRestartVersion`.
- **Not lanes** (`lane-server.ts` has no ladder). **Not a backend or app change.**
- **Not a hoai change.** Field launchers keep their old code until their own restart.
- **Anti-goal:** any path that can leave a daemon drained and deaf. The ladder's 3 minute watchdog stays the bound.

## Platforms

| Platform | Shape | Authority used |
|---|---|---|
| macOS launchd or Linux systemd --user | gen-2 `bin/bgos-agent` job (run.sh starts hoai in tmux) | The own launcher rung: a marker to the proven hoai |
| macOS launchd or Linux systemd --user | A declared job that owns the daemon, its claude resuming a pinned session | Owning service (existing, ownership proven); on systemd it waits for strays in the unit's cgroup |
| macOS launchd or Linux systemd --user | gen-1 job (run.sh starts claude fresh) | Never: the conversation would be lost. One restart by a person or the watcher moves it to gen-2 |
| macOS or Linux | Bespoke keepalive script with keepalive.json | Keepalive SIGTERM (existing, proven) |
| Windows | "HOAI Agent" logon task: wscript of a hidden run-agent.vbs, then `hoai-core.mjs --keep-alive` | Launcher marker (existing) with the Windows unattended proof |
| Any | A person's own `hoai` or `claude` | Never |

## Rollout

The controller ships in 0.81.0. An agent still running 0.80 or older cannot run code it does not have. Each such agent needs ONE restart to load 0.81: by a person, by the watcher's sweep, or by an owning service. From then on it updates itself. Alex's 15 agents need that one restart.

## Proof plan

**Unit, red first:**
- `test/idle-update.test.ts`: one test per gate, plus the version order, lease, canary, record transitions, back-off, validation and rollback decisions. Each has a mutant recorded in `docs/idle-update/mutants.json`.
- `test/update-rpc.own-launcher.test.ts`: the rung and every refusal (not an ancestor, not hoai, a nested claude, a dead pid, the click, scheduled and hook paths unchanged).
- `test/pending-restart.test.ts`: additions for the latch.
- `test/idle-update.wiring.test.ts`: the server.ts dependency block.

- `test/idle-update.controller.test.ts`: the controller over an in-memory disk; `test/idle-update.host.test.ts`: the host readings and the marketplace rollback; `test/self-update.idle-rollback.test.ts`: the clone rollback without an exit; `test/claude-preseed.test.ts`: the reclaim.

**Integration:** `test/idle-update.integration.test.ts` joins the real controller, the real `UpdateRpcHandler` (its own launcher rung) and the real host readings on the real disk in a scratch HOME, with a gen-2 Mac process table. The real `superviseClaude` taking the marker is the rig's job, on the real chain.

**Rig** (`docs/idle-update/rig/`, Windows, this box). The scale (`BGOS_IDLE_UPDATE_SCALE`) is honoured only when the backend URL is a loopback address, so a real agent can never shrink its windows; two windows keep floors under any scale (did-not-arrive 3.5 min, beacon fresh 30 s).
- **The real chain:** a hidden `wscript` of a generated `run-agent.vbs`, then the real `hoai-core.mjs --keep-alive`, then a stand-in `claude.exe` (node, which speaks MCP to the daemon and keeps a transcript per pin), then the real daemon (`bun server.ts`), loaded from a marketplace-style `installed_plugins.json` in the scratch config dir.
- **No scheduled task is created.**
- **The stub backend** on 127.0.0.1 (43000 to 48999) captures heartbeats and serves the schedule, and runs a socket.io server so the daemon's WebSocket is healthy and the channel beacon is written as in the field. It answers always-on false (true with `--always-on`, for the launchd proof) and never sends `watcher_install_rpc`.
- **Processes are killed by exact pid only.**
- **Scenarios:**
  - staged plus idle restarts once and reports;
  - each busy case waits: turn, owed reply, open ask, goal, call, browser, wake due, young;
  - a broken staged build rolls back;
  - 15 agents stagger with no overlap;
  - a pending wakeup holds the restart, an interval `/loop` does not, and a backend wake armed before the restart fires into the resumed session.
- **Scheduled tasks:** `schtasks /query /fo csv /v` hashed, and in WSL `systemctl --user list-units --all`, `list-timers` and `crontab -l`, before and after each run. They must be identical.

**MACOS-PROOF.md:** a short script (`macos-proof.sh`) Data runs on a Mac. It installs one scratch agent with the REAL installer (`bin/bgos-agent install --always-on --no-clone`) under a scratch HOME, so the job is the gen-2 shape that failed on Alex's Mac (launchd, run.sh, tmux on the agent's own socket, hoai under expect). Its label and socket carry the scratch HOME's id. It cleans up by its own label, socket and pid, compares `launchctl list` before and after, and prints `MACOS PROOF PASS` or `FAIL`.

**Not proven live here:** the gen-2 tmux ancestry rung on a real launchd or systemd host. This box has no Linux node or bun, and no expect. It is covered by unit and integration tests over real-shape process tables, and by `MACOS-PROOF.md`.

## Rig results (Windows, this box, scale 5)

These runs predate round 2 (the 60 s hold, no way back for a follower). Round 2's are at the end of the Round 2 section. Run on `7afa42d` (the merge of main 0.80.2 and the eighth review's fixes); the two busy batches marked * on `48697ef`, whose only change is those two cases' rig steps. Every run: the real chain (hidden wscript, real `hoai-core.mjs --keep-alive`, the stand-in claude, the real `bun server.ts`) in a scratch HOME on E:, a stub backend on 127.0.0.1 in 43000 to 48999, watcher install off, no scheduled task created. Windows scheduled tasks (237, sha `9a89a022c2e9`) and WSL scheduled work (`9a4d2d56f7c3`) identical before and after every run; nothing of the rig's left alive after any run.

| Scenario | Agents | Result | What it showed |
|---|---|---|---|
| idle | 1 | PASS, 6 checks | One restart onto 0.81.1; the second launch resumed the same session; heartbeats carry 0.81.1 with no error; record validated. |
| busy: turn in flight, reply owed * | 3 | PASS, 8 checks | The idle control restarted and validated; each busy agent never restarted through the quiet window and jitter, waiting for its own reason (`turn_in_flight`, `pending_messages`); once released, each restarted onto 0.81.1. |
| busy: browser in use, wake due * | 3 | PASS, 8 checks | The same, `browser_in_use` and `wake_due`. |
| busy: launched by hand, auto update off | 3 | PASS, 10 checks | `no_unattended_authority` and `off: updates_disabled`; both still never restarted after the others were released. |
| busy: open ask card, call live | 3 | PASS, 8 checks | `open_ask` and `call_active`; released, both restarted. |
| busy: goal running | 2 | PASS, 6 checks | `goal_running`; released, it restarted. |
| broken | 2 | PASS, 10 checks | The canary restarted onto the broken build once, came back on 0.81.0 in the same session, reported `idle_update_rolled_back`; the install points back at 0.81.0, 0.81.1 is latched bad, Claude Code's update for the marketplace is off; the other agent never restarted; 3 launches in all, no loop. |
| stagger (real chain) | 3 | PASS, 6 checks | Each restarted exactly once, relaunches 51 s and 53 s apart (spacing 24 s), none before the previous one validated, every session kept. |
| many (`stagger-many.mjs`) | 15 | PASS, 10 checks | Fifteen real controllers, each its own process on the real disk: all 15 validated on 0.81.1, each restarted exactly once with one attempt, the first onto the version was canary 1, relaunches at least 45 s apart (spacing 24 s), none before the previous validation, no rollback, 0.43 GB at peak. |

**Why the busy cases run in batches and the fifteen as light processes.** Each real-chain agent commits about 0.9 GB (`bun server.ts` about 470 MB and the compiled stand-in about 340 MB, measured by the rig per process name), so the ten busy agents together, or fifteen stagger agents, pass the 4 GB a probe may use on this box (fifteen need about 13 GB). Each busy batch is the idle control plus up to two cases; the stagger runs on the real chain with three, and with fifteen as real controllers in their own processes. What `many` fakes: the process table, the turn and backend facts, and the restart itself (the supervisor relaunches on the controller's ask). The chain those fakes stand for is what the real-chain runs prove.

**What the rig found on the way, all in the rig:** a fresh chat's first message is read as backlog (no tracked reply, by design on main), so the owed case first gets one message; a browser tool outside a turn that ends reads as a turn in flight, and the browser window (6 min at scale 5) is shorter than the hold, so the case uses the browser again every 2 min; a run once saw Windows remove two of its own `\SoftLanding\` tasks mid-run (the strict check failed it, and it was run again).

## Residuals, stated not hidden

- **The wake schedule is the agent's own view.** Tasks another acting user created on a shared agent are not in it, and meetings live elsewhere. A restart can land close to one of those; it still waits for an idle, quiet session, and the session it resumes is the pinned one. Whether a fire that lands during the restart minute is redelivered is the backend's, not verified here.
- **Two agents breaking the same expired lease at once:** both rename it aside, and each checks that the file it moved is the one it read; the one that moved the other's fresh lease puts it back. The window is one rename wide, and the canary files are exclusive creates, so at worst two restarts on one computer, never a lost latch.
- **Wall clock.** Every window but validation's deadline is measured on the wall clock (the stamps in the files are ISO times). A computer that sleeps or a clock that jumps can shorten a wait; the lease and the canary still serialise the restarts. Validation subtracts sleep with the monotonic clock. On Windows, whether `performance.now()` stops across sleep is not verified here; if it does not, a canary that sleeps through its validation can still be rolled back, which costs that one agent and holds the version, never more.
- **Enrolment comes back only at a boot.** After a marketplace rollback, Claude Code's own update stays off until a newer version is published AND a daemon of this computer boots. The app's update button (a click) still works meanwhile.
- **A build that cannot evaluate at all** (see Rollback) is caught by hoai's own health relaunch and the canary hold, not by the daemon.
- **A build whose daemon is slow on one boot and then dies on the next.** The first boot ends cleanly when hoai relaunches it (a re-arrival), the second dies before it can act, and hoai's one beacon relaunch is spent, so no boot is left to roll back. The canary is deaf (hoai raises its no-channel-heartbeat alert), the version stays held by the canary on every other agent here, and the version is held 24 h, then one more agent tries, and a second silent canary latches it. The same class as a build that cannot evaluate at all.
- **On Windows a slow startup that hoai relaunches on a version no canary has proved is rolled back, and the version is held bad on that computer until a newer one.** hoai's kill-on-close job ends the daemon without its shutdown, so no clean end is on record and the next boot is `second_boot`, the same as a build that crashed before its first beacon. No other canary retries it: a retry would need the possibly broken build installed for the whole computer again, where any reboot puts every agent on it. The agents stay on the old, working build; nobody is deaf. The same holds for a follower on a version the canary proved: its slow start costs every agent here that release, which is the price of the latch that stops a crashing build at the first follower (Calls, 11). The trigger is narrower than any slow start: boot 1 must have taken the pairing lock (the record settles `arrived` there) and still written no beacon 3 min after claude started. A slowness wholly before the lock leaves the record `requested`, and the next boot is a plain arrival. See Calls I made, 11.
- **A second canary whose validation runs past 100 min is latched bad by the others.** Sleep and passive minutes are not counted toward a validation's deadline, and an outage is forgiven both before and after startup completes, so a validation can outlast `canarySilentMs`. It needs a first canary that already went silent. The outcome is the safe one: a healthy version held on that computer until a newer one, nothing rolled back. A canary that refreshes a liveness stamp each poll would close it, and would open a race at wake (every agent wakes at once to a stale stamp), so it is left as stated.
- **A permanent stray in an owning systemd unit's group holds the update restart for good.** The update waits (a wait is always the safe outcome) and says `waiting: background_job`; the rollback restart is bounded (above).
- **A canary whose two canaries went silent leaves the install on the target.** The version is latched bad, so no other agent goes onto it and the watcher and enrolment hold it, but nothing rolls the shared install back: no agent on it proved it failed. The agents still on the old build stay there.
- **The enrolment hold file is one per HOME,** shared by the config folders under it, and holds one folder. A reclaim takes back only the folder on record. A second switch-off in another config folder before the first reclaims overwrites the record, and the first folder's Claude Code update stays off until a person turns it on (a missed update, never a broken build). Two marketplace config folders under one HOME is not the usual setup.
- **On Windows a shutdown, logoff or update reboot while an agent validates is a failed build too.** The same cause as the slow startup above: nothing on Windows writes a clean end. The window is the minutes between an agent's arrival and its first live proof, and it now applies to every agent on the target, not the canary alone. The outcome is the conservative one for any agent with its way back: the old build, the version held bad on that computer until a newer one. A spent follower stays, and nothing is held.
- **A rollback does not check that the install still names the failed build.** If Claude Code's own startup update installs a newer fix inside an agent's validation window and that agent then fails, the rollback puts the old build back over the fix. It heals at the next daemon boot on that computer (the rollback's own restart is one): the fix is not held bad, so the enrolment is reclaimed and the next claude start installs it again. The clone path is the same, through the self updater's checkout.
- **The authority is resolved twice:** once by the controller (which proves the launcher and checks a systemd unit's strays for the rung it picks) and again by the ladder. A transient ownership probe failure in the controller and a success in the ladder a moment later can restart through the owning unit without its stray check. It needs one probe of `systemctl show` or `ps` to fail and the next to succeed.
- **A person attached through a grouped tmux session is not seen by the keepalive check.** `list-clients -t` lists the clients of the agent's own session; a client of another session in its group shares its windows. The launchd and systemd jobs run tmux on the agent's own socket, where every client is listed; this is the keepalive rung only.
- **The bad latch is written before the rollback, and a failure to write it is not fatal.** On a full disk the rollback still happens, and the enrolment can reclaim, so a second canary may restart onto the broken build after the 24 h hold and fail the same way: one more agent, never a loop.
- **Validation and the rollback still run when the auto update is switched off after the restart.** Both are the safe direction (proving the build the agent is on, or going back to the old one); only a new update restart obeys the switch.
- **The rollback moment reads the turn state it was given;** a turn that starts between that read and the restart is cut. The same window as the update restart's, one poll wide.
- **`idle_update_rolled_back` is published before the restart onto the old build,** so a rollback restart that then stalls says so through `idle_update_rollback_failed` after 3.5 min. A daemon that dies first says nothing more (below).
- **macOS launchd jobs end a process group, not a cgroup.** A job a Bash tool detached into its own session survives a launchd restart; one left in the job's group is ended with it. Only systemd's cgroup is read for strays; launchd relies on the job scan under claude.
- **A gen-1 job never restarts** (above); it needs one restart by a person or the watcher to become gen-2.
- **A clean end in the moments the lock is with another daemon is not written.** It needs two live daemons of one agent, the lock moving early in validation, and the claude ending cleanly in that window. The next boot then reads `second_boot` and a healthy build rolls back on this computer: the slower, safe side. Writing it anyway would let a passive daemon stamp a record the holder is validating (16).
- **A daemon that adopts after a sleep may count the sleep once more.** Adopting restarts the passive and outage counters, but a sleep between this daemon's last poll and the adoption is still added at its next poll: the deadline (and a deaf build's rollback) comes later by that sleep at most, never earlier.
- **A failure the other boot gave under an expired login reads as a rollback under way.** The daemon that holds the lock again stands down, and the next boot of the agent settles the record (`second_boot`, a rollback). That is the slower side, never a broken build kept for good, and no regression: before adoption it stood down on any newer record.
- **A rollback in progress is not checked for a superseded record.** A daemon that loses the lock mid-rollback and holds it again carries on with the rollback it started. That is the safe direction (back onto the old build, the version held bad), so it is left as stated.
- **Whether a removed SIGHUP listener restores the default under Bun is not verified here.** Past its window a validating daemon drops its hangup listener; if Bun does not restore the default disposition, that daemon ignores a hangup until stdin closes, which ends it the same way a moment later.
- **The 30 s between the ladder's watchdog (3:00) and `did_not_arrive` (3:30).** hoai can still take the marker in that gap, as on main. The marker is removed only if it is this ask's, by exact mtime.
- **Retries against a latched hoai.** After the back-off, each attempt can still spend up to 3 min of drain on a launcher that takes no markers. It is bounded by the back-off and reported as `idle_update_launcher_latched`.
- **A shared rollback puts a healthy agent's next restart on `from`.** See Rollback. It reads `from` as pending until a newer version is published, or nothing at all if `from` is held bad, and its own card does not say why.
- **A spent agent can still be the canary.** `went-back-<id>` bounds a follower. An agent that used its way back and then becomes the canary on a later version gives that version's verdict, so one agent broken for its own reasons can cost several releases that way. Barring it from the role, or voiding its verdict, is Data's call.
- **N agents broken for their own reasons can cost N releases,** one each, before each needs a person. The bound is per agent, not per computer.
- **The hold proves about 3 min of delivery, not 5.** Liveness holds without a break for 5 min, but a beacon counts for 2 min after it was touched, so the last 2 min of the hold can rest on an earlier touch.
- **A daemon that dies after its first beacon has no way back from itself.** hoai checks the beacon once per launch and this one passed, so no next boot comes and hoai raises no alert. On a version no canary proved, the others hold. On a proven one only the 25 min lease holds the next follower, so a build the canary passed that kills followers this way walks on at about two agents an hour, if the fault reaches them (Calls, 19).
- **A daemon that dies twice inside its first 2 min goes back on the install, not in the session.** Boot 2's first tick latches the build and repoints the install, and the rollback restart then waits for 2 min of quiet from that boot, or 30 min with no hook signal. hoai's one relaunch is spent, so the agent stays deaf on the failed build until a person restarts it, and that restart lands on the old build. hoai raises its alert, no other agent follows, and `idle_update_rolled_back` may have landed while the agent is still on the target. A canary has had this since round 1, and followers now take the same path. A restart with no quiet and no hook signal would be a wider exception to fix 1 than Call 17 (Calls, 19).
- **A daemon that dies before its first settle leaves no trace.** The record stays `requested` and the next boot reads as a first arrival, so two such deaths give no verdict.
- **A canary's proof is keyed by version, not by install.** `<version>/validated` is per HOME. A checkout or another config folder can prove a version for a marketplace install that never ran it, and then the marketplace agents go as followers with no canary hold. Keying the files by install is a change of shape, not a fix to these five.
- **A canary goes back to its own `from`, however old.** A busy agent that is first idle can be the canary from an older build, and its rollback takes the install there, past a version the others run and proved. Their next restart lands on it.
- **An agent whose `from` folder was swept can still be the canary.** Its rollback fails with `from_root_missing`, and it stays on the build with `idle_update_rollback_failed`.
- **An expired login does not suppress a second boot's verdict.** The first tick runs before any login sweep, so the login reads as fine there, and a usage cap the same. The deadline's suppression is real from the first sweep on; before startup completes nothing has swept yet. A second boot under an expired login rolls back, the slower safe side. A real fix needs a login signal that outlives a daemon.
- **A healed agent keeps its `idle_update_failed`.** A later boot does not settle `failed`, so a restart by hand that heals it still shows the report and still reads as spent, until the next attempt replaces the record.
- **On a checkout several agents share, a follower goes back to its own commit,** not the one the canary left: the validated file carries no commit.
- **The beside check is an exact compare.** One folder spelled two ways on Windows reads as two, and the agent's own build stands.
- **The rollback restart reads neither the lease nor the spacing.** Past a lapsed lease, or with two followers failing at once, two relaunches can overlap on one computer.
- **A stalled rollback restart names the build installed when it stalled.** `idle_update_rollback_failed` from that stage says the old build is installed again, which is true when it is published and stands for that daemon's life. Another agent may move the install after it, and the next boot replaces the report.
- **A passive daemon can write the record at `did_not_arrive`.** The `requested` phase does not read `active`. It needs an old daemon that outlives its claude while the new one holds the lock, and then the new daemon stands down from validating. Rare, older than round 2, and the next boot settles it.
- **Two followers can fail at once** (a lease that expired, or a voided canary and a second canary). The bad file is exclusive and each spends its own way back; the last repoint wins, and a report can name the other's build. The result of `went-back-<id>`'s create is not checked: a full disk loses the bound, not the rollback.
- **A crash between the repoint and the `rolled_back` write is silent on the next boot.** The install is back and the boot is off target, so nothing is reported and the lease waits for its expiry.
- **The take-back has one chance.** A marker that cannot be removed, a daemon that dies while it waits, or a rollback that goes passive leaves the marker for hoai's next poll, as before this fix. Only a latched hoai leaves one past a poll, and then it takes no marker.
- **An agent with no hook signal stays on its build until something else moves it.** Whether the real CLI's SessionStart env id matches on `--resume` is not verified here; the field check is the log line `hook intake: bound to session ... (proof: session-start)`.

## Calls I made (Data or Ares may overrule)

1. **"--continue" is read as "resume the pinned session".** Every supervisor already does it that way, and bare `--continue` is banned since 2026-08-23.
2. **The own launcher rung serves only the idle update and its rollback.** Clicks, the scheduled update and the hook restart stay exactly as on main.
3. **Gate 2 requires the staged version to be strictly newer.** The version latch is applied where `pendingRestartVersion` is computed, so every reader honours it.
4. **Round 2 overruled this: any agent that fails may roll back the shared install, the canary always, any other agent once (Rollback).** A marketplace rollback turns Claude Code's startup auto-update off for the marketplace until a newer version is published. A clone rollback uses the self updater's existing latch, which pauses that clone's updates.
5. **The controller stands down where the watcher's sweep is active.**
6. **Open non-blocking ask cards older than 24 h do not hold an update**, because they survive the restart. A goal is busy only when the transcript fold shows it, since a running goal is also a turn.
7. **An unreadable wake schedule fails closed,** with no time bound.
8. **The numbers:**
   - N is 10 min with hooks, 30 without (the watcher's numbers).
   - Jitter is 0 to 10 min.
   - The lease is 25 min and spacing is 2 min.
   - The canary is held 24 h, with a second canary, then latched.
   - Back-off is 24 h doubling to 7 days.
   - Validation needs 5 min of live delivery without a break, with a 15 min deadline from this boot's startup complete (15 min from arrival for a startup that never completes).
   - A boot whose last boot ended cleanly (at any age), or proved live, is a re-arrival, once.
   - An outage is forgiven for 60 min of validation at most; a canary is silent past 100 min.
   - A refused launch proof is read again 60 min on; a proof is kept for that launcher.
   - The rollback restart waits up to 10 min for a proven authority before asking for a restart by hand.
   - A marker older than 5 min is reported as latched.
   - The rig scales every duration down through one env var, `BGOS_IDLE_UPDATE_SCALE` (clamped, logged at arm time).
9. **Reporting reuses `lastError`,** and sends no chat message.
10. **Version proposal: 0.81.0.** Data sets it.
11. **A Windows slow start that hoai relaunches is a failed build, held bad on that computer until a newer version** (Residuals). The fifth review suggested voiding that canary so another retries at once, or retrying after the hold. Voiding retries a build that crashed before its first beacon on every agent here, one after another; a later retry reinstalls it for the whole computer while no agent on it has proved it. Both trade a safe outcome (a healthy release held back) for an unsafe one (a broken release reinstalled), so the code keeps the conservative verdict. Round 2 tried one exception, no verdict on a follower's second boot on a proven version, and took it back: hoai relaunches once, so the third boot it waited for never came, nothing latched the build, and the next follower walked on. A real fix needs a clean end hoai can vouch for on Windows (a launcher that records the daemon alive when it relaunches), which is a launcher change outside this lane.
12. **Data's review text is not on #291.** Its issue comments, reviews, review comments and commit comments are all empty, and the goal's `NOTES.md` is in the lane folder, not on the branch. Round 2 works from the five lines in the goal. Where a line has two readings the calls below say which was taken.
13. **"A way back" is read as the shared rollback, for any agent that fails, once.** A per-agent pin cannot be proven from this branch, and one agent stuck on a failing build is the unsafe side. This flips the second review's item 11 on purpose. Its cost is real and belongs to Data: a follower that fails for its own reasons holds a release every other agent proved, and on a clone it pauses updates on the checkout until a person acts. If Data means a per-agent way back, or the old rule on clones, this is the call to overrule.
14. **"The hold" is read as `validateHoldMs`: 60 s becomes 5 min.** The other holds (`canaryHoldMs`, 24 h) already give a build a day. Followers wait longer as a result: each canary now takes at least 5 min, and at 15 agents the stagger takes that much longer.
15. **The numbers that had to move with the hold:** `validateDeadlineMs` 5 to 15 min (it must leave room for a late break in the live proof, twice the hold and a poll either side; a deadline at or under the hold would fail every healthy build), `leaseTtlMs` 10 to 25 min (it must outlast a failing agent's verdict, through hoai's 3 min relaunch wait, a 2 min start and the deadline, or the next agent walks onto a build about to be held bad; a longer start runs past it, and costs one more agent), `canarySilentMs` 90 to 100 min (the startup bound, the outage, the longer deadline and the margin). `startupDeadlineMs` stays 15 min.
16. **Fix 2 is scoped, not reverted.** A plain revert brings back the sixth review's bug (a clean end the record never saw). Every daemon runs main's signal handlers again and the launch shim is main's; only a lock-holding daemon, from arrival to the first live proof, borrows more. The pipe fault path keeps its round 1 change (`stdout-epipe` and `broken-pipe` told apart), which alters a log line and the clean end proof, not the exit.
17. **What an agent with no hook signal gets (fix 1).** No unattended restart from this controller; a standing `idle_update_no_turn_signal` once it has been quiet 30 min, which names a restart by hand. The watcher's sweep (opt-in, its own 30 min rule unchanged) still restarts it, and so does a click where the ladder has an authority that owns the daemon. On a gen-2 service neither a click nor a clone's scheduled update does: they stage, as on main, and only this controller has the own launcher rung. A rollback still runs with no signal, at 30 min quiet: it leaves a failing build. That cost is the incident Data named, a long silent tool call cut, taken for an agent already failing. Data may overrule it.
18. **`/loop`: the hold, not a re-arm** (above).
19. **Three questions round 2 leaves for Data, because each changes a rule, not a bug.**
    - A follower's slow start on Windows takes a proven release back for the whole computer (Calls, 11). A hold that does not need a verdict could stop the spread without that cost: a shared file written when a follower acts, cleared when it validates, read like a canary. It is new machinery, so it is not in this push.
    - A daemon that dies twice inside its first 2 min stays deaf on the failed build until a person restarts it (Residuals). Asking for the rollback restart at once on a second boot would bring most of those back unattended. It needs a restart with no quiet and no hook signal, a wider exception to fix 1 than Call 17, so Data decides. The real answer may be hoai relaunching again, which is out of this lane.
    - A follower that dies after its first beacon gives no verdict, and only the lease holds the next one (Residuals). The hold above answers this too.

## What the review changed

1. **The new rung reached every ladder caller.** It is now limited to the idle update, because the click, scheduled and hook paths do not have its gates.
2. **The bad version latch held back only this controller,** and Claude Code's auto-update would have reinstalled the bad build. The latch now sits in `pendingRestartVersion`, and a marketplace rollback pauses the auto-update.
3. **Plain inequality would have cascaded a rollback into downgrades.** Gate 2 now requires newer, and only the canary rolls back.
4. **"startup complete" plus 60 s could validate a deaf build.** Validation now needs a beacon, a heartbeat at the new version, and no deaf verdict.
5. **The Windows `--keep-alive` flag is typed by people.** The proof is now the hidden wscript of run-agent.vbs.
6. **Read-modify-write shared state could lose a latch.** Per-version exclusive files replace it, along with a nonce on the lease, the hoai marker budget latch reported, a pin check for lost context, a second-canary cap, and the wake schedule re-read before the act.

## What the second review changed

A fresh security reviewer and a correctness reviewer read the branch at `c6ce58d`; each finding was verified by a third reader before it was fixed. Every one below has a red-first test and a mutant.

1. **The rollback restart could go through a launch not proven unattended** (critical). It now needs the same proven authority as the update restart; without one it reports and asks for a restart by hand.
2. **The rollback restart ignored the ask, goal, call, browser and wake gates.** It now waits for all of them, and only as the lock holder, never while draining.
3. **A keepalive's person check failed open** when its declared session was not found or none was declared. It now asks the tmux the daemon runs in, and anything it cannot ask is unknown.
4. **The controller armed only after "startup complete",** so a build that hung in startup was never rolled back. It now arms at the lock, and gate 9 waits for startup.
5. **A person's restart or a backend outage read as a broken build.** A build that proved live may boot once more; the deadline is suspended while the backend is unreachable and does not count the outage or a sleep; a second boot restarts the arrival clock.
6. **The status-only heartbeat counted as proof.** Only a beat carrying this build's version does.
7. **A reclaim could overturn a person's `autoUpdate: false` in another config folder.** The hold records its folder.
8. **`BGOS_IDLE_UPDATE_SCALE` worked in production.** It now needs a loopback backend, and two windows keep floors.
9. **Two silent canaries were never written as `<version>/bad`.** They are now.
10. **A keepalive relaunching with bare `--continue` counted as unattended.** Only a pinned resume does.
11. **A voided canary could still roll back a version another agent validated.** The role is read again at failure time.
12. **A slow rollback install ran outside the busy guard,** so a second tick could start it again. Validation is awaited inside the guard.
13. **An API key session would never validate** and so roll back every update. The idle update runs on paired agents only.

Minors fixed the same way: a record target or `from` must be X.Y.Z; the Windows proof names this agent's own `run-agent.vbs`; future lease, canary and watcher stamps fail closed; `installed_plugins.json` is read back; a switch-off that did not persist fails the rollback; validation and rollback stop when passive; a failed activity read counts as activity now; `<target>/bad` is written before the install; an rpc id like `constructor` is never a log-only label.

Not changed, stated: `idle_update_context_lost` stands until the next attempt (see Reporting). A second boot whose session came from the pin file rather than claude's command line is still read as `second_boot` unless the build proved live first.

## What the third review changed

A fresh reviewer read the branch at `8e3cb8f`; each finding was verified by a second reader before it was fixed. The broken build rig run found one more. Every one below has a red-first test and a mutant.

1. **A slow startup read as a broken build** (critical). hoai relaunches a session whose beacon has not appeared 3 min after start; that second boot had no `liveAt`, so it was `second_boot`, and the canary rolled a healthy build back for the whole computer. Startup minutes also counted toward the 5 min deadline. Now each validation poll writes `aliveAt`, a boot after a live predecessor is a re-arrival (once), and the deadline counts from this boot's startup complete, with a 15 min bound for a startup that never completes.
2. **The 60 s hold counted from arrival,** not from continuous liveness. It now counts from the first live reading, and restarts when liveness breaks or the daemon goes passive.
3. **Backend reach was read off the heartbeat alone,** which a slow startup has not sent yet. It is now read off every backend call.
4. **An owning service skipped the pinned resume check.** A gen-1 job restarts claude fresh: the conversation would be lost, unreported. It now needs a claude resuming a pinned session, as a keepalive does.
5. **One unproven authority reading gave the rollback restart up for good** (a failed listing, a stale launch-status), leaving a rolled-back agent on the bad build until a person came. It now waits 10 min for a proven reading.
6. **A systemd restart ends the unit's whole cgroup,** including a job orphaned out of claude's tree. The watcher checks those strays; the idle update did not. It now does, for the update and the rollback restart, and fails closed.
7. **Passive minutes counted toward the deadline.** They no longer do.
8. **The rig's broken build validated** (the rig, not the review): the daemon stamped the beacon in memory even when the beacon file was never written, so a build whose supervisor saw no beacon proved live to the idle update. The stamp now needs the write.

The first fix for 1 (each poll wrote `aliveAt`, and a boot within 2 min of one was a re-arrival) was itself wrong; the fourth review replaced it.

Minors fixed the same way: a person is read after the wake schedule call; a `released.json` or watcher stamp further ahead than its window holds nothing; the mutant run found three tests missing (the gate order, the lease create race, a record that cannot be written) and one vacuous (a passive record with no `from`).

Not changed, stated: the enrolment reclaim only at boot (see Residuals).

## What the fourth review changed

A fresh security and correctness review of the third round's diff, each finding checked by a second reader trying to refute it.

1. **A recent poll hid a crash** (critical, brought in by the third round's first fix). A daemon that died a minute before hoai's relaunch had polled within 2 min, so its next boot read as a re-arrival, that boot died the same way, and nothing ever rolled the build back. A re-arrival now needs a clean end on record: the daemon's own shutdown when its claude went away writes `endedAt`; a crash or a hang never does.
2. **An outage held the deadline with no limit,** and every failed call counted as one, so a build that breaks its own calls sat on the canary for good. An outage is now forgiven for 60 min at most, and only calls to the backend's own base URL count.
3. **One failed process listing was remembered** as a launch not proven unattended for a keepalive or an owning service, and the update then waited for good. A table with no claude row is no longer remembered.
4. **The rollback restart waited for good on a cgroup stray that never ends,** while the app had been told the agent went back. It now asks for a restart by hand after 10 min.
5. **Minutes under an expired login counted** toward the deadline once it lifted. They no longer do.

Minors fixed the same way: the hold needs the beacon touched again and a version heartbeat landed during it, on this boot; `readServiceStrays` fails closed with no service named, a running unit with no group, or a group member the listing does not have.

## What the fifth review changed

A fresh review of the fourth round's diff, each finding checked by a second reader.

1. **A fault in the broken-pipe class was written as a clean end** (important, found by both readers). The daemon's fault handlers send any error `isBrokenPipe` matches (EPIPE, a write after end, a destroyed stream: on any stream, not only stdout) through `shutdown('stdout-epipe')`, and shutdown wrote `endedAt`. A new build that hit one before its first beacon would re-arrive on hoai's relaunch instead of being rolled back. A clean end is now `isCleanEnd`: stdin ended or closed, SIGTERM or SIGINT, and a broken pipe only once stdin has ended too.
2. **On Windows a slow startup holds a healthy version bad until a newer one** (important). The code was right to roll back; the design was wrong to say another canary retries it. The residual now says what happens, and why the code keeps it is call 11.
3. **The launcher branch remembered a refusal from an input it could not read** (minor, from both readers). The same class as the fourth review's third finding, on the other branch: a run-agent.vbs read during an antivirus scan, or a listing missing a row, refused the launch for the daemon's whole life. Only a proof, or a launcher pid that is not this session's hoai, is remembered now; anything else is read again at the next close look, 5 min on.
4. **A second canary past its 10 min lease was latched bad while it may still be validating** (minor). Silence is now 90 min.

## What the sixth review changed

A fresh review of the fifth round's diff, each finding checked by a second reader.

1. **A hangup was not a clean end** (important, found by both readers). On the supervised macOS and Linux shape, hoai ends a slow start by SIGTERM to expect, whose trap kills claude and exits. claude leads expect's pty session, so when it exits the kernel hangs up its whole process group, and the daemon, which handled only SIGINT and SIGTERM, died on SIGHUP's default action without its shutdown. No clean end, so the next boot was `second_boot` and a healthy build rolled back: the case the design said only Windows has. The daemon now routes SIGHUP through its shutdown (exit 129, off Windows; repeated hangups are harmless), the launch shim forwards it, and SIGHUP is a clean end.
2. **The broken-pipe rule could never count a real departure** (minor). Stdin's flags are set as its end event fires, and that event shuts down first, so `shutdown('stdout-epipe')` never saw stdin ended; a claude gone abruptly can surface as EPIPE on the daemon's own output first. Now a broken pipe on the daemon's own stdout or stderr is caught on the stream itself and is clean (its reader is claude); the fault handlers' broken pipe, on any other stream, is `broken-pipe` and never clean.
3. **A person's own hoai was looked at every 5 min for as long as an update was staged** (minor, from both readers), a cost the fifth round brought in. A refused launch proof is now remembered for 60 min, then read again: once an hour for a person's own session, and a refusal on one unreadable input heals within the hour.
4. **The 90 min canary silence is not a hard bound on a validation** (minor, from both readers). Stated as a residual: the outcome is the safe one.

## What the seventh review changed

A fresh review of the sixth round's diff.

1. **A second SIGTERM could still end the daemon before its clean end** (important). SIGINT and SIGTERM were one-shot handlers. A systemd stop signals every process in the unit's control group, so the daemon gets SIGTERM directly and again through the launch shim's forward; the second one, with no handler left, took the default action and ended the daemon midway through its shutdown, before `endedAt` was written, so the next boot read as `second_boot`. All three signals now stay handled; `shutdown()` already runs once whatever reaches it.
2. **Only the reader gone is a clean end on the daemon's own pipes** (minor). A write after end or to a destroyed stream on stdout or stderr is the daemon's own doing, so it now goes to `broken-pipe` like any other broken pipe; only EPIPE (`isReaderGone`, with or without its code, as bun surfaces it) is clean.
3. **A handled hangup kept the launch shim alive** (minor). Before round six, SIGHUP's default action ended the shim. Now that it forwards the hangup, a child whose shutdown is stuck would hold both processes open with nobody reading them. The shim kills a child still running 10 s after a forwarded hangup, on a timer that never holds the shim open.
4. **A clean end counted for 2 min only** (minor). A computer shut down (or a person quitting the session) while a restarted agent is still validating ends its daemon cleanly, and the next boot can be hours later; with the 2 min grace that boot was `second_boot`, and a healthy build rolled back. A clean end now allows its one re-arrival whatever its age. One re-arrival per record still bounds a loop, and a crash or a hang still writes no `endedAt`.
5. The hangup describe test now checks the line, not only the signal's name.

A second pass of the same review, over the fix above:

6. **A crash on a new session could inherit the clean end of the boot before it** (found by both readers; minor, but this round brought it in). A `context_lost` settle carried `endedAt` forward, and with the age bound gone, a crash of that boot on its new session read as a re-arrival, one more crash cycle before the rollback. The new session's settle now clears it.
7. **A daemon that had lost the lock could write its old record over a newer one** (minor, older than this round). A daemon validating when another session of the agent took the lock stayed passive with its in-memory record, and its clean end, or its validation once it held the lock again, wrote that record over whatever the other boot had settled: in the worst case over a newer version's attempt, so a broken newer build was never rolled back by this agent. Both now read the record on disk first.

A third pass, over the second:

8. **Standing down left the attempt with no verdict** (important, found by both readers). The first version of 7 stood down to watching whenever the record was superseded. But a daemon sees that only once it holds the lock again, when the boot that settled the newer record no longer does: nobody gave the attempt a verdict, so a deaf build stayed until the next boot and a healthy one was never confirmed (the other agents held for its canary). Now the same attempt with no verdict is validated on the newer record by the daemon that holds the lock; only another attempt or a verdict makes it stand down.
9. **A crash on a new session could still be forgiven through the live proof** (minor). The new session's settle cleared `endedAt` but carried the previous boot's `liveAt`, the other half of the re-arrival condition. It now clears both.

A fourth pass, over the third (a fresh security reader and a correctness reader, each finding checked by a skeptic; no Critical or Important survived, these Minors were real):

10. **Adopting could validate over a failure verdict mid-rollback.** `second_boot` and a missed deadline append their attempt but leave the record arrived while the rollback runs; a daemon holding the lock again after that boot died mid-rollback adopted it and could write `validated` over a version this computer latched bad. Those two outcomes now make it stand down, as before 8, and the next boot finishes the rollback.
11. **Adopting took the time before the other boot's arrival off twice.** The deadline counts from that arrival, but the sleep, passive and outage minutes this daemon had built up before it were still subtracted: hours of them could hold off a deaf build's rollback for as long. The counters now restart at the adoption: all the time since that arrival is uncounted, and no outage before it is.
12. **Adopting kept the other boot's clean end and live proof**, so a crash of the adopting boot could read as a re-arrival. They are dropped (written at once), as in 9.
13. A typing error in the stand-down test (`JSON.parse` of a read that can be null) that tsc caught.

14. **The other boot, still alive, could write over the adopter's verdict.** Reported as important, confirmed as minor. The pairing lock can move back to a live daemon (a stale heartbeat after a sleep, a channel takeover). Its copy of the attempt has the same nonce and arrival, so the check in 7 saw nothing newer, and it validated its stale copy: in the test it wrote `failed` over `validated`. A verdict state on disk that differs from the daemon's own, or more attempts on disk than in its copy (a missed deadline appends one and keeps the state), now supersede too. A disk that refused this daemon's write holds fewer attempts and an earlier state, so it still supersedes nothing.

Three Minors were refuted by their skeptics. A same-nonce record with another target cannot steer a rollback: a nonce is one attempt's, and the record file is already trusted at boot. A future `arrivedAt` holds validation pending whoever settled it, so adoption adds nothing there. And the adopted pin is the session the attempt now lives on.

A fifth pass, over the fourth (the same two lenses and skeptics; one Important claimed, confirmed as minor; every finding below real):

15. **A daemon stood down on its own failed boot.** The stand-down in 10 read the record's last attempt, whoever gave it: a daemon whose own `second_boot` came under an expired login (no rollback, it keeps validating) stood down for the rest of its life once another session re-arrived on the record. Only a failed boot or a missed deadline the other boot appended, beyond the attempts this daemon holds, now makes it stand down.
16. **A daemon that no longer held the lock could still write its clean end**, onto a record another daemon had adopted, bringing back the proof that 12 dropped. The clean end is written during the shutdown, when `active` is already false, so the controller asks `holdsLock` (the lock alone) and writes only as the holder.
17. **A lock that moved and came back between two polls kept the hold's old start.** A live daemon that never saw itself passive adopted with its hold begun before the adopted arrival, which can never count, and a healthy build rolled back at the deadline. The hold now starts again at the adoption.

The same pass also found a record with an unreadable `arrivedAt` adopted forever pending (refuted: every writer of an arrived record stamps it).

A sixth pass, over the fifth (the same lenses, ranked against an explicit bar: a broken build kept, a healthy one rolled back in a realistic case, a loop, a busy or unsupervised restart, or data loss). One Important was claimed, and its skeptic confirmed it as a minor that predates the branch. Three findings were real, all minor and rare, and stand as residuals below rather than as a further round of changes. Each would trade one rare corner for another.

## What the eighth review changed

A fresh security review of the whole branch after origin/main (0.80.2) was merged: three readers (the restart authority, the install and its files, the rig and proof scripts), each finding checked by two skeptics with different lenses. No Critical or Important survived; the three reported as important were confirmed as minor. Changed:

1. **A nonce read from disk could name a path.** The record's nonce went unchecked into the name of the file the lease is moved aside to, so a record and lease written by another process of the same user could make the daemon rename over and delete a file outside the machine folder. The aside name now takes only a plain nonce; any other moves nothing.
2. **The rig could end a process it never started.** A root was adopted at whatever pid the first listing showed, and a kill used the pid alone, a second or more after the listing. A root is now adopted only if it was created after its own start, and each kill reads the creation time and kills through the same handle. A failure once the run has started throws, so the teardown always runs; a stub that is slow to start is ended through its own handle before the next is tried, and only its own ready line counts. stagger-many ends its children through their own handles.
3. **The macOS proof's scratch folder was a predictable name in /private/tmp;** it is now `mktemp -d`.
4. **A mutant run killed outright leaves the mutant in the source.** The runner now refuses to start over a mutated file that differs from git.
5. **The full suite after the merge found two of main's own tests red.** `test/pairing-lock-standdown.test.ts` wants the hook intake stopped first in the shutdown, and `test/stand-down-sites.test.ts` runs the real shutdown site against stubs that had none for the idle update. The clean end is now noted right after the intake stops (still before the lock is released), and the site test stubs it.

Real but stated, not changed (Residuals): the enrolment hold for two config folders, a Windows shutdown during a canary's validation, a rollback over a newer fix, the authority resolved twice, a grouped tmux session, a bad latch that could not be written, and validation after the auto update is switched off. One skeptic of two confirmed that the rig's stand-in build passes its paths to cmd.exe unquoted; they are the operator's own `--run-dir` and checkout, so it stays. Refuted by both skeptics: the rollback's `fromRoot` and `fromCommit` taken from the record (the record is written by this agent's own daemon, and the root is checked to hold `from`), descendants missed when a parent exits between listings, the cmd.exe arguments of run-rig.sh, a second claude on the macOS proof's PATH, and stagger-many's run folder.


## Round 2: Data's five fixes

Data's word on `d5d63e1` was "merge after fixes", with these five. The review text itself is not on #291 (Calls, 12), so each row works from Data's line. Each has a red test before its fix, the fix, and mutants that turn the test red (`docs/idle-update/mutants.json`).

| # | Data's line | The incident it prevents | What changed |
|---|---|---|---|
| 1 | Unattended restart only when `turnSignal === 'hooks'` | With no hook signal a turn cannot be seen, so a long tool call with no transcript write reads as 30 min quiet and is cut. | Gate 16 ends in `no_turn_signal`. Agents that lack hooks get a standing `idle_update_no_turn_signal` and a remedy that works on every shape (Calls, 17). A deaf build gets no turns, so the rollback restart does not need the signal: requiring it would trap a failing build. |
| 2 | Revert, or scope, the once to on change and the SIGHUP handlers | Every daemon, for its whole life, ignores a second signal and catches a hangup, for a proof only a daemon between arrival and `liveAt` needs. A stuck shutdown can no longer be ended by a second signal. | Scoped (Calls, 16). The signal handlers in `server.ts`, and `bin/bgos-launch.mjs`, are main's again. `createCleanEndSignals` opens only for that window, on a daemon that holds the lock. |
| 3 | Delete the marker on `did_not_arrive` | A marker hoai never took stays on disk, and hoai's next poll kills claude with no turn check, after the canary was voided and the lease released. | The controller removes the marker it wrote, by exact mtime, so never a person's restart, on `did_not_arrive` and on a rollback restart that never arrives. The marker fed `launcher_latched`, so the record now carries that (`markerStranded`). |
| 4 | A failed non-canary needs a way back; lengthen the hold | A non-canary that fails stays on the failing build for good, and its report said another agent decides, which no code did. And a 60 s proof lets through a build that dies at minute 3. | Rollback, above: any agent goes back, the canary always, any other once. The hold is 5 min, and the deadline, lease and silence moved with it (Calls, 13 to 15). |
| 5 | What happens to `/loop` schedules on restart | A self-paced `/loop` dies with the process, and nothing says so. | The written answer, "What a restart does to /loop and scheduled wakes", and gate 12b. |

**What this flips:** the second review's item 11 said a voided canary must not roll back a version another agent validated. Under fix 4 it may, once. That residual, "A voided canary left on a bad build", is gone with it.

**What the fresh review of these five changed.** Three readers took the diff, and a verifier tried to refute each finding. Ten stood, none Critical, and the list below is what they changed, with two of the readers' minors taken as well (9 and 10); the rest of the minors are in Residuals or were declined. Each code change has a red test and a mutant.
1. **A rollback could land on a version held bad here** (a follower's own or the canary's). The source now passes over one where a good one stands beside it. The refusal added with it was taken back by the second read.
2. **The canary's build replaced the agent's own with no fallback,** across config folders and checkouts. It now counts only beside the agent's own, in a folder that still holds it, and the agent's own stands otherwise.
3. **One follower's slow start on Windows would have rolled a proven build back for the whole computer.** The answer, no verdict on a second boot, was a regression, and the second read took it back. It stands as a Residual and Calls 11 and 19.
4. **The rollback restart could wait for ever while the app said the agent went back.** A stale turn flag stops counting at 2 h, and any wait is bounded at 3 h.
5. **On a clone the way back pauses updates until a person acts.** It stays, stated in Calls 13, and the report now says how to lift it.
6. **The lease ran out before a failing agent's verdict.** The test now holds it to the verdict, not the healthy path. It went to 20 min, and to 25 with the second read.
7. **`idle_update_no_turn_signal` named a remedy that stages on gen-2.** It now says by hand, and the second read took out its promise of a restart.
8. **The poison bound was described as covering the canary role, and residuals read canary only.** Both are corrected.
9. **A daemon that lost the lock kept the borrowed signals.** It now gives them back.
10. **A follower's rollback was proven only over a fake install.** An integration test now joins it to the real marketplace rollback on a real disk.

**What a second fresh read changed.** The same shape, on the fixes above, with a verifier on the six worst. Three distinct findings stood as Critical. Each code change has a red test and a mutant.
1. **Critical, and my regression: a follower that crashed twice on a proven version got no verdict.** The third boot that rule waited for never comes: hoai relaunches once. Nothing wrote `<T>/bad`, and the next follower walked on when the lease lapsed, at about two agents an hour. The test built the third boot by hand. A second boot is a verdict again, on any version. That also ends two Important findings that came with the rule: a rollback a crash cut short was not finished, and a daemon holding the lock again stood down with no verdict.
2. **Critical: `source_held_bad` left a failing agent and the shared install on the failed build.** Every healthy agent on a version one follower failed on has a held `from`, so the next release's canary could never go back, and the report's remedy landed on the same build. The refusal is gone: the agent's own build is what it ran here.
3. **Critical, not fixed: a daemon that dies twice inside its first 2 min stays deaf** on the failed build until a person restarts it. The install is back and the build is held. Fixing it widens fix 1's exception, so it is a Residual and Calls 19. A canary has had this since round 1.
4. **A missed deadline left a live proof on the record,** so a boot after a crash before the repoint validated over the verdict. The deadline now clears it.
5. **The lease still ran out on hoai's relaunch path.** It is 25 min, and the test's sum includes that wait and a 2 min start.
6. **Three reports named a remedy that does not work, or said what did not happen.** `idle_update_failed`, and `idle_update_rollback_failed` from the record, now say a restart by hand loads what is installed, which may be this same build. They name no landing, because another agent may move the install later. A stalled rollback restart still names what it left installed (Residuals). `idle_update_failed` no longer says the agent took the computer back, since a rollback may have failed. `idle_update_no_turn_signal` no longer promises a restart.
7. **The rest is in Residuals,** each stated, none in this push: proof keyed by version, a canary's old `from`, a swept `from`, the login at the first tick, a healed agent's report, a shared checkout's commit, the exact compare, a rollback restart outside the lease. This section's claims were corrected where the read found them false.

**Rig (Windows, this box, scale 5).** Run on `88e0572`, the last code change: every commit after it touches this file alone. The same real chain as the table above, in a scratch HOME on E:, against a stub backend, with `many` as fifteen real controllers in light processes, as there. Scale 5 divides every duration, so the 5 min hold is 1 min here. Windows scheduled tasks (237, sha `5d41182a3f57`) and WSL scheduled work (`9a4d2d56f7c3`) identical before and after every run; nothing of the rig's left alive after any run; every run under the 4 GB cap.

| Scenario | Agents | Result | What it showed |
|---|---|---|---|
| wake | 1 | PASS, 8 checks, 1.25 GB | A pending wakeup at the last Stop held the restart through the quiet window and the largest jitter. An interval `/loop` alone did not. One restart, same session. A backend wake armed before the restart, 6 h out, fired into the resumed session (matched by pid), through the poll alone, as an empty row filled later. This is fix 5's before and after. |
| idle | 1 | PASS, 6 checks, 1.26 GB | One restart onto the target, same session, validated, heartbeats on the new version with no error. |
| broken | 2 | PASS, 10 checks, 2.06 GB | The canary went onto a deaf build once and came back on the old one in the same session; the install points back; the version is latched bad; the other agent never restarted; Claude Code's own update is off. |
| stagger | 3 | PASS, 6 checks, 2.84 GB | All restarted once, smallest gap 104 s, none before the previous agent validated, each kept its session. |
| many | 15 | PASS, 10 checks, 0.43 GB | All 15 validated once, the first as canary, smallest gap 96 s, none before the previous agent validated, no rollback. |

**What the rig does not prove.** `broken` is a canary whose daemon stays alive. No scenario runs a follower's way back, which rests on the controller tests and an integration test against the real marketplace rollback on a real disk, and none runs a daemon that dies. The stand-in claude proves the daemon's handling, never Claude Code's own restore of a `/loop`, which rests on the docs and the read of 2.1.314.
