# One-click plugin update + restart: identity-safe supervised restart (design)

Status: design + first hardening increment. Not deployed. Staged rollout required.
Context: KC 2026-08-23 asked for truly one-click plugin updates (detect -> show ->
one click updates AND restarts onto the new version). A live fleet incident on the
night of 2026-08-23 then exposed two restart-safety gaps that this increment fixes.

## 1. What already exists (do not rebuild)

The one-click pipeline shipped in claude-code plugin 0.38.0 (#81) and 0.38.1 (#82),
with the app side in BGOS #1157/#1158. Binding wire contract:
`docs/handoff/one-click-plugin-update/wire-contract.md` in the BGOS repo (branch
`design/one-click-plugin-update`). End to end today:

1. Auto-detect: the daemon reports its running version and the newest version at its
   pinned source via the heartbeat (`latestKnownVersion` + `updateReadiness`); the
   backend computes `update_state`; the app renders it (Whisper suffix / Glyph
   badge). Done; not touched here.
2. One click: app -> `POST /integrations/pairings/:id/update` -> backend emits
   `update_rpc {rpcId, op:"update_now"}` to `pairing:<id>`. The frame carries no
   version/URL/script; the daemon resolves what to install from its own pinned
   source (`SelfUpdater`, same-major gate, dirty-tree brake, latches authoritative).
3. Stage: `lib/update-rpc.ts` acks, drains, applies the fast-forward to disk,
   reporting `draining` then `installing`.
4. Restart ladder (`lib/update-rpc.ts` + `lib/update-readiness.ts`
   `chooseRestartAuthority`), strongest first: `service` (launchd/systemd) ->
   `spawnDetached` `launchctl kickstart -k` / `systemctl --user restart`; `launcher`
   (a live supervise loop that declared `relaunch`) -> write the existence-only
   marker `~/.bgos-agent/<id>/restart-requested.json`; else `staged` (keep serving,
   ride `pendingRestartVersion`, never self-exit: the kc-server invariant).
5. Completion truth stays server-side: a heartbeat with `daemonVersion >=
   targetVersion` flips `done`; silence times out to `unknown`, never faked.

The `launcher` authority for Claude Code agents is `bin/hoai-core.mjs`
`superviseClaude()`: `hoai` launches `claude`, polls the state dir for the marker,
and on the marker SIGTERMs the child and relaunches it. Plugins load at session
start and the MCP daemon is a child of `claude`, so ONLY a full session restart
loads a new plugin version. That supervisor exists; it is the restart of the WHOLE
session that these two gaps make unsafe.

## 2. GAP 1 (CRITICAL, caused the 2026-08-23 fleet incident): identity bleed

The relaunch uses `claude --continue`. `--continue` means "continue the MOST RECENT
conversation in this cwd" (verified: `claude --help`). The fleet runs many agents
in the SHARED cwd `/Users/fitecho/BGOS`, whose sessions all live in one project dir
`~/.claude/projects/-Users-fitecho-BGOS/`. So a restarted agent resumes whatever
session was newest in that shared folder, which is usually NOT its own.

`lib/session-binding.ts` already documented the read side of this exact hazard on
2026-07-18: "when two or more sessions share the project dir, the newest mtime is a
coin toss on a neighbour's transcript", and "`--continue` discards the pre-generated
CLAUDE_CODE_SESSION_ID and keeps appending to the OLD transcript". The incident is
the WRITE side: on the night of 2026-08-23 roughly six agents restarted, each
`--continue`'d into one agent's (Data's) conversation, fought over a single channel
pairing, re-spawned duplicate background workers, and drained the shared account.

A safe restart MUST relaunch each agent as ITSELF, resuming ONLY that agent's own
session, never "whatever is newest in a shared folder".

### The fix: a per-agent pinned session id, resumed deterministically

Verified empirically against `claude 2.1.241`:
- `claude --session-id <uuid>` creates a session with a deterministic id (writes
  `<uuid>.jsonl` in the cwd's project dir);
- `claude --resume <uuid>` resumes exactly that session (context preserved),
  regardless of what else is newest in the folder: identity-safe;
- `claude --session-id <uuid>` on an id that already exists ERRORS ("Session ID ...
  is already in use"), so the launcher must branch create-once / resume-after.

Design:
- Pin a UUID per agent in the per-agent state dir: `~/.bgos-agent/<id>/session-id`
  (channel-neutral, same dir the supervisor already keys on). Generated once.
- Resolve launch identity from (pinned id, does the session's transcript already
  exist in this cwd's project dir):
  - no transcript yet -> `--session-id <uuid>` (create the agent's OWN session with
    a known id);
  - transcript exists -> `--resume <uuid>` (resume the agent's OWN session).
- NEVER `--continue`. The id is agent-scoped, so even two agents in the same cwd
  each resume their own distinct session.
- The transcript-existence check mirrors Claude Code's own project-dir munge
  (`mungeCwd`, `cwd.replace(/[^a-zA-Z0-9]/g,'-')`), pinned by a mirror test.

Pure decision `sessionArgsFor(sessionId, sessionExists)` returns the `--resume` /
`--session-id` args (or `[]` when no id is resolvable). The id resolution and the
transcript-exists probe are injected IO, so every branch is unit-tested.

## 3. GAP 2: dev-channels / trust prompt stranding

The clone (dev) launch passes `--dangerously-load-development-channels server:bgos`,
which shows a confirmation prompt at (re)start (footer "Enter to confirm"). There is
NO non-interactive flag to accept it (`claude --help`: only the WORKSPACE TRUST
dialog is auto-skipped in non-interactive mode; the dev-channels confirm is not).
A supervised, unattended restart therefore comes back BLOCKED on that prompt and the
agent is offline until a human presses Enter (verified by a test-restart on the
night of 2026-08-23).

CORRECTION (2026-08-25): this section used to end "Marketplace/store installs use
the approved `--channels` flag and have no such prompt, so this is the clone/dev
path." Both halves are wrong, and the same wrong claim sat in a comment in
bin/hoai-core.mjs until it was removed. `--channels` is a silent-drop trap, not
an approved alternative: it loads a marketplace plugin's tools with no prompt,
`claude mcp list` reports Connected, and it wires NO inbound delivery for a
channel that is not on Anthropic's allowlist. So HOAI uses
`--dangerously-load-development-channels` for BOTH install methods and only the
spec differs (`plugin:hoai@hoai` vs `server:bgos`), which means the gate shows
for marketplace installs too. See
`docs/learnings/dev-channels-gate-on-marketplace-installs-and-the-windows-console.md`,
where that was verified live on Claude Code 2.1.241, and
`bin/bgos-install-method.mjs` launchFlagArgs, which is the code that decides.

The fleet's tmux `run.expect` already solves this: it spawns claude under a PTY and
sends Enter on `confirm`. `superviseClaude` spawns with plain `stdio:'inherit'` and
no auto-accept, so its relaunch strands.

### The fix: auto-accept the startup gate on a supervised (re)launch

- Pure `relaunchNeedsGateAutoAccept(installMethod)`: `clone` -> true (dev channel
  prompts), `marketplace` -> false (approved channel, no prompt).
- When a gate is expected AND `expect` is available on the host (dev hosts have it;
  probe injected), route the supervised spawn through a generated expect wrapper
  that mirrors the proven `run.expect`: spawn claude with the resolved args, send
  Enter on `confirm`, then `interact` so a human at the terminal is still relayed
  and the supervisor's kill still ends the session. `buildGateAutoAcceptExpect()`
  returns that script as a pure string (unit-tested for the accept logic).
- When a gate is expected but `expect` is NOT available, spawn directly and print
  ONE clear warning that an unattended restart may strand on the confirm prompt,
  and how to fix it (install expect, or use a marketplace/store install). Honest,
  never silent.

## 4. Complementary hardening (also in this increment)

Two additional safety properties a fleet-critical restart authority should not ship
without, both pure + unit-tested in `superviseClaude`:

- Singleton guard (`decideSupervisorArming`): a second `hoai` in the same folder
  refuses to start when a live supervisor already owns the agent (parsed from a
  live-pid `supervisor.json` declaring `relaunch`), instead of doubling the session
  and racing the marker. A stale/dead/own/malformed supervisor file is reclaimed.
- Never-leave-dead (`decideRelaunchRecovery`): a resumed relaunch that exits
  NON-ZERO inside a 25s health window (the keepalive.sh "resumed session died in
  <25s" lesson) is retried once as a FRESH owned session, so the supervisor never
  returns after its own kill with the agent dead. A clean quit (code 0) is always
  honored, never hijacked.

## 4b. Known limitations & deferred hardening (from code review)

Addressed in this increment: recovery now covers a rejected INITIAL `--resume`
(a fresh hoai process whose pinned session exists, e.g. the external keepalive
restarted it), not only in-process relaunches (the recovery keys on whether the
exited child was resuming, `--resume` present); the expect wrapper carries a
SIGTERM trap that kills the spawned claude so a supervisor kill cannot orphan it
into a second live session; the singleton refusal message no longer tells the
user to blindly kill a pid (a reused pid could be innocent); and the expect
script brace-quotes each arg (defense in depth; today's args are fixed flags plus
a regex-validated UUID).

Deferred for a later increment (proportionate for a first, staged increment; both
documented so they are not silently lost):
- The singleton guard is check-then-act, not atomic. It reliably stops the common
  sequential double-launch (a stray second `hoai`, the incident case); a
  microsecond-simultaneous race could still double-launch. Fix later with an
  `O_EXCL` lock on `supervisor.json`.
- The transcript-exists probe is cwd-sensitive while the pinned id is
  cwd-independent. If an agent's cwd ever changes, the probe can report "not
  exists" for a session that exists under the old cwd and try `--session-id` on an
  existing id (claude errors "already in use"); the never-leave-dead fallback then
  mints a fresh id and recovers, but a cleaner fix is to fall back to `--resume`
  on that specific error. Low likelihood: agents launch from a fixed pinned folder.

Intended behavior noted in review: a supervised clone launch now runs claude UNDER
expect (this is exactly what the fleet's `run.expect` already does, so no
regression); marketplace and Windows paths never take the expect path. The expect
loop's timeout-Enter can send up to a few harmless empty Enters into a live TUI if
no known marker appears within 12s (same as `run.expect`).

## 5. Safety guarantees (after this increment)

1. Identity: each agent relaunches as itself, resuming ONLY its own pinned session.
   No `--continue`, no newest-in-shared-folder.
2. No stranding: an unattended supervised restart auto-accepts the startup gate (or
   warns clearly when it cannot), reaching idle with no human keypress.
3. Singleton: at most one supervisor per agent id.
4. Never dead: a failed resume recovers to a fresh owned session within budget.
5. Bounded: <= 3 marker relaunches per rolling hour + a one-shot fresh fallback.
6. Frame carries no code; daemon fails closed to staging; kc-server invariant held.

## 6. Trigger contract (channel-neutral, for Hermes / Gobot adoption)

Daemon <-> supervisor communicate through existence-only files in
`~/.bgos-agent/<id>/`: `supervisor.json` (supervisor -> daemon: `{pid,
capabilities:['relaunch'], startedAt}`) and `restart-requested.json` (daemon ->
supervisor). NEW alongside them: `session-id` (the agent's pinned resume identity).
Another channel host adopts the contract by supplying a supervisor that resolves the
same state dir, writes `supervisor.json`, polls the marker, and relaunches with ITS
own launch command resumed by the pinned id (the only channel-specific piece). The
identity-safe and gate-accept decisions here are copy-portable pure functions.

## 7. Fleet recovery (what a human runs to bring an agent back safely)

The fleet's live launcher is `keepalive.sh` + `run.expect` (tmux/expect), not
`hoai-core` yet. The incident came from `run.expect` launching `--continue` in the
shared cwd. The immediate, safe recovery for ONE agent is to relaunch it as itself
on its OWN session, with the dev-channels prompt auto-accepted (expect already does
that). Two forms, per agent folder (see the PR report for the exact tested command):
- Clean (recommended to stop the fighting now): a FRESH owned session
  (`--session-id <new-uuid>`), accepting loss of tonight's cross-contaminated
  context. Each agent comes back cleanly as itself.
- Continuity: `--resume <that-agent's-own-session-id>` once its own transcript is
  identified (the daemon knows its own via reply markers; from outside, the
  contaminated shared session should NOT be resumed).

The durable fix is to swap `--continue` for the pinned-session-id resolution in
`run.expect` (mirror of the hoai-core fix) so every relaunch is identity-safe.

## 8. What a safe rollout requires (human-approved, staged)

1. Merge to the plugin repo behind the Data gate. No fleet effect on merge alone
   (agents run the plugin they launched with; a plugin change applies only on the
   next session restart).
2. Cut a plugin release (version bump + CHANGELOG). No served-canon change (no new
   user-facing capability), so no capability-canon bump.
3. Apply the identity-safe + gate-accept change to the LIVE `run.expect` fleet
   launcher first (that is what runs tonight), one agent as a canary: confirm it
   resumes its OWN session (its own recent context, not a neighbour's) and reaches
   idle with no keypress.
4. Canary the hoai-core path: drive the real one-click flow end to end on ONE
   non-critical agent (click -> update_rpc -> stage -> marker -> superviseClaude
   relaunch -> heartbeat flips done); verify single session (singleton), identity
   (own session resumed), no stranding, and a forced bad resume recovers fresh.
5. Watch one full rolling hour under a real update before any fleet roll. Never
   restart real fleet agents by hand as part of validation.

Rollback: the change is contained to `bin/hoai-core.mjs`; revert the PR and cut a
patch release. An agent already relaunched onto the new plugin keeps the new
supervisor until its next restart.
