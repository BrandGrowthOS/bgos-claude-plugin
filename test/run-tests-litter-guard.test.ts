import { test } from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { snapshotWorkingTree } from '../scripts/test-tree-snapshot.mjs'

function fixture(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), 'suite-litter-guard-'))
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 3 }))
  return root
}

test('snapshot sees ignored files and empty nested repos, without traversing git or dependencies', (t) => {
  const root = fixture(t)
  mkdirSync(join(root, 'nested', '.git'), { recursive: true })
  mkdirSync(join(root, '.git'))
  mkdirSync(join(root, 'node_modules'))
  writeFileSync(join(root, '.git', 'internal'), '')
  writeFileSync(join(root, 'node_modules', 'dependency'), '')
  writeFileSync(join(root, '.gitignore'), '*.backup\n')
  writeFileSync(join(root, 'ignored.backup'), '')
  mkdirSync(join(root, 'empty'))
  const before = snapshotWorkingTree(root)
  assert.deepEqual([...before].sort(), ['.git', '.gitignore', 'empty', 'ignored.backup', 'nested', 'nested/.git', 'node_modules'])
  mkdirSync(join(root, 'nested', 'new', '.git'), { recursive: true })
  writeFileSync(join(root, 'new.backup'), '')
  assert.deepEqual([...snapshotWorkingTree(root)].filter((path) => !before.has(path)).sort(), ['nested/new', 'nested/new/.git', 'new.backup'])
})

test('snapshot does not follow directory links out of the tree or into a cycle', (t) => {
  const root = fixture(t)
  const outside = fixture(t)
  writeFileSync(join(outside, 'outside'), '')
  symlinkSync(outside, join(root, 'external'), process.platform === 'win32' ? 'junction' : 'dir')
  symlinkSync(root, join(root, 'cycle'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.deepEqual([...snapshotWorkingTree(root)].sort(), ['cycle', 'external'])
})

test('a failed scan throws instead of silently treating an unreadable tree as clean', (t) => {
  const root = fixture(t)
  assert.throws(() => snapshotWorkingTree(join(root, 'missing')), /ENOENT/)
})

// Exercise the real orchestrator in a disposable checkout. Only its child
// runners are stand-ins, so this never starts another full suite or installs.
for (const scenario of [
  { name: 'unchanged pre-existing files pass', litter: false, childExit: 0 },
  { name: 'new paths fail even when both test families pass', litter: true, childExit: 0 },
  { name: 'new paths are still reported after a test family fails', litter: true, childExit: 7 },
]) {
  test(`whole-run guard: ${scenario.name}`, (t) => {
    const root = fixture(t)
    for (const directory of ['scripts', 'test', 'bin', 'pre-existing']) mkdirSync(join(root, directory))
    for (const file of ['run-tests.mjs', 'test-tree-snapshot.mjs']) {
      copyFileSync(join(import.meta.dirname, '..', 'scripts', file), join(root, 'scripts', file))
    }
    writeFileSync(join(root, 'test', 'node.test.ts'), '// node fixture\n')
    writeFileSync(join(root, 'test', 'bun.test.ts'), `import { test } from ${JSON.stringify('bun:test')}\n`)
    writeFileSync(join(root, '.gitignore'), '*.backup\n')
    writeFileSync(join(root, 'pre-existing', 'kept.backup'), '')
    const child = join(root, 'child.mjs')
    writeFileSync(child, `
      import { mkdirSync, writeFileSync } from 'node:fs'
      if (${scenario.litter}) {
        mkdirSync('left-empty/.git', { recursive: true })
        writeFileSync('left.backup', '')
        writeFileSync('pre-existing/new.backup', '')
      }
      process.exit(${scenario.childExit})
    `)
    for (const command of ['npx', 'bun']) {
      const windows = process.platform === 'win32'
      const shim = join(root, 'bin', command + (windows ? '.cmd' : ''))
      const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`
      writeFileSync(shim, windows
        ? `@"${process.execPath}" "${child}"\r\n`
        : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(child)}\n`, { mode: 0o755 })
    }
    const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'PATH'
    const result = spawnSync(process.execPath, [join(root, 'scripts', 'run-tests.mjs')], {
      cwd: root,
      env: { ...process.env, [pathKey]: `${join(root, 'bin')}${process.platform === 'win32' ? ';' : ':'}${process.env[pathKey]}` },
      encoding: 'utf8',
      timeout: 30_000,
    })
    const output = result.stdout + result.stderr
    assert.equal(result.error, undefined, output)
    assert.equal(result.status, scenario.litter ? 1 : 0, output)
    if (scenario.litter) {
      for (const path of ['left-empty', 'left-empty/.git', 'left.backup', 'pre-existing/new.backup']) {
        assert.ok(output.includes(`[run-tests] NEW PATH: ${JSON.stringify(path)}`), output)
      }
      assert.doesNotMatch(output, /both families green/)
    } else {
      assert.doesNotMatch(output, /NEW PATH:/)
      assert.match(output, /both families green/)
    }
    if (scenario.childExit) assert.match(output, /node family exit 7, bun family exit 7/)
  })
}
