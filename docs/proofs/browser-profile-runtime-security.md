# Agent browser runtime security qualification

Snapshot: 2026-10-15. This changes the shipped Playwright pin to 1.64.1 and its bundled Chromium to exactly 156.0.8078.4, revision 1248. Retired 153 and 155 versions now refuse managed profile qualification. The exact bundle hash protects the private native target-session and isolated field adapters. No browser engine or bridge seam changes.

The source baseline is committed 38ad8c17ab825934c9e0c836e8e819010e78fa79 with the 24 explicit overlays listed in the [receipt](browser-profile-runtime-security.json). Its private fresh Bun workspace has its own node_modules; resolution does not rely on NODE_PATH. The plugin worktree's separate, nonjunction npm graph was also updated after bin ownership release. No installed plugin, Ava, main dependency junction, system Node, host trust or production configuration changed.

## Why these versions

[Playwright 1.64.0](https://github.com/microsoft/playwright/releases/tag/v1.64.0) ships Chromium 156 and enables page-defined WebMCP tools in its MCP backend by default. The shipped host now explicitly sets the supported `webmcp:false` configuration. The [1.64.1 patch](https://github.com/microsoft/playwright/releases/tag/v1.64.1) fixes first-window Electron launch and routed cross-origin redirect regressions. The version is frozen for this audit rather than repeatedly following a moving latest release.

[Node's release inventory](https://nodejs.org/en/about/previous-releases) marks 18 and 20 EOL and 22/24 LTS at this snapshot. Package metadata and the doctor now require the compatibility floor 22.12.0 and recommend a current patched 22 or 24 LTS release. A pure minimum helper runs at loadPlaywright before its cached fast path or any Playwright require. This also protects imported PlaywrightEngine and the Codex/default Companion lazy browser path. Watcher discovery and service resolution are unchanged. Importing the host remains side effect free.

The private CRSession comparison retained the original canonical connection, child-session ownership, send and disposal seam; 1.64 adds explicit child disposal and ignores late crash replies. Native field probes requalify the actual utility context and snapshot-ref adapter against the new bundle. The actual new roster contains browser_emulate_media and a named isolatedContext tab option. Recipient-scoped signed requests for those unsupported write actions cannot acquire a permission or reach the engine.

## Evidence

- Fresh frozen-lock Bun install; 24 touched or directly affected test files, 438 tests green, no skips; TypeScript noEmit exit 0. Root independently reran four security/Node/permission/doctor suites: 144 green, no skips.
- The independent npm-installed graph passes nine focused files, 234 tests, with no skips. Older-version refusal tests inject process version values in isolated child processes; they do not install or run EOL Node binaries. Actual positive hosts are Windows Node 24.16.0 and Linux Node 22.23.3.
- Actual Linux Node 22.23.3, nonroot uid 1000, Chromium sandbox enabled, private debugging pipe and no public CDP port. The binary reports Google Chrome for Testing 156.0.8078.4; its SHA-256 is 377a9fc07b495c3b8d0ab8ec1fdfd153641759f9756fea34d8dfce4de82f5025.
- Seven native probes: 8 RTC, 13 runtime including popup first-request coverage, 8 cookies, 6 tab restore, 14 isolated fields, 2 WebMCP, 5 readonly live backup. Every container was positively absent afterward, with no forced stop. Individual receipts retain their own native cleanup claims.
- The WebMCP positive control registers and invokes a real tool through document.modelContext. The actual shipped configuration then exposes no dynamic tool, omits it from the served roster, refuses invocation, leaves the canary unchanged and creates no extra page. All original and later browser group members are gone afterward.
- A separate image overlays only the independently reviewed download manager and probe hashes. Actual 156 normal, slow and overflow cases pass. Each has private 0700 storage, one engine download event, empty or removed raw storage, zero physical work and all original/later browser group members gone. Normal 7936-byte content matches its hash; unfinished and oversized files are not accepted. The probe uses 150 ms/10 s deadlines and 5 ms observation; production 120 s/100 ms and the single 2 s cancellation grace are source/unit qualifications.
- npm production and full-graph audits report zero advisories. The independent fresh Bun graph audit also reports none. These audits describe package advisories, not browser-CVE absence.

## Mutation proof

Every mutation affects an executable line in a disposable copy. The JSON receipt retains the printed line, red log hash, exact restoration and green result.

1. Remove the shared Node call: older-runtime lazy, imported-engine and cached paths turn red.
2. Lower the pure major floor to 18: old Node acceptance turns red.
3. Report every found Node as healthy: the doctor's old/malformed version regression turns red.
4. Set WebMCP true: both the real configuration unit check and the native page-tool exclusion turn red. Native restoration returns two green cases and positive process-group cleanup.
5. Reallow 153: exact current-version and retired-version refusals turn red.
6. Omit the launch bundle-hash comparison: changed native bundle bytes are wrongly accepted and the regression turns red.
7. Loosen the dependency to a caret range: the shipped exact dependency/lock qualification turns red.
8. Replace the native field bundle digest with 64 `f` characters: normal real field preparation refuses with profile_field_native_unqualified. Exact restoration returns 14 green cases. A read-only PID/start observer proves all 11 sampled browser processes are gone in both runs.

## Limits and follow-up

These are standalone native/runtime qualifications with synthetic authority and explicit fixture actions. They do not claim physical human approval, real account login, final 43/156 HOAI composition, cross-machine file consent or automatic 60 s agent backup. The seven-probe image uses the exact 38ad baseline and security overlays; the download run adds only its two named reviewed files. Later policy wording and Companion backup hooks belong to separate frozen revisions and need their own integrated proof.

The earlier selection fixture used an empty backend config and an old 28-tool roster assertion. Tests now use the actual shipped configuration and the upgraded 29-tool roster; the final 438-test run is green. One initial native field drill harness demanded an AssertionError for an intended admission refusal. Only its later red/restored run with independent positive PID/start sampling is used here.

Chromium 156 is Playwright's pinned testing build. A newer major number and clean JavaScript dependency audits do not prove that every Chromium CVE is absent or every stable-channel backport is present. Keep the browser and adapter pins together and requalify them when updating. Historical 153/155 and Electron 40 receipts remain historical.

The receipt lists exact source, private image, resolver, executable, raw evidence and mutation hashes. The new WebMCP probe is runnable on a disposable supported Linux environment with the bundled browser and sandbox prerequisites using node scripts/probe-browser-profile-webmcp.mjs. Its synthetic loopback website does not require an external account.
