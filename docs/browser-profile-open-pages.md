# Moving open browser pages

A managed profile runs on one approved machine at a time. The person chooses
the machine in HOAI's Browser controls. Agent commands and encrypted checkpoint
transfers go through the HOAI server. Installing the plugin supplies the runtime
and setup instructions; it does not approve a machine or move another person's
profile automatically. Complete [companion setup](browser-profile-companion.md)
and public-key review first.

When the person chooses open pages, the checkpoint can include ordinary completed
GET pages in their current order and the selected tab. The destination opens new
documents at those exact URLs after HOAI confirms its authority. This is a new
page load. Live page memory, browser history, popup relationships, POST results,
unfinished sign-ins and unsaved form edits do not move. Saved data only remains
an explicit alternative. Do not work around a refusal by opening another profile
or rewriting the URL.

URLs with a query or fragment need the person's native review of their complete
exact values. That review permits only the checkpoint's one-time reopening. It
does not grant the agent standing permission to navigate, type, click or submit
anything. Known authentication callbacks and token URLs still refuse. A popup
must be finished or closed on its current machine before an ordinary-page move;
the checkpoint does not reproduce its opener relationship.

Cookies, supported localStorage and IndexedDB records, saved login entries and
search preference travel in an encrypted checkpoint between the exact approved
endpoints. Saved logins use the current machine's protected storage. The owner
still chooses Save in the native login interface. Session storage and device-bound
credentials do not become portable. A site can require another sign-in or second
factor on a different machine. Finish an ongoing sign-in where it started rather
than moving it midway or repeatedly retrying a callback.

The agent must report a refused move and retain the original session when HOAI
does so. A stopped source stays stopped while an uncertain upload or activation
is inspected. Do not resend a possible action, auto-restart a stopped browser or
treat a historical status response as fresh permission. A failed destination
navigation is not retried automatically. Existing recipient and site permissions
continue to apply after a successful move. Background access is not permission
to read passwords, type credentials, pay or bypass a site decision.

Encryption protects stored and transferred snapshots. The approved destination
machine must decrypt them to use the profile, so its operator remains trusted.
Revocation cannot recall secrets or cookies a previously approved machine already
received. Shared-agent recipients keep separate profiles and do not fall back to
the original sharer's browser. See [managed permissions](browser-profile-managed-permissions.md)
and [encrypted saved data](browser-profile-portable-extras.md).

Qualification evidence and its limits are recorded in
[the ordinary-tab receipt](proofs/browser-profile-agent-resume.md). Native popup
startup is separately under qualification; that receipt does not claim a working
popup session or full two-machine acceptance.
