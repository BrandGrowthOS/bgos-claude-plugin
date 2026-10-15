#!/usr/bin/env node
/**
 * Test orchestrator for a genuinely mixed suite.
 *
 * This repo carries two test families that no single runner can execute:
 *   - node:test files (the majority), which need tsx (bare `node --test`
 *     cannot even parse several lib sources: TS parameter properties in
 *     strip-only mode, and `.js` specifiers that resolve to `.ts` files);
 *   - bun:test files (six, e.g. health-log, self-update), whose `bun:`
 *     scheme imports no node loader will ever serve.
 *
 * Before this script, `npm test` pointed at bare `node --test` and had
 * therefore NEVER been able to run the whole suite anywhere; the first CI
 * run simply made that visible. Files are partitioned by inspecting their
 * source for a bun:test import, so a new test file lands in the right
 * family automatically.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const testDir = join(repoRoot, 'test')

const files = readdirSync(testDir)
  .filter((name) => name.endsWith('.test.ts'))
  .map((name) => join('test', name))

const bunFiles = []
const nodeFiles = []
for (const file of files) {
  const source = readFileSync(join(repoRoot, file), 'utf8')
  if (/from\s+['"]bun:test['"]/.test(source)) bunFiles.push(file)
  else nodeFiles.push(file)
}

console.log(`[run-tests] ${nodeFiles.length} node:test files via tsx, ${bunFiles.length} bun:test files via bun`)

function run(label, command, args) {
  console.log(`\n[run-tests] ${label}: ${command} ${args.slice(0, 3).join(' ')} ... (${args.length} args)`)
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  return result.status ?? 1
}

// On Windows `shell: true` sends the command through cmd.exe, which refuses a
// line over 8,191 characters with "The syntax of the command is incorrect."
// and runs nothing. The node:test family crossed that at about 262 files
// (PR #235's Windows job), so there it runs in batches that each stay well
// under the limit. Elsewhere it stays one run, as before.
const CMD_LINE_BUDGET = 7000

function batches(list, prefixLength) {
  if (process.platform !== 'win32') return list.length ? [list] : []
  const out = []
  let current = []
  let length = prefixLength
  for (const file of list) {
    if (current.length && length + file.length + 1 > CMD_LINE_BUDGET) {
      out.push(current)
      current = []
      length = prefixLength
    }
    current.push(file)
    length += file.length + 1
  }
  if (current.length) out.push(current)
  return out
}

let nodeStatus = 0
const nodeBatches = batches(nodeFiles, 'npx tsx --test'.length)
nodeBatches.forEach((batch, i) => {
  const label = nodeBatches.length > 1 ? `node:test family, batch ${i + 1} of ${nodeBatches.length}` : 'node:test family'
  const status = run(label, 'npx', ['tsx', '--test', ...batch])
  if (status !== 0) nodeStatus = status
})
const bunStatus = bunFiles.length
  ? run('bun:test family', 'bun', ['test', ...bunFiles])
  : 0

if (nodeStatus !== 0 || bunStatus !== 0) {
  console.error(`\n[run-tests] FAILED (node family exit ${nodeStatus}, bun family exit ${bunStatus})`)
  process.exit(1)
}
console.log('\n[run-tests] both families green')
