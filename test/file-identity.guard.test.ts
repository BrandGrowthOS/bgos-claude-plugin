/**
 * No new plain device or inode comparisons in lib. Missing file numbers are
 * unknown, and number stats can round large file ids. The existing sites are
 * debt, not examples to copy: remove entries from the allow list as they are
 * fixed; never add entries. This guard deliberately does no type inference.
 *
 * Sites use a relative path and a printed comparison, not a line number, so
 * comments and unrelated line shifts do not require refreshing the baseline.
 * Each entry permits one occurrence, so copying an allowed comparison fails.
 */
import assert from 'node:assert/strict'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { scratchDir } from './helpers/scratch-dirs.ts'

const LIB = fileURLToPath(new URL('../lib/', import.meta.url))
const ALLOW_LIST: string[] = JSON.parse(readFileSync(new URL('./fixtures/file-identity-allowlist.json', import.meta.url), 'utf8'))
const SOURCE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/
const COMPARISONS = new Set([
  ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.LessThanToken, ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.GreaterThanEqualsToken,
])
const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed })

type Site = { key: string, location: string }

function readsFileNumber(node: ts.Node): boolean {
  // A type check compares a type name, not the device or inode value itself.
  if (ts.isTypeOfExpression(node)) return false
  if (ts.isPropertyAccessExpression(node) && /^(dev|ino)$/.test(node.name.text)) return true
  if (ts.isElementAccessExpression(node) && node.argumentExpression &&
      ts.isStringLiteralLike(node.argumentExpression) && /^(dev|ino)$/.test(node.argumentExpression.text)) return true
  return ts.forEachChild(node, child => readsFileNumber(child) || undefined) ?? false
}

function comparisonSites(file: string, source: string): Site[] {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const sites: Site[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && COMPARISONS.has(node.operatorToken.kind) &&
        (readsFileNumber(node.left) || readsFileNumber(node.right))) {
      const { line, character } = parsed.getLineAndCharacterOfPosition(node.getStart(parsed))
      const expression = printer.printNode(ts.EmitHint.Expression, node, parsed)
      sites.push({ key: `${file}: ${expression}`, location: `${file}:${line + 1}:${character + 1}` })
    }
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  return sites
}

function scanLib(root: string): Site[] {
  const sites: Site[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (SOURCE_FILE.test(entry.name)) {
        const file = `lib/${relative(root, path).split('\\').join('/')}`
        sites.push(...comparisonSites(file, readFileSync(path, 'utf8')))
      }
    }
  }
  walk(root)
  return sites
}

function unlistedSites(sites: Site[], allowed: readonly string[]): Site[] {
  const remaining = new Map<string, number>()
  for (const key of allowed) remaining.set(key, (remaining.get(key) ?? 0) + 1)
  return sites.filter(({ key }) => {
    const count = remaining.get(key) ?? 0
    if (count === 0) return true
    remaining.set(key, count - 1)
    return false
  })
}

test('lib has no new plain device or inode comparison sites', () => {
  const offenders = unlistedSites(scanLib(LIB), ALLOW_LIST)
  assert.deepEqual(offenders, [],
    'New plain file number comparison(s). Treat missing numbers as unknown and preserve large file ids; ' +
    'do not grow test/fixtures/file-identity-allowlist.json.\n' +
    offenders.map(site => `${site.location}: ${site.key}`).join('\n'))
})

test('the scanner catches both file numbers, either operand and every comparison operator', () => {
  for (const field of ['dev', 'ino']) {
    for (const operator of ['==', '===', '!=', '!==', '<', '<=', '>', '>=']) {
      for (const expression of [`a.${field} ${operator} b.${field}`, `0 ${operator} a.${field}`, `a.${field} ${operator} 0`]) {
        assert.equal(comparisonSites('lib/example.ts', expression).length, 1, expression)
      }
    }
  }
})

test('formatting, optional and bracket access, casts and numeric conversions cannot hide a comparison', () => {
  for (const expression of [
    'a?.ino === b?.ino',
    'a["ino"] !== b["ino"]',
    "a?.['dev'] === b?.['dev']",
    'a[`ino`] === b[`ino`]',
    '(a.ino) === (b.ino)',
    'a.ino! === b.ino!',
    '(a.ino as number) === (b.ino as number)',
    'Number(a.ino) === Number(b.ino)',
    'a\n . /* comment */ ino\n ===\n b.ino',
    'cache.get(key) !== stat.ino',
  ]) {
    assert.equal(comparisonSites('lib/example.ts', expression).length, 1, expression)
  }
  assert.equal(comparisonSites('lib/example.ts', 'a.ino === b.ino && a.dev !== b.dev').length, 2)
})

test('comments, strings, other properties, type checks and non-comparison uses are not sites', () => {
  const source = `
    // a.ino === b.ino
    /* a.dev !== b.dev */
    const example = 'a.ino === b.ino'
    const other = a.inodes === b.deviceLabel
    const kind = typeof a.ino === 'number'
    const copy = { dev: a.dev, ino: a.ino }
    const safe = bothSame(known, a.ino, b.ino)
  `
  assert.deepEqual(comparisonSites('lib/example.ts', source), [])
})

test('allowances are tied to the file, expression and number of occurrences', () => {
  const [site] = comparisonSites('lib/known.mjs', 'a.ino === b.ino')
  assert.deepEqual(unlistedSites([site], [site.key]), [])
  assert.deepEqual(unlistedSites([site, site], [site.key]), [site])
  assert.equal(unlistedSites(comparisonSites('lib/new.mjs', 'a.ino === b.ino'), [site.key]).length, 1)
  assert.equal(unlistedSites(comparisonSites('lib/known.mjs', 'a.dev === b.dev'), [site.key]).length, 1)
  assert.equal(unlistedSites(comparisonSites('lib/known.mjs', 'a.ino !== b.ino'), [site.key]).length, 1)
  // Removing a comparison is allowed without replacing it with new debt.
  assert.deepEqual(unlistedSites([], [site.key]), [])
})

test('site keys ignore line shifts and comments while diagnostics retain the source line', () => {
  const [original] = comparisonSites('lib/example.ts', 'a.ino === b.ino')
  const [shifted] = comparisonSites('lib/example.ts', '\n// unrelated\na.ino /* reason */ === b.ino')
  assert.equal(shifted.key, original.key)
  assert.equal(shifted.location, 'lib/example.ts:3:1')
})

test('the lib walk reads nested source files and detects a new comparison in a scratch lib file', () => {
  const root = scratchDir('file-identity-guard-')
  mkdirSync(join(root, 'nested'))
  for (const extension of ['ts', 'mts', 'cts', 'tsx', 'js', 'mjs', 'cjs', 'jsx']) {
    writeFileSync(join(root, 'nested', `example.${extension}`), 'a.ino === b.ino')
  }
  writeFileSync(join(root, 'notes.md'), 'a.ino === b.ino')
  const sites = scanLib(root)
  assert.equal(sites.length, 8)
  assert.equal(unlistedSites(sites, []).length, 8)
  assert.deepEqual(unlistedSites(sites, sites.map(site => site.key)), [])
  writeFileSync(join(root, 'scratch.mjs'), 'a.ino === b.ino')
  assert.deepEqual(unlistedSites(scanLib(root), sites.map(site => site.key)).map(site => site.key), [
    'lib/scratch.mjs: a.ino === b.ino',
  ])
})
