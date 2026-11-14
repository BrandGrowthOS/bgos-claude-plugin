# edit_message really edits, or says it could not (2026-11-14)

## The bug

From 2026-08-04 `edit_message` posted every edit to the backend's unsigned `/webhook/edited_message` bridge with
`chat_id: '0'` and never read the answer. Production, 2026-11-07 to 11-13: 18 plugin calls, 18 refusals
(11 `message_not_in_named_chat`, 7 `message_chat_kind_not_on_this_transport`). The agent heard "Edited" every time.

## The fix

`case 'edit_message'` in `server.ts` checks the id (`/^[1-9]\d{0,17}$/` after a trim), then calls
`bgosPatch(\`messages/${id}\`, { text: safeText })`: `PATCH /api/v1/messages/:id` with the daemon's own credential.
On BGOS main (`backend/src/controllers/message.controller.ts`, `updateMessage`) that route binds the owner to the
credential (`resolveWriteOwnershipUserId`) and asks the chat kind's own edit rule (`mayActOnMessage`); a refusal is a
400 `Message not found or access denied.`. `bgosPatch` throws on anything but a 2xx, so the tool answers
`Failed: PATCH 400: ...` with `isError`. The posted buttons record follows only an edit that landed.

## Proof on screen

A real BGOS backend (BGOS main `ec2203ae10`, built with `nest build`) on a private Postgres 17, the fixture rig's
seed (Maya owns the agent Atlas, id 1) and its web export, signed in as Maya in headless Chrome. The REAL plugin
daemon (`bun server.ts`) runs as an MCP stdio server, paired to Atlas through `pair-codes` and `pair-exchange`, with
an isolated HOME. `harness/drive.mjs` calls `reply`, then `edit_message`, screenshots after each, reads the row back
over the API as Maya, then tries three edits that must fail. Run once with plugin `origin/main` (0.87.5, `before`)
and once with this branch (`after`), against the same backend and chat.

| Step | before (0.87.5) | after (this branch) |
|---|---|---|
| reply | `Sent (message_id: 10) ...` | `Sent (message_id: 11) ...` |
| edit_message on its own reply | `Edited`, row unchanged, no `editedAt` (`before-2-after-edit.png`) | `Edited`, row text changed, `editedAt` stamped, bubble changed live with the "edited" mark (`after-2-after-edit.png`) |
| `message_id: "abc"` | `Edited` | `Error: message_id must be a message id from a reply` (isError, no request) |
| `message_id: "999999"` (no such row) | `Edited` | `Failed: PATCH 400: Message not found or access denied.` (isError) |
| `message_id: "6"` (Leo's line in a room Maya created) | `Edited` | `Failed: PATCH 400: Message not found or access denied.` (isError), row unchanged |
| after a reload | draft text (`before-3-after-reload.png`) | edited text (`after-3-after-reload.png`) |
| phone width, light | `before-4-phone-light.png` | `after-4-phone-light.png` |

`before-backend-refusals.log` is the backend's own account of the old route on the rig: the same refusal reasons
production logged (`message_not_in_named_chat`, `message_chat_kind_not_on_this_transport`, 401). The `after` shots
also show message 10 from the `before` run, still unedited above the edited message 11: both runs in one frame.
`after-backend-refusals.log` holds the two refusals of the new route. Each run's tool calls and answers are in
`*-transcript.json`.

## Tests

- `red-first.tap`: `test/edit-message-route.test.ts` against the unchanged `server.ts`, 24 of 25 red. The one green
  is the posted buttons record test, which already held (the old code noted only a 2xx).
- `green.tap`: the same file and `test/private-turn-owner-tap.test.ts` on this branch, 112 of 112.
- Mutation: moving `postedButtons.edited` above the PATCH fails both the new record test and the updated
  "re-verify (Low)" test.

## Round 2: only a message this agent sent (review F1)

The PATCH carries the owner's credential, and the backend admits any row the owner may edit, so round 1 let the tool
rewrite the owner's own lines and the lines of the owner's other agents. `lib/own-messages.ts` keeps the ids the
server answered as this agent's own rows when the daemon created them (`bgosPost` notes the answer of
`POST /send-message` and `POST /messages` when `sender` is `assistant` and `senderAssistantId` is absent or this
agent), in `own-messages.json` beside the chat cursors, bounded and kept across restarts. `edit_message` refuses any
other id with one line before anything is sent. An edit that got no answer now says it may have landed (F3).

Same rig, two targets made through the API as Maya: her own line in Atlas's chat (message 12) and a line of her
other agent Kite in Kite's chat (message 13). `harness/drive2.mjs`.

| Call | round 1 (`851630e`) | round 2 (this commit) |
|---|---|---|
| edit Maya's own line 12 | `Edited`; her bubble now reads "Never mind, any small room is fine.", marked edited (`round2/round1-1-atlas-chat.png`) | `Error: edit_message edits only a message this agent sent, and message 12 is not one of them, so nothing was changed`; nothing sent (`round2/round2-1-atlas-chat.png`) |
| edit Kite's line 13 | `Edited`; Kite's line rewritten (`round2/round1-2-kite-chat.png`) | the same refusal; Kite's line intact (`round2/round2-2-kite-chat.png`) |
| its own reply 14 | | `Edited` |
| its own reply 14, after the daemon restarted | | `Edited` (the record survived; `round2/round2-3-after-restart.png`) |

Round 2 ran first; the round 1 shots therefore also show reply 14 as round 2 left it.

Tests: `round2/red-first.tap` (the route tests against round 1's `server.ts`: 6 red, the owner's line, the other
agent's line, an id never created, F3, the bgosPost note, and the source check); `round2/green.tap` (the route tests,
`test/own-messages.test.ts` and the private turn test: 128 of 128); `round2/mutants.txt` (six mutants, all killed:
no own row check, the record keyed by the raw id (F2, killed by a source pin, since the posted buttons record keys by
`Number()`, which ignores the same whitespace `trim()` removes), no note in bgosPost, another agent's row counted, a
user row counted, the no-answer wording dropped).

Not covered here: native iOS and Android (the change is in the plugin daemon, the app's rendering of
`edited_message` is unchanged; phone width is shown in the web export).
