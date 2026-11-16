// Execute real production functions in disposable copies, with one worker.
// No production source, index or branch state is changed.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const scratch = join(root, 'node_modules/.cache/missions279c')
mkdirSync(scratch, { recursive: true })
const sandbox = mkdtempSync(join(scratch, 'mutations-'))
const tests = ['test/mission-turn-refresh.test.ts', 'test/mission-turn-snapshots.test.ts']
const original = readFileSync(join(root, 'server.ts'), 'utf8')
const gate = `if (previousVersion !== undefined) {
      if (!Number.isFinite(updatedAt) || updatedAt < previousVersion.updatedAt) return
      if (updatedAt === previousVersion.updatedAt && (previous || !open || !previousVersion.open)) return
    }`
const store = 'if (Number.isFinite(updatedAt)) missionTurnSnapshotVersions.set(snapshot.id, { updatedAt, open })'
const duplicate = 'if (updatedAt === previousVersion.updatedAt && (previous || !open || !previousVersion.open)) return'
const mutants = [
  { name: 'snapshot ordering gate removed', before: gate, after: '' },
  { name: 'timestamp order reversed', before: 'updatedAt < previousVersion.updatedAt', after: 'updatedAt > previousVersion.updatedAt' },
  { name: 'closed mission version forgotten', before: store,
    after: 'if (Number.isFinite(updatedAt) && open) missionTurnSnapshotVersions.set(snapshot.id, { updatedAt, open })' },
  { name: 'timestamp text compared instead of instants', before: 'Date.parse(snapshot.updatedAt)', after: 'snapshot.updatedAt' },
  { name: 'unknown versions overwrite known versions', before: '!Number.isFinite(updatedAt) || updatedAt <', after: 'updatedAt <' },
  { name: 'equal versions can overwrite goals', before: duplicate, after: '' },
  { name: 'versions shared by different missions', before: 'missionTurnSnapshotVersions.get(snapshot.id)',
    after: 'missionTurnSnapshotVersions.get(0)', second: [store, 'if (Number.isFinite(updatedAt)) missionTurnSnapshotVersions.set(0, { updatedAt, open })'] },
  { name: 'cold discovery bypasses the version gate', before: 'noteMissionTurnSnapshot(mission, chatId)\n    missions = missionTurnEntries(current())',
    after: 'missions = [entryFromMission(mission)]' },
  { name: 'equal open discovery cannot restore an evicted mission', before: duplicate,
    after: 'if (updatedAt === previousVersion.updatedAt) return' },
  { name: 'goal-check completion loses its tombstone', before: 'if (!open && version) version.open = false', after: '' },
]

try {
  cpSync(join(root, 'lib'), join(sandbox, 'lib'), { recursive: true })
  for (const folder of ['test', 'bin', 'tmp']) mkdirSync(join(sandbox, folder))
  for (const file of [...tests, 'package.json', 'bin/hoai-mission-turn-hook.mjs']) {
    writeFileSync(join(sandbox, file), readFileSync(join(root, file)))
  }
  const run = (pattern) => spawnSync(process.execPath, [
    '--import', import.meta.resolve('tsx'), '--test', '--test-reporter=tap', '--test-concurrency=1',
    ...(pattern ? [`--test-name-pattern=${pattern}`] : []), ...tests,
  ], { cwd: sandbox, env: { ...process.env, TSX_DISABLE_CACHE: '1', TMPDIR: join(sandbox, 'tmp') },
    encoding: 'utf8', timeout: 30_000 })
  writeFileSync(join(sandbox, 'server.ts'), original)
  const control = run()
  assert.equal(control.status, 0, 'unmodified control: ' + control.stdout + control.stderr)
  console.log('Control: real daemon, tool, frame and hook regressions pass; one worker')
  for (const mutant of mutants) {
    assert.equal(original.split(mutant.before).length - 1, 1, `unique mutation site: ${mutant.name}`)
    let changed = original.replace(mutant.before, mutant.after)
    if (mutant.second) {
      assert.equal(changed.split(mutant.second[0]).length - 1, 1)
      changed = changed.replace(...mutant.second)
    }
    writeFileSync(join(sandbox, 'server.ts'), changed)
    const result = run('self-write ordering')
    assert.equal(result.status, 1, `mutant must fail: ${mutant.name}`)
    const output = result.stdout + result.stderr
    assert.match(output, /ERR_ASSERTION/, `assertion failure required: ${mutant.name}`)
    const failingTests = [...output.matchAll(/^not ok \d+ - (.+)$/gm)].map((match) => match[1])
    assert.ok(failingTests.length > 0, `named failure required: ${mutant.name}`)
    console.log(JSON.stringify({ mutation: mutant.name, status: 'caught', failingTests }))
  }
  console.log(`Result: ${mutants.length} of ${mutants.length} mutants caught; production files untouched; one worker`)
} finally {
  rmSync(sandbox, { recursive: true, force: true })
}
