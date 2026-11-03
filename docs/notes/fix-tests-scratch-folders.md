# Test scratch folders are removed when the test process ends

Board row c1ddf80c. Ares lane `tmplitter`. This is the first of two changes for the row; the second (a report of the names a run adds to the OS temp folder, in `scripts/run-tests.mjs`) waits for #302 to land.

## Before

A full `npm test` left about 540 new names in the machine's temp folder every run. Measured on `main` (f780cf1) with a private temp folder, so the count was that run's alone: 534 names from 184 distinct mkdtemp prefixes, made by 52 test files. Each file made folders with `mkdtempSync(join(tmpdir(), 'x-'))` and never removed them. The nine largest groups were skills-share (53), hoai-shim-relay (32), vhb (28), bh-sup (21), doctor-identity (20), hoai-model-control (14), clone-hooks-ws (12), published-release-state (10) and release-origin (9); the other 175 prefixes were one to nine names each.

## After

- `test/helpers/scratch-dirs.ts`: `scratchDir(prefix)` makes the folder and removes every one it made when the process ends. `removeScratchDir(dir)` removes one at once.
  - node:test runs one process per file, so the sweep hangs off the `exit` event. That covers a pass, a throw, a failed assertion and `process.exit`.
  - `bun test` runs every file in one process and never emits `exit` or `beforeExit`. There the first folder made after a sweep registers bun's `afterAll`, so each file gets its own sweep.
  - The sweep never throws, steps out of a folder the test `chdir`-ed into (by physical path too), and never follows a link (`rm` unlinks a symlink or junction).
- 58 files under `test/` (57 test files and the `release-origin` helper) now call `scratchDir(prefix)`: the 51 that leaked on a full run here, plus seven that skip on a machine without `expect` or off Windows and so never showed in a local run: `bgos-agent.gate`, `bgos-agent.install`, `browser-env`, `gate-block`, `gate-proof.script`, `win32-gate-helper.console`, `win32-relaunch.console`. A fresh review found those seven; they leak on CI.
- `test/helpers/browser-managed-context.cjs` removes its home in the same `t.after` that stops its child.
- `test/scratch-folder-convention.test.ts` fails for any test file that calls mkdtemp and neither uses `scratchDir` nor removes anything. It is a convention check, not a proof: a file with one remove and three leaks passes it. Only looking at the temp folder after a full run sees those.

`test/helpers/packaged-browser-bootstrap-smoke.ts` still uses a bare mkdtemp. It is an opt-in operator script (`node --import tsx ...`, never collected by `npm test`) that writes its evidence under `docs/reports`, and it is left alone.

No shipping file changed (`test/` and `docs/` only), so no version bump.

## Proof

Each full run used its own fresh folder made with `mktemp -d`, through `heavy`, with `TMPDIR`, `TEMP` and `TMP` pointed at it. "Names left" is `ls -A` of that folder after the run.

| Run | Tree | Run folder on | Names left | Of which tool caches | bun:test |
| --- | --- | --- | --- | --- | --- |
| baseline | f780cf1 (main) | RAM disk | 534 | 2 | 374 pass, 0 fail |
| run 1 | an earlier state of this work | RAM disk | 2 | 2 | 377 pass, 0 fail |
| run 2 | the same test files plus a report in run-tests.mjs | RAM disk | 2 | 2 | 377 pass, 0 fail |
| run 3 | as run 2 | RAM disk | 2 | 2 | 377 pass, 0 fail |
| run 4 | this change exactly (b117144) | WSL home, ext4 | 2 | 2 | 377 pass, 0 fail |

The two names left are `node-compile-cache` and `tsx-1000`, the toolchain's own caches. In run 4 the repo tree also had nothing new, ignored files included, and `tsc --noEmit` exits 0.

- A test made to throw still cleans its folder, on real converted files in both families: a throwing case planted in `test/skills-share.test.ts` (node:test) and in `test/version-heartbeat.test.ts` (bun:test) made a folder that existed when the case threw, the case failed, and the folder was gone with 0 names left. The plants were removed again.
- `test/scratch-dirs.test.ts` and `test/scratch-dirs.bun.test.ts` run real child processes (`tsx --test` and `bun test`) under their own `TMPDIR` and look at that folder from outside: pass, throw, `process.exit`, early remove, a folder already gone, `chdir`, a link not followed, a failing test in the middle of a bun run and the last file of the run. Both were red first, and with the sweep disabled 6 of the 7 node cases and 2 of the 3 bun cases fail (the ones that still pass check explicit removal, which does not use the sweep, and a control that proves the check can see litter).
- `test/scratch-folder-convention.test.ts` was red on exactly the seven files first.

Failures in the full runs are the ones the baseline already had: the 10 real-Chromium cases (no Linux browser on this host) and a handful of timing cases in the private-turn late-Stop-line family, which varies from run to run and fails in isolation too. Run 2 also had two end-to-end cases in `duplicate-copy.e2e.test.ts` fail on a loaded machine; the file passes 3 of 3 alone. In run 4 every failing name was already in the baseline's failing set.

## Environment

- Linux Node 24.22.1 and Bun 1.3.14 through WSL; the checkout's own `node_modules` has Windows shims, so a POSIX `tsx` shim and `ESBUILD_BINARY_PATH` were used, the same in every run.
- Runs 1 to 3 and the baseline used a folder on a RAM disk; run 4 used the WSL home (ext4). A temp folder on the Windows mount (drvfs) does not work for this suite: tsx cannot create its socket there, file-mode assertions see 0777, and the run did not finish inside `heavy`'s 30 minute timeout.
- The Windows result comes from the plugin's own CI job, not from this host.

## Limits

- A process killed by a signal skips the `exit` sweep, so what it made stays.
- Under bun, call `scratchDir` inside a test, a hook or a helper they call, not in a `describe` body: a describe-level folder is swept by the first describe's `afterAll`.
- Nothing here fails a run that leaves folders. The runtime report of new names in the OS temp folder is the second change for this row.
