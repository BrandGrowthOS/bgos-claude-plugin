// Run from the checkout after installing dependencies. Only disposable copies
// under node_modules are mutated; production files and git state stay intact.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const scratch = join(root, 'node_modules/.cache/missions279b')
mkdirSync(scratch, { recursive: true })
const sandbox = mkdtempSync(join(scratch, 'mutations-'))
const tests = ['mission-turn', 'mission-turn-refresh', 'mission-turn-hook', 'mission-turn-wiring'].map((name) => `test/${name}.test.ts`)
const files = ['lib/mission-turn.mjs', 'server.ts', 'bin/hoai-mission-turn-hook.mjs']
const original = Object.fromEntries(files.map((file) => [file, readFileSync(join(root, file), 'utf8')]))
const mutants = [
  { name: 'completion clears the chat', file: 'server.ts',
    before: '...(missionId !== undefined ? { missionId } : {})', after: '',
    tests: ['test/mission-turn-refresh.test.ts'], pattern: 'completion removes only' },
  { name: 'new mission drops existing missions', file: 'lib/mission-turn.mjs',
    before: 'Object.fromEntries(missionTurnEntries(chats[key]).map((row) => [String(row.missionId), row]))', after: '{}',
    tests: ['test/mission-turn-refresh.test.ts'], pattern: 'closing one' },
  { name: 'changed checked goals retain freshness', file: 'lib/mission-turn.mjs',
    before: 'isDeepStrictEqual(checkedGoals(previous.goals), checkedGoals(goals))', after: 'true',
    tests: ['test/mission-turn.test.ts'], pattern: 'adding checked goals|changing or removing' },
  { name: 'late HTTP reports ignore revision fences', file: 'server.ts', all: true,
    before: 'if (revision() !== before) return current()', after: '',
    tests: ['test/mission-turn-refresh.test.ts'], pattern: 'late HTTP|cold discovery|answer budget' },
  { name: 'daemon watcher never starts', file: 'server.ts',
    before: '  startMissionTurnWatch()\n', after: '',
    tests: ['test/mission-turn-wiring.test.ts'], pattern: 'watcher never keeps' },
  { name: 'hook second Stop writes an ask', file: 'bin/hoai-mission-turn-hook.mjs',
    before: "if (event === 'Stop' && payload?.stop_hook_active === true) return ''", after: '',
    tests: ['test/mission-turn-hook.test.ts'], pattern: 'stop_hook_active goes through' },
  { name: 'hook silently skips the ask', file: 'bin/hoai-mission-turn-hook.mjs',
    before: 'writeMissionTurnJson(missionTurnAskPath(root, key), { askId, chatId, at: Date.now() })', after: '',
    tests: ['test/mission-turn-hook.test.ts'], pattern: 'Stop ALLOWS when' },
  { name: 'wire answer loses other missions', file: 'lib/mission-turn.mjs',
    before: 'Array.isArray(found?.missions) ? { missions:', after: 'false ? { missions:',
    tests: ['test/mission-turn.test.ts'], pattern: 'file answer preserves' },
  { name: 'known missions use ambiguous implicit reads', file: 'server.ts',
    before: 'buildMissionGoalChecksPath(ASSISTANT_ID, mission.missionId)', after: 'buildMissionActivePath(ASSISTANT_ID, chatId)',
    tests: ['test/mission-turn-refresh.test.ts'], pattern: 'multiple cached' },
  { name: 'one failed mission aborts all checks', file: 'server.ts',
    before: 'log(`mission turn: mission ${mission.missionId} check read failed (${err})`)\n      continue', after: 'throw err',
    tests: ['test/mission-turn-refresh.test.ts'], pattern: 'failed check read' },
]
try {
  cpSync(join(root, 'lib'), join(sandbox, 'lib'), { recursive: true })
  for (const folder of ['test', 'bin', 'tmp']) mkdirSync(join(sandbox, folder))
  for (const file of [...tests, 'package.json', ...files.filter((file) => !file.startsWith('lib/'))]) {
    writeFileSync(join(sandbox, file), readFileSync(join(root, file)))
  }
  const run = (selected, pattern) => spawnSync(process.execPath, [
    '--import', import.meta.resolve('tsx'), '--test', '--test-reporter=tap', '--test-concurrency=1',
    ...(pattern ? [`--test-name-pattern=${pattern}`] : []), ...selected,
  ], { cwd: sandbox, env: { ...process.env, TSX_DISABLE_CACHE: '1', TMPDIR: join(sandbox, 'tmp') }, encoding: 'utf8', timeout: 60_000 })
  const control = run(tests)
  assert.equal(control.status, 0, 'unmodified control: ' + control.stdout + control.stderr)
  console.log('Control: unmodified behavioral, daemon, hook and wiring tests pass; one worker')
  for (const mutant of mutants) {
    for (const file of files) writeFileSync(join(sandbox, file), original[file])
    const source = original[mutant.file]
    const occurrences = source.split(mutant.before).length - 1
    assert.ok(mutant.all ? occurrences >= 2 : occurrences === 1, `mutation site: ${mutant.name}`)
    writeFileSync(join(sandbox, mutant.file), mutant.all
      ? source.replaceAll(mutant.before, mutant.after) : source.replace(mutant.before, mutant.after))
    const result = run(mutant.tests, mutant.pattern)
    assert.equal(result.status, 1, `mutation must be killed by the test runner: ${mutant.name}`)
    const output = result.stdout + result.stderr
    assert.match(output, /ERR_ASSERTION/, `must fail an assertion: ${mutant.name}`)
    const failingTests = [...output.matchAll(/^not ok \d+ - (.+)$/gm)].map((match) => match[1])
    assert.ok(failingTests.length > 0, `named test failure: ${mutant.name}`)
    console.log(JSON.stringify({ mutation: mutant.name, status: 'caught', failingTests }))
  }
  console.log(`Result: ${mutants.length} of ${mutants.length} mutants caught; production files untouched; one worker`)
} finally {
  rmSync(sandbox, { recursive: true, force: true })
}
