# fix/canary-catches-deaf-build (board row 42499778)

Stacked on #291 (`fix/idle-agent-loads-staged-update`), merges after it. Ships as 0.85.1.

## The gap

`isLiveBuild` read the beacon (touched by the poll tick), a version heartbeat and the deaf verdict. A build whose loop runs and hands nothing over passed all three, and the deaf verdict needs a delivery that went unanswered, which a quiet canary never has.

## What was built

`lib/delivery-proof.ts`, in `isLiveBuild` as `undelivered`. DESIGN.md Calls 41 has the reasons.

- What waits: a read of its own, per owned chat, while a build is being proved. Never the poll's.
- What was handed: the write to Claude Code, once it resolved.
- A message waiting past 3 min with no later hand-off in its chat: not live.

## Found on the way

1. The backend records a wake as handed off when a chat read names its agent (`X-Caller-Assistant-Id`, `chat.controller.ts` `noteHandedOff`). The poll is that read. A proof read naming the agent would mark a wake received on a deaf build, so it names none. Pinned by a test.
2. The healthy sweep is 5 min on the socket and a day on the stream, so a missed frame would read as deaf on a healthy build unless the grace outlasted a day. A waiting message has the poll read its chat at once, and the grace can stay 3 min.
3. `test/model-effort-card-hold.test.ts` allows exactly two `mcp.notification` wrappers, and the hold's `onSent` fires before the write with no card. So the hand-off note is on the transport's `send`, which is the real write, and sees every path to Claude Code.

## From the fresh review (commit efc89cb)

Fixed: the reply reminder counted as delivering the message it names; any assistant row cleared a waiting message, including the daemon's own `/status` answer (the rule is gone: the poll's delta branch hands every row over anyway); a permission verdict the daemon consumed waited for ever; a read in flight across a re-arm; a row or chat gone from the server waited for ever; the poll told only after the whole sweep; a stale validator after a re-arm; reads with no end under an expired login; `send` dropping its other arguments; the history test passing through restart recovery; two timing assertions.

Added from the review's Minor 7: a card the host would silently drop no longer counts as handed.

Left, on purpose: a wall clock grace, so a sleep can cost one broken hold or one missed stamp (no false verdict, the deadline already takes sleep off); a chat whose first read came back empty and that is later admitted can read its history as new. It needs a chat the backend hides from this agent and then shows it, and costs a hold.

## What it does not catch

A session that discards a good card it was handed: the write resolves. See the stamp's Residual in DESIGN.md. Only asking the session reads that (Data's channel probe, Calls 27).

## How it was run

- WSL: `~/.local/opt/node-v24.22.1-linux-x64/bin` and `~/.local/opt/bun-1.3.14/bun-linux-x64` on PATH (neither is on the default PATH).
- The end to end file is posix only, like `test/first-read-cursor-zero.e2e.test.ts`, so it does not run under Windows node.
