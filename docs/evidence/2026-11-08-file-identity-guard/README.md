# File identity comparison guard

The starting checkout still contained plain device and inode comparisons and had no guard against new sites. The checked-in baseline records 37 comparison occurrences in 14 lib files. Product code, dependency manifests and lock files are unchanged.

The guard recursively parses JavaScript and TypeScript sources under lib, including the browser profile core. It checks equality, inequality and ordering comparisons involving dev or ino property reads, including optional and literal bracket access, either operand, casts and numeric conversions. Comments, strings and type-name comparisons do not count. The allow list identifies each comparison by relative file and printed expression, with an occurrence budget. New files, changed expressions and duplicate copies fail. Line shifts and comments do not require a baseline refresh. Existing entries are debt and must only be removed as sites are fixed. Per the brief, this does not add a historical Git check for allow-list growth.

This is a conservative syntax guard without type inference or data-flow analysis. It does not follow values through local aliases or discover comparisons hidden inside a generic helper. The existing email identity helper remains unchanged.

## Validation

- guard-red.log: adding one exported a.ino === b.ino comparison to lib/file-identity-guard-scratch.mjs makes the real repository guard exit 1 and name that site. A finally block removes the scratch file.
- guard-green.log: after scratch removal, all seven guard and scanner checks pass.
- full-suite.log: npm test exits 0 with 11,414 passed, zero failed and 62 skipped across 505 files in 1867.2 seconds. The retained log contains every top-level file result, family worker settings and final totals; passing fixture diagnostics are omitted.
- typecheck.log: npm run build exits 0.
- code-map.log: required per-file and final changed-files queries, including their failures.

The full run used RUN_TESTS_WORKERS=2 and inherited nice value 15 (confirmed on the running test process). The runner serializes Chromium, daemon and runner regression groups at one worker and sets Bun test concurrency to one within each file. Node 26.4.0, Bun 1.3.14 and the existing system browser were used; npm ci installed the locked dependencies inside this checkout. Dependency installation used a checkout-local npm cache. Test scratch data and the configured browser cache were directed inside the checkout. No fetch, pull or push was run.

## Code map limitation and manual checks

scripts/codegraph/query.mjs is absent, so every required query exits 1 with MODULE_NOT_FOUND and returns no guards, mirrors, tests or contracts. The origin/main ref is also absent. The final exact command, node scripts/codegraph/query.mjs --changed origin/main, was attempted without fetching. The starting local HEAD is 76cb515b25c2336267abb832b8fab1b5774d4791.

Manual inspection confirmed that scripts/run-tests.mjs automatically collects this new top-level .test.ts file, scripts/run-test-files.mjs honors the two-worker environment setting, test/scratch-folder-convention.test.ts accepts the shared cleanup helper, and .gitattributes already enforces LF. Those files need no changes. There is no product or shared-contract change requiring a mirror update. No BRIEF or REPORT file is included in the commit.

## Reproduce

```sh
npm ci --cache .inoguard-work/npm-cache --no-audit --no-fund
mkdir -p .inoguard-work/tmp
TMPDIR="$PWD/.inoguard-work/tmp" TSX_DISABLE_CACHE=1 NODE_DISABLE_COMPILE_CACHE=1 RUN_TESTS_WORKERS=2 node --import tsx --test --test-concurrency=2 test/file-identity.guard.test.ts
TMPDIR="$PWD/.inoguard-work/tmp" TSX_DISABLE_CACHE=1 NODE_DISABLE_COMPILE_CACHE=1 RUN_TESTS_WORKERS=2 PLAYWRIGHT_BROWSERS_PATH="$PWD/.inoguard-work/browsers" npm test
npm run build
```

To repeat the negative proof, temporarily create lib/file-identity-guard-scratch.mjs with the single line below, run just the repository guard, and remove the file before the positive checks:

```js
export const same = (a, b) => a.ino === b.ino
```

```sh
TMPDIR="$PWD/.inoguard-work/tmp" TSX_DISABLE_CACHE=1 NODE_DISABLE_COMPILE_CACHE=1 RUN_TESTS_WORKERS=2 node --import tsx --test --test-concurrency=2 '--test-name-pattern=^lib has no new plain' test/file-identity.guard.test.ts
```

Local absolute paths in the negative-proof stack are replaced with <checkout>. Trailing whitespace in the captured diagnostic is removed.
