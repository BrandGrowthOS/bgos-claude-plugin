# Changelog

Notable changes to the HOAI Claude Code plugin.

## 0.33.0 (5 August 2026)

Two observability items; no behavior change to auth or to what remote
compact does.

- **Auth divergence recheck (visibility only).** Auth is resolved once at
  boot, and the boot log line then masquerades as current truth even after
  the credentials file is rewritten underneath the process. The daemon now
  re-runs the same pure resolution every 10 minutes (env-tunable via
  `BGOS_AUTH_RECHECK_INTERVAL_MS`; `0`/`off` disables) plus immediately on a
  credentials-file watch event, and when the OUTCOME (mode, source,
  assistantId, token identity via a sha256-first-8 fingerprint) differs from
  boot it logs ONE structured WARN per distinct divergence, including the
  age of the underlying file change, and a recovery line if it reverts. The
  running process keeps its boot auth; no token is ever logged.
- **Remote compact detection survives startup races.** When the boot env
  does not resolve a tmux target, detection now retries for a bounded
  window (3 attempts over 30s) before concluding OFF, and after an OFF
  conclusion a throttled periodic recheck (every 60s, bounded budget) may
  make a one-time late upgrade to ON, logging that detection succeeded
  after the startup window and re-advertising `/compact`. The healthy boot
  path and its ON log line are byte-identical to 0.32.x.

## 0.32.0 (4 August 2026)

Multi-agent pairing: N agents under one OS user can now each hold their own
pairing. Driven by a live incident on a 7-agent host where pairing intended
for one assistant silently rebound another.

- **bgos-pair never guesses the assistant.** `--assistant-id <id>` (or
  `BGOS_ASSISTANT_ID`) pins the intended assistant; if the pairing resolves to
  a different one, nothing is written and both ids are named. With no request
  and several bound agents, the candidates are listed and an explicit choice
  is required.
- **Per-assistant credentials files.** New pairings write
  `~/.bgos-agent/credentials-<assistantId>.json` (or `BGOS_CREDENTIALS_PATH`),
  so pairing agent B no longer overwrites agent A's slot. Read order is strict
  and total: `BGOS_CREDENTIALS_PATH`, else an existing
  `credentials-<BGOS_ASSISTANT_ID>.json`, else the legacy `credentials.json`
  (the existing single-file fleet keeps working unchanged).
- **A rejected pairing file is loud.** When a credentials file is ignored
  because its assistantId does not match the configured `BGOS_ASSISTANT_ID`,
  startup logs a WARN naming both ids and the file path instead of silently
  falling back to api-key auth (the silent fallback made "boards 401" look
  like the channel being down).
- **Post-write verification.** bgos-pair re-resolves the file it just wrote
  and exits nonzero unless it actually resolves to the intended assistant. It
  also probes the real, unpinned environment: when only an env pin would make
  the daemon find the file, the success output says REQUIRED, with the exact
  variable to set.
- **Single-agent hosts keep working with an empty env.** After the
  per-assistant write, the legacy `credentials.json` is co-written when it is
  absent, junk, or already this same assistant, never when it holds another
  agent's pairing. A daemon with no `BGOS_ASSISTANT_ID` configured (the
  packaged plugin default) finds its pairing exactly as it did on 0.31.0.
- **The unbound write cannot clobber a live pairing.** When no assistant is
  bound yet, writing the legacy slot is refused if that file holds a live
  pairing for a bound assistant, naming that assistant.
- **Whitespace parity.** `BGOS_CREDENTIALS_PATH` and `BGOS_ASSISTANT_ID` are
  trimmed identically on the write side and the read side (a padded id that
  previously rejected a matching pairing file now matches it).
- **Honest restart instructions** for both topologies: the packaged
  `plugin:hoai@hoai` channel and a checkout-based `server:bgos` host.

## 0.31.0 — 27 July 2026

The first release since 0.21.1. Twenty-two commits, and the reason it is being
cut now is that the app already requires it: HOAI raised its Claude Code
staleness floor to 0.31.0, so until this is tagged and published every user was
told their plugin was out of date and could never clear it.

### Heartbeat

- **The daemon reports its working directory** (0.31.0). This is what lets the
  app show which folder an agent is actually running from, and is the reason
  the app's floor was raised to this version.
- **Version heartbeat**: pairing daemons report `daemonVersion` (0.22.0), which
  is what makes staleness detectable at all.

### Voice

- **Per-agent realtime model**, applied from the mint frame (0.30.0).

### Tools available to agents

- **`show_component`**, the generic renderable-components tool (0.26.0).
- **`show_health_tracker`**, summoning the native tracker card (0.25.0), later
  extended to carry the rich Budget board payload (0.28.0).
- **Native health-log tools**: `log_health_event`, `list_health_events`,
  `undo_health_event` (0.23.0).
- **`complete_mission`** takes an optional honest summary.
- **Outbound file types** match the backend allowlist (0.29.0).

### Self-update

- **Opt-in self-update** with a shared-checkout lock, a stable wrapper and a
  rollback latch, then **defaulted ON** (0.27.0).

### Fixes

- **Per-agent credential resolution is isolated**, so one agent's credentials
  cannot resolve for another.
- **BGOS slash commands execute** rather than being echoed.
- **Restart replay bug**: per-chat poll cursors persist and a first-run backlog
  gate stops a restarted daemon re-answering messages it already handled.
- **Scheduling**: a recurrence or `everyHours` object serialized to a JSON
  string in `when` is recovered rather than rejected.
- **Context**: stop advertising a dead `/compact` and infer unmarked 1M windows
  (0.22.1).
- **Real remote `/compact`** via supervisor tmux injection, plus positive
  self-session binding for `contextPct` (0.24.0).

### Performance

- **Delta polling and conditional GETs**, plus a scoped fast mode and a
  reconcile cadence, so a daemon stops refetching whole chat histories.

### Honest limits

- Agent-side resting self-report: usage-cap detection, `resetAt` parsing, and a
  deduped PATCH so a capped agent says so instead of going quiet.

---

## 0.21.1 and earlier

See the git history; this changelog starts at 0.31.0.
