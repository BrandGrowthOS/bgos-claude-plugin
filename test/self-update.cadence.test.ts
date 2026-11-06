import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { setImmediate as settle } from 'node:timers/promises'
import { test, type TestContext } from 'node:test'

import {
  initializeSelfUpdater,
  loadAutoUpdateState,
  saveSharedUpdateSafety,
  EMPTY_SHARED_UPDATE_SAFETY,
  type DrainSnapshot,
  type SelfUpdaterOptions,
} from '../lib/self-update'
import { scratchDir } from './helpers/scratch-dirs'

const HOUR = 3_600_000
const OLD_COMMIT = 'a'.repeat(40)
const NEW_COMMIT = 'b'.repeat(40)
const QUIET = { activeOperations: 0, pendingMessages: 0, pendingPermissions: 0 }

// Only external IO is doubled. Scheduling, inspection, drain, staging, locks
// and rollback state are the production updater, driven by Node's fake clock.
async function fixture(t: TestContext, opts: {
  env?: Record<string, string | undefined>
  random?: () => number
  snapshot?: () => DrainSnapshot
  requestRestart?: SelfUpdaterOptions['requestRestart']
} = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_800_000_000_000 })
  const rootDir = scratchDir('update-cadence-')
  mkdirSync(join(rootDir, '.git'))
  const stateFilePath = join(rootDir, 'auto-update.json')
  const reads: number[] = []
  const commands: string[] = []
  const drainModes: boolean[] = []
  const exits: number[] = []
  let published = '0.26.0'
  let head = OLD_COMMIT
  const updater = await initializeSelfUpdater({
    rootDir,
    stateFilePath,
    env: opts.env ?? {},
    runningVersion: '0.26.0',
    log: () => {},
    random: opts.random ?? (() => 0),
    drainSnapshot: opts.snapshot ?? (() => QUIET),
    setDrainMode: (enabled) => { drainModes.push(enabled) },
    exit: (code) => { exits.push(code) },
    requestRestart: opts.requestRestart,
    readPublishedTag: async () => {
      reads.push(Date.now())
      return `v${published}`
    },
    runner: async (file, args) => {
      assert.equal(file, 'git')
      const key = args.join(' ')
      commands.push(key)
      let stdout = ''
      if (key === 'rev-parse HEAD') stdout = head
      else if (key === 'status --porcelain --untracked-files=normal') stdout = ''
      else if (key === `fetch --quiet --no-tags origin +refs/tags/v${published}:refs/tags/v${published}`) stdout = ''
      else if (key === `rev-parse refs/tags/v${published}^{commit}`) stdout = NEW_COMMIT
      else if (key === `show ${NEW_COMMIT}:package.json`) stdout = JSON.stringify({ version: published })
      else if (key === `merge-base HEAD ${NEW_COMMIT}`) stdout = OLD_COMMIT
      else if (key === `diff --name-only ${OLD_COMMIT} ${NEW_COMMIT} -- bun.lock package.json`) stdout = ''
      else if (key === `merge --ff-only --no-edit ${NEW_COMMIT}`) head = NEW_COMMIT
      else throw new Error(`unexpected git command: ${key}`)
      return { stdout, stderr: '' }
    },
  })
  return {
    updater, reads, commands, drainModes, exits, rootDir, stateFilePath,
    publish: () => { published = '0.27.0' },
    advance: async (ms: number) => { t.mock.timers.tick(ms); await settle() },
  }
}

for (const [label, random, delay] of [
  ['lower bound', 0, 4 * HOUR],
  ['midpoint', 0.5, 4.5 * HOUR],
  ['upper bound', 1, 5 * HOUR],
  ['negative random', -1, 4 * HOUR],
  ['oversized random', 2, 5 * HOUR],
  ['nonfinite random', Number.NaN, 4 * HOUR],
] as const) {
  test(`scheduled checks use the four-hour cadence and bounded jitter: ${label}`, async (t) => {
    const h = await fixture(t, { random: () => random })
    h.updater!.start()
    await settle()
    assert.equal(h.reads.length, 1, 'check immediately at boot')
    await h.advance(delay - 1)
    assert.equal(h.reads.length, 1, 'no early check')
    await h.advance(1)
    assert.equal(h.reads.length, 2, 'check at the jittered deadline')
    assert.equal(h.reads[1]! - h.reads[0]!, delay)
  })
}

test('each completed check draws fresh jitter for the next check', async (t) => {
  const draws = [0, 1, 0.5]
  const h = await fixture(t, { random: () => draws.shift()! })
  h.updater!.start()
  await settle()
  await h.advance(4 * HOUR)
  assert.equal(h.reads.length, 2)
  await h.advance(5 * HOUR - 1)
  assert.equal(h.reads.length, 2)
  await h.advance(1)
  assert.equal(h.reads.length, 3)
  await h.advance(4.5 * HOUR)
  assert.equal(h.reads.length, 4)
})

test('environment overrides set the interval and jitter used by the scheduler', async (t) => {
  const h = await fixture(t, {
    env: { BGOS_AUTO_UPDATE_INTERVAL_MS: '7200000', BGOS_AUTO_UPDATE_JITTER_MS: '600000' },
    random: () => 0.5,
  })
  h.updater!.start()
  await settle()
  await h.advance(7_500_000 - 1)
  assert.equal(h.reads.length, 1)
  await h.advance(1)
  assert.equal(h.reads.length, 2)
})

test('zero jitter can be configured without disabling the interval', async (t) => {
  const h = await fixture(t, {
    env: { BGOS_AUTO_UPDATE_JITTER_MS: '0' }, random: () => 1,
  })
  h.updater!.start()
  await settle()
  await h.advance(4 * HOUR - 1)
  assert.equal(h.reads.length, 1)
  await h.advance(1)
  assert.equal(h.reads.length, 2)
})

for (const value of ['', '0', '-1', 'nope', 'Infinity', '1.5', '2147483648', '9007199254740992']) {
  test(`invalid interval ${JSON.stringify(value)} falls back without a timer overflow loop`, async (t) => {
    const h = await fixture(t, { env: { BGOS_AUTO_UPDATE_INTERVAL_MS: value } })
    h.updater!.start()
    await settle()
    await h.advance(4 * HOUR - 1)
    assert.equal(h.reads.length, 1)
    await h.advance(1)
    assert.equal(h.reads.length, 2)
  })
}

for (const value of ['', '-1', 'nope', 'Infinity', '1.5', '2147483647']) {
  test(`invalid jitter ${JSON.stringify(value)} falls back to at most one hour`, async (t) => {
    const h = await fixture(t, {
      env: { BGOS_AUTO_UPDATE_JITTER_MS: value }, random: () => 1,
    })
    h.updater!.start()
    await settle()
    await h.advance(5 * HOUR - 1)
    assert.equal(h.reads.length, 1)
    await h.advance(1)
    assert.equal(h.reads.length, 2)
  })
}

for (const counter of ['activeOperations', 'pendingMessages', 'pendingPermissions'] as const) {
  for (const exitOptIn of [false, true]) {
    test(`a scheduled check never restarts while ${counter} is busy, exit opt-in ${exitOptIn}`, async (t) => {
      let busy = true
      const restarts: string[] = []
      const h = await fixture(t, {
        env: exitOptIn ? { BGOS_EXIT_AFTER_UPDATE: '1' } : {},
        snapshot: () => ({ ...QUIET, [counter]: busy ? 1 : 0 }),
        requestRestart: async (version) => { restarts.push(version!); return false },
      })
      h.updater!.start()
      await settle()
      h.publish()
      await h.advance(4 * HOUR)
      assert.equal(h.reads.length, 2, 'new release inspected on schedule')
      await h.advance(15 * 60_000)
      assert.equal(h.commands.some((key) => key.startsWith('merge ')), false)
      assert.deepEqual(h.drainModes, [], 'intake stays open while busy')
      assert.deepEqual(h.exits, [])
      assert.deepEqual(restarts, [])
      assert.equal(loadAutoUpdateState(h.stateFilePath).validationPending, false)
      await h.advance(30 * 60_000 - 1)
      assert.equal(h.reads.length, 2, 'busy retry remains thirty minutes')
      busy = false
      await h.advance(1)
      assert.equal(h.reads.length, 3)
      assert.ok(h.commands.includes(`merge --ff-only --no-edit ${NEW_COMMIT}`))
      assert.deepEqual(h.exits, exitOptIn ? [0] : [])
      assert.deepEqual(restarts, exitOptIn ? [] : ['0.27.0'])
      const state = loadAutoUpdateState(h.stateFilePath)
      assert.equal(state.validationPending, true, 'rollback validation stays armed')
      assert.equal(state.previousCommit, OLD_COMMIT)
      assert.equal(state.targetCommit, NEW_COMMIT)
      if (!exitOptIn) assert.equal(h.drainModes.at(-1), false, 'staging reopens intake')
    })
  }
}

test('the shorter schedule still honors a shared rollback latch', async (t) => {
  const h = await fixture(t)
  h.updater!.start()
  await settle()
  h.publish()
  saveSharedUpdateSafety(join(h.rootDir, '.git', 'bgos-auto-update-disabled.json'), {
    ...EMPTY_SHARED_UPDATE_SAFETY, disabled: true,
  })
  await h.advance(4 * HOUR)
  assert.equal(h.reads.length, 1)
  assert.deepEqual(h.exits, [])
  assert.deepEqual(h.drainModes, [])
})

test('auto-update off does not arm a timer or inspect a release', async (t) => {
  const h = await fixture(t, { env: { BGOS_AUTO_UPDATE: 'off' } })
  assert.equal(h.updater, null)
  await h.advance(24 * HOUR)
  assert.deepEqual(h.reads, [])
  assert.deepEqual(h.commands, [])
})
