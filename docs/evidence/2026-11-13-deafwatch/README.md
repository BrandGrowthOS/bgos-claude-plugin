# deafwatch evidence (0.87.6, 2026-11-13)

The watcher now checks that an agent's channel is live, not only that its claude process runs (Ares's PC: antivirus removed `bin/bgos-launch.mjs`, the channel died with MODULE_NOT_FOUND, the agent sat deaf for 11 hours while the watcher reported it supervised).

Round 2 (review rvdeafwatch) added three rules:
- a deaf channel is acted on only once every minute's sweep has seen it deaf for two minutes in a row, so a laptop waking from sleep is not restarted before its daemon ticks (F1);
- the launcher's `claude-login-expired` for the claude being judged is reported as the login and never restarted (F2);
- a channel that comes back and dies again within 30 minutes is one episode (F5).

| File | What it shows |
|---|---|
| `live-sweep.mjs` | The real keep-alive sweep against the real process table and a real file system on a throwaway HOME: a live `claude --resume <pin>` with no MCP server under it and `bin/bgos-launch.mjs` removed. Acts (systemctl and the like) are printed, never run. |
| `live-sweep.out.txt` | This branch, exit 0. Sweep 1 (seconds after the launch) leaves the slow start alone. Sweep 2 (6 min) is a first deaf look and acts on nothing. Sweep 4 (8 min, its transcript written a minute before, as on Ares's PC at 17:29Z) confirms it and restarts it once through its service, reporting `failed no-channel-heartbeat: missing bin/bgos-launch.mjs; no live channel (agent_deaf_after_restart)`. Sweep 5 (9 min, the launcher having written `claude-login-expired`) reports `failed claude-login-expired: ...` and restarts nothing. |
| `live-sweep.round1.out.txt` | The same script against round 1 (3b55728), exit 1: it restarts on the first deaf look, and keeps calling the failed login `no-channel-heartbeat`. |
| `live-sweep.main.out.txt` | The same script against main before the fix, exit 1: every sweep says `supervised`. |
| `mutants.txt` | One-line mutants of the new guards, every one turning named tests red. M1 to M15 (round 1): the start grace, the fresh beacon, a daemon with no beacon yet, the sweep's channel check, the held failure, the named files, cwd-only claudes, the check up's grace and file names, the pending kind, the files cleared once live, and the recent activity lift. Round 2: K2, K3, K4 and K6 (the review's surviving mutants: the newest claude judged, the keepalive's and the daemon parent's claude counted, an unreadable file not named) and N1 to N9 (the two minute confirmation, the gap rule, the run cleared once not deaf, the login verdict in the sweep and the check up, and the episode kept through a short live spell). |

Run from the plugin root: `node docs/evidence/2026-11-13-deafwatch/live-sweep.mjs`.
