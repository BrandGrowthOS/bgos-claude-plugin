# The launchd proof (for Data's Mac)

The Windows rig (docs/idle-update/rig) proves the idle update on the hidden logon task.
This script proves it on the shape that failed on Alex's Mac. In that shape, launchd runs
`run.sh`, which starts hoai in a detached tmux server on the agent's own socket. The launchd
job never owns the daemon, so before this branch the restart ladder could only stage.

## Run it

From this checkout, on the branch, logged in to the Mac's desktop (launchd's `gui/<uid>`
domain needs a login session, so SSH alone is not enough), after `bun install`:

```
bash docs/idle-update/macos-proof.sh
```

It needs bun, node, expect, tmux, git, launchctl, plutil and `/usr/libexec/PlistBuddy`. It
takes about 10 minutes: up to 4 for the daemon to arm, then about 4 for the quiet window
and jitter at scale 5, then 1 to validate, plus a 2 minute watch for a second restart.

The last line is `MACOS PROOF PASS`, or `MACOS PROOF FAIL: <what>`. The evidence stays in
`/private/tmp/idleupd-proof.<pid>/`: the daemon log, the stub's requests, the session
launches, and the install, restart and teardown logs.

## What it does

1. Builds two copies of this checkout, 0.81.0 and 0.81.1, into a scratch HOME's marketplace
   cache (`<home>/.claude/plugins/cache/hoai/hoai/<version>`). `installed_plugins.json`
   points at 0.81.0, and `settings.json` enables `hoai@hoai`.
2. Compiles the rig's stand-in `claude` into `<home>/.local/bin/claude`. It does no model
   work. It starts the plugin's MCP server as Claude Code does, runs its hooks, keeps the
   session transcript, and logs every launch.
3. Starts the rig's stub backend on `127.0.0.1:<43000..48999>`. It answers always-on true,
   so the daemon's always-on grace never uninstalls the job mid proof, and it never sends a
   watcher install.
4. Installs agent 7300001 with the real installer, `bin/bgos-agent install --always-on
   --no-clone`, run from the 0.81.0 cache copy with a clean environment (HOME = the scratch
   HOME). It then adds `BGOS_IDLE_UPDATE_SCALE=5`, `HOAI_BROWSER_HOST=off` and
   `HOAI_RIG_DIR` to the scratch plist and restarts the job.
5. Waits for `idle update: armed on 0.81.0`, then stages 0.81.1 by repointing
   `installed_plugins.json`, as Claude Code's own update does.
6. Waits for `idle update: restarted onto 0.81.1 from 0.81.0` (validated). It then watches
   two more minutes and checks:
   - exactly one more session launch;
   - the last launch resumed the same session on 0.81.1, so the context was kept;
   - the last versioned heartbeat says 0.81.1 with no lastError, so it reported;
   - the record is `validated`;
7. Tears down: `bgos-agent uninstall`, then a bootout of its own label, then `kill-server`
   on its own tmux socket, then the stub by its exact pid. It checks that the job is gone
   and that `launchctl list` is identical to before.

## What it never touches

The person's HOME, `~/.claude`, real agents, real launchd jobs and the HOAI Watcher are
never touched. The label is `ai.bgos.agent.7300001.home-<hid>`, and the tmux socket is
`hoai-7300001-home-<hid>`. `<hid>` is the scratch HOME's id, so neither can name a real
agent's job or socket, and no real agent has id 7300001. The plist lives in the scratch
HOME, so the job does not come back at the next login even if the script is killed. If the
script is killed before teardown, run `launchctl bootout gui/$(id -u)/<label>`; the label
is printed at install.

## Reading a FAIL

- `the daemon armed`: see `install.log`, `restart.log` and the scratch `agent.log` under
  `<home>/.bgos-agent/7300001/`. The installer refuses with a reason when its paired
  topology proof fails.
- `the restart onto 0.81.1 validated`: the daemon log's `idle update: waiting: <reason>`
  lines name the gate that held. `no_unattended_authority` there means the own launcher
  proof failed on this Mac, which is the case this proof exists to catch.
- `context kept`: `<work>/.rig/launches.jsonl` shows each launch's mode and session id.
- `the old daemon left no shutdown line`: the daemon was killed under its shutdown, most likely
  by a signal. Send the daemon log; this is the case where a slow start on a Mac would roll a
  healthy build back.
