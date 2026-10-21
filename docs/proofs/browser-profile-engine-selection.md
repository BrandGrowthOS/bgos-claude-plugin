# Exact restored page selection

The first two-machine schema2 trials reached a running Chromium and restored pages, then failed before the runtime socket proof. An excluded observer-only Codex wrapper narrowed this to `PlaywrightEngine.selectPage`. The actual pinned MCP `BrowserBackend.initialize` constructs a lazy context with an empty tab list. Its `ensureBrowserContext` wraps the existing native pages and subscribes to new ones; it does not create a replacement page.

`selectPage` now awaits that initialization, finds the exact supplied native page, selects it, and checks managed authority and backend continuity around asynchronous work. A foreign page, revoked authority, replaced backend, or different selected page refuses. This adds no page creation, URL load, retry, or permission grant.

Seven new cases use the actual pinned MCP BrowserBackend and Context, with EventEmitter page fixtures. Together with the six touched host cases, 13 pass with no skips. TypeScript `--noEmit` exits0. Seven copied-module executable mutations each print the changed line, fail an assertion, restore exact bytes, and pass. The attached JSON records them.

The real nonroot, sandboxed Chromium153 probe captures and restores three ordered schema2 pages, then starts the actual MCP engine and selects the exact restored page without a new page or HTTP request. Baseline exits0. Replacing line1071 `await context.ensureBrowserContext()` with `void context` exits1 with `Browser tab is unavailable`; exact restoration exits0. Both runtimes are physically gone and the fixture HTTP server is closed in all three runs. Docker confirms the containing test container is absent without forced stop after the matrix.

The native probe uses synthetic coordinator, CAS and review proofs. Its image overlays the recorded working-copy bytes on immutable8a33. The final committed archive and full two-machine HOAI roundtrip require their own qualification. The two failed observer-wrapper runs and the earlier full-roundtrip failure are diagnostics, not acceptance.

Raw private receipts: `.tmp/engine-selection-drills-5335a76c/report.json` and `.tmp/fresh-plugin-proof/engine-selection-99f1f45b.json`. Durable receipt: `browser-profile-engine-selection.json`.
