/**
 * No new plain device or inode comparisons anywhere in the plugin's source
 * tree (lib, bin, scripts, server.ts and every other shipping file; the
 * top level tests, docs, installs and dot folders are not scanned). Missing
 * file numbers are unknown, number stats can round large file ids, and a ReFS
 * or Dev Drive volume shows only 64 bits of a 128 bit id: lib/file-numbers.mjs
 * holds that rule, and a number read through its wholeNumber is not a plain
 * one. The rule files have no exemption of their own: they read every number
 * through wholeNumber (so does the vendored BGOS copy,
 * lib/browser-profile-core/file-numbers.js). The existing sites are debt, not
 * examples to copy: remove entries from the allow list as they are fixed,
 * lowering the pinned count too; never add entries. Unused allowances fail so
 * fixed sites cannot leave credits.
 *
 * A compare is a comparison operator, Object.is, a `case` of a switch, or an
 * includes, has, indexOf or lastIndexOf call, with a file number on either
 * side. This guard does no type inference and follows no data: a number first
 * copied into a variable of another name, or a compare written some other way
 * (a Map key, a sort callback, a find), is not seen.
 *
 * Sites use a relative path and a printed comparison, not a line number, so
 * comments and unrelated line shifts do not require refreshing the baseline.
 * Each entry permits one occurrence, so copying an allowed comparison fails.
 */
import assert from 'node:assert/strict'
import { appendFileSync, cpSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { scratchDir } from './helpers/scratch-dirs.ts'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
/**
 * Top level folders that ship no code: the tests, the docs, installs and every dot folder (.git, .github,
 * .claude-plugin). Only the first segment of a path is checked: the same names deeper in a shipping folder are scanned.
 */
const NOT_SOURCE = new Set(['node_modules', 'test', 'docs'])
const notSource = (relativePath: string): boolean => {
  const first = relativePath.split(/[\\/]/)[0]
  return first !== '' && (first.startsWith('.') || NOT_SOURCE.has(first))
}
const ALLOWED_SITE_COUNT = 37
/**
 * Today's allowed sites, listed one by one (path and printed compare) in the fixture. Every one is in lib: bin,
 * scripts and server.ts have none, and a test below keeps it so.
 */
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
  // wholeNumber keeps the number whole and gives null when it is unknown, the rule this guard asks for.
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'wholeNumber') return false
  if (ts.isPropertyAccessExpression(node) && /^(dev|ino)$/.test(node.name.text)) return true
  if (ts.isElementAccessExpression(node) && node.argumentExpression &&
      ts.isStringLiteralLike(node.argumentExpression) && /^(dev|ino)$/.test(node.argumentExpression.text)) return true
  return ts.forEachChild(node, child => readsFileNumber(child) || undefined) ?? false
}

/** Object.is(a.ino, b.ino), and the same through optional or bracket access: a compare written as a call. */
function isObjectIs(node: ts.CallExpression): boolean {
  const callee = node.expression
  if (!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee)) return false
  const name = ts.isPropertyAccessExpression(callee) ? callee.name.text
    : ts.isStringLiteralLike(callee.argumentExpression) ? callee.argumentExpression.text : ''
  return name === 'is' && ts.isIdentifier(callee.expression) && callee.expression.text === 'Object'
}

/** The methods that find an equal value in a list or a set: a compare of their argument with what is in it. */
const MEMBERSHIP = new Set(['includes', 'has', 'indexOf', 'lastIndexOf'])

/** [a.ino].includes(b.ino), seen.has(stat.dev), list.indexOf(a.ino): a compare written as a membership call. */
function isMembership(node: ts.CallExpression): boolean {
  const callee = node.expression
  const name = ts.isPropertyAccessExpression(callee) ? callee.name.text
    : ts.isElementAccessExpression(callee) && ts.isStringLiteralLike(callee.argumentExpression) ? callee.argumentExpression.text : ''
  return MEMBERSHIP.has(name)
}

function comparisonSites(file: string, source: string): Site[] {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const sites: Site[] = []
  const print = (node: ts.Node) => printer.printNode(ts.EmitHint.Expression, node, parsed)
  const add = (node: ts.Node, expression: string): void => {
    const { line, character } = parsed.getLineAndCharacterOfPosition(node.getStart(parsed))
    sites.push({ key: `${file}: ${expression}`, location: `${file}:${line + 1}:${character + 1}` })
  }
  const visit = (node: ts.Node): void => {
    if ((ts.isBinaryExpression(node) && COMPARISONS.has(node.operatorToken.kind) &&
        (readsFileNumber(node.left) || readsFileNumber(node.right))) ||
        (ts.isCallExpression(node) && (isObjectIs(node) || isMembership(node)) && node.arguments.some(readsFileNumber))) {
      add(node, print(node))
    }
    // switch (a.dev) { case b.dev: } compares the switch value with every case: each case is one site.
    if (ts.isCaseClause(node) && ts.isCaseBlock(node.parent) && ts.isSwitchStatement(node.parent.parent)) {
      const value = node.parent.parent.expression
      if (readsFileNumber(value) || readsFileNumber(node.expression)) add(node, `switch (${print(value)}) case ${print(node.expression)}`)
    }
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  return sites
}

/** Every source file under `root` (a checkout, or a scratch copy of one) except the top level non-source folders. */
function scanTree(root: string): Site[] {
  const sites: Site[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name)
      const file = relative(root, path).split('\\').join('/')
      if (entry.isDirectory()) {
        if (!notSource(file)) walk(path)
      } else if (entry.isFile() && SOURCE_FILE.test(entry.name)) {
        sites.push(...comparisonSites(file, readFileSync(path, 'utf8')))
      }
    }
  }
  walk(root)
  return sites
}

function auditAllowances(sites: Site[], allowed: readonly string[]): { unlisted: Site[], unused: string[] } {
  const remaining = new Map<string, number>()
  for (const key of allowed) remaining.set(key, (remaining.get(key) ?? 0) + 1)
  const unlisted = sites.filter(({ key }) => {
    const count = remaining.get(key) ?? 0
    if (count === 0) return true
    remaining.set(key, count - 1)
    return false
  })
  const unused = [...remaining].flatMap(([key, count]) => Array<string>(count).fill(key))
  return { unlisted, unused }
}

test('the allow list has exactly the reviewed number of sites', () => {
  assert.equal(ALLOW_LIST.length, ALLOWED_SITE_COUNT,
    'Allow-list size changed. Remove fixed sites and lower ALLOWED_SITE_COUNT together; do not add allowances.')
})

test('the source tree has no new plain device or inode comparison sites', () => {
  const { unlisted: offenders, unused } = auditAllowances(scanTree(ROOT), ALLOW_LIST)
  assert.deepEqual(offenders, [],
    'New plain file number comparison(s). Treat missing numbers as unknown and preserve large file ids; ' +
    'do not grow test/fixtures/file-identity-allowlist.json.\n' +
    offenders.map(site => `${site.location}: ${site.key}`).join('\n'))
  assert.deepEqual(unused, [],
    'Unused file number comparison allowance(s). Remove fixed sites from ' +
    'test/fixtures/file-identity-allowlist.json and lower ALLOWED_SITE_COUNT.\n' + unused.join('\n'))
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
    'Object.is(a.ino, b.ino)',
    "Object['is'](a?.dev, other)",
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
    const sized = Object.is(a.inodes, b.size)
    const named = Reflect.is(a.ino, b.ino)
  `
  assert.deepEqual(comparisonSites('lib/example.ts', source), [])
})

test('a number read whole through wholeNumber is not a plain site, and a plain operand beside it still is', () => {
  // wholeNumber (lib/file-numbers.mjs, lib/browser-profile-core/file-numbers.js) keeps a 64 bit number whole and gives null when it is unknown.
  assert.deepEqual(comparisonSites('lib/example.js', 'wholeNumber(stat?.dev) !== null && wholeNumber(stat?.ino) !== null'), [])
  assert.deepEqual(comparisonSites('lib/example.js', 'wholeNumber(a?.["ino"]) === wholeNumber(b.ino)'), [])
  assert.equal(comparisonSites('lib/example.js', 'wholeNumber(a.ino) === b.ino').length, 1)
  assert.equal(comparisonSites('lib/example.js', 'Number(wholeNumber(a.ino)) === b.ino').length, 1)
  assert.equal(comparisonSites('lib/example.js', 'other.wholeNumber(a.ino) === null').length, 1, 'only the plain helper name counts')
  assert.equal(comparisonSites('lib/example.js', 'wholeNumber(a.ino, a.dev === b.dev) === null').length, 1, 'a comparison inside its arguments is still a site')
})

test('compares written as a switch, includes, has or indexOf are sites too', () => {
  for (const expression of [
    '[a.ino].includes(b.ino)',
    'new Set([a.ino]).has(b.ino)',
    'seen.has(stat.dev)',
    'list.indexOf(a.ino)',
    'list.lastIndexOf(a?.["dev"])',
    'inodes.includes(Number(b.ino))',
  ]) {
    assert.equal(comparisonSites('lib/example.ts', expression).length, 1, expression)
  }
  assert.equal(comparisonSites('lib/example.ts', 'switch (a.dev) { case b.dev: break; case 7: break }').length, 2, 'every case against a file number')
  assert.equal(comparisonSites('lib/example.ts', 'switch (kind) { case a.ino: break; case "x": break }').length, 1, 'a case that reads one')
  // Not compares of a file number: other arguments, other methods, and a number read whole.
  assert.deepEqual(comparisonSites('lib/example.ts', [
    'seen.has(stat.size)', 'names.includes(entry.name)', 'map.get(a.ino)', 'list.push(a.dev)',
    'seen.has(wholeNumber(a.ino))', 'switch (kind) { case "dev": break }',
  ].join('\n')), [])
  const [site] = comparisonSites('lib/example.ts', 'switch (a.dev) {\n  case b.dev: break\n}')
  assert.equal(site.key, 'lib/example.ts: switch (a.dev) case b.dev')
  assert.equal(site.location, 'lib/example.ts:2:3')
})

test('allowances are tied to the file, expression and number of occurrences', () => {
  const [site] = comparisonSites('lib/known.mjs', 'a.ino === b.ino')
  assert.deepEqual(auditAllowances([site], [site.key]), { unlisted: [], unused: [] })
  assert.deepEqual(auditAllowances([site, site], [site.key]), { unlisted: [site], unused: [] })
  assert.deepEqual(auditAllowances([site, site], [site.key, site.key]), { unlisted: [], unused: [] })
  for (const source of [
    comparisonSites('lib/new.mjs', 'a.ino === b.ino'),
    comparisonSites('lib/known.mjs', 'a.dev === b.dev'),
    comparisonSites('lib/known.mjs', 'a.ino !== b.ino'),
  ]) {
    assert.deepEqual(auditAllowances(source, [site.key]), { unlisted: source, unused: [site.key] })
  }
  // Fixed sites and surplus duplicate allowances must be removed from the list.
  assert.deepEqual(auditAllowances([], [site.key]), { unlisted: [], unused: [site.key] })
  assert.deepEqual(auditAllowances([site], [site.key, site.key]), { unlisted: [], unused: [site.key] })
  assert.deepEqual(auditAllowances([], [site.key, site.key]), { unlisted: [], unused: [site.key, site.key] })
})

test('site keys ignore line shifts and comments while diagnostics retain the source line', () => {
  const [original] = comparisonSites('lib/example.ts', 'a.ino === b.ino')
  const [shifted] = comparisonSites('lib/example.ts', '\n// unrelated\na.ino /* reason */ === b.ino')
  assert.equal(shifted.key, original.key)
  assert.equal(shifted.location, 'lib/example.ts:3:1')
})

test('the walk reads nested source files and detects a new comparison in a scratch lib file', () => {
  const root = scratchDir('file-identity-guard-')
  mkdirSync(join(root, 'lib', 'nested'), { recursive: true })
  for (const extension of ['ts', 'mts', 'cts', 'tsx', 'js', 'mjs', 'cjs', 'jsx']) {
    writeFileSync(join(root, 'lib', 'nested', `example.${extension}`), 'a.ino === b.ino')
  }
  writeFileSync(join(root, 'lib', 'notes.md'), 'a.ino === b.ino')
  const sites = scanTree(root)
  assert.equal(sites.length, 8)
  assert.equal(auditAllowances(sites, []).unlisted.length, 8)
  assert.deepEqual(auditAllowances(sites, sites.map(site => site.key)), { unlisted: [], unused: [] })
  writeFileSync(join(root, 'lib', 'scratch.mjs'), 'a.ino === b.ino')
  assert.deepEqual(auditAllowances(scanTree(root), sites.map(site => site.key)).unlisted.map(site => site.key), [
    'lib/scratch.mjs: a.ino === b.ino',
  ])
})

test('every shipping folder is scanned; the tests, the docs, installs and dot folders are not', () => {
  const root = scratchDir('file-identity-tree-')
  const compare = 'export const same = (a, b) => a.ino === b.ino\n'
  for (const file of ['server.ts', 'bin/tool.mjs', 'scripts/tool.mjs', 'hooks/hook.cjs', 'lib/deep/er/x.ts',
    'test/x.test.ts', 'test/helpers/x.ts', 'docs/x.mjs', 'node_modules/pkg/x.js', '.git/x.js', '.github/x.js']) {
    mkdirSync(join(root, file, '..'), { recursive: true })
    writeFileSync(join(root, file), compare)
  }
  assert.deepEqual(scanTree(root).map(site => site.key), [
    'bin/tool.mjs: a.ino === b.ino',
    'hooks/hook.cjs: a.ino === b.ino',
    'lib/deep/er/x.ts: a.ino === b.ino',
    'scripts/tool.mjs: a.ino === b.ino',
    'server.ts: a.ino === b.ino',
  ])
})

test('only the top level tests, docs, installs and dot folders are skipped; the same names deeper are scanned', () => {
  const root = scratchDir('file-identity-depth-')
  for (const [file, compare] of [
    ['lib/docs/leak.mjs', 'before.ino !== after.ino'],
    ['scripts/test/leak.mjs', 'before.dev !== after.dev'],
    ['lib/.generated/leak.mjs', 'Object.is(before.ino, after.ino)'],
    ['bin/node_modules/leak.js', 'before.ino === after.ino'],
    ['test/leak.mjs', 'before.ino === after.ino'],
    ['.github/leak.mjs', 'before.ino === after.ino'],
  ]) {
    mkdirSync(join(root, file, '..'), { recursive: true })
    writeFileSync(join(root, file), `export const moved = (before, after) => ${compare}\n`)
  }
  assert.deepEqual(scanTree(root).map(site => site.key), [
    'bin/node_modules/leak.js: before.ino === after.ino',
    'lib/.generated/leak.mjs: Object.is(before.ino, after.ino)',
    'lib/docs/leak.mjs: before.ino !== after.ino',
    'scripts/test/leak.mjs: before.dev !== after.dev',
  ])
})

test('the rule files have no exemption: they read the numbers through wholeNumber and pass like any other file', () => {
  const root = scratchDir('file-identity-home-')
  mkdirSync(join(root, 'lib', 'browser-profile-core'), { recursive: true })
  // The rule as this checkout ships it, and the compares of the vendored BGOS copy (park/plugfilenum d448cf29).
  writeFileSync(join(root, 'lib', 'file-numbers.mjs'), readFileSync(join(ROOT, 'lib', 'file-numbers.mjs'), 'utf8'))
  writeFileSync(join(root, 'lib', 'browser-profile-core', 'file-numbers.js'), [
    'const knownNumbers = stat => wholeNumber(stat?.dev) !== null && wholeNumber(stat?.ino) !== null;',
    'const numberPairs = (a, b) => ["dev", "ino"].map(key => [wholeNumber(a?.[key]), wholeNumber(b?.[key])]);',
    'const sameGivenNumbers = (a, b) => ["dev", "ino"].every(key => a?.[key] === b?.[key]);',
  ].join('\n'))
  assert.deepEqual(scanTree(root), [])
  // A plain compare in either rule file is a site like anywhere else.
  appendFileSync(join(root, 'lib', 'file-numbers.mjs'), '\nexport const plain = (a, b) => a.ino === b.ino\n')
  appendFileSync(join(root, 'lib', 'browser-profile-core', 'file-numbers.js'), '\nconst plain = (a, b) => a.dev !== b.dev;\n')
  assert.deepEqual(scanTree(root).map(site => site.key), [
    'lib/browser-profile-core/file-numbers.js: a.dev !== b.dev',
    'lib/file-numbers.mjs: a.ino === b.ino',
  ])
})

test('a throwaway compare added to a scratch copy of this checkout fails the guard', () => {
  // The copy holds the shipping source exactly as this checkout has it, so it passes as the checkout does.
  const copy = scratchDir('file-identity-copy-')
  cpSync(ROOT, copy, { recursive: true, filter: source => !notSource(relative(ROOT, source)) })
  assert.deepEqual(auditAllowances(scanTree(copy), ALLOW_LIST), { unlisted: [], unused: [] })
  // A throwaway compare in server.ts, in bin and in a new lib file: each one alone fails it.
  const throwaways: Array<[string, string]> = [
    ['server.ts', 'server.ts: before.ino !== after.ino'],
    ['bin/bgos-claim.mjs', 'bin/bgos-claim.mjs: Object.is(before.dev, after.dev)'],
    ['lib/throwaway.mjs', 'lib/throwaway.mjs: before.ino !== after.ino'],
  ]
  appendFileSync(join(copy, 'server.ts'), '\nif (before.ino !== after.ino) throw new Error("moved")\n')
  appendFileSync(join(copy, 'bin', 'bgos-claim.mjs'), '\nif (!Object.is(before.dev, after.dev)) throw new Error("moved")\n')
  writeFileSync(join(copy, 'lib', 'throwaway.mjs'), 'export const moved = (before, after) => before.ino !== after.ino\n')
  const { unlisted, unused } = auditAllowances(scanTree(copy), ALLOW_LIST)
  assert.deepEqual(unlisted.map(site => site.key).sort(), throwaways.map(([, key]) => key).sort())
  assert.deepEqual(unused, [])
  // A compare copied from an allowed site is a second occurrence, so it fails too.
  appendFileSync(join(copy, 'lib', 'git-changes.ts'), '\nexport const again = (a: { ino: number }, b: { ino: number }) => a.ino === b.ino\n')
  assert.ok(auditAllowances(scanTree(copy), ALLOW_LIST).unlisted.some(site => site.key === 'lib/git-changes.ts: a.ino === b.ino'))
})
