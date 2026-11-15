# A prompt with no delivery behind it ends the owner's turn, and nothing may trust it

**Date:** 2026-11-15

**Context:** KC asked for a bug to be raised: an agent's private action (a schedule, a board write) fails with "This private action did not start because its current sender could not be verified" when another agent's message lands in the same turn. Ava (chat 818) lost a `schedule` at about 09:26Z in a scheduler fire's turn, right after a peer message. Argus (assistant 1050, plugin 0.88.0) lost board writes all morning in scheduler fire turns. The first idea for a fix was "private actions keep the turn's verified origin, a later peer event must not replace it".

**What it was (two causes, read from the daemon's own log, never guessed):** the daemon logs why it refused, `private turn: refused <tool>: ...` in `~/.bgos-agent/logs/bgos-plugin-<assistantId>.log` (`explain()`). Argus's log for 2026-11-15, 05:56Z to 09:37Z, 9 refusals:

| Time (Z) | Tool | What the log says the last prompt was |
|---|---|---|
| 05:56:18 | boards_search | no-token |
| 06:06:02 | boards_search | no-token |
| 06:31:39 | boards_update | no-token |
| 07:56:42 | boards_search | no-token |
| 07:56:48 | boards_insert | no-token |
| 09:00:24 | boards_get_row | no-token |
| 09:01:23 | boards_get_row | peer |
| 09:06:02 | boards_get_row | no-token |
| 09:37:08 | boards_get_row | no-token |

1. **`peer`, 1 of 9.** A peer agent's message was the last prompt (Data's message 228649 at 09:01:11Z, 24 seconds after the 09:00:47Z fire). This is the gate working as written: a delivery that names no person, delivered after the owner's, "may be in front of the model", so it ends the turn (`current()`, `strangerAfter`; pinned by `test/private-turn-owner-authority.test.ts` (f) and `test/quiet-turn-threats.test.ts`). The fix that keeps the guard already existed: the quiet turn hold (`lib/quiet-turn.mjs`, 2026-11-11) keeps every other card outside the owner's own turn for up to five minutes. It was OFF: it holds nothing unless the server says `quietTurn: true`, which it says only with `VOICE_ASK_STAMP` on, and production had that variable unset. Data set it at 09:46Z; this daemon logged "quiet turn: the server says on" at 09:45:44Z.
2. **`no-token`, 8 of 9.** The last prompt of the session carried no delivery token at all (`begin()` answers `no-token` when a prompt holds no `<hoai-private-turn id=.../>`). In this session those were Claude Code's own prompts, which the CLI submits like any other: a background task's completion notice, the feedback of a Stop hook that sends the session back to work, and a reply reminder card about a peer's message. Each ran after the scheduler fire that had opened the owner's turn, in a session that works for hours without stopping.

**Gotcha / Pattern:** "the sender could not be verified" reads like a fault and is the designed answer. Two different things produce it, and only one has a fix.

- The peer case is fixed by the hold, not by trusting the peer. The origin must not be "kept" past a peer's message: a model cannot tell two instructions apart once both are in its context, which is the whole reason the turn ends.
- The tokenless case has **no trust to give**. The private turn hook sees a prompt's text and nothing else. A prompt with no token is words nobody delivered: a notice from the CLI, text typed at the terminal by whoever sits there, or anything that can be made to look like either. Nothing in it can be verified, so it cannot keep an owner's turn, and no rule that recognises "a harmless notice" by its text is safe, because the text is exactly what an attacker controls. A background task's notice also carries a summary of that task's output, which may be outside content.
- The hold cannot help here either: it stands at the one choke point channel cards pass, and the CLI's own prompts do not pass it.

**How to apply next time:**

- Read the log line before proposing a change to the gate. `the last prompt ...: peer`, `no-token`, `ambiguous` and "someone other than the owner reached this turn" are four different stories.
- When an owner's switch is said to be "built", check that the server says so: `quiet turn: the server says on` in the daemon log, or the variable on the production container (names and whether it reads true, never values).
- An agent that needs a private action in a long turn does it FIRST, in the fire's or the owner's message's own turn, before starting anything that will come back as a notice (a background command, a long wait), and keeps what was refused in a file to do on the next verified turn. That is a habit, not a fix, and it is the honest state of the tokenless case.
- Do not open a change that lets a tokenless prompt, or a prompt after a peer's message, act as the owner. If the cost of the tokenless case grows, the question to ask is whether the CLI can deliver its own notices without submitting them as prompts, not whether the gate can look away.

**Regression guard:** none added, on purpose: no code changed. The rules this note describes are pinned already: `test/private-turn-owner-authority.test.ts` (a peer's message ends the authority, the owner's next prompt has it back), `test/quiet-turn-threats.test.ts` (the hold, and "without the hold the same peer message ends the owner's trust"), `test/private-turn-late-line.test.ts` and `test/private-turn-two-admitted.test.ts` (`no-token`).

**Not verified:** Ava's 09:26Z refusal was not read from Ava's own log (another agent's state folder); it is taken from Data's report as a `peer` case. The tokenless case was not retested after the switch: nothing about it changed.

**Confirmed live, 2026-11-15 10:00Z (the peer case, with the hold on):** Argus's scheduler fire 1611 arrived while its CLI turn was already running. The daemon logged `the prompt ... admitted its sender` at 10:00:37Z and `quiet turn: a channel card waits until the owner's turn ends (five minutes at most)` at 10:01:05Z. In that turn, 10:01:00Z to 10:02:40Z, three board reads, four updates, one insert and two searches all went through; none was refused.
