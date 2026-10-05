# Encrypted agent browser storage and owner login handoff

Candidate: `codex/remote-browser-host`, package and plugin manifest `0.60.5`. No push, merge, publication, production database write or production configuration change was performed. The companion candidate is committed locally for the orchestrator's final review.

## Delivered behavior

The host launches a fresh disposable Chrome shell and a separate nonpersistent Playwright context. It never reopens the old native Chrome profile. Locked browsing leaves no persisted browser state. Owner unlock derives an AES-256-GCM key using asynchronous scrypt, restores cookie/localStorage/IndexedDB state into that context, and enables encrypted snapshots including session cookies. The key and passphrase are not saved. The stable profile stores the encrypted vault and existing browser policy. POSIX mode/owner/symlink checks and an owner-only Windows DACL protect the profile. Bounded reads, authenticated agent/principal scope, fresh nonce, atomic replacement, and serial snapshot/login operations prevent cross-profile restoration and lost updates. A failed save preserves prior ciphertext and reports a fixed persistence failure while cleanup locks and closes the browser.

The final native proof exposed a real SPA regression: Playwright 1.63 resets its visited-origin registry to the origins supplied to `setStorageState`, so restoring an empty vault while a page was already open caused later localStorage/IndexedDB writes to disappear from snapshots. The restore copy now includes empty entries for currently open HTTP(S) origins that have no saved entry. Playwright performs restoration through its own intercepted internal pages, preserving the visible document and existing saved state. The real Chromium test starts with the page open, unlocks, writes storage without navigation, then restarts and restores before reading it. It asserts identical document identity and zero website requests during unlock. The public API is documented in the [Playwright BrowserContext reference](https://playwright.dev/docs/api/class-browsercontext#browser-context-set-storage-state); the origin reset was verified in the pinned local package source.

The final audit also reproduced a still-live IndexedDB connection surviving Playwright's unawaited page-level database deletion. Before restoration the vault now uses the target context's public CDP session and `Storage.clearDataForOrigin` for IndexedDB. This force-closes old connections before either empty or saved database restoration. Public page, frame-navigation and service-worker events retain current and historical origins until context close or a new bind. The set is bounded at 1,024 origins and overflow refuses restoration. Invalid URLs from frames that have not committed are ignored. Real Chromium tests verify that a worker on a historical origin cannot read its old locked canary after restore, while another context at the same origin remains unchanged. The visible document is preserved. Installer filtering separately ignores Chrome-specific environment opt-ins, so opting Chrome into an SSH agent socket cannot grant that socket to the downloader.

Owner login entry uses the existing HOAI relay with the shared X25519/HKDF/AES-GCM offer protocol. The independent credential lease fences agent actions, captures exact document/form/field handles and rechecks them around every DOM event. Filling does not submit. Saving a password requires the separate Save decision; Not now discards the candidate. A completed trusted fill permits one explicit owner pointer click on the exact validated submit button for 30 seconds. Nested button descendants inherit credential classification. Interrupting a held submit releases offscreen. Password typing through ordinary B remains refused.

Passwords are registered before DOM events. The per-engine redactor covers Playwright output rendering, console collection, text artifacts, synthesized session status and errors, including late registration during a pending status read. Normal JSON, URL and HTML serialization variants are covered. Its capacity is bounded, and Not now does not remove protection while the password remains in the page.

The daemon's normal host startup prefers installed Chrome/Chromium, otherwise downloads the pinned Playwright Chromium into the user cache. It uses a filtered installer environment, process and cache locks, and a bounded timeout. It neither installs operating-system packages nor disables the browser sandbox. The shipped browser skill, README and release notes explain locked storage, owner-only passphrases, separate save consent, manual submission and installation requirements.

## Final checks

- Twelve focused Linux suites: **124 passed, 0 failed, 0 skipped**, 51.935 seconds. See `final-focused-checks.txt`.
- Windows vault, actual Chromium SPA/held-database persistence, late-secret redaction, credential and bootstrap checks: **24 passed, 0 failed, 0 skipped**. See `windows-security-final.txt`.
- `npx tsc --noEmit`: **exit 0**. See `final-tsc.txt`.
- Fresh packaged Windows installation: **passed**. Empty dependency and browser caches, 123 freshly installed dependencies, normal production supervisor, automatic Chromium download and first open in **22.396 seconds**, real credential prepare reporting locked/unconfigured storage, locked cookie discard and a full supervisor process restart. All eight required packaged runtime/skill files match the worktree, including final audit fixes and Linux prerequisite instructions. No sandbox-disabling flags; no fixture browser processes remained. See `packaged-bootstrap-summary.md`.
- Real Chromium storage test proves the authenticated context differs from the native disk context, that the native context has no authentication cookie, and that session cookies, localStorage and IndexedDB survive only encrypted owner unlock. Deletion persists across another restart.

Exact Linux command:

```text
HOAI_BROWSER_EXECUTABLE=/tmp/hoai-remote-browser-mjmkaA/fixture-chrome node --import tsx --test test/hoai-browser-host.test.ts test/browser-env.test.ts test/browser-bootstrap.test.ts test/browser-secret-redactor.test.ts test/agent-browser-vault.test.ts test/agent-browser-vault.chromium.test.ts test/remote-credentials.test.ts test/remote-credentials.chromium.test.ts test/remote-input.test.ts test/remote-input.chromium.test.ts test/remote-view.test.ts test/remote-view.chromium.test.ts
```

That Linux wrapper is limited to the disposable root-hosted test fixture; the separately verified packaged Windows path uses neither a wrapper nor an executable override and retains Chromium's sandbox.

An earlier broad Windows attempt is retained in `windows-broad-attempt.txt`: existing host tests assume POSIX paths and graceful SIGTERM, installed Google Chrome encountered an updater pipe startup error under the synthetic HOME, and the new durability fake lacked the redactor field of a real engine. The fake was corrected; the final Windows security checks and clean packaged Chromium path pass. An initial Linux attempt named the fixture executable backwards and is retained in `linux-final-attempt.txt`; the corrected final run passes without skips.

## Executed mutations

Each mutation changed executable source, printed the changed line, produced a failing test, then restored the source and passed its focused check. The tool transcript contains the printed lines; the following files preserve failure output.

| Behavior | Changed executable line | Red proof |
| --- | --- | --- |
| Restore before snapshot | Removed `!this.restored` from snapshot guard | `vault-mutation.txt` |
| Exact captured password field | Replaced `captured.password === password` with `true` | `credential-mutation.txt` |
| Default output/artifact redaction | Replaced redaction pattern iteration with `[]` | `redaction-mutation.txt` |
| Submitter effective destination | Prefixed submit-control validation with `true ||` | `submitter-mutation.txt` |
| Old-close/new-open serialization | Replaced `while (slot.stopping)` with `while (false)` | `closing-mutation.txt` |
| Truthful persistence result | Replaced final `if (persistenceFailed)` with `if (false)` | `persistence-mutation.txt` |
| One manual submit | Replaced submit-up grant consumption with `grant.pressed = false` | `submit-once-mutation.txt` |
| Synthesized status redaction | Replaced core redactor with `value => value` | `status-redaction-mutation.txt` |
| Late secret registration | Captured a copied pattern array instead of the live retained array | `late-secret-mutation.txt` |
| Installed browser preference | Replaced `if (installed?.path)` with `if (false)` | `bootstrap-mutation.txt` |
| Already-open SPA persistence | Replaced the current-page origin loop with `for (const page of [])` | `open-spa-mutation.txt` |
| Uncommitted frame URL | Replaced the URL parsing guard with unguarded `new URL` | `loading-frame-mutation.txt` |
| Held IndexedDB disposal | Disabled the CDP storage reset branch | `held-idb-mutation.txt` |
| Installer privilege separation | Passed Chrome-specific environment opt-ins to the installer | `installer-optin-mutation.txt` |
| Historical worker-held database | Replaced the visited-origin loop with `for (const origin of [])` | `historical-idb-mutation.txt` |

All mutations are restored. Windows ACL reopening also reproduced a real Set-Acl privilege failure before the fix; direct Directory.SetAccessControl retains the same protected DACL and passes the fresh-process and packaged restart tests.

## Security boundaries for the PR

Credentials travel through the HOAI server as sealed envelopes, are decrypted on the agent machine, and reach the destination page in plaintext during use. Saved browser state and passwords are encrypted at rest under the owner passphrase. The offer is bound to authenticated relay context but is not independently authenticated against an actively malicious HOAI server replacing cryptographic offers. An attacker controlling the agent account, runtime or destination page can inspect or misuse live credentials and authenticated cookies. Screenshots and owner-view metadata can reveal content a site chooses to display. Exact-secret redaction is defense in depth for normal agent output, not a guarantee against deliberate secret transformation or a compromised machine.

The ordinary keyboard/pointer channel still refuses detected credential fields. The dedicated credential flow accepts only exact HTTPS or loopback origin, top-document and supported unambiguous login forms. It refuses signup/new-password/OTP/payment/file/hidden/iframe forms and foreign form or submitter actions/targets. No raw password or passphrase is logged or persisted outside the encrypted vault by this feature. Owner save consent is separate from filling. Legacy native artifacts require explicit owner clearing consent and refuse active browsers, unknown files and symlinked paths.

## Stable runtime hashes

```text
bin/hoai-browser-host.mjs A80102B496A4880EB49468D4A48A4759739485B305F34B0DFACA83DBAF941261
lib/browser-secret-redactor.mjs D19227C106183C6CCF9408DB1EC8E832A0805D38D79AE338ECFDD97262F6A8A4
lib/remote-credentials.mjs A437C4061E88709BEEBFB82370EEBD43F6BFE869B957BEFC21EBDC37C5EF9878
lib/agent-browser-vault.mjs 174E50C59C132DAE93F18A3CC963A9717CBDF17F35223F5A1E859C71B8BD358C
lib/browser-bootstrap.mjs AFD690386D5EDAA82FDFBC1B35203E50A74ABD038249405452C706B885515F92
packaged archive 911755444fe52661829aa66cc576e997a9dae93cadfe991cf2fe71ee39ef64cd
```

Native owner-dialog and remote Linux restart captures are maintained by the parent task. This handoff reports only the checks executed in this companion worktree and the disposable packaged/Chromium fixtures.
