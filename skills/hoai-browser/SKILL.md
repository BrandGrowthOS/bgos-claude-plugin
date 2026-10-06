---
name: hoai-browser
description: Use the HOAI Agent Browser for websites, research, and web tasks on this agent machine. Explain owner-controlled encrypted login storage and browser prerequisites without requesting credentials in chat.
---

Use the shipped `hoai-browser` MCP tools. Start with `hoai_browser_open_session` and a short purpose, then navigate and inspect the page. The daemon starts its browser host automatically for its pairing. An installed Chrome or Chromium is preferred; otherwise the plugin downloads the Chromium revision pinned by its bundled Playwright dependency into the machine user's cache on first use. A download failure or missing operating-system library is an installation error to report, not permission to disable the sandbox or install system packages silently.

For missing Linux libraries, inspect dependencies from the installed plugin directory with the pinned CLI:

```bash
node node_modules/playwright-core/cli.js install-deps --dry-run chromium
```

The dry run does not change system packages. On supported Linux systems it simulates installation and returns a nonzero exit code if required packages are missing. Report the output to the owner. Only after the owner or administrator explicitly approves privileged operating-system package changes should they run:

```bash
node node_modules/playwright-core/cli.js install-deps chromium
```

The install can request sudo privileges. Never run it or apt automatically. Run the browser host as a non-root user with Chromium's required user namespaces and sandbox operations permitted by the host or container policy. If sandbox support is blocked, ask the administrator to configure that policy; never add `--no-sandbox` or broadly disable security protections. Reference: Playwright's [system dependencies](https://playwright.dev/docs/browsers#install-system-dependencies) and [sandbox guidance](https://playwright.dev/docs/docker#crawling-and-scraping).

The owner can view and control the page through the HOAI browser pane from another desktop. All traffic goes through the HOAI server. Do not expose a browser debugging port or make a direct desktop-to-agent connection.

The pane provides address navigation, Back, Forward, Reload, Stop, and New, Select and Close tab controls for this agent's actual browser. Owner actions require taking control and pause agent browser tools while the physical action settles. Switching a tab or navigating releases stale input and login offers. Opened links can create a tab in the same agent browser. Never open a local owner-desktop tab as a substitute.

Every new browser starts with login storage locked and a nonpersistent browsing context. This agent and each person it acts for have separate encrypted storage. Browsing while locked is discarded when the browser closes. Site permission grants are separate from login storage consent.

For sign-in, tell the owner to open **Logins** in the browser pane. Only the owner can enter the vault passphrase in trusted HOAI UI. Never request passwords, passphrases, codes, cookies or login tokens in chat, tool arguments or agent instructions. Do not put them in scripts, files, environment variables or logs.

Unlock permits encrypted cookie, localStorage and IndexedDB snapshots on the agent machine until the browser closes. Session cookies are included. The passphrase and encryption key are never saved. After a restart, the owner must unlock again. Losing the passphrase means existing saved state cannot be recovered by HOAI.

Creating storage for the first time keeps and encrypts the sign-in already in this browser. Unlock an existing configured vault before signing in: unlocking it restores saved cookies and storage in place of the current session. Browser display metadata keeps the canonical public origin used for routing and credential offers; known credential values are redacted from titles and URL paths, queries and fragments.

**Enter login** and **Fill saved login** are owner actions bound to the exact page and origin. Login detection accepts visible username/password, password-only steps and JavaScript login pages without an HTML form. An unrelated captcha iframe, alternate Email OTP link or signup footer does not block a top-page login. Hidden, ambiguous or replaced targets and foreign form destinations still refuse automatic filling. Filling never submits automatically. Saving a new password requires a separate **Save** confirmation; **Not now** discards the password candidate.

Clicking a password or other protected login field opens trusted native HOAI entry for that exact field. The owner can enter a password, username or OTP even with storage locked. That one-use encrypted field operation neither stores nor automatically submits the value. Raw page keystrokes remain disabled for protected fields. **Save a new login** in Logins lets the owner explicitly create an encrypted entry for the exact current origin even if the page has no recognized login form. Unlock storage first to save it. Never ask the owner to put the value in chat as a workaround.

After entry or saved fill, the owner reviews the page, takes control and clicks its validated **Sign in** submit button within 30 seconds. For HTML forms, this permits one explicit pointer down/up on the captured form and button. Navigation, a new form, releasing control or expiry revokes that permission. Payment, file, opaque iframe and unsupported secret fields are refused. Signup or OTP fields are not filled by whole-login autofill; owner OTP entry uses the separate native field action.

An existing native Chrome profile can contain unencrypted login material. Never open or migrate it automatically. The trusted owner flow explains and requests explicit consent before clearing supported legacy Chrome artifacts. An active legacy browser or unknown files block clearing. Do not remove another process's profile or request a credential through chat to work around a refusal.

Encryption protects saved files. The destination page and this agent machine receive plaintext during use, and a compromised agent account can inspect live browser state. Do not describe this as protection from the agent machine or as protection against an actively malicious HOAI server substituting cryptographic offers.

Close the browser session when finished. An unlocked vault drains its last encrypted snapshot, then locks. No secrets should appear in the task summary.
