#!/usr/bin/env node
/**
 * Test orchestrator for a genuinely mixed suite.
 *
 * This repo carries two test families that no single runner can execute:
 *   - node:test files (the majority), which need tsx (bare `node --test`
 *     cannot even parse several lib sources: TS parameter properties in
 *     strip-only mode, and `.js` specifiers that resolve to `.ts` files);
 *   - bun:test files (e.g. health-log, self-update), whose `bun:` scheme
 *     imports no node loader will ever serve.
 *
 * Files are partitioned by inspecting their source for a bun:test import, so a
 * new test file lands in the right family automatically. Each file runs in its
 * own bounded worker (scripts/run-test-files.mjs). One filename per direct spawn
 * also removes Windows cmd.exe's command-line limit and .cmd shell quoting.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { useRealTmpdir } from './run-tests-env.mjs'
import { testGroups, runTestFiles, stopActiveTests, summarize, focusesATest, testWorkerLimit } from './run-test-files.mjs'
import { snapshotWorkingTree } from './test-tree-snapshot.mjs'

// `npm test` runs this repository. Another folder is how test/run-tests-timeout.test.ts runs this script for real.
const repoRoot = process.argv[2] ? resolve(process.argv[2]) : join(dirname(fileURLToPath(import.meta.url)), '..')
// Every family gets the REAL temp folder: on macOS $TMPDIR is a link, which the browser profile code refuses.
useRealTmpdir(process.env)
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => { stopActiveTests().finally(() => process.exit(130)) })
}
const files = readdirSync(join(repoRoot, 'test'))
  .filter((name) => name.endsWith('.test.ts'))
  .map((name) => join('test', name))
const entries = files.map((file) => ({ file, source: readFileSync(join(repoRoot, file), 'utf8') }))
const groups = testGroups(entries)
// A family with no files proved nothing, so a run that found none is not green. This cannot see one deleted file.
const emptyFamilies = ['node', 'bun'].filter((family) => !groups.some((group) => group.family === family && group.files.length > 0))
const focused = new Set(entries.filter(({ source }) => focusesATest(source)).map(({ file }) => file))

// A test of this runner meets the file deadline with this, in seconds and not 270 s. Nothing else sets it.
const fileDeadlineMs = Number(process.env.RUN_TESTS_FILE_DEADLINE_MS)

// What the tree holds before any file runs. A scan that fails here fails the run, as an uncaught error.
const pathsBefore = snapshotWorkingTree(repoRoot)

const started = performance.now()
const results = []
for (const file of focused) {
  const problem = 'focuses a test, which silently drops the rest of the file, so it was not run'
  console.log(`[run-tests] FAIL ${file}: ${problem}`)
  results.push({ file, code: 1, timedOut: false, tally: null, failures: [], problem })
}
for (const { label, files, ...options } of groups) {
  const toRun = files.filter((file) => !focused.has(file))
  options.concurrency = Math.min(options.concurrency, testWorkerLimit())
  console.log(`\n[run-tests] ${label}: ${toRun.length} files, ${options.concurrency} workers`)
  results.push(...await runTestFiles(toRun, { ...options, cwd: repoRoot, ...(fileDeadlineMs > 0 ? { timeoutMs: fileDeadlineMs } : {}) }))
}
// Every file ends in runTestFiles, a hung one as TIMED OUT, so a hang reaches this scan like any other file. Its
// kill is bounded, not sure: a tree still alive, or an orphan the kill could not find, can write after this scan
// or remove a folder during it, which fails the run below as a tree it could not read. A stop (SIGINT, SIGTERM)
// exits above and does not get here. The scan sees new paths: not a changed file, and not one that was already there.
const unreadable = []
const newPaths = [...snapshotWorkingTree(repoRoot, (error) => unreadable.push(error))].filter((path) => !pathsBefore.has(path)).sort()
console.log(`\n${summarize(results, ((performance.now() - started) / 1000).toFixed(1))}`)
for (const family of emptyFamilies) console.error(`[run-tests] no ${family} test files in ${join(repoRoot, 'test')}`)
if (newPaths.length > 0) console.error(`\n[run-tests] the run left ${newPaths.length} new paths in the working tree:`)
for (const path of newPaths) console.error(`[run-tests] NEW PATH: ${JSON.stringify(path)}`)
for (const error of unreadable) console.error(`\n[run-tests] could not read the working tree after the run, so it cannot say no test left a file: ${error.message}`)
if (emptyFamilies.length > 0 || results.some((result) => result.problem) || newPaths.length > 0 || unreadable.length > 0) {
  console.error('\n[run-tests] FAILED')
  process.exitCode = 1
} else console.log('\n[run-tests] both families green')
