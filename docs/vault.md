# Agent vault: request and fill

Plugin 0.86.1 lets an agent use a login the owner saved in its HOAI agent vault,
without the password ever reaching the agent, the chat or this machine.

## Tools (owner turns only)

| Tool | Input | Returns |
|---|---|---|
| `vault_items` | `{q?}` | `{items:[{id,name,kind,labels,website,username,envName,reference,vaultAssistantId,revision}]}`, metadata only |
| `vault_request_login` | `{name, website, username?}` | `{requested:true, messageId}`; the owner gets the secure Add a login form |
| `vault_fill_prepare` | `{itemId, sessionId, tabId, origin}` | `{ticket, sessionId, tabId, origin, request:{intent, signature}, expiresIn}` |

Pass the `vault_fill_prepare` result unchanged to `hoai_vault_fill` on the HOAI
desktop browser. The desktop checks the pinned agent identity, the signed
intent, the item and its current revision, asks for its own OS unlock, fills
the current HTTPS tab under the owner's credential hold and returns a receipt.
The ticket is single use and expires in 60 seconds.

Every call goes to `/api/v1/vault/agent/<id>/...` with the pairing credential
(`X-BGOS-Pairing`) and a BGOS-A2A-V1 request signature over the exact body. A
turn admitted for anyone but the owner is refused before any request. Failures
are fixed `VAULT_*` codes that never echo a response body.

## Setting up the host: nothing to do (0.88.0)

Where the HOAI server takes host offers (`VAULT_ZERO_SETUP_ENABLED`), this
machine sets itself up. Nobody opens a terminal, pastes a key, compares a
fingerprint or types anything.

1. **Keys.** When the daemon arms, when HOAI sends `vault_host_setup`, and on a
   vault tool's first use, `lib/vault-host-auto.mjs` makes the host key (as in
   step 1 below) and this machine's OWN Ed25519 agent identity, both in the
   owner only file. No private key crosses the server.
2. **Offer.** It posts `{identityPublic, publicKey, keySignature}` to
   `/api/v1/vault/agent/<id>/host-offer` with the pairing credential only.
   `keySignature` is the host key proof of step 3 below.
3. **HOAI finishes it.** The owner's app verifies the proof, accepts the offer
   from the owner's own session and pins the key, in the background. The answer
   to the next offer reads `installed` and names the installed keys; this
   machine records its registration and pin only when they are its own.
4. **A changed key.** A new key on a machine the owner already set up answers
   `change_offered`. The owner sees "this computer changed" in HOAI and taps
   Use the new computer; until then the vault tools stay blocked and say so.

`hoai vault-host auto` shows the state from a command line (no terminal
needed). `HOAI_VAULT_AUTO_HOST=0` switches this off on a machine. A server
without the flag answers 404 to the first request: no key is made and the
older steps below are the way.

A key file another account could read is never used: it is removed, a fresh
key is made, and the owner sees a changed computer. A folder that cannot be
made private makes no key; HOAI tells the owner why with a fixed code. A file
is removed only when that is KNOWN: one whose protection could not be read (a
slow PowerShell), that another account owns, or that belongs to another agent
is left alone. One setup runs at a time on a machine (a lock file beside the
vault folder), so the daemon and a command never make two identities.

What this trades: the owner's app trusts the FIRST key it sees for an agent.
A server already hostile at that minute could substitute its own key and read
what is shared with this agent. Values stay end to end encrypted and a later
change is never trusted without the owner. HOAI's design note
(`docs/superpowers/specs/2026-11-12-vault-zero-setup-design.md`) says so in full.

## Setting up the host by hand: `hoai vault-host` (servers without zero setup)

Run it in a terminal on the agent machine, from the agent's folder. It refuses
to run without a terminal, because the fingerprint must not reach a pipe, a log
or chat.

1. **Host key.** On first use it creates an Ed25519 host key in
   `~/.bgos-agent/<id>/vault/vault-host.json`, a file only your user can read
   (mode 0600 in a 0700 folder; a looser file is refused, never used). The
   key's standard X25519 form is the host encryption key that HOAI wraps item
   keys to. On Windows, the folder and every key file must have a protected
   ACL owned by the current account, with no access granted to other accounts.
   Setup restricts and verifies an empty temporary file before writing keys;
   existing exposed folders or files are refused.
2. **Agent signing key.** HOAI only trusts an agent signing identity that the
   owner minted for this agent (`POST /api/v1/assistants/<id>/signing-key/rotate`,
   which returns the private key once). Paste it when asked; it is not echoed
   and is stored in the same owner-only file. `--new-signing-key` replaces it
   after a rotation, which also drops the old registration and pin.
3. **Registration.** It posts `{publicKey, signature}` to `.../host-key`, where
   the signature is the agent identity's Ed25519 signature over
   `["hoai-vault-host-key-v1", ownerId, assistantId, publicKey]`.
4. **Fingerprint and pin.** It shows the host fingerprint in this terminal
   only. In HOAI, compare it with the fingerprint shown for this agent and pin
   the host only if they match, then type `PINNED` here. Until then,
   `vault_fill_prepare` answers `VAULT_HOST_NOT_PINNED` without requesting a
   fill. Never compare through a chat message: the server can rewrite one.

`hoai vault-host status` shows the state and the fingerprint again.

Setup uses the daemon's credential resolver: `BGOS_CREDENTIALS_PATH`, the
configured assistant or folder pin, per-assistant credentials and the legacy
credentials file. Environment pairing takes precedence over file pairing.
The effective pairing supplies both the identity and backend. `--assistant`
selects an agent explicitly; a conflicting configured or paired identity is
refused.

If Windows reports `VAULT_HOST_KEY_EXPOSED`, open the vault folder and key
file's Properties > Security > Advanced in File Explorer. Set your account as
the owner, disable inheritance, and remove access for every other account.
Remove the exposed record and run `hoai vault-host` again to create a new host
key. If a signing key was exposed, rotate it in HOAI before provisioning it
again. Setup also refuses if Windows ACL inspection or protection fails.


## What this does not do

The local pin confirmation is a guard on this machine. The real checks are the
owner's pin in HOAI and the desktop's verification of every request. Using API
keys in commands (`vault_run`) and contacts are not part of this release.
