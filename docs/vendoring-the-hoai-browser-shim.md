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

3. **Update the pin.** Record the full immutable BGOS `sourceCommit`, the
   SHA-256 of its committed shim blob as `sourceSha256`, the identical vendor
   `sha256`, and today's `vendoredAt` date in
   `bin/hoai-browser-mcp.vendor.json`. Remove `aheadOfSource` once parity holds.
   This is the step that makes drift loud:
   the guard test fails until the pin and the file agree, so a re-vendor cannot
   land without someone stating the new hash in the tree.

4. **Run the guard and upstream verification.** Every `npm test` compares the
   vendored bytes with the two local hash fields. That consistency check alone
   cannot establish what BGOS contains at `sourceCommit`.

   The Linux plugin CI job runs `node scripts/check-browser-shim-source.mjs`
   unconditionally, including on fork PRs. It validates the immutable commit,
   both recorded hashes and the vendored bytes without network access or a
   secret. It emits a notice that the live comparison was skipped. This verifies
   the recorded content hash, not independently fetched source provenance.

   A separate CI job runs `node scripts/check-browser-shim-source.mjs --live`
   on pushes to this repository's main branch and on the daily schedule. When
   `BGOS_SOURCE_READ_TOKEN` is available, it fetches the raw source blob from
   the GitHub contents API at the full immutable `sourceCommit`, compares its
   hash and bytes with the local pin and shim, then runs
   `test/hoai-browser-mcp.vendor.test.ts` with `HOAI_BROWSER_SHIM_SOURCE` set
   to that fetched file. It never executes BGOS code. A wrong commit, stale
   commit, failed fetch or different blob fails the live job. The ordinary
   Linux behavioral suite runs independently of that job.

   BGOS is private. Repository administrators can configure the Actions secret
   `BGOS_SOURCE_READ_TOKEN` with read-only contents access to BrandGrowthOS/BGOS.
   The plugin's `GITHUB_TOKEN` only reads this plugin and cannot replace it.
   An unavailable token emits an explicit skip notice after validating the
   recorded hash offline. PRs never receive this credential, and fork PRs can
   run the entire ordinary suite. Keep the live job limited to trusted push
   and scheduled events.

   For a local network check, supply that token as `BGOS_SOURCE_READ_TOKEN` and
   run `node scripts/check-browser-shim-source.mjs --live`. The command without
   `--live` remains offline even if a token is present. Alternatively, use a
   read-only BGOS clone and measure the committed source blob:

   ```bash
   git -C "<bgos>" show "<sourceCommit>:frontend/electron-app/agent-browser/shim/hoai-browser-mcp.mjs" | sha256sum
   ```

   With that pinned checkout available, also run the direct cross-tree audit:

   ```bash
   HOAI_BROWSER_SHIM_SOURCE="<bgos>/frontend/electron-app/agent-browser/shim/hoai-browser-mcp.mjs" \
     node --import tsx --test --test-concurrency=4 test/hoai-browser-mcp.vendor.test.ts
   ```

   Without that variable the direct audit is skipped in ordinary `npm test`.
   The offline CI hash verification always runs. A supplied path that does
   not exist fails rather than silently skipping. Live CI verifies the recorded
   commit's content, not the latest moving BGOS main; re-vendoring still requires
   measuring that committed blob and reviewing the upstream diff.

5. **Run the behavioural cover, which is what catches a shim that no longer
   works rather than one that merely changed.**

   ```bash
   node --import tsx --test --test-concurrency=4 test/hoai-browser-mcp.cancellation.test.ts test/hoai-browser-mcp.relay.test.ts test/hoai-browser-mcp.test.ts
   npm test && npm run build
   ```

6. **Say it in `CHANGELOG.md`** under Unreleased, with the source commit and
   hash. Version changes belong to the release order; a re-vendor alone does
   not bump `.claude-plugin/plugin.json` or `package.json`.

7. **The other plugin ships the same bytes.** `codex-channel-bgos` vendors the
   shim as `vendor/hoai-browser-mcp.mjs`; re-vendor it in the same round or say
   plainly that its parity was not checked when it is outside the work scope.

## When this copy leads (current, 0.86.12)

Sometimes a fix must ship here before BGOS can take it. That copy is still not
a fork: it is the BGOS blob at `sourceCommit` plus one committed, reviewable
patch, and the checks prove that relationship instead of being switched off.

1. **Keep `sourceCommit` and `sourceSha256` at the BGOS blob you started
   from**, and set `sha256` to the new vendored bytes.
2. **Commit the delta as `bin/hoai-browser-mcp.ahead.patch`**, a unified diff
   from the BGOS source path to these bytes, so BGOS can apply it with
   `git apply` unchanged:

   ```bash
   diff -u "<bgos shim at sourceCommit>" bin/hoai-browser-mcp.mjs \
     | sed -e "1s#.*#--- a/frontend/electron-app/agent-browser/shim/hoai-browser-mcp.mjs#" \
           -e "2s#.*#+++ b/frontend/electron-app/agent-browser/shim/hoai-browser-mcp.mjs#" \
     > bin/hoai-browser-mcp.ahead.patch
   ```

3. **Record `aheadOfSource`** in `bin/hoai-browser-mcp.vendor.json` as
   `{ "patch": "bin/hoai-browser-mcp.ahead.patch", "bgosFollowUp": "<what BGOS must land>" }`.
4. **What the checks then require.** `node scripts/check-browser-shim-source.mjs`
   and `test/hoai-browser-mcp.vendor.test.ts` reverse the patch out of the
   vendored bytes offline and require the result to hash to `sourceSha256`,
   then require the patch to rebuild the exact vendored bytes. Any change not in
   the patch, a patch that does not apply, or a stale base fails. `--live`
   fetches the blob at `sourceCommit`, checks it against `sourceSha256`, applies
   the patch and requires the vendored bytes. An ahead pin whose two hashes are
   equal fails: at parity, remove `aheadOfSource` and the patch.
5. **The armed cross-tree case fails against BGOS until BGOS lands the patch**,
   with a message naming the patch, and passes once the supplied BGOS shim is
   these exact bytes. That keeps the BGOS vendor parity workflow red as a FORK
   for exactly as long as the trees differ.
6. **Then return to parity**: after BGOS commits the bytes, re-vendor with the
   checklist above, pin the new BGOS commit, and delete `aheadOfSource` and the
   patch.

0.86.12 leads for the fill-only contract: tool schemas omit composite
submission and sequential typing, `browser_fill_form` accepts textbox fields
only, old composite calls are refused before forwarding, and submission
requires a separate approved `browser_click` on the exact current submit
control. Enter, Return and Space are refused in every key chord position, and
only Alt, Control, ControlOrMeta, Meta and Shift may precede the final key (a
literal plus remains a valid final key). The local and relay suites cover the
refusals and ordinary fill forwarding. BGOS and `codex-channel-bgos` have not
taken these bytes yet; `aheadOfSource.bgosFollowUp` says what they must land.

## Historical exception: when this copy led (0.72.0)

Resolved on 2026-11-06: a fresh BGOS main clone at
`aed69c93bd191ce8de678b4f5cac4761f7130680` contains the exact vendored bytes
(SHA-256 `2fd50404ff330d65f5f38017ffb7dd0a5df2f1c560b694c1f329b1bbe88f71ef`).
The pin now records parity and no longer claims to lead. Cancellation was
already present in both copies; the plugin now runs its transport cases too.

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

## Filled-tab dispatcher contract

The portable host now tracks filled fields per tab at its shared engine
boundary. After a fill, actions require a fresh allow-once decision bound to
that action and the current field revision, even with a saved write grant.
Only fixed reads and more textbox fills remain available without that extra
decision. Scripts and unclassified tools cannot receive an exception.
`browser_fill_form` accepts textbox fields only, on both local and relay shim
routes. The shim side of this contract is the recorded ahead patch above. See
[browser-fill-submit.md](browser-fill-submit.md) for the host contract.
