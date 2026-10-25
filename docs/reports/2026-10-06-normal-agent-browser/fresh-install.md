# Fresh shipping-plugin installation check

Passed on 2026-10-06T08:24:17.601Z with Node v24.16.0 on Windows. Package and plugin manifest version: 0.61.4. The checked source was frozen commit `fd03a09aa50d6d24cd7a366aa607c5f3dce5b0bb`.

The existing shipping smoke was run from a temporary `git archive` of that commit, so its generated reports did not modify the source branch. It created a local npm package, extracted it, and installed fresh dependencies with an empty npm user cache. It used isolated HOME, USERPROFILE, LOCALAPPDATA and installed-browser search roots. The browser cache started absent. The packaged production browser-host supervisor connected to a disposable synthetic local relay. No executable override, browser wrapper, preinstalled machine Chrome or manual browser install supplied this proof.

First browser use automatically downloaded the plugin's pinned Chromium and opened its fixture page in 57,632 ms. The actual credential prepare route advertised remote credentials and returned `configured=false`, `unlocked=false`, `legacy=false`. A fixture session cookie was present before closing the locked browser and absent after reopening. A fresh supervisor process also reopened that protected profile successfully. No sandbox-disabling flags were used, and no fixture Chromium processes remained after cleanup.

The packaged artifact included all 14 checked shipping files, each byte-identical to the frozen candidate: the browser skill, README, changelog, package and plugin manifests, bootstrap, supervisor, host, remote view/input/credentials/crypto, vault and redactor. Their SHA256 values are in [fresh-install.json](fresh-install.json). The package archive SHA256 is `05f180c7a4e6d1a532a124383b9779adbd75171d92256e2dc057861bcc7fbed6`.

Reproduce from a disposable archive of the source candidate with its development dependencies available:

```powershell
node --import tsx test/helpers/packaged-browser-bootstrap-smoke.ts
```

The same packaged skill tells every fresh agent to use the shipped hoai-browser MCP tools and explains automatic browser provisioning, owner controls, protected-field entry, explicit saved-login consent, encrypted storage and restart unlock. Its Linux dependency instructions inspect prerequisites using the pinned CLI, require owner or administrator approval for privileged packages, retain Chromium's sandbox, and keep traffic on HOAI. The fresh package includes those instructions without a machine-specific manual installation step.

This verifies the fresh Windows dependency, packaging, provisioning and normal supervisor path. It does not claim a fresh Linux operating-system install, automatic installation of missing Linux system libraries, native desktop visual behavior or a remote Linux live-pane recording. Those are distinct checks in the companion HOAI evidence. The encrypted cookie, localStorage, IndexedDB and saved-login restart checks passed separately in the 122-test focused run.

The sanitized JSON omits temporary paths, process command lines, tokens, cookies, credential values and connection transcripts. No production records or live accounts were used.
