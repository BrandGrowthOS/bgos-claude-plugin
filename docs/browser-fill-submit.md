# Filled fields and separate submission approval

The portable host enforces this rule at `PlaywrightEngine.callTool`, shared
by the Chromium adapter, host MCP and relay calls, and direct-engine calls.
A per-page weak map holds field references and a revision, never field values.
The dispatcher initializes Playwright's lazy tab inventory before choosing the
page for privacy and fill tracking, including the first direct-engine call.
Textbox fill attempts mark the page before backend dispatch, so partial errors
retain the barrier. Keys and select changes conservatively mark potential field
changes too. State survives document navigation and tab selection.

`FORM_TOOL_CLASSES` is the complete classification table. Fixed reads and
textbox fills are safe while fields are pending. All other classified actions,
including every click, key, navigation, tab operation, dialog, upload, drop,
hover and resize, require a separate fresh owner approval. Unknown tools and
scripts are refused with `form_submit_approval_required`. Scripts cannot be
approved while fields are pending. The registry test compares the table with
the full supported roster and fails when a tool lacks a classification.

The core forces a new allow-once gate after filling, regardless of saved grants.
Its closure issues an opaque single-use capability for the exact page, tool,
arguments and field revision only when that gate runs the held action. A normal
write approval, an agent argument or a target-binding object cannot substitute
for it. The engine checks it again immediately before dispatch, after privacy
preflight and live target binding. Approval clears the pending set. A key or
select action may immediately begin a new pending set. Concurrent engine calls
are serialized so fills cannot overlap an activation inside the dispatcher.
A fill during a held approval invalidates that approval's revision.

Batch fill accepts textbox operations only. It validates the entire batch
before any fill or gate, so a later checkbox, radio or select operation cannot
activate a control changed by an earlier textbox. The shim carries the same
restriction and schema on local and relay routes. Other control changes must
be separate actions and pass the filled-tab gate.

This rule governs agent tool dispatch. Page event handlers remain page code;
it does not promise to suppress a website's own network requests or arbitrary
script side effects triggered by text input. Managed field input continues to
use its independent person-approved controller. External host and shim mirrors
were not accessed or changed; their integration remains outstanding.
