# A Windows cold start whose gate helper logged `accepted` without `attached` (agent 888)

**Date:** 2026-10-16. **Reported by:** Data and Mark (agent 888). **Board row:** d806c69f. **Fix:** 0.69.7.

## The report

16 Oct 07:59Z, a cold start right after logon (launcher pid 25088, claude.exe 25184).
`win32-gate-helper.log` showed `start`, then `accepted` 16 s later, but no `attached`; every earlier
boot had all three. claude.exe stayed alive and never spawned its MCP server, so 888 sat offline
for 10 minutes until a restart marker recovered it. hoai-switch's PASS greps only `accepted`.
Mark's hypothesis, unverified: the console was not ready right after logon.

## The path (main 035cec9, 0.69.6)

| what | where |
| --- | --- |
| the helper's exit codes: 0 accepted, 2 attach failed, 3 inject failed, 4 timeout (5, add-type failed, undocumented) | `bin/win32-accept-dev-channels.ps1:21`, `:59` |
| `Note`: `try { Add-Content ... } catch {}` | `:28-30` |
| `start` | `:31` |
| `attached`, right after `AttachConsole` succeeds | `:62` |
| `accepted` then `exit 0`, the moment `WriteConsoleInputW` returns true | `:94` |
| the argv | `bin/hoai-core.mjs:1291` `win32GateHelperArgs` |
| the spawn: not detached, hidden, stdout and stderr on the log opened for append | `bin/hoai-core.mjs:1507-1528` `defaultSpawnGateHelper` (`:1514`, `:1520`) |
| hoai spawns it after claude, prints its pid, returns claude's exit and never listens to the helper's | `bin/hoai-core.mjs:2002-2007` |
| hoai-switch's PASS check | not in this repo (no BrandGrowthOS repository indexes it); left as it is |

So `accepted` could be written without `attached` in exactly one way: the `attached` write failed
and `Note` hid it. The only ways out of the script that touch the log after `start` are its
`Note` calls, in that order, and nothing else writes `attached`.

## Cause of the missing line (proven on scratch files and a fake console)

PowerShell 5.1's `Add-Content` refuses a file that any other process has open for reading, even a
reader that shares read, write and delete, and it raises a NON-terminating error, which a bare
`try { } catch {}` never sees (scratch file, PowerShell 5.1.26100):

    reader, share ReadWrite -> Add-Content FAILED: The process cannot access the file ... because it is being used by another process.
    reader, share Read -> Add-Content FAILED
    appender, share ReadWrite -> Add-Content written
    reader, share ReadWrite+Delete -> Add-Content FAILED
    (the helper's Note shape wrote nothing in each failed case and went on)

`reproduce-888.mjs` (this folder) runs the REAL helper the way hoai spawns it, against a hidden
console holding a small node program that shows the gate's marker text and waits for one Enter
(never a real claude), with one other reader holding the log from `start` until `attached` has
been tried. With the 0.69.6 helper:

    fake gate pid 100392 in its own hidden console
    a reader holds the log from +765 ms
    reader closed at +1174 ms; showing the gate
    helper exit code: 0
    fake gate got its Enter: yes
    --- win32-gate-helper.log
    2026-10-16T18:36:18.0313203+04:00 pid=136296 start console=100392 timeout=60
    Add-Content : The process cannot access the file
    'E:\bgos-worktrees\gateattach\tmp\repro-old\win32-gate-helper.log' because it
    is being used by another process.
    ...
    2026-10-16T18:36:19.0375430+04:00 pid=136296 accepted

That is 888's shape, plus the refusal text, which the helper's stderr writes into the same log. With
the 0.69.7 helper, same run (its writer shares read, so the reader no longer refuses it):

    a reader holds the log from +647 ms
    reader closed at +4758 ms; showing the gate
    helper exit code: 0
    fake gate got its Enter: yes
    2026-10-16T19:18:55.4034653+04:00 pid=52312 start console=115900 timeout=60
    2026-10-16T19:18:55.5763441+04:00 pid=52312 attached
    2026-10-16T19:19:00.2431650+04:00 pid=52312 accepted

Only a log that nothing can write (held with no sharing at all) still loses lines; the helper then
presses Enter, says `log write refused, one line lost: ...` on stderr and exits 6
(`test/win32-gate-helper.console.test.ts`). The same writer on scratch files: a held reader, hoai's
own append handle, and two writers appending 300 lines each at once (600 of 600 lines, none torn).

What held 888's log open at 07:59Z is not known from here (the real logs were not read). Anything
that opens a just-changed file for reading qualifies: a search indexer, an antivirus scan, a person
or a script reading the log.

## What is NOT proven

- That 888's gate stayed up. In the reproduction the gate got its Enter although the log shows the
  888 shape, so the shape alone does not explain why claude never started its MCP server. Nothing on
  888 recorded what claude was waiting on.
- Mark's hypothesis, a console not ready right after logon. It was not reproduced, and the rules
  for this work forbid running the helper against a real claude, so no bounded wait or retry of the
  attach was added: it would be a fix for a cause nobody has shown.

## The fix (0.69.7)

- The cause of the missing line: the helper appends through a FileStream opened append-only that
  shares read, write and delete, so no reader can refuse it. A write that still fails is retried
  for about a second and reported on stderr.
- a. The helper exits 0 only with both `attached` and `accepted` on record; an Enter without both
  is exit 6 and an `unproven:` line (neither word in it). An unattended hoai relaunches claude for a
  6 through the restart marker's own relaunch and budget (3 per rolling hour), on the agent's own
  session.
- b. `gate-proof.ps1` (this folder) passes a start only on `start`, `attached` AND `accepted` from
  one helper pid of THIS agent's launcher (the log is shared by every agent of the Windows user),
  then a daemon boot within 3 minutes and a channel beacon after it.
- c. An unattended hoai relaunches, ONCE, a launch whose channel beacon (`channel-beacon.json`)
  has not been written 3 minutes after it started; the next such launch is recorded as
  `no-channel-heartbeat` in launch-status and left running. This covers a gate that swallowed its
  Enter, whatever the log says.

## Mark's proof for 888, after the release

1. Update 888's plugin to 0.69.7, then log off and on (the cold start this is about), or restart
   the agent's task. The running launcher keeps the code it started with.
2. Within 5 minutes of logon, in a PowerShell window on 888's PC:

       powershell -NoProfile -ExecutionPolicy Bypass -File <plugin root>\docs\evidence\2026-10-16-gate-attach\gate-proof.ps1 -Id 888

   It reads files only and saves its report to `%TEMP%`. It judges only helpers whose `start` names
   888's launcher (the pid in `.bgos-agent\888\supervisor.json`), so another agent's helper on the
   same PC cannot pass for 888.
3. These lines must appear in `%USERPROFILE%\.bgos-agent\logs\win32-gate-helper.log`, from ONE pid:

       <time> pid=N start console=<launcher pid> timeout=120
       <time> pid=N attached
       <time> pid=N accepted

   then `[bgos] Starting BGOS channel plugin` in `logs\bgos-plugin-888.log` after them, and
   `channel-beacon.json` in `%USERPROFILE%\.bgos-plugin-state\888\` written after them. The script
   prints `RESULT: PASS`.
4. If the start was not clean, the fix shows it instead of a silent offline agent:
   `pid=N unproven: ...` and `outcome=health-relaunch reason=gate-accept-unproven` in
   `.bgos-agent\888\launch-status`, followed by a second helper's `start`, `attached`, `accepted`;
   or, 3 minutes in, `outcome=health-relaunch reason=no-channel-heartbeat`, and at worst
   `outcome=no-channel-heartbeat` 3 minutes after that (reported, not relaunched again).
5. For the 07:59Z boot itself: `gate-proof.ps1 -Id 888 -Since 2026-10-16T07:55:00Z -ConsolePid 25088`
   shows that boot's helper lines and counts any Add-Content refusal text the old helper left in
   the log around it. Present, it confirms the
   cause of the missing line on 888; absent, the line was lost some other way.
