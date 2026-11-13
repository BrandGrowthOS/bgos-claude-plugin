/**
 * lib/follow-published.mjs: the one step every clone install path that is NOT the daemon takes to move a
 * checkout (board row 01a0db74, KC 2026-10-30: "Follow the published version"). `hoai-agent update`,
 * `hoai-agent install`, `bgos-claim` and the bootstrap scripts all go through it, so a merged change reaches a
 * clone only once the marketplace ref names it.
 *
 * Real git throughout (test/helpers/release-origin.ts): a bare origin whose main runs AHEAD of the published tag,
 * the way it does between a merge and a publish. The published release (what lib/published-release.mjs reads from
 * the marketplace) is injected.
 *
 * Run: npx tsx --test test/follow-published.test.ts
 */
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { git, releaseOrigin } from './helpers/release-origin.ts'

// Only a missing module reads as missing; a module that does not load is a failure of its own.
const follow: any = await import('../lib/follow-published.mjs').catch((err) => {
  if (err?.code === 'ERR_MODULE_NOT_FOUND') return null
  throw err
})
const NO_MODULE = 'lib/follow-published.mjs does not exist: a clone installer moves to origin/main, not to the published release'
const SLOW = { timeout: 120_000 }

const head = (dir: string) => git(dir, 'rev-parse', 'HEAD')
const published = (tag: string) => async () => tag

/** An origin with a published release, then main moving on past it: a merge, and a bump that was tagged and never published. */
function aheadOfPublished() {
  const o = releaseOrigin('follow-published-')
  const old = o.commit('0.26.0', 'release 0.26.0')
  o.tag('v0.26.0', old)
  const behind = o.clone()
  const released = o.commit('0.27.0', 'release 0.27.0')
  o.tag('v0.27.0', released)
  o.commit('0.27.0', 'merged after the release')
  const unpublished = o.commit('0.28.0', 'bumped and auto-tagged, never published')
  o.tag('v0.28.0', unpublished)
  return { o, behind, released, unpublished }
}

test('a clone behind the published release moves to exactly the tag the marketplace names, never to main past it', SLOW, async () => {
  assert.ok(follow, NO_MODULE)
  const { o, behind, released, unpublished } = aheadOfPublished()
  const result = await follow.followPublishedRelease({ dir: behind, readPublishedTag: published('v0.27.0') })
  assert.equal(result.outcome, 'moved', result.message)
  assert.equal(head(behind), released)
  assert.notEqual(head(behind), unpublished)
  assert.equal(result.from, '0.26.0')
  assert.equal(result.to, '0.27.0')
  assert.match(result.message, /0\.26\.0 to 0\.27\.0/)
  assert.match(result.message, /v0\.27\.0/)
  // Only the published tag came over; the bump nobody published did not.
  assert.equal(git(behind, 'tag', '--list', 'v0.28.0'), '')
  assert.ok(o.bare)
})

test('a depth 1 field clone fetches only the published tag, stays shallow, and lands on it', SLOW, async () => {
  assert.ok(follow, NO_MODULE)
  const o = releaseOrigin('follow-published-shallow-')
  o.tag('v0.26.0', o.commit('0.26.0', 'release 0.26.0'))
  o.commit('0.26.0', 'history the clone never needs')
  const clone = o.clone({ shallow: true })
  const released = o.commit('0.27.0', 'release 0.27.0')
  o.tag('v0.27.0', released)
  o.commit('0.27.0', 'merged after the release')
  const result = await follow.followPublishedRelease({ dir: clone, readPublishedTag: published('v0.27.0') })
  assert.equal(result.outcome, 'moved', result.message)
  assert.equal(head(clone), released)
  assert.equal(git(clone, 'rev-parse', '--is-shallow-repository'), 'true', 'a depth 1 clone is not deepened to full history')
  assert.equal(git(clone, 'rev-list', '--count', 'HEAD'), '1', 'only the release commit came over')
})

test('a clone AHEAD of the published release is never moved back: it says so and waits for the release to catch up', SLOW, async () => {
  assert.ok(follow, NO_MODULE)
  const { o, unpublished } = aheadOfPublished()
  const ahead = o.clone()
  assert.equal(head(ahead), unpublished)
  const result = await follow.followPublishedRelease({ dir: ahead, readPublishedTag: published('v0.27.0') })
  assert.equal(result.outcome, 'ahead', result.message)
  assert.equal(head(ahead), unpublished, 'not downgraded')
  assert.match(result.message, /0\.28\.0 is ahead of the published release v0\.27\.0/)
  assert.match(result.message, /stays at 0\.28\.0 until/)
  // Once the marketplace names it, the same clone follows.
  const later = await follow.followPublishedRelease({ dir: ahead, readPublishedTag: published('v0.28.0') })
  assert.equal(later.outcome, 'current', later.message)
  assert.equal(head(ahead), unpublished)
})

test('a clone at the published version with later commits on it stays where it is', SLOW, async () => {
  assert.ok(follow, NO_MODULE)
  const o = releaseOrigin('follow-published-current-')
  o.tag('v0.27.0', o.commit('0.27.0', 'release 0.27.0'))
  const after = o.commit('0.27.0', 'merged after the release')
  const clone = o.clone()
  const result = await follow.followPublishedRelease({ dir: clone, readPublishedTag: published('v0.27.0') })
  assert.equal(result.outcome, 'current', result.message)
  assert.equal(head(clone), after)
})

test('a marketplace that cannot be read, or names no release, leaves the clone where it is', SLOW, async () => {
  assert.ok(follow, NO_MODULE)
  const { behind } = aheadOfPublished()
  const before = head(behind)
  const offline = await follow.followPublishedRelease({
    dir: behind,
    readPublishedTag: async () => {
      throw new Error('the published release could not be read from https://example.invalid: fetch failed')
    },
  })
  assert.equal(offline.outcome, 'unknown', offline.message)
  assert.match(offline.message, /could not be read/)
  assert.match(offline.message, /stays at 0\.26\.0/)
  assert.equal(head(behind), before)
  for (const bad of ['main', 'v0.27', '0.27.0', 'v0.27.0; rm -rf /']) {
    const result = await follow.followPublishedRelease({ dir: behind, readPublishedTag: published(bad) })
    assert.equal(result.outcome, 'unknown', `${bad}: ${result.message}`)
    assert.equal(head(behind), before, bad)
  }
})

test('a published tag whose package.json carries another version is refused, and nothing moves', SLOW, async () => {
  assert.ok(follow, NO_MODULE)
  const o = releaseOrigin('follow-published-mislabel-')
  o.tag('v0.26.0', o.commit('0.26.0', 'release 0.26.0'))
  const clone = o.clone()
  o.tag('v0.27.0', o.commit('0.26.5', 'a tag on the wrong commit'))
  const result = await follow.followPublishedRelease({ dir: clone, readPublishedTag: published('v0.27.0') })
  assert.equal(result.outcome, 'failed', result.message)
  assert.match(result.message, /v0\.27\.0 carries package\.json version 0\.26\.5/)
  assert.equal(git(clone, 'show', 'HEAD:package.json').includes('"0.26.0"'), true)
})

test('a checkout with local changes is never touched', SLOW, async () => {
  assert.ok(follow, NO_MODULE)
  const { behind } = aheadOfPublished()
  const before = head(behind)
  writeFileSync(join(behind, 'notes.md'), 'an edit someone is in the middle of\n')
  let asked = false
  const result = await follow.followPublishedRelease({
    dir: behind,
    readPublishedTag: async () => {
      asked = true
      return 'v0.27.0'
    },
  })
  assert.equal(result.outcome, 'dirty', result.message)
  assert.equal(asked, false, 'not even the marketplace is read')
  assert.equal(head(behind), before)
})

test('a checkout with commits of its own that no remote or tag holds is never reset over them (review of 01a0db74)', SLOW, async () => {
  assert.ok(follow, NO_MODULE)
  const o = releaseOrigin('follow-published-local-')
  o.tag('v0.26.0', o.commit('0.26.0', 'release 0.26.0'))
  const clone = o.clone()
  const local = o.localCommit(clone, '0.26.1', 'work nobody pushed')
  o.tag('v0.27.0', o.commit('0.27.0', 'release 0.27.0'))
  const result = await follow.followPublishedRelease({ dir: clone, readPublishedTag: published('v0.27.0') })
  assert.equal(result.outcome, 'failed', result.message)
  assert.match(result.message, /commits that no remote branch or tag holds/)
  assert.equal(head(clone), local, 'the commit is still checked out')
})

test('fresh: a clone just made of main is pinned to the published release, even though main is ahead of it', SLOW, async () => {
  assert.ok(follow, NO_MODULE)
  const { o, released, unpublished } = aheadOfPublished()
  const fresh = o.clone({ shallow: true })
  assert.equal(head(fresh), unpublished)
  // Without --fresh it is an ahead checkout and stays; a new install must not start out ahead.
  const result = await follow.followPublishedRelease({ dir: fresh, fresh: true, readPublishedTag: published('v0.27.0') })
  assert.equal(result.outcome, 'moved', result.message)
  assert.equal(head(fresh), released)
  assert.equal(result.to, '0.27.0')
})

test('fresh: a marketplace that cannot be read is a failure, so the caller never keeps a clone of main', SLOW, async () => {
  assert.ok(follow, NO_MODULE)
  const { o } = aheadOfPublished()
  const fresh = o.clone({ shallow: true })
  const result = await follow.followPublishedRelease({
    dir: fresh,
    fresh: true,
    readPublishedTag: async () => {
      throw new Error('the published release could not be read: offline')
    },
  })
  assert.equal(result.outcome, 'unknown', result.message)
  assert.equal(follow.exitCodeFor(result.outcome), 1)
})

test('the exit codes the shell callers act on', () => {
  assert.ok(follow, NO_MODULE)
  assert.equal(follow.exitCodeFor('moved'), 0)
  assert.equal(follow.exitCodeFor('current'), 10)
  assert.equal(follow.exitCodeFor('ahead'), 10)
  for (const outcome of ['unknown', 'dirty', 'failed', 'anything else']) assert.equal(follow.exitCodeFor(outcome), 1, outcome)
})
