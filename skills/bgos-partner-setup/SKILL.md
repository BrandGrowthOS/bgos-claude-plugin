---
name: bgos-partner-setup
description: Route to the canonical setup runbook for connecting an agent host to BGOS (Home of Agents). Use when asked to connect or pair a Hermes, Gobot, OpenClaw, or Claude Code agent host to BGOS/HOAI, to do partner setup, to pair an agent with a code from the app, or to find the current install or pair commands for a channel.
---

# BGOS partner setup — routing runbook

This skill routes; it does not copy. Every agent host below has exactly one
canonical setup runbook, and this file points at it **by reference** so the
copy you are reading can never drift. On purpose, this skill carries **no
install command strings at all**: the current commands are rendered by the
app on its **Integrations** screen, and quoting them here would create one
more copy that rots. When you need a command, send the user to the app, or
read the canonical runbook for that host.

Provenance: per the canonical ruling of 2026-08-28, the
[`hermes-channel-bgos` README](https://github.com/BrandGrowthOS/hermes-channel-bgos#canonical-setup-runbook)
is the canonical committed setup runbook, and this skill is the only other
committed copy — allowed because Claude Code discovers plugin skills from a
file on disk — and it is a router, not a runbook. Everything else is served
(app screens, in-app prompts, the capability canon endpoint).

## Before you start (any host)

- **A BGOS (Home of Agents) account** with access to the app's
  **Integrations** screen. That screen generates pair codes and shows the
  current connect command for every framework.
- **Shell access to the host machine** where the agent framework runs.
  Setup is never possible from the app side alone.
- Host-specific prerequisites (runtimes, minimum versions) live in each
  host's canonical runbook, not here.

## Where pair codes come from

Pair codes are generated in the app, on demand: **Integrations → the
host's card → its Connect action** (for Claude Code agents, also **Add
agent → Claude Code**). A code **expires in 10 minutes**, and no real code
exists until the user generates one. Never invent, guess, or reuse a code
from an example — this skill and its references deliberately contain no
sample codes. Ask the user to generate one in the app and report it back.

## Route by host

### Hermes

Canonical: the
[`hermes-channel-bgos` README](https://github.com/BrandGrowthOS/hermes-channel-bgos#canonical-setup-runbook)
(committed, public). It embeds a full paste-into-Claude-Code prompt — the
recommended path — plus the by-hand reference. Go straight to the section
you need:

- Guided setup, recommended —
  [Quick start with Claude Code](https://github.com/BrandGrowthOS/hermes-channel-bgos#quick-start-with-claude-code-recommended)
- Host requirements —
  [Prerequisites](https://github.com/BrandGrowthOS/hermes-channel-bgos#prerequisites)
- By hand (plugin path or legacy fork patch) —
  [Manual setup](https://github.com/BrandGrowthOS/hermes-channel-bgos#manual-setup)
- Pairing with a code from the app —
  [First-time pairing](https://github.com/BrandGrowthOS/hermes-channel-bgos#first-time-pairing)
- Several agents on one machine —
  [Multiple agents on one machine](https://github.com/BrandGrowthOS/hermes-channel-bgos#multiple-agents-on-one-machine-routes-and-hermes-profiles)
- Env vars —
  [Configuration](https://github.com/BrandGrowthOS/hermes-channel-bgos#configuration-env-vars)
- Anything broken —
  [Troubleshooting](https://github.com/BrandGrowthOS/hermes-channel-bgos#troubleshooting)

### Gobot

Canonical: the app's in-app Gobot setup prompt (the `gobotSetupPrompt`
module) — a full agent playbook the user copies out of the app and pastes
into a Claude Code session on the Gobot host. It is served by the app, not
committed to a partner repo, so it is always current. Path: **Integrations
→ GoBot card → "Setup instructions" → Copy prompt**.

### OpenClaw

Canonical: the
[`openclaw-channel-bgos` npm package](https://www.npmjs.com/package/openclaw-channel-bgos)
README (published from the `BrandGrowthOS/openclaw-channel-bgos` source
repository). The current pair command is shown on the OpenClaw card of the
app's Integrations screen.

### Claude Code (this plugin)

Install from the BGOS Claude Code plugin marketplace —
[`BrandGrowthOS/hoai-marketplace`](https://github.com/BrandGrowthOS/hoai-marketplace),
plugin name `hoai` — or follow this repo's own
[README](../../README.md) for the one-command and manual paths. The app's
Claude Code card on the Integrations screen shows the current connect
command, and creating a Claude Code assistant in the app shows a setup
prompt with the credentials pre-filled. Once the plugin is installed, use
`/hoai:pair` with a fresh code from the app, and `/hoai:doctor` when
anything looks broken.

## Canonical and served pointers

- **Canonical committed runbook** — the
  [`hermes-channel-bgos` README](https://github.com/BrandGrowthOS/hermes-channel-bgos#canonical-setup-runbook).
  Its section headings are stable deep-link anchors; the links above route
  there by anchor, and the app's setup prompts point there.
- **Current install / pair commands** — the app's **Integrations** screen,
  rendered from app source. Never quote them into docs; they are pinned by
  test in the app and copies drift.
- **Served capability canon** — once a host is connected, its capabilities
  come from the backend endpoint
  `GET /api/v1/integrations/capabilities?channel=<channel>` (channels:
  `core`, `claude`, `hermes`, `openclaw`, `gobot`, `codex`), versioned and
  ETag'd; channel plugins fetch it at connect. Consult it — not committed
  docs — for what a connected agent can currently do.
