# The watcher really restarts an agent: a live run, not a mock

**Date:** 2026-09-26 · **For:** the scheduled-restart fix in this branch

KC asked for proof rather than tests: *"you need to test this very rigorously ...
see the update on how it works, how the watcher restarts it. It needs to be end
to end fixed with proof."*

## What is real in this run, and what is not

**Real:** the actual `superviseClaude` from `bin/hoai-core.mjs`, a real temporary
HOME, a real `restart-requested.json` written to disk by the harness exactly as
the update ladder's launcher rung writes it, real child processes with real pids,
a real kill, a real relaunch, and the real channel resolution.

**Substituted:** the launched command is `sleep` rather than the claude binary.
What is under test is the restart mechanism, not claude.

## The run

```
  [hoai] restart supervisor armed for assistant 999999
  [spawn] launch #1 pid=6506
  [marker] WROTE restart-requested.json (this is what the ladder does)
  [hoai] restart requested by the daemon; restarting claude to pick up the update...
  [hoai] relaunching: claude --dangerously-skip-permissions
         --dangerously-load-development-channels server:bgos
         --session-id fa5292fc-e2ce-4b25-921d-82bca74ab650
  [spawn] launch #2 pid=6514

  first child pid   6506
  marker consumed   true
  relaunched pid    6514
  different process true
  elapsed           1213 ms
```

Run again with fresh pids (6597 then 6611) to show it is not a one-off.

Note the relaunch line: it resumes the agent's OWN pinned session id, which is
the behaviour that makes a restart cost the agent nothing.

## Two refusals worth keeping, because they are the safety working

The first two attempts did NOT relaunch, and both were correct:

1. The temp HOME recorded no plugin install and the folder published no
   `.mcp.json`, so the launcher **refused to guess a channel**: *"an agent on a
   guessed channel starts, reports Connected, and never receives a message."*
   That is the 2026-08-21 silent-deafness signature being prevented.
2. A `.mcp.json` whose server entry carried no `BGOS_` key was correctly not
   recognised as ours (`parseMcpChannelServerName`), so the channel still did
   not resolve.

Only a folder that genuinely publishes a HOAI server got a relaunch. The harness
had to become a real agent folder before the real code would act, which is the
point.

## What this does and does not prove

**Proves:** marker written, watcher detects, child killed, new child started,
session id preserved. That is links 5 and 6 of the chain.

**Does not prove:** that a nightly update on a production daemon reaches this
point. Links 2 to 4 are covered by `test/scheduled-restart.test.ts`, mutation
proven at both the decision and the wiring. The remaining gap is an agent whose
keepalive never declares itself, which has no provable authority for any
mechanism to use.

Reproduce: `node docs/evidence/2026-09-26-restart-live-proof.mjs`
