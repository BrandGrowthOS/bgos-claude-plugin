# Packaged browser bootstrap smoke

Passed on 2026-10-04T17:25:12.547Z with Node v24.16.0 on Windows. Package and plugin manifest version: 0.60.5.

Reproduce from the plugin worktree with:

```powershell
node --import tsx test/helpers/packaged-browser-bootstrap-smoke.ts
```

The smoke creates npm pack, extracts it, and installs fresh dependencies with an empty npm user cache. It uses an isolated HOME, USERPROFILE, LOCALAPPDATA and installed-browser search roots. The browser cache starts absent. The packaged production startBrowserHostSupervisor connects the actual host to a synthetic local relay. No executable override, browser wrapper or manual browser install is used.

First browser use downloaded pinned Chromium and opened the page in 22396 ms. The actual credential prepare route returned configured=false, unlocked=false, legacy=false. A session cookie was present before closing the locked browser and absent after reopening. A new supervisor process also reopened the same protected profile successfully. Chromium ran with no sandbox-disabling flags, and no fixture Chromium process remained after cleanup.

All 8 required skill and runtime files are included and match the final worktree byte for byte. SHA256 values, process command lines and storage results are in [packaged-bootstrap-evidence.json](packaged-bootstrap-evidence.json). The archive hash and retained disposable install are in [packaged-bootstrap-run.json](packaged-bootstrap-run.json).

This verifies Windows packaging and the normal supervisor/bootstrap path with a disposable local relay. Native owner-dialog, encrypted restart-state and remote Linux proof are separate checks. No production records were used.
