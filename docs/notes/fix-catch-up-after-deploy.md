# D04-1: the Claude Code plugin catches up after every deploy

Branch `fix/catch-up-after-deploy`, off origin/main f780cf1 (0.81.0). Row D04-1, first in Alex's D04 order. Working notes; the final report is the lane's last message.

## First note: the four questions

**1. What would a top engineer do here that was not asked?**

- Read the server's paging rule before designing the paging. `afterId` returns the NEWEST n rows above the cursor (BGOS fc9e3bc853 `message.repository.ts:4916-4919`: inner `ORDER BY m.id DESC LIMIT n`, outer `ORDER BY id ASC`). So the obvious loop, "read again with afterId set to the last page's newest id", goes up and skips the middle without a word. The only way down is `beforeId`, and delivery has to wait until the walk has reached the cursor, then go oldest first.
- Ask what else breaks once one read can be thousands of rows, because reads of 50 hid all of it:
  - The only dedupe between overlapping reads is `forwardedMessageIds`, capped at 500 ids across all chats (`server.ts:11911`).
  - A cursor parked under an empty wake card is bounded on main only by accident: the card falls out of the newest 50 and the cursor jumps. A walk would keep finding it, so one never-filled card would pin the cursor for good and re-read everything above it on every poll.
  - `Math.max(...rows)` has an argument limit.
  - A walk inside the tick stops the pairing lock heartbeat (5 s beat, 15 s stale).
  - A continuation page must never ride the chat's ETag validator: a 304 there is a page with no rows.
- Keep the idle poll flat. The fleet's reads were once 83 percent of backend traffic, so an idle chat must still cost one conditional GET.
- Keep what looks like a cap but is a decision: the first install gate, the group history cap (Data's gate of #265), and the restart recovery cap.
- Notice what a deploy does to the socket. nginx drops old sockets 30 s after its reload (`lib/reconnect-spread.ts`), and BGOS has no socket.io adapter (no `createAdapter` in `backend/src`). For those 30 s a socket that says "connected" hears nothing the new container commits. So "did a boot poll ever finish" can never be what makes a cursor bump safe; it has to be tied to this connection.
- Say where the brief and the repo disagree: **this repo has no AGENTS.md** (not at any depth, not in history, and not in the sibling plugin worktrees). I follow what its CI and its last release do: `package.json`, `.claude-plugin/plugin.json`, `package-lock.json` and a CHANGELOG entry (a056695, `scripts/check-version-bump.mjs`).

**2. What would they start from?**

The D04 report's measured cases, not my own idea of the bug: PL1 (51 rows lose 1, 80 lose 30, also on the boot read), PL2 (a live message right after the reconnect: 0 of N), PL3 (a row never pushed, then a live message, no outage), PL4 (a chat empty at its first read). Those were measured on the real routes by another lane, predicted first and reviewed by Data. Then the backend's SQL for the rules the fake must copy, and #265's end to end shape: the real daemon under bun, a stand in backend (http and socket.io), an MCP client collecting the channel cards.

**3. Which tools?**

- `git.exe` for git, because this worktree's gitdir is a Windows path; `gh.exe`, read only.
- Linux node 24.22.1 (CI's major) and bun 1.3.14 from `~/.local/opt`, never the Windows ones on PATH.
- `tsx --test` for one file, `~/.local/bin/heavy` for the full suite, `tsc --noEmit`.
- A throwaway mutation script: revert one fix, watch its test go red, restore.
- A separate Opus reviewer given only the D04-1 text and the diff.

**4. What would prove the result right, independent of me and of Ares?**

- The report's numbers. Another lane wrote down what the unfixed daemon loses (PL1, PL2, PL4); the same scenarios must flip to every row, once, in order. I did not choose those numbers.
- The fake server's rules are not mine either: each one cites a backend line, so anyone can check them against BGOS without trusting me.
- Each fix has a mutant that goes red, with the output kept.
- A reviewer who sees the row and the diff and none of my reasoning.
- CI's Linux and Windows legs, once Ares opens the push slot.
- The strongest check is one this lane may not run under its fake only rule: the report's own rig (`reports/D04/experiments/connectors/plugin/d04-r2-plugin-daemon.mjs`) against the real routes server, on this branch. Whoever merges should run it. I cannot tune a rig I did not write.

## What the server does (BGOS fc9e3bc853)

| Fact | Where |
|---|---|
| Newest n rows in the range, returned oldest first | `backend/src/repository/message.repository.ts:4916-4919` |
| `limit` defaults to 50 and is clamped to 1..200 | same file, `findByUserAndChat`, `:3996` |
| `afterId` and `beforeId` combine (`m.id > $n`, `m.id < $n`) | same file, `:4582-4589` |
| `withPagination=1` adds `hasMore` (a probe row, not a guess) and `nextCursor` (the page's oldest id, or null) | `findPageByUserAndChat` `:4017`; `backend/src/services/message.service.ts`, `getMessages` |
| No row is dropped after the SQL (only values are withheld) | `message.service.ts`, `getMessages` |
| In production since 2026-07-15 | BGOS #700, 106c70ab50 |
| The read answers 304 to the daemon's own `If-None-Match` | report PL2, trials 1 to 3 |
| No socket.io adapter: one socket server per container | no `createAdapter` under `backend/src` |

CORE-CONTRACTS 2.12 ("a reconnect is ONE difference call") is the app's account stream. A machine socket never joins that room and the plugin makes no difference call, so paging here does not touch it. D04-11 stays its own row.

One more server fact, found while choosing the empty chat's cursor: **the route's WHERE clause is its authorization** (`message.repository.ts`, the admission arms in `queryChatPage`). A chat the caller is not admitted to answers with no rows, not a 403. So "read empty" proves empty only for a chat the caller is admitted to.

## Holes (the red run on main f780cf1 is `docs/evidence/2026-11-03-catch-up-after-deploy/red-main-f780cf1.txt`)

1. **Reconnect skip.** `wsCursorSafe` is true once the chat's boot poll ever finished, so after a reconnect a live message moves the cursor over rows no read has returned. Red: 1 of 8, missing 101-107.
2. **Newest 50.** The daemon never pages, and the cursor moves to the newest id returned. On the delta read, the boot read and a chat with open buttons. Red: 50 of 120 on each; 25 of 30 with mixed senders, the oldest owner rows lost.
3. **A chat that started empty.** #265 removed the cap of 10 from one read. Still there: a read at cursor 0 reaches only the newest 50. And a chat read empty gets no cursor at all, so its next read is a first read: the walk back stops at any agent row under a person row, and a group's history cap of 10 applies after a restart, because the first listing time is in memory only. Red: 50 of 120; 1 of 15 with an agent row among them; 10 of 14 in the group (the literal "newest 10").
4. **The fourth, PL3.** A row the server never pushes, then a live message: the bump moves the read position over it with no outage at all. Same cause as 1. Red: row 101 never arrives.

The red run took the report's PL1 and PL2 numbers on its own, from a rig this lane wrote: those numbers came from another lane, so they back the rig.

## Design decisions

- **The walk delivers nothing until it is whole.** Rows must go out oldest first, and a failed page must leave the cursor where it was. So a walk is one read: pages are held in memory, and then the existing code runs over them.
- **A live frame waits rather than overtakes.** Without this, "in order" fails on the first message after every reconnect. The read delivers it too (`poll`), and the frame then stands down at the dedupe. Frames held in a chat the inbox does not list would never be read, so only monitored chats hold. Stamped frames keep the stream's own arithmetic: `holdLiveFrame` sits on the legacy path only, which also leaves `deliverWsInbound`'s signature and the source pins on it alone.
- **The cursor still bumps, the next read starts under it.** Removing the bump would have meant one more read per live message across the fleet, and a restart re-delivering what the socket delivered. The floor costs no request.
- **The empty chat's cursor is 1, not an id borrowed from another chat.** A borrowed high-water mark would stop a not-yet-admitted chat handing over history, but it adds a small way to lose a row, in a row whose whole point is no loss. Chats polled here come from this assistant's own inbox listing or an open meeting, so empty means empty on every path known today. The narrow remainder is reported.
- **Parking only on the newest page.** That is the bound main always had, by accident: a card that never fills falls out of the newest 50 and the cursor moves on.

## Changes to tests that existed before this row, and why

- `test/poll-core.test.ts`: the request paths now carry `withPagination=1`; `callerAssistantId: ASSISTANT_ID` now appears twice (the walk's pages).
- `test/first-poll-gate.test.ts`: the `wsCursorSafe` pin now includes `chatBehindSocket`.
- `test/first-read-cursor-zero.e2e.test.ts` (#265): a live message into a chat not caught up now arrives with the read, so its `transport` reads `poll`, and the burst case waits on the daemon's "waits for the catch up read" line, not on cards the read has not delivered yet. The failed read case fails two reads, because a failed read is now retried at once when its frame is let through. The fake's `failNextRead` counts, for that. Every row assertion in that file stands, and the first of those cases now also checks arrival order.

## Environment

```
export PATH="$HOME/.local/opt/node-v24.22.1-linux-x64/bin:$HOME/.local/opt/bun-1.3.14/bun-linux-x64:/usr/bin:/bin"
mkdir -p ~/lane-tmp/d041; R=$(mktemp -d ~/lane-tmp/d041/run.XXXXXX); export TMPDIR=$R TEMP=$R TMP=$R
```

- `bun.lock` matched `/mnt/e/bgos-worktrees/tmplitter/plugin/bun.lock` byte for byte (`cmp`), so node_modules was copied from there. That copy held Windows shims only, so I added `@esbuild/linux-x64` 0.28.1 from `/mnt/e/bgos-worktrees/privturn/plugin/node_modules` and POSIX shims for `tsx` and `tsc` in `.bin`. All gitignored.
- A slip of mine: one Bash call early on carried a stray `rm -f /dev/null`. It failed harmlessly as an unprivileged user; `/dev/null` was checked afterwards and is still the character device (1,3).
