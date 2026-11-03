import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const sourcePath = 'lib/message-edits.ts'
const testPath = 'test/message-edits.test.ts'
const source = readFileSync(join(root, sourcePath), 'utf8')
const tests = readFileSync(join(root, testPath), 'utf8')
const hash = value => createHash('sha256').update(value).digest('hex')
const cache = join(root, 'node_modules/.cache/editdrop-collisions')
mkdirSync(cache, { recursive: true })
const results = []
const mutations = [
  {
    label: 'skip equal-time reconciliation',
    from: '((incomingTime === null && incomingRevision === null) || ambiguousTime)',
    to: '(incomingTime === null && incomingRevision === null)',
    scenario: 'rejects replayed B after C',
    assertion: 'the current row is still C; replayed B must not become a fourth card',
  },
  {
    label: 'reject all equal timestamps',
    from: 'time !== null && entry.time !== null && time < entry.time',
    to: 'time !== null && entry.time !== null && time <= entry.time',
    scenario: 'delivers a later edit and genuine revert',
    assertion: 'timestamp equality must not discard the current C',
  },
]
for (const mutation of mutations) {
  assert.equal(source.split(mutation.from).length, 2, `${mutation.label}: exactly one mutation site`)
  const dir = mkdtempSync(join(cache, 'mutant-'))
  try {
    cpSync(join(root, 'lib'), join(dir, 'lib'), { recursive: true })
    mkdirSync(join(dir, 'test'))
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n')
    cpSync(join(root, 'server.ts'), join(dir, 'server.ts'))
    writeFileSync(join(dir, testPath), tests)
    writeFileSync(join(dir, sourcePath), source.replace(mutation.from, mutation.to))
    for (const lane of ['socket', 'poll', 'stream']) {
      for (const precision of ['identical timestamps', 'microsecond timestamps']) {
        const name = `review R4: ${lane} ${mutation.scenario} with ${precision}`
        const args = ['--import', 'tsx', '--test', '--test-concurrency=4', '--test-timeout=10000', `--test-name-pattern=^${name}$`, join(dir, testPath)]
        console.log(`\nMUTATION ${mutation.label}\nTEST ${name}\nFILE ${sourcePath}\nREPLACE ${mutation.from}\nWITH ${mutation.to}`)
        const result = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: 20000 })
        const output = result.stdout + result.stderr
        process.stdout.write(output)
        assert.equal(result.status, 1, `${name}: mutant must fail`)
        assert.match(output, /AssertionError/, `${name}: assertion-based failure`)
        assert.ok(output.includes(mutation.assertion), `${name}: fails at the intended behavior`)
        assert.match(output, /tests 1\b/, `${name}: exactly one selected case`)
        assert.doesNotMatch(output, /test timed out|TypeError:|ReferenceError:/, `${name}: no timeout or harness error`)
        results.push({ mutation: mutation.label, test: name, exit: result.status, assertion: mutation.assertion })
        console.log(`KILLED ${name}`)
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
assert.equal(readFileSync(join(root, sourcePath), 'utf8'), source, 'production source unchanged')
assert.equal(readFileSync(join(root, testPath), 'utf8'), tests, 'tests unchanged')
writeFileSync(new URL('./mutation-summary.json', import.meta.url), JSON.stringify({
  source_sha256: hash(source), tests_sha256: hash(tests), max_workers: 4,
  killed: results.length, survivors: 0, source_unchanged: true, results,
}, null, 2) + '\n')
console.log(`\nALL ${results.length} COLLISION MUTANTS KILLED; production source and tests unchanged`)
