# Marketplace merge evidence

This merges local `main` at `309ef744bbb6d03ad771492df0af0e7df13ed5c9` into `fix/daemon-attach-scope-impl`, whose previous tip was `0c096eaadce0a9b439cbcc7be42b01b76fdbdf1c`.

## Resolution

- `.claude-plugin/plugin.json`, `package.json` and `package-lock.json` match main exactly, including version `0.83.1`.
- `REPORT.md` matches main exactly. `REPORT-ROUND.md` remains unchanged from the branch.
- The branch's attach-scope changelog body is retained verbatim under `### Unreleased: attach scope` inside main's newest release heading. Main's existing changelog text is preserved.
- `test/bootstrap-askuserquestion-deny.test.ts` uses main's `scratchDir` cleanup and the branch's CommonJS fixture boundary.
- `test/run-tests-tmpdir.test.ts` uses main's `scratchDir` cleanup. Both conflicted tests retain all test names and assertions from both parents.
- The branch's `test/attach-scope.test.ts` also uses main's `scratchDir` helper. Its original helper leaked temporary folders, which main's new scratch-folder guard detected after the merge. Only fixture allocation and imports changed; every test name and assertion is preserved.
- Other existing files match a parent or Git's automatic three-way merge. No additional production behavior was introduced during conflict resolution.

## Verification

The initial integration run covered 33 files: every attach-scope, marketplace, `hoai-core` and `bgos-agent` suite, service home-scope and launcher inventory suites, both conflicted tests, and the scratch-folder guards. It finished with 616 passed, 9 skipped and one failure: the scratch-folder guard identified the attach-scope fixture leak. Its command, files and output are in `suites-initial.json` and `suites-initial.log`. `scratch-cleanup-red.log` independently reproduces that guard failure before the cleanup fix.

After the fixture-only fix, the final run repeats all 20 attach-scope, marketplace and `hoai-core` suites, both conflict tests and the scratch-folder guards: **396 passed, 7 skipped, 0 failed, exit 0**. The exact command and files are in `suites.json`; output is in `suites.log`. The unchanged service and `bgos-agent` suites already passed in the initial run. All runs use four workers. Temporary files are under `.tmp/marketmerge` in this checkout.

`cleanup-proof.log` and `cleanup-proof.json` record a further run of the attach-scope unit suite with a fresh in-checkout TMPDIR. It passed and left zero `attach-scope-*` fixture directories behind, proving cleanup beyond the static guard.

Typecheck: `npm run build`, exit 0. See `typecheck.log` and `typecheck.json`.

`structure.json` records a successful check of all 1,260 other original paths against both parents and Git's automatic merge, plus exact report and metadata comparisons, the changelog placement, and TypeScript AST comparisons of the three manually resolved tests' names and assertions. Reproduce from the repository root:

```sh
python3 docs/evidence/2026-11-03-marketmerge/verify-merge.py
```

`review.md` records a separate read-only review with no actionable findings.

`git diff --cached --check main` passes. The full diff against the branch parent reports 166 whitespace warnings in 38 historical evidence files imported unchanged from main. `diff-check.json` lists them and verifies they match main byte-for-byte. They were preserved rather than rewriting existing evidence. See `diff-check.log` for the diagnostics.

Existing local dependencies were sufficient; no dependency installation was needed. The run used Node 26.0.0, npm 11.12.1, tsx 4.23.0, TypeScript 6.0.3 and Bun 1.4.4. The selected suites run through Node/tsx and use Bun for their daemon fixtures.

Saved logs trim trailing whitespace and replace existing em or en dashes with ASCII hyphens. Test verdicts, counts and exit codes are unchanged.

To rerun the exact selected suites from this checkout:

```sh
python3 - <<'PY'
import json, os, pathlib, shlex, subprocess
root = pathlib.Path.cwd()
scratch = root / '.tmp/marketmerge'
scratch.mkdir(parents=True, exist_ok=True)
env = os.environ.copy()
env.update(TMPDIR=str(scratch), TMP=str(scratch), TEMP=str(scratch),
           npm_config_cache=str(root / '.cache/npm'),
           PATH=str(root / 'node_modules/.bin') + os.pathsep + env['PATH'])
record = json.loads((root / 'docs/evidence/2026-11-03-marketmerge/suites.json').read_text())
raise SystemExit(subprocess.run(shlex.split(record['command']), env=env).returncode)
PY
```

The merge is local. Nothing was pushed.
