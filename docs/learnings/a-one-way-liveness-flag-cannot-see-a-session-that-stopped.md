# A liveness flag that only flips one way cannot see a session that was live and then stopped

**Date:** 2026-09-13

**Context:** The deaf-session detector (fix 04, then the 2026-08-26 probe
ladder) decides whether to ask a silent session a direct question and, if the
question goes unanswered, to tell its owner. Its first input is `live`, and
`server.ts` passed `channelLiveness.live`: a one-way latch that flips true on
the first bgos tool call of a boot and never flips back. `deafSessionAction`
returns `'wait'` whenever `live` is true.

On 2026-09-12 the Data agent's session (assistant 900) made its last tool call
at 07:49Z, a reply, and was then wedged by a queued `/exit`. The daemon stayed
connected and heartbeating until the owner restarted it at 20:36Z. In between,
13 hourly scheduler wakes and 2 owner messages queued unanswered. The plugin
log for `[08:10Z, 20:36Z)` holds 161 lines: 150 slash-command syncs, a few WS
reconnects, ONE `reply-overdue fired` line at 19:54:36Z, and zero `deaf session
suspected` or `deaf session confirmed` lines. (Positive control: the same log
carries both lines for 2026-09-01 and 2026-09-11, boots in which the session
had made no tool call at all.) The detector was working exactly as written. It
had been told the session was live, and it would be told that until the
process died.

**Gotcha / Pattern:** A latch answers "has this EVER happened this boot". A
liveness decision asks "is this happening NOW". They agree only until the first
event, and every session that wedges after its first tool call sits in the gap
between them. The gap is invisible from the inside: the detector's own log line
said "zero bgos tool calls since boot" on the probe path, which was the latch's
reading, and on the path that actually ran (`'wait'`) it said nothing at all.
A session that had spoken once was structurally exempt from ever being asked
again.

The same shape hides in any "seen once" flag that later gates a freshness
decision: `connected`, `authenticated`, `hasReplied`, `markerWritten`. The
question to ask of every boolean input to a health decision is: what un-sets
it? If the answer is "nothing", it is a latch, and it can only ever say that
something happened, never that it is still happening.

The latch was not wrong for its other consumers. Cursor persistence gates on
`.live` because a session that once heard the channel DID receive the
deliveries behind its cursor advances; going quiet later changes nothing about
that. So the fix is not to replace the latch but to add the clock beside it:
`recentlyLive(now, windowMs)` (a call within `LIVE_RECENCY_WINDOWS` windows)
for the decisions that ask about now, `.live` unchanged for the ones that ask
about ever. One class, two readings, each named for the question it answers.

**How to apply next time:**

- For every boolean fed into a health or liveness decision, name the event
  that flips it BACK. If there is none, it is a latch and the decision needs
  a timestamp instead.
- When a detector has a "positive control" (here: it fired correctly on 09-01
  and 09-11), check what those cases have in common that the failing case
  lacks. Both were never-live boots. That was the whole diagnosis.
- Keep the latch for the consumers that want a latch. Changing what `.live`
  means to fix one caller would have made cursor persistence withhold writes
  on every quiet session, a worse failure than the one being fixed.
- Make the log line report the observation the decision used (the age of the
  last tool call), not a paraphrase of a different flag.
- A recovery anchor beats a bare clock for a once-per-boot verdict: the
  heartbeat clears when the session speaks AFTER the verdict, so a recovered
  session cannot flap back to unresponsive on silence alone.
- Look for what the latch was doing IMPLICITLY and say it explicitly. An
  answered probe used to be permanent because the ack flipped the latch;
  with a clock, `unansweredProbe` has to spend it, or the next lapse
  escalates on a probe that was answered and the chat copy lies.

**Regression guard:** `test/liveness-recency.test.ts`. `THE REGRESSION (900,
2026-09-12): a session that was live and then stopped is probed` builds the
daemon's exact composition (a `ChannelLiveness` marked at 07:49, an inbound
twelve hours later, `live: recentlyLive(now, REPLY_OVERDUE_MS)`) and expects
`'probe'`; `recentlyLive flips false exactly at LIVE_RECENCY_WINDOWS *
windowMs` pins the boundary; `.live keeps its ever-live meaning` pins the
latch; three `server.ts` pins hold the wiring at the CallTool chokepoint
(every call marks), the decision (recency, never `.live`) and the heartbeat.
Verified by mutation: `recentlyLive` returning `this.live` compiles and fails
8 of the file's 21 tests, the 900 case among them.
