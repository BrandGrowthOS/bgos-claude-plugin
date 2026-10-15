# Agent profile companion

The plugin ships the managed companion and its setup instructions. The daemon's existing browser host starts it for the current pairing. Its setup and browser traffic use the configured HOAI server only. There is no direct desktop-to-agent browser connection.

Installation does not enroll a device, create a person's profile, grant background access or acquire a writer. In HOAI, the person opens Browser > Devices and requests this agent machine. The host generates separate endpoint keys for that exact person, agent and profile. The full public fingerprint appears on the agent machine for independent comparison with the native HOAI review. Acceptance and background consent are separate decisions. A new runtime remains blocked until the person separately confirms its exact session request.

Supported agent storage requires Linux with an unlocked persistent Secret Service collection. See [encrypted login storage](browser-profile-portable-extras.md). Missing helpers, a locked keyring, an unsupported browser version or a stale private write marker are setup or recovery requirements. Do not save plaintext keys, steal a lock, attach to a legacy Chrome profile or silently select another person's browser.

The default managed browser comes from the plugin's pinned Playwright revision and runs sandboxed. An explicit executable override must pass the same exact native qualification. Arbitrary browser versions, active transport histories, uncommitted site drafts and unfinished login are not promised portable. Cookies and supported website state move as encrypted checkpoints. The actual page, network request and JavaScript process do not teleport.

## Review the source machine

A foreign checkpoint requires a locally reviewed source key. A source identity supplied by HOAI metadata alone cannot create that trust. HOAI exports public JSON with these exact fields:

```text
version, kind=agent-peer-pin-review, profileId, actingUserId, assistantId,
agentEndpointId, agentKeyFingerprint,
peerIdentity={version,endpointId,signingPublicKey,encryptionPublicKey},
peerKeyFingerprint
```

The machine operator independently compares the full `peerKeyFingerprint` with the native source machine, then runs:

```bash
node bin/hoai-browser-host.mjs --review-profile-peer /absolute/path/public-peer-review.json --confirm-fingerprint <full-64-character-fingerprint>
```

The command freshly reloads the exact own enrollment through OS-protected storage and verifies current background consent before signing a private local public-pin record. It refuses unknown fields, mismatched recipients, stale own keys and substitutions. Up to four source pins are immutable. Replacing a pin is not automatic. This is explicit operator setup, not an agent instruction to trust a website, a grant of site permission or an extra network transport. The review JSON and fingerprint are public. No password, token or private key belongs in the command.

## Runtime boundaries

The browser location and its controller are separate. The companion accepts typed command hints only for its exact active runtime. It fetches the stored command from HOAI under a signed possession proof before executing it, and posts signed results directly to HOAI. A hint body cannot authorize a command or cancellation. Current recipient-scoped site permission is still required; an unavailable permission refuses the action.

For a desktop transfer, the agent prepares an inactive destination, confirms the expected source against its local reviewed pin, imports the unchanged signed capsule without network access, then writes and reads back an encrypted staged journal before acknowledging staging. A separate fresh server writer epoch must name the exact destination before network access opens. Historical readiness confirmation alone is not activation.

Normal stop checks physical work and sign-in state first. A refusal preserves the live browser. Successful stop destroys the owned native process, seals a local encrypted journal, verifies its readback and then commits to HOAI. An uncertain write is never automatically replayed. Unattended same-endpoint restart requires a verified committed agent retirement, current consent, new boot/runtime/session identities, inactive import and a fresh server CAS. An old active boot is recovery required.

Temporary connectivity loss pauses new agent commands while keeping the page in memory. A verified current revocation physically disposes the local runtime. Neither event creates a saved receipt or authorizes another writer. Explicit daemon termination is a different boundary: failed preservation must be reported as recovery required, with previous encrypted state retained and no saved-state claim.

After an explicit End session in the same daemon process, the companion remains closed. A later agent open needs a fresh explicit recipient-scoped open intent; it is not implemented by silently reopening the stopped profile. A supported action needing permission stays bound to its one original signed request. The recipient opens Agent machine in HOAI to review the pending action. The agent waits at most the original permission lifetime and never sends the request to the agent's sharer. See [managed runtime permissions](browser-profile-managed-permissions.md).

The form guard compares native reset defaults in an inert document before and after script pause. It returns only booleans and preserves the original page when a check refuses. It conservatively refuses nonempty contenteditable documents and changed form fields, including a website-saved value whose DOM default was not updated. Reload can establish a baseline for website-saved state. Arbitrary application variables, canvas state and active page memory are not portable.

The native observer admits only qualified Chromium `156.0.8078.4`, supplied by pinned Playwright `1.64.1`. Retired browser versions and unknown patches refuse. The [runtime security proof](proofs/browser-profile-runtime-security.md) covers the exact bundled resolver, native RTC history, Runtime checkpoint primitives and page-tool exclusion. The standalone probes do not by themselves prove the complete companion, Linux keyring, HOAI HTTP, browser host and human handover composition. That composition must be tested separately before claiming delivery.

The approved machine operator and OS account can inspect plaintext while the profile is in use. Encryption protects saved files and relay payloads; it cannot recall data already received by an approved machine.
