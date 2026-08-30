import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  EXIT_CODE,
  decideVersionBump,
  isAdvance,
  isShippingPath,
  parseSemver,
} from '../scripts/check-version-bump.mjs'
// The gate is only useful if it accepts what the machines can act on, so the
// parity test below compares it against the real runtime parser rather than
// against a copy of the regex that could drift out from under it.
import { parseSemver as runtimeParseSemver } from '../lib/update-planner.mjs'

test('passes when the version advances and both manifests agree', () => {
  const r = decideVersionBump({
    headPkg: '0.38.6',
    headManifest: '0.38.6',
    basePkg: '0.38.5',
    changedPaths: ['server.ts'],
  })
  assert.equal(r.verdict, 'ok')
})

test('fails when shipping code changed but the version did not advance', () => {
  const r = decideVersionBump({
    headPkg: '0.38.5',
    headManifest: '0.38.5',
    basePkg: '0.38.5',
    changedPaths: ['server.ts'],
  })
  assert.equal(r.verdict, 'not-advanced')
})

test('fails when package.json and plugin.json disagree', () => {
  const r = decideVersionBump({
    headPkg: '0.38.6',
    headManifest: '0.38.5',
    basePkg: '0.38.5',
    changedPaths: ['server.ts'],
  })
  assert.equal(r.verdict, 'mismatch')
})

test('a docs-only PR does not need a bump', () => {
  const r = decideVersionBump({
    headPkg: '0.38.5',
    headManifest: '0.38.5',
    basePkg: '0.38.5',
    changedPaths: ['README.md', 'docs/learnings/x.md'],
  })
  assert.equal(r.verdict, 'no-shipping-change')
})

test('a lower version is not an advance', () => {
  const r = decideVersionBump({
    headPkg: '0.38.4',
    headManifest: '0.38.4',
    basePkg: '0.38.5',
    changedPaths: ['lib/slash-catalog.ts'],
  })
  assert.equal(r.verdict, 'not-advanced')
})

test('shipping paths are distinguished from repo furniture', () => {
  assert.equal(isShippingPath('server.ts'), true)
  assert.equal(isShippingPath('lib/slash-catalog.ts'), true)
  assert.equal(isShippingPath('bin/hoai-core.mjs'), true)
  assert.equal(isShippingPath('docs/learnings/x.md'), false)
  assert.equal(isShippingPath('test/foo.test.ts'), false)
  assert.equal(isShippingPath('.github/workflows/tests.yml'), false)
})

test('isAdvance refuses unparseable input rather than guessing', () => {
  assert.equal(isAdvance('not-a-version', '0.38.5'), false)
  assert.equal(isAdvance('0.38.6', ''), false)
})

// A real pull request rarely changes only one kind of file: it ships code AND
// updates the test beside it AND touches a README. Nothing above passed a MIXED
// list, so the predicate that reduces the list to a yes or no was unpinned:
// swapping `.some(isShippingPath)` for `.every(isShippingPath)` left all seven
// tests green while turning "ships code and docs" from not-advanced into
// no-shipping-change, which is a version freeze waved straight through.
test('a mixed pull request that ships code needs a bump, whatever else it touches', () => {
  const r = decideVersionBump({
    headPkg: '0.38.5',
    headManifest: '0.38.5',
    basePkg: '0.38.5',
    changedPaths: ['server.ts', 'test/version-bump.test.ts', 'README.md'],
  })
  assert.equal(r.verdict, 'not-advanced')
})

test('the same mixed pull request passes once the version advances', () => {
  const r = decideVersionBump({
    headPkg: '0.38.6',
    headManifest: '0.38.6',
    basePkg: '0.38.5',
    changedPaths: ['server.ts', 'test/version-bump.test.ts', 'README.md'],
  })
  assert.equal(r.verdict, 'ok')
})

// The comparison must be numeric, not lexicographic. This repo is at 0.38.x and
// the very next boundary it crosses is 0.38.9 to 0.38.10, where string ordering
// says '0.38.10' < '0.38.9' and would reject a legitimate release.
test('0.38.10 advances on 0.38.9, so ordering is numeric and not lexicographic', () => {
  assert.equal(isAdvance('0.38.10', '0.38.9'), true)
  assert.equal(isAdvance('0.38.9', '0.38.10'), false)
  assert.equal(isAdvance('0.9.0', '0.10.0'), false)
  assert.equal(isAdvance('1.0.0', '0.99.99'), true)
})

// Versions the gate must judge the same way the machines do. A string the gate
// waves through but lib/update-planner.mjs cannot parse is the worst outcome
// available: the release merges, and every daemon's planner skips it as
// invalid-version, so the whole fleet stays on the old code. That is precisely
// the silent freeze this gate exists to make impossible.
const VERSION_STRINGS = [
  '0.38.6',
  '1.0.0',
  '0.0.0',
  '10.20.30',
  'v0.38.6',
  '0.38.6-rc.1',
  '0.38.6+build.1',
  '0.38.6 ',
  ' 0.38.6',
  '0.38.06',
  '0.38.6.7',
  '0.38.6abc',
  '99999999999999999999.0.0',
  '0.38',
  '',
  'not-a-version',
]

test('the gate accepts exactly the versions the runtime can act on', () => {
  for (const value of VERSION_STRINGS) {
    assert.equal(
      parseSemver(value) !== null,
      runtimeParseSemver(value) !== null,
      `gate and lib/update-planner.mjs disagree about ${JSON.stringify(value)}`,
    )
  }
})

test('a non-string version is rejected rather than coerced', () => {
  assert.equal(parseSemver(null), null)
  assert.equal(parseSemver(undefined), null)
  assert.equal(parseSemver(38), null)
})

test('a pre-release version the daemons cannot parse does not pass the gate', () => {
  const r = decideVersionBump({
    headPkg: '0.38.6-rc.1',
    headManifest: '0.38.6-rc.1',
    basePkg: '0.38.5',
    changedPaths: ['server.ts'],
  })
  assert.equal(r.verdict, 'not-advanced')
})

// ---------------------------------------------------------------------------
// The CLI half.
//
// Everything above exercises decideVersionBump, which is pure and cheap to
// test. The half that actually runs in CI was untested: argv parsing, the exit
// code, the GitHub annotation, and the guard that keeps an import from running
// the script. A mutation in any of those merges green, and a gate that cannot
// fail is worse than no gate, because it is a green check that means nothing.
// An exit code can only be observed from outside, so these spawn the real file.
// ---------------------------------------------------------------------------

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const gatePath = join(repoRoot, 'scripts', 'check-version-bump.mjs')

// scripts/run-tests.mjs requires bun anyway, but this file is also run alone.
const bunAvailable = spawnSync('bun', ['--version'], { encoding: 'utf8' }).status === 0

function gateArgs(headPkg: string, headManifest: string, basePkg: string, changed: string) {
  return [
    '--head-pkg', headPkg,
    '--head-manifest', headManifest,
    '--base-pkg', basePkg,
    '--changed', changed,
  ]
}

function runGate(args: string[], command: string = process.execPath) {
  return spawnSync(command, [gatePath, ...args], { encoding: 'utf8' })
}

const ANNOTATION = '::error file=package.json::'

// Asserted as literals on purpose. The CLI reads EXIT_CODE, so a test that also
// read EXIT_CODE would agree with any mutation of it and pin nothing.
test('CLI: the exit-code table is the one CI depends on', () => {
  assert.deepEqual(EXIT_CODE, {
    ok: 0,
    'no-shipping-change': 0,
    mismatch: 1,
    'not-advanced': 1,
  })
})

test('CLI: an advancing version exits 0 and raises no annotation', () => {
  const r = runGate(gateArgs('0.38.6', '0.38.6', '0.38.5', 'server.ts'))
  assert.equal(r.status, 0)
  assert.ok(r.stdout.startsWith('ok: '), `expected an ok verdict, got ${JSON.stringify(r.stdout)}`)
  assert.ok(!r.stdout.includes(ANNOTATION), 'a passing run must not annotate the file')
})

test('CLI: a documentation-only change exits 0 and raises no annotation', () => {
  const r = runGate(gateArgs('0.38.5', '0.38.5', '0.38.5', 'README.md\ndocs/learnings/x.md'))
  assert.equal(r.status, 0)
  assert.ok(r.stdout.startsWith('no-shipping-change: '), `got ${JSON.stringify(r.stdout)}`)
  assert.ok(!r.stdout.includes(ANNOTATION), 'a passing run must not annotate the file')
})

test('CLI: a frozen version exits 1 and annotates package.json', () => {
  const r = runGate(gateArgs('0.38.5', '0.38.5', '0.38.5', 'server.ts'))
  assert.equal(r.status, 1)
  assert.ok(r.stdout.startsWith(`${ANNOTATION}not-advanced: `), `got ${JSON.stringify(r.stdout)}`)
})

test('CLI: two disagreeing manifests exit 1 and annotate package.json', () => {
  const r = runGate(gateArgs('0.38.6', '0.38.5', '0.38.5', 'server.ts'))
  assert.equal(r.status, 1)
  assert.ok(r.stdout.startsWith(`${ANNOTATION}mismatch: `), `got ${JSON.stringify(r.stdout)}`)
})

// The workflow hands --changed one blob of newline separated paths, so the
// split is load bearing. Documentation comes first here deliberately: without
// the split the whole blob is one path that starts with docs/, the gate calls
// it repo furniture, and a pull request that ships server.ts sails through.
test('CLI: --changed is split into one path per line', () => {
  const r = runGate(gateArgs('0.38.5', '0.38.5', '0.38.5', 'docs/a.md\nserver.ts'))
  assert.equal(r.status, 1)
  assert.ok(r.stdout.startsWith(`${ANNOTATION}not-advanced: `), `got ${JSON.stringify(r.stdout)}`)
})

test('CLI: bun runs the gate the same way node does', { skip: !bunAvailable && 'bun is not on PATH' }, () => {
  const r = runGate(gateArgs('0.38.5', '0.38.5', '0.38.5', 'server.ts'), 'bun')
  assert.equal(r.status, 1)
  assert.ok(r.stdout.startsWith(`${ANNOTATION}not-advanced: `), `got ${JSON.stringify(r.stdout)}`)
})

// The module is imported by this test file, so the CLI must not fire on import.
// The importer is deliberately NAMED check-version-bump.mjs while sitting at the
// root of a temporary directory: the correct guard requires the scripts/ parent
// and stays quiet, so a guard weakened to match the bare filename fires here.
// The arguments would produce a failing verdict, which means a guard that runs
// when it should not cannot hide behind a quiet exit 0.
test('CLI: importing the module never runs it, under node and bun', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'version-bump-import-'))
  try {
    const importer = join(dir, 'check-version-bump.mjs')
    await writeFile(
      importer,
      `import ${JSON.stringify(pathToFileURL(gatePath).href)}\nconsole.log('imported-quietly')\n`,
      'utf8',
    )
    const runtimes = bunAvailable ? [process.execPath, 'bun'] : [process.execPath]
    for (const runtime of runtimes) {
      const r = spawnSync(
        runtime,
        [importer, ...gateArgs('0.38.5', '0.38.5', '0.38.5', 'server.ts')],
        { encoding: 'utf8' },
      )
      assert.equal(r.status, 0, `${runtime}: import must not exit non-zero`)
      assert.equal(
        r.stdout,
        'imported-quietly\n',
        `${runtime}: import must print nothing of its own, got ${JSON.stringify(r.stdout)}`,
      )
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// The workflow is the only caller, and it is not covered by any other test, so
// the one flag it cannot lose is pinned here. Without core.quotePath=false git
// escapes a path holding a non-ASCII byte into "docs/caf\303\251.md", which
// starts with a quote character, matches none of the non-shipping patterns, and
// turns a documentation-only pull request into a hard failure. Reproduced in a
// scratch repo: exit 1 without the flag, exit 0 with it.
test('the workflow asks git not to escape non-ASCII paths', async () => {
  const { readFile } = await import('node:fs/promises')
  const workflow = await readFile(join(repoRoot, '.github', 'workflows', 'version-check.yml'), 'utf8')
  assert.ok(
    workflow.includes('git -c core.quotePath=false diff --name-only'),
    'the changed-file list must be read with core.quotePath=false',
  )
})

// Pinned as source text because this hazard is invisible from inside a test
// run. process.exit() at module scope takes down whatever imported the file,
// including this test runner: with the argv guard mutated, node reported
// "tests 1, pass 1, fail 0" and a zero status, having run not one test in this
// file. No assertion can catch that from inside the process it kills, so the
// shape that makes it impossible is pinned instead.
test('the CLI sets an exit code instead of calling process.exit', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(gatePath, 'utf8')
  // Comment lines are stripped first, because the comment explaining this rule
  // has to be allowed to name the call it forbids.
  const code = source
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n')
  assert.ok(
    code.includes('process.exitCode = code'),
    'the CLI must set process.exitCode',
  )
  assert.ok(
    !/process\.exit\(/.test(code),
    'process.exit() at module scope kills any importer, including the test runner',
  )
})
