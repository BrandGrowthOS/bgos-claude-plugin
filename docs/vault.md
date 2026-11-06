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

## Setting up the host: `hoai vault-host`

Run it in a terminal on the agent machine, from the agent's folder. It refuses
to run without a terminal, because the fingerprint must not reach a pipe, a log
or chat.

1. **Host key.** On first use it creates an Ed25519 host key in
   `~/.bgos-agent/<id>/vault/vault-host.json`, a file only your user can read
   (mode 0600 in a 0700 folder; a looser file is refused, never used). The
   key's standard X25519 form is the host encryption key that HOAI wraps item
   keys to.
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

## What this does not do

The local pin confirmation is a guard on this machine. The real checks are the
owner's pin in HOAI and the desktop's verification of every request. Using API
keys in commands (`vault_run`) and contacts are not part of this release.
