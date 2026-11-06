# PLUGART2 report

The plugin is version 0.86.0 on `feat/artifact-tools`.

## Tools and contract

| Tool | HTTP under `api/v1/integrations/assistants/:assistantId/artifacts` |
| --- | --- |
| `artifact_create` | GET `schema`, then POST collection |
| `artifact_update` | GET `schema`, then PATCH `:id` with `expectedVersion` |
| `artifact_read` | GET `:id`, optionally `?version=N`; omit id to GET `schema` |
| `artifact_list` | GET collection |
| `artifact_versions` | GET `:id/versions`, then GET `:id` for its current title and link |

`lib/artifacts-tools.ts` uses the existing authenticated boards transport.
The server freezes the verified private turn before awaiting work and passes
its acting-person headers, the daemon's pairing authentication and its own
assistant id. The marketplace hooks and installed clone hooks recognize the
new private tools too.

Create and revision bodies use the fields in the supplied controller and
capability contract. Strict schemas reject unknown request, source and
content-envelope fields; the artifact id remains in the URL. Both write tools
fetch the live schema, check its envelope and limits, and never retry a write.
A 409 tells the agent to reopen before editing. Native block parsing,
read-only enforcement at every depth, combined data-cell limits and Markdown
parsing remain authoritative on the backend. `artifact_read` without id exposes
the full live schema so the agent can compose those blocks without guessing.

Results carry each Artifact's id, title and relative app link, including the
server's link version when present. Schema reads and empty collections have
no artifact reference. Minimal successful write responses use the submitted
title or read current metadata without repeating the write. The backend posts
the reference beside chat. Links do not grant access.

## Guidance delivered to agents

The MCP server instructions and every Artifact tool description contain:

> When you produce a dashboard, report, chart, table, plan, document or any page a person will read, share or revisit, make it an Artifact instead of a long chat message, then send a short reply with its link. Update the same Artifact for revisions rather than creating new ones.

The same guidance appears in the capability fallback (`lib/capabilities.ts`),
the README's required agent-doc snippet, the installer-generated agent docs
(`bin/bgos-agent`) and `docs/artifacts.md`. These also explain the schema read,
revision lock, access boundaries, and handling of untrusted Artifact text.
The package, lockfile and plugin manifest all declare 0.86.0. The changelog
records this release.

## Tests and evidence

Dependencies were installed in this checkout with `npm ci`, using a local
cache. Test temporary directories are under `.plugart2-tmp`, directly in this checkout
so clone-detection fixtures do not resemble a package-runner install.
`RUN_TESTS_WORKERS=2` caps both families and nested runner workers; the full
suite runs at niceness 10. Existing Chromium and daemon groups remain serial. The runner regression tests exercise
the configurable cap and count actual overlapping worker processes.

- Focused suite: 294 tests passed, zero failed or skipped. See
  [focused.log](docs/evidence/plugart2/focused.log).
- Typecheck: `npm run build` (`tsc --noEmit`) passed. See
  [typecheck.log](docs/evidence/plugart2/typecheck.log).
- Full plugin suite: 9,897 passed, zero failed, 58 skipped by existing
  platform/environment guards; all 459 files completed. Both Node and Bun
  families passed with the requested worker cap. The independent working-tree
  litter check passed, and the dedicated temp folder was empty after the run.
  See [full-suite.log](docs/evidence/plugart2/full-suite.log).

`test/artifacts-tools.test.ts` stubs HTTP through the production transport and
checks every tool's method, full assistant-scoped URL, pairing and acting-person
headers, JSON body and returned reference. It also checks schema reads,
unknown fields, contract/declaration parity, revision locks, path traversal,
content limits, live-schema failures, minimal write responses, backend errors
without retries, and guidance in all agent surfaces. Existing private-turn and
hook tests verify the tool matchers stay synchronized and all five Artifact
tools refuse an unverified turn. Source guards pin the new strict-tool branch
and the literal server instruction.

The full run also exposed an unrelated mission test that assumed arrival
order between concurrent refreshes of different goals. It now checks the
initial selections in order and the exact refresh requests independently of
cross-goal arrival order. The rollback fixture guard permits a deliberately
configured dedicated temp subfolder inside the checkout while still refusing
fixtures elsewhere in the tree and checking that every fixture was removed.
`TSX_DISABLE_CACHE=1` and `NODE_DISABLE_COMPILE_CACHE=1` prevent persistent
compiler caches from tripping the runner's independent working-tree litter
check. A thread-probe unit test now awaits its second background probe before
removing the fixture, so the probe cannot recreate its cache directory after
cleanup. The focused run leaves the dedicated temp folder empty.

Focused command:

```sh
RUN_TESTS_WORKERS=2 TSX_DISABLE_CACHE=1 NODE_DISABLE_COMPILE_CACHE=1 TMPDIR="$PWD/.plugart2-tmp" nice -n 10 node --import tsx --test --test-concurrency=2 test/artifacts-tools.test.ts test/bgos-doctor.test.ts test/boards-download.test.ts test/bundled-instructions.test.ts test/capabilities.test.ts test/hooks-manifest.test.ts test/private-turn.test.ts test/turn-aware-tools.test.ts test/mission-working-hooks.test.ts test/self-update.idle-rollback.test.ts test/threads-cli.test.ts test/run-tests-chromium-serial.test.ts
```

Full-suite command:

```sh
RUN_TESTS_WORKERS=2 TSX_DISABLE_CACHE=1 NODE_DISABLE_COMPILE_CACHE=1 TMPDIR="$PWD/.plugart2-tmp" nice -n 10 npm test
```

Validation uses the supplied API contract and HTTP stubs, plus the local plugin
suite. It does not claim a live-backend or app UI end-to-end pass. Evidence
keeps public relative paths; raw local suite output stays in ignored
`node_modules/.plugart2-full-suite.log`.
