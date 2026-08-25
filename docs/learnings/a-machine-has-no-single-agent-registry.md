# A machine has no single registry of its agents, and the inventory that assumed one silently skipped an agent

**Date:** 2026-08-25

**Context:** After the restart-authority work landed, a reconcile dry-run on the
BGOS dev Mac observed SEVEN agents. Eight were running. Agent 900, the
orchestrator, was not a failed step or a `manual_restart_required` row; it was
absent from the plan entirely. A checklist that omits a row looks complete, so a
user reading it believes every agent on the machine was covered.

**Gotcha / Pattern:**

`listPairedAssistantIds` enumerated `~/.bgos-agent/credentials-<id>.json`, so
the inventory was effectively "the set of credentials files". There were exactly
seven. Agent 900 had none: its key and id live in its folder's `.mcp.json`.

The important part is that 900 was NOT misconfigured. `lib/agent-credentials.ts`
documents two supported auth topologies, and only one of them leaves a
credentials file:

- `bgos-pair` (pairing token) writes `~/.bgos-agent/credentials-<id>.json`;
- `bgos-agent install --key --user` (its `write_mcp_json`) and `bgos-claim` (the
  Agent Pack claim installer) write `BGOS_API_KEY` + `BGOS_ASSISTANT_ID` into
  the agent folder's `.mcp.json` and write no credentials file at all.

So `credentials-<id>.json` is the artefact of ONE topology, not a registry. The
fix was never "give 900 a credentials file": that would mutate production config
to work around a reader, invent a pairing token the agent does not have, and
still leave every future `bgos-agent install --key` and `bgos-claim` agent
invisible.

How to widen it without trying to enumerate a filesystem: we already ask the
platform for the LOADED service jobs, and every one of them states its own
`WorkingDirectory`. That is a bounded, authoritative candidate set, and it is
exactly the set of agents a restart could act on anyway. Reading each of those
folders with the same `readFolderIdentity` the working-directory anchor uses
turns "which folders declare a HOAI assistant" into a cheap lookup with no new
parser and no new trust.

Two smaller lessons fell out of it:

- **Fail closed must not mean vanish.** When two folders declare the same
  assistant, the agent is still discovered and still gets a row, just with no
  cwd, so it lands as an honest `manual_restart_required` instead of
  disappearing. Dropping it would have recreated the original bug in the name of
  safety.
- **State the basis, not just the rows.** Full discovery is impossible: an agent
  with no credentials file whose folder no loaded job names cannot be seen from
  here (it also cannot be restarted from here). Every plan now carries
  `plan.inventory` = `{total, credentials, supervisedFolder, basis}`, where
  `basis` names that blind spot in one clause, and `notes` gains a line whenever
  a row was findable ONLY through a folder. `notes` stays the anomaly channel;
  provenance rides in its own field so an anomaly-free plan still has an empty
  `notes`.

**The same blindness ran through the LAUNCHER, and further than the inventory.**
`bin/hoai-core.mjs` has three readers that resolve an agent's identity, and all
three consulted the `.bgos-agent-id` pin and then the process environment:
`buildRunPlan` (which agent to launch), `superviseAssistantId` (whether to
supervise at all), and `logsAssistantId` (what to key the log file by). The trap
is an asymmetry that is easy to miss: Claude Code injects an MCP server entry's
`env` block into the DAEMON's process environment, so the daemon does find
`BGOS_ASSISTANT_ID` there and authenticates fine. `hoai` runs OUTSIDE claude,
launching it, so the launcher's own environment never contains it. An agent
whose id lives only in `.mcp.json` is therefore invisible to every launcher-side
reader while being perfectly visible to the daemon.

Measured on the dev Mac against unmodified main: `hoai` could launch **0 of 8**
agents and supervised **0 of 8**, because not one of those folders has a
`.bgos-agent-id` (they all predate `bakeLaunchPin`) and the host has more than
one credentials file, so the sole-agent fallback never fired. The refusal even
told the operator the folder "has no `.bgos-agent-id` pin" while `.mcp.json` two
lines away declared the id. All three readers now go through the same
`readFolderIdentity`, which grew a `source` field precisely so the message can
name the file that actually answered, and a folder declaring two different ids
is refused as a named CONFLICT rather than launched under a guess.

**How to apply next time:** before treating a directory listing, a table or a
file-name convention as "the set of X", find every writer that creates an X and
check they all write there. Here two of the three install paths did not. The
same failure family had just been fixed one layer down (a folder-identity veto
that read `.bgos-agent-id`, a file no agent folder on this machine has, while
the real id sat in `.mcp.json`): one source of truth assumed, everything
configured the other way silently absent. When you cannot enumerate exhaustively,
publish what the enumeration WAS, so no reader mistakes a partial list for a
complete one.

**Regression guard:** `test/hoai-core.test.ts` (an agent declared only in
`.mcp.json` is launched, supervised and log-keyed; the launch note names
`.mcp.json` and never says "folder pin"; a folder declaring two ids is refused
as a conflict; the multi-agent refusal names both sources in its DIAGNOSIS, not
only in its remedy). `test/agent-inventory.test.ts` (`discoverFolderAgents`
finds an agent declared only in its folder; the home directory, a silent folder
and a conflicted folder declare nobody; two folders claiming one agent still
yield a row with no cwd; and `listAgents` inventories an agent with NO
credentials file, resolves it to its supervising job, and leaks neither the API
key beside the id nor the pairing token). `test/service-supervision.test.ts`
(`listLoadedJobs` returns only loaded jobs, proven with a plist that names a
loaded job without being one, so the cheap text prefilter cannot be what
excludes it). `test/update-planner.test.ts` (`inventoryBasis` counts each source
and names the blind spot; every plan carries it; the folder-only row is called
out in `notes`). All eight guards were mutation-checked, each mutant compiling,
and the headline one is killed by a fixture built as the real agent folder is:
`.mcp.json` with the key next to the id, and no credentials file anywhere.
