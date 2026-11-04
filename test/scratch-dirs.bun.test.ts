/**
 * test/helpers/scratch-dirs.ts under bun:test (board row c1ddf80c).
 *
 * `bun test` runs every file of a run in one process and never emits the process `exit` or `beforeExit` event,
 * so a helper that only sweeps on exit left every folder made by the six bun files in the temp folder. The
 * helper must reach bun's own afterAll hook as well. As in scratch-dirs.test.ts, the check is made from
 * outside: a real `bun test` child runs fixture files with TMPDIR, TEMP and TMP pointed at a folder of its
 * own, and that folder is looked at afterwards.
 */

import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')
const HELPER = pathToFileURL(join(HERE, 'helpers', 'scratch-dirs.ts')).href

function fixtureFile(name: string, testBody: string): string {
  return [
    `import { expect, test } from 'bun:test'`,
    `import { existsSync, writeFileSync } from 'node:fs'`,
    `import { join } from 'node:path'`,
    `import { scratchDir } from ${JSON.stringify(HELPER)}`,
    `test(${JSON.stringify(name)}, () => {`,
    `  const dir = scratchDir('bun-scratch-case-')`,
    `  writeFileSync(join(dir, 'file.txt'), 'x')`,
    `  expect(existsSync(dir)).toBe(true)`,
    testBody,
    `})`,
    '',
  ].join('\n')
}

function runBunChild(files: Record<string, string>): { status: number | null; output: string; left: string[]; privateTmp: string } {
  const privateTmp = realpathSync(mkdtempSync(join(tmpdir(), 'scratch-dirs-bun-case-')))
  const fixtures = realpathSync(mkdtempSync(join(tmpdir(), 'scratch-dirs-bun-fixtures-')))
  try {
    for (const [name, source] of Object.entries(files)) writeFileSync(join(fixtures, name), source)
    // This test's own files live next to the fixtures, outside privateTmp, so only the child's litter lands there.
    const run = spawnSync(process.execPath, ['test', ...Object.keys(files).map((name) => join(fixtures, name))], {
      cwd: REPO,
      encoding: 'utf8',
      env: { ...process.env, TMPDIR: privateTmp, TEMP: privateTmp, TMP: privateTmp },
      timeout: 60_000,
    })
    return { status: run.status, output: `${run.stdout}${run.stderr}`, left: readdirSync(privateTmp), privateTmp }
  } finally {
    rmSync(fixtures, { recursive: true, force: true })
    rmSync(privateTmp, { recursive: true, force: true })
  }
}

test('bun test files that pass leave no scratch folder in the temp folder', () => {
  const run = runBunChild({
    'one.test.ts': fixtureFile('one', ''),
    'two.test.ts': fixtureFile('two', ''),
  })
  expect(run.status, run.output).toBe(0)
  expect(run.left, run.output).toEqual([])
})

test('bun test files where a test fails still leave none, including the last file of the run', () => {
  const run = runBunChild({
    'one.test.ts': fixtureFile('one', ''),
    'two.test.ts': fixtureFile('two fails', `  throw new Error('boom')`),
    'three.test.ts': fixtureFile('three', ''),
  })
  expect(run.status, run.output).not.toBe(0)
  expect(run.output).toContain('boom')
  expect(run.left, run.output).toEqual([])
})

test('a fixture really does make a folder (the check above can fail)', () => {
  // Same child, but the folder is made with plain mkdtemp: it must show up, or "left is empty" proves nothing.
  const privateTmp = realpathSync(mkdtempSync(join(tmpdir(), 'scratch-dirs-bun-control-')))
  const fixtures = realpathSync(mkdtempSync(join(tmpdir(), 'scratch-dirs-bun-control-fixtures-')))
  try {
    mkdirSync(join(fixtures, 'x'))
    writeFileSync(
      join(fixtures, 'leaky.test.ts'),
      [
        `import { expect, test } from 'bun:test'`,
        `import { mkdtempSync } from 'node:fs'`,
        `import { tmpdir } from 'node:os'`,
        `import { join } from 'node:path'`,
        `test('leaks', () => { expect(mkdtempSync(join(tmpdir(), 'bun-control-leak-'))).toBeTruthy() })`,
        '',
      ].join('\n'),
    )
    const run = spawnSync(process.execPath, ['test', join(fixtures, 'leaky.test.ts')], {
      cwd: REPO,
      encoding: 'utf8',
      env: { ...process.env, TMPDIR: privateTmp, TEMP: privateTmp, TMP: privateTmp },
      timeout: 60_000,
    })
    expect(run.status, `${run.stdout}${run.stderr}`).toBe(0)
    expect(readdirSync(privateTmp).filter((name) => name.startsWith('bun-control-leak-'))).toHaveLength(1)
  } finally {
    rmSync(fixtures, { recursive: true, force: true })
    rmSync(privateTmp, { recursive: true, force: true })
  }
})
