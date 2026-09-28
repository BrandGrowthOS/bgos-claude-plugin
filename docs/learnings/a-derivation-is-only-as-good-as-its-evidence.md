# A derivation is only as good as the evidence that rides with it

**Date:** 2026-09-21

**Context:** The stage 7 review of the turn summary card (what a command printed, its exit code,
an edit's line counts, the turn's own clock). Four confirmed findings in this plugin, all green on
the shipped suite, all of them a derivation reading something that was not the evidence it needed.

**Gotcha / Pattern:**

- **A payload shrinker has to be read field by field.** `clipPayload` puts every kept string
  through one clipper that keeps the FIRST 200 characters. `tool_response` had a repair after the
  loop; `error` did not, and the LIVE failure shape carries `error` and no `tool_response` at all.
  So the one field whose value is its TAIL (a failing build's log, with the exit code on its first
  line) was the one field that shipped its head, and only on payloads over 256 KB, where nobody
  looks. The test that was supposed to cover it asserted the tail on `clipped.tool_response` with
  `error` held at a short string, a shape the runtime never emits.
- **An empty diff is not proof that a file is new.** `editCountsFor` took the whole body of
  `content` as added lines whenever `structuredPatch` was empty, on the premise that only a create
  has an empty patch. The runtime says otherwise in its own schema: an update carries an empty
  patch when nothing changed, when the diff timed out and when the write was staged, and the too
  large to diff case carries `originalFile: null` as well, so a missing original is not the gate
  either. Read the discriminator (`type === 'create'`), and make sure it SURVIVES the reduction:
  the forwarder now sends `type` and only builds the reduced `{ lines }` count for a create, so
  both paths answer under one rule.
- **A line anchored redactor cannot see a multi line secret.** The scan ruleset is a detector, one
  rule per line, and the private key rule matches the `-----BEGIN ... PRIVATE KEY-----` header
  alone. Every base64 body line after it matches nothing at all, so the key was stored whole in
  `messages.tool_progress` and re fanned on every edited message frame. A header now takes the
  whole line with it and swallows everything through the first `-----END` line, or the rest of the
  text when there is none.
- **A session opening is not a turn opening.** `SessionStart` set the turn clock, so the first turn
  of a session that had no prompt hook reported the minutes since the daemon attached, and the
  PreToolUse fallback that exists for exactly that case could never run. The two sources are the
  prompt receipt and the first tool of the turn, and nothing else.

**How to apply next time:** When a derivation has a premise ("its patch is populated", "the reducer
already ran"), name the field that proves it and assert on THAT field, not on the absence of
something. When a payload is reduced on a size path, ask which end of each field matters, and read
the live capture rather than the shape you expect. And when a detector is reused as a redactor, ask
what its rules do NOT match: the value of the secret is not always on the line that names it.

**Regression guard:** `test/hoai-hook.test.ts` (`an oversized FAILURE keeps the tail of its error`,
`an oversized update with an empty patch carries no count at all`), `test/tool-outcome.test.ts`
(`a Write whose patch is empty because NOTHING changed claims no lines`),
`test/hook-events.redaction.test.ts` (`a private key block goes body and all`, `a private key with
no END line takes the rest of the text with it`), `test/hook-events.test.ts` (`a SessionStart opens
no clock`). Each proven by restoring the old line and watching only its own case go red.
