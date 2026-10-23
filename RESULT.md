# RESULT: owner model and effort control for a running Claude Code session (Route A)

Branch `feat/owner-model-effort-control`, off the plugin's main at `457210c`. Board row c0cc7944. Not pushed (no GitHub access here); Data fetches the branch over ssh. Plugin bumped to 0.75.0 with a CHANGELOG entry. Commits: `078fe83` (red first tests), `81bae66` (implementation), `33469f8` (release bump), and this file.

Built exactly as KC approved it: "Route A exactly as this proposal writes it, and nothing wider. Two typed operations only, set_model and set_effort, built from the frozen literal tables in compact-inject.ts. No slash command or free text on the wire. A separate owner opt-in for remote model and effort control (the compact permission does not count). Every precondition you listed before typing."

## What was built

| Piece | File | What it does |
| --- | --- | --- |
| Frozen literal tables | `lib/compact-inject.ts` | `MODEL_LITERALS` (opus, sonnet, haiku, fable, each `/model <family>`) and `EFFORT_LITERALS` (low, medium, high, xhigh, max, each `/effort <level>`). `buildSetModelInjectionSteps` and `buildSetEffortInjectionSteps` accept only an exact own key and return null (no argv at all) for anything else. They type the literal, then ONE Enter (the proposal's warning about a second Enter accepting a menu item). Ultra Code has no literal. Two read only probes (`display-message` pane state, `capture-pane -e`) are built here too, so every tmux argv still comes from this one file. |
| Pane reader | `lib/model-effort-pane.ts` | Parses the pane state; proves the pane is the agent's (its root process is an ancestor of the daemon, and the terminal's foreground group is the daemon's own job below that root, so a shell in front of a suspended CLI is refused); reads the composer (empty, draft, or unknown) from the CLI's two known layouts, telling a dimmed placeholder from a typed draft. |
| Opt in, bridge, observations | `lib/model-control-store.mjs`, `bin/hoai-statusline-bridge.mjs`, `bin/hoai-model-control.mjs` | The owner's per agent opt in, written only by `hoai-model-control on --assistant <id>` on the agent's machine. `on` also installs the status line bridge in front of the owner's own status line (kept, still run and printed), with `refreshInterval` 2 s. The bridge stores session id, model id, effort and version from Claude Code's own status line JSON as numbered observations, owner only (0600 in 0700, symlinks and shared files refused). The status line runs a stable copy of the bridge in the owner only folder, refreshed by the daemon at boot, so a marketplace update does not break it. `off` for the last agent puts the owner's line back. |
| Catalog and report | `lib/model-effort-catalog.ts` | Available efforts from the installed CLI's own `claude --help` `--effort` choices; available models from the aliases its own `--model` help names; each kept only where the frozen table has a literal. Never a hard coded list. The report carries the model and effort now (the session's own words), the available lists, Ultra Code as unavailable with the proposal's sentence, and whether a change could be attempted now and why not. |
| Transaction | `lib/model-effort-control.ts` | Every precondition below, in order, then type once, then confirm from a NEWER observation of the SAME session reporting the requested value. Holds an exclusive lock. |
| Wire | `lib/model-effort-rpc.ts` | The typed frame, the owner rule, main chat only, dedupe, answers, and the report through the existing session settings rail. |
| Server wiring | `server.ts`, `lib/declared-capabilities.ts`, `lib/steer.ts` | The `model_effort_rpc` socket event (lock holder only, never during a drain, tracked so a restart drain waits); the control lock held against compact, goal typing, steer and incoming deliveries; the `owner_model_effort_control` token on the heartbeat only while every precondition for advertising holds. |

## The wire

BGOS #3060's capability canon and DTO are not readable from this worktree: `~/hoai-work/BGOS.git` main (`765196150`) has no `backend/src/integrations/model-effort-picker.*`, and no branch carries it. What main does have is the Codex slice (P5 stage 7, C-26): the `session_model_control` token, the report route, and a row whose tap sends `/model` as a slash command. So the wire below is ASSUMED, shaped on the plugin's own `changes_rpc` and on that report route. It must be matched against #3060 before the app sends a frame.

**Request** (backend to the pairing room, socket event `model_effort_rpc`):

```json
{
  "rpcId": "uuid",
  "op": "describe | set_model | set_effort",
  "assistantId": "42",
  "chatId": "chat id",
  "chatKind": "main",
  "value": "sonnet | high (absent for describe)",
  "sender": { "userId": "the human who tapped", "relationship": "owner" },
  "isSharedRecipient": false,
  "shareOwnerUserId": null
}
```

`value` is a lookup key: a family alias for set_model, a level for set_effort. Never a slash command, never text.

**Answer** (`POST integrations/model-effort-rpc/:rpcId/result`):

```json
{ "ok": true, "payload": { "applied": true, "report": { ... } } }
{ "ok": false, "error": { "code": "composer_not_empty", "message": "one plain sentence" }, "payload": { "report": { ... } } }
```

`applied: false` with ok means it already ran that value (nothing typed). The report:

```json
{
  "model": "claude-sonnet-5-5", "modelFamily": "sonnet", "modelDisplayName": "Sonnet",
  "effort": "high", "runtimeVersion": "2.1.309",
  "availableModels": ["fable", "opus", "sonnet"],
  "availableEfforts": ["low", "medium", "high", "xhigh", "max"],
  "ultracode": { "available": false, "reason": "This host cannot confirm Ultra Code remotely." },
  "canChange": true, "cannotChangeCode": null, "cannotChangeReason": null,
  "observedAt": "ISO time the session reported it"
}
```

**The pill**: after every answer that has a report, the daemon also writes the EXISTING rail, `PATCH integrations/assistants/:assistantId/chats/:chatId/session-settings` with `{ model, effort, serviceTier: null, rerouted: false, reportedAt }`, the five fields and patterns of BGOS `report-session-settings.dto.ts` (pinned in `test/model-effort-rpc.test.ts`). A model id the route's pattern refuses (for example `claude-opus-5-5[1m]`) is not sent.

**Capability**: `owner_model_effort_control`, on pairing connections only, declared only while opted in, the injector answers, the bridge has a fresh observation of the proven session, and the installed CLI's help offers something. Deliberately not `session_model_control`, whose words promise Codex semantics. The app needs #3060 to read this token (and to draw the row for a Claude agent), which is the BGOS side.

## Each precondition and its test

Unit cases on a fake pane: `test/model-effort-control.test.ts` (25). Every refusal case also asserts that NOTHING was typed and the lock was released.

| # | Precondition (refusal code) | Test |
| --- | --- | --- |
| 1 | Sender is provably the owner (`not_owner`): share recipient, owner id labelled recipient, malformed or absent sender | `model-effort-rpc.test.ts` "a share recipient is refused before the control is consulted" |
| 2 | Main chat only (`not_main_chat`) | `model-effort-rpc.test.ts` "a side chat, a group or a room is refused" |
| 3 | Only set_model, set_effort, describe (`unsupported_op`) | "an op outside the two typed operations is refused" |
| 4 | Value is an exact own key of the frozen table (`unsupported_value`), injection attempts included | "every value outside the frozen tables is refused", and `model-effort-literals.test.ts` "every injection attempt builds NO argv at all" |
| 5 | Ultra Code (`ultracode_unconfirmable`, "This host cannot confirm Ultra Code remotely.") | "Ultra Code is refused with the proposal's own sentence" |
| 6 | Exclusive control lock (`control_busy`), held synchronously from entry | "the control lock is exclusive", "a running turn ... another injection"; wiring: `model-effort-wiring.test.ts` (compact, goal, steer, deliveries) |
| 7 | Owner opted this agent in, separately from compact (`not_opted_in`), checked before the terminal is looked at | "no owner opt in: refused before the terminal is even looked at"; store: "the opt in is per agent, off by default, and refuses a planted file" |
| 8 | A tmux target (`no_terminal`) | "no terminal, no bound session, no status source, a stale status source" |
| 9 | A PROVEN session id (`session_unknown`) | same |
| 10 | A status source for that session (`no_status_source`) and a fresh one (`stale_status`, 15 s) | same |
| 11 | The installed CLI offers the value (`not_in_catalog`) | "a family the installed CLI does not name is not offered" |
| 12 | An effort change needs a model that reports effort (`effort_unsupported`) | "an effort on a model that reports none is refused" |
| 13 | Idle by the hook turn signal (`busy_turn`), unknown refused (`turn_unknown`) | "a running turn, an unknown turn state, ..." |
| 14 | No permission question open (`dialog_open`) | same |
| 15 | Pane alive (`pane_lost`) and not in a tmux mode (`pane_in_mode`) | "a lost pane, a dead pane, a pane in a tmux mode" |
| 16 | The agent's own CLI is in front in that pane (`pane_not_agent`) | "a pane whose foreground is not the agent"; `model-effort-pane.test.ts` "the agent owns the pane only when ..." (suspended CLI with a shell in front, another program in front, a pane that is not an ancestor, another terminal) |
| 17 | Composer empty (`composer_not_empty`), draft left untouched, no Escape ever | "an occupied composer is refused and the owner's draft is left exactly as it was"; rig: "a real draft in the pane is refused and left exactly as the owner typed it" |
| 18 | A recognisable composer (`composer_unknown`) | "a screen with no recognisable composer is refused"; pane fixtures |
| 19 | Turn, dialog, lock and session checked AGAIN right before typing | "a turn that starts while the pane is being checked stops the typing" |
| 20 | Confirmation: a newer observation of the same session with the requested value (`not_confirmed`) | "FALSE SUCCESS: echoed input is not confirmation", "FALSE SUCCESS: status ticks that advance without the change", "a slow status line still confirms within the window"; rig: "echoed input that never applies is not confirmed" |
| 21 | Session changed mid confirmation (`session_changed`) | "a session that changes during confirmation is reported, never claimed" |
| 22 | A failed keystroke is reported once, never retried (`inject_failed`) | "a failed keystroke is reported once and never retried" |
| 23 | A re sent frame never types twice | `model-effort-rpc.test.ts` "a re sent frame never types twice" |

End to end on a REAL tmux server with a FAKE agent (`test/model-effort-tmux-rig.test.ts`, 4 cases): the real argv typed by real `tmux send-keys`, the real pane probes, real `ps` ancestry, and confirmation from observations written by the real bridge. The fake agent (`test/fixtures/fake-claude-tui.mjs`) draws the composer and applies `/model` and `/effort` the way the CLI does. Each rig server is on a socket file in the test's own temp folder (`-S`), killed with `kill-server` on that socket and the folder removed; the stand in daemon child exits on its own when its parent goes. No other tmux server, session or agent was touched.

## Test runs

- New files, all green: `model-effort-literals` 7, `model-effort-pane` 9, `model-control-store` 12, `model-effort-catalog` 8, `model-effort-control` 25, `model-effort-rpc` 10, `model-effort-wiring` 8, `model-effort-tmux-rig` 4.
- Red first: commit `078fe83` holds the tests before any implementation (every new file failed on its missing module or export). Two corrections came after it, both before their implementation existed: the pane identity rule was tightened (the shell in front of a suspended CLI) and the rig moved to private socket files; both are in the implementation commit.
- `npx tsc --noEmit`: clean.
- Full suite (`npm test`, node:test family; bun is not installed on this laptop, so the bun:test files could not run): 7161 tests, 7049 pass, 49 fail, 63 skipped on the first full run. 4 of the 49 were this branch's and are fixed (the frame name must be a literal for the stand down guard, `changes_rpc` must stay right after `memory_rpc`, and the steer and stop pause pins named the old expressions); those files now pass (253 tests across every new and touched file: 252 pass, 0 fail, 1 skipped). The other 45 are in 12 browser profile files, and two of those files (`browser-profile-active-backup`, `browser-profile-companion-backups`) hang with no timeout. Each of the 12 files was run on main `457210c` and on this branch with a 120 s cap: the same pass and fail counts and the same failing test names on both, hangs included. They fail on this machine without this change.

## What a live check on a real agent must still show

None of this was run against a real Claude Code session (the brief forbids it). Before the app is allowed to send a frame, a live check on the supported CLI version (2.1.309 here) must show:

1. **The status line reports a change while idle.** With the bridge installed (`refreshInterval` 2), `/model sonnet` and `/effort max` typed by hand produce an observation with the new `model.id` and `effort.level` within a few seconds and with no new turn. The docs list no status line trigger for `/model` or `/effort`, which is why the refresh interval is there; confirm it fires while idle.
2. **`/model <family>` and `/effort <level>` apply directly on one Enter**, with no menu, confirmation or second prompt on this version. If either opens a menu, the one Enter may pick an item: stop and change the submission before enabling.
3. **The composer layouts.** Capture the pane (`tmux capture-pane -p -e`) of an idle session with an empty composer, with the placeholder showing, with the cursor on the placeholder, with a typed draft, with a multi line draft, during a turn, and with a permission dialog open, and run `readComposer` on each: empty, empty, empty, draft, draft, (empty composer while busy is refused by the turn check), unknown or draft. If the CLI draws the composer differently, the fixtures in `test/model-effort-pane.test.ts` change first.
4. **The pane identity holds for the real process tree**: the MCP daemon's `ps` ancestry reaches the pane's root, and the CLI's job is the foreground group (`pgid == tpgid`), both when tmux runs `claude` directly and when it runs a shell that runs `claude` (bgos-agent, hoai run). If Claude Code starts MCP servers in their own process group, the rule still holds through the CLI's own entry; confirm.
5. **The alias resolves to the family**: after `/model fable` the status line `model.id` contains `fable` as a token (the `modelFamilyOf` rule).
6. **A model without effort support** (haiku, if offered) omits `effort` from the status line, so efforts are offered as none.
7. **The owner's own status line is unchanged** in look while the bridge is in front of it, and `hoai-model-control off` restores it byte for byte.
8. **The app side**: #3060 sends exactly the frame above (or this file's wire is changed to match), stamps the sender per frame, reads `owner_model_effort_control`, and draws the pill from the session settings report.

## Not done, and why

- **The BGOS side**: the picker for a Claude agent, the `model_effort_rpc` emit, the result route and reading the token are #3060's, not in this repo, and the wire above is assumed.
- **Ultra Code**: refused by design. No session native report this daemon can read distinguishes it from xhigh; the proposal says to disable it without that evidence.
- **Both at once**: a frame carries one operation, so there is no partial state and no rollback path. A picker that changes both sends set_model, waits for its answer, then set_effort, and each answer carries the true report.
- **Report push without a request**: the pill is refreshed with every answer (describe included). A change made by hand in the terminal reaches the pill on the next describe, not on its own; a watcher that PATCHes on every observation change would need to know which chats to report to.
- **Model ids with brackets** (`[1m]`) are refused by the BGOS route's pattern, so they are not reported on the rail (they are in the RPC answer).
- **Windows**: no tmux, so no terminal, so the capability is never declared there.
- **The `availableModels` user setting** of Claude Code (an allowlist an admin can set) is not read; the catalog is the CLI's own help.
- **A project level `statusLine`** overrides the user level one, so the bridge never runs for that project: no observations, the capability is not declared there (fails closed). `hoai-model-control status` does not detect it.
- **Publishing** (tag, marketplace ref, the app's pin) stays with Data.

## Processes

Started: the test runners, and inside the rig test one private tmux server per case (socket file in the test's own temp folder) with the fake agent and its stand in child. Stopped, all of them mine:

- the rig servers, by the test itself (kill-server on its own socket, folder removed); none remained (checked). An early rig version used `-L` names and left four stale socket files of its own in the tmux folder (`hoai-mec-rig-68288-*`, no server behind them); those four were deleted and the rig moved to `-S` sockets in its temp folder.
- the two hung browser profile test processes of my own full run (PIDs 74674, 75056), so the run could finish;
- the orphaned children of my own first baseline attempt (PIDs 46631, 46632, 46634, `browser-profile-active-backup` on main), after a capped wrapper died without them; the baseline was then rerun with a runner that kills its own process group.

A temporary detached worktree of main at `457210c` was used for the baseline and removed. No real agent, session or other tmux server was touched; no settings file outside temp folders was written.
