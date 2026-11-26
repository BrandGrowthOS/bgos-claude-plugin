# Normal agent browser and saved login evidence

The source branch is `codex/remote-browser-normal-controls`. Its first commit is [85c0ce20](https://github.com/BrandGrowthOS/bgos-claude-plugin/commit/85c0ce20e75146e34f0aec1200c64283fdd2dc1b), and its final frozen commit is [fd03a09](https://github.com/BrandGrowthOS/bgos-claude-plugin/commit/fd03a09aa50d6d24cd7a366aa607c5f3dce5b0bb). This documentation branch starts at `origin/main` commit `62fe80f` and contains no runtime changes. Package and plugin manifest versions in the source candidate are both 0.61.4. No release tag, deployment, production database write or live-account login was performed.

The implementation is under review in [plugin source PR #183](https://github.com/BrandGrowthOS/bgos-claude-plugin/pull/183) and [HOAI source PR #1989](https://github.com/BrandGrowthOS/BGOS/pull/1989). These documentation proofs are separate from the source diffs.

The pane controls the real agent browser through HOAI. The plugin adds address navigation, history, Reload, Stop and tab creation, selection and closure. Physical operations retain the agent-tool fence until they settle. Navigation replies acknowledge dispatch before delayed network headers or documents complete, so Stop can reach the browser. New viewers negotiate browser controls explicitly; older viewers keep their existing single-target stream. At most 16 tabs are permitted, including agent-created tabs before a viewer attaches. Selecting or closing a tab checks its displayed identity as well as its index.

Protected-field entry remains a dedicated native owner action. A password, username or OTP can be entered through the encrypted field operation while storage is locked. Explicit Save a new login stores an entry for the exact current origin without requiring a recognized HTML form. Whole-login fill accepts password-only steps and JavaScript login pages while retaining document, origin and field identity checks. Creating storage for the first time preserves the browser's current completed sign-in. Unlocking an already configured vault restores its saved profile; it cannot adopt replacement browser state.

## Diagnosis and limits of the reproduction

The screenshot's exact website was not exercised with live credentials. The confirmed reproducible false-positive class is a visible top-page sign-in with an unrelated iframe, alternate Email OTP link and signup footer. Restoring the original blanket iframe guard produced `credential_changed` on that disposable real-Chromium fixture. Separate mutations restored the no-form refusal and whole-form signup-text heuristic; each corresponding realistic fixture went red. The corrected fixtures filled and explicitly saved the encrypted login without automatic submission. This evidence does not establish a cause for the earlier intermittent Google HTTP 400.

## Focused verification

The final restored source passed exactly 10 touched test files: 122 tests, zero failures, zero cancellations and zero skips. `tsc --noEmit` and `git diff --check` passed. The tests used real pinned Chromium with disposable local HTTP fixtures and isolated agent profiles. The test executable override was removed afterward.

| Test file | Passing tests |
| --- | ---: |
| test/hoai-browser-host.test.ts | 34 |
| test/remote-view.test.ts | 10 |
| test/remote-input.test.ts | 10 |
| test/remote-credentials.test.ts | 40 |
| test/agent-browser-vault.test.ts | 16 |
| test/remote-browser-controls.chromium.test.ts | 7 |
| test/remote-view.chromium.test.ts | 1 |
| test/remote-input.chromium.test.ts | 1 |
| test/remote-credentials.chromium.test.ts | 1 |
| test/agent-browser-vault.chromium.test.ts | 2 |
| Total | 122 |

```powershell
node --import tsx --test test/hoai-browser-host.test.ts test/remote-view.test.ts test/remote-input.test.ts test/remote-credentials.test.ts test/agent-browser-vault.test.ts test/remote-browser-controls.chromium.test.ts test/remote-view.chromium.test.ts test/remote-input.chromium.test.ts test/remote-credentials.chromium.test.ts test/agent-browser-vault.chromium.test.ts
node node_modules/typescript/bin/tsc --noEmit
```

The real browser tests verify changing streamed JPEG frames after Stop, typed native field values appearing in the remote page, explicit saved entries remaining encrypted, full browser restart restoring cookies, localStorage and IndexedDB, first-time vault setup retaining the current sign-in, tab identity race refusal, background roster refresh, owner-created popups, an ownerless 16-tab context, old-viewer compatibility, Stop during responses delayed beyond the relay deadline, and loading completion for physical links and same-document history. Unit probes also defer the old capture start, close its active target and verify capture starts on the replacement target before the old promise settles.

The companion HOAI proof also passed against the final frozen source candidates with a disposable Linux agent browser. It exercised the actual pane and relay, including a response delayed by 12 seconds whose owner Stop command completed in 118 ms. Its recording and visual evidence are maintained separately in the HOAI evidence PR.

All 18 executable mutations went red and were restored. Two baseline reproductions also went red: the original login guard and the missing physical-fragment observer. The printed executable lines and failing test names are retained in [mutation-proofs.md](mutation-proofs.md). The final suite transcript is [focused-tests.txt](focused-tests.txt), with compiler output in [tsc.txt](tsc.txt).

## Fresh installation and agent instructions

The actual shipping [browser skill at the frozen commit](https://github.com/BrandGrowthOS/bgos-claude-plugin/blob/fd03a09aa50d6d24cd7a366aa607c5f3dce5b0bb/skills/hoai-browser/SKILL.md) instructs an agent to use its shipped hoai-browser MCP tools and automatic daemon browser host. It explains pinned Chromium provisioning, owner controls and native encrypted Logins. It prohibits passwords or codes in chat and browser tool arguments. The [shipping README](https://github.com/BrandGrowthOS/bgos-claude-plugin/blob/fd03a09aa50d6d24cd7a366aa607c5f3dce5b0bb/README.md) gives installation and prerequisite instructions.

Linux still requires system libraries and sandbox support. The shipped instructions provide the pinned dependency inspection command and require explicit administrator approval before privileged package changes. They do not add `--no-sandbox` or expose a debugging port. Installation does not grant permission to save credentials; only the owner's native consent enables the encrypted vault.

See [fresh-install.md](fresh-install.md) for the fresh packaged-install check. That Windows packaging proof is separate from the HOAI desktop and remote Linux live-pane proof maintained in the companion HOAI evidence PR.

## Security review boundaries

All browser traffic crosses the authenticated HOAI relay. Ordinary pane keystrokes are refused on protected credential fields. Native credential values are sealed to a one-use offer and checked against the current session, tab, document, origin and captured field. The destination page and agent machine receive plaintext while using a login. Saving remains a separate explicit owner action, and encrypted vault files never retain the passphrase or derived key.

Saving a login for the current origin does not fill or submit it. Field entry neither persists nor submits its value. Captured HTML-form submission permits one physical pointer down/up within 30 seconds and checks the same document, fields, form and submitter. Hidden, changed, ambiguous and foreign-destination targets remain refused. Payment fields, file fields and opaque iframe credential fields remain unsupported.

Tab transitions revoke stale credential offers and input, publish the authenticated new target before its frames, and retire the old CDP session. Indexed tab actions carry an expected tab identity to prevent closing or selecting the wrong target after concurrent roster changes. Negotiated revocations distinguish navigation and target replacement from expiry or release, allowing the desktop to clear expired owner authority. Old viewers receive the original empty revocation shape. Agent tools remain fenced through unresolved physical actions.

Known credential values are redacted from ordinary tool text, display titles, and URL paths, queries and fragments. The canonical public origin remains routing and credential-offer authority metadata. Session and tab identifiers are also retained as routing identifiers. Secret-value substitutions do not rewrite those authorities or identifiers; a short OTP matching a hostname character otherwise made valid state unparseable. This is a precise limit of the redaction guarantee.

Streamed JPEG pixels and binary screenshots are not guaranteed to redact registered credential values. A website may render usernames, OTPs, secrets or signed-in account content in visible pixels. Those images remain visible to the trusted viewer and relevant browser or relay endpoints; binary screenshots returned by agent tools can also expose that rendered content. Text redaction and sealed native credential entry do not provide secrecy for page pixels or signed-in browser content.

Encryption protects stored files and the intended relay envelope against passive observation. It does not protect live browser state from a compromised agent account or machine. The current cryptographic offer exchange does not protect against an actively malicious HOAI server substituting offers. The destination website can read its own form values, cookies and storage. Browser screenshots, URLs and page content remain visible to the trusted owner, and other page content may contain information not registered as a credential value.

Fresh storage setup adopts current cookies and origin storage only when the vault was previously unconfigured. The encrypted snapshot and tracked context are established before the browser continues. An existing configured vault cannot silently adopt replacement state. Restoring an existing vault replaces current cookies and storage, so shipping instructions tell the owner to unlock it before starting a new sign-in. Restart requires native unlock again; lost passphrases cannot be recovered by HOAI.

The delegated final independent diff review and cross-repository security audit reported no remaining blockers after the source corrections and regression probes. The companion HOAI evidence records the final review details. This does not broaden the trusted-endpoint, public-origin or pixel-visibility guarantees described above. No personal screenshot, credential envelope, passphrase, token, cookie value or production connection transcript is included in this evidence branch.
