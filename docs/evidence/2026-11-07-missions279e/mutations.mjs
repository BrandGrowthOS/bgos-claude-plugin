// Revert proofs and targeted faults execute real production functions in a
// disposable copy inside this checkout. Exactly one test worker per run.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(process.cwd())
const scratch = join(root, '.laneenv6-tmp/missions279e')
mkdirSync(scratch, { recursive: true })
const sandbox = mkdtempSync(join(scratch, 'proof-'))
const files = ['server.ts', 'lib/mission-turn.mjs']
const original = Object.fromEntries(files.map((file) => [file, readFileSync(join(root, file), 'utf8')]))
const tests = ['test/mission-turn-refresh.test.ts', 'test/mission-turn-snapshots.test.ts', 'test/mission-turn.test.ts']
const base = '53092a5bb4eaf92e76fd2d40cb36c435fbb04329'
const terminalBranch = `  if (['completed', 'abandoned', 'failed'].includes(observation.status)) {
    const confirmed = entryFromReport(await bgosGetCachedOn304(checksPath), mission.title, Date.now())
    if (!sameMissionTurnGoals(observation, confirmed)) return null
    return { entry: confirmed, acceptance: { terminalConfirmed: true } }
  }
`
const mutants = [
  ['revert terminal report fix', 'server.ts', terminalBranch, '', 'unversioned terminal|unversioned completion'],
  ['revert equal timestamp fix', 'lib/mission-turn.mjs', ' || (reconciled && time === oldTime)', '', 'confirmed equal revision'],
  ['skip terminal confirmation read', 'server.ts', 'const confirmed = entryFromReport(await bgosGetCachedOn304(checksPath), mission.title, Date.now())', 'const confirmed = observation', 'unversioned terminal confirmation rejects'],
  ['ignore terminal report agreement', 'server.ts', 'if (!sameMissionTurnGoals(observation, confirmed)) return null', 'if (false) return null', 'unversioned terminal confirmation rejects'],
  ['forget terminal tombstone', 'lib/mission-turn.mjs', 'held.set(incoming.missionId, { chatId, entry, terminal: true })', '// terminal state forgotten', 'unversioned terminal|unversioned completion'],
  ['forge a terminal revision', 'lib/mission-turn.mjs', 'const entry = structuredClone(incoming)\n        held.set', 'const entry = { ...structuredClone(incoming), updatedAt: prior.entry.updatedAt }\n        held.set', 'unversioned terminal confirmation requires'],
  ['remove per-chat generation bump', 'server.ts', 'missionTurnRevisions.set(chatId, (missionTurnRevisions.get(chatId) ?? 0) + 1)', '// generation bump removed', 'unversioned terminal read'],
  ['remove store chat binding', 'lib/mission-turn.mjs', '(prior && prior.chatId !== chatId)', 'false', 'unversioned terminal confirmation requires|wrong-chat write'],
  ['let versioned reports replace equal-time goals', 'server.ts', 'return { entry: entryFromReport(report, mission.title, Date.now()) }', 'return { entry: entryFromReport(report, mission.title, Date.now()), acceptance: { reconciled: true } }', 'equal report revisions'],
  ['let confirmed older reads replace goals', 'lib/mission-turn.mjs', '(reconciled && time === oldTime)', '(reconciled && time <= oldTime)', 'confirmed legacy reads with an inverted timestamp'],
]
const replaceOnce = (source, before, after, name) => {
  assert.equal(source.split(before).length - 1, 1, `one mutation site: ${name}`)
  return source.replace(before, after)
}
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
    encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024 })
  const mustFail = (name, result) => {
    const output = result.stdout + result.stderr
    assert.equal(result.status, 1, `${name}: expected exit 1, got ${result.status}: ${output.slice(-3000)}`)
    assert.match(output, /ERR_ASSERTION/, `${name}: expected assertion failure`)
    assert.doesNotMatch(output, /ReferenceError|SyntaxError|ERR_MODULE_NOT_FOUND|ERR_UNKNOWN_FILE_EXTENSION/, `${name}: loading is not a regression proof`)
    const failures = [...output.matchAll(/^\s*not ok \d+ - (.+)$/gm)].map((m) => m[1])
    assert.ok(failures.length > 0)
    console.log(JSON.stringify({ name, exit: result.status, caught: true, failingTests: failures }))
  }
  restore()
  const control = run()
  assert.equal(control.status, 0, control.stdout + control.stderr)
  console.log('Control: all three mission files pass with one worker')
  for (const file of files) writeFileSync(join(sandbox, file), execFileSync('git', ['show', `${base}:${file}`], { cwd: root }))
  mustFail('both production fixes reverted to reviewed HEAD', run('unversioned terminal|unversioned completion|confirmed equal revision|T0 snapshot, T2 unversioned'))
  for (const [name, file, before, after, pattern] of mutants) {
    restore()
    writeFileSync(join(sandbox, file), replaceOnce(original[file], before, after, name))
    mustFail(name, run(pattern))
  }
  restore()
  const restored = run()
  assert.equal(restored.status, 0, restored.stdout + restored.stderr)
  console.log(`Result: both independent fix reverts fail; ${mutants.length}/${mutants.length} reverts and targeted faults caught; restored control passes; one worker`)
  for (const file of files) assert.equal(readFileSync(join(root, file), 'utf8'), original[file], `checkout unchanged: ${file}`)
} finally {
  rmSync(sandbox, { recursive: true, force: true })
}
