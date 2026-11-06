// Run from the repository with dependencies installed. Production files stay untouched.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const scratch = join(root, 'node_modules/.cache/missions279')
mkdirSync(scratch, { recursive: true })
const sandbox = mkdtempSync(join(scratch, 'mutations-'))
const original = readFileSync(join(root, 'lib/mission-turn.mjs'), 'utf8')
const mutants = [
  ['missing block', 'return { block: true, reason: blockReason', 'return { block: false, reason: blockReason'],
  ['second Stop blocks again', 'if (stopHookActive === true) return { block: false }', 'if (false) return { block: false }'],
  ['missing answer blocks', 'if (!isObject(answer)) return { block: false }', 'if (!isObject(answer)) return { block: true }'],
  ['forged embedded chat tag', 'const match = /^\\s*<channel', 'const match = /\\s*<channel'],
  ['expired ask answered', 'if (!Number.isFinite(ask.at) || now() - ask.at > MISSION_TURN_ASK_MAX_AGE_MS)', 'if (!Number.isFinite(ask.at))'],
  ['newer ask deleted', 'if (readMissionTurnJson(askPath)?.askId === ask.askId) removeQuietly(askPath)', 'removeQuietly(askPath)'],
  ['freshness inverted', 'now - entry.checkedAt < MISSION_TURN_REUSE_MS', 'now - entry.checkedAt > MISSION_TURN_REUSE_MS'],
]
try {
  for (const name of ['lib', 'test', 'tmp']) mkdirSync(join(sandbox, name))
  symlinkSync(join(root, 'lib/private-turn.mjs'), join(sandbox, 'lib/private-turn.mjs'))
  writeFileSync(join(sandbox, 'test/mission-turn.test.ts'), readFileSync(join(root, 'test/mission-turn.test.ts')))
  const run = () => spawnSync(process.execPath, [
    '--import', import.meta.resolve('tsx'), '--test', '--test-reporter=tap', '--test-concurrency=1', 'test/mission-turn.test.ts',
  ], { cwd: sandbox, env: { ...process.env, TMPDIR: join(sandbox, 'tmp') }, encoding: 'utf8', timeout: 30_000 })
  writeFileSync(join(sandbox, 'lib/mission-turn.mjs'), original)
  const baseline = run()
  assert.equal(baseline.status, 0, 'unmodified behavioral tests must pass')
  console.log('Control: unmodified mission-turn behavioral tests pass')
  for (const [name, before, after] of mutants) {
    assert.equal(original.split(before).length, 2, `unique mutation site: ${name}`)
    writeFileSync(join(sandbox, 'lib/mission-turn.mjs'), original.replace(before, after))
    const result = run()
    const output = result.stdout + result.stderr
    assert.notEqual(result.status, 0, `surviving mutant: ${name}`)
    assert.match(output, /ERR_ASSERTION/, `mutant must fail an assertion: ${name}`)
    const failures = [...output.matchAll(/^not ok \d+ - (.+)$/gm)].map(match => match[1])
    assert.ok(failures.length > 0, `named failing test: ${name}`)
    console.log(JSON.stringify({ mutation: name, status: 'caught', failingTests: failures }))
  }
  console.log('Result: 7 of 7 mutants caught; production files untouched; one worker')
} finally {
  rmSync(sandbox, { recursive: true, force: true })
}
