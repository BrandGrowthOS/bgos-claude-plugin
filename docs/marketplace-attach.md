# Marketplace attachment scope

The machine wide marketplace copy starts in every Claude Code session. It now
attaches only when the resolved agent belongs to the launch folder or the
session explicitly opts in. A matching `.bgos-agent-id` pin or the resolved
credentials file's `homeDir` establishes the home. On a host with multiple
agents and no identity pin, exactly one credentials file must name this home.
Two files naming the same home remain ambiguous. An inherited
`BGOS_ASSISTANT_ID` alone does not establish that the current folder is a home.
A pin naming another agent refuses attachment even if the environment names
this agent.

Outside that scope the copy completes the MCP handshake with no tools and no
channel capability. It writes one plain `marketplace dormant` log line. It does
not acquire a pairing lock, poll, publish presence, or connect to the backend.
Duplicate copies still stand aside first, without writing scope telemetry.

## Explicit opt-in and rollback

The `hoai` launcher sets `HOAI_ATTACH_SCOPE` when a folder, environment, or
supervisor explicitly names the agent, and `HOAI_ATTACH_SCOPE_DIR` to the
launch folder. A matching scope opts in from outside the recorded home. With
no explicit identity, it sends only the launch folder and the daemon resolves
the agent after Claude applies the marketplace configuration. This folder-only
intent also opts in, including for a legacy pairing without a recorded home.
A marker inherited from a different folder does not opt in. An explicit scope
or folder pin naming a different agent still refuses attachment. The scope
verifies the resolved identity; it does not choose credentials.

For a deliberate one-process override, set `BGOS_ALLOW_ANY_FOLDER=1` (or `true`).
The existing `HOAI_ATTACH_SCOPE_MODE=off` also disables attachment enforcement.
To disable it for the whole host, write `{"mode":"off"}` to
`~/.bgos-agent/attach-scope.json`. Removing that setting restores the marketplace
home default. These overrides do not create a pairing or select an agent on an
ambiguous host; configure the intended credentials as usual.

The existing `strict` mode still requires launcher scope, including in an agent
home. `wrong-agent` mode accepts a matching home but rejects another agent or
an unrelated folder. Clone installs retain their existing mode defaults.

## Failure handling and evidence

Unreadable scope, credentials, folder evidence or settings fail open. Missing
pairings and absent home evidence are known absence, so an unrelated session
stays dormant. Invalid settings also fail open as in the previous scope design.

Each evaluated dormant start appends one event to the existing bounded
`<plugin state>/attach-scope-events.jsonl`; attached starts are counted by the
normal startup path. The default marketplace mode is recorded as `home`, with
the existing `match`, `wrong-agent`, `unscoped`, and `unreadable` outcomes.
The event retains the resolved agent, launcher, folder, route, verdict, and
counterfactual refusal class. Read it with `bin/hoai-attach-scope.mjs --json`.
Home admissions retain their strict-mode refusal forecast even though their
effective outcome is `match`. The diagnostic command reports the detected
install's effective `mode`, its legacy `setting`, and `installMethod`
separately. Thus an unconfigured marketplace install shows mode `home` and
setting `off`; a clone keeps its `off` default.
The local `recorded-home` route denotes selection by unique home; backend
stand-down reporting uses its existing `unknown` route for that new case.
No new heartbeat or backend fields are required.
