# Browser close redaction only captures privacy context when it exists

**Date:** 2026-11-06

**Context:** Portable browser integration with the current plugin main branch.

**Gotcha / Pattern:** The host captures a result redactor before closing a browser. Its secret-pattern redactor also supports an engine without the page privacy layer, including the encrypted snapshot failure fixture. Unconditionally asking that engine for a private current tab throws before shutdown can report its storage failure. Capture a page and invoke its tab-overview and shown-address helpers only when the privacy layer exists. An engine without that layer retains its ordinary metadata path and the captured secret-pattern redactor, including secrets registered during the pending read and detached by close. A privacy-enabled engine still requires its real current-tab owner and keeps the original per-page filtering behavior.

**How to apply next time:** Keep secret-pattern redaction independent of page-privacy context. Do not add a fake private tab to the storage failure test or relax its shutdown and ciphertext assertions.

**Regression guard:** `test/agent-browser-vault.test.ts`, `failed final snapshot preserves the prior ciphertext, cleans up, and reports storage failure instead of saved success`. The unchanged test fails before this fix and passes after it. `test/browser-secret-redactor.test.ts` also requires a delayed title to remain redacted after a later secret registration and engine close. Shared round 13 to 18 Chromium cases continue to cover privacy-enabled engines.
