# The Windows test baseline: 13 node + 1 bun failures are the box, not the branch

**Date:** 2026-08-25

**Context:** Proving "no regressions" for the zero-terminal lifecycle branch on Kc's Windows box, where CI (Ubuntu) is not available locally. The first baseline read "1 failure" because the grep only matched lines containing the word "failed"; the true pristine-`main` count is higher, and it matters because a wrong baseline hides a real regression or makes a healthy branch look broken.

**Gotcha / Pattern:** On this box, pristine `main` (`npm test` = `scripts/run-tests.mjs`, node family via `tsx --test`, bun family via `bun test`) fails exactly these, all 0600 / symlink / shell / path artefacts of Windows, all green on Ubuntu CI:

node family (13): `per-assistant credentials file is preferred when it exists for the configured id`; `read order in lib and the bgos-pair mirror never drift apart`; `selection: fresh single-agent host (one per-assistant + legacy) does NOT regress`; `MCP_JSON_MODE is 600 and writeMcpJsonFile pins it on disk`; `resolveAgentDir keeps the scaffold strictly inside the agents root`; `simulated crash: a failed save leaves the previous file intact`; `flushIfDirty failure keeps the store dirty so a later flush retries`; `daemon spawn uses fixed bun argv without a shell`; `stable wrapper installation is atomic and executable outside checkout`; `real fs: the walk + allowlist package a temp workspace end to end`; `real fs: an on-disk symlink escaping the workspace blocks the export`; `the file is written 0600 (owner only), like the chat cursor store`; `loadVoiceMemory concatenates the agent home memory files, capped`.

bun family (1): `durable state and shared lock > state lives next to daemon state and round trips atomically at mode 600`.

Also: `bun:test` files cannot be run with `tsx --test` (they fail to load with `bun:` scheme errors, which looks like two whole-file failures); a fresh clone must use `core.autocrlf=false` or the static `server.ts` source tests fail on CRLF; and a `Stop-Process` filter on a test file name will match the shell running your own command.

Two more from the review round: CI's type check is `bun run build` (`tsc --noEmit`) and it INCLUDES `test/**`, while a local `tsc --noEmit -p .` skipped the tests and reported 0 errors for a branch CI rejected (a JSDoc block detached from its function by an inserted helper, and a widened fs default type); run `bun run build` before pushing. And the generated win32 `install-task.ps1` `stop` action once killed every process whose command line mentioned `hoai-watcher.mjs`, my own shell included, mid E2E; any process matcher must be `node.exe` + the exact bundle script path, never a bare file name (pinned in `test/watcher-service.test.ts`).

**How to apply next time:** Read the runner's `✖ failing tests:` block (node) and the `(fail)` lines (bun) and diff the NAMES against this list; never trust a count from a grep. Run bun files with `bun test`. If a name outside this list fails, it is the branch.

**Regression guard:** none (environment-only). The list above is the guard; CI is the truth.
