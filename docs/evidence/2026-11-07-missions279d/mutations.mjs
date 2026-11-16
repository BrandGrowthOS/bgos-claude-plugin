// Real production functions, copied under local dependencies. One test worker.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(process.cwd())
const scratch = join(root, 'node_modules/.cache/missions279d')
mkdirSync(scratch, { recursive: true })
const sandbox = mkdtempSync(join(scratch, 'mutations-'))
const files = ['server.ts', 'lib/mission-turn.mjs']
const original = Object.fromEntries(files.map((file) => [file, readFileSync(join(root, file), 'utf8')]))
const tests = ['test/mission-turn-refresh.test.ts', 'test/mission-turn-snapshots.test.ts', 'test/mission-turn.test.ts']
const mutants = [
  ['all source ordering disabled', 'lib/mission-turn.mjs', 'if (time > oldTime)', 'if (true)'],
  ['revision comparison reversed', 'lib/mission-turn.mjs', 'if (time > oldTime)', 'if (!prior || time < oldTime)'],
  ['completion tombstones forgotten', 'lib/mission-turn.mjs', 'if (changed) held.set', "if (changed && entry.status === 'active') held.set"],
  ['report revision discarded', 'lib/mission-turn.mjs', 'updatedAt: report?.updatedAt ?? null', 'updatedAt: null'],
  ['equal revisions replace goals', 'lib/mission-turn.mjs', 'if (time > oldTime)', 'if (time >= oldTime)'],
  ['mission revision keys shared', 'lib/mission-turn.mjs', 'held.get(incoming?.missionId)', 'held.get(0)', ['held.set(incoming.missionId,', 'held.set(0,']],
  ['equal revision check refresh disabled', 'lib/mission-turn.mjs', 'time === oldTime && sameMissionTurnGoals(entry, incoming)', 'false && sameMissionTurnGoals(entry, incoming)'],
  ['equal report goal consistency bypassed', 'lib/mission-turn.mjs', 'time === oldTime && sameMissionTurnGoals(entry, incoming)', 'time === oldTime'],
  ['legacy enclosing revision comparison bypassed', 'server.ts', "Date.parse(before.updatedAt) !== Date.parse(after.updatedAt ?? '')", 'false'],
  ['legacy report consistency bypassed', 'server.ts', '!sameMissionTurnGoals(entry, entryFromMission(before)) ||\n      !sameMissionTurnGoals(entry, entryFromMission(after))', 'false'],
  ['legacy reconciliation disabled', 'server.ts', '  const path = buildMissionActivePath(ASSISTANT_ID, chatId)\n  if (!path.ok) return null', '  return null\n  const path = buildMissionActivePath(ASSISTANT_ID, chatId)\n  if (!path.ok) return null'],
  ['chat binding removed', 'lib/mission-turn.mjs', '(prior && prior.chatId !== chatId)', 'false'],
  ['timestamps compared as strings', 'lib/mission-turn.mjs', 'if (time > oldTime)', 'if (!prior || incoming.updatedAt > prior.entry.updatedAt)'],
  ['legacy exact-state observation disabled', 'server.ts', 'if (sameMissionTurnGoals(observation, mission)) return', 'if (false) return'],
  ['unversioned initial goals accepted', 'lib/mission-turn.mjs', "typeof incoming?.updatedAt === 'string' ? Date.parse(incoming.updatedAt) : NaN", "typeof incoming?.updatedAt === 'string' ? Date.parse(incoming.updatedAt) : 0"],
]

try {
  cpSync(join(root, 'lib'), join(sandbox, 'lib'), { recursive: true })
  for (const folder of ['test', 'bin', 'tmp']) mkdirSync(join(sandbox, folder))
  for (const file of [...tests, 'package.json', 'bin/hoai-mission-turn-hook.mjs']) {
    writeFileSync(join(sandbox, file), readFileSync(join(root, file)))
  }
  const restore = () => { for (const file of files) writeFileSync(join(sandbox, file), original[file]) }
  const run = (pattern) => spawnSync(process.execPath, [
    '--import', import.meta.resolve('tsx'), '--test', '--test-reporter=tap', '--test-concurrency=1',
    ...(pattern ? [`--test-name-pattern=${pattern}`] : []), ...tests,
  ], { cwd: sandbox, env: { ...process.env, NODE_DISABLE_COMPILE_CACHE: '1', TSX_DISABLE_CACHE: '1', TMPDIR: join(sandbox, 'tmp') },
    encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024 })
  const failures = (result) => [...(result.stdout + result.stderr).matchAll(/^\s*not ok \d+ - (.+)$/gm)].map((m) => m[1])
  const mustFail = (name, result) => {
    const output = result.stdout + result.stderr
    assert.equal(result.status, 1, `${name}: expected exit 1, got ${result.status}: ${output.slice(-2000)}`)
    assert.match(output, /ERR_ASSERTION/, `${name}: assertion failure required`)
    assert.doesNotMatch(output, /ReferenceError|SyntaxError|ERR_MODULE_NOT_FOUND|ERR_UNKNOWN_FILE_EXTENSION/, `${name}: must fail behavior, not loading`)
    const names = failures(result)
    assert.ok(names.length > 0, `${name}: named test failure required`)
    console.log(JSON.stringify({ name, status: 'caught', failingTests: names }))
  }
  restore()
  const control = run()
  assert.equal(control.status, 0, control.stdout + control.stderr)
  console.log('Control: all three real mission test files pass; one worker')
  for (const file of files) writeFileSync(join(sandbox, file), execFileSync('git', ['show', `a1965bb432374c325c76593a6e390d23f4f4b57f:${file}`], { cwd: root }))
  mustFail('pre-fix production with final regressions', run('all goal-state sources|T0 snapshot|legacy report reconciliation|equal report revisions|wrong-chat write|unversioned snapshots'))
  for (const [name, file, before, after, second] of mutants) {
    restore()
    let changed = original[file]
    assert.equal(changed.split(before).length - 1, 1, `unique mutation site: ${name}`)
    changed = changed.replace(before, after)
    if (second) {
      assert.equal(changed.split(second[0]).length - 1, 1, `unique second site: ${name}`)
      changed = changed.replace(...second)
    }
    writeFileSync(join(sandbox, file), changed)
    mustFail(name, run('all goal-state sources|T0 snapshot|legacy report reconciliation|equal report revisions|wrong-chat write|unversioned snapshots|timestamps compare|matching legacy reports'))
  }
  console.log(`Result: pre-fix regressions fail; ${mutants.length}/${mutants.length} targeted mutants caught; production untouched; one worker`)
} finally {
  rmSync(sandbox, { recursive: true, force: true })
}
