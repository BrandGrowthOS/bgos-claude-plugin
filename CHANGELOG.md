# Changelog

Notable changes to the HOAI Claude Code plugin.

## 0.72.0 (2026-10-19)

**Agents use the owner's managed Agent Browser (BGOS mission 173, proposal item 15): a paired agent finds its person's managed browser profile through HOAI before every browser call and drives it over the typed profile route; every browser refusal reaches the agent as its `browser_profile_*` code and one plain sentence, never as "the desktop app is not running" while the desktop is connected; and an agent is never offered a profile choice: it opens its own browser. The Agent Browser's Node floor is now 22.12.0.**

This release brings #253 (managed browser profiles and encrypted HOAI handoff, head 7d8db11) and #260 (the shim synced with BGOS #2625, head 5885201) onto 0.71.7 as one branch. Both were open and conflicting against main; they replace them.

- **From #253, the managed profile runtime.** The agent's own browser host runs a profile companion (`lib/browser-profile-companion.mjs` and `lib/browser-profile-*.mjs`, with the vendored `lib/browser-profile-core/`): a profile per acting person and agent, encrypted checkpoints sent and returned through HOAI, an OS protected key store (Linux needs an unlocked Secret Service), one writer, a positively stopped source before any handover, and managed downloads, files and text fields behind a fresh approval of the original request. The paired launcher sets `HOAI_RELAY_PROFILE_SYNC=1`; the shim then resolves the acting person's profile (`/api/v1/browser/profile-sync/rpc/resolve`) before every call and sends it to `/call`, `/poll` and `/cancel` with that exact authority, and once it has seen a managed profile it never falls back to a local or legacy browser. Playwright is pinned to 1.64.1 (Chromium 156) and the MCP SDK to 1.32.1; bundled Chromium startup accepts Bun's hardlinked cache for the exact pinned files only. The host handshake names its `deviceBootId`. Setup, recovery and limits are in `docs/browser-profile-*.md`, the qualification receipts in `docs/proofs/`.
- **From #260.** The same shim bytes #253 vendored (sha256 a55d97ae, BGOS 62193f7a on BGOS main) and its pin's newer source commit.
- **Resolved on the way.** The host handshake declares both `features: ["saved_sites"]` (#257) and its `deviceBootId` (#253); a retiring pairing connection is not reopened, and a new one keeps the owner's saved sites route and gets its profile companion. #253's own changelog note (titled 0.71.5, a number main had already used) is folded in here. Everything 0.71.x added since #253 branched is kept as main has it: the private turn package (#261, `lib/private-turn.mjs`, server.ts's admission block), saved sites (#257), the Windows relaunch fixes (#258) and the lane that hands each message to Claude once (#259). The signed turn context still gates every browser tool, the open call included.
- **Every refusal in one plain sentence (`bin/hoai-browser-mcp.mjs`).** The shim knows every `browser_profile_*` code and answers each as `<code>: <one sentence>`: `setup_required` ("Your owner has not set up your browser yet; a Set up card is in your chat."), `restart_review_required`, `recovery_required`, `outcome_unknown`, `return_pending`, `active_elsewhere`, `stopped_local_only` (the desktop's admission states), `authority_required` (the backend's legacy fence and the desktop) and `managed` (the agent's own host), `storage_full`, `close_blocked`, `transition_absent`, and the shim's own `closing` (a quiescing profile), `unavailable` and `unconfirmed` (a sent call the browser never confirmed, which may have run). A code it does not know yet keeps its code with a plain fallback sentence that says to look at the page first. `authority_required` and `managed` arrive before a call runs and also after one ran (the fence withholds a collected result, the bridge's 423 included; the desktop rechecks its runtime once an action is done), so their sentence says the call may still have run and to check the page with browser_snapshot before repeating it, never "nothing ran, try again". The code is read from the relay's or profile route's `code`, from a host refusal the relay carries as `host_error` ("<code>: ..."), and from the desktop's own tool error (`### Error` then `tool_error: <code>`, its RC4 answer to an agent with no profile). Discovery's writer states map to codes (idle to setup_required, stopped and staged to restart_review_required, quiescing to closing, fenced to recovery_required). On a share recipient's turn "your owner" becomes "the person you act for".
- **A 409 is host_offline only when the relay says so.** A 409 used to mean host_offline whatever it carried, so the profile fence's `409 browser_profile_authority_required` reached the agent as "your owner's Home of Agents desktop app is not running or not signed in" while the desktop was open (phase 1 RC4). Now only `code: host_offline` says that; a profile code says its sentence, while connecting as well as in a call, and a 409 with no code is a refusal with its status. While a profile refusal holds, the served instructions and the one status tool no longer say the desktop app is unreachable either.
- **No profile question.** KC's decision (2026-10-19): one browser per agent, nothing for an agent to ask about. The shim serves every host's tools and instructions without the choice: `hoai_browser_open_session` loses its `profile` argument (a 5.21 desktop listed `preview` or `signed-in`, preview by default; its managed variant required `signed-in`), and the sentences that offered or reported it are dropped or reworded, keeping the rest (the owner's verify ask, the permission rules). An argument's own words are cleaned too (the desktop's `verify` said "Always opens a Preview session."). On a HOAI route the open call opens the agent's own persistent browser (`signed-in`, the only profile a managed desktop opens) whatever an older client sends; on a desktop on the same machine the agent's choice is dropped, the desktop's default for a client it cannot verify applies (a temporary browser), and the words served there say so instead of promising a remembered one. The plugin's own host no longer lists the argument either, and the browser skill and the channel instructions tell the agent never to ask.
- **Pairing only on profile requests.** Profile requests carry `X-BGOS-Pairing` (and, on a recipient's turn, the signed `X-BGOS-Acting-User`) and nothing else that authenticates, even when an account key is also configured; the backend refuses a profile call that carries an account key, a session or an Authorization header.
- **Node floor 22.12.0, decided.** #253 raised `engines.node` to `>=22.12.0`: Playwright 1.64.1 and the managed profile runtime are qualified on Node 22 and 24, and 18 and 20 are end of life. It stays. Only the browser needs it (the channel runs on Bun), so nothing else refuses: on an older Node `bin/bgos-launch.mjs` and `bin/hoai-browser-launch.mjs` each print one plain line naming this Node and the floor and still start, the agent's own host refuses browser work with the same advice (#253), and `hoai doctor` marks the Node.js row (#253). The README's requirements table, its browser section, `hoai-agent`'s install, pair and doctor messages and the `hoai` wrappers (`bin/hoai`, `bin/hoai.ps1`) say it.
- **This shim copy now leads BGOS.** The words above could not wait for the desktop tree, which other work is changing, so `bin/hoai-browser-mcp.mjs` is ahead of `frontend/electron-app/agent-browser/shim/`. The pin says so (`why`, `aheadOfSource`), `docs/vendoring-the-hoai-browser-shim.md` says how BGOS takes it back, and the armed cross-tree check fails by design until it does. The codex-channel-bgos copy is behind too.

Guards: `test/hoai-browser-mcp.refusals.test.ts` (29 cases on the real shim and a disposable backend: the shim's table matches the pinned words; one test per code, each reached the way it arrives; the recipient wording; a connected desktop's 409 in a call and while connecting, a bare 409, a sent call the fence withholds at collect (409 and 423), and the host_offline control; the pairing only header for the owner and a recipient; the 5.21 desktop's and managed desktop's tools and instructions served without the choice; the plugin host's roster; the open call on the relay, managed and loopback routes; the loopback door's words; the turn gate on the open call). Run against the shim as merged, 25 of the 29 fail; the four that pass are the controls. `test/hoai-browser-mcp.profile-runtime.test.ts` names each writer state's code; `test/browser-profile-managed-instructions.test.ts` holds that the managed roster has no profile argument; `test/bgos-launch.test.ts`, `test/hoai-browser-launch.test.ts` and `test/browser-profile-node-runtime.test.ts` hold the Node floor line. #253's own suites and the existing `test/hoai-browser-launch.test.ts` case for `HOAI_RELAY_PROFILE_SYNC=1` on a paired launch come with it.

Release order (Data): the desktop side ships first, then the three step publish. This version is not published by this change.

## 0.71.7 (2026-10-18)

**A verified owner turn now keeps its private turn authority to the end of its CLI turn (boards, schedule, missions and the Agent Browser no longer refuse with "sender could not be verified" when a second owner wake, a peer conversation close, a reply reminder or the owner's own button tap arrives mid turn); the owner's own tap on the stream opens a private turn (a button, never a Custom reply); a card that names nobody, delivered after the owner's message, ends its authority on every gated tool through one rule; and #254's four lows are closed.**

This release is based on 0.71.5 (#257), on main.

- **c09e214e, the owner's authority mid turn (`lib/private-turn.mjs`).** current() adopts through one path (adoptAt) and follows the CLI to another admitted prompt of the same turn; two wakes of the owner are one turn whatever their chats (ownerWake); a card the daemon pushed with no delivery that names nobody but the owner (a peer conversation close, a reply reminder, the owner's own stamped tap: PRIVATE_CARRIED_CARDS) run as its own prompt keeps the turn, only while every prompt the CLI ran since the verified one is such a card or one admitted for the turn (the hook lists the turn's prompts in its marker, `prompts`), and never in a voice consult's turn. A Stop line that lands late keeps the turn the CLI already ran next; one whose Stop hook failed still ends the turn it stopped. The line now says when the CLI stopped by the forwarder's own process start (`startedAt` on the spool line, `performance.timeOrigin`, which claude spawns with the Stop hook), not by its receivedAt, which comes after the forwarder's cold start and stdin read and could fall after the next prompt's marker; and end() measures the marker the owner's turn was verified on, not one a carried card wrote after a Stop. The same carried card run again right after itself (a peer close announced twice) keeps the turn, as long as nothing else ran between the two copies. A peer agent's MESSAGE still ends the owner's authority (the PEER default, unchanged; Data decides).
- **4bf28148, the owner's tap (`ownerTapOpens`, `privateTapCard` at the three tap sites).** A tap opens a private turn only when the backend stamped `answeredByUserId` as the owner, it arrives on the stream lane, and at most 90 s after the backend's answeredAt (60 s before it for clock skew). It goes through the fire ledger as `tap:<message id>`, so a second announce is a replay; the owner's tap that opens none (the poll, the boot sweep) is recorded too. A card pushed with no delivery (that tap, a reply reminder, a peer close) is placed in the delivery order as well, each push its own place (the same words pushed again take the oldest push not yet run, as the CLI runs queued cards in order), so a CLI turn it opens places a card queued behind it, and a card repeated in one daemon life no longer reaches back to its first push. A push with a whole CLI turn between it and the prompt is skipped: a copy no prompt line ever took (injected into a running turn, or its line lost) no longer puts every later copy of those words a turn back. A Stop counts once per closed marker, so a second line of the same Stop (another hook source) is no second Stop. A tap is never a reason to send: in the owner's turn it leaves that turn's reason, and only a message the CLI ran in the tap's own CLI turn.
- **e7166041, a stranger after the owner's message.** One record (#254's `strangers`) and one rule for email_send and the gated tools: a delivery or card that names no person (an email, a peer or room agent, a meeting line, someone else's tap) delivered after the owner turn's own delivery ends the turn's authority (boards, schedule, the signed browser context; email_send refuses) until the owner's next prompt, whatever place it reached: one queued behind the owner's message while the CLI was still in the turn before runs with that message or after it. One delivered before it in the same CLI turn leaves the gated tools to the owner, and email_send asks (#254). The owner's later prompt survives a reordered line and asks before an email goes. The ask and the owner bar follow the same order: a card that names no person, or another person's delivery, delivered after the earliest delivery the owner's CLI turn ran (the CLI runs queued cards in order) makes email_send ask and bars the owner, in another chat, injected with no prompt, or run behind a killed hook. A card run first in the CLI turn with its own hook killed still reaches it: its forwarder line bars the owner (a person's) or makes email_send ask (an email, a meeting line) while it was submitted after the latest Stop, by the forwarder's own start against the Stop line's, whichever of the two lines lands first. A live marker left by a CLI killed with no Stop is a place of the next turn (`afterLive`), also with an older hook beside this one that drops it (the CLI turn read right before).
- **c69224fe, #254's lows.** L1: the hook stamps a record it keeps whole (`record: 2`), and an older hook beside this one costs an ask, not a direct send; the daemon keeps its own record of a prompt that carried an untracked card or a delivery naming no person, and the forwarder's clip keeps the untracked tag. L2: a daemon process names one daemon life (`FLOOR_DAEMON_LIFE_AT`), the attached entry is rewritten only when it changes, and a prompt that finds no daemon attached (a daemon standing down after it lost the pairing lock, a torn read) closes the marker holding its CLI turn (`staleTurn`), so the next prompt continues that turn, unsure, instead of opening a new one inside it. Another claude session in the agent's folder, or a rival daemon of the same claude, never takes the agent's turn: the attached entry names the session the daemon's intake is bound to (written beside and moved over, so never read torn), another session's hook writes no marker under it, the hook keeps its own copy of the session's last marker (`private-turn/own`) and a marker someone else wrote in between makes the turn unsure, and a live marker of the session under another daemon life continues the turn, unsure, only while that daemon still runs or when the turn came from this very life (`lifeBefore`); the entry names no session once that session's SessionEnd is consumed, and the SessionEnd hook's own close says which session ended (`ended`), so the first prompt after the operator's /clear writes its marker even before the daemon reads that line. With no verified turn, the turn aware tools (call_owner, list_chats, create_mission, the mission goal tools) also refuse when the live marker names a person by tag, so a share recipient's card queued across a /clear whose line was dropped never acts as the owner. L3: an askOwner draft retried in the same turn is kept once. L4: a late Stop line no longer puts a later turn's email behind the Stop.
- **Data's review of #261.** M1: a reply reminder keeps an owner's turn only when the message it names was the owner's own (server.ts keeps who sent the pending inbound and marks the card `owner_inbound`); one about a share recipient's or a peer agent's message ends the turn as any card with no delivery does. M2: a Custom reply (the `__custom__` sentinel, or any words typed with a tap) opens no private turn, since the backend stamps `answeredByUserId` from whatever credential posted the callback; a plain button tap keeps the rule above, and only on a card as this daemon posted it (its re-verify: the same credential can rewrite a card's text and buttons, so a tap opens a private turn only on a button the reply tool or the plan card posted in this daemon life, with its label, on that card's posted text, which follows an edit_message the backend took and forgets a retired plan card). A tap stamped as the owner's whose words are not shown to be the owner's (typed words, or a card not as posted) is noted as someone else's words on every lane, so it never rides a live owner turn either (Data's L3); the owner's tap on a card as posted, and the backend's Skip on it, are the owner's as before. M3: the drafts email_send keeps for the owner are remembered per fire (the reason's `fire`, kept in the daemon and never posted), so a recurring task's next askOwner fire keeps its own draft while a retry within one fire still saves nothing.

Guards: `test/private-turn-owner-authority.test.ts`, `test/private-turn-owner-tap.test.ts`, `test/reply-overdue-owner-inbound.test.ts`, `test/private-turn-stranger-inside.test.ts`, `test/private-turn-254-lows.test.ts`, the c69224fe section of `test/agent-email-send.test.ts` and the spool line tests in `test/hoai-hook.test.ts`, on the real forwarder, hook, intake, tracker and server.ts's admission block (`test/helpers/private-turn-host.ts`), each red on main or on the commit before its fix.

## 0.71.5 (2026-10-18)

This release carries 0.71.4 (#258, the Windows relaunch weak spots) and 0.71.2 (#259), merged from main.

**The owner can now see which sites an agent's own browser remembers (every Always allow and Trust this site answer) and forget one or all of them from the agent editor; a forgotten site asks again on its very next visit, in a browser that is already open as well as after a restart (HOAI board row 79fda9a6).**

- **Why.** Since 0.68.5 (#224) the browser host keeps those answers in `~/.bgos-agent/<id>/browser/<principal>/agent-browser.settings.json` (`agentGrants["assistant-<id>"]`, beside the legacy `alwaysGrants` map a session also reads), and the only way to take one back was to edit that file by hand.
- **The owner's request (`bin/hoai-browser-host.mjs` `PairingConnection`).** A new socket event, `browser_saved_sites`, `{ assistantId, op: "list" }` or `{ assistantId, op: "forget", origin | all: true }`, answered through the socket.io acknowledgement. The backend emits it only from its owner route (a signed-in person who owns the agent, never an agent credential) and only to the host of the agent's own pairing. The agent's own traffic is `browser_rpc`, which never reaches it, and no tool on the agent's roster lists or forgets anything. A request for an agent this pairing does not serve, or one that is not exactly one site or all, is refused. The handshake now carries `features: ["saved_sites"]`, so the backend asks only a host that answers and tells the owner at once that an older host needs updating (an older backend ignores the field).
- **The forget (`BrowserHostCore.forgetSavedSites`, `lib/browser-saved-sites.mjs`).** Every person's file of that agent on this machine is read, changed and written in one step (`settings.updateSettings`), and every slot of that agent in this host drops the site from its cached grants, so the next visit asks. It removes every yes of the site (fields a newer host added included) and keeps every Deny, the whole site's and one kind's (uploads, downloads); a site the owner refused as a whole is not listed as Trusted. Every other key of the file is kept as read, so an older or newer host still reads it. A file it could not write makes the answer `ok: false`, never a success. The vendored rule tier (`lib/browser-host-core/`) is unchanged.

Guards: `test/hoai-browser-host.forget-sites.test.ts` (a forgotten Always allow and a forgotten Trust this site ask again in the live browser and after a restart; forgetting one keeps the others; forget all across two people's folders, both browsers live, keeps a Deny; a per-kind Deny is kept; a legacy-only grant cached in a live browser asks again; a symlinked person folder is neither listed nor written; per agent; an unreadable file is not reported as forgotten; unknown keys survive and the vendored `sessionGrants` reads the result; the agent has no tool for it; the socket event refuses an agent the pairing does not serve and a malformed request; the handshake declares the feature). `test/hoai-browser-host.test.ts`: the two handshake shape assertions name the new field. Live on a local BGOS rig (made up people, loopback only): after the owner forgot a site in the editor, the agent's next visit in its already open browser raised a fresh permission card, while a site still saved opened without one. The owner surface and the route are BGOS's (the agent editor's "Sites this agent's browser remembers").

## 0.71.4 (2026-10-18)

**A Windows agent's relaunch no longer leaves the real claude running behind its npm shim, nor lets the new launch's gate helper press Enter on a gate the killed claude left on screen; a relaunch inside a fresh session's window keeps that fresh session; health relaunches have a budget of their own; an expired Claude login every agent shares is an alert instead of a relaunch; and gate-proof.ps1 without a launcher pid judges only the newest helper run (HOAI board rows 978da5db and 31583f86, the #246 review's open points).**

This release carries 0.71.2 (#259, a lane hands each message to Claude once), merged from main; #257 shipped as 0.71.5 and is not in it.

- **The claude under the shim (`bin/hoai-core.mjs` `endWin32ShimTree`).** claude installed by npm is `claude.cmd`, which hoai starts as `cmd.exe /c claude.cmd`. node's `kill()` on Windows is TerminateProcess on that cmd.exe alone, and the real claude (node running cli.js) breaks away from libuv's kill-on-close job, so it ran on beside the relaunched one. An update restart, an unproven gate, a missing heartbeat and a stop of a claude started through the shim now list the processes once (Win32_Process through the System32 powershell: pid, parent pid, start and name) and end the processes the shim started after it, through any further cmd.exe layer, then the shim. Only a cmd.exe shim is listed and opened up this way (a native claude.exe is ended by its own `kill()` as on main, its children with its job), and never deeper: claude's own MCP servers end with claude's job, as under a native claude.exe, and what the daemon detached to outlive claude (its browser host, which closes Chrome cleanly; a person lane's supervisor) lives on, which `taskkill /T` would not have allowed. It fails closed (no SystemRoot, a failed listing: hoai's own `kill()`, and a line saying so). A claude whose exit is already recorded is never sent to it (its pid may be someone else's by then), and a child from an injected spawn never reaches the real listing or kill.
- **No Enter on a stale gate (`clearWin32Console`).** A killed claude leaves its last screen on the console the next launch shares (measured: alternate and main screen alike), and the new gate helper pressed Enter on the old gate before the new claude had drawn anything. Before every launch after the first, on the Windows helper path, hoai now leaves a stale alternate screen and erases the screen and scrollback when its stdout is a console. The first launch never clears.
- **The fresh session's window.** A fresh retry's id is pinned once that session outlives 25 s. An update, an unproven gate or a missing heartbeat inside that window relaunched the pin on disk, the session whose resume had just been rejected. None of those is a verdict on the fresh session: it is relaunched (resumed when it has a transcript) and judged again. A fresh session that dies by itself still leaves the previous pin, and a pin the daemon rewrote meanwhile wins.
- **A budget of their own.** Health relaunches (exit 6, no heartbeat at 3 minutes) count against `MAX_HEALTH_RELAUNCHES_PER_WINDOW`, 3 per rolling hour, apart from the update restarts' 3, so neither can use up the other's.
- **An expired shared login.** With no heartbeat at 3 minutes hoai first reads the CLI's own records: the newest login signal across the fresh transcripts (10 minutes, the daemon's rule) of every agent folder in the store the CLI signs in through (`CLAUDE_CONFIG_DIR`, else `<home>\.claude`). When that is an `authentication_failed` record no agent answered after, it writes launch-status `claude-login-expired` (with the time the failure was first seen), prints an ALERT with the CLI's words and the fix (`/login`), and relaunches nothing; the one heartbeat relaunch stays unspent, and the check comes back every 3 minutes, quietly. The failure stands, across relaunches too, until the login is back after it: a sign-in (the CLI rewrote `<configDir>\.credentials.json`; only its time is looked at) or some agent's answer, at any age (a failure nobody has tried past is still a failure once it is 10 minutes old, the daemon's rule). Then a launch still without a heartbeat gets that relaunch. `loginSignalOf` mirrors `lib/claude-login.ts` `extractLoginSignal` (hoai runs under bare node) and is pinned against it.
- **gate-proof.ps1.** Without supervisor.json or `-ConsolePid` any PASS in the shared log since `-Since` made the result, so an old PASS (an earlier start, or another agent's) outweighed the newest run's UNPROVEN. Now a run begins at its `start` line (a reused pid is a second run) and only the newest run is judged: the launcher's newest when its pid is known, else the newest in the log.

Guards: `test/hoai-core.win-relaunch.test.ts` (fake claude behind the npm shim, fake helper, fake console, fake clock, fake credential store), `test/win32-relaunch.console.test.ts` (Windows only: a real npm shim with a FAKE claude, `kill()` leaves it running, and `endWin32ShimTree` ends it and its MCP server while a process that server detached lives on; the real gate helper presses Enter on a killed fake claude's gate and finds nothing after `clearWin32Console`), and `test/gate-proof.script.test.ts` (the real script under PowerShell 5.1, and pwsh when `PWSH_EXE` names one, against fake files). All red on main first, and 45 mutations of the change each turned them red. The real relaunch loop, run on Windows against a fake claude, is in `docs/evidence/2026-10-18-win-relaunch/`. An independent review found the first cut's `taskkill /T` reaching detached processes (High) and the login alert never looking again (Medium), its second pass found that looking again let a failure expire into a relaunch after 10 minutes (Medium), and its third that only a model reply, never /login itself, cleared a held failure (Medium); all are fixed above, with tests red first.

## 0.71.2 (2026-10-18)

**A person's lane now hands each of her messages to Claude once: a message that arrives while the lane is starting is no longer answered twice, and a lane that starts with no inbox note (a first start, or its folders deleted) asks the server which of her recent messages were already answered instead of re-answering her last 15 minutes (mission 161 pilot readiness, board row 01a14cec).**

- **Bug 1, the cause (proved on main with the real lane daemon).** The check and the note in `deliverRaw` were never split by an await; the boot poll was the second path. It read its re-offer set (`inbox.pending`) AFTER its backlog fetch returned, so a message the socket path had noted while that fetch was in flight looked like a turn the last life left unanswered and was re-offered in the same life: two channel events and two acks for one message. Measured: with the 0.71.1 `LaneClaudeReady` hold removed it still doubles, and with only the re-offer set read before the fetch it does not, so the hold is not the cause; the race predates it.
- **Bug 1, the fix (`lib/lane-daemon.ts` `LaneDeliveryClaims`, `lane-server.ts`).** Each message id is decided once per process, synchronously, before `deliverRaw`'s first await, so the socket and the poll can never both hand the same message over. Only the turns the inbox held at launch can be re-offered, each once, and only while still waiting (a `/new` keeps them out as before). And a turn older than the last `/new` the lane performed is never handed over after it (it belongs to the conversation she left), even one the boot poll was still deciding; the `/new` is kept in the inbox note, saved before the restart it asks for, so the next life keeps that turn out too. Such a turn is noted as handled, and the lane does not acknowledge it. A lane that starts with no note finds the `/new` again at the server (below).
- **Bug 2, the signal.** A lane's inbox note and cursor live in its own state folder; with them gone it booted as brand new and re-offered up to five messages of the last 15 minutes. The person's chat history (`GET chats/:chatId/messages`, a route a lane session may read for its own chats since BGOS P2) shows `deliveryState: acknowledged` on a message an agent picked up, and the rows after it: the lane acks a turn the moment it hands it to Claude, the owner's daemon did the same before lanes, and the backend also marks her latest message acknowledged whenever any agent row is saved in her chat, a real answer or one of the fixed lane notices the owner's daemon posts as the agent. So acknowledged alone does not mean answered.
- **Bug 2, the fix (`lane-server.ts`, `lib/lane-daemon.ts`).** ONLY when the lane launched with no inbox note (with one, the note is the authority and the server is not asked), the boot poll asks the server about each backlog row stamped for this lane (one or two requests per row, rows in parallel) and treats a row as ALREADY ANSWERED, never offered again and noted locally as handled, when the server shows it acknowledged AND either an agent answered it (an agent row after it that is not one of the lane's fixed notices, `laneHistoryAnsweredAfter`) or it is a command the lane performs itself (`/new`, `/model x`, `/effort x`, so one the server shows acknowledged is not performed twice; an acknowledged `/new` also restores where the new conversation starts, so the older turns stay out). Everything else goes over as before: the turn that woke the lane, a message only a lane notice acknowledged, and a message handed over but never answered. Each read may take 4 s; one that fails or hangs is retried twice (after 1 s and 2 s), so one read takes at most 15 s and a row needs two at most: the turn that woke the lane waits at most 30 s, and only when the route fails or hangs; a row whose state the server cannot give is then offered as before (the lane never stalls and is never ended by this read), and an acknowledged row whose answer it cannot show is kept out (never re-answered). A turn the socket hands over while the server is asked keeps its own note, unless the server shows it answered (one the server shows picked up but whose answer it cannot show keeps its note too), and a note saved before the boot poll has asked is marked, so a restart in that window does not trust it. A brand new lane asks too, so on its first start the messages of the last 15 minutes that the owner's single mind answered before lanes are no longer offered.
- **Unchanged.** A relaunch WITH its note still re-offers the turn its last life left unanswered (the server has that one acknowledged too), once. The stamp check, the hold, the ack after hand over and the reply chat rule are as in 0.71.1. No backend change.
- **Not covered.** On a boot with no note: a row that never shows acknowledged (a system row, a failed dispatch) is offered as before; and any agent row saved after a picked up message is taken as its answer, even one that answered something else (an answer to a later message, the owner's agent finishing an earlier reply as lanes come on, another writer posting as the agent), while an answer posted in another chat of the lane is not seen; so such a message is not offered again. Telling a lane's own hand over apart from the reply hook's ack would need the backend.

Guards: `test/lane-dedupe.test.ts` runs the real lane daemon under `bin/bgos-launch.mjs` against a stand in backend (the history route in the backend's own envelope) with a stand in Claude: a socket frame noted while the boot fetch is held reaches Claude once and is acked once; a lane with no note keeps out what an agent answered and offers what only a lane notice acknowledged, what was handed over but never answered, and what woke it; it keeps out an acknowledged row whose answer the server cannot show, and offers a row never acknowledged though an agent row follows it; after a `/new` it performed it keeps the older turn out and does not perform the `/new` again; a failed or hung read is retried after a second, and a server that keeps failing gets the backlog offered as before; a note a first boot saved before it finished asking is not trusted; a row stamped for another person is never asked about; a turn the socket hands over while the server is asked stays waiting; a turn the socket hands over during the reads whose answer the server cannot show keeps its note; a relaunch with its note never asks the server and re-offers its waiting turn once; a `/new` during the boot fetch keeps that turn out of the new conversation; a `/new` performed while the boot poll asks the server keeps the older waking turn out and is saved in the note; and a next life started from such a note keeps that turn out too. `test/lane-daemon.test.ts` pins the claims and the history envelope. The bug tests are red on main 64af2f6.

Live (local rig only: BGOS origin/main 67aeb564b with `PERSON_LANES_ENABLED=true`, its own Postgres and ports, made up people, the real `hoai-lane run` supervisor, the lane's locked launch and Claude Code 2.1.302). Bug 1, a cold lane whose boot fetch the rig held while her second message arrived: on 0.71.1 that message reached Claude twice (a turn, then queued into the same turn again) and was acked twice; on 0.71.2 once, acked once. Bug 2, a lane that answered her message, was stopped, had its lane folder and state deleted, and was woken by her next message: on 0.71.1 the new lane answered the old message again; on 0.71.2 it asked the server, logged the old one as already answered, and answered only the new one.

## 0.71.1 (2026-10-18)

**A person's lane now answers her very first message with `reply` on its first launch, with no `/new` needed: the lane daemon hands Claude no turn until Claude has the lane's tools, and tool search is off in every lane, so a tool that reaches Claude late is never left where nothing can load it (mission 161 goal 9).**

- **Why.** On a lane's first launch the model was offered only Edit, Glob, Grep, Read, Write and EndConversation, answered in plain text nobody sees, and kept that tool list for the whole session; only the person's `/new` (a restart whose first turn came later) brought `mcp__bgos__reply` back.
- **The cause (measured on Claude Code 2.1.302 with the lane's own locked launch and a stand in server).** The CLI registers a server's channel handler as soon as the server connects, but queues that server's tools into its tool pool on a 16 ms batch. A lane's first turn is already waiting when its daemon connects, and the daemon handed it over at once, inside that gap: the first request was built with no `bgos` tools. Then, with tool search on (the default) and ToolSearch outside the lane's `--tools`, the CLI kept `reply` deferred for every later turn (its debug log: `Dynamic tool loading: 0/1 deferred tools included`). A turn sent 100 ms after the list had `reply`; one 2 ms after did not, cold start or not. Print mode never hit it because it waits for its servers before its one prompt.
- **The fix, part 1 (`lib/lane-daemon.ts` `LaneClaudeReady`, `lane-server.ts`).** No turn goes to Claude until Claude asked for the tool list, a ping sent after that answer came back (so Claude has read the list), and 2 s passed after that (over a hundred times the CLI's batch). A Claude that never asks still gets its turns after 30 s, the CLI's own MCP connect timeout. The turn is noted (so a second copy is still skipped) and acknowledged exactly as before, the ack still only after Claude was handed it, and `reply` accepts a new turn's chat only from that moment, not while the turn is held (review finding 3; a re-offered turn's chat is accepted from boot, as before).
- **The fix, part 2 (`lib/lane-core.mjs` `LANE_CLAUDE_FIXED_ENV`).** Every lane's Claude runs with `ENABLE_TOOL_SEARCH=false`, whatever the owner's shell exported, so a tool that arrives after the first request (a slow owner MCP server a share allows, say) is sent in full from the next turn instead of being deferred for good. Measured: with it, a turn after a missed first one got `reply` and used it.
- **Nothing widened.** Measured on the same launch, the offered list with the fix is exactly the list a working lane had before: Edit, EndConversation, Glob, Grep, Read, Write and `mcp__bgos__reply` (and the CLI's server side advisor, there in every run). `--tools`, `--restricted`, the strict MCP config, the allow and deny rules and path confinement are untouched; ToolSearch was tried and NOT added (it does not help: the model was never told the tool existed).

Guards: `test/lane-first-turn.test.ts` runs the real lane daemon under `bin/bgos-launch.mjs` against a stand in backend with a stand in Claude: the waiting turn goes out at least the settle after the tool list and is acked after, a row stamped for another person is never handed over nor acked, and a Claude that lists late gets no turn, no ack and no accepted `reply` before its list (red on main: the turn went out 13 ms after the list). `test/lane-claude-ready.test.ts` pins the gate (the ping only after the answer, the settle from the ping's answer, a failed or silent ping, the 30 s limit, ready stays ready). `test/lane-launch.test.ts`: tool search off under both logins, the owner's own setting never reaching a lane. An independent review of the diff found nothing that widens a lane (`ENABLE_TOOL_SEARCH=false` adds no tool and carries no owner value; the gate runs after the stamp check and the dedupe); its low findings are fixed here (the early `reply`, the test's cleanup, its ack check and a timing dependent check), and its note on the owner's settings needs no change, because `--restricted` ignores user, project and local settings files (the CLI's own help text, not measured here) and managed settings outrank `--settings` anyway. Live on a local BGOS rig (backend branch `feat/lane-send-message` with `PERSON_LANES_ENABLED`, its own Postgres, made up people, the plugin's own supervisor, lane daemon and locked launch under CLI 2.1.302): four brand new lanes from cold folders each answered the person's FIRST message through `mcp__bgos__reply`, the reply in her chat history; in each the turn reached Claude about 2 s after the lane daemon came up, the lane's Claude ran with `ENABLE_TOOL_SEARCH=false`, and its first request offered exactly Edit, EndConversation, Glob, Grep, Read, Write and `mcp__bgos__reply` (plus the CLI's server side advisor). The last run was on the final tree. Not live checked: a share with `ownerMcpServers` on, whose late servers this release makes reachable from the next turn.

## 0.71.0 (2026-10-18)

**A person's lane now has its own memory, a real `/new`, its own model and effort within the owner's list, and its own Memory screen answered from that lane; and the share's tool policy options are honoured at launch: a tighter policy restarts the lane at once onto the stricter launch, a looser one at its next idle moment (shared agents Phase 3, P5 and P7).** Inert until the backend serves lanes for the pairing (`PERSON_LANES_ENABLED`); the owner's own chat path is unchanged.

- **Why.** P3 (0.70.0) gave each recipient a locked Claude Code process of their own, but with no memory (under `--restricted` the CLI's auto memory is off, spike S2), no `/new`, the agent's model only, and every lane on the locked base whatever the owner allowed. BGOS P4 built the person's Memory screen for her own lane (`lane_memory_rpc`) and P6 the share's `toolPolicy`; this is the plugin half (design `docs/superpowers/specs/2026-10-15-shared-agents-per-person-sessions-design.md` sections 6 and 7.2 in BGOS).
- **Memory per lane (`lib/lane-memory.mjs`).** The memory is `<lane>/work/memory/` (a MEMORY.md index and one note per memory, the format `lib/memory.ts` reads), inside the only folder the lane's file tools reach. Because auto memory and CLAUDE.md are off under `--restricted`, the supervisor writes `<lane>/system-prompt.md` at every start (what this lane may do, the memory folder and its format, the index as it stands, cut at 200 lines and 25,000 bytes) and passes it with `--append-system-prompt-file`. Measured live: the lane saved a person's fact there from that file alone. A person's edit from the app reaches the model at the lane's next start.
- **The person's Memory screen (`lib/lane-memory-rpc.ts`).** A `memory_rpc` frame stamped exactly for a person is answered from THAT person's lane folder, by her running lane (its own person only) or by the owner's daemon for her stopped lane, never from the owner's memory. Every answer, an error included, echoes `lane` at the top and `actorUserId` and `lane` inside `payload` (the result body's free form object, so a strict validation pipe never refuses it). A write (add, replace, remove) is applied AT MOST ONCE per rpcId across processes: the first process to create the marker `<lane>/memory-rpc/<sha256>.json` (exclusive create, outside `work/`) applies it, a duplicate re-sends that answer, and one still running elsewhere gets nothing. The memory view refuses a symlinked `work/`, memory folder or note, so a planted link cannot turn a panel read or write into one of the owner's files. `lane_memory_rpc` is declared with `person_lanes` on the pairing heartbeat, and in the lane's and the owner's daemon's own socket handshake (`auth.capabilities`; otherwise the owner's handshake is byte for byte today's).
- **The lane's commands (`lib/lane-slash.ts`, `lib/lane-controls.ts`).** A lane resolves commands against its OWN catalog and never reads a command folder, so the body of an owner's `~/.claude/commands/*.md` never reaches a recipient's turn; a name only the owner has is answered as unavailable, with no body. `/memory`, `/permissions` and `/hooks` are reworded for a lane (none reads or edits a settings file, a CLAUDE.md or the owner's project). The lane daemon performs three itself: `/new` repins ONLY that lane's session (a fresh id, never the old one; a pin that cannot be written stops the lane) and restarts its Claude, the memory folder kept; `/model <name>` and `/effort <level>` switch only to what the owner's list for the agent allows, or back with `default`, recorded in `<lane>/choices.json` (outside `work/`) and applied with the CLI's own `--model` and `--effort` by a restart; off the list nothing changes. `/model` or `/effort` alone is a question the model answers from the facts. After `/new` the old conversation's waiting turns are no longer re-offered into the new one (found in the live run). A typed `/new`, `/model x` or `/effort x` sent as plain text counts too (the picker shows the owner's catalog). The lane reports its model and effort with its lane session (`PATCH .../session-settings`). The person is told what happened by a FIXED sentence the owner's daemon posts in her chat, because BGOS main does not take a lane's own reply yet.
- **The owner's list (decision K7).** BGOS main serves no list of models recipients may use, so the owner keeps it on the agent's machine: `hoai-lane models --assistant <id> --set sonnet,haiku --efforts low,medium` (`people/lane-models.json`). With no list only the agent's own default is used, and a choice the owner later takes off the list is dropped at the lane's next start.
- **The tool policy at launch (`lib/lane-policy.mjs`, `lib/lane-session.mjs`).** Before EVERY launch the supervisor reads the share's policy with the lane session (`GET lanes/me`; it mints the session from the ticket when none is stored, and the lane daemon reuses it). ABSENT MEANS LOCKED: no session, a refusal, an answer for another lane, a malformed or unknown version policy, or any option not literally `true` launches the locked base. `webFetch` adds `WebFetch` and `WebSearch` to the `--tools` list and the allow list (the builder refuses any other tool). `shell` adds `Bash`, and runs it under the CLI's Bash sandbox with unsandboxed commands OFF and every secret on the machine denied to it at the operating system: the home folder's sign ins and keys, every agent's credentials, browser profiles and lane bookkeeping, every lane's ticket and session, every OTHER person's lane folder (listed at launch, and a lane that appears later restarts this one at once onto a list that names it), every agent's logs, any `.env*`, `.mcp.json` or credentials file under the home folder, this lane's own control files (its `mcp.json` holds any owner server's keys) and the agent folder's credentials. `shell` is honoured only where the operating system provides that sandbox (macOS `sandbox-exec`; Linux `bwrap` and `socat`); elsewhere the lane gets no Bash at all rather than an unconfined one. The lane floor matches path text, which a shell glob or an interpreter defeats; the sandbox holds whatever path the shell expands to (measured under `--restricted`: a floor evading glob and a Python read of another lane both refused, the network refused, the lane's own folder read). `readAgentFolder` lists the agent's folder (the launcher's own `BGOS_LAUNCH_CWD`, passed as `--agent-folder`) in the settings' `additionalDirectories` with `Read` allowed and `Edit` denied there, NEVER as `--add-dir` (spike S5: `findAgentClaudePids` would take the lane for the owner), and its credentials stay closed (`.mcp.json`, `.git/`, `.claude/`, `.env*`, credentials files); it is refused for the home folder, a folder holding or inside `~/.bgos-agent` or `~/.bgos-plugin-state`, or a path a permission rule cannot hold. Measured with the real CLI: the folder's README read, its `.mcp.json` and `.git/config` refused, a write there refused, and with the option off the read refused. `ownerMcpServers` copies the owner's user scope and agent folder local scope servers from `.claude.json` into the lane's `mcp.json`, allowed by name, never one named like this channel or the browser shim or carrying its credentials, and never as `bgos`. `browser` is read and recorded but never loaded: the Agent Browser relay refuses a lane credential on BGOS main and the shim's local door is the owner's own desktop browser (D3). What each launch got is written into the lane daemon's own environment through the lane's `mcp.json` (`HOAI_LANE_LAUNCH_POLICY`, `_MODEL`, `_EFFORT`), fixed for the process's life, so nothing the lane can rewrite hides a tighter policy; `<lane>/launch-policy.json` is a record only.
- **A policy change while a lane runs.** `lane_policy_changed` (a nudge with no policy in it), every heartbeat answer (the catch up a lost frame needs; no policy in the answer keeps the launch flags) and the boot `lanes/me` are compared with the launch's own policy: TIGHTER (anything the launch had is now off) asks the supervisor for a restart NOW onto the stricter launch, and a turn in flight is cut with one fixed sentence to its person; LOOSER asks for a restart at the lane's next idle moment (no turn in flight and a quiet minute). A restart request is merged with one already waiting, so a policy change can never swallow a `/new`, and a restart spends none of the crash budget.
- **The CLI probe** now also requires `--model`, `--effort` and the hidden `--append-system-prompt-file` before `person_lanes` is declared (probe version 3, so a cached yes is asked again).
- **Not in this release.** A STOPPED lane's Memory screen times out on BGOS main: the server hands that frame only to a SIGNED daemon socket (an assistant signing key, which only the owner's app session can provision), and this plugin's socket is not signed; the owner's daemon answers such a frame correctly when it gets one. The browser option is never loaded (above). A lane's own reply is still refused by BGOS main (`send-message` has no lane principal), so the person reads the fixed sentences, not the model's words. Windows lanes stay off. Under the inherited login (K2 option a) the CLI itself puts the owner's Claude account email into a lane's context (seen in the live transcript), and a `shell` lane can read its own environment, which carries any login variable the owner exported (the red sheet the design gives `shell` says so).

Guards: `test/lane-policy.test.ts` (absent means locked, a deny test for every option, the agent folder rules, the owner server filter, K7, restart requests), `test/lane-launch-options.test.ts`, `test/lane-memory-rpc.test.ts` (the echo, another person refused, once per rpcId across two processes, symlinks), `test/lane-slash.test.ts` (the lane catalog, `/new`, `/model`, the all string command event), `test/lane-policy-watch.test.ts` (tighter now, looser at idle, the lane-server.ts wiring), `test/lane-supervisor-controls.test.ts` (the launch the policy builds, `/new` on a fresh pin, tighter and looser restarts, the default launch facts), `test/lane-owner-controls.test.ts` (the declaration, the handshake, the stopped lane wiring in server.ts, the notices, `hoai-lane models`); `test/lane-cli-probe.test.ts`, `test/memory-wiring.test.ts`, `test/lane-stamp.test.ts` and `test/lane-daemon.test.ts` updated where the code they pin moved. An independent security review of the full diff found one critical (a `shell` lane's glob or interpreter past the floor), three high (the agent folder's `.mcp.json` and git config under `readAgentFolder`; under `shell`, the lane's environment and its own `mcp.json`) and two medium and two low issues; the critical, the highs other than the environment (stated above), both mediums and the low read race are fixed here with tests and mutations, and the other low (a notice aimed at another person's chat) now needs a shell the sandbox keeps out of the lane's control files. Its second pass confirmed those fixes and raised four more (the sandbox must exist on the host; the other lanes list was a snapshot; secrets in the owner's other projects; the agents' logs), all fixed here with tests and mutations. Live on a local BGOS rig with `PERSON_LANES_ENABLED`: `/new`, `/model`, the memory panel read and write through the lane, a tighter policy applied in about two seconds and a looser one at the next idle minute, then the check repeated on the final tree after the review (a `shell` loosen launched Bash under the sandbox with its denials and ran in the lane, the tighten took it away at once), the owner's refresh token fingerprints unchanged throughout.

## 0.70.1 (2026-10-17)

**An email, a peer or room agent's message, a meeting card, or someone else's button tap that reached the CLI turn before the owner's message no longer lets `email_send` send directly: the send goes only with the owner's own approval of exactly that email, else it is kept as a draft for the owner (HOAI board row 70f1898b).**

- **Why.** `email_send` named the owner's message as its reason while the other party's words were in front of the model. Its own state was per prompt: `begin()` recomputed `sendRefused` from that prompt's tokens alone, a Stop line cleared it, and its look back started at the owner's own delivery. So an email, a peer agent's message or a meeting line that reached the CLI turn BEFORE the owner's prompt (its own prompt in that turn, or injected into it with none, no Stop between) was never seen. 0.69.8 (#247) closed this for a share recipient only.
- **The rule.** One CLI turn runs Stop to Stop, as the synchronous private turn hook records it in the marker (0.69.8). The tracker now keeps every delivery that names no person, with the places it reached (`strangers`, never reset by a Stop line, which can be late). When one reached the CLI turn the owner's prompt runs in, `requireEmailSendTurn` still names the owner's message, marked `askOwner`. It counts when a prompt of the turn carried it (its tag), when it was delivered into the turn or the gap before it (its places), when it was delivered while the marker could not be read, or when a prompt of the turn carried a card with no delivery behind it (the marker's `untracked` flag). A marker from a hook before 0.69.8 records no turn; there, any such delivery since the last Stop line counts.
- **What happens to such a send.** It reaches the send route only with an approval the owner's Allow once tap on the Always ask card issued for exactly that email, as today. Without one it never reaches the send route: the plugin posts `email_draft`'s own body to the drafts route, which never sends, and the agent is told "Not sent: the email was kept as a draft for your owner, because words that are not your owner's reached this turn (an email, another agent's message or a meeting card), so only your owner can send it. Your owner can read all of it and send it from the Email chat (...)". With Always ask on, the owner's card works exactly as before.
- **Why a draft and not a forced card.** The backend issues an approval only for a card that carries its floor block (`mayIssueEmailSendApproval`), and stamps that block only while the agent's Always ask switch is on (`stampFloorOnCreate`). With Always ask off, no card the plugin posted could carry an approval. The drafts route is the ask before send the server already enforces: nothing leaves until the owner taps Send.
- **Cards with no delivery behind them.** A meeting line and a meeting invitation (now noted too: it carries the room's earlier words) end with `<hoai-untracked/>`, and the private turn hook records `untracked: true` on the CLI turn whose prompt carries one, for the rest of that turn. So a card queued during one turn and run as a prompt of the owner's next turn is still seen, alone or batched with the owner's message. It is not a delivery token: it opens no turn, fills none of the turn's tags, and the hook waits for no receipt on it. A button tap by anyone but the owner, or by nobody the server named, is noted the same way (`noteTap`, at the boot sweep, poll and stream announce sites); the owner's own tap is not. An email's text cannot forge the tag, and one forged into other words can only make `email_send` ask.
- **Unchanged.** Every existing refusal comes first: a delivery after the owner's own still refuses, a share recipient's message in the turn is still 0.69.8's refusal, and a recipient's own turn still says only the owner can send. An owner turn after a Stop sends directly, the Stop line on time or late. The owner's own deliveries (a wake, a scheduler notice, a voice consult, the owner's own tap) ask nothing. Every other private tool keeps its rule.

Guards: `test/agent-email-send.test.ts` section 15 runs the real CallTool handler against the fake backend: the email, peer and meeting card; a reply; Always ask on with and without an approval; no card possible; no floor route; the Stop separated and share recipient controls; and the wiring pins (every meeting card, the invitation, the three tap sites). Its #228 test (`:227`) now asks without a Stop and sends after a real one. `test/private-turn-late-line.test.ts` uses the real forwarder, hook, intake and admission block. It covers an email, a peer, a room agent and a meeting card (each with its own prompt and injected), a late Stop line, an email queued across a Stop, an unreadable marker on time and behind a late Stop line, an older hook's marker, a meeting card queued and batched, 33 queued meeting lines, a card from the previous daemon life, the tag forged into a peer's or a meeting's words, someone else's tap before and after the owner's message, and controls (Stop separated, on time or late; a share recipient; the owner's wake; the owner's tap). `test/plan-tap-authority.test.ts`: a stream tap by the plan's person or by nobody carries the tag. No version is published or tagged here.

## 0.70.0 (2026-10-17)

**A shared agent now runs one locked Claude Code process per person: each recipient's turns reach only their own lane, started on their first message, stopped when idle, relaunched after a crash, and signed in either as the agent or with the person's own token (shared agents Phase 3, P3, with decision K2).** Inert until the backend serves lanes for the pairing (`PERSON_LANES_ENABLED`, BGOS P2); the owner's own chat path is unchanged.

- **Why.** Every turn on a shared agent ran in ONE Claude Code session with ONE memory on the owner's machine, launched with skip permissions, so a recipient's words, memory and tools reached the owner's context and computer (BGOS design `docs/superpowers/specs/2026-10-15-shared-agents-per-person-sessions-design.md`, the Cho and Riff case). BGOS P2 and P4 built the server half (the lane session, tickets, lane rooms, the stamp, rules version 4); this is the plugin half.
- **The supervisor (`bin/hoai-lane.mjs`, `lib/lane-supervisor.mjs`).** On a `lane_wake` the owner's daemon leaves the single use ticket in the lane's state folder (0600) and starts `hoai-lane run --assistant <id> --lane <userId>`, detached, so lanes outlive the owner's daemon. The supervisor holds a lane singleton (two wakes for one person start one Claude), joins the machine wide registry `~/.bgos-agent/lanes-machine.json` under a file lock (dead supervisors pruned), applies the caps (2 lanes per agent, a machine ceiling of floor((available - 4 GiB) / 1 GiB) from `vm_stat` or `MemAvailable`, the least recently used idle lane evicted, all busy answers `lane_busy`), writes the lane's files and runs Claude under expect in a pty of its own (the development channels screen answered by the shared gate block). Idle stop: 20 minutes with no turn in flight (the lane daemon's `lane.json`), pin kept. A revoke leaves a marker (`revoked.json`) a starting supervisor honours, and only a fresh wake clears; it also removes the lane's ticket and session. Both locks are created atomically (`link()` of a written temp file) and a stale lock is taken over only after renaming it aside and checking it is still the one judged stale. Crash: relaunched with the SAME pin, `--resume` once the transcript exists, at most 3 times an hour, then `lane_failed`. Lane folder `~/.bgos-agent/<id>/people/<userId>/` (`work/` is the only folder its file tools reach); its ticket, session and inbox live in `~/.bgos-plugin-state/<id>/lanes/<userId>/`.
- **The locked base, always.** `--restricted --strict-mcp-config --mcp-config <lane>/mcp.json --settings <lane>/settings.json --permission-mode dontAsk --tools Read,Edit,Write,Glob,Grep --dangerously-load-development-channels server:bgos`, never `--dangerously-skip-permissions` (a new builder, `laneLaunchArgsFor`; the owner's `launchArgsFor` is untouched). The settings allow `mcp__bgos__reply`, `Read(//<work>/**)` and `Edit(//<work>/**)` only (the rule forms spike S2 measured), deny `AskUserQuestion`, set `remoteControlAtStartup: false` (S2 finding 2), and run the lane floor hook on every tool. The environment is an allow list: no tmux names, project dir, supervision variables or BGOS secrets, and `BGOS_AUTO_APPROVE=false`.
- **The lane daemon (`lane-server.ts`, `lib/lane-daemon.ts`).** A separate, small MCP server named `bgos`, deliberately not a mode of server.ts: it never reads the credentials file, never builds a pairing header and never takes the agent's lock. It checks its environment names exactly its own lane's folders, drops any Claude or BGOS secret from its own environment, mints its lane session from the ticket alone (`POST integrations/lanes/session`), checks `GET lanes/me`, connects its lane socket presenting the session ALONE, pulls `GET lanes/inbound` (paged), delivers each turn as a channel event (every meta value a string, plus `lane`), acknowledges it, beats `lanes/heartbeat`, refreshes on `lane_refresh_ticket` and stops on `lane_revoked` or a lost session. Its inbox (`cursor.json`) re-offers a turn that was handed over and not answered after a relaunch, never an answered one, never twice. One tool, `reply`: the chat must be one this lane was handed a turn in, and every file is resolved with realpath and refused outside `work/` (design 7.2 item 7). No permission relay is declared.
- **The stamp check in every daemon.** The owner's daemon refuses any delivery stamped for a person (or stamped with anything it cannot read) on the socket, the poll and the stream, before the delivery claims its id, logs `lane_misroute`, and acknowledges nothing; an unstamped delivery (the switch off) is today's path. Button taps are turns too: once lanes run for the agent, a tap in a chat the daemon knows is a share recipient's (or a stream tap stamped for a person) is never announced into the owner's session. The lane daemon delivers only its own exact `person:<userId>` stamp for its own agent.
- **Rules version 4 (`lib/hard-floor-lane.mjs`, `bin/hoai-lane-floor-hook.mjs`).** A port of the backend's lane floor: version 3 plus any read of a secret or of another person's lane. `lib/hard-floor-lane-fixture.ts` is the backend's file byte for byte (sha256 `ddfcd103...ed39`, LF pinned); all 31 cases pass. In a lane the hook DENIES a hold and fails CLOSED on anything it cannot read, including its own rules failing to load, with no network and no credentials. As in the backend's rule, every path shaped token counts, prose included: a reply whose text names `~/.ssh` is held (seen live), the safe direction the shared rule chose.
- **`person_lanes` only when the CLI can run the lock (`lib/lane-cli-probe.mjs`).** Declared in all three `declaredCapabilities` call sites only on a pairing whose host has `expect`, is not Windows, and whose installed CLI lists every locked flag in `--help`, lists `dontAsk` among its permission modes, and answers "argument missing" for a bare `--dangerously-load-development-channels`. The answer is cached per binary (real path, size, modification time). Otherwise nothing is declared and the backend keeps the agent's single mind.
- **K2, both logins, per share (`lib/lane-login.mjs`).** `hoai-lane login --assistant <id> --lane <userId> --mode inherit|own_token`. (a) `inherit` (default): the login variables pass through only if the owner's process had them, byte for byte, and `CLAUDE_CONFIG_DIR` is never invented. (b) `own_token`: the person's own `claude setup-token` token, stored with `hoai-lane token set` (stdin only) in the macOS keychain (`security -i`, never argv) or a 0600 file on Linux, read into that lane's environment only, with the lane's own `CLAUDE_CONFIG_DIR=<lane>/claude-config` and every owner login variable dropped. A MISSING token never starts Claude: the lane daemon runs once in notice mode to find the person's chat and the owner's daemon posts a fixed sentence there, then reports `lane_failed`. A REFUSED token: measured on CLI 2.1.302, the CLI keeps the refused token (debug line `OAuth 401: keeping the user-supplied CLAUDE_CODE_OAUTH_TOKEN instead of adopting the stored credential`) and starts with its channels switched off ("Channels are not currently available"), so it never takes a turn; the lane launches with `--debug-file`, the lane daemon reads that line within 5 seconds, tells the person and stops the lane. The sentences are fixed text in the agent's voice; nothing a lane writes chooses their words, only which of the agent's chats.
- **Inert unless served.** The owner's daemon acts on lane frames only while it holds the pairing lock and only after the server's `lanes_state` (or `GET lanes/state`, asked again when a wake finds lanes off) says lanes are on for this agent.
- **Not in this release.** The backend does not yet accept a lane's reply (`/send-message` answers the lane refusal until BGOS gives that route a lane principal), so a lane takes its turn and the person sees no answer yet. Windows lanes (a console per lane, spike S5), the policy options and the browser in a lane (P7), and memory, `/new`, model and effort per lane (P5) are later PRs. Whether a VALID `setup-token` token gets channels at all is unmeasured (the CLI says such sessions default to the `user:inference` scope).
- **Tests only: real Chromium files run one at a time.** `scripts/run-tests.mjs` now runs the `*.chromium.test.ts` files after the rest, with a concurrency of one. Run side by side, two of `remote-browser-controls.chromium`'s tests fail on main 97d977d exactly as on this branch (measured with the same command on both); one at a time all seven files pass. The nine new test files shift which files the parallel pool overlaps, which turned that rare overlap into a usual one.
- **Unchanged:** the owner's launch arguments and supervisor, every owner delivery without a stamp, and the declared list when the probe says no.

Guards: `test/run-tests-chromium-serial.test.ts`, `test/lane-launch.test.ts`, `test/lane-stamp.test.ts`, `test/lane-registry.test.ts`, `test/lane-supervisor.test.ts` (singleton, idle stop, crash relaunch, both logins, busy, eviction), `test/lane-cli-probe.test.ts`, `test/lane-login.test.ts`, `test/lane-daemon.test.ts` (path confinement with real symlinks, all-string meta, the inbox, the refused token line), `test/lane-owner.test.ts`, `test/hard-floor-lane.test.ts`. Every new file fails on main; 34 of 35 mutations red, one equivalent. An independent security review of the full diff found no critical or high issue; its medium (button taps) and lows (lock races, a revoke during a start, hook and expect quoting, the debug log read) are fixed here. Live run against a local BGOS rig with lanes on: two made up people, two lane processes with separate folders and sessions, crash relaunch, idle stop and both login modes, with the owner's refresh token fingerprint unchanged. No version is published or tagged here.

## 0.69.12 (2026-10-17)

**A host start's sweep keeps a dead host's runtime folder until it is quiet, and the runtime folder tests no longer fail on a macOS TMPDIR (two review lows from #249, and Data's macOS finding).**

- **Why.** The sweep of 0.69.10 removed a `hoai-browser-runtime-*` folder at once when its owner's pid was dead. A host that crashed after making its folder and before its Chrome took the lockfile (or, on macOS and Linux, its `SingletonLock`) leaves a folder the busy check cannot tell from a free one, and a Chrome that host spawned can outlive it and still be starting there. The next host start would have removed the folder from under that Chrome.
- **The fix.** A dead owner's folder is now removed only once it is untouched for `RUNTIME_DIR_REUSE_QUIET_MS` (10 minutes), the quiet window a reused pid already had, on every platform. This is the smallest rule that holds: the alternative, proving no live Chrome uses the folder, would need every Chrome's command line (a PowerShell CIM query on Windows, a `ps` scan elsewhere) on each start, and a Chrome that is still starting writes into its folder, so a folder quiet for 10 minutes with no lock is not one a start is working in (a start is bounded by `BROWSER_START_TIMEOUT_MS`, far under 10 minutes). The busy check, and every other rule of the sweep (this host's own folders, a live owner, an unreadable start, an unnamed folder after 24 h, links, one removal at a time), are unchanged. A folder kept for being recent is counted in the sweep's summary line as kept, and removed by the next host start after it has gone quiet.
- **Comment only.** `_abandonStart` still said the wait for the Chrome a timed out start killed runs only on Windows; since 0.69.10 it runs on every platform.
- **macOS, tests only (HOAI board, Data).** On a Mac, 8 tests of `test/browser-runtime-folder.test.ts` failed with `unsafe_profile: a folder above the browser profile folder is a link`, because the tests put the engine's profile folder under `os.tmpdir()`, and macOS TMPDIR is under the `/var` to `/private/var` link. Plugin CI runs Linux and Windows only, so it never showed. The product is not affected: the vault's link check (`secureProfileDir`, `lib/agent-browser-vault.mjs`) runs only on the profile folder, which is under `~/.bgos-agent` (`browserPathsFor`), never on the runtime folder, which is made in TEMP and only created and made private (`ensurePrivateDir`). So the host needs no change; the tests now resolve the temp root they create folders under (`realpathSync(tmpdir())`), and a new test starts a browser with TEMP reached through a link (a junction on Windows, a symlink elsewhere) and expects the runtime folder to be made under it.

Guards: `test/browser-runtime-folder.test.ts`: a dead host's fresh folder is kept on win32, linux and macOS, a dead host's folder is removed once quiet for 10 minutes and not at 9, a dead host's quiet folder with a Chrome in it is still left whole, the runtime folder is made when TEMP is a link. The existing sweep tests that removed a dead host's folder now age the folder first (the dead host's folder, the win32 busy case, the win32 refused removal, the link inside a swept folder, and the end to end case). No version is published or tagged here.

## 0.69.11 (2026-10-17)

**Another agent's follow-up in a group or a channel now reaches the agent like a person's follow-up, labelled as that agent and never as the owner; the agent's own message still never wakes it (HOAI board row 2d6ac222).** This is the plugin half BGOS's `COLLAB_FOLLOWUP_AGENTS` waits for.

- **Why.** BGOS keeps a follow-up window in a group or a channel: the agents a message woke are handed the next two messages written there. Step 2 (BGOS #2521) hands them another seated agent's message too, marked on every lane as `senderType: 'room_agent'` with the author's `senderAssistantId` (a number) and no human sender block. Before this release the socket lane took such a message for the OWNER speaking (it fell back to the envelope's `userId`, which is this agent's owner), and the update stream dropped it as the agent's own reply (its stored `sender` is `'assistant'`) and cleared the pending reply. So BGOS keeps the flag off, client release first.
- **The reader.** `readRoomAgentSender` (lib/inbound-channel.ts) reads the exact BGOS shape, `senderType`/`sender_type` `room_agent` and `senderAssistantId`/`sender_assistant_id`, off the server's own record, and `isOwnRoomAgentMessage` compares the author with this agent's id. BGOS marks every agent's row in a group or channel this way, the agent's own reply included, so the id decides: another agent's message is delivered, the agent's own is not. On the socket a message whose author cannot be read is not delivered either, and a log line says which of the two it was.
- **Delivered like a person's follow-up, once, with its settled text.** The socket (`deliverWsInbound`) delivers it through the same path as a person's follow-up, its text exactly as BGOS framed it (the framing already says an agent wrote it and that the agent was not named), with the room's session handle so a reply goes back there. BGOS pushes it only once the text has settled (no edit for 20 seconds). The update stream hands it over as it stands, because an agent writes its message by creating it and then editing it: a `message_new` with the first chunk (or nothing yet) within seconds, then a `message_finalized` for each edit. Delivering the first version would claim the message id, and the settled push (which carries no stream stamp, since BGOS never kicks an agent's row) would be dropped as a duplicate, so the agent would only ever see the first chunk. Leaving it to the push is no answer either: a stream read after BGOS's 5 second kick grace marks the push's row delivered (`TURN_WAKE_NOTE_READ_SQL`), and the push never comes (both found by the delegated review). So `viewStreamMessage` reads it as `senderKind: 'room_agent'`, `decideMessageNew` / `decideMessageFinalized` answer `room_agent_settling`, and the stream hands each version to a settle wait (`lib/room-agent-settle.ts`): it keeps the latest version (an empty one never erases text, and a message still empty when the wait ends stays parked for its text) and delivers it through the stream forwarder once no newer version has come for 20 seconds, BGOS's own settle time, unless a lane delivered it first. Whichever of the push and the wait comes first delivers; the other finds the id taken. The stream moves on meanwhile and the pending reply stays. A `message_finalized` behind the persisted chat cursor is covered, as a person's is, unless the wait still holds the message, so an edit long after delivery or after a restart is not delivered again; a `message_new` always goes to the wait, since the cursor can already be past it (a later message pushed first while the stream catches up). A handoff that fails is tried once more after another wait. A `seat_revoked` or `chat_deleted` for the chat drops what the wait holds there. At most 200 messages wait at once (the oldest is delivered early). Two limits, stated: the wait is in memory, so a daemon that stops inside it loses the stream's copy (the push still comes only if the stream had not read the row after the grace); and unlike the push it does not ask BGOS again before delivering, so a message deleted or a flag turned off inside the 20 seconds is still delivered.
- **Labelled as that agent, never a person.** Its card carries `sender_type="room_agent"`, `user="Agent"`, `sender_assistant_id="<id>"` and `user_id="room_agent:<id>"`, and no sender relationship, display name, share keys or guardrail, whatever the record says. Every value is a string (wake-card contract). It is never the chat's last human sender, the acting user, an owner turn (Stop pause, private tools: `privateActor` gives none and `email_send` refuses), the sign-in code, a permission answer (`isAgentInbound` now counts it) or a slash command.
- **It asks for no reply.** `inboundOwesReply` treats `room_agent` like a system card or an email: BGOS hands an agent's message over only as a follow-up, and its canon says silence is a correct answer and nothing waits for a reply. A reply nudge would push one agent to answer another, the back and forth the window prevents.
- **The agent's own message.** The socket drops it before anything is noted. On the stream it stays the reply boundary it always was (`assistant_authored`: the pending reply is cleared, nothing is delivered). Only an id match counts: an author the stream cannot read leaves the pending reply alone. A delivered agent message is filed as an agent's turn (`peer`) for the hook rows, not a person's.
- **Told to the agent.** The instructions gain "Another Agent In A Group (sender_type room_agent, NOT a person)", and the per sender text says what `user_id` is on such a message.
- **No capability token.** BGOS gates step 2 on its own wire flag, not on a declared token (`followupAgentsEnabled`, turn-wake-flags.ts; the canon names none), so nothing new is declared.
- **Unchanged:** a person's follow-up and every other delivery, byte for byte, the poll lane (the history route this daemon polls does not carry the marker and never forwards an agent's row), peers, email and system cards.

Guards: `test/room-agent-followup.test.ts` (24 cases; the socket, stream and poll lanes run out of server.ts with the email label test's harness, the stream with its settle wait on fake timers: another agent's follow-up on the socket, its command and permission look alikes, the stream's empty row, first chunk and finished text delivered once as the finished text with the pending reply kept, the settled push coming first and the stream delivering nothing, a stream delivery first and the push dropped as its duplicate, the settle wait's own rules (latest version, the room cap, an empty message parked for its text, a chat dropped, one retry), an agent working past the settle time before its first text, a message the cursor is already past, a stood down or draining daemon delivering nothing from it, a seat taken away or a chat deleted dropping a held message, an edit of a delivered message after a restart not delivered again, the stream forwarder, the agent's own message on each lane, an author that cannot be read and its log line, a person's follow-up before and after an agent's, the poll lane unchanged, the private turn fields (no actor, `email_send` refused), the builder from either side with a sparse record, the reader, the instructions). 14 fail on main; the five that pass there are the person and poll controls, the stream's own message guard and the stood down gate, which hold on main because it never delivers another agent's message at all. 44 mutations of the change, each one red. No version is published or tagged here.

## 0.69.10 (2026-10-17)

**A browser start that failed removes its own runtime folder, and a host start sweeps the runtime folders that a host gone since left in TEMP (HOAI board row 5e811669, found in #245).** Two ways a `hoai-browser-runtime-*` folder stayed in TEMP for good, on every platform.

- **Why, 1.** When `ChromiumEngine.start()` failed (Chrome never reported its DevTools endpoint, exited early, or the connection to it failed), the folder the start had made was never removed: `BrowserPool.acquire` drops an engine whose start failed and never calls its `stop()`, and only `stop()` removed the folder. Every failed browser start left one.
- **Why, 2.** Since 0.69.6 a folder Chrome's helpers still held after a stop's 2 s retry is logged and left for the next browser start in the same process. At the host's final stop there is no next start and that list lived in memory only, so the folder stayed. A host that crashed or was killed left its folders the same way.
- **The fix, a.** A start that failed removes its own folder (`_abandonStart`), after `launchChromium`'s bounded wait for the Chrome it killed or the connect failure's own stop and kill. That wait (`BROWSER_KILL_WAIT_MS`, 3 s at most, milliseconds after a SIGKILL) now runs on macOS and Linux too, not only on Windows: until the killed Chrome has exited its `SingletonLock` names a live pid, and the folder reads as in use. Not while a Chrome may still run in it: a Chrome `_killChild` gave up on, or one still holding the folder (the busy check below), leaves the folder whole and forgotten, so no later stop of that engine touches it, and the next host's start sweep removes it. On Windows the removal gets the stop's bounded retry, and a folder still held after it is logged and left (for the next start, or the next host's sweep). The start's own error reaches the caller, never the folder's.
- **The fix, b.** Every runtime folder now records its owner in its name: `hoai-browser-runtime-<pid>-<start>-XXXXXX`, the host's pid and that process's start time (base 36; on Linux on the boot clock, the clock `ps` measures etime on, so a step of the wall clock after a WSL2 or VM resync cannot make a live host look gone; elsewhere on the wall clock, which Windows and macOS date a process's start on). The name exists from the moment the folder does, and survives a Windows removal that took everything else in the folder. Five seconds after its start, off the start path, the host (`main`) sweeps its own TEMP (`sweepRuntimeFolders`, removals awaited one at a time) and removes a folder only when its owner is proven gone: its pid is not alive, or the process holding that pid now started more than 2 minutes after the recorded start (a reused pid, read with `lib/agent-inventory.mjs`'s process query) and the folder is untouched for 10 minutes (`RUNTIME_DIR_REUSE_QUIET_MS`). It keeps this host's own folders, those of an owner that is alive or whose start cannot be read (two hosts run at once, the desktop app's and an agent's), and a folder that names no owner (made by a host before 0.69.10) unless it has been untouched for 24 h. Before any removal it asks whether a Chrome still runs there: on Windows Chrome holds its `lockfile` without delete sharing while it runs (removing it fails `EBUSY`; measured with a real Chrome on Windows 11), on macOS and Linux its `SingletonLock` link names a live pid on this machine. Such a folder, and one Windows refuses to remove, is left and logged, never thrown. Only real folders directly in TEMP are looked at (on macOS and Linux only this user's): a link by that name is left whole, and the links inside a removed folder are unlinked, never followed. Each removal is logged (`removed the stale browser runtime folder <path>: its host (pid N) is gone`), then one summary line (`runtime folder sweep of <TEMP>: N removed, N left, N kept`) when TEMP held any.
- **Known limit, and how far it reaches:** on Windows a process's start is read from CIM as local time, so for a host started in the repeated hour when daylight saving ends it can read an hour late; on macOS a step of the wall clock moves it the same way (Linux reads the boot clock). Such a live host reads as a reused pid. The time comparison alone never removes its folder: a reused pid's folder is removed only when the busy check also passes (no Chrome holds its `lockfile`, or on macOS and Linux its `SingletonLock`) and the folder is untouched for 10 minutes, well past what a start takes before its Chrome takes the lock. So a folder whose Chrome runs, or whose browser is still starting, is always kept; a misread live host can lose only a folder no Chrome has run or started in for 10 minutes, such as a stop's leftover, which its own next browser start removes anyway. A dead owner's folder is removed as before, once free.
- **Unchanged:** every browser that starts, a stop (its retry, its log line now naming the next host start too, macOS and Linux still failing on a removal error), the pool, and anything in TEMP not named `hoai-browser-runtime-*`.

Guards: `test/browser-runtime-folder.test.ts`, on the fake Chrome of 0.69.6: a timed out start removes its own folder once Chrome let go (win32; macOS and Linux once the killed Chrome exited, which `launchChromium` now waits for there too), a failed start leaves no folder on win32, Linux and macOS, a connection that failed after the endpoint removes it too, a start whose Chrome did not exit or still runs in the folder leaves it whole and forgotten, a folder still busy after the retry is logged and left with the start's own error thrown and the next start removes it; the folder's name records its host; the sweep on scratch TEMP folders: a dead owner's folder is removed and logged, a live owner's is kept (the real process table), a reused pid is proven gone (the real process table), a live host whose start reads an hour late (the daylight saving hour) keeps its folder while its Chrome holds the lockfile and while its browser may still be starting, a true reused pid's free and quiet folder is removed, the same on macOS after a wall clock step, an owner whose start cannot be read is kept, the 2 minute slack, the Linux boot clock across a wall clock step, this host's own are kept with no query, an unnamed folder is kept under 24 h and removed after, a win32 folder whose Chrome holds its lockfile is skipped whole, a win32 removal refused busy is logged and the sweep goes on, the posix SingletonLock check, a junction (win32) or symlink inside a folder is unlinked and its target survives, a link, a file and another program's folder by TEMP are left whole, an unreadable TEMP throws nothing; END TO END, the real host started as a process with TEMP on a scratch folder removes a dead owner's folder and keeps a live one's, after its start. No version is published or tagged here.

## 0.69.9 (2026-10-17)

**An agent granted a board can now fetch the files on its rows: `boards_download` saves one into the agent's folder and answers the path (HOAI board rows 01a14840-19e0, 01a14840-27c2).** KC: "agents who have access to a board should be able to download the attachments; now it is not the case."

- **Why.** `boards_get_row` printed every file's name and full id, and `boards_attach` promised that "every agent granted that row can fetch it later", but no tool fetched anything. The backend's agent route that mints the download link (`GET .../attachments/:id/url`) worked for every grant all along; reproduced on a local rig (a throwaway backend, Postgres and an S3 compatible store), where a read grant, a write grant and a row grant each got every file they may read byte for byte through that route, and a row-scoped agent and an ungranted one got the uniform not found. In production nginx's last seven days hold about 4,000 agent boards calls and not one to any attachment route; Vexa, 2026-10-16: "its tools do not let me download attachments."
- **The tool.** `boards_download {board, attachment_id, response_format?}`, the thirteenth boards tool, right after `boards_attach`. It mints the link through this daemon's own boards transports (so the server's grant check decides, and its denial body reaches the model verbatim), fetches it, and saves the bytes at `.hoai/board-files/<person>/<attachment id>/<file name>` under the agent's folder (LAUNCH_CWD, the folder claude runs in), folder 0700 and file 0600, written to a temporary name and renamed. The answer names the path, the type and the size; the model opens the file with its Read tool.
- **The link is a credential.** It is fetched over https only, with no header of this daemon's (the pairing token never reaches the storage host), no redirect, and never shown to the model, in an answer or an error.
- **Exactly the file, or nothing.** The backend now answers the file's name, type and size beside the link; a body longer or shorter than that size is not saved and leaves no partial file, a declared length over it is refused before the body is read, and anything over 100 MB is refused before it is fetched.
- **One folder per person, which organises and does not isolate.** The owner's turns save under `owner`; a share recipient's under `person-<16 hex of the sha256 of their user id>`, decided by the same comparison that decides whether the call carries `X-BGOS-Acting-User`, so a file lands with the principal the server answered for. Until person lanes every turn on a shared agent runs in one session and one folder, and Read or a shell reaches any of these folders (the security review of this release), so **every copy is deleted after an hour** (`BOARD_FILE_KEEP_MS`): swept by each download for its own folder and by the daemon at start and every ten minutes (`sweepBoardFiles`, which enters only the folders it names and never follows a link), and the answer and the canon tell the agent never to open or show a copy fetched for one person while answering anyone else. Under lanes each person's daemon runs in its own folder, and the folder becomes the boundary.
- **The owner's file name never picks a folder, and is never an instruction file.** It goes through `saveName` (lib/browser-downloads.mjs: the last path part only, control and direction characters and Windows reserved names removed), then `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`, `GEMINI.md` and their kin are saved as `board-file-<name>` so the agent's CLI cannot load one as instructions, then the name is cut to 200 bytes with its extension kept; the attachment id, the only other path part, must be a full uuid before anything reaches the network. A linked folder anywhere on the way (`.hoai`, `board-files`, the person, the attachment) is refused, and the file's real path is checked before anything is written. The uploader's type is printed to the model only when it is a plain type/subtype.
- **Told only where it exists.** The daemon declares `boards_download` (every host, `DECLARED_CAPABILITIES_BASE`), and the backend's capability canon tells the agent about the tool only for a connection that declares it, so an agent on an older plugin is never told about a tool it does not have. `boards_attach` and `boards_get_row` now point at it.
- **Unchanged:** every other boards tool, their transports and verbatim denials, the private turn gate (the tool is a `boards_` tool, so it is refused with no verified turn exactly like the rest, and `PRIVATE_TOOL_MATCHER` already covers it).

Guards: `test/boards-download.test.ts` (29 cases: the declaration, the mint path and the saved bytes, markdown and json, a second download in place, the file and folder modes, a verbatim denial with nothing fetched, a short key or a path as the id, a connection with no folder, a non https link, the size ceiling, a body longer or shorter than the file, a failed fetch without the link, hostile file names, the default fetch's headers, redirect and byte cap, one folder per person, server.ts's wiring from the admitted turn, the private tool gate, the declared token, the expiry sweep and its link and folder limits, instruction file names (compared NFKC folded), linked folders, the uploader's type, names cut by bytes, an upper case id, the warning in the json answer). `test/boards-tools.test.ts`, `test/declared-capabilities.test.ts`, `test/capabilities.test.ts` and `test/version-heartbeat.test.ts` pin the roster and the declared list with the new tool and token. No version is published or tagged here.

## 0.69.8 (2026-10-16)

**A share recipient's message that reaches a CLI turn before that turn's prompt reaches the daemon no longer lets anything act as the owner in it (HOAI board row f81a527c, the 0.69.0 review's plugrel item B; cousin row 70f1898b).** Within one CLI turn the daemon now knows everyone who reached it, and no tool acts as the owner once someone else did.

- **Why.** The private turn hook writes its marker synchronously, but the forwarder line that carries the prompt to the daemon (`begin()`) is never waited for: on Windows a cold node start alone took 4 s, and the hook stops waiting for the daemon after 3 s. A recipient's message that arrived meanwhile found no admitted turn, so it revoked nothing, and the CLI injected it into the running turn. Then the late line's `begin()` reset `turnSeen` (`turnSeen = freshSeen()`), forgetting the recipient, and the owner's prompt opened a verified owner turn: boards, schedule, the Agent Browser and the turn aware tools (`call_owner`, `list_chats`, the mission tools) acted as the owner with the recipient's words in the turn. The same reset hid a recipient whose prompt ran in the same turn as the owner's (#232: one UserPromptSubmit per delivery, the marker left is the last one's), and there `email_send` named the owner's message too (70f1898b), since its look back starts at the owner's own delivery. Reproduced on main, on #233 alone and on 0.69.0. A Stop line is never waited for either, so the same race also ran across a late Stop.
- **The fix.** The private turn hook, the one part that runs in step with the CLI, records the CLI turn in the live marker it writes (`privateTurnRecord`): `cliTurn` stays the same for every prompt until a Stop closes the marker (a new turn is named by the CLI's prompt_id, so two hook sources of one submission agree), `after` names the closed marker the turn followed, whatever closed it (this or an earlier session's Stop or SessionEnd, a failed Stop hook), or `none` when there was no marker yet, and `tags` carry a hash of each prompt's delivery token (never the token). The daemon notes, for each person's delivery, where the markers stood when it arrived, and keeps each delivery's tag with its sender. The tracker is told the owner (`ownerUserId`, server.ts `USER_ID`) and the markers (`markerPaths`, `PRIVATE_MARKER_PATHS`), and `current()` gives no turn that would act as the owner while the marker it adopts names anyone else: a person whose delivery reached that CLI turn or the gap before it, or whose prompt is among its tags. A tag the daemon cannot place (a delivery of another daemon life), a turn whose earlier prompts are unknown (the marker before could not be read), and a delivery that came while a marker could not be read (until a Stop written after it) bar it too. Every reader goes through `current()`: the boards and schedule gate, `email_send`, the turn aware tools (which then refuse too) and the signed context the Agent Browser verifies. The refusal's log line says it (`...but someone other than the owner reached this turn (user_...), so nothing acts as the owner in it`).
- **A CLI killed without SessionEnd bars nothing after it (the #247 review, Data).** The fleet restarts claude with kill -TERM, which leaves the marker live. A live marker before a prompt is that prompt's CLI turn only when the same session wrote it under the same daemon life: the session id first, then the daemon life the hook found serving the session (the floor's attached entry: its pid and when it attached, `daemon` in the marker), so a reused pid never keeps a dead life's marker. Another session (a new one after the kill) or the same session started again on its pinned id (its daemon a new life) starts a new turn, and the dead turn's tags, which the new daemon could not place, no longer refuse the owner's first turn after every restart. A marker of an older hook names no daemon life; the session decides alone, as before.
- **The turn aware refusal names a person only when one reached the turn.** "A person this agent is shared with" stays for a share recipient's message; a turn barred only by a message the agent could not verify gets plain words (`TURN_AWARE_UNVERIFIED_REFUSAL`), with nothing about sharing.
- **turnSeen** (who reached the work, read by the turn aware tools when no verified turn is open) now survives `begin()`, with each prompt's own sender in it; a Stop keeps whoever reached the gap after it or the turn the CLI ran after it (the marker written last of this session says which), and forgets everyone else. A marker written by a hook before 0.69.8 records no turn; then the owner bar falls back to turnSeen.
- **Fails closed.** An owner prompt in the same CLI turn as a recipient's message, before or after it, gets no private tools in that turn; a turn interrupted without a Stop is still the same turn. A tracker not told the owner treats any sender as possibly the owner.
- **Unchanged:** who may open a private turn (the owner, a share recipient as themselves, never anyone else), every begin outcome and log line, a share recipient's turn (it acts as that person even when the owner's message ran in the same turn, as #232 has it), email, peer and meeting deliveries (as before: `email_send` refuses, the other tools are not barred), the mid turn revoke, #232, scheduled wakes (#221), voice consults (#227), replayed fires (#229) and a Windows agent folder reached through a link (#214). The marker stays well under the 2048 bytes every reader, the Agent Browser included, accepts.

Guards: `test/private-turn-late-line.test.ts`, on the real forwarder, the real private turn hook, a real intake, the tracker, the signed browser context and server.ts's own admission block: the plugrel shape, 70f1898b in both line orders and behind a late Stop line, a second owner prompt of the same turn, the race across a late Stop line (the recipient arriving before or after the next prompt's hook), a queued recipient prompt in either line order, a new CLI session (the recipient before or after its first hook), a failed Stop hook, the first prompt at a marker key, two hook sources of one submission, a daemon restart, a CLI killed without SessionEnd and started again (the full stack, a new session, the same session with a dead daemon pid or a reused pid), the plain refusal text, a goal continuation, a second record with no prompt_id, a delivery of another daemon life, a marker that cannot be read, an unknown owner, the turn record the hook writes, and the controls (the owner alone, the recipient alone, owner then recipient and back, also with the Stop line ahead of its marker, the mid turn revoke and the next turn, #232, #221, #227, #229, the #232 stranger, a restart, stale markers). `test/turn-aware-tools.test.ts`: a new prompt without a Stop no longer clears a recipient (the turn is the same), `turnSenders().people` lists the prompt's own sender, and its harness's Stop runs the Stop hook as the CLI does. The fixtures of `test/private-turn.test.ts`, `test/private-turn-duplicate-boundary.test.ts`, `test/private-turn-shared-spool.test.ts` and `test/private-turn-two-admitted.test.ts` name the owner, as server.ts does. No version is published or tagged here.

## 0.69.7 (2026-10-16)

**On Windows a gate the helper cannot show it answered is relaunched, and an unattended launch whose channel never sends a heartbeat is relaunched once, then reported (HOAI board row d806c69f).** Reported by Data and Mark for agent 888: a cold start right after logon (16 Oct 07:59Z, launcher pid 25088, claude.exe 25184) left `win32-gate-helper.log` with `start` and, 16 s later, `accepted`, but no `attached`, where every earlier boot had all three. claude stayed alive, never started its MCP server, and the agent sat offline for 10 minutes until a restart marker brought it back.

- **Why the line was missing.** The helper's `Note` wrote with `try { Add-Content ... } catch {}`. PowerShell 5.1's Add-Content refuses a file that any other process has open for reading (an indexer, a scanner, a person's tail), and it does so with a NON-terminating error, which that `catch` never sees: the line is lost, and the error text goes to the helper's stderr, which hoai points at the same log. Reproduced with the real 0.69.6 helper on a fake console, spawned as hoai spawns it, with one reader holding the log while `attached` was written: the log read `start`, Add-Content's refusal, `accepted`, exit 0 (`docs/evidence/2026-10-16-gate-attach.md`).
- **Why nothing acted on it.** `accepted` only ever meant "an Enter was written to the console input", and hoai never looked at the helper's exit code: it spawned the helper and moved on. In the reproduction the fake gate did get its Enter, so the log shape alone does not show that 888's gate stayed up; nothing on 888 recorded what claude was waiting on. Mark's hypothesis, a console not ready right after logon, is not proven here, so no wait or retry of the attach is added.
- **The cause, fixed.** `Note` appends through a FileStream opened append-only (`FileSystemRights.AppendData`) that shares read, write and delete, so a reader, hoai's own handle on the log and another agent's helper can no longer refuse or overwrite a line (with a reader holding the log, the reproduction now logs all three lines and exits 0). A write that still fails (the log held with no sharing at all) is retried for about a second and reported on stderr as `log write refused, one line lost: ...`.
- **The fix, a.** The helper exits 0 only when `attached` AND `accepted` are both on record; an Enter it wrote without both is exit 6 (`WIN32_GATE_EXIT_UNPROVEN`) and an `unproven: ...` line that contains neither word. An unattended hoai (the agent task, `--keep-alive`, `HOAI_SUPERVISED`) relaunches claude for a 6, on the agent's own pinned session, through the same relaunch a restart marker gets, counted against the same 3 relaunches per rolling hour; past that it is refused (`health-relaunch-refused`) and claude is left as it is. A helper exit only ever acts on the launch that spawned it.
- **The fix, b.** No PASS check in this repo read the gate log; hoai-switch, whose PASS greps only `accepted`, is not in this repo. `docs/evidence/2026-10-16-gate-attach/gate-proof.ps1` is the read-only proof for 888: PASS only on `start`, `attached` AND `accepted` from one helper pid of 888's own launcher (the `console=` its `start` names, by default the pid in `supervisor.json`; the log is shared by every agent of the Windows user), then a daemon boot within 3 minutes and a channel beacon after it.
- **The fix, c.** An unattended hoai checks the channel's heartbeat 3 minutes after each launch (`CHANNEL_HEARTBEAT_WAIT_MS`): the daemon's `channel-beacon.json` (`lib/pairing-lock.ts`, touched about every 5 s while the channel delivers), which must have been written since the launch started, and not by the daemon the file named at launch within the first minute (a predecessor winding down). A launch without one is relaunched ONCE (`health-relaunch reason=no-channel-heartbeat`); the next launch without one is recorded as `no-channel-heartbeat` in launch-status with a console line, and left running, never relaunched again until a launch has sent a heartbeat. The check is cleared when claude ends first, and a launcher asked to stop relaunches and records nothing.
- **Unchanged:** a helper that logs `attached` then `accepted` (exit 0), and every other helper exit (2, 3, 4, 5): nothing is relaunched for them; a person's own `hoai` at a terminal (no relaunch, no heartbeat check); the gate helper's screen reading and its one Enter; macOS and Linux apart from the heartbeat check; the restart marker budget's own latch.

Guards: `test/hoai-core.gate-attach.test.ts` on a fake helper, fake claude, fake files and a fake clock: the 888 shape relaunches (with and without `--keep-alive`), the fourth in an hour is refused, an earlier launch's helper never ends the current claude, a person's hoai is left alone, exit 0 and every other exit change nothing; no heartbeat at 3 minutes relaunches once and then reports, a heartbeat in time does nothing, a stale or a predecessor's beacon is no heartbeat, a long-lived holder's is, a healthy launch earns the relaunch back, a dead launch is never judged; the helper's exit 6, `-ErrorAction Stop` and its one `exit 0`; the beacon name mirrors `lib/pairing-lock.ts`; the proof script's PASS. Also: a stop request racing the check, a heartbeat relaunch refused by the budget, the posix supervised (expect) relaunch, and `pluginStateDirFor` agreeing with the daemon's `resolveCursorFilePath`. `test/win32-gate-helper.console.test.ts` runs the real helper on Windows against a fake console: attached then accepted exits 0; with a reader holding the log all three lines still land and it exits 0 (0.69.6 recorded none and exited 0); with the log held exclusively it still presses Enter and exits 6 (0.69.6 exited 0). No version is published or tagged here.

## 0.69.6 (2026-10-16)

**On Windows, a browser stop no longer throws because Chrome still holds its runtime folder, so the cleanup after it runs (HOAI board row 717860f8).** Found by #242's Windows suite: a Chrome that never reported its DevTools endpoint was killed at the start timeout, and the `ChromiumEngine.stop()` after it threw `EPERM` removing the browser's runtime folder, so the caller's cleanup after the stop never ran.

- **Why.** On Windows a killed Chrome holds its `hoai-browser-runtime-*` folder until it and its helper processes have exited, which takes up to about a second. `launchChromium` killed Chrome at the timeout and rejected at once, and `stop()` removed the folder with a bare `rmSync`. The same `rmSync` runs in every stop, so in the browser host any stop that met a folder Chrome's helpers still held would throw: the pool then marks the browser as not closed safely, and that agent and person's browser refuses every later start until the host restarts, and a host stop (`pool.stopAll`) fails. (The pool itself never stops a browser whose start failed; the start timeout then stop sequence is a direct caller's, such as #242's test hooks.) Reproduced with a real Chrome 154 on Windows 11 that refused remote debugging: on 0.69.5 the stop threw `EPERM` and the folder stayed.
- **The fix.** On Windows a failed start waits, bounded at 3 s (`BROWSER_KILL_WAIT_MS`), for the Chrome it killed to exit before it rejects. A stop retries a folder Windows reports busy (`EPERM`, `EBUSY`, `EACCES`, `ENOTEMPTY`) every 100 ms for up to 2 s (`RUNTIME_DIR_RETRY_MS`). A folder still held after that is left in place and logged (`the browser's runtime folder <path> is still in use (EPERM); it is left for the next browser start to remove`), never thrown, and the host's next browser start removes it.
- **Unchanged:** macOS and Linux (no wait, no retry, a removal error still fails the stop as before), a stop whose folder is free (one removal, no wait), any other removal error (still thrown), the stop's other failures (`browser_stop_failed`, `credential_storage`), and every browser that starts. A runtime folder of a start that failed, which the pool never stops, is still not removed (as before).

Guards: `test/browser-runtime-folder.test.ts`, on a fake Chrome that holds its folder while it runs and briefly after it exits, as Windows does: a timed-out start rejects only after the killed Chrome exited, and still rejects within the bound when it never does; `stop()` after a start timeout resolves, removes the folder and lets the cleanup after it run; a folder still busy after the retry is logged and left, and the next start removes it; a stop on a clean exit is one removal with no wait; macOS and Linux behave as before. No version is published or tagged here.

## 0.69.5 (2026-10-16)

**Every per-agent service is named after the HOME it was installed from, so a daemon or watcher in a scratch or second HOME holding the same agent's credentials can never re-register, start, stop or remove the owner's real agent (HOAI board row d6198bb6, mission 154 goal 8).** 0.69.2 scoped the per-machine watcher's service (#237); the agents' services were still named by agent id alone.

- **Why.** The agent's files were HOME scoped, its names were not: the Scheduled Task `HOAI Agent <id>` belongs to the Windows user, the label `ai.bgos.agent.<id>` to the one `gui/<uid>` domain, the unit `bgos-agent-<id>` to the one user manager and the tmux socket `hoai-<id>` to the one socket directory. Every act addressed that name: `Register-ScheduledTask -Force`, `schtasks /Run`, `Unregister-ScheduledTask` (the watcher's sweep, create_agent, the restart ladder, the daemon's restart handoff), `launchctl bootout` by a scratch plist that carries the owner's label (install, start, restart, update), `launchctl bootout` and `systemctl --user stop` by name (uninstall), `launchctl kickstart -k` and `systemctl --user restart` (the watcher's restarts), and `tmux -L hoai-<id> kill-server` (uninstall, and every run.sh start). The Windows launcher pinned no HOME either, so a task registered from a scratch HOME ran hoai against the logon profile's real credentials.
- **The fix.** The names carry #237's `home-<id>` (`watcherHomeId`): `HOAI Agent <id> home-<id>`, `ai.bgos.agent.<id>.home-<id>`, `bgos-agent-<id>-home-<id>`, tmux `hoai-<id>-home-<id>` (`lib/agent-inventory.mjs` `agentServiceNames`, and the same names in `bin/bgos-agent`). On macOS and Linux the id is taken from the HOME's real path (`realHome`, `agentHomeId`), and a registration is judged this HOME's by real path too, so a HOME spelled through a symlink (`/Users/fitecho` to `/Users/bgos`) is one HOME with one service, never two; the watcher's own id is unchanged (#237's, from the HOME as spelled), so the two differ only for such a HOME. The registration records its HOME and agent id: the task description `HOAI agent <id>, installed from home=<HOME>`, its action's launcher path and a launcher that pins `USERPROFILE`; the plist's path, `HOME` and `run.sh`; the unit's `HOME` and `run.sh`. Every act reads it back first with #237's reader and judge (`readProbe`, now told what a registration records, and `classifyRegistration`; `lib/agent-service.mjs`): the task script's new `probe` and `probe-legacy` actions, `launchctl print`, `systemctl --user show` and the unit file the manager loaded. Only a record that names THIS agent counts. A registration under this HOME's own name that records another HOME, or none readable, is refused and left exactly as it is: by the Windows install, start and uninstall (`lib/agent-task-win32.mjs`; Windows has no agent task removal yet, so `uninstallAgentTask` has no caller), by the restart ladder's task and service tiers (`lib/agent-restart.mjs`), and by `hoai-agent install`, `start`, `stop`, `restart`, `update`, `status` and `uninstall` (`bin/bgos-agent`, through `bin/hoai-agent-service.mjs` on bun or node; without either it refuses to act by name). A refused uninstall removes nothing (exit 1), and so does one whose own read-back fails or that cannot compute the HOME id: removing the files of a job it cannot stop would leave the agent running while it says it was removed.
- **A read that fails is unknown, never absent.** The task script asks `Get-ScheduledTask -ErrorAction Stop`: only `ObjectNotFound` is "task absent"; access denied, a broken Task Scheduler service or a timeout print `probe failed` and exit 2, read as unknown. An old task that cannot be read blocks any registration under the new name while this HOME has none (it may be this HOME's, and a second logon task on one launcher would start the agent twice).
- **Existing agents (0.69.4 and earlier).** Windows: the watcher's sweep reads each agent's task back once. This HOME's old `HOAI Agent <id>` is renamed in place, #237's order: the new task registered first (a logon trigger, it starts nothing), then the old one retired; a failed retire unregisters the new one again and reads it back to say what is really registered. The running agent is never stopped or started, provided `Unregister-ScheduledTask` leaves the old task's running instance alone (not verified), and a task its owner disabled is registered disabled. When the old name holds ANOTHER HOME's task (an older rig took it) or neither name is registered, this HOME's own task is registered beside it, enabled and not started, and the foreign one is left alone and said, with the fact that, unless it is disabled, it still starts at logon (in the logon profile, when its launcher pins no HOME). The agent counts as checked only once a read-back proves this HOME's own task registered; anything else is tried again after an hour. macOS and Linux: the agent keeps its old name until the next `hoai-agent install` from the same HOME (by hand, the daemon's reconcile or the watcher's upgrade), which renames it. macOS loads the NEW job first: it parks this HOME's old plist in the agent's state dir, bootstraps the new job and reads it back, and only then boots the old one out and waits until launchd no longer lists it, then ends its old tmux server. An installer typed into the old job's own session dies at that bootout and leaves the agent supervised under its new name and one plist; the two jobs are loaded together only until the old one is gone (or, when it will not go, until the new one is booted out again; should that fail too, both stay loaded, the install says so, and only the old plist loads at the next login), and the new one never runs claude beside the old one (run.sh's singleton wait holds it until the old claude has left the folder). A `launchctl print` that fails with anything but rc 113, or a "Could not find service" answer (no such job), is unknown, never gone; while no read answers, a bootout launchd accepted counts as gone, and a plist launchd took again as loaded. A new job that does not load is removed and the old one stays loaded. When the old one will not go, or cannot be read back, the new one is booted out again and the old plist put back; unless launchd still lists the old job after a bounded watch, its own plist is bootstrapped again on its own run.sh (launchd refuses a second bootstrap of a label it has), and one that still cannot be read back is said to be possibly not loaded. A new job that cannot be booted out again, or read back, counts as possibly loaded, and the old one is then never loaded again beside it. Linux writes a `Conflicts=`/`After=` drop-in, enables the new unit, disables the old one and makes ONE `systemctl --user start` of the new unit stop the old one and start the new one as a single manager job, so an installer inside the old unit's cgroup cannot leave the agent down; a failed step enables and starts the old unit again and removes the new unit file. A rolled back rename puts the previous `run.sh` back (it is now written beside and moved into place, never rewritten under a running job). This HOME's old plist or unit file is removed whoever holds the old name now (another HOME's loaded job is not touched), so the next login never loads two, also when `plutil` rewrote it in XML (a binary plist is not read, and so never removed on a guess); an install whose old job or unit cannot be read back while this HOME's old service file is there is refused (it might be this HOME's). An old name is never loaded anew: `hoai-agent start` or `restart` with only this HOME's old file and nothing loaded says to run `install`, which renames it. Until the rename, the old name is still found and supervised (the inventory, the restart tiers, the daemon's own canonical tier, the always-on reconcile and the tmux matchers accept it when it is this HOME's).
- **Leftovers of an older agent.** An install ends a tmux server from before 0.69.5 orphaned on the old socket `hoai-<id>` when one of its panes runs in this agent's folder (it would hold the new job's singleton wait for good); one elsewhere is another agent's and is left. A rename drop-in an interrupted swap left behind is removed by the next install.
- **Linux: a HOME the user manager does not read is refused.** The `systemd --user` manager reads units only from its own HOME (`systemctl --user show-environment`); an install from another HOME (a scratch HOME on the same account) is refused by name before its service file or run.sh is written, instead of failing every 15 minutes with a generic error.
- **Another HOME's old registration is left alone and said:** in the watcher log (`keep-alive <id>: left the Scheduled Task "HOAI Agent <id>" alone: it was installed from another HOME (...)`; never how to remove it, since the reader may be a scratch HOME looking at the owner's real task), by `hoai-agent` (`service note: ...`), in the daemon log (`always-on: ...`; a refusal once per refusal, not every 15 minutes), and in `hoai-watcher status` (a line per Windows agent task, `agents[].task` in `--json`) and `hoai-agent status` (the listing marks each job this HOME, another HOME or old name).
- **Bounded.** Every read-back has a time limit (the restart ladder's, the sweep's, `hoai-watcher status`'s and `bin/hoai-agent-service.mjs`'s): a probe that hangs is unreadable, refused, never a sweep or a `hoai-agent` held for good; a timed out command says so. A task start refused before `schtasks /Run` ran spends none of the episode's three starts.
- **Unchanged:** an explicit install (create_agent, the sweep's install of an agent with no task) registers the task enabled and starts it when asked, as before; the task's settings and the launcher's launch apart from the name, its description and the `USERPROFILE` pin; the plist and unit contents apart from the label or unit name and run.sh's baked tmux socket; supervisor generation 2; the restart ladder's tiers and limits; a HOME with no old registration installs exactly as before. Agent names still carry no `HOAI_SERVICE_NAMESPACE`.

Guards: `test/agent-task-win32.home-scope.test.ts` (a faked Task Scheduler for agent tasks, `test/helpers/fake-agent-tasks.ts`, which answers a failed query the way the generated script does), `test/agent-service.home-scope.test.ts` (#237's faked launchd domain and user manager; a symlinked HOME on the host) and `test/bgos-agent.home-scope.test.ts` (bin/bgos-agent run for real on a faked launchd domain, user manager and tmux shared by two HOMEs, `test/helpers/fake-posix-services.mjs`): two HOMEs with the same agent id side by side, a scratch HOME against the owner's 0.69.2 agent (install, start, stop, restart, status, uninstall, the watcher's sweep and the restart ladder), the same-HOME rename (Windows and Linux with no moment without a registration and never two at once; macOS with the new job loaded before the old one goes, from inside the old job's own session too), a foreign or missing old task on Windows, a failed query or `launchctl print`, a symlinked HOME, the rollbacks and the run.sh they put back, a Disabled task kept disabled, refusal of another HOME's record, uninstall of only its own and a blind uninstall refused, the watcher supervising a renamed agent and one not renamed yet; on Windows, PowerShell 5.1 parses the generated task script (parse only). No version is published or tagged here.

## 0.69.4 (2026-10-16)

**A backend refusal reaches the model whole, and the MCP server reports the real plugin version (HOAI board row 81a68f4).** A share recipient's 403 mission refusal reached the model as "...works in that person's chat ins", and the MCP `serverInfo` said 0.19.0 while package.json said 0.69.x.

- **Why.** Every REST helper in `server.ts` threw `text.slice(0, 200)` of the error body, so any backend sentence longer than 200 characters was cut mid-word. The `Server` was built with the literal `{ name: 'bgos', version: '0.19.0' }`, never moved.
- **The fix.** One helper, `errorBodyText` (`lib/error-body.ts`), used by every error site (GET, POST, PUT, PATCH, DELETE, and the peer GET, POST, DELETE). When the body is JSON with a `message` (the NestJS `{message, error, statusCode}` shape), the message is surfaced whole, bounded at 600 characters; a string-array message (validation failures) is joined with `; `. The status code stays in front (`POST 403: ...`). A body that is not JSON, or has no usable message, keeps the old 200 character bound. `HttpError.body` and the peer refusal reader are unchanged. `mcpServerInfo` (`lib/mcp-server-info.ts`) builds `serverInfo` from `RUNNING_VERSION`, the package version the heartbeat reads (`readOwnVersion`).
- **Unchanged:** the status codes, the error classes, what is retried, and every success path.

Guards: `test/error-body.test.ts` (the real 403 sentence whole, a string-array message joined, an over-long message and a non-JSON or huge body bounded, no `slice(0, 200)` left in `server.ts`, `serverInfo` equal to package.json). No version is published or tagged here.

## 0.69.3 (2026-10-15)

**On a busy Windows PC a slow look for the agent's own claude no longer refuses every browser call for 10 minutes (HOAI board row 7046de2a, mission 154 goal 10).** Seen during the BGOS #2432 download ask proof on AlienAres under normal worker load.

- **Why.** The signed browser context names the claude the daemon serves, and is live only with that pid (`lib/private-turn.mjs` `publishPrivateContext`); the managed browser shim refuses every call while it is not live (`bin/hoai-browser-mcp.mjs` `readManagedContext`, `acting_context_unavailable`). On Windows the daemon finds that pid with one PowerShell call (`lib/agent-state.ts` `win32AncestryCommand`) that ran one `Get-CimInstance Win32_Process -Filter` per parent link, all the way up to wininit. A filtered query costs as much as a full one (each link added about 0.5 s on a busy PC), so on AlienAres the nine links took 4.0 s to 6.3 s (median 4.9 s, 4 of 10 runs over) against `defaultExecSync`'s 5 s cap (`lib/service-supervision.mjs`). A probe killed at the cap read as "no claude", and `memoizeUntilFound` held that miss for `CLAUDE_ANCESTOR_RETRY_MS`, 10 minutes (`server.ts`).
- **The fix.** The script makes one `Get-CimInstance` of the process table and walks the parents in PowerShell, printing the same chain: 1.1 s to 1.4 s on the same PC for the same nine links (median 1.2 s). A CIM error now stops the script (`-ErrorAction Stop`), and a chain that does not hold the daemon's own pid is no reading. A probe that could not be read (timed out, non-zero exit, output cut short or without the daemon, could not start) is now `readable: false` (`readClaudeAncestorWin32`, `readClaudeAncestor`), and `memoizeAncestorReading` retries it after 30 s, doubling while it keeps failing, never held past 10 minutes.
- **Unchanged:** a found claude is kept for the daemon's life; a chain that was read and holds no claude (a reused parent pid included) is still held 10 minutes, and the browser context is still not live, so its calls are still refused; macOS and Linux read through `ps` exactly as before, every answer held as before.

Guards: `test/agent-state.ancestor-probe.test.ts` on a faked PowerShell with this PC's measured costs (no real process listing): a slow probe over the cap, a timeout followed by a good answer, a real absence still refused, the cached answers expiring, and the server wiring. No version is published or tagged here.

## 0.69.2 (2026-10-15)

**The watcher's OS service is named after the HOME it was installed from, so a second install on the same computer, a test rig's scratch HOME among them, can never replace or stop the owner's watcher (board row dfafdfb6, mission 151 goal 8).** BGOS #2432: a rig backend asked a scratch HOME daemon on v0.69.0 to install the watcher on the owner's own computer; only the rig's 409 from enroll stopped it before `Register-ScheduledTask -TaskName 'HOAI Watcher' -Force` pointed the owner's task at the scratch bundle.

- **Why.** The watcher's files were HOME scoped, its names were not: the Scheduled Task `HOAI Watcher` and the Run value `HOAIWatcher` belong to the Windows user, the label `ai.bgos.watcher` to the one `gui/<uid>` domain, the unit `bgos-watcher` to the one user manager. Every install, start, stop and uninstall addressed them by that fixed name (`Register-ScheduledTask -Force`, `Stop-ScheduledTask`, `Unregister-ScheduledTask`, `launchctl bootout`, `systemctl --user enable --now`, `restart`, `disable --now`). The Windows launcher pinned no HOME either, so a task installed from a scratch HOME ran against the logon profile's real credentials and agents; and uninstall ran whatever `install-task.ps1` an older install had left, with the old name in it.
- **The fix** (`lib/watcher-service.mjs`). Every name carries `home-<id>`, the first 8 hex characters of the SHA-256 of the normalized HOME (`watcherHomeId`, `canonicalHome`: trimmed, `.` and `..` resolved, no trailing separator, and on Windows backslashes and lower case): `HOAI Watcher home-<id>`, `HOAIWatcher-home-<id>`, `ai.bgos.watcher.home-<id>`, `bgos-watcher-home-<id>`, composing with `HOAI_SERVICE_NAMESPACE` as `HOAI Watcher (<ns>) home-<id>` (a namespace never holds the `-`, so no scoped name can equal an old one). The registration records its HOME: the task description (`HOAI per-machine watcher, installed from home=<HOME>`), the launcher, which now sets `USERPROFILE` to it before node starts, the plist's and the unit's `HOME`. Before acting, install, status and uninstall read that record back through the injected exec (`probe`: the task script's new `probe` actions, base64 so a non-ASCII HOME survives the console code page; `launchctl print`; `systemctl --user show`) and judge it (`readProbe`, `classifyRegistration`): this HOME's only when every HOME it records is this one. A registration under this HOME's own name that records another HOME, or none that can be read, is refused and left exactly as it is. Install and uninstall rewrite the task script before running it, so a stale one never runs.
- **Existing installs (0.69.x).** The watcher keeps running under its old name until the next watcher install from the same HOME (the app's "Set up the watcher", or `hoai-watcher install`), which renames it in place and never runs two watchers of one HOME at once. Windows: the new task is registered, the old Run value and task are retired, then the watcher restarts under the new name; a failed retire unregisters the new task again. Linux: the new unit is enabled with a temporary drop-in (`<unit>.service.d/hoai-rename.conf`, `Conflicts=` and `After=` the old unit), the old unit is disabled, and one `systemctl --user start` of the new unit makes the user manager stop the old one and start the new one as a single job: the daemon of an agent the watcher started on the recipe tier lives in the old unit's cgroup and dies when it stops, and the manager still finishes the job (review finding C1; stopping the old unit from the installer first would have left no watcher until reboot); a failed step enables and starts the old unit again. Windows and Linux are never without a registration. macOS, where a bootstrap also starts the job: the old job is booted out, the install waits until launchd no longer lists it (`LAUNCHD_UNLOAD_WAIT`; bootout returns before the job has unloaded), then bootstraps the new one, and when that fails bootstraps the old one again and removes the new plist, so the next login loads one. The old plist or unit file of that HOME is removed so it cannot load again at the next login. An old registration that another HOME installed is left alone and reported: in the daemon log (`watcher_install_rpc: left the Scheduled Task "HOAI Watcher" alone: it was installed from another HOME (...)`), by `hoai-watcher install` and `uninstall`, and in `hoai-watcher status` (`service.legacy`); on Windows the note adds, when that task's launcher pins no HOME (0.69.x launchers), that it serves the logon user's profile and how to remove it if it is not wanted.
- **Uninstall and status.** A registration under this HOME's own name that records another HOME is refused by uninstall too (exit 1, no purge). One whose record cannot be read (a user manager that does not answer) is not unregistered by name, but this HOME's own files are still removed and `--purge` still runs. Status reports a same-HOME old registration as this HOME's until it is renamed, never another HOME's, and never creates a bundle folder.
- **Also:** a systemd `Environment=` assignment that holds whitespace is quoted (systemd split `HOME=/home/k c` at the space), and a unit's HOME is read from the unit file the manager loaded.
- **Unchanged:** the service files and their contents apart from the name, the launcher's `USERPROFILE` line, the task description and that quoting; the install, start, stop and status ladders of a HOME with no old registration; the launchd bootstrap retry; the bundle, credentials and the RPC's steps.

Guards: `test/watcher-service.home-scope.test.ts` on `test/helpers/fake-service-host.ts`, a faked Task Scheduler and Run key, launchd domain and systemd `--user` manager driven only by the commands the code emits (it reads the task script from disk at the moment it runs, models an installer killed with the old unit's cgroup, a bootout that returns before the job has unloaded, and systemd's own splitting of `Environment=`): two HOMEs side by side, a scratch HOME against the owner's 0.69.x registration on all three platforms (install, status, uninstall), the same-HOME rename with no moment without a registration and never two watchers, the rollbacks, refusal of another HOME's record, uninstall of only its own, the CLI with a stale task script, the probe parsers; on Windows, PowerShell 5.1 parses every generated task script (parse only). Every one of them was red on 0.69.0, and so was the daemon log test in `test/watcher-install.test.ts`. No version is published or tagged here.

**An agent's browser profile on a Windows drive where the user has Modify but not Full control is no longer refused without a reason (HOAI board row 221ec9db, mission 151 goal 9).** The vault makes the profile folder private by setting its owner to the user and writing an access list with one entry, the user's own Full control. Setting the owner needs WRITE_OWNER, which Modify alone does not give, not even to the folder's owner. So on such a drive (E: on a PC that grants users Modify) every profile was refused as `unsafe_profile`, the PowerShell error was thrown away, and nothing said why (found in BGOS #2432).

- **A folder that is already the user's own and that no other account can write is accepted without SetOwner.** The vault writes it the same access list (an owner may always write that list), reads it back, and accepts it only when it is owned by the user, protected, and holds that one entry. The allow-list is the vault's own, the user alone: SYSTEM and Administrators count as other accounts, since the access list the vault writes has no entry for them either. Any allow entry for another account with a bit beyond read, list and traverse counts as write, inherit-only entries and the entry types .NET's GetAccessRules leaves out included; deny entries do not. A folder whose owner the vault can set (Full control) goes through the same steps as before.
- **Every other folder is still refused, and the refusal says why.** `unsafe_profile` now carries a `reason`: `owner_foreign` (another account owns the folder, or on macOS and Linux a folder above it), `other_writer` (another account can write to it, or to a folder above it on macOS and Linux), `owner_not_set` (the owner could not be set and the folder could not be checked), `not_private` (the lock did not read back as the user's alone), `acl_step_failed` (PowerShell did not finish) or `alias` (a link, not a plain folder). The agent's answer, where `unsafe_profile` was reported before, now reads `tool_error: unsafe_profile: ` and a fixed sentence per reason saying what is wrong and what to do, with no path, account or Windows error in it. The browser host log names the folder, the accounts and the Windows error. The macOS and Linux refusals carry the same reasons. The owner pane's credential errors keep their fixed `credential_storage` code and message.
- **A folder path with a letter outside ASCII reaches Windows intact.** PowerShell reads its script from stdin in the console code page, so a path such as `C:\Users\José\...` arrived garbled and every profile under it was refused, with Full control too. The path now goes to PowerShell as UTF-16 in base64 (which also leaves nothing to quote), so such a folder is treated like any other (found in review).
- **On a drive like this PC's E: a fresh profile is still refused**, now as `other_writer`, naming Authenticated Users, SYSTEM and Administrators: the folder inherits write for them. The owner can give the agent's account Full control of the agent's folder (the vault then takes the folder over as before) or make the folder private to that account.

Guards: `test/agent-browser-vault.test.ts`: the Windows step with a fake PowerShell on every platform, the same cases with real access lists (icacls) on Windows, and the agent's answer and the host log.

## 0.69.1 (2026-10-15)

**The agent's browser cards read right (mission 150 goal 12, the wording step 8 of BGOS #2432 failed on).** Three causes, each fixed where the text is built:

- **The cards name the agent.** The browser host dropped the relay frame's `assistantName` (`bin/hoai-browser-host.mjs`, `RelaySessions.relay`), so every card and every download record said "Your agent". The session context now carries it (`assistantNameOrNull`). A kept file's notice whose record has no name (one written before this fix) sends no name, and the backend names the agent from its own record rather than "Your agent"; inside a summary the fallback reads "your agent", never capitalised mid sentence.
- **Every verb reads after "wants to".** The host passed the trail's past tense as the card summary ("Sage wants to opened ...", "wants to clicked ..."). It now passes `policy.intentPhrase`, the imperative the desktop's gate strip prints. `lib/browser-host-core/policy.js` is re-vendored from BGOS (the gate words of every tool that can ask: drag, drop, close, highlight, annotate, the mouse tools, one form field); `vendor.json` carries the new hash.
- **A download card carries its facts.** The ask and the kept notice now send `download` beside the English summary (`stage`, `fileName`, `folder`, `device`, and `keepsIfUnanswered` on an ask or `reason` on a notice; `lib/browser-gate.mjs` forwards it). The app (BGOS, same mission) words the card from them in the owner's language and says in its last line that an unanswered file is kept, not skipped. A backend that predates the field strips it and the card reads as before.

Guards: `test/hoai-browser-host.card-wording.test.ts` (the name through the relay; every verb the host can ask about) and the three download card tests in `test/browser-downloads.test.ts`. No version is published or tagged here.

## 0.69.0 (2026-10-15)

One release carrying four pull requests: the agent can save an email as a draft and send one only on its owner's own instruction (#228, written as 0.68.5); the plugin's second copy of a channel stands aside when the session already runs the checkout (#231, written as 0.68.5); two deliveries submitted together open their private turn (#232, written as 0.68.7); and shared agents Phase 0, the plugin half (#233). Where they meet, found merging them:

- **`email_send` reads every prompt admitted for its turn (#228 with #232).** #232 found that deliveries submitted together reach the daemon as separate prompts of one turn, keeps every prompt of one session, sender and chat admitted together, and adopts the turn on whichever of them the marker names. Two #228 rules now cover the whole of that list (`lib/private-turn.mjs`): a refusal decided for one admitted prompt (a scheduler state report beside a wake, say) still refuses `email_send` when another is admitted after it; and the look back starts at the earliest admitted prompt, not at the one the turn was adopted on, so a delivery between two admitted prompts (an email, a peer, a meeting line) refuses, and so does a wake delivered after the prompt the turn was adopted on; the admitted prompts up to that one are the turn's own and are passed over, as #228 alone passes over a prompt admitted before the last. Before the review's fix, owner A, an email and owner B submitted together, their lines landing email, B, A, sent naming B, where #228 alone opened no turn. Both rules can only refuse more. Guard: `test/private-turn-email-batch.test.ts`.
- **A held `email_send` card follows the owner's chat rules (#228 with #233).** It still goes only to a main chat, the owner's turn chat first, and now also skips every chat that refused a card with the backend's 403 and every chat known to be a share recipient's, the owner's own main chats first (`emailSendCardChat` reads the chat ownership, as `pickPermissionChat` does). #233's 403 retry now hands on the floor hook's record, so a retried card still binds the exact email instead of letting the send through with no card. And by Data's ruling (2026-10-15), fail closed: when no main chat of the owner can take the card (none is usable, or the inbox names no chat kinds), it is posted nowhere, never at the default pick and never at the turn chat, since either can be a group and the card carries the whole email. The call is refused and the agent hears why (`EMAIL_SEND_NO_OWNER_CHAT`, `lib/agent-email-tools.ts`): nothing is sent and nothing is saved. The CLI's permission verdict carries no text, so the relay marks the call before the CLI hears it and the `email_send` step refuses it. Guard: `test/permission-card-email-send.test.ts`, and the "Data 2026-10-15" tests in `test/agent-email-send.test.ts`.

Not closed here, for a separate gate decision: a delivery that admits nobody (an email, a peer agent) empties the admitted list, and a share recipient's message replaces it, so when one is submitted in the same turn and its line lands just BEFORE the owner's prompt, the owner's prompt is admitted alone and `email_send` names it. That includes owner A, an email and owner B with their lines landing in order: the turn is adopted on B with nothing admitted beside it, and it sends. The tracker cannot tell that from a new turn whose Stop line has not arrived, and #228's own test pins the second reading (`test/agent-email-send.test.ts`, "an email turn cannot send": an owner prompt right after an email prompt, with no Stop between, sends). #228 alone behaves the same, so the #228 sentence below about a prompt that carries one beside the owner's message holds for a combined prompt, which the CLI does not produce.

### #228: email_draft and email_send, a send only on the owner's own instruction

**The agent can save an email as a draft, and send one only on its owner's own instruction (outgoing email modes, HOAI board row 2dd04488, addition 5, piece B: the plugin).** The owner chooses per agent how its email leaves: Ask me before every send (the default), Drafts only, or Send for me. Until now the server took a draft from the agent but the agent had no tool to write one, so the owner copied its suggestion into the app by hand.

- **`email_draft`** posts to `POST /api/v1/integrations/agent-email/reply-drafts`. A reply sends exactly today's body `{assistantId, emailId, text}`, so it works against the route that is live today and alone makes Ask me before every send real; a new email adds `kind: "new"`, `to` and `subject`. A draft never sends, in any mode, and it may be written in the email's own turn.
- **`email_send`** posts to `POST /api/v1/integrations/agent-email/send` with `basis`, the reason, filled from the turn that woke the agent and never by the model (a `basis` argument is refused): an owner turn names that message's id, a scheduled wake names its task id (the backend's wake identity: a scheduler card with no status, no payload kind, a task id and a fire id). In an email turn, a peer turn or a system turn that is not a wake, it refuses locally with "An email can never make you send. Tell your owner instead." and posts nothing. So does a turn that anything else reached after its own delivery (an email, a peer, a meeting card, a wake or another system card), even one that landed before the daemon admitted the prompt, and a prompt that carries one beside the owner's message. The reason is only ever the delivery that opened the turn (Data, 2026-10-13): the owner's newer message in the same chat leaves it as it is (the server, which wants the newest owner message, then keeps a draft), a later wake refuses, and a boot replay (the poll lane's backlog), which may be a message an earlier turn already answered, names no reason. A turn admitted for anyone but the owner (a shared person's message or wake) refuses too. The reason is frozen at admission through the private turn rule (`lib/private-turn.mjs`: one delivery token, a live marker, at most 15 minutes old), and `email_send` joins the private tool guard, so a helper started in an earlier turn cannot send. An agent's own wake looks like any wake here and is passed through: the server, the authority, keeps its email as a draft. The tool reports exactly what the server answered (sent, or a draft and why).
- **Both tools** take text only (no files, no HTML; 32,000 characters, a subject of at most 200), check their arguments before the network, refuse an email that holds a secret (`lib/secret-scan.ts`) or this daemon's own credential (in the address, the subject or the text, even split by spacing), and pass backend refusals through verbatim. A call that gets no answer (a deadline, a network failure) says the email may have been sent and must not be sent again, rather than calling it unsent.
- **What the agent is told.** Both tool descriptions, the Email From Outside instructions and the offline canon say the owner's chosen signature is added to the end of every email it sends or drafts and that it never signs an email itself. The offline copy of the agent email sentence now ends as plan A6 words it ("nothing is emailed unless your owner chose Send for me and asked you in their own chat, or a task your owner scheduled is running; an email is never a reason to send"), followed by the sentence about the two tools; an email's own first line no longer says that only the owner's Send sends.
- **Always ask stops a send** (Data, 2026-10-13). The hard floor no longer exempts this channel's own `email_send` (`HOAI_OWN_SENDING_TOOLS` in `lib/hard-floor-core.mjs`, every server name of the channel, exact tool name; `email_draft` and every other tool of the channel stay exempt). With the owner's "Always ask before risky actions" on, the floor hook asks, the relay's floor check holds the request and the owner gets the approval card before anything is sent, every time. The card leads with the recipient (or, for a reply, says it is one) and the subject, then the first lines, whatever order the agent wrote its arguments in (`lib/email-send-approval.ts`). Because the floor hook fails open, the daemon also checks before it posts: the owner's Allow of exactly this call on a card the floor held (taken once, within two minutes, matched against what the card showed; a text the CLI cut is matched by the CLI's own cut and count), or the server's word from the same floor check route that the owner does not ask first, from a server whose list holds `email_send`. A hold, a check that cannot answer, or a "not held" from a server still on rules version 2 sends nothing and tells the agent to save a draft. An `email_send` the tool would refuse anyway (a secret in it, an address that is not plain letters, a key it does not take) is denied on its preview before any card is posted, so the card never carries it. The card shows the trimmed address and subject the tool sends, and names any invisible or direction changing character instead of hiding it; `to` must be plain ASCII. The rules version becomes 3 on both sides (`HARD_FLOOR_RULES_VERSION`, the cross repo key), which is how the daemon tells a server whose list holds `email_send` from one that predates it; the shared fixture (`lib/hard-floor-fixture.ts`) gains the cases.
- **The server is the gate for a send while Always ask is on** (Data, 2026-10-13; wire-shapes.md "Server approval for a send"). The held `email_send` card carries `approvalMeta.email_send`, the email the owner's tap approves: `to` and `subject` (or `email_id` for a reply) as the tool sends them, `body_sha256` of the exact text and `text_preview`, its raw start of at most 1000 characters (`lib/email-send-binding.mjs`). The floor hook, which sees the whole input, writes that binding into its record (the CLI's preview folds and cuts the text), paired to its own request by a probe of the text; the relay uses it only when the probe and the address, subject or email agree, else the binding of an uncut preview, else none, and the server then makes the card deny only. An email the tool would refuse reaches no card. The card goes to the chat of the owner's turn, the only one that can carry an Allow. The owner's Allow once tap issues an approval `{id, expiresAt}` that rides on the answer the daemon already reads (the poll row, the stream's buttons answered row and the card read; the daemon keeps its single tap path and adds no `inbound_click` listener), or comes from `GET /api/v1/integrations/agent-email/send-approvals/:requestId`, once, when the daemon missed it. `email_send` passes it as `approval: {id}`, one approval for one send, never invented or reused. A draft answer with `approval_required` tells the agent plainly the email was kept as a draft for the owner. The daemon check stays as the backstop. After review: an email record pairs by the letters of every script and by its start agreeing with the request's, so a long Arabic email binds and two emails that only share their ends never swap; an Allow is claimed only by the call whose card the owner allowed, and its approval only by the call its binding names to the byte (otherwise the send goes without one and the server keeps a draft); a refused request takes its record with it; the card goes to a main chat, never a group; with auto approve off the floor still decides a held `email_send`; and an id is a uuid as the server reads one. Wire shapes v6 (#2326): the block carries the exact body as `text`, taken only from the hook's record and never from the CLI's folded or cut preview (with no exact body the card goes without a block and offers deny only); `body_sha256` and `text_preview` stay, well formed, though the server now ignores them and builds the owner's preview itself; the tool's secret check runs over the whole body before any card. Wire shapes v7: a body longer than a card shows (1000 characters) can never be approved on a card, so no card is posted for it; the send goes to the server, which keeps it as a draft while the owner asks before every send, and the agent is told plainly it was kept as a draft because it is too long to approve on a card, not to try again; the same body again saves no second draft. Data's security review F6: the stream and socket lanes give a message sent before the daemon started no reason to send, the poll lane's backlog rule (`sentBeforeStart`).
- **Wire shapes v7 (backend #2326 at `d8fbaf5d7`, Data's review F1 to F5).** The three agent email routes (the send, the drafts and the approval pull) now carry `X-Caller-Assistant-Id`: the agent this daemon runs as, the same id as the body's `assistantId`, never anything the tool call carries (`agentEmailCallerHeaders`); a call that names an agent is refused before the network, as any key the tool does not take. The server's `too_long_to_approve` is read by its name, and the agent hears the email waits as a draft in the Email chat and not to try again; no other reason is read as too long any more, and only the very email the server kept (its recipient, subject or email, and text) is "already waiting". With no hook record, a held `email_send` whose preview already shows more than 1000 characters gets no card either (a preview, without the CLI's cut line, is never longer than its body). While the owner does not ask before every send, a send the server keeps as `approval_required` (a reason it holds no record of) waits on no card and no pull, and the agent hears plainly that it waits as a draft in the Email chat, never that the owner approves every email; only the floor check's "not held" from rules version 3 or more counts as the owner not asking first. A control character other than tab, line feed and carriage return in the text or the subject, or a subject on two lines, is refused before the network, and the card's binding refuses it too; so is a lone surrogate.
- **A held send with no floor hook record gets no card** (Data, 2026-10-14 06:43Z). A card without the exact body could only ever be denied, so none is posted for any held `email_send` whose floor hook record is missing or names another email, short or long: the send goes to the server with no approval, the server keeps it as a draft (whose card shows the whole text and is where the owner acts), and the agent hears plainly that it waits as a draft in the Email chat. A held send with its record still gets its approvable card.
- **`email_send`** is declared on the heartbeat and the canon fetch, on every host and connection, only while `shipsEmailTools()` holds: both tools listed, each telling the signature rule.

For the backend: the canon's `AGENT_EMAIL_SEND_SENTENCE` and the mode neutral ending of `AGENT_EMAIL_SENTENCE` must match this plugin's offline copy word for word (`lib/agent-email-tools.ts`, `lib/capabilities.ts`; `test/agent-email-send.test.ts` pins both). The server's hard floor must list the channel's own `email_send` the same way, and the fixture must be copied byte for byte (wire-shapes.md, "Always ask stops a send (Data 2026-10-13)"); until it does, the server's floor check does not hold `email_send` and Always ask does not stop it. The tool also explains the new held reason `email_off` (wire shapes v2: the owner turned the agent's email off). Guards: `test/agent-email-send.test.ts` (the tool call run out of `server.ts` against a fake backend), the lane checks in `test/external-email-label.test.ts`, and the capability and hook matcher pins. No version is published or tagged here.

### #231: the plugin's second copy stands aside when the session already runs the checkout

**The plugin's second copy of a channel stands aside when the session already runs the checkout (kc-server, 2026-10-13; agents 863, 867, 871, 872, 873, 876).** An agent whose folder registers the checkout as the `bgos` server in `.mcp.json` (launched with `--dangerously-load-development-channels server:bgos`) and whose user settings also enable the marketplace plugin started TWO daemons for one pairing. The lock logic was right (the checkout proves its channel loaded and holds the lock; the plugin copy proves it is not and stays passive), but passive is not silent: the session also listed the plugin's tools (`mcp__plugin_hoai_bgos__*`), the model picked them, and a private tool (`schedule`, `boards_*`) answered "does not hold the active agent connection". The copy also raced for the lock at every boot and filed a stand down report each time.

- **The plugin copy serves a one tool notice, `hoai_duplicate_copy`, instead of a second daemon** when ALL of these hold: it is the marketplace install; its own channel spec is not on the session's claude command line while `server:bgos` is; and the launch folder's `.mcp.json` registers a `bgos` server whose `server.ts` exists in another checkout. It takes no pairing lock, writes no supervisor record or plugin state, starts no poll and declares no `claude/channel` capability, so the checkout stays the only channel the session can push into. Any doubt (no claude ancestor, a command line it cannot read, Windows, no `.mcp.json`, a sibling whose `server.ts` is gone, both specs listed) keeps the daemon exactly as before.
- Takes effect for a session's NEXT start, and only once the plugin copy in the cache is this version or newer: the check lives in the copy's own code. Nothing changes in a running agent.
- Not changed: the private turn gate. A button click does not carry the sender's authority (its card has no delivery token), so a private tool called inside a click turn is refused as before; a typed message opens the turn.

Guards: `test/duplicate-copy.test.ts` (the decision table, the notice over a real in-memory MCP client, the process table probe, server.ts ordering) and `test/duplicate-copy.e2e.test.ts`, which boots the real `server.ts` as the cache copy under a stand-in `claude` and reads what it answers.

### #232: two deliveries submitted together open their private turn

**Two deliveries submitted together open their private turn.** Mark, agent 888 on 0.68.4 (2026-10-14 08:00:15Z): wakes 1460 and 1658 fired in the same second, both prompts logged `admitted its sender; the turn is usable once its marker matches`, and boards_update refused in that turn (`admitted user_369z... (prompt 5ca60a030597), waiting for its marker; none of the files this daemon reads matches`), a retry a minute later too. A single wake earlier that day worked.

- **What the CLI does** (measured on claude 2.1.299, with a stand in channel server pushing two events in the same millisecond). Both run as ONE turn: one answer, one Stop. UserPromptSubmit runs once per event, in order, each with its own prompt (one token) and its own prompt_id; there is no combined prompt. The second event's synchronous hooks start when the first event's have ended, so the private turn hook leaves the LAST prompt's marker. The async forwarder is not waited for: with the first event's forwarder slowed by 4 s (a cold node start, as on Windows), the second event's line was spooled 2.4 s before the first's.
- **Why it refused.** The tracker kept one admitted prompt, and every begin() replaced it. With the lines out of order the daemon kept the first prompt while the marker named the second, and nothing matched until the next prompt. With the lines in order the turn opened on the second prompt alone, and in one order the first wake's fire was never recorded, so a restart could replay it as a fresh private turn.
- **The fix** (`lib/private-turn.mjs`). The prompts admitted for the turn not yet adopted are a short list (at most 16, `PRIVATE_TURN_ADMITTED_MAX`), oldest first, all of one session, sender and chat, with no voice consult among them (a consult's turn stays its own). The marker may name any of them; the turn is adopted as the one it names. Whatever closed the turn before still empties the list: Stop or SessionEnd, a prompt that admits nobody (no token, a token not delivered or already used, a peer agent, no verified sender, a replay), a card from someone else mid turn, a consult ending. A prompt of another sender, chat or session starts the list again, as it replaced the one prompt before.
- **Each fire recorded once.** When the turn becomes usable, the fire of every prompt admitted for it is recorded, each once: one the next prompt already recorded while it was held is not recorded again by its own prompt (0.68.4 recorded the second wake twice). If one of them cannot be recorded, no turn is usable (fail closed, as for a single fire) and the refusal names it; a person's message is adopted all the same, as before. A wake of the list that the backend fires again while the turn waits is a replay (0.68.4 checked only the prompt it kept).
- **The refusal line** names every admitted prompt (`prompt 5ca60a030597 or 1e345b40b0d9`) and says `prompt=same` when the marker names any of them.
- **Unchanged:** who may open a private turn; a marker of a prompt nobody admitted refuses; a card from another person, from another chat or replaying a handled fire still ends a turn mid turn.

Guards: `test/private-turn-two-admitted.test.ts` (22 tests) runs the real forwarder, the real private turn hook, a real intake, the fire ledger and the tracker. The reported shape in all five orders the CLI allows; a marker for the first prompt and for the second; both wakes re-offered after a restart are replays; two owner messages sent together; and fail closed controls (a combined prompt nobody admitted, a typed prompt between them, another person, another chat, another session, after Stop, a voice consult, a fire that cannot be recorded). 13 were red on 0.68.4. Mutation proven: 19 mutations, each turns at least one test red, and every test is turned red by at least one.

### #233: shared agents Phase 0, the plugin half

Board rows 3d604489 and dd56ddf8, BGOS `docs/reports/2026-10-14-shared-agents-review/PLAN.md` section 3. The backend half ships separately; every change here works against today's backend and against that one.

- **On a recipient's turn the browser shim says whose browser it is (0.2, MATRIX M8.15, KC's decision D3).** With a signed managed context naming someone other than the owner, `hoai_browser_status` adds that their browser runs on this agent's own host or on their own Home of Agents desktop app, never on the owner's desktop app; the offline text (no host online, or a relay `host_offline`) and the relay's host timeout say the same and ask them, not the owner, instead of "your owner's Home of Agents desktop app is not running" or "The owner's desktop app did not answer". The comment that claimed a shared agent's page never runs on the owner's machine is corrected: a daemon placed agent's own host can be the owner's computer, and D3 allows it. The owner's own turn reads word for word as before. The BGOS source carries the same bytes on BGOS commit `166f1fbe6` (branch `fix/shared-agents-phase0-shim`, local, not yet merged, with its own `shim.recipient-turn.test.js` and its wording pin updated for D3), which the pin (`bin/hoai-browser-mcp.vendor.json`, sha256 `007dd4f6`) names as `sourceCommit`; the cross-tree check passes against it. Land the two together; `codex-channel-bgos` vendors the same file and is behind until it is re-vendored. Guard: `test/hoai-browser-mcp.recipient-host.test.ts` (the real shim process).

- **call_owner, the mission tools and list_chats act for the verified sender of the turn (0.3, 0.4, 0.7).** They join the helper guard (`PRIVATE_TOOL_MATCHER`, all three installs), so a helper started in an earlier turn cannot call them, and the daemon resolves their turn TURN AWARE (`turnAwarePrivateTurn` in `lib/private-turn.mjs`): a verified turn is used as boards and schedule use it, so a share recipient's turn is always named (`X-BGOS-Acting-User`) and the backend half refuses or filters for them; on the owner's own turn nothing is added and every request is byte identical. Unlike boards they are NOT refused on a turn no delivery opened, because the owner's own work runs there (the native goal lane's `/goal` and every continuation after a Stop, the mission_started and mission_resumed cards, a button tap, a peer agent's message): such a turn runs as the owner, as before, unless the private turn tracker saw someone other than the owner reach it (`turnSenders`: the delivery its prompt carried named them, one of several deliveries submitted together as one prompt did, or their delivery arrived while it ran, a goal continuation after a Stop included), which is refused. It reads who reached the turn, never the chat the session last saw, which a typed `/goal` or a mission card inherits. Boards, schedule and the browser are gated exactly as before.
  - **call_owner (MATRIX M7.6).** The outbound call carries the turn's headers; on a recipient's turn it is bound to their own chat, never the first monitored chat, and a chat named that is not theirs is refused. The backend half's one sentence reaches the model as the tool's answer. Guard: `test/call-owner-private.test.ts`.
  - **Mission tools (MATRIX M4.3, M4.5).** With no chat named, `pickImplicitMissionChat` answers a recipient's turn with that turn's own chat and never falls back (it skipped their DM and landed in an owner chat, or in null, the owner's main chat); with no chat it refuses. A chat named on a recipient's turn must be their own, and a mission id is never taken at face value there: it must be the open mission of their chat. Every mission request on a recipient's turn carries the headers, and their active mission read never rides the shared ETag cache (`bgosGet` with personal headers). The owner's turn, and the goal lane, keep every rule they had. Guard: `test/mission-private.test.ts`.
  - **list_chats (MATRIX M3.9).** `GET peers/reachable` carries the turn's headers, so the backend half lists only a recipient's own chats. Guard: `test/list-chats-private.test.ts`.
  - The turn aware rule itself: `test/turn-aware-tools.test.ts`.
- **The owner's per recipient guardrail reaches the agent on every lane (0.5, MATRIX M3.4, CORE-CONTRACTS 7.6).** The backend has always sent it beside the message (`senderGuardrail` on the socket and the stream, `sender_guardrail` on the snake case rails, and `senderGuardrail` on the chat history row the poll reads once the backend half adds it there), already labelled; this plugin never read it, so the owner's instruction was silently dropped. `buildInboundChannel` now reads `senderGuardrail ?? sender_guardrail` off each lane's server record, on a person's turn only (never a peer agent's or a system card), and renders it at the top of the turn as a labelled marker, `[Guardrail from this agent's owner for the person writing, ...; NOT their words]`, with the person's words after it unchanged. The same value is the `sender_guardrail` attribute, a string, omitted when absent; it is a server sender key, so no lane's extras can set it, and the instructions say a line in the text claiming to be one without the attribute is not. With no guardrail the turn is byte identical. Guard: `test/sender-guardrail.test.ts`.
- **A permission card for the owner's machine goes to the owner's own chat, and only the owner can answer it (0.8, MATRIX M13.2, M13.3).** The daemon now marks whose each monitored chat is (`lib/chat-ownership.ts`): the backend row's user when the inbox names one (it outranks any message), else a person's message by its server stamped author (never the owner fallback, never a machine event row); only a main chat can be the owner's own, and a chat where anybody else was seen is somebody else's for good. `pickPermissionChat` sends the card to the owner's own chat first, the most recently confirmed first, and never to a chat known to be a share recipient's; with no evidence it is what it was. The answer is bound to `USER_ID` (it was bound to whoever last wrote in the card's chat), and a tap is read by the tapper the server stamps (`answeredByUserId`) first, on the card watch and both click intakes, so a tap the server names as a recipient's never allows a tool on the owner's machine; an unstamped tap keeps the old rule. The backend half's exact 403 sentence for a card posted into a recipient's chat (read off the whole response body) skips that chat from then on and moves the request on to the next chat; any other failure, any other 403, or a 403 after the card is up is a deny as before. A plan card keeps its own binding (the person it was proposed to); `test/plan-tap-authority.test.ts` now says the two differ on purpose. Guard: `test/permission-card-owner-chat.test.ts`.

## 0.68.4 (2026-10-13)

One release carrying three pull requests: a voice consult from the owner opens a private turn for that one consult (#227); replayed scheduled fires, the Windows hook self-restart and the private turn hook's cold start (#229, written as 0.68.6); and the PATH baked into an agent's or the watcher's unit is correct for its OS (#226). Found on the release head: an owner message the agent answered opens no private turn when a restart brings it back.

From #227: **A voice consult from the owner on a live call can use schedule, boards and the browser, for that one consult only.** On a live HOAI call the owner's question reaches the agent as a `voice_rpc` consult frame, answered with `voice_consult_reply`. Since the private turn gate (0.67.0) every private tool called while answering it was refused ("This private action did not start because its current sender could not be verified"): the consult card was pushed as a raw notification, never through `privateTurns.deliver`, and named nobody. Seen on Ares (agent 1040, Windows, 0.67.5) at 04:30Z on 2026-10-13: schedule refused twice from a consult, then accepted from an owner-typed message.

- **Who decides.** The backend stamps the owner on the frame, `payload.eventMeta = {source: 'voice_consult', payload: {actingUserId, consultId, assistantId, voiceSessionId, expiresAt}}`, only when it proved from its own state that the owner is live on that very call: the tool call came on the owner's own signed in Clerk session, the voice session is active, theirs, minted by a signed in person, about no chat or their own main chat with the agent, for an agent they own, an agent-placed call (`call_owner`) is still their live answered call holding that session, and the owner has spoken on that very session, whoever placed the call: a user turn with words in it in the backend's own record of the call (`voice_session_turns`, streamed by the app), never the voice model's word (BGOS `backend/src/voice/voice-consult-actor.ts`). A consult the voice model makes before the owner has said anything is not stamped and opens nothing here. Nothing in a body can supply it.
- **What the plugin reads** (`voiceConsultActor` in `lib/private-turn.mjs`). That stamp and nothing else: the source spelled exactly `voice_consult`, a `user_` id that is this daemon's own owner, the frame's own rpcId as `consultId`, this agent on the frame and in the stamp, and a deadline that is the earlier of `expiresAt` and 60 s from receipt. The model's arguments, a top level field, the card's `user_id` and every message lane are never read for it; the message lanes still admit only a person's own message or a scheduler card, unchanged.
- **The turn is that consult's alone.** Every consult card now goes through `privateTurns.deliver` with its own single use token. A stamped consult opens a turn that ends when the consult is answered (`voice_consult_reply` final, or the final word on a `final=false` continuation), when it times out or cannot be delivered (`onConsultEnded`, `endConsult`), or at its deadline, whichever comes first; a card of it not yet submitted cannot open one afterwards. A consult id delivered a second time names nobody. Any other card mid turn (another consult, the same consult again, an owner message, an unattributed card) revokes it, and so does any channel card pushed without the tracker (a meeting line, a button tap, a voice dispatch or stop): every channel notification now passes `privateTurns.rawCard`, which ends a consult's turn only, never a chat or scheduler turn. An unstamped consult (compose assist, a call a machine minted, another agent) opens nothing and, like any unattributed card, revokes a live turn. A stamped consult of the same person in the same chat arriving during the owner's own chat turn leaves that turn as it was.
- **What the agent is told.** A stamped consult's card adds one line: private tools act for the user only inside this consult, until its final answer, so run them before the final `voice_consult_reply` or reply with `final=false` first.

Guards: `test/voice-consult-private-turn.test.ts`, and `test/voice-consult-private-turn.proof.test.ts`, which feeds the frame the backend's Postgres integration spec emitted (`test/fixtures/voice-consult-stamped-frame.json`) through `normalizeVoiceRpc`, the consult handler, the daemon's own notify and tool admission code from `server.ts` and the real private turn hook: schedule is refused before the consult, allowed inside it, and refused after the reply and for a replay of the same frame. Needs the backend stamp (BGOS pull request for `voice-consult-actor.ts`); until it ships every consult opens nothing, as today. No version is published or tagged here.

From #229: three fixes from Mark's run of 0.68.3 on agent 909 (Vera, Windows), and one race the restart proof found.

**A scheduled fire opens one private turn, however often it is delivered.** After restarts on 0.68.3, two old native wakes (messages 118303 and 118672) came back as backlog and were each admitted as a fresh private turn, one with a new private-turn token.

- **Why.**
  - On every boot, the poll lane's restart recovery re-offers user and system rows from the last 24 hours that it does not count as answered (`lib/poll-core.ts` `selectRestartRecoveryIds`). Only an assistant row directly after a USER row counts, so a wake the agent answered is re-offered on every restart.
  - Each re-offer is a new delivery, with a new token and a new 15 minute window.
  - The private turn tracker lives in memory, per process.
  - Delivery is at least once.
- **The fix** (`lib/private-turn.mjs`, `server.ts`):
  - **The record.** Each agent keeps, in its own state folder (`<state>/<assistant id>/private-fires.json`), the scheduled fires it handled, for 48 hours: twice the recovery window. The file survives restarts, is read on every delivery, and is written atomically (once more after a short pause if a Windows rename fails) and pruned on every record, keeping the newest 1000.
  - **The key** (`privateFireKey`). A native wake is `native:<eventMeta.payload.fireId>`. An n8n Agent Scheduler card is `n8n:<scheduled_action_id>:<message id>`. Any other scheduler card is `scheduler:<message id>`. A scheduler system card has one, and in this release a person's own message too (below): the same deliveries an actor can come from. All three delivery lanes pass it.
  - **Replay, decided at delivery.** A fire found in the record, or already delivered by this daemon, is a replay. It still reaches the agent as text, after a line saying `[replayed: this scheduled fire was already handled at <time>; it opens no private turn]`. Its own prompt opens no private turn, and the daemon logs once: `private turn: replayed fire <key>, already handled at <time>`.
  - **Replays injected into a turn.** A replay injected into a running turn ends it: `a delivery that replays a scheduled fire, voice consult or message already handled (chat C) ended the private turn`. A replay delivered before any turn was open (the boot sweep comes before the hook intake starts) keeps the next prompt from opening one (`opens no private turn: a replayed scheduled fire, voice consult or message was delivered just before it, and the CLI may run it inside this turn`). The prompt after that opens as usual.
  - **When a fire is recorded.** A new fire is recorded when its own turn becomes usable (its marker adopted). One the CLI injected into another turn instead is recorded when the next prompt begins or that turn ends. So a fire delivered but never run, or never usable, before a restart still runs once. A fire that cannot be recorded opens no usable turn (fail closed), and the refusal says so.
- **Unchanged:** a new owner message opens its turn as before (an answered one re-offered after a restart: see below); who may open a private turn; two agents on one home keep separate files. #228's `email_send` takes its basis from the open private turn (`current()`), so a replayed fire, which opens none, can never be its basis.
- **The race the restart proof found** (`server.ts` `armDelivery`). The daemon wrote its attached floor entry only at the end of the arm, after the boot poll had delivered backlog. The private turn hook of that first backlog prompt then found no daemon of its own, wrote no marker (0.68.3 fails closed there), and the prompt lost its private turn. On Linux this happened on every restart in the lab. The entry is now written first.

**The hook self-restart no longer waits in silence on Windows** (#220). On Vera it logged `armed` at 07:46:00, then `waiting: process_tree_unreadable` at 07:47:00 and nothing more, so a fresh install still needed a manual second restart.

- **Why.**
  - The process table was readable. The daemon did not know its claude pid: on Windows that comes from a PowerShell parent walk with a 5 s limit, whose miss is cached for 10 minutes (`server.ts` `agentClaudePid`). The walk measured 1.6 to 2.4 s for three links, and 3.2 to 5 s or more to the top of the tree, on an idle PC.
  - With claude unknown, the controller never listed the table at all. It logged the reason once and waited in silence, and nothing ended the wait.
  - wmic plays no part: nothing in the plugin calls it.
- **The fix** (`lib/hook-restart.mjs`):
  - **The table names claude.** When the daemon does not know its claude, the whole process table names it: the nearest claude above this daemon, the watcher's own rule (`nearestClaudeAncestor`). The whole-table read has a 30 s limit and took 1.1 to 1.8 s on the same PC.
  - **Errors named.** The waiting line names the reader's error, and a claude found nowhere has its own reason, `claude_not_found`.
  - **Bounded.** After 60 minutes and at least six failed looks in a row (time the agent was busy adds no looks), the daemon says once: `hook restart: waited N min without a readable process table (<error>), so this daemon cannot prove that no tool or background job is running under claude; restart this agent by hand to load the private turn hook. It looks again every 30 min and asks on its own if the table reads at a safe moment`.
  - **Never blind.** It never restarts without the table: nothing else proves that no tool or background job is running.
- **Unchanged:** the safe moment itself (no turn in flight, nothing owed, no job under claude, the quiet window); single use; the ladder.

**The private turn hook ends inside its timeout, however slowly node starts** (board row d6aa4f1f). On Vera the UserPromptSubmit private turn hook timed out on cold starts: 3082, 3160 and 3706 ms against 3000 ms.

- **Why.**
  - After writing a live marker, the hook waits up to 2.5 s for the daemon's receipt (`.ready`). That wait counted from the marker write, while the CLI's timeout counts from the spawn. So a slow start was added on top: 2.5 s plus 0.6 to 1.2 s of start is exactly Vera's numbers.
  - The imports cost about 8 ms, so lazy imports would not help.
  - A start slower than the whole limit was killed before the marker was even written.
- **The fix: lighter, and a safe margin.**
  - **Lighter.** The wait ends 2.5 s after the marker, but never later than 3 s after the hook's own process start (`performance.now()`, `bin/hoai-private-turn-hook.mjs` `readyWaitEnd`). The hook's own time is bounded whatever its start cost, and a normal start keeps the whole 2.5 s wait.
  - **Margin.** The CLI's timeout for the private turn hook is 5 s in all five registrations (`hooks/hooks.json`; clone installs through `lib/claude-preseed.mjs` `PRIVATE_HOOK_TIMEOUT_SECONDS`). That leaves 2 s over the hook's deadline for its creation and exit.
  - **Existing installs.** An existing clone registration with the old 3 s is rewritten on the next registration (launcher start, update, `bgos-agent`), one entry per event. The daemon's own boot check ignores the timeout, so this costs no extra restart.

**Old daemon sweeps.** From 0.68.3 every daemon logs each spool folder it removes (`hook intake: removed the spool of session ...`), in its own log. A spool that vanishes with no such line in any 0.68.3+ daemon's log was removed by an older daemon (or by something outside the plugin). This release does not change the sweep.

**Together: a voice consult and a replayed fire (this release).** #227's consult turn and #229's fire ledger run in one tracker. A replayed fire opens no turn even on a card that also carries a consult stamp; a fresh consult after a replay still opens its own turn and ends with the consult; and a replay injected into a consult's turn ends it, for #227's reason (`a delivery that is not this voice consult`). A stamped voice consult is also a fire of its own, `consult:<consult id>` (a long id hashed): #227 refuses a consult id delivered a second time while the daemon lives (`consultsSeen`, in memory), and the ledger now refuses it after a restart too, with the card line `[replayed: this voice consult was already handled at <time>; it opens no private turn]`. Like a fire, a consult is recorded only once its turn was usable: one answered or expired before its card was submitted is not, and an unstamped consult never enters the ledger. Guard: `test/private-turn-consult-replay.test.ts` (on #227 alone three of its first six cases fail; on the plain merge of both, the restart case fails; the last three came from the review).

**An owner message the agent answered opens no private turn when a restart brings it back (this release).** Mark on Vera, on the release head 2bf7978, at 15:05Z, 15:13Z and 15:15Z: restart recovery re-offered KC's message 119731, which Vera had answered as 119866, on every restart, and each time it was admitted as a fresh owner private turn, so the agent could act again on an old request. Restart recovery counts an assistant row as an answer only when the row right before it is a user row (`lib/poll-core.ts`, unchanged since 0.68.3; that rule is left for 0.68.5), and the attach-first fix above makes such a re-offer reliably open a turn.

- **The key.** A person's own message is `owner:<message id>` in the same per agent ledger, for 48 hours (`privateFireKey`). All three lanes pass it.
- **Recorded only when its own turn is usable** (its prompt submitted and its marker adopted), as a fire is. Recorded means that, not answered: a message whose turn died before the answer opens no private turn when it is re-offered.
- **Not recorded:** one injected into another turn (even a turn of the same owner in the same chat, where it runs; recording it there would also record one the CLI only queued and never ran), one delivered but never begun, and one begun but never usable. Its re-offer still opens.
- **Unlike a fire,** an owner message whose key cannot be written keeps its turn, which never needed the ledger, and the daemon logs `private turn: owner:<message id> could not be recorded in the fire ledger; its turn stands, but a re-offer of this message after a restart would open a private turn again`.
- **A replay** reaches the agent as text after `[replayed: this message was already handled at <time>; it opens no private turn]`, opens no private turn, and is logged once: `private turn: replayed fire owner:<message id>, already handled at <time>`. Injected into a running turn it ends it; delivered before any turn was open it keeps the next prompt from opening one, as a replayed fire does.
- **Unchanged:** a new owner message opens its turn as before. Only a prompt that begins while a replay delivered just before it still waits opens none (`beside-replay`, as for a fire); the next prompt opens.
- **On the first restart on this build** no earlier build has recorded owner messages, so an answered message that recovery is already re-offering (KC's 119731, while it is inside the 24 hour window) is admitted once more and recorded then. From the next restart on it opens no turn.

Guard: the `Vera owner replay` cases in `test/private-turn-duplicate-boundary.test.ts` (on 2bf7978 KC's re-offer opens a turn) and the lane check in `test/private-tools-wiring.test.ts`.

From #226: **The PATH baked into an agent's or the watcher's unit is correct for its OS (board row 84296679, Nicole, kc-server).** `/opt/homebrew/bin` is Homebrew's macOS prefix; the rebaked Linux units still carried it. `servicePath` (the watcher's launchd plist and systemd unit) takes the platform and leaves it out of the systemd unit, and `bin/bgos-agent install` adds it only on Darwin. A macOS plist keeps it, and every other directory and the order are unchanged.


## 0.68.3 (2026-10-13)

One release carrying five fixes: restart marker takeover (#220), private turn and wake fixes (#221), stale claude on Linux installs (#222), a pending update no longer blocks sends (#223), and Always allow / Trust this site saved per agent (#224).

**An always-on install no longer bakes a claude that cannot start the agent (board row 84296679, kc-server, 2026-10-12).** A keep-alive reinstall ran under the watcher's service PATH, which led with `/usr/local/bin`; a stale `/usr/local/bin/claude` 2.1.22 sat ahead of the user's own `~/.local/bin/claude`, `command -v claude` returned it, and five agents were baked with it. That CLI answers `error: unknown option '--dangerously-load-development-channels'` and exits 1, so each launch died at once, about 420 times, with nothing in any log.

- **Which claude is chosen by what it can do, never by PATH order** (`lib/claude-binary.mjs`, `bin/hoai-select-claude.mjs`, `bin/bgos-agent install`). The launch flag is hidden from `--help`, but a bare use of it answers `argument missing` on a CLI that knows it and `unknown option` on one that does not. Candidates are `~/.local/bin/claude` first, then every `claude` on PATH; the first that is not `unsupported` is baked, the ones skipped are named, and an install is refused by name (`claude:none-supports-flag`, before anything is written) only when every one of them is. No version floor is guessed, and a CLI whose wording is unreadable is accepted, so a change of wording can never lock an install out.
- **The service PATH leads with the user's own directories** (`servicePath`): `~/.local/bin` and `~/.bun/bin` come before `/usr/local/bin`. The baked agent PATH leads with the chosen claude's directory and lists each directory once.
- **`run.sh` writes which claude the launch found and its version** into `agent.log` at every launch.
- **A claude that exits during startup leaves its own words.** The expect launcher takes what claude printed and its exit code into `launch-status` (`screen=` and `rc=`) and into `hoai.err`, which `run.sh` already prints back, instead of letting them vanish with the pane.
- **A failed agent stays failed until something proves it is up** (`decideHeldFailure`, `lib/watcher-keepalive.mjs`). On kc-server a verify FAILED (`agent_deaf_after_restart`) at 10:42:33 and the next sweep, 26 s later, classified the same agent by its unit file alone and wrote `supervised (canonical)` while claude crash looped. The record now holds `failed` (with its reason) until a fresh published state or a running claude of that agent proves it up, and a launch whose launch-status or three fast fails say it is failing is `failed launch_failing:<outcome>` even with no earlier record. An unreadable process table never turns a healthy agent red.
- **`hoai-agent status` names a crash loop.** A loaded unit with an `exited-during-startup` (or any other failed) last launch, or three or more consecutive fast fails, now says `NOT RUNNING HEALTHY` before the generic last-launch line.
- **`hoai doctor --assistant <id>` is `--assistant-id <id>`, and `--all-agents` checks every paired agent in turn**, each under its own id; it is also the default when the doctor is run from the home folder with no agent named and more than one paired agent. From any other folder an unnamed agent keeps its documented refusal.

**A restart marker that an old hoai launcher no longer reads restarts the agent anyway (Windows; Data and Mark, agent 909).** `bin/hoai-core.mjs` (byte identical at v0.66.1 and main, the same logic at v0.44.0) allows 3 marker relaunches per rolling hour per launcher process. The fourth marker is deleted before the budget is checked (`:2295` before `:2296`) and ignored, and the `exhausted` latch it sets (`:2299`, declared once at `:2228`) is never reset, so every later marker stays on disk for the life of that launcher (`:2293`). Mark saw exactly that: write 1 gone with claude on the same pid, write 2 on disk for more than a minute. It was not the 0.67.5 daemon: the same five writes against a v0.66.1 daemon fail the same way (reproduced with the real `claude.exe` 2.1.296 under v0.44.0 and v0.66.1 launchers, docs/evidence/2026-10-12-restart-marker-takeover.md). Three update restarts inside an hour (0.67.3, 0.67.4 and 0.67.5 were tagged within 53 minutes) spend the budget by themselves, and the launchers already running in the field cannot be changed.

Now the daemon takes such a marker over (`lib/marker-takeover.mjs`, Windows only, `HOAI_MARKER_TAKEOVER=off` turns it off). The pairing lock holder watches its own `~/.bgos-agent/<id>/restart-requested.json` and acts only on a marker written after it started that the live hoai launcher left unanswered: still on disk 15 s after it was seen (stranded), or removed within 7 s while this session runs 10 s more with `supervisor.json` and `launch.json` unchanged (swallowed by the deny branch). It waits until the session is a minute old, so the launcher never reads the exit as a rejected resume, and it spawns ONE detached hidden helper (`bin/hoai-restart-handoff.mjs`, `lib/restart-handoff.mjs`). The helper changes nothing until it has proven from the process table that the launcher named in `supervisor.json` is the parent of this daemon's claude (or its grandparent through an npm `claude.cmd`), runs `hoai-core.mjs` and wrote that file, that no other claude carries the agent's pin, and how the agent comes back. Then it checks claude's creation time and the daemon's pairing lock once more (a refusal there spends nothing), claims a stranded marker by rename (`restart-requested.claimed.json`), records the takeover in `restart-takeovers.json` (the launcher's own 3 per rolling hour; a marker refused by that cap is set aside as `restart-requested.refused.json`, never restarted later), and ends claude with TerminateProcess, what the launcher's own restart does. From then on the ended claude and daemon count as dead whatever reuses their pids, the launcher counts as gone only once its process (pid and creation time) is, and a last process listing right before any start refuses when a claude carrying the pin already runs. A `--keep-alive` launcher (the "HOAI Agent <id>" task) relaunches the pinned session by itself and the helper starts nothing. An old interactive launcher exits; after a 20 s settle with no launcher or daemon of the agent live, the helper starts the agent through the unchanged restart ladder (`restartAgent`: the task when it is registered for this folder, else the hidden recipe launch), with a filesystem that cannot write a restart marker and an environment without Claude Code's session markers or the keys the plugin injects. Every route resumes `~/.bgos-agent/<id>/session-id`. Measured live: write 4 swallowed, the helper ran, a new hidden launcher resumed the same session 28 s later, writes 5 and 6 restarted normally. The daemon logs every step as `restart takeover: ...` and the helper as `restart takeover helper (pid N): ...`. `listAgents` takes `includeIds` so the helper finds an agent whose key lives in its folder's `.mcp.json`.

**A fresh start never requests another restart (agent 909, 17:17:10).** About 9 s after a hand restart a bare `{}` marker restarted the agent again. Only the restart ladder writes `{}` (`lib/agent-restart.mjs:242-245`), and the automatic caller is the keep-alive sweep (`lib/watcher-keepalive.mjs`, the update restart): it read the old daemon's state, awaited a process listing of several seconds during which the relaunch happened, and wrote its marker onto the new session without asking again. The sweep now asks `decideFreshStart` (`lib/keepalive-plan.mjs`) after its last await and before anything is spent: a restart waits as `fresh_start` when the daemon it judged is gone or replaced (a keep-alive backoff included), or when `launch.json` (rewritten before every launch since 0.44) or the newest claude started inside the quiet window; and on the marker tier a PENDING marker (under 5 minutes old and written after this session started) is never rewritten (`restart_already_requested`), while a stranded one is, so a takeover sees a fresh request. A service restart (macOS, Linux) is never held up by a marker. Jobs an owner asks for are unchanged.

**A daemon that registers the private turn hook itself asks for ONE restart, so the hook loads (Data, PR #220).** Until now a daemon that booted without the private turn hook wrote it into its clone workspace (`registerCloneHooks`) and only logged "restart this agent to load them": the CLI reads its hooks once, at launch, so every boards, schedule and browser call kept refusing until a person restarted the agent. Now a registration made by THIS boot (outcome `registered`) arms exactly one restart through the daemon's own ladder, the one a scheduled update walks (`restartAfterHookRegistration` in `lib/update-rpc.ts`: the keepalive signal, a service that provably owns the process, or the hoai launcher's marker; nothing is posted to the backend). It never arms on a plain fresh start that found the hook, on a registration that was already in place, on a folder that is not this clone, or on a failed write (`lib/hook-restart.mjs`). It is single use: `~/.bgos-agent/<id>/hook-restart.json` is created exclusively BEFORE the ladder is asked, so the daemon the restart brings up (which finds the hook registered anyway), any later one, and a second daemon racing this one never ask again; a record that cannot be written means no restart, and deleting it by hand re-arms the next registration. Only the pairing lock holder asks, never in its first minute, never while an update holds the shared checkout's lock or drains the daemon, and only at the safe moment the watcher itself waits for before a restart nobody asked for (`decideSafeMoment`): no turn in flight, nothing owed, no background job under claude, and 10 minutes of quiet (30 without the hook turn signal), boot counting as activity, so no turn is cut. Intake is drained first, as for a scheduled update; a restart that never arrives says to restart by hand. Logged as `hook restart: ...`, each reason to wait once; after the process tree said wait, it is listed again only five minutes later.

**A scheduled wake opens its private turn on a computer that runs several agents.** Reported by Data and Mark on a Windows PC at 0.67.5: agent 909 (Vera) got a 17:30 scheduled wake (sender System, `actingUserId` the owner). The private turn hook wrote its marker, but no `.ready` followed and both `boards_query` calls refused with "its current sender could not be verified". An owner message later in the same session passed, and the intake logged that it bound then. A Mac clone at 0.67.2 passed the same wakes.

- **Why.** Every agent of one OS user spools its hooks under one root, `~/.bgos-plugin-state/hooks/<session>/`, and every agent's daemon drains every session directory there (`lib/hook-intake.ts`). Vera had just restarted onto 0.67.5: her new session had spooled only its SessionStart, then sat quiet past the 30 minute idle sweep, which removed the directory. The wake's UserPromptSubmit recreated `events.jsonl` as one line about three times as long as the old one. A neighbour's daemon still held its cursor for the old file; the new file was larger, so it was not seen as a new file, and the neighbour wrote that cursor into the session's `cursor.json` although it had refused the session. Vera's daemon, which had forgotten the directory when it swept it, loaded that cursor and started after the wake's line. When a third daemon did the sweeping, Vera's daemon kept its own old cursor and made the same mistake. Either way `privateTurns.begin()` never ran for the wake, so no turn was pending and nothing wrote `.ready`. The owner's next message was a fresh line and bound the session. It was never about wakes: any first prompt after the idle sweep was exposed, and a wake is what arrives after half an hour of quiet. One agent alone on a computer never shows it, because nobody else drains its spool; that was the Mac.
- **The fix, in `lib/hook-intake.ts`.** Only a session's own daemon writes its cursor: the daemon bound to it, or the one whose project folder it is while it still waits for proof. A session a daemon refused as another agent's or another session's keeps its cursor in memory. The file is now `own-cursor.json`, and the `cursor.json` every daemon wrote before 0.68.4 is never read, so a neighbour still on an older plugin cannot bring the skip back: an agent is covered as soon as it runs 0.68.4, whatever its neighbours run. And a cursor names the file it counted (`head`, a short hash of the file's first line, which carries the forwarder's minted line id): another first line means another file, drained from the top whatever its size. The one cost: a session that outlives the upgrade (a `--resume` of the same session id after a crash) is drained once from the top, which can repeat that session's activity rows.
- **Unchanged.** Who may open a private turn: a verified human sender, or a scheduler wake's `actingUserId`, never a peer agent and never another system message. A wake that names someone other than the owner still runs only as that person (the daemon names them in `X-BGOS-Acting-User` and the backend admits the claim only through an active share of this agent), never with the owner's authority.
- **Proof.** Reproduced with the real daemon (`bin/bgos-launch.mjs`, bun) against a fake backend, with a fake Claude Code that renders channel prompts as claude.exe 2.1.296 does and runs the workspace's real hooks: two agents on one Windows home lost the wake in 3 of 4 runs and the owner message after it bound and passed, as reported; one agent alone passed; Linux lost it in 2 of 4 runs with two agents and passed with one. With the fix, Windows 6 of 6 and Linux 4 of 4 runs passed. Guards: `test/private-turn-shared-spool.test.ts` (the real forwarder, private turn hook, intakes on one shared folder, the socket lane's actor statements and claude.exe's prompt; controls for an owner message, a peer message, a wake naming a stranger and a system message that is not a wake) and `test/hook-intake.test.ts` (a recreated larger spool, the head across a restart, who writes the cursor, an older daemon's `cursor.json`, a restart that keeps an unproven session's dropped lines dropped). No version is published or tagged here.

**A private turn survives a second record of its own prompt.** Mark's proof of the change above failed on Vera at 18:45 (2026-10-12): after a restart at 18:06 and about 39 idle minutes, a scheduled wake rewrote the private turn marker live (turnId 19a3c691), no `.ready` followed and `boards_query` refused with "its current sender could not be verified"; the daemon's only line was "4d6691bc... was rotated, truncated or recreated; draining it from the top".

- **Why.** The from-top drain reached `privateTurns.begin()`: the daemon was already bound to the session, so it consumed the wake silently, and a healthy wake logs only that line. The turn was opened and then lost to a second record of the same submission's boundary, which a second hook source produces (the CLI runs a hook once per distinct command, so the same script under two spellings, a clone's settings and an enabled plugin copy, runs twice). Either the private turn hook ran again after the daemon had adopted the first marker and stamped a new `turnId`, and `current()` dropped the turn because the id changed (`lib/private-turn.mjs`, `current`); or the forwarder spooled the prompt twice, and the second `begin()` cleared the turn the first had opened and found its single use token already spent (`lib/private-turn.mjs`, `begin`). The first adoption's receipt, `<marker>.ready`, holds `{turnId, sessionId}`: the second private turn file with the same sessionId seen on the PC. `lib/hook-intake.ts` already promised that a second registration costs nothing; for a private turn it cost the turn.
- **The fix.** A repeat is recognised only as the SAME submission: the CLI stamps every hook of one submission with one `prompt_id`, and a resubmission gets another. `begin()` (`lib/private-turn.mjs`) remembers each submission it took that carries a delivery token and a `prompt_id` (session, prompt hash, `prompt_id`); the same submission again changes nothing. The private turn hook writes the `prompt_id` into its marker (`bin/hoai-private-turn-hook.mjs`), and `current()` follows a marker stamped again only for the same live submission in the same session. Each repeat is logged: "private turn: the same submission reached the daemon twice ..." or "private turn: the marker was stamped again for the same submission ...", the one trace of a doubled hook.
- **Unchanged.** Who may open a private turn: the actor still comes only from the delivery whose token the prompt carries. A repeat never revives a turn that ended (Stop) or that a card from someone else revoked, and never hands a turn back to an older sender: a late record of an older submission leaves the newer turn as it is, or ends it so that nobody may act. The same words submitted again, after an interrupt with no Stop or from a CLI without `prompt_id`, are a new prompt and end the turn, exactly as before; so do another prompt, another session and a closed marker. A peer agent's or a stranger's turn stays exactly what it was.
- **Proof.** The real daemon, real hooks and a fake backend with the backend's exact wake frame, in Vera's shape (restart, idle, a neighbour's sweep, a stale same-session file, the reset line as the only intake line): on PR 221's head the wake passes with single records and is lost when the private hook runs a second time after adoption or the forwarder spools the prompt twice, on Windows and Linux; with this change all of them pass and a peer's message is still refused. Guards: `test/private-turn-duplicate-boundary.test.ts` (Windows and Linux), 16 mutations, each red.

**The daemon says what the private turn decided.** Mark's canary of the change above on Vera (22:51, 2026-10-12) still refused the wake's `boards_query`, and the daemon logged nothing about the private turn: three rounds could not tell whether `begin()` declined the wake's prompt or its marker never matched.

- **Now logged.** For every prompt that carries a delivery token, or a delivered message without one: `private turn: the prompt in session <S> admitted its sender; the turn is usable once its marker matches`, or `... opens no private turn: <reason>` (no delivery token, more than one token, a token this daemon did not deliver or already used, a delivery older than 15 minutes, a peer agent's message, no verified sender). For a card from someone else that ends a turn mid turn: `private turn: a delivery <from a peer agent | with no verified sender | from another person | from the same person in another chat> (chat <C>) ended the private turn; nobody may act until the next prompt`; before this the turn ended silently. For every refused private call: `private turn: refused <tool>: <why>`. With no turn open, the why says what the last prompt decided and how its turn closed (Stop or SessionEnd, or revoked, by whom). With a turn admitted and waiting, it names each marker file the daemon reads with `live`, `session`, `prompt` and `turn`. Once a marker was adopted, it names only that file and what changed in it (`turn`, `promptId`), since no other file is read again. A schema other than 1 is named, and no marker field can split the line. The refusal the model sees is unchanged, and so is who may open a private turn.
- **Ruled out, with the real daemon on main, 0.68.4 and this change (Windows and Linux).** The delivered token and the marker's `turnId` are different ids by design (the daemon mints one at delivery, the hook the other at the prompt) and are never compared. The idle sweep of a bound session's spool keeps the binding, and a spool the next prompt recreates (its line 0 the wake, no SessionStart) still opens the turn. A private turn hook killed by its 3000 ms timeout before it writes loses only that turn, as does a mangled hook path; neither touches the next turn. An empty-prompt Stop record (`e3b0c442...b855` is the hash of no prompt) is the normal end of a turn.

**The private turn hook never writes under another agent's key, and the idle sweep says what it removes.** Mark's step 0 answers (2026-10-13 01:50Z) settled Vera's 22:51 wake and showed two more things on her PC.

- **The 22:51 wake.** It was the n8n Agent Scheduler's reminder, not a native wake: `event_source` scheduler, sender System, chat 1132 (Vera's own chat with her owner), and an `event_payload` of the reminder's own fields with no `actingUserId`. `privateActor()` (`lib/private-turn.mjs`) takes a system card's actor only from a scheduler event's `eventMeta.payload.actingUserId`, so `begin()` declined it as it should. The rule is unchanged; the daemon's line now says what the delivery lacks: `private turn: the prompt in session <S> opens no private turn: its delivery names no verified sender: neither a person's own message with their user_ id nor a scheduler event carrying eventMeta.payload.actingUserId`. The backend's stamp is a separate change. Guard: `test/private-turn-duplicate-boundary.test.ts` (the reminder's exact shape, an owner sender block included; controls: the same reminder stamped with the owner, and the native wake; and what a scheduler card needs: `eventMeta.payload.actingUserId` alone, a camelCase `user_...` string, while `scheduledTaskId`, `fireId`, `ack` and `dueAt` are not read). Vera's run on the previous build matched it: the native wake at 02:30Z passed, the reminder at 02:40Z was refused as `no-actor`.
- **Another agent's key.** `floor\attached\354c5ab3...json` was Mark's daemon (agent 888), yet `private-turn\354c5ab3...json`, still live from 06:24:56Z, carried Vera's session: Vera's private turn hook had written her turn under Mark's key. Neither daemon can use such a turn, and it overwrites the file the other agent's own turns live in. The hook took the first of its session's folders (`CLAUDE_PROJECT_DIR`, `BGOS_LAUNCH_CWD`, the payload's cwd and every folder above it) with a live attached entry, whichever daemon wrote it, and with none it fell back to the first of those folders that held a marker: a cwd moved into another agent's folder, a launch folder inherited from another agent's process, an agent folder above this one, or a restart before its own daemon attached each led there. Now the daemon's attached entry names the folder its session transcripts live in (`projectDir`, the folder the hook intake admits sessions by) and the folder a relative transcript path is read against (`baseDir`, its launch folder, as the intake reads it). The hook writes only under a live entry whose `projectDir` holds the payload's `transcript_path` (`lib/floor-state.mjs` `findOwnAttachedKey`); an entry from a daemon older than this names none and is used only at `CLAUDE_PROJECT_DIR`'s own key. With no such entry the hook writes no marker, prints one line on stderr and exits 1 (a non blocking error the CLI records; the prompt runs and its private tools refuse), and leaves `private-turn/unserved/<session>.json`, which the daemon's refusal line quotes: `...; the private turn hook of session <S> wrote no marker at <time>: no live daemon attached to this session's folders serves its transcript <path> (<key>: pid <n> serves the transcripts in <folder>; ...)`. It does close this session's own live markers at keys no other live daemon holds, so a turn whose daemon stood down cannot outlast the next boundary (its signed browser context lives up to 60 s), and a helper's private call in such a session is refused. A failed Stop closes only this session's own markers, and a helper's start is recorded only beside its own marker. A session with nothing attached and no marker (a person's own `claude`) stays silent. Still per folder, not per session: another CLI session in the same agent folder matches the agent's entry, as before. Guards: `test/private-turn-cross-agent.test.ts` (two agents on one home: each path to the other's key, the real hook's stderr and exit code, the daemon's line, a daemon that stood down mid turn, a helper, a relative transcript path; controls: the own daemon listed after the other's, the WSL hop with no `CLAUDE_PROJECT_DIR`, an older daemon's entry, other spellings of the transcript path, a standalone session) and `test/floor-state.test.ts` (`comparableFolder`, `folderHolds`, `findOwnAttachedKey`). With real daemons and hooks, two agents on one Windows or Linux home: on the previous build Vera's hook overwrote Mark's marker with her session and her wake was lost; with this one Mark's marker is untouched, a launch folder inherited from Mark's process no longer costs Vera's wake, and a cwd in Mark's folder with no `CLAUDE_PROJECT_DIR` refuses with the reason in her daemon's log.
- **The sweep says what it removes.** Every agent's daemon sweeps every session folder, and none logged it: Vera's bound session's folder went during an idle with no line in any log. Each removal now logs one line in the log of the daemon that removed it: `hook intake: removed the spool of session <S> (idle sweep: nothing in it touched for 31m05s); this daemon is bound to that session and stays bound`, or `(its SessionEnd was consumed: ...)` and `... was bound to that session and is now unbound`. A folder that cannot be removed is named once; one the forwarder recreated at once counts as removed. Guard: `test/hook-intake.test.ts`.

**A staged auto-update no longer blocks sends and can no longer wait for ever (HOAI product board row a741d98b, Pylon 929, 2026-10-11).** On 0.68.2 a scheduled update closed intake and then refused every tool call with "restarting for an update" for as long as it waited for in-flight work to finish, and that wait was unbounded: with one operation wedged (a wake delivery nobody read), the daemon sat muted until it was killed.

- **A pending update only defers the restart.** The scheduled path now waits for a quiet moment WITHOUT closing intake or refusing a tool call. Intake closes only once nothing is in flight, and if a message lands in that instant the update yields (bounded by the triggered path's 45 s) and intake reopens.
- **A ceiling on the scheduled wait** (`UPDATE_SCHEDULED_QUIET_CEILING_MS`, 15 min). A daemon that never goes quiet keeps serving and retries in 30 minutes (`UPDATE_BUSY_RETRY_MS`) instead of at the next daily check.
- **A tool call is admitted while the update is only waiting** (`decideToolAdmission`): a send is exactly the in-flight work finishing. It is refused only once the daemon is drained and the restart is committed.
- **Stale work is not work.** An in-flight operation or an unanswered inbound older than 30 minutes (`UPDATE_STALE_WORK_MS`) no longer holds a drain open; the agent state the watcher reads still carries the raw counts.

**The owner's Always allow and Trust this site in the agent's own browser now outlive the browser host (HOAI board row b774a758).** On a daemon placed agent, both answers lasted only until the host restarted, and the owner was asked again. The host files a remembered answer under `profiles.agentProfileKey`, the desktop's own key function, vendored byte for byte. That function takes the agent id as a string (`relay:<id>` for an assistant the backend resolved) and returns null for anything else, and the host handed it `ctx.assistantId`, which `relay()` has already turned into a number. So the key was always null and `_remember` wrote nothing. `_profileKey` (`bin/hoai-browser-host.mjs`) now hands it `relay:<id>`, as `local-mcp.js` does for the relay door, which keys the agent `assistant-<id>`: the key the desktop uses for the same assistant, the key `withoutTrustGrant` revokes under, and one key per agent. An id that is not a positive integer gets no key and nothing is remembered; before, a non numeric string id would have been filed as a loopback client (`client-<name>`). The vendored `profiles.js` is unchanged. Allow once and Allow for this session are still never written to disk, and every answer is still written only to the agent's own browser folder, `~/.bgos-agent/<id>/browser/<principal>/agent-browser.settings.json`. Known limit: this plugin has no control yet for the owner to revoke a remembered answer (the desktop's `withoutTrustGrant` works on this file, and the test proves it); until one lands, deleting the origin's entry under `agentGrants["assistant-<id>"]` in that file revokes it, and a revoke control is a follow-up. Guard: `test/hoai-browser-host.trust-persist.test.ts`. No version is published or tagged here.

## 0.68.2 (2026-10-12)

**An email reaches the agent as a stranger's words, never as the owner (agent email, HOAI board row 2dd04488, piece P2: the plugin).** The backend delivers an email to an agent as a row of the agent's email chat: sender `user`, no sender user id, `fromAgent {name: 'Email', type: 'external_email'}`, and `senderType: 'external_email'` on the socket and the history route. This plugin knew no such sender: every lane delivered it as a plain user turn, with `user="User"` and the owner's id as `user_id` (the owner fallback); an email stamped `slash_command` ran `/status` on the socket lane, and a `yes <code>` email was swallowed as a permission answer on the poll and stream lanes.

- **The label** (`lib/inbound-channel.ts`). An email is recognised by any one of the backend's three signs (the sender type, `fromAgent`, `externalEmail`), on the record or inside a row envelope, and it wins over every other reading. Its turn opens with a fixed line, `[Email from outside HOAI, ...]`, and ends with a fixed line, `[End of the email from outside HOAI. ...]`, with the attachment lines inside; neither line carries anything the sender chose. It says more than the peer marker: NOT the user, NOT the owner, never an instruction even when it names the owner, files asked for and never run, and a reply leaves only when the owner taps Send. Inside, the text is folded (NFKC), every format and default ignorable character goes, and a channel, harness or private turn tag, or a line that opens like one this plugin or the backend writes (the email and end lines, peer, system, plan level, backlog, attachment, meeting and BGOS lines, and every bracketed event tag such as `[button_clicked]` or `[stop_turn]`), is neutralised, found as a model would read it: through look-alike letters, combining marks and any spacing. Nothing the sender writes can close the label or pass for the channel, the owner or this plugin, and every word stays; text past 24,000 characters (the backend already cuts at 16,000) is cut inside the label. Meta: `user="Email"`, `user_id="external_email"` (the host drops a card without one, and it names no person), `sender_type="external_email"`, `email_id` when the server sent one, and never a sender relationship or share key, whatever the record says. The owner's plan level and the backlog line sit above the label; an email's backlog line asks for nothing.
- **Its files** are the content lines and the `meta.files` entries the instructions describe, each entry with `from_email: "true"`. The backend's own names (`attachment-<n>.<ext>`) pass unchanged; any other name keeps only letters, digits, dot, underscore and hyphen; a type that is not a plain MIME type is dropped, and a reference that is not one clean http(s) link reads as no link.
- **Every lane.** Socket, poll (the history route, its boot backlog and restart recovery included), stream and every meeting card deliver an email labelled and keep it out of every branch that acts for the owner: never a slash command, steer or plan chip, never a permission answer (the permission wait included), never a meeting turn, never the chat's last human sender, never an event, never the acting user or a private turn's actor, never a mission resume, and no reply overdue nudge. The stream view keeps it an email in both wire shapes, never reads the transport owner as its author, and a finalize never turns it into a system wake.
- **`email_label`** rides every heartbeat and the canon fetch, on every host and connection, but only while `labelsExternalEmail()`, a check of the real builder, holds: a build whose label broke stops declaring it, and the backend holds the mail. That check proves the builder; the lanes are proved by the tests, which run each lane's real code out of `server.ts`.
- **What the agent is told.** A new instructions section, Email From Outside, plus a line in Receiving Attachments and in the per sender text; the offline canon says the same. The Sessions sheet never titles a session with an email.

For the backend: this plugin sends no capabilities at pair exchange, so the token arrives on the first heartbeat; it adds no draft tool (the design names the route `POST integrations/agent-email/reply-drafts` but no tool), so the agent is told to write a suggested answer in its reply to the owner, who makes the draft in the app; and it polls only chats `peers/inbox` lists, so an email chat hidden there is served by the socket alone. Guards: `test/external-email-label.test.ts`, `test/session-library.test.ts`. No version is published or tagged here.

## 0.68.1 (2026-10-12)

**A refused private call on a peer agent's turn is now counted.** A request that arrives from another agent is never a verified sender, so boards, schedule and browser calls on such a turn refuse (since 0.67.0, and correctly). KC asked to see the impact before deciding whether an owner-set delegation should let a trusted agent's request through (`docs/proposals/peer-delegation-private-tools.md`). Each such refusal now logs one line (`peer private call refused: tool=... delegate=... target=... today=N`) and adds to a per-day file `peer-private-refusals.json` beside the daemon's state, per delegate and tool, 30 days kept. Ids and the tool's name only; no message text, no arguments, no board or chat names. The refusal itself is unchanged: the turn tracker remembers the peer behind a turn apart from the actor, and that never satisfies the gate.

## 0.68.0 (2026-10-12)

**Agents run in the background on every computer, and a window is only a viewer beside one (HOAI board row d133ddb2, piece 1 of 4: the plugin).** "Create a new agent here" on Windows started the agent with `cmd /c start ... cmd /k node hoai-core.mjs`, a visible console that stayed open, empty, after the agent ended (AlienAres), and the Windows agent task ran its launcher minimized in the taskbar.

- **Every launch is hidden.** The restart ladder's recipe rung (create_agent, and any restart with no supervisor) starts `wscript //B <statedir>\launch-hidden.vbs` on Windows, which runs `node hoai-core.mjs` once in a console of window style 0 and does not wait, unattended as that agent (`HOAI_SUPERVISED`, as the task launcher does). `cmd /k` is gone. On a Mac or Linux the rung is tmux, then `script`; the visible Terminal and terminal emulator fallbacks are gone (no tmux and no `script` is the named failure `no_pty_available`). The Windows agent task's `run-agent.vbs` uses window style 0 instead of 7; the sweep already rewrites an installed launcher whose text differs, so a task picks it up at its next start.
- **create_agent keeps a new agent running from its first minute.** It reads the keep-alive answer after pairing. When the computer's Keep agents running switch is on, or the computer was never set (Kc's choice 1: the first new agent turns it on), it installs and starts the product supervisor itself: the agent task on Windows (registered and started), `bgos-agent install --always-on` on a Mac or Linux. A computer the owner turned off, or no answer, gets the hidden one shot. A task that cannot be registered leaves no file it wrote behind (files an earlier install left are kept) and the agent still starts once, hidden; a supervisor that was started is never doubled by a one shot. Re-creating an agent that already runs registers or installs the supervisor without starting it and restarts the running session in place, as before. The step says which: `launched via task (keep agents running: switch_on)`, `launched via task, restarted via marker (...)`.
- **Never a second session from a hidden launch.** On Windows the one shot now refuses (`session_without_launcher`) when the agent still runs with no launcher (an orphaned claude, a person's own), exactly as the task start already did; the old visible `cmd /k` had the same gap, only it showed.
- **Show agent windows.** Right after every sweep, whatever the switch says, the watcher's windows pass (`lib/agent-windows.mjs`, rules in `lib/agent-windows-plan.mjs`) reads the owner's setting from the keep-alive answer (`showAgentWindows`, absent reads off) and opens or closes viewers: on Windows a watch only window (`bin/hoai-agent-viewer.ps1`, started hidden through `bin/hoai-agent-viewer.vbs`) that attaches to the agent's hidden console and mirrors its screen, with no way to type into it; on a Mac a read only `tmux attach-session -r` in Terminal (`open -g -a Terminal` on a `view-agent.command` in the agent's state folder, so no Automation prompt); on Linux the same attach in the first terminal emulator found, when the watcher has a screen. At most 4 open a minute, oldest agent first. Switching it off closes the viewers and only the viewers (a Windows viewer process found by its command line; a read only tmux client, never a person's own attach). A viewer the owner closed stays closed until the agent's next start or the setting goes off and on, also across a watcher restart (the memory rides the watcher's `state.json`); an agent that restarts in a loop gets a new viewer at most every 5 minutes, and a viewer left on a session that ended is closed rather than counted for the new one. The pass never starts, stops or restarts an agent. It also hides in place, once per launcher, a console that an older task launcher left minimized or the old `cmd /k` left on screen (never a person's own console). Measured on a Windows 11 PC whose default terminal is Windows Terminal: the old task launcher's minimized console is a conhost window and is hidden in place; the old `cmd /k` console went to Windows Terminal, which hiding cannot reach, so it is left as it is and logged, and it shows until that agent's next start. The new hidden launches are not handed to Windows Terminal: no window of any kind appeared.
- **The heartbeat says what each computer can show:** `env.watcherHealth.windows = {mode, reason}`, mode `tmux | viewer | none`, reason `setting_off | showing | no_tmux | no_screen | no_terminal | open_failed | unsupported`, fixed lists only.

What the backend must add (piece 2): `showAgentWindows` (true or false) in `users.fleet_prefs`, and in the `GET integrations/watchers/keep-alive` answer on both branches; `switchState: 'on' | 'off' | 'never_set'` in that answer (`never_set` for a computer with no row, `off` for a row the owner turned off); the default ON write and the adoption of the new agent for a computer never set, at create_agent time (the plugin starts the supervisor for `never_set` before the agent first checks in); and `windows` kept by `sanitizeWatcherHealth` (both values from the lists above). Until then the plugin behaves as today with every launch hidden: no field means windows off and the switch read from `enabled`.

Not in this piece: the plugin's own `bin/hoai-bootstrap.sh` and `.ps1` still open a visible terminal for their final launch, and the app's one click script launches a visible PowerShell window on Windows (pieces 3 and 4). WSL tmux on Windows waits for its one day test (choice 2).

## 0.67.5 (2026-10-12)

**Boards, schedule and browser tools no longer refuse every call on a Windows agent whose folder is reached through a link.** Claude Code names a session by `fs.realpathSync(process.cwd())`: the transcript under `<config dir>/projects/<folder>`, the hook payload's `cwd` and `transcript_path`, and the `CLAUDE_PROJECT_DIR` it hands its MCP servers. The daemon gets the CLI's cwd as spelled (`bin/bgos-launch.mjs` passes its `process.cwd()` on as `BGOS_LAUNCH_CWD`). On macOS and Linux `getcwd()` already returns the real folder. On Windows a junction or a symlink keeps its spelling, so the daemon looked for the session under a projects folder the CLI never writes, the hook intake refused every event of the agent's own session (`hook intake: ignoring session <id> (foreign-project)` in the daemon log), `privateTurns.begin()` never ran, no `.ready` receipt was written and `browser-turn.json` kept `turnId: null`. The private turn hook still wrote its marker, because it also finds the folder through `CLAUDE_PROJECT_DIR`. Reproduced on Windows with the real daemon, the real hooks and a fake backend; the same layout behind a symlink adopts on Linux.

The daemon now resolves the launch folder the way the CLI does (`claudeProjectCwd` in `lib/session-binding.ts`: the same non-native `realpathSync`, so an 8.3 short name and the drive letter stay as spelled, checked under node and under bun, and a folder that cannot be resolved is used as given) for the readers that follow the CLI's transcripts: the session binder and with it the hook intake, the usage self report, the resting watcher and the login watcher. Everything that means the agent's own folder (the folder pin, the floor keys, supervision, skills, the intake's base for a relative path) still uses the launch folder as given. Two other readers of `<config dir>/projects` also still use it and are left for a follow-up: the memory folder (`resolveMemoryFolder` in `server.ts`) and the session pin keeper, which mirrors the launcher's own lookup in `bin/hoai-core.mjs`. On macOS and Linux the launch folder comes from `getcwd()`, which is already the real folder, so nothing changes there; only a `BGOS_LAUNCH_CWD` inherited with a linked spelling now resolves to the folder the CLI uses. Guards: `test/private-turn-linked-folder.test.ts` and `test/claude-project-cwd-bun.test.ts`. The daemon picks up the change when it restarts, so each Windows agent needs one restart after the update.

**A download in the agent's own browser is asked for, and one nobody answers is kept for the owner (HOAI board row 67562770).** Measured on main 0a4c96a with the host started the way the daemon starts it: Chrome raised the download over CDP, Playwright wrote it into a `playwright-artifacts` folder in the system temp folder and its MCP tab code copied it into `~/.bgos-agent/<id>/browser-output/<person>/` and printed that path to the agent. Nobody was asked, although the host's agent text said a download is asked for. The causes: `connectOverCDP` without an artifacts folder, the browsing context accepting downloads by default, and Playwright's `Tab._downloadStarted`, while the host's ask only looked at tool calls.

**Now the rules are the desktop app's (BGOS #2198).** Every download goes to the host's ask (`lib/browser-downloads.mjs`), with the desktop's download choices, as a card for 60 seconds whatever wait the click carried; it never holds the agent's call, and the agent's next gated action waits for it instead of being told the browser is busy. Chrome writes only into `~/.bgos-agent/<id>/browser-downloads/<person>/held`, inside the agent's own folder; Playwright's own saver is switched off when it loads, and a browser whose folder guard fails refuses downloads. Allow puts the file where the ask said, the agent's browser output folder, under its own name and never over another file, and the agent reads its path in `hoai_browser_status`. Deny deletes it (a Deny is not remembered, as on every gate of this host). Only an explicit Deny deletes: a timeout, a lost card, an answer the host cannot read or a host that stops keeps the file. Kept files sit under opaque names in an owner only folder (0700 and 0600 off Windows; on Windows inheritance removed and the user's SID alone, read back), refused inside OneDrive, Dropbox, iCloud and the like (the host now receives the OneDrive variables for this; Chrome never does) and in a roaming profile, excluded from Time Machine; they are deleted after 7 days by a sweep at start and every hour. The owner is told the moment a file is kept, by a second card whose Deny deletes it at once and whose Allow gives that one file to the agent and remembers nothing; a notice that could not be posted is posted when the pairing next connects, and one posted before a restart is still read after it. The agent reads its latest downloads and every file still kept for the owner as a handle, a name, a size and a state, also after its session closed, and never a kept file's path. Limits for keeping are Kc's: 50 MB a file, 5 files and 500 MB a session, 25 files and 1 GB for the agent; past them no answer deletes the file, and the ask says so. Bytes still arriving are bounded by watching the held folder. A closing session keeps what finished within 5 seconds before Chrome quits. After a crash, a finished download nobody answered comes back kept at the next start (an owner's earlier Allow saves it instead), and a download owed a delete is written down as such before the delete starts, so a delete Windows refuses for a moment is retried and a crash never brings a denied file back as kept.

**Known limits.** The agent runs on this machine as the same OS user, so owner only permissions keep other users out, not the agent's own shell: no tool hands it a kept file or its path, and it is told not to fetch a kept file again. The notice card lasts 30 minutes; after that a kept file goes at 7 days. The gate now reserves the browser before posting a card, so two asks at once post one card, and counts a card's wait from when it was posted. Guards: `test/browser-downloads.test.ts`, `test/hoai-browser-host.downloads.test.ts`, `test/hoai-browser-host.downloads.chromium.test.ts`, `test/browser-gate.test.ts`, `test/browser-env.test.ts`. No version is published here; publishing is Kc's call.

## 0.67.4 (2026-10-12)

**A clone agent no longer loses boards, schedule and browser after a self-update or a watcher update (board bbbf3438 follow-up).** 0.67.2 registered the private turn hook only through `bgos-agent update`. The daemon's own auto-update (`lib/self-update.ts`) and the watcher's update never ran it, so any clone install updating that way restarted onto 0.67.x with no hook in its workspace and every private tool call refused (15 agents of one user on a MacBook Air and 4 on kc-server were one restart away).

Now the self-updater runs the NEW checkout's `bin/hoai-register-hooks.mjs` for the daemon's workspace folders after the pull and BEFORE it asks for a restart (the CLI reads hooks once, at launch), and the daemon registers them at boot when the private turn hook is missing so the next launch has it. Only a workspace whose `.mcp.json` names this checkout's `server.ts` is touched, a marketplace install never is, and a folder that never carried the activity rail gets the rail and the private turn hook but not the blocking floor hook. The hook helper is `lib/clone-hooks.mjs`. The watcher's connector update (`lib/update-executor.mjs`) does the same for each clone agent, once per workspace folder, after the fast-forward and right before that agent's restart (best effort, 30 s budget, never changes the step's outcome).

## 0.67.3 (2026-10-12)

**`bgos-agent update` finishes with the script it just pulled.** The pull is a `git reset --hard`, which replaces the very file the shell is running, so everything after it (hook registration, the restart) ran the OLD function bodies. The first update to 0.67.2 therefore registered no private turn hook and a second run was needed. The update now hands over to the new file right after the pull (`HOAI_UPDATE_REEXEC` stops a second pull and carries the starting version), so a fix shipped in an update applies on the first update.

## 0.67.2 (2026-10-12)

**Boards, schedule and browser tools no longer refuse every call on a clone agent that never had the private turn hook (board row bbbf3438 follow-up).** 0.67.0 runs a private tool only inside a turn whose marker `hoai-private-turn-hook.mjs` wrote. A clone workspace gets that hook only from its own `.claude/settings.local.json`, and `bgos-agent update` refreshed only a folder that already named `hoai-hook.mjs`. Nine agents on KC's Mac had no entry, so after a restart onto 0.67.x every private call answered "its current sender could not be verified", on scheduler wakes and every other turn.

`bgos-agent update` now registers the hooks for a clone workspace (its `.mcp.json` names this checkout's `server.ts`, compared by real path) even when the folder never carried one, and for agents another supervisor keeps alive (a keepalive job, a watchdog) it does so from the folder their `service.json` declares. A folder that never had the hooks gets the activity forwarder and the private turn hook, not the blocking floor hook. The CLI reads hooks at launch, so each agent needs one restart after the update.

The gate itself is unchanged and stays closed without the hook. The daemon now looks once at boot and logs `private turn: the private turn hook is NOT registered for this session` with the fix, and a refused private call says that cause instead of blaming the sender.

## 0.67.1 (2026-10-12)

**A connector update no longer calls an agent deaf when it never restarted it (board row bbbf3438).** The keepalive launcher calls `bin/hoai-keepalive-marker.mjs` through an aliased home path, and the script compared its resolved module URL with that alias, so `main()` never ran: exit 0, nothing written, `keepalive.json` left naming dead pids. The update then had no live session to restart, reported "restarted", and verification failed on the unchanged boot time. The script now compares real paths on both sides, as `hoai-core.mjs` already does.

Four more scripts decided "am I the entry point?" the same way and would also have done nothing when launched through an aliased path: `hoai-hook.mjs`, `bgos-claim.mjs`, `bgos-daemon-wrapper.mjs` and `hoai-private-turn-hook.mjs`. All now compare real paths. When the private turn hook was skipped, private tools were refused (the server finds no marker for the prompt), so the failure was a refusal, not an exposure.

## 0.67.0 (2026-10-11)

Remote browser control returns to the agent ten seconds after the owner's last accepted page click. Typing, scrolling and navigation do not extend that deadline. Physical input still drains before agent work resumes. A request refused during owner control is clearly reported as not started and safe to retry after handback. The bundled browser skill explains the behavior. Protected credential entry and encrypted per-agent profiles retain their separate rules.

Shared browser, schedule and Boards tools stay on the acting person. A card from another person, an unattributed card or a card from another chat that lands while a private turn runs now ends that turn's private identity at once, so the next private call refuses until a new prompt admits one person. A helper agent may use private tools only inside the turn that started it (SubagentStart and a PreToolUse guard). A failed boundary write at Stop or SessionEnd no longer blocks stopping; the marker is invalidated instead. A prompt past the 256 KB forwarder clip keeps its private turn through the prompt hash, and the prompt text is never spooled.

## 0.66.1 (2026-10-11)

**A Windows agent that crashes is started again in the same sweep, not 30 minutes later (board row 69337efa).** On AlienAres (watcher and plugin 0.66.0, Keep agents running on), the sweep had installed the task `HOAI Agent 1078` for test agent 1078. Ares killed only its claude at 07:54:15Z; the plain hoai launcher exited with it, and nothing started the task for 30 minutes while the heartbeat said `supervised canonical` and no task start was counted. The cause: on Windows the sweep started a dead launcher's task only after 30 minutes with no activity (`decideTaskStart` refused on `recentActivity`, `LEGACY_QUIET_WINDOW_MS`), because Windows has no cwd lookup and recent activity was its only stand in for "maybe a session this watcher cannot see". After a crash that activity is the dead session's own last writes: its state, its transcript, its hook spool.

**Now the process table answers.** When the launcher is dead and no live daemon says the agent runs (no fresh state, no live holder of its pairing lock), the sweep looks in the listing it already reads for a claude of this agent, by what a Windows listing carries (`lib/process-tree.mjs` `findAgentClaudePids`): the agent's pinned session id on a command line (hoai-core starts claude with `--resume <pin>` or `--session-id <pin>`), its folder as a whole argument on a command line (a claude installed under the folder, as for an agent paired in the home folder, is not one run in it), or a process of record that still runs (the claude or the daemon its last state named, its lock's holder; each only while its start time shows it is the same process and not a reused pid). None listed: the task is started in that sweep. One listed: the start waits (`session_without_launcher`) even with no recent activity, where it used to start a second session on the same pin beside it. Only a listing that cannot be read, or a lock holder that still runs with no claude visible above it (an orphaned or hung daemon, or a claude whose command line the watcher cannot read), keeps the 30 minute quiet window. The first install of a task is unchanged (started only when nothing says the agent may run); the sweep after it starts a crashed agent as above.

**A start that waits says so, and when.** The row is `waiting_idle` with its reason, never `supervised`: `quiet_window` (the listing could not be read and the agent was active), `task_start_rate_limited` (was `supervised task_start_rate_limited`), `one_restart_per_sweep`, and `session_without_launcher` (a session of the agent runs without its launcher; with no update pending this used to read `supervised canonical`). The heartbeat entry carries `restartAt`, an ISO time re-serialised by the plugin (no path, no free text), when the start can run: 30 minutes after the newest activity for `quiet_window`, 30 minutes after the last start for `task_start_rate_limited`, absent when nobody can know (the end of a session, the next sweep). None of these waits carries `pending`, so the app offers no Restart now for them. The backend keeps only the agent keys it names (`sanitizeAgent` in `backend/src/integrations/watcher-health.ts`: id, state, reason, since, waitingSince, pending), so the state and the reason reach the app today, and `restartAt` once the backend keeps it (an ISO time, the check `bundle.lastRefresh.at` already has).

**The limits stay, and a task start now counts as the sweep's one restart.** One start per agent per 30 minutes and 3 per launcher death episode, then `failed task_start_failed`, are unchanged, so a crash loop is still bounded: three starts in about an hour, then a visible failure. The module said a task start had the same limits as a restart, one per sweep included, but nothing counted it there: now it does, so two agents that crash together are started a minute apart, and a task start and an update restart never land in the same sweep. Nothing new is written outside the watcher's own folder. Guards: `test/watcher-keepalive.test.ts`, `test/keepalive-plan.test.ts`, `test/process-tree.test.ts`. No version is published here; publishing is Kc's call.

## 0.66.0 (2026-10-11)

**The plugin answers the skills view: list the skills an agent loads, and remove one of its own (skills view row 3, board rows 01a12481 and cc6dda66).** A new `skills_rpc` op `list_installed` walks the roots Claude Code reads (agent, repo, computer, synced, plugin, managed), with the agent folder taken from `BGOS_LAUNCH_CWD` only (never the plugin cache cwd) and the config dir from the resolved `CLAUDE_CONFIG_DIR`. Only the head of each SKILL.md is read, a file whose realpath leaves its skill folder is never read, and name and description pass the secret scanner. Each row carries a display path with the home as `~` and `/` separators on every OS (Windows included, `lib/skills-inventory.ts` `displayPath`), its provenance, and `removable` only for the agent scope. `remove` moves one agent scope skill to the plugin state trash, outside every skills root, and refuses every other scope, `.` and `..` segments, any other path, a linked `.claude` or `.claude/skills` and an agent folder that is the computer's. The daemon declares `skills_list`. This version carries #201 and #206 together, green on Windows: the install path runs the win32 branch on a Windows host in its tests too, and the unreadable file cases use an ACL deny there, since mode bits do not gate reads on Windows.

**An agent can share one of its skills with another agent, and receive one (skills view row 6, Claude Code part, board row 01a12481).** Two new `skills_rpc` ops answer the Share backend (BGOS #2216). `export_skill {name, scope, dryRun}` reads one skill folder of this agent (scope `agent`, `<launch folder>/.claude/skills`) or of this computer (scope `computer`, the config dir's `skills`, never `synced`), found the way the skills list names its rows (frontmatter name, else folder name; a folder the list does not show is never read, and two rows of one name are refused), applies the shared content rules and answers the files they send, each with its sha256, plus the bundle sha256, the excluded files with why, the scan rule ids and the block, if any. The walk follows no link at all (a link inside the folder could name a dot or secret file under a harmless name), leaves behind hard linked files, anything not a regular file and every dot folder unread, reads at most 51 files of at most 64 KB plus one byte, leaves a file that is not UTF-8 behind as not text, says `too_large` past any bound instead of sending a folder with files missing, and refuses (`read_failed`) a folder with a file or subfolder it cannot read. A secret never leaves the computer: a secret in any file or in any name the walk leaves behind refuses the export (`share_blocked`) even for a preview and whatever other block outranks it, and so does a too large or binary skill, whose cut or lossily decoded file could carry part of one; a skill the list hides for a secret shaped name is never found. A preview (`dryRun` exactly `true`) answers a runs commands or invalid verdict with the content so the sheet can say why; the real export of any blocked skill is refused and carries no content. A shell fence opened anywhere in a line (Claude Code runs ```` ```! ```` with no line anchor) counts as runs commands on export and on install, on top of the shared rules, which only see one at the start of a line; the backend twin should adopt that with a rules version bump.

**`install_bundle {offerId, name, files, sha256, replace?}` writes an approved bundle into this agent's own skills folder and nowhere else.** Every file's sha256 and the bundle's are checked (`hash_mismatch`), then the content rules run again, so a script, a dot file, executable frontmatter or a shell line refuses the whole bundle. Refused before anything is written (`scope_refused`): a name outside Claude Code's rule (and a Windows reserved one on Windows), a path that is absolute, has a `.` or `..` segment, a backslash or a drive, a `.claude` or `.claude/skills` that is a link, an agent folder whose skills folder is or sits inside the computer's, the managed one or a repo level one (an agent launched in the home folder included), and no launch folder at all (`not_supported`). An existing skill of the same name in any case is `name_taken` unless `replace`, which moves the old copy to the plugin state trash first and puts it back if the new one cannot be moved in. The files are written into a temp folder beside the skills folder (never inside it), read back and hashed, then renamed into a name claimed with `mkdir`, so nothing half written is ever loaded. Progress (`verifying`, `writing`) goes to the backend's `/progress` lane. The backend's resend and a second Install tap carry a new rpcId: an install in flight for the same `offerId` is joined, an installed one is answered again from memory, and after a restart a folder on disk that hashes to the bundle answers installed instead of `name_taken`. A failed install may be retried.

**The rules are the backend's, byte for byte.** `lib/skill-share-content-rules.ts` ports `backend/src/skills/skill-share-content-rules.ts` (rules version 1) onto this plugin's twin secret scanner, and `lib/skill-share-content-fixture.ts` is the backend's fixture copied byte for byte and pinned by the same sha256; all 46 cases give the backend's verdicts. The daemon declares `skills_receive` on every host, right after `skills_list`. No MCP notification is added. Mutation proven. No version is published here; publishing is Kc's call.

## 0.65.5 (2026-10-11)

**A generic `POST /messages` now names the agent that wrote it (board row 019ff949).** The backend reads the writing agent on that route only from the `X-Caller-Assistant-Id` header, and this daemon never sent it there, so every hook rail card, plan, question carousel, component card and permission card it posted was logged by the backend's `raw_chatid_shadow` line with `callerAssistantId: null`. On 2026-10-10 that was 3,445 of 3,907 lines, and a null line cannot say which agent still addresses chats by raw id, the one question that gates turning `ALLOW_RAW_CHATID` off. `bgosPost` now adds the header for the exact `messages` route (`lib/messages-caller-header.ts`); every other route is unchanged, an explicit header still wins, and a chat this daemon knows is a meeting or a peer side-thread gets no header: in a meeting a caller id would let a hook rail card into the shared transcript, and in a CLOSED side-thread it would make the backend reopen the conversation (and hand the turn to the peer) before refusing the post 400 `a2a_wrong_route`; without it nothing is written there, as before. For an owner's own chat nothing else changes: the backend checks that the named agent belongs to the authenticated owner. Guard: `test/messages-caller-header.test.ts`.

## 0.65.4 (2026-10-11)

**The watcher follows the installed plugin by itself, with no job and no reinstall (board row 0c659c85, raised on Data's word).** Before this version the per machine watcher refreshed its own bundle only at the end of a reconcile job, which only the owner's Update or Reconcile sends. Its manifest names the versioned cache folder the bundle was copied from, and a marketplace update leaves that folder on disk unchanged, so nothing on the computer ever read the bundle as stale. On AlienAres (Windows 11) the watcher ran 0.61.1 from 2026-10-05 while the plugin moved to 0.63.2, without the supervisor arm 0.62.0 added for Keep agents running, and its heartbeat only ever said 0.61.1.

**Now, right after each heartbeat (once a minute), between jobs**, the watcher compares the bundle it runs (hashed when it started) with the watcher files of the CURRENT install: the `installPath` that `installed_plugins.json` names for a marketplace install (under the manifest's `CLAUDE_CONFIG_DIR` when it records one, else under the config dir the cache folder itself sits in), the checkout itself for a clone, so a clone's watcher follows what is checked out. When they differ it runs the staged swap a job runs: copy into `next/`, load the copy under the service's node (`hoai-watcher help`), swap, and leave the way a job's refresh leaves (exit 75 for launchd and systemd, on Windows a successor through `run-hidden.vbs`, then exit). It never runs inside a job or a keep-alive sweep: their heartbeats only report. A staged copy that does not load, or is incomplete, is cleared and the live bundle keeps running. The comparison is by content, so a bundle already refreshed from that install does not read stale again, whatever fingerprint an older installer recorded. A release that stops shipping a file an older watcher lists is still followed: the copy takes this code's list minus what the install no longer has, plus the install's own import closure, checked complete and probed as before.

**Bounded.** Every attempt is written to the watcher's `state.json` (`bundleRefresh`) before anything is copied and again before the process leaves, and it outlives restarts: after a swap the next attempt waits 10 minutes, after a failure or a refusal an hour, and while the watcher runs exactly the bundle a swap put in place, that swap's target is never swapped to again, so a swap that somehow still reads stale stays reported instead of repeating (a bundle moved away by anything else is brought back as usual). Refused by name, with no swap: an installed plugin OLDER than the bundle (no automatic downgrade); on Windows a watcher folder without `run-hidden.vbs` (exiting would leave no watcher until the next logon); on Linux any other process in the watcher's own cgroup, or a cgroup it cannot read (systemd ends the whole cgroup of the unit when the watcher exits, so an agent the watcher started through tmux or script would die with it). On Windows a successor that does not start leaves this watcher running on its old code instead of exiting, recorded as `no_successor` and retried after an hour. Everything it writes stays in `~/.bgos-agent/watcher`. A manual `hoai-watcher reconcile` still never swaps.

**Reported.** The heartbeat's `env.watcherHealth.bundle` carries `bundleVersion`, `installedVersion`, `stale` (null with a `reason`: `no_manifest`, `not_installed`, `plugin_root_missing`, `plugin_root_unknown`) and `lastRefresh` (`at`, `outcome`, scrubbed of the home path and the user name). It rides inside `watcherHealth` because the backend takes that field leniently (never a 400, strict validation or not); today's backend sanitizer keeps only the keys it knows, so showing `bundle` in the app needs the backend to keep it in `sanitizeWatcherHealth`. **Also fixed:** a swap (a job's too) wrote the new manifest without the agents' `claudeConfigDir`, which the service environment does not carry, so a watcher on a custom config dir lost it at its first refresh; it is kept now, and a manifest that already lost it gets it back at the next automatic refresh.

**A watcher already installed (0.61.x up to this version) still runs the old code**, which refreshes only at the end of a reconcile job, so it needs one nudge after this version is published: one Update (or Reconcile) job from the app to that computer's watcher. The job runs its normal plan first (it may update the plugin and restart agents) and ends with the `refresh_watcher` step, which brings this code in; from then on the watcher follows by itself. Guard: `test/watcher-self-refresh.test.ts` (22 tests: the real loop, the real `installed_plugins.json` reader, the real installer, POSIX and Windows paths, and one run of this checkout's real bundle through the real probe), red on 0.65.2. No version is published here; publishing is Kc's call.

## 0.65.3 (2026-10-11)

**A daemon that stands down now tells the backend, in tokens only (board row fc75c7c3, identity race plan step 3).** Until now a daemon that refused, went passive, lost the pairing lock, died or switched a duty off told only its own log, so nobody could count the strays, or the agents still answering by elimination. Each of the twelve sites in the plan's list now sends one report: `POST /api/v1/integrations/stand-downs` (BGOS #2189) under the pairing token the heartbeat sends, with a body of exactly `{reason, route, phase, machineId, pluginVersion, at}`. The reasons are the backend's eight: `refuse_home_mismatch` (the home refusal), `passive_at_boot`, `lock_lost` (five places: the tick, the re-arm gate, a re-arm without the lock, and both ends of the first arm), `arm_failed` (an arm that throws after a promotion), `exit_uncaught`, `exit_boot_fatal`, `always_on_unsupported` (a Windows daemon, and only when Keep agents running is known to be on for the agent: the daemon reads the agent's `alwaysOn` once, so off, unknown or a failed read sends nothing) and `always_on_supervisor_missing`. The route is the fine one the resolver chose (`env-path`, `env-assistant`, `folder-pin`, `sole-per-assistant`, `legacy`, or `unknown`), never the pairing lock's `pin`, `env` or `elimination`. The phase is `boot` until delivery is first armed and `run` after. The eight other sites send nothing: the several agents refusal (no single pairing), the unpaired stub (no credentials), a normal shutdown, the self-update restart (its readiness already reports it), the update stream on a revoked pairing, and the three per chat refusals the backend issued.

**A report never gets in the way.** One attempt, bounded at 2 s for headers and body, never retried (not a 400, not a 401, nothing), never redirected (a redirect would carry the token elsewhere), and it never throws. At most one report per reason and phase per process: that dedupe is the rate limit, so a lock that flaps all day sends one `lock_lost` per phase. After a 401 the token is refused and nothing more is sent. A boot never waits for one. The two exit sites (an uncaught exception, `main()` failing) send theirs from a child process and block on it, 2 s at most, so nothing else in the daemon runs between the fault and the exit, as before (no poll, arm or socket frame can slip into that window). The home refusal starts its report before it serves the notice and waits for what is left of the 2 s only once the host has gone. A value the backend would refuse is never sent, and a site with no pairing credentials (unpaired, or an API key install) sends nothing. No folder, path, pid, session id, error text or token is in any body or log line; the exit path hands the token to its child on stdin, never on a command line. The machine id is read for a report, never minted (the heartbeat mints it), so a refused stray still writes nothing; its one new use of the token is the report itself. The version is read once at boot, so a clone updated in place reports the code that is running.

**The heartbeat says how the daemon found its identity.** `env.identityRoute` (the same fine route) and `env.homeConfirmed` (whether it passed the home check) ride every full beat. Only a listed route and a real boolean are sent.

**Data's contract test.** The backend's token lists are copied into `test/stand-down-report.test.ts` and pinned: a drift on either side, a report or heartbeat sending `pin`, `env` or `elimination` as a route, or any key outside the lists, goes red. `test/stand-down-sites.test.ts` finds each site in server.ts by its syntax, lifts it with the daemon's own wiring and runs it against a local fake backend: each of the twelve was red before this change and is green now, and each of the eight is proven silent. Mutation proven.

**`hoai doctor`: a workspace .mcp.json server beside the marketplace install is WARN, not FAIL (Data, kc-server agent 867).** On that shape the agent launches through the workspace (or clone) `.mcp.json` server and the marketplace install is kept on purpose, because it supplies hoai-browser, the hooks and the skills. 0.65.2 failed the Channel route row with "TWO routes on this host" and a fix line saying that removing the marketplace install is what clears it. The row is now WARN (a new fifth status, which like UNPROVEN never fails the bootstrap's preflight gate and prints no Fix line), says it is a supported shape, and no line of it says to remove the marketplace install. Every other duplicate (a clone install beside a workspace server of another name, or a `.mcp.json` declaring two HOAI servers) keeps its FAIL. Mutation proven. No version is published here; publishing is Kc's call.

## 0.65.2 (2026-10-10)

**`hoai doctor` finds an agent's identity the way the daemon does, so a computer that runs several agents under an env pin no longer reads as broken (board row fc75c7c3, found by the n8n Guru canary of 0.65.0 on kc-server, agent 867).** kc-server runs seven agents under systemd. Each is identified by `BGOS_ASSISTANT_ID` or `BGOS_CREDENTIALS_PATH` in the `env` block of its own `.mcp.json`, each has its own `credentials-<id>.json`, and no folder holds a `.bgos-agent-id`. The agents boot and run. The doctor did not see that pin: it read only its own flag, its own environment and the folder pin, so the daemon its handshake started had no identity and refused ("REFUSING to start: this host has 7 paired agents ... no identity pin"), and its credentials row looked for a single `credentials.json`. A computer with one `credentials-<id>.json` and no `credentials.json` read as unpaired for the same reason.

**The rule is the daemon's, run in the agent's folder.** Strongest first: the env pin, with the folder's `.mcp.json` env block over the shell's environment (Claude Code hands the block to the daemon it starts; a block that sets the id to nothing or to the unsubstituted placeholder still overrides the shell's value, and `${VAR}` and `${VAR:-default}` in it are expanded from the shell, an id that came out of the shell having to be a number and never being printed), then a `.bgos-agent-id` folder pin (a pin naming an agent with no credentials file is ignored, as the daemon ignores it), then elimination: the only paired agent, else the shared `credentials.json`, else several paired agents and a refusal. The doctor's copy of that rule is pinned to the daemon's own resolver by a test over 2560 combinations of those signals. The handshake child is handed what Claude Code would hand the daemon (the `.mcp.json` id and path, and `--assistant-id` as before); a folder pin is not injected, the daemon finds it from the folder it is started in, as in a real launch. The log path and the channel-live marker use the same identity.

**What it prints.** The credentials row names the file, where the identity came from (the env block of that `.mcp.json`, the shell, the folder pin, or elimination, with a note when a pin or a shell value was ignored or overridden) and the home with its source, as in 0.65.0. With `--assistant-id` it also says what a session started in the folder without the flag would do, when that is not that agent. A folder whose `.bgos-agent-id` and `.mcp.json` name two different agents fails the row, because `hoai` will not launch it, although the daemon alone would answer as the env pin.

**A refused daemon is still never healthy.** In a folder nothing names, on a computer with several paired agents, the handshake fails with the daemon's own refusal and the credentials row fails with both remedies (write the id into `.bgos-agent-id`, or set `BGOS_ASSISTANT_ID` in the env block of `.mcp.json`), without guessing which agent, and says the doctor looked only at its own environment, the `.mcp.json` and the pin (a systemd `Environment=` line or the supervisor's `HOAI_SUPERVISED_ASSISTANT_ID` is not visible to it). Two servers in a `.mcp.json` naming two agents, or a `${VAR}` the shell does not set, fail the row and say why. The doctor prints no token and writes no pin or credentials file; a test asserts both on every shape it runs (seven agents with the pin in `.mcp.json`, the pin in the environment, the folder pin, both, one agent by elimination, and a folder nothing names).

## 0.65.1 (2026-10-10)

**Agents now get each attachment's details as the instructions promised (board row 01a1266e).** The session instructions told agents every message may carry a `files` array in `meta`; no lane sent one, and meeting turn cards dropped attachments entirely. `meta.files` is now a JSON string (the harness drops a card whose meta holds a non-string value) with `name`, `kind`, `mimeType` and an http(s) `url`, omitted when a message has none, on the socket, poll and stream lanes alike. Meeting turn cards carry the same lines and meta; one built from the meeting broadcast, which carries no files today, says `files_unknown: "true"` instead of implying there were none. A file the server could not link is named to the agent rather than silently dropped. Guard: `test/inbound-files-meta.test.ts` (62 tests; a raw array in meta turns 20 red).

## 0.65.0 (2026-10-10)

**A stray Claude Code session can no longer claim an agent's home folder, and the agent takes its channel back from one (board row fc75c7c3, options A and D of the identity race plan).** On a computer with one paired agent every Claude Code session starts a bgos daemon, and one started in a folder with no pin finds the agent by elimination. Up to 0.64.3 such a stray, booting while the agent was down, took the pairing lock (the lock picked whoever came first), answered in the agent's chats, and after 60 s holding the channel wrote its own folder into the agent's credentials file as `homeDir`. From then on every stray in that folder passed the home check and could repoint the agent's resume pin (Ares, 2026-09-19: the BGOS repo recorded as Ares' home, fixed by hand). The race is now a test (`test/identity-race.test.ts`, real temp files, the same lib calls server.ts makes): red on 0.64.3, where the stray writes its folder as the home at 60 s and the pinned agent cannot take the lock back, and green here.

**Who may write the home.** Pairing writes the folder it pairs in, the folder it bakes the pin into, as `homeDir` with `homeSource: "pairing"` (only when an agent is bound, as for the pin; a re-pair rewrites both). A daemon that found its identity through the folder pin confirms an unconfirmed home with its own folder (`homeSource: "pin"`) on its first held tick, and logs a WARN naming both folders when that replaces a different one, with the pin that keeps the old folder working. Every home written up to 0.64.3 has no `homeSource` and counts as unconfirmed: it is still enforced against elimination starts as before, and the agent's next start from its pinned folder, or a re-pair, replaces it, Ares' included. No credentials file needs a hand edit. A daemon that found its identity by elimination never writes the home (the 60 s self record is gone), and one with no home to check against has not passed the home check: it still starts, but it neither repoints the resume pin (`~/.bgos-agent/<id>/session-id`) nor serves the owner's Memory and Changes panels, and its boot log says so in one WARN line with the fix. Kept on purpose (the plan's choice 2): a start that matches an unconfirmed home passes the check, because unpinned agents whose home 0.64.3 recorded correctly rely on it; on a host in the Ares state that window closes at the agent's next pinned start.

**The env route** (`BGOS_ASSISTANT_ID` or `BGOS_CREDENTIALS_PATH`) keeps working and is never refused, wherever the variable reaches the daemon (a clone's `.mcp.json`, a filled `assistant_id`, a variable set for the user). It confirms a home only when its launch folder also carries the pin for the same agent: the env var says which agent, but every child process inherits it in whatever folder it runs, so on its own it cannot say where the agent lives. An agent the environment names that has no credentials file of its own (a bgos-claim agent on an API key, which the resolver serves from the legacy file) passes the home check as it did before. Not verified here: whether hoai's supervised hand-off of `BGOS_ASSISTANT_ID` (the Windows logon task) reaches a marketplace daemon past the plugin's own env block; a supervised agent in its pinned folder resolves through the pin either way. Multi-agent hosts are unchanged; they already refuse elimination.

**A pinned agent wins the pairing lock from a stray.** The lock file records one more word, `route`: `pin`, `env` or `elimination`. No folder is stored. A pinned daemon (pin or env) takes the lock from a live holder whose route is `elimination` (`route-takeover`, logged with both pids), and the stray stands down on its next heartbeat. It never takes the lock from a holder pinned to the same agent (Data's guard: two pinned sessions never take it from each other), never from a 0.64.x record with no route (mixed versions behave as today), never while its own channel is proven not loaded (0.63.2's rule), and never from a holder whose channel is proven loaded unless its own is proven loaded too: an agent relaunched from an unpinned folder keeps its channel when a bare `claude` is opened in its pinned folder, while hoai's own start, which carries the channel on its command line, still takes it. A daemon that came by elimination never takes the lock from a pinned holder, not even by the 0.63.2 channel rule, so the two cannot flap: a test over every pair of routes and channel states shows the holder changes at most once.

**A refused stray is told, not dropped.** A session the home check refuses used to exit before the MCP handshake, which Claude Code shows only as a failed server. It now serves a one tool notice, `hoai_not_this_agent`, as an unpaired install already does: no channel capability, no server instructions (a refused session is usually the owner's own, so nothing goes into its prompt), a short description that names the agent it refused, and when called the reason with both folders, the fixes for the owner, and a line telling the model not to create or edit `.bgos-agent-id` unless the owner asks. It uses no token, takes no lock and writes nothing. `hoai doctor` prints the home and its source in the credentials row and notes when a session started in its folder would be refused, and its handshake check now fails a server that answers with a one tool notice instead of a channel, so it no longer reads a refused or unpaired daemon as healthy. `hoai` prints a WARNING naming the home and the pin when it launches the sole agent from a folder its daemon will refuse. The one start that newly refuses is a start from an unpinned folder other than the agent's recorded home once pairing has written one; its notice and the hoai line name both folders. The stand-down reports to the backend and their 0.65.1 sender are separate work. No version is published here; publishing is Kc's call.

## 0.64.3 (2026-10-10)

**A /goal whose condition carries a previous command joined to its front is refused, not armed (board row 102a3966).** Four missions have ever been created by the typed /goal path and three of them are titled `clear/goal <something>`: a driver or a paste sends `clear` and `/goal <condition>` with no newline between them, the TUI joins them into one line, and the condition the runtime reports carries the previous command. Creating a mission sets the open one aside, so on 2026-10-05 a mission at 11 of 12 went abandoned in the same second mission 74 was created from such a line. The daemon now refuses two shapes only, a leading `/` and `<word>/goal ` (letters with no space before the command name, which cannot occur in a sentence), so it creates nothing and sets no card aside, and the person sees an error naming what it saw. Refusing rather than stripping, because a stripped guess would still create a mission. A false positive control keeps five conditions someone could mean (for example `the q3/goal split is reported in one table`). Mutation proven both ways: removing the guard reds the refusal tests, widening it to any slash reds the control alone.

## 0.64.2 (2026-10-10)

**The daemon tells the server what its session is doing, on the heartbeat it already sends.** A `sessionStatus` block (facts only: whether a task is open, questions and messages waiting, the oldest waiting message, what is running, and when the SESSION last did anything) rides every heartbeat and its own small beat (`{ sessionStatus }`) within a minute of a change and every 2 minutes while work is owed, from the pairing lock holder only. The shape is the shared contract `lib/session-status-contract.ts`, a byte identical copy of the BGOS file, pinned by sha256 here, in BGOS and in codex-channel-bgos. The server judges it into a word and only logs it for two weeks; nothing in the app changes yet. **The not responding verdict goes out at once** (and its clearing), from the lock holder, instead of on the next 6 hourly beat. **The daemon's unprompted texts are marked** with `postedBy: 'connection'` (the deaf warning, the goal and plan notices), so the server's stall sweep stops reading them as the agent answering; its answers to the owner's own commands (/status, /login, /compact, "Asked to stop.") stay unmarked, because they answer a row the owner wrote. Release order: the backend first; an older backend ignores both fields only while its validation stays lenient. No version is chosen here; publishing is Kc's call.

## 0.64.1 (2026-10-10)

**A steer sent right after a Send now attachment is answered at once and obeyed, not refused, ignored or late (BGOS #2140).** Visual QA (three runs on a real session): the owner pressed Send now on an attachment row during a long command, a plain channel message the CLI holds until the command ends, then Steer on a text row. The daemon pressed Escape first and delivered the steer text 800 ms later, so the held attachment opened the next turn alone and the steer landed mid turn: once refused as "from an external channel", once ignored (the model re-ran the task the steer dropped), once answered 12.1 s late. Reproduced on 0.64.0 here: the model re-ran the 150 s command and then refused the steer as not from the owner. The order is now reversed. The gate decides whether it will press (the same plan, cooldown, busy and once per message rules) BEFORE anything is delivered, delivers the steer text first while the turn still runs, so the CLI queues it behind the held message, waits 500 ms (`STEER_QUEUE_MS`), then presses the one Escape. Both queued messages open the next turn together and in order. The `steer="true"` marker is set from that decision, and the decision is kept: from it to the Escape the press owns the composer, so the daemon's own /compact and /goal typing waits for it (`pressDone`) instead of racing it, and the pane is probed before a marked delivery (a pane that is gone gets the text plainly). A failed delivery presses nothing, so a retry delivers and presses once. An ordinary message that arrives during the half second is delivered before the Escape and joins the same next turn. Proven live on macOS (Claude Code 2.1.296) through this daemon on the final code: the attachment then steer repro passed three runs in a row, each steer answered and obeyed about 2 s after the daemon received it, and a single steer interrupted 0.6 s after receipt (docs/reports/2026-10-10-steer-deliver-first; four more passing runs on the code before review are kept there too). The app floor (`CLAUDE_STEER_SINCE` 0.64.0) and the cross repo hash are unchanged. Mutation proven.

## 0.64.0 (2026-10-09)

**Send now is a real steer: it interrupts the running turn and the text is answered at once (KC 2026-10-03, msg 98508).** A channel message sent during a turn waits for the next tool boundary, so a queued follow up sent behind a two minute command waited two minutes. Where the daemon has tmux control of the CLI pane (the supervisor path remote /compact already uses), it now advertises `steer` in its synced catalog, and a `/steer {text}` from the app presses ONE fixed Escape key in the pane, waits 800 ms, and delivers the text as an ordinary message (attachment lines and prefixes kept), marked `steer="true"` only when the Escape was really pressed. No chat text ever reaches tmux: the Escape is a fixed key name (`buildInterruptSteps`), the words go through the channel. The text is ALWAYS delivered: with no running turn (the hook rail says idle) nothing is pressed; a share recipient's steer, a backlog or replayed one older than two minutes, one arriving while a relayed permission prompt is open, and one sent from a chat other than the one whose turn the hooks say is running are delivered plainly with no key; a failed Escape still delivers. Steers run one at a time through one gate: never two Escapes within 3 s (Claude Code fires no Stop on an interrupt, so the hook rail still reads live), none while the daemon is typing /compact or /goal itself, never a second for the same message, and a message arriving behind a steer in flight is delivered after it. Without a tmux target the catalog carries no `steer`, so the app sends plainly and nothing calls itself a steer that only queues. `steer` is reserved like `/compact`: a user or project command of that name is not synced and cannot shadow it. The app floors Claude Code steer on this version (`CLAUDE_STEER_SINCE` 0.64.0) and both repos pin the hash of `steer;slash_command;/steer {text};0.64.0`. Proven live on macOS (Claude Code 2.1.295) with this daemon: a 150 s foreground command interrupted under a second after the steer reached the daemon and the steer answered through `reply` about a second after that; an idle steer answered with no key pressed; a backlog steer delivered with no key (docs/reports/2026-10-09-steer-interrupt). 31 new tests, each mutation proven.

## 0.63.2 (2026-10-09)

**A daemon whose channel is not loaded in its session no longer holds the pairing over a sibling whose channel is (assistant 873).** A session launched with `--dangerously-load-development-channels server:bgos` (a clone in .mcp.json) whose global settings also enable `hoai@hoai` starts two daemons for one pairing, and only the clone's channel is registered. Both raced for the pairing lock; when the plugin won, every inbound message went into a channel Claude Code drops, for five hours on kc-server. Each daemon now reads whether its own channel is loaded off the claude command line above it (`--channels` / `--dangerously-load-development-channels`, matched against `plugin:hoai@<marketplace>` for a marketplace install and `server:bgos` for a clone) and records `channelLoaded` in the lock file. A daemon whose channel is loaded takes the lock from a live holder that recorded `channelLoaded: false`, and the holder stands down on its next heartbeat; a daemon whose channel is not loaded never takes the lock from a live holder. Anything not proven (no claude above us, a claude command line that shows no arguments at all, Windows, an unidentified install, a clone whose session names some other `server:` channel, or a holder from an older version that records nothing) keeps the lock exactly as before. Proven on macOS (Claude Code 2.1.295) that the MCP initialize request is identical for a channel server and a plain one, so the command line is the only signal. The takeover and the yield each log one line naming the reason. Both daemons must run 0.63.2 for the takeover to happen. Mutation proven.

## 0.63.1 (2026-10-09)

**Keep working has no turn cap by default, and the no progress stop still holds without one (board row 20e7ac50).** KC approved 2026-09-28 that the 30 minute Keep working wake alone drives a mission, with no per reply goal check cap unless the owner chose one. `decideGoalStop` used to return early on a missing cap, which also switched off the no progress stop (three checks in a row with the same finding), the one protection against a goal looping forever. The two rules are now gated separately: the turn cap runs only when there is a number, and the stall stop runs whenever the owner's Keep working armed the goal, cap or not. A goal a person typed in their own terminal still has neither and is still left alone. The daemon declares a new token, `mission_goal_uncapped`, wherever it declares `mission_goal_loop`; the backend leaves a Keep working mission uncapped by default only for a daemon declaring it and fills the old 20 for every other one, so this release and the backend change can ship in either order. Mutation proven (six mutations).
## 0.63.0 (2026-10-09)

**The daemon tells HOAI when this computer's Claude login has expired or hit its limit (BGOS board e5d0fb3a).** A failed login is written into the session transcript as `error: "authentication_failed"`, and a usage cap as `error: "rate_limit"`. A 30 second sweep reads them, keeps the first failure time, and clears only on real activity or a completed /login. The state goes out on the heartbeat as `lastError` code `claude_login_expired` or `claude_usage_limit`, with a beat sent at once when it changes, plus a non-secret `claudeAccountKey` and the account label. The backend groups these by machine and tells the owner once per outage (BGOS #2107, off by default there). 14 mutations, all caught.

## 0.62.3 (2026-10-08)

**A tool card a group refuses is refused once, not on every tool call (bug 0cd3eca1).** The backend refuses an agent's tool card posted into a room or channel with 400 "Agent messages into a group must use /send-message", on purpose: a stamped agent row would stop the room's working line keepalive and trip the room loop guard. The hook rail did not know that refusal, so every tool call in a group posted again, got another 400 and logged another line. It is now read as permanent for that chat, the same narrow way as the other two (the 400 and the message whole, or a `group_route_required` code), and the rail stops posting cards there. Mutation proven.

## 0.62.2 (2026-10-08)

**The a2a route refusal is recognised by the code the backend actually ships.** BGOS #2038 sends the 400 "A2A messages must use /send-message" with `code: a2a_wrong_route`; this plugin had guessed `a2a_route_required`. Both are accepted now, and the message text match still answers for a backend that sends no code. Found by Ares's check of 0.62.1 against #2038.

**A permission approval card no longer posts into a chat that has refused this agent for good.** The card went to the first monitored chat unconditionally, so when that chat was a peer side-thread every approval request posted again, was refused again and failed closed again. It now goes to the first monitored chat that has not refused, a refused card is remembered, and when every monitored chat has refused the request is denied, as it is with no chat at all (`pickPermissionChat`). Both mutation proven.

## 0.62.1 (2026-10-07)

**A plugin clone on a prerelease version now reports it.** `readOwnVersion` accepted only strict X.Y.Z, so a clone on `0.62.1-local` reported `runningVersion null` and the watcher never restarted it onto a staged update (found by the mission 104 goal 4 proof). It now accepts the same shape the backend heartbeat and the watcher already accept (`X.Y.Z` plus an optional suffix, at most 32 characters). Self-update still compares strict X.Y.Z only, so nothing about published updates changes. Mutation proven.

**A write refused with "Caller assistant is not a participant of this peer conversation." is tried once, never looped (board row a80d3683).** Measured 2026-10-07: pairing 97 (assistant 947, 0.61.4) was refused 378 times in one hour on `POST /api/v1/messages` with that reason, and pairings 99, 106 and 137 at 111, 24 and 22. That route is the hook rail's. A turn in a peer side-thread posts its tool card there, the backend reads the caller assistant on that route only from an `X-Caller-Assistant-Id` header the daemon does not send, so every card into a side-thread with an open conversation is refused (sending the header would not help: that route refuses a side-thread write anyway, with a 400); a refused card minted no id, and the next 600 ms flush posted it again, up to 6000 times an hour.

The refusal is now read as permanent from the status and the WHOLE body: a 403 whose `message` is that reason, matched whole and anchored, or whose `code` is `peer_not_participant` once the backend sends one. Never from the error sentence, a substring, or a number in a URL (`lib/peer-refusal.ts`). The rail makes one attempt per chat, logs why once, and posts no more cards or markers there; every other chat is unaffected. A `reply` refused the same way returns a typed `peer_not_participant` result that tells the agent the conversation open there is not one it is in (its own has closed, or it never was), not to retry, and to tell its owner only if it matters. Later replies into that chat are answered locally until something new happens there (a new message, a close, or a `send_to_peer` that lands in it), and the inbound it was answering is dropped, so the reply-overdue sweep no longer asks for that reply again; a message that arrives while the refused reply is still in flight keeps its tracker and leaves the chat unblocked. Every other 403 and every 5xx behaves as before; a failed POST is now an `HttpError`, so its log line reads `HttpError: POST ...`, as a failed PUT already did. No version is chosen here; the release that carries it is Kc's call.

**A closed side-thread no longer loops on "A2A messages must use /send-message" (the review of #186).** Once a side-thread's conversation is closed the participant check passes, and `POST /api/v1/messages` refuses every card and marker with `400 {"message":"A2A messages must use /send-message","operation":"MESSAGE"}` instead: an a2a chat takes writes only through `/send-message`. Nothing classified that 400, so the rail posted the same card again on every 600 ms flush, 6006 posts in a simulated hour (6000 cards and 6 markers) against a mocked backend answering that exact body. The backend's denial log, which counted the 403s, logs no 400, so it never counted this loop (its only trace is the participation check's legacy a2a warning, one line per post). The same classifier (`lib/peer-refusal.ts`) now also reads it as permanent: status 400 with that `message` whole and anchored, or a `code` of `a2a_route_required` once the backend sends one, and neither reason counts on the other's status. The rail makes one attempt per chat, as it does for the 403, and logs the right status once. `show_component`, `ask_user_input` and `propose_plan`, the tools that post there, return a typed `a2a_route_required` result: the chat is a peer side-thread, do not retry, anything for the owner belongs in the owner's chat, and a reply there reaches the peer agent and reopens a closed conversation, so send one only if the peer needs to hear it. Later calls into that chat are answered locally, and the rail and the tools share what either learned first, so neither posts there again (`propose_plan` already refused a side-thread it knew about; this covers one it did not, as after a restart). A chat's kind never changes, so nothing lifts that. `reply` keeps its typed answer for the participant 403 only. Every other 400, 403 and 5xx behaves as before.

**The owner marker is set on every lane, from the server's record only (board rows 8e8748ef and a80d3683, BGOS #2026).** The served canon now tells an agent an event is its owner only when the outer channel tag says `sender_relationship="owner"`, and that a missing value settles nothing. Only the live websocket lane set it. The stream lane dropped the `senderRelationship` and `senderDisplayName` the backend hydrates onto every human authored row, the meeting cards dropped the twin's sender block, and every `button_clicked` event stamped this daemon's own configured id as `user_id`, so a tap read as the owner's whoever made it.

One reader (`readServerSenderMeta`, `lib/inbound-channel.ts`) now builds `sender_relationship`, `sender_display_name`, `is_shared_recipient` and `share_owner_user_id` for the websocket, poll and stream lanes and for every meeting card, from the record that lane received (the socket payload's sender block, the stream's flat fields, either spelling), never from the message text, and with the server's strings unchanged, as the websocket lane always emitted them. Nothing is defaulted: a value the server did not send, sent in a shape that cannot be trusted, or sent twice with two answers is left off. That changes one websocket attribute: `is_shared_recipient` used to read `"false"` when the server omitted it (a persistent group omits it by design) and is now absent. A lane's extra meta can no longer set a sender key. A tap's `user_id` is now the tapper the backend stamps on the answer (`answeredByUserId`, from the authenticated caller), on the poll, stream and plan boot sweep lanes alike, and is absent when the answer names nobody; no tap carries a relationship, because the answer does not. The poll lane reads `GET /chats/:id/messages`, whose rows carry no relationship today, so poll deliveries still carry none until the backend adds it to that projection, and the same holds for the `meeting_message` broadcast. Every lane has an owner, peer, system and room test, a forged body test and a missing field test, with a recorded mutation proof. No version is chosen here; the release that carries it is Kc's call.

## 0.62.0 (2026-10-07)

**Keep agents running: one switch per computer keeps every agent alive and up to date (mission 104).** Design: BGOS `docs/superpowers/specs/2026-10-06-keep-agents-alive-design.md`. With the switch on in the app (Integrations, the computer's card), the backend marks every Claude Code agent on that computer always-on FIRST, the per-machine watcher is installed, and the watcher's keep-alive sweep gives every agent on disk, including agents created later, its own supervisor. A crash or a reboot brings the agent back on its own conversation, and a staged plugin update is applied only at a safe moment.

**The supervisor, generation 2 (`hoai-agent install --always-on`).** launchd, systemd `--user` (linger) or a Windows logon task runs `run.sh`, which starts the hoai launcher inside a detached tmux session on the agent's own socket (`tmux -L hoai-<id>`), so the agent RESUMES its pinned session (`claude --resume <pin>`) instead of starting a fresh one, and remote compact stays ON. The plugin root is resolved at every launch, so a restart lands on the installed version. `hoai-agent attach --assistant <id>` watches the session. New: `hoai --keep-alive` (the Windows task), `HOAI_SUPERVISED` named exits 6 to 11, an install lock, a Linux restart of an active unit on reinstall, `CLAUDE_CONFIG_DIR` and `HOAI_SERVICE_NAMESPACE` carried into the service, `installed-at` stamped for every install, and every launchd or systemd stop removes `supervisor.json`. One that an unclean stop leaves behind (a power cut, a Windows logoff) counts only while its pid is still the launcher that wrote it: started no later than the file's stamp and running `hoai-core.mjs` as its script (its node may sit in a path with a space, such as Laravel Herd's under `Application Support`), so a pid reused after a reboot, another agent's hoai or tmux server included, cannot keep an agent down. On Linux, where `ps` measures a process's age on the boot clock, supervisor.json and keepalive.json also record the boot clock they were stamped on and the start is compared on that clock, so a wall clock stepped after the stamp (a Raspberry Pi with no RTC, a VM resynced after host sleep) never turns a live launcher, daemon or keepalive script into a reused pid, and a file from an earlier boot never names a live one. The record the daemon writes for a declared launcher (`BGOS_SUPERVISOR_KIND=launcher`) names the daemon itself and is proven by its start time alone.

**The watcher sweep and the safe moment.** Every minute, with the switch on: install a supervisor for an agent that has none (a hand-run hoai launcher counts as none: it does not survive a reboot), upgrade a generation 1 supervisor, and restart an agent onto a staged update only when no turn is in flight, no reply or permission is pending, no Claude Code background job (Bash or Monitor tool process) runs under its claude, and it has been quiet for 10 minutes (30 for an older daemon). It never kills: an agent that stays busy is waited for, and after 24 h of waiting for an update the app shows the reason with Restart now (the watcher's report says `pending: update`); a hand-run plain claude, or on Windows an agent's claude still running after its task's launcher died, is waited for until that session ends and is offered no Restart now (a plain restart cannot end that wait, so its report names no `pending`). One restart and one install per sweep, 3 attempts per version.

**The watcher reports its own health.** A crash-safe entry records every start and any failure before the loop, sends a minimal heartbeat with `watcherHealth {status: crash_loop, lastFatal}`, and backs off (30 s doubling to 10 min) instead of restarting every 5 s; the app shows a red row with a Reinstall action. Reinstalling a running watcher now retries the launchd bootstrap that loses the race with an async bootout, and the watcher's service PATH carries the directories where its tools were found.

**The daemon.** `~/.bgos-plugin-state/<id>/agent-state.json` publishes the turn state, pending work, running and pending versions and the live session for the watcher; the live session id is pinned so a takeover resumes it; the always-on reconcile never adds a second supervisor beside a bespoke one (G11) and installs with the agent's real folder; marketplace installs now report `pendingRestartVersion`; the hook session binder honours the launch folder and `CLAUDE_CONFIG_DIR`.

Every behaviour has a focused test with a recorded mutation proof; an end to end run on a Mac under launchd (isolated from the live fleet) proved switch on, crash and return on the same session, and an update applied only after a background job ended.

## 0.61.4 (2026-10-06)

The remote pane can navigate, use history and reload, and create, select or close tabs in the agent's actual browser. Owner actions retain exclusive control until the physical operation settles. Navigation acknowledges dispatch promptly so Stop remains available during delayed headers or documents. Physical links and same-document history publish loading completion. Tab actions verify the displayed target identity, roster changes refresh even when the selected page stays unchanged, and pending capture survives a target replacement. The browser keeps at most 16 tabs whether the agent or owner creates them.

Login detection no longer rejects a visible top-page sign-in because it contains an unrelated iframe, an alternative OTP link or signup footer text. Password-only steps and JavaScript login pages are supported with exact document, field and origin checks. Native encrypted entry for the clicked username, password or OTP field works with storage locked. The owner can explicitly save a new login for the current origin without requiring a recognized HTML form. Credential values remain sealed over HOAI and saved entries remain encrypted on the agent machine. Raw protected-field keystrokes, hidden or changed targets, foreign form destinations, payment fields and opaque iframe fields remain refused.

Real Chromium regressions, printed executable mutation proofs and the touched host suites cover these changes. New viewers explicitly negotiate browser controls; older viewers keep their existing single-target stream and empty input-revocation events. Negotiated revocations distinguish navigation and target changes from expiry and release. Version metadata advances together for review; no release tag, marketplace pin, publish or deployment is performed here.

## 0.61.1 (2026-10-05)

**A daemon holding a staged update no longer goes blind to later releases.** Both `checkNow` and `updateNow` correctly decline to install while an update is already on disk awaiting a restart, but both writers of the version this daemon reports as latest sat after that early return. So staging an update froze `latestKnownVersion` at that moment, for as long as the restart never happened. Measured in production forty minutes after 0.61.0 was published: of 59 live daemons, twenty were staged on a version that had itself been superseded, each reporting that stale target AS the latest it knew, and nothing could tell them from a daemon that was genuinely current. The periodic check now LOOKS before it defers, and says what it saw. The triggered one-click deliberately does not, because a user can tap it repeatedly and its no-new-fetch property is pinned by a test. This does not unstick a staged daemon, which still needs its restart; it makes the stuck state visible, which is what anyone fixing it needs.

## 0.61.0 (2026-10-05)

**One release carrying every plugin change since 0.60.2, batched on purpose (KC, 2026-10-05: "batch all the updates into one major update with a version change and then you publish instead of publishing every update on its own").** The five branches below each proposed their own number; they ship as this one.

**`/login` works from the chat, and the daemon answers it.** An agent whose Anthropic session expires can be signed back in without anyone opening its terminal. Send `/login` and the agent offers Claude subscription or Anthropic Console; the tap returns the sign-in link; the code pasted back as the next message completes it. It is answered by the DAEMON and never by the model, which is the whole point: a logged out session cannot think, so a model-handled `/login` would be dead exactly when it is needed. Owner only, refused before anything spawns. The code is never logged, echoed or replied, child output is redacted at ingestion, a message that is not a code is not swallowed, one sign-in at a time, ten minute window, and no sign-in starts from a room or a meeting where the link would be posted to every member. It covers a session that expires while running, not a cold start that was already signed out: under the supervisor that case exits at the startup gate before any daemon exists.


**Always ask now covers installing a plugin or tool (floor rules version 2).** With the owner's "Always ask before
risky actions" switch on, the floor hook now holds `claude plugin install` (and `i`), `claude mcp add` (`add-json`,
`add-from-claude-desktop`), `codex plugin add` and `codex mcp add` for the owner, even with full access: a plugin or
tool the agent installs outlives the chat that added it. Listing, updating, removing and adding a marketplace do not
ask, and neither does a skill file the agent writes itself (the Teach flow already asks first). The matcher, the words
("installing a new plugin or tool that stays after this chat") and the byte identical fixture match BGOS
`backend/src/services/hard-floor.ts` rules version 2. On a pairing with the hook, the daemon also declares
`hard_floor_rules_2`, which the app reads before it tells the owner the hook stops a plugin install. Lands together with
the BGOS change; no version is chosen here, the release that carries it is Kc's call.

The daemon provisions its browser on first use: an installed Chrome or Chromium is preferred, otherwise the pinned Playwright Chromium revision is downloaded into the user cache. The normal browser-host supervisor owns startup. The browser keeps its sandbox, and missing operating-system prerequisites return an installation error.

Owner login entry uses a dedicated encrypted relay capability and trusted HOAI dialogs. Exact document, form and field checks guard filling, and filling never submits automatically. Saving a new password requires a separate confirmation. After saving or declining to save, the owner can review the page, take control and click the validated Sign in button within 30 seconds. This grants one explicit down/up on the captured form and button, revoked by navigation, a new form, input release or expiry. Ordinary remote keyboard input still refuses credential fields. Each agent and acting person have separate passphrase-encrypted login storage. Browsing starts locked and nonpersistent; unlocking enables encrypted cookie, localStorage and IndexedDB snapshots until close. No passphrase or encryption key is saved. Legacy native profiles require explicit owner confirmation before supported artifacts are cleared.

The package includes the HOAI browser skill and the bootstrap, vault, credential and shared crypto modules. Targeted unit, mutation, real Chromium and packaged supervisor evidence is recorded under `docs/reports/2026-10-04-remote-credentials`. Version and manifest move together. No tag, marketplace pin, publication or deployment is performed here.

The owner can explicitly control a daemon browser through the HOAI server. Exclusive leases fence agent tools and retain the reservation until pressed-key/button cleanup settles. Single-use focus tokens and host DOM checks refuse detected credential fields until KC decides otherwise. Allowed ordinary text crosses the server and agent machine; field detection cannot prove it contains no secrets.

The native pane typing proof, credential refusal, targeted50-test host run and TypeScript check passed. B depends on the independent A release. Package and manifest versions advance together. No tag, marketplace pin, publish or deployment is performed here.
**Windows is a tested host now: the suite runs on Windows in CI, and three bugs Windows users had are fixed.** Until
now the suite had only run on Linux and macOS. Run on Windows it went 31 red on a clone made with
`core.autocrlf=false`, and 44 on a default clone, which is what a Windows install really is. Every red was triaged.

- **A Full handoff from an agent on Windows no longer fails on its own files.** The export pack's symlink gate checked
  containment with a hardcoded `/` against the OS realpath, which on Windows uses backslashes, so every file "escaped"
  the workspace: the export failed PATH_ESCAPE and the dry run offered the owner nothing. It now decides by the host's
  own path rules (case blind on Windows, another drive is outside, a drive root works), and on posix a backslash stays
  a file name byte, so `/ws\evil` is still outside `/ws`.
- **`bgos-claim` locks the `.mcp.json` that holds the API key to your Windows user**, with icacls, as `bgos-pair`
  already does for its credentials. On Windows chmod does nothing, so with an agents folder outside your profile the
  key was readable by every local user while the installer said "chmod 600". It now reports the protection the file
  really got, and says UNPROTECTED if the lock fails. It also gets that far on Windows now: its check for git asked
  `/bin/sh`, which Windows does not have, so every claim there stopped at "git is required" with git installed.
- **On Windows the daemon's stop closes Chrome cleanly.** It used to stop its browser host with `kill('SIGTERM')`,
  which on Windows is TerminateProcess: Chrome was cut off on every daemon stop, restart and lock handover, and
  logins from its last few seconds could be lost. The daemon now holds the host's stdin and closing it is the stop,
  on every OS (off Windows it still sends SIGTERM as well). On Windows the host is started detached, so the daemon's
  exit cannot kill it mid close, with a late backstop kill while the daemon lives. On every OS a stop is now bounded:
  after 15 s the host kills the Chromes it started, launching ones included, and exits, where a hung close used to
  keep it running forever.
- **Every checkout is LF.** A Windows install is a git clone made with the user's `core.autocrlf=true`, so 349 files
  reached Windows users as CRLF while CI tested LF. `.gitattributes` now pins every text file LF (batch files CRLF),
  and `test/line-endings.test.ts` keeps it that way.
- **The daemon builds an agent's supervisor paths with the watcher's join.** `lib/update-readiness.ts` built the
  service file, `supervisor.json` and marker paths with the host's `path.join`, so on Windows a home written with
  `/` came back with `\`, while the watcher keeps the separator of the home it is given (`joinDir`). Handed the same
  home, the two named different files for one agent, which the new Windows leg showed as the one red parity test.
  The daemon now uses that same `joinDir`, and so does `bin/hoai-keepalive-marker.mjs`, which writes the
  `keepalive.json` the daemon reads. No real install moves: for a real home (`C:\Users\...` or `/Users/...`)
  every path is byte for byte what it was.
- The rest were tests that assumed POSIX paths, file modes, a bash on PATH (on Windows that is the WSL launcher),
  `pgrep`, or a 400 ms cold start, now written to hold on both hosts without being weakened. A new
  `test (windows)` job runs the suite and the type check on `windows-latest`; the README says what a Windows machine
  needs to run it (Git for Windows) and what skips there by design.


Daemon browser pages can stream into the HOAI owner pane through the authenticated server relay. The host attaches Page.startScreencast to its existing browser and retains the latest update while a prior frame is outstanding. Closing the view leaves the agent page running. This is the independent A release; it sends no owner input.

Targeted browser-host/view tests and real Chromium streaming passed. Package and manifest versions advance together for the repository gate. No tag, marketplace pin, publish or deployment is performed here.
## 0.60.2 (2026-10-04)

**Re-vendored the HOAI browser shim from BGOS main, sha256 `b9a7c24b`** (was `24470ac3`, vendored
2026-09-28). `bin/hoai-browser-mcp.mjs` is a byte-identical copy and the pin in
`bin/hoai-browser-mcp.vendor.json` names the new hash, so the guard states the identity in the tree.

Two things ride this copy. The status line that `hoai_browser_status` appends now reads
`Reached on <host>.` It read "Reached through your owner's account on <host>", which was already loose
(an account is not an app) and became wrong outright when BGOS shipped the acting-principal election:
the backend elects a desktop belonging to the ACTING human, so for a shared agent the page does not run
on the owner's machine at all and the old sentence could name the wrong person. And the copy had been
three days behind, missing MCP request cancellation entirely.

Verified on this tree rather than asserted: the vendor guard's cross-tree case PASSED rather than
skipped (`HOAI_BROWSER_SHIM_SOURCE` armed at BGOS main's shim, 5 of 5), the ported relay and shim
suites are 34 of 34, `npm test` is 3,346 tests with 0 failures, and `npm run build` is clean.

**The version moves because this repo's `version advances against base` check requires it on every
PR, and that is not the same as a release.** Publishing is a separate act: the tag, the marketplace
ref and the app's own plugin version floor, none of which move here. So a machine installing through
the pin is unaffected.

What IS delivery, and it is easy to miss: a host that TRACKS this repo picks the new shim up at its
next session restart, so merging reaches those machines even with nothing released.

## 0.60.1 (2026-10-02)

**The deny that stops an agent wedging on a terminal question now reaches agents that were already installed.** Claude
Code's own `AskUserQuestion` tool halts a session at a prompt nobody is watching, waiting for a keypress that never
comes, while the daemon still reports online. Both bootstraps have denied it since 0.56.0, and a bootstrap runs once, at
first install, so every agent installed before that never received it and nothing revisited them. Measured on a nine
agent machine on 2026-10-02: one carried it.

`ensureDeniedTools` writes the deny into one agent folder's `settings.local.json`, and `bgos-agent` calls it on install
and on restart, so a restart is enough. It is not folded into `ensureHookEntries`, which writes the same file, because
the restart path calls that function only for a workspace that already names `hoai-hook.mjs`: a permission cannot
duplicate anything, so it must not inherit a gate that exists to stop a second hook entry firing. Folding it in would
have skipped exactly the agents it is for. A workdir with no `.claude` directory is left alone rather than having
configuration invented for it, and a settings file that does not parse is returned untouched.

## 0.60.0 (2026-09-28)

**One release for four changes: the owner's Changes panel, a truthful browser shim, the browser rule file the desktop
uses, and a nightly update that no longer leaves the second daemon on old code.** Published once, as one version, so
the fleet takes all four on the same restart.

**A daemon that waited for another daemon's nightly update now restarts onto it the same way the one that installed it
does.** When several daemons share one checkout, one of them takes the update lock and installs the update, and the
others wait for it. Since 0.54.0 the installer asks the restart ladder to restart its session (the same ladder a click
on Update uses, which acts only on an authority that proves it owns the process and otherwise leaves the update staged).
The daemons that waited did not: they kept running the old code they had already replaced until someone restarted them
by hand, and an older version of that path exited outright with nothing to bring it back (two agents dark for about
four hours, twice). Now the waiting daemon takes exactly the installer's decision: it exits only where the operator set
`BGOS_EXIT_AFTER_UPDATE`; otherwise it asks the restart ladder when one is wired in; otherwise, or when the ladder
stages, it keeps serving, takes messages again, and logs that the update waits for the next restart. An update started
from the app is unchanged: the app's own restart step still decides for it.

**The browser tools say what really happened when a call is refused or a connection drops.** The HOAI browser shim
(`bin/hoai-browser-mcp.mjs`) is re vendored from HOAI's source, sha256 `24470ac3` (it was `aaaff4b6`). A rate limit, a
general request limit, a host whose connection dropped mid call, a refusal met while the shim was still connecting,
a result that could not be collected for a call already sent, and a status check the backend refused each get words
that are true for that case. Before, most of them told the agent that the owner's desktop app "is not running or not
signed in", or invited a blind retry of a call that may already have clicked, bought or sent something. The relay
tests carried over from HOAI now cover each of these (32 cases here, 20 of which fail against the old copy).

**The daemon's browser rules are the desktop's rules again.** `lib/browser-host-core/policy.js` is re vendored from
the desktop Agent Browser (sha256 `7541a0c3`), so a browser run on the agent's own machine keeps the same truthful
step trail the desktop keeps (BGOS #1634).

**The owner's Changes panel can read this agent's uncommitted changes.**
The HOAI Changes panel (HOAI P7 stage 3, C-31) shows the files a coding agent has changed and not committed yet. This
daemon answers a new `changes_rpc` lane (op `diff`, scope `uncommitted`) with read only Git in the agent's launch
folder (lib/changes-rpc.ts over lib/git-changes.ts).

**What the read defends against, and what it does not.** It defends the owner against untrusted repository content,
what a clone carries (a `git` binary planted in the folder, attributes, the files themselves), and against Git writing
the repository (the index refresh, its locks). It does not defend against the agent itself: the agent runs as the same
user with the same reach on the same machine and can already run any program and read any file there, and the answer
goes only to the owner who owns that machine. A setting only the agent's own local config or its `.git` file can make
(`core.worktree`, a gitfile or `GIT_DIR` pointing elsewhere, a clean filter, a promisor remote's programs) can mislead
its own panel; the checks below that exist for those (the top folder rule, `GIT_NO_LAZY_FETCH`, the Git floor) are
defence in depth, and each line says what it covers. The git dir and the common dir are not contained, on purpose: an
agent that runs in a Git worktree keeps its common dir outside its folder.

- **Read only, and it stays off the index.** The whole list is the one `git version` read per Git path (the floor,
  below), then `rev-parse`, `symbolic-ref`, `diff --numstat`, `diff` and `ls-files`, all run with
  `GIT_OPTIONAL_LOCKS=0`. Both diffs also run with `diff.autoRefreshIndex` off: measured on Git 2.55, a file touched
  but unchanged makes `git diff HEAD` rewrite `.git/index` even with the optional locks off, which would race the
  agent's own `git add` for the index lock. None of these writes the index, the working tree or a ref; a lazy fetch, on
  a Git that does not know `GIT_NO_LAZY_FETCH`, would still add objects (below).
- **No fsmonitor hook runs, on Git 2.36 or later.** Every Git command turns `core.fsmonitor` off on its command line.
  The repository's own config can point that setting at a program, and measured on Git 2.55 both diffs and `ls-files`
  ran it, so each panel read would have run that program, which the agent picked, as the owner. That setting lives in
  the repository's local config, which no clone carries, so this is defence in depth. From Git 2.36 the flag reads as
  off; before it, the same `core.fsmonitor=false` is read as the path of a program to run, so the daemon reads
  `git version` for the Git it finds before any other command, and an older Git, or a version it cannot read, is
  refused with "changes could not be read on the agent host: Git 2.36 or later is needed to read changes safely", the
  sentence the Codex daemon sends for it too, and nothing else runs. Only an accepted Git is remembered: a refused one
  is asked again at the next read, so an owner who updates Git needs no daemon restart. The floor stays 2.36: 2.45
  would refuse Ubuntu 24.04's Git 2.43, which honours `GIT_NO_LAZY_FETCH`.
- **No lazy fetch from a partial clone, on a Git that knows `GIT_NO_LAZY_FETCH`.** Every Git command runs with
  `GIT_NO_LAZY_FETCH=1`, so on such a Git a read that needs an object a partial clone left out fails instead of asking
  the promisor remote for it, a fetch that runs the programs the repository's config names and can wait on the network
  (measured on Git 2.55: the numstat ran the upload-pack program a clone's config named). The variable, not the
  `--no-lazy-fetch` flag an older Git rejects. Git's release notes first name it in 2.45.0, and Ubuntu 24.04's build of
  Git 2.43.0 honours it too (measured); a Git from 2.36 that does not know it passes the floor and can still fetch
  lazily in a partial clone, a documented gap. A promisor remote is the clone's local config, so this too is defence in
  depth.
- **A clean filter still runs, on every Git.** A clean filter the repository's own config and attributes name still
  runs on the two diffs; no flag here stops it (and on a Git that does not know `GIT_NO_LAZY_FETCH`, a lazy fetch's
  programs can run too, above). This is an accepted limit: it needs the repository's local config, which no clone
  carries, and this daemon runs as the same user with the same reach as the agent. Unlike the fsmonitor there is no
  one switch for it (filter names are free), and reading attributes from an empty tree (`--attr-source` from Git 2.41,
  `attr.tree` from Git 2.43) would raise the floor and still not cover `.git/info/attributes`.
- **Git's own `a/` and `b/` prefixes**, asked for on the patch, so a host whose Git config sets
  `diff.mnemonicPrefix`, `diff.noprefix`, `diff.srcPrefix` or `diff.dstPrefix` still reads right.
- **A moved submodule is one section of its own.** The patch asks for Git's short submodule format too, so a host
  whose Git config sets `diff.submodule` to `log` or `diff` still writes a moved submodule as one `diff --git` section
  with its old and new commit, never lines the backend would hang on the file before it (measured on Git 2.55).
- **The launch folder, never the process folder.** The first command finds the repository root from the agent's
  folder and every later one runs in that root, so tracked and untracked paths agree from a subfolder too. Variables
  that would point Git at another repository (`GIT_DIR` and its neighbours) are dropped for the call, in any spelling on
  Windows, whose names are case blind (measured: a `Git_Dir` there made Git read the other repository). A launch folder
  that is gone is a failed read, never "Git is not installed" (Node names both the same way). The repository's top
  folder must be the launch folder or a folder above it, as the host resolves both: a `core.worktree` in the
  repository's config that names any other folder is refused and nothing there is read (measured on Git 2.55: without
  the check, the read went on in that folder's own repository and sent a new file from it whole). The refusal reads
  "changes could not be read on the agent host", the sentence the Codex daemon sends for it too. `core.worktree` is
  local config, so this is defence in depth, and it covers the top folder only: the git dir and the common dir are not
  checked, so a gitfile pointing elsewhere still reads that repository against this folder.
- **Git by its absolute path, never a git in the agent's folder.** Windows looks for a bare `git` in the working
  folder before PATH, so a `git.exe` there, which a cloned repository can carry as an ordinary file, would have run as
  the owner each time the panel opened (measured on node 24.16 and bun 1.3.9). Git is looked up on PATH's absolute
  entries only and run by that path; an empty, `.` or other relative entry is never looked at, and no Git on PATH still
  reads as "Git is not installed".
- **New files count.** The first 20 untracked files are read: text up to 64 KB is sent whole, a file with a NUL in
  its first 8,000 bytes is binary, a larger one is its size only, a symlink is never followed. Each is opened once and
  checked through that handle before any byte is read: it is read, at most 64 KB and one byte, only while it is still
  the regular file first checked and within the cap, so a file that grows is never loaded whole and a name swapped for
  a link or a device is not read at all.
- **Raw and capped, never processed here.** Each stream is cut at the byte cap the frame carries (never above the
  backend's own numbers) and Git is killed at the cap, and the read answers then, never waiting on a process Git for
  Windows' launcher leaves holding the pipes, so a huge diff costs a flag, not a failed read. Past the
  frame's budget (10 s) the read stops and answers too slow. The backend, not this daemon, splits the patch, counts,
  masks secrets and caps what reaches the app. The folder is sent as its last name only.
- **Only this agent answers.** A frame for another agent gets no answer at all, a re sent frame is answered again and
  never runs Git twice, only the pairing lock holder answers, a draining daemon takes none, and nothing is read before
  the agent's home folder is confirmed. The log carries sizes, never a path or a line. An answer is held for a re send
  only through the backend's own 20 s wait, and at most the newest four, so old diffs never pile up in a daemon that
  runs for days.
- **Declares `changes_rpc` on every host.** The backend sends a changes frame to a Claude Code pairing only while it is
  declared and only while the owner has turned the panel on for this agent; this daemon never reads that switch.

## 0.59.0

**A Stop is asked for honestly and never closes the mission, and the owner can find this agent's sessions in the app.**
P6 stage 3 (HOAI's Resume button and Sessions sheet). The tokens, op names, words and limits below come from
`lib/session-controls-contract.ts`, BGOS's session controls contract copied byte for byte and pinned by sha256,
the same digest BGOS and codex-channel-bgos pin.

- **Claude Code's own AskUserQuestion is denied for the agent, in the agent's own folder** (board row 01a07b28, skipped by six releases). Both `bin/hoai-bootstrap.sh` and `bin/hoai-bootstrap.ps1` now write `permissions.deny: ["AskUserQuestion"]` into the workspace's `.claude/settings.local.json`, the file the bootstrap already manages there for the activity hooks, added to an existing deny list once and never doubled, every other key kept, and a file that does not parse left as it is. It is never written to the settings.json in the Claude config folder: with `CLAUDE_CONFIG_DIR` unset that is the owner's own `~/.claude/settings.json`, which every Claude Code session they run reads, so a deny there would switch AskUserQuestion off in all their personal sessions (found in review before release). The owner's file still gets only the bypass prompt acceptance it got before. The agent asks its owner through the HOAI app (`ask_user_input`); the built in tool stopped the session at a terminal nobody watches. Proven by `test/bootstrap-askuserquestion-deny.test.ts`, which runs the real pre-seed of each script against a temporary HOME and agent folder and fails if `$HOME/.claude/settings.json` gains the deny.
- **"Asked to stop."** The line posted after a Stop replaces "Run stopped at your request.". It is posted the
  moment the notice reaches the session, before the model has stood down, so it claims the asking and nothing more.
- **The stop notice keeps the mission open.** The `[stop_turn]` notice now tells the model to leave the chat's
  open mission open and not to call `complete_mission` for it because of the stop. A Stop is neither a finish nor
  a failure.
- **A Stop pauses the mission an armed goal loops on.** Where this daemon can type into its session and Keep
  working is armed on the stopped chat's open mission, the Stop pauses that mission with the reason "Stopped by
  you", so the goal's own Stop hook cannot re prompt the model, and the owner's next message in that chat resumes
  it. An owner's own Pause is never resumed by a message. After a daemon restart the owner's first message in a
  chat asks the server, and a read that fails is asked again on the next message, so a Stop pause from before the
  restart is never left behind. Declares `stop_pauses_mission` beside `mission_pause`.
- **The Sessions library, list only.** New `list_sessions` op: the sessions in this agent's own folder, newest
  first, with a title, last activity, a preview, the branch and the Current session, searchable. The 200 newest
  transcripts at most, their first and last 64 KB only, cached while unchanged. Titles and previews that hold a
  secret are withheld whole before they leave the machine. `resume_session` and `rename_session` answer
  `unsupported`: switching the session a running agent is pinned to needs a supervisor change that reaches an
  agent only when its owner runs `hoai` again, so it is a later update. Declares `sessions_library` on every host.
  The bundled MCP instructions, what the model reads when the served canon cannot be fetched, carry the served
  Sessions sentence word for word, and say resuming from the app is not available yet.

## 0.58.0 (2026-09-26)

- **The agent is told what a run id and a stop message mean.** A card handed
  to an agent now carries a run id, and one message may hand it several
  cards, each with its own. This daemon declares `boards_runs` on every host,
  on its heartbeat and on the capabilities fetch, and the backend serves the
  canon's run id sentence only to a connection that declares it: a run id
  the agent has already seen is the same work sent again, so it does it once,
  and a message that starts "Stop working on" names a card the owner took
  back or closed. It needs no tool and adds no argument; the id rides the
  hand over message. The bundled fallback and the MCP instructions say
  nothing about runs, so an agent reads it only from the served canon.
- **The column instruction text says what stays true.** `starts_when` still
  takes only `person_moves_in`, and its description and its refusal now say
  it is the only start an agent can suggest, while starting work when a card
  is created in a column is a setting the owner turns on in the app.
- The version is the first minor above every number an open or shipped
  release held on 2026-09-26 (main 0.54.0, #161 0.55.0, and this branch's
  two parents, #149 at 0.56.0 and #159 at 0.57.0, renumbered level with main
  that day); the release that ships it confirms the number.

## 0.57.0 (2026-09-26)

- **An agent can suggest what a column asks of the agent a card is handed
  to.** A column line gains an instruction part: `set_column_lines` takes a
  `does` per line, with `kind` (start work, or only tell), the `instruction`
  itself, `starts_when` (only `person_moves_in`, a person moving a card
  there, is honoured today; an agent moving a card never starts anything),
  `who` gets the card (one agent by `assistant_id`, the agent a card field
  names, or ask the owner at each drop), one `only_when` condition, the
  `needs` that must be filled before a hand over, `ask_for_note`, the
  `fills` the agent is expected to write, the columns finished work
  `lands_in`, and `plan_first`. The tool sends the server's camel case,
  rebuilt key by key from a closed schema.
  - **It is a suggestion until the owner approves the exact words.** The
    server files an agent's instruction as a suggestion the owner reads and
    approves in the app, and nothing starts until then. The echo lists those
    columns in `suggested`, and the tool answers with one sentence naming
    them: saved as a suggestion, nothing starts until the owner approves
    those exact words, do not send it again. Words the owner already turned
    down come back in `declined`, answered with their own sentence: do not
    send it again unless the owner asks for a different one. The filed
    sentence of 0.50.0 is unchanged, and "Everything else in this call was
    saved." now closes the answer once, when something else in the call was.
  - **The approval is the owner's alone.** The tool never sends `approved`,
    `textHash` or `v`, and refuses them by name, with the owner's `paused`
    switch, as keys an instruction does not take.
  - **The shape is checked here, the rules are the server's.** A misspelt
    key, a wrong type, a value outside an enum, a `who` whose parts do not fit
    its `by`, or an `only_when` with both or neither of `in` and `empty` is
    answered before anything leaves the machine. Every length (1200
    characters of instruction, 20 items a list) and every reference (a field
    of the table, an option of the select, an agent of the owner's fleet) is
    the server's, and its sentence reaches the model word for word.
  - **The instruction sentence reaches only an agent that can write one.**
    This daemon declares `boards_playbook_does` on every host, beside
    `boards_playbook`, on its heartbeat and on the capabilities fetch. The
    backend serves the canon's instruction sentence only to a connection that
    declares it, and the phase 1 column lines sentence is unchanged.
  - **The `lines` text says what changed.** Its last sentence now reads: a
    line's sentence and facts only describe the board; its does part is a
    suggestion until the owner approves it. Everything else a line describes
    is still description only, and every other op, argument and answer of
    the board tools is exactly as it was.
  - **Release order.** Against a server from before instructions, a `does`
    is filed with the line's other structural changes and answered `filed`
    (reported as not applied), or dropped by an older whitelist and reported
    as nothing written. Update the server first.

## 0.56.1 (2026-09-28)

Desktop one-click could not start a background agent on a fresh workspace, and
once it could, the agent removed itself.

- **`hoai-agent install --always-on` now installs a PROVEN paired folder that has
  no `.mcp.json`**, which is what desktop one-click leaves: it installs the
  marketplace plugin and pairs with a one time code, so it never holds a key to
  write a `.mcp.json` with. The launch step died there ("no .mcp.json ... and no
  creds given", measured with the desktop's exact line). The gate is not
  skipped, because an agent once came back deaf on the wrong channel spec
  (2026-08-21). The install goes ahead only when `bgos-doctor
  --prove-paired-topology` proves it, by readers the repo already had: pairing's
  own live-safe verifier (the folder pin names this agent, its per-agent
  credentials are there and hold that agent's id) and the launcher's channel
  resolver (a marketplace install, enabled, its files on disk). Both are asked
  about the environment the BACKGROUND session will have, which carries no
  `CLAUDE_CONFIG_DIR`. `bin/bgos-agent` still never types the marketplace spec:
  it takes the one the resolver proved.
- **Anything unproven is refused by name**, exit 1, with nothing written and the
  service manager never called: `paired-topology:no-folder-pin`, `:pin-mismatch`,
  `:no-agent-credentials`, `:credentials-belong-to-another-agent`,
  `:plugin-not-installed`, `:plugin-disabled`, `:plugin-files-missing`,
  `:installer-is-a-clone`, `:node-not-found`, `:channel-mismatch`. A refused
  install is better than an agent that says Connected and hears nothing.
- **A workspace that DOES carry a `.mcp.json` is untouched.** Pinned by tests,
  and checked by putting the same clone-style folder through the 0.42.3
  installer and this one: state dir, service file, `.mcp.json`, `CLAUDE.md` and
  the installer's own output came out byte identical.
- **The supervisor is no longer removed by its own daemon.** The app records
  always-on in BGOS only after it has seen the agent connect, and a new agent's
  flag defaults to off, so the supervised session's daemon read "off" with a
  supervisor installed and uninstalled the job it was running in. A paired
  install is now stamped, and the reconcile leaves a supervisor younger than 15
  minutes alone. After that a flag that is still off is honoured as before.
  Read in code, not yet run against a real backend.
- **Node on the service PATH.** The marketplace plugin starts its MCP server and
  its hooks with `node`, and the service PATH was built for clone agents, which
  run `bun`. With node from nvm, volta or fnm the session came up and the channel
  never did. Node is now resolved before anything is written and leads the
  service PATH.

Not verified in this release: a supervised session actually coming online through
the marketplace channel. That needs one real one-click run on a clean account.

## 0.56.0 (2026-09-26)

- **An agent can say what each column of a board means.** A board's workflow
  select is the one the Kanban stacks by, and until now its columns were bare
  names: the owner read "Review" and had to guess whether a card there was
  waiting on them, on an agent or on nobody. `boards_update_schema` gains a
  `set_column_lines` op that describes each column in one plain sentence plus
  a few closed facts: who a card there waits on (the owner, an agent, someone
  else or nobody), whether it is open, parked, finished or dropped, which
  field sorts it, and, for a column that waits on the owner, up to four
  answers the owner can give. `clear_lines` removes a line and `workflow`
  proposes the select as the board's workflow, which the Kanban stacks by
  once the owner confirms the board.
  - **The lines only describe the board.** Nothing an agent writes there
    starts work, sends a message or is read to decide anything; the tool's
    own description says so, and the tool refuses the server owned keys
    (`v`, `writtenBy`, `at`, `does`) as unknown ones.
  - **A change the owner decides is reported as not applied.** Once the
    owner confirms the board, or on a column whose line the owner wrote, only
    the sentence changes directly; any other change is not applied and the
    owner's setting stays. The server lists those columns in `filed`, and the
    tool answers with one sentence naming them, saying which sentence was
    saved and not to send the rest again, instead of a success the model
    would retry on every run.
  - **A server that cannot store a line says so.** A BGOS server from before
    column lines drops the new keys and answers 200 with the field alone, so
    the tool checks the answer for its `playbook` and, when it is missing,
    reports that nothing was written rather than claiming the write.
  - **The shape is checked here, the rules are the server's.** A misspelt
    key, a wrong type or a value outside an enum is answered before anything
    leaves the machine, with the allowed values named. Every length (140
    characters for the sentence, 40 for an answer label, four answers) and
    every cross reference (an option that exists, a sort field of the same
    table) is the server's, and its sentence reaches the model word for word.
  - **Renaming an option keeps its column.** `set_options` takes an optional
    `option_renames` list of `{ from, to }` pairs, so a renamed option's cards
    and its column line follow the new name instead of being dropped with the
    old one. Without it the wire is byte for byte what 0.44.0 sent.
  - **The column lines sentence reaches only an agent that has the tool.**
    This daemon declares `boards_playbook` on every host, on its heartbeat and
    now on the capabilities fetch at connect as well (the fetch can run
    before the first beat has stored the declaration). The backend serves the
    sentence that teaches the op only to a connection that declares it, so an
    older daemon is never told about a tool it does not have. The bundled
    offline guide does not change.
  - **Nothing here is new for agents that do not describe columns.** Every
    other op, argument and answer of the board tools is exactly as it was,
    and the tool roster is still the same twelve.
## 0.55.0

**Renumbered from 0.52.0, then from 0.54.0, at merge:** the plugin's main took 0.51.0 to 0.54.0 (#162, #163, #157, #164).

**An owner can change this agent's memory from the app.**
The HOAI Memory screen now reaches a Claude Code agent (HOAI P7 stage 2, C-39). This daemon answers a new
`memory_rpc` lane (list, add, replace, remove) over the agent's own auto memory folder, the one the CLI reads at every
start.

- **The folder is found by the CLI's own rule, on every request.** `autoMemoryDirectory` from the agent's settings
  (local, then project, then user), else the git root of the agent folder (a worktree shares its main repository's
  memory), under the config dir this daemon runs with, never a hardcoded `~/.claude` and never the process folder.
  Memory turned off is said so. A relative folder setting, an agent path over 200 characters, or a folder the CLI
  never made is refused, and nothing is created.
- **An entry is one line of `MEMORY.md`**, the only part the model reads at start; the full words live in the note the
  line links to. A note typed `user` is listed as what the agent knows about its owner, the rest as its own notes.
- **Changes apply from the agent's next start**, not in the conversation it is having now.
- **Every change can be undone.** What a change takes away is kept in a trash outside the memory folder (the newest
  50, in this agent's plugin state folder), and adding the same words back restores the whole note where it was. A
  note the agent removed itself comes back whole too, while this daemon still remembers listing it.
- **The What changed Undo puts the folder back byte for byte.** When the app pairs a fact that went and one that
  came in the same store as one change, its Undo now brings the gone fact back under its own note and its own line
  and moves the one that came to the trash, instead of writing the old note under the new fact's name and title. A
  correction also retitles its line with the first words of the new fact, a title written by hand included, so the
  old fact no longer stays in the line the model reads at start, and the Undo of a correction puts the saved line
  back exactly as it was, the CLI's own title and separator included (the HOAI live round trip, F1 and F2, and its
  fix round).
- **Safe beside the model.** Every file is written through a temp file and a rename, the note before its line, and the
  index is compared right before it is replaced: a lost race answers busy instead of overwriting the other writer.
  Replace and remove match one entry exactly, never a part of one.
- **Only this agent answers.** A frame for another agent gets no answer at all, a re sent frame is answered again and
  never run twice, only the pairing lock holder answers, and nothing is read or written before the agent's home
  folder is confirmed.
- **Search is answered as not available here**; the app hides it for Claude Code.
- **Declares `memory_rpc` on every host.** The backend sends a memory frame to a Claude Code pairing only while it is
  declared, so the gate is the token, never this version.

## 0.53.0 (2026-09-26)

**Renumbered from 0.46.0, then from 0.49.0, then from 0.52.0, at merge.**
This release was prepared as 0.46.0, then renumbered 0.49.0 when the plugin's
main was released as 0.46.0, 0.47.0 and 0.47.1 by other programs without this
work and it stacked on the plan card. The permission request card (prepared as
0.44.1, then 0.47.0) has since shipped as 0.49.0 and the plan card it stacks on
(prepared as 0.45.0, then 0.48.0) as 0.50.0, both on the plugin's main. Main
then took 0.51.0 (add_mission_goals and cancel_mission_goal) and, while this
branch was being merged as 0.52.0, 0.52.0 (the restart recovery of an
unanswered message, #163), so this ships as 0.53.0, the next free number above
it. A plugin version cannot be reserved, so the HOAI canon does not tie the
floor to a release number: it tells the floor sentences only to a daemon that
DECLARES the `hard_floor` capability, the way it tells the request card and the
plan card only to a daemon that declares `permission_card` or `plan_card`
(BGOS #1624).

- **Always ask before risky actions: a listed action now stops and asks you,
  even though the agent runs with full access.** It is your switch, per agent,
  OFF by default, and it lives on the server; this plugin never reads it. With
  it on, deleting a folder and everything in it, force pushing, changing a file
  inside `.git`, changing an `.env` file, changing a settings file in your home
  folder, and an MCP tool that sends, posts, pays or deletes on your behalf all
  arrive as the Allow once / Deny card and wait for you. Nothing else changes:
  `git status`, an ordinary edit and this channel's own tools never ask.
  A payment tool is read by the names payment tools really use
  (`create_payment_intent`, `createPayment`, `charge_card`), while a read of
  one (`list_payment_intents`, `get_charge`) is not; and the HOAI Agent
  Browser's own tools are left to the browser's own gate, which already asks
  you before every sensitive action in the page, so clearing a value from the
  agent's own browser storage no longer asks. A shell command the CLI cut in
  the middle that no floor record names waits for you only when your switch
  is on (the relay asks the server with `elided: true`); with it off it runs
  as it did before. And if this daemon cannot fetch the canon, its offline
  copy tells the agent that a hook stops a listed action only when it
  declares `hard_floor`, the served canon's own rule.
  - **A blocking hook, and only one.** `bin/hoai-floor-hook.mjs` is a second
    `PreToolUse` entry with `async: false`, a matcher for the shell, edit and
    MCP tools and a 3 second timeout. For a listed action it answers `ask`,
    which the CLI honours under `--dangerously-skip-permissions` (the stage 6
    live probe, run D1). It never answers `deny`, because you could not
    overrule a deny from your phone, and it fails OPEN: bad input, a crash, a
    missing core or its own 1.5 second budget all end with nothing printed and
    exit 0. The telemetry forwarder is untouched and still cannot block
    anything; the manifest test and the forwarder's rule 1 now say why the one
    exception exists.
  - **Only where a HOAI agent runs.** The hook asks only in a session a HOAI
    daemon is attached to (the daemon marks its project folder while it holds
    its pairing lock). A plain `claude` elsewhere on the same machine, or a
    headless `claude -p` job, gets no new prompt.
  - **The relay stops waving it through.** A default install auto approves, and
    the probe watched it allow the hook's ask in 8 ms (run D3). The hook now
    leaves a floor record before it asks, and the relay takes it before its
    auto approve branch, because the request's own preview is a copy the CLI
    cuts in the middle when a command is long: a delete in the middle of a
    long script was invisible to it. On a match the relay asks the server
    (`POST /api/v1/integrations/assistants/:id/floor-check`, sent the matched
    command): hold posts the card and waits for you, proceed auto approves as
    before, and a check that fails or times out REFUSES the action rather than
    allowing it silently. A held request meets the same drain and no chat
    refusals as any other card. With auto approve off, a proceed in a full
    access session lets the call run as it did before, instead of a card for a
    switch you left off.
  - **The card the server can read.** An MCP tool's card now carries
    `<tool_name> <input_preview>`, so the server recognises a held send, post
    or payment and only you can allow it; a held long command leads with the
    matched command, so you see the delete or the push first.
  - **One list, owned by the server.** `lib/hard-floor-core.mjs` is a port of
    the server's reader in plain JavaScript, so a bare `node` hook can load it;
    `lib/hard-floor.ts` is its typed face for the daemon;
    `lib/hard-floor-fixture.ts` is copied byte for byte from the server's and
    pins six rule ids, their words, rules version 1 and every named case, with
    its digest pinned again in the test. A mention in quotes, a commit message,
    a comment or a heredoc written to a file is not the action; the HOAI
    exemption is the channel's exact server names; `rm --rec` is recursive.
    The cheap shell forms of the same actions are on it too: `find -delete`,
    `git clean -fd`/`-fx`, `rsync --delete`, `git push --mirror`, `--delete`
    and `:branch`, and a redirect, `tee`, `sed -i`, `cp` or `mv` onto a
    protected file. The same fixture now carries the card strings: the relay
    must build each one byte for byte, and the test pins the file's own bytes
    (kept at LF by `.gitattributes`), not only its data.
  - **Clone installs too.** The launchers now write the floor hook's entry into
    `.claude/settings.local.json` beside the forwarder, so a clone agent has the
    same floor as a marketplace one from its next launch through a launcher.
    An always on agent that `bgos-agent update` moves to this release gets the
    entry too: the update re-registers a clone workspace's hooks before it
    restarts the service (a service starts `claude` directly, so nothing else
    would have written it). And the daemon never takes the hook on trust: it
    looks at boot for the blocking entry in the files the CLI reads for its
    session and declares `hard_floor` only when it finds one, so a session
    with no floor hook is not told a hook stops a listed action.
  - **Long commands keep what makes them listed.** The hook's record keeps the
    whole matched command, and the relay fits it to the floor check's 4000
    characters and to the card's lead by dropping arguments, never the
    operator, with a marker saying how many went: `echo "K=<4000 characters>"
    > .env`, a `--force` after hundreds of branch names, `-rf` after hundreds
    of folders and a `cp` of hundreds of files into `.git/hooks/` used to be
    cut from their head, read as harmless and auto approved with the switch
    on, or held on a card the server could not stamp. A held edit whose path
    the preview lost now leads its card with the path. If the listed part
    cannot fit at all, a `hold: false` about the cut body does not auto
    approve it: you are asked.
  - **Only a tap allows a held action.** A typed `yes <id>`, the `Yes, this
    once` label or a callback pasted as text no longer settles a request the
    floor holds (a typed no still does): the server cannot tell a person from
    the agent's own credential on such a message, and the person only gate is
    on the tap.
  - **Not covered, on purpose or for now:** a legacy API key connection and a
    backend without the route (both auto approve a listed action as before,
    and say so in the log), and a delete done by a script, an alias, a
    variable or `python -c` (the list reads text, not intent).
- The daemon's attached marker, which the floor hook asks behind, is keyed by
  the folder the agent was LAUNCHED from as well (`BGOS_LAUNCH_CWD`, which
  `bin/bgos-launch.mjs` hands through when it moves the server to the plugin
  folder), and the hook reads that key too. Before, a launcher start rested on
  `CLAUDE_PROJECT_DIR` alone, and where that was lost (a WSL hop) the floor
  silently did not ask.
- A test ties the channel's own server exemption to the plugin manifest's name
  and channel server, so renaming either cannot turn the channel's own replies
  into floor matches.
- The plan card's own words no longer claim that no hook can stop a tool call:
  an ordinary edit is still never blocked, and the wait is still a promise.
- The bundled offline capability text carries the floor's three core canon
  sentences and the Claude delta sentence, so a model whose canon fetch failed
  is not told the opposite.
- **This daemon declares `hard_floor`.** On every heartbeat and on the canon
  fetch at connect, on every host of a PAIRING connection (a legacy API key
  connection does not declare it: its relay has no floor check to ask and
  auto approves a listed action, so it must not be told a hook holds one;
  `permission_card` and `plan_card` stay declared there, both work on an API
  key), taken from `lib/claude-capability-tokens.ts`
  (now naming three tokens), the file BGOS pins byte for byte, both sides
  pinning the same new sha256. The token promises the blocking floor hook and
  the relay's hold before any auto approve; the served canon tells the floor
  sentence only to a daemon that declares it together with `permission_card`.
  The floor-check limits (200 and 4000) are pinned as literals beside the ones
  BGOS pins on its route.
- The log says what the floor really does. The boot line reads "declared" off
  the declaration itself, so a daemon on an API key, where `hard_floor` is
  never declared, now says plainly that the floor is not declared and why,
  instead of "declaring the floor capability on a pairing". And a typed yes
  the floor refuses, or a verdict from another user, is logged once per row
  per request rather than on every poll tick (the final live proof counted
  57 copies in 37 s).

## 0.52.0 (2026-09-26)

**A message the previous session could not answer comes back after a restart,
instead of being lost forever.**

Board row 294a571a, raised 2026-09-06. The per-chat cursor advances when a
message is FORWARDED, not when it is ANSWERED. So a session that is handed a
message and then cannot act on it, because its account hit a limit, because the
model call failed, because it was killed mid turn, left that message BELOW the
cursor where nothing would ever look again: the delta window starts above it,
`selectFirstPollBacklogIds` only runs for a chat with no cursor at all, and the
restart handed the new session nothing.

The clean exemplar is KC's own question to Argus on 2026-09-24. It was consumed
at 14:29Z by a session whose every model call was being refused, the daemon was
restarted at 14:49Z, the new session came up and sat idle with the question
still open, and it was answered at 14:53Z only because a person noticed and
asked again. A shared account running out of credit is a fleet wide event, so
every message that arrives during one is consumed by a session that cannot
answer it.

`selectRestartRecoveryIds` (lib/poll-core.ts) runs on the BOOT poll only, which
is already the one poll that fetches a chat in full, and re-offers the trailing
messages nobody answered. Three limits, each of which is a way this could have
made things worse:

- **The stop rule is what makes it safe**, not the window or the cap. It is the
  same walk back `selectFirstPollBacklogIds` uses: stop at a real user then
  assistant REPLY. If the previous session DID answer, there is an assistant row
  after the user row and the scan stops before reaching it.
- **Only at or below the cursor.** Rows above it are delivered by the ordinary
  delta path on the same poll, so including them would hand the agent one
  message twice in one turn.
- **A day-long window, a cap of ten, and an undated row does not qualify**,
  because unknown age must not read as recent.

Six mutations, each printed before running and each reddening a named test:
removing the stop rule (6 red, including "a user message the session ANSWERED is
never re-offered"), dropping the cursor bound (2), dropping the age window and
the undated guard (2), dropping the cap (1), dropping the entry guards (1), and
replacing the boot gate with `if (true)` (1).

**That last one is the finding worth keeping.** Its guard passed the first time:
the test searched the 1200 characters before the call for the word `isBootPoll`,
and the comment written above the call contains that word, so replacing the real
gate left all seventeen tests green. A guard that can be satisfied by a COMMENT
is not a guard. It now walks back to the nearest `if (` line and reads that line
itself.

One honest note: the `lastSeen <= 0` half of the entry guard turned out to be
defence in depth rather than load bearing, since the at-or-below-cursor filter
already excludes everything when the cursor is zero. Kept, and said so, rather
than reported as a caught defect.

## 0.51.0 (2026-09-26)

**Two tools that change a mission already running: `add_mission_goals` and
`cancel_mission_goal`.**

KC asked for "add and cancel mini goals" on 2026-09-23. The app has had an owner
goal editor since stage 5 and it REFUSES a mission whose origin is `derived`,
which is every `/goal` mission; the card says so in words and tells the owner to
ask the agent in the chat. The agent then had nothing to change it WITH.
`set_mission_goals` refuses a mission that already has goals, and
`create_mission` SETS THE MISSION ASIDE, so the only answer to "add a goal" was
to destroy the card the owner was reading, every tick on it included.

- `add_mission_goals` APPENDS 1 to 12 goals. Send only the new ones: the backend
  never reads a row the mission already holds, which is what stops a restated
  list from dropping one silently. Refused on a mission with none, which is the
  fill door's job, and refused when the total would pass twelve, with both
  numbers in the sentence.
- `cancel_mission_goal` removes one goal by its id, validated in the path
  builder so a bad id is a sentence the model can act on rather than a 400. A
  TICKED goal is refused: it is a record of work carrying the agent's own
  evidence line. Cancelling the last unticked goal does NOT complete the
  mission, because removing a promise is not keeping one.
- `create_mission` and `set_mission_goals` now point at these two rather than
  only forbidding a create, and the served canon's Missions section loses a
  sentence that had become an instruction to do the destructive thing.

**A guard in this repo was not keeping the promise written in its own header.**
`test/mission-ws-wiring.test.ts` says a "FOURTH mission tool added later must
not be able to forget the stamp quietly", and it named its four tools as
literals in four places, so a fifth and a sixth would have been added with every
one of those tests green and neither checked. The scope is now DERIVED from the
tool dispatch switch: a mission tool is a case that builds a mission path or
body, and a mission WRITE is one that resolves an existing mission id. Proven by
deleting `rememberMissionSelfWrite` from the new cancel case (2 tests red, named)
and by moving its stamp after the DELETE (1 red, named); the literal lists caught
neither. The request-verb search was `Patch|Put` only, so it also now sees a POST
and a DELETE.

Two smaller fixes fell out of building that: a case body was sliced to a fixed
6000 characters, so the last case of a switch swallowed the next switch (that is
how `show_component` briefly appeared to build a mission), and the scan read the
whole file rather than the tool dispatch switch, so WS frame cases arrived as
tools.

Backend: BGOS PR #1669, canon `-goaledit1`. Requires a backend carrying it.

## 0.50.0 (2026-09-25)

**Renumbered from 0.45.0, then from 0.48.0, at merge.** This release was
prepared as 0.45.0, then renumbered 0.48.0 when the plugin's main was released
as 0.46.0 by another program without this work. The permission request card it
stacks on (prepared as 0.44.1, then 0.47.0) has since shipped as 0.49.0 on top
of main's 0.48.1, so this ships as 0.50.0, the next free number above it. The
HOAI canon no longer ties the plan card to a release number: it tells
propose_plan and the plan card only to a daemon that DECLARES the `plan_card`
capability (BGOS #1624), which this one now does, so the number is whatever
release is free when this merges.

- **The agent can now show you its PLAN before it touches anything, and you
  answer with a button.** `propose_plan` posts a real card into the chat: a
  title, one line saying how many steps and files, the numbered steps each with
  the file it touches, a check line, and three buttons, Go ahead, Change the
  plan and Do not do this. The tool returns immediately and the turn ends; your
  answer arrives later as an ordinary click and starts a new turn. Nothing
  parks a watchdog and nothing times out, so a plan answered tomorrow still
  works.
  - **Only the person a plan was proposed to can answer it.** A tap on a plan
    card is bound to that person with the permission card's own rule: a tap
    that names a different person is refused (the agent is not told to proceed:
    the chip and the status line stay up, and nothing reaches the agent),
    while a tap that names nobody, which is every tap on today's backend, is
    accepted. The
    person is the one the card was posted for, or the account owner when a
    restart lost that record. Before this, on a shared assistant, anyone who
    could see the chat could approve a plan and the agent went to work as if
    its owner had.
    The rule holds on every intake: the poll, the boot sweep and the live
    update stream, which reads the tapper off the raw answer payload (its
    normalised answer now carries that id as `clickerUserId`; before, it kept
    only the button fields, so a stamped tap from the wrong person read as
    unstamped on the stream and was accepted). A refused tap does not re arm
    the card: the backend records the first answer, so the plan's person then
    types their answer or the agent proposes again.
  - **The wait on this channel is a CONVENTION, and everything says so.** Every
    HOAI agent is launched with permissions skipped and the shipped manifest
    auto approves, so no tool call is blocked, no hook can stop one, and this
    plugin cannot prevent an edit one second after a plan is proposed. The card
    carries `enforced: false`, which is what puts "will propose before it
    changes anything" on your screen instead of "read only until approved"; the
    tool description, the `/plan` procedure and the agent instructions each say
    it in as many words. Codex, which has a real read only mode, sends `true`.
  - **A revision retires the plan it replaces, in that order, whatever this
    daemon happens to remember.** Pass `supersedes` and the older card loses
    its buttons BEFORE the new one is posted, so two live plans never sit in
    one chat and a tap on the old one cannot approve a plan the agent has
    withdrawn. When this process still holds the old plan the card also dims
    and says what replaced it; when it does not (a restart mid wait, or a model
    naming an older card) the buttons still come off, which is the half that
    matters.
  - **Change the plan carries your words, not a button label.** The app sends
    the typed revision as `custom_text` on the click itself, one stimulus
    instead of a click plus a message, and the agent reads
    `Change the plan: <what you typed>`. It arrives under the `__custom__`
    sentinel rather than `plan:change`, because the chip arms your composer
    instead of answering, so the daemon reads it off the card it landed on and
    hands the agent the `plan:change` code every one of its instructions names.
  - **Your answer settles the wait even if the agent restarted while you were
    thinking.** The status line beside the agent and the Plan mode chip above
    your composer are both taken down on any answer, and no longer depend on
    the daemon still holding the plan in memory. If it was not even running
    when you tapped, it finds the answer on its next boot and acts on it once.
  - **Where a tap lands fast, and where it does not.** A click reaches this
    plugin on the poll and nowhere else, so a chat with an open plan is polled
    every two seconds for thirty minutes. A tap inside that window lands in
    seconds; a later one arrives on the five minute sweep. That is the honest
    trade rather than pinning a chat at two seconds for a plan nobody may
    answer until tomorrow.
  - **A button an agent wrote can never be read as a plan answer.** Every agent
    authored button value is namespaced on the way out, and the plan
    classification now happens before that namespace is stripped, so a reply
    button whose value happens to start `plan:` is an ordinary button both
    ways.
- **`/plan` is a real command now, with a procedure behind it.** It reaches the
  model as an actionable directive whose first step is `propose_plan`, and the
  daemon arms a verifier when it delivers one: cancelled by the first
  `propose_plan` call, fired by the turn's Stop hook when the turn ended without
  a plan, and by a five minute timer where the hook rail is not installed. If no
  plan came, you get one line saying so instead of silence. Typing `/plan` at an
  agent that is ALREADY WORKING no longer fires it early: the verifier only
  answers to the end of a turn that began after you asked, so the turn already
  in flight can finish without taking your chip down and telling you no plan
  arrived seconds after you asked for one.
- **The Plan mode chip, and its close.** The daemon reports the chat's session
  mode (`plan` when it delivers a `/plan`, `default` when the plan is answered
  or you close the chip) so the app can draw the chip above the composer. The
  close arrives as `/code` and is answered by the daemon, never handed to the
  model, which would otherwise have told you your own close button was
  unavailable.
- **The owner's plan level reaches the agent on every transport.** The per agent
  setting ("Only when I ask", "For bigger or risky jobs", "Always before it
  changes anything") rides the inbound envelope as a labelled sentence and is
  rendered into the turn the model reads, on the poll, the stream and the
  socket alike. The daemon never reads the setting itself: the server decides,
  the daemon renders what it is handed.
  - **The poll rail gets it from the socket, because the poll route does not
    carry it.** The backend puts the level on the socket event and on the agent
    update stream. The chat history route this daemon polls is the app's own
    projection and has no such field, so the poll read nothing on every delivery
    and an owner on "Always" got an agent planning at the default for every turn
    the poll won, which during a plan wait is most of them. The daemon now
    remembers what the last carrying rail said, absence included, and the poll
    answers from that. A level the owner turns back DOWN therefore stops on the
    next socket delivery rather than lingering.
- **Reply buttons can ask for a colour.** `reply`'s `buttons[]` gains an
  optional `style` (`default | primary | success | danger`). An unknown value is
  dropped rather than refused, because losing a whole message over a colour is
  the wrong trade. Until now only approval cards sent a tier and every agent
  authored chip rendered neutral.
- **Fixed: the agent instructions advertised `/clear` and `/cost`.** Both were
  removed from the catalog on 2026-08-30, because nothing here can reset a
  context window or read client side accounting, so the model was being handed
  two commands that come back unavailable. The instructions now say that
  plainly.
- **Hardened: `plan:` is a reserved button namespace.** An agent authored reply
  button whose value was `plan:go` would have come back through the same intake
  as a real approval on a plan card. It is now escaped like any other agent
  value.
- **This daemon declares `plan_card`.** On every heartbeat and on the
  capabilities fetch at connect, on every host, because `propose_plan` is a
  typed tool with no platform limit. It is what tells the canon to describe
  the tool and the card to this agent.

## 0.49.0 (2026-09-25)

**Renumbered from 0.44.1, then from 0.47.0, at merge.** This release was
prepared as 0.44.1, then renumbered 0.47.0 when the plugin's main was released
as 0.46.0 by another program without this work. Main has since moved on again
without it (0.47.1, 0.48.0 and 0.48.1; main's own 0.47.0 was never released and
was folded into 0.47.1), so it ships as 0.49.0 on top of 0.48.1. The HOAI canon no longer ties the
permission request card to a release number: it tells the card only to a
daemon that DECLARES the `permission_card` capability (BGOS #1624), which this
one now does, so the number is whatever release is free when this merges.

- **A permission request now looks like one, and stops dying after two
  minutes.** When this agent needed an OK before running a tool, it posted a plain
  chat message with four grey chips and gave up on its own after two minutes.
  It looked like the approval card the rest of HOAI uses and was nothing like
  it: the app drew chips instead of a card, the agent read as FINISHED on every
  needs you surface while it sat there waiting, and the morning report never
  counted the request at all, because every one of those reads the
  `approval_request` message type and this relay did not send it.
  - **The card is a real one.** `messageType: 'approval_request'`, an
    `approvalMeta` naming the tool, the route and the request id, and exactly
    two buttons: Allow once and Deny, in the platform's `ea:<choice>:<id>`
    vocabulary. Two and not four, because the CLI accepts only allow or deny,
    so a session or permanent button would have promised the owner a memory
    this agent does not have.
  - **The owner decides how long it waits, and this daemon only offers.** The
    plugin reads no setting of the owner's. Every card carries
    `wait_seconds: 1800`, the longest this daemon can keep its own side of a
    request open, and the SERVER stores the smaller of that and the owner's
    per agent choice (10 minutes unless they change it). That stored number
    comes back on the created message, and it is what the card says and what
    this daemon's own backstop is built from. Sending nothing instead would be
    the shortest wait of all: a card with no `wait_seconds` gets the server's
    generic minute, shorter than the two minutes this replaces.
  - **Deploy the backend first, and this is why.** Both halves this release
    leans on are on one BGOS branch, `feat/p2-requests-wait-for-you`, and
    neither is on the deployed backend yet.
    - The **push**: the card has to go to the messages route, because that is
      the only one that carries an `approvalMeta` at all, and that route sends
      no device notification today. Every push in HOAI is sent from the other
      one. So until that branch deploys, a request raised while the app is
      closed reaches nobody.
    - The **per agent clamp**: the deployed backend caps `wait_seconds` at
      1800 and stores what it is given. Until the clamp lands, every request
      from this daemon waits the full 30 minutes whatever the owner chose,
      and can hold an update's drain for that whole time (see below).
    Both are reasons to let hosts take this release AFTER the backend is out,
    not before.
  - **The server is the only judge of when a request is dead.** The 120 s
    local clock is gone. The wait ends on the owner's answer, or on the
    server's own expiry flag, or on a backstop 90 s BEHIND the stored wait for
    a server that never answers, which also strips the buttons off a card
    nobody is listening to. A yes in the last seconds is honoured now, where
    before it hit a request the daemon had already declined. And a request
    raised while an auto update is draining the daemon is answered with a no
    instead of hanging the CLI on a question nothing was left to answer.
  - **The tap is read off the card, which is what makes the answer arrive at
    all.** Pressing Allow writes no message into the chat: the backend stamps
    the answer onto the card row and pushes the event to whichever daemon is
    paired for clicks, and this one is not paired for them. So the wait now
    reads the owner's answer off the card row it is already watching. That is
    the lane that exists in the two cases where the others do not: when the
    card has slid off the newest page of a busy chat, and while a self update
    has the daemon's inbound intake shut. Both of those used to end in a deny
    at the backstop with the owner's Allow thrown away. The same tap can still
    arrive on the ordinary poll a cycle later; the request is settled exactly
    once, and the late copy finds nothing to resolve. WHOSE tap it is comes off
    the answer the backend stamps on the card, and no backend stamps a tapper
    there yet: a tap nobody named is accepted, because the alternative on a
    shared agent is to throw away an approval the owner really gave, and only a
    tap that names a different person is refused. The two click intakes keep
    their older, stricter rule, and a click they refuse is not a verdict lost
    whenever the card's id came back off the post, because this read then sees
    the same answer on the card a moment later (with no id that read is off).
  - **A parked request reads its chat on a budget, and the budget is the
    wait.** TWO loops read that chat while a request waits, and only counting
    one of them is how a half hour request got expensive. The verdict watch now
    looks every 1.5 s for the first minute, where an answer usually lands, then
    every 5 s: about 390 looks over half an hour rather than 1,200. The
    daemon's own 2 s fast scope stays on the chat for exactly as long as this
    daemon is still listening to the request, which is about 300 reads at the
    ten minute wait the clamp will make the default and about 900 at the
    unclamped half hour. It is NOT cut shorter than that, and a first attempt
    to cut it at ten minutes was wrong: that scope is what keeps the ordinary
    poll's own click intake prompt, and a chat dropped out of it is read on the
    five minute sweep instead, so a tap could sit unheard for five minutes.
    Every one of these reads still carries an If-None-Match.
  - **The expiry reaches a request in a busy chat.** The watch reads a PAGE of
    the chat, the newest 50 messages, and a card posted into a chat with
    several people talking can slide off that page during a wait that now
    lasts minutes. The server's "this request is dead" flag lives on the card
    row, so once the row was off the page nothing ended the wait but the local
    backstop, with the CLI blocked the whole time. The card is now read on its
    own, anchored, the moment the page stops carrying it.
  - **A daemon that stops mid wait no longer leaves a live looking card.**
    The requests a process is holding live in its memory, so a crash, a kill or
    an ordinary restart takes them with it: nothing answers the CLI, and, worse
    for the owner, nothing takes the buttons off the card. It sat there
    tappable until the server expired it, which used to be a minute and is now
    up to the whole wait, and a tap on it showed as answered while nothing was
    listening. On boot the daemon now retires its own unanswered cards on the
    newest page of each chat it monitors, one log line each. A card a busy chat
    has already pushed off that page is still left to the server's expiry:
    reading further back on every boot would cost every daemon a great deal to
    catch the rarest case. A card posted in the last minute before this daemon
    booted is left alone too: the row's date is the server's clock and the
    cutoff is this machine's, so the sweep allows a minute for the two to
    disagree rather than risk taking the buttons off a card another daemon is
    at that moment waiting on.
  - **Known and not fixed here: a pending request holds an auto update's
    drain** for as long as it waits, because the handler runs inside the same
    message operation tracker that the drain waits on. Up to the owner's whole
    wait once the backend clamp is deployed, and up to the full 30 minutes
    until then. Bounding the drain belongs to the self update lane, not to
    this one. What DOES end such a request while the daemon drains: the owner's
    tap, heard through the watch only (both click intakes are shut in a drain),
    a typed `yes <code>`, the server's own expiry, or the local backstop.
  - **Nothing changes for an agent installed with auto approve on**, which is
    the default: that check answers first, ahead of everything else in the
    handler, including the drain. It needs no chat, no network and no intake,
    so an update drain must not turn it into a refusal. The drain deny above is
    for interactive mode, where the card genuinely cannot be posted or heard.
  - **A prompt left on screen by a 0.48.1 or older daemon** is still
    recognised, for one release, though not for the reason the first draft of
    this note gave. It cannot be ANSWERED across the update: the pending
    request died with the process that posted it. What the tolerance buys is
    that such a click is swallowed as a stale permission click rather than
    forwarded to the model as ordinary chatter.
  - **The daemon says which backend it needs, at boot.** One line naming the
    two halves above, so a host that takes this release ahead of the backend
    reads it in the log instead of wondering why requests wait the full offer
    and ring nobody.
- **This daemon declares `permission_card`, and the canon fetch carries the
  declaration.** The token rides every heartbeat on every host, because the
  relay speaks the channel's own permission notification and has no platform
  limit. The capabilities fetch at connect now sends the declared list too
  (`capabilitiesFetchPath`, the same helper the Kanban release adds for
  `boards_playbook`), because that fetch can run before the first heartbeat
  has stored the list, and the agent would otherwise not be told about the
  card until the canon was fetched again.

## 0.48.1

**An agent whose browser runs on its own machine is no longer read as offline when the owner's desktop app is closed.**
The browser tools' presence probe asked the backend for the browser host WITHOUT naming the agent, so the backend
answered for the owner's desktop alone. With that app closed, every browser call from an agent placed on its own
machine was refused as host offline, which is exactly the case the placement exists for (HOAI mission 25 goal 6).
The probe now sends the agent's id, and the backend answers with the agent's own host when the owner placed it
there. Re-vendored from HOAI's shim (BGOS #1642); bin/hoai-browser-mcp.mjs hashes to the pin, aaaff4b6.

## 0.48.0

**set_mission_goals: the agent writes the goals of a mission that has none.**
Every /goal mission, and every mission an owner starts from the app, begins
with no mini goals. Keep working ON now wakes the agent about every 30 minutes
while a goal is unticked (HOAI #1635), and on a goal-less mission that wake
asks the agent to write its goals first (KC, 2026-09-24).

- **New tool `set_mission_goals`** (`mini_goals`, optional `mission_id` and
  `chat_id`): `PUT integrations/assistants/:id/missions/:missionId/goals`. It
  writes 2 to 12 `{ name, done_when }` goals into the OPEN mission that has
  NONE, and keeps the same mission, so its Keep working switch and wake stay
  with it. `create_mission` would have replaced it. A mission that already has
  goals is refused: tick those instead. It validates goals with the same rule
  as `create_mission`, now shared, so the two can never disagree.
- **Declares `mission_set_goals` on every host.** The backend arms the
  goal-less Keep working wake only for a daemon declaring it, so an agent is
  never woken every 30 minutes to do something it has no tool for. It is a
  plain HTTP write, so unlike the goal loop it needs no tmux.

## 0.47.1

**The agent's own browser asks its owner, as a card, and waits.** 0.46.0 shipped
that browser UNGATED and named the gates as the follow-up; this is it. The
0.47.0 entry below was written when only the rules had landed and said the host
"does not yet ask with them". It does now, so that heading is folded into this
one rather than left to read as the shipped state of something it describes
half of. 0.47.0 was never released.

- **Permission gates, using the desktop's rules.** Every browser_ call is
  classified and decided by the vendored `policy.js`, so an agent is judged by
  the same rules wherever its browser runs. A new site, any write on one, a
  download, an upload, running scripts and every sensitive action is asked
  about; a password or a code is never remembered by any answer.
- **The card is the only surface, and it is posted immediately.** The desktop
  opens a gate as a strip with a 60 second countdown and only PARKS an
  unanswered one into the owner's chat. There is no pane on the agent's
  machine and nobody is sitting at it, so there is no strip: the card goes to
  the owner's chat with that agent the moment the gate is raised.
- **The host ASKS what the owner answered**, on `GET /api/v1/browser/gate/:gateId`.
  `browser_gate_answer` is emitted to the owner's person room and never to an
  agent socket, and this host joins only `browser-host:<assistantId>`, so it
  could otherwise post a card and then wait out the whole park for a frame that
  cannot reach it. The read is scoped to the account AND to the assistant the
  host serves, so a host serving one agent cannot read another's decision.
- **The action runs at most once**, whichever call returns it. A gate that
  outlives its call parks with a gate id, and `hoai_browser_wait_gate`
  re-attaches to the same held run rather than starting a second.
- **An ordinary gate answers inside the call that asked.** The attach budget
  sits under the relay's call cap and over the default 60 second wait, and a
  guard pins that ordering: it shipped inverted for one commit, and every gate
  would have parked five seconds before its own deadline.
- **Fail closed on every path that is not an explicit allow**: a card that could
  not be posted, a gate the server no longer has, an expired card, a park that
  runs out, an answer whose choice cannot be read, a gate kind the card route
  cannot carry, and a host with no way to reach the owner at all.
- **A group's browser is its own.** A room's frame carries `group-<chatId>`
  rather than the acting human's principal, and a test with a real Chromium
  shows the group sees neither the owner's nor either member's cookie, and that
  its own does not leak back.
- **`profiles.js` joins the vendored tier**, so "Always allow" and "Trust this
  site" are stored in the shape the desktop reads. Both sides of the pin now
  DERIVE the file set from disk instead of naming it, after a third file was
  vendored, hashed, and silently checked by nothing.

## 0.47.0 (never released, folded into 0.47.1)

- **`lib/browser-host-core/` holds byte-identical copies of the BGOS rule tier**
  (`policy.js` and `settings.js`): what counts as a read, a write, a sensitive
  action, a credential, a blocked category, and what the owner's grants mean.
  They are COPIED rather than re-implemented on purpose. Two hand-written
  copies of a permission policy is how two hosts quietly come to disagree about
  what is sensitive, and the disagreement surfaces as an agent doing something
  on one machine that it would have been stopped from doing on another.
  - They keep their ORIGINAL filenames in a directory of their own, because
    `settings.js` does `require("./policy")`: a rename breaks that require and
    a patched require breaks the byte-identity the hash exists to protect.
  - The nested `package.json` declaring `type: commonjs` is load-bearing, since
    this package is `type: module`; without it Node reads them as ESM and the
    host cannot load the rules at all.
- **Drift is now caught in BOTH directions.** `lib/browser-host-core/vendor.json`
  pins each file's sha256 and `test/browser-host-core.vendor.test.ts` reads it,
  following the shim's pattern; and BGOS carries a matching pin, so editing a
  rule there fails ITS suite until someone re-vendors here. The shim's own
  vendor test documents that missing second half, and that gap had already
  shipped a stale copy with a dead relay lane for a round.
- The vendor test does not stop at hashes: it loads the rules and asks them to
  decide, so a passing hash is not the only thing proven.
- `bin/hoai-browser-host.mjs` imports them and exposes `policy` and
  `hostSettings`. Nothing calls them yet, so behaviour is unchanged.

**Still ungated, and a backend gap is why.** `browser_gate_answer` reaches the
owner's PERSON room only, deliberately, and a daemon host joins only its
`browser-host:<assistantId>` room, so it can post a permission card and never
hear the answer. A host-scoped read has to exist first; until it does, wiring
the gate here would be a wait that never fires.

## 0.46.0

**Runs ungated on purpose, by the owner's decision (2026-09-23).** A
daemon-placed agent's browser raises NO permission strip: a new site, a write
on a signed-in site, a download, an upload and every sensitive action just run,
where the desktop Agent Browser stops and asks. The owner was shown that
difference and chose it for now. Moving the gates into the host is the
follow-up, and the served capability canon is corrected in the same breath so
no agent is told it will be asked when it will not be.


- **An agent's own browser, on the machine the agent lives on.** New
  `bin/hoai-browser-host.mjs`, run with node. It connects one socket per
  pairing on this machine with the `browser_host` handshake the backend
  already serves (the pairing token in the query; the role, only that
  pairing's agents and the device label in the auth), answers each
  `browser_rpc` frame through the desktop's own engine (Playwright's
  `BrowserBackend` over the same filtered roster, so `tools/list` is byte
  identical to the desktop's) and posts the answer to
  `/api/v1/browser/rpc/<rpcId>/result` with the same pairing token and the
  socket the frame arrived on. A notification is never posted.
  - **It drives a real, installed Chrome or Chromium** over CDP
    (`--remote-debugging-port`, `--user-data-dir`), headless by default. It
    never downloads a browser; when none is installed it says so at startup
    and in every call that needs one.
  - **The profile is keyed by principal, not by agent:**
    `~/.bgos-agent/<assistantId>/browser/<principal>/`, `owner` when the frame
    names none. Two different principals always get two directories, on a
    case-insensitive disk too, and a principal the host cannot read is
    refused rather than served from the owner's profile. A test with a real
    Chromium proves one principal's cookie is never sent for another.
  - Adds `playwright-core` 1.63.0 (the desktop's pin) as a dependency and
    `socket.io` as a dev dependency for the fake relay the tests drive.
  - Two existing tests skipped with `t.skip()` or the `skip` option, which
    bun's `node:test` does not honour, now also return early, so `bun test`
    is green as well as `npm test`.
- **The daemon starts that host itself.** `server.ts` spawns
  `bin/hoai-browser-host.mjs` under node on every paired daemon
  (`lib/browser-host-supervisor.ts`), scoped to the daemon's own pairing, with
  its output in `~/.bgos-agent/browser-host-<digest>.log` and never on the
  daemon's stdio, and stops it when the daemon exits (the host also stops
  itself if the daemon is killed outright).
  - **Unconditional, and safe by construction:** the backend elects an agent
    host only for an agent whose browser placement is `daemon`, so a
    desktop-placed agent's host never receives a frame, and Chromium and
    playwright-core load only on the first frame; an idle host is one node
    process (about 80 MB resident on macOS) holding one socket.
  - **One host per pairing on a machine,** through the reclaimable lock of
    `lib/pairing-lock.ts` at a per-pairing path: a second daemon of the same
    pairing waits, and takes the host over when the first daemon or its host
    is gone. A holder that is alive but late (a machine waking from sleep) is
    given a full recheck to beat again before its lock is taken, and a daemon
    whose lock was taken stands its host down and waits to take it back.
  - **Chrome and the host get an ALLOW-LISTED environment**
    (`lib/browser-env.mjs`), not a deny-list by name: a name rule cannot
    see `SSH_AUTH_SOCK`, a live handle to the user's ssh-agent. Chrome gets
    PATH, HOME, TMPDIR/TMP/TEMP, USER/LOGNAME, LANG/LANGUAGE/LC_*, TZ, the
    Windows system folders on Windows, and on linux the display and session
    variables only when it is shown. The host gets that plus its own
    `HOAI_BROWSER_*` settings, `NODE_EXTRA_CA_CERTS` and its pairing token,
    which it drops from its environment once read. Anything else is opt-in
    by name in `HOAI_BROWSER_CHROME_ENV`, and a credential-looking name is
    dropped even then.
  - **It can never take the daemon down.** A missing node, a spawn that
    fails, or a host that crashes is one log line; the daemon carries on and
    does not restart that host.
  - **Kill switch: `HOAI_BROWSER_HOST=off`** (also `0`, `false`, `no`) skips
    the spawn entirely.
  - Review fixes to the host: it no longer exits when it has no live socket
    (no credentials yet, or refused by the gateway), a stop during a Chrome
    launch now stops that Chrome, JSON-RPC ids `1` and `"1"` no longer share a
    waiter, the CDP connect after a launch is bounded, and a Snap Chromium
    (which cannot open a profile under `~/.bgos-agent`) is skipped with a
    message that says so. `package-lock.json` now carries the new
    dependencies.

## 0.44.0 (2026-09-21)

- **The helpers a turn hands work to get a row each, and the owner watches
  them work.** Until now delegating was invisible: the card said an Agent tool
  had run and finished in five milliseconds, which is how long the launch took
  and not how long the child worked, and everything the child then did arrived
  as unattributed rows in the middle of the parent's own. Now each child is a
  row of its own, named by the kind of helper it is, carrying the one line
  description it was given, a state, an elapsed time that ticks while it works,
  what it is doing right now, and, when it finishes, its last message.
  - **Every part of it comes from the runtime's own events, and each part is
    drawn only where its datum exists.** The row opens when the launch is
    asked for and its start is the moment the hook process stamped on that
    line. The launch RESPONSE is what says a child was handed off rather than
    a tool finished, so the five milliseconds the response took is never
    written as a helper's time. The elapsed is the difference between two of
    this host's own receipts. A child that never reports back carries no time
    and no result at all, because absent means absent.
  - **A card now stays open while a helper is still working, even after the
    turn has ended.** A finished card folds, and a helper ticking behind a
    fold helps nobody. So a turn that stops with a child still running leaves
    its card behind and the child's own stop, minutes later, updates that same
    card instead of posting a second one. The card settles when the last child
    settles.
  - **More than one card can be waiting, and none of them can be written over
    by another.** A card a turn leaves behind is kept under a name of its own,
    so a later turn cannot write over the card the owner is watching a helper
    on, and a second turn that ends the same way keeps the first card as well
    rather than abandoning it half done. The commands a child runs after that
    point land on that same card, beside the helper row they belong to, so one
    delegating turn is one card in the chat however long the child goes on
    working. Every card still owed an update has its own place in the queue, so
    what a helper is doing right now reaches its card while it is still working
    instead of being dropped for whatever the parent drew a moment later.
  - **The child's own commands are still there.** A helper's Bash row still
    carries the command, what it printed and the code it exited with, exactly
    as before, and the helper's row says which of them it is running right
    now. Nothing was taken away to make room for this.
  - **Nothing is promised that this runtime cannot give.** There is no token
    count, because the host is never handed one for a child, and no way to
    stop one helper: Claude Code offers no door for it, and a button that
    cannot do what it says is worse than no button. Both are recorded as
    blocked rather than postponed.
  - **One new hook event, and only one.** `SubagentStop` is registered;
    `SubagentStart` deliberately is not, because it carries no description and
    no tool id, so it can name nothing and be joined to nothing. A stop whose
    child this host never saw launched is ignored outright, which is what
    keeps the composer's own suggestion generator from drawing helpers nobody
    asked for.
  - **Nothing here is new for an owner who keeps the switch off.** The card is
    still hidden by the per agent "Show technical details" setting, still off
    by default, and this daemon still never reads it: the plugin always sends,
    and what is drawn is the owner's choice.

## 0.43.0 (2026-09-21)

- **The folded card after a turn stops saying "Used 5 tools" and starts saying
  what happened.** How long the turn took, how many tools ran, how many failed
  and how many files changed, and underneath it a shell row now carries what
  the command printed and the code it exited with, and an edit row the lines it
  added and removed. The owner opens a row and reads the output where before
  they had to ask the agent what it saw.
  - **Every number comes from the runtime's own events, and each part is drawn
    only where its datum exists.** The turn's start and finish are the moments
    the hook process stamped on its own receipts, never the moment this daemon
    happened to read the spool file (idle polling delays that by two seconds
    and an unproven session by up to a minute, so a card built on the later
    clock can report minutes that are wrong by more than the turn was long).
    A card with no clock shows no minutes. A row with no output has no chevron.
    A grep that matched nothing reports no exit code at all, because zero would
    be a lie and one would be a guess: it carries the runtime's own reading,
    "No matches found", as its short qualifier instead.
  - **What a command printed is masked before it is cut, and never leaves the
    machine in full.** The plugin's secret scanner runs over the output first
    and the tail is taken second, because cutting first can slice a token in
    half and hand the scanner a value its pattern no longer matches. Then the
    caps: the last 2048 characters and the last 200 lines of a row, and 8192
    characters of output across a whole card, spent newest first. Those caps
    are applied before EVERY write and not only the last one, because the whole
    tool list rides every card update while a turn is live.
  - **Nothing here is new for an owner who keeps the switch off.** The card is
    still hidden by the per agent "Show technical details" setting, still off
    by default, and this daemon still never reads it: the plugin always sends,
    and what is drawn is the owner's choice.
  - **No Undo button, and it is blocked rather than deferred.** Claude Code's
    own `/rewind` is an interactive selector with no tool, no channel method
    and no control request behind it, so a daemon cannot call it and a button
    that cannot do what it says is worse than no button.

## 0.42.3 (2026-09-22)

Two live defects that 0.42.1 and 0.42.2 shipped, plus the startup gates.

- **The doctor failed EVERY desktop one-click install.** 0.42.2 added a folder
  trust row that GATES the preflight, and the desktop runs `hoai doctor
  --preflight` from the owner's HOME with no `--workdir`, so it checked the
  wrong folder and failed after the pair code was already spent. Measured from
  HOME against 0.42.2: `FAIL Folder trust` then `preflight FAILED: trust`. The
  row now reads UNPROVEN when no agent folder was named, carries its remedy in
  the detail, and resolves the folder from a pin when there is one. It also
  honours trust INHERITED from a trusted ancestor, which Claude Code does and
  the exact-key lookup did not.
- **The trust seed replaced an owner's `~/.claude.json` when it could not read
  it.** A 0600 file it could not parse came back as a fresh five line config at
  0644, no backup, and the function reported success. Measured, and the same
  for a zero byte file, a non-object and EACCES. It now refuses and says so,
  leaving the file exactly as it was; both call sites already treat the seed as
  best effort, so a refusal costs nobody their install.
- **The startup gate block answers a gate by READING it**, rather than pressing
  a key it hopes is right. It waits for the screen to be quiet, identifies a
  gate by its footer phrase rather than a bare word (a resumed transcript
  saying "can you confirm" had made the supervisor kill a healthy agent), reads
  where the selection marker actually sits after each Down, and sends nothing
  at all on a screen it does not recognise, reporting what was on it instead.

A timing note worth keeping, because it made a correct fix look broken: a key
sent within about 100 ms of the trust gate painting is drawn but not honoured,
and the Enter that follows still declines. From about 150 ms on the same bytes
work. Two people measured opposite results from the same key for exactly that
reason.

## 0.42.2 (2026-09-21)

The other half of the same install post-mortem, plus one defect found while
verifying the fix that shipped in 0.42.1.

- **`hoai` never reached the user's own PATH.** After a marketplace install the
  command resolved inside Claude Code, which injects the plugin's `bin/` into
  its session environment, and answered `command not found` in the user's
  terminal. The remedy existed but pairing printed it as a conditional footnote
  BELOW the line declaring setup complete. Pairing now RUNS `install-cli` as its
  last step and says what it did, best effort and never fatal.
- **`hoai doctor` passed while the agent could not start.** Twelve PASS rows and
  one SKIP on a machine where every launch exited instantly, because the doctor
  validated the channel and never the launch. Four rows now cover the launch
  itself, and a check that never ran renders UNPROVEN rather than SKIP: the one
  honest row in that report read SKIP, which a reader takes as "not applicable"
  when it meant "unverified".
- **`waitForIncumbent` blocked forever.** No deadline, no escape, and a process
  whose cwd merely COULD NOT BE READ counted as blocking, so any claude under
  the same uid that `lsof` could not inspect held every launch. Bounded at 90s
  with the incumbent pid and how to clear it; an unreadable cwd is an absence of
  evidence, not evidence of a conflict, so it warns and lets the launch through.
- **Pairing from `$HOME` made the home directory the agent folder**, after which
  the agent ran with permissions skipped across the whole home. Refused now,
  before the code exchange, because a pair code is one-time and expires.
- **The trust seed wrote a key Claude Code never looks up.** 0.42.1 fixed WHICH
  FILE `preseedClaudeTrust` writes; this fixes the KEY inside it. Claude Code
  keys `projects` on the RESOLVED cwd, and `/var` is a symlink to `/private/var`
  on every Mac, so a seed for a folder under `/tmp` or `/var` reported success
  and changed nothing. Measured on a fresh folder against the real CLI: seeding
  the literal path left the trust dialog showing, seeding the resolved path made
  it disappear. Both spellings are seeded now, and a realpath that throws still
  seeds the literal cwd rather than skipping.

Also, as a rule rather than a patch: a setup step never silently replaces
anything. `install-cli` runs only on the interactive pairing path, never from
the watcher's background daemon, and when it finds a shim pointing elsewhere it
prints what it found and which one wins on PATH instead of re-pointing it.

## 0.42.1 (2026-09-21)

A first-time install on a fresh macOS user failed at four separate points, and
every one of them failed SILENTLY. Compiled from a real debugging session, then
each defect verified in source and on the host before it was touched.

- **The trust pre-seed wrote to a file Claude Code never opens.**
  `preseedClaudeTrust` derived its target by joining the config directory, so
  with `CLAUDE_CONFIG_DIR` unset it wrote `~/.claude/.claude.json` while the CLI
  reads `~/.claude.json`. The `settings.json` half of the same function resolved
  correctly, which is why the failure read as a partial success rather than a
  bug. A new `claudeConfigFilePath({env, home})` answers the question the config
  directory cannot. Every existing test passed over this because all of them
  inject an explicit `configDir`; the unset case now has its own test.

- **Nothing on the hand-typed path ever pre-seeded anything.**
  `preseedClaudeTrust` had exactly one production caller, the app's create-agent
  flow, so running `hoai` by hand (the command pairing itself tells you to run)
  seeded nothing. It is now called from pairing and from the launcher, the
  second of which also repairs agents paired by older versions.

- **The startup gate answered unknown screens with a blind Enter.** The posix
  expect wrapper ended in `timeout { send "\r" }`. The bypass-permissions
  warning defaults to DECLINE, so an unrecognised screen was answered by
  quitting, instantly and with no output. It now falls through to `interact`
  and lets the person decide. This file's own comment about the Windows helper
  had already stated the rule it broke: never press blindly on a prompt with a
  dangerous default.

- **An unpaired daemon died before the handshake, so nothing could say why.**
  The host could only report `CONNECTION_CLOSED` while the real reason went to
  stderr where nobody reads it. An unpaired server now completes `initialize`
  and offers a single `hoai_pair_required` tool carrying the instructions. A
  degraded connected server is diagnosable from inside the session; a dead one
  is not.

Not fixed here, and named so they are not assumed: `hoai` still does not reach
the user's own PATH after a marketplace install, `hoai doctor` still passes
while the agent cannot start, `waitForIncumbent` still has no timeout, and
pairing still accepts `$HOME` as an agent folder.

## 0.42.0 (2026-09-21)

- **Keep working until it is done: the agent's own goal loop reaches the
  mission card.** Claude Code has had a real goal loop of its own for a while:
  a person types `/goal <condition>` in the terminal, and after every turn a
  separate checker reads the work and answers met, not yet with a reason, or
  cannot be done with a reason. None of that reached the owner's phone. This
  release makes the whole of it visible, and on the hosts where this daemon can
  type into its own session it lets the owner's **Keep working** switch arm one.
  - **The reading half works on every host, Windows included.** The verdict is
    in NO hook payload (the Stop schema carries `hook_event_name`,
    `stop_hook_active`, `last_assistant_message`, `background_tasks` and
    `session_crons` and nothing else), and the checker runs as a SECOND hook
    inside the same Stop batch. So the hook is a wake and the session
    transcript is the source: `lib/goal-tail.ts` is a cursored tailer over the
    PROVEN transcript only (a goal set in a neighbour's session on the same
    machine is never adopted), `lib/goal-status.ts` maps the five
    `goal_status` shapes, and `lib/goal-writes.ts` decides which mission write
    each one deserves. A Windows agent shows a complete Last check, the turns
    and the time for a goal a person typed in its own terminal, and gets a
    mission card of its own for it.
  - **Time and turns only where the runtime counted them.** A not met check
    reports no iterations, no elapsed time and no tokens at all, so a live
    check sends the check count and NO working time; the time arrives with the
    terminal record or it never arrives. Nothing is ever worked out from when
    the mission was created.
  - **The turns already spent are carried.** "Give it 10 more turns" raises the
    cap and arms the same goal again, and the runtime starts its own count over
    at the new set sentinel. The lane adds what it already counted, so the card
    goes from 20 of 20 to 21 of 30 rather than back to 1.
  - **Two stops, both this daemon's.** The owner's turn cap, and three checks in
    a row that found the same thing after trimming, collapsing the whitespace
    and lowercasing (a judge rewords one finding between turns, and treating a
    reword as progress is how a goal loops for ever). Each clears the native
    goal and posts `stopped` so the server can turn the mission to Needs you.
    The runtime has its own competing pause and retry loop, with its own words,
    and it runs in interactive sessions, which every BGOS agent is: this
    daemon's stop wins and is the only one the owner sees.
  - **Setting a goal is the tmux injector, and nothing else.** A channel push
    provably cannot arm one: the CLI hard codes `skipSlashCommands: true` on
    the channel enqueue and wraps the text in a `<channel>` element before any
    flag could be read. `lib/compact-inject.ts` gains its FIRST parameterised
    literal in exchange, behind a validator that refuses an empty condition, a
    multi line one, any control character, anything over the runtime's own 4000
    character cap, and anything beginning with `/`, plus a `--` before the
    literal so a condition starting with a dash is text and not a tmux flag.
    See `docs/learnings/a-channel-push-cannot-arm-a-native-goal.md`.
  - **The declaration is now computed per beat.** `lib/declared-capabilities.ts`
    is a frozen base plus a pure function: `mission_events` and
    `mission_goal_checks` on every host, `mission_goal_loop` and `mission_pause`
    only while the injector answers. A late tmux upgrade (up to thirty minutes
    after boot) starts declaring on the next heartbeat, and a host that cannot
    type is never offered a switch that would do nothing. `mission_pause` was
    deliberately absent until now; clearing the native goal is the pause this
    daemon can genuinely enforce, and the canon says plainly what it means: the
    loop stops after the current turn, and a turn already running is not killed.
  - **Pause, Resume and Set aside reach a goal nobody armed from the app.** The
    owner is offered those three buttons on every open mission of this agent,
    and the pause this daemon enforces is clearing the native goal, so the lane
    reads them against the mission it is REPORTING on and not only against the
    one the switch armed. A goal a person typed in their own terminal has a
    derived mission and no switch behind it: Pause clears it and the checks
    stop, Resume puts the same condition back, and Set aside forgets it.
  - **The model is told, in the instructions, that it does not set goals.**
    There is no tool for one and it must not try to type a slash command; it
    works the condition, ends its turn normally, treats a not yet reason as the
    next instruction, and never ticks a mini goal because a check passed.
  - `/goal` is deliberately NOT published in the slash catalog: the app passes a
    typed `/goal <text>` straight to the agent when the server catalog carries
    it, and on this channel the model cannot set one, so publishing it would
    break the app's own door.
- **The channel's protocol era is pinned.** Claude Code refuses to deliver an
  unsolicited notification (a channel push, which is every inbound BGOS
  message) over a connection whose negotiated protocol revision it considers
  modern, and the MCP SDK answers `initialize` with whatever revision the CLI
  asked for. The era this channel lives in was therefore decided by the CLI's
  request and by whichever SDK a `bun install` resolved, both of which move
  without this repository, and the day one of them crossed the line the daemon
  would have gone deaf with nothing on screen and nothing in any log.
  `lib/channel-transport.ts` now pins the answer to the legacy revision a live
  session was proved to accept, wrapping the SDK's own handler rather than
  replacing it, and failing open if a future SDK has no handler to wrap.

## 0.41.0 (2026-09-20)

- **Your owner's decisions about a mission now reach you.** Until this release a
  mission was something the agent wrote and never heard about again: the owner
  could press Set aside, Mark done, Pause or Resume in the app, the card in
  front of them changed, and the agent kept working a goal that was already
  dead. The daemon now listens for the eight `mission_*` frames it was already
  being sent and tells the live session, in one plain line in the chat's own
  channel voice, what its owner decided.
  - `lib/mission-events.ts` is the whole decision, pure and unit tested:
    `parseMissionEvent` is total (junk in, null out, never a throw into the
    socket handler), and `decideMissionNotice` returns the words or null. The
    narrated set is exactly five: paused, resumed, set aside, marked done, and
    a mission the OWNER started. `mission_ticked` is never narrated, because
    the owner cannot tick, so every tick is the agent's own write and the model
    already has the tool result; telling it again is noise in its context.
  - **Three ways this could have gone wrong, each closed with a test.** The
    agent's own writes are stamped TWICE so the daemon never narrates the
    model's own create or tick back to it: once by mission id BEFORE the
    request leaves, because the backend emits the frame from inside the
    transaction it answers from and it regularly beats the response home, and
    once by mission id plus `updatedAt` when the response lands, which is what
    covers a frame delivered late. The pending stamp is spent by one frame, so
    a later change by the owner to the same mission is still heard, and the two
    frames that are never narrated cannot spend it: a tick that closes the last
    goal emits `mission_ticked` AND `mission_completed`, and a tick that ate
    the stamp would leave the completion looking like the owner's Mark done.
    Every frame is deduped (frame, mission id, `updatedAt`),
    because a paired daemon sits in BOTH `pairing:<id>` and `assistant:<id>`
    and a daemon in the field outlives a backend deploy. And an owner-authored
    title is collapsed to one line with any channel marker inside it defanged,
    so a crafted 200 character title cannot forge a second `[mission_*]` line
    and hand the model instructions its owner never wrote.
  - The eight registrations are written out one per line on purpose. The
    stand-down guard counts handlers by matching a literal quoted frame name,
    so a loop would have shipped eight ungated handlers with the whole suite
    green; `test/mission-ws-wiring.test.ts` now fails if anyone writes one.
  - A mission the owner REPLACED by starting a new one in the same chat is not
    narrated as a Set aside. The `[mission_started]` line riding the same write
    already says the new mission replaced any that was open, so telling the
    model to stop and post a "where I stopped" line for the mission its owner
    simply swapped out would contradict the line it is about to read.
- **A mission belongs to ONE CHAT.** `create_mission`, `tick_mini_goal` and
  `complete_mission` take an optional `chat_id`, resolved the way `reply`
  resolves one (an opaque `session_handle` round-tripped by the model resolves,
  a chat this agent may not reach is refused), then the live turn's chat, then
  the first monitored chat last. The two implicit steps skip any chat the
  server would refuse a mission in, because handing it one is not a mission in
  the wrong chat, it is a 400 the agent cannot act on: a meeting room (owned by
  the first participant) and a chat whose last inbound came from somebody other
  than the owner (a share recipient's own chat with the agent). When nothing is
  left the answer is the agent's main chat, which is what a single chat agent
  has always had. The active read carries `?chatId=`, which is
  what stops a tick issued while working chat B from ticking chat A's card.
  An agent with ONE chat sees no difference at all: with no chat named the
  request is byte identical to the 0.40.0 one, and the backend reads an absent
  chat as the agent's main chat.
- **The owner is not offered a Pause button on this channel, and now that is
  the honest answer rather than a hardcoded one.** The daemon declares
  `mission_events` on every heartbeat (`lib/declared-capabilities.ts`), and
  deliberately does NOT declare `mission_pause`: this runtime has no
  process-level handle on an in-flight turn, so its stop is cooperative and a
  Pause button here would do nothing. Mark done and Set aside DO reach the
  agent, and they end the mission. A pause this daemon can genuinely enforce
  is stage 6 work, and that is when the token gets declared.

## 0.40.0 (2026-09-20)

- **The owner can finally watch the agent work.** Until now a Claude Code
  agent's chat showed replies and nothing else: the twenty minutes it spent
  reading files, running commands and handing work to subagents were invisible,
  and the app's own header could only guess at "working" from the replies
  themselves. This release gives the channel the activity rail every other BGOS
  channel already had, fed by the CLI's own hooks rather than by anything the
  agent has to remember to say.
  - `hooks/hooks.json` registers nine events (`SessionStart`,
    `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`,
    `Stop`, `PreCompact`, `PostCompact`, `SessionEnd`), each in the `args` exec
    form so a Windows path with a quote or a `$` in it never reaches a shell
    parser, each `async: true` with a 5 s timeout, and the forwarder exits 0 on
    every path including a crash. A hook that exits 2 BLOCKS the tool call it
    was watching; telemetry that can stop the agent is a defect, not a feature.
  - `bin/hoai-hook.mjs` reads stdin as BYTES and decodes UTF-8 explicitly (a
    text mode read crashed on a payload carrying a box glyph when the Windows
    console code page could not decode it), appends one JSON line to
    `<state>/hooks/<session_id>/events.jsonl`, and exits. It opens no socket and
    reads no credentials. A payload over 256 KB is reduced to the fields the
    mapper reads, so a `Write` tool's whole file body never touches the disk
    twice; a spool over 2 MB rotates.
  - `lib/hook-intake.ts` is the other half: the daemon watches that directory
    with `fs.watch` plus a poll that tightens to 500 ms while a turn is live.
    A loopback listener was considered and rejected: a port needs a descriptor
    file, a token, a firewall question on Windows and a file fallback anyway for
    the daemon-is-booting case, and the file fallback is the entire design.
  - **Only the pairing lock holder consumes, and only our own session.** Several
    daemons can resolve one pairing on a shared host (the 2026-09-04 three
    daemon incident), and they all watch the same directory, so a passive one
    draining it would post every tool row twice. The intake starts inside the
    lock holder branch, re-checks `channelArmed && lockHeld` on every pump, and
    stops on stand down and on exit. A source guard in
    `test/pairing-lock-standdown.test.ts` fails if any of those move.
  - **Binding got stronger, not weaker.** Every hook payload carries the CLI's
    own `transcript_path`, which is the CLI naming our file rather than us
    inferring it from a tool result it echoed. `lib/session-binding.ts` takes
    `hook` as its strongest source, so the "several recent transcripts and no
    positive signal yet, refusing to guess" branch stops firing once hooks are
    live, and the context gauge stops going unreported on a busy machine.
  - **The Steps snapshot is heartbeated.** The server drops a Steps record after
    three minutes of silence, and a Claude Code turn is routinely quieter than
    that between task changes, so the unchanged snapshot is re-sent every 60 s
    while the turn is live. Without it the strip blinks out mid turn and the
    owner reads it as the agent dying. The route is the USER family,
    `assistants/:id/chats/:chatId/steps`, because it is the one both this
    plugin's auth modes accept; a 403 silences that one chat and nothing else.
  - **A clone install is not a plugin, and that is the trap.** Claude Code reads
    a plugin's `hooks/hooks.json` only for an INSTALLED plugin under
    `~/.claude/plugins`. A claimed workspace is an MCP server entry, so nothing
    would ever read the checkout's hooks file and the rail would be missing with
    no error to notice. `ensureHookEntries` writes the same entries into the
    workspace's `.claude/settings.local.json` with the checkout's absolute
    forwarder path, through the verified JSON mutator this repo already uses for
    the trust preseed, and every launcher calls it: `bin/bgos-agent`,
    `bin/bgos-claim.mjs`, both bootstraps and `hoai` itself, which is the
    command an agent folder actually starts with day after day. Each of them
    skips a MARKETPLACE install, which already has the rail, so no event ever
    fires twice. Existing clones gain the rail on their next install or launch. `docs/learnings/a-plugin-hooks-file-reaches-marketplace-installs-only.md`
    is the note; a test pins all four callers.
  - **The launch lines now set `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`.** Without it
    the CLI has no task tools, so the live Steps strip stays empty forever while
    the rest of the rail works, which reads as a broken feature rather than a
    missing env var. The launchd plist and the systemd unit carry it too.
  - **The daemon always sends; the app decides what to draw.** The owner's per
    agent "Show technical details" switch hides these rows in the app. Nothing
    in this plugin reads it, and a test asserts that: the backend derives the
    agent's live working status from a tool row arriving, and a shared agent has
    several viewers, so gating here would blind the header for everyone.
  - **What an adversarial review changed before this shipped.** Fourteen
    findings, all fixed with a test and a named mutation:
    - **A session now binds on PROOF, not on proximity.** The first payload
      whose transcript sat under this daemon's project dir used to capture the
      rail, so a human's own `claude` in the agent folder, or a session that
      died last week, could take it and the real agent's rows were then refused
      as foreign for the life of the daemon. Three positive proofs are accepted
      instead: a prompt carrying the text of a message this daemon delivered, the
      transcript `lib/session-binding.ts` has already proven (a reply marker or
      the CLI assigned session id, never the newest-mtime guess), and a
      `SessionStart` naming that transcript. Unproven events are held for 60 s in
      case the proof is a line behind, then dropped.
    - **The drain cursor is on disk** (`cursor.json` beside `events.jsonl`,
      written atomically). It lived only in memory, so every restart and every
      lock re-arm replayed a whole session: every card, marker and step again.
      A directory is swept when its `SessionEnd` has been consumed, or when
      nothing in it has been touched for 30 minutes.
    - **The line id is minted, not measured.** It was the file size each hook
      process stat'ed, so two hooks on one parallel tool call read the same
      number and the daemon dropped the second event as a duplicate. It is now a
      per process random tag plus a counter, written in one `appendFileSync`, and
      the drain reads whole lines only. That id is also what gives `Stop`,
      `SessionStart`, `PreCompact` and the other id less events their occurrence
      identity in the dedupe key, so a second genuine one is no longer swallowed.
    - **A turn end awaits the card already on the wire** before sending the final
      `done`, the way the Codex poster's `finalizeTurn` does. A `done` that
      arrived mid flight used to be thrown away, leaving the card on "running"
      for ever, on exactly the turns busy enough to matter.
    - **A turn's chat is fixed at its prompt** and held until `Stop`, so a peer
      message, a system wake or a meeting invitation arriving mid turn no longer
      re-points the rest of the rows into a chat the turn was never about. After
      `Stop` the chat is kept (with no live turn), so an out of turn compaction
      marker lands in the conversation that just happened rather than in
      whichever chat happens to be first in the monitored list.
    - **A 403 is read from the status, never from the text of the error.** The
      Steps URL carries the chat id, so a chat numbered 4403 silenced its own
      Steps strip for the life of the daemon.
    - **A Bash row shortens the paths inside the command**, not only the ones in
      its path slot, so `~` and a workspace relative path go on the wire instead
      of a home directory naming the account, and the 120 character clip is spent
      on what the command did.
    - **`assistantId` is off the `POST /messages` bodies** (card and markers):
      `CreateMessageDto` does not declare it, so the backend stripped it and
      logged an unknown field for every row this rail posted.
    - **`show_component` refuses the activity kinds** with one plain sentence.
      They are posted by the host from the session's own hook stream; an agent
      able to summon `context_compacted` could narrate a compaction that never
      happened into a chat the owner reads as a record.
    - **`hoai` carries the rail too**: the run plan now includes
      `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` and the clone hook entries, applied on
      every launch. And the Windows `cmd` launch line writes
      `set CLAUDE_CODE_ENABLE_TODO_TOOLS=1&&`, without the space that made the
      value `"1 "` and the flag dead.
  - Tests: `test/hoai-hook.test.ts` (22), `test/hook-intake.test.ts` (28),
    `test/turn-chat.test.ts` (14), the hook halves of
    `test/claude-preseed.test.ts`, `test/session-binding.test.ts`,
    `test/hoai-core.test.ts`, `test/renderables.test.ts` and
    `test/hook-events.redaction.test.ts`, plus eleven `server.ts` source guards.
    Each was proven red against a named mutation before it was kept.
## 0.39.9 (2026-09-20)

- **A daemon-handled slash command now checks who sent it.** `/compact` and
  `/status` are acted on by the daemon and never reach the model, and neither
  handler asked who sent them. One session serves every chat of an agent, so
  a person the owner had shared the agent with could tap `/compact` in their
  own chat and compact the owner's context. The decision now lives in one
  pure function, `lib/daemon-command-sender.ts`, called first by both
  handlers, which every rail (poll, WebSocket, stream) lands on. The sender
  is read from the per-message sender fields in each transport's own shape
  (the nested `sender` block on the socket, the flat `sender_user_id` on a
  poll or stream row) and never from the top-level owner id, which on both
  wires is the owner's for every sender. Decided per command on what it
  mutates or exposes: `/compact` mutates the owner's session, so anyone but
  the owner is refused with a short reply in their own chat, before the
  host's compact capability is consulted; `/status` mutates nothing, so a
  non-owner is still answered, but only with "connected" and the version,
  not the install method, supervisor, update enrolment or the last-message
  clock, which describe the owner's machine and the owner's traffic. A
  missing or malformed sender fails closed. The enforcement is one exported
  seam, `runDaemonCommand`: each handler in `server.ts` is a single call to
  it with its real work passed as `act`, so
  `test/daemon-command-sender.test.ts` proves with spies, against the real
  exported code, that a refused sender never reaches the action, the
  refusal is sent once to the sender's chat, a failed reply is still a
  refusal, and the owner reaches the action with the owner audience
  (behavioural). What is still only pinned by SHAPE, because the handlers
  and rails are module-scoped and not exported: each rail's exact call with
  the payload, each handler being one seam call, the real work invoked
  nowhere else, the tmux injection existing in exactly one place, and the
  seam's import path. Nine mutations proven red, six by behaviour and
  three by shape; the test file lists what no pin can catch.

## 0.39.8 (2026-09-19)

- **Every meeting turn reaches the agent with its turn marker.** Found in
  KC's meeting QA on 2026-09-19: some meeting messages arrived as plain chat
  cards with no `[Meeting #N, your_turn=...]` header. The backend delivers
  each meeting turn twice, as a `meeting_message` broadcast and as an
  `inbound_message` twin carrying `meetingContext` with the server's own
  verdict on whose turn it is; both share one message id, so whichever lands
  first wins the dedupe. The twin path ignored `meetingContext`, so about
  half of all turns lost the marker, and an agent's handoff was labelled as
  if the human had written it. The twin is now framed as a meeting card using
  the server's `yourTurn`, the broadcast handler records the new speaker
  before its dedupe can return (the stale speaker was what made the poll
  fallback say `your_turn=NO` on a turn that was ours), and a late frame for
  an older turn can no longer put stale meeting state back. All three
  transports build the card through `lib/meeting-card.ts`, every meta value
  a string. `test/meeting-card.test.ts` exercises the real builder and
  guards the `server.ts` wiring; seven mutations proven red.

## 0.39.7 (2026-09-18)

- **A shared agent's boards belong to the person using it.** KC, 2026-09-16:
  "If someone uses a shared agent to create boards or whatever it is, a
  browser, they should all be on the account of the person with the agent
  that was shared with it, not the owner." Every `boards_*` call now carries
  `X-BGOS-Acting-User` naming the sender of the most recent inbound user
  turn (poll, stream and WS alike), which the backend admits only through an
  active share of this agent to that person (BGOS PR #1472). The owner's own
  turn sends no header at all, so that wire is byte-identical to before; a
  peer or system inbound never moves the pointer; a proactive call with no
  user turn seen acts as the owner. `lib/acting-user.ts` holds the rules,
  `test/acting-user.test.ts` pins them on the real boards transports and
  guards the three `server.ts` sites. The browser shim (`bin/hoai-browser-mcp.mjs`)
  is a vendored copy of the BGOS source and a separate process with no path
  to the daemon's inbound state, so it does not name the acting user yet; see
  the PR for the mechanism that needs. Version 0.39.6 is the keepalive restart
  authority, merged immediately before this.

## 0.39.6 (2026-09-14)

A keepalive script is a restart authority, so a one-click update can finish on
the sessions it launches.

- **New `keepalive` restart authority.** A keepalive that starts claude inside a
  detached tmux (launchd job `ai.bgos.session.<id>` running
  `~/.bgos-session-<id>/keepalive.sh`) really does bring the session back, but
  its pid is nowhere in the daemon's ancestry, so 0.39.1's ownership rule
  refused it and nine sessions sat on "restart pending" after a one-click
  update. The script now declares itself in `~/.bgos-agent/<id>/keepalive.json`
  (`bin/hoai-keepalive-marker.mjs` writes it) and the daemon accepts the marker
  ONLY while the script's pid is alive, the claude pid it declares is a STRICT
  ancestor of the daemon (walked through `ps`), and that pid really is a claude
  session (`ps -o comm=`). The last check is not belt and braces: one tmux
  server is a strict ancestor of every agent on the host, so ancestry alone
  would let a marker naming it bind to all nine daemons and the restart would
  take the whole fleet down mid-turn. A stale marker, a dead script, a foreign
  session or a shared ancestor all fall through to the older tiers exactly as
  before.
- **This rung is inert until a keepalive script calls the writer.** The plugin
  ships the marker contract and the writer; nothing writes a marker on its own,
  so an agent with no marker behaves exactly as it did in 0.39.2. The marker has
  to be rewritten on every launch, since a stale `claudePid` is refused.
  `docs/one-click-restart-helper.md` carries the wiring notes.
- **The restart is a signal, never a kickstart.** After the usual drain and
  install, the daemon sends `SIGTERM` to the session pid from the marker and the
  keepalive relaunches it on the new version: the same recovery five sessions
  were brought back by hand with. It never `launchctl kickstart`s a keepalive
  job, which kills the script, restarts nothing, and leaves the daemon drained
  (the 2026-09-11 mute). A signal that does not land degrades to `staged`, and
  the un-drain watchdog still covers a relaunch that never arrives.
- **A keepalive publishes no service record.** `~/.bgos-agent/<id>/service.json`
  is cleared for these agents, so the per-machine watcher no longer holds a
  launchd job that cannot restart them.

## 0.39.5 (2026-09-13)

- **The browser relay no longer doubles the API prefix.** The launcher hands
  the shim the daemon's own backend URL, which carries `/api/v1` on every
  install whose config names it, and the shim appended `/api/v1` again: every
  probe went to `/api/v1/api/v1/integrations/browser/host`, was answered 404,
  and every Claude Code agent believed the owner's desktop app was offline.
  The shim now strips a trailing `/api/v1` before composing relay paths; a
  relay test pins it. Versions 0.39.3 and 0.39.4 are taken by open branches
  (liveness recency, keepalive restart authority).

A session that was live and then stopped is now seen. On 2026-09-12 the Data
agent's session (assistant 900) was wedged by a queued `/exit` from 07:49Z to
20:36Z. The daemon stayed connected and heartbeating; 13 hourly wakes and 2
owner messages queued unanswered; the log for the window holds one
reply-overdue line (19:54:36Z) and no probe or escalate line. The deaf-session
detector returned 'wait' whenever `live` was true, and `live` was the
ever-live latch, "any bgos tool call since boot", which had flipped at 07:49
and could never flip back. A session that had ever spoken was never probed
and never named to its owner.

- **Liveness for the deaf-session decision is recency-based.**
  `ChannelLiveness` records the time of every bgos tool call and answers
  `recentlyLive(now, windowMs)`: a call within `LIVE_RECENCY_WINDOWS` (3)
  reply-overdue windows, twelve minutes at the default. `checkReplyOverdue`
  passes that instead of `.live`. The ladder is unchanged: nudge at 4 minutes,
  a `channel_ack` probe once the nudge has sat two windows, the chat warning
  only after the probe has sat `DEAF_PROBE_GRACE_WINDOWS` more, once per
  boot. For 900 that is a probe at about 19:58Z and the warning at about
  20:10Z, instead of never.
- **`.live` keeps its ever-live meaning.** Cursor persistence, the on-disk
  channel-live marker and the shutdown flush still gate on the latch: a
  session that once heard the channel did receive the deliveries behind its
  cursor advances, and a quiet one must not start withholding them.
- **The heartbeat's unresponsive report reads the same recency**, so the
  backend's `session_unresponsive` tier can see a wedge on a session that had
  spoken (the latch hid it there too), and a tool call after the verdict
  clears it for the rest of the boot rather than letting a recovered session
  flap back to unresponsive on its next quiet quarter hour. Known limit, not
  new: `lastError` rides the version heartbeat, every 6h or on a readiness
  change, and nothing sends one at the verdict, so the backend learns late.
- **An answered probe is spent.** Under the latch an ack was permanent (it
  flipped `live` for the boot). Under a clock, recency can lapse again while
  the same inbound is still unanswered, so `checkReplyOverdue` now clears a
  probe the session has answered before the ladder runs, and the next lapse
  asks again instead of escalating on a probe that was answered. Every chat
  warning still rides on a probe that went unanswered for the full grace,
  which is what its copy says.
- **The probe and escalate log lines say what was observed** ("last bgos tool
  call 720 minute(s) ago", or "no bgos tool call since boot") instead of
  asserting "zero bgos tool calls since boot", which was false for 900.
- Guarded by `test/liveness-recency.test.ts`: the 900 case earns a probe, a
  recent call waits, the grace escalates, the boundary flips at exactly three
  windows, the never-live ladder is unchanged, the heartbeat reports the
  wedge and stays clear after a recovery, and the `server.ts` wiring at the
  chokepoint, the decision and the heartbeat is pinned. Mutant: `recentlyLive`
  returning `this.live` compiles and fails 8 of its 21 tests, the 900 case
  among them. `test/channel-liveness.test.ts` and
  `test/unresponsive-heartbeat.test.ts` pass unchanged.

## 0.39.2 (2026-09-12)

The HOAI Agent Browser reaches Claude Code agents by default, on this machine
and from any other one.

- **New MCP server `hoai-browser`** (`bin/hoai-browser-mcp.mjs`, zero
  dependencies): a stdio proxy to the browser pane the Home of Agents desktop
  app hosts (`~/.hoai/agent-browser.json` names the local endpoint and token).
  When the app is running the agent sees `hoai_browser_open_session`,
  `hoai_browser_close_session`, `hoai_browser_status` and Playwright's
  `browser_*` tools; when it is not, only `hoai_browser_status`, which says so.
  The shim sends `notifications/tools/list_changed` when the app appears.
- **The browser reaches the owner's desktop app from another machine.** The shim
  gained a second door: when the desktop app is not on THIS machine, every MCP
  message travels through the owner's HOAI account to the computer that runs it,
  and comes back the same way (`POST /api/v1/integrations/browser/mcp`, long
  poll, then `GET .../mcp/:rpcId` for a slow answer). The local loopback door
  still wins whenever it answers, so nothing changes for an agent that sits on
  the owner's own computer. The owner sees the agent's name in the pane.
- **The launcher hands the daemon credentials to the shim as env.** The
  `hoai-browser` server now starts `bin/hoai-browser-launch.mjs`, which
  resolves this folder's agent exactly as the MCP server does (the same
  `resolveCredentialsSelection` / `loadCredentialsFile` / `resolveAuth`, run
  through `bin/hoai-browser-creds.ts` under bun because that resolver is
  TypeScript) and spawns the shim with `HOAI_RELAY_BACKEND_URL`,
  `HOAI_RELAY_ASSISTANT_ID` and then either `HOAI_RELAY_PAIRING_TOKEN` or, for
  legacy api-key agents, `HOAI_RELAY_API_KEY`. The assistant id rides BOTH
  lanes: the relay endpoint requires it whichever header is used, because one
  pairing can back several assistants and the owner's pane shows which agent is
  browsing. The shim itself stays framework neutral and reads nothing but its
  environment. A pre-set `HOAI_RELAY_*` is an operator override and passes
  through untouched.
- **Nothing about it is fatal and nothing is logged.** No bun, a resolver that
  fails, an agent that is not paired yet: the shim starts anyway without relay
  env (local mode keeps working) and one plain stderr line says the relay is
  off and why. No credential is ever written to a log, a stderr line or a tool
  result.
- **Honest wording when the owner app is down.** `host_offline` now reads as
  "your owner's Home of Agents desktop app is not running or not signed in"
  rather than the local "not running on this computer", and while relay
  credentials exist the shim probes every 20 s so the browser tools appear by
  themselves the moment the owner opens the app.
- **Instructions:** the server instructions and the bundled capability fallback
  now say the Agent Browser is the default browser, ahead of Playwright MCP,
  chrome-devtools-mcp or Claude in Chrome, and that it works the same from
  another machine. The served canon carries the same rule.
- Guarded by `test/hoai-browser-mcp.test.ts` (the local and offline doors),
  `test/hoai-browser-mcp.relay.test.ts` (the relay door against a fake backend
  on loopback: the pairing header, the assistant id on both lanes, the api-key
  lane, a pending answer polled to done under both the 201 the relay endpoint
  really answers and the documented 200 / 202, `host_offline`, local winning
  over relay) and
  `test/hoai-browser-launch.test.ts` (the env mapping, the operator override,
  every failure path, and the bun resolver printing one JSON line).
- **The vendored shim is pinned by hash, not by a sentence.**
  `bin/hoai-browser-mcp.mjs` is a byte-identical copy of the BGOS shim, and for
  one round that claim lived only in a commit message: the BGOS source then
  moved twice and this repo shipped a stale copy whose relay lane was dead.
  `bin/hoai-browser-mcp.vendor.json` now holds the expected sha256
  (`e749abf800fb53cc1afce7ee20ead271610c3d0eaec69e071791ade027000d97`) and
  `test/hoai-browser-mcp.vendor.test.ts` checks it on every run, so a re-vendor
  cannot land without the hash moving with it. It also pins the LF rule and the
  `.gitattributes` line behind it, and it compares against the BGOS tree itself
  when `HOAI_BROWSER_SHIM_SOURCE` names it (skipped with a reason otherwise:
  BGOS is a separate repo and is not on this runner). Procedure:
  `docs/vendoring-the-hoai-browser-shim.md`; the drift and what is still not
  guarded: `docs/learnings/a-vendored-copy-is-only-as-good-as-its-hash-check.md`.
- **The launcher can never half-configure the pairing lane.** Two cases marked
  "THE INVARIANT" in `test/hoai-browser-launch.test.ts` pin it at the pure map,
  at the resolver path and at the env the shim is actually spawned with: a
  pairing result naming no assistant leaves the relay OFF rather than relaying
  into a guaranteed 400. The shim's own env-only contract (it sends whatever it
  is handed, which is what an operator or another host may configure) stays
  pinned in the relay test, which now says which of the two it is covering.

Design and evidence: BGOS `docs/superpowers/specs/2026-09-11-hoai-agent-browser-design.md`,
`docs/superpowers/plans/2026-09-12-agent-browser-relay.md`,
`docs/reports/2026-09-11-agent-browser-dev-environment/`.

## 0.39.1 (2026-09-12)

A one-click update can no longer leave a daemon deaf. On 2026-09-11 a forced
`update_now` across 21 pairings muted 9 daemons for 50 minutes: each reported
`restarting`, drained, and sat alive and heartbeating while answering nothing.
Their declared restart authority was a launchd job whose program is a
keepalive SCRIPT; that script had started a detached tmux server, so the job's
pid was nowhere in the daemon's ancestry, `launchctl kickstart -k` re-ran a
script whose singleton guard saw the session alive and waited, and nothing
died. The pre-flight only ever refused `staged`.

- **A service authority must OWN the process.** Before draining or pulling,
  the daemon reads its own pid ancestry (`ps -o ppid=` walked to 1) and the
  job's main pid (`launchctl print` `pid = N` / `systemctl show -p MainPID`).
  A job whose pid is not an ancestor fails `no_restart_authority` at once,
  with a log line naming the handle and both pids; the ladder never kicks
  such a job (a marketplace install stages instead). A job that does hold the
  process restarts exactly as before.
- **An un-drain watchdog after `restarting`.** Three minutes after either
  restart rung (service or launcher marker), if this process is still
  running, the restart did not arrive: drain off, terminal
  `error restart_did_not_arrive`, heartbeat, loud log. A real restart kills
  the timer with the process.
- Guarded by `test/update-rpc.test.ts` (ownership pre-flight, both paths,
  the watchdog on both rungs, re-arm) and `test/update-readiness.test.ts`
  (`serviceOwnsProcess` table, the three parsers, the probe).

## 0.38.26 (2026-09-05)

A tap on an inline button reaches the agent in seconds again instead of up to
five minutes. Why it was five minutes: the Agent Update Stream is off unless
`BGOS_UPDATE_STREAM=true`, and on every daemon we read on 2026-09-05 it was off
(mine, Data's, and the marketplace route sets no such env), so a click could
only arrive on the chat sweep, whose WS-healthy cycle has been five minutes
since 0.34.0. Text rides the WS at once, which is why replies were instant and
taps were late, and why a click stamped 26 seconds BEFORE a text message
reached the agent four minutes AFTER it. Nothing was dropped; the fast lane
was never switched on.

- **A chat with a fresh inline-button prompt joins the 2s fast scope**, the
  same scope meeting and pending-permission chats already use, until the tap
  lands (either lane), the prompt is ten minutes old, a later prompt replaces
  it, or this daemon replies TO the prompt in words (an unrelated progress
  update leaves the chips live; the agent is the chatty one). At most eight
  such chats at once, newest first. Bounded on purpose: an abandoned prompt
  must not pin a busy chat at 2s forever. The edge, stated so the next late
  tap is not read as a regression: a tap more than ten minutes after the
  prompt still lands on the five minute sweep.
- **The stream-off exit now says so in the log.** It returned silently, so a
  daemon with the stream off looked identical to one with it on and quiet.
- Guarded by `test/poll-core.test.ts` (the pure scope helper, edge and cap,
  and a source pin that both lanes drop the chat) and `test/stream-wiring.test.ts`.

## 0.38.25 (2026-09-05)

The poll lane now says when it is the one that delivered a click. 0.38.23 made
every outcome in the STREAM path observable and left the other half silent: the
poll path logged nothing on success, so a click that arrived there produced
silence indistinguishable from a click that never arrived at all. Half an
instrument answers half a question.

- **`button_clicked ANNOUNCED via POLL`** on the poll announce path, naming the
  message, the chat and the backend's `answeredAt`. Two independent samples put
  a click roughly 4.5 and 5.5 minutes behind its own timestamp, and the
  WS-healthy full poll cycle is 300000 ms: a missed WS push plus one fallback
  sweep fits both numbers. Only a positive line from this path distinguishes
  "the poll rescued it" from "the stream arrived late", and neither log existed.
- **What the pair now settles.** A stream line and no poll line means the stream
  delivered it, with its own in-daemon duration. A poll line and no stream line
  means the WS push was missed and the sweep recovered it. Neither line, and the
  click never reached the daemon at all. Before this, all three cases looked the
  same from the log: empty.

## 0.38.24 (2026-09-05)

Every `button_clicked` outcome is now observable. A tap of the owner's reached
his agent about five and a half minutes after the backend stamped it, and
nobody could say whether the click was DELIVERED LATE or delivered on time and
QUEUED BEHIND A BUSY AGENT TURN, because from the outside those are the same
picture: `applyStreamButtonsAnswered` had four unlogged early returns and
ws-delivered inbound was never logged at all. "Late" and "lost" both produced
no evidence, which is why this reached the owner as a regression instead of a
test catching it.

This does NOT fix the latency. It makes the next real tap self-diagnosing.

- **Every exit says what it dropped and why.** View unresolvable or no chatId;
  `answerPayloadOf` returning null, which is exactly where a wire-shape change
  lands; the skip decision, with "already announced by the other transport"
  distinguished from the messageType; and the permission branch's callbackData
  failing to re-parse, which silently hung a permission prompt with no trace.
  That fourth path was found by the new guard, not by reading the code.
- **Stream authority is recorded at receipt, not assumed.** Whether the stream
  held authority when a click arrived changes which bug you are looking at, so
  it is stamped on every outcome line rather than inferred afterwards.
- **A delivered click reports its time inside the daemon**, named "handed to
  transport" rather than "applied": the plugin cannot observe when the agent's
  turn picks a notification up, and a proxy under the wrong name would have
  poisoned the reading. The gap between that log and the agent acting is the
  busy-turn bucket, now two timestamps instead of an inference.
- **Guarded** by `test/button-click-observability.test.ts`, which pins that no
  bare early return survives in that function. Two of its own pins were
  vacuous when first written and were only found by running the mutations: a
  `>= 4` threshold that survived a removed stamp, and a `[^)]*` regex that
  could not see a condition containing a call. The source scan normalises line
  endings, because this checkout is CRLF and a scan matching a literal newline
  finds nothing and passes forever.

## 0.38.23 (2026-09-05)

Consult continuation: answer now, finish later. On an iPhone call the agent
answered a weather consult from a five hour old reading, then fetched a fresh
one and posted it to the chat, and the call never heard it because the consult
had already closed. `voice_consult_reply` now takes `final` (default true).
`final:false` delivers the provisional answer and keeps the consult open as a
running task on the backend (`pending:true, consultId` on the consult result);
a second `voice_consult_reply` with the same consult id posts the fresh answer
to `POST /api/v1/integrations/voice-consults/:consultId/result`, which the
backend announces in the call, flips the Work Stream card and settles the chat
card. The consult notification tells the agent about the path.

## 0.38.18 (2026-09-04)

The daemon half of the 'unresponsive' presence tier. Backend #1278 gave presence
a third state, connected but not answering, so a deaf or credit-drained session
stops reading as a confident green 'online'. It arrives on the heartbeat's
existing `lastError` under one reserved code, and its fail-safe is that no
report means 'ok'.

That fail-safe is correct, and it is exactly why the feature shipped DARK:
backend and app were both live and NOTHING SENT THE CODE, so every agent read
'ok' and the quiet field looked like a healthy fleet.

- **The verdict the daemon already reached is now reported.** No new detection:
  this projects the same 'escalate' decision that already posts launch guidance
  into the chat, which by then means roughly twenty minutes of silence AND an
  ignored direct liveness probe. It cannot fire on a busy session.
- **Recovery needs no second call.** The escalation latch is once-per-boot and
  never un-latches, so recovery comes from LIVENESS: any bgos tool call makes
  the session live, the report goes null, and the backend reads an explicit
  null as "clear". A session that comes back is not left marked.
- **One field, two producers, explicit precedence.** A refused credential wins
  over an unresponsive session, because the two are not independent: a daemon
  whose calls are refused cannot reach its session, so that session goes quiet
  and LOOKS deaf. Reporting the deafness would name the symptom and bury the
  cause, and they have different remedies.
- **The wiring guard is widened, because this failure already happened once.**
  The auth-rejection guard existed precisely because a lastError could sit
  unsent for months; the same thing then happened one field over. It now pins
  both producers and the combiner, so neither can be unwired without a red
  test. Verified by mutation: removing the new producer still COMPILES and
  turns the guard red.

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

## 0.31.0 (27 July 2026)

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
