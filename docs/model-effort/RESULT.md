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
