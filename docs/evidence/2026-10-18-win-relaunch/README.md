# Windows relaunch, real proof with a fake claude (2026-10-18)

HOAI board row 978da5db, points 1 (kill the whole tree) and 2 (no Enter on a stale gate).

`relaunch-proof.mjs` runs the real `superviseClaude` unattended in a hidden console of its own, with
claude installed the npm way (cmd-shim's `claude.cmd`) and a FAKE claude behind the shim, and the real
gate helper (`bin/win32-accept-dev-channels.ps1`, powershell.exe 5.1). Launch 1's fake claude draws the
gate in the alternate screen and ignores the Enter; the script then writes the restart marker, as the
daemon does for an update. Launch 2's fake claude takes 4 s to draw its gate (a cold start).

Each run went through a refuse-unless-scratch runner: HOME, USERPROFILE, LOCALAPPDATA, APPDATA, TEMP,
TMP and TMPDIR under the worktree's scratch folder, every BGOS_ and HOAI_ variable removed. Process
listings print pid, parent pid and name only. Every process a run started was ended by the pids it
recorded; each log ends with "left running afterwards: (none)".

| Run | core | launch 1 fake claude alive after the relaunch | launch 2 helper pressed before its gate | launch 2 gate answered |
| --- | --- | --- | --- | --- |
| `proof-main.log` | main (64af2f6) | **true** | (gate never drawn) | false |
| `proof-fix1-only.log` | point 1 only (b4dabf8) | false | **true** (07:25:48.440, gate at 07:25:51.365) | false |
| `proof-fix1-and-2.log` | points 1 and 2 (b4f6584) | false | false (gate at 07:27:36.210, Enter at 07:27:36.291) | true |
| `proof-final.log` | the final tree (74d85f5) | false | false (gate at 08:03:27.836, Enter at 08:03:28.075) | true |

On main both fake claudes froze once launch 2 put the console in raw mode: two readers on one console,
which is point 1's survivor at work. With point 1 alone, launch 2's helper found launch 1's gate still on
the console and pressed Enter 3 s before launch 2 drew its own; the fake claude got an Enter with no gate
on screen and its real gate was never answered. With both, the console is cleared before launch 2 and the
helper presses only once launch 2's gate is up.

The first three runs ended the tree with `taskkill /T /F`. The review then found that /T also ends what
the daemon detaches to outlive claude (its browser host, a person lane's supervisor), so the final tree
ends only the shim's own children and the shim (`endWin32ShimTree`); `proof-final.log` is that tree, and
`test/win32-relaunch.console.test.ts` shows the detached process living on.

Run it again (Windows, from the repo root, through a scratch runner):

    node docs\evidence\2026-10-18-win-relaunch\relaunch-proof.mjs --core bin\hoai-core.mjs --label again
