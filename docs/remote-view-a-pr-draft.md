# Show the agent browser in the HOAI pane

An owner can watch the browser that is already running on the agent machine. This change supplies the agent-host end of the read-only live view. It does not launch a browser for the viewer, change the agent's profile, or enable owner input.

`RemoteBrowserViews` attaches a CDP session to an existing `BrowserPool` page and sends bounded JPEG screencast frames. The existing `PairingConnection` carries view commands and frames through the HOAI server. The viewer never receives the browser's CDP endpoint or a direct connection to the agent machine. No peer-to-peer path exists.

The HOAI backend authenticates the owner, checks assistant ownership and placement, and binds each view to the exact registered pairing socket. The host independently checks that pairing's assistant roster, the explicit person principal, and stable browser and page identities. Only one viewer owns a slot at a time. A disconnect, replaced viewer, closed page, or changed engine revokes the view. Closing a view detaches its display session and keeps the agent browser alive.

Only display start, display stop, and paint acknowledgements are admitted. Display commands are serialized. A paint acknowledgement bypasses the command queue to release the one frame the owner is painting. Oversized frames are dropped and acknowledged locally. Raw CDP input, scripts, cookies, and storage commands are refused.

## Validation

- `node --import tsx --test test/hoai-browser-host.test.ts test/remote-view.test.ts test/remote-view.chromium.test.ts`: 38 passed on kc-server with its installed Chrome. The fixture uses synthetic assistant 901 and principal user-fixture in a task-owned temporary directory.
- `node node_modules/typescript/bin/tsc --noEmit`: clean.
- Real Chromium test receives at least two different frame hashes through `BrowserPool`, `ChromiumEngine`, and `RemoteBrowserViews`.
- Desktop companion proof shows the actual HOAI pane changing from counter 276 to 360 while the browser process runs on kc-server. The fixture page is remote loopback only, and the frames pass through the disposable HOAI backend.
- Mutation: changed the executing stream publication line to `const sent = false && this._send(view, { method: 'Page.screencastFrame', params: frame,`. The changing-frame and acknowledgement tests failed. Restored publication and the touched tests passed.

The test fixture refuses production backend addresses and production-style pairing credentials. One explicit test Tailscale host can reach the disposable HOAI backend proxy when SSH port forwarding is unavailable. Production database records, daemon state, configuration, and installed plugin checkouts were not changed.

## Companion and rollout

This is the agent-host companion to the HOAI backend and desktop read-only view change. It can ship without owner input. The owner-input feature and daemon placement default are separate changes and separate commits. No branch was pushed or merged.
