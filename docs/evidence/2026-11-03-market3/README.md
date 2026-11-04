# Market3 verification evidence

All commands ran from this checkout. Test runs set TMPDIR to `.test-tmp` inside the checkout. Existing local dependencies were used with Node v26.0.0 and Bun 1.3.14 on macOS. Test runners use at most four workers.

## Before the fix

Baseline, 76 passed, 0 failed:

```sh
mkdir -p .test-tmp
TMPDIR="$PWD/.test-tmp" node_modules/.bin/tsx --test --test-concurrency=4 \
  test/marketplace-attach.e2e.test.ts test/marketplace-attach.test.ts \
  test/attach-scope.test.ts test/attach-scope.launcher.test.ts \
  test/attach-scope.e2e.test.ts
```

Output: `baseline.log`.

The new end-to-end regression was red before any production edit. The real launcher announced legacy agent 41. After the real manifest supplied configured agent 42, the real daemon went dormant and the assertion that its MCP tool list includes `reply` failed. Exit 1, 1 failed:

```sh
TMPDIR="$PWD/.test-tmp" node_modules/.bin/tsx --test --test-concurrency=4 \
  --test-name-pattern='market3 launcher' test/marketplace-attach.e2e.test.ts
```

Output: `red-manifest-identity.log`.

The new folder-only intent test and the two updated contract assertions were also red before the production edit. Exit 1, 3 failed. The old launcher still guessed 871; the daemon classified fresh folder-only intent as unscoped:

```sh
TMPDIR="$PWD/.test-tmp" node_modules/.bin/tsx --test --test-concurrency=4 \
  --test-name-pattern='market3 scope|an unpinned launch|the launcher is recorded' \
  test/attach-scope.test.ts test/attach-scope.launcher.test.ts
```

Output: `red-launch-intent.log`.

## After the fix

The same five-suite command passed 78 tests with 0 failed and 0 skipped. Output: `green-regression.log`. It includes all four previous launcher layouts with the actual manifest environment applied, the new configured-42 case, and the numeric wrong-agent refusal.

Typecheck:

```sh
npm run build
```

Output: `typecheck.log`. Exit 0.

Full mixed suite:

```sh
TMPDIR="$PWD/.test-tmp" npm test
```

Output: `green-full.log`. Exit 0: 8,237 passed, 52 skipped, 0 failed. Node: 7,852 passed, 47 skipped. Chromium: 11 passed, 4 skipped. Bun: 374 passed, 1 skipped. The repository runner sets node test concurrency to 4, real Chromium test concurrency to 1, and Bun max concurrency to 4; the groups run sequentially.

A separate read-only reviewer inspected the implementation, tests, and red/green evidence against the brief and found no actionable issues. No files or Git state were modified by that reviewer.

Saved log punctuation only: an existing test title used a Unicode dash in green-full.log. That dash is normalized to an ASCII hyphen to follow the brief. Trailing whitespace and extra blank lines at the end of saved logs are also removed for git diff checks. Test results and exit status are unchanged.
