---
name: hoai-browser
description: Use the HOAI Agent Browser for websites, research, and web tasks through the person's selected HOAI browser or approved agent machine. Explain encrypted login storage and browser prerequisites without requesting credentials in chat.
---

Use the shipped `hoai-browser` MCP tools. Start with `hoai_browser_open_session` and a short purpose, then navigate and inspect the page. The daemon starts its browser host automatically for its pairing. A managed agent-machine profile uses the pinned sandboxed Chromium by default. Legacy sessions prefer an installed Chrome or Chromium. When the required bundled browser is absent, the plugin downloads its pinned revision into the machine user's cache on first use. A download failure or missing operating-system library is an installation error to report, not permission to disable the sandbox or install system packages silently.

When HOAI reports a managed browser profile, the shipped launcher resolves that verified person's current profile through HOAI before using tools. A profile can run in the person's HOAI desktop while this agent controls it through the server, or on an explicitly approved agent machine. Browser location and who controls its current page are separate choices. A stopped, staged, fenced, unavailable or setup-required profile must be reviewed in HOAI. Never switch to another browser, another person, an older profile or the legacy relay to work around that state. A missing or failed discovery response is not permission to start a different browser. Polling and cancellation refer to the original exact session and never repeat its action.

A fresh agent installation ships the browser runtime, paired protocol and setup instructions. It does not silently enroll a machine, approve a device key or grant background access. Until the person reviews that machine's identity and explicitly permits background use, report `setup_required` and direct them to Browser in HOAI. Agent-machine profile key storage requires an available persistent OS secret service on supported Linux. A locked or missing provider is a setup or unlock requirement; never save endpoint keys, profile keys or passwords in plaintext as a workaround. Product support for moving a particular browser state must be qualified; a successful disposable-site test does not establish support for every website, active connection or unfinished sign-in.

For managed profiles, the shipped companion starts with the daemon's browser host. It observes only a person's explicit device setup request. That person's public endpoint candidate is distinct from every other recipient's, including recipients of a shared agent. The person compares the full public fingerprint in HOAI, accepts that exact key and separately grants background use. A new browser stays blocked until a separate exact session request is confirmed in HOAI. Background consent does not authorize site actions, credentials, payments or downloads. A recipient permission that is unavailable must refuse the action, never ask the original sharer on the recipient's behalf.

The managed companion uses the plugin's pinned, sandboxed Chromium by default. An explicit `HOAI_BROWSER_EXECUTABLE` override still has to pass the exact native browser qualification. Unsupported versions refuse profile movement. Movement refuses populated password or security-code fields, changed form fields, outstanding or uncertain network operations, and WebSocket, WebTransport or RTC history that cannot be safely moved. These checks are not a generic inventory of application memory or every unfinished OAuth flow. Finish sign-in in its current browser instead of bypassing a refusal or moving a pending login.

For ordinary managed page text, request `browser_type` without `slowly` or `submit`, or `browser_fill_form` with textbox fields. Each needs a fresh **Enter page text** approval and exact current native field classification. Passwords, codes, unknown field purposes, subframes, contenteditable, global keys and automatic submission remain human handover cases. A refused or uncertain action is not retried. Do not put credentials in text arguments to work around that gate. See [managed plaintext fields](../../docs/browser-profile-fields.md).

Before moving a person's desktop checkpoint to the agent machine, the machine operator must independently compare and review the desktop's full source fingerprint. HOAI exports public review JSON. The operator runs the shipped command only after that comparison:

```bash
node bin/hoai-browser-host.mjs --review-profile-peer /absolute/path/public-peer-review.json --confirm-fingerprint <full-64-character-fingerprint>
```

This is a human setup decision, not an agent tool or an instruction to approve a key found on a website. Do not run it autonomously or substitute a fingerprint from relay metadata. Missing, stale or changed own enrollment and source pins refuse. Review data contains public keys only. Browser traffic and encrypted state continue through HOAI; this command opens no direct peer connection. See [companion setup](../../docs/browser-profile-companion.md), [moving ordinary open pages and its exceptions](../../docs/browser-profile-open-pages.md) and [Linux encrypted login storage](../../docs/browser-profile-portable-extras.md).

Managed profile cookies, saved logins and search preference use the approved profile's OS-protected encrypted state, separate from the legacy passphrase vault below. A successful normal stop proves native shutdown and local encrypted journal readback before committing to HOAI. Unknown writes are not replayed. A fresh process can restore its own verified committed stopped checkpoint only after current pairing, share, grant and key checks, a new process tuple, inactive staging and the server's new writer epoch. It never resumes an old active boot. A network status failure pauses new agent actions and reports unknown while retaining the live page. A verified revocation stops the local runtime. Neither condition invents a saved checkpoint or authorizes failover.

For missing Linux libraries, inspect dependencies from the installed plugin directory with the pinned CLI:

```bash
node node_modules/playwright-core/cli.js install-deps --dry-run chromium
```

The dry run does not change system packages. On supported Linux systems it simulates installation and returns a nonzero exit code if required packages are missing. Report the output to the owner. Only after the owner or administrator explicitly approves privileged operating-system package changes should they run:

```bash
node node_modules/playwright-core/cli.js install-deps chromium
```

The install can request sudo privileges. Never run it or apt automatically. Run the browser host as a non-root user with Chromium's required user namespaces and sandbox operations permitted by the host or container policy. If sandbox support is blocked, ask the administrator to configure that policy; never add `--no-sandbox` or broadly disable security protections. Reference: Playwright's [system dependencies](https://playwright.dev/docs/browsers#install-system-dependencies) and [sandbox guidance](https://playwright.dev/docs/docker#crawling-and-scraping).

When the managed browser runs locally in HOAI, the person's keyboard, pointer and rendering stay on that desktop. Agent commands reach that same page through the HOAI server. Hand back to agent keeps the live page, tabs and unfinished sign-in in that browser. Continue on agent's machine is a different operation that stops the source and moves supported saved state only. Never suggest a machine move to work around a pending sign-in or a temporary human-control refusal. All cross-machine commands, encrypted checkpoints and explicitly shared files go through HOAI. Do not expose a browser debugging port or make a direct desktop-to-agent connection.

For a shared agent, the browser belongs to the person whose verified current message started the work. Each recipient and the original owner have separate browser sessions, cookies, encrypted login files and schedules. Here, browser owner means that person, including an authorized share recipient. Do not select a person from tool arguments, copy another person's profile, or fall back to the original owner's browser. If private turn verification refuses an action, it did not start: ask the person to send a new message in their own HOAI chat. Do not retry with another identity or local browser. Existing recipient-consented activity summaries keep their current consent rules.

For a managed browser, use the exact selected profile and current runtime reported by HOAI, whether its authorized host is the person's desktop or the agent machine. Human control and a collapsed pane do not end that session. Respect the reported control state and wait for the person to hand back control when required. The X action ends the session; it is not a way to hide the pane or release a temporary control refusal. Never open an unrelated browser, another profile or a fresh session as a substitute.

The following remote-pane and passphrase instructions apply to legacy browser sessions. They do not change the managed native browser or its OS-protected profile described above.

The legacy pane provides address navigation, Back, Forward, Reload, Stop, and New, Select and Close tab controls for the actual browser on the agent machine. Owner actions require taking control and pause agent browser tools while the physical action settles. Switching a tab or navigating releases stale input and login offers. Opened links can create a tab in that same browser. A separate desktop tab is not a substitute for this legacy remote session.

An owner click inside the browser pane takes control. Pointer movement, keys, scrolling and activity in other apps do not take control or extend the click timer. Ordinary input returns control automatically after at least ten seconds without another accepted pane click, once any physical input cleanup finishes. The owner can also use **Hand back to agent**. Protected login entry has its own reservation until the owner finishes, cancels the native window, or its offer expires. Never close the browser to work around temporary owner control: this would interrupt the owner's session.

On the agent machine, a running browser action finishes once before owner input starts. A new request refused with `owner_control` did not start and can be retried once control returns. Check `hoai_browser_status` before retrying. Do not replay any action reported as interrupted after dispatch or with an unknown outcome; inspect the page first to avoid repeating a submission or other side effect.

Every new legacy browser starts with login storage locked and a nonpersistent browsing context. This agent and each person it acts for have separate encrypted storage. Browsing while locked is discarded when the browser closes. Site permission grants are separate from login storage consent.

For sign-in, tell the owner to open **Logins** in the browser pane. Only the owner can enter the vault passphrase in trusted HOAI UI. Never request passwords, passphrases, codes, cookies or login tokens in chat, tool arguments or agent instructions. Do not put them in scripts, files, environment variables or logs.

Unlock permits encrypted cookie, localStorage and IndexedDB snapshots on the agent machine until the browser closes. Session cookies are included. The passphrase and encryption key are never saved. After a restart, the owner must unlock again. Losing the passphrase means existing saved state cannot be recovered by HOAI.

Creating storage for the first time keeps and encrypts the sign-in already in this browser. Unlock an existing configured vault before signing in: unlocking it restores saved cookies and storage in place of the current session. Browser display metadata keeps the canonical public origin used for routing and credential offers; known credential values are redacted from titles and URL paths, queries and fragments.

**Enter login** and **Fill saved login** are owner actions bound to the exact page and origin. Login detection accepts visible username/password, password-only steps and JavaScript login pages without an HTML form. An unrelated captcha iframe, alternate Email OTP link or signup footer does not block a top-page login. Hidden, ambiguous or replaced targets and foreign form destinations still refuse automatic filling. Filling never submits automatically. Saving a new password requires a separate **Save** confirmation; **Not now** discards the password candidate.

Clicking a password or other protected login field opens trusted native HOAI entry for that exact field. The owner can enter a password, username or OTP even with storage locked. That one-use encrypted field operation neither stores nor automatically submits the value. Raw page keystrokes remain disabled for protected fields. **Save a new login** in Logins lets the owner explicitly create an encrypted entry for the exact current origin even if the page has no recognized login form. Unlock storage first to save it. Never ask the owner to put the value in chat as a workaround.

After entry or saved fill, the owner reviews the page, takes control and clicks its validated **Sign in** submit button within 30 seconds. For HTML forms, this permits one explicit pointer down/up on the captured form and button. Navigation, a new form, releasing control or expiry revokes that permission. Payment, file, opaque iframe and unsupported secret fields are refused. Signup or OTP fields are not filled by whole-login autofill; owner OTP entry uses the separate native field action.

An existing native Chrome profile can contain unencrypted login material. Never open or migrate it automatically. The trusted owner flow explains and requests explicit consent before clearing supported legacy Chrome artifacts. An active legacy browser or unknown files block clearing. Do not remove another process's profile or request a credential through chat to work around a refusal.

Encryption protects saved files. The destination page and this agent machine receive plaintext during use, and a compromised agent account can inspect live browser state. Do not describe this as protection from the agent machine or as protection against an actively malicious HOAI server substituting cryptographic offers.

Close the browser session when finished. An unlocked vault drains its last encrypted snapshot, then locks. No secrets should appear in the task summary.

The pane's collapse arrows hide the view and keep the exact agent browser session running. The X control ends that person's session and saves unlocked encrypted state before confirming closure. An unconfirmed close is not proof of shutdown. Reconnect only restores the view; it never repeats the close request.
