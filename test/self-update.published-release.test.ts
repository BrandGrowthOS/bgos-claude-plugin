/**
 * A clone updates to EXACTLY the published release (board row 84c23fab): the commit of the tag the marketplace
 * ref names, never the head of origin/main, never a version that was tagged on main and not published, and a
 * checkout already past the release stays where it is.
 *
 * Real git throughout: a bare origin with releases on it and a real clone (test/helpers/release-origin.ts), run
 * through lib/self-update.ts with its real command runner. Only `bun install` is faked, and the published release
 * (what lib/published-release.mjs reads from the marketplace) is injected.
 *
 * At main these are red for the true reason: the updater fetched origin main and fast-forwarded to its HEAD as
 * soon as main's package.json carried a newer version, so it took every commit merged after the release, and a
 * version bump nobody had published.
 *
 * Run: bun test test/self-update.published-release.test.ts
 */
import { describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { initializeSelfUpdater, runCommand, type CommandRunner } from '../lib/self-update'
import { git, releaseOrigin } from './helpers/release-origin'

const IDLE = { activeOperations: 0, pendingMessages: 0, pendingPermissions: 0 }

// Real git: dozens of git processes per test, several times slower on the Windows runner than bun's 5 s default.
setDefaultTimeout(120_000)

/** A daemon's updater on `clone`, running `running`, with the marketplace publishing whatever `published` says. */
async function updaterFor(clone: string, opts: { running: string; published: () => string; logs?: string[] }) {
  const stateDir = realpathSync(mkdtempSync(join(tmpdir(), 'published-release-state-')))
  const runner: CommandRunner = async (file, args, runnerOpts) =>
    file === 'bun' ? { stdout: '', stderr: '' } : runCommand(file, args, runnerOpts)
  const updater = await initializeSelfUpdater({
    rootDir: clone,
    stateFilePath: join(stateDir, 'auto-update.json'),
    env: { BGOS_AUTO_UPDATE: 'on' },
    runningVersion: opts.running,
    log: (line) => opts.logs?.push(line),
    drainSnapshot: () => IDLE,
    setDrainMode: () => {},
    exit: () => {
      throw new Error('this host is not supervised; the updater must never exit')
    },
    runner,
    readPublishedTag: async () => opts.published(),
    schedule: () => setTimeout(() => {}, 60_000),
  })
  expect(updater).not.toBeNull()
  return updater!
}

const head = (dir: string) => git(dir, 'rev-parse', 'HEAD')
const noStages = async () => {}

describe('a clone updates to exactly the published release (board row 84c23fab)', () => {
  test('a commit merged to main after the published release is never taken', async () => {
    const o = releaseOrigin()
    o.commit('0.26.0')
    const clone = o.clone()
    const released = o.commit('0.27.0', 'release 0.27.0')
    o.tag('v0.27.0', released)
    o.commit('0.27.0', 'merged after the release')
    const unpublished = o.commit('0.28.0', 'bumped and auto-tagged, never published')
    o.tag('v0.28.0', unpublished)

    const updater = await updaterFor(clone, { running: '0.26.0', published: () => 'v0.27.0' })
    expect(await updater.updateNow(noStages)).toEqual({ kind: 'installed', targetVersion: '0.27.0' })
    expect(head(clone)).toBe(released)
    expect(updater.latestKnownVersion).toBe('0.27.0')
  })

  test('the nightly check lands on the same commit, not on main', async () => {
    const o = releaseOrigin()
    o.commit('0.26.0')
    const clone = o.clone()
    const released = o.commit('0.27.0', 'release 0.27.0')
    o.tag('v0.27.0', released)
    o.commit('0.27.0', 'merged after the release')
    o.tag('v0.28.0', o.commit('0.28.0', 'bumped and auto-tagged, never published'))

    const logs: string[] = []
    const updater = await updaterFor(clone, { running: '0.26.0', published: () => 'v0.27.0', logs })
    await updater.checkNow()
    expect(head(clone)).toBe(released)
    expect(logs).toContain('Auto-update installed 0.26.0 to 0.27.0.')
  })

  test('a release tagged on main is not taken until it is published, and then exactly at its tag', async () => {
    const o = releaseOrigin()
    const current = o.commit('0.27.0', 'release 0.27.0')
    o.tag('v0.27.0', current)
    const clone = o.clone()
    o.commit('0.27.0', 'docs after 0.27.0')
    const next = o.commit('0.28.0', 'release 0.28.0')
    o.tag('v0.28.0', next)
    o.commit('0.28.0', 'merged after 0.28.0')

    let published = 'v0.27.0'
    const updater = await updaterFor(clone, { running: '0.27.0', published: () => published })
    // Tagged by release-tag.yml, not yet named by the marketplace: nothing moves.
    expect(await updater.updateNow(noStages)).toEqual({ kind: 'no-update', latestVersion: '0.27.0', reason: 'not-newer' })
    expect(head(clone)).toBe(current)
    // Published: taken, at the tag's own commit.
    published = 'v0.28.0'
    expect(await updater.updateNow(noStages)).toEqual({ kind: 'installed', targetVersion: '0.28.0' })
    expect(head(clone)).toBe(next)
  })

  test('a clone already ahead of the published release stays where it is', async () => {
    const o = releaseOrigin()
    o.tag('v0.27.0', o.commit('0.27.0', 'release 0.27.0'))
    const ahead = o.commit('0.27.0', 'merged after the release')
    // The fleet today: clones that followed origin/main before this change sit past the tag.
    const clone = o.clone()
    o.tag('v0.28.0', o.commit('0.28.0', 'bumped and auto-tagged, never published'))

    const updater = await updaterFor(clone, { running: '0.27.0', published: () => 'v0.27.0' })
    expect(await updater.updateNow(noStages)).toEqual({ kind: 'no-update', latestVersion: '0.27.0', reason: 'not-newer' })
    expect(head(clone)).toBe(ahead)
    await updater.checkNow()
    expect(head(clone)).toBe(ahead)
  })

  test('a depth 1 clone already past the release fetches nothing for its not-newer answer', async () => {
    const o = releaseOrigin()
    o.tag('v0.27.0', o.commit('0.27.0', 'release 0.27.0'))
    o.commit('0.27.0', 'merged after the release')
    const ahead = o.commit('0.27.0', 'merged after the release, again')
    const clone = o.clone({ shallow: true })
    const objectsBefore = git(clone, 'count-objects', '-v')

    const updater = await updaterFor(clone, { running: '0.27.0', published: () => 'v0.27.0' })
    expect(await updater.updateNow(noStages)).toEqual({ kind: 'no-update', latestVersion: '0.27.0', reason: 'not-newer' })
    expect(updater.latestKnownVersion).toBe('0.27.0')
    expect(head(clone)).toBe(ahead)
    // The release tag sits behind the shallow boundary; fetching it would have pulled its whole history.
    expect(git(clone, 'tag', '--list', 'v0.27.0')).toBe('')
    expect(git(clone, 'count-objects', '-v')).toBe(objectsBefore)
  })

  test('a developer checkout with its own commits past the release is never moved, forward or back', async () => {
    const o = releaseOrigin()
    o.tag('v0.27.0', o.commit('0.27.0', 'release 0.27.0'))
    const clone = o.clone()
    const local = o.localCommit(clone, '0.28.0', 'work in progress')
    o.tag('v0.28.0', o.commit('0.28.0', 'release 0.28.0'))

    // Same version published as the checkout carries, on a commit it does not descend from.
    const updater = await updaterFor(clone, { running: '0.28.0', published: () => 'v0.28.0' })
    expect(await updater.updateNow(noStages)).toEqual({ kind: 'no-update', latestVersion: '0.28.0', reason: 'not-newer' })
    expect(head(clone)).toBe(local)
    // A newer release it cannot fast-forward to is refused, and nothing moves.
    const newer = await updaterFor(clone, { running: '0.27.0', published: () => 'v0.28.0' })
    expect(await newer.updateNow(noStages)).toEqual({ kind: 'not-fast-forward' })
    expect(head(clone)).toBe(local)
  })

  test('a depth 1 field clone fetches only the published tag, never main, and lands on it', async () => {
    const o = releaseOrigin()
    const current = o.commit('0.27.0', 'release 0.27.0')
    o.tag('v0.27.0', current)
    const clone = o.clone({ shallow: true })
    o.commit('0.27.0', 'docs after 0.27.0')
    const next = o.commit('0.28.0', 'release 0.28.0')
    o.tag('v0.28.0', next)
    o.commit('0.28.0', 'merged after 0.28.0')

    const updater = await updaterFor(clone, { running: '0.27.0', published: () => 'v0.28.0' })
    expect(await updater.updateNow(noStages)).toEqual({ kind: 'installed', targetVersion: '0.28.0' })
    expect(head(clone)).toBe(next)
    // origin/main was never fetched: it still points where the clone was made.
    expect(git(clone, 'rev-parse', 'refs/remotes/origin/main')).toBe(current)
  })

  test('a published release that cannot be read changes nothing, and the daemon keeps serving', async () => {
    const o = releaseOrigin()
    o.commit('0.26.0')
    const clone = o.clone()
    const before = head(clone)
    o.tag('v0.27.0', o.commit('0.27.0', 'release 0.27.0'))

    const logs: string[] = []
    const unreadable = () => {
      throw new Error('the published release could not be read from https://raw.githubusercontent.com/x: HTTP 503')
    }
    const updater = await updaterFor(clone, { running: '0.26.0', published: unreadable, logs })
    const outcome = await updater.updateNow(noStages)
    expect(outcome.kind).toBe('failed')
    expect(outcome).toMatchObject({ latched: false })
    expect((outcome as { message: string }).message).toContain('HTTP 503')
    await updater.checkNow()
    expect(logs.some((line) => line.includes('daemon will continue') && line.includes('HTTP 503'))).toBe(true)
    expect(head(clone)).toBe(before)
    expect(updater.latestKnownVersion).toBeNull()
  })

  test('a published tag whose package.json carries another version is refused', async () => {
    const o = releaseOrigin()
    o.commit('0.26.0')
    const clone = o.clone()
    const before = head(clone)
    // A tag on a commit that does not carry its version: not a release this updater can name.
    o.tag('v0.28.0', o.commit('0.27.0', 'mis-tagged'))

    const updater = await updaterFor(clone, { running: '0.26.0', published: () => 'v0.28.0' })
    const outcome = await updater.updateNow(noStages)
    expect(outcome).toMatchObject({ kind: 'failed', latched: false })
    expect((outcome as { message: string }).message).toContain('v0.28.0 carries package.json version 0.27.0')
    expect(head(clone)).toBe(before)
  })
})
