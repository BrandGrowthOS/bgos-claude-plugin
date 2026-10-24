# Re-vendoring the HOAI browser shim (release checklist)

`bin/hoai-browser-mcp.mjs` is a byte-identical **copy** of the BGOS source of
truth, `frontend/electron-app/agent-browser/shim/hoai-browser-mcp.mjs`. It is
not a fork and must never be edited here: the shim is framework neutral by
design (relay plan decision 11.2, it never reads a plugin's files and takes its
credentials from env), so every channel plugin ships the same bytes and only the
launcher differs. `vendor/hoai-browser-mcp.mjs` in `codex-channel-bgos` is the
same copy.

The expected hash lives in `bin/hoai-browser-mcp.vendor.json` and is checked by
`test/hoai-browser-mcp.vendor.test.ts` on every `npm test`. Fix the shim in
BGOS, then bring the copy across with this list.

1. **Copy the file, do not patch it.** From a checkout that has both trees:

   ```bash
   cp "<bgos>/frontend/electron-app/agent-browser/shim/hoai-browser-mcp.mjs" bin/hoai-browser-mcp.mjs
   ```

   Copy the BGOS test changes too (`agent-browser/__tests__/shim.relay.test.js`
   -> `test/hoai-browser-mcp.relay.test.ts`, ported to TypeScript, node:test and
   `node:path`; no bare POSIX path, the Windows runner is real).

2. **Hash both sides and confirm they agree.**

   ```bash
   sha256sum bin/hoai-browser-mcp.mjs "<bgos>/frontend/electron-app/agent-browser/shim/hoai-browser-mcp.mjs"
   git show HEAD:bin/hoai-browser-mcp.mjs | sha256sum      # after committing
   ```

   The BGOS side must be **committed** there, or the claim is unverifiable from
   git and a reviewer diffing the two committed blobs sees them disagree.

3. **Bump the pin.** Put the new hash and today's date in
   `bin/hoai-browser-mcp.vendor.json`. This is the step that makes drift loud:
   the guard test fails until the pin and the file agree, so a re-vendor cannot
   land without someone stating the new hash in the tree.

4. **Run the guard with the cross-tree check armed**, on the machine that has
   both trees:

   ```bash
   HOAI_BROWSER_SHIM_SOURCE="<bgos>/frontend/electron-app/agent-browser/shim/hoai-browser-mcp.mjs" \
     npx tsx --test test/hoai-browser-mcp.vendor.test.ts
   ```

   Without that variable the cross-tree case is skipped with a reason: BGOS is a
   separate private repo and is not on this repo's CI runner, so CI can only
   check the copy against the pin, never against BGOS.

5. **Run the behavioural cover, which is what catches a shim that no longer
   works rather than one that merely changed.**

   ```bash
   npx tsx --test test/hoai-browser-mcp.relay.test.ts test/hoai-browser-mcp.test.ts
   npm test && npm run build
   ```

6. **Say it in `CHANGELOG.md`** under the version that ships the new copy, with
   the hash, and bump `.claude-plugin/plugin.json` + `package.json` so the fleet
   can actually receive it. A vendored fix nobody publishes reaches nobody.

7. **The other plugin ships the same bytes.** `codex-channel-bgos` vendors the
   shim as `vendor/hoai-browser-mcp.mjs`; re-vendor it in the same round or say
   plainly that it is behind.

## When this copy leads (0.72.0)

Plugin 0.72.0 (BGOS mission 173) changed this copy before BGOS could: the
desktop tree was being changed by other work at the time, and the agent side had
to stop telling agents "the desktop app is not running" first. The change is in
this repo's history (the 0.72.0 PR) and is recorded in the pin: `why` says what
was added on top of the BGOS bytes it started from (`sourceCommit`), and
`aheadOfSource` says that BGOS is now the side that must copy.

1. **BGOS copies this file, byte for byte**, into
   `frontend/electron-app/agent-browser/shim/hoai-browser-mcp.mjs`, bumps its own
   pin (`hoai-browser-mcp.pin.json`) and ports `test/hoai-browser-mcp.refusals.test.ts`
   to its shim suite.
2. **Then this pin goes back to normal**: `sourceCommit` names the BGOS commit
   that holds these bytes and `aheadOfSource` is removed.
3. **Until then the armed cross-tree check fails, by design.** Run without
   `HOAI_BROWSER_SHIM_SOURCE`, the guard still holds this copy to its pin.
4. `codex-channel-bgos` ships its own copy (`vendor/hoai-browser-mcp.mjs`) and is
   behind until it takes the same bytes.
5. Plugin 0.74.2 (board row 94c6a3fb) changed this copy again: the managed
   context watch, so the tools follow a live turn within seconds. BGOS takes
   these bytes (sha256 `c8b0f0dc`) and ports
   `test/hoai-browser-mcp.live-context.test.ts` in the same copy.

## What none of this catches

Nothing in THIS repo fires when the BGOS shim changes and this copy does not
move, which is the drift that actually happened (2026-09-12). That check lives
on the BGOS side now: `frontend/electron-app/agent-browser/shim/hoai-browser-mcp.pin.json`
holds the shim's sha256 and `agent-browser/__tests__/shim.vendor-pin.test.js`
fails on the BGOS side the moment the shim's bytes stop matching it, with a message
that names both plugin copies. It stops a BGOS change from landing without a
deliberate pin bump; it cannot re-vendor this repo, so step 1 of a BGOS shim
fix is still "re-vendor both plugins". Here, the automatic protection is
behavioural: the relay suite fails against a shim that regresses what it pins.
As of the 2026-09-28 re-vendor (sha256 `24470ac3`, BGOS `8daa845bc`) the ported
relay suite holds 32 cases, and 20 of them fail against the previous copy
(`aaaff4b6`): the rate limit and throttle words, the dropped host, the refusals
met while connecting, the collect of a sent call, and the refused host probe.
