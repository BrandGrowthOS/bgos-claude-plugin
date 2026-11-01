# RESULT: owner model and effort control for a running Claude Code session (Route A)

Branch `feat/owner-model-effort-control`, off the plugin's main at `457210c`. Board row c0cc7944. Not pushed (no GitHub access here); Data fetches the branch over ssh. Plugin bumped to 0.75.0 with a CHANGELOG entry. Commits: `078fe83` (red first tests), `81bae66` (implementation), `33469f8` (release bump), and this file.

**Round 3 (0.74.4) replaced the wire.** BGOS #3060 merged and is authoritative: the picker speaks `model_effort_picker` and voice_rpc `list_model_effort` / `apply_model_effort`, and the assumed `model_effort_rpc` wire with `owner_model_effort_control`, `set_model`, `set_effort` and `describe` described in the sections up to "Round 2" is gone. See "Round 3".

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
- First full run (`npm test`, default temp folder): 7161 tests, 7049 pass, 49 fail. 4 were this branch's (a literal frame name for the stand down guard, `changes_rpc` right after `memory_rpc`, and the steer and stop pause pins on the old expressions) and are fixed; the other 45 were the browser profile files and the `/var` symlink, explained below. The final whole suite run is green (next section).

### Whole suite: green at `d29fc86`

Every node:test file (361, nothing excluded) and every real Chromium file (7, one at a time, as `scripts/run-tests.mjs` runs them), with `TMPDIR=/private/tmp/claude-501/mec`:

- node:test: 7175 tests, **7112 pass, 0 fail**, 0 cancelled, 63 skipped (exit 0).
- Chromium: all 7 files exit 0 (2, 1, 7 and 1 pass; the other three skip on this host), 0 fail.
- bun:test (14 files): not run, bun is not installed on this laptop.

Why `TMPDIR`: the earlier runs used macOS's default `os.tmpdir()`, under `/var/folders/...`, and `/var` is a symlink to `/private/var`. The browser profile state code refuses any symlink on the path to its own folder (`lib/browser-profile-companion-state.mjs` `_directory`), so its 12 test files failed or hung there, on main `457210c` exactly as on this branch (the per file comparison below). With a temp folder whose path has no symlink they pass. The folder must also be outside a git checkout: inside this worktree, the bootstrap tests saw the repository and failed, which is why it is under the session's temp root. No code was changed for this.

The whole suite runs also found two of this branch's own defects, fixed in `d29fc86`: `test/pairing-lock-standdown.test.ts` classifies every socket frame and now lists `model_effort_rpc` as a lock holder frame; and the rig's draft case raced its own simulated keystrokes (the control read the pane before the fake agent had drawn them, and typed), so the case now waits until the draft is on screen. That race is real in production too, see "Not done". A load sensitive timing case in `browser-profile-runtime.test.ts` failed once under the default temp folder and passed alone on main and on the branch; it passed in the green run above.

### Red first, then green (rerun on the final commits)

| Test file | At `078fe83` (tests only) | At `493d837` (HEAD) |
| --- | --- | --- |
| `model-effort-literals` | fails: no export `EFFORT_LITERALS` | 7 pass, 0 fail |
| `model-effort-pane` | fails: no module `lib/model-effort-pane.ts` | 9 pass, 0 fail |
| `model-control-store` | fails: no module `lib/model-control-store.mjs` | 12 pass, 0 fail |
| `model-effort-catalog` | fails: no module `lib/model-effort-catalog.ts` | 8 pass, 0 fail |
| `model-effort-control` | fails: no module `lib/model-effort-control.ts` | 25 pass, 0 fail |
| `model-effort-rpc` | fails: no module `lib/model-effort-rpc.ts` | 10 pass, 0 fail |
| `model-effort-wiring` | fails: no export `OWNER_MODEL_EFFORT_TOKEN` | 8 pass, 0 fail |
| `model-effort-tmux-rig` | fails: no module `lib/model-effort-control.ts` | 4 pass, 0 fail |

Existing files this branch touched, at HEAD: `compact-inject` 16, `steer` 39, `stop-pause-wiring` 5, `changes-wiring` 4, `mission-ws-wiring` 22, `declared-capabilities` 36, `pairing-lock` 40, all pass, 0 fail.

### Under the default temp folder the browser profile files fail identically on main

Kept for the record (the cause is the `/var` symlink above). Each file run alone with a 120 s cap that kills its whole process group, on a detached worktree of main `457210c` and on this branch, with the default `TMPDIR`:

| File | main | branch |
| --- | --- | --- |
| browser-bootstrap | 19 pass, 1 fail | 19 pass, 1 fail |
| browser-profile-active-backup | hangs (killed at 120 s) | hangs (killed at 120 s) |
| browser-profile-artifacts | 0 pass, 2 fail | 0 pass, 2 fail |
| browser-profile-backup-workers | 1 pass, 1 fail | 1 pass, 1 fail |
| browser-profile-companion-backups | hangs (killed at 120 s) | hangs (killed at 120 s) |
| browser-profile-companion-state | 1 pass, 4 fail | 1 pass, 4 fail |
| browser-profile-companion | 35 pass, 8 fail | 35 pass, 8 fail |
| browser-profile-downloads | 21 pass, 1 fail | 21 pass, 1 fail |
| browser-profile-files | 16 pass, 7 fail | 16 pass, 7 fail |
| browser-profile-peer-pins | 1 pass, 4 fail | 1 pass, 4 fail |
| browser-profile-peer-review | 3 pass, 1 fail | 3 pass, 1 fail |
| browser-profile-portable-extras | 0 pass, 10 fail | 0 pass, 10 fail |

None of these files imports anything this branch changed. With the symlink free `TMPDIR` they all pass (the green run above).

### On the wire and #3060

The brief says: read `backend/src/integrations/model-effort-picker.*` on `~/hoai-work/BGOS.git` main "if present, else describe the wire you assume". It is not present on main (`765196150`) or on any local branch, and `git fetch` is not possible here, so the wire above is the described assumption. The parts that ARE on BGOS main were matched exactly: the session settings route's path, five fields and patterns (pinned in `test/model-effort-rpc.test.ts`), the pairing token grammar, and the backend's chat kind rule.

## Security review fixes (0.75.1)

An independent reviewer read the branch at `a15f7e7` (`REVIEW-275.md`, kept outside the repository). Fixed here: H1, M2, L5, L6, on top of `9fc1b03`, not rewritten and not pushed. Commits: `d9f06fe` (the red first tests), `8995dd6` (H1), `a89f9ac` (M2 and L5), `f12aacc` (L6), `07dff40` (rig harness race), `1b1f936` (the 0.75.1 bump and this section), `73340eb` (rig cleanup), then the whole suite record below. Every red line below is the first assertion that failed, run against the code at `9fc1b03` with the new tests in place. "Mutation" means that fix alone was reverted in the working tree at the fixed HEAD and its tests run again; each was restored with `git checkout` afterwards.

| Finding | Fix | Test | Red line (first failure, before the fix) |
| --- | --- | --- | --- |
| **H1** A draft whose first `>` ends the line (`const f = () =>`, `<div>`, `x >`) read as an empty composer, so the draft was submitted with `/model ...` appended. | `lib/model-effort-pane.ts`: the prompt glyph is the first visible character of the prompt line (after the box frame), never a `❯` or `>` found further along (`afterPrompt`, on styled glyphs, not `indexOf` on the raw line). Any line between the prompt and the closing frame is the owner's: text, a blank line (a typed newline, or a draft that filled the line and wrapped the cursor). Anything drawn before the drawn cursor is typed, spaces included. A continuation line drawn only faint is `unknown`, refused. New `composerText` reads the typed text exactly (used by L5). | `model-effort-pane.test.ts`: "H1: a draft containing, starting or ending with > is a draft, in both layouts" (11 drafts, ruled, ruled with `>`, boxed, styled), "H1: a multi line draft ...", "H1: a draft that wraps ...", "H1: spaces typed before the drawn cursor ...", "H1: composerText reads the typed text exactly ...". Rig: "H1: a real draft ending with > is refused and left exactly as the owner typed it" (the reviewer's own case on a real tmux server). | `AssertionError [ERR_ASSERTION]: ruled: "const f = () =>"` with `'empty' !== 'draft'` (4 of the 4 readComposer cases red; the composerText case was skipped in that run because the export did not exist yet). Rig: `AssertionError [ERR_ASSERTION]: ● Unknown: const f = () =>/model sonnet`. |
| **M2** With a session name target the pane was proven on one pane and typed into another (tmux resolves a name to the active pane on every call). | `lib/model-effort-control.ts`: `checkPane` returns the PROVEN pane by its own id (`%N`, read in the same `display-message` that gave the tty and root pid the ancestry check proves). The capture, the literal, the L5 re-read, the Enter and the timeout capture all name that id. | `model-effort-control.test.ts`: "M2: a session name target is proven once, then every read and key goes to the proven pane id" (a window opened right after the screen read), "M2: the window switching before the screen read ...". Rig: "M2: a window opened mid request does not receive the keys; the proven pane does" (`new-window ... cat` inside the request, real tmux). | `AssertionError [ERR_ASSERTION]: keys typed into a pane that was never proven`, actual `[ 'tmux', '-L', 'fake', 'send-keys', '-t', 'agent-session', '-l', '--', '/model sonnet' ], [ ..., 'send-keys', '-t', 'agent-session', 'Enter' ]`. Rig: `AssertionError [ERR_ASSERTION]: the new window received keys: /model sonnet`. |
| **L5** The Enter followed the literal 400 ms later with nothing read in between. | `lib/model-effort-control.ts` `checkTyped`: after the literal and the same 400 ms, the composer is captured again and `composerText` must equal the literal exactly. Otherwise no Enter, and the refusal `composer_changed`. The literal is cleared, one BSpace per character (`buildClearTypedArgs`, `lib/compact-inject.ts`), only when the composer ENDS with it, so a BSpace can only remove what the daemon typed; the answer says "What was typed was cleared." only when a second read shows exactly what was there before it. A key typed after the literal, or a screen without a composer (a dialog), gets no key at all, and the answer says where the literal was left. | `model-effort-control.test.ts`: "L5: the composer is read again between the literal and the Enter", "L5: an owner key that lands before the literal is cleared off it, never submitted", "L5: an owner key that lands after the literal is left as it is, never submitted", "L5: a dialog that opens in the gap gets no Enter and no other key". | `AssertionError [ERR_ASSERTION]: ["send-keys","send-keys"]` (no read between the two keys); the owner key cases: actual `'not_confirmed'`, expected `'composer_changed'` (the Enter had been pressed); the dialog case: the Enter went in and the fake reported `"ok":true`. |
| **L6** rpcIds were logged raw (the sender's text, so a newline forged log lines). | `lib/model-effort-rpc.ts` `rpcLogTag` (sha256, first 12 hex), used at the not_owner refusal, the result post failure (which now logs the HTTP status or error class, not the error text: a timeout's text names the request path, the id in it), and `server.ts` at "model_effort_rpc received". | `model-effort-rpc.test.ts` "L6: an rpcId is never logged raw, only as a short hash" (an id carrying a forged log line); `model-effort-wiring.test.ts` "L6: the daemon logs a received rpcId as its short hash, never raw". | `AssertionError [ERR_ASSERTION]: raw rpcId in the log: "model_effort_rpc: refused not_owner (rpc rpc-7\n[2026-10-24T00:00:00Z] model control: set_model sonnet applied)"`; wiring: `AssertionError [ERR_ASSERTION]: the raw rpcId is the sender's text`. |

**M1, left as the review wrote it:** the owner rule rests on the backend. `isOwnerSender` trusts `sender.userId`, `sender.relationship`, `isSharedRecipient` and `shareOwnerUserId` as the frame carries them, so a compromised backend passes it for every frame; the BGOS side (#3060) must stamp `sender.relationship` (and `sender.userId`) on each `model_effort_rpc` frame from the server's own authenticated session, never from anything the client sends.

**Mutation, each fix reverted alone** (output in the session scratchpad, first failing lines quoted):

- H1 reverted (the glyph found anywhere in the line, the old continuation rule, no cursor rule): pane file 9 pass, 5 fail, all five H1 cases (`ruled: "const f = () =>"`, `'empty' !== 'draft'`); rig 5 pass, 1 fail, "H1: a real draft ending with > ..." (`● Unknown: const f = () =>/model sonnet`).
- M2 reverted (the proven target is the configured one again): control 29 pass, 2 fail, both M2 cases (`keys typed into a pane that was never proven`; `"code":"composer_unknown"`); rig 5 pass, 1 fail, the M2 case (`the new window received keys: /model sonnet`).
- L5 reverted (the Enter right after the 400 ms, no re-read): control 27 pass, 4 fail, all four L5 cases (`["send-keys","send-keys"]`; `'not_confirmed'` twice; `"ok":true` for the dialog).
- L6 reverted (the raw id at all three log sites): rpc and wiring 18 pass, 2 fail, both L6 cases (`raw rpcId in the log: ...`; `the raw rpcId is the sender's text`).

**A harness race the mutation runs surfaced** (`07dff40`, test only): the rig's fake agent wrote its status line observation before redrawing, at start and after each applied command, so under load the control confirmed a change and then read a screen still showing the submitted line (`composer_not_empty`) or not yet drawn (`composer_unknown`). The fake now draws before it reports, and `startRig` waits for the first frame. Three consecutive rig runs after it: 6 of 6 each.

**The rig's cleanup** (`73340eb`, test only): in whole suite run 5 every rig test passed but its `after` hook threw `ENOTEMPTY`: a status line bridge the dying fake agent had in flight wrote `model-control/observations/rig-draft-*.json` into a folder already emptied, and since the hook killed and removed one rig at a time, the throw left the three later rig servers running. The hook now SIGKILLs each fake agent's own process group (the pane's process leads it, with its stand in daemon and any bridge in flight) and kills every server before any folder goes, then waits for each agent to exit and removes its folder with retries. Eight rig runs after it: 6 of 6 each, no process and no rig folder left.

**Whole suite** (`TMPDIR=/private/tmp/claude-501/mec2 node scripts/run-tests.mjs`, bun 1.3.14 on PATH, plus `npx tsc --noEmit`, exit 0 with no output at `1b1f936` and at `73340eb`): **green at `73340eb`** (run 7): node:test 7190 tests, 7151 pass, 0 fail, 39 skipped; real Chromium 15 tests, 11 pass, 0 fail, 4 skipped; bun 374 pass, 1 skip, 0 fail; `[run-tests] both families green`, exit 0. The runs before it were on a machine another session loaded to a 1 minute average of 95 to 358 on 18 CPUs (a jest run and an Android emulator, not this work's and left alone), and each failed one to three timing tests in files this branch does not touch, each of which passes run alone: run 1 `remote-browser-controls.chromium` (45 s timeout, cancelled); runs 2 and 3 `browser-profile-runtime` (`profile_target_tracking_unavailable` against a 30 ms fixture timeout, and "oversized native packets"); run 4 `browser-profile-downloads-failure` (`profile_download_cleanup_unconfirmed`); run 5 this branch's rig cleanup above (fixed); run 6 `hoai-core` "a fresh retry that stays up past the health window" (a 50 ms health window, the supervisor took 5.3 s to arm; `bin/hoai-core.mjs` and its test unchanged since `9fc1b03`).

**Processes for these fixes:** only test runners and the rig's private tmux servers (socket files under the symlink free `TMPDIR=/private/tmp/claude-501/mec2`), each runner and each server PID recorded in `pids.log` (worktree root, git excluded) by the wrapper that started it, and after every run the wrapper checked those PIDs. Once some were left alive: the three rig servers of whole suite run 5 (12270, 14076, 14359, with their fake agents 12273, 14082, 14363), stopped with `kill-server` on their own sockets and logged; after every other run none was left alive. Nothing ran against a real agent.

**Still open after these fixes:** a key the owner presses in the milliseconds between the L5 read and the Enter is still not seen (no screen read closes that); typed spaces with no drawn cursor are invisible to a screen read; L1, L2, L3, L4 and L7 are untouched (the brief named H1, M2, L5, L6). The stricter composer read (a blank or faint continuation line refuses) must be confirmed on the real CLI's empty composer in the live check below (item 3).

## Round 2 (0.75.2)

An independent check confirmed H1, M2, L5 and L6 fixed and guarded, and found one Medium that ships with this feature and two Lows. Each is fixed here on top of `d764672`, red first, not rewritten and not pushed. Commits: `bf43b9f` (the red first tests and the real CLI fixtures), `fddefa7` (Medium), `262543d` (L1), `a530310` (L2), `f397a7a` (the rig's L1 case waits for keys in flight), `53f350c` (the 0.75.2 bump and CHANGELOG), and this file.

### The Medium: what the real CLI draws

Read first from the installed CLI (`~/.local/bin/claude`, Claude Code 2.1.310, its own bundled source), then measured:

- **The placeholder** is drawn by the CLI's text input as `chalk.dim(placeholder)`, and with the cursor showing as `inverse(placeholder[0]) + chalk.dim(placeholder.slice(1))`. Measured on screen: `❯ \e[7mT\e[0;2mry "how do I log an error?"\e[0m`. SGR 2 only, in every theme and colour mode; no grey or black colour.
- **The light themes' `text` colour is `rgb(0,0,0)`** (the theme tables in the binary: light and light daltonized both carry `text:"rgb(0,0,0)"`, `inactive:"rgb(102,102,102)"`, `subtle:"rgb(175,175,175)"`). The old faint rule (any grey or black true colour with each channel at most 180, bright black, 256 greys 8 and 236 to 250) called all three faint.
- **What the brief asked to check, "typed text in rgb(0,0,0)"**: not so for the prompt itself on 2.1.310. Typed text, a draft starting with `>`, and the `[Pasted text #1 +40 lines]` tag are drawn in the DEFAULT colour (`\e[39m`) in both themes and both colour modes; the slash command of `/model sonnet` is drawn in the theme's suggestion colour (`38;5;105` or `38;2;87;105;247`). So the old reader happened to decide the real 2.1.310 screens right (the first live run below, at the unfixed `d764672` reader: the same decisions), but only because nothing the prompt drew today fell inside its grey rule: any text the CLI colours with its `text`, `inactive` or `subtle` colour, or a theme that draws input in them, would have read as empty. The fix stops guessing from colour altogether.
- **Inside tmux the CLI clamps itself to 256 colours** unless `CLAUDE_CODE_TMUX_TRUECOLOR` is set (its own colour setup: `if (TMUX && level > 2) level = 2`), so both were measured.
- **The prompt glyph is followed by a no-break space** (U+00A0), not a plain one. The reader's patterns use `\s`, which matches it; the fixtures and the fake agent now draw it.

**The fix** (`lib/model-effort-pane.ts`, `fddefa7`):

- Faint is SGR 2 and nothing else. No colour is ever faint.
- The composer is EMPTY only when it is proven: on the prompt line the drawn cursor (an inverse cell) sits at the very start, and is followed by nothing, or by an SGR 2 placeholder whose first letter (under the cursor) is not dim, and whose text is not one of the CLI's own reference tags (`[Pasted text #N`, `[Image #N`, `[...Truncated text #N`, the team setup guide tag; the CLI's own pattern for them, found in the binary). Anything before the cursor (dim or not, spaces included), any visible text after it that is not dim, or any line between the prompt and the closing frame is a DRAFT. No cursor drawn, a second inverse cell, a dim cursor letter, or a blank cursor followed by dim text is UNKNOWN (refused as `composer_unknown`).
- `composerText` (the L5 re-read before the Enter) keeps dim text: a placeholder is only there while nothing is typed, so after typing anything dim is the owner's. A dim tag in front of the command can no longer be dropped from the comparison.
- New `cursorFollows` (for L1, below).

Four existing pane expectations changed with it, all toward refusing: a prompt line with no cursor drawn (`❯ `, `❯`, the older box's `│ >`) and a dim placeholder with no cursor were `empty` and are now `unknown`; `composerText` keeps a dim hint after the command instead of dropping it. Every real 2.1.310 screen draws the cursor.

### The live check

A real Claude Code CLI (the installed 2.1.310), in a throwaway private tmux server (`tmux -S <socket file> -f /dev/null`, 120 by 40) in a scratch folder, `~/hoai-work/meswitch-live/work`. Its own config folder per theme (`CLAUDE_CONFIG_DIR=~/hoai-work/meswitch-live/cfg-light` or `cfg-dark`, each a `.claude.json` with that `theme`, onboarding done and the scratch folder trusted), so KC's own config, login and sessions were never read or written. A dummy `ANTHROPIC_API_KEY` (no login exists in that config, so nothing could reach a model; the CLI's managed settings fetch was refused with a 401 and it said so on screen), telemetry, error reporting, auto update and non essential traffic off, and `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=1` so a fresh session shows its `Try "..."` placeholder. Each theme ran twice: with the CLI's default inside tmux (256 colours) and with `CLAUDE_CODE_TMUX_TRUECOLOR=1` (true colour). Keys sent: literal text, `C-u` to clear, `Home`, `End`, and a 40 line paste through `tmux paste-buffer -p` (bracketed). **Enter was never pressed**; nothing was sent. Each screen was captured with `capture-pane -p -e` and read by the switch's own `readComposer`, `composerText` and `cursorFollows` from this worktree.

Decisions of the FIXED reader (`fddefa7`), second live run, 06:19 to 06:22 UTC. The four colour columns agreed on every row, so each row is one decision for 256 and true colour alike:

| Theme | Case | Decision (`readComposer`) | Re-read and clear (`composerText`, `cursorFollows`) |
| --- | --- | --- | --- |
| light | empty box with placeholder (`Try "how does <filepath> work?"`, cursor on the T) | **empty** | |
| light | typed draft `hello draft` | **draft** | |
| light | draft starting with `>` (`> quoted line`) | **draft** | |
| light | pasted 40 line draft (`[Pasted text #1 +40 lines]`) | **draft** | |
| light | the same, cursor moved to its start (`Home`) | **draft** | |
| light | box cleared again (`C-u`) | **empty** | |
| light | `/model sonnet` typed into the empty box | draft | `"/model sonnet"`, follows: **true** (the Enter would go) |
| light | then `Home`, `q`: the owner's key in front, the cursor moved | draft | `"q/model sonnet"`, follows: **false** (no Enter, no BSpace) |
| light | then `End` | draft | `"q/model sonnet"`, follows: **true** (the clear would go) |
| light | `/effort high` typed into the empty box | draft | `"/effort high"`, follows: **true** |
| dark | empty box with placeholder (`Try "create a util logging.py that..."`) | **empty** | |
| dark | typed draft `hello draft` | **draft** | |
| dark | draft starting with `>` (`> quoted line`) | **draft** | |
| dark | pasted 40 line draft (`[Pasted text #1 +40 lines]`) | **draft** | |
| dark | the same, cursor moved to its start (`Home`) | **draft** | |
| dark | box cleared again (`C-u`) | **empty** | |
| dark | `/model sonnet` typed into the empty box | draft | `"/model sonnet"`, follows: **true** |
| dark | then `Home`, `q` | draft | `"q/model sonnet"`, follows: **false** |
| dark | then `End` | draft | `"q/model sonnet"`, follows: **true** |
| dark | `/effort high` typed into the empty box | draft | `"/effort high"`, follows: **true** |

(The placeholder text is the CLI's random pick per session; 256 and true colour drew different picks, all read as empty.) The first live run (05:55 to 05:58 UTC) read the same screens with the UNFIXED reader at `d764672`: the same decisions on every row, for the reason above. Its captures, 32 of them (both themes, both colour modes, eight cases each), are now fixtures (`test/fixtures/claude-2.1.310-composer/`), replayed by `test/model-effort-pane-live.test.ts`, which also redraws each real draft in the light theme's `rgb(0,0,0)`, its `rgb(102,102,102)`, the dark theme's `rgb(80,80,80)`, bright black, two 256 greys and SGR 2: none may read as empty. All screens of both runs are kept in `~/hoai-work/meswitch-live/caps` and `caps-r1`, with the scripts that made them (`start.sh`, `matrix.sh`).

Not measured live: an empty box after a real turn (the prompt suggestion feature shows its suggestion there) and the box while a turn runs or a permission question is open, since the dummy key allows no turn. If the suggestion is drawn as the placeholder is (SGR 2, cursor on its first letter) it reads as empty; if it is drawn any other way it reads as a draft or unknown and the change is refused, never typed.

### L1: the clear, only with the cursor proven after the command

`lib/model-effort-control.ts` `checkTyped` (`262543d`): when the re-read shows the composer ending with the command but not equal to it, the pane is read AGAIN right before any key, and the BSpaces go only when that read shows the same text and `cursorFollows` holds: the cursor drawn once, as a blank inverse cell on the composer's last line with nothing after it, right after the whole command (a command that wrapped is not provable). Otherwise no key at all, and the answer says the command is still in the agent's message box. The live check above shows the rule on the real CLI (`Home`, `q`: false; `End`: true).

### L2: every received rail logs a hash

`server.ts` (`a530310`): the received lines of voice, memory (and a person's stopped lane), changes, skills, export pack and its manifest, update and watcher install, and the person lane refusal, log `rpcLogTag(rpcId)` (as L6), the export pack's handoff id through `rpcLogTag` too, and the op through the new `rpcLogOp` (the op when it is one plain word, else `?`; several rails log the op before checking it). The wiring test scans every `${...}` in `server.ts` that names an rpcId or handoff id (only `encodeURIComponent(...)` for a request path or `rpcLogTag(...)` may) and every logged `frame.op`.

**Found and left, outside this brief's scope**: the handler modules themselves still log rpcIds raw, 45 lines in `lib/changes-rpc.ts`, `lib/export-pack.ts`, `lib/memory-rpc.ts`, `lib/lane-memory-rpc.ts`, `lib/skills-rpc.ts`, `lib/update-rpc.ts`, `lib/voice-rpc.ts`, `lib/watcher-install.mjs` and `lib/watcher-core.mjs` (`grep -n 'log(.*\${[a-zA-Z.]*rpcId}' lib/*`). They predate this feature; the same `rpcLogTag` fixes them.

### Red first, then green

The tests are at `bf43b9f`, before any fix. Each red line is the first failing assertion of that case against the unfixed code. The pane file failed to load at `bf43b9f` (`does not provide an export named 'cursorFollows'`), so its cases were also run against the unfixed reader with only a throwing stub for that export; the wiring file likewise (`rpcLogOp`), so its scan was run against `server.ts` at `bf43b9f` (and is the same line in the L2 mutation run).

| Finding | Test | Red line (first failure, unfixed) |
| --- | --- | --- |
| Medium | `model-effort-pane-live`: "a real draft drawn in black, grey or dim is still a draft" | `AssertionError [ERR_ASSERTION]: light-256 2-typed-draft in light theme text, rgb(0,0,0)`, actual `'empty'`, expected `'draft'` |
| Medium | `model-effort-pane-live`: "the re-read before the Enter keeps dim text" | `AssertionError [ERR_ASSERTION]: light-256`, actual `'/model sonnet'` (the dim `[Pasted text #1 +40 lines]` before it dropped) |
| Medium | `model-effort-pane`: "faint is SGR 2 only; text in black, grey or bright black is typed" | `AssertionError [ERR_ASSERTION]: 38;2;0;0;0`, actual `'empty'`, expected `'draft'` |
| Medium | `model-effort-pane`: "something drawn dim with no space after it, the cursor at its end, is a draft" | actual `'empty'`, expected `'draft'` |
| Medium | `model-effort-pane`: "the cursor parked on a dim tag ... is a draft, not a placeholder" | `AssertionError [ERR_ASSERTION]: [Pasted text #1 +40 lines]`, actual `'empty'` |
| Medium | `model-effort-pane`: "with no cursor drawn the composer is not known to be empty", "only the CLI's own placeholder form is empty", the box case | actual `'empty'`, expected `'unknown'` |
| Medium | `model-effort-pane`: "composerText reads the typed text exactly" | actual `'/model sonnet'`, expected `'/model sonnet a faint hint'` |
| Medium | rig: "a real draft drawn in the light theme's black is refused and left as typed" | `AssertionError [ERR_ASSERTION]: ● ready ... ❯ half a thought/model sonnet` (the command typed onto the owner's draft and left there: the L5 re-read dropped the black text too, so it refused without an Enter, as the brief predicted) |
| Medium | rig: "a real pasted text tag drawn dim is refused and left as it was" | `AssertionError [ERR_ASSERTION]: ● Unknown: [Pasted text #1 +40 lines]/model sonnet` (the reviewer's probe: the owner's draft SUBMITTED with the command) |
| L1 | `model-effort-control`: "an arrow key in the gap: nothing of the owner's is deleted, no BSpace, no Enter" (and the two other L1 cases) | `AssertionError [ERR_ASSERTION]: the owner's key and the command are left as they are`, actual `'et'`, expected `'q/model sonnet'` |
| L1 | rig: "an arrow key in the gap: the owner's key is never deleted" | the screen `❯ /model sonnet`: the owner's `q` deleted |
| L2 | `model-effort-wiring`: "no daemon log line carries a raw rpcId, handoff id or op" | `AssertionError [ERR_ASSERTION]: raw in a log line: ${frame.rpcId}` (11 raw id interpolations and 7 raw ops at `bf43b9f`) |

**Mutation, each fix reverted alone** (output in the session scratchpad; each file restored with `git checkout` afterwards):

- Medium reverted (the reader at `bf43b9f`, plus only the new `cursorFollows` so the imports resolve): pane, pane live, control and rig 57 pass, 11 fail: every round 2 pane case, the box case, the composerText case, and both rig Medium cases.
- L1 reverted (the clear without `cursorFollows`): control 3 fail, the three L1 cases. The rig's L1 case passed once in four runs with the fix reverted (it read the screen before the fake agent had drawn the BSpaces); `f397a7a` waits 500 ms before reading, after which five mutant runs all failed it and three runs on the fix passed 9 of 9.
- L2 reverted (`server.ts` at `bf43b9f`): wiring 10 pass, 1 fail, `raw in a log line: ${frame.rpcId}`.

### Tests and the whole suite

New or changed, all green at `53f350c`: `model-effort-pane-live` 5 (new), `model-effort-pane` 20 (6 new), `model-effort-control` 34 (3 new), `model-effort-wiring` 11 (2 new), `model-effort-tmux-rig` 9 (3 new), and unchanged `model-effort-literals` 7, `model-effort-rpc` 11, `compact-inject` 16, all 0 fail. `npx tsc --noEmit`: exit 0, no output.

**Whole suite: green at `53f350c`**, first run (`TMPDIR=/private/tmp/claude-501/mec3 node scripts/run-tests.mjs`, bun 1.3.14 on PATH, 06:28 to 06:44 UTC, on a machine other sessions loaded to a 1 minute average of about 276 to 290 on 18 CPUs): node:test 362 files, 7209 tests, **7170 pass, 0 fail**, 0 cancelled, 39 skipped; real Chromium 7 files, 15 tests, 11 pass, 0 fail, 4 skipped; bun:test 14 files, 374 pass, 1 skip, 0 fail; `[run-tests] both families green`, exit 0. Its 9 rig tmux server PIDs are in `pids.log`; none was alive at the end.

### Still open after round 2

- With the cursor parked on the first letter of a draft the CLI draws ENTIRELY in SGR 2 that is not one of its reference tags, the draft looks exactly like a placeholder and reads as empty. On 2.1.310 nothing typed into the prompt is drawn dim (measured above), and the reference tags are refused by name.
- A key the owner presses in the milliseconds between the last read and the BSpaces or the Enter is not seen (no screen read closes that gap).
- A terminal that hides the drawn cursor (for example tmux with `focus-events on` and the agent's window not focused, if the CLI then stops drawing it) reads as unknown: the change is refused, never typed.
- The 45 raw rpcId log lines in the handler modules (L2, above).

### Processes for round 2

Every one recorded in `pids.log` (worktree root, git excluded), and only those stopped:

- The real CLI sessions of the live check, each a private tmux server on a socket file in `~/hoai-work/meswitch-live`, stopped with `kill-server` on that socket and checked gone. Probes: server 32253 with CLI 32257 (stopped at the CLI's API key question, which the config then answered), 32461 with 32462, 53499 with 53501. First run: 67598 with 67599, 68613 with 68614, 71956 with 71957, 73612 with 73613. Second run: 25865 with 25866, 26606 with 26607, 27313 with 27314, 28188 with 28189. One mis-started batch (my loop passed the theme and colour as one word, so the script typed to a socket path that did not exist and sent no key at all): 63066, 63982, 65035, 66324 with CLIs 63067, 63984, 65036, 66325, stopped on their own sockets.
- One tmux server to test the PID watcher, 23807, and three rig servers of a probe run, 23190, 23310, 23436.
- The test runners and the rig's private tmux servers (socket files under `TMPDIR=/private/tmp/claude-501/mec3`), each server PID logged by the wrapper that ran them; after every run none was left alive.

No other tmux server, session or agent was touched, nothing was sent from the live sessions, and nothing was written outside `~/hoai-work`, this worktree and the session's temp folders.

## Round 3 (0.74.4): the BGOS wire, merged with main

BGOS #3060 merged and is live, so it is AUTHORITATIVE and the wire assumed above ("The wire", and the server wiring row of "What was built") is replaced. Read at BGOS main `1ec6bbf4`: `backend/src/integrations/model-effort-picker.model.ts`, `assistant-sessions.service.ts` (modelEffort and its gate), `voice/voice-rpc.service.ts`, `dto/integrations/model-effort-picker.dto.ts`, and the app's `queries/modelEffortQuery.ts` and `components/chat/model-picker/`. A `git grep` of that tree finds no sender of `set_model`, `set_effort`, `model_effort_rpc` or `owner_model_effort_control` outside a review document, so the old wire is removed rather than kept as a dead second wire. The Codex connector's `src/model-effort-picker.ts` and its `adapter.ts` branch (codex-channel-bgos `codex/model-effort-picker`) were the reference for shapes and refusal codes.

### The wire now

| | BGOS sends (voice_rpc, the Sessions rail) | The daemon answers |
| --- | --- | --- |
| list | `list_model_effort`, payload `{}` | `{ ok: true, payload: { runtime: 'claude-code', sessionId, current: { model, effort } or null, models: [{ id, label, description: '', enabled, defaultEffort, efforts: [{ id, label, enabled, reason }] }] } }`, read back through a vendored `readModelEffortCatalog` before it leaves |
| apply | `apply_model_effort`, payload `{ sessionId, model, effort }` | `{ ok: true, payload: { current: { model, effort }, sessionId } }` only when the session's own latest report holds both |
| refusal | | `{ ok: false, error: { code, message } }`, code `busy`, `not_allowed` or `failed` (BGOS passes the first two and its own `timeout`; anything else becomes `switch_failed`) |

Model ids are the frozen table's families (`opus`, `sonnet`, `haiku`, `fable`, kept only where the CLI's own help names them), plus the running model by its own id when the table has no literal for it, so its effort can still be changed. Efforts are the CLI's `--effort` choices; Ultra Code is listed disabled with "This host cannot confirm Ultra Code remotely."; a running model that reports no effort lists its efforts disabled. No fresh report of the proven session, or a session id BGOS's DTO refuses, and the list is refused, never sent empty.

Capability `model_effort_picker`: a pairing, opted in on this machine, the injector answers, a fresh observation and a non empty catalog, and never on Windows. One selection is the model step then the effort step under one hold of the lock and one 15 s deadline from the frame's arrival (confirmation stops 1.5 s before it; a step needs 4 s to start). A confirmed switch is reported on the session settings rail and noted in the chat ("Switched to Sonnet, effort Extra high."), neither awaited before the result.

### Independent security review

A separate reviewer, which did not write the code, read c1c71d2 against the eight properties of the brief and the BGOS side, and ran the six relevant files in a private copy (124 of 124). No High.

| Finding | Verdict | Fix |
| --- | --- | --- |
| M1: the result could land after BGOS's 20 s timer (budget started after an awaited ack; result waited on the PATCH and the note). Verified by the reviewer with a virtual clock. | Real | Deadline from arrival, 15 s; a picker op does not await its ack; PATCH and note sent, not awaited. |
| M2: the control lock held back message deliveries only; consult, dispatch, meeting, mission, button and nudge cards called `mcp.notification` directly. | Real | `holdChannelCardsWhileBusy` wraps `mcp.notification` once, outermost; plus the turn, dialog and other injections checked again right before the Enter, the literal cleared under the round 2 rule on a refusal. |
| L1: a model switched before the effort step was refused read as `not_allowed`. | Real | Answered `failed`, says the model changed, noted in the chat. |
| L2: `handle()` had no production caller; this file described the old wire. | Real | `handle()` removed; its per step cases drive `apply` (unit file and tmux rig); this section. |
| Info: the owner rule on an agent with one main chat rests on BGOS's gate (the frame names no sender). | Kept | Nothing more is knowable from the frame; listed as an open risk. |
| Info: the status line store's sequence number is read then written without a lock. | Kept | Every interleaving the reviewer worked fails closed (`not_confirmed`). |
| Info: the once per rpcId set is in memory, so a re sent frame after a restart could run again. | Kept | The second run reads "already" or types the same idempotent literal into an empty composer. |
| Info: a picker frame is answered even where the token is not declared (apikey, Windows). | Kept | The control refuses (`no_terminal`, `not_opted_in`); harmless. |

Properties the reviewer found no issue with: owner and main chat only, the pane proof, the composer empty and confirmation reads, confirmation only from a newer observation, Ultra Code, the project level statusLine. The lock (M2) and the wire (M1) are fixed above.

### Second review, of the fixes

A second reviewer, again not the author, read `c1c71d2..b59b583` (184 of 184 tests in a private copy, the tmux rig and live pane files skipped). M1, M2, L1 and L2 fixed; no deadlock (nothing the change waits on needs a channel card), no unhandled rejection, no path that deletes owner text. Fixed in `a54d93c`:

| Finding | Verdict | Fix |
| --- | --- | --- |
| Important: a voice dispatch waits for its card before answering accepted and BGOS waits 10 s (`voice-task.service.ts` `DISPATCH_ACCEPT_TIMEOUT_MS`); held behind a change it read as staged and could run twice. Verified by the reviewer. | Real | While cards are held the dispatch is accepted at once; its card goes out when the change ends (`cardsHeld`). |
| Minor: confirmation ran to the deadline, leaving the last screen read and the result POST past it. | Real | Confirmation stops 1.5 s early; a step needs 4 s to start. |
| Minor: a card sent just before the lock can open a turn the hooks have not reported. | Real | For 2 s after any channel card the turn is unknown and nothing is typed (`lastCardAtMs`). |
| Minor: an effort step unconfirmed after its Enter was noted as "not changed". | Real | Noted as "could not be confirmed". |
| Minor: a voice consult or a tap card is recorded by the private turn tracker when it is called, before the hold; an untracked card when it is sent. | Kept, open risk | The reviewer traced it as only making the tracker more cautious; not reproduced. |
| Minor: a voice consult's 38 s timer starts before a hold. | Kept, open risk | A long hold ends in the existing "will follow up in chat" answer. |
| Minor: a `dialog_open` refusal before the Enter may send BSpace while a dialog is drawn; no end to end test of a held direct card. | Kept, open risk | The clear needs the composer to read as exactly the literal with the cursor after it, which a drawn dialog hides; the hold is unit tested and its install pinned. |

### Mutations

Every new test of round 3, and each test the review fixes added, was MUTATION PROVEN in an isolated copy of `a54d93c`'s tree (`git archive`, never this worktree): the one line it guards was broken, the named test run alone (`npx tsx --test --test-name-pattern`), required RED, the line restored, and the test required GREEN again. Line numbers are at `a54d93c`. All 72 proven, 0 timed out (each run is capped at 120 s and only its own process group is killed). The first pass found three weak tests, each fixed before this table: C7 and R11 stayed green under their mutation (a session id case that was refused for another reason, and an agent id check exercised only with a non empty id), and V5 hung instead of failing; three more cases now race a 500 ms timer so a broken guard fails instead of hanging.

| # | Test (file :: name) | Mutated line at `a54d93c` (after the mutation) | Result |
| --- | --- | --- | --- |
| C1 | `model-effort-picker-contract.test.ts` :: the capability token and both op names | `lib/model-effort-rpc.ts:58` `export const MODEL_EFFORT_PICKER = 'model_effort_pickers'` | PROVEN, red: AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: |
| C1b | `model-effort-picker-contract.test.ts` :: the capability token and both op names | `lib/model-effort-rpc.ts:61` `export const APPLY_MODEL_EFFORT = 'apply_model_efforts'` | PROVEN, red: AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: |
| C2 | `model-effort-picker-contract.test.ts` :: the catalog carries exactly BGOS | `lib/model-effort-catalog.ts:291` `note: 'x',` | PROVEN, red: AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal: |
| C3 | `model-effort-picker-contract.test.ts` :: BGOS's reader accepts what the daemon builds | `lib/model-effort-catalog.ts:291` `current: running ? { model: o.modelId, effort: runningEffort } : null,` | PROVEN, red: AssertionError [ERR_ASSERTION]: current names the picker row, so the app highlights it |
| C4 | `model-effort-picker-contract.test.ts` :: every effort the CLI offers is enabled | `lib/model-effort-catalog.ts:284` `{ id: 'ultracode', label: effortLabel('ultracode'), enabled: true, reason: ULTRACODE_UNCONFIRMA` | PROVEN, red: AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal: |
| C5 | `model-effort-picker-contract.test.ts` :: a running model that reports no effort lists | `lib/model-effort-catalog.ts:281` `enabled: true,` | PROVEN, red: AssertionError [ERR_ASSERTION]: The expression evaluated to a falsy value: |
| C6 | `model-effort-picker-contract.test.ts` :: a running model outside the frozen table | `lib/model-effort-catalog.ts:263` `(deleted) if (running && !ids.includes(running)) ids.push(running)` | PROVEN, red: AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal: |
| C7 | `model-effort-picker-contract.test.ts` :: nothing to offer, no proven session | `lib/model-effort-catalog.ts:256` `if (!sessionId) return null` | PROVEN, red: AssertionError [ERR_ASSERTION]: ../x |
| C8 | `model-effort-picker-contract.test.ts` :: a model id that would carry text | `lib/model-effort-catalog.ts:230` `(deleted) if (!isModelId(modelId)) return null` | PROVEN, red: AssertionError [ERR_ASSERTION]: opus;whoami |
| C9 | `model-effort-picker-contract.test.ts` :: the vendored reader is BGOS | `lib/model-effort-catalog.ts:192` `if (!isRecord(e) \|\| !isId(e.id) \|\| !isText(e.label, 80) \|\| typeof e.enabled !== 'boolean' \|\| !(` | PROVEN, red: AssertionError [ERR_ASSERTION]: a disabled effort must say why |
| C10 | `model-effort-picker-contract.test.ts` :: every refusal maps to a code the app understands | `lib/model-effort-rpc.ts:100` `if (BUSY.has(code) && code !== 'busy_turn') return 'busy'` | PROVEN, red: AssertionError [ERR_ASSERTION]: busy_turn |
| R1 | `model-effort-rpc.test.ts` :: list answers a catalog BGOS's reader accepts | `lib/model-effort-rpc.ts:230` `return { ok: true, payload: { ...catalog, sessionId: '' } }` | PROVEN, red: AssertionError [ERR_ASSERTION]: readModelEffortCatalog accepts it |
| R2 | `model-effort-rpc.test.ts` :: list while not opted in | `lib/model-effort-rpc.ts:221` `if (false) {` | PROVEN, red: AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal: |
| R3 | `model-effort-rpc.test.ts` :: apply hands the control exactly the selection | `lib/model-effort-rpc.ts:75` `export const APPLY_BUDGET_MS = 18_000` | PROVEN, red: AssertionError [ERR_ASSERTION]: BGOS waits 20 000 ms from its emit (assistant-sessions.service.ts:13 |
| R4 | `model-effort-rpc.test.ts` :: apply answers what the session REPORTS | `lib/model-effort-rpc.ts:264` `if (false) {` | PROVEN, red: AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: |
| R5 | `model-effort-rpc.test.ts` :: a confirmed switch is reported on the session settings rail | `lib/model-effort-rpc.ts:245` `if (false) {` | PROVEN, red: AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal: |
| R6 | `model-effort-rpc.test.ts` :: a selection that was already running is answered without a note | `lib/model-effort-rpc.ts:267` `if (true) this.note(chatId, `Switched to ${name}, effort ${effortLabel(effort)}.`)` | PROVEN, red: AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: |
| R7 | `model-effort-rpc.test.ts` :: a refusal is answered with the app's code | `lib/model-effort-rpc.ts:252` `if (!outcome.modelSwitched) return { ok: false, code: outcome.code as never, message: outcome.m` | PROVEN, red: AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal: |
| R8 | `model-effort-rpc.test.ts` :: owner only, main chat only: a chat the daemon cannot place | `lib/model-effort-rpc.ts:206` `if (false) {` | PROVEN, red: AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: |
| R9 | `model-effort-rpc.test.ts` :: pickerChatAllowed | `lib/model-effort-rpc.ts:158` `return true` | PROVEN, red: AssertionError [ERR_ASSERTION]: shared agent: a main chat not proven the owner's |
| R9b | `model-effort-rpc.test.ts` :: pickerChatAllowed | `lib/model-effort-rpc.ts:157` `(deleted) if (input.isOthers(chatId)) return false` | PROVEN, red: AssertionError [ERR_ASSERTION]: a share recipient's chat, even when it is the only one listed |
| R10 | `model-effort-rpc.test.ts` :: a malformed selection is refused | `lib/model-effort-rpc.ts:236` `typeof sessionId !== 'string' \|\| sessionId === '' \|\| false \|\|` | PROVEN, red: AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: |
| R11 | `model-effort-rpc.test.ts` :: a frame for another agent is not this daemon | `lib/model-effort-rpc.ts:200` `return (typeof frame.assistantId === 'string' \|\| typeof frame.assistantId === 'number') && Stri` | PROVEN, red: AssertionError [ERR_ASSERTION]: a daemon with no agent id answers nothing |
| R12 | `model-effort-rpc.test.ts` :: a control that throws is answered failed | `lib/model-effort-rpc.ts:215` `throw err` | PROVEN, red: Error: boom |
| V1 | `voice-rpc-model-effort.test.ts` :: both picker ops pass the normalizer | `lib/voice-rpc.ts:127` `isSessionOp(r.op)` | PROVEN, red: AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: |
| V2 | `voice-rpc-model-effort.test.ts` :: a list is acked, answered by the picker | `lib/voice-rpc.ts:871` `payload = {}` | PROVEN, red: AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal: |
| V3 | `voice-rpc-model-effort.test.ts` :: a refusal is posted with the picker's code | `lib/voice-rpc.ts:870` `if (!answer.ok) throw new VoiceRpcError('PLUGIN_ERROR', answer.message)` | PROVEN, red: AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal: |
| V4 | `voice-rpc-model-effort.test.ts` :: a picker that throws is answered failed | `lib/voice-rpc.ts:897` `: isSessionOp(frame.op)` | PROVEN, red: AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: |
| V5 | `voice-rpc-model-effort.test.ts` :: a re sent apply never types twice | `lib/voice-rpc.ts:815` `if (isSessionOp(frame.op)) {` | PROVEN, red: AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: |
| V6 | `voice-rpc-model-effort.test.ts` :: another agent's frame gets no ack | `lib/voice-rpc.ts:808` `? true` | PROVEN, red: AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal: |
| V7 | `voice-rpc-model-effort.test.ts` :: with no picker wired | `lib/voice-rpc.ts:861` `throw new VoiceRpcError('unsupported', 'This agent does not change its model and effort from th` | PROVEN, red: AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: |
| V8 | `voice-rpc-model-effort.test.ts` :: logs a picker rpcId as its short hash | `lib/voice-rpc.ts:835` `this.deps.log(`voice_rpc ack failed (non-fatal, rpc=${frame.rpcId}): ${err instanceof Error ? e` | PROVEN, red: AssertionError [ERR_ASSERTION]: raw rpcId in the log: "voice_rpc ack failed (non-fatal, rpc=rpc-7\n[ |
| W1 | `model-effort-wiring.test.ts` :: model_effort_picker is declared only on a pairing | `lib/declared-capabilities.ts:399` `...(input.authMode === 'pairing' && input.modelEffortPicker === true && true` | PROVEN, red: AssertionError [ERR_ASSERTION]: a Windows host cannot prove or type into a tmux pane |
| W2 | `model-effort-wiring.test.ts` :: the heartbeat declares from the live answer | `server.ts:17233` `...declaredCapabilities({ canInjectGoal: compactTarget !== null, floorHook: FLOOR_HOOK.register` | PROVEN, red: AssertionError [ERR_ASSERTION]: The input did not match the regular expression /modelEffortPicker: m |
| W3 | `model-effort-wiring.test.ts` :: the picker rides voice_rpc | `server.ts:12370` `(deleted) modelEffort: modelEffortPicker,` | PROVEN, red: AssertionError [ERR_ASSERTION]: The input did not match the regular expression /modelEffort: modelEf |
| W4 | `model-effort-wiring.test.ts` :: the picker answers only the owner's main chat | `server.ts:2362` `pickerChatAllowed({ chatId, mainChatIds, isOwners: (c) => chatOwnership.isOwners(c), isOthers: ` | PROVEN, red: AssertionError [ERR_ASSERTION]: The input did not match the regular expression /chatAllowed: \(chatI |
| W5 | `model-effort-wiring.test.ts` :: L2: no daemon log line carries a raw rpcId | `server.ts:14546` `log(`doctor_rpc received (op=${frame.op}, rpc=${frame.rpcId})`)` | PROVEN, red: AssertionError [ERR_ASSERTION]: raw in a log line: ${frame.rpcId} |
| S1 | `stop-pause-wiring.test.ts` :: the stop reads the goal lane as it is at that moment | `server.ts:17233` `...declaredCapabilities({ canInjectGoal: compactTarget !== null, floorHook: FLOOR_HOOK.register` | PROVEN, red: AssertionError [ERR_ASSERTION]: the heartbeat declaration moved; keep the stop gate on the same expr |
| P1 | `pairing-lock-standdown.test.ts` :: the wrapped set is exactly the handlers minus the transport ones | `server.ts:14521` `realtimeSocket.on('model_effort_rpc', () => {})` | PROVEN, red: AssertionError [ERR_ASSERTION]: server.ts registers a socket handler this test does not classify; wr |
| K1 | `model-effort-control.test.ts` :: snapshot reports the proven session | `lib/model-effort-control.ts:317` `return { optedIn, sessionId, observation, catalog: parseHelpCatalog(null) }` | PROVEN, red: AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal: |
| K2 | `model-effort-control.test.ts` :: snapshot while not opted in | `lib/model-effort-control.ts:307` `const optedIn = true` | PROVEN, red: AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: |
| K3 | `model-effort-control.test.ts` :: apply switches the model, then the effort, each confirmed, under one lock | `lib/model-effort-control.ts:282` `this.inFlight = false` | PROVEN, red: AssertionError [ERR_ASSERTION]: the lock is held through both steps |
| K4 | `model-effort-control.test.ts` :: apply with the model already running types only the effort | `lib/model-effort-control.ts:289` `const step = await this.change('set_effort', 'max', pre, opts.deadlineAtMs)` | PROVEN, red: AssertionError [ERR_ASSERTION]: {"ok":false,"op":"apply","code":"not_confirmed","message":"The comma |
| K5 | `model-effort-control.test.ts` :: apply with the effort already running types only the model | `lib/model-effort-control.ts:280` `const step = await this.change('set_model', 'fable', pre, opts.deadlineAtMs)` | PROVEN, red: AssertionError [ERR_ASSERTION]: {"ok":false,"op":"apply","code":"not_confirmed","message":"The comma |
| K6 | `model-effort-control.test.ts` :: apply of what already runs types nothing | `lib/model-effort-control.ts:277` `let applied = true` | PROVEN, red: AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: |
| K7 | `model-effort-control.test.ts` :: apply for a session the picker read before a restart | `lib/model-effort-control.ts:275` `(deleted) if (wanted !== pre.sessionId) throw new Refusal('session_mismatch')` | PROVEN, red: AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: |
| K8 | `model-effort-control.test.ts` :: apply refuses Ultra Code | `lib/model-effort-control.ts:257` `(deleted) if (effort === 'ultracode') return this.refused('apply', new Refusal('ultracode_uncon` | PROVEN, red: AssertionError [ERR_ASSERTION]: {"sessionId":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee","model":"sonnet" |
| K9 | `model-effort-control.test.ts` :: apply on a model outside the frozen table | `lib/model-effort-control.ts:260` `if (!isEffortLevel(effort) \|\| !isModelFamily(model)) {` | PROVEN, red: AssertionError [ERR_ASSERTION]: {"ok":false,"op":"apply","code":"unsupported_value","message":"That  |
| K10 | `model-effort-control.test.ts` :: apply checks every precondition again before the effort step | `lib/model-effort-control.ts:351` `if (turn === 'live') return null` | PROVEN, red: AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: |
| K11 | `model-effort-control.test.ts` :: apply onto a model that reports no effort | `lib/model-effort-control.ts:284` `(deleted) pre = await this.preflight()` | PROVEN, red: AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: |
| K12 | `model-effort-control.test.ts` :: apply waits for confirmation no longer than its deadline | `lib/model-effort-control.ts:429` `const deadline = Math.min(this.deps.now() + this.opts.confirmTimeoutMs, deadlineAtMs)` | PROVEN, red: AssertionError [ERR_ASSERTION]: waited 5150 ms |
| K13 | `model-effort-control.test.ts` :: apply does not start the effort step without the time | `lib/model-effort-control.ts:328` `(deleted) if (deadlineAtMs - this.deps.now() < this.opts.minStepMs) throw new Refusal('out_of_t` | PROVEN, red: AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: |
| K14 | `model-effort-control.test.ts` :: apply is refused while another change holds the lock | `lib/model-effort-control.ts:263` `if (this.deps.otherInjectionBusy()) {` | PROVEN, red: AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: |
| R13 | `model-effort-rpc.test.ts` :: apply hands the control exactly the selection | `lib/model-effort-rpc.ts:241` `const outcome = await this.deps.control.apply({ sessionId, model, effort }, { deadlineAtMs: thi` | PROVEN, red: AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal: |
| R14 | `model-effort-rpc.test.ts` :: the answer never waits on the session settings report | `lib/model-effort-rpc.ts:246` `await this.deps.reportSettings(chatId, settings).catch((err) => {` | PROVEN, red: AssertionError [ERR_ASSERTION]: the answer was held behind the report or the note |
| R15 | `model-effort-rpc.test.ts` :: a model switched before the effort was refused | `lib/model-effort-rpc.ts:252` `if (true) return refuse(outcome.code, outcome.message)` | PROVEN, red: AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: |
| R16 | `model-effort-rpc.test.ts` :: a refusal with nothing switched sends no note | `lib/model-effort-rpc.ts:252` `if (false) return refuse(outcome.code, outcome.message)` | PROVEN, red: AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: |
| V9 | `voice-rpc-model-effort.test.ts` :: a picker result is not held behind a slow ack | `lib/voice-rpc.ts:833` `if (false) {` | PROVEN, red: AssertionError [ERR_ASSERTION]: the result waited for the ack |
| V10 | `voice-rpc-model-effort.test.ts` :: a picker result is not held behind a slow ack | `lib/voice-rpc.ts:868` `(deleted) receivedAtMs,` | PROVEN, red: AssertionError [ERR_ASSERTION]: The expression evaluated to a falsy value: |
| H1 | `model-effort-card-hold.test.ts` :: the method held is the channel card | `lib/model-effort-control.ts:552` `export const CHANNEL_CARD_METHOD = 'notifications/claude/channel/x'` | PROVEN, red: AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: |
| H2 | `model-effort-card-hold.test.ts` :: a channel card waits while a change is in flight | `lib/model-effort-control.ts:573` `(deleted) while (lock.busy) await lock.whenIdle()` | PROVEN, red: AssertionError [ERR_ASSERTION]: held while busy |
| H3 | `model-effort-card-hold.test.ts` :: a card waits again when a second change takes the lock first | `lib/model-effort-control.ts:573` `if (lock.busy) await lock.whenIdle()` | PROVEN, red: AssertionError [ERR_ASSERTION]: still held by the second change |
| H4 | `model-effort-card-hold.test.ts` :: with no change in flight a card is sent at once | `lib/model-effort-control.ts:571` `if (true) {` | PROVEN, red: AssertionError [ERR_ASSERTION]: a permission answer is never held |
| H5 | `model-effort-card-hold.test.ts` :: server.ts installs the hold OUTERMOST | `server.ts:9438` `(deleted) mcp.notification = holdChannelCardsWhileBusy(modelEffortControl, mcp.notification.bin` | PROVEN, red: AssertionError [ERR_ASSERTION]: the private turn record and the hold, never stacked twice |
| K15 | `model-effort-control.test.ts` :: a turn that starts between the literal and the Enter | `lib/model-effort-control.ts:482` `return` | PROVEN, red: AssertionError [ERR_ASSERTION]: busy_turn: never an Enter into a turn |
| K16 | `model-effort-control.test.ts` :: apply checks every precondition again before the effort step | `lib/model-effort-control.ts:282` `(deleted) modelSwitched = applied` | PROVEN, red: AssertionError [ERR_ASSERTION]: the answer knows the model did change |
| K17 | `model-effort-control.test.ts` :: a channel card sent in the last 2 s makes the turn unknown | `lib/model-effort-control.ts:349` `(deleted) if (lastCard !== null && this.deps.now() - lastCard < this.opts.cardSettleMs) return ` | PROVEN, red: AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: |
| H6 | `model-effort-card-hold.test.ts` :: the hold reports when a channel card really goes out | `lib/model-effort-control.ts:574` `(deleted) onSent?.()` | PROVEN, red: AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal: |
| H7 | `model-effort-card-hold.test.ts` :: server.ts notes each card it sends and the control reads it | `server.ts:2320` `(deleted) lastCardAtMs: () => lastChannelCardAtMs,` | PROVEN, red: AssertionError [ERR_ASSERTION]: The input did not match the regular expression /lastCardAtMs: \(\) = |
| V11 | `voice-rpc-model-effort.test.ts` :: a voice dispatch during a change is accepted at once | `lib/voice-rpc.ts:1224` `if (false) {` | PROVEN, red: AssertionError [ERR_ASSERTION]: held: accepted without waiting for the card |
| V12 | `voice-rpc-model-effort.test.ts` :: server.ts tells the voice handler when cards are held | `server.ts:12372` `(deleted) cardsHeld: () => modelEffortControl.busy,` | PROVEN, red: AssertionError [ERR_ASSERTION]: The input did not match the regular expression /cardsHeld: \(\) => m |
| R17 | `model-effort-rpc.test.ts` :: an effort step that ended unconfirmed is noted as not confirmed | `lib/model-effort-rpc.ts:257` `const unconfirmed = false` | PROVEN, red: AssertionError [ERR_ASSERTION]: not_confirmed |


### Suite

**Whole suite: green at `a54d93c`**, first run of that commit (`TMPDIR=/private/tmp/claude-501/mecr3 node scripts/run-tests.mjs`, bun 1.3 on PATH, 06:30 to 06:39 UTC, 1 minute load average about 10 then 6): node:test 372 files, 7402 tests, **7356 pass, 0 fail**, 0 cancelled, 46 skipped; real Chromium 7 files, 15 tests, 11 pass, 0 fail, 4 skipped; bun:test 14 files, 374 pass, 1 skip, 0 fail; `[run-tests] both families green`, exit 0. `npx tsc --noEmit` clean. The commit after it changes only BGOS line citations in a comment and two assertion messages (`model-effort-picker.spec.ts:69` and `:59-83`, `assistant-sessions.service.ts:128-134` and `:135`) and these docs; its two test files were run again, 10 and 17 pass, 0 fail.

Two earlier attempts were stopped by me, not failed: the first under macOS's default temp folder, where the browser profile files hang on the `/var` symlink exactly as on main (round 1's table), and the second, already at 0 fail after 564 tests, because the second review's fixes needed a final run anyway.

## What a live check on a real agent must still show

None of this was run against a real Claude Code session (the brief forbids it). Before the app is allowed to send a frame, a live check on the supported CLI version (2.1.309 here) must show:

1. **The status line reports a change while idle.** With the bridge installed (`refreshInterval` 2), `/model sonnet` and `/effort max` typed by hand produce an observation with the new `model.id` and `effort.level` within a few seconds and with no new turn. The docs list no status line trigger for `/model` or `/effort`, which is why the refresh interval is there; confirm it fires while idle.
2. **`/model <family>` and `/effort <level>` apply directly on one Enter**, with no menu, confirmation or second prompt on this version. If either opens a menu, the one Enter may pick an item: stop and change the submission before enabling.
3. **The composer layouts.** (Idle states done in round 2, both themes, the table above; still to do: during a turn, a permission dialog, and the empty box after a real turn.) Capture the pane (`tmux capture-pane -p -e`) of an idle session with an empty composer, with the placeholder showing, with the cursor on the placeholder, with a typed draft, with a multi line draft, during a turn, and with a permission dialog open, and run `readComposer` on each: empty, empty, empty, draft, draft, (empty composer while busy is refused by the turn check), unknown or draft. If the CLI draws the composer differently, the fixtures in `test/model-effort-pane.test.ts` change first.
4. **The pane identity holds for the real process tree**: the MCP daemon's `ps` ancestry reaches the pane's root, and the CLI's job is the foreground group (`pgid == tpgid`), both when tmux runs `claude` directly and when it runs a shell that runs `claude` (bgos-agent, hoai run). If Claude Code starts MCP servers in their own process group, the rule still holds through the CLI's own entry; confirm.
5. **The alias resolves to the family**: after `/model fable` the status line `model.id` contains `fable` as a token (the `modelFamilyOf` rule).
6. **A model without effort support** (haiku, if offered) omits `effort` from the status line, so efforts are offered as none.
7. **The owner's own status line is unchanged** in look while the bridge is in front of it, and `hoai-model-control off` restores it byte for byte.
8. **The app side** (round 3): on a real pairing, the picker appears once `model_effort_picker` is declared, the list fills it, and an apply reaches the pane and answers inside BGOS's 20 s.

## Not done, and why

- **The BGOS side**: the picker for a Claude agent, the `model_effort_rpc` emit, the result route and reading the token are #3060's, not in this repo, and the wire above is assumed.
- **Ultra Code**: refused by design. No session native report this daemon can read distinguishes it from xhigh; the proposal says to disable it without that evidence.
- **Both at once**: a frame carries one operation, so there is no partial state and no rollback path. A picker that changes both sends set_model, waits for its answer, then set_effort, and each answer carries the true report.
- **Report push without a request**: the pill is refreshed with every answer (describe included). A change made by hand in the terminal reaches the pill on the next describe, not on its own; a watcher that PATCHes on every observation change would need to know which chats to report to.
- **Model ids with brackets** (`[1m]`) are refused by the BGOS route's pattern, so they are not reported on the rail (they are in the RPC answer).
- **A key in flight**: the composer is read from the screen, so a key the owner presses in the few milliseconds between the screen read and the typed literal is not seen when the literal is typed. Since 0.75.1 the composer is read again before the Enter (L5, "Security review fixes"), so such a key is caught then and nothing is submitted (`composer_changed`); only a key in the milliseconds between that second read and the Enter remains unseen.
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
