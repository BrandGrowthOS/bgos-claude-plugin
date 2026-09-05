# Changelog

Notable changes to the HOAI Claude Code plugin.

## 0.38.17 (2026-09-04)

Home-folder identity binding (board 01a068f7). The 0.38.6 pairing lock below
guarantees exactly ONE daemon per pairing. It does not guarantee the RIGHT one,
and that gap recurred on 2026-09-04: a session started in a folder that is not
an agent's own resolved to that agent by elimination, took the lock while the
real agent was between restarts, and answered users in its name. Nothing was
misconfigured. At the credential layer a stray session and the real one are
indistinguishable, because identity was a property of the HOST and never of the
session.

- **An agent's home folder is now recorded and enforced.** A daemon that
  resolved its credentials by ELIMINATION (`sole-per-assistant` or `legacy`)
  from a folder that is not the one recorded for that agent REFUSES to start,
  naming both folders and every way to clear it, instead of speaking as
  someone else.
- **Explicit pins are never constrained.** `BGOS_CREDENTIALS_PATH`,
  `BGOS_ASSISTANT_ID` and a `.bgos-agent-id` folder pin are already
  per-process identity signals, so env-pinned hosts keep launching from
  wherever they like. Only the routes that guess are constrained.
- **It self-migrates, so nothing stops working on upgrade.** Every existing
  agent has no home recorded on the day this ships; the first one to hold the
  channel records its own folder and proceeds. No operator action.
- **A folder is claimed only after a minute of holding the channel.** The
  residual race is a stray recording a folder that is not its own, and strays
  are overwhelmingly transient (a subagent, a one-shot `claude -p`, a stray
  shell). A minute of continuous delivery filters those; the real long-lived
  agent crosses it without noticing.
- **Kill-switch:** `BGOS_ALLOW_ANY_FOLDER=1` skips the check for one boot, so a
  wedge is one variable away from cleared rather than a file edit.
- Failing to WRITE the binding never fails a boot: a read-only credentials file
  leaves the agent unbound and working, exactly as today.

## 0.38.6 (2026-08-30)

Single-instance pairing lock (board 01a05185): a confirmed fleet bug where, on
a host whose clone holds the sole credentials file, ANY session (KC's plain
sessions, default-config subagents) resolved to that agent's pairing via
"sole-per-assistant" and connected a rival daemon. Several daemons then joined
one Socket.IO pairing room, the server broadcast dispatch to all of them, and
the wrong one dropped the message ("Rejected dispatch to unauthorized
chat_id"), leaving the real agent unreachable while its process stayed healthy.

- **Reclaimable single-instance lock.** Before a daemon connects its pairing
  WebSocket it must hold an exclusive, heartbeat-based lock keyed to the
  resolved credentials file (`<credentials>.lock`). Exactly one daemon per
  pairing holds it and arms delivery; the rest stay PASSIVE, keeping their MCP
  tool surface up (the session is still usable) but never joining the pairing
  room and never touching the pairing. The holder stamps its pid plus a
  heartbeat and refreshes it on the existing poll tick; a rival RECLAIMS a lock
  whose holder is plainly gone (dead pid, or a heartbeat older than 3 intervals)
  rather than being locked out first-come by a short-lived transient subagent.
  A passive daemon rechecks on the heartbeat cadence and takes over
  automatically if the holder exits.
- **Beacon heartbeat.** On each successful beacon the active daemon touches a
  new `channel-beacon.json` (a sibling of `channel-live.json`) whose mtime an
  external supervisor can watch to detect a dead channel behind a live process.
  `channel-live.json` is edge-triggered on connect/boot only, so its mtime was
  never a liveness signal; this one is.

## 0.38.3 (2026-08-24)

One-click update robustness (#84): the update dirty-tree check now ignores
untracked and ignored files, so a stray report or note left in the connector
folder no longer aborts the update with "dirty_tree". It still refuses only on a
genuinely conflicting tracked change; the ff-only pull and detached-checkout
rollback remain safe backstops.

## 0.38.2 (2026-08-24)

Supervised-restart safety, after a live fleet incident on the night of
2026-08-23 where roughly six agents restarted and all resumed one agent's
conversation. The supervised launcher migration is a separate staged step (see
`docs/one-click-restart-helper.md`); this release ships the hardened restart
code so the one-click update path is safe when adopted.

- **Identity-safe relaunch (GAP 1).** The supervise loop no longer relaunches
  with `--continue` (which resumes the MOST RECENT conversation in the cwd, so
  agents sharing a folder resume a neighbour's session, the identity bleed that
  caused the incident). Each agent now pins a per-agent session id in
  `~/.bgos-agent/<id>/session-id` and relaunches resuming ONLY its own session
  (`--resume <id>`, created once with `--session-id <id>`). Verified against the
  `claude` CLI: `--session-id` creates, `--resume` resumes, a reused id errors.
- **Dev-channels prompt-stranding fix (GAP 2).** A clone (dev) launch shows the
  `--dangerously-load-development-channels` confirm prompt at (re)start, with no
  non-interactive flag to accept it, so an unattended supervised restart came
  back blocked until a human pressed Enter. The supervised launch now auto-
  accepts the gate under `expect` (mirror of the fleet's `run.expect`) when it is
  available, and warns clearly when it is not. Marketplace installs use the
  approved `--channels` flag and never prompt.
- **Singleton guard.** A second `hoai` in the same folder refuses to start when a
  live supervisor already owns the agent, instead of doubling the session and
  racing the restart marker.
- **Never-leave-dead.** A resumed relaunch that exits non-zero inside a 25s
  health window (the `keepalive.sh` lesson) is retried once as a fresh OWN
  session, so the supervisor never returns after its own kill with the agent
  down. A clean quit (code 0) is always honored, never hijacked.

## 0.38.1 (24 August 2026)

One fix, found live: one-click onboarding failed at the pairing stage on any
host already serving other agents (MacBook-Air-2, ten agents, 2026-08-23),
while the server side had paired fine.

- **A verified launch-folder pin now counts as a pin.** `hoai-pair` bakes a
  `.bgos-agent-id` pin into its working folder and then, on a multi-agent
  host, still exited 3 (pin required) because the live-safe verdict only
  honored the ENV pin. The one-click script read any nonzero as
  pair-failed, and the retry bounced off the mint guard's 409 because the
  first pairing WAS live. `launchFolderLiveSafe` now verifies the baked pin
  on disk (override absent, env id absent or matching, pin id matching,
  per-assistant credentials present) and a pairing that provably resolves
  from its launch folder exits 0 with a line naming exactly where it is
  live-safe from. The exit-3 refusal remains for a failed or elsewhere bake.

## 0.38.0 (22 August 2026)

One-click updates (wire contract v1, BrandGrowthOS/BGOS
docs/handoff/one-click-plugin-update/wire-contract.md): the app's "update
this agent" button reaches the daemon, and interactive sessions finally
have a restart authority.

- **update_rpc handler.** The backend pushes `update_rpc {rpcId, op}` to
  the pairing room; the frame carries NOTHING else (no version, no url, no
  script), the daemon resolves the update from its own pinned source with
  every existing brake honored (same-major gate, dirty-tree, checkout lock,
  rollback latches). Ack + progress ride REST
  (`integrations/update-rpc/:rpcId/ack` / `/progress`); the handler is
  deliberately NOT drain-gated and never tracked as message work (either
  would deadlock or deafen its own drain). Kill switch off, latch tripped,
  nothing newer, marketplace install: each is a descriptive terminal error,
  never silence (`lib/update-rpc.ts`).
- **Restart ladder, never a bare exit.** After installing: an installed
  always-on service triggers a DETACHED delayed restart (systemd-run /
  launchctl kickstart); else a live hoai launcher gets a
  restart-requested.json marker; else the daemon reports 'staged', keeps
  serving the old code, and the pending restart rides the next heartbeat.
  The daemon itself never calls process.exit (the kc-server invariant).
- **Launcher-loop supervisor.** A bare `hoai` now supervises the claude it
  spawns: it writes `~/.bgos-agent/<id>/supervisor.json` (pid + relaunch
  capability), polls for the restart marker every 3s, and on marker SIGTERMs
  claude and relaunches it with the re-detected channel flags plus
  --continue. Marker contents are ignored (existence only, so the marker can
  never carry commands), a normal exit never relaunches, and a 3-per-hour
  budget stops update-crash loops (`bin/hoai-core.mjs superviseClaude`).
- **Readiness heartbeat.** The 6h version heartbeat now also reports
  `latestKnownVersion` (last origin/main inspection; null on marketplace
  installs) and `updateReadiness` {supervised: systemd|launchd|launcher|none,
  autoUpdateEnabled, rollbackLatched, pendingRestartVersion}, so the app can
  show update_available / restart_pending / paused per pairing. A 'staged'
  update fires one immediate heartbeat instead of waiting 6 hours.

## 0.37.0 (22 August 2026)

One click, zero terminal: the onboarding release. Every fix from the
approved design (bgos-oneclick-design.vercel.app) plus one the build's own
E2E discovered, each with a regression test.

- **Launch shim (fix 01).** The plugin manifest and generated configs launch
  `bin/bgos-launch.mjs` under node, which resolves bun (BUN_INSTALL, ~/.bun,
  PATH, then bunx) and prints the exact install command instead of a bare
  ENOENT when bun is missing.
- **Install-method detection (fix 02).** `bin/bgos-install-method.mjs`
  detects marketplace vs clone and picks the matching channel spec
  (plugin:hoai@hoai vs server:bgos); pairing prints the ONE exact launch
  command for the install it found. The approved-sounding `--channels` flag
  is documented as a trap: it loads a non-allowlisted plugin's tools and
  wires no inbound (proven live 2026-08-22).
- **Preflight gate + doctor (fixes 03, 08).** `bin/bgos-doctor.mjs` prints
  the prerequisite table with one fix command per failing row; --preflight
  requires the MCP initialize handshake and a Connected row in
  `claude mcp list` before setup may claim success. `/hoai:doctor` runs it
  from chat; `hoai doctor` from a terminal.
- **Boot hello + channel-live marker (fix 09, new).** Connected cannot
  prove the session HEARS channel events, so on the first-ever boot of a
  pairing the daemon asks the session to greet its owner; the greeting's
  tool call writes a persistent channel-live marker, and the bootstraps'
  final step waits for it (doctor --wait-live-since) before declaring done.
- **Deaf-session honesty (fix 04).** Cursor PERSISTENCE is gated on channel
  liveness (first tool call since boot): a session that cannot hear never
  marks messages delivered, so a restart with the fixed flag redelivers
  them. When the reply-overdue nudge itself goes unacted on such a session,
  the daemon posts the exact launch command into the chat over REST, once
  per boot.
- **Credentials dedupe (fix 05).** The legacy credentials.json co-write is
  replaced by dedupe-at-write: a legacy file holding the same agent's
  pairing (or junk) is deleted after the verified per-assistant write;
  another agent's live pairing is never touched. The Windows ACL now
  applies (direct icacls argv; the cmd.exe string form double-quoted the
  grant and left the file world-readable).
- **Stable log path (fix 06).** `~/.bgos-agent/logs/bgos-plugin-<id>.log`
  regardless of launch method; BGOS_LOG_FILE still wins.
- **Session binding (fix 07).** The newest-mtime last resort binds only
  when unambiguous (a sole candidate, or exactly one active in the last 10
  minutes); otherwise the binder refuses and waits for reply-marker proof.
- **One-click bootstraps.** `bin/hoai-bootstrap.ps1` (Windows) and
  `bin/hoai-bootstrap.sh` (macOS/Linux): idempotent, sentinel-emitting,
  install only missing prerequisites (node, bun with BOTH bun and bunx on
  PATH, Claude Code), stop at the login gate until `claude auth status`
  says loggedIn, pair from the workspace with --assistant-id, pre-seed the
  characterized one-time prompts (trust; the bypass warning whose DEFAULT
  answer is exit), run the preflight, and wait for the channel-live proof.
- **The hoai alias.** Open the folder, run `hoai`: launches with the right
  flags via the folder pin; `hoai doctor`, `hoai pair`, `hoai logs`.
- **CI.** The full test suite + tsc now run on every PR.

## 0.34.0 (8 August 2026)

The Agent Update Stream consumer, strictly opt-in via
`BGOS_UPDATE_STREAM=true` (pairing mode only). With the flag unset, the
daemon is behaviorally identical to 0.33.6 and the whole pre-existing test
suite passes unmodified.

- **Sequenced delivery, trusted by arithmetic.** Stamped `inbound_message`
  pushes (`seq` + `streamEpoch`) apply through the Telegram-style rule:
  successor applies, duplicate drops, a jump buffers 500ms and then heals
  with ONE `GET /integrations/updates` catch-up chain (slices, intermediate
  cursor persisted before every next request, 429 resume, tooOld /
  invalidCursor / epoch mismatch routed to one full boot-style resync, 404
  feature detection for old backends).
- **Session tokens, memory only.** `POST /integrations/session` exchanges
  the pairing token for a short-lived session token used on catch-up reads;
  `session_expired` re-mints once (single flight), `pairing_revoked` stops
  the stream. The token never touches disk or logs.
- **Beacon + authority.** The 60s `update_state` beacon detects lost pushes
  and silent room drops; `stream_authority` is per connection, so sweeps
  demote only with authority AND a beacon on the current connection, and
  losing either degrades to the legacy cadence (never a reconnect loop).
- **Recovery gets cheap.** Reconnect = one jittered chain instead of a full
  sweep; WS-down = one updates poll per 10s instead of a full sweep; the
  healthy 5 minute sweep stretches to a daily reconciliation while stream
  mode is active.
- **The daemon-side application contract (spec 5.7).** Empty system wakes
  are held and their `message_finalized` delivers AS the wake; assistant
  authored rows only advance cursors (reply boundary); the per-chat cursors
  remain the dedup substrate and are fed by the stream; `buttons_answered`
  announces only what the legacy detector would have and consumes the
  transition, keeping the single-announce contract.
- New pure modules `lib/stream-client.ts`, `lib/stream-cursor-store.ts`,
  `lib/stream-apply.ts` (the consumer core `lib/update-stream.ts` landed
  earlier on this branch), plus 76 new tests including the all-string meta
  regression guards.

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
