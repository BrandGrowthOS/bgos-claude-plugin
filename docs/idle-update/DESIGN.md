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
- **A bad build costs at most one agent, never a loop.** One attempt per version, one rollback, a version latch that every restart path reads, and no downgrade cascade. Respect `BGOS_AUTO_UPDATE` off. Never use a restart path that cannot prove it owns the session (the 2026-09-11 mute).

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
| Wiring | `server.ts` | `armIdleUpdate()`, called once by the first arm of delivery after "startup complete" and the heartbeat. Stamps the busy facts nothing kept (a voice frame, a browser tool, the beacon, startup complete, a heartbeat that landed), adds the fourth `lastError` producer, and holds the marketplace enrolment while the latest version is held bad here. |

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
| 9 | Up for less than 60 s | `wait: young` | The daemon's boot also counts as activity in gate 16, so a session that just started waits the whole quiet window: a separate fresh start gate is not needed. |
| 10 | Turn in flight, a reply owed, a permission card, an active operation | the `decideSafeMoment` reason | Turns use its 2 h stale rule. Inbounds and operations use the update path's 30 min rule (`updateDrainSnapshot`). |
| 11 | A blocking ask, a plan card, or an own ask card younger than 24 h | `wait: open_ask` | Older non-blocking cards survive a restart (`lib/ask-tracker.ts`). |
| 12 | A goal armed, arming, injecting, or clearing | `wait: goal_running` | |
| 13 | Voice consults pending, open continuations, a voice frame in the last 30 min, or an open meeting | `wait: call_active` | |
| 14 | A browser tool used in the last 30 min | `wait: browser_in_use` | The host is the daemon's child, so a restart closes Chrome. |
| 15 | A read-write client attached to the agent's own tmux socket (or the keepalive's session), or that reading failed | `wait: person_attached` | A person at the keyboard. On Windows the unattended proof requires the hidden console instead. |
| 16 | Activity inside the quiet window (N = 10 min with the hook signal, 30 without) | `wait: recent_activity` | |
| 17 | Quiet, but this agent's jitter has not elapsed | `wait: jitter` | A uniform draw of 0 to 10 min, per version and per boot. |
| 18 | Another agent holds the lease, or the last release was under 2 min ago | `wait: machine_busy` or `wait: spacing` | |
| 19 | Another agent is the canary for this version and has not confirmed it | `wait: canary_unconfirmed` | |
| 20 | Process tree: a background job under claude, or the tree unreadable | the `decideSafeMoment` reason | Read last. |
| 21 | Wake schedule: a wake or call due within 10 min, or the schedule unreadable | `wait: wake_due` or `wait: wake_schedule_unknown` | `GET scheduled-tasks/agent?status=active`, the agent's own view (`AgentScheduledTaskViewDto.nextFireAt`). Re-read just before the act. Fails closed. |
| 22 | Otherwise | `restart` | |

**Unattended proof (gate 6), by authority:**
- **Keepalive** (proven by `resolveKeepalive`): an external script by construction. Gate 15 checks its tmux session.
- **A service whose main pid is our ancestor** (gen-1 run.sh, or a declared owning job): run by launchd or systemd, with no terminal.
- **A launcher on macOS or Linux** (the own launcher rung, or a plain live launcher): it descends from the agent's own tmux server on its own socket, or from its run.sh. Alternatively, launch-status holds an outcome only a supervised launch writes (`live`, `live-but-not-signed-in`, `no-live-marker`), written at or after supervisor.json.
- **A launcher on Windows:** its parent is `wscript ... run-agent.vbs`, and that `run-agent.vbs` in the agent's folder launches hidden (style 0) and was written before the launcher started (`lib/agent-windows.mjs` `supervisorConsoleParent`, `startedHidden`). `--keep-alive` alone is not proof, because people type it. An unreadable process table is no proof.

### Lease, spacing and canary (15 agents, one computer)

- **State lives in `~/.bgos-agent/idle-update/`,** shared by every agent under one HOME. Every shared fact is its own file created exclusively; no file is read, modified and written back.
  - `lease.json` holds `{assistantId, target, nonce, at}`. A lease older than 10 min is broken by renaming it aside (atomic, one winner). The holder releases it only if the nonce is still its own and the lease has not expired.
  - `released.json` (rewritten by the releaser while it holds the lease) holds the last release time, for the 2 min spacing.
  - `<version>/canary-<n>` holds `{assistantId, at}`. `<version>/validated` and `<version>/bad` hold `{assistantId, at, reason}`.
- **The canary is the first agent to restart onto a version on this computer.**
  - Until it has written `validated`, every other agent waits.
  - If its lease expires with no outcome (the agent never came back), the version is held for 24 h, and then ONE more agent may try (`canary-2`).
  - If that one also expires with no outcome, the version is latched bad.
  - So a silently broken build costs at most two agents per computer, never fifteen.
- **Jitter** is drawn per boot, so restarts never re-synchronise. The lease is what forbids two at once.
- **Limit:** another HOME is another computer as far as these files go. Agents of two accounts on one machine are not serialised against each other.

### The attempt, and its record

`~/.bgos-agent/<id>/idle-update.json` holds `{target, from, fromRoot, fromCommit, installMethod, pin, nonce, state, attempts: [{at, outcome}], lockBoots, validatedAt}`.

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
2. A heartbeat POST carrying the new `daemonVersion` succeeded.
3. This pid has touched the channel beacon, which happens only while delivery is live (`touchBeaconHeartbeat`, `server.ts`).
4. There is no deaf verdict.
5. It has held all of the above, as the lock holder, for 60 s.

A boot heartbeat can land before the record settles, so until a beat lands after arrival the controller asks the heartbeat for one (`sendNow`), at most once a poll. An expired login or a usage cap (`currentAccountError`) suspends the 5 min deadline: neither is the build's fault.

Validation writes `validated` to the record and, for the canary, `<version>/validated`. Then it releases the lease and clears any standing error.

### Rollback

A failed restart falls into one of three cases:

| Failure | Who sees it | What happens |
|---|---|---|
| The ladder staged, or the restart never arrived | The old daemon, still running | Nothing to roll back: the old build never stopped. Record it, release the lease, record "no verdict" for the canary, back off, report. |
| The session came back on the old version, or with a new pin | The daemon after the restart | Nothing to roll back. Record it, release, no verdict, back off, report. |
| The session came back on the new version, the new build fails validation, AND this agent is the canary | The new build's daemon | **Roll back.** The trigger is either a second lock-holding boot on the target with no validation (the first one died, and hoai's unattended `no-channel-heartbeat` relaunch started it again), or no validation within 5 min of a live lock-holding boot. The trigger is suppressed while hoai reports `claude-login-expired`, because that failure is the login's, not the build's. |

A non-canary agent that fails on a version its canary already validated does **not** roll back the shared install, because the other agents are healthy on it. It reports `idle_update_failed` and stops.

**The rollback:**
1. **Marketplace:**
   - Point the `hoai@hoai` entry of `installed_plugins.json` back to `{version: from, installPath: fromRoot}`, only if `fromRoot/.claude-plugin/plugin.json` still says `from`. Write it atomically.
   - Turn off Claude Code's startup auto-update for this marketplace (`ensureMarketplaceAutoUpdate({enabled: false})`, `lib/claude-preseed.mjs`), so the relaunch does not reinstall the target.
   - That switch-off is recorded in `~/.bgos-agent/idle-update/enrolment-hold.json`, only when this call made it. An `autoUpdate: false` a person set stays theirs: today's enrolment never overturns one (`declined`), and nothing here records it.
   - The boot enrolment (`server.ts`) leaves it off while the marketplace's latest version is latched bad on this computer. Once a newer version is published, it takes back its OWN switch-off (`ensureMarketplaceAutoUpdate({reclaim: true})`, passed only with the hold on record) and removes the hold.
2. **Clone:** the self updater's own rollback, split from its `exit(0)`: the shared lock, the dirty tree refusal, `git checkout --detach fromCommit`, a dependency reinstall if needed, and the shared safety latch. It is the existing clone semantics for a bad build: updates paused, and the app says so.
3. Write `<target>/bad`.
4. Wait for a short safe moment: no turn, nothing owed, no background job, nobody attached, 2 min quiet. No lease or canary wait, because it already holds the lease.
5. `restartForRollback(from)`.
6. The old version's daemon boots, finds `rolled_back`, and reports it.

If the target boots again after a rollback, the state becomes `rollback_failed`. It is reported, and nothing is tried again: one rollback, never a loop.

**Residual, stated not hidden:** a build so broken that the daemon cannot evaluate at all (a syntax or link error) is not caught by the daemon itself. It costs the canary, and at most one retry 24 h later. hoai raises its own `no-channel-heartbeat` alert, and every other agent holds the version.

### Reporting

- **Restarted onto X:**
  - the new daemon's boot heartbeat carries `daemonVersion` X and `pendingRestartVersion` null, so the app moves from restart pending to up to date;
  - the log says `idle update: restarted onto X from Y after N min idle, resumed pinned session <pin>`;
  - any standing idle update error is cleared.
- **Failure:** a fourth `lastError` producer, after the login, the usage cap and the deaf verdict. The backend takes any code of at most 64 characters with a message of at most 300 (`HeartbeatErrorDto`), so no backend or app change is needed.
  - `scheduled_update_failed` for did not arrive, came back old, context lost or no authority. The app already shows "The automatic update could not finish; it will try again", which is what the back-off does. The message names the versions and the next try.
  - `idle_update_rolled_back`: "X did not start cleanly on this agent; it went back to Y and holds X."
  - `idle_update_held`: other agents holding a version because of a rollback or an unconfirmed canary.
  - `idle_update_launcher_latched`: a marker that hoai stopped taking.
- **No chat message.** Fifteen agents saying "I updated" is noise, and the app shows the version.

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
| macOS launchd or Linux systemd --user | gen-1 job, or a declared job that owns the daemon | Owning service (existing, ownership proven) |
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

**Rig** (`docs/idle-update/rig/`, Windows, this box):
- **The real chain:** a hidden `wscript` of a generated `run-agent.vbs`, then the real `hoai-core.mjs --keep-alive`, then a stand-in `claude.exe` (node, which speaks MCP to the daemon and keeps a transcript per pin), then the real daemon (`bun server.ts`), loaded from a marketplace-style `installed_plugins.json` in the scratch config dir.
- **No scheduled task is created.**
- **The stub backend** on 127.0.0.1 (43000 to 48999) captures heartbeats and serves the schedule. It answers always-on false and never sends `watcher_install_rpc`.
- **Processes are killed by exact pid only.**
- **Scenarios:**
  - staged plus idle restarts once and reports;
  - each busy case waits: turn, owed reply, open ask, goal, call, browser, wake due, young;
  - a broken staged build rolls back;
  - 15 agents stagger with no overlap.
- **Scheduled tasks:** `schtasks /query /fo csv /v` hashed, and in WSL `systemctl --user list-units --all`, `list-timers` and `crontab -l`, before and after each run. They must be identical.

**MACOS-PROOF.md:** a short script Data runs on a Mac. It uses a scratch HOME and a gen-2 style launchd job with a scratch label. It cleans up, and it states its pass lines.

**Not proven live here:** the gen-2 tmux ancestry rung on a real launchd or systemd host. This box has no Linux node or bun, and no expect. It is covered by unit and integration tests over real-shape process tables, and by `MACOS-PROOF.md`.

## Residuals, stated not hidden

- **The wake schedule is the agent's own view.** Tasks another acting user created on a shared agent are not in it, and meetings live elsewhere. A restart can land close to one of those; it still waits for an idle, quiet session, and the session it resumes is the pinned one. Whether a fire that lands during the restart minute is redelivered is the backend's, not verified here.
- **Two agents breaking the same expired lease at once:** both rename it aside, and each checks that the file it moved is the one it read; the one that moved the other's fresh lease puts it back. The window is one rename wide, and the canary files are exclusive creates, so at worst two restarts on one computer, never a lost latch.
- **Wall clock.** Every window is measured on the wall clock (the stamps in the files are ISO times). A computer that sleeps or a clock that jumps can shorten a wait; the lease and the canary still serialise the restarts.
- **Enrolment comes back only at a boot.** After a marketplace rollback, Claude Code's own update stays off until a newer version is published AND a daemon of this computer boots. The app's update button (a click) still works meanwhile.
- **A build that cannot evaluate at all** (see Rollback) is caught by hoai's own health relaunch and the canary hold, not by the daemon.

## Calls I made (Data or Ares may overrule)

1. **"--continue" is read as "resume the pinned session".** Every supervisor already does it that way, and bare `--continue` is banned since 2026-08-23.
2. **The own launcher rung serves only the idle update and its rollback.** Clicks, the scheduled update and the hook restart stay exactly as on main.
3. **Gate 2 requires the staged version to be strictly newer.** The version latch is applied where `pendingRestartVersion` is computed, so every reader honours it.
4. **Only the canary rolls back the shared install.** A marketplace rollback turns Claude Code's startup auto-update off for the marketplace until a newer version is published. A clone rollback uses the self updater's existing latch, which pauses that clone's updates.
5. **The controller stands down where the watcher's sweep is active.**
6. **Open non-blocking ask cards older than 24 h do not hold an update**, because they survive the restart. A goal is busy only when the transcript fold shows it, since a running goal is also a turn.
7. **An unreadable wake schedule fails closed,** with no time bound.
8. **The numbers:**
   - N is 10 min with hooks, 30 without (the watcher's numbers).
   - Jitter is 0 to 10 min.
   - The lease is 10 min and spacing is 2 min.
   - The canary is held 24 h, with a second canary, then latched.
   - Back-off is 24 h doubling to 7 days.
   - Validation needs 60 s of live delivery, with a 5 min deadline.
   - A marker older than 5 min is reported as latched.
   - The rig scales every duration down through one env var, `BGOS_IDLE_UPDATE_SCALE` (clamped, logged at arm time).
9. **Reporting reuses `lastError`,** and sends no chat message.
10. **Version proposal: 0.81.0.** Data sets it.

## What the review changed

1. **The new rung reached every ladder caller.** It is now limited to the idle update, because the click, scheduled and hook paths do not have its gates.
2. **The bad version latch held back only this controller,** and Claude Code's auto-update would have reinstalled the bad build. The latch now sits in `pendingRestartVersion`, and a marketplace rollback pauses the auto-update.
3. **Plain inequality would have cascaded a rollback into downgrades.** Gate 2 now requires newer, and only the canary rolls back.
4. **"startup complete" plus 60 s could validate a deaf build.** Validation now needs a beacon, a heartbeat at the new version, and no deaf verdict.
5. **The Windows `--keep-alive` flag is typed by people.** The proof is now the hidden wscript of run-agent.vbs.
6. **Read-modify-write shared state could lose a latch.** Per-version exclusive files replace it, along with a nonce on the lease, the hoai marker budget latch reported, a pin check for lost context, a second-canary cap, and the wake schedule re-read before the act.
