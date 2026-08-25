---
description: Pair this Claude Code session to HOAI with a one time code from the HOAI app.
argument-hint: BGOS-XXXX-XX
allowed-tools: Bash
---

Pair this Claude Code session with the user's HOAI account using their one time
pair code: $ARGUMENTS

Run exactly this command with the Bash tool and show the user the result:

`node "${CLAUDE_PLUGIN_ROOT}/bin/bgos-pair.mjs" $ARGUMENTS`

Rules:
- Never print, echo, or repeat the pairing token or any secret from the output.
- Only exit 0 is a completed, live-safe pairing. Then tell the user their agent
  is being added in the HOAI app, and that to go live they should type `/exit`
  and run `hoai` from this same folder. That is the whole instruction; relay
  the pairing output's own restart lines verbatim and add nothing to them.
  Never hand the user a raw `claude ... --dangerously-load-development-channels
  <spec>` line and never suggest a shell alias containing one: the correct spec
  differs per install (marketplace vs local checkout), is knowable only at run
  time, and getting it wrong drops every inbound message in silence. `hoai`
  detects it on every launch, which is the entire reason it exists. (The
  approved-sounding `--channels` flag is a third trap: it loads the plugin but
  silently wires no inbound delivery for a not-yet-allowlisted channel; never
  suggest it either.)
- If the user says `hoai` is not found, have them run `hoai install-cli` (or
  `npx --yes --package github:BrandGrowthOS/bgos-claude-plugin hoai install-cli`)
  and then open a new terminal.
- Exit 3 means the credentials were paired but the agent is NOT DONE because an
  environment pin is required. Relay the printed BGOS_ASSISTANT_ID or
  BGOS_CREDENTIALS_PATH instruction and do not describe it as ready.
- Exit 2 means the server refused the pairing. Relay the refusal without
  describing it as an unexpected crash.
- On an account with several bound agents, pairing refuses to guess and lists
  the candidates; rerun with `--assistant-id <id>` appended to $ARGUMENTS.
- If the code has expired, tell them to get a fresh code in the HOAI app
  (Add agent, then Claude Code) and run /hoai:pair again.
