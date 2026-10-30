/**
 * `hoai-agent update` follows the PUBLISHED release, never plugin main (board row 01a0db74, KC 2026-10-30:
 * "Follow the published version").
 *
 * The daemon's own updater and the watcher already took exactly the published tag (#268, board row 84c23fab),
 * but `hoai-agent update` still ran `git fetch origin main` and `git reset --hard origin/main`: an operator who
 * updated a clone host (kc-server's agents) put it on every change merged since the release, published or not,
 * and moved a host that was ahead of main BACK to main. Publishing has to be the one gate for every host.
 *
 * This runs the REAL bin/bgos-agent against a fake origin whose main runs ahead of the published tag (a merge
 * after the release, then a bump that release-tag.yml tagged and nobody published), with the marketplace stood
 * in for by a local manifest server (HOAI_PUBLISHED_MANIFEST_URL). HOME is a temp dir; no service is installed,
 * so nothing is restarted.
 *
 * Run: npx tsx --test test/bgos-agent.update-published.test.ts
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { resolvePosixBash } from './helpers/posix-bash.ts'
import { offlineUrl, startManifestServer, type ManifestServer } from './helpers/manifest-server.ts'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const BASH = process.platform === 'win32' ? null : resolvePosixBash()
const probe = (script: string) => (BASH ? spawnSync(BASH, ['-c', script], { encoding: 'utf8' }) : null)
const hasGit = probe('command -v git')?.status === 0
const hasNode = probe('command -v node')?.status === 0
const SKIP = BASH && hasGit && hasNode ? false : 'needs bash, git and node'
const SLOW = { skip: SKIP, timeout: 120_000 }

const IDENTITY = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }

function sh(cwd: string, cmd: string, env: Record<string, string> = {}) {
  const res = spawnSync(BASH!, ['-c', cmd], { cwd, encoding: 'utf8', env: { ...process.env, ...IDENTITY, ...env } })
  assert.equal(res.status, 0, `${cmd}\n${res.stdout}\n${res.stderr}`)
  return res.stdout.trim()
}

const servers: ManifestServer[] = []
after(() => servers.forEach((s) => s.stop()))
async function marketplace(ref: string) {
  const server = await startManifestServer(ref)
  servers.push(server)
  return server
}

/**
 * A plugin checkout at 1.0.0 carrying the real installer, and its origin moving on: 2.0.0 released and
 * published, a merge after it, then 3.0.0 bumped and auto-tagged on main but never published.
 */
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'update-published-')))
  const home = join(root, 'home')
  mkdirSync(home, { recursive: true })
  const stubs = join(root, 'stubs')
  mkdirSync(stubs)
  // bun: `-e <script> <args>` is node's `-e`; anything else (bun install, the daemon wrapper) is a no-op here.
  writeFileSync(join(stubs, 'bun'), '#!/bin/bash\nif [ "$1" = "-e" ]; then shift; s="$1"; shift; exec node -e "$s" -- "$@"; fi\nexit 0\n')
  chmodSync(join(stubs, 'bun'), 0o755)

  const work = join(root, 'work')
  // The plugin's own bin and lib, as a checkout carries them; the daemon wrapper is a stub (no daemon here).
  cpSync(join(repoRoot, 'bin'), join(work, 'bin'), { recursive: true })
  writeFileSync(join(work, 'bin', 'bgos-daemon-wrapper.mjs'), '// stub\n')
  cpSync(join(repoRoot, 'lib'), join(work, 'lib'), { recursive: true })
  const version = (dir: string, v: string) => writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'hoai', version: v }))
  version(work, '1.0.0')
  const git = (dir: string, c: string) => sh(dir, `git ${c}`, { HOME: home })
  git(work, 'init -q -b main')
  git(work, 'config core.autocrlf false')
  git(work, 'add -A')
  git(work, 'commit -q -m v1')
  const start = git(work, 'rev-parse HEAD')
  const origin = join(root, 'origin.git')
  sh(root, `git clone -q --bare "${work}" "${origin}"`, { HOME: home })
  git(work, `remote add origin "${origin}"`)
  git(work, 'fetch -q origin main')
  git(work, 'branch -q --set-upstream-to=origin/main main')

  const next = join(root, 'next')
  sh(root, `git clone -q "${origin}" "${next}"`, { HOME: home })
  const step = (v: string, note: string, tag?: string) => {
    version(next, v)
    writeFileSync(join(next, 'notes.md'), `${note}\n`)
    git(next, 'add -A')
    git(next, `commit -q -m "${note}"`)
    if (tag) git(next, `tag ${tag}`)
    git(next, `push -q origin main${tag ? ` refs/tags/${tag}` : ''}`)
    return git(next, 'rev-parse HEAD')
  }
  const released = step('2.0.0', 'release 2.0.0', 'v2.0.0')
  step('2.0.0', 'merged after the release')
  const unpublished = step('3.0.0', 'bumped and auto-tagged, never published', 'v3.0.0')
  return { root, work, home, stubs, start, released, unpublished, git: (c: string) => git(work, c) }
}

function update(f: ReturnType<typeof fixture>, manifestUrl: string) {
  const res = spawnSync(BASH!, [join(f.work, 'bin', 'bgos-agent'), 'update'], {
    cwd: f.work,
    encoding: 'utf8',
    timeout: 100_000,
    env: {
      ...process.env,
      HOME: f.home,
      PATH: `${f.stubs}:${process.env.PATH}`,
      CLAUDE_CONFIG_DIR: join(f.home, '.claude'),
      HOAI_PUBLISHED_MANIFEST_URL: manifestUrl,
      NO_COLOR: '1',
    },
  })
  return { status: res.status, out: `${res.stdout}\n${res.stderr}` }
}

test('hoai-agent update lands on the published release, not on main past it', SLOW, async () => {
  const f = fixture()
  const m = await marketplace('v2.0.0')
  const res = update(f, m.url)
  assert.equal(res.status, 0, res.out)
  assert.equal(f.git('rev-parse HEAD'), f.released, `the published tag's commit, not main (${f.unpublished})\n${res.out}`)
  assert.match(res.out, /plugin updated: 1\.0\.0 -> 2\.0\.0/)
  assert.doesNotMatch(res.out, /Fetching origin\/main/)
  assert.equal(f.git('tag --list v3.0.0'), '', 'the bump nobody published is never fetched')
  assert.equal(f.git('status --porcelain'), '', 'a clean checkout')
})

test('hoai-agent update on a host AHEAD of the published release does not move it back: it says so and waits', SLOW, async () => {
  const f = fixture()
  // The fleet after following main: the checkout sits on main's head, a version nobody published.
  f.git('fetch -q origin main')
  f.git('reset -q --hard origin/main')
  assert.equal(f.git('rev-parse HEAD'), f.unpublished)
  const m = await marketplace('v2.0.0')
  const res = update(f, m.url)
  assert.equal(res.status, 0, res.out)
  assert.equal(f.git('rev-parse HEAD'), f.unpublished, 'not downgraded')
  assert.match(res.out, /3\.0\.0 is ahead of the published release v2\.0\.0/)
  assert.match(res.out, /stays at 3\.0\.0 until/)
  assert.match(res.out, /no change: the plugin stays at 3\.0\.0/)
  assert.doesNotMatch(res.out, /up to date/, 'a host running code nobody published is not told it is up to date')
})

test('hoai-agent update with the marketplace offline leaves the checkout exactly where it is', SLOW, async () => {
  const f = fixture()
  const res = update(f, await offlineUrl())
  assert.notEqual(res.status, 0, res.out)
  assert.equal(f.git('rev-parse HEAD'), f.start, `not moved\n${res.out}`)
  assert.match(res.out, /the published release could not be read/)
  assert.match(res.out, /the plugin checkout was not changed/)
  assert.doesNotMatch(res.out, /plugin updated/)
})

test('hoai-agent update with an unreadable marketplace ref leaves the checkout exactly where it is', SLOW, async () => {
  const cases: Array<[string, (m: ManifestServer) => void]> = [
    ['an HTTP 500', (m) => m.fail(500)],
    ['a body that is not the manifest', (m) => m.raw('<html>not json</html>')],
    ['a ref that is not a release tag', (m) => m.publish('main')],
  ]
  for (const [name, breakIt] of cases) {
    const f = fixture()
    const m = await marketplace('v2.0.0')
    breakIt(m)
    const res = update(f, m.url)
    assert.notEqual(res.status, 0, `${name}\n${res.out}`)
    assert.equal(f.git('rev-parse HEAD'), f.start, `${name}: not moved\n${res.out}`)
    assert.match(res.out, /the plugin checkout was not changed/, name)
  }
})

test('hoai-agent update on a checkout with local changes refuses, and neither moves nor reads the release', SLOW, async () => {
  const f = fixture()
  writeFileSync(join(f.work, 'notes.md'), 'an edit someone is in the middle of\n')
  const res = update(f, await offlineUrl())
  assert.notEqual(res.status, 0, res.out)
  assert.match(res.out, /local changes, not overwriting/)
  assert.doesNotMatch(res.out, /could not be read/, 'the marketplace is not even asked')
  assert.equal(f.git('rev-parse HEAD'), f.start)
})

test('the update hands the rest of its work to the script it just checked out, once', SLOW, async () => {
  const f = fixture()
  const m = await marketplace('v2.0.0')
  const res = update(f, m.url)
  assert.equal(res.status, 0, res.out)
  assert.equal((res.out.match(/Continuing with the updated script/g) ?? []).length, 1, res.out)
  assert.equal((res.out.match(/Following the published release/g) ?? []).length, 1, 'the move happens once')
  assert.equal(readFileSync(join(f.work, 'package.json'), 'utf8').includes('"2.0.0"'), true)
})
