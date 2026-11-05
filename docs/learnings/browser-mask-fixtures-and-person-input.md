# Mask fixtures keep owner consent explicit

**Date:** 2026-11-06

**Context:** Integrating the legacy machine-private Chromium mask test with portable browser Person mode.

**Gotcha / Pattern:** A loaded fixture can already have a fail-closed Person hold before the test measures its populated secret fields. That hold has a different fixed sentence. The mask test now performs the actual owner Hand back action and asserts success and the cleared Person state before measuring the filled-secret wall. Every original secret-absence, exact private-copy, frame, search and last-net-disabled check remains. The filled fields must stay private after this owner consent too. The remote-credentials fixture now requires an exact whole-page private reply for snapshots and status instead of the old partial-tree `(masked)` marker. Every raw, escaped and encoded value-absence assertion and its no-save, refusal and one-use submit checks remain.

Tree reads still enter the backend's protected wrapper, where the sealed reader owns tree construction. A draft zero-wrapper-call assertion was not the contract and was not retained. The forced error case keeps the exact private response and also checks that the later masked value is absent.

**How to apply next time:** Separate owner/person control setup from the filled-secret invariant being measured. Use the real Hand back API with an asserted result, retain exact fixed responses and all value checks, and keep Person/reload transitions covered by their dedicated shared Chromium cases.

**Regression guard:** `test/browser-machine-private.chromium.test.ts`, `a masked field keeps its value out of every reply on the real engine: a plain line, a quoted line, a placeholder, a frame, and browser_find`; shared round 15 to 18 cases retain the Person and reload transition checks. `test/remote-credentials.chromium.test.ts` additionally checks the exact private snapshot and status shape after an actual owner credential fill. All nine machine-private Chromium tests passed after the fixture update.
