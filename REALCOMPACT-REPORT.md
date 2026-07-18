# Real Remote /compact + Positive Self-Session Binding (0.24.0)

Branch: `feat/real-compact` (worktree `/Users/fitecho/bgos-claude-plugin-wt/realcompact`, rebased onto origin/main 39cc106 after #33 landed mid-work). Base context: #41 removed the dead /compact catalog entry in 0.22.1 because a channel event can never run a host CLI command.

## Part 1: real compaction (design)

### Env contract (capability detection, boot-time, lib/compact-inject.ts)

| Variable | Meaning |
|---|---|
| `BGOS_TMUX_SESSION` | tmux target (session name or any -t spec) hosting the claude CLI. Set by the supervisor. Presence turns the capability ON. |
| `BGOS_TMUX_SOCKET` | Optional tmux socket NAME (`tmux -L`). Omit for the default socket. |
| auto-detect | When `BGOS_TMUX_SESSION` is absent but the daemon inherited `TMUX` + `TMUX_PANE` (claude itself runs inside a tmux pane), the exact pane (`%N`) is targeted via the socket path from `$TMUX`. Zero supervisor changes needed on this fleet: live daemon 16445 (assistant 900) already carries both. |
| `BGOS_REMOTE_COMPACT=off` | Hard opt-out, wins over everything. |

Explicit `BGOS_TMUX_SESSION` wins over auto-detect. Targets and socket names are validated against strict character sets (defense in depth; everything is argv exec, no shell ever).

### Trigger flow

1. A /compact tap (or typed `/compact`) arrives as a `slash_command` channel event on the poll or WS path. Both paths intercept it BEFORE the model: the event is swallowed (the model cannot act on it anyway) and deduped across transports by message id. Backlog-delivered (daemon-was-offline) compact requests are ignored as stale.
2. Capability OFF: honest direct reply "This install cannot compact remotely ... run /compact in the agent terminal" plus the current context pct.
3. Capability ON: probe the target (`tmux display-message -p -t <target> ok`; chosen over `has-session` because it resolves pane ids too), then inject three steps: `send-keys -l '/compact'`, 400ms, `Enter`, 400ms, `Enter` (paste-safety; proven a no-op on an already-submitted composer). Reply "Compaction started (context at X%)".
4. Async confirmation (lib/compact-confirm.ts, pure + tested): poll the BOUND transcript tail every 5s for up to 4 min for a `{"type":"system","subtype":"compact_boundary"}` entry at/after injection time (5s clock slack). Verified against real fleet transcripts: compaction appends that entry to the SAME session .jsonl. On confirm: `reportContextPct()` refreshes the pill and the chat gets "Compaction complete: X% -> Y%" (Y from the first post-boundary assistant usage entry; when the session stays idle post-compact there is no such entry yet, so the reply honestly says the gauge refreshes on the next turn). On timeout: honest failure reply.
5. Single-flight guard (`compactInFlight`) is claimed before any await in the injection path, released by the watcher; two rapid taps cannot double-inject.

### Safety (structural, tested)

The frozen `INJECTABLE_LITERALS` allow-list (`{ compact: '/compact' }`) is the ONLY source of injected text; `buildInjectionSteps` takes a TypeScript-narrowed key and runtime-throws on anything else. The only other key ever sent is the literal `Enter`. No parameter anywhere accepts chat/user-derived content into send-keys. `test/compact-inject.test.ts` asserts every emitted argv payload is either an allow-listed literal (with `-l`, so tmux never key-name-expands) or `Enter`.

### Catalog

`catalogForCapabilities({ remoteCompact })` (lib/slash-catalog.ts) appends `/compact` ONLY when the boot capability detection succeeded; the daemon PUTs its own per-assistant catalog, so the BGOS Compact button appears exactly where it works. `BUILTIN_COMMANDS` itself stays compact-free and the invariant comment was rewritten to document the conditional path. `/new` remains unadvertised: deliberately deferred (see below).

## Part 2: session binding (signal chosen and why)

Evidence gathered from THIS machine's live fleet (8 daemons inspected via `ps eww` + project dirs):

- `CLAUDE_CODE_SESSION_ID` is set for MCP children and matches the transcript file for FRESH launches (daemon 94034/pylon: `5c13caf6...jsonl` exists and is live). But for `--continue` launches (most of the fleet, `BGOS_CONTINUE=1`) the env id is a pre-generated id that is DISCARDED when the CLI resumes the previous session file (daemons 91759, 95118, 95678, 16445: env id has NO matching file; writes go to the resumed old-id file).
- `lsof` on the parent CLI: the transcript is not held open between appends. Dead end.
- Reply markers (CHOSEN primary): every successful `reply` returns `Sent (message_id: N)` and the CLI writes that tool_result VERBATIM into our transcript as a `type:"user"` entry (verified in live transcript 50724ca1/observer). The daemon minted N, so a tail hit is positive proof of ownership. Survives `--continue` AND mid-life rotation (/clear), self-healing on the next reply.

Resolution chain (lib/session-binding.ts, `SessionTranscriptBinder`): marker hit > sticky marker binding > env session id file > sticky previous binding > newest-mtime last resort (one-time log line). Newest-mtime at daemon BOOT is still the correct approximation for `--continue` (the CLI itself picked newest-mtime an instant earlier); stickiness then stops a foreign session from stealing the binding via mtime, which was the original bug. Marker scans read 256KB tails of only recently-active (30 min) transcripts, with a bound-file fast path. `reportContextPct` and the compact watcher both read through the binder; `readContextPct` in usage-report.ts is retained as the documented legacy fallback + test surface.

## E2E evidence (throwaway sessions only; no live session touched)

Stage 1, real module against a throwaway shell (`tmux -L realcompacttest`, session `throwaway-shell` running `cat > sink`):

```
target: {"target":"throwaway-shell","socketArgs":["-L","realcompacttest"],"source":"env-session"}
probe ok (target alive)
capture-pane: /compact
cat sink bytes: /   c   o   m   p   a   c   t  \n  \n
```

Stage 2, throwaway claude (`claude --dangerously-skip-permissions --strict-mcp-config` in an empty scratch dir, own tmux socket), injected via the same module:

```
> /compact
  L  Not enough messages to compact.
```

The literal reached the composer and EXECUTED (one execution; the paste-safety Enter did not double-run). Throwaway tmux server killed afterwards.

## Test tally

- Baseline at start: 478 pass (origin/main a4f1c76). After rebase onto 39cc106 (#33 added 4): baseline 482.
- Final: **513 pass, 0 fail** (`bun test`, 27 files). New: compact-inject 10, compact-confirm 6, session-binding 13 (incl. fs-backed binder tests with real-shape fixtures), slash-catalog +1, usage-report refactor covered by existing 24.
- `tsc --noEmit`: only the pre-existing main errors (bun:test types, `import.meta.dir`); no new errors. `bun build server.ts` bundles clean.
- Version parity: package.json = plugin.json = 0.24.0 (CI `version-check.yml` gates equality).

## What supervisors must add (keepalive pattern)

For a keepalive that launches claude inside tmux (example: assistant 900 in `tmux -L default` session `data-900`), export the contract before the claude line:

```sh
export BGOS_TMUX_SESSION="data-900"        # the tmux session that hosts claude
# export BGOS_TMUX_SOCKET="default"        # only if launched with tmux -L <name>
tmux -L default new-session -d -s data-900 'claude --continue --dangerously-skip-permissions ...'
```

Note the env must be visible to the claude PROCESS (set it inside the tmux command or the session environment, e.g. `tmux -L default new-session -d -s data-900 'BGOS_TMUX_SESSION=data-900 BGOS_TMUX_SOCKET=default claude ...'`). On THIS fleet even that is optional: any claude already running inside tmux auto-detects via inherited `TMUX`/`TMUX_PANE` and targets its own exact pane, which is more precise than a session name. Set `BGOS_REMOTE_COMPACT=off` to opt a host out.

Rollout: update the plugin to 0.24.0 and restart the daemon; the capability logs `remote compact capability ON/OFF ...` at boot and the catalog re-syncs within 5 minutes (Compact button appears only on capable installs).

## Deferred

- `/new` remote injection: mechanically identical (add one allow-list entry) but the CLI reset command is `/clear` and BGOS's `/new` naming needs a mapping decision plus its own confirmation story (session rotation, binder re-bind). Documented in the slash-catalog invariant as future work; the binder already survives rotation via markers.
- After-pct when the session stays idle post-compact: no assistant usage entry exists until the next turn, so the confirm reply falls back to "gauge refreshes on the next turn". An optional synthetic wake turn could produce an immediate after-pct; intentionally not done (costs a model turn).
- In-fleet live QA: needs a plugin update + daemon restart on a tmux-hosted agent (e.g. 900) and a real Compact tap from the app; not run from this session (live fleet is read-only per ground rules).
