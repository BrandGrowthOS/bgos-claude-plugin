/**
 * bgos-claim's shared plugin checkout follows the PUBLISHED release, never plugin main (board row 01a0db74).
 *
 * ensurePluginCheckout made a new checkout with `git clone --depth 1` of main, and refreshed an existing one with
 * `git pull --ff-only`, so every Agent Pack claim put the host on whatever had been merged since the release. Now
 * a new checkout is pinned to the published tag before it is put in place, and an existing one moves only
 * forward to the published tag, through lib/follow-published.mjs.
 *
 * Real git (test/helpers/release-origin.ts) with main ahead of the published tag; the published release is
 * injected. BGOS_PLUGIN_REPO points the clone at the fake origin.
 *
 * Run: npx tsx --test test/bgos-claim.published.test.ts
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'

import { ensurePluginCheckout } from '../bin/bgos-claim.mjs'
import { git, releaseOrigin } from './helpers/release-origin.ts'

const SLOW = { timeout: 120_000 }
// What the checkout must carry to be one: server.ts. bun install leaves files git must not see as changes.
const FILES = { 'server.ts': '// the plugin\n', '.gitignore': 'node_modules/\nbun.lock\n' }

function origin() {
  const o = releaseOrigin('claim-published-')
  o.tag('v0.26.0', o.commit('0.26.0', 'release 0.26.0', FILES))
  const released = o.commit('0.27.0', 'release 0.27.0')
  o.tag('v0.27.0', released)
  o.commit('0.27.0', 'merged after the release')
  const unpublished = o.commit('0.28.0', 'bumped and auto-tagged, never published')
  o.tag('v0.28.0', unpublished)
  // Over a file URL, as GitHub is reached over https: a plain path would make git ignore --depth 1.
  return { o, released, unpublished, repo: { BGOS_PLUGIN_REPO: pathToFileURL(o.bare).href } }
}

const agentsRoot = () => realpathSync(mkdtempSync(join(tmpdir(), 'claim-agents-')))
const pluginDirOf = (root: string) => join(root, '.plugin', 'bgos-claude-plugin')

test('a new claim checkout is the published release, never main', SLOW, async () => {
  const { repo, released, unpublished } = origin()
  const root = agentsRoot()
  const logs: string[] = []
  const server = await ensurePluginCheckout(root, repo, (l: string) => logs.push(l), {
    readPublishedTag: async () => 'v0.27.0',
  })
  assert.equal(server, join(pluginDirOf(root), 'server.ts'))
  assert.equal(git(pluginDirOf(root), 'rev-parse', 'HEAD'), released, `not main (${unpublished})\n${logs.join('\n')}`)
  assert.deepEqual(readdirSync(join(root, '.plugin')), ['bgos-claude-plugin'], 'no half-made checkout is left beside it')
  assert.equal(git(pluginDirOf(root), 'rev-parse', '--is-shallow-repository'), 'true', 'a depth 1 clone, as in the field')
})

test('a new claim checkout is never made when the published release cannot be read', SLOW, async () => {
  const { repo } = origin()
  const root = agentsRoot()
  await assert.rejects(
    ensurePluginCheckout(root, repo, () => {}, {
      readPublishedTag: async () => {
        throw new Error('the published release could not be read: offline')
      },
    }),
    /the published release could not be read/,
  )
  assert.equal(existsSync(pluginDirOf(root)), false, 'no checkout of main is left behind for the next claim to use')
  assert.deepEqual(existsSync(join(root, '.plugin')) ? readdirSync(join(root, '.plugin')) : [], [])
})

test('an existing claim checkout moves to the published release, not to main', SLOW, async () => {
  const { repo, released, unpublished } = origin()
  const root = agentsRoot()
  const first = await ensurePluginCheckout(root, repo, () => {}, { readPublishedTag: async () => 'v0.26.0' })
  assert.ok(first)
  const dir = pluginDirOf(root)
  assert.match(git(dir, 'show', 'HEAD:package.json'), /"0\.26\.0"/)
  const logs: string[] = []
  await ensurePluginCheckout(root, repo, (l: string) => logs.push(l), { readPublishedTag: async () => 'v0.27.0' })
  assert.equal(git(dir, 'rev-parse', 'HEAD'), released, `not main (${unpublished})\n${logs.join('\n')}`)
})

test('an existing claim checkout ahead of the published release stays, and says so; an unreadable release leaves it too', SLOW, async () => {
  const { repo, unpublished } = origin()
  const root = agentsRoot()
  await ensurePluginCheckout(root, repo, () => {}, { readPublishedTag: async () => 'v0.28.0' })
  const dir = pluginDirOf(root)
  assert.equal(git(dir, 'rev-parse', 'HEAD'), unpublished)
  const logs: string[] = []
  await ensurePluginCheckout(root, repo, (l: string) => logs.push(l), { readPublishedTag: async () => 'v0.27.0' })
  assert.equal(git(dir, 'rev-parse', 'HEAD'), unpublished, 'not downgraded')
  assert.match(logs.join('\n'), /0\.28\.0 is ahead of the published release v0\.27\.0/)
  const offline: string[] = []
  await ensurePluginCheckout(root, repo, (l: string) => offline.push(l), {
    readPublishedTag: async () => {
      throw new Error('the published release could not be read: offline')
    },
  })
  assert.equal(git(dir, 'rev-parse', 'HEAD'), unpublished)
  assert.match(offline.join('\n'), /could not be read/)
})
