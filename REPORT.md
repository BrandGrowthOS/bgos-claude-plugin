# REPORT: a deleted agent's machine cleans up after it (plugin half)

Board row 5b45611f6b0d. Branch `fix/agent-unbound-cleans-up`, worktree
`/Users/kc/hoai-work/mbunbind`. Not pushed. No version bump.

Commits:

- `0672e86` fix(agent): a deleted agent's machine stops it, removes its auto start and archives its folder
- `f8be89d` fix(agent): unbound cleanup acts only once the auto start is proven gone (the review fixes)
- `6b27175` fix(agent): register assistant_unbound by name and classify it in the stand-down guard (plus the first REPORT.md)
- `e840f6e` test(agent): the cleanup never deletes a file of the agent's folder, and a replay logs that it found nothing (kills M9 and M16)
- the last commit: the final review's fixes (a folder that cannot move stops the cleanup) and this REPORT.md

## The backend shape this assumes

I read the backend from the local BGOS bare repo, read only
(`git --git-dir=BGOS.git show main:...`). I did not change or run it, and I
did not touch prod.

- Event `assistant_unbound` (EventType.ASSISTANT_UNBOUND) with the payload
  `{ pairingId, assistantId }`. The gateway's cutUnboundAssistant emits it to the
  room `pairing:<pairingId>`. So every daemon on that pairing hears every
  agent's notice. Daemons connect with the shared pairing token.
- `pairing-notices.ts` stores the notice and replays it on each pairing
  connect for 7 days, with an ack callback. An ack retires the row.
- The same event also goes out when an agent is re-paired to another
  computer or handed to a new owner. That is not a delete.
- `GET api/v1/assistants/:id` returns 200 with a null body (Nest can send the
  null as an empty body) for a deleted or not-owned agent, and the row
  otherwise.

So the event name and payload on their own do not prove a delete. The
plugin confirms a delete with its own authenticated read before it acts.

## What changed

### `lib/agent-unbound.mjs` (new)

Every step that decides anything lives here, as pure code with injected
dependencies.

- `judgeUnboundNotice(payload, own)`: acts only when `assistantId` is this
  daemon's agent AND `pairingId` is this daemon's own pairing. A notice for
  another agent, for another pairing, with no pairing named, or arriving on a
  daemon that does not know its own pairing is ignored (`other_agent`,
  `other_pairing`, `own_pairing_unknown`, `malformed`).
- `classifyOwnAgentRead`: a 200 with an empty or `null` body means `deleted`.
  A row with our id means `present`, which covers a re-pair or a hand-over.
  Anything else (an error, junk, a 5xx) means `unknown`, and nothing happens.
- `createUnboundNoticeHandler`: judge the notice, confirm with the server,
  then launch the cleanup once. Its states are idle, busy and done. A replay
  or a race launches nothing new. A failed launch goes back to idle, so the
  next notice retries it.
- `createUnboundFrameRouter`: the daemon's socket handler.
  - It never calls the ack. The daemon that launches the cleanup cannot know
    the cleanup finished, so an unacked notice keeps replaying, and the
    replay is the retry.
  - Before the daemon is armed (holds the lock), it holds only this agent's
    own judged notice and hands it over when the daemon arms. Without this,
    the replay at connect would always land before arming and be dropped.
- `cleanUpUnboundAgent`: the cleanup itself. It refuses a junk id outright,
  so no path is built from one. It only ever names this agent's id: its
  folder, its `credentials-<id>.json`, the legacy `credentials.json` only if
  that file's `assistantId` is ours, and its own service.
  - **Windows**:
    1. Run the watcher's existing `uninstallAgentTask` with `files: []`, so
       the generated launcher files are archived with the folder rather than
       deleted.
    2. Read the task back with `agentTaskStatus`. If it is not `absent`, stop
       there: no kill, no archive, credentials kept. The replay retries.
    3. Only after that, end the launcher tree with `taskkill /PID <pid> /T /F`
       (hoai-core `--keep-alive` would otherwise relaunch claude).
    4. Wait for the process to go, then archive the folder, retrying while it
       is busy (EBUSY/EPERM). Remove the credentials only once the folder has
       moved. A folder that never moves keeps them, so the agent still shows on
       this computer.
  - **macOS and Linux**:
    1. Send SIGTERM to a hand-run hoai launcher (its supervisor.json pid,
       proven the writer) and wait for it to exit.
    2. Archive the folder FIRST, because `bgos-agent uninstall` deletes the
       state. If the folder could not move, stop there: no uninstall (its
       state wipe would delete the folder) and credentials kept, so the
       running service hears the replay and tries again.
    3. Run the existing `bin/bgos-agent uninstall --assistant <id>`. That
       takes the install lock, removes the plist or unit and runs launchctl
       bootout or systemctl --user stop.
    4. Remove the credentials only if the uninstall succeeded.
    5. A late sweep re-archives the folder if a dying session wrote it again.
  - **Idempotent**: with no folder, no credentials and no service file it
    does nothing. With the folder already moved, it runs no task command and
    makes no folder again.
- `removedArchivePath`: `~/.bgos-agent/.removed/<id>-<UTC YYYY-MM-DD>`, then
  `-2`, `-3`. It never overwrites and never deletes. Every scanner of
  `~/.bgos-agent` keys on `credentials-<id>.json`, so `.removed` is never
  read as an agent.
- `unboundRunStageCommands`: how the cleanup escapes the agent's process tree.
  - On Linux it runs as its own transient unit, `systemd-run --user --collect`
    with `--setenv=HOME` and `--setenv=PATH`, because stopping the agent's
    unit kills its whole cgroup. It falls back to a detached child.
  - On macOS and Windows it runs as a detached child.

### `bin/hoai-agent-unbound.mjs` (new)

- `--stage launch` starts `--stage run` out of the agent's tree and exits.
- `--stage run` calls `cleanUpUnboundAgent` with the real fs and exec,
  `bin/bgos-agent`, and the launcher read from the inventory. It logs to
  `~/.bgos-agent/.removed/<id>-unbound.log`.

### `server.ts`

- The daemon listens for `assistant_unbound` and sends it through the router.
- The router reads the agent back with the same authenticated
  `GET /assistants/<id>` the daemon already uses (no ETag).
- The daemon spawns the helper's launch stage detached, then stops itself with
  SIGTERM after 15 s, so a plain claude with no service also loses its channel.
- `handleUnboundBeforeArm()` runs at both places the channel arms.

## Tests (`test/agent-unbound.test.ts`, 37 tests, all pass)

Everything uses fakes. No date is pinned: the archive date is computed from
the injected clock with `dayOf(ms)`.

- **Notice checks**:
  - the event name
  - this agent's notice is acted on
  - another agent's notice is ignored
  - a forged notice (another pairing, or none named) is ignored
  - an own pairing that is unknown is ignored
  - the server read classification
- **Handler**:
  - forged and other-agent notices are never confirmed
  - nothing happens while the server still returns the agent
  - an unconfirmed read retries later
  - the cleanup launches once, and a replay adds nothing
  - a failed launch is retried
  - racing notices launch once
- **Router**: never acks; a notice before arming is held and handled on arm;
  once armed, every frame goes to the handler.
- **Windows** (memory fs plus the fake task host; agents 912 and 913 both
  installed and started):
  - The task is unregistered and read back gone, and only 5912's tree is
    taskkilled.
  - The archive holds session-id, agent.log, run-agent.vbs and
    install-agent-task.ps1. The credentials are removed. 913's task, folder
    and credentials are untouched.
  - A replay does nothing new.
  - A task that does not read back gone stops everything.
  - A run after the folder already moved runs no task command.
  - A busy folder is retried.
- **macOS and Linux** (the REAL `bin/bgos-agent` under bash, with fake
  launchctl and systemctl; agents 42 and 43):
  - The plist or unit file is removed, and the job is booted out or the unit
    stopped.
  - The archive holds run.sh and session-id, and the credentials are removed.
  - 43's files are byte-identical, and no cleanup command names 43.
  - Replays do nothing new.
  - A hand-run launcher is sent SIGTERM before the move. A launcher its
    service runs is never signalled; the uninstall stops it.
  - A failed uninstall keeps the credentials.
  - A folder that cannot move is never handed to the uninstall, and its
    credentials stay. On Windows, a folder that never moves keeps its
    credentials too.
  - The legacy `credentials.json` is removed only when it names this agent.
- **Other**:
  - The server.ts wiring, by source scan:
    - the own pairing comes from the daemon's credentials file, never from
      the notice
    - the confirming read is `assistants/<own id>` with the daemon's own auth
    - the helper is started for the daemon's own agent id and HOME
  - a junk id touches nothing
  - the run-stage commands per platform
  - the real bin `--stage run` end to end on macOS

## Red first

1. The first run, before any code existed, failed in every test with
   `ERR_MODULE_NOT_FOUND` for `lib/agent-unbound.mjs`.
2. The launch-plan and router tests were written before those exports
   existed. They failed with
   `does not provide an export named 'unboundRunStageCommands'` and
   `... named 'createUnboundFrameRouter'`.
3. The final review's tests (`red-final.out`, run against e840f6e): `ℹ pass 35`,
   `ℹ fail 2`. The two failures:
   - `Linux: a folder that cannot be moved is never handed to the uninstall`:
     `no uninstall while the folder is still in place`, with
     actual `[ '/x/bgos-agent uninstall --assistant 42' ]` and expected `[]`.
   - `Windows: a folder that never moves keeps the credentials and is never deleted`:
     `the credentials stay with the folder that could not move`, with
     actual `false` and expected `true`.

   The legacy credentials, service-launcher and server.ts tests guard
   behavior that already existed. They passed at once, and M33 to M38 prove
   they can fail.
4. The review-driven tests were run against the lib from commit 0672e86
   (with only the router appended so the file loads): `ℹ pass 29`,
   `ℹ fail 3`.

```
✖ Windows: a task the read back does not show gone stops the cleanup: no session ended, folder and credentials left for the replay to retry
    actual: true,
    expected: false,
✖ Linux: an auto start the uninstall could not remove keeps the credentials (the folder is still archived first)
    actual: undefined,
    expected: '{}',
✖ unboundRunStageCommands: Linux tries its own transient systemd unit first (a unit stop kills its whole cgroup), then a detached child
    (the systemd-run args had no --setenv=HOME / --setenv=PATH)
```

## Mutations

The runner is in the scratchpad: `mutate.py`. It applies one mutant, runs the
tests that guard it, and restores the file in a `finally`. None of the
mutants failed to compile. Each entry gives the line taken out (`-`), the line
put in (`+`), and the result.

| # | Behavior broken | Changed line | Result |
|---|---|---|---|
| M1 | forged notice: pairing check | `- if (pairing !== ownPairing) return { act: false, reason: 'other_pairing' }` (deleted) | KILLED (2 fail) |
| M2 | other agent: id check | `- if (agent !== ownAgent) return { act: false, reason: 'other_agent' }` (deleted) | KILLED (2) |
| M3 | a returned row read as deleted | `+ if (text === '' \|\| text === 'null' \|\| text.startsWith('{')) return 'deleted'` | KILLED (2) |
| M4 | an error status read as deleted | `+ if (!read) return 'unknown'` | KILLED (1) |
| M5 | (first run, old ack design) other agent's notice acked | handler ack | KILLED (2) |
| M6 | a replay launches again | `+ state = 'idle'` after launch | KILLED (1) |
| M7 | a failed launch never retried | `+ state = 'done'` on failure | KILLED (1) |
| M8 | Windows task not unregistered | `+ const res = { ok: true, notes: [] }` | KILLED (1) |
| M9 | Windows launcher files deleted, not archived | `+ uninstallAgentTask(reg,` | KILLED (1) |
| M10 | Windows launcher tree not ended | `+ if (launcherPid === -1) {` | KILLED (1) |
| M11 | busy folder not retried | `+ archivedTo = await archive({ retry: false })` | KILLED (1) |
| M12 | Windows replay runs the task uninstall with no folder | `+ if (true) {` | KILLED (1) |
| M13 | posix: no archive before the uninstall wipes it | `- archivedTo = await archive({ retry: false })` (and its stop check) | KILLED (2) |
| M14 | posix auto start not removed | `+ const res = { code: 0, stdout: '', stderr: '' }` | KILLED (2) |
| M15 | credentials not removed | `- fs.rm(path)` (deleted) | KILLED (2) |
| M16 | the nothing-left early return | `+ if (false) {` | KILLED (1) |
| M17 | hand-run launcher not stopped | `+ ... launcher.supervisor === 'nobody'` | KILLED (1) |
| M18 | archive name not unique | `+ return base` | KILLED (1) |
| M19 | junk id accepted (traversal) | `+ const stateDir = agentStateDir(home, String(deps.assistantId).replace(/\D/g, ''))` | KILLED (1) |
| M20 | Linux: no own systemd unit | `+ if (platform === 'nope') return [{ how: 'systemd-run'` | KILLED (1) |
| M21 | bin run stage never cleans | `+ const report = { ok: true } \|\| await cleanUpUnboundAgent({` | KILLED (1) |
| M22 | the router acks | `+ if (typeof _ack === 'function') _ack()` | KILLED (1) |
| M23 | a notice before arming dropped | `- held = payload` (deleted) | KILLED (1) |
| M24 | Windows: a task not read back gone counts as removed | `+ gone = res.ok` | KILLED (1) |
| M25 | posix creds removed although auto start stayed | `+ if (true) removeCredentials()` | KILLED (1) |
| M26 | Linux systemd-run unit gets no PATH | `+ ...(path ? [] : [])` | KILLED (1) |
| M31 | Windows: credentials removed though the folder never moved | `+ if (false) say(... its credentials are kept` | KILLED (1) |
| M32 | posix: the uninstall runs with the folder still in place | `+ if (false) {` (the stop check) | KILLED (1) |
| M33 | another agent's legacy credentials removed | `+ if (parsed) credentialFiles.push(legacy)` | KILLED (1) |
| M34 | this agent's legacy credentials kept | `+ if (false) credentialFiles.push(legacy)` | KILLED (1) |
| M35 | posix: a service-run launcher signalled too | `+ ... launcher.supervisor !== 'nobody'` | KILLED (1) |
| M36 | server: own pairing not from the credentials file | `+ pairingId: undefined }` | KILLED (1) |
| M37 | server: the confirming read asks another path | ``+ url: `${API_BASE}/assistants/me`,`` | KILLED (1) |
| M38 | server: helper started for another HOME | `+ '--home', process.cwd()]` | KILLED (1) |

**Every mutant is killed; none survives.** The final run, against the
committed code, is in the scratchpad: `mutations-final.txt`. It covers M1 to
M4, M6 to M38, and M28.1 and M28.2. M5 belonged to the old ack design and no
longer applies.

M9 and M16 first survived as equivalents: their result could not be
observed. New assertions now make them observable:

- **M9**: with the mutant, the uninstall deletes `install-agent-task.ps1` and
  the read-back writes it again. The Windows test now records every `fs.rm`
  and requires that nothing inside `~/.bgos-agent/<id>` is ever removed,
  only moved.
- **M16**: the Windows replay test now requires the run log to say "already
  cleaned up".

M12 and M22 were rerun after their test patterns were fixed.

### The socket guard (after the full suite found it)

The full suite failed `mission-ws-wiring: no socket registration anywhere
takes a variable frame name`. server.ts registered
`realtimeSocket.on(ASSISTANT_UNBOUND_EVENT, ...)`, a constant the
pairing-lock-standdown counting guard cannot see. The fix:

- server.ts now registers the literal `'assistant_unbound'`. The lib test
  still pins the constant to the backend name.
- test/pairing-lock-standdown.test.ts classifies the frame as SELF_GATED. It
  is not wrapped in `whenArmed`, because `whenArmed` drops a frame heard
  before arming, and that would undo review fix 2. A new test requires that
  the frame goes straight to the router, that the router's `isArmed` reads
  `channelArmed`, and that both arm sites hand a held notice over.

Red first (`guard-red.out`): `ℹ fail 3`, with these three failing:

- `no socket registration anywhere takes a variable frame name`
- `the wrapped set is exactly the handlers minus the transport ones`
- `the deleted agent notice is gated on arming by its own router, which reads channelArmed`

Then green: 81 pass across the two guard files and agent-unbound.

| # | Behavior broken | Changed line (server.ts) | Result |
|---|---|---|---|
| M27 | the router acts while stood down | `+ isArmed: () => true,` | KILLED (1) |
| M28.1 | held notice not handed over at the re-arm site | `- handleUnboundBeforeArm()` (deleted, line 17841) | KILLED (1) |
| M28.2 | held notice not handed over at the first arm site | `- handleUnboundBeforeArm()` (deleted, line 18639) | KILLED (1) |
| M29 | frame registered through a variable again | `+ realtimeSocket.on(UNBOUND_FRAME,` | KILLED (3) |
| M30 | the notice bypasses the router | `+ void onAssistantUnbound(payload)` | KILLED (1) |

The first delegated review ran before this fix. The second review (below)
covers it.

## Review

Two delegated reviews (feature-dev:code-reviewer), each given the code and
the brief's requirement, not my conclusions.

### First review (on 0672e86)

1. "The folder is archived after the uninstall deletes it." **False
   positive.** The reviewer read the working tree while mutation M13 was
   applied, so it saw that mutant. In the committed code the archive comes
   before the uninstall, and M13 is killed by both posix tests.
2. A replay that arrives at connect, before the daemon arms, was dropped.
   **Fixed** with the router's hold, handed over at both arm sites. M23
   guards it.
3. The systemd-run unit had no HOME or PATH, so `bgos-agent` could not run.
   **Fixed** with `--setenv`. M26 guards it.
4. and 7. Ack semantics: an ack before the cleanup finished could retire a
   notice whose cleanup then failed, and another agent's notice must not be
   acked. **Changed the design to never ack**, so the 7 day replay is the
   retry. M22 guards it.
5. The credentials were removed before the uninstall could refuse, which
   would leave an auto start that can never authenticate or be cleaned by a
   replay. **Fixed**: they are removed only after the uninstall succeeds. M25
   guards it.
6. On Windows, an unknown probe after unregister was treated as removed.
   **Fixed**: it is read back again with `agentTaskStatus`, and nothing
   continues unless the task is `absent`. M24 guards it.

### Final review (on e840f6e, the whole branch including the socket guard fix)

It found no serious defect. It confirmed:
- notices are judged by both ids, with the pairing taken from the
  credentials file
- the server confirms the delete
- every path uses the exact id
- the folder is only ever renamed, never deleted
- the Windows task must read back absent
- the cleanup runs out of the agent's process tree
- a replay does nothing
- the stand-down set is classified, with `channelArmed` cleared at every
  stand-down site and the held notice handed over at both arm sites

Its minor findings, and what I did:

1. The server.ts choices (own pairing, the read URL, the spawn arguments)
   were not tested. **Fixed** with a source-scan test. M36, M37 and M38
   guard it.
2. Other branches were not tested. **Covered**:
   - legacy `credentials.json` (M33, M34)
   - a service-run launcher is not signalled (M35)

   Still not unit tested: the late re-archive sweep, the legacy plist and
   unit names, the `systemd-run` fallback inside the bin, and the bin's
   `readLauncher`. They are listed as follow ups.
3. On Windows, the credentials were removed even when the folder never
   moved. **Fixed**: they are kept while the folder is still in place. M31
   guards it.

   The same review led me to a sharper case on macOS and Linux. If the
   archive failed, the cleanup still ran `bgos-agent uninstall`, whose state
   wipe would have DELETED the folder. **Fixed**: the cleanup stops before
   the uninstall, with the folder, auto start and credentials all kept, so
   the running service hears the replay and retries. M32 guards it.
4. On macOS and Linux, an uninstall that refuses after the folder has moved
   leaves a service whose `run.sh` is gone, so nothing hears the replay.
   **Kept as a known trade-off**: the archive must come first, or the
   uninstall deletes the state. Logged, and listed as a follow up.
5. If the launch stage cannot start the run stage, the daemon still stops
   itself. Under a service it restarts and hears the replay again; when run
   by hand, it does not. **Follow up.**

## Gates

- `npx tsc --noEmit`: clean (rc 0) on the final code.
- `test/agent-unbound.test.ts`: 37 pass, 0 fail. With the two guard files (pairing-lock-standdown, mission-ws-wiring): 86 pass, 0 fail.
- **The plugin's own test command, `npm test`, is GREEN on the final code**
  (2d8c804): rc 0, and `[run-tests] both families green` (`npmtest-final.out`).

  | Family | Tests | Pass | Fail | Skipped |
  |---|---|---|---|---|
  | node:test (384 files) | 7856 | 7809 | 0 | 47 |
  | real Chromium (7 files, one at a time) | 15 | 11 | 0 | 4 |
  | bun:test (14 files) | 375 | 374 | 0 | 1 |

  It was run with `TMPDIR=/private/tmp/claude-501/mbt/` (a private 0700
  folder) and bun on PATH. The command and the code are unchanged.

- **Why TMPDIR matters on this Mac.** The first runs used the default macOS
  TMPDIR, `/var/folders/.../T`.
  - In that setup `npm test` hung for over an hour on two browser-profile
    files. The parts I ran with a timeout showed 39 failures plus 9 failures
    and 2 never-finishing tests in those two files.
  - main c636ded gave the identical results, in tests that do not import
    anything this branch changes.
  - The cause: `lib/browser-profile-core/profile-file-staging.js:58` lstats
    every ancestor of a path and refuses a symlink, and on macOS `/var` is a
    symlink to `private/var`. So every browser-profile test that works under
    `os.tmpdir()` is refused here: it fails or waits forever.
  - With a TMPDIR that has no symlink in its path, those same files pass
    (`browser-profile-files` 23 of 23; the two "hanging" files 34 of 34 in
    5 s), and then the whole suite passes.
  - CI (`.github/workflows/tests.yml`, Ubuntu and Windows on node 24) has no
    such symlink. This lane does not touch that code; it is a follow up.
- One failure WAS caused by this branch: the socket guard (above). It is
  fixed, and it passes in the green run.
- No em or en dash anywhere in the diff (checked with grep for U+2013 and
  U+2014 over `git diff main`).
- This repo has no frontend, backend, `.claude/rules` or
  `docs/CORE-CONTRACTS.md`, so those gates do not apply. Nothing visual
  changed, so the light and dark checks do not apply.

## Follow ups

1. **No ack.** A delete notice keeps replaying to the pairing for 7 days. The
   daemon's lookup is idempotent and cheap: a present row does nothing, and
   once the cleanup is done there is nothing left to clean. A backend-side
   "cleanup done" report could retire the row instead.
2. **Re-pair or hand-over.** When the server still returns the row, the
   agent is not cleaned on the old computer. That case needs its own backend
   signal.
3. **A hand-run plain claude** (no hoai launcher) only loses its channel
   through the daemon's 15 s self-stop. Its claude process is not ended.
4. **macOS and Linux: an uninstall that refuses after the folder has moved**
   leaves the plist or unit without its `run.sh`, so nothing hears the
   replay. The credentials stay and the run log says what happened. Fixing
   it would mean splitting the service removal from the state wipe in
   `bgos-agent uninstall`.
5. **The launch stage cannot detect a failure to start the run stage.** The
   daemon still stops itself 15 s later. Under a service it restarts and
   retries on the replay; when run by hand, it does not.
6. **Not unit tested**: the late re-archive sweep, the legacy plist and unit
   names, the bin's `systemd-run` fallback, and the bin's `readLauncher`.
7. **Linux without systemd-run**: the detached child stays in the agent's
   cgroup and can die halfway through the uninstall. The credentials are then
   kept and the replay retries.
8. **Windows**: a task whose folder is already gone cannot be probed or
   removed through the watcher's uninstall, because that needs the
   registration built from the folder.
9. `~/.bgos-plugin-state/<id>` is not archived.
10. CHANGELOG: there is no unreleased section and no version bump was
   allowed, so the entry is left for the release.
11. The server.ts wiring is covered only by source scans and by the router
    and handler lib tests. No test runs the daemon itself.
12. The doctor does not list archived agents under `.removed`.
13. **Browser-profile tests on macOS** (not this lane's code): they refuse the
    default `/var/folders` TMPDIR because `/var` is a symlink, so a plain
    `npm test` on a Mac fails and hangs on main as well. The fix is either to
    realpath `os.tmpdir()` in those tests, or to document a TMPDIR for local
    runs.
