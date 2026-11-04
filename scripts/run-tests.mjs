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
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { useRealTmpdir } from './run-tests-env.mjs'
import { testGroups, runTestFiles, stopActiveTests, summarize } from './run-test-files.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
// Every family gets the REAL temp folder: on macOS $TMPDIR is a link, which the browser profile code refuses.
useRealTmpdir(process.env)
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => { stopActiveTests().finally(() => process.exit(130)) })
}
const files = readdirSync(join(repoRoot, 'test'))
  .filter((name) => name.endsWith('.test.ts'))
  .map((name) => join('test', name))
const groups = testGroups(
  files.map((file) => ({ file, source: readFileSync(join(repoRoot, file), 'utf8') })),
)

const started = performance.now()
const results = []
for (const { label, files, ...options } of groups) {
  console.log(`\n[run-tests] ${label}: ${files.length} files, ${options.concurrency} workers`)
  results.push(...await runTestFiles(files, { ...options, cwd: repoRoot }))
}
console.log(`\n${summarize(results, ((performance.now() - started) / 1000).toFixed(1))}`)
if (results.some((result) => result.code !== 0)) {
  console.error('\n[run-tests] FAILED')
  process.exitCode = 1
} else console.log('\n[run-tests] both families green')
