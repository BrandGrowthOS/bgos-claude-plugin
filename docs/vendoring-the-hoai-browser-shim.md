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

## What none of this catches

Nothing in THIS repo fires when the BGOS shim changes and this copy does not
move, which is the drift that actually happened (2026-09-12). A check for that
has to live on the BGOS side: a BGOS test that fails when the shim's hash is not
the one the plugins pin. Until that exists, step 1 of a BGOS shim fix is
"re-vendor both plugins", and the only automatic protection here is
behavioural: the relay suite fails against a shim that regresses the body-status
reading or the pairing-lane assistant id (proven: 6 of 9 cases fail against the
pre-fix blob).
