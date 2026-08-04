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
- If pairing succeeds, tell the user their agent is being added in the HOAI app,
  and that they should restart their agent process the way it normally starts.
  Both known channel forms (relay whichever matches how this session was
  launched): `claude --dangerously-load-development-channels plugin:hoai@hoai`
  for the packaged HOAI channel from the plugin marketplace, or
  `claude --dangerously-load-development-channels server:bgos` for a
  checkout-based host running server.ts directly (e.g. a multi-agent server).
  (The flag is temporary until HOAI is on the Claude channel allowlist.)
- On an account with several bound agents, pairing refuses to guess and lists
  the candidates; rerun with `--assistant-id <id>` appended to $ARGUMENTS.
- If the code has expired, tell them to get a fresh code in the HOAI app
  (Add agent, then Claude Code) and run /hoai:pair again.
