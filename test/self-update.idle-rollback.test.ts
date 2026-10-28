/**
 * lib/self-update.ts SelfUpdater.rollbackCheckoutTo: the clone half of the
 * idle update's rollback (docs/idle-update/DESIGN.md, "Rollback").
 *
 * The self updater already knows how to put a shared checkout back safely
 * (attemptRollback): the shared lock, the dirty tree refusal, a detached
 * checkout of a known commit, the dependency reinstall, the shared safety
 * latch that pauses the clone's updates, and a restore of the target when any
 * step fails. But it ends with exit(0), and the 2026-09-11 lesson is that a
 * daemon never exits to restart itself: the idle update restarts through the
 * ladder. So the same steps are offered without the exit, for a commit the
 * idle update recorded (the one the old daemon was running).
 *
 * Run: npx tsx --test test/self-update.idle-rollback.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'

import { EMPTY_AUTO_UPDATE_STATE, initializeSelfUpdater, loadSharedUpdateSafety, saveAutoUpdateState, type CommandRunner } from '../lib/self-update'

const COMMIT_OLD = 'a'.repeat(40)
const COMMIT_NEW = 'b'.repeat(40)
const SCRATCH = process.env.TEMP || process.env.TMPDIR || '.'

function scratch(prefix: string): string {
  return mkdtempSync(join(SCRATCH, prefix))
}

async function updaterOn(opts: { dirty?: boolean; deps?: string; checkoutFails?: boolean; missingCommit?: boolean } = {}) {
  const rootDir = scratch('idle-rollback-root-')
  const gitDir = join(rootDir, '.git')
  mkdirSync(gitDir)
  const stateFilePath = join(scratch('idle-rollback-state-'), 'auto-update.json')
  saveAutoUpdateState(stateFilePath, { ...EMPTY_AUTO_UPDATE_STATE })
  const calls: string[] = []
  const exits: number[] = []
  const logs: string[] = []
  let head = COMMIT_NEW
  const runner: CommandRunner = async (file, args) => {
    const key = `${file} ${args.join(' ')}`
    calls.push(key)
    if (key === 'git rev-parse HEAD') return { stdout: `${head}\n`, stderr: '' }
    if (key === 'git status --porcelain --untracked-files=normal') return { stdout: opts.dirty ? ' M server.ts\n' : '', stderr: '' }
    if (key === `git cat-file -e ${COMMIT_OLD}^{commit}`) {
      if (opts.missingCommit) throw new Error('fatal: not a valid object')
      return { stdout: '', stderr: '' }
    }
    if (key === `git diff --name-only ${COMMIT_OLD} ${COMMIT_NEW} -- bun.lock package.json`) return { stdout: opts.deps ?? '', stderr: '' }
    if (key === `git checkout --detach ${COMMIT_OLD}`) {
      if (opts.checkoutFails) throw new Error('checkout failed')
      head = COMMIT_OLD
      return { stdout: '', stderr: '' }
    }
    if (key === `git checkout --detach ${COMMIT_NEW}`) {
      head = COMMIT_NEW
      return { stdout: '', stderr: '' }
    }
    if (key === 'bun install --frozen-lockfile') return { stdout: '', stderr: '' }
    throw new Error(`unexpected command: ${key}`)
  }
  const updater: any = await initializeSelfUpdater({
    rootDir,
    stateFilePath,
    env: { BGOS_AUTO_UPDATE: 'on' },
    runningVersion: '0.80.0',
    log: (line) => logs.push(line),
    drainSnapshot: () => ({ activeOperations: 0, pendingMessages: 0, pendingPermissions: 0 }),
    setDrainMode: () => {},
    exit: (code) => exits.push(code),
    runner,
  })
  assert.ok(updater, 'the self updater initialised')
  if (typeof updater.rollbackCheckoutTo !== 'function') {
    assert.fail(
      'SelfUpdater.rollbackCheckoutTo is missing: the clone rollback exists only inside attemptRollback, which ends the daemon with ' +
        'exit(0), so a bad build an idle restart landed on cannot be undone without a forced exit',
    )
  }
  return { updater, calls, exits, logs, gitDir, head: () => head }
}

test('the checkout goes back to the recorded commit, updates are latched off, and the daemon does NOT exit', async () => {
  const t = await updaterOn({ deps: 'bun.lock\n' })
  const result = await t.updater.rollbackCheckoutTo(COMMIT_OLD)
  assert.deepEqual(result, { ok: true })
  assert.equal(t.head(), COMMIT_OLD)
  assert.ok(t.calls.includes(`git checkout --detach ${COMMIT_OLD}`))
  assert.ok(t.calls.includes('bun install --frozen-lockfile'), 'the dependencies follow the checkout')
  assert.deepEqual(t.exits, [], 'never an exit: the idle update restarts through the ladder')
  assert.equal(loadSharedUpdateSafety(join(t.gitDir, 'bgos-auto-update-disabled.json')).disabled, true)
  assert.equal(existsSync(join(t.gitDir, 'bgos-auto-update.lock')), false, 'the shared lock is released')
  assert.ok(t.calls.indexOf(`git checkout --detach ${COMMIT_OLD}`) > t.calls.indexOf('git status --porcelain --untracked-files=normal'))
})

test('a checkout with local changes is never touched', async () => {
  const t = await updaterOn({ dirty: true })
  assert.deepEqual(await t.updater.rollbackCheckoutTo(COMMIT_OLD), { ok: false, reason: 'dirty_tree' })
  assert.equal(t.calls.some((c) => c.startsWith('git checkout')), false)
  assert.equal(loadSharedUpdateSafety(join(t.gitDir, 'bgos-auto-update-disabled.json')).disabled, false)
})

test('a recorded commit the checkout does not have is refused before anything changes', async () => {
  const t = await updaterOn({ missingCommit: true })
  const result = await t.updater.rollbackCheckoutTo(COMMIT_OLD)
  assert.equal(result.ok, false)
  assert.equal(t.calls.some((c) => c.startsWith('git checkout')), false)
  assert.equal(loadSharedUpdateSafety(join(t.gitDir, 'bgos-auto-update-disabled.json')).disabled, false)
})

test('a checkout that fails restores the target and clears the latch it armed', async () => {
  const t = await updaterOn({ checkoutFails: true })
  const result = await t.updater.rollbackCheckoutTo(COMMIT_OLD)
  assert.equal(result.ok, false)
  assert.equal(t.head(), COMMIT_NEW)
  assert.equal(loadSharedUpdateSafety(join(t.gitDir, 'bgos-auto-update-disabled.json')).disabled, false)
  assert.deepEqual(t.exits, [])
})

test('only a full commit id is accepted', async () => {
  const t = await updaterOn()
  for (const bad of ['', 'HEAD~1', 'main', '--orphan', 'abc']) {
    const result = await t.updater.rollbackCheckoutTo(bad)
    assert.equal(result.ok, false, bad)
  }
  assert.equal(t.calls.some((c) => c.startsWith('git checkout') || c.startsWith('git status')), false)
})

test('the commit this daemon runs is readable, so the idle update records where a rollback goes back to', async () => {
  const t = await updaterOn()
  assert.equal(t.updater.runningCommitId, COMMIT_NEW, 'SelfUpdater.runningCommitId is missing: the record would have no fromCommit to roll a clone back to')
})
