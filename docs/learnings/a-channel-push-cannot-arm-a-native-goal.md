# A channel push cannot arm a native goal, so the setting half belongs to whatever can type

**Date:** 2026-09-21

**Context:** Stage 6 of the Mission program gives the owner a **Keep working until it is done** switch. On Claude Code that has to become a native `/goal <condition>` on the live session, because the native goal is the only thing in that runtime that keeps a turn going until a separate checker says the condition holds. The daemon already had one channel into the session that reaches every host: the `notifications/claude/channel` push it uses for every inbound BGOS message. Pushing the literal text `/goal <condition>` through it would have made the switch work on Windows too, and the whole platform split would have disappeared. It was built and driven against a real session with the exact wire shape this daemon sends, and the answer is no.

**Gotcha / Pattern:** The CLI's channel handler is four lines, and it locks slash expansion twice over:

```js
queue.enqueue({
  mode: "prompt",
  value: wqe(server.name, content, meta),  // LOCK 2: wraps content in <channel ...>
  priority: "next",
  isMeta: true,
  origin: { kind: "channel", server: server.name },
  skipSlashCommands: true,                 // LOCK 1: expansion explicitly disabled
  skipAttachments: true,
})
```

`skipSlashCommands: true` is hard coded on the enqueue. It is not read from the notification, from the meta, or from settings, so EVERY push from EVERY channel server arrives with expansion off. And `wqe` wraps the content unconditionally in `<channel source="..." chat_id="..." ...>`, so the prompt text never begins with a slash, which would defeat expansion on its own even if the first lock were lifted. The wrapper is applied before any flag could be consulted, so no meta key can rescue it and no content shape can either (a leading newline was tried; same result). Live, the model read `/goal <condition>` as prose and did the work by hand: zero matches for `goal_status`, `<command-name>/goal` and `Goal set:` in the transcript, and a `/goal clear` at the end answered `No goal set`.

Three inputs DO expand a slash command: the interactive composer, `claude -p` with the prompt on stdin, and `claude -p --input-format stream-json` with a JSON user message. **A plugin spawned by Claude Code owns none of them.** The model cannot help either: there is no slash command tool, and `ProposeGoal` sits behind a server side feature gate that is off, is absent from the tool list, and throws `ProposeGoal cannot be used in agent contexts` even when enabled.

The same probe found a second thing worth writing down, because it is silent when broken: a channel push is DROPPED ENTIRELY unless the server declares `capabilities.experimental['claude/channel']` AND answers `initialize` with a legacy protocol revision. A modern revision trips an `era` skip, a missing capability trips a `capability` skip, and the toast for a `capability` skip is suppressed, so the push vanishes with nothing on screen and nothing in any log. The shipped daemon already did both, which is exactly why nobody knew it mattered; the SDK answers `initialize` with whatever revision the CLI asks for, so the era this channel lives in moved with two things outside this repository.

**How to apply next time:** Split a capability into the half that READS and the half that WRITES before deciding what a host can offer, and ship the reading half everywhere. Reading the session transcript has no platform limit, so Last check, the turns and the time work on Windows for a goal a person typed in their own terminal; only ARMING one needs something that can type, which on this channel is the tmux injector on Mac and Linux. Declare the difference rather than hiding it: `lib/declared-capabilities.ts` is a per beat function now, so the owner is offered Keep working exactly where it would do something and is offered nothing at all, rather than a greyed control, everywhere else. And when a transport fact is load bearing and silent when broken, pin it in a test instead of relying on it having always been true: `lib/channel-transport.ts` now pins the protocol revision and `test/channel-transport.test.ts` drives both gates over a real in memory transport, with a control that shows an unpinned server echoing the client.

The weak fallback is named so nobody proposes it again: pushing a message that ASKS the agent to run `/goal` itself. A model has no way to type a slash command, so that reduces to asking it to behave as if a goal were set, which carries none of the Stop hook evaluation and would put a Checked tag on nothing.

**Regression guard:** `test/channel-transport.test.ts` (both transport gates, behavioural plus a source guard on `server.ts`), `test/declared-capabilities.test.ts` (the goal loop and the pause declared ONLY where the injector answers; a host that cannot type declares the read half), `test/compact-inject.test.ts` (the one parameterised literal and its validator), `test/slash-catalog.test.ts` (`/goal` is never published, or the app's own goal door breaks).
