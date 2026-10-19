# Agent browser login storage

The managed browser's portable login and search preference store is separate from the legacy browser partition and passphrase vault. Only an approved profile may use it. An accepted device offer alone does not permit saved browser data to be shared.

## Linux setup

The privileged host requires the fixed executables `/usr/bin/gdbus` and `/usr/bin/secret-tool`, a local Unix session bus, and a configured secure persistent Secret Service collection. The default collection must be unlocked. The helper refuses the temporary session collection. Missing software or service returns setup required; a locked collection returns unlock required. The plugin does not install system packages, unlock a user's keyring, or save an unlock passphrase.

Use the operating system's supported keyring setup and unlock flow. A fresh headless service needs an explicit operator decision about secure keyring provisioning and unlock. Do not place its passphrase in command arguments, environment variables, chat, or a plaintext file. Until secure provisioning is complete, report setup or manual unlock required. Do not announce unattended restart support or fall back to a plaintext key, legacy vault, or Chromium profile.

Secret Service defines a D-Bus interface, not a guarantee about an implementation's disk encryption. The configured provider and machine operator remain trusted. The isolated qualification uses GNOME Keyring 48 with a nonempty synthetic unlock passphrase and verifies persistence across actual daemon restarts. It does not provision the installed agent's service. See the [Secret Service specification](https://specifications.freedesktop.org/secret-service/latest/) and [GNOME Keyring 48 daemon manual](https://github.com/GNOME/gnome-keyring/blob/48.0/docs/gnome-keyring-daemon.xml).

The companion provider currently supports Linux. Other platforms report manual unlock required. This does not describe the separate desktop application's native OS key storage support.

## Host integration contract

`BrowserProfilePortableExtrasStore.preload` must finish before admitting a browser runtime. Supply an independently verified current actor, assistant, profile, endpoint identity, grant generation, content-key epoch and background-use permission, plus a synchronous current-scope check. Saved bindings are authenticated context, never authority. Loading a missing or mismatched record refuses; it never creates an empty vault.

Use a dedicated private destination directory that includes the new runtime and session IDs. Explicit `createNew: true` is only for approved first setup or a fresh inactive destination. It refuses an existing record. Pass bound callbacks for the Runtime's three hooks:

1. `preflightExtras({authority})` validates the complete password vault and preference bundle.
2. `captureExtras({authority})` returns `{bundle, assertCurrent, release}`. Retain that lease through physical browser stop, encryption and durable checkpoint publication. Local credential mutations refuse until release.
3. `commitExtras({authority, bundle, receipt, grant})` publishes only after the Runtime independently verifies exact activation. It requires the exact staged destination and full active authority. It is one use and runs before destination network access.

Only a separately authorized privileged credential flow may call `replaceBundle`. Never expose provider instances, plaintext bundles, keys, or generic mutation callbacks to a renderer or agent RPC. Preserve whole-snapshot deletions, Never origins and search preference. Prompt for passwords in the protected login UI, not chat.

Async OS key lookup happens only at preload. The hooks perform synchronous local authenticated encryption and private file IO. The store fsyncs its file and directory, atomically replaces one ciphertext record, then decrypts a readback. A persistent pending marker or stale lease requires explicit recovery. Do not remove these markers automatically or retry an uncertain commit. A failed explicit create removes only its new OS key after key disposal when the destination record is definitely absent. Already-published uncertain data retains its key and marker; failed OS cleanup is reported separately.

The approved machine and its operator can read and use the saved logins once unlocked. JavaScript strings cannot be reliably zeroed. Temporary cryptographic buffers and retained wrapping keys are cleared, but this is not protection from a hostile authorized host.

The disposable `scripts/probe-browser-profile-extras.mjs` needs a private test bus and extracted official libsecret executable. Its command remap and fixture authority are qualification tools, not installation instructions, a browser relay proof, or production provisioning.
