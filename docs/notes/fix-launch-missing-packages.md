# An agent starts even when an update left out its packages

Branch `fix/launch-missing-packages`, off main 6a787b34 (0.90.0). Working notes.

## First note: the four questions

**1. What would a top engineer do here that was not asked?**

- Treat a half finished install as missing, not only an empty folder. Measured: an offline `bun install --frozen-lockfile --production` fails in about 1 s and leaves a node_modules with some packages in it. So the check walks the whole production closure (transitive packages included), resolving the way node and bun do, and never looks at devDependencies, optional or peer ones.
- Plan for several agents on one machine starting the same new version at once (a machine with seven agents all updated together). One start fixes the folder under a lock inside it; the others wait and start as soon as the packages are there. A lock whose holder died is taken over with that holder's half copy.
- Keep the MCP channel clean: the launcher's stdout is the MCP stdio pipe, so the install's stdout is ignored and only its last stderr line is kept for the plain message.
- Keep relative links relative when copying (`verbatimSymlinks`), or the copy would point into the sibling and break when Claude Code sweeps the old folder. Clone on APFS (`COPYFILE_FICLONE`), so on a Mac the copy costs almost nothing.
- Never make a working start worse: the common start (packages present) still spawns bun in the same tick as before, and a check that throws starts bun anyway.
- Bound the install loop, not just the install: one attempt per 10 min per folder, recorded in the folder, so a supervisor restarting a dead agent never turns into a stream of installs.
- Fit the whole check inside Claude Code's wait for the MCP server, which does not try a stdio server again by itself. A start waits at most MCP_TIMEOUT less 5 s (25 s when unset) for everything together. An install still going then runs on by itself under a small keeper, which caps it, records how it went and lets go of the folder, so the next start finds the packages.
- Never let the check be the reason a start fails that worked before: an install that exits 0 is believed over the check (and remembered, so it costs no install per start), and when the check cannot help at all (only bunx, a folder it cannot write) bun starts as before.
- Say where the brief and the code disagree: the watcher line the trace names (`bin/hoai-watcher.mjs` missingBundleModule) gates the watcher's own bundle self repair. It never sees the agent server's errors. The match is fixed as asked, but it does not by itself recover the agent; the launcher change does.

**2. What would they start from?**

The field failure itself, reproduced: a version folder with package.json and bun.lock but no packages, run through the real launcher with node and the real bun, offline. Before the change it ends with bun's own `error: Cannot find package 'dep-a' from '.../server.ts'`, the exact Mac failure.

**3. Which tools?**

- `git.exe` inside the tree (its gitdir is a Windows path); `gh.exe pr diff`, read only, for #363 and #292.
- node.exe and bun.exe through interop for the suite; Linux node 24 and bun 1.3 from a local tools folder for the same tests on posix paths with real symlinks.
- `node --import tsx --test` for single files and `scripts/run-tests.mjs` for the suite, both under `heavy`; `tsc --noEmit`.
- A throwaway mutation script outside the tree: one mutant per rule, run, restore, check sha256.

**4. What would prove it right, independent of the implementer?**

- The real launcher, the real bun, offline: an empty folder beside a sibling starts and its imports (transitive ones included) resolve; with no sibling it exits 69 with one line and does not install again on the next start.
- The same with the real 80 MB node_modules and a probe that imports exactly what server.ts imports; and a real online install into an empty cache (15 s, 99 packages, no devDependencies).
- Mutants: every rule's mutant turns a test red.
- CI on Linux, Windows and macOS, which runs the symlink test that this Windows account cannot.

## Decisions

- Exit code 69 (EX_UNAVAILABLE). 127 stays "no bun".
- One wait per start, a little under Claude Code's: MCP_TIMEOUT less 5 s, 25 s when it is unset (the docs give no default; about 30 s is the common figure), never more than 120 s. The install itself is capped at 10 min by its keeper, since it outlives the start.
- The lock: a folder made whole under a work name and renamed into place, with an owner record (pid, the install's pid, time, token). A holder is alive while either pid is alive and for at most 11 min. A takeover renames the lock aside and checks the token again; a lock that cannot go back stays aside, never deleted. A release only removes a lock that still has its token. Every pass that cannot make progress sleeps and checks the deadline.
- Directory renames retry on EPERM, EACCES and EBUSY for about 4.5 s, for a Windows virus scanner holding new files.
- No version bump, CHANGELOG entry or manifest change in this branch: #363 changes those same lines. The version check in CI needs a bump at merge time.
- Work names inside the version folder: `.bgos-packages.lock/` (and `.new-*`, `.stale-*` while it moves), `.bgos-node_modules.partial-<pid>/`, `.bgos-node_modules.old-<pid>/`, `.bgos-packages-attempt.json`, `.bgos-packages-install.log`, `.bgos-packages-copy.json` (while a copy runs). A start holding the lock clears the half copies of starts that are gone.

## Review

Two fresh reviews. The first found the install could outlast Claude Code's wait, a live holder's lock could be deleted, two starts could take over one dead lock, renames were not retried on Windows, and an install that exited 0 could still stop the start. The second, on the rework, found a takeover that could spin forever, a wait counted per step instead of per start, a put back that could delete a live lock, a lock trusting a bare install pid, and a disputed install costing an install per start. A third found that a copy too slow for the wait, if Claude Code kills the start, would repeat on every start, and that the owner record was rewritten in place, so a start could read it empty and break a live lock. A start now records a copy while it runs (a record left by a start that is gone sends the next one to the install), the owner record is written aside and renamed over, a release moves the lock to its own name before removing it, and lock leftovers of gone starts are cleared. Each has a test and a mutant now.

## Not proven here

- That the install survives a kill of the start (the `detached` flag): a test cannot kill its own parent. Reasoned from node's documented behavior: its own process group on macOS and Linux.
- Claude Code's MCP_TIMEOUT default: not in its docs.
- Whether Claude Code on Windows stops a server with its whole process tree (which would take the detached keeper with it, leaving bun's install uncapped and unrecorded until the lock goes stale).
- An install that exits 0 after its start stopped waiting, while the check still disagrees: the keeper only clears the attempt, so the next start installs once more before the dispute is remembered.
- The suite's browser, Chromium and vault failures on this machine also fail on unchanged main here (a sample of 12 files run on a clean checkout of 6a787b34).

## Measured

- Check with every package present, median: 4.2 ms on a Linux local filesystem (9 ms cold), 25 ms with Windows node on an NTFS drive. 616 ms with Linux node over the WSL file share, which is that share's cost per file operation, not a real machine.
- Offline copy of the real node_modules (80 MB): about 4 s on Windows, start included.
