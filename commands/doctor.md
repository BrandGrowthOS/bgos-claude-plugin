---
description: Diagnose this machine's HOAI agent setup: prerequisite table plus the exact fix command for anything broken.
argument-hint: (no arguments)
allowed-tools: Bash
---

Diagnose this machine's HOAI agent setup and show the user exactly what is
broken and how to fix it.

Run exactly this command with the Bash tool:

`node "${CLAUDE_PLUGIN_ROOT}/bin/bgos-doctor.mjs"`

Rules:
- Relay the printed table VERBATIM in a code block: every row, in the printed
  order, including the Fix lines under it. Never invent, reorder, drop, or
  summarize rows; the table IS the diagnosis.
- Never print, echo, or repeat secrets. The doctor itself prints none (the
  credentials row shows only a file path and an assistant id); do not add any
  from elsewhere either.
- FAIL rows come with one Fix line each; point the user at those Fix commands
  as the next step. SKIP means the check was not run, not that it passed.
- If the command itself fails to launch (node missing, plugin root unresolved),
  tell the user to run `hoai doctor` in a terminal instead.
- The handshake and `claude mcp list` rows are the live checks: only when both
  are PASS is the channel actually able to deliver messages. Do not describe
  the setup as working while either is FAIL or SKIP.
