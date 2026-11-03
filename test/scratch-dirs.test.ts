/**
 * test/helpers/scratch-dirs.ts: a test's scratch folders under the OS temp folder go away with the test
 * process, whether the test passed, threw or called process.exit (board row c1ddf80c).
 *
 * Each case runs a real child process with TMPDIR, TEMP and TMP pointed at a folder of its own, so what is
 * left there is exactly what the child made, and then looks at that folder from outside.
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const HELPER = pathToFileURL(join(HERE, 'helpers', 'scratch-dirs.ts')).href

type Child = { status: number | null; stdout: string; stderr: string; left: string[]; privateTmp: string }

/** Runs `body` (module source that may use scratchDir, removeScratchDir, fs helpers) in a child with its own temp folder. */
function inChild(body: string, extraEnv: Record<string, string> = {}): Child {
  const privateTmp = realpathSync(mkdtempSync(join(tmpdir(), 'scratch-dirs-case-')))
  try {
    const script = [
      `import { scratchDir, removeScratchDir } from ${JSON.stringify(HELPER)}`,
      `import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'`,
      `import { tmpdir } from 'node:os'`,
      `import { join } from 'node:path'`,
      body,
    ].join('\n')
    const env = { ...process.env, TMPDIR: privateTmp, TEMP: privateTmp, TMP: privateTmp, ...extraEnv }
    const run = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      encoding: 'utf8',
      env,
      timeout: 60_000,
    })
    // tsx keeps its own cache folder in the temp folder; it is the tool's, not the test's.
    const left = readdirSync(privateTmp).filter((name) => !name.startsWith('tsx-'))
    return { status: run.status, stdout: run.stdout, stderr: run.stderr, left, privateTmp }
  } finally {
    rmSync(privateTmp, { recursive: true, force: true })
  }
}

const MAKE_TWO = `
const a = scratchDir('scratch-case-a-')
writeFileSync(join(a, 'file.txt'), 'x')
mkdirSync(join(a, 'nested', 'deeper'), { recursive: true })
writeFileSync(join(a, 'nested', 'deeper', 'file.txt'), 'y')
const b = scratchDir('scratch-case-b-')
console.log(JSON.stringify({ a, b, tmp: tmpdir() }))
`

test('a scratch folder is made under the OS temp folder, and a test that finishes leaves none', () => {
  const run = inChild(MAKE_TWO)
  assert.equal(run.status, 0, run.stderr)
  const made = JSON.parse(run.stdout.trim()) as { a: string; b: string; tmp: string }
  assert.equal(made.tmp, run.privateTmp, 'the child honoured TMPDIR')
  assert.ok(made.a.startsWith(made.tmp) && made.a.includes('scratch-case-a-'), made.a)
  assert.ok(made.b.startsWith(made.tmp) && made.b.includes('scratch-case-b-'), made.b)
  assert.notEqual(made.a, made.b)
  assert.deepEqual(run.left, [])
})

test('a test that throws still leaves none', () => {
  const run = inChild(`${MAKE_TWO}\nthrow new Error('boom')`)
  assert.notEqual(run.status, 0)
  assert.match(run.stderr, /boom/)
  assert.deepEqual(run.left, [])
})

test('a test that calls process.exit still leaves none', () => {
  const run = inChild(`${MAKE_TWO}\nprocess.exit(3)`)
  assert.equal(run.status, 3)
  assert.deepEqual(run.left, [])
})

test('removeScratchDir removes at once, twice is fine, and the exit sweep then has nothing to trip over', () => {
  const run = inChild(`
const a = scratchDir('scratch-case-early-')
writeFileSync(join(a, 'file.txt'), 'x')
removeScratchDir(a)
const goneAtOnce = !existsSync(a)
removeScratchDir(a)
console.log(JSON.stringify({ goneAtOnce }))
`)
  assert.equal(run.status, 0, run.stderr)
  assert.deepEqual(JSON.parse(run.stdout.trim()), { goneAtOnce: true })
  assert.deepEqual(run.left, [])
})

test('a folder the test already removed itself, or turned into a file, does not fail the exit sweep', () => {
  const run = inChild(`
import { rmSync } from 'node:fs'
const a = scratchDir('scratch-case-self-')
rmSync(a, { recursive: true, force: true })
const b = scratchDir('scratch-case-file-')
rmSync(b, { recursive: true, force: true })
writeFileSync(b, 'now a file')
`)
  assert.equal(run.status, 0, run.stderr)
  assert.equal(run.stderr.trim(), '')
  assert.deepEqual(run.left, [])
})

test('a test that chdir-ed into its scratch folder still leaves none', () => {
  const run = inChild(`
const a = scratchDir('scratch-case-cwd-')
mkdirSync(join(a, 'inner'))
process.chdir(join(a, 'inner'))
`)
  assert.equal(run.status, 0, run.stderr)
  assert.deepEqual(run.left, [])
})

test('a link inside a scratch folder is removed as a link, never followed into what it points at', () => {
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'scratch-dirs-outside-')))
  try {
    writeFileSync(join(outside, 'precious.txt'), 'keep me')
    const run = inChild(`
const a = scratchDir('scratch-case-link-')
symlinkSync(process.env.OUTSIDE, join(a, 'link'), 'junction')
`, { OUTSIDE: outside })
    assert.equal(run.status, 0, run.stderr)
    assert.deepEqual(run.left, [])
    assert.ok(existsSync(join(outside, 'precious.txt')), 'what the link pointed at is still there')
  } finally {
    rmSync(outside, { recursive: true, force: true })
  }
})
