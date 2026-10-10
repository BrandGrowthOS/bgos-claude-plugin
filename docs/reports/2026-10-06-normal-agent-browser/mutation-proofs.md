# Executable mutation proofs

Each mutation changed a runtime executable line, ran the named focused test to failure, then restored the original file bytes in finally. Printed line numbers refer to the source at the time of that mutation. The final restored source passed all 122 tests and tsc. Fixture value comparisons and connection details are omitted.

## background-roster-refresh-red

Printed executable line:

```javascript
EXECUTABLE_MUTATION background-roster-refresh lib/remote-view.mjs:164 _scheduleState(view) { return
```

Failing test: owner normal browser creates, switches and closes real agent tabs and navigates history under its lease (6001.0621ms)

Result: EXIT=1. Restored before the final green run.

## browser-url-authority-red

Printed executable line:

```javascript
EXECUTABLE_MUTATION browser-url-authority lib/remote-view.mjs:26 return redact(url.href).slice(0, 4096)
```

Failing test: owner normal browser creates, switches and closes real agent tabs and navigates history under its lease (2377.5413ms)

Result: EXIT=1. Restored before the final green run.

## capability-negotiation-red

Printed executable line:

```javascript
lib\remote-view.mjs:54:    const remoteBrowser = true
```

Failing test: ownerless agent tabs respect the same cap before a viewer attaches and legacy views keep their old wire (2108.6794ms)

Result: EXIT=1. Restored before the final green run.

## expected-tab-target-red

Printed executable line:

```javascript
EXECUTABLE_MUTATION expected-tab-target lib/remote-view.mjs:232 if (false && params.action !== 'new' && (!identifier(params.targetTabId) || this._tabId(view, pages[params.index]) !== params.targetTabId)) throw viewError('stale_target')
```

Failing test: owner normal browser creates, switches and closes real agent tabs and navigates history under its lease (2854.3312ms)

Result: EXIT=1. Restored before the final green run.

## explicit-login-save-red

Printed executable line:

```javascript
EXECUTABLE_MUTATION explicit-login-save lib/remote-credentials.mjs:374 if (false && save) {
```

Failing test: real sign-in with unrelated iframe, signup footer and alternative Email OTP fills and saves encrypted login (1929.9484ms)

Result: EXIT=1. Restored before the final green run.

## js-login-form-red

Printed executable line:

```javascript
EXECUTABLE_MUTATION js-login-form lib/remote-credentials.mjs:115 const password = passwords[0], form = password.form; if (!form) return refused()
```

Failing test: JavaScript and password-only login pages keep exact capture checks and permit explicit login save (1753.9403ms)

Result: EXIT=1. Restored before the final green run.

## lease-expiry-cause-red

Printed executable line:

```javascript
lib\remote-input.mjs:115:    lease.timer = setTimeout(() => this.release(lease.view, undefined, 'released'), this.leaseMs)
```

Failing test: negotiated input revocation names expiry and navigation while legacy viewers receive empty params (36.3628ms)

Result: EXIT=1. Restored before the final green run.

## login-baseline-red

Printed executable line:

```javascript
Executable baseline guard at line 47: if (document.querySelector('iframe, frame')) return refused()
```

Failing test: real sign-in with unrelated iframe, signup footer and alternative Email OTP fills and saves encrypted login (1677.7844ms)

Result: Baseline: one failing test, zero passing tests; credential_changed. Restored before the final green run.

## manual-login-save-red

Printed executable line:

```javascript
EXECUTABLE_MUTATION manual-login-save lib/remote-credentials.mjs:317 await Promise.resolve({ origin: lease.origin, username: body.username, password: body.password })
```

Failing test: native sealed field entry works while locked and manual Save login works without a form (2089.1863ms)

Result: EXIT=1. Restored before the final green run.

## native-field-fill-red

Printed executable line:

```javascript
EXECUTABLE_MUTATION native-field-fill lib/remote-credentials.mjs:307 await this._document(lease, 'check', { value: body.value })
```

Failing test: native sealed field entry works while locked and manual Save login works without a form (1775.9023ms)

Result: EXIT=1. Restored before the final green run.

## native-fresh-setup-red

Printed executable line:

```javascript
EXECUTABLE_MUTATION native-fresh-setup lib/remote-credentials.mjs:299 if (false && !lease.configured && typeof lease.storage.retainCurrent === 'function') await lease.storage.retainCurrent(view.page.context())
```

Failing test: first native storage setup keeps the current completed sign-in and restores it encrypted after restart (1877.0699ms)

Result: EXIT=1. Restored before the final green run.

## owner-click-loading-red

Printed executable line:

```javascript
lib\remote-view.mjs:175:    view.onLoadingStart = event => { if (current(event)) { waitingForCommit = true; view.loadingRevision = (view.loadingRevision || 0) + 1; view.loading = false; this._scheduleState(view) } }
lib\remote-view.mjs:179:    view.onLoadingEnd = event => { if (current(event) && !waitingForCommit && event.loaderId === loaderId && event.name === 'load') { view.loading = false; this._scheduleState(view) } }
```

Failing test: slow headers, slow documents and owner-clicked links accept Stop without blocking the remote stream (4839.9846ms)

Result: EXIT=1. Restored before the final green run.

## ownerless-tab-cap-red

Printed executable line:

```javascript
bin\hoai-browser-host.mjs:999:    if (false && name === 'browser_tabs' && args?.action === 'new' && this.pages().length >= REMOTE_BROWSER_TAB_MAX) throw new HostError('browser_tabs_full', 'The browser has reached its tab limit.')
```

Failing test: ownerless agent tabs respect the same cap before a viewer attaches and legacy views keep their old wire (2291.3148ms)

Result: EXIT=1. Restored before the final green run.

## pending-capture-retarget-red

Printed executable line:

```javascript
lib\remote-view.mjs:399:        view.capturing = false
```

Failing test: negotiated capture intent survives active target close while an old start promise is pending (1005.7989ms)

Result: EXIT=1. Restored before the final green run.

## physical-fragment-baseline-red

Printed executable line:

```javascript
lib\remote-view.mjs:175:    view.onLoadingStart = event => { if (current(event)) { waitingForCommit = true; view.loadingRevision = (view.loadingRevision || 0) + 1; view.loading = true; this._scheduleState(view) } }
```

Failing test: slow headers, slow documents and owner-clicked links accept Stop without blocking the remote stream (4992.8277ms)

Result: EXIT=1. Restored before the final green run.

## physical-fragment-loading-red

Printed executable line:

```javascript
lib\remote-view.mjs:191:    cdp.on('Page.navigatedWithinDocument', () => {})
```

Failing test: slow headers, slow documents and owner-clicked links accept Stop without blocking the remote stream (4945.9003ms)

Result: EXIT=1. Restored before the final green run.

## prompt-navigation-dispatch-red

Printed executable line:

```javascript
lib\remote-view.mjs:304:    await pending
```

Failing test: slow headers, slow documents and owner-clicked links accept Stop without blocking the remote stream (13831.0132ms)

Result: EXIT=1. Restored before the final green run.

## same-document-loading-red

Printed executable line:

```javascript
lib\remote-view.mjs:311:      if (false && complete) view.loading = false
```

Failing test: slow headers, slow documents and owner-clicked links accept Stop without blocking the remote stream (4857.6638ms)

Result: EXIT=1. Restored before the final green run.

## signup-footer-red

Printed executable line:

```javascript
EXECUTABLE_MUTATION signup-footer lib/remote-credentials.mjs:116 if (!safeForm(form) || form && /sign[ -]?up|register|create.{0,20}account/i.test([form.id, form.name, form.getAttribute('aria-label'), form.textContent].join(' '))) return refused()
```

Failing test: real sign-in with unrelated iframe, signup footer and alternative Email OTP fills and saves encrypted login (1914.0564ms)

Result: EXIT=1. Restored before the final green run.

## tabs-command-red

Printed executable line:

```javascript
EXECUTABLE_MUTATION tabs-command lib/remote-view.mjs:10 const BROWSER_METHODS = new Set(['hoai.browser.navigate', 'hoai.browser.navigation'])
```

Failing test: owner normal browser creates, switches and closes real agent tabs and navigates history under its lease (1598.6419ms)

Result: EXIT=1. Restored before the final green run.
