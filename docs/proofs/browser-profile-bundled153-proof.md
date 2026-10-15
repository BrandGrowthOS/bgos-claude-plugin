# Bundled browser delivery qualification

The pinned `playwright-core@1.63.0` installs full Chromium `153.0.8010.12`, revision1243. Fresh managed setup previously refused that browser: the native observer admitted only separately qualified Chrome `155.0.8059.39`, and Runtime had an independent `155.*` check. Both now use the same frozen list of two exact qualified versions. Unknown patch versions and a changed observed version still refuse. The observer remains bound to its original browser, native process identity, context and authority.

The shipped companion uses `ensureBrowser()` with its bundled full Chromium when no executable override exists. The Runtime probe now uses that same resolver. Playwright's implicit headless shell lacks the private native WebUI and correctly fails qualification; it is not the managed companion's selected default. No custom executable override was present in the successful default proof.

## Evidence

The disposable image started from official Node22 Bookworm Slim digest `sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392`, plugin commit `6beef48`, `npm ci` and the pinned browser installer. Its initial image reports `profile_key_setup_required` without Secret Service helpers. Dependencies were added only inside a second disposable image. No installed plugin, Ava profile, production record or host package was changed.

The actual Linux container ran as uid1000 with no network, private IPC, all capabilities dropped except `SYS_CHROOT`, and the official Playwright1.63 seccomp profile. No `--no-sandbox` option was used. A separate native `chrome://sandbox` preflight reported namespace, PID/network namespace and Seccomp-BPF protection enabled. This container configuration is proof infrastructure, not an instruction to weaken a user's host.

The final observer bytes passed eight real browser checks: exclusive startup, main/frame/cross-frame/navigation/popup closed RTC histories, the final pause boundary, and a concurrent unknown context. Two executable copied-source mutations each failed and then passed after exact restoration: ignoring recorded RTC history and replacing the final native FIFO flush with a snapshot read.

The final Runtime and observer bytes passed 13 real native phases through the companion's default bundled resolver. They include physical source exit before encrypted checkpoint durability, an inactive destination making zero site requests, HTTPOnly cookie/localStorage/rich IndexedDB restoration, saved-login extras publication once after an exact activation grant, and refusals for unfinished passwords, EventSource, prior RTC and pending worker requests. The coordinator, command lease and activation proof are injected fixtures; the extras store uses synthetic AES encryption. This is not yet the complete bin, Linux keyring, HOAI server and desktop lifecycle handover.

Six direct unit mutations printed changed executable lines, failed the relevant behavioral test, restored exact bytes and then passed. A seventh case restored the old `155.*` Runtime gate in a disposable native copy. It failed at Runtime constructor line308 with `profile_transport_qualification_required`; the restored exact source completed all 13 phases. The [machine-readable receipts](browser-profile-bundled153-proof.json) retain changed lines, native failures, restoration hashes and test results.

The six touched suites passed 96 tests with zero skips. Plugin `tsc --noEmit` passed. The exact observer list is a qualification boundary, not a promise that later browser patches are automatically safe.
