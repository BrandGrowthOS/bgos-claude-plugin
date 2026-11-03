/**
 * A test file that makes a folder with mkdtemp must also remove it (board row c1ddf80c).
 *
 * Seven test files were found, by review, still leaking: they skip on a machine without `expect`, or run only
 * on Windows, so a full run on a developer's machine never showed them and CI did. This reads the sources
 * instead of running them, so it holds on every platform: a file that calls mkdtemp or mkdtempSync has to use
 * the scratchDir helper (test/helpers/scratch-dirs.ts) or contain some removal of its own.
 *
 * It is a convention check, not a proof. A file with one remove and three leaking folders passes it; only a
 * look at the temp folder after a full run (ls it, with TMPDIR pointed at a fresh folder) sees those.
 */

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { test } from 'node:test'

const TEST_DIR = import.meta.dirname

/** Opt-in operator scripts that are never collected by npm test and keep their evidence on purpose. */
const KEEPS_ITS_FOLDER_ON_PURPOSE = new Set(['helpers/packaged-browser-bootstrap-smoke.ts'])

const REMOVAL = /\b(rmSync|rmdirSync|rimraf|removeScratchDir)\b|\.rm\(|\brm\(|Remove-Item|force:\s*true/

function sources(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sources(path))
    else if (/\.(ts|mjs|cjs|js)$/.test(entry.name)) out.push(path)
  }
  return out
}

/** The text with import lists blanked, so `mkdtempSync` in an import is not read as a call. */
function withoutImports(source: string): string {
  return source.replace(/import\s*\{[^}]*\}\s*from\s*['"][^'"]+['"]/g, '')
}

test('every test file that calls mkdtemp uses scratchDir or removes what it made', () => {
  const offenders: string[] = []
  for (const file of sources(TEST_DIR)) {
    const name = relative(TEST_DIR, file).split('\\').join('/')
    if (KEEPS_ITS_FOLDER_ON_PURPOSE.has(name)) continue
    const source = readFileSync(file, 'utf8')
    if (!/\bmkdtemp(Sync)?\(/.test(withoutImports(source))) continue
    if (source.includes('scratch-dirs')) continue
    if (REMOVAL.test(source)) continue
    offenders.push(name)
  }
  assert.deepEqual(offenders, [], `these files make a folder with mkdtemp and never remove it; use scratchDir from ./helpers/scratch-dirs.ts: ${offenders.join(', ')}`)
})

test('the convention check can fail: a source with a bare mkdtemp and no removal is an offender', () => {
  // The same three conditions as above, on text, so a loosened regex cannot make the check above pass for nothing.
  const bare = `import { mkdtempSync } from 'node:fs'\nconst d = mkdtempSync(join(tmpdir(), 'x-'))\n`
  assert.ok(/\bmkdtemp(Sync)?\(/.test(withoutImports(bare)))
  assert.ok(!bare.includes('scratch-dirs'))
  assert.ok(!REMOVAL.test(bare))
  const cleaned = `${bare}rmSync(d, { recursive: true })\n`
  assert.ok(REMOVAL.test(cleaned))
  const importOnly = `import { mkdtempSync } from 'node:fs'\n`
  assert.ok(!/\bmkdtemp(Sync)?\(/.test(withoutImports(importOnly)))
})
