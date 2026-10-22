/**
 * lib/published-release.mjs, and the watcher's clone observation that uses it (board row 84c23fab).
 *
 * The release a clone may update to is the tag the marketplace ref names, read from the public marketplace
 * manifest. Anything but exactly one strict v<semver> ref fails closed. The watcher (lib/watcher-core.mjs
 * observeCloneInstall, then the planner and lib/update-executor.mjs) used to take the branch upstream, origin/main,
 * as its target: at main the watcher tests below are red for that reason.
 *
 * Run: npx tsx --test test/published-release.test.ts
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { git, marketplaceManifest, releaseOrigin } from './helpers/release-origin.ts'

// Only a missing module reads as missing; a module that does not load is a failure of its own.
const published: any = await import('../lib/published-release.mjs').catch((err) => {
  if (err?.code === 'ERR_MODULE_NOT_FOUND') return null
  throw err
})
const NO_MODULE = 'lib/published-release.mjs does not exist: nothing reads which release is published'

const { observeCloneInstall } = await import('../lib/watcher-core.mjs')
const { nodeExec, nodeFs } = await import('../lib/watcher-bundle.mjs')
const { planMachine } = await import('../lib/update-planner.mjs')

/** A fetch that answers the manifest URL with `body` and records what it was asked. */
function fakeFetch(body: string | (() => Promise<never>), status = 200) {
  const asked: string[] = []
  const impl = async (url: string) => {
    asked.push(String(url))
    if (typeof body === 'function') return body()
    return { ok: status >= 200 && status < 300, status, text: async () => body }
  }
  return { impl, asked }
}

test('the published release is the ref the marketplace names for this plugin', async () => {
  assert.ok(published, NO_MODULE)
  assert.equal(published.PUBLISHED_MANIFEST_URL, 'https://raw.githubusercontent.com/BrandGrowthOS/hoai-marketplace/main/.claude-plugin/marketplace.json')
  assert.equal(published.publishedReleaseTagFrom(marketplaceManifest('v0.73.0')), 'v0.73.0')
  const { impl, asked } = fakeFetch(marketplaceManifest('v0.73.0'))
  assert.equal(await published.readPublishedReleaseTag({ fetchImpl: impl }), 'v0.73.0')
  assert.deepEqual(asked, [published.PUBLISHED_MANIFEST_URL])
  assert.equal(published.releaseTagVersion('v0.73.0'), '0.73.0')
  assert.equal(published.releaseTagRefspec('v0.73.0'), '+refs/tags/v0.73.0:refs/tags/v0.73.0')
})

test('anything but one strict v<semver> ref is no release at all', () => {
  assert.ok(published, NO_MODULE)
  for (const ref of ['main', 'v0.73', '0.73.0', 'v0.73.0-rc.1', 'v01.2.3', ' v0.73.0x', 'refs/tags/v0.73.0', 'v0.73.0;rm -rf /']) {
    assert.equal(published.publishedReleaseTagFrom(marketplaceManifest(ref)), null, ref)
    assert.equal(published.releaseTagVersion(ref), null, ref)
    assert.throws(() => published.releaseTagRefspec(ref), /not a release tag/, ref)
  }
  // A declared version that disagrees with the ref is two answers, so no answer.
  assert.equal(published.publishedReleaseTagFrom(marketplaceManifest('v0.73.0', { version: '0.72.0' })), null)
  assert.equal(published.publishedReleaseTagFrom(marketplaceManifest('v0.73.0', { version: '0.73.0' })), 'v0.73.0')
  // Not this plugin, not JSON, no plugins.
  assert.equal(published.publishedReleaseTagFrom(marketplaceManifest('v0.73.0').replace('"name":"hoai","displayName"', '"name":"other","displayName"')), null)
  assert.equal(published.publishedReleaseTagFrom('<html>rate limited</html>'), null)
  assert.equal(published.publishedReleaseTagFrom('{}'), null)
})

test('a manifest that cannot be read throws a reason a log line can carry, and never guesses', async () => {
  assert.ok(published, NO_MODULE)
  const url = published.PUBLISHED_MANIFEST_URL
  await assert.rejects(published.readPublishedReleaseTag({ fetchImpl: fakeFetch('Not Found', 404).impl }), new RegExp(`could not be read from ${url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: HTTP 404`))
  await assert.rejects(
    published.readPublishedReleaseTag({ fetchImpl: fakeFetch(() => Promise.reject(new Error('getaddrinfo ENOTFOUND'))).impl }),
    /could not be read from .*: getaddrinfo ENOTFOUND/,
  )
  await assert.rejects(published.readPublishedReleaseTag({ fetchImpl: fakeFetch(marketplaceManifest('main')).impl }), /names no published v<x\.y\.z> release/)
  await assert.rejects(published.readPublishedReleaseTag({ fetchImpl: fakeFetch('x'.repeat(300 * 1024)).impl }), /the answer is not the manifest/)
  // A fetch that never answers is cut off at the timeout.
  const hang = async (_url: string, init: { signal: AbortSignal }) =>
    new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))))
  await assert.rejects(published.readPublishedReleaseTag({ fetchImpl: hang, timeoutMs: 20 }), /no answer within 0\.02s/)
})

// -- The watcher's clone observation (lib/watcher-core.mjs observeCloneInstall) ---------------------------------

function originWithUnreleasedMain() {
  const o = releaseOrigin('watcher-release-')
  o.commit('0.26.0')
  const clone = o.clone({ shallow: true })
  const released = o.commit('0.27.0', 'release 0.27.0')
  o.tag('v0.27.0', released)
  o.commit('0.27.0', 'merged after the release')
  const unpublished = o.commit('0.28.0', 'bumped and auto-tagged, never published')
  o.tag('v0.28.0', unpublished)
  return { o, clone, released, unpublished }
}

test('the watcher targets the published release commit, not the branch upstream', async () => {
  const { clone, released } = originWithUnreleasedMain()
  const logs: string[] = []
  const observed = await observeCloneInstall({ pluginRoot: clone, exec: nodeExec(), fs: nodeFs(), log: (line: string) => logs.push(line), readPublishedTag: async () => 'v0.27.0' })
  assert.equal(observed.targetCommit, released, logs.join('\n'))
  assert.equal(observed.latestVersion, '0.27.0')
  assert.equal(observed.canFastForward, true)
  assert.equal(observed.currentVersion, '0.26.0')
  // And the planner's fast-forward is to that release.
  const plan = planMachine({
    platform: 'linux',
    installMethod: 'clone',
    runningVersion: observed.currentVersion,
    clone: { latestVersion: observed.latestVersion, dirty: observed.dirty, canFastForward: observed.canFastForward, currentCommit: observed.currentCommit, targetCommit: observed.targetCommit },
    autoUpdateEnabled: true,
    rollbackLatched: false,
    agents: [],
    intent: 'update',
  })
  assert.equal(plan.targetVersion, '0.27.0')
  assert.ok(plan.steps.some((step: { kind: string }) => step.kind === 'git_fast_forward'))
})

test('the watcher plans no fast-forward when the published release is unknown or misnamed', async () => {
  for (const readPublishedTag of [
    async () => {
      throw new Error('the published release could not be read from x: HTTP 503')
    },
    async () => 'main',
  ]) {
    const { clone } = originWithUnreleasedMain()
    const logs: string[] = []
    const observed = await observeCloneInstall({ pluginRoot: clone, exec: nodeExec(), fs: nodeFs(), log: (line: string) => logs.push(line), readPublishedTag })
    assert.equal(observed.targetCommit, null)
    assert.equal(observed.latestVersion, null)
    assert.equal(observed.canFastForward, false)
    assert.ok(logs.some((line) => /published release/.test(line)), logs.join('\n'))
    // Nothing was fetched: origin/main is still where the clone was made, and no tag arrived.
    assert.equal(git(clone, 'tag', '--list', 'v0.28.0'), '')
  }
})

test('the watcher refuses a published tag whose package.json carries another version', async () => {
  const o = releaseOrigin('watcher-mistag-')
  o.commit('0.26.0')
  const clone = o.clone()
  o.tag('v0.28.0', o.commit('0.27.0', 'mis-tagged'))
  const logs: string[] = []
  const observed = await observeCloneInstall({ pluginRoot: clone, exec: nodeExec(), fs: nodeFs(), log: (line: string) => logs.push(line), readPublishedTag: async () => 'v0.28.0' })
  assert.equal(observed.targetCommit, null)
  assert.equal(observed.latestVersion, null)
  assert.ok(logs.some((line) => line.includes('v0.28.0 carries package.json version 0.27.0')), logs.join('\n'))
})
