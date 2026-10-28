#!/usr/bin/env node
/**
 * The mutants for the idle update (docs/idle-update/mutants.json): each one
 * breaks ONE rule in the source, alone, runs only the test files it names,
 * and must turn them red (killed). The source is put back after every mutant,
 * and checked byte for byte. First a baseline: every named file must pass on
 * the unmutated source, with more than 0 tests.
 *
 * usage (from the plugin root): node docs/idle-update/run-mutants.mjs [--only id1,id2] [--out file.json]
 * Exit 0 only when every mutant was killed. Exit 3 when a run counted 0 tests.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const args = process.argv.slice(2)
const flag = (name) => {
  const at = args.indexOf(name)
  return at >= 0 ? args[at + 1] : null
}
const only = flag('--only')?.split(',').filter(Boolean) ?? null
const outPath = flag('--out')

const all = JSON.parse(readFileSync(join(root, 'docs', 'idle-update', 'mutants.json'), 'utf8')).mutants
const mutants = only ? all.filter((m) => only.includes(m.id)) : all
if (mutants.length === 0) {
  console.error('[mutants] none selected')
  process.exit(2)
}

function runTests(files) {
  const res = spawnSync('npx', ['tsx', '--test', '--test-reporter=spec', '--test-concurrency=2', ...files], {
    cwd: root,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=3072' },
  })
  const out = `${res.stdout ?? ''}\n${res.stderr ?? ''}`.replace(/\r/g, '')
  const count = (label) => {
    const match = new RegExp(`^ℹ ${label} (\\d+)`, 'm').exec(out)
    return match ? Number(match[1]) : null
  }
  const failing = [...out.matchAll(/^✖ (.+?) \(\d/gm)].map((m) => m[1])
  return { status: res.status, tests: count('tests') ?? 0, fail: count('fail'), failing: [...new Set(failing)].slice(0, 5) }
}

// Put every touched file back, whatever stops this run.
const originals = new Map()
const restoreAll = () => {
  for (const [file, text] of originals) writeFileSync(join(root, file), text)
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    restoreAll()
    process.exit(130)
  })
}

const files = [...new Set(mutants.flatMap((m) => m.tests))]
console.log(`[mutants] ${mutants.length} mutants over ${files.length} named test files`)
const baseline = runTests(files)
console.log(`[mutants] baseline: exit ${baseline.status}, tests ${baseline.tests}, fail ${baseline.fail}`)
if (baseline.tests === 0) {
  console.error('[mutants] STOP: the baseline ran 0 tests')
  process.exit(3)
}
if (baseline.status !== 0) {
  console.error(`[mutants] STOP: the baseline is red: ${baseline.failing.join(' | ')}`)
  process.exit(1)
}

const results = []
let zero = false
for (const m of mutants) {
  const path = join(root, m.file)
  const original = readFileSync(path, 'utf8')
  const hits = original.split(m.find).length - 1
  if (hits !== 1) {
    results.push({ id: m.id, rule: m.rule, verdict: 'not_applied', reason: `the target occurs ${hits} times` })
    console.log(`[mutants] ${m.id}: NOT APPLIED (target occurs ${hits} times)`)
    continue
  }
  originals.set(m.file, original)
  let run
  try {
    writeFileSync(path, original.replace(m.find, () => m.replace))
    run = runTests(m.tests)
  } finally {
    writeFileSync(path, original)
    originals.delete(m.file)
  }
  if (readFileSync(path, 'utf8') !== original) {
    console.error(`[mutants] STOP: ${m.file} was not restored`)
    process.exit(4)
  }
  if (run.tests === 0) zero = true
  const verdict = run.tests === 0 ? 'no_tests' : run.status !== 0 && (run.fail ?? 0) > 0 ? 'killed' : 'survived'
  results.push({ id: m.id, rule: m.rule, file: m.file, tests: m.tests, verdict, testsRun: run.tests, failed: run.fail, failing: run.failing })
  console.log(`[mutants] ${m.id}: ${verdict.toUpperCase()} (tests ${run.tests}, fail ${run.fail})${run.failing.length ? ` e.g. ${run.failing[0]}` : ''}`)
}

const killed = results.filter((r) => r.verdict === 'killed').length
const summary = { baseline: { tests: baseline.tests, fail: baseline.fail }, mutants: results.length, killed, survived: results.filter((r) => r.verdict === 'survived').map((r) => r.id), notApplied: results.filter((r) => r.verdict === 'not_applied').map((r) => r.id), noTests: results.filter((r) => r.verdict === 'no_tests').map((r) => r.id), results }
if (outPath) writeFileSync(outPath, `${JSON.stringify(summary, null, 2)}\n`)
console.log(`[mutants] KILLED ${killed}/${results.length}; survived: ${summary.survived.join(', ') || 'none'}; not applied: ${summary.notApplied.join(', ') || 'none'}`)
if (zero) process.exit(3)
process.exit(killed === results.length ? 0 : 1)
