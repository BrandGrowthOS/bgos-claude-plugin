# A restart authority has to be DETECTED, not guessed from the name we would have used

**Date:** 2026-08-25

**Context:** The one-click update button in the BGOS app is gated on the daemon's
heartbeat reporting `update_readiness.supervised !== "none"` (see the app's
`isOneClickEligible`, and the earlier learning that a button offered to a daemon
which cannot restart itself is a doomed click). On the BGOS dev Mac 8 agents run
and launchd supervises all 8, yet 7 of them reported `none` and the button stayed
dark for every one of them.

**Gotcha / Pattern:**

Both readers of the restart authority answered "is this agent supervised?" by
testing whether ONE hardcoded path existed:

- `lib/update-readiness.ts` `detectSupervision` (the daemon's own heartbeat), and
- `lib/agent-inventory.mjs` `detectSupervisor` (the per-machine watcher),

each calling `serviceFilePath(platform, home, id)`, which is hardcoded to
`~/Library/LaunchAgents/ai.bgos.agent.<id>.plist` on darwin and
`~/.config/systemd/user/bgos-agent-<id>.service` on linux. That is the name
`bin/bgos-agent` installs, so the check is right exactly when `bgos-agent` did
the install and wrong for every other launcher. On this machine 7 agents were
installed by hand as `ai.bgos.session.<id>` (loaded, `KeepAlive`, launchd would
restart them on request) and 1 as `ai.bgos.agent.901`. Verdict: 1 detected, 7
invisible.

The fix is NOT a second hardcoded label. That fixes one machine and goes dark on
the next bespoke name. `lib/service-supervision.mjs` asks the platform instead:
enumerate the LOADED jobs (`launchctl list`, `systemctl --user list-units`), read
each candidate job's own launch recipe, and keep the single job whose recipe
names THIS agent. Two anchors count, both of them the agent's own
identity-bearing paths rather than a name we hope for:

- `state-dir`: the job's program arguments / stdout / stderr / working directory
  point inside `~/.bgos-agent/<id>`. Only this agent's launcher writes there.
- `working-directory`: the job's `WorkingDirectory` IS the agent's working
  directory. That is the identity-bearing match, because an agent takes its
  identity from the `.mcp.json` of the folder it runs in, so a job that re-runs
  its recipe in that folder brings back THAT agent and no other.

Details that turned out to matter:

- **Process ancestry looks like the perfect signal and is not.** "Walk up from
  my pid to the first pid launchd reports as a job" is definitive when it works,
  and it works for none of this fleet: every launchd job here hands off to
  `tmux`, and the `claude` process is re-parented under the tmux SERVER, whose
  own parent is pid 1. Ancestry returns `none` for all 8 agents including the
  one with a canonical plist. Checking that before designing around it saved the
  whole approach.
- **Loaded, not merely present.** A plist sitting unloaded on disk restarts
  nothing and `launchctl kickstart` on it fails, so the discovery tier requires
  the job to appear in the loaded list. (The canonical tier is deliberately left
  as a pure `exists` test so the change is purely additive and cannot regress an
  agent that reported `service` before.)
- **Fail closed on ambiguity.** Two loaded jobs equally entitled to the agent
  resolve to null. Guessing which of two agents a restart belongs to is the
  exact failure this module exists to prevent.
- **An exact `WorkingDirectory` match, never a prefix.** A prefix test would let
  `~/agents` claim every agent under it.
- **A working directory pinned to ANOTHER agent vetoes the match**, and the home
  directory (shared by everything) is refused as an anchor outright.
- **The restart must be addressed to the handle that was resolved.** Detecting
  `ai.bgos.session.910` and then running
  `launchctl kickstart -k gui/501/ai.bgos.agent.910` is a failed restart at best.
  The resolved handle travels with the verdict (`resolveSupervision().service`,
  `AgentRow.service`) and the command is built from it. Because a discovered
  handle comes off disk it is validated against `SERVICE_HANDLE_RE` before it can
  reach a command line, and that rule lives in exactly ONE place: a duplicate
  copy in the caller masked the first, so neither could be proven by a mutant.

Why going through the supervisor is the safety property and not just a
convenience: `launchctl kickstart -k` / `systemctl --user restart` make the
supervisor re-run ITS OWN launch recipe, in its own working directory, reading
its own `.mcp.json`. A hand-rolled relaunch in the caller's cwd, or one carrying
`--continue`, is the fleet-restart identity bleed (several sessions coming up as
one agent, fighting over one pairing, draining the account). Nothing in this path
launches anything itself.

**How to apply next time:** when code asks "does capability X exist for this
subject", check whether it is asking the SYSTEM or asserting a name the code
itself would have chosen. The second reads as an audit and is really a
tautology: it can only ever see the installs we performed. Ask the platform,
match on the subject's own identity-bearing facts, and fail closed on zero and
on more than one. And when the answer will be acted on, carry the resolved
handle with the verdict rather than re-deriving it at the call site.

**Regression guard:** `test/service-supervision.test.ts` (bespoke launchd label
found by working directory; bespoke systemd unit; state-dir anchor; unloaded job
is not an authority; ambiguous match fails closed; exact working-directory
match; foreign folder pin vetoes; home / root refused; unsafe handle builds no
command; win32 resolves nothing; plus a shared scenario table asserting
`lib/update-readiness.ts` and `lib/agent-inventory.mjs` agree on both the
authority and the handle, so the mirror cannot drift apart again).
`test/update-readiness.test.ts` and `test/agent-inventory.test.ts` pin each entry
point; `test/agent-restart.test.ts` pins that the watcher kickstarts the
DISCOVERED label. All 12 guards were mutation-checked: each mutant compiles and
turns the named test red.
