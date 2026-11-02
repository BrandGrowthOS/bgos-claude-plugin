# Idle rollback test litter

Lane rbtlitter, board row 3dc5a343. Branch fix/idle-rollback-test-litter, stacked on #291.

## Before

`test/self-update.idle-rollback.test.ts` made its scratch folders under
`process.env.TEMP || process.env.TMPDIR || '.'`. With neither variable set, that is the working
tree. Every test made two folders (`idle-rollback-root-*`, `idle-rollback-state-*`) and nothing
removed them. A full `npm test` on a clean tree left 14 folders (7 tests, 2 each):

- 7 `idle-rollback-state-*` folders, each with an `auto-update.json`. `git status` shows these.
- 7 `idle-rollback-root-*` folders, each holding an empty `.git` folder (two also hold
  `bgos-auto-update-disabled.json`). `git status` does NOT show these, so they were silent litter.

No other test left anything in the tree in that run. (`test/idle-update.integration.test.ts` has
the same `|| '.'` fallback but removes its folders itself, so it did not litter; it would leak
only if a test failed before its rmSync. Left alone, not asked.)

## After

Scratch folders come from `fs.mkdtempSync(path.join(os.tmpdir(), prefix))`, which never falls back
to the working tree. An `afterEach` removes them after every test, passed or failed. An `after`
guard fails the file if any scratch folder was made inside the repo tree or still exists.

## Proof

- Red: guard added with the old folder logic, run with TEMP and TMPDIR unset: failed, listing 14
  folders created inside the tree.
- Green: same run after the fix passes 7 of 7, nothing left in the tree or the temp folder.
- Cleanup survives a failure: with one assertion broken on purpose, the run failed and still left
  0 folders (the break was reverted).

## Not changed

Outside the tree, many other tests leave folders in the OS temp folder (531 entries after one full
run). That does not touch `git status`, so it is out of scope here.
