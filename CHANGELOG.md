# Changelog

Notable changes to the HOAI Claude Code plugin.

## 0.68.6 (2026-10-13)

Three fixes from Mark's run of 0.68.3 on agent 909 (Vera, Windows), and one race the restart proof found.

**A scheduled fire opens one private turn, however often it is delivered.** After restarts on 0.68.3, two old native wakes (messages 118303 and 118672) came back as backlog and were each admitted as a fresh private turn, one with a new private-turn token.

- **Why.**
  - On every boot, the poll lane's restart recovery re-offers user and system rows from the last 24 hours that it does not count as answered (`lib/poll-core.ts` `selectRestartRecoveryIds`). Only an assistant row directly after a USER row counts, so a wake the agent answered is re-offered on every restart.
  - Each re-offer is a new delivery, with a new token and a new 15 minute window.
  - The private turn tracker lives in memory, per process.
  - Delivery is at least once.
- **The fix** (`lib/private-turn.mjs`, `server.ts`):
  - **The record.** Each agent keeps, in its own state folder (`<state>/<assistant id>/private-fires.json`), the scheduled fires it handled, for 48 hours: twice the recovery window. The file survives restarts, is read on every delivery, and is written atomically (once more after a short pause if a Windows rename fails) and pruned on every record, keeping the newest 1000.
  - **The key** (`privateFireKey`). A native wake is `native:<eventMeta.payload.fireId>`. An n8n Agent Scheduler card is `n8n:<scheduled_action_id>:<message id>`. Any other scheduler card is `scheduler:<message id>`. Only a scheduler system card has one: the same cards an actor can come from. All three delivery lanes pass it.
  - **Replay, decided at delivery.** A fire found in the record, or already delivered by this daemon, is a replay. It still reaches the agent as text, after a line saying `[replayed: this scheduled fire was already handled at <time>; it opens no private turn]`. Its own prompt opens no private turn, and the daemon logs once: `private turn: replayed fire <key>, already handled at <time>`.
  - **Replays injected into a turn.** A replay injected into a running turn ends it: `a delivery that replays a scheduled fire already handled (chat C) ended the private turn`. A replay delivered before any turn was open (the boot sweep comes before the hook intake starts) keeps the next prompt from opening one (`opens no private turn: a replayed scheduled fire was delivered just before it, and the CLI may run it inside this turn`). The prompt after that opens as usual.
  - **When a fire is recorded.** A new fire is recorded when its own turn becomes usable (its marker adopted). One the CLI injected into another turn instead is recorded when the next prompt begins or that turn ends. So a fire delivered but never run, or never usable, before a restart still runs once. A fire that cannot be recorded opens no usable turn (fail closed), and the refusal says so.
- **Unchanged:** owner messages have no fire and open their turn as before; who may open a private turn; two agents on one home keep separate files. #228's `email_send` takes its basis from the open private turn (`current()`), so a replayed fire, which opens none, can never be its basis.
- **The race the restart proof found** (`server.ts` `armDelivery`). The daemon wrote its attached floor entry only at the end of the arm, after the boot poll had delivered backlog. The private turn hook of that first backlog prompt then found no daemon of its own, wrote no marker (0.68.3 fails closed there), and the prompt lost its private turn. On Linux this happened on every restart in the lab. The entry is now written first.

**The hook self-restart no longer waits in silence on Windows** (#220). On Vera it logged `armed` at 07:46:00, then `waiting: process_tree_unreadable` at 07:47:00 and nothing more, so a fresh install still needed a manual second restart.

- **Why.**
  - The process table was readable. The daemon did not know its claude pid: on Windows that comes from a PowerShell parent walk with a 5 s limit, whose miss is cached for 10 minutes (`server.ts` `agentClaudePid`). The walk measured 1.6 to 2.4 s for three links, and 3.2 to 5 s or more to the top of the tree, on an idle PC.
  - With claude unknown, the controller never listed the table at all. It logged the reason once and waited in silence, and nothing ended the wait.
  - wmic plays no part: nothing in the plugin calls it.
- **The fix** (`lib/hook-restart.mjs`):
  - **The table names claude.** When the daemon does not know its claude, the whole process table names it: the nearest claude above this daemon, the watcher's own rule (`nearestClaudeAncestor`). The whole-table read has a 30 s limit and took 1.1 to 1.8 s on the same PC.
  - **Errors named.** The waiting line names the reader's error, and a claude found nowhere has its own reason, `claude_not_found`.
  - **Bounded.** After 60 minutes and at least six failed looks in a row (time the agent was busy adds no looks), the daemon says once: `hook restart: waited N min without a readable process table (<error>), so this daemon cannot prove that no tool or background job is running under claude; restart this agent by hand to load the private turn hook. It looks again every 30 min and asks on its own if the table reads at a safe moment`.
  - **Never blind.** It never restarts without the table: nothing else proves that no tool or background job is running.
- **Unchanged:** the safe moment itself (no turn in flight, nothing owed, no job under claude, the quiet window); single use; the ladder.

**The private turn hook ends inside its timeout, however slowly node starts** (board row d6aa4f1f). On Vera the UserPromptSubmit private turn hook timed out on cold starts: 3082, 3160 and 3706 ms against 3000 ms.

- **Why.**
  - After writing a live marker, the hook waits up to 2.5 s for the daemon's receipt (`.ready`). That wait counted from the marker write, while the CLI's timeout counts from the spawn. So a slow start was added on top: 2.5 s plus 0.6 to 1.2 s of start is exactly Vera's numbers.
  - The imports cost about 8 ms, so lazy imports would not help.
  - A start slower than the whole limit was killed before the marker was even written.
- **The fix: lighter, and a safe margin.**
  - **Lighter.** The wait ends 2.5 s after the marker, but never later than 3 s after the hook's own process start (`performance.now()`, `bin/hoai-private-turn-hook.mjs` `readyWaitEnd`). The hook's own time is bounded whatever its start cost, and a normal start keeps the whole 2.5 s wait.
  - **Margin.** The CLI's timeout for the private turn hook is 5 s in all five registrations (`hooks/hooks.json`; clone installs through `lib/claude-preseed.mjs` `PRIVATE_HOOK_TIMEOUT_SECONDS`). That leaves 2 s over the hook's deadline for its creation and exit.
  - **Existing installs.** An existing clone registration with the old 3 s is rewritten on the next registration (launcher start, update, `bgos-agent`), one entry per event. The daemon's own boot check ignores the timeout, so this costs no extra restart.

**Old daemon sweeps.** From 0.68.3 every daemon logs each spool folder it removes (`hook intake: removed the spool of session ...`), in its own log. A spool that vanishes with no such line in any 0.68.3+ daemon's log was removed by an older daemon (or by something outside the plugin). This release does not change the sweep.

## 0.68.3 (2026-10-13)

One release carrying five fixes: restart marker takeover (#220), private turn and wake fixes (#221), stale claude on Linux installs (#222), a pending update no longer blocks sends (#223), and Always allow / Trust this site saved per agent (#224).

**An always-on install no longer bakes a claude that cannot start the agent (board row 84296679, kc-server, 2026-10-12).** A keep-alive reinstall ran under the watcher's service PATH, which led with `/usr/local/bin`; a stale `/usr/local/bin/claude` 2.1.22 sat ahead of the user's own `~/.local/bin/claude`, `command -v claude` returned it, and five agents were baked with it. That CLI answers `error: unknown option '--dangerously-load-development-channels'` and exits 1, so each launch died at once, about 420 times, with nothing in any log.

- **Which claude is chosen by what it can do, never by PATH order** (`lib/claude-binary.mjs`, `bin/hoai-select-claude.mjs`, `bin/bgos-agent install`). The launch flag is hidden from `--help`, but a bare use of it answers `argument missing` on a CLI that knows it and `unknown option` on one that does not. Candidates are `~/.local/bin/claude` first, then every `claude` on PATH; the first that is not `unsupported` is baked, the ones skipped are named, and an install is refused by name (`claude:none-supports-flag`, before anything is written) only when every one of them is. No version floor is guessed, and a CLI whose wording is unreadable is accepted, so a change of wording can never lock an install out.
- **The service PATH leads with the user's own directories** (`servicePath`): `~/.local/bin` and `~/.bun/bin` come before `/usr/local/bin`. The baked agent PATH leads with the chosen claude's directory and lists each directory once.
- **`run.sh` writes which claude the launch found and its version** into `agent.log` at every launch.
- **A claude that exits during startup leaves its own words.** The expect launcher takes what claude printed and its exit code into `launch-status` (`screen=` and `rc=`) and into `hoai.err`, which `run.sh` already prints back, instead of letting them vanish with the pane.
- **A failed agent stays failed until something proves it is up** (`decideHeldFailure`, `lib/watcher-keepalive.mjs`). On kc-server a verify FAILED (`agent_deaf_after_restart`) at 10:42:33 and the next sweep, 26 s later, classified the same agent by its unit file alone and wrote `supervised (canonical)` while claude crash looped. The record now holds `failed` (with its reason) until a fresh published state or a running claude of that agent proves it up, and a launch whose launch-status or three fast fails say it is failing is `failed launch_failing:<outcome>` even with no earlier record. An unreadable process table never turns a healthy agent red.
- **`hoai-agent status` names a crash loop.** A loaded unit with an `exited-during-startup` (or any other failed) last launch, or three or more consecutive fast fails, now says `NOT RUNNING HEALTHY` before the generic last-launch line.
- **`hoai doctor --assistant <id>` is `--assistant-id <id>`, and `--all-agents` checks every paired agent in turn**, each under its own id; it is also the default when the doctor is run from the home folder with no agent named and more than one paired agent. From any other folder an unnamed agent keeps its documented refusal.

**A restart marker that an old hoai launcher no longer reads restarts the agent anyway (Windows; Data and Mark, agent 909).** `bin/hoai-core.mjs` (byte identical at v0.66.1 and main, the same logic at v0.44.0) allows 3 marker relaunches per rolling hour per launcher process. The fourth marker is deleted before the budget is checked (`:2295` before `:2296`) and ignored, and the `exhausted` latch it sets (`:2299`, declared once at `:2228`) is never reset, so every later marker stays on disk for the life of that launcher (`:2293`). Mark saw exactly that: write 1 gone with claude on the same pid, write 2 on disk for more than a minute. It was not the 0.67.5 daemon: the same five writes against a v0.66.1 daemon fail the same way (reproduced with the real `claude.exe` 2.1.296 under v0.44.0 and v0.66.1 launchers, docs/evidence/2026-10-12-restart-marker-takeover.md). Three update restarts inside an hour (0.67.3, 0.67.4 and 0.67.5 were tagged within 53 minutes) spend the budget by themselves, and the launchers already running in the field cannot be changed.

Now the daemon takes such a marker over (`lib/marker-takeover.mjs`, Windows only, `HOAI_MARKER_TAKEOVER=off` turns it off). The pairing lock holder watches its own `~/.bgos-agent/<id>/restart-requested.json` and acts only on a marker written after it started that the live hoai launcher left unanswered: still on disk 15 s after it was seen (stranded), or removed within 7 s while this session runs 10 s more with `supervisor.json` and `launch.json` unchanged (swallowed by the deny branch). It waits until the session is a minute old, so the launcher never reads the exit as a rejected resume, and it spawns ONE detached hidden helper (`bin/hoai-restart-handoff.mjs`, `lib/restart-handoff.mjs`). The helper changes nothing until it has proven from the process table that the launcher named in `supervisor.json` is the parent of this daemon's claude (or its grandparent through an npm `claude.cmd`), runs `hoai-core.mjs` and wrote that file, that no other claude carries the agent's pin, and how the agent comes back. Then it checks claude's creation time and the daemon's pairing lock once more (a refusal there spends nothing), claims a stranded marker by rename (`restart-requested.claimed.json`), records the takeover in `restart-takeovers.json` (the launcher's own 3 per rolling hour; a marker refused by that cap is set aside as `restart-requested.refused.json`, never restarted later), and ends claude with TerminateProcess, what the launcher's own restart does. From then on the ended claude and daemon count as dead whatever reuses their pids, the launcher counts as gone only once its process (pid and creation time) is, and a last process listing right before any start refuses when a claude carrying the pin already runs. A `--keep-alive` launcher (the "HOAI Agent <id>" task) relaunches the pinned session by itself and the helper starts nothing. An old interactive launcher exits; after a 20 s settle with no launcher or daemon of the agent live, the helper starts the agent through the unchanged restart ladder (`restartAgent`: the task when it is registered for this folder, else the hidden recipe launch), with a filesystem that cannot write a restart marker and an environment without Claude Code's session markers or the keys the plugin injects. Every route resumes `~/.bgos-agent/<id>/session-id`. Measured live: write 4 swallowed, the helper ran, a new hidden launcher resumed the same session 28 s later, writes 5 and 6 restarted normally. The daemon logs every step as `restart takeover: ...` and the helper as `restart takeover helper (pid N): ...`. `listAgents` takes `includeIds` so the helper finds an agent whose key lives in its folder's `.mcp.json`.

**A fresh start never requests another restart (agent 909, 17:17:10).** About 9 s after a hand restart a bare `{}` marker restarted the agent again. Only the restart ladder writes `{}` (`lib/agent-restart.mjs:242-245`), and the automatic caller is the keep-alive sweep (`lib/watcher-keepalive.mjs`, the update restart): it read the old daemon's state, awaited a process listing of several seconds during which the relaunch happened, and wrote its marker onto the new session without asking again. The sweep now asks `decideFreshStart` (`lib/keepalive-plan.mjs`) after its last await and before anything is spent: a restart waits as `fresh_start` when the daemon it judged is gone or replaced (a keep-alive backoff included), or when `launch.json` (rewritten before every launch since 0.44) or the newest claude started inside the quiet window; and on the marker tier a PENDING marker (under 5 minutes old and written after this session started) is never rewritten (`restart_already_requested`), while a stranded one is, so a takeover sees a fresh request. A service restart (macOS, Linux) is never held up by a marker. Jobs an owner asks for are unchanged.

**A daemon that registers the private turn hook itself asks for ONE restart, so the hook loads (Data, PR #220).** Until now a daemon that booted without the private turn hook wrote it into its clone workspace (`registerCloneHooks`) and only logged "restart this agent to load them": the CLI reads its hooks once, at launch, so every boards, schedule and browser call kept refusing until a person restarted the agent. Now a registration made by THIS boot (outcome `registered`) arms exactly one restart through the daemon's own ladder, the one a scheduled update walks (`restartAfterHookRegistration` in `lib/update-rpc.ts`: the keepalive signal, a service that provably owns the process, or the hoai launcher's marker; nothing is posted to the backend). It never arms on a plain fresh start that found the hook, on a registration that was already in place, on a folder that is not this clone, or on a failed write (`lib/hook-restart.mjs`). It is single use: `~/.bgos-agent/<id>/hook-restart.json` is created exclusively BEFORE the ladder is asked, so the daemon the restart brings up (which finds the hook registered anyway), any later one, and a second daemon racing this one never ask again; a record that cannot be written means no restart, and deleting it by hand re-arms the next registration. Only the pairing lock holder asks, never in its first minute, never while an update holds the shared checkout's lock or drains the daemon, and only at the safe moment the watcher itself waits for before a restart nobody asked for (`decideSafeMoment`): no turn in flight, nothing owed, no background job under claude, and 10 minutes of quiet (30 without the hook turn signal), boot counting as activity, so no turn is cut. Intake is drained first, as for a scheduled update; a restart that never arrives says to restart by hand. Logged as `hook restart: ...`, each reason to wait once; after the process tree said wait, it is listed again only five minutes later.

**A scheduled wake opens its private turn on a computer that runs several agents.** Reported by Data and Mark on a Windows PC at 0.67.5: agent 909 (Vera) got a 17:30 scheduled wake (sender System, `actingUserId` the owner). The private turn hook wrote its marker, but no `.ready` followed and both `boards_query` calls refused with "its current sender could not be verified". An owner message later in the same session passed, and the intake logged that it bound then. A Mac clone at 0.67.2 passed the same wakes.

- **Why.** Every agent of one OS user spools its hooks under one root, `~/.bgos-plugin-state/hooks/<session>/`, and every agent's daemon drains every session directory there (`lib/hook-intake.ts`). Vera had just restarted onto 0.67.5: her new session had spooled only its SessionStart, then sat quiet past the 30 minute idle sweep, which removed the directory. The wake's UserPromptSubmit recreated `events.jsonl` as one line about three times as long as the old one. A neighbour's daemon still held its cursor for the old file; the new file was larger, so it was not seen as a new file, and the neighbour wrote that cursor into the session's `cursor.json` although it had refused the session. Vera's daemon, which had forgotten the directory when it swept it, loaded that cursor and started after the wake's line. When a third daemon did the sweeping, Vera's daemon kept its own old cursor and made the same mistake. Either way `privateTurns.begin()` never ran for the wake, so no turn was pending and nothing wrote `.ready`. The owner's next message was a fresh line and bound the session. It was never about wakes: any first prompt after the idle sweep was exposed, and a wake is what arrives after half an hour of quiet. One agent alone on a computer never shows it, because nobody else drains its spool; that was the Mac.
- **The fix, in `lib/hook-intake.ts`.** Only a session's own daemon writes its cursor: the daemon bound to it, or the one whose project folder it is while it still waits for proof. A session a daemon refused as another agent's or another session's keeps its cursor in memory. The file is now `own-cursor.json`, and the `cursor.json` every daemon wrote before 0.68.4 is never read, so a neighbour still on an older plugin cannot bring the skip back: an agent is covered as soon as it runs 0.68.4, whatever its neighbours run. And a cursor names the file it counted (`head`, a short hash of the file's first line, which carries the forwarder's minted line id): another first line means another file, drained from the top whatever its size. The one cost: a session that outlives the upgrade (a `--resume` of the same session id after a crash) is drained once from the top, which can repeat that session's activity rows.
- **Unchanged.** Who may open a private turn: a verified human sender, or a scheduler wake's `actingUserId`, never a peer agent and never another system message. A wake that names someone other than the owner still runs only as that person (the daemon names them in `X-BGOS-Acting-User` and the backend admits the claim only through an active share of this agent), never with the owner's authority.
- **Proof.** Reproduced with the real daemon (`bin/bgos-launch.mjs`, bun) against a fake backend, with a fake Claude Code that renders channel prompts as claude.exe 2.1.296 does and runs the workspace's real hooks: two agents on one Windows home lost the wake in 3 of 4 runs and the owner message after it bound and passed, as reported; one agent alone passed; Linux lost it in 2 of 4 runs with two agents and passed with one. With the fix, Windows 6 of 6 and Linux 4 of 4 runs passed. Guards: `test/private-turn-shared-spool.test.ts` (the real forwarder, private turn hook, intakes on one shared folder, the socket lane's actor statements and claude.exe's prompt; controls for an owner message, a peer message, a wake naming a stranger and a system message that is not a wake) and `test/hook-intake.test.ts` (a recreated larger spool, the head across a restart, who writes the cursor, an older daemon's `cursor.json`, a restart that keeps an unproven session's dropped lines dropped). No version is published or tagged here.

**A private turn survives a second record of its own prompt.** Mark's proof of the change above failed on Vera at 18:45 (2026-10-12): after a restart at 18:06 and about 39 idle minutes, a scheduled wake rewrote the private turn marker live (turnId 19a3c691), no `.ready` followed and `boards_query` refused with "its current sender could not be verified"; the daemon's only line was "4d6691bc... was rotated, truncated or recreated; draining it from the top".

- **Why.** The from-top drain reached `privateTurns.begin()`: the daemon was already bound to the session, so it consumed the wake silently, and a healthy wake logs only that line. The turn was opened and then lost to a second record of the same submission's boundary, which a second hook source produces (the CLI runs a hook once per distinct command, so the same script under two spellings, a clone's settings and an enabled plugin copy, runs twice). Either the private turn hook ran again after the daemon had adopted the first marker and stamped a new `turnId`, and `current()` dropped the turn because the id changed (`lib/private-turn.mjs`, `current`); or the forwarder spooled the prompt twice, and the second `begin()` cleared the turn the first had opened and found its single use token already spent (`lib/private-turn.mjs`, `begin`). The first adoption's receipt, `<marker>.ready`, holds `{turnId, sessionId}`: the second private turn file with the same sessionId seen on the PC. `lib/hook-intake.ts` already promised that a second registration costs nothing; for a private turn it cost the turn.
- **The fix.** A repeat is recognised only as the SAME submission: the CLI stamps every hook of one submission with one `prompt_id`, and a resubmission gets another. `begin()` (`lib/private-turn.mjs`) remembers each submission it took that carries a delivery token and a `prompt_id` (session, prompt hash, `prompt_id`); the same submission again changes nothing. The private turn hook writes the `prompt_id` into its marker (`bin/hoai-private-turn-hook.mjs`), and `current()` follows a marker stamped again only for the same live submission in the same session. Each repeat is logged: "private turn: the same submission reached the daemon twice ..." or "private turn: the marker was stamped again for the same submission ...", the one trace of a doubled hook.
- **Unchanged.** Who may open a private turn: the actor still comes only from the delivery whose token the prompt carries. A repeat never revives a turn that ended (Stop) or that a card from someone else revoked, and never hands a turn back to an older sender: a late record of an older submission leaves the newer turn as it is, or ends it so that nobody may act. The same words submitted again, after an interrupt with no Stop or from a CLI without `prompt_id`, are a new prompt and end the turn, exactly as before; so do another prompt, another session and a closed marker. A peer agent's or a stranger's turn stays exactly what it was.
- **Proof.** The real daemon, real hooks and a fake backend with the backend's exact wake frame, in Vera's shape (restart, idle, a neighbour's sweep, a stale same-session file, the reset line as the only intake line): on PR 221's head the wake passes with single records and is lost when the private hook runs a second time after adoption or the forwarder spools the prompt twice, on Windows and Linux; with this change all of them pass and a peer's message is still refused. Guards: `test/private-turn-duplicate-boundary.test.ts` (Windows and Linux), 16 mutations, each red.

**The daemon says what the private turn decided.** Mark's canary of the change above on Vera (22:51, 2026-10-12) still refused the wake's `boards_query`, and the daemon logged nothing about the private turn: three rounds could not tell whether `begin()` declined the wake's prompt or its marker never matched.

- **Now logged.** For every prompt that carries a delivery token, or a delivered message without one: `private turn: the prompt in session <S> admitted its sender; the turn is usable once its marker matches`, or `... opens no private turn: <reason>` (no delivery token, more than one token, a token this daemon did not deliver or already used, a delivery older than 15 minutes, a peer agent's message, no verified sender). For a card from someone else that ends a turn mid turn: `private turn: a delivery <from a peer agent | with no verified sender | from another person | from the same person in another chat> (chat <C>) ended the private turn; nobody may act until the next prompt`; before this the turn ended silently. For every refused private call: `private turn: refused <tool>: <why>`. With no turn open, the why says what the last prompt decided and how its turn closed (Stop or SessionEnd, or revoked, by whom). With a turn admitted and waiting, it names each marker file the daemon reads with `live`, `session`, `prompt` and `turn`. Once a marker was adopted, it names only that file and what changed in it (`turn`, `promptId`), since no other file is read again. A schema other than 1 is named, and no marker field can split the line. The refusal the model sees is unchanged, and so is who may open a private turn.
- **Ruled out, with the real daemon on main, 0.68.4 and this change (Windows and Linux).** The delivered token and the marker's `turnId` are different ids by design (the daemon mints one at delivery, the hook the other at the prompt) and are never compared. The idle sweep of a bound session's spool keeps the binding, and a spool the next prompt recreates (its line 0 the wake, no SessionStart) still opens the turn. A private turn hook killed by its 3000 ms timeout before it writes loses only that turn, as does a mangled hook path; neither touches the next turn. An empty-prompt Stop record (`e3b0c442...b855` is the hash of no prompt) is the normal end of a turn.

**The private turn hook never writes under another agent's key, and the idle sweep says what it removes.** Mark's step 0 answers (2026-10-13 01:50Z) settled Vera's 22:51 wake and showed two more things on her PC.

- **The 22:51 wake.** It was the n8n Agent Scheduler's reminder, not a native wake: `event_source` scheduler, sender System, chat 1132 (Vera's own chat with her owner), and an `event_payload` of the reminder's own fields with no `actingUserId`. `privateActor()` (`lib/private-turn.mjs`) takes a system card's actor only from a scheduler event's `eventMeta.payload.actingUserId`, so `begin()` declined it as it should. The rule is unchanged; the daemon's line now says what the delivery lacks: `private turn: the prompt in session <S> opens no private turn: its delivery names no verified sender: neither a person's own message with their user_ id nor a scheduler event carrying eventMeta.payload.actingUserId`. The backend's stamp is a separate change. Guard: `test/private-turn-duplicate-boundary.test.ts` (the reminder's exact shape, an owner sender block included; controls: the same reminder stamped with the owner, and the native wake; and what a scheduler card needs: `eventMeta.payload.actingUserId` alone, a camelCase `user_...` string, while `scheduledTaskId`, `fireId`, `ack` and `dueAt` are not read). Vera's run on the previous build matched it: the native wake at 02:30Z passed, the reminder at 02:40Z was refused as `no-actor`.
- **Another agent's key.** `floor\attached\354c5ab3...json` was Mark's daemon (agent 888), yet `private-turn\354c5ab3...json`, still live from 06:24:56Z, carried Vera's session: Vera's private turn hook had written her turn under Mark's key. Neither daemon can use such a turn, and it overwrites the file the other agent's own turns live in. The hook took the first of its session's folders (`CLAUDE_PROJECT_DIR`, `BGOS_LAUNCH_CWD`, the payload's cwd and every folder above it) with a live attached entry, whichever daemon wrote it, and with none it fell back to the first of those folders that held a marker: a cwd moved into another agent's folder, a launch folder inherited from another agent's process, an agent folder above this one, or a restart before its own daemon attached each led there. Now the daemon's attached entry names the folder its session transcripts live in (`projectDir`, the folder the hook intake admits sessions by) and the folder a relative transcript path is read against (`baseDir`, its launch folder, as the intake reads it). The hook writes only under a live entry whose `projectDir` holds the payload's `transcript_path` (`lib/floor-state.mjs` `findOwnAttachedKey`); an entry from a daemon older than this names none and is used only at `CLAUDE_PROJECT_DIR`'s own key. With no such entry the hook writes no marker, prints one line on stderr and exits 1 (a non blocking error the CLI records; the prompt runs and its private tools refuse), and leaves `private-turn/unserved/<session>.json`, which the daemon's refusal line quotes: `...; the private turn hook of session <S> wrote no marker at <time>: no live daemon attached to this session's folders serves its transcript <path> (<key>: pid <n> serves the transcripts in <folder>; ...)`. It does close this session's own live markers at keys no other live daemon holds, so a turn whose daemon stood down cannot outlast the next boundary (its signed browser context lives up to 60 s), and a helper's private call in such a session is refused. A failed Stop closes only this session's own markers, and a helper's start is recorded only beside its own marker. A session with nothing attached and no marker (a person's own `claude`) stays silent. Still per folder, not per session: another CLI session in the same agent folder matches the agent's entry, as before. Guards: `test/private-turn-cross-agent.test.ts` (two agents on one home: each path to the other's key, the real hook's stderr and exit code, the daemon's line, a daemon that stood down mid turn, a helper, a relative transcript path; controls: the own daemon listed after the other's, the WSL hop with no `CLAUDE_PROJECT_DIR`, an older daemon's entry, other spellings of the transcript path, a standalone session) and `test/floor-state.test.ts` (`comparableFolder`, `folderHolds`, `findOwnAttachedKey`). With real daemons and hooks, two agents on one Windows or Linux home: on the previous build Vera's hook overwrote Mark's marker with her session and her wake was lost; with this one Mark's marker is untouched, a launch folder inherited from Mark's process no longer costs Vera's wake, and a cwd in Mark's folder with no `CLAUDE_PROJECT_DIR` refuses with the reason in her daemon's log.
- **The sweep says what it removes.** Every agent's daemon sweeps every session folder, and none logged it: Vera's bound session's folder went during an idle with no line in any log. Each removal now logs one line in the log of the daemon that removed it: `hook intake: removed the spool of session <S> (idle sweep: nothing in it touched for 31m05s); this daemon is bound to that session and stays bound`, or `(its SessionEnd was consumed: ...)` and `... was bound to that session and is now unbound`. A folder that cannot be removed is named once; one the forwarder recreated at once counts as removed. Guard: `test/hook-intake.test.ts`.

**A staged auto-update no longer blocks sends and can no longer wait for ever (HOAI product board row a741d98b, Pylon 929, 2026-10-11).** On 0.68.2 a scheduled update closed intake and then refused every tool call with "restarting for an update" for as long as it waited for in-flight work to finish, and that wait was unbounded: with one operation wedged (a wake delivery nobody read), the daemon sat muted until it was killed.

- **A pending update only defers the restart.** The scheduled path now waits for a quiet moment WITHOUT closing intake or refusing a tool call. Intake closes only once nothing is in flight, and if a message lands in that instant the update yields (bounded by the triggered path's 45 s) and intake reopens.
- **A ceiling on the scheduled wait** (`UPDATE_SCHEDULED_QUIET_CEILING_MS`, 15 min). A daemon that never goes quiet keeps serving and retries in 30 minutes (`UPDATE_BUSY_RETRY_MS`) instead of at the next daily check.
- **A tool call is admitted while the update is only waiting** (`decideToolAdmission`): a send is exactly the in-flight work finishing. It is refused only once the daemon is drained and the restart is committed.
- **Stale work is not work.** An in-flight operation or an unanswered inbound older than 30 minutes (`UPDATE_STALE_WORK_MS`) no longer holds a drain open; the agent state the watcher reads still carries the raw counts.

**The owner's Always allow and Trust this site in the agent's own browser now outlive the browser host (HOAI board row b774a758).** On a daemon placed agent, both answers lasted only until the host restarted, and the owner was asked again. The host files a remembered answer under `profiles.agentProfileKey`, the desktop's own key function, vendored byte for byte. That function takes the agent id as a string (`relay:<id>` for an assistant the backend resolved) and returns null for anything else, and the host handed it `ctx.assistantId`, which `relay()` has already turned into a number. So the key was always null and `_remember` wrote nothing. `_profileKey` (`bin/hoai-browser-host.mjs`) now hands it `relay:<id>`, as `local-mcp.js` does for the relay door, which keys the agent `assistant-<id>`: the key the desktop uses for the same assistant, the key `withoutTrustGrant` revokes under, and one key per agent. An id that is not a positive integer gets no key and nothing is remembered; before, a non numeric string id would have been filed as a loopback client (`client-<name>`). The vendored `profiles.js` is unchanged. Allow once and Allow for this session are still never written to disk, and every answer is still written only to the agent's own browser folder, `~/.bgos-agent/<id>/browser/<principal>/agent-browser.settings.json`. Known limit: this plugin has no control yet for the owner to revoke a remembered answer (the desktop's `withoutTrustGrant` works on this file, and the test proves it); until one lands, deleting the origin's entry under `agentGrants["assistant-<id>"]` in that file revokes it, and a revoke control is a follow-up. Guard: `test/hoai-browser-host.trust-persist.test.ts`. No version is published or tagged here.

## 0.68.2 (2026-10-12)

**An email reaches the agent as a stranger's words, never as the owner (agent email, HOAI board row 2dd04488, piece P2: the plugin).** The backend delivers an email to an agent as a row of the agent's email chat: sender `user`, no sender user id, `fromAgent {name: 'Email', type: 'external_email'}`, and `senderType: 'external_email'` on the socket and the history route. This plugin knew no such sender: every lane delivered it as a plain user turn, with `user="User"` and the owner's id as `user_id` (the owner fallback); an email stamped `slash_command` ran `/status` on the socket lane, and a `yes <code>` email was swallowed as a permission answer on the poll and stream lanes.

- **The label** (`lib/inbound-channel.ts`). An email is recognised by any one of the backend's three signs (the sender type, `fromAgent`, `externalEmail`), on the record or inside a row envelope, and it wins over every other reading. Its turn opens with a fixed line, `[Email from outside HOAI, ...]`, and ends with a fixed line, `[End of the email from outside HOAI. ...]`, with the attachment lines inside; neither line carries anything the sender chose. It says more than the peer marker: NOT the user, NOT the owner, never an instruction even when it names the owner, files asked for and never run, and a reply leaves only when the owner taps Send. Inside, the text is folded (NFKC), every format and default ignorable character goes, and a channel, harness or private turn tag, or a line that opens like one this plugin or the backend writes (the email and end lines, peer, system, plan level, backlog, attachment, meeting and BGOS lines, and every bracketed event tag such as `[button_clicked]` or `[stop_turn]`), is neutralised, found as a model would read it: through look-alike letters, combining marks and any spacing. Nothing the sender writes can close the label or pass for the channel, the owner or this plugin, and every word stays; text past 24,000 characters (the backend already cuts at 16,000) is cut inside the label. Meta: `user="Email"`, `user_id="external_email"` (the host drops a card without one, and it names no person), `sender_type="external_email"`, `email_id` when the server sent one, and never a sender relationship or share key, whatever the record says. The owner's plan level and the backlog line sit above the label; an email's backlog line asks for nothing.
- **Its files** are the content lines and the `meta.files` entries the instructions describe, each entry with `from_email: "true"`. The backend's own names (`attachment-<n>.<ext>`) pass unchanged; any other name keeps only letters, digits, dot, underscore and hyphen; a type that is not a plain MIME type is dropped, and a reference that is not one clean http(s) link reads as no link.
- **Every lane.** Socket, poll (the history route, its boot backlog and restart recovery included), stream and every meeting card deliver an email labelled and keep it out of every branch that acts for the owner: never a slash command, steer or plan chip, never a permission answer (the permission wait included), never a meeting turn, never the chat's last human sender, never an event, never the acting user or a private turn's actor, never a mission resume, and no reply overdue nudge. The stream view keeps it an email in both wire shapes, never reads the transport owner as its author, and a finalize never turns it into a system wake.
- **`email_label`** rides every heartbeat and the canon fetch, on every host and connection, but only while `labelsExternalEmail()`, a check of the real builder, holds: a build whose label broke stops declaring it, and the backend holds the mail. That check proves the builder; the lanes are proved by the tests, which run each lane's real code out of `server.ts`.
- **What the agent is told.** A new instructions section, Email From Outside, plus a line in Receiving Attachments and in the per sender text; the offline canon says the same. The Sessions sheet never titles a session with an email.

For the backend: this plugin sends no capabilities at pair exchange, so the token arrives on the first heartbeat; it adds no draft tool (the design names the route `POST integrations/agent-email/reply-drafts` but no tool), so the agent is told to write a suggested answer in its reply to the owner, who makes the draft in the app; and it polls only chats `peers/inbox` lists, so an email chat hidden there is served by the socket alone. Guards: `test/external-email-label.test.ts`, `test/session-library.test.ts`. No version is published or tagged here.

## 0.68.1 (2026-10-12)

**A refused private call on a peer agent's turn is now counted.** A request that arrives from another agent is never a verified sender, so boards, schedule and browser calls on such a turn refuse (since 0.67.0, and correctly). KC asked to see the impact before deciding whether an owner-set delegation should let a trusted agent's request through (`docs/proposals/peer-delegation-private-tools.md`). Each such refusal now logs one line (`peer private call refused: tool=... delegate=... target=... today=N`) and adds to a per-day file `peer-private-refusals.json` beside the daemon's state, per delegate and tool, 30 days kept. Ids and the tool's name only; no message text, no arguments, no board or chat names. The refusal itself is unchanged: the turn tracker remembers the peer behind a turn apart from the actor, and that never satisfies the gate.

## 0.68.0 (2026-10-12)

**Agents run in the background on every computer, and a window is only a viewer beside one (HOAI board row d133ddb2, piece 1 of 4: the plugin).** "Create a new agent here" on Windows started the agent with `cmd /c start ... cmd /k node hoai-core.mjs`, a visible console that stayed open, empty, after the agent ended (AlienAres), and the Windows agent task ran its launcher minimized in the taskbar.

- **Every launch is hidden.** The restart ladder's recipe rung (create_agent, and any restart with no supervisor) starts `wscript //B <statedir>\launch-hidden.vbs` on Windows, which runs `node hoai-core.mjs` once in a console of window style 0 and does not wait, unattended as that agent (`HOAI_SUPERVISED`, as the task launcher does). `cmd /k` is gone. On a Mac or Linux the rung is tmux, then `script`; the visible Terminal and terminal emulator fallbacks are gone (no tmux and no `script` is the named failure `no_pty_available`). The Windows agent task's `run-agent.vbs` uses window style 0 instead of 7; the sweep already rewrites an installed launcher whose text differs, so a task picks it up at its next start.
- **create_agent keeps a new agent running from its first minute.** It reads the keep-alive answer after pairing. When the computer's Keep agents running switch is on, or the computer was never set (Kc's choice 1: the first new agent turns it on), it installs and starts the product supervisor itself: the agent task on Windows (registered and started), `bgos-agent install --always-on` on a Mac or Linux. A computer the owner turned off, or no answer, gets the hidden one shot. A task that cannot be registered leaves no file it wrote behind (files an earlier install left are kept) and the agent still starts once, hidden; a supervisor that was started is never doubled by a one shot. Re-creating an agent that already runs registers or installs the supervisor without starting it and restarts the running session in place, as before. The step says which: `launched via task (keep agents running: switch_on)`, `launched via task, restarted via marker (...)`.
- **Never a second session from a hidden launch.** On Windows the one shot now refuses (`session_without_launcher`) when the agent still runs with no launcher (an orphaned claude, a person's own), exactly as the task start already did; the old visible `cmd /k` had the same gap, only it showed.
- **Show agent windows.** Right after every sweep, whatever the switch says, the watcher's windows pass (`lib/agent-windows.mjs`, rules in `lib/agent-windows-plan.mjs`) reads the owner's setting from the keep-alive answer (`showAgentWindows`, absent reads off) and opens or closes viewers: on Windows a watch only window (`bin/hoai-agent-viewer.ps1`, started hidden through `bin/hoai-agent-viewer.vbs`) that attaches to the agent's hidden console and mirrors its screen, with no way to type into it; on a Mac a read only `tmux attach-session -r` in Terminal (`open -g -a Terminal` on a `view-agent.command` in the agent's state folder, so no Automation prompt); on Linux the same attach in the first terminal emulator found, when the watcher has a screen. At most 4 open a minute, oldest agent first. Switching it off closes the viewers and only the viewers (a Windows viewer process found by its command line; a read only tmux client, never a person's own attach). A viewer the owner closed stays closed until the agent's next start or the setting goes off and on, also across a watcher restart (the memory rides the watcher's `state.json`); an agent that restarts in a loop gets a new viewer at most every 5 minutes, and a viewer left on a session that ended is closed rather than counted for the new one. The pass never starts, stops or restarts an agent. It also hides in place, once per launcher, a console that an older task launcher left minimized or the old `cmd /k` left on screen (never a person's own console). Measured on a Windows 11 PC whose default terminal is Windows Terminal: the old task launcher's minimized console is a conhost window and is hidden in place; the old `cmd /k` console went to Windows Terminal, which hiding cannot reach, so it is left as it is and logged, and it shows until that agent's next start. The new hidden launches are not handed to Windows Terminal: no window of any kind appeared.
- **The heartbeat says what each computer can show:** `env.watcherHealth.windows = {mode, reason}`, mode `tmux | viewer | none`, reason `setting_off | showing | no_tmux | no_screen | no_terminal | open_failed | unsupported`, fixed lists only.

What the backend must add (piece 2): `showAgentWindows` (true or false) in `users.fleet_prefs`, and in the `GET integrations/watchers/keep-alive` answer on both branches; `switchState: 'on' | 'off' | 'never_set'` in that answer (`never_set` for a computer with no row, `off` for a row the owner turned off); the default ON write and the adoption of the new agent for a computer never set, at create_agent time (the plugin starts the supervisor for `never_set` before the agent first checks in); and `windows` kept by `sanitizeWatcherHealth` (both values from the lists above). Until then the plugin behaves as today with every launch hidden: no field means windows off and the switch read from `enabled`.

Not in this piece: the plugin's own `bin/hoai-bootstrap.sh` and `.ps1` still open a visible terminal for their final launch, and the app's one click script launches a visible PowerShell window on Windows (pieces 3 and 4). WSL tmux on Windows waits for its one day test (choice 2).

## 0.67.5 (2026-10-12)

**Boards, schedule and browser tools no longer refuse every call on a Windows agent whose folder is reached through a link.** Claude Code names a session by `fs.realpathSync(process.cwd())`: the transcript under `<config dir>/projects/<folder>`, the hook payload's `cwd` and `transcript_path`, and the `CLAUDE_PROJECT_DIR` it hands its MCP servers. The daemon gets the CLI's cwd as spelled (`bin/bgos-launch.mjs` passes its `process.cwd()` on as `BGOS_LAUNCH_CWD`). On macOS and Linux `getcwd()` already returns the real folder. On Windows a junction or a symlink keeps its spelling, so the daemon looked for the session under a projects folder the CLI never writes, the hook intake refused every event of the agent's own session (`hook intake: ignoring session <id> (foreign-project)` in the daemon log), `privateTurns.begin()` never ran, no `.ready` receipt was written and `browser-turn.json` kept `turnId: null`. The private turn hook still wrote its marker, because it also finds the folder through `CLAUDE_PROJECT_DIR`. Reproduced on Windows with the real daemon, the real hooks and a fake backend; the same layout behind a symlink adopts on Linux.

The daemon now resolves the launch folder the way the CLI does (`claudeProjectCwd` in `lib/session-binding.ts`: the same non-native `realpathSync`, so an 8.3 short name and the drive letter stay as spelled, checked under node and under bun, and a folder that cannot be resolved is used as given) for the readers that follow the CLI's transcripts: the session binder and with it the hook intake, the usage self report, the resting watcher and the login watcher. Everything that means the agent's own folder (the folder pin, the floor keys, supervision, skills, the intake's base for a relative path) still uses the launch folder as given. Two other readers of `<config dir>/projects` also still use it and are left for a follow-up: the memory folder (`resolveMemoryFolder` in `server.ts`) and the session pin keeper, which mirrors the launcher's own lookup in `bin/hoai-core.mjs`. On macOS and Linux the launch folder comes from `getcwd()`, which is already the real folder, so nothing changes there; only a `BGOS_LAUNCH_CWD` inherited with a linked spelling now resolves to the folder the CLI uses. Guards: `test/private-turn-linked-folder.test.ts` and `test/claude-project-cwd-bun.test.ts`. The daemon picks up the change when it restarts, so each Windows agent needs one restart after the update.

**A download in the agent's own browser is asked for, and one nobody answers is kept for the owner (HOAI board row 67562770).** Measured on main 0a4c96a with the host started the way the daemon starts it: Chrome raised the download over CDP, Playwright wrote it into a `playwright-artifacts` folder in the system temp folder and its MCP tab code copied it into `~/.bgos-agent/<id>/browser-output/<person>/` and printed that path to the agent. Nobody was asked, although the host's agent text said a download is asked for. The causes: `connectOverCDP` without an artifacts folder, the browsing context accepting downloads by default, and Playwright's `Tab._downloadStarted`, while the host's ask only looked at tool calls.

**Now the rules are the desktop app's (BGOS #2198).** Every download goes to the host's ask (`lib/browser-downloads.mjs`), with the desktop's download choices, as a card for 60 seconds whatever wait the click carried; it never holds the agent's call, and the agent's next gated action waits for it instead of being told the browser is busy. Chrome writes only into `~/.bgos-agent/<id>/browser-downloads/<person>/held`, inside the agent's own folder; Playwright's own saver is switched off when it loads, and a browser whose folder guard fails refuses downloads. Allow puts the file where the ask said, the agent's browser output folder, under its own name and never over another file, and the agent reads its path in `hoai_browser_status`. Deny deletes it (a Deny is not remembered, as on every gate of this host). Only an explicit Deny deletes: a timeout, a lost card, an answer the host cannot read or a host that stops keeps the file. Kept files sit under opaque names in an owner only folder (0700 and 0600 off Windows; on Windows inheritance removed and the user's SID alone, read back), refused inside OneDrive, Dropbox, iCloud and the like (the host now receives the OneDrive variables for this; Chrome never does) and in a roaming profile, excluded from Time Machine; they are deleted after 7 days by a sweep at start and every hour. The owner is told the moment a file is kept, by a second card whose Deny deletes it at once and whose Allow gives that one file to the agent and remembers nothing; a notice that could not be posted is posted when the pairing next connects, and one posted before a restart is still read after it. The agent reads its latest downloads and every file still kept for the owner as a handle, a name, a size and a state, also after its session closed, and never a kept file's path. Limits for keeping are Kc's: 50 MB a file, 5 files and 500 MB a session, 25 files and 1 GB for the agent; past them no answer deletes the file, and the ask says so. Bytes still arriving are bounded by watching the held folder. A closing session keeps what finished within 5 seconds before Chrome quits. After a crash, a finished download nobody answered comes back kept at the next start (an owner's earlier Allow saves it instead), and a download owed a delete is written down as such before the delete starts, so a delete Windows refuses for a moment is retried and a crash never brings a denied file back as kept.

**Known limits.** The agent runs on this machine as the same OS user, so owner only permissions keep other users out, not the agent's own shell: no tool hands it a kept file or its path, and it is told not to fetch a kept file again. The notice card lasts 30 minutes; after that a kept file goes at 7 days. The gate now reserves the browser before posting a card, so two asks at once post one card, and counts a card's wait from when it was posted. Guards: `test/browser-downloads.test.ts`, `test/hoai-browser-host.downloads.test.ts`, `test/hoai-browser-host.downloads.chromium.test.ts`, `test/browser-gate.test.ts`, `test/browser-env.test.ts`. No version is published here; publishing is Kc's call.

## 0.67.4 (2026-10-12)

**A clone agent no longer loses boards, schedule and browser after a self-update or a watcher update (board bbbf3438 follow-up).** 0.67.2 registered the private turn hook only through `bgos-agent update`. The daemon's own auto-update (`lib/self-update.ts`) and the watcher's update never ran it, so any clone install updating that way restarted onto 0.67.x with no hook in its workspace and every private tool call refused (15 agents of one user on a MacBook Air and 4 on kc-server were one restart away).

Now the self-updater runs the NEW checkout's `bin/hoai-register-hooks.mjs` for the daemon's workspace folders after the pull and BEFORE it asks for a restart (the CLI reads hooks once, at launch), and the daemon registers them at boot when the private turn hook is missing so the next launch has it. Only a workspace whose `.mcp.json` names this checkout's `server.ts` is touched, a marketplace install never is, and a folder that never carried the activity rail gets the rail and the private turn hook but not the blocking floor hook. The hook helper is `lib/clone-hooks.mjs`. The watcher's connector update (`lib/update-executor.mjs`) does the same for each clone agent, once per workspace folder, after the fast-forward and right before that agent's restart (best effort, 30 s budget, never changes the step's outcome).

## 0.67.3 (2026-10-12)

**`bgos-agent update` finishes with the script it just pulled.** The pull is a `git reset --hard`, which replaces the very file the shell is running, so everything after it (hook registration, the restart) ran the OLD function bodies. The first update to 0.67.2 therefore registered no private turn hook and a second run was needed. The update now hands over to the new file right after the pull (`HOAI_UPDATE_REEXEC` stops a second pull and carries the starting version), so a fix shipped in an update applies on the first update.

## 0.67.2 (2026-10-12)

**Boards, schedule and browser tools no longer refuse every call on a clone agent that never had the private turn hook (board row bbbf3438 follow-up).** 0.67.0 runs a private tool only inside a turn whose marker `hoai-private-turn-hook.mjs` wrote. A clone workspace gets that hook only from its own `.claude/settings.local.json`, and `bgos-agent update` refreshed only a folder that already named `hoai-hook.mjs`. Nine agents on KC's Mac had no entry, so after a restart onto 0.67.x every private call answered "its current sender could not be verified", on scheduler wakes and every other turn.

`bgos-agent update` now registers the hooks for a clone workspace (its `.mcp.json` names this checkout's `server.ts`, compared by real path) even when the folder never carried one, and for agents another supervisor keeps alive (a keepalive job, a watchdog) it does so from the folder their `service.json` declares. A folder that never had the hooks gets the activity forwarder and the private turn hook, not the blocking floor hook. The CLI reads hooks at launch, so each agent needs one restart after the update.

The gate itself is unchanged and stays closed without the hook. The daemon now looks once at boot and logs `private turn: the private turn hook is NOT registered for this session` with the fix, and a refused private call says that cause instead of blaming the sender.

## 0.67.1 (2026-10-12)

**A connector update no longer calls an agent deaf when it never restarted it (board row bbbf3438).** The keepalive launcher calls `bin/hoai-keepalive-marker.mjs` through an aliased home path, and the script compared its resolved module URL with that alias, so `main()` never ran: exit 0, nothing written, `keepalive.json` left naming dead pids. The update then had no live session to restart, reported "restarted", and verification failed on the unchanged boot time. The script now compares real paths on both sides, as `hoai-core.mjs` already does.

Four more scripts decided "am I the entry point?" the same way and would also have done nothing when launched through an aliased path: `hoai-hook.mjs`, `bgos-claim.mjs`, `bgos-daemon-wrapper.mjs` and `hoai-private-turn-hook.mjs`. All now compare real paths. When the private turn hook was skipped, private tools were refused (the server finds no marker for the prompt), so the failure was a refusal, not an exposure.

## 0.67.0 (2026-10-11)

Remote browser control returns to the agent ten seconds after the owner's last accepted page click. Typing, scrolling and navigation do not extend that deadline. Physical input still drains before agent work resumes. A request refused during owner control is clearly reported as not started and safe to retry after handback. The bundled browser skill explains the behavior. Protected credential entry and encrypted per-agent profiles retain their separate rules.

Shared browser, schedule and Boards tools stay on the acting person. A card from another person, an unattributed card or a card from another chat that lands while a private turn runs now ends that turn's private identity at once, so the next private call refuses until a new prompt admits one person. A helper agent may use private tools only inside the turn that started it (SubagentStart and a PreToolUse guard). A failed boundary write at Stop or SessionEnd no longer blocks stopping; the marker is invalidated instead. A prompt past the 256 KB forwarder clip keeps its private turn through the prompt hash, and the prompt text is never spooled.

## 0.66.1 (2026-10-11)

**A Windows agent that crashes is started again in the same sweep, not 30 minutes later (board row 69337efa).** On AlienAres (watcher and plugin 0.66.0, Keep agents running on), the sweep had installed the task `HOAI Agent 1078` for test agent 1078. Ares killed only its claude at 07:54:15Z; the plain hoai launcher exited with it, and nothing started the task for 30 minutes while the heartbeat said `supervised canonical` and no task start was counted. The cause: on Windows the sweep started a dead launcher's task only after 30 minutes with no activity (`decideTaskStart` refused on `recentActivity`, `LEGACY_QUIET_WINDOW_MS`), because Windows has no cwd lookup and recent activity was its only stand in for "maybe a session this watcher cannot see". After a crash that activity is the dead session's own last writes: its state, its transcript, its hook spool.

**Now the process table answers.** When the launcher is dead and no live daemon says the agent runs (no fresh state, no live holder of its pairing lock), the sweep looks in the listing it already reads for a claude of this agent, by what a Windows listing carries (`lib/process-tree.mjs` `findAgentClaudePids`): the agent's pinned session id on a command line (hoai-core starts claude with `--resume <pin>` or `--session-id <pin>`), its folder as a whole argument on a command line (a claude installed under the folder, as for an agent paired in the home folder, is not one run in it), or a process of record that still runs (the claude or the daemon its last state named, its lock's holder; each only while its start time shows it is the same process and not a reused pid). None listed: the task is started in that sweep. One listed: the start waits (`session_without_launcher`) even with no recent activity, where it used to start a second session on the same pin beside it. Only a listing that cannot be read, or a lock holder that still runs with no claude visible above it (an orphaned or hung daemon, or a claude whose command line the watcher cannot read), keeps the 30 minute quiet window. The first install of a task is unchanged (started only when nothing says the agent may run); the sweep after it starts a crashed agent as above.

**A start that waits says so, and when.** The row is `waiting_idle` with its reason, never `supervised`: `quiet_window` (the listing could not be read and the agent was active), `task_start_rate_limited` (was `supervised task_start_rate_limited`), `one_restart_per_sweep`, and `session_without_launcher` (a session of the agent runs without its launcher; with no update pending this used to read `supervised canonical`). The heartbeat entry carries `restartAt`, an ISO time re-serialised by the plugin (no path, no free text), when the start can run: 30 minutes after the newest activity for `quiet_window`, 30 minutes after the last start for `task_start_rate_limited`, absent when nobody can know (the end of a session, the next sweep). None of these waits carries `pending`, so the app offers no Restart now for them. The backend keeps only the agent keys it names (`sanitizeAgent` in `backend/src/integrations/watcher-health.ts`: id, state, reason, since, waitingSince, pending), so the state and the reason reach the app today, and `restartAt` once the backend keeps it (an ISO time, the check `bundle.lastRefresh.at` already has).

**The limits stay, and a task start now counts as the sweep's one restart.** One start per agent per 30 minutes and 3 per launcher death episode, then `failed task_start_failed`, are unchanged, so a crash loop is still bounded: three starts in about an hour, then a visible failure. The module said a task start had the same limits as a restart, one per sweep included, but nothing counted it there: now it does, so two agents that crash together are started a minute apart, and a task start and an update restart never land in the same sweep. Nothing new is written outside the watcher's own folder. Guards: `test/watcher-keepalive.test.ts`, `test/keepalive-plan.test.ts`, `test/process-tree.test.ts`. No version is published here; publishing is Kc's call.

## 0.66.0 (2026-10-11)

**The plugin answers the skills view: list the skills an agent loads, and remove one of its own (skills view row 3, board rows 01a12481 and cc6dda66).** A new `skills_rpc` op `list_installed` walks the roots Claude Code reads (agent, repo, computer, synced, plugin, managed), with the agent folder taken from `BGOS_LAUNCH_CWD` only (never the plugin cache cwd) and the config dir from the resolved `CLAUDE_CONFIG_DIR`. Only the head of each SKILL.md is read, a file whose realpath leaves its skill folder is never read, and name and description pass the secret scanner. Each row carries a display path with the home as `~` and `/` separators on every OS (Windows included, `lib/skills-inventory.ts` `displayPath`), its provenance, and `removable` only for the agent scope. `remove` moves one agent scope skill to the plugin state trash, outside every skills root, and refuses every other scope, `.` and `..` segments, any other path, a linked `.claude` or `.claude/skills` and an agent folder that is the computer's. The daemon declares `skills_list`. This version carries #201 and #206 together, green on Windows: the install path runs the win32 branch on a Windows host in its tests too, and the unreadable file cases use an ACL deny there, since mode bits do not gate reads on Windows.

**An agent can share one of its skills with another agent, and receive one (skills view row 6, Claude Code part, board row 01a12481).** Two new `skills_rpc` ops answer the Share backend (BGOS #2216). `export_skill {name, scope, dryRun}` reads one skill folder of this agent (scope `agent`, `<launch folder>/.claude/skills`) or of this computer (scope `computer`, the config dir's `skills`, never `synced`), found the way the skills list names its rows (frontmatter name, else folder name; a folder the list does not show is never read, and two rows of one name are refused), applies the shared content rules and answers the files they send, each with its sha256, plus the bundle sha256, the excluded files with why, the scan rule ids and the block, if any. The walk follows no link at all (a link inside the folder could name a dot or secret file under a harmless name), leaves behind hard linked files, anything not a regular file and every dot folder unread, reads at most 51 files of at most 64 KB plus one byte, leaves a file that is not UTF-8 behind as not text, says `too_large` past any bound instead of sending a folder with files missing, and refuses (`read_failed`) a folder with a file or subfolder it cannot read. A secret never leaves the computer: a secret in any file or in any name the walk leaves behind refuses the export (`share_blocked`) even for a preview and whatever other block outranks it, and so does a too large or binary skill, whose cut or lossily decoded file could carry part of one; a skill the list hides for a secret shaped name is never found. A preview (`dryRun` exactly `true`) answers a runs commands or invalid verdict with the content so the sheet can say why; the real export of any blocked skill is refused and carries no content. A shell fence opened anywhere in a line (Claude Code runs ```` ```! ```` with no line anchor) counts as runs commands on export and on install, on top of the shared rules, which only see one at the start of a line; the backend twin should adopt that with a rules version bump.

**`install_bundle {offerId, name, files, sha256, replace?}` writes an approved bundle into this agent's own skills folder and nowhere else.** Every file's sha256 and the bundle's are checked (`hash_mismatch`), then the content rules run again, so a script, a dot file, executable frontmatter or a shell line refuses the whole bundle. Refused before anything is written (`scope_refused`): a name outside Claude Code's rule (and a Windows reserved one on Windows), a path that is absolute, has a `.` or `..` segment, a backslash or a drive, a `.claude` or `.claude/skills` that is a link, an agent folder whose skills folder is or sits inside the computer's, the managed one or a repo level one (an agent launched in the home folder included), and no launch folder at all (`not_supported`). An existing skill of the same name in any case is `name_taken` unless `replace`, which moves the old copy to the plugin state trash first and puts it back if the new one cannot be moved in. The files are written into a temp folder beside the skills folder (never inside it), read back and hashed, then renamed into a name claimed with `mkdir`, so nothing half written is ever loaded. Progress (`verifying`, `writing`) goes to the backend's `/progress` lane. The backend's resend and a second Install tap carry a new rpcId: an install in flight for the same `offerId` is joined, an installed one is answered again from memory, and after a restart a folder on disk that hashes to the bundle answers installed instead of `name_taken`. A failed install may be retried.

**The rules are the backend's, byte for byte.** `lib/skill-share-content-rules.ts` ports `backend/src/skills/skill-share-content-rules.ts` (rules version 1) onto this plugin's twin secret scanner, and `lib/skill-share-content-fixture.ts` is the backend's fixture copied byte for byte and pinned by the same sha256; all 46 cases give the backend's verdicts. The daemon declares `skills_receive` on every host, right after `skills_list`. No MCP notification is added. Mutation proven. No version is published here; publishing is Kc's call.

## 0.65.5 (2026-10-11)

**A generic `POST /messages` now names the agent that wrote it (board row 019ff949).** The backend reads the writing agent on that route only from the `X-Caller-Assistant-Id` header, and this daemon never sent it there, so every hook rail card, plan, question carousel, component card and permission card it posted was logged by the backend's `raw_chatid_shadow` line with `callerAssistantId: null`. On 2026-10-10 that was 3,445 of 3,907 lines, and a null line cannot say which agent still addresses chats by raw id, the one question that gates turning `ALLOW_RAW_CHATID` off. `bgosPost` now adds the header for the exact `messages` route (`lib/messages-caller-header.ts`); every other route is unchanged, an explicit header still wins, and a chat this daemon knows is a meeting or a peer side-thread gets no header: in a meeting a caller id would let a hook rail card into the shared transcript, and in a CLOSED side-thread it would make the backend reopen the conversation (and hand the turn to the peer) before refusing the post 400 `a2a_wrong_route`; without it nothing is written there, as before. For an owner's own chat nothing else changes: the backend checks that the named agent belongs to the authenticated owner. Guard: `test/messages-caller-header.test.ts`.

## 0.65.4 (2026-10-11)

**The watcher follows the installed plugin by itself, with no job and no reinstall (board row 0c659c85, raised on Data's word).** Before this version the per machine watcher refreshed its own bundle only at the end of a reconcile job, which only the owner's Update or Reconcile sends. Its manifest names the versioned cache folder the bundle was copied from, and a marketplace update leaves that folder on disk unchanged, so nothing on the computer ever read the bundle as stale. On AlienAres (Windows 11) the watcher ran 0.61.1 from 2026-10-05 while the plugin moved to 0.63.2, without the supervisor arm 0.62.0 added for Keep agents running, and its heartbeat only ever said 0.61.1.

**Now, right after each heartbeat (once a minute), between jobs**, the watcher compares the bundle it runs (hashed when it started) with the watcher files of the CURRENT install: the `installPath` that `installed_plugins.json` names for a marketplace install (under the manifest's `CLAUDE_CONFIG_DIR` when it records one, else under the config dir the cache folder itself sits in), the checkout itself for a clone, so a clone's watcher follows what is checked out. When they differ it runs the staged swap a job runs: copy into `next/`, load the copy under the service's node (`hoai-watcher help`), swap, and leave the way a job's refresh leaves (exit 75 for launchd and systemd, on Windows a successor through `run-hidden.vbs`, then exit). It never runs inside a job or a keep-alive sweep: their heartbeats only report. A staged copy that does not load, or is incomplete, is cleared and the live bundle keeps running. The comparison is by content, so a bundle already refreshed from that install does not read stale again, whatever fingerprint an older installer recorded. A release that stops shipping a file an older watcher lists is still followed: the copy takes this code's list minus what the install no longer has, plus the install's own import closure, checked complete and probed as before.

**Bounded.** Every attempt is written to the watcher's `state.json` (`bundleRefresh`) before anything is copied and again before the process leaves, and it outlives restarts: after a swap the next attempt waits 10 minutes, after a failure or a refusal an hour, and while the watcher runs exactly the bundle a swap put in place, that swap's target is never swapped to again, so a swap that somehow still reads stale stays reported instead of repeating (a bundle moved away by anything else is brought back as usual). Refused by name, with no swap: an installed plugin OLDER than the bundle (no automatic downgrade); on Windows a watcher folder without `run-hidden.vbs` (exiting would leave no watcher until the next logon); on Linux any other process in the watcher's own cgroup, or a cgroup it cannot read (systemd ends the whole cgroup of the unit when the watcher exits, so an agent the watcher started through tmux or script would die with it). On Windows a successor that does not start leaves this watcher running on its old code instead of exiting, recorded as `no_successor` and retried after an hour. Everything it writes stays in `~/.bgos-agent/watcher`. A manual `hoai-watcher reconcile` still never swaps.

**Reported.** The heartbeat's `env.watcherHealth.bundle` carries `bundleVersion`, `installedVersion`, `stale` (null with a `reason`: `no_manifest`, `not_installed`, `plugin_root_missing`, `plugin_root_unknown`) and `lastRefresh` (`at`, `outcome`, scrubbed of the home path and the user name). It rides inside `watcherHealth` because the backend takes that field leniently (never a 400, strict validation or not); today's backend sanitizer keeps only the keys it knows, so showing `bundle` in the app needs the backend to keep it in `sanitizeWatcherHealth`. **Also fixed:** a swap (a job's too) wrote the new manifest without the agents' `claudeConfigDir`, which the service environment does not carry, so a watcher on a custom config dir lost it at its first refresh; it is kept now, and a manifest that already lost it gets it back at the next automatic refresh.

**A watcher already installed (0.61.x up to this version) still runs the old code**, which refreshes only at the end of a reconcile job, so it needs one nudge after this version is published: one Update (or Reconcile) job from the app to that computer's watcher. The job runs its normal plan first (it may update the plugin and restart agents) and ends with the `refresh_watcher` step, which brings this code in; from then on the watcher follows by itself. Guard: `test/watcher-self-refresh.test.ts` (22 tests: the real loop, the real `installed_plugins.json` reader, the real installer, POSIX and Windows paths, and one run of this checkout's real bundle through the real probe), red on 0.65.2. No version is published here; publishing is Kc's call.

## 0.65.3 (2026-10-11)

**A daemon that stands down now tells the backend, in tokens only (board row fc75c7c3, identity race plan step 3).** Until now a daemon that refused, went passive, lost the pairing lock, died or switched a duty off told only its own log, so nobody could count the strays, or the agents still answering by elimination. Each of the twelve sites in the plan's list now sends one report: `POST /api/v1/integrations/stand-downs` (BGOS #2189) under the pairing token the heartbeat sends, with a body of exactly `{reason, route, phase, machineId, pluginVersion, at}`. The reasons are the backend's eight: `refuse_home_mismatch` (the home refusal), `passive_at_boot`, `lock_lost` (five places: the tick, the re-arm gate, a re-arm without the lock, and both ends of the first arm), `arm_failed` (an arm that throws after a promotion), `exit_uncaught`, `exit_boot_fatal`, `always_on_unsupported` (a Windows daemon, and only when Keep agents running is known to be on for the agent: the daemon reads the agent's `alwaysOn` once, so off, unknown or a failed read sends nothing) and `always_on_supervisor_missing`. The route is the fine one the resolver chose (`env-path`, `env-assistant`, `folder-pin`, `sole-per-assistant`, `legacy`, or `unknown`), never the pairing lock's `pin`, `env` or `elimination`. The phase is `boot` until delivery is first armed and `run` after. The eight other sites send nothing: the several agents refusal (no single pairing), the unpaired stub (no credentials), a normal shutdown, the self-update restart (its readiness already reports it), the update stream on a revoked pairing, and the three per chat refusals the backend issued.

**A report never gets in the way.** One attempt, bounded at 2 s for headers and body, never retried (not a 400, not a 401, nothing), never redirected (a redirect would carry the token elsewhere), and it never throws. At most one report per reason and phase per process: that dedupe is the rate limit, so a lock that flaps all day sends one `lock_lost` per phase. After a 401 the token is refused and nothing more is sent. A boot never waits for one. The two exit sites (an uncaught exception, `main()` failing) send theirs from a child process and block on it, 2 s at most, so nothing else in the daemon runs between the fault and the exit, as before (no poll, arm or socket frame can slip into that window). The home refusal starts its report before it serves the notice and waits for what is left of the 2 s only once the host has gone. A value the backend would refuse is never sent, and a site with no pairing credentials (unpaired, or an API key install) sends nothing. No folder, path, pid, session id, error text or token is in any body or log line; the exit path hands the token to its child on stdin, never on a command line. The machine id is read for a report, never minted (the heartbeat mints it), so a refused stray still writes nothing; its one new use of the token is the report itself. The version is read once at boot, so a clone updated in place reports the code that is running.

**The heartbeat says how the daemon found its identity.** `env.identityRoute` (the same fine route) and `env.homeConfirmed` (whether it passed the home check) ride every full beat. Only a listed route and a real boolean are sent.

**Data's contract test.** The backend's token lists are copied into `test/stand-down-report.test.ts` and pinned: a drift on either side, a report or heartbeat sending `pin`, `env` or `elimination` as a route, or any key outside the lists, goes red. `test/stand-down-sites.test.ts` finds each site in server.ts by its syntax, lifts it with the daemon's own wiring and runs it against a local fake backend: each of the twelve was red before this change and is green now, and each of the eight is proven silent. Mutation proven.

**`hoai doctor`: a workspace .mcp.json server beside the marketplace install is WARN, not FAIL (Data, kc-server agent 867).** On that shape the agent launches through the workspace (or clone) `.mcp.json` server and the marketplace install is kept on purpose, because it supplies hoai-browser, the hooks and the skills. 0.65.2 failed the Channel route row with "TWO routes on this host" and a fix line saying that removing the marketplace install is what clears it. The row is now WARN (a new fifth status, which like UNPROVEN never fails the bootstrap's preflight gate and prints no Fix line), says it is a supported shape, and no line of it says to remove the marketplace install. Every other duplicate (a clone install beside a workspace server of another name, or a `.mcp.json` declaring two HOAI servers) keeps its FAIL. Mutation proven. No version is published here; publishing is Kc's call.

## 0.65.2 (2026-10-10)

**`hoai doctor` finds an agent's identity the way the daemon does, so a computer that runs several agents under an env pin no longer reads as broken (board row fc75c7c3, found by the n8n Guru canary of 0.65.0 on kc-server, agent 867).** kc-server runs seven agents under systemd. Each is identified by `BGOS_ASSISTANT_ID` or `BGOS_CREDENTIALS_PATH` in the `env` block of its own `.mcp.json`, each has its own `credentials-<id>.json`, and no folder holds a `.bgos-agent-id`. The agents boot and run. The doctor did not see that pin: it read only its own flag, its own environment and the folder pin, so the daemon its handshake started had no identity and refused ("REFUSING to start: this host has 7 paired agents ... no identity pin"), and its credentials row looked for a single `credentials.json`. A computer with one `credentials-<id>.json` and no `credentials.json` read as unpaired for the same reason.

**The rule is the daemon's, run in the agent's folder.** Strongest first: the env pin, with the folder's `.mcp.json` env block over the shell's environment (Claude Code hands the block to the daemon it starts; a block that sets the id to nothing or to the unsubstituted placeholder still overrides the shell's value, and `${VAR}` and `${VAR:-default}` in it are expanded from the shell, an id that came out of the shell having to be a number and never being printed), then a `.bgos-agent-id` folder pin (a pin naming an agent with no credentials file is ignored, as the daemon ignores it), then elimination: the only paired agent, else the shared `credentials.json`, else several paired agents and a refusal. The doctor's copy of that rule is pinned to the daemon's own resolver by a test over 2560 combinations of those signals. The handshake child is handed what Claude Code would hand the daemon (the `.mcp.json` id and path, and `--assistant-id` as before); a folder pin is not injected, the daemon finds it from the folder it is started in, as in a real launch. The log path and the channel-live marker use the same identity.

**What it prints.** The credentials row names the file, where the identity came from (the env block of that `.mcp.json`, the shell, the folder pin, or elimination, with a note when a pin or a shell value was ignored or overridden) and the home with its source, as in 0.65.0. With `--assistant-id` it also says what a session started in the folder without the flag would do, when that is not that agent. A folder whose `.bgos-agent-id` and `.mcp.json` name two different agents fails the row, because `hoai` will not launch it, although the daemon alone would answer as the env pin.

**A refused daemon is still never healthy.** In a folder nothing names, on a computer with several paired agents, the handshake fails with the daemon's own refusal and the credentials row fails with both remedies (write the id into `.bgos-agent-id`, or set `BGOS_ASSISTANT_ID` in the env block of `.mcp.json`), without guessing which agent, and says the doctor looked only at its own environment, the `.mcp.json` and the pin (a systemd `Environment=` line or the supervisor's `HOAI_SUPERVISED_ASSISTANT_ID` is not visible to it). Two servers in a `.mcp.json` naming two agents, or a `${VAR}` the shell does not set, fail the row and say why. The doctor prints no token and writes no pin or credentials file; a test asserts both on every shape it runs (seven agents with the pin in `.mcp.json`, the pin in the environment, the folder pin, both, one agent by elimination, and a folder nothing names).

## 0.65.1 (2026-10-10)

**Agents now get each attachment's details as the instructions promised (board row 01a1266e).** The session instructions told agents every message may carry a `files` array in `meta`; no lane sent one, and meeting turn cards dropped attachments entirely. `meta.files` is now a JSON string (the harness drops a card whose meta holds a non-string value) with `name`, `kind`, `mimeType` and an http(s) `url`, omitted when a message has none, on the socket, poll and stream lanes alike. Meeting turn cards carry the same lines and meta; one built from the meeting broadcast, which carries no files today, says `files_unknown: "true"` instead of implying there were none. A file the server could not link is named to the agent rather than silently dropped. Guard: `test/inbound-files-meta.test.ts` (62 tests; a raw array in meta turns 20 red).

## 0.65.0 (2026-10-10)

**A stray Claude Code session can no longer claim an agent's home folder, and the agent takes its channel back from one (board row fc75c7c3, options A and D of the identity race plan).** On a computer with one paired agent every Claude Code session starts a bgos daemon, and one started in a folder with no pin finds the agent by elimination. Up to 0.64.3 such a stray, booting while the agent was down, took the pairing lock (the lock picked whoever came first), answered in the agent's chats, and after 60 s holding the channel wrote its own folder into the agent's credentials file as `homeDir`. From then on every stray in that folder passed the home check and could repoint the agent's resume pin (Ares, 2026-09-19: the BGOS repo recorded as Ares' home, fixed by hand). The race is now a test (`test/identity-race.test.ts`, real temp files, the same lib calls server.ts makes): red on 0.64.3, where the stray writes its folder as the home at 60 s and the pinned agent cannot take the lock back, and green here.

**Who may write the home.** Pairing writes the folder it pairs in, the folder it bakes the pin into, as `homeDir` with `homeSource: "pairing"` (only when an agent is bound, as for the pin; a re-pair rewrites both). A daemon that found its identity through the folder pin confirms an unconfirmed home with its own folder (`homeSource: "pin"`) on its first held tick, and logs a WARN naming both folders when that replaces a different one, with the pin that keeps the old folder working. Every home written up to 0.64.3 has no `homeSource` and counts as unconfirmed: it is still enforced against elimination starts as before, and the agent's next start from its pinned folder, or a re-pair, replaces it, Ares' included. No credentials file needs a hand edit. A daemon that found its identity by elimination never writes the home (the 60 s self record is gone), and one with no home to check against has not passed the home check: it still starts, but it neither repoints the resume pin (`~/.bgos-agent/<id>/session-id`) nor serves the owner's Memory and Changes panels, and its boot log says so in one WARN line with the fix. Kept on purpose (the plan's choice 2): a start that matches an unconfirmed home passes the check, because unpinned agents whose home 0.64.3 recorded correctly rely on it; on a host in the Ares state that window closes at the agent's next pinned start.

**The env route** (`BGOS_ASSISTANT_ID` or `BGOS_CREDENTIALS_PATH`) keeps working and is never refused, wherever the variable reaches the daemon (a clone's `.mcp.json`, a filled `assistant_id`, a variable set for the user). It confirms a home only when its launch folder also carries the pin for the same agent: the env var says which agent, but every child process inherits it in whatever folder it runs, so on its own it cannot say where the agent lives. An agent the environment names that has no credentials file of its own (a bgos-claim agent on an API key, which the resolver serves from the legacy file) passes the home check as it did before. Not verified here: whether hoai's supervised hand-off of `BGOS_ASSISTANT_ID` (the Windows logon task) reaches a marketplace daemon past the plugin's own env block; a supervised agent in its pinned folder resolves through the pin either way. Multi-agent hosts are unchanged; they already refuse elimination.

**A pinned agent wins the pairing lock from a stray.** The lock file records one more word, `route`: `pin`, `env` or `elimination`. No folder is stored. A pinned daemon (pin or env) takes the lock from a live holder whose route is `elimination` (`route-takeover`, logged with both pids), and the stray stands down on its next heartbeat. It never takes the lock from a holder pinned to the same agent (Data's guard: two pinned sessions never take it from each other), never from a 0.64.x record with no route (mixed versions behave as today), never while its own channel is proven not loaded (0.63.2's rule), and never from a holder whose channel is proven loaded unless its own is proven loaded too: an agent relaunched from an unpinned folder keeps its channel when a bare `claude` is opened in its pinned folder, while hoai's own start, which carries the channel on its command line, still takes it. A daemon that came by elimination never takes the lock from a pinned holder, not even by the 0.63.2 channel rule, so the two cannot flap: a test over every pair of routes and channel states shows the holder changes at most once.

**A refused stray is told, not dropped.** A session the home check refuses used to exit before the MCP handshake, which Claude Code shows only as a failed server. It now serves a one tool notice, `hoai_not_this_agent`, as an unpaired install already does: no channel capability, no server instructions (a refused session is usually the owner's own, so nothing goes into its prompt), a short description that names the agent it refused, and when called the reason with both folders, the fixes for the owner, and a line telling the model not to create or edit `.bgos-agent-id` unless the owner asks. It uses no token, takes no lock and writes nothing. `hoai doctor` prints the home and its source in the credentials row and notes when a session started in its folder would be refused, and its handshake check now fails a server that answers with a one tool notice instead of a channel, so it no longer reads a refused or unpaired daemon as healthy. `hoai` prints a WARNING naming the home and the pin when it launches the sole agent from a folder its daemon will refuse. The one start that newly refuses is a start from an unpinned folder other than the agent's recorded home once pairing has written one; its notice and the hoai line name both folders. The stand-down reports to the backend and their 0.65.1 sender are separate work. No version is published here; publishing is Kc's call.

## 0.64.3 (2026-10-10)

**A /goal whose condition carries a previous command joined to its front is refused, not armed (board row 102a3966).** Four missions have ever been created by the typed /goal path and three of them are titled `clear/goal <something>`: a driver or a paste sends `clear` and `/goal <condition>` with no newline between them, the TUI joins them into one line, and the condition the runtime reports carries the previous command. Creating a mission sets the open one aside, so on 2026-10-05 a mission at 11 of 12 went abandoned in the same second mission 74 was created from such a line. The daemon now refuses two shapes only, a leading `/` and `<word>/goal ` (letters with no space before the command name, which cannot occur in a sentence), so it creates nothing and sets no card aside, and the person sees an error naming what it saw. Refusing rather than stripping, because a stripped guess would still create a mission. A false positive control keeps five conditions someone could mean (for example `the q3/goal split is reported in one table`). Mutation proven both ways: removing the guard reds the refusal tests, widening it to any slash reds the control alone.

## 0.64.2 (2026-10-10)

**The daemon tells the server what its session is doing, on the heartbeat it already sends.** A `sessionStatus` block (facts only: whether a task is open, questions and messages waiting, the oldest waiting message, what is running, and when the SESSION last did anything) rides every heartbeat and its own small beat (`{ sessionStatus }`) within a minute of a change and every 2 minutes while work is owed, from the pairing lock holder only. The shape is the shared contract `lib/session-status-contract.ts`, a byte identical copy of the BGOS file, pinned by sha256 here, in BGOS and in codex-channel-bgos. The server judges it into a word and only logs it for two weeks; nothing in the app changes yet. **The not responding verdict goes out at once** (and its clearing), from the lock holder, instead of on the next 6 hourly beat. **The daemon's unprompted texts are marked** with `postedBy: 'connection'` (the deaf warning, the goal and plan notices), so the server's stall sweep stops reading them as the agent answering; its answers to the owner's own commands (/status, /login, /compact, "Asked to stop.") stay unmarked, because they answer a row the owner wrote. Release order: the backend first; an older backend ignores both fields only while its validation stays lenient. No version is chosen here; publishing is Kc's call.

## 0.64.1 (2026-10-10)

**A steer sent right after a Send now attachment is answered at once and obeyed, not refused, ignored or late (BGOS #2140).** Visual QA (three runs on a real session): the owner pressed Send now on an attachment row during a long command, a plain channel message the CLI holds until the command ends, then Steer on a text row. The daemon pressed Escape first and delivered the steer text 800 ms later, so the held attachment opened the next turn alone and the steer landed mid turn: once refused as "from an external channel", once ignored (the model re-ran the task the steer dropped), once answered 12.1 s late. Reproduced on 0.64.0 here: the model re-ran the 150 s command and then refused the steer as not from the owner. The order is now reversed. The gate decides whether it will press (the same plan, cooldown, busy and once per message rules) BEFORE anything is delivered, delivers the steer text first while the turn still runs, so the CLI queues it behind the held message, waits 500 ms (`STEER_QUEUE_MS`), then presses the one Escape. Both queued messages open the next turn together and in order. The `steer="true"` marker is set from that decision, and the decision is kept: from it to the Escape the press owns the composer, so the daemon's own /compact and /goal typing waits for it (`pressDone`) instead of racing it, and the pane is probed before a marked delivery (a pane that is gone gets the text plainly). A failed delivery presses nothing, so a retry delivers and presses once. An ordinary message that arrives during the half second is delivered before the Escape and joins the same next turn. Proven live on macOS (Claude Code 2.1.296) through this daemon on the final code: the attachment then steer repro passed three runs in a row, each steer answered and obeyed about 2 s after the daemon received it, and a single steer interrupted 0.6 s after receipt (docs/reports/2026-10-10-steer-deliver-first; four more passing runs on the code before review are kept there too). The app floor (`CLAUDE_STEER_SINCE` 0.64.0) and the cross repo hash are unchanged. Mutation proven.

## 0.64.0 (2026-10-09)

**Send now is a real steer: it interrupts the running turn and the text is answered at once (KC 2026-10-03, msg 98508).** A channel message sent during a turn waits for the next tool boundary, so a queued follow up sent behind a two minute command waited two minutes. Where the daemon has tmux control of the CLI pane (the supervisor path remote /compact already uses), it now advertises `steer` in its synced catalog, and a `/steer {text}` from the app presses ONE fixed Escape key in the pane, waits 800 ms, and delivers the text as an ordinary message (attachment lines and prefixes kept), marked `steer="true"` only when the Escape was really pressed. No chat text ever reaches tmux: the Escape is a fixed key name (`buildInterruptSteps`), the words go through the channel. The text is ALWAYS delivered: with no running turn (the hook rail says idle) nothing is pressed; a share recipient's steer, a backlog or replayed one older than two minutes, one arriving while a relayed permission prompt is open, and one sent from a chat other than the one whose turn the hooks say is running are delivered plainly with no key; a failed Escape still delivers. Steers run one at a time through one gate: never two Escapes within 3 s (Claude Code fires no Stop on an interrupt, so the hook rail still reads live), none while the daemon is typing /compact or /goal itself, never a second for the same message, and a message arriving behind a steer in flight is delivered after it. Without a tmux target the catalog carries no `steer`, so the app sends plainly and nothing calls itself a steer that only queues. `steer` is reserved like `/compact`: a user or project command of that name is not synced and cannot shadow it. The app floors Claude Code steer on this version (`CLAUDE_STEER_SINCE` 0.64.0) and both repos pin the hash of `steer;slash_command;/steer {text};0.64.0`. Proven live on macOS (Claude Code 2.1.295) with this daemon: a 150 s foreground command interrupted under a second after the steer reached the daemon and the steer answered through `reply` about a second after that; an idle steer answered with no key pressed; a backlog steer delivered with no key (docs/reports/2026-10-09-steer-interrupt). 31 new tests, each mutation proven.

## 0.63.2 (2026-10-09)

**A daemon whose channel is not loaded in its session no longer holds the pairing over a sibling whose channel is (assistant 873).** A session launched with `--dangerously-load-development-channels server:bgos` (a clone in .mcp.json) whose global settings also enable `hoai@hoai` starts two daemons for one pairing, and only the clone's channel is registered. Both raced for the pairing lock; when the plugin won, every inbound message went into a channel Claude Code drops, for five hours on kc-server. Each daemon now reads whether its own channel is loaded off the claude command line above it (`--channels` / `--dangerously-load-development-channels`, matched against `plugin:hoai@<marketplace>` for a marketplace install and `server:bgos` for a clone) and records `channelLoaded` in the lock file. A daemon whose channel is loaded takes the lock from a live holder that recorded `channelLoaded: false`, and the holder stands down on its next heartbeat; a daemon whose channel is not loaded never takes the lock from a live holder. Anything not proven (no claude above us, a claude command line that shows no arguments at all, Windows, an unidentified install, a clone whose session names some other `server:` channel, or a holder from an older version that records nothing) keeps the lock exactly as before. Proven on macOS (Claude Code 2.1.295) that the MCP initialize request is identical for a channel server and a plain one, so the command line is the only signal. The takeover and the yield each log one line naming the reason. Both daemons must run 0.63.2 for the takeover to happen. Mutation proven.

## 0.63.1 (2026-10-09)

**Keep working has no turn cap by default, and the no progress stop still holds without one (board row 20e7ac50).** KC approved 2026-09-28 that the 30 minute Keep working wake alone drives a mission, with no per reply goal check cap unless the owner chose one. `decideGoalStop` used to return early on a missing cap, which also switched off the no progress stop (three checks in a row with the same finding), the one protection against a goal looping forever. The two rules are now gated separately: the turn cap runs only when there is a number, and the stall stop runs whenever the owner's Keep working armed the goal, cap or not. A goal a person typed in their own terminal still has neither and is still left alone. The daemon declares a new token, `mission_goal_uncapped`, wherever it declares `mission_goal_loop`; the backend leaves a Keep working mission uncapped by default only for a daemon declaring it and fills the old 20 for every other one, so this release and the backend change can ship in either order. Mutation proven (six mutations).
## 0.63.0 (2026-10-09)

**The daemon tells HOAI when this computer's Claude login has expired or hit its limit (BGOS board e5d0fb3a).** A failed login is written into the session transcript as `error: "authentication_failed"`, and a usage cap as `error: "rate_limit"`. A 30 second sweep reads them, keeps the first failure time, and clears only on real activity or a completed /login. The state goes out on the heartbeat as `lastError` code `claude_login_expired` or `claude_usage_limit`, with a beat sent at once when it changes, plus a non-secret `claudeAccountKey` and the account label. The backend groups these by machine and tells the owner once per outage (BGOS #2107, off by default there). 14 mutations, all caught.

## 0.62.3 (2026-10-08)

**A tool card a group refuses is refused once, not on every tool call (bug 0cd3eca1).** The backend refuses an agent's tool card posted into a room or channel with 400 "Agent messages into a group must use /send-message", on purpose: a stamped agent row would stop the room's working line keepalive and trip the room loop guard. The hook rail did not know that refusal, so every tool call in a group posted again, got another 400 and logged another line. It is now read as permanent for that chat, the same narrow way as the other two (the 400 and the message whole, or a `group_route_required` code), and the rail stops posting cards there. Mutation proven.

## 0.62.2 (2026-10-08)

**The a2a route refusal is recognised by the code the backend actually ships.** BGOS #2038 sends the 400 "A2A messages must use /send-message" with `code: a2a_wrong_route`; this plugin had guessed `a2a_route_required`. Both are accepted now, and the message text match still answers for a backend that sends no code. Found by Ares's check of 0.62.1 against #2038.

**A permission approval card no longer posts into a chat that has refused this agent for good.** The card went to the first monitored chat unconditionally, so when that chat was a peer side-thread every approval request posted again, was refused again and failed closed again. It now goes to the first monitored chat that has not refused, a refused card is remembered, and when every monitored chat has refused the request is denied, as it is with no chat at all (`pickPermissionChat`). Both mutation proven.

## 0.62.1 (2026-10-07)

**A plugin clone on a prerelease version now reports it.** `readOwnVersion` accepted only strict X.Y.Z, so a clone on `0.62.1-local` reported `runningVersion null` and the watcher never restarted it onto a staged update (found by the mission 104 goal 4 proof). It now accepts the same shape the backend heartbeat and the watcher already accept (`X.Y.Z` plus an optional suffix, at most 32 characters). Self-update still compares strict X.Y.Z only, so nothing about published updates changes. Mutation proven.

**A write refused with "Caller assistant is not a participant of this peer conversation." is tried once, never looped (board row a80d3683).** Measured 2026-10-07: pairing 97 (assistant 947, 0.61.4) was refused 378 times in one hour on `POST /api/v1/messages` with that reason, and pairings 99, 106 and 137 at 111, 24 and 22. That route is the hook rail's. A turn in a peer side-thread posts its tool card there, the backend reads the caller assistant on that route only from an `X-Caller-Assistant-Id` header the daemon does not send, so every card into a side-thread with an open conversation is refused (sending the header would not help: that route refuses a side-thread write anyway, with a 400); a refused card minted no id, and the next 600 ms flush posted it again, up to 6000 times an hour.

The refusal is now read as permanent from the status and the WHOLE body: a 403 whose `message` is that reason, matched whole and anchored, or whose `code` is `peer_not_participant` once the backend sends one. Never from the error sentence, a substring, or a number in a URL (`lib/peer-refusal.ts`). The rail makes one attempt per chat, logs why once, and posts no more cards or markers there; every other chat is unaffected. A `reply` refused the same way returns a typed `peer_not_participant` result that tells the agent the conversation open there is not one it is in (its own has closed, or it never was), not to retry, and to tell its owner only if it matters. Later replies into that chat are answered locally until something new happens there (a new message, a close, or a `send_to_peer` that lands in it), and the inbound it was answering is dropped, so the reply-overdue sweep no longer asks for that reply again; a message that arrives while the refused reply is still in flight keeps its tracker and leaves the chat unblocked. Every other 403 and every 5xx behaves as before; a failed POST is now an `HttpError`, so its log line reads `HttpError: POST ...`, as a failed PUT already did. No version is chosen here; the release that carries it is Kc's call.

**A closed side-thread no longer loops on "A2A messages must use /send-message" (the review of #186).** Once a side-thread's conversation is closed the participant check passes, and `POST /api/v1/messages` refuses every card and marker with `400 {"message":"A2A messages must use /send-message","operation":"MESSAGE"}` instead: an a2a chat takes writes only through `/send-message`. Nothing classified that 400, so the rail posted the same card again on every 600 ms flush, 6006 posts in a simulated hour (6000 cards and 6 markers) against a mocked backend answering that exact body. The backend's denial log, which counted the 403s, logs no 400, so it never counted this loop (its only trace is the participation check's legacy a2a warning, one line per post). The same classifier (`lib/peer-refusal.ts`) now also reads it as permanent: status 400 with that `message` whole and anchored, or a `code` of `a2a_route_required` once the backend sends one, and neither reason counts on the other's status. The rail makes one attempt per chat, as it does for the 403, and logs the right status once. `show_component`, `ask_user_input` and `propose_plan`, the tools that post there, return a typed `a2a_route_required` result: the chat is a peer side-thread, do not retry, anything for the owner belongs in the owner's chat, and a reply there reaches the peer agent and reopens a closed conversation, so send one only if the peer needs to hear it. Later calls into that chat are answered locally, and the rail and the tools share what either learned first, so neither posts there again (`propose_plan` already refused a side-thread it knew about; this covers one it did not, as after a restart). A chat's kind never changes, so nothing lifts that. `reply` keeps its typed answer for the participant 403 only. Every other 400, 403 and 5xx behaves as before.

**The owner marker is set on every lane, from the server's record only (board rows 8e8748ef and a80d3683, BGOS #2026).** The served canon now tells an agent an event is its owner only when the outer channel tag says `sender_relationship="owner"`, and that a missing value settles nothing. Only the live websocket lane set it. The stream lane dropped the `senderRelationship` and `senderDisplayName` the backend hydrates onto every human authored row, the meeting cards dropped the twin's sender block, and every `button_clicked` event stamped this daemon's own configured id as `user_id`, so a tap read as the owner's whoever made it.

One reader (`readServerSenderMeta`, `lib/inbound-channel.ts`) now builds `sender_relationship`, `sender_display_name`, `is_shared_recipient` and `share_owner_user_id` for the websocket, poll and stream lanes and for every meeting card, from the record that lane received (the socket payload's sender block, the stream's flat fields, either spelling), never from the message text, and with the server's strings unchanged, as the websocket lane always emitted them. Nothing is defaulted: a value the server did not send, sent in a shape that cannot be trusted, or sent twice with two answers is left off. That changes one websocket attribute: `is_shared_recipient` used to read `"false"` when the server omitted it (a persistent group omits it by design) and is now absent. A lane's extra meta can no longer set a sender key. A tap's `user_id` is now the tapper the backend stamps on the answer (`answeredByUserId`, from the authenticated caller), on the poll, stream and plan boot sweep lanes alike, and is absent when the answer names nobody; no tap carries a relationship, because the answer does not. The poll lane reads `GET /chats/:id/messages`, whose rows carry no relationship today, so poll deliveries still carry none until the backend adds it to that projection, and the same holds for the `meeting_message` broadcast. Every lane has an owner, peer, system and room test, a forged body test and a missing field test, with a recorded mutation proof. No version is chosen here; the release that carries it is Kc's call.

## 0.62.0 (2026-10-07)

**Keep agents running: one switch per computer keeps every agent alive and up to date (mission 104).** Design: BGOS `docs/superpowers/specs/2026-10-06-keep-agents-alive-design.md`. With the switch on in the app (Integrations, the computer's card), the backend marks every Claude Code agent on that computer always-on FIRST, the per-machine watcher is installed, and the watcher's keep-alive sweep gives every agent on disk, including agents created later, its own supervisor. A crash or a reboot brings the agent back on its own conversation, and a staged plugin update is applied only at a safe moment.

**The supervisor, generation 2 (`hoai-agent install --always-on`).** launchd, systemd `--user` (linger) or a Windows logon task runs `run.sh`, which starts the hoai launcher inside a detached tmux session on the agent's own socket (`tmux -L hoai-<id>`), so the agent RESUMES its pinned session (`claude --resume <pin>`) instead of starting a fresh one, and remote compact stays ON. The plugin root is resolved at every launch, so a restart lands on the installed version. `hoai-agent attach --assistant <id>` watches the session. New: `hoai --keep-alive` (the Windows task), `HOAI_SUPERVISED` named exits 6 to 11, an install lock, a Linux restart of an active unit on reinstall, `CLAUDE_CONFIG_DIR` and `HOAI_SERVICE_NAMESPACE` carried into the service, `installed-at` stamped for every install, and every launchd or systemd stop removes `supervisor.json`. One that an unclean stop leaves behind (a power cut, a Windows logoff) counts only while its pid is still the launcher that wrote it: started no later than the file's stamp and running `hoai-core.mjs` as its script (its node may sit in a path with a space, such as Laravel Herd's under `Application Support`), so a pid reused after a reboot, another agent's hoai or tmux server included, cannot keep an agent down. On Linux, where `ps` measures a process's age on the boot clock, supervisor.json and keepalive.json also record the boot clock they were stamped on and the start is compared on that clock, so a wall clock stepped after the stamp (a Raspberry Pi with no RTC, a VM resynced after host sleep) never turns a live launcher, daemon or keepalive script into a reused pid, and a file from an earlier boot never names a live one. The record the daemon writes for a declared launcher (`BGOS_SUPERVISOR_KIND=launcher`) names the daemon itself and is proven by its start time alone.

**The watcher sweep and the safe moment.** Every minute, with the switch on: install a supervisor for an agent that has none (a hand-run hoai launcher counts as none: it does not survive a reboot), upgrade a generation 1 supervisor, and restart an agent onto a staged update only when no turn is in flight, no reply or permission is pending, no Claude Code background job (Bash or Monitor tool process) runs under its claude, and it has been quiet for 10 minutes (30 for an older daemon). It never kills: an agent that stays busy is waited for, and after 24 h of waiting for an update the app shows the reason with Restart now (the watcher's report says `pending: update`); a hand-run plain claude, or on Windows an agent's claude still running after its task's launcher died, is waited for until that session ends and is offered no Restart now (a plain restart cannot end that wait, so its report names no `pending`). One restart and one install per sweep, 3 attempts per version.

**The watcher reports its own health.** A crash-safe entry records every start and any failure before the loop, sends a minimal heartbeat with `watcherHealth {status: crash_loop, lastFatal}`, and backs off (30 s doubling to 10 min) instead of restarting every 5 s; the app shows a red row with a Reinstall action. Reinstalling a running watcher now retries the launchd bootstrap that loses the race with an async bootout, and the watcher's service PATH carries the directories where its tools were found.

**The daemon.** `~/.bgos-plugin-state/<id>/agent-state.json` publishes the turn state, pending work, running and pending versions and the live session for the watcher; the live session id is pinned so a takeover resumes it; the always-on reconcile never adds a second supervisor beside a bespoke one (G11) and installs with the agent's real folder; marketplace installs now report `pendingRestartVersion`; the hook session binder honours the launch folder and `CLAUDE_CONFIG_DIR`.

Every behaviour has a focused test with a recorded mutation proof; an end to end run on a Mac under launchd (isolated from the live fleet) proved switch on, crash and return on the same session, and an update applied only after a background job ended.

## 0.61.4 (2026-10-06)

The remote pane can navigate, use history and reload, and create, select or close tabs in the agent's actual browser. Owner actions retain exclusive control until the physical operation settles. Navigation acknowledges dispatch promptly so Stop remains available during delayed headers or documents. Physical links and same-document history publish loading completion. Tab actions verify the displayed target identity, roster changes refresh even when the selected page stays unchanged, and pending capture survives a target replacement. The browser keeps at most 16 tabs whether the agent or owner creates them.

Login detection no longer rejects a visible top-page sign-in because it contains an unrelated iframe, an alternative OTP link or signup footer text. Password-only steps and JavaScript login pages are supported with exact document, field and origin checks. Native encrypted entry for the clicked username, password or OTP field works with storage locked. The owner can explicitly save a new login for the current origin without requiring a recognized HTML form. Credential values remain sealed over HOAI and saved entries remain encrypted on the agent machine. Raw protected-field keystrokes, hidden or changed targets, foreign form destinations, payment fields and opaque iframe fields remain refused.

Real Chromium regressions, printed executable mutation proofs and the touched host suites cover these changes. New viewers explicitly negotiate browser controls; older viewers keep their existing single-target stream and empty input-revocation events. Negotiated revocations distinguish navigation and target changes from expiry and release. Version metadata advances together for review; no release tag, marketplace pin, publish or deployment is performed here.

## 0.61.1 (2026-10-05)

**A daemon holding a staged update no longer goes blind to later releases.** Both `checkNow` and `updateNow` correctly decline to install while an update is already on disk awaiting a restart, but both writers of the version this daemon reports as latest sat after that early return. So staging an update froze `latestKnownVersion` at that moment, for as long as the restart never happened. Measured in production forty minutes after 0.61.0 was published: of 59 live daemons, twenty were staged on a version that had itself been superseded, each reporting that stale target AS the latest it knew, and nothing could tell them from a daemon that was genuinely current. The periodic check now LOOKS before it defers, and says what it saw. The triggered one-click deliberately does not, because a user can tap it repeatedly and its no-new-fetch property is pinned by a test. This does not unstick a staged daemon, which still needs its restart; it makes the stuck state visible, which is what anyone fixing it needs.

## 0.61.0 (2026-10-05)

**One release carrying every plugin change since 0.60.2, batched on purpose (KC, 2026-10-05: "batch all the updates into one major update with a version change and then you publish instead of publishing every update on its own").** The five branches below each proposed their own number; they ship as this one.

**`/login` works from the chat, and the daemon answers it.** An agent whose Anthropic session expires can be signed back in without anyone opening its terminal. Send `/login` and the agent offers Claude subscription or Anthropic Console; the tap returns the sign-in link; the code pasted back as the next message completes it. It is answered by the DAEMON and never by the model, which is the whole point: a logged out session cannot think, so a model-handled `/login` would be dead exactly when it is needed. Owner only, refused before anything spawns. The code is never logged, echoed or replied, child output is redacted at ingestion, a message that is not a code is not swallowed, one sign-in at a time, ten minute window, and no sign-in starts from a room or a meeting where the link would be posted to every member. It covers a session that expires while running, not a cold start that was already signed out: under the supervisor that case exits at the startup gate before any daemon exists.


**Always ask now covers installing a plugin or tool (floor rules version 2).** With the owner's "Always ask before
risky actions" switch on, the floor hook now holds `claude plugin install` (and `i`), `claude mcp add` (`add-json`,
`add-from-claude-desktop`), `codex plugin add` and `codex mcp add` for the owner, even with full access: a plugin or
tool the agent installs outlives the chat that added it. Listing, updating, removing and adding a marketplace do not
ask, and neither does a skill file the agent writes itself (the Teach flow already asks first). The matcher, the words
("installing a new plugin or tool that stays after this chat") and the byte identical fixture match BGOS
`backend/src/services/hard-floor.ts` rules version 2. On a pairing with the hook, the daemon also declares
`hard_floor_rules_2`, which the app reads before it tells the owner the hook stops a plugin install. Lands together with
the BGOS change; no version is chosen here, the release that carries it is Kc's call.

The daemon provisions its browser on first use: an installed Chrome or Chromium is preferred, otherwise the pinned Playwright Chromium revision is downloaded into the user cache. The normal browser-host supervisor owns startup. The browser keeps its sandbox, and missing operating-system prerequisites return an installation error.

Owner login entry uses a dedicated encrypted relay capability and trusted HOAI dialogs. Exact document, form and field checks guard filling, and filling never submits automatically. Saving a new password requires a separate confirmation. After saving or declining to save, the owner can review the page, take control and click the validated Sign in button within 30 seconds. This grants one explicit down/up on the captured form and button, revoked by navigation, a new form, input release or expiry. Ordinary remote keyboard input still refuses credential fields. Each agent and acting person have separate passphrase-encrypted login storage. Browsing starts locked and nonpersistent; unlocking enables encrypted cookie, localStorage and IndexedDB snapshots until close. No passphrase or encryption key is saved. Legacy native profiles require explicit owner confirmation before supported artifacts are cleared.

The package includes the HOAI browser skill and the bootstrap, vault, credential and shared crypto modules. Targeted unit, mutation, real Chromium and packaged supervisor evidence is recorded under `docs/reports/2026-10-04-remote-credentials`. Version and manifest move together. No tag, marketplace pin, publication or deployment is performed here.

The owner can explicitly control a daemon browser through the HOAI server. Exclusive leases fence agent tools and retain the reservation until pressed-key/button cleanup settles. Single-use focus tokens and host DOM checks refuse detected credential fields until KC decides otherwise. Allowed ordinary text crosses the server and agent machine; field detection cannot prove it contains no secrets.

The native pane typing proof, credential refusal, targeted50-test host run and TypeScript check passed. B depends on the independent A release. Package and manifest versions advance together. No tag, marketplace pin, publish or deployment is performed here.
**Windows is a tested host now: the suite runs on Windows in CI, and three bugs Windows users had are fixed.** Until
now the suite had only run on Linux and macOS. Run on Windows it went 31 red on a clone made with
`core.autocrlf=false`, and 44 on a default clone, which is what a Windows install really is. Every red was triaged.

- **A Full handoff from an agent on Windows no longer fails on its own files.** The export pack's symlink gate checked
  containment with a hardcoded `/` against the OS realpath, which on Windows uses backslashes, so every file "escaped"
  the workspace: the export failed PATH_ESCAPE and the dry run offered the owner nothing. It now decides by the host's
  own path rules (case blind on Windows, another drive is outside, a drive root works), and on posix a backslash stays
  a file name byte, so `/ws\evil` is still outside `/ws`.
- **`bgos-claim` locks the `.mcp.json` that holds the API key to your Windows user**, with icacls, as `bgos-pair`
  already does for its credentials. On Windows chmod does nothing, so with an agents folder outside your profile the
  key was readable by every local user while the installer said "chmod 600". It now reports the protection the file
  really got, and says UNPROTECTED if the lock fails. It also gets that far on Windows now: its check for git asked
  `/bin/sh`, which Windows does not have, so every claim there stopped at "git is required" with git installed.
- **On Windows the daemon's stop closes Chrome cleanly.** It used to stop its browser host with `kill('SIGTERM')`,
  which on Windows is TerminateProcess: Chrome was cut off on every daemon stop, restart and lock handover, and
  logins from its last few seconds could be lost. The daemon now holds the host's stdin and closing it is the stop,
  on every OS (off Windows it still sends SIGTERM as well). On Windows the host is started detached, so the daemon's
  exit cannot kill it mid close, with a late backstop kill while the daemon lives. On every OS a stop is now bounded:
  after 15 s the host kills the Chromes it started, launching ones included, and exits, where a hung close used to
  keep it running forever.
- **Every checkout is LF.** A Windows install is a git clone made with the user's `core.autocrlf=true`, so 349 files
  reached Windows users as CRLF while CI tested LF. `.gitattributes` now pins every text file LF (batch files CRLF),
  and `test/line-endings.test.ts` keeps it that way.
- **The daemon builds an agent's supervisor paths with the watcher's join.** `lib/update-readiness.ts` built the
  service file, `supervisor.json` and marker paths with the host's `path.join`, so on Windows a home written with
  `/` came back with `\`, while the watcher keeps the separator of the home it is given (`joinDir`). Handed the same
  home, the two named different files for one agent, which the new Windows leg showed as the one red parity test.
  The daemon now uses that same `joinDir`, and so does `bin/hoai-keepalive-marker.mjs`, which writes the
  `keepalive.json` the daemon reads. No real install moves: for a real home (`C:\Users\...` or `/Users/...`)
  every path is byte for byte what it was.
- The rest were tests that assumed POSIX paths, file modes, a bash on PATH (on Windows that is the WSL launcher),
  `pgrep`, or a 400 ms cold start, now written to hold on both hosts without being weakened. A new
  `test (windows)` job runs the suite and the type check on `windows-latest`; the README says what a Windows machine
  needs to run it (Git for Windows) and what skips there by design.


Daemon browser pages can stream into the HOAI owner pane through the authenticated server relay. The host attaches Page.startScreencast to its existing browser and retains the latest update while a prior frame is outstanding. Closing the view leaves the agent page running. This is the independent A release; it sends no owner input.

Targeted browser-host/view tests and real Chromium streaming passed. Package and manifest versions advance together for the repository gate. No tag, marketplace pin, publish or deployment is performed here.
## 0.60.2 (2026-10-04)

**Re-vendored the HOAI browser shim from BGOS main, sha256 `b9a7c24b`** (was `24470ac3`, vendored
2026-09-28). `bin/hoai-browser-mcp.mjs` is a byte-identical copy and the pin in
`bin/hoai-browser-mcp.vendor.json` names the new hash, so the guard states the identity in the tree.

Two things ride this copy. The status line that `hoai_browser_status` appends now reads
`Reached on <host>.` It read "Reached through your owner's account on <host>", which was already loose
(an account is not an app) and became wrong outright when BGOS shipped the acting-principal election:
the backend elects a desktop belonging to the ACTING human, so for a shared agent the page does not run
on the owner's machine at all and the old sentence could name the wrong person. And the copy had been
three days behind, missing MCP request cancellation entirely.

Verified on this tree rather than asserted: the vendor guard's cross-tree case PASSED rather than
skipped (`HOAI_BROWSER_SHIM_SOURCE` armed at BGOS main's shim, 5 of 5), the ported relay and shim
suites are 34 of 34, `npm test` is 3,346 tests with 0 failures, and `npm run build` is clean.

**The version moves because this repo's `version advances against base` check requires it on every
PR, and that is not the same as a release.** Publishing is a separate act: the tag, the marketplace
ref and the app's own plugin version floor, none of which move here. So a machine installing through
the pin is unaffected.

What IS delivery, and it is easy to miss: a host that TRACKS this repo picks the new shim up at its
next session restart, so merging reaches those machines even with nothing released.

## 0.60.1 (2026-10-02)

**The deny that stops an agent wedging on a terminal question now reaches agents that were already installed.** Claude
Code's own `AskUserQuestion` tool halts a session at a prompt nobody is watching, waiting for a keypress that never
comes, while the daemon still reports online. Both bootstraps have denied it since 0.56.0, and a bootstrap runs once, at
first install, so every agent installed before that never received it and nothing revisited them. Measured on a nine
agent machine on 2026-10-02: one carried it.

`ensureDeniedTools` writes the deny into one agent folder's `settings.local.json`, and `bgos-agent` calls it on install
and on restart, so a restart is enough. It is not folded into `ensureHookEntries`, which writes the same file, because
the restart path calls that function only for a workspace that already names `hoai-hook.mjs`: a permission cannot
duplicate anything, so it must not inherit a gate that exists to stop a second hook entry firing. Folding it in would
have skipped exactly the agents it is for. A workdir with no `.claude` directory is left alone rather than having
configuration invented for it, and a settings file that does not parse is returned untouched.

## 0.60.0 (2026-09-28)

**One release for four changes: the owner's Changes panel, a truthful browser shim, the browser rule file the desktop
uses, and a nightly update that no longer leaves the second daemon on old code.** Published once, as one version, so
the fleet takes all four on the same restart.

**A daemon that waited for another daemon's nightly update now restarts onto it the same way the one that installed it
does.** When several daemons share one checkout, one of them takes the update lock and installs the update, and the
others wait for it. Since 0.54.0 the installer asks the restart ladder to restart its session (the same ladder a click
on Update uses, which acts only on an authority that proves it owns the process and otherwise leaves the update staged).
The daemons that waited did not: they kept running the old code they had already replaced until someone restarted them
by hand, and an older version of that path exited outright with nothing to bring it back (two agents dark for about
four hours, twice). Now the waiting daemon takes exactly the installer's decision: it exits only where the operator set
`BGOS_EXIT_AFTER_UPDATE`; otherwise it asks the restart ladder when one is wired in; otherwise, or when the ladder
stages, it keeps serving, takes messages again, and logs that the update waits for the next restart. An update started
from the app is unchanged: the app's own restart step still decides for it.

**The browser tools say what really happened when a call is refused or a connection drops.** The HOAI browser shim
(`bin/hoai-browser-mcp.mjs`) is re vendored from HOAI's source, sha256 `24470ac3` (it was `aaaff4b6`). A rate limit, a
general request limit, a host whose connection dropped mid call, a refusal met while the shim was still connecting,
a result that could not be collected for a call already sent, and a status check the backend refused each get words
that are true for that case. Before, most of them told the agent that the owner's desktop app "is not running or not
signed in", or invited a blind retry of a call that may already have clicked, bought or sent something. The relay
tests carried over from HOAI now cover each of these (32 cases here, 20 of which fail against the old copy).

**The daemon's browser rules are the desktop's rules again.** `lib/browser-host-core/policy.js` is re vendored from
the desktop Agent Browser (sha256 `7541a0c3`), so a browser run on the agent's own machine keeps the same truthful
step trail the desktop keeps (BGOS #1634).

**The owner's Changes panel can read this agent's uncommitted changes.**
The HOAI Changes panel (HOAI P7 stage 3, C-31) shows the files a coding agent has changed and not committed yet. This
daemon answers a new `changes_rpc` lane (op `diff`, scope `uncommitted`) with read only Git in the agent's launch
folder (lib/changes-rpc.ts over lib/git-changes.ts).

**What the read defends against, and what it does not.** It defends the owner against untrusted repository content,
what a clone carries (a `git` binary planted in the folder, attributes, the files themselves), and against Git writing
the repository (the index refresh, its locks). It does not defend against the agent itself: the agent runs as the same
user with the same reach on the same machine and can already run any program and read any file there, and the answer
goes only to the owner who owns that machine. A setting only the agent's own local config or its `.git` file can make
(`core.worktree`, a gitfile or `GIT_DIR` pointing elsewhere, a clean filter, a promisor remote's programs) can mislead
its own panel; the checks below that exist for those (the top folder rule, `GIT_NO_LAZY_FETCH`, the Git floor) are
defence in depth, and each line says what it covers. The git dir and the common dir are not contained, on purpose: an
agent that runs in a Git worktree keeps its common dir outside its folder.

- **Read only, and it stays off the index.** The whole list is the one `git version` read per Git path (the floor,
  below), then `rev-parse`, `symbolic-ref`, `diff --numstat`, `diff` and `ls-files`, all run with
  `GIT_OPTIONAL_LOCKS=0`. Both diffs also run with `diff.autoRefreshIndex` off: measured on Git 2.55, a file touched
  but unchanged makes `git diff HEAD` rewrite `.git/index` even with the optional locks off, which would race the
  agent's own `git add` for the index lock. None of these writes the index, the working tree or a ref; a lazy fetch, on
  a Git that does not know `GIT_NO_LAZY_FETCH`, would still add objects (below).
- **No fsmonitor hook runs, on Git 2.36 or later.** Every Git command turns `core.fsmonitor` off on its command line.
  The repository's own config can point that setting at a program, and measured on Git 2.55 both diffs and `ls-files`
  ran it, so each panel read would have run that program, which the agent picked, as the owner. That setting lives in
  the repository's local config, which no clone carries, so this is defence in depth. From Git 2.36 the flag reads as
  off; before it, the same `core.fsmonitor=false` is read as the path of a program to run, so the daemon reads
  `git version` for the Git it finds before any other command, and an older Git, or a version it cannot read, is
  refused with "changes could not be read on the agent host: Git 2.36 or later is needed to read changes safely", the
  sentence the Codex daemon sends for it too, and nothing else runs. Only an accepted Git is remembered: a refused one
  is asked again at the next read, so an owner who updates Git needs no daemon restart. The floor stays 2.36: 2.45
  would refuse Ubuntu 24.04's Git 2.43, which honours `GIT_NO_LAZY_FETCH`.
- **No lazy fetch from a partial clone, on a Git that knows `GIT_NO_LAZY_FETCH`.** Every Git command runs with
  `GIT_NO_LAZY_FETCH=1`, so on such a Git a read that needs an object a partial clone left out fails instead of asking
  the promisor remote for it, a fetch that runs the programs the repository's config names and can wait on the network
  (measured on Git 2.55: the numstat ran the upload-pack program a clone's config named). The variable, not the
  `--no-lazy-fetch` flag an older Git rejects. Git's release notes first name it in 2.45.0, and Ubuntu 24.04's build of
  Git 2.43.0 honours it too (measured); a Git from 2.36 that does not know it passes the floor and can still fetch
  lazily in a partial clone, a documented gap. A promisor remote is the clone's local config, so this too is defence in
  depth.
- **A clean filter still runs, on every Git.** A clean filter the repository's own config and attributes name still
  runs on the two diffs; no flag here stops it (and on a Git that does not know `GIT_NO_LAZY_FETCH`, a lazy fetch's
  programs can run too, above). This is an accepted limit: it needs the repository's local config, which no clone
  carries, and this daemon runs as the same user with the same reach as the agent. Unlike the fsmonitor there is no
  one switch for it (filter names are free), and reading attributes from an empty tree (`--attr-source` from Git 2.41,
  `attr.tree` from Git 2.43) would raise the floor and still not cover `.git/info/attributes`.
- **Git's own `a/` and `b/` prefixes**, asked for on the patch, so a host whose Git config sets
  `diff.mnemonicPrefix`, `diff.noprefix`, `diff.srcPrefix` or `diff.dstPrefix` still reads right.
- **A moved submodule is one section of its own.** The patch asks for Git's short submodule format too, so a host
  whose Git config sets `diff.submodule` to `log` or `diff` still writes a moved submodule as one `diff --git` section
  with its old and new commit, never lines the backend would hang on the file before it (measured on Git 2.55).
- **The launch folder, never the process folder.** The first command finds the repository root from the agent's
  folder and every later one runs in that root, so tracked and untracked paths agree from a subfolder too. Variables
  that would point Git at another repository (`GIT_DIR` and its neighbours) are dropped for the call, in any spelling on
  Windows, whose names are case blind (measured: a `Git_Dir` there made Git read the other repository). A launch folder
  that is gone is a failed read, never "Git is not installed" (Node names both the same way). The repository's top
  folder must be the launch folder or a folder above it, as the host resolves both: a `core.worktree` in the
  repository's config that names any other folder is refused and nothing there is read (measured on Git 2.55: without
  the check, the read went on in that folder's own repository and sent a new file from it whole). The refusal reads
  "changes could not be read on the agent host", the sentence the Codex daemon sends for it too. `core.worktree` is
  local config, so this is defence in depth, and it covers the top folder only: the git dir and the common dir are not
  checked, so a gitfile pointing elsewhere still reads that repository against this folder.
- **Git by its absolute path, never a git in the agent's folder.** Windows looks for a bare `git` in the working
  folder before PATH, so a `git.exe` there, which a cloned repository can carry as an ordinary file, would have run as
  the owner each time the panel opened (measured on node 24.16 and bun 1.3.9). Git is looked up on PATH's absolute
  entries only and run by that path; an empty, `.` or other relative entry is never looked at, and no Git on PATH still
  reads as "Git is not installed".
- **New files count.** The first 20 untracked files are read: text up to 64 KB is sent whole, a file with a NUL in
  its first 8,000 bytes is binary, a larger one is its size only, a symlink is never followed. Each is opened once and
  checked through that handle before any byte is read: it is read, at most 64 KB and one byte, only while it is still
  the regular file first checked and within the cap, so a file that grows is never loaded whole and a name swapped for
  a link or a device is not read at all.
- **Raw and capped, never processed here.** Each stream is cut at the byte cap the frame carries (never above the
  backend's own numbers) and Git is killed at the cap, and the read answers then, never waiting on a process Git for
  Windows' launcher leaves holding the pipes, so a huge diff costs a flag, not a failed read. Past the
  frame's budget (10 s) the read stops and answers too slow. The backend, not this daemon, splits the patch, counts,
  masks secrets and caps what reaches the app. The folder is sent as its last name only.
- **Only this agent answers.** A frame for another agent gets no answer at all, a re sent frame is answered again and
  never runs Git twice, only the pairing lock holder answers, a draining daemon takes none, and nothing is read before
  the agent's home folder is confirmed. The log carries sizes, never a path or a line. An answer is held for a re send
  only through the backend's own 20 s wait, and at most the newest four, so old diffs never pile up in a daemon that
  runs for days.
- **Declares `changes_rpc` on every host.** The backend sends a changes frame to a Claude Code pairing only while it is
  declared and only while the owner has turned the panel on for this agent; this daemon never reads that switch.

## 0.59.0

**A Stop is asked for honestly and never closes the mission, and the owner can find this agent's sessions in the app.**
P6 stage 3 (HOAI's Resume button and Sessions sheet). The tokens, op names, words and limits below come from
`lib/session-controls-contract.ts`, BGOS's session controls contract copied byte for byte and pinned by sha256,
the same digest BGOS and codex-channel-bgos pin.

- **Claude Code's own AskUserQuestion is denied for the agent, in the agent's own folder** (board row 01a07b28, skipped by six releases). Both `bin/hoai-bootstrap.sh` and `bin/hoai-bootstrap.ps1` now write `permissions.deny: ["AskUserQuestion"]` into the workspace's `.claude/settings.local.json`, the file the bootstrap already manages there for the activity hooks, added to an existing deny list once and never doubled, every other key kept, and a file that does not parse left as it is. It is never written to the settings.json in the Claude config folder: with `CLAUDE_CONFIG_DIR` unset that is the owner's own `~/.claude/settings.json`, which every Claude Code session they run reads, so a deny there would switch AskUserQuestion off in all their personal sessions (found in review before release). The owner's file still gets only the bypass prompt acceptance it got before. The agent asks its owner through the HOAI app (`ask_user_input`); the built in tool stopped the session at a terminal nobody watches. Proven by `test/bootstrap-askuserquestion-deny.test.ts`, which runs the real pre-seed of each script against a temporary HOME and agent folder and fails if `$HOME/.claude/settings.json` gains the deny.
- **"Asked to stop."** The line posted after a Stop replaces "Run stopped at your request.". It is posted the
  moment the notice reaches the session, before the model has stood down, so it claims the asking and nothing more.
- **The stop notice keeps the mission open.** The `[stop_turn]` notice now tells the model to leave the chat's
  open mission open and not to call `complete_mission` for it because of the stop. A Stop is neither a finish nor
  a failure.
- **A Stop pauses the mission an armed goal loops on.** Where this daemon can type into its session and Keep
  working is armed on the stopped chat's open mission, the Stop pauses that mission with the reason "Stopped by
  you", so the goal's own Stop hook cannot re prompt the model, and the owner's next message in that chat resumes
  it. An owner's own Pause is never resumed by a message. After a daemon restart the owner's first message in a
  chat asks the server, and a read that fails is asked again on the next message, so a Stop pause from before the
  restart is never left behind. Declares `stop_pauses_mission` beside `mission_pause`.
- **The Sessions library, list only.** New `list_sessions` op: the sessions in this agent's own folder, newest
  first, with a title, last activity, a preview, the branch and the Current session, searchable. The 200 newest
  transcripts at most, their first and last 64 KB only, cached while unchanged. Titles and previews that hold a
  secret are withheld whole before they leave the machine. `resume_session` and `rename_session` answer
  `unsupported`: switching the session a running agent is pinned to needs a supervisor change that reaches an
  agent only when its owner runs `hoai` again, so it is a later update. Declares `sessions_library` on every host.
  The bundled MCP instructions, what the model reads when the served canon cannot be fetched, carry the served
  Sessions sentence word for word, and say resuming from the app is not available yet.

## 0.58.0 (2026-09-26)

- **The agent is told what a run id and a stop message mean.** A card handed
  to an agent now carries a run id, and one message may hand it several
  cards, each with its own. This daemon declares `boards_runs` on every host,
  on its heartbeat and on the capabilities fetch, and the backend serves the
  canon's run id sentence only to a connection that declares it: a run id
  the agent has already seen is the same work sent again, so it does it once,
  and a message that starts "Stop working on" names a card the owner took
  back or closed. It needs no tool and adds no argument; the id rides the
  hand over message. The bundled fallback and the MCP instructions say
  nothing about runs, so an agent reads it only from the served canon.
- **The column instruction text says what stays true.** `starts_when` still
  takes only `person_moves_in`, and its description and its refusal now say
  it is the only start an agent can suggest, while starting work when a card
  is created in a column is a setting the owner turns on in the app.
- The version is the first minor above every number an open or shipped
  release held on 2026-09-26 (main 0.54.0, #161 0.55.0, and this branch's
  two parents, #149 at 0.56.0 and #159 at 0.57.0, renumbered level with main
  that day); the release that ships it confirms the number.

## 0.57.0 (2026-09-26)

- **An agent can suggest what a column asks of the agent a card is handed
  to.** A column line gains an instruction part: `set_column_lines` takes a
  `does` per line, with `kind` (start work, or only tell), the `instruction`
  itself, `starts_when` (only `person_moves_in`, a person moving a card
  there, is honoured today; an agent moving a card never starts anything),
  `who` gets the card (one agent by `assistant_id`, the agent a card field
  names, or ask the owner at each drop), one `only_when` condition, the
  `needs` that must be filled before a hand over, `ask_for_note`, the
  `fills` the agent is expected to write, the columns finished work
  `lands_in`, and `plan_first`. The tool sends the server's camel case,
  rebuilt key by key from a closed schema.
  - **It is a suggestion until the owner approves the exact words.** The
    server files an agent's instruction as a suggestion the owner reads and
    approves in the app, and nothing starts until then. The echo lists those
    columns in `suggested`, and the tool answers with one sentence naming
    them: saved as a suggestion, nothing starts until the owner approves
    those exact words, do not send it again. Words the owner already turned
    down come back in `declined`, answered with their own sentence: do not
    send it again unless the owner asks for a different one. The filed
    sentence of 0.50.0 is unchanged, and "Everything else in this call was
    saved." now closes the answer once, when something else in the call was.
  - **The approval is the owner's alone.** The tool never sends `approved`,
    `textHash` or `v`, and refuses them by name, with the owner's `paused`
    switch, as keys an instruction does not take.
  - **The shape is checked here, the rules are the server's.** A misspelt
    key, a wrong type, a value outside an enum, a `who` whose parts do not fit
    its `by`, or an `only_when` with both or neither of `in` and `empty` is
    answered before anything leaves the machine. Every length (1200
    characters of instruction, 20 items a list) and every reference (a field
    of the table, an option of the select, an agent of the owner's fleet) is
    the server's, and its sentence reaches the model word for word.
  - **The instruction sentence reaches only an agent that can write one.**
    This daemon declares `boards_playbook_does` on every host, beside
    `boards_playbook`, on its heartbeat and on the capabilities fetch. The
    backend serves the canon's instruction sentence only to a connection that
    declares it, and the phase 1 column lines sentence is unchanged.
  - **The `lines` text says what changed.** Its last sentence now reads: a
    line's sentence and facts only describe the board; its does part is a
    suggestion until the owner approves it. Everything else a line describes
    is still description only, and every other op, argument and answer of
    the board tools is exactly as it was.
  - **Release order.** Against a server from before instructions, a `does`
    is filed with the line's other structural changes and answered `filed`
    (reported as not applied), or dropped by an older whitelist and reported
    as nothing written. Update the server first.

## 0.56.1 (2026-09-28)

Desktop one-click could not start a background agent on a fresh workspace, and
once it could, the agent removed itself.

- **`hoai-agent install --always-on` now installs a PROVEN paired folder that has
  no `.mcp.json`**, which is what desktop one-click leaves: it installs the
  marketplace plugin and pairs with a one time code, so it never holds a key to
  write a `.mcp.json` with. The launch step died there ("no .mcp.json ... and no
  creds given", measured with the desktop's exact line). The gate is not
  skipped, because an agent once came back deaf on the wrong channel spec
  (2026-08-21). The install goes ahead only when `bgos-doctor
  --prove-paired-topology` proves it, by readers the repo already had: pairing's
  own live-safe verifier (the folder pin names this agent, its per-agent
  credentials are there and hold that agent's id) and the launcher's channel
  resolver (a marketplace install, enabled, its files on disk). Both are asked
  about the environment the BACKGROUND session will have, which carries no
  `CLAUDE_CONFIG_DIR`. `bin/bgos-agent` still never types the marketplace spec:
  it takes the one the resolver proved.
- **Anything unproven is refused by name**, exit 1, with nothing written and the
  service manager never called: `paired-topology:no-folder-pin`, `:pin-mismatch`,
  `:no-agent-credentials`, `:credentials-belong-to-another-agent`,
  `:plugin-not-installed`, `:plugin-disabled`, `:plugin-files-missing`,
  `:installer-is-a-clone`, `:node-not-found`, `:channel-mismatch`. A refused
  install is better than an agent that says Connected and hears nothing.
- **A workspace that DOES carry a `.mcp.json` is untouched.** Pinned by tests,
  and checked by putting the same clone-style folder through the 0.42.3
  installer and this one: state dir, service file, `.mcp.json`, `CLAUDE.md` and
  the installer's own output came out byte identical.
- **The supervisor is no longer removed by its own daemon.** The app records
  always-on in BGOS only after it has seen the agent connect, and a new agent's
  flag defaults to off, so the supervised session's daemon read "off" with a
  supervisor installed and uninstalled the job it was running in. A paired
  install is now stamped, and the reconcile leaves a supervisor younger than 15
  minutes alone. After that a flag that is still off is honoured as before.
  Read in code, not yet run against a real backend.
- **Node on the service PATH.** The marketplace plugin starts its MCP server and
  its hooks with `node`, and the service PATH was built for clone agents, which
  run `bun`. With node from nvm, volta or fnm the session came up and the channel
  never did. Node is now resolved before anything is written and leads the
  service PATH.

Not verified in this release: a supervised session actually coming online through
the marketplace channel. That needs one real one-click run on a clean account.

## 0.56.0 (2026-09-26)

- **An agent can say what each column of a board means.** A board's workflow
  select is the one the Kanban stacks by, and until now its columns were bare
  names: the owner read "Review" and had to guess whether a card there was
  waiting on them, on an agent or on nobody. `boards_update_schema` gains a
  `set_column_lines` op that describes each column in one plain sentence plus
  a few closed facts: who a card there waits on (the owner, an agent, someone
  else or nobody), whether it is open, parked, finished or dropped, which
  field sorts it, and, for a column that waits on the owner, up to four
  answers the owner can give. `clear_lines` removes a line and `workflow`
  proposes the select as the board's workflow, which the Kanban stacks by
  once the owner confirms the board.
  - **The lines only describe the board.** Nothing an agent writes there
    starts work, sends a message or is read to decide anything; the tool's
    own description says so, and the tool refuses the server owned keys
    (`v`, `writtenBy`, `at`, `does`) as unknown ones.
  - **A change the owner decides is reported as not applied.** Once the
    owner confirms the board, or on a column whose line the owner wrote, only
    the sentence changes directly; any other change is not applied and the
    owner's setting stays. The server lists those columns in `filed`, and the
    tool answers with one sentence naming them, saying which sentence was
    saved and not to send the rest again, instead of a success the model
    would retry on every run.
  - **A server that cannot store a line says so.** A BGOS server from before
    column lines drops the new keys and answers 200 with the field alone, so
    the tool checks the answer for its `playbook` and, when it is missing,
    reports that nothing was written rather than claiming the write.
  - **The shape is checked here, the rules are the server's.** A misspelt
    key, a wrong type or a value outside an enum is answered before anything
    leaves the machine, with the allowed values named. Every length (140
    characters for the sentence, 40 for an answer label, four answers) and
    every cross reference (an option that exists, a sort field of the same
    table) is the server's, and its sentence reaches the model word for word.
  - **Renaming an option keeps its column.** `set_options` takes an optional
    `option_renames` list of `{ from, to }` pairs, so a renamed option's cards
    and its column line follow the new name instead of being dropped with the
    old one. Without it the wire is byte for byte what 0.44.0 sent.
  - **The column lines sentence reaches only an agent that has the tool.**
    This daemon declares `boards_playbook` on every host, on its heartbeat and
    now on the capabilities fetch at connect as well (the fetch can run
    before the first beat has stored the declaration). The backend serves the
    sentence that teaches the op only to a connection that declares it, so an
    older daemon is never told about a tool it does not have. The bundled
    offline guide does not change.
  - **Nothing here is new for agents that do not describe columns.** Every
    other op, argument and answer of the board tools is exactly as it was,
    and the tool roster is still the same twelve.
## 0.55.0

**Renumbered from 0.52.0, then from 0.54.0, at merge:** the plugin's main took 0.51.0 to 0.54.0 (#162, #163, #157, #164).

**An owner can change this agent's memory from the app.**
The HOAI Memory screen now reaches a Claude Code agent (HOAI P7 stage 2, C-39). This daemon answers a new
`memory_rpc` lane (list, add, replace, remove) over the agent's own auto memory folder, the one the CLI reads at every
start.

- **The folder is found by the CLI's own rule, on every request.** `autoMemoryDirectory` from the agent's settings
  (local, then project, then user), else the git root of the agent folder (a worktree shares its main repository's
  memory), under the config dir this daemon runs with, never a hardcoded `~/.claude` and never the process folder.
  Memory turned off is said so. A relative folder setting, an agent path over 200 characters, or a folder the CLI
  never made is refused, and nothing is created.
- **An entry is one line of `MEMORY.md`**, the only part the model reads at start; the full words live in the note the
  line links to. A note typed `user` is listed as what the agent knows about its owner, the rest as its own notes.
- **Changes apply from the agent's next start**, not in the conversation it is having now.
- **Every change can be undone.** What a change takes away is kept in a trash outside the memory folder (the newest
  50, in this agent's plugin state folder), and adding the same words back restores the whole note where it was. A
  note the agent removed itself comes back whole too, while this daemon still remembers listing it.
- **The What changed Undo puts the folder back byte for byte.** When the app pairs a fact that went and one that
  came in the same store as one change, its Undo now brings the gone fact back under its own note and its own line
  and moves the one that came to the trash, instead of writing the old note under the new fact's name and title. A
  correction also retitles its line with the first words of the new fact, a title written by hand included, so the
  old fact no longer stays in the line the model reads at start, and the Undo of a correction puts the saved line
  back exactly as it was, the CLI's own title and separator included (the HOAI live round trip, F1 and F2, and its
  fix round).
- **Safe beside the model.** Every file is written through a temp file and a rename, the note before its line, and the
  index is compared right before it is replaced: a lost race answers busy instead of overwriting the other writer.
  Replace and remove match one entry exactly, never a part of one.
- **Only this agent answers.** A frame for another agent gets no answer at all, a re sent frame is answered again and
  never run twice, only the pairing lock holder answers, and nothing is read or written before the agent's home
  folder is confirmed.
- **Search is answered as not available here**; the app hides it for Claude Code.
- **Declares `memory_rpc` on every host.** The backend sends a memory frame to a Claude Code pairing only while it is
  declared, so the gate is the token, never this version.

## 0.53.0 (2026-09-26)

**Renumbered from 0.46.0, then from 0.49.0, then from 0.52.0, at merge.**
This release was prepared as 0.46.0, then renumbered 0.49.0 when the plugin's
main was released as 0.46.0, 0.47.0 and 0.47.1 by other programs without this
work and it stacked on the plan card. The permission request card (prepared as
0.44.1, then 0.47.0) has since shipped as 0.49.0 and the plan card it stacks on
(prepared as 0.45.0, then 0.48.0) as 0.50.0, both on the plugin's main. Main
then took 0.51.0 (add_mission_goals and cancel_mission_goal) and, while this
branch was being merged as 0.52.0, 0.52.0 (the restart recovery of an
unanswered message, #163), so this ships as 0.53.0, the next free number above
it. A plugin version cannot be reserved, so the HOAI canon does not tie the
floor to a release number: it tells the floor sentences only to a daemon that
DECLARES the `hard_floor` capability, the way it tells the request card and the
plan card only to a daemon that declares `permission_card` or `plan_card`
(BGOS #1624).

- **Always ask before risky actions: a listed action now stops and asks you,
  even though the agent runs with full access.** It is your switch, per agent,
  OFF by default, and it lives on the server; this plugin never reads it. With
  it on, deleting a folder and everything in it, force pushing, changing a file
  inside `.git`, changing an `.env` file, changing a settings file in your home
  folder, and an MCP tool that sends, posts, pays or deletes on your behalf all
  arrive as the Allow once / Deny card and wait for you. Nothing else changes:
  `git status`, an ordinary edit and this channel's own tools never ask.
  A payment tool is read by the names payment tools really use
  (`create_payment_intent`, `createPayment`, `charge_card`), while a read of
  one (`list_payment_intents`, `get_charge`) is not; and the HOAI Agent
  Browser's own tools are left to the browser's own gate, which already asks
  you before every sensitive action in the page, so clearing a value from the
  agent's own browser storage no longer asks. A shell command the CLI cut in
  the middle that no floor record names waits for you only when your switch
  is on (the relay asks the server with `elided: true`); with it off it runs
  as it did before. And if this daemon cannot fetch the canon, its offline
  copy tells the agent that a hook stops a listed action only when it
  declares `hard_floor`, the served canon's own rule.
  - **A blocking hook, and only one.** `bin/hoai-floor-hook.mjs` is a second
    `PreToolUse` entry with `async: false`, a matcher for the shell, edit and
    MCP tools and a 3 second timeout. For a listed action it answers `ask`,
    which the CLI honours under `--dangerously-skip-permissions` (the stage 6
    live probe, run D1). It never answers `deny`, because you could not
    overrule a deny from your phone, and it fails OPEN: bad input, a crash, a
    missing core or its own 1.5 second budget all end with nothing printed and
    exit 0. The telemetry forwarder is untouched and still cannot block
    anything; the manifest test and the forwarder's rule 1 now say why the one
    exception exists.
  - **Only where a HOAI agent runs.** The hook asks only in a session a HOAI
    daemon is attached to (the daemon marks its project folder while it holds
    its pairing lock). A plain `claude` elsewhere on the same machine, or a
    headless `claude -p` job, gets no new prompt.
  - **The relay stops waving it through.** A default install auto approves, and
    the probe watched it allow the hook's ask in 8 ms (run D3). The hook now
    leaves a floor record before it asks, and the relay takes it before its
    auto approve branch, because the request's own preview is a copy the CLI
    cuts in the middle when a command is long: a delete in the middle of a
    long script was invisible to it. On a match the relay asks the server
    (`POST /api/v1/integrations/assistants/:id/floor-check`, sent the matched
    command): hold posts the card and waits for you, proceed auto approves as
    before, and a check that fails or times out REFUSES the action rather than
    allowing it silently. A held request meets the same drain and no chat
    refusals as any other card. With auto approve off, a proceed in a full
    access session lets the call run as it did before, instead of a card for a
    switch you left off.
  - **The card the server can read.** An MCP tool's card now carries
    `<tool_name> <input_preview>`, so the server recognises a held send, post
    or payment and only you can allow it; a held long command leads with the
    matched command, so you see the delete or the push first.
  - **One list, owned by the server.** `lib/hard-floor-core.mjs` is a port of
    the server's reader in plain JavaScript, so a bare `node` hook can load it;
    `lib/hard-floor.ts` is its typed face for the daemon;
    `lib/hard-floor-fixture.ts` is copied byte for byte from the server's and
    pins six rule ids, their words, rules version 1 and every named case, with
    its digest pinned again in the test. A mention in quotes, a commit message,
    a comment or a heredoc written to a file is not the action; the HOAI
    exemption is the channel's exact server names; `rm --rec` is recursive.
    The cheap shell forms of the same actions are on it too: `find -delete`,
    `git clean -fd`/`-fx`, `rsync --delete`, `git push --mirror`, `--delete`
    and `:branch`, and a redirect, `tee`, `sed -i`, `cp` or `mv` onto a
    protected file. The same fixture now carries the card strings: the relay
    must build each one byte for byte, and the test pins the file's own bytes
    (kept at LF by `.gitattributes`), not only its data.
  - **Clone installs too.** The launchers now write the floor hook's entry into
    `.claude/settings.local.json` beside the forwarder, so a clone agent has the
    same floor as a marketplace one from its next launch through a launcher.
    An always on agent that `bgos-agent update` moves to this release gets the
    entry too: the update re-registers a clone workspace's hooks before it
    restarts the service (a service starts `claude` directly, so nothing else
    would have written it). And the daemon never takes the hook on trust: it
    looks at boot for the blocking entry in the files the CLI reads for its
    session and declares `hard_floor` only when it finds one, so a session
    with no floor hook is not told a hook stops a listed action.
  - **Long commands keep what makes them listed.** The hook's record keeps the
    whole matched command, and the relay fits it to the floor check's 4000
    characters and to the card's lead by dropping arguments, never the
    operator, with a marker saying how many went: `echo "K=<4000 characters>"
    > .env`, a `--force` after hundreds of branch names, `-rf` after hundreds
    of folders and a `cp` of hundreds of files into `.git/hooks/` used to be
    cut from their head, read as harmless and auto approved with the switch
    on, or held on a card the server could not stamp. A held edit whose path
    the preview lost now leads its card with the path. If the listed part
    cannot fit at all, a `hold: false` about the cut body does not auto
    approve it: you are asked.
  - **Only a tap allows a held action.** A typed `yes <id>`, the `Yes, this
    once` label or a callback pasted as text no longer settles a request the
    floor holds (a typed no still does): the server cannot tell a person from
    the agent's own credential on such a message, and the person only gate is
    on the tap.
  - **Not covered, on purpose or for now:** a legacy API key connection and a
    backend without the route (both auto approve a listed action as before,
    and say so in the log), and a delete done by a script, an alias, a
    variable or `python -c` (the list reads text, not intent).
- The daemon's attached marker, which the floor hook asks behind, is keyed by
  the folder the agent was LAUNCHED from as well (`BGOS_LAUNCH_CWD`, which
  `bin/bgos-launch.mjs` hands through when it moves the server to the plugin
  folder), and the hook reads that key too. Before, a launcher start rested on
  `CLAUDE_PROJECT_DIR` alone, and where that was lost (a WSL hop) the floor
  silently did not ask.
- A test ties the channel's own server exemption to the plugin manifest's name
  and channel server, so renaming either cannot turn the channel's own replies
  into floor matches.
- The plan card's own words no longer claim that no hook can stop a tool call:
  an ordinary edit is still never blocked, and the wait is still a promise.
- The bundled offline capability text carries the floor's three core canon
  sentences and the Claude delta sentence, so a model whose canon fetch failed
  is not told the opposite.
- **This daemon declares `hard_floor`.** On every heartbeat and on the canon
  fetch at connect, on every host of a PAIRING connection (a legacy API key
  connection does not declare it: its relay has no floor check to ask and
  auto approves a listed action, so it must not be told a hook holds one;
  `permission_card` and `plan_card` stay declared there, both work on an API
  key), taken from `lib/claude-capability-tokens.ts`
  (now naming three tokens), the file BGOS pins byte for byte, both sides
  pinning the same new sha256. The token promises the blocking floor hook and
  the relay's hold before any auto approve; the served canon tells the floor
  sentence only to a daemon that declares it together with `permission_card`.
  The floor-check limits (200 and 4000) are pinned as literals beside the ones
  BGOS pins on its route.
- The log says what the floor really does. The boot line reads "declared" off
  the declaration itself, so a daemon on an API key, where `hard_floor` is
  never declared, now says plainly that the floor is not declared and why,
  instead of "declaring the floor capability on a pairing". And a typed yes
  the floor refuses, or a verdict from another user, is logged once per row
  per request rather than on every poll tick (the final live proof counted
  57 copies in 37 s).

## 0.52.0 (2026-09-26)

**A message the previous session could not answer comes back after a restart,
instead of being lost forever.**

Board row 294a571a, raised 2026-09-06. The per-chat cursor advances when a
message is FORWARDED, not when it is ANSWERED. So a session that is handed a
message and then cannot act on it, because its account hit a limit, because the
model call failed, because it was killed mid turn, left that message BELOW the
cursor where nothing would ever look again: the delta window starts above it,
`selectFirstPollBacklogIds` only runs for a chat with no cursor at all, and the
restart handed the new session nothing.

The clean exemplar is KC's own question to Argus on 2026-09-24. It was consumed
at 14:29Z by a session whose every model call was being refused, the daemon was
restarted at 14:49Z, the new session came up and sat idle with the question
still open, and it was answered at 14:53Z only because a person noticed and
asked again. A shared account running out of credit is a fleet wide event, so
every message that arrives during one is consumed by a session that cannot
answer it.

`selectRestartRecoveryIds` (lib/poll-core.ts) runs on the BOOT poll only, which
is already the one poll that fetches a chat in full, and re-offers the trailing
messages nobody answered. Three limits, each of which is a way this could have
made things worse:

- **The stop rule is what makes it safe**, not the window or the cap. It is the
  same walk back `selectFirstPollBacklogIds` uses: stop at a real user then
  assistant REPLY. If the previous session DID answer, there is an assistant row
  after the user row and the scan stops before reaching it.
- **Only at or below the cursor.** Rows above it are delivered by the ordinary
  delta path on the same poll, so including them would hand the agent one
  message twice in one turn.
- **A day-long window, a cap of ten, and an undated row does not qualify**,
  because unknown age must not read as recent.

Six mutations, each printed before running and each reddening a named test:
removing the stop rule (6 red, including "a user message the session ANSWERED is
never re-offered"), dropping the cursor bound (2), dropping the age window and
the undated guard (2), dropping the cap (1), dropping the entry guards (1), and
replacing the boot gate with `if (true)` (1).

**That last one is the finding worth keeping.** Its guard passed the first time:
the test searched the 1200 characters before the call for the word `isBootPoll`,
and the comment written above the call contains that word, so replacing the real
gate left all seventeen tests green. A guard that can be satisfied by a COMMENT
is not a guard. It now walks back to the nearest `if (` line and reads that line
itself.

One honest note: the `lastSeen <= 0` half of the entry guard turned out to be
defence in depth rather than load bearing, since the at-or-below-cursor filter
already excludes everything when the cursor is zero. Kept, and said so, rather
than reported as a caught defect.

## 0.51.0 (2026-09-26)

**Two tools that change a mission already running: `add_mission_goals` and
`cancel_mission_goal`.**

KC asked for "add and cancel mini goals" on 2026-09-23. The app has had an owner
goal editor since stage 5 and it REFUSES a mission whose origin is `derived`,
which is every `/goal` mission; the card says so in words and tells the owner to
ask the agent in the chat. The agent then had nothing to change it WITH.
`set_mission_goals` refuses a mission that already has goals, and
`create_mission` SETS THE MISSION ASIDE, so the only answer to "add a goal" was
to destroy the card the owner was reading, every tick on it included.

- `add_mission_goals` APPENDS 1 to 12 goals. Send only the new ones: the backend
  never reads a row the mission already holds, which is what stops a restated
  list from dropping one silently. Refused on a mission with none, which is the
  fill door's job, and refused when the total would pass twelve, with both
  numbers in the sentence.
- `cancel_mission_goal` removes one goal by its id, validated in the path
  builder so a bad id is a sentence the model can act on rather than a 400. A
  TICKED goal is refused: it is a record of work carrying the agent's own
  evidence line. Cancelling the last unticked goal does NOT complete the
  mission, because removing a promise is not keeping one.
- `create_mission` and `set_mission_goals` now point at these two rather than
  only forbidding a create, and the served canon's Missions section loses a
  sentence that had become an instruction to do the destructive thing.

**A guard in this repo was not keeping the promise written in its own header.**
`test/mission-ws-wiring.test.ts` says a "FOURTH mission tool added later must
not be able to forget the stamp quietly", and it named its four tools as
literals in four places, so a fifth and a sixth would have been added with every
one of those tests green and neither checked. The scope is now DERIVED from the
tool dispatch switch: a mission tool is a case that builds a mission path or
body, and a mission WRITE is one that resolves an existing mission id. Proven by
deleting `rememberMissionSelfWrite` from the new cancel case (2 tests red, named)
and by moving its stamp after the DELETE (1 red, named); the literal lists caught
neither. The request-verb search was `Patch|Put` only, so it also now sees a POST
and a DELETE.

Two smaller fixes fell out of building that: a case body was sliced to a fixed
6000 characters, so the last case of a switch swallowed the next switch (that is
how `show_component` briefly appeared to build a mission), and the scan read the
whole file rather than the tool dispatch switch, so WS frame cases arrived as
tools.

Backend: BGOS PR #1669, canon `-goaledit1`. Requires a backend carrying it.

## 0.50.0 (2026-09-25)

**Renumbered from 0.45.0, then from 0.48.0, at merge.** This release was
prepared as 0.45.0, then renumbered 0.48.0 when the plugin's main was released
as 0.46.0 by another program without this work. The permission request card it
stacks on (prepared as 0.44.1, then 0.47.0) has since shipped as 0.49.0 on top
of main's 0.48.1, so this ships as 0.50.0, the next free number above it. The
HOAI canon no longer ties the plan card to a release number: it tells
propose_plan and the plan card only to a daemon that DECLARES the `plan_card`
capability (BGOS #1624), which this one now does, so the number is whatever
release is free when this merges.

- **The agent can now show you its PLAN before it touches anything, and you
  answer with a button.** `propose_plan` posts a real card into the chat: a
  title, one line saying how many steps and files, the numbered steps each with
  the file it touches, a check line, and three buttons, Go ahead, Change the
  plan and Do not do this. The tool returns immediately and the turn ends; your
  answer arrives later as an ordinary click and starts a new turn. Nothing
  parks a watchdog and nothing times out, so a plan answered tomorrow still
  works.
  - **Only the person a plan was proposed to can answer it.** A tap on a plan
    card is bound to that person with the permission card's own rule: a tap
    that names a different person is refused (the agent is not told to proceed:
    the chip and the status line stay up, and nothing reaches the agent),
    while a tap that names nobody, which is every tap on today's backend, is
    accepted. The
    person is the one the card was posted for, or the account owner when a
    restart lost that record. Before this, on a shared assistant, anyone who
    could see the chat could approve a plan and the agent went to work as if
    its owner had.
    The rule holds on every intake: the poll, the boot sweep and the live
    update stream, which reads the tapper off the raw answer payload (its
    normalised answer now carries that id as `clickerUserId`; before, it kept
    only the button fields, so a stamped tap from the wrong person read as
    unstamped on the stream and was accepted). A refused tap does not re arm
    the card: the backend records the first answer, so the plan's person then
    types their answer or the agent proposes again.
  - **The wait on this channel is a CONVENTION, and everything says so.** Every
    HOAI agent is launched with permissions skipped and the shipped manifest
    auto approves, so no tool call is blocked, no hook can stop one, and this
    plugin cannot prevent an edit one second after a plan is proposed. The card
    carries `enforced: false`, which is what puts "will propose before it
    changes anything" on your screen instead of "read only until approved"; the
    tool description, the `/plan` procedure and the agent instructions each say
    it in as many words. Codex, which has a real read only mode, sends `true`.
  - **A revision retires the plan it replaces, in that order, whatever this
    daemon happens to remember.** Pass `supersedes` and the older card loses
    its buttons BEFORE the new one is posted, so two live plans never sit in
    one chat and a tap on the old one cannot approve a plan the agent has
    withdrawn. When this process still holds the old plan the card also dims
    and says what replaced it; when it does not (a restart mid wait, or a model
    naming an older card) the buttons still come off, which is the half that
    matters.
  - **Change the plan carries your words, not a button label.** The app sends
    the typed revision as `custom_text` on the click itself, one stimulus
    instead of a click plus a message, and the agent reads
    `Change the plan: <what you typed>`. It arrives under the `__custom__`
    sentinel rather than `plan:change`, because the chip arms your composer
    instead of answering, so the daemon reads it off the card it landed on and
    hands the agent the `plan:change` code every one of its instructions names.
  - **Your answer settles the wait even if the agent restarted while you were
    thinking.** The status line beside the agent and the Plan mode chip above
    your composer are both taken down on any answer, and no longer depend on
    the daemon still holding the plan in memory. If it was not even running
    when you tapped, it finds the answer on its next boot and acts on it once.
  - **Where a tap lands fast, and where it does not.** A click reaches this
    plugin on the poll and nowhere else, so a chat with an open plan is polled
    every two seconds for thirty minutes. A tap inside that window lands in
    seconds; a later one arrives on the five minute sweep. That is the honest
    trade rather than pinning a chat at two seconds for a plan nobody may
    answer until tomorrow.
  - **A button an agent wrote can never be read as a plan answer.** Every agent
    authored button value is namespaced on the way out, and the plan
    classification now happens before that namespace is stripped, so a reply
    button whose value happens to start `plan:` is an ordinary button both
    ways.
- **`/plan` is a real command now, with a procedure behind it.** It reaches the
  model as an actionable directive whose first step is `propose_plan`, and the
  daemon arms a verifier when it delivers one: cancelled by the first
  `propose_plan` call, fired by the turn's Stop hook when the turn ended without
  a plan, and by a five minute timer where the hook rail is not installed. If no
  plan came, you get one line saying so instead of silence. Typing `/plan` at an
  agent that is ALREADY WORKING no longer fires it early: the verifier only
  answers to the end of a turn that began after you asked, so the turn already
  in flight can finish without taking your chip down and telling you no plan
  arrived seconds after you asked for one.
- **The Plan mode chip, and its close.** The daemon reports the chat's session
  mode (`plan` when it delivers a `/plan`, `default` when the plan is answered
  or you close the chip) so the app can draw the chip above the composer. The
  close arrives as `/code` and is answered by the daemon, never handed to the
  model, which would otherwise have told you your own close button was
  unavailable.
- **The owner's plan level reaches the agent on every transport.** The per agent
  setting ("Only when I ask", "For bigger or risky jobs", "Always before it
  changes anything") rides the inbound envelope as a labelled sentence and is
  rendered into the turn the model reads, on the poll, the stream and the
  socket alike. The daemon never reads the setting itself: the server decides,
  the daemon renders what it is handed.
  - **The poll rail gets it from the socket, because the poll route does not
    carry it.** The backend puts the level on the socket event and on the agent
    update stream. The chat history route this daemon polls is the app's own
    projection and has no such field, so the poll read nothing on every delivery
    and an owner on "Always" got an agent planning at the default for every turn
    the poll won, which during a plan wait is most of them. The daemon now
    remembers what the last carrying rail said, absence included, and the poll
    answers from that. A level the owner turns back DOWN therefore stops on the
    next socket delivery rather than lingering.
- **Reply buttons can ask for a colour.** `reply`'s `buttons[]` gains an
  optional `style` (`default | primary | success | danger`). An unknown value is
  dropped rather than refused, because losing a whole message over a colour is
  the wrong trade. Until now only approval cards sent a tier and every agent
  authored chip rendered neutral.
- **Fixed: the agent instructions advertised `/clear` and `/cost`.** Both were
  removed from the catalog on 2026-08-30, because nothing here can reset a
  context window or read client side accounting, so the model was being handed
  two commands that come back unavailable. The instructions now say that
  plainly.
- **Hardened: `plan:` is a reserved button namespace.** An agent authored reply
  button whose value was `plan:go` would have come back through the same intake
  as a real approval on a plan card. It is now escaped like any other agent
  value.
- **This daemon declares `plan_card`.** On every heartbeat and on the
  capabilities fetch at connect, on every host, because `propose_plan` is a
  typed tool with no platform limit. It is what tells the canon to describe
  the tool and the card to this agent.

## 0.49.0 (2026-09-25)

**Renumbered from 0.44.1, then from 0.47.0, at merge.** This release was
prepared as 0.44.1, then renumbered 0.47.0 when the plugin's main was released
as 0.46.0 by another program without this work. Main has since moved on again
without it (0.47.1, 0.48.0 and 0.48.1; main's own 0.47.0 was never released and
was folded into 0.47.1), so it ships as 0.49.0 on top of 0.48.1. The HOAI canon no longer ties the
permission request card to a release number: it tells the card only to a
daemon that DECLARES the `permission_card` capability (BGOS #1624), which this
one now does, so the number is whatever release is free when this merges.

- **A permission request now looks like one, and stops dying after two
  minutes.** When this agent needed an OK before running a tool, it posted a plain
  chat message with four grey chips and gave up on its own after two minutes.
  It looked like the approval card the rest of HOAI uses and was nothing like
  it: the app drew chips instead of a card, the agent read as FINISHED on every
  needs you surface while it sat there waiting, and the morning report never
  counted the request at all, because every one of those reads the
  `approval_request` message type and this relay did not send it.
  - **The card is a real one.** `messageType: 'approval_request'`, an
    `approvalMeta` naming the tool, the route and the request id, and exactly
    two buttons: Allow once and Deny, in the platform's `ea:<choice>:<id>`
    vocabulary. Two and not four, because the CLI accepts only allow or deny,
    so a session or permanent button would have promised the owner a memory
    this agent does not have.
  - **The owner decides how long it waits, and this daemon only offers.** The
    plugin reads no setting of the owner's. Every card carries
    `wait_seconds: 1800`, the longest this daemon can keep its own side of a
    request open, and the SERVER stores the smaller of that and the owner's
    per agent choice (10 minutes unless they change it). That stored number
    comes back on the created message, and it is what the card says and what
    this daemon's own backstop is built from. Sending nothing instead would be
    the shortest wait of all: a card with no `wait_seconds` gets the server's
    generic minute, shorter than the two minutes this replaces.
  - **Deploy the backend first, and this is why.** Both halves this release
    leans on are on one BGOS branch, `feat/p2-requests-wait-for-you`, and
    neither is on the deployed backend yet.
    - The **push**: the card has to go to the messages route, because that is
      the only one that carries an `approvalMeta` at all, and that route sends
      no device notification today. Every push in HOAI is sent from the other
      one. So until that branch deploys, a request raised while the app is
      closed reaches nobody.
    - The **per agent clamp**: the deployed backend caps `wait_seconds` at
      1800 and stores what it is given. Until the clamp lands, every request
      from this daemon waits the full 30 minutes whatever the owner chose,
      and can hold an update's drain for that whole time (see below).
    Both are reasons to let hosts take this release AFTER the backend is out,
    not before.
  - **The server is the only judge of when a request is dead.** The 120 s
    local clock is gone. The wait ends on the owner's answer, or on the
    server's own expiry flag, or on a backstop 90 s BEHIND the stored wait for
    a server that never answers, which also strips the buttons off a card
    nobody is listening to. A yes in the last seconds is honoured now, where
    before it hit a request the daemon had already declined. And a request
    raised while an auto update is draining the daemon is answered with a no
    instead of hanging the CLI on a question nothing was left to answer.
  - **The tap is read off the card, which is what makes the answer arrive at
    all.** Pressing Allow writes no message into the chat: the backend stamps
    the answer onto the card row and pushes the event to whichever daemon is
    paired for clicks, and this one is not paired for them. So the wait now
    reads the owner's answer off the card row it is already watching. That is
    the lane that exists in the two cases where the others do not: when the
    card has slid off the newest page of a busy chat, and while a self update
    has the daemon's inbound intake shut. Both of those used to end in a deny
    at the backstop with the owner's Allow thrown away. The same tap can still
    arrive on the ordinary poll a cycle later; the request is settled exactly
    once, and the late copy finds nothing to resolve. WHOSE tap it is comes off
    the answer the backend stamps on the card, and no backend stamps a tapper
    there yet: a tap nobody named is accepted, because the alternative on a
    shared agent is to throw away an approval the owner really gave, and only a
    tap that names a different person is refused. The two click intakes keep
    their older, stricter rule, and a click they refuse is not a verdict lost
    whenever the card's id came back off the post, because this read then sees
    the same answer on the card a moment later (with no id that read is off).
  - **A parked request reads its chat on a budget, and the budget is the
    wait.** TWO loops read that chat while a request waits, and only counting
    one of them is how a half hour request got expensive. The verdict watch now
    looks every 1.5 s for the first minute, where an answer usually lands, then
    every 5 s: about 390 looks over half an hour rather than 1,200. The
    daemon's own 2 s fast scope stays on the chat for exactly as long as this
    daemon is still listening to the request, which is about 300 reads at the
    ten minute wait the clamp will make the default and about 900 at the
    unclamped half hour. It is NOT cut shorter than that, and a first attempt
    to cut it at ten minutes was wrong: that scope is what keeps the ordinary
    poll's own click intake prompt, and a chat dropped out of it is read on the
    five minute sweep instead, so a tap could sit unheard for five minutes.
    Every one of these reads still carries an If-None-Match.
  - **The expiry reaches a request in a busy chat.** The watch reads a PAGE of
    the chat, the newest 50 messages, and a card posted into a chat with
    several people talking can slide off that page during a wait that now
    lasts minutes. The server's "this request is dead" flag lives on the card
    row, so once the row was off the page nothing ended the wait but the local
    backstop, with the CLI blocked the whole time. The card is now read on its
    own, anchored, the moment the page stops carrying it.
  - **A daemon that stops mid wait no longer leaves a live looking card.**
    The requests a process is holding live in its memory, so a crash, a kill or
    an ordinary restart takes them with it: nothing answers the CLI, and, worse
    for the owner, nothing takes the buttons off the card. It sat there
    tappable until the server expired it, which used to be a minute and is now
    up to the whole wait, and a tap on it showed as answered while nothing was
    listening. On boot the daemon now retires its own unanswered cards on the
    newest page of each chat it monitors, one log line each. A card a busy chat
    has already pushed off that page is still left to the server's expiry:
    reading further back on every boot would cost every daemon a great deal to
    catch the rarest case. A card posted in the last minute before this daemon
    booted is left alone too: the row's date is the server's clock and the
    cutoff is this machine's, so the sweep allows a minute for the two to
    disagree rather than risk taking the buttons off a card another daemon is
    at that moment waiting on.
  - **Known and not fixed here: a pending request holds an auto update's
    drain** for as long as it waits, because the handler runs inside the same
    message operation tracker that the drain waits on. Up to the owner's whole
    wait once the backend clamp is deployed, and up to the full 30 minutes
    until then. Bounding the drain belongs to the self update lane, not to
    this one. What DOES end such a request while the daemon drains: the owner's
    tap, heard through the watch only (both click intakes are shut in a drain),
    a typed `yes <code>`, the server's own expiry, or the local backstop.
  - **Nothing changes for an agent installed with auto approve on**, which is
    the default: that check answers first, ahead of everything else in the
    handler, including the drain. It needs no chat, no network and no intake,
    so an update drain must not turn it into a refusal. The drain deny above is
    for interactive mode, where the card genuinely cannot be posted or heard.
  - **A prompt left on screen by a 0.48.1 or older daemon** is still
    recognised, for one release, though not for the reason the first draft of
    this note gave. It cannot be ANSWERED across the update: the pending
    request died with the process that posted it. What the tolerance buys is
    that such a click is swallowed as a stale permission click rather than
    forwarded to the model as ordinary chatter.
  - **The daemon says which backend it needs, at boot.** One line naming the
    two halves above, so a host that takes this release ahead of the backend
    reads it in the log instead of wondering why requests wait the full offer
    and ring nobody.
- **This daemon declares `permission_card`, and the canon fetch carries the
  declaration.** The token rides every heartbeat on every host, because the
  relay speaks the channel's own permission notification and has no platform
  limit. The capabilities fetch at connect now sends the declared list too
  (`capabilitiesFetchPath`, the same helper the Kanban release adds for
  `boards_playbook`), because that fetch can run before the first heartbeat
  has stored the list, and the agent would otherwise not be told about the
  card until the canon was fetched again.

## 0.48.1

**An agent whose browser runs on its own machine is no longer read as offline when the owner's desktop app is closed.**
The browser tools' presence probe asked the backend for the browser host WITHOUT naming the agent, so the backend
answered for the owner's desktop alone. With that app closed, every browser call from an agent placed on its own
machine was refused as host offline, which is exactly the case the placement exists for (HOAI mission 25 goal 6).
The probe now sends the agent's id, and the backend answers with the agent's own host when the owner placed it
there. Re-vendored from HOAI's shim (BGOS #1642); bin/hoai-browser-mcp.mjs hashes to the pin, aaaff4b6.

## 0.48.0

**set_mission_goals: the agent writes the goals of a mission that has none.**
Every /goal mission, and every mission an owner starts from the app, begins
with no mini goals. Keep working ON now wakes the agent about every 30 minutes
while a goal is unticked (HOAI #1635), and on a goal-less mission that wake
asks the agent to write its goals first (KC, 2026-09-24).

- **New tool `set_mission_goals`** (`mini_goals`, optional `mission_id` and
  `chat_id`): `PUT integrations/assistants/:id/missions/:missionId/goals`. It
  writes 2 to 12 `{ name, done_when }` goals into the OPEN mission that has
  NONE, and keeps the same mission, so its Keep working switch and wake stay
  with it. `create_mission` would have replaced it. A mission that already has
  goals is refused: tick those instead. It validates goals with the same rule
  as `create_mission`, now shared, so the two can never disagree.
- **Declares `mission_set_goals` on every host.** The backend arms the
  goal-less Keep working wake only for a daemon declaring it, so an agent is
  never woken every 30 minutes to do something it has no tool for. It is a
  plain HTTP write, so unlike the goal loop it needs no tmux.

## 0.47.1

**The agent's own browser asks its owner, as a card, and waits.** 0.46.0 shipped
that browser UNGATED and named the gates as the follow-up; this is it. The
0.47.0 entry below was written when only the rules had landed and said the host
"does not yet ask with them". It does now, so that heading is folded into this
one rather than left to read as the shipped state of something it describes
half of. 0.47.0 was never released.

- **Permission gates, using the desktop's rules.** Every browser_ call is
  classified and decided by the vendored `policy.js`, so an agent is judged by
  the same rules wherever its browser runs. A new site, any write on one, a
  download, an upload, running scripts and every sensitive action is asked
  about; a password or a code is never remembered by any answer.
- **The card is the only surface, and it is posted immediately.** The desktop
  opens a gate as a strip with a 60 second countdown and only PARKS an
  unanswered one into the owner's chat. There is no pane on the agent's
  machine and nobody is sitting at it, so there is no strip: the card goes to
  the owner's chat with that agent the moment the gate is raised.
- **The host ASKS what the owner answered**, on `GET /api/v1/browser/gate/:gateId`.
  `browser_gate_answer` is emitted to the owner's person room and never to an
  agent socket, and this host joins only `browser-host:<assistantId>`, so it
  could otherwise post a card and then wait out the whole park for a frame that
  cannot reach it. The read is scoped to the account AND to the assistant the
  host serves, so a host serving one agent cannot read another's decision.
- **The action runs at most once**, whichever call returns it. A gate that
  outlives its call parks with a gate id, and `hoai_browser_wait_gate`
  re-attaches to the same held run rather than starting a second.
- **An ordinary gate answers inside the call that asked.** The attach budget
  sits under the relay's call cap and over the default 60 second wait, and a
  guard pins that ordering: it shipped inverted for one commit, and every gate
  would have parked five seconds before its own deadline.
- **Fail closed on every path that is not an explicit allow**: a card that could
  not be posted, a gate the server no longer has, an expired card, a park that
  runs out, an answer whose choice cannot be read, a gate kind the card route
  cannot carry, and a host with no way to reach the owner at all.
- **A group's browser is its own.** A room's frame carries `group-<chatId>`
  rather than the acting human's principal, and a test with a real Chromium
  shows the group sees neither the owner's nor either member's cookie, and that
  its own does not leak back.
- **`profiles.js` joins the vendored tier**, so "Always allow" and "Trust this
  site" are stored in the shape the desktop reads. Both sides of the pin now
  DERIVE the file set from disk instead of naming it, after a third file was
  vendored, hashed, and silently checked by nothing.

## 0.47.0 (never released, folded into 0.47.1)

- **`lib/browser-host-core/` holds byte-identical copies of the BGOS rule tier**
  (`policy.js` and `settings.js`): what counts as a read, a write, a sensitive
  action, a credential, a blocked category, and what the owner's grants mean.
  They are COPIED rather than re-implemented on purpose. Two hand-written
  copies of a permission policy is how two hosts quietly come to disagree about
  what is sensitive, and the disagreement surfaces as an agent doing something
  on one machine that it would have been stopped from doing on another.
  - They keep their ORIGINAL filenames in a directory of their own, because
    `settings.js` does `require("./policy")`: a rename breaks that require and
    a patched require breaks the byte-identity the hash exists to protect.
  - The nested `package.json` declaring `type: commonjs` is load-bearing, since
    this package is `type: module`; without it Node reads them as ESM and the
    host cannot load the rules at all.
- **Drift is now caught in BOTH directions.** `lib/browser-host-core/vendor.json`
  pins each file's sha256 and `test/browser-host-core.vendor.test.ts` reads it,
  following the shim's pattern; and BGOS carries a matching pin, so editing a
  rule there fails ITS suite until someone re-vendors here. The shim's own
  vendor test documents that missing second half, and that gap had already
  shipped a stale copy with a dead relay lane for a round.
- The vendor test does not stop at hashes: it loads the rules and asks them to
  decide, so a passing hash is not the only thing proven.
- `bin/hoai-browser-host.mjs` imports them and exposes `policy` and
  `hostSettings`. Nothing calls them yet, so behaviour is unchanged.

**Still ungated, and a backend gap is why.** `browser_gate_answer` reaches the
owner's PERSON room only, deliberately, and a daemon host joins only its
`browser-host:<assistantId>` room, so it can post a permission card and never
hear the answer. A host-scoped read has to exist first; until it does, wiring
the gate here would be a wait that never fires.

## 0.46.0

**Runs ungated on purpose, by the owner's decision (2026-09-23).** A
daemon-placed agent's browser raises NO permission strip: a new site, a write
on a signed-in site, a download, an upload and every sensitive action just run,
where the desktop Agent Browser stops and asks. The owner was shown that
difference and chose it for now. Moving the gates into the host is the
follow-up, and the served capability canon is corrected in the same breath so
no agent is told it will be asked when it will not be.


- **An agent's own browser, on the machine the agent lives on.** New
  `bin/hoai-browser-host.mjs`, run with node. It connects one socket per
  pairing on this machine with the `browser_host` handshake the backend
  already serves (the pairing token in the query; the role, only that
  pairing's agents and the device label in the auth), answers each
  `browser_rpc` frame through the desktop's own engine (Playwright's
  `BrowserBackend` over the same filtered roster, so `tools/list` is byte
  identical to the desktop's) and posts the answer to
  `/api/v1/browser/rpc/<rpcId>/result` with the same pairing token and the
  socket the frame arrived on. A notification is never posted.
  - **It drives a real, installed Chrome or Chromium** over CDP
    (`--remote-debugging-port`, `--user-data-dir`), headless by default. It
    never downloads a browser; when none is installed it says so at startup
    and in every call that needs one.
  - **The profile is keyed by principal, not by agent:**
    `~/.bgos-agent/<assistantId>/browser/<principal>/`, `owner` when the frame
    names none. Two different principals always get two directories, on a
    case-insensitive disk too, and a principal the host cannot read is
    refused rather than served from the owner's profile. A test with a real
    Chromium proves one principal's cookie is never sent for another.
  - Adds `playwright-core` 1.63.0 (the desktop's pin) as a dependency and
    `socket.io` as a dev dependency for the fake relay the tests drive.
  - Two existing tests skipped with `t.skip()` or the `skip` option, which
    bun's `node:test` does not honour, now also return early, so `bun test`
    is green as well as `npm test`.
- **The daemon starts that host itself.** `server.ts` spawns
  `bin/hoai-browser-host.mjs` under node on every paired daemon
  (`lib/browser-host-supervisor.ts`), scoped to the daemon's own pairing, with
  its output in `~/.bgos-agent/browser-host-<digest>.log` and never on the
  daemon's stdio, and stops it when the daemon exits (the host also stops
  itself if the daemon is killed outright).
  - **Unconditional, and safe by construction:** the backend elects an agent
    host only for an agent whose browser placement is `daemon`, so a
    desktop-placed agent's host never receives a frame, and Chromium and
    playwright-core load only on the first frame; an idle host is one node
    process (about 80 MB resident on macOS) holding one socket.
  - **One host per pairing on a machine,** through the reclaimable lock of
    `lib/pairing-lock.ts` at a per-pairing path: a second daemon of the same
    pairing waits, and takes the host over when the first daemon or its host
    is gone. A holder that is alive but late (a machine waking from sleep) is
    given a full recheck to beat again before its lock is taken, and a daemon
    whose lock was taken stands its host down and waits to take it back.
  - **Chrome and the host get an ALLOW-LISTED environment**
    (`lib/browser-env.mjs`), not a deny-list by name: a name rule cannot
    see `SSH_AUTH_SOCK`, a live handle to the user's ssh-agent. Chrome gets
    PATH, HOME, TMPDIR/TMP/TEMP, USER/LOGNAME, LANG/LANGUAGE/LC_*, TZ, the
    Windows system folders on Windows, and on linux the display and session
    variables only when it is shown. The host gets that plus its own
    `HOAI_BROWSER_*` settings, `NODE_EXTRA_CA_CERTS` and its pairing token,
    which it drops from its environment once read. Anything else is opt-in
    by name in `HOAI_BROWSER_CHROME_ENV`, and a credential-looking name is
    dropped even then.
  - **It can never take the daemon down.** A missing node, a spawn that
    fails, or a host that crashes is one log line; the daemon carries on and
    does not restart that host.
  - **Kill switch: `HOAI_BROWSER_HOST=off`** (also `0`, `false`, `no`) skips
    the spawn entirely.
  - Review fixes to the host: it no longer exits when it has no live socket
    (no credentials yet, or refused by the gateway), a stop during a Chrome
    launch now stops that Chrome, JSON-RPC ids `1` and `"1"` no longer share a
    waiter, the CDP connect after a launch is bounded, and a Snap Chromium
    (which cannot open a profile under `~/.bgos-agent`) is skipped with a
    message that says so. `package-lock.json` now carries the new
    dependencies.

## 0.44.0 (2026-09-21)

- **The helpers a turn hands work to get a row each, and the owner watches
  them work.** Until now delegating was invisible: the card said an Agent tool
  had run and finished in five milliseconds, which is how long the launch took
  and not how long the child worked, and everything the child then did arrived
  as unattributed rows in the middle of the parent's own. Now each child is a
  row of its own, named by the kind of helper it is, carrying the one line
  description it was given, a state, an elapsed time that ticks while it works,
  what it is doing right now, and, when it finishes, its last message.
  - **Every part of it comes from the runtime's own events, and each part is
    drawn only where its datum exists.** The row opens when the launch is
    asked for and its start is the moment the hook process stamped on that
    line. The launch RESPONSE is what says a child was handed off rather than
    a tool finished, so the five milliseconds the response took is never
    written as a helper's time. The elapsed is the difference between two of
    this host's own receipts. A child that never reports back carries no time
    and no result at all, because absent means absent.
  - **A card now stays open while a helper is still working, even after the
    turn has ended.** A finished card folds, and a helper ticking behind a
    fold helps nobody. So a turn that stops with a child still running leaves
    its card behind and the child's own stop, minutes later, updates that same
    card instead of posting a second one. The card settles when the last child
    settles.
  - **More than one card can be waiting, and none of them can be written over
    by another.** A card a turn leaves behind is kept under a name of its own,
    so a later turn cannot write over the card the owner is watching a helper
    on, and a second turn that ends the same way keeps the first card as well
    rather than abandoning it half done. The commands a child runs after that
    point land on that same card, beside the helper row they belong to, so one
    delegating turn is one card in the chat however long the child goes on
    working. Every card still owed an update has its own place in the queue, so
    what a helper is doing right now reaches its card while it is still working
    instead of being dropped for whatever the parent drew a moment later.
  - **The child's own commands are still there.** A helper's Bash row still
    carries the command, what it printed and the code it exited with, exactly
    as before, and the helper's row says which of them it is running right
    now. Nothing was taken away to make room for this.
  - **Nothing is promised that this runtime cannot give.** There is no token
    count, because the host is never handed one for a child, and no way to
    stop one helper: Claude Code offers no door for it, and a button that
    cannot do what it says is worse than no button. Both are recorded as
    blocked rather than postponed.
  - **One new hook event, and only one.** `SubagentStop` is registered;
    `SubagentStart` deliberately is not, because it carries no description and
    no tool id, so it can name nothing and be joined to nothing. A stop whose
    child this host never saw launched is ignored outright, which is what
    keeps the composer's own suggestion generator from drawing helpers nobody
    asked for.
  - **Nothing here is new for an owner who keeps the switch off.** The card is
    still hidden by the per agent "Show technical details" setting, still off
    by default, and this daemon still never reads it: the plugin always sends,
    and what is drawn is the owner's choice.

## 0.43.0 (2026-09-21)

- **The folded card after a turn stops saying "Used 5 tools" and starts saying
  what happened.** How long the turn took, how many tools ran, how many failed
  and how many files changed, and underneath it a shell row now carries what
  the command printed and the code it exited with, and an edit row the lines it
  added and removed. The owner opens a row and reads the output where before
  they had to ask the agent what it saw.
  - **Every number comes from the runtime's own events, and each part is drawn
    only where its datum exists.** The turn's start and finish are the moments
    the hook process stamped on its own receipts, never the moment this daemon
    happened to read the spool file (idle polling delays that by two seconds
    and an unproven session by up to a minute, so a card built on the later
    clock can report minutes that are wrong by more than the turn was long).
    A card with no clock shows no minutes. A row with no output has no chevron.
    A grep that matched nothing reports no exit code at all, because zero would
    be a lie and one would be a guess: it carries the runtime's own reading,
    "No matches found", as its short qualifier instead.
  - **What a command printed is masked before it is cut, and never leaves the
    machine in full.** The plugin's secret scanner runs over the output first
    and the tail is taken second, because cutting first can slice a token in
    half and hand the scanner a value its pattern no longer matches. Then the
    caps: the last 2048 characters and the last 200 lines of a row, and 8192
    characters of output across a whole card, spent newest first. Those caps
    are applied before EVERY write and not only the last one, because the whole
    tool list rides every card update while a turn is live.
  - **Nothing here is new for an owner who keeps the switch off.** The card is
    still hidden by the per agent "Show technical details" setting, still off
    by default, and this daemon still never reads it: the plugin always sends,
    and what is drawn is the owner's choice.
  - **No Undo button, and it is blocked rather than deferred.** Claude Code's
    own `/rewind` is an interactive selector with no tool, no channel method
    and no control request behind it, so a daemon cannot call it and a button
    that cannot do what it says is worse than no button.

## 0.42.3 (2026-09-22)

Two live defects that 0.42.1 and 0.42.2 shipped, plus the startup gates.

- **The doctor failed EVERY desktop one-click install.** 0.42.2 added a folder
  trust row that GATES the preflight, and the desktop runs `hoai doctor
  --preflight` from the owner's HOME with no `--workdir`, so it checked the
  wrong folder and failed after the pair code was already spent. Measured from
  HOME against 0.42.2: `FAIL Folder trust` then `preflight FAILED: trust`. The
  row now reads UNPROVEN when no agent folder was named, carries its remedy in
  the detail, and resolves the folder from a pin when there is one. It also
  honours trust INHERITED from a trusted ancestor, which Claude Code does and
  the exact-key lookup did not.
- **The trust seed replaced an owner's `~/.claude.json` when it could not read
  it.** A 0600 file it could not parse came back as a fresh five line config at
  0644, no backup, and the function reported success. Measured, and the same
  for a zero byte file, a non-object and EACCES. It now refuses and says so,
  leaving the file exactly as it was; both call sites already treat the seed as
  best effort, so a refusal costs nobody their install.
- **The startup gate block answers a gate by READING it**, rather than pressing
  a key it hopes is right. It waits for the screen to be quiet, identifies a
  gate by its footer phrase rather than a bare word (a resumed transcript
  saying "can you confirm" had made the supervisor kill a healthy agent), reads
  where the selection marker actually sits after each Down, and sends nothing
  at all on a screen it does not recognise, reporting what was on it instead.

A timing note worth keeping, because it made a correct fix look broken: a key
sent within about 100 ms of the trust gate painting is drawn but not honoured,
and the Enter that follows still declines. From about 150 ms on the same bytes
work. Two people measured opposite results from the same key for exactly that
reason.

## 0.42.2 (2026-09-21)

The other half of the same install post-mortem, plus one defect found while
verifying the fix that shipped in 0.42.1.

- **`hoai` never reached the user's own PATH.** After a marketplace install the
  command resolved inside Claude Code, which injects the plugin's `bin/` into
  its session environment, and answered `command not found` in the user's
  terminal. The remedy existed but pairing printed it as a conditional footnote
  BELOW the line declaring setup complete. Pairing now RUNS `install-cli` as its
  last step and says what it did, best effort and never fatal.
- **`hoai doctor` passed while the agent could not start.** Twelve PASS rows and
  one SKIP on a machine where every launch exited instantly, because the doctor
  validated the channel and never the launch. Four rows now cover the launch
  itself, and a check that never ran renders UNPROVEN rather than SKIP: the one
  honest row in that report read SKIP, which a reader takes as "not applicable"
  when it meant "unverified".
- **`waitForIncumbent` blocked forever.** No deadline, no escape, and a process
  whose cwd merely COULD NOT BE READ counted as blocking, so any claude under
  the same uid that `lsof` could not inspect held every launch. Bounded at 90s
  with the incumbent pid and how to clear it; an unreadable cwd is an absence of
  evidence, not evidence of a conflict, so it warns and lets the launch through.
- **Pairing from `$HOME` made the home directory the agent folder**, after which
  the agent ran with permissions skipped across the whole home. Refused now,
  before the code exchange, because a pair code is one-time and expires.
- **The trust seed wrote a key Claude Code never looks up.** 0.42.1 fixed WHICH
  FILE `preseedClaudeTrust` writes; this fixes the KEY inside it. Claude Code
  keys `projects` on the RESOLVED cwd, and `/var` is a symlink to `/private/var`
  on every Mac, so a seed for a folder under `/tmp` or `/var` reported success
  and changed nothing. Measured on a fresh folder against the real CLI: seeding
  the literal path left the trust dialog showing, seeding the resolved path made
  it disappear. Both spellings are seeded now, and a realpath that throws still
  seeds the literal cwd rather than skipping.

Also, as a rule rather than a patch: a setup step never silently replaces
anything. `install-cli` runs only on the interactive pairing path, never from
the watcher's background daemon, and when it finds a shim pointing elsewhere it
prints what it found and which one wins on PATH instead of re-pointing it.

## 0.42.1 (2026-09-21)

A first-time install on a fresh macOS user failed at four separate points, and
every one of them failed SILENTLY. Compiled from a real debugging session, then
each defect verified in source and on the host before it was touched.

- **The trust pre-seed wrote to a file Claude Code never opens.**
  `preseedClaudeTrust` derived its target by joining the config directory, so
  with `CLAUDE_CONFIG_DIR` unset it wrote `~/.claude/.claude.json` while the CLI
  reads `~/.claude.json`. The `settings.json` half of the same function resolved
  correctly, which is why the failure read as a partial success rather than a
  bug. A new `claudeConfigFilePath({env, home})` answers the question the config
  directory cannot. Every existing test passed over this because all of them
  inject an explicit `configDir`; the unset case now has its own test.

- **Nothing on the hand-typed path ever pre-seeded anything.**
  `preseedClaudeTrust` had exactly one production caller, the app's create-agent
  flow, so running `hoai` by hand (the command pairing itself tells you to run)
  seeded nothing. It is now called from pairing and from the launcher, the
  second of which also repairs agents paired by older versions.

- **The startup gate answered unknown screens with a blind Enter.** The posix
  expect wrapper ended in `timeout { send "\r" }`. The bypass-permissions
  warning defaults to DECLINE, so an unrecognised screen was answered by
  quitting, instantly and with no output. It now falls through to `interact`
  and lets the person decide. This file's own comment about the Windows helper
  had already stated the rule it broke: never press blindly on a prompt with a
  dangerous default.

- **An unpaired daemon died before the handshake, so nothing could say why.**
  The host could only report `CONNECTION_CLOSED` while the real reason went to
  stderr where nobody reads it. An unpaired server now completes `initialize`
  and offers a single `hoai_pair_required` tool carrying the instructions. A
  degraded connected server is diagnosable from inside the session; a dead one
  is not.

Not fixed here, and named so they are not assumed: `hoai` still does not reach
the user's own PATH after a marketplace install, `hoai doctor` still passes
while the agent cannot start, `waitForIncumbent` still has no timeout, and
pairing still accepts `$HOME` as an agent folder.

## 0.42.0 (2026-09-21)

- **Keep working until it is done: the agent's own goal loop reaches the
  mission card.** Claude Code has had a real goal loop of its own for a while:
  a person types `/goal <condition>` in the terminal, and after every turn a
  separate checker reads the work and answers met, not yet with a reason, or
  cannot be done with a reason. None of that reached the owner's phone. This
  release makes the whole of it visible, and on the hosts where this daemon can
  type into its own session it lets the owner's **Keep working** switch arm one.
  - **The reading half works on every host, Windows included.** The verdict is
    in NO hook payload (the Stop schema carries `hook_event_name`,
    `stop_hook_active`, `last_assistant_message`, `background_tasks` and
    `session_crons` and nothing else), and the checker runs as a SECOND hook
    inside the same Stop batch. So the hook is a wake and the session
    transcript is the source: `lib/goal-tail.ts` is a cursored tailer over the
    PROVEN transcript only (a goal set in a neighbour's session on the same
    machine is never adopted), `lib/goal-status.ts` maps the five
    `goal_status` shapes, and `lib/goal-writes.ts` decides which mission write
    each one deserves. A Windows agent shows a complete Last check, the turns
    and the time for a goal a person typed in its own terminal, and gets a
    mission card of its own for it.
  - **Time and turns only where the runtime counted them.** A not met check
    reports no iterations, no elapsed time and no tokens at all, so a live
    check sends the check count and NO working time; the time arrives with the
    terminal record or it never arrives. Nothing is ever worked out from when
    the mission was created.
  - **The turns already spent are carried.** "Give it 10 more turns" raises the
    cap and arms the same goal again, and the runtime starts its own count over
    at the new set sentinel. The lane adds what it already counted, so the card
    goes from 20 of 20 to 21 of 30 rather than back to 1.
  - **Two stops, both this daemon's.** The owner's turn cap, and three checks in
    a row that found the same thing after trimming, collapsing the whitespace
    and lowercasing (a judge rewords one finding between turns, and treating a
    reword as progress is how a goal loops for ever). Each clears the native
    goal and posts `stopped` so the server can turn the mission to Needs you.
    The runtime has its own competing pause and retry loop, with its own words,
    and it runs in interactive sessions, which every BGOS agent is: this
    daemon's stop wins and is the only one the owner sees.
  - **Setting a goal is the tmux injector, and nothing else.** A channel push
    provably cannot arm one: the CLI hard codes `skipSlashCommands: true` on
    the channel enqueue and wraps the text in a `<channel>` element before any
    flag could be read. `lib/compact-inject.ts` gains its FIRST parameterised
    literal in exchange, behind a validator that refuses an empty condition, a
    multi line one, any control character, anything over the runtime's own 4000
    character cap, and anything beginning with `/`, plus a `--` before the
    literal so a condition starting with a dash is text and not a tmux flag.
    See `docs/learnings/a-channel-push-cannot-arm-a-native-goal.md`.
  - **The declaration is now computed per beat.** `lib/declared-capabilities.ts`
    is a frozen base plus a pure function: `mission_events` and
    `mission_goal_checks` on every host, `mission_goal_loop` and `mission_pause`
    only while the injector answers. A late tmux upgrade (up to thirty minutes
    after boot) starts declaring on the next heartbeat, and a host that cannot
    type is never offered a switch that would do nothing. `mission_pause` was
    deliberately absent until now; clearing the native goal is the pause this
    daemon can genuinely enforce, and the canon says plainly what it means: the
    loop stops after the current turn, and a turn already running is not killed.
  - **Pause, Resume and Set aside reach a goal nobody armed from the app.** The
    owner is offered those three buttons on every open mission of this agent,
    and the pause this daemon enforces is clearing the native goal, so the lane
    reads them against the mission it is REPORTING on and not only against the
    one the switch armed. A goal a person typed in their own terminal has a
    derived mission and no switch behind it: Pause clears it and the checks
    stop, Resume puts the same condition back, and Set aside forgets it.
  - **The model is told, in the instructions, that it does not set goals.**
    There is no tool for one and it must not try to type a slash command; it
    works the condition, ends its turn normally, treats a not yet reason as the
    next instruction, and never ticks a mini goal because a check passed.
  - `/goal` is deliberately NOT published in the slash catalog: the app passes a
    typed `/goal <text>` straight to the agent when the server catalog carries
    it, and on this channel the model cannot set one, so publishing it would
    break the app's own door.
- **The channel's protocol era is pinned.** Claude Code refuses to deliver an
  unsolicited notification (a channel push, which is every inbound BGOS
  message) over a connection whose negotiated protocol revision it considers
  modern, and the MCP SDK answers `initialize` with whatever revision the CLI
  asked for. The era this channel lives in was therefore decided by the CLI's
  request and by whichever SDK a `bun install` resolved, both of which move
  without this repository, and the day one of them crossed the line the daemon
  would have gone deaf with nothing on screen and nothing in any log.
  `lib/channel-transport.ts` now pins the answer to the legacy revision a live
  session was proved to accept, wrapping the SDK's own handler rather than
  replacing it, and failing open if a future SDK has no handler to wrap.

## 0.41.0 (2026-09-20)

- **Your owner's decisions about a mission now reach you.** Until this release a
  mission was something the agent wrote and never heard about again: the owner
  could press Set aside, Mark done, Pause or Resume in the app, the card in
  front of them changed, and the agent kept working a goal that was already
  dead. The daemon now listens for the eight `mission_*` frames it was already
  being sent and tells the live session, in one plain line in the chat's own
  channel voice, what its owner decided.
  - `lib/mission-events.ts` is the whole decision, pure and unit tested:
    `parseMissionEvent` is total (junk in, null out, never a throw into the
    socket handler), and `decideMissionNotice` returns the words or null. The
    narrated set is exactly five: paused, resumed, set aside, marked done, and
    a mission the OWNER started. `mission_ticked` is never narrated, because
    the owner cannot tick, so every tick is the agent's own write and the model
    already has the tool result; telling it again is noise in its context.
  - **Three ways this could have gone wrong, each closed with a test.** The
    agent's own writes are stamped TWICE so the daemon never narrates the
    model's own create or tick back to it: once by mission id BEFORE the
    request leaves, because the backend emits the frame from inside the
    transaction it answers from and it regularly beats the response home, and
    once by mission id plus `updatedAt` when the response lands, which is what
    covers a frame delivered late. The pending stamp is spent by one frame, so
    a later change by the owner to the same mission is still heard, and the two
    frames that are never narrated cannot spend it: a tick that closes the last
    goal emits `mission_ticked` AND `mission_completed`, and a tick that ate
    the stamp would leave the completion looking like the owner's Mark done.
    Every frame is deduped (frame, mission id, `updatedAt`),
    because a paired daemon sits in BOTH `pairing:<id>` and `assistant:<id>`
    and a daemon in the field outlives a backend deploy. And an owner-authored
    title is collapsed to one line with any channel marker inside it defanged,
    so a crafted 200 character title cannot forge a second `[mission_*]` line
    and hand the model instructions its owner never wrote.
  - The eight registrations are written out one per line on purpose. The
    stand-down guard counts handlers by matching a literal quoted frame name,
    so a loop would have shipped eight ungated handlers with the whole suite
    green; `test/mission-ws-wiring.test.ts` now fails if anyone writes one.
  - A mission the owner REPLACED by starting a new one in the same chat is not
    narrated as a Set aside. The `[mission_started]` line riding the same write
    already says the new mission replaced any that was open, so telling the
    model to stop and post a "where I stopped" line for the mission its owner
    simply swapped out would contradict the line it is about to read.
- **A mission belongs to ONE CHAT.** `create_mission`, `tick_mini_goal` and
  `complete_mission` take an optional `chat_id`, resolved the way `reply`
  resolves one (an opaque `session_handle` round-tripped by the model resolves,
  a chat this agent may not reach is refused), then the live turn's chat, then
  the first monitored chat last. The two implicit steps skip any chat the
  server would refuse a mission in, because handing it one is not a mission in
  the wrong chat, it is a 400 the agent cannot act on: a meeting room (owned by
  the first participant) and a chat whose last inbound came from somebody other
  than the owner (a share recipient's own chat with the agent). When nothing is
  left the answer is the agent's main chat, which is what a single chat agent
  has always had. The active read carries `?chatId=`, which is
  what stops a tick issued while working chat B from ticking chat A's card.
  An agent with ONE chat sees no difference at all: with no chat named the
  request is byte identical to the 0.40.0 one, and the backend reads an absent
  chat as the agent's main chat.
- **The owner is not offered a Pause button on this channel, and now that is
  the honest answer rather than a hardcoded one.** The daemon declares
  `mission_events` on every heartbeat (`lib/declared-capabilities.ts`), and
  deliberately does NOT declare `mission_pause`: this runtime has no
  process-level handle on an in-flight turn, so its stop is cooperative and a
  Pause button here would do nothing. Mark done and Set aside DO reach the
  agent, and they end the mission. A pause this daemon can genuinely enforce
  is stage 6 work, and that is when the token gets declared.

## 0.40.0 (2026-09-20)

- **The owner can finally watch the agent work.** Until now a Claude Code
  agent's chat showed replies and nothing else: the twenty minutes it spent
  reading files, running commands and handing work to subagents were invisible,
  and the app's own header could only guess at "working" from the replies
  themselves. This release gives the channel the activity rail every other BGOS
  channel already had, fed by the CLI's own hooks rather than by anything the
  agent has to remember to say.
  - `hooks/hooks.json` registers nine events (`SessionStart`,
    `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`,
    `Stop`, `PreCompact`, `PostCompact`, `SessionEnd`), each in the `args` exec
    form so a Windows path with a quote or a `$` in it never reaches a shell
    parser, each `async: true` with a 5 s timeout, and the forwarder exits 0 on
    every path including a crash. A hook that exits 2 BLOCKS the tool call it
    was watching; telemetry that can stop the agent is a defect, not a feature.
  - `bin/hoai-hook.mjs` reads stdin as BYTES and decodes UTF-8 explicitly (a
    text mode read crashed on a payload carrying a box glyph when the Windows
    console code page could not decode it), appends one JSON line to
    `<state>/hooks/<session_id>/events.jsonl`, and exits. It opens no socket and
    reads no credentials. A payload over 256 KB is reduced to the fields the
    mapper reads, so a `Write` tool's whole file body never touches the disk
    twice; a spool over 2 MB rotates.
  - `lib/hook-intake.ts` is the other half: the daemon watches that directory
    with `fs.watch` plus a poll that tightens to 500 ms while a turn is live.
    A loopback listener was considered and rejected: a port needs a descriptor
    file, a token, a firewall question on Windows and a file fallback anyway for
    the daemon-is-booting case, and the file fallback is the entire design.
  - **Only the pairing lock holder consumes, and only our own session.** Several
    daemons can resolve one pairing on a shared host (the 2026-09-04 three
    daemon incident), and they all watch the same directory, so a passive one
    draining it would post every tool row twice. The intake starts inside the
    lock holder branch, re-checks `channelArmed && lockHeld` on every pump, and
    stops on stand down and on exit. A source guard in
    `test/pairing-lock-standdown.test.ts` fails if any of those move.
  - **Binding got stronger, not weaker.** Every hook payload carries the CLI's
    own `transcript_path`, which is the CLI naming our file rather than us
    inferring it from a tool result it echoed. `lib/session-binding.ts` takes
    `hook` as its strongest source, so the "several recent transcripts and no
    positive signal yet, refusing to guess" branch stops firing once hooks are
    live, and the context gauge stops going unreported on a busy machine.
  - **The Steps snapshot is heartbeated.** The server drops a Steps record after
    three minutes of silence, and a Claude Code turn is routinely quieter than
    that between task changes, so the unchanged snapshot is re-sent every 60 s
    while the turn is live. Without it the strip blinks out mid turn and the
    owner reads it as the agent dying. The route is the USER family,
    `assistants/:id/chats/:chatId/steps`, because it is the one both this
    plugin's auth modes accept; a 403 silences that one chat and nothing else.
  - **A clone install is not a plugin, and that is the trap.** Claude Code reads
    a plugin's `hooks/hooks.json` only for an INSTALLED plugin under
    `~/.claude/plugins`. A claimed workspace is an MCP server entry, so nothing
    would ever read the checkout's hooks file and the rail would be missing with
    no error to notice. `ensureHookEntries` writes the same entries into the
    workspace's `.claude/settings.local.json` with the checkout's absolute
    forwarder path, through the verified JSON mutator this repo already uses for
    the trust preseed, and every launcher calls it: `bin/bgos-agent`,
    `bin/bgos-claim.mjs`, both bootstraps and `hoai` itself, which is the
    command an agent folder actually starts with day after day. Each of them
    skips a MARKETPLACE install, which already has the rail, so no event ever
    fires twice. Existing clones gain the rail on their next install or launch. `docs/learnings/a-plugin-hooks-file-reaches-marketplace-installs-only.md`
    is the note; a test pins all four callers.
  - **The launch lines now set `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`.** Without it
    the CLI has no task tools, so the live Steps strip stays empty forever while
    the rest of the rail works, which reads as a broken feature rather than a
    missing env var. The launchd plist and the systemd unit carry it too.
  - **The daemon always sends; the app decides what to draw.** The owner's per
    agent "Show technical details" switch hides these rows in the app. Nothing
    in this plugin reads it, and a test asserts that: the backend derives the
    agent's live working status from a tool row arriving, and a shared agent has
    several viewers, so gating here would blind the header for everyone.
  - **What an adversarial review changed before this shipped.** Fourteen
    findings, all fixed with a test and a named mutation:
    - **A session now binds on PROOF, not on proximity.** The first payload
      whose transcript sat under this daemon's project dir used to capture the
      rail, so a human's own `claude` in the agent folder, or a session that
      died last week, could take it and the real agent's rows were then refused
      as foreign for the life of the daemon. Three positive proofs are accepted
      instead: a prompt carrying the text of a message this daemon delivered, the
      transcript `lib/session-binding.ts` has already proven (a reply marker or
      the CLI assigned session id, never the newest-mtime guess), and a
      `SessionStart` naming that transcript. Unproven events are held for 60 s in
      case the proof is a line behind, then dropped.
    - **The drain cursor is on disk** (`cursor.json` beside `events.jsonl`,
      written atomically). It lived only in memory, so every restart and every
      lock re-arm replayed a whole session: every card, marker and step again.
      A directory is swept when its `SessionEnd` has been consumed, or when
      nothing in it has been touched for 30 minutes.
    - **The line id is minted, not measured.** It was the file size each hook
      process stat'ed, so two hooks on one parallel tool call read the same
      number and the daemon dropped the second event as a duplicate. It is now a
      per process random tag plus a counter, written in one `appendFileSync`, and
      the drain reads whole lines only. That id is also what gives `Stop`,
      `SessionStart`, `PreCompact` and the other id less events their occurrence
      identity in the dedupe key, so a second genuine one is no longer swallowed.
    - **A turn end awaits the card already on the wire** before sending the final
      `done`, the way the Codex poster's `finalizeTurn` does. A `done` that
      arrived mid flight used to be thrown away, leaving the card on "running"
      for ever, on exactly the turns busy enough to matter.
    - **A turn's chat is fixed at its prompt** and held until `Stop`, so a peer
      message, a system wake or a meeting invitation arriving mid turn no longer
      re-points the rest of the rows into a chat the turn was never about. After
      `Stop` the chat is kept (with no live turn), so an out of turn compaction
      marker lands in the conversation that just happened rather than in
      whichever chat happens to be first in the monitored list.
    - **A 403 is read from the status, never from the text of the error.** The
      Steps URL carries the chat id, so a chat numbered 4403 silenced its own
      Steps strip for the life of the daemon.
    - **A Bash row shortens the paths inside the command**, not only the ones in
      its path slot, so `~` and a workspace relative path go on the wire instead
      of a home directory naming the account, and the 120 character clip is spent
      on what the command did.
    - **`assistantId` is off the `POST /messages` bodies** (card and markers):
      `CreateMessageDto` does not declare it, so the backend stripped it and
      logged an unknown field for every row this rail posted.
    - **`show_component` refuses the activity kinds** with one plain sentence.
      They are posted by the host from the session's own hook stream; an agent
      able to summon `context_compacted` could narrate a compaction that never
      happened into a chat the owner reads as a record.
    - **`hoai` carries the rail too**: the run plan now includes
      `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` and the clone hook entries, applied on
      every launch. And the Windows `cmd` launch line writes
      `set CLAUDE_CODE_ENABLE_TODO_TOOLS=1&&`, without the space that made the
      value `"1 "` and the flag dead.
  - Tests: `test/hoai-hook.test.ts` (22), `test/hook-intake.test.ts` (28),
    `test/turn-chat.test.ts` (14), the hook halves of
    `test/claude-preseed.test.ts`, `test/session-binding.test.ts`,
    `test/hoai-core.test.ts`, `test/renderables.test.ts` and
    `test/hook-events.redaction.test.ts`, plus eleven `server.ts` source guards.
    Each was proven red against a named mutation before it was kept.
## 0.39.9 (2026-09-20)

- **A daemon-handled slash command now checks who sent it.** `/compact` and
  `/status` are acted on by the daemon and never reach the model, and neither
  handler asked who sent them. One session serves every chat of an agent, so
  a person the owner had shared the agent with could tap `/compact` in their
  own chat and compact the owner's context. The decision now lives in one
  pure function, `lib/daemon-command-sender.ts`, called first by both
  handlers, which every rail (poll, WebSocket, stream) lands on. The sender
  is read from the per-message sender fields in each transport's own shape
  (the nested `sender` block on the socket, the flat `sender_user_id` on a
  poll or stream row) and never from the top-level owner id, which on both
  wires is the owner's for every sender. Decided per command on what it
  mutates or exposes: `/compact` mutates the owner's session, so anyone but
  the owner is refused with a short reply in their own chat, before the
  host's compact capability is consulted; `/status` mutates nothing, so a
  non-owner is still answered, but only with "connected" and the version,
  not the install method, supervisor, update enrolment or the last-message
  clock, which describe the owner's machine and the owner's traffic. A
  missing or malformed sender fails closed. The enforcement is one exported
  seam, `runDaemonCommand`: each handler in `server.ts` is a single call to
  it with its real work passed as `act`, so
  `test/daemon-command-sender.test.ts` proves with spies, against the real
  exported code, that a refused sender never reaches the action, the
  refusal is sent once to the sender's chat, a failed reply is still a
  refusal, and the owner reaches the action with the owner audience
  (behavioural). What is still only pinned by SHAPE, because the handlers
  and rails are module-scoped and not exported: each rail's exact call with
  the payload, each handler being one seam call, the real work invoked
  nowhere else, the tmux injection existing in exactly one place, and the
  seam's import path. Nine mutations proven red, six by behaviour and
  three by shape; the test file lists what no pin can catch.

## 0.39.8 (2026-09-19)

- **Every meeting turn reaches the agent with its turn marker.** Found in
  KC's meeting QA on 2026-09-19: some meeting messages arrived as plain chat
  cards with no `[Meeting #N, your_turn=...]` header. The backend delivers
  each meeting turn twice, as a `meeting_message` broadcast and as an
  `inbound_message` twin carrying `meetingContext` with the server's own
  verdict on whose turn it is; both share one message id, so whichever lands
  first wins the dedupe. The twin path ignored `meetingContext`, so about
  half of all turns lost the marker, and an agent's handoff was labelled as
  if the human had written it. The twin is now framed as a meeting card using
  the server's `yourTurn`, the broadcast handler records the new speaker
  before its dedupe can return (the stale speaker was what made the poll
  fallback say `your_turn=NO` on a turn that was ours), and a late frame for
  an older turn can no longer put stale meeting state back. All three
  transports build the card through `lib/meeting-card.ts`, every meta value
  a string. `test/meeting-card.test.ts` exercises the real builder and
  guards the `server.ts` wiring; seven mutations proven red.

## 0.39.7 (2026-09-18)

- **A shared agent's boards belong to the person using it.** KC, 2026-09-16:
  "If someone uses a shared agent to create boards or whatever it is, a
  browser, they should all be on the account of the person with the agent
  that was shared with it, not the owner." Every `boards_*` call now carries
  `X-BGOS-Acting-User` naming the sender of the most recent inbound user
  turn (poll, stream and WS alike), which the backend admits only through an
  active share of this agent to that person (BGOS PR #1472). The owner's own
  turn sends no header at all, so that wire is byte-identical to before; a
  peer or system inbound never moves the pointer; a proactive call with no
  user turn seen acts as the owner. `lib/acting-user.ts` holds the rules,
  `test/acting-user.test.ts` pins them on the real boards transports and
  guards the three `server.ts` sites. The browser shim (`bin/hoai-browser-mcp.mjs`)
  is a vendored copy of the BGOS source and a separate process with no path
  to the daemon's inbound state, so it does not name the acting user yet; see
  the PR for the mechanism that needs. Version 0.39.6 is the keepalive restart
  authority, merged immediately before this.

## 0.39.6 (2026-09-14)

A keepalive script is a restart authority, so a one-click update can finish on
the sessions it launches.

- **New `keepalive` restart authority.** A keepalive that starts claude inside a
  detached tmux (launchd job `ai.bgos.session.<id>` running
  `~/.bgos-session-<id>/keepalive.sh`) really does bring the session back, but
  its pid is nowhere in the daemon's ancestry, so 0.39.1's ownership rule
  refused it and nine sessions sat on "restart pending" after a one-click
  update. The script now declares itself in `~/.bgos-agent/<id>/keepalive.json`
  (`bin/hoai-keepalive-marker.mjs` writes it) and the daemon accepts the marker
  ONLY while the script's pid is alive, the claude pid it declares is a STRICT
  ancestor of the daemon (walked through `ps`), and that pid really is a claude
  session (`ps -o comm=`). The last check is not belt and braces: one tmux
  server is a strict ancestor of every agent on the host, so ancestry alone
  would let a marker naming it bind to all nine daemons and the restart would
  take the whole fleet down mid-turn. A stale marker, a dead script, a foreign
  session or a shared ancestor all fall through to the older tiers exactly as
  before.
- **This rung is inert until a keepalive script calls the writer.** The plugin
  ships the marker contract and the writer; nothing writes a marker on its own,
  so an agent with no marker behaves exactly as it did in 0.39.2. The marker has
  to be rewritten on every launch, since a stale `claudePid` is refused.
  `docs/one-click-restart-helper.md` carries the wiring notes.
- **The restart is a signal, never a kickstart.** After the usual drain and
  install, the daemon sends `SIGTERM` to the session pid from the marker and the
  keepalive relaunches it on the new version: the same recovery five sessions
  were brought back by hand with. It never `launchctl kickstart`s a keepalive
  job, which kills the script, restarts nothing, and leaves the daemon drained
  (the 2026-09-11 mute). A signal that does not land degrades to `staged`, and
  the un-drain watchdog still covers a relaunch that never arrives.
- **A keepalive publishes no service record.** `~/.bgos-agent/<id>/service.json`
  is cleared for these agents, so the per-machine watcher no longer holds a
  launchd job that cannot restart them.

## 0.39.5 (2026-09-13)

- **The browser relay no longer doubles the API prefix.** The launcher hands
  the shim the daemon's own backend URL, which carries `/api/v1` on every
  install whose config names it, and the shim appended `/api/v1` again: every
  probe went to `/api/v1/api/v1/integrations/browser/host`, was answered 404,
  and every Claude Code agent believed the owner's desktop app was offline.
  The shim now strips a trailing `/api/v1` before composing relay paths; a
  relay test pins it. Versions 0.39.3 and 0.39.4 are taken by open branches
  (liveness recency, keepalive restart authority).

A session that was live and then stopped is now seen. On 2026-09-12 the Data
agent's session (assistant 900) was wedged by a queued `/exit` from 07:49Z to
20:36Z. The daemon stayed connected and heartbeating; 13 hourly wakes and 2
owner messages queued unanswered; the log for the window holds one
reply-overdue line (19:54:36Z) and no probe or escalate line. The deaf-session
detector returned 'wait' whenever `live` was true, and `live` was the
ever-live latch, "any bgos tool call since boot", which had flipped at 07:49
and could never flip back. A session that had ever spoken was never probed
and never named to its owner.

- **Liveness for the deaf-session decision is recency-based.**
  `ChannelLiveness` records the time of every bgos tool call and answers
  `recentlyLive(now, windowMs)`: a call within `LIVE_RECENCY_WINDOWS` (3)
  reply-overdue windows, twelve minutes at the default. `checkReplyOverdue`
  passes that instead of `.live`. The ladder is unchanged: nudge at 4 minutes,
  a `channel_ack` probe once the nudge has sat two windows, the chat warning
  only after the probe has sat `DEAF_PROBE_GRACE_WINDOWS` more, once per
  boot. For 900 that is a probe at about 19:58Z and the warning at about
  20:10Z, instead of never.
- **`.live` keeps its ever-live meaning.** Cursor persistence, the on-disk
  channel-live marker and the shutdown flush still gate on the latch: a
  session that once heard the channel did receive the deliveries behind its
  cursor advances, and a quiet one must not start withholding them.
- **The heartbeat's unresponsive report reads the same recency**, so the
  backend's `session_unresponsive` tier can see a wedge on a session that had
  spoken (the latch hid it there too), and a tool call after the verdict
  clears it for the rest of the boot rather than letting a recovered session
  flap back to unresponsive on its next quiet quarter hour. Known limit, not
  new: `lastError` rides the version heartbeat, every 6h or on a readiness
  change, and nothing sends one at the verdict, so the backend learns late.
- **An answered probe is spent.** Under the latch an ack was permanent (it
  flipped `live` for the boot). Under a clock, recency can lapse again while
  the same inbound is still unanswered, so `checkReplyOverdue` now clears a
  probe the session has answered before the ladder runs, and the next lapse
  asks again instead of escalating on a probe that was answered. Every chat
  warning still rides on a probe that went unanswered for the full grace,
  which is what its copy says.
- **The probe and escalate log lines say what was observed** ("last bgos tool
  call 720 minute(s) ago", or "no bgos tool call since boot") instead of
  asserting "zero bgos tool calls since boot", which was false for 900.
- Guarded by `test/liveness-recency.test.ts`: the 900 case earns a probe, a
  recent call waits, the grace escalates, the boundary flips at exactly three
  windows, the never-live ladder is unchanged, the heartbeat reports the
  wedge and stays clear after a recovery, and the `server.ts` wiring at the
  chokepoint, the decision and the heartbeat is pinned. Mutant: `recentlyLive`
  returning `this.live` compiles and fails 8 of its 21 tests, the 900 case
  among them. `test/channel-liveness.test.ts` and
  `test/unresponsive-heartbeat.test.ts` pass unchanged.

## 0.39.2 (2026-09-12)

The HOAI Agent Browser reaches Claude Code agents by default, on this machine
and from any other one.

- **New MCP server `hoai-browser`** (`bin/hoai-browser-mcp.mjs`, zero
  dependencies): a stdio proxy to the browser pane the Home of Agents desktop
  app hosts (`~/.hoai/agent-browser.json` names the local endpoint and token).
  When the app is running the agent sees `hoai_browser_open_session`,
  `hoai_browser_close_session`, `hoai_browser_status` and Playwright's
  `browser_*` tools; when it is not, only `hoai_browser_status`, which says so.
  The shim sends `notifications/tools/list_changed` when the app appears.
- **The browser reaches the owner's desktop app from another machine.** The shim
  gained a second door: when the desktop app is not on THIS machine, every MCP
  message travels through the owner's HOAI account to the computer that runs it,
  and comes back the same way (`POST /api/v1/integrations/browser/mcp`, long
  poll, then `GET .../mcp/:rpcId` for a slow answer). The local loopback door
  still wins whenever it answers, so nothing changes for an agent that sits on
  the owner's own computer. The owner sees the agent's name in the pane.
- **The launcher hands the daemon credentials to the shim as env.** The
  `hoai-browser` server now starts `bin/hoai-browser-launch.mjs`, which
  resolves this folder's agent exactly as the MCP server does (the same
  `resolveCredentialsSelection` / `loadCredentialsFile` / `resolveAuth`, run
  through `bin/hoai-browser-creds.ts` under bun because that resolver is
  TypeScript) and spawns the shim with `HOAI_RELAY_BACKEND_URL`,
  `HOAI_RELAY_ASSISTANT_ID` and then either `HOAI_RELAY_PAIRING_TOKEN` or, for
  legacy api-key agents, `HOAI_RELAY_API_KEY`. The assistant id rides BOTH
  lanes: the relay endpoint requires it whichever header is used, because one
  pairing can back several assistants and the owner's pane shows which agent is
  browsing. The shim itself stays framework neutral and reads nothing but its
  environment. A pre-set `HOAI_RELAY_*` is an operator override and passes
  through untouched.
- **Nothing about it is fatal and nothing is logged.** No bun, a resolver that
  fails, an agent that is not paired yet: the shim starts anyway without relay
  env (local mode keeps working) and one plain stderr line says the relay is
  off and why. No credential is ever written to a log, a stderr line or a tool
  result.
- **Honest wording when the owner app is down.** `host_offline` now reads as
  "your owner's Home of Agents desktop app is not running or not signed in"
  rather than the local "not running on this computer", and while relay
  credentials exist the shim probes every 20 s so the browser tools appear by
  themselves the moment the owner opens the app.
- **Instructions:** the server instructions and the bundled capability fallback
  now say the Agent Browser is the default browser, ahead of Playwright MCP,
  chrome-devtools-mcp or Claude in Chrome, and that it works the same from
  another machine. The served canon carries the same rule.
- Guarded by `test/hoai-browser-mcp.test.ts` (the local and offline doors),
  `test/hoai-browser-mcp.relay.test.ts` (the relay door against a fake backend
  on loopback: the pairing header, the assistant id on both lanes, the api-key
  lane, a pending answer polled to done under both the 201 the relay endpoint
  really answers and the documented 200 / 202, `host_offline`, local winning
  over relay) and
  `test/hoai-browser-launch.test.ts` (the env mapping, the operator override,
  every failure path, and the bun resolver printing one JSON line).
- **The vendored shim is pinned by hash, not by a sentence.**
  `bin/hoai-browser-mcp.mjs` is a byte-identical copy of the BGOS shim, and for
  one round that claim lived only in a commit message: the BGOS source then
  moved twice and this repo shipped a stale copy whose relay lane was dead.
  `bin/hoai-browser-mcp.vendor.json` now holds the expected sha256
  (`e749abf800fb53cc1afce7ee20ead271610c3d0eaec69e071791ade027000d97`) and
  `test/hoai-browser-mcp.vendor.test.ts` checks it on every run, so a re-vendor
  cannot land without the hash moving with it. It also pins the LF rule and the
  `.gitattributes` line behind it, and it compares against the BGOS tree itself
  when `HOAI_BROWSER_SHIM_SOURCE` names it (skipped with a reason otherwise:
  BGOS is a separate repo and is not on this runner). Procedure:
  `docs/vendoring-the-hoai-browser-shim.md`; the drift and what is still not
  guarded: `docs/learnings/a-vendored-copy-is-only-as-good-as-its-hash-check.md`.
- **The launcher can never half-configure the pairing lane.** Two cases marked
  "THE INVARIANT" in `test/hoai-browser-launch.test.ts` pin it at the pure map,
  at the resolver path and at the env the shim is actually spawned with: a
  pairing result naming no assistant leaves the relay OFF rather than relaying
  into a guaranteed 400. The shim's own env-only contract (it sends whatever it
  is handed, which is what an operator or another host may configure) stays
  pinned in the relay test, which now says which of the two it is covering.

Design and evidence: BGOS `docs/superpowers/specs/2026-09-11-hoai-agent-browser-design.md`,
`docs/superpowers/plans/2026-09-12-agent-browser-relay.md`,
`docs/reports/2026-09-11-agent-browser-dev-environment/`.

## 0.39.1 (2026-09-12)

A one-click update can no longer leave a daemon deaf. On 2026-09-11 a forced
`update_now` across 21 pairings muted 9 daemons for 50 minutes: each reported
`restarting`, drained, and sat alive and heartbeating while answering nothing.
Their declared restart authority was a launchd job whose program is a
keepalive SCRIPT; that script had started a detached tmux server, so the job's
pid was nowhere in the daemon's ancestry, `launchctl kickstart -k` re-ran a
script whose singleton guard saw the session alive and waited, and nothing
died. The pre-flight only ever refused `staged`.

- **A service authority must OWN the process.** Before draining or pulling,
  the daemon reads its own pid ancestry (`ps -o ppid=` walked to 1) and the
  job's main pid (`launchctl print` `pid = N` / `systemctl show -p MainPID`).
  A job whose pid is not an ancestor fails `no_restart_authority` at once,
  with a log line naming the handle and both pids; the ladder never kicks
  such a job (a marketplace install stages instead). A job that does hold the
  process restarts exactly as before.
- **An un-drain watchdog after `restarting`.** Three minutes after either
  restart rung (service or launcher marker), if this process is still
  running, the restart did not arrive: drain off, terminal
  `error restart_did_not_arrive`, heartbeat, loud log. A real restart kills
  the timer with the process.
- Guarded by `test/update-rpc.test.ts` (ownership pre-flight, both paths,
  the watchdog on both rungs, re-arm) and `test/update-readiness.test.ts`
  (`serviceOwnsProcess` table, the three parsers, the probe).

## 0.38.26 (2026-09-05)

A tap on an inline button reaches the agent in seconds again instead of up to
five minutes. Why it was five minutes: the Agent Update Stream is off unless
`BGOS_UPDATE_STREAM=true`, and on every daemon we read on 2026-09-05 it was off
(mine, Data's, and the marketplace route sets no such env), so a click could
only arrive on the chat sweep, whose WS-healthy cycle has been five minutes
since 0.34.0. Text rides the WS at once, which is why replies were instant and
taps were late, and why a click stamped 26 seconds BEFORE a text message
reached the agent four minutes AFTER it. Nothing was dropped; the fast lane
was never switched on.

- **A chat with a fresh inline-button prompt joins the 2s fast scope**, the
  same scope meeting and pending-permission chats already use, until the tap
  lands (either lane), the prompt is ten minutes old, a later prompt replaces
  it, or this daemon replies TO the prompt in words (an unrelated progress
  update leaves the chips live; the agent is the chatty one). At most eight
  such chats at once, newest first. Bounded on purpose: an abandoned prompt
  must not pin a busy chat at 2s forever. The edge, stated so the next late
  tap is not read as a regression: a tap more than ten minutes after the
  prompt still lands on the five minute sweep.
- **The stream-off exit now says so in the log.** It returned silently, so a
  daemon with the stream off looked identical to one with it on and quiet.
- Guarded by `test/poll-core.test.ts` (the pure scope helper, edge and cap,
  and a source pin that both lanes drop the chat) and `test/stream-wiring.test.ts`.

## 0.38.25 (2026-09-05)

The poll lane now says when it is the one that delivered a click. 0.38.23 made
every outcome in the STREAM path observable and left the other half silent: the
poll path logged nothing on success, so a click that arrived there produced
silence indistinguishable from a click that never arrived at all. Half an
instrument answers half a question.

- **`button_clicked ANNOUNCED via POLL`** on the poll announce path, naming the
  message, the chat and the backend's `answeredAt`. Two independent samples put
  a click roughly 4.5 and 5.5 minutes behind its own timestamp, and the
  WS-healthy full poll cycle is 300000 ms: a missed WS push plus one fallback
  sweep fits both numbers. Only a positive line from this path distinguishes
  "the poll rescued it" from "the stream arrived late", and neither log existed.
- **What the pair now settles.** A stream line and no poll line means the stream
  delivered it, with its own in-daemon duration. A poll line and no stream line
  means the WS push was missed and the sweep recovered it. Neither line, and the
  click never reached the daemon at all. Before this, all three cases looked the
  same from the log: empty.

## 0.38.24 (2026-09-05)

Every `button_clicked` outcome is now observable. A tap of the owner's reached
his agent about five and a half minutes after the backend stamped it, and
nobody could say whether the click was DELIVERED LATE or delivered on time and
QUEUED BEHIND A BUSY AGENT TURN, because from the outside those are the same
picture: `applyStreamButtonsAnswered` had four unlogged early returns and
ws-delivered inbound was never logged at all. "Late" and "lost" both produced
no evidence, which is why this reached the owner as a regression instead of a
test catching it.

This does NOT fix the latency. It makes the next real tap self-diagnosing.

- **Every exit says what it dropped and why.** View unresolvable or no chatId;
  `answerPayloadOf` returning null, which is exactly where a wire-shape change
  lands; the skip decision, with "already announced by the other transport"
  distinguished from the messageType; and the permission branch's callbackData
  failing to re-parse, which silently hung a permission prompt with no trace.
  That fourth path was found by the new guard, not by reading the code.
- **Stream authority is recorded at receipt, not assumed.** Whether the stream
  held authority when a click arrived changes which bug you are looking at, so
  it is stamped on every outcome line rather than inferred afterwards.
- **A delivered click reports its time inside the daemon**, named "handed to
  transport" rather than "applied": the plugin cannot observe when the agent's
  turn picks a notification up, and a proxy under the wrong name would have
  poisoned the reading. The gap between that log and the agent acting is the
  busy-turn bucket, now two timestamps instead of an inference.
- **Guarded** by `test/button-click-observability.test.ts`, which pins that no
  bare early return survives in that function. Two of its own pins were
  vacuous when first written and were only found by running the mutations: a
  `>= 4` threshold that survived a removed stamp, and a `[^)]*` regex that
  could not see a condition containing a call. The source scan normalises line
  endings, because this checkout is CRLF and a scan matching a literal newline
  finds nothing and passes forever.

## 0.38.23 (2026-09-05)

Consult continuation: answer now, finish later. On an iPhone call the agent
answered a weather consult from a five hour old reading, then fetched a fresh
one and posted it to the chat, and the call never heard it because the consult
had already closed. `voice_consult_reply` now takes `final` (default true).
`final:false` delivers the provisional answer and keeps the consult open as a
running task on the backend (`pending:true, consultId` on the consult result);
a second `voice_consult_reply` with the same consult id posts the fresh answer
to `POST /api/v1/integrations/voice-consults/:consultId/result`, which the
backend announces in the call, flips the Work Stream card and settles the chat
card. The consult notification tells the agent about the path.

## 0.38.18 (2026-09-04)

The daemon half of the 'unresponsive' presence tier. Backend #1278 gave presence
a third state, connected but not answering, so a deaf or credit-drained session
stops reading as a confident green 'online'. It arrives on the heartbeat's
existing `lastError` under one reserved code, and its fail-safe is that no
report means 'ok'.

That fail-safe is correct, and it is exactly why the feature shipped DARK:
backend and app were both live and NOTHING SENT THE CODE, so every agent read
'ok' and the quiet field looked like a healthy fleet.

- **The verdict the daemon already reached is now reported.** No new detection:
  this projects the same 'escalate' decision that already posts launch guidance
  into the chat, which by then means roughly twenty minutes of silence AND an
  ignored direct liveness probe. It cannot fire on a busy session.
- **Recovery needs no second call.** The escalation latch is once-per-boot and
  never un-latches, so recovery comes from LIVENESS: any bgos tool call makes
  the session live, the report goes null, and the backend reads an explicit
  null as "clear". A session that comes back is not left marked.
- **One field, two producers, explicit precedence.** A refused credential wins
  over an unresponsive session, because the two are not independent: a daemon
  whose calls are refused cannot reach its session, so that session goes quiet
  and LOOKS deaf. Reporting the deafness would name the symptom and bury the
  cause, and they have different remedies.
- **The wiring guard is widened, because this failure already happened once.**
  The auth-rejection guard existed precisely because a lastError could sit
  unsent for months; the same thing then happened one field over. It now pins
  both producers and the combiner, so neither can be unwired without a red
  test. Verified by mutation: removing the new producer still COMPILES and
  turns the guard red.

## 0.38.17 (2026-09-04)

Home-folder identity binding (board 01a068f7). The 0.38.6 pairing lock below
guarantees exactly ONE daemon per pairing. It does not guarantee the RIGHT one,
and that gap recurred on 2026-09-04: a session started in a folder that is not
an agent's own resolved to that agent by elimination, took the lock while the
real agent was between restarts, and answered users in its name. Nothing was
misconfigured. At the credential layer a stray session and the real one are
indistinguishable, because identity was a property of the HOST and never of the
session.

- **An agent's home folder is now recorded and enforced.** A daemon that
  resolved its credentials by ELIMINATION (`sole-per-assistant` or `legacy`)
  from a folder that is not the one recorded for that agent REFUSES to start,
  naming both folders and every way to clear it, instead of speaking as
  someone else.
- **Explicit pins are never constrained.** `BGOS_CREDENTIALS_PATH`,
  `BGOS_ASSISTANT_ID` and a `.bgos-agent-id` folder pin are already
  per-process identity signals, so env-pinned hosts keep launching from
  wherever they like. Only the routes that guess are constrained.
- **It self-migrates, so nothing stops working on upgrade.** Every existing
  agent has no home recorded on the day this ships; the first one to hold the
  channel records its own folder and proceeds. No operator action.
- **A folder is claimed only after a minute of holding the channel.** The
  residual race is a stray recording a folder that is not its own, and strays
  are overwhelmingly transient (a subagent, a one-shot `claude -p`, a stray
  shell). A minute of continuous delivery filters those; the real long-lived
  agent crosses it without noticing.
- **Kill-switch:** `BGOS_ALLOW_ANY_FOLDER=1` skips the check for one boot, so a
  wedge is one variable away from cleared rather than a file edit.
- Failing to WRITE the binding never fails a boot: a read-only credentials file
  leaves the agent unbound and working, exactly as today.

## 0.38.6 (2026-08-30)

Single-instance pairing lock (board 01a05185): a confirmed fleet bug where, on
a host whose clone holds the sole credentials file, ANY session (KC's plain
sessions, default-config subagents) resolved to that agent's pairing via
"sole-per-assistant" and connected a rival daemon. Several daemons then joined
one Socket.IO pairing room, the server broadcast dispatch to all of them, and
the wrong one dropped the message ("Rejected dispatch to unauthorized
chat_id"), leaving the real agent unreachable while its process stayed healthy.

- **Reclaimable single-instance lock.** Before a daemon connects its pairing
  WebSocket it must hold an exclusive, heartbeat-based lock keyed to the
  resolved credentials file (`<credentials>.lock`). Exactly one daemon per
  pairing holds it and arms delivery; the rest stay PASSIVE, keeping their MCP
  tool surface up (the session is still usable) but never joining the pairing
  room and never touching the pairing. The holder stamps its pid plus a
  heartbeat and refreshes it on the existing poll tick; a rival RECLAIMS a lock
  whose holder is plainly gone (dead pid, or a heartbeat older than 3 intervals)
  rather than being locked out first-come by a short-lived transient subagent.
  A passive daemon rechecks on the heartbeat cadence and takes over
  automatically if the holder exits.
- **Beacon heartbeat.** On each successful beacon the active daemon touches a
  new `channel-beacon.json` (a sibling of `channel-live.json`) whose mtime an
  external supervisor can watch to detect a dead channel behind a live process.
  `channel-live.json` is edge-triggered on connect/boot only, so its mtime was
  never a liveness signal; this one is.

## 0.38.3 (2026-08-24)

One-click update robustness (#84): the update dirty-tree check now ignores
untracked and ignored files, so a stray report or note left in the connector
folder no longer aborts the update with "dirty_tree". It still refuses only on a
genuinely conflicting tracked change; the ff-only pull and detached-checkout
rollback remain safe backstops.

## 0.38.2 (2026-08-24)

Supervised-restart safety, after a live fleet incident on the night of
2026-08-23 where roughly six agents restarted and all resumed one agent's
conversation. The supervised launcher migration is a separate staged step (see
`docs/one-click-restart-helper.md`); this release ships the hardened restart
code so the one-click update path is safe when adopted.

- **Identity-safe relaunch (GAP 1).** The supervise loop no longer relaunches
  with `--continue` (which resumes the MOST RECENT conversation in the cwd, so
  agents sharing a folder resume a neighbour's session, the identity bleed that
  caused the incident). Each agent now pins a per-agent session id in
  `~/.bgos-agent/<id>/session-id` and relaunches resuming ONLY its own session
  (`--resume <id>`, created once with `--session-id <id>`). Verified against the
  `claude` CLI: `--session-id` creates, `--resume` resumes, a reused id errors.
- **Dev-channels prompt-stranding fix (GAP 2).** A clone (dev) launch shows the
  `--dangerously-load-development-channels` confirm prompt at (re)start, with no
  non-interactive flag to accept it, so an unattended supervised restart came
  back blocked until a human pressed Enter. The supervised launch now auto-
  accepts the gate under `expect` (mirror of the fleet's `run.expect`) when it is
  available, and warns clearly when it is not. Marketplace installs use the
  approved `--channels` flag and never prompt.
- **Singleton guard.** A second `hoai` in the same folder refuses to start when a
  live supervisor already owns the agent, instead of doubling the session and
  racing the restart marker.
- **Never-leave-dead.** A resumed relaunch that exits non-zero inside a 25s
  health window (the `keepalive.sh` lesson) is retried once as a fresh OWN
  session, so the supervisor never returns after its own kill with the agent
  down. A clean quit (code 0) is always honored, never hijacked.

## 0.38.1 (24 August 2026)

One fix, found live: one-click onboarding failed at the pairing stage on any
host already serving other agents (MacBook-Air-2, ten agents, 2026-08-23),
while the server side had paired fine.

- **A verified launch-folder pin now counts as a pin.** `hoai-pair` bakes a
  `.bgos-agent-id` pin into its working folder and then, on a multi-agent
  host, still exited 3 (pin required) because the live-safe verdict only
  honored the ENV pin. The one-click script read any nonzero as
  pair-failed, and the retry bounced off the mint guard's 409 because the
  first pairing WAS live. `launchFolderLiveSafe` now verifies the baked pin
  on disk (override absent, env id absent or matching, pin id matching,
  per-assistant credentials present) and a pairing that provably resolves
  from its launch folder exits 0 with a line naming exactly where it is
  live-safe from. The exit-3 refusal remains for a failed or elsewhere bake.

## 0.38.0 (22 August 2026)

One-click updates (wire contract v1, BrandGrowthOS/BGOS
docs/handoff/one-click-plugin-update/wire-contract.md): the app's "update
this agent" button reaches the daemon, and interactive sessions finally
have a restart authority.

- **update_rpc handler.** The backend pushes `update_rpc {rpcId, op}` to
  the pairing room; the frame carries NOTHING else (no version, no url, no
  script), the daemon resolves the update from its own pinned source with
  every existing brake honored (same-major gate, dirty-tree, checkout lock,
  rollback latches). Ack + progress ride REST
  (`integrations/update-rpc/:rpcId/ack` / `/progress`); the handler is
  deliberately NOT drain-gated and never tracked as message work (either
  would deadlock or deafen its own drain). Kill switch off, latch tripped,
  nothing newer, marketplace install: each is a descriptive terminal error,
  never silence (`lib/update-rpc.ts`).
- **Restart ladder, never a bare exit.** After installing: an installed
  always-on service triggers a DETACHED delayed restart (systemd-run /
  launchctl kickstart); else a live hoai launcher gets a
  restart-requested.json marker; else the daemon reports 'staged', keeps
  serving the old code, and the pending restart rides the next heartbeat.
  The daemon itself never calls process.exit (the kc-server invariant).
- **Launcher-loop supervisor.** A bare `hoai` now supervises the claude it
  spawns: it writes `~/.bgos-agent/<id>/supervisor.json` (pid + relaunch
  capability), polls for the restart marker every 3s, and on marker SIGTERMs
  claude and relaunches it with the re-detected channel flags plus
  --continue. Marker contents are ignored (existence only, so the marker can
  never carry commands), a normal exit never relaunches, and a 3-per-hour
  budget stops update-crash loops (`bin/hoai-core.mjs superviseClaude`).
- **Readiness heartbeat.** The 6h version heartbeat now also reports
  `latestKnownVersion` (last origin/main inspection; null on marketplace
  installs) and `updateReadiness` {supervised: systemd|launchd|launcher|none,
  autoUpdateEnabled, rollbackLatched, pendingRestartVersion}, so the app can
  show update_available / restart_pending / paused per pairing. A 'staged'
  update fires one immediate heartbeat instead of waiting 6 hours.

## 0.37.0 (22 August 2026)

One click, zero terminal: the onboarding release. Every fix from the
approved design (bgos-oneclick-design.vercel.app) plus one the build's own
E2E discovered, each with a regression test.

- **Launch shim (fix 01).** The plugin manifest and generated configs launch
  `bin/bgos-launch.mjs` under node, which resolves bun (BUN_INSTALL, ~/.bun,
  PATH, then bunx) and prints the exact install command instead of a bare
  ENOENT when bun is missing.
- **Install-method detection (fix 02).** `bin/bgos-install-method.mjs`
  detects marketplace vs clone and picks the matching channel spec
  (plugin:hoai@hoai vs server:bgos); pairing prints the ONE exact launch
  command for the install it found. The approved-sounding `--channels` flag
  is documented as a trap: it loads a non-allowlisted plugin's tools and
  wires no inbound (proven live 2026-08-22).
- **Preflight gate + doctor (fixes 03, 08).** `bin/bgos-doctor.mjs` prints
  the prerequisite table with one fix command per failing row; --preflight
  requires the MCP initialize handshake and a Connected row in
  `claude mcp list` before setup may claim success. `/hoai:doctor` runs it
  from chat; `hoai doctor` from a terminal.
- **Boot hello + channel-live marker (fix 09, new).** Connected cannot
  prove the session HEARS channel events, so on the first-ever boot of a
  pairing the daemon asks the session to greet its owner; the greeting's
  tool call writes a persistent channel-live marker, and the bootstraps'
  final step waits for it (doctor --wait-live-since) before declaring done.
- **Deaf-session honesty (fix 04).** Cursor PERSISTENCE is gated on channel
  liveness (first tool call since boot): a session that cannot hear never
  marks messages delivered, so a restart with the fixed flag redelivers
  them. When the reply-overdue nudge itself goes unacted on such a session,
  the daemon posts the exact launch command into the chat over REST, once
  per boot.
- **Credentials dedupe (fix 05).** The legacy credentials.json co-write is
  replaced by dedupe-at-write: a legacy file holding the same agent's
  pairing (or junk) is deleted after the verified per-assistant write;
  another agent's live pairing is never touched. The Windows ACL now
  applies (direct icacls argv; the cmd.exe string form double-quoted the
  grant and left the file world-readable).
- **Stable log path (fix 06).** `~/.bgos-agent/logs/bgos-plugin-<id>.log`
  regardless of launch method; BGOS_LOG_FILE still wins.
- **Session binding (fix 07).** The newest-mtime last resort binds only
  when unambiguous (a sole candidate, or exactly one active in the last 10
  minutes); otherwise the binder refuses and waits for reply-marker proof.
- **One-click bootstraps.** `bin/hoai-bootstrap.ps1` (Windows) and
  `bin/hoai-bootstrap.sh` (macOS/Linux): idempotent, sentinel-emitting,
  install only missing prerequisites (node, bun with BOTH bun and bunx on
  PATH, Claude Code), stop at the login gate until `claude auth status`
  says loggedIn, pair from the workspace with --assistant-id, pre-seed the
  characterized one-time prompts (trust; the bypass warning whose DEFAULT
  answer is exit), run the preflight, and wait for the channel-live proof.
- **The hoai alias.** Open the folder, run `hoai`: launches with the right
  flags via the folder pin; `hoai doctor`, `hoai pair`, `hoai logs`.
- **CI.** The full test suite + tsc now run on every PR.

## 0.34.0 (8 August 2026)

The Agent Update Stream consumer, strictly opt-in via
`BGOS_UPDATE_STREAM=true` (pairing mode only). With the flag unset, the
daemon is behaviorally identical to 0.33.6 and the whole pre-existing test
suite passes unmodified.

- **Sequenced delivery, trusted by arithmetic.** Stamped `inbound_message`
  pushes (`seq` + `streamEpoch`) apply through the Telegram-style rule:
  successor applies, duplicate drops, a jump buffers 500ms and then heals
  with ONE `GET /integrations/updates` catch-up chain (slices, intermediate
  cursor persisted before every next request, 429 resume, tooOld /
  invalidCursor / epoch mismatch routed to one full boot-style resync, 404
  feature detection for old backends).
- **Session tokens, memory only.** `POST /integrations/session` exchanges
  the pairing token for a short-lived session token used on catch-up reads;
  `session_expired` re-mints once (single flight), `pairing_revoked` stops
  the stream. The token never touches disk or logs.
- **Beacon + authority.** The 60s `update_state` beacon detects lost pushes
  and silent room drops; `stream_authority` is per connection, so sweeps
  demote only with authority AND a beacon on the current connection, and
  losing either degrades to the legacy cadence (never a reconnect loop).
- **Recovery gets cheap.** Reconnect = one jittered chain instead of a full
  sweep; WS-down = one updates poll per 10s instead of a full sweep; the
  healthy 5 minute sweep stretches to a daily reconciliation while stream
  mode is active.
- **The daemon-side application contract (spec 5.7).** Empty system wakes
  are held and their `message_finalized` delivers AS the wake; assistant
  authored rows only advance cursors (reply boundary); the per-chat cursors
  remain the dedup substrate and are fed by the stream; `buttons_answered`
  announces only what the legacy detector would have and consumes the
  transition, keeping the single-announce contract.
- New pure modules `lib/stream-client.ts`, `lib/stream-cursor-store.ts`,
  `lib/stream-apply.ts` (the consumer core `lib/update-stream.ts` landed
  earlier on this branch), plus 76 new tests including the all-string meta
  regression guards.

## 0.33.0 (5 August 2026)

Two observability items; no behavior change to auth or to what remote
compact does.

- **Auth divergence recheck (visibility only).** Auth is resolved once at
  boot, and the boot log line then masquerades as current truth even after
  the credentials file is rewritten underneath the process. The daemon now
  re-runs the same pure resolution every 10 minutes (env-tunable via
  `BGOS_AUTH_RECHECK_INTERVAL_MS`; `0`/`off` disables) plus immediately on a
  credentials-file watch event, and when the OUTCOME (mode, source,
  assistantId, token identity via a sha256-first-8 fingerprint) differs from
  boot it logs ONE structured WARN per distinct divergence, including the
  age of the underlying file change, and a recovery line if it reverts. The
  running process keeps its boot auth; no token is ever logged.
- **Remote compact detection survives startup races.** When the boot env
  does not resolve a tmux target, detection now retries for a bounded
  window (3 attempts over 30s) before concluding OFF, and after an OFF
  conclusion a throttled periodic recheck (every 60s, bounded budget) may
  make a one-time late upgrade to ON, logging that detection succeeded
  after the startup window and re-advertising `/compact`. The healthy boot
  path and its ON log line are byte-identical to 0.32.x.

## 0.32.0 (4 August 2026)

Multi-agent pairing: N agents under one OS user can now each hold their own
pairing. Driven by a live incident on a 7-agent host where pairing intended
for one assistant silently rebound another.

- **bgos-pair never guesses the assistant.** `--assistant-id <id>` (or
  `BGOS_ASSISTANT_ID`) pins the intended assistant; if the pairing resolves to
  a different one, nothing is written and both ids are named. With no request
  and several bound agents, the candidates are listed and an explicit choice
  is required.
- **Per-assistant credentials files.** New pairings write
  `~/.bgos-agent/credentials-<assistantId>.json` (or `BGOS_CREDENTIALS_PATH`),
  so pairing agent B no longer overwrites agent A's slot. Read order is strict
  and total: `BGOS_CREDENTIALS_PATH`, else an existing
  `credentials-<BGOS_ASSISTANT_ID>.json`, else the legacy `credentials.json`
  (the existing single-file fleet keeps working unchanged).
- **A rejected pairing file is loud.** When a credentials file is ignored
  because its assistantId does not match the configured `BGOS_ASSISTANT_ID`,
  startup logs a WARN naming both ids and the file path instead of silently
  falling back to api-key auth (the silent fallback made "boards 401" look
  like the channel being down).
- **Post-write verification.** bgos-pair re-resolves the file it just wrote
  and exits nonzero unless it actually resolves to the intended assistant. It
  also probes the real, unpinned environment: when only an env pin would make
  the daemon find the file, the success output says REQUIRED, with the exact
  variable to set.
- **Single-agent hosts keep working with an empty env.** After the
  per-assistant write, the legacy `credentials.json` is co-written when it is
  absent, junk, or already this same assistant, never when it holds another
  agent's pairing. A daemon with no `BGOS_ASSISTANT_ID` configured (the
  packaged plugin default) finds its pairing exactly as it did on 0.31.0.
- **The unbound write cannot clobber a live pairing.** When no assistant is
  bound yet, writing the legacy slot is refused if that file holds a live
  pairing for a bound assistant, naming that assistant.
- **Whitespace parity.** `BGOS_CREDENTIALS_PATH` and `BGOS_ASSISTANT_ID` are
  trimmed identically on the write side and the read side (a padded id that
  previously rejected a matching pairing file now matches it).
- **Honest restart instructions** for both topologies: the packaged
  `plugin:hoai@hoai` channel and a checkout-based `server:bgos` host.

## 0.31.0 (27 July 2026)

The first release since 0.21.1. Twenty-two commits, and the reason it is being
cut now is that the app already requires it: HOAI raised its Claude Code
staleness floor to 0.31.0, so until this is tagged and published every user was
told their plugin was out of date and could never clear it.

### Heartbeat

- **The daemon reports its working directory** (0.31.0). This is what lets the
  app show which folder an agent is actually running from, and is the reason
  the app's floor was raised to this version.
- **Version heartbeat**: pairing daemons report `daemonVersion` (0.22.0), which
  is what makes staleness detectable at all.

### Voice

- **Per-agent realtime model**, applied from the mint frame (0.30.0).

### Tools available to agents

- **`show_component`**, the generic renderable-components tool (0.26.0).
- **`show_health_tracker`**, summoning the native tracker card (0.25.0), later
  extended to carry the rich Budget board payload (0.28.0).
- **Native health-log tools**: `log_health_event`, `list_health_events`,
  `undo_health_event` (0.23.0).
- **`complete_mission`** takes an optional honest summary.
- **Outbound file types** match the backend allowlist (0.29.0).

### Self-update

- **Opt-in self-update** with a shared-checkout lock, a stable wrapper and a
  rollback latch, then **defaulted ON** (0.27.0).

### Fixes

- **Per-agent credential resolution is isolated**, so one agent's credentials
  cannot resolve for another.
- **BGOS slash commands execute** rather than being echoed.
- **Restart replay bug**: per-chat poll cursors persist and a first-run backlog
  gate stops a restarted daemon re-answering messages it already handled.
- **Scheduling**: a recurrence or `everyHours` object serialized to a JSON
  string in `when` is recovered rather than rejected.
- **Context**: stop advertising a dead `/compact` and infer unmarked 1M windows
  (0.22.1).
- **Real remote `/compact`** via supervisor tmux injection, plus positive
  self-session binding for `contextPct` (0.24.0).

### Performance

- **Delta polling and conditional GETs**, plus a scoped fast mode and a
  reconcile cadence, so a daemon stops refetching whole chat histories.

### Honest limits

- Agent-side resting self-report: usage-cap detection, `resetAt` parsing, and a
  deduped PATCH so a capped agent says so instead of going quiet.

---

## 0.21.1 and earlier

See the git history; this changelog starts at 0.31.0.
