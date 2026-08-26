# Silence is not proof of deafness

**Date:** 2026-08-26

**Context:** Fix 04 (the double-silent failure) shipped a detector for a Claude
Code session launched without the channel flag. Such a session accepts our MCP
channel notifications at the transport and discards them, so the daemon cannot
learn it is deaf from any delivery result. The chosen signal was indirect: a
session that hears us eventually CALLS a bgos tool, so zero tool calls since
boot means deaf. On that signal the daemon posted into the owner's chat that the
agent "cannot receive your messages. It was launched without the channel flag",
and told them to quit the session and relaunch it.

**Gotcha / Pattern:** The negative does not follow. Silence is a legitimate,
frequently CORRECT outcome, and we ask for it ourselves in two places: the
reply-overdue nudge ends "If you intended to stay silent, ignore this
notification", and most watch-style standing orders end "tell the owner only if
blocked". So the daemon invited silence and then read silence as proof of a
broken install.

Observer (930), 2026-08-26: received its 00:30 scheduled wake, worked for 7m37s,
finished its checks, found nothing worth reporting, and stood down quietly
exactly as instructed. At 00:38:35, eight and a half minutes after the wake, its
daemon told its owner it could not receive messages and had been launched
without the channel flag. Both clauses were false. `argv` on pid 11490 carried
`--dangerously-load-development-channels server:bgos`, its workspace `.mcp.json`
declared a matching `bgos` server, and its own terminal showed the entire run.

Fleet-wide the check had fired 13 times across 9 agents since 2026-08-22. At
least 6 were provably false: 5 agents posted real replies within the following
hour (Psyclone 19 messages, Data 7, Nicole 4, Viva 2, Tarweej 1), and Observer
was caught working in its own pane. None was ever confirmed true. The signature
repeats exactly: Observer was accused at 00:38 on 08-24 and again at 00:38 on
08-26, both times 8.5 minutes after the same 00:30 wake, because the escalation
re-arms on every restart.

Two costs, and the second is the quiet one. The message told people to quit
sessions that were mid-task, which throws away the work in flight and, on a
`--continue` relaunch, risks resuming the wrong conversation. And it spent the
credibility of the one alarm that had genuinely found a deaf daemon a week
earlier: an alarm that cries wolf on healthy agents stops being read.

**How to apply next time:** When a signal can only ever be ABSENT, ask what else
produces the same absence before you act on it, and make sure the check
discriminates between those causes rather than merely correlating with one. Here
the passive signal was a sound POSITIVE (a session that spoke can obviously hear
us) and an unsound NEGATIVE, and the fix is to keep it for what it proves and
add an ACTIVE probe for what it does not: ask the session to call `channel_ack`
and give it a real grace period. A session with nothing to say still answers a
direct question; a deaf one never does. The machinery already existed for the
watcher's post-restart probe, so the fix was to reuse it, not invent one.

Two rules that generalise past this file. Order a remedy by what it costs to be
wrong: `hoai doctor` is ten seconds and harmless, quitting a session destroys
work, so the diagnostic leads. And never state an inferred cause as an
observation in user-facing copy: the message now says the session "has not
answered a direct check", which is what we actually know.

**Regression guard:** `test/channel-liveness.test.ts`, in particular
`deafSessionAction: THE REGRESSION. a quiet session is asked, not accused`
(a silent session earns a probe at 2, 5, 20 and 500 windows, never an
escalation), plus `escalates only after an unanswered probe`, `answering the
probe ends it for the boot`, and the two copy guards asserting the message
states the observation and leads with the diagnostic. Verified by mutation: with
the old immediate-escalate branch and the old wording restored, 5 of these fail.
