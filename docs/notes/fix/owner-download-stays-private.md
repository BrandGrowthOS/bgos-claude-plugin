# A file the owner downloads stays theirs

Branch `fix/owner-download-stays-private`, version 0.87.3.

## What the browser host does now

A download Chrome raises while the owner holds the browser, or after the owner hands it back and before the agent
takes its next action, is the owner's. For such a file:

- The owner's card in the app names it, on the owner's own turn, as before.
- No answer the agent gets names it, gives its `dl_` handle or its size: not `hoai_browser_status`, not the reply
  to an action the host holds, not `hoai_browser_wait_gate`, not the "### Download" block pushed after a tool call.
  The one exception is the owner's own gift, below.
- While the owner's own download ask is open, the agent reads "Your owner has a request open until <time>." and
  nothing about the file.
- It stays the owner's after the host restarts: the downloads index records it. An older index's "kept for the
  owner" reason reads as the owner's too.
- A file first seen while the owner held the browser stays the owner's, even when the agent acts before the host
  adopts it.
- It never goes through the agent's site rules (trust, session, always): the owner is asked.
- When the owner taps Allow once on its card (the ask, or the notice of a file kept for them), the file goes to the
  agent's browser folder, and once it is there the agent is told the name it has there, once: one line,
  "- <name>: your owner gave you this file; it is in your browser folder (<folder>).", with no handle and no size.
  It comes in the next answer that carries downloads (the reply to a browser action the host runs, or
  `hoai_browser_status`), and never again: not on a later read, status or `hoai_browser_wait_gate`, and not after a
  restart. The promise to tell it is made only once the file is in the folder and gone from the index, and is kept
  in memory only, so a host that restarts cannot read the answer again, and one that restarts before that answer
  never names it. A save that fails names nothing: the file is kept for the owner, and their Allow once on that card
  names it once it lands. Deny names nothing. Allow for this session and Trust this site still give the file, and
  name nothing. The ask card keeps its four buttons.
- The owner's files never push the agent's own out of status.

Only an action ends the owner's window. A read (a snapshot, a screenshot, the tab list) starts no download, so a
download Chrome raises after one stays the owner's.

The daemon's poll lane never watches or announces a tap on a browser download card (`isBrowserDownloadCard` in
`lib/poll-core.ts`), so neither the tap nor the card's text reaches the agent.

An agent's own download, after its own click, is named in its reply and in status, as before.

## Merge with main (0.86.19)

Merged `origin/main` into the branch (a merge, no rebase).

| File | Decision |
|---|---|
| `package.json`, `.claude-plugin/plugin.json`, `package-lock.json` | Main's numbers, then 0.86.22: `version-check.yml` needs the version to advance on a pull request, and open pull requests already use 0.86.20 and 0.86.21. |
| `CHANGELOG.md` | Main's `## Unreleased` notes stay as they are. This change's paragraph has its own `## 0.86.22` heading above main's latest, as each version bump on main and in open pull requests has, since the release workflow tags the version on merge. |
| `lib/browser-downloads.mjs` | Main's unnamed file row keeps its new `ownerTurn` field and also carries the owner flag of first sight. |
| `bin/hoai-browser-host.mjs` | Main's run block kept whole. The one line that ends the owner's window now reads `if (classification.kind !== 'read')` inside it. |

Main's two card rig tests (`test/own-card-answer.test.ts`, `test/posted-card-answer.test.ts`) load the real poll page
source, which now calls `isBrowserDownloadCard`, so both rigs pass it in. `test/posted-card-answer.test.ts` gains one
test over the real poll page: a tap on a browser download card is never watched or announced, and the same two polls
still announce a tap on another browser gate card.

## Merge with main (0.87.1)

Merged `origin/main` again (a merge, no rebase), after main released 0.87.0 and 0.87.1.

| File | Decision |
|---|---|
| `package.json`, `.claude-plugin/plugin.json`, `package-lock.json` | 0.87.2, the next number after main's 0.87.1. |
| `CHANGELOG.md` | This change's paragraph moves under `## 0.87.2` above main's `## 0.87.1`; main's entries stay as they are. |
| `test/posted-card-answer.test.ts` | Both sides kept: main's card answer tests and their `card` helpers, and this branch's download card test and `isBrowserDownloadCard`. |

`server.ts` and `test/own-card-answer.test.ts` merged by themselves; both keep main's changes and this branch's lines.

## Merge with main (0.87.2)

Merged `origin/main` a third time (a merge, no rebase), after main released 0.87.2 (a thread answer reaches the app
again).

| File | Decision |
|---|---|
| `package.json`, `.claude-plugin/plugin.json`, `package-lock.json` | 0.87.3, the next number after main's 0.87.2. |
| `CHANGELOG.md` | This change's paragraph moves under `## 0.87.3` above main's `## 0.87.2`; main's entries stay as they are. |

Every other file merged by itself: main's thread lane files and tests, and `server.ts`, keep main's changes and this
branch's lines.

## Every path that returns download facts to the agent

Rows marked (main) are what main added since this branch was last merged.

| Path | What the agent gets for an owner's file |
|---|---|
| `hoai_browser_status` (open and closed session) | Nothing: owner rows leave `DownloadStore.rows()`. |
| Pushed "### Download" block (`untold`) | Nothing: owner rows are skipped. |
| Reply to an action held behind a download ask (`_pendingLine`, `_parkedResult`) | "Your owner has a request open until <time>." |
| `hoai_browser_wait_gate` on a download gate | The same sentence. The gate id the agent never saw is unknown to it. |
| Index after a restart | The owner flag is read back, so nothing. |
| Poll lane tap on a download card | Nothing: never watched. |
| The owner taps Allow once on their own file's card | Once the file is in the agent folder, one line, once: the name it was saved under and the folder, no handle, no size (`giftOnce`, `DownloadStore.give`, `given` and `takeGiven`, `ownerGaveLine`). A failed save, Deny, Allow for this session and Trust this site: nothing. |
| `downloadCardForPrincipal` (main) | Card side only: on a turn not proved to be the owner's, the card says "A file". Kept as main has it. |
| `ownerTurn` on each row (main) | Card side only. Carried on the unnamed file row too. |
| `_behindDownloadAsk` (main) | An action waits behind a download ask and learns nothing about it. Past the wait, its answer is the held action reply above. |
| `_permit` early returns (main) | Person mode, hold, privacy, reload and dialog routes: none carries a download. |
| Owner input compose window (main) | Caps how long the owner's lease lives after their last tap. An expired lease is a hand back like any other: the owner's window stays open until the agent's next action. |
| Managed profile companion downloads | Its own store, with no owner hold: the owner's remote control attaches to the regular browser only, so none of its downloads is the owner's. |

## Proof on the merged head

- `tsc --noEmit`: exit 0.
- One test file at a time, on the final code:
  - `test/hoai-browser-host.downloads.test.ts`: 44 of 44.
  - `test/poll-core.test.ts`: 61 of 61.
  - `test/browser-downloads.test.ts`: 39 of 39 (one skipped).
  - `test/hoai-browser-host.test.ts`: 35 of 35 (one skipped).
  - `test/hoai-browser-host.card-wording.test.ts`: 4 of 4.
  - `test/remote-credentials.test.ts`: 40 of 40.
  - `test/posted-card-answer.test.ts`: 31 of 31.
  - The eight other files that call `hoai_browser_status` through the host: 119 tests, all pass.
- `test/stream-apply.test.ts` (39), `test/ask-tracker.test.ts` (116) and `test/own-card-answer.test.ts` (18) passed
  on the merged head before the Allow once change. They import neither file it changed.
- An independent probe drives the real host over a fake page, a fake owner who holds the browser and a fake card
  server, and greps every answer for the file's name, its parts, its handle and its size. Through every tool, a
  close, a restart, both answers to the owner's card, a lapsed card, a session closed while the card is open, an
  unnamed file and a full keep count, no answer names the owner's file. The one exception is Allow once on either
  card: exactly one answer has exactly one line naming it, with no handle, size, byte count, gate id or URL part,
  and nothing after that, or after a restart, names it. A download Chrome raises after the agent's
  own action is the agent's and is named, as is the agent's own download after its own click. The probe builds its
  host with the owner check the real host wires in, since main's host names the file on the owner's card only on a
  turn proved to be the owner's.
- Mutants, each breaking one rule in turn on a copy of the tree, each run against the test file most likely to catch
  it (the downloads, poll-core and posted card files, 44, 61 and 31 green first): all 29 turn a test red in that
  file. They break, one at a time:
  - status and the pushed block hiding owner rows;
  - the owner flag on save and on load, and the older index reason;
  - the per-class trim and first-sight adoption;
  - the owner's request line, an unexplained download gate read as the owner's, and the gate kind on held results;
  - `hoai_browser_wait_gate`, and the host's words to the agent;
  - the poll lane check and its server mapping, in unit and through the real poll page;
  - the read rule and the site rules;
  - for Allow once: the name told twice, told again when the same file is allowed a second time, told on Deny on
    either card, told on Allow for this session or Trust this site (by the answer, or by the save), told at the
    answer before the file lands, and told by the name asked for rather than the name it was saved under.

## Deploy order

The BGOS half ships first.
