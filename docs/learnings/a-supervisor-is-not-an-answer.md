# `running` only says an agent has a supervisor: ask whether it answers BEFORE blaming an update for its silence

**Date:** 2026-11-18

**Context:** Bug board rows 66450e01 and 367b861a (17 Nov 2026). Two one click updates to 0.90.0 ended `agent_deaf_after_update`, rolled the whole computer back, and the same agent then failed again on the old version (`agent_deaf_after_rollback`). The agent had been deaf for days: hand started on an old version, its session dropping every channel event.

**Gotcha / Pattern:** the planner already had the right idea, "only an agent that was RUNNING before the install can prove the update broke it" (`canBlameInstall` in `lib/update-planner.mjs`). But `running` comes from `lib/agent-inventory.mjs` as `supervisor !== 'none'`. It says a launcher or a service holds the agent, not that the session acts on a channel event. A deaf agent with a healthy supervisor is `running`, so its verify carried the rollback, and a failure that existed before the update was charged to it. A flag named for one fact (the process is kept up) was read as another (the agent hears). The only proof of hearing this connector has is the channel-live marker moving after a probe, and it was being asked only AFTER the restart.

**How to apply next time:** before a step can undo work for everyone because one participant fails a check, run the same check once before the work, and let a plain failure there remove that participant's veto. Keep three answers, not two: answered, did not answer and shows no sign of life, and did not answer but was recently alive. The last one must stay "unknown" (a busy session answers a probe only when its turn ends), and unknown must behave exactly as before. When a boolean in a plan comes from an inventory, read how the inventory computes it before relying on its name.

**Regression guard:** `test/agent-verify.test.ts` (the `proveLiveBefore` block: answered, never live, stale, recently live stays unknown, the stale edge, the lap bound), `test/update-executor.test.ts` (the last block: a deaf answer before the update takes the rollback away from that one agent and keeps the install; answered, unknown, a throw and a hang roll back as before; asked once, before the first claude call; nobody asked when no verify can roll back) and `test/watcher-core.test.ts` ("the executor is given the question to ask BEFORE an update").

**Added after review (2026-11-19):** the first version read "deaf before" off the live marker alone, and the marker moves only on a boot's first tool call and on `channel_ack`, an edge, not a pulse. A healthy session up for more than six hours and in a long turn had an old marker and missed the 20 s probe, so it would have read deaf and a bad build that broke it would have been neither rolled back nor held. Three things made it right:

- Ask the thing that knows it is busy. The daemon publishes `agent-state.json` (`parseAgentState`, fresh and from a live writer): a turn in flight, work waiting or activity inside the window means "unknown", never "deaf".
- Ask again just before acting. The marker is read once more just before the agent's restart and when its verify fails; a move after the question is a late answer, so the agent was live.
- Never excuse the last witness. When every agent that could roll back was deaf before (a one agent computer), nothing proves the new build, so the run rolls back as it always did; the restart on the known build also cures an agent that was wedged.

The probe the daemon sends says which question it answers: the request carries `purpose: 'before_update'`, read before the file is removed, so a session that was not restarted is not told it was.

