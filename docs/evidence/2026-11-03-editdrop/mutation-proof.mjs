import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '../../..')
const source = readFileSync(join(root, 'server.ts'), 'utf8')
const digest = text => createHash('sha256').update(text).digest('hex')
const scratch = join(root, 'node_modules/.cache/editdrop')
mkdirSync(scratch, { recursive: true })
console.log(`server.ts SHA256 ${digest(source)}`)
for (const [name, from, to, test] of [
  ['socket listener removed', "realtimeSocket.on('message_edited',", "realtimeSocket.on('message_edited_disabled',", '^socket:'],
  ['poll replacement disabled', "if (humanMessageEdits.has(view)) await forwardHumanEdit(view, 'poll', editReadGeneration)", "if (false) await forwardHumanEdit(view, 'poll', editReadGeneration)", '^poll:'],
  ['stream replacement disabled', "if (cls !== 'message_new' && humanMessageEdits.has(view))", "if (false && cls !== 'message_new' && humanMessageEdits.has(view))", '^stream:'],
]) {
  assert.equal(source.split(from).length, 2, `${name}: exactly one mutation site`)
  const dir = mkdtempSync(join(scratch, 'mutation-'))
  try {
    mkdirSync(join(dir, 'test'))
    symlinkSync(join(root, 'lib'), join(dir, 'lib'), 'dir')
    cpSync(join(root, 'test/message-edits.test.ts'), join(dir, 'test/message-edits.test.ts'))
    writeFileSync(join(dir, 'server.ts'), source.replace(from, to))
    console.log(`\nMUTATION ${name}\nREPLACE ${from}\nWITH ${to}`)
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', '--test-concurrency=4', `--test-name-pattern=${test}`, join(dir, 'test/message-edits.test.ts')], { cwd: root, encoding: 'utf8' })
    process.stdout.write(result.stdout)
    process.stdout.write(result.stderr)
    console.log(`MUTANT EXIT ${result.status}`)
    assert.equal(result.status, 1, 'regression must fail')
    assert.match(result.stdout + result.stderr, /1 !== 2/, 'must fail because the edit was dropped')
  } finally { rmSync(dir, { recursive: true, force: true }) }
}
assert.equal(readFileSync(join(root, 'server.ts'), 'utf8'), source)
console.log('\nALL THREE MUTANTS KILLED; production source unchanged')
