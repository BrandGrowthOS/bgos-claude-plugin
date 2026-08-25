# Directory marketplaces live at `installLocation`, and "latest" needs a `version` field or a semver `ref`

**Date:** 2026-08-25

**Context:** The E2E uses a throwaway marketplace added from a local directory (`claude plugin marketplace add E:\oneclick-e2e\marketplace`) whose plugin entry points at a local git clone (`file:///E:/oneclick-e2e/plugin-repo`, ref `e2e-next`). Two surprises while wiring the daemon's "is there a newer version" read.

**Gotcha / Pattern:**
- For a GitHub-source marketplace the CLI clones under `<config>/plugins/marketplaces/hoai/`; for a DIRECTORY source it copies NOTHING and records the directory itself as `known_marketplaces.json.hoai.installLocation`. A reader that assumes the fixed path reads no file and reports "not registered". `observeMarketplaceInstall` follows `installLocation` first and falls back to the fixed path only when the entry does not say.
- `readMarketplaceLatest` derives the latest version from the plugin entry's declared `version`, else from a semver-looking `ref` (`v0.38.4`). A bare branch ref (`e2e-next`) with no `version` reads as unknown, the heartbeat carries no `latestKnownVersion`, and the app shows "up to date" forever. The real marketplace pins `ref: v<semver>` so it works there; a test marketplace must declare `version` (or use a tag ref) to simulate a release.

**How to apply next time:** When simulating a release, bump BOTH the plugin's `package.json`/`plugin.json` at the target ref AND the marketplace entry's `version`, then trigger the daemon's refresh (boot + 30s, or a restart). And delete an old branch that shares a tag's name; `git rev-parse e2e-next` warns "ambiguous" and the CLI's checkout may pick either.

**Regression guard:** `test/plugin-cli.test.ts` (`observeMarketplaceInstall` reads `marketplace.json` from `installLocation`; `readMarketplaceLatest` prefers `version`, accepts a semver `ref`, returns null otherwise).
