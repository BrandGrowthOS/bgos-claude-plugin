/**
 * Board row 10f8bc52 (Data decided 2026-11-16): a build marked bad on the
 * checkout wins over a good answer the self updater staged.
 *
 * The case, from the idleupd3 review: an agent installed by clone, with a
 * second checkout under the same HOME. Its self updater staged a good target
 * (auto-update.json validationPending, or its live state). Meanwhile the
 * checkout this daemon runs from moved to a build that is marked bad on this
 * computer (<machineDir>/<version>/bad, lib/idle-update.mjs isVersionHeldBad).
 * A restart of a clone boots whatever the checkout holds, not what the self
 * updater names, so #185's rule (the self updater's answer wins over the
 * checkout, lib/pending-restart.ts E5) made the staged good answer hide the
 * bad checkout: the heartbeat, agent-state.json (so the watcher), a click and
 * the idle update all restarted the agent, and it came up on the bad build.
 *
 * The decision: for this case the bad mark on the checkout wins, so an agent
 * never restarts onto a known bad build; #185's rule stands everywhere else.
 * The agent holds on the build it runs and says why in plain words.
 *
 * Run: npx tsx --test test/pending-restart.bad-checkout.test.ts
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import * as pendingRestart from '../lib/pending-restart.ts'
import { readOwnVersion } from '../lib/version-heartbeat.ts'
import { decidePendingRestart } from '../lib/keepalive-plan.mjs'
import { decideIdleUpdate, idleUpdateWaitError, isVersionHeldBad, nodeIdleUpdateFs } from '../lib/idle-update.mjs'

const { resolvePendingRestartVersion } = pendingRestart
// Read off the module object, so a missing export fails its own assertion instead of the whole file.
const heldBadCheckoutVersion = (input: any): string | null => {
  const fn = (pendingRestart as any).heldBadCheckoutVersion
  assert.equal(typeof fn, 'function', 'lib/pending-restart.ts exports heldBadCheckoutVersion')
  return fn(input)
}

const RUNNING = '0.90.0'
const STAGED_GOOD = '0.91.0'
const CHECKOUT_BAD = '0.92.0'

/** The two checkout case, with every source of the clone answer named. */
const twoCheckouts = (over: Record<string, unknown> = {}) => ({
  installMethod: 'clone' as const,
  runningVersion: RUNNING,
  updaterPending: () => STAGED_GOOD,
  stagedTargetVersion: () => STAGED_GOOD,
  readInstalledPlugins: () => null,
  readCheckoutVersion: () => CHECKOUT_BAD,
  heldBad: (v: string) => v === CHECKOUT_BAD,
  ...over,
})

/** What the idle update reads (server.ts daemonStagedVersion): the latched answer, then the unlatched one, which
 *  for a clone names its checkout held bad before anything else. */
const staged = (input: any): string | null =>
  resolvePendingRestartVersion(input) ?? heldBadCheckoutVersion(input) ?? resolvePendingRestartVersion({ ...input, heldBad: undefined })

test('two checkouts: a checkout held bad wins over a good staged answer, so nothing is pending', () => {
  assert.equal(resolvePendingRestartVersion(twoCheckouts()), null, 'the self updater\'s live answer does not hide the bad checkout')
  assert.equal(
    resolvePendingRestartVersion(twoCheckouts({ updaterPending: () => null })),
    null,
    'the staged auto-update.json target does not hide it either',
  )
  // The watcher believes a fresh daemon (decidePendingRestart, review daemon F7): null is no restart.
  assert.equal(
    decidePendingRestart({
      canonical: true,
      generation: 2,
      stateFresh: true,
      runningVersion: RUNNING,
      pendingRestartVersion: resolvePendingRestartVersion(twoCheckouts()),
      installedVersion: null,
      claudeStartedAtMs: null,
      installLandedAtMs: null,
    } as any),
    null,
  )
})

test('two checkouts: the idle update reads the bad checkout and holds on the running build with a plain reason', () => {
  const reading = staged(twoCheckouts())
  assert.equal(reading, CHECKOUT_BAD, 'the build a restart would boot, not the staged good one')
  const decision = decideIdleUpdate({
    autoUpdateEnabled: true,
    stagedVersion: reading,
    runningVersion: RUNNING,
    active: true,
    watcherSweepActive: false,
    heldBad: true,
  })
  assert.deepEqual(decision, { action: 'wait', reason: 'version_held_bad' })
  const report = idleUpdateWaitError(decision.reason, { target: reading, runningVersion: RUNNING, now: Date.parse('2026-11-16T12:00:00Z') })
  assert.equal(report?.code, 'idle_update_held')
  assert.equal(report?.message, `Plugin ${CHECKOUT_BAD} is held on this computer after it failed here; this agent stays on ${RUNNING}.`)
})

test('heldBadCheckoutVersion: only a checkout a restart would boot, held bad here, and never a throw', () => {
  const boom = () => {
    throw new Error('EIO')
  }
  const cases: Array<[string, Record<string, unknown>, string | null]> = [
    ['the case: the checkout differs from the running build and is held', {}, CHECKOUT_BAD],
    ['a good checkout holds nothing', { readCheckoutVersion: () => '0.92.1' }, null],
    ['a checkout equal to the running build is no restart onto it', { readCheckoutVersion: () => RUNNING, heldBad: () => true }, null],
    ['an older checkout held bad is still what a restart would boot', { readCheckoutVersion: () => '0.89.0', heldBad: (v: string) => v === '0.89.0' }, '0.89.0'],
    ['no latch reader holds nothing', { heldBad: undefined }, null],
    ['a latch reader that throws holds nothing', { heldBad: boom }, null],
    ['a latch reader that answers anything but true holds nothing', { heldBad: () => undefined }, null],
    ['a checkout reader that throws holds nothing', { readCheckoutVersion: boom }, null],
    ['an unreadable checkout holds nothing', { readCheckoutVersion: () => null }, null],
    ['an unknown running build holds nothing', { runningVersion: null }, null],
    ['a marketplace install has no checkout', { installMethod: 'marketplace' }, null],
  ]
  for (const [name, over, expected] of cases) assert.equal(heldBadCheckoutVersion(twoCheckouts(over)), expected, name)
})

test('#185 everywhere else: the self updater\'s answer still wins over a checkout that is not held bad', () => {
  assert.equal(resolvePendingRestartVersion(twoCheckouts({ heldBad: () => false })), STAGED_GOOD, 'a good checkout: the staged answer wins')
  assert.equal(resolvePendingRestartVersion(twoCheckouts({ readCheckoutVersion: () => RUNNING })), STAGED_GOOD, 'the checkout still on the running build')
  assert.equal(resolvePendingRestartVersion(twoCheckouts({ readCheckoutVersion: () => STAGED_GOOD })), STAGED_GOOD, 'the checkout on the staged build')
  assert.equal(resolvePendingRestartVersion(twoCheckouts({ heldBad: undefined })), STAGED_GOOD, 'no latch reader: #185 unchanged')
  assert.equal(staged(twoCheckouts({ heldBad: () => false })), STAGED_GOOD, 'the idle update reads the staged good build')
  // A staged answer held bad with a good checkout past it: the existing latch rule, unchanged.
  assert.equal(
    resolvePendingRestartVersion(twoCheckouts({ updaterPending: () => CHECKOUT_BAD, stagedTargetVersion: () => null, readCheckoutVersion: () => '0.92.1' })),
    '0.92.1',
  )
})

test('two checkouts, with the real readers: a package.json on a build marked bad in the machine folder', () => {
  const root = mkdtempSync(join(tmpdir(), 'bad-checkout-root-'))
  const machineDir = mkdtempSync(join(tmpdir(), 'bad-checkout-machine-'))
  try {
    const writeVersion = (version: string) =>
      writeFileSync(join(root, 'package.json'), `${JSON.stringify({ name: 'claude-channel-bgos', version }, null, 2)}\n`)
    writeVersion(RUNNING)
    const runningVersion = readOwnVersion(root)
    const fs = nodeIdleUpdateFs()
    const input = () =>
      twoCheckouts({
        runningVersion,
        readCheckoutVersion: () => readOwnVersion(root),
        heldBad: (v: string) => isVersionHeldBad(v, { machineDir, fs }),
      })
    // The second checkout's agent moved this tree; nothing is marked yet, so #185's rule answers.
    writeVersion(CHECKOUT_BAD)
    assert.equal(resolvePendingRestartVersion(input()), STAGED_GOOD)
    // An agent on the same HOME failed on that build and marked it.
    mkdirSync(join(machineDir, CHECKOUT_BAD), { recursive: true })
    writeFileSync(join(machineDir, CHECKOUT_BAD, 'bad'), '')
    assert.equal(resolvePendingRestartVersion(input()), null, 'the mark wins: no restart boots the bad build')
    assert.equal(staged(input()), CHECKOUT_BAD)
    // The checkout put back on the running build (the idle update's way down) leaves #185's answer again.
    writeVersion(RUNNING)
    assert.equal(resolvePendingRestartVersion(input()), STAGED_GOOD)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(machineDir, { recursive: true, force: true })
  }
})

test('server.ts: the idle update reads the held checkout before the unlatched answer, and the click\'s self updater reads the checkout', () => {
  const server = readFileSync(new URL('../server.ts', import.meta.url), 'utf8')
  const at = server.indexOf('function daemonStagedVersion(')
  assert.ok(at >= 0)
  assert.match(
    server.slice(at, server.indexOf('\n}\n', at)),
    /return daemonPendingRestartVersion\(\) \?\? daemonPendingRestartVersion\(undefined, \{ latched: false \}\)/,
  )
  const pending = server.indexOf('function daemonPendingRestartVersion(')
  assert.ok(pending >= 0)
  assert.match(
    server.slice(pending, server.indexOf('\n}\n', pending)),
    /\): string \| null \{\n  if \(!latched\) \{\n    const held = daemonHeldBadCheckoutVersion\(\)\n    if \(held\) return held\n  \}\n  return resolvePendingRestartVersion\(\{/,
  )
  const held = server.indexOf('function daemonHeldBadCheckoutVersion(')
  assert.ok(held >= 0)
  const body = server.slice(held, server.indexOf('\n}\n', held))
  assert.match(body, /heldBadCheckoutVersion\(\{/)
  assert.match(body, /installMethod: INSTALL_METHOD,/)
  assert.match(body, /runningVersion: RUNNING_VERSION,/)
  assert.match(body, /readCheckoutVersion: \(\) => readOwnVersion\(RUNNING_ROOT\),/)
  assert.match(body, /heldBad: idleUpdateHeldBad,/)
  const init = server.indexOf('selfUpdater = await initializeSelfUpdater({')
  assert.ok(init >= 0)
  assert.match(server.slice(init, init + 400), /\n    readCheckoutVersion: \(\) => readOwnVersion\(RUNNING_ROOT\),\n/)
})
