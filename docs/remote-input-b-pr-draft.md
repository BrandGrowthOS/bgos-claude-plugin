# Control the remote agent browser from the HOAI pane

This separately reviewable change adds owner pointer and keyboard input to the live remote view delivered by commits e49c210 and 3e6e8fc. Input goes from the desktop to the HOAI server and then to the authenticated agent host. There is no direct desktop-to-agent connection, no peer-to-peer transport, and no exposed browser debugging endpoint.

Taking control reserves an exclusive lease on the existing browser slot before waiting for running agent tools to settle. Newly scheduled agent tools and actions held by permission gates recheck that lease before executing. Releasing control, hiding the pane, losing focus, navigating the remote page, disconnecting, or reaching the inactivity limit revokes owner input. An owner command already sent retains the agent block until that physical command settles. Named keys always receive keyup cleanup. Pressed pointer buttons are released at their last coordinates, and the agent remains blocked until that cleanup settles.

The desktop obtains a short-lived, single-use focus token before sending a character. The host binds that token to the actual focused DOM element, checks that element again immediately before dispatch, and rejects expired, replaced, noneditable, credential, and opaque iframe targets. Pointer changes invalidate the preceding focus token. The host supports a narrow pointer protocol and a single character or named navigation key, not arbitrary CDP, scripts, modifiers, clipboard paste, or cookies.

## Password and credential decision

Owner keystrokes cross the HOAI relay and reach another machine. This is not end-to-end encryption: the HOAI server and agent host process can observe ordinary text accepted by this feature. The browser can retain entered data according to the page and its persistent profile. Input payloads are not deliberately logged or persisted by this implementation.

B refuses identified credential fields until KC explicitly decides otherwise. This includes password inputs, username/password/one-time-code/card autocomplete fields, credential names and labels, text fields belonging to a form containing a password input, file inputs, and opaque iframe focus. The desktop refuses to send text when the host reports a blocked focus; the host rechecks before browser dispatch.

Field inspection is a conservative guard, not proof that arbitrary user text is non-secret. An ordinary text field can still receive a password typed as ordinary text, and a hostile page can mislabel a field or change it after the focus check. Users should not type secrets through remote control. Supporting credential entry requires a separate explicit product and security decision, not relaxing this guard silently.

## Validation

- Targeted unit tests cover lease reservation and physical drain, gate action rechecks, focus token reuse and expiry, credential changes between probe and key dispatch, pointer invalidation, and release during in-flight owner input.
- A real Chromium test types `K` through the actual remote-view command path, verifies the remote input value, rejects a field changed to password after a focus token, rejects OTP and iframe focus, and observes navigation revoke the lease.
- All 50 tests in the five touched browser-host, view, and input test files pass on kc-server. `tsc --noEmit` is clean.
- Executable mutation replaced `await cdp.send('Input.insertText', { text: key })` with a resolved promise. The typing test failed with no dispatched key. The original line was restored and the targeted tests passed.
- The native desktop pane typed `hoai relay proof`; an independent read-only SSH GET of the remote fixture confirmed that text on kc-server, with passwordLength 0. Pane screenshots and credential-refusal evidence are in the parent HOAI review report.

A delegated review found and verified fixes for stale final display frames, named-key cleanup during view closure, and missing pressed-button masks during drag. A further regression test pins that a cleanup failure blocks its affected browser until successful shutdown, then allows a fresh browser to recover.

The verification fixture uses synthetic assistant 901 on kc-server with a task-owned temporary browser profile and disposable HOAI backend. It does not use Ava's live records, production database writes, production configuration changes, or a live daemon browser session.
