# File identity comparison guard

The starting checkout still contained plain device and inode comparisons and had no guard against new sites. The checked-in baseline records 37 comparison occurrences in 14 lib files. Product code, dependency manifests and lock files are unchanged.

The guard recursively parses JavaScript and TypeScript sources under lib, including the browser profile core. It checks equality, inequality and ordering comparisons involving dev or ino property reads, including optional and literal bracket access, either operand, casts and numeric conversions. Comments, strings and type-name comparisons do not count. The allow list identifies each comparison by relative file and printed expression, with an occurrence budget. New files, changed expressions and duplicate copies fail. Line shifts and comments do not require a baseline refresh.

The test pins the exact allow-list length with ALLOWED_SITE_COUNT = 37. Adding an allowance therefore also requires an explicit edit to the test constant. Every allowance must match an existing occurrence in lib: fixed sites and surplus duplicate allowances fail until their entries are removed. A fix must remove its allowance and lower the pinned count together, leaving no unused credit.

This is a conservative syntax guard without type inference or data-flow analysis. It does not follow aliases or destructured bindings, resolve dynamic property keys, or detect comparisons implemented through calls or switch cases. Inline comparisons still count when wrapped in conversions. The existing email identity helper remains unchanged.

## Validation

- guard-red.log: two temporary mutants exercise the real repository guard. Adding a comparison and its allowance fails because 38 differs from the pinned 37. Deleting the inode comparison in checkpoint-store.js fails with its exact unused allowance and an instruction to remove it. Each mutant has a passing control: explicitly raise the count for growth, or remove the stale entry and lower the count for a fix. All temporary edits are restored byte for byte in finally blocks.
- guard-green.log: after restoration, all eight guard and scanner checks pass.
- full-suite.log: npm test exits 0 with 11,415 passed, zero failed and 62 skipped across 505 files in 2009.9 seconds. Family worker settings, final totals and exit status are retained; per-file output and passing fixture diagnostics are omitted.
- typecheck.log: npm run build exits 0.

The full run uses RUN_TESTS_WORKERS=2 and nice value 15. The runner serializes Chromium, daemon and runner regression groups at one worker and sets Bun test concurrency to one within each file. Validation uses Node 26.4.0, Bun 1.3.14, locked dependencies and the existing system browser. Test scratch data and the configured browser cache are directed to a short system temporary folder outside the checkout to fit Unix socket pathname limits.

## Reproduce

```sh
validation_dir=$(mktemp -d /tmp/file-identity.XXXXXX)
trap 'rm -rf "$validation_dir"' EXIT
mkdir -p "$validation_dir/tmp" "$validation_dir/browsers"
export TMPDIR="$validation_dir/tmp" PLAYWRIGHT_BROWSERS_PATH="$validation_dir/browsers"
export TSX_DISABLE_CACHE=1 NODE_DISABLE_COMPILE_CACHE=1 RUN_TESTS_WORKERS=2
npm ci --cache "$validation_dir/npm-cache" --no-audit --no-fund
node --import tsx --test --test-concurrency=2 test/file-identity.guard.test.ts
nice -n 15 npm test
npm run build
```

To repeat the growth mutant, temporarily create lib/file-identity-guard-scratch.mjs with this line and append `"lib/file-identity-guard-scratch.mjs: a.ino === b.ino"` to the allow list:

```js
export const same = (a, b) => a.ino === b.ino
```

Run the guard command above: only the pinned-count check fails. Temporarily changing ALLOWED_SITE_COUNT to 38 makes all eight checks pass. Restore the constant, list and scratch file.

To repeat the stale allowance mutant, temporarily delete ` && a.ino === b.ino` from `_sameFile` in lib/browser-profile-core/checkpoint-store.js, keeping the allow list unchanged. Run the guard: the repository check fails and names the unused entry. Removing that entry and lowering ALLOWED_SITE_COUNT to 36 makes all eight checks pass. Restore the source, list and constant before the final positive checks. These mutants exercise syntax scanning only and are never retained as product changes.

Local absolute paths in the negative-proof stack are replaced with <checkout>. Trailing whitespace in the captured diagnostic is removed.
