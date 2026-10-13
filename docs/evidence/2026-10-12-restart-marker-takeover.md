# A restart marker an old hoai launcher no longer acts on (Windows, agent 909)

**Date:** 2026-10-12. **Reported by:** Data and Mark (agent 909, Vera). **Fix:** 0.68.3.

## The report

On Windows, an agent run by an old hoai launcher (0.44.0 `bin/hoai`, or one a
fleet script starts from a 0.66.1 checkout) whose claude runs the 0.67.5 daemon
did not restart when `%USERPROFILE%\.bgos-agent\909\restart-requested.json` was
written: write 1 vanished with claude on the same pid, write 2 stayed for more
than a minute, and a fresh 0.66.1 launcher deleted a marker without a restart.
A 0.67.5 launcher that hoai-switch had just started honoured one (17:16:58), and
9 s after that restart a 2-byte `{}` marker restarted the agent a second time
(17:17:10). The theory was that the launcher asks the daemon to make claude
exit and the 0.67.5 daemon no longer does.

## Cause 1: the launcher's relaunch budget latch (not the daemon)

The launcher never asks the daemon or claude for anything, at any version. Only
`bin/hoai-core.mjs` deletes the marker; the daemon only writes one
(`lib/update-rpc.ts:557`, `server.ts` writeMarker) and so does the watcher
(`lib/agent-restart.mjs:242-245`). `bin/hoai-core.mjs` is byte identical at
v0.66.1, v0.67.5 and main.

| what | main = v0.67.5 = v0.66.1 | v0.44.0 |
| --- | --- | --- |
| 3 marker relaunches per rolling hour, per launcher process | `:889`, `:890` | `:668` |
| `let exhausted = false`, once per process, never reset | `:2228` | `:1684` |
| `if (exhausted \|\| restartRequested \|\| !childRef) return` before the marker is looked at | `:2293` | `:1733` |
| `removeFile(markerPath)` BEFORE the budget decision | `:2295` | `:1735` |
| `decideMarkerRelaunch(...)` | `:2296` | `:1736` |
| deny: `exhausted = true`, a console line only, no kill | `:2299` | `:1739` |
| a launcher that arms deletes any marker already there (stale rule) | `:2159` | `:1629` |

The fourth marker in an hour is deleted and ignored (claude keeps its pid); from
then on every marker stays on disk for the life of that launcher. Three update
restarts in an hour (0.67.3, 0.67.4 and 0.67.5 were tagged within 53 minutes,
and an update restart through a live launcher is a marker) spend the budget by
themselves. Nothing in the marker path reads the daemon version; the 0.67.5
launcher worked because hoai-switch had just started it (a fresh budget). The
fresh 0.66.1 launcher that deleted a marker without a restart is the stale rule
at `:2159`.

## Cause 2: the keep-alive sweep wrote onto the session after the one it judged

Only `lib/agent-restart.mjs` `writeRestartMarker` writes exactly `{}`. Its one
automatic caller is the keep-alive sweep's update restart
(`lib/watcher-keepalive.mjs`, main `:938`, v0.67.5 `:896`). The sweep reads the
daemon's `agent-state.json` once, then awaits a PowerShell process listing
(seconds on Windows), then writes the marker with nothing asked again. A person's
marker that restarts claude during the listing gets a second, unrequested
restart on top of it.

## What is real in the runs, and what is not

Real: launchers from v0.44.0 and v0.66.1 checkouts, the main daemon (`bun
server.ts`, unchanged since v0.67.5), the v0.66.1 daemon, the fixed daemon, the
real `claude.exe` 2.1.296 in a hidden console with the launcher's own win32 gate
helper, real marker files, real kills, a scratch HOME on E:.

Substituted: claude is never signed in. It runs on a dummy API key whose
`ANTHROPIC_BASE_URL` is a local fake backend, so no request leaves the machine;
it reaches its prompt, starts its MCP servers, resumes a seeded transcript with
`--resume`, and is supervised exactly as in the field ("Channels are not
currently available" on screen, which needs a claude.ai sign-in). The BGOS API is
a local catch-all fake. The harness is in `2026-10-12-restart-marker-takeover/`
(`repro.mjs`, `fake-backend.mjs`, `scoped.mjs`, `tee.mjs`, `screendump.ps1`).

## Reproduction (before the fix)

Five marker writes, about 30 s apart, one launcher process:

| run | launcher | daemon | writes 1-3 | write 4 | write 5 |
| --- | --- | --- | --- | --- | --- |
| r3 | v0.66.1 | main | restarted | gone in 3 s, `restart marker ignored`, no restart | stays |
| r4 | v0.66.1 | v0.66.1 | restarted | gone in 3 s, `restart marker ignored`, no restart | stays |
| r5 | v0.44.0 | main | restarted | gone in 3 s, claude pid 112932 unchanged | stays |

The v0.66.1 daemon fails exactly as the main daemon does. r6: once the budget is
spent, ending claude from outside makes the interactive v0.66.1 launcher return
(exit 1) and remove supervisor.json, so the agent stays down: a daemon that only
"makes claude exit" would take the agent down. v0.44.0 has no `--keep-alive`. r7:
a detached child spawned by the bun daemon survives claude's TerminateProcess and
the launcher's exit (it kept writing for 30 s until the teardown).

## The fix, measured live (the fixed daemon, real claude.exe)

These runs were made before the branch was rebased onto main, when its version
string was still 0.68.2 (the daemon logs `v0.68.2`); the code is the 0.68.3 fix.

g1, v0.66.1 interactive launcher, six writes 90 s apart, seeded transcript:

- writes 1 to 3: the launcher relaunched `--resume 7c1d2e3f-...` itself; the
  daemon logged `marker seen` and died with its claude;
- write 4: `[hoai] restart marker ignored`, the marker gone 140 ms later, and
  10 s later `restart takeover: ACT (swallowed)`; the helper planned
  `recipe-hidden`, ended claude 79848, saw launcher 40508 exit, settled 20 s,
  launched the hidden recipe, and logged `agent 909 is back: launcher pid
  153392, daemon pid 64152, session pin 7c1d2e3f-... (same)`, 28 s in all;
- writes 5 and 6: the new launcher (a fresh budget) relaunched `--resume` itself;
- at the end: ONE claude.exe (74200, parent 153392, `--resume 7c1d2e3f-...`),
  one ledger entry, nothing left over after the teardown.

g2, v0.66.1 `--keep-alive` launcher (what the "HOAI Agent <id>" task runs), seven
writes: writes 1 to 3 relaunched by the launcher; write 4 swallowed, taken over,
`route keep-alive`, `launcher 180356 relaunched claude itself; nothing started`;
write 5 stranded on disk, claimed as `restart-requested.claimed.json`, the same
path; write 6 stranded, takeover 3 of 3; write 7 `REFUSED (loop guard): 3 takeovers in the last hour (next slot 15:59:10Z)`, the marker kept as `restart-requested.refused.json`, claude untouched. At the end: ONE claude.exe (parent 180356, the same launcher, `--resume 7c1d2e3f-...`), three ledger entries, the claimed and the refused marker on disk with the writer's bytes. The task path keeps working: the keep-alive launcher relaunches itself and the helper starts nothing.

g3, v0.44.0 launcher (no `--keep-alive` there), five writes: writes 1 to 3 relaunched by the launcher; write 4 `restart marker ignored`, then `ACT (swallowed)`, `route recipe-hidden`, claude 101964 ended, launcher 126020 exited, the hidden recipe launched, `agent 909 is back: launcher pid 9340, daemon pid 141080, session pin 7c1d2e3f-... (same)`, 30 s in all; write 5 relaunched by the new launcher. At the end: ONE claude.exe (parent 9340, `--resume 7c1d2e3f-...`), nothing left over.

## Tests

Red at main for the stated reason, green on 0.68.3: `test/marker-takeover.test.ts`,
`test/restart-handoff.test.ts`, `test/marker-takeover.integration.test.ts` (the
real launcher loop spends its budget, then the real daemon side, helper,
inventory and ladder bring the agent back on the same pin),
`test/marker-takeover.wiring.test.ts`, and the additions to
`test/agent-inventory.test.ts`, `test/keepalive-plan.test.ts` and
`test/watcher-keepalive.test.ts` (the race reproduced inside the sweep's
listing; a person's marker on disk; a session 9 s old).
