# Changelog

Notable changes to the HOAI Claude Code plugin.

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
    that names a different person is refused (the plan stays open, the chip and
    the status line stay up, and nothing reaches the agent), while a tap that
    names nobody, which is every tap on today's backend, is accepted. The
    person is the one the card was posted for, or the account owner when a
    restart lost that record. Before this, on a shared assistant, anyone who
    could see the chat could approve a plan and the agent went to work as if
    its owner had.
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
