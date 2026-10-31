/**
 * `npm test` hands every test the REAL temp folder. On macOS $TMPDIR (/var/folders/...) is a link into /private/var,
 * and the browser profile code refuses a path through a link on purpose, so on a stock Mac the browser profile tests
 * were refused (45 failures) and two of them hung, while CI (Linux, a real /tmp) never saw it. The runner now resolves
 * the folder once (scripts/run-tests-env.mjs) before it starts any test family.
 *
 * Run: npx tsx --test test/run-tests-tmpdir.test.ts
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const helper: any = await import('../scripts/run-tests-env.mjs').catch((err) => {
  if (err?.code === 'ERR_MODULE_NOT_FOUND') return null
  throw err
})

test('a temp folder reached through a link is handed over as its real path', { skip: process.platform === 'win32' ? 'no symlinked temp folder to stand in for on Windows' : false }, () => {
  assert.ok(helper, 'scripts/run-tests-env.mjs does not exist: the tests get $TMPDIR as it is, link and all')
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'run-tests-tmpdir-')))
  const real = join(root, 'private', 'var', 'T')
  mkdirSync(real, { recursive: true })
  const link = join(root, 'var')
  symlinkSync(join(root, 'private', 'var'), link)
  const env: Record<string, string | undefined> = { TMPDIR: `${join(link, 'T')}/` }
  helper.useRealTmpdir(env, 'darwin', () => join(link, 'T'))
  assert.equal(env.TMPDIR, real)
  // Linux: /tmp is already real, and it stays what it is.
  const linux: Record<string, string | undefined> = { TMPDIR: real }
  helper.useRealTmpdir(linux, 'linux', () => real)
  assert.equal(linux.TMPDIR, real)
})

test('on Windows the temp folder is left alone, and a folder that cannot be resolved changes nothing', () => {
  assert.ok(helper, 'scripts/run-tests-env.mjs does not exist')
  const win: Record<string, string | undefined> = { TEMP: 'C:\\\\Temp' }
  helper.useRealTmpdir(win, 'win32', () => 'C:\\\\Temp')
  assert.deepEqual(win, { TEMP: 'C:\\\\Temp' })
  const gone: Record<string, string | undefined> = { TMPDIR: '/nowhere/at/all' }
  helper.useRealTmpdir(gone, 'darwin', () => '/nowhere/at/all')
  assert.deepEqual(gone, { TMPDIR: '/nowhere/at/all' })
})

test('the runner resolves the temp folder before it starts any test family', () => {
  const runner = readFileSync(new URL('../scripts/run-tests.mjs', import.meta.url), 'utf8')
  const call = runner.indexOf('useRealTmpdir(process.env')
  assert.ok(call > -1, 'scripts/run-tests.mjs calls useRealTmpdir(process.env, ...)')
  assert.ok(call < runner.indexOf("run('node:test family'") || runner.indexOf("run('node:test family'") === -1, 'before the first family runs')
  assert.ok(call < runner.indexOf('spawnSync(command'), 'before the runner spawns anything')
})
