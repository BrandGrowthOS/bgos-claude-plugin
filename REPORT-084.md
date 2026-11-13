# Plugin 0.84.0 integration report

## Scope and history

Work stayed in `/Users/kc/hoai-work/mbplugin084` on `release/plugin-0.84.0`. The starting main snapshot was `309ef744bbb6d03ad771492df0af0e7df13ed5c9`. Nothing was pushed or deployed, and no production service was used.

The reviewed branch tips were merged in the requested order, with separate merge commits:

| Branch | Reviewed tip | Merge commit |
| --- | --- | --- |
| `fix/threads-hardening-2` | `f0056b963dd432d53b9c87d83c88d0182fcc22d4` | `cca3732722b06555e8611a94847111e3272200ca` |
| `feat/mission-working-hooks` | `a141232feb6d37b2f2ae83018ddea232b642e599` | `20d06d00f38c49aabd437fef90c060739d065597` |
| `fix/edit-after-delivery` | `2298111ac23a8daf2970f9a07aaa3505e8d75f8d` | `36238cfa6ba9c0b3841c0189bf55ff2397af3531` |
| `fix/daemon-attach-scope-impl` | `5ec1909cde91d42e2d5ef5c08c7286c34168c6b7` | `d80e6e2355fceb404f67a7ac647670d6145373e3` |

The first three merges were clean. The fourth had one conflict, in the startup block of `server.ts`. Attach scope moves duplicate-copy detection into an earlier preflight; thread hardening starts a background CLI probe after the duplicate guard. The resolution keeps the earlier preflight, runs `await attachScopeAtBoot()` at the start of `main()`, and then starts `threadsCliGate.ready()`. A duplicate or refused copy therefore exits before the probe writes its cache. The duplicate check runs only once.

The automatic shutdown merge was inspected and tested. It stops hook intake immediately, gives working-mark cleanup up to 2 seconds before releasing authority, then stops thread lanes and side-question children with their existing 3 second bound before browser shutdown and process exit. Both behaviors remain present.

`package.json`, `.claude-plugin/plugin.json`, and both root version fields in `package-lock.json` now say `0.84.0`. Dependency entries are unchanged. One plain-language changelog entry covers all four owner benefits; the inherited unreleased attach-scope draft was consolidated into it. Earlier released changelog text matches main.

Main's root `REPORT.md` is unchanged, with SHA-256 `21ab6bd8b8fa6a4f52ff613b6ac1fe7be38a2e645174bb6688af4f9be2e0eb55`.

## Verification setup

The machine is macOS 27.0.1 on arm64, with Node `v26.0.0`, npm `11.12.1`, and Bun `1.3.14`. Locked dependencies were installed here with `npm ci --no-audit --no-fund`, using a local npm cache. The install added 124 packages.

The initial evidence runs placed HOME, temporary directories, and caches inside this checkout's ignored `node_modules/.plugin084` folder and removed inherited BGOS, HOAI, and Claude environment settings. The doctor control runs used `.plugin084-tmp` for temporary files, also inside this checkout, for the path-classification reason below. Test backends are local fixtures. The available Chrome executable is used for browser tests. Main comparisons use an exported copy of the pinned main commit under that same local folder, without switching or modifying main.

Focused Node runs use `--test-concurrency=4`; focused Bun runs use `--max-concurrency=4`. The full `npm test` runner uses four Node workers, serial Chromium files, and Bun concurrency of four. No two test commands were run concurrently.

Both the initial and final `npm run build` checks passed. The final check ran after the shutdown harness change.

## Focused suites

| Suite | Passed | Failed | Skipped | Evidence |
| --- | ---: | ---: | ---: | --- |
| Threads | 237 | 0 | 1 | [threads-node.log](docs/evidence/plugin084/threads-node.log) |
| Mission working, final | 276 | 0 | 0 | [mission-working-final.log](docs/evidence/plugin084/mission-working-final.log) |
| Edit delivery, Node | 310 | 0 | 0 | [edit-delivery-node.log](docs/evidence/plugin084/edit-delivery-node.log) |
| Edit delivery, Bun | 19 | 0 | 0 | [edit-delivery-bun.log](docs/evidence/plugin084/edit-delivery-bun.log) |
| Attach scope | 183 | 0 | 0 | [attach-scope-node.log](docs/evidence/plugin084/attach-scope-node.log) |
| Launcher | 198 | 0 | 15 | [launcher-node.log](docs/evidence/plugin084/launcher-node.log) |
| Marketplace | 58 | 0 | 0 | [marketplace-node.log](docs/evidence/plugin084/marketplace-node.log) |

The real CLI sandbox check is opt-in and was skipped because `THREADS_SANDBOX_CLAUDE` was not supplied. The launcher skips are 5 Linux-only process checks and 10 Windows-only process or console checks. The complete file lists are in [focused-files.json](docs/evidence/plugin084/focused-files.json). Each run has adjacent JSON recording the exact command, working directory, environment paths, duration, exit status, and server source hash.

## Failures and main comparison

The initial mission-working run had one failure: `graceful shutdown keeps authority until clears finish, with a bounded fallback` in `test/mission-working-wiring.test.ts`, with `ReferenceError: stopThreadChildren is not defined`. The test evaluates the real shutdown body with supplied dependencies; after combining the two branches, that body also calls the thread-stop helper, which the old test harness did not supply.

Only the test harness changed. It now supplies the helper and checks clear completion and the deadline both with no thread children and with children still stopping. It asserts that intake stops immediately, authority is retained during working cleanup, and browser shutdown and exit wait for children. The full mission-working rerun passed all 276 tests.

On main, this mission-working test does not exist, so the exact failure is not applicable there. That absence is recorded in [mission-test-main-presence.json](docs/evidence/plugin084/mission-test-main-presence.json). Main's existing thread-lifecycle suite passed all 8 tests in the exported snapshot: [main-thread-lifecycle.log](docs/evidence/plugin084/main-thread-lifecycle.log). The initial failure log is retained as [mission-working-node.log](docs/evidence/plugin084/mission-working-node.log).

The full run's only failure was `provePairedTopology, with the REAL verifiers: the same folder is refused when any one of the three is taken away` in `test/bgos-doctor.test.ts:1883`. It expected `paired-topology:installer-is-a-clone` and received an empty reason. The same test fails with the same assertion on pinned main using the same temporary-directory layout: [main-doctor-nested.log](docs/evidence/plugin084/main-doctor-nested.log).

This is a fixture-location problem. The test's fake clone lives beneath TMPDIR. The initial local TMPDIR was itself under `node_modules`, and the existing install detector treats a path containing `node_modules` under a temporary root as an ephemeral package-runner location. That makes this fake clone look like a package-runner install. The doctor, detector, and test are unchanged from main. Moving only TMPDIR to `.plugin084-tmp` inside this folder restores the intended fixture shape. The complete doctor file then passes all 111 tests on the integration tree and all 111 on main: [doctor-final.log](docs/evidence/plugin084/doctor-final.log), [main-doctor-final.log](docs/evidence/plugin084/main-doctor-final.log). No production code or test assertion was changed for this failure.

These are the two distinct failures observed during the work: the repaired integration shutdown harness and the main-reproducible doctor fixture-location failure. The latter also failed once in its explicit main reproduction. There were no other test failures or cancellations.

## Full suite

Ran `python3 docs/evidence/plugin084/run.py full npm test` exactly once after the focused suites, with the final production and test sources. It completed all three families in 732.053 seconds and exited 1 because of the doctor fixture-location failure above. The full run itself is not reported as green and was not repeated.

| Family | Tests | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: | ---: |
| Node, 416 files, 4 workers | 8,628 | 8,574 | 1 | 53 |
| Chromium, 7 files, serial | 15 | 15 | 0 | 0 |
| Bun, 15 files, concurrency 4 | 378 | 377 | 0 | 1 |
| Total | 9,021 | 8,966 | 1 | 54 |

Complete output: [full.log](docs/evidence/plugin084/full.log). Command, environment, source hash, timing, and exit status: [full.json](docs/evidence/plugin084/full.json). The skips are platform-specific or opt-in cases; Chromium ran against the available Chrome executable. All 796 recorded source and test hashes still match the tree tested by this run.

## Review and preservation evidence

An independent read-only review found the same shutdown harness issue, accepted the correction, and reported no further findings. See [review.md](docs/evidence/plugin084/review.md).

The preservation audit verified 250 files byte for byte against their last contributing branch. Its only differing branch files are the combined `server.ts`, the adapted shutdown test, and the consolidated changelog. Version changes are checked separately and alter only the requested version fields. Evidence includes [inputs.json](docs/evidence/plugin084/inputs.json), [structure.json](docs/evidence/plugin084/structure.json), [branch-preservation.json](docs/evidence/plugin084/branch-preservation.json), [conflict-resolution.diff](docs/evidence/plugin084/conflict-resolution.diff), and [source-sha256.json](docs/evidence/plugin084/source-sha256.json).

Final audit: [final-checks.json](docs/evidence/plugin084/final-checks.json). It verifies release versions, merge ancestry and order, preserved history, unchanged tested sources, expected command exit statuses, and the new prose format.
