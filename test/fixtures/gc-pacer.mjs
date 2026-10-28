// Preloaded into the daemon by test/win-commit-growth.soak.test.ts (BUN_OPTIONS
// --preload). A full collection every HOAI_SOAK_GC_MS (12 s): sparse enough that
// JavaScriptCore's helper threads go idle and exit between collections, which
// is what an idle daemon does on its own every so often, only faster. Unref'd,
// so it never holds the daemon open.
setInterval(() => Bun.gc(true), Number(process.env.HOAI_SOAK_GC_MS) || 12_000).unref()
