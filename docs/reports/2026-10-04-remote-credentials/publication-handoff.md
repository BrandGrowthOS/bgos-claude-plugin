# Publication handoff, 2026-10-04

The owner authorized pushing review PRs after the local runtime proof and security audit. No merge, deployment, package release or production change is authorized. Earlier handoffs retain their local-only status and historical source identities.

| Piece | Branch | Full source commit | Base |
| --- | --- | --- | --- |
| A, independent live view, plugin 0.60.3 | codex/remote-browser-live-review | 6142bc9d8883806a6b1603f36fe5e1def987059f | main at ca5b94ea37453420ac0998a35f718556fc9d4fbe |
| B, guarded control; D, encrypted storage and provisioning, plugin 0.60.5 | codex/remote-browser-control-storage-review | ea34c3098bf8552da5571de3fa9777c884a5fdee | A branch |
| Evidence only | codex/remote-browser-review-evidence | See PR head | main at ca5b94ea37453420ac0998a35f718556fc9d4fbe |

The follow-up code tree exactly matches the independently audited combined candidate ef6087ec9fdfef779e3f1cb887a2c261b08a13cf outside evidence and docs/reports. A contains no input or credential flow. There are no runtime or test dependencies on files moved into the evidence PR.

Merge and deploy the matching BGOS control/storage follow-up before upgrading agents to 0.60.5. The new plugin advertises remoteInput and remoteCredentials in hoai.ready, which the strict A-only server relay refuses. The new BGOS server accepts the older A-only plugin. A can ship independently with the matching BGOS A branch. Retarget the follow-up to main after A merges if needed.

Publication validation repeated 24 touched Windows vault, real Chromium persistence, redaction, credentials and bootstrap tests with zero failures or skips, plus tsc --noEmit exit 0. See publication-tests.txt and publication-typecheck-summary.txt. The original evidence retains 124 touched Linux tests, fifteen printed executable red/restore mutations and a fresh npm-packed installation with empty dependency and browser caches.

Independent review confirmed exact committed tree identity, branch ancestry, A isolation and critical runtime hashes. Vault SHA256 remains 174E50C59C132DAE93F18A3CC963A9717CBDF17F35223F5A1E859C71B8BD358C; bootstrap remains AFD690386D5EDAA82FDFBC1B35203E50A74ABD038249405452C706B885515F92. The fresh packaged archive was proven before publication and is unchanged source: 911755444fe52661829aa66cc576e997a9dae93cadfe991cf2fe71ee39ef64cd.

The shipped host, browser dependencies, automatic pinned Chromium provisioner and skills/hoai-browser/SKILL.md implement fresh-machine behavior. Owners do not reproduce the disposable Linux staging setup. Provisioning retains the browser sandbox and does not automatically install privileged operating-system packages.

All forwarding passes through HOAI. Passwords and passphrases use the trusted native owner flow; ordinary pane credential typing stays refused. Explicit Save is required for password entries. Saved browser state is passphrase-encrypted on the agent machine. The server/application remain trusted offer authorities, and the agent machine and destination page receive plaintext during use. Text redaction is not universal secrecy from pixels, transformed values, bearer tokens or a compromised endpoint. Read implementation-handoff.md and the matching BGOS security-audit.md for the full security scope.

UTF-16 text logs were converted to UTF-8 and trailing text whitespace was removed for GitHub review. Log content and screenshots were otherwise preserved.

Historical evidence/ logs are preserved under docs/reports/2026-10-04-remote-browser-host-evidence in this evidence-only PR. This keeps the diff non-shipping under the existing version gate without changing that gate or bumping a package version for reports.
