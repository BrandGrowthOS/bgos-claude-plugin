# Two state roots per agent, and why a restart needs a silent probe to prove the session hears the channel

**Date:** 2026-08-25

**Context:** The watcher restarts agents and must verify each one answers before calling the job done ("Connected" is never proof; proof is the session ACTING on a channel event). Wiring that verify exposed where the plugin actually keeps its state.

**Gotcha / Pattern:**
- Two roots, two owners. `~/.bgos-agent/<assistantId>/` belongs to the LAUNCHER (`bin/hoai-core.mjs`): `supervisor.json` (pid + capabilities), `restart-requested.json` (the marker), `session-id` (the pinned id), `launch.json` (the relaunch recipe: cwd, argv, install method, plugin root, node, `claudeConfigDir`), `probe-requested.json`. `~/.bgos-plugin-state/<assistantId>/` belongs to the DAEMON (`server.ts`): `chat-cursors.json`, `auto-update.json`, and `channel-live.json` (`firstLiveAt` / `lastLiveAt`). The machine id is at `~/.bgos-agent/machine-id`; the watcher bundle at `~/.bgos-agent/watcher/`. A verify that looks for the liveness marker in the launcher root finds nothing and rolls back a healthy update.
- `channel-live.json` is refreshed only when the session CALLS a tool through the plugin (boot hello + the first tool call). After a routine restart nothing touches it until a human speaks, so `lastLiveAt` stays older than the restart and an honest verify would fail every quiet agent. Hence the silent probe: the watcher writes `probe-requested.json`, the daemon (polling every 30s) pushes one channel notification asking the session to call the `channel_ack` MCP tool (no user-visible output), the tool call writes the marker, and the verify accepts only `lastLiveAt > restartedAt`. In the E2E the round trip took 15 to 36 seconds; a logged-out session never answered and was correctly rolled back.

**How to apply next time:** Any new liveness or restart feature must name which root it reads and which process writes it. Never treat a heartbeat, a WS connect, or a fresh pid as proof the model can act; require a tool call after the restart timestamp, and log the probe on both sides so a deaf agent is diagnosable from the logs alone.

**Regression guard:** `test/agent-verify.test.ts` (marker newer than restart, stale marker, missing file), `test/channel-ack.test.ts` (tool writes the marker), `test/boot-hello.test.ts`, `test/watcher-core.test.ts` (probe written, verify via the live marker).
