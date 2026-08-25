# A marketplace install's cache dir is a git clone, so the clone-path updater must never run on it

**Date:** 2026-08-25

**Context:** First real end-to-end of the marketplace update path on Windows. The disposable agent's boot log said `marketplace latest-version refresh armed` and, two lines later, `Auto-update skipped because the checkout has local changes.` The second line comes from the CLONE-install git self-updater (`lib/self-update.ts`), which had no install-method gate.

**Gotcha / Pattern:** Claude Code installs a `url`/git-source plugin by cloning the repo into `<config>/plugins/cache/hoai/hoai/<version>/` and leaves `.git` in place, checked out at the release tag. The real hoai marketplace entry is `{source:'url', url:'https://github.com/BrandGrowthOS/bgos-claude-plugin.git', ref:'v0.38.3'}`, so every marketplace install on the fleet is a detached-HEAD clone of the plugin repo with `origin/main` reachable. `BGOS_AUTO_UPDATE` defaults ON. The git updater's daily check would fetch `origin/main`, see a newer `package.json` version, fast-forward Claude Code's cache dir behind its bookkeeping (files at one version, `installed_plugins.json` at another), restart the daemon, and on a failed health window roll it back with `git checkout`. In the E2E it only "skipped" because hand-copied files made the clone dirty. Pre-existing on `main`; inside P1's "keep git for clones" scope.

**How to apply next time:** Decide the update authority once, by install method, at boot: marketplace installs update only through `claude plugin update` (the marketplace path in `lib/update-rpc.ts` + `lib/marketplace-update.mjs`); the git self-updater is constructed only for clones. Anything that reads `selfUpdater` must tolerate `null` (it already did). When a directory "looks like a clone", ask who owns it before running git in it.

**Regression guard:** `test/self-update.test.ts` static guard `server.ts never arms the git self-updater on a marketplace install (its root is Claude Code's cache clone)`; boot log line `git self-updater not armed: marketplace install` observed in the E2E.
