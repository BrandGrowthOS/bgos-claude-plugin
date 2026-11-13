# deafwatch evidence (0.87.6, 2026-11-13)

The watcher now checks that an agent's channel is live, not only that its claude process runs (Ares's PC: antivirus removed `bin/bgos-launch.mjs`, the channel died with MODULE_NOT_FOUND, the agent sat deaf for 11 hours while the watcher reported it supervised).

| File | What it shows |
|---|---|
| `live-sweep.mjs` | The real keep-alive sweep against the real process table and a real file system on a throwaway HOME: a live `claude --resume <pin>` with no MCP server under it and `bin/bgos-launch.mjs` removed. Acts (systemctl and the like) are printed, never run. |
| `live-sweep.out.txt` | This branch: sweep 1 (seconds after the launch) leaves the slow start alone; sweep 2 (six minutes on, its transcript written a minute before, as on Ares's PC at 17:29Z) restarts it once through its service and reports `failed no-channel-heartbeat: missing bin/bgos-launch.mjs; no live channel (agent_deaf_after_restart)`. Exit 0. |
| `live-sweep.main.out.txt` | The same script against main before the fix: both sweeps say `supervised`. Exit 1. |
| `mutants.txt` | Fifteen one-line mutants of the new guards (start grace, fresh beacon, a daemon with no beacon yet, the sweep's channel check, the held failure, the named files, cwd-only claudes, the check up's grace and file names, the pending kind, the files cleared once live, and M12 to M15 for the recent activity lift: absent in the sweep, taken on an unknown start, lifting the job hold, absent in the check up): every one turns named tests red. |

Run from the plugin root: `node docs/evidence/2026-11-13-deafwatch/live-sweep.mjs`.
