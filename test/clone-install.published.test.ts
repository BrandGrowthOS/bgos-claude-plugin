/**
 * A NEW clone install starts on the published release, never on plugin main (board row 01a0db74, KC 2026-10-30:
 * "Follow the published version").
 *
 * `hoai-agent install` (bin/bgos-agent) and the clone method of bin/hoai-bootstrap.sh both made the checkout with
 * `git clone --depth 1` of main, so a host installed between a merge and a publish started out AHEAD of the
 * published release, on code nobody had published, and (since an ahead host is never moved back) stayed there
 * until a release caught up with it.
 *
 * Both run for real here against a fake GitHub: a `git` stand in on PATH that maps the plugin's GitHub URL to a
 * local bare origin whose main runs past the published tag, and a local manifest server for the marketplace
 * (HOAI_PUBLISHED_MANIFEST_URL). HOME is a temp dir; nothing on this machine is touched.
 *
 * Run: npx tsx --test test/clone-install.published.test.ts
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { resolvePosixBash } from './helpers/posix-bash.ts'
import { offlineUrl, startManifestServer, type ManifestServer } from './helpers/manifest-server.ts'
import { git, releaseOrigin } from './helpers/release-origin.ts'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const BASH = process.platform === 'win32' ? null : resolvePosixBash()
const probe = (script: string) => (BASH ? spawnSync(BASH, ['-c', script], { encoding: 'utf8' }) : null)
const realGit = String(probe('command -v git')?.stdout ?? '').trim()
const SKIP = BASH && realGit ? false : 'needs bash and git (bin/bgos-agent and hoai-bootstrap.sh are the macOS and Linux installers)'
const SLOW = { skip: SKIP, timeout: 120_000 }
const GITHUB = 'https://github.com/BrandGrowthOS/bgos-claude-plugin.git'

const servers: ManifestServer[] = []
after(() => servers.forEach((s) => s.stop()))
async function marketplace(ref: string) {
  const server = await startManifestServer(ref)
  servers.push(server)
  return server
}

/** GitHub's plugin repository, faked: main has moved past the published v0.27.0. */
function github() {
  const o = releaseOrigin('clone-install-')
  const files = { 'server.ts': '// the plugin\n', '.gitignore': 'node_modules/\nbun.lock\n' }
  // The plugin's own bin and lib: hoai-bootstrap.sh pins its new clone with that clone's own CLI.
  o.include('bin', join(repoRoot, 'bin'))
  o.include('lib', join(repoRoot, 'lib'))
  o.tag('v0.26.0', o.commit('0.26.0', 'release 0.26.0', files))
  const released = o.commit('0.27.0', 'release 0.27.0')
  o.tag('v0.27.0', released)
  o.commit('0.27.0', 'merged after the release')
  const unpublished = o.commit('0.28.0', 'bumped and auto-tagged, never published')
  o.tag('v0.28.0', unpublished)
  return { bare: o.bare, released, unpublished }
}

/** A HOME with stand ins on PATH: git that serves GitHub from `bare` (over a file URL, so --depth 1 holds as it does in the field), the real node, and tools the installer only looks for. */
function host(bare: string) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'clone-install-home-')))
  const shims = join(home, 'shims')
  mkdirSync(shims)
  const shim = (name: string, body: string) => {
    writeFileSync(join(shims, name), `#!/bin/bash\n${body}\n`)
    chmodSync(join(shims, name), 0o755)
  }
  shim('git', `args=(); for a in "$@"; do if [ "$a" = "${GITHUB}" ]; then args+=("${pathToFileURL(bare).href}"); else args+=("$a"); fi; done\nexec "${realGit}" "\${args[@]}"`)
  shim('node', `exec "${process.execPath}" "$@"`)
  // bun install would reach the network: a no-op. Anything else bun is asked runs on node (bun -e is node -e).
  shim('bun', `[ "$1" = "install" ] && exit 0\nif [ "$1" = "-e" ]; then shift; s="$1"; shift; exec "${process.execPath}" -e "$s" -- "$@"; fi\nexit 0`)
  shim('claude', 'exit 0')
  shim('expect', 'exit 0')
  return { home, shims, PATH: `${shims}:/usr/bin:/bin:/usr/sbin:/sbin` }
}

/** The real installer, run from a copy of this checkout (it is what hoai-agent is, on a host). */
function installer(home: string) {
  const root = join(home, 'installer')
  if (existsSync(join(root, 'bin', 'bgos-agent'))) return join(root, 'bin', 'bgos-agent')
  mkdirSync(root)
  cpSync(join(repoRoot, 'bin'), join(root, 'bin'), { recursive: true })
  cpSync(join(repoRoot, 'lib'), join(root, 'lib'), { recursive: true })
  cpSync(join(repoRoot, 'package.json'), join(root, 'package.json'))
  writeFileSync(join(root, 'server.ts'), '// the installer checkout\n')
  return join(root, 'bin', 'bgos-agent')
}

function install(h: ReturnType<typeof host>, pluginDir: string, manifestUrl: string) {
  const res = spawnSync(BASH!, [installer(h.home), 'install', '--assistant', '7', '--dir', join(h.home, 'ws'), '--key', 'k', '--user', 'u'], {
    cwd: h.home,
    encoding: 'utf8',
    timeout: 100_000,
    env: { HOME: h.home, PATH: h.PATH, NO_COLOR: '1', BGOS_PLUGIN_DIR: pluginDir, HOAI_PUBLISHED_MANIFEST_URL: manifestUrl },
  })
  return { status: res.status, out: `${res.stdout}\n${res.stderr}` }
}

test('hoai-agent install clones the published release, not main', SLOW, async () => {
  const gh = github()
  const h = host(gh.bare)
  const pluginDir = join(h.home, 'bgos-claude-plugin')
  const m = await marketplace('v0.27.0')
  const res = install(h, pluginDir, m.url)
  assert.ok(existsSync(join(pluginDir, 'server.ts')), res.out)
  assert.equal(git(pluginDir, 'rev-parse', 'HEAD'), gh.released, `the published tag, not main (${gh.unpublished})\n${res.out}`)
  assert.match(readFileSync(join(pluginDir, 'package.json'), 'utf8'), /"0\.27\.0"/)
  assert.deepEqual(readdirSync(h.home).filter((n) => n.startsWith('bgos-claude-plugin')), ['bgos-claude-plugin'], 'no half-made clone beside it')
})

test('hoai-agent install with the marketplace unreachable makes no checkout at all, rather than one of main', SLOW, async () => {
  const gh = github()
  const h = host(gh.bare)
  const pluginDir = join(h.home, 'bgos-claude-plugin')
  const res = install(h, pluginDir, await offlineUrl())
  assert.notEqual(res.status, 0, res.out)
  assert.match(res.out, /the published release could not be read/)
  assert.equal(existsSync(pluginDir), false, `no checkout of main is left for the next install to find\n${res.out}`)
  assert.deepEqual(readdirSync(h.home).filter((n) => n.startsWith('bgos-claude-plugin')), [])
  // An empty folder the owner made where the checkout goes is kept: it is removed only for a pinned checkout.
  mkdirSync(pluginDir)
  const again = install(h, pluginDir, await offlineUrl())
  assert.notEqual(again.status, 0, again.out)
  assert.equal(existsSync(pluginDir), true, again.out)
  assert.deepEqual(readdirSync(pluginDir), [])
})

// ---- bin/hoai-bootstrap.sh, the clone method --------------------------------------------------------------------

const bootstrap = readFileSync(join(repoRoot, 'bin', 'hoai-bootstrap.sh'), 'utf8').replace(/\r\n/g, '\n')
/** The clone method's checkout step, exactly as the script has it: from where it names the folder to bun install. */
function cloneStep(): string {
  const open = '    PLUGIN_ROOT="$HOME/bgos-claude-plugin"\n'
  const close = "    say 'Installing plugin dependencies (bun install)...'"
  const a = bootstrap.indexOf(open)
  assert.ok(a > -1, 'hoai-bootstrap.sh names the clone folder')
  const b = bootstrap.indexOf(close, a)
  assert.ok(b > -1, 'hoai-bootstrap.sh installs the deps after the clone')
  return bootstrap.slice(a, b)
}

function runCloneStep(h: ReturnType<typeof host>, manifestUrl: string) {
  const script = `set -u\nsay() { printf '%s\\n' "$1"; }\nfail() { printf 'FAIL %s\\n' "$1"; exit 3; }\n${cloneStep()}\nsay "DONE $PLUGIN_ROOT"\n`
  const res = spawnSync(BASH!, ['-c', script], {
    cwd: h.home,
    encoding: 'utf8',
    timeout: 100_000,
    env: { HOME: h.home, PATH: h.PATH, HOAI_PUBLISHED_MANIFEST_URL: manifestUrl },
  })
  return { status: res.status, out: `${res.stdout}\n${res.stderr}` }
}

test('hoai-bootstrap.sh (clone method) checks out the published release, not main', SLOW, async () => {
  const gh = github()
  const h = host(gh.bare)
  const m = await marketplace('v0.27.0')
  const res = runCloneStep(h, m.url)
  assert.equal(res.status, 0, res.out)
  const pluginDir = join(h.home, 'bgos-claude-plugin')
  assert.equal(git(pluginDir, 'rev-parse', 'HEAD'), gh.released, `the published tag, not main (${gh.unpublished})\n${res.out}`)
  assert.deepEqual(readdirSync(h.home).filter((n) => n.startsWith('bgos-claude-plugin')), ['bgos-claude-plugin'])
  // A second run finds the checkout and leaves it alone, as before.
  const again = runCloneStep(h, m.url)
  assert.equal(again.status, 0, again.out)
  assert.equal(git(pluginDir, 'rev-parse', 'HEAD'), gh.released)
})

test('hoai-bootstrap.sh (clone method) with the marketplace unreachable fails plugin-install and leaves no checkout', SLOW, async () => {
  const gh = github()
  const h = host(gh.bare)
  const res = runCloneStep(h, await offlineUrl())
  assert.equal(res.status, 3, res.out)
  assert.match(res.out, /FAIL plugin-install/)
  assert.equal(existsSync(join(h.home, 'bgos-claude-plugin')), false, res.out)
  assert.deepEqual(readdirSync(h.home).filter((n) => n.startsWith('bgos-claude-plugin')), [])
})

test('hoai-bootstrap.sh (clone method): an empty folder where the checkout goes stays until a pinned checkout replaces it; a folder with files is never touched', SLOW, async () => {
  const gh = github()
  // The release cannot be read: the empty folder the owner made is still there.
  const h = host(gh.bare)
  const target = join(h.home, 'bgos-claude-plugin')
  mkdirSync(target)
  const offline = runCloneStep(h, await offlineUrl())
  assert.equal(offline.status, 3, offline.out)
  assert.equal(existsSync(target), true, `the empty folder is not removed for a clone that did not happen\n${offline.out}`)
  assert.deepEqual(readdirSync(h.home).filter((n) => n.startsWith('bgos-claude-plugin')), ['bgos-claude-plugin'])
  // The release can be read: the pinned checkout takes the empty folder's place.
  const m = await marketplace('v0.27.0')
  const res = runCloneStep(h, m.url)
  assert.equal(res.status, 0, res.out)
  assert.equal(git(target, 'rev-parse', 'HEAD'), gh.released)
  // A folder with something in it is refused and left as it is, before anything is cloned.
  const h2 = host(gh.bare)
  const kept = join(h2.home, 'bgos-claude-plugin')
  mkdirSync(kept)
  writeFileSync(join(kept, 'mine.txt'), 'not a checkout\n')
  const refused = runCloneStep(h2, m.url)
  assert.equal(refused.status, 3, refused.out)
  assert.match(refused.out, /exists and is not a plugin checkout/)
  assert.deepEqual(readdirSync(kept), ['mine.txt'])
  assert.deepEqual(readdirSync(h2.home).filter((n) => n.startsWith('bgos-claude-plugin')), ['bgos-claude-plugin'])
})

// ---- bin/hoai-bootstrap.ps1, the clone method (Windows) --------------------------------------------------------
// No PowerShell runs on the macOS and Linux runners, so the Windows twin is pinned by its text: the same steps as
// the .sh above, which runs for real.

test('hoai-bootstrap.ps1 (clone method) pins its new clone to the published release before it is put in place', () => {
  const ps1 = readFileSync(join(repoRoot, 'bin', 'hoai-bootstrap.ps1'), 'utf8').replace(/\r\n/g, '\n')
  const open = "    $PluginRoot = Join-Path $env:USERPROFILE 'bgos-claude-plugin'\n"
  const close = "    Say 'Installing plugin dependencies (bun install)...'"
  const a = ps1.indexOf(open)
  assert.ok(a > -1, 'hoai-bootstrap.ps1 names the clone folder')
  const block = ps1.slice(a, ps1.indexOf(close, a))
  const code = block.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')
  // main is cloned beside the folder, never into it
  assert.match(code, /& git clone --quiet --depth 1 https:\/\/github\.com\/BrandGrowthOS\/bgos-claude-plugin\.git \$pluginPartial\n/)
  assert.doesNotMatch(code, /git clone[^\n]*\$PluginRoot/)
  // the clone's own CLI moves it to the published release, whatever main holds
  assert.match(code, /& node \(Join-Path \$pluginPartial 'bin\\hoai-published-release\.mjs'\) follow \$pluginPartial --fresh/)
  // only a move (0) or main already being the release (10) keeps it; anything else removes it and fails
  assert.match(code, /if \(\$LASTEXITCODE -ne 0 -and \$LASTEXITCODE -ne 10\) \{\n[^}]*Remove-Item -Recurse -Force \$pluginPartial\n\s*Fail 'plugin-install'/)
  // and only then is it put in place, and a move Windows refused is a failure, not a missing checkout
  assert.ok(code.indexOf('Move-Item -ErrorAction SilentlyContinue $pluginPartial $PluginRoot') > code.indexOf('--fresh'), 'put in place after it is pinned')
  const afterMove = code.slice(code.indexOf('Move-Item -ErrorAction SilentlyContinue $pluginPartial $PluginRoot'))
  assert.match(afterMove, /^Move-Item[^\n]*\n {8}if \(-not \(Test-Path \(Join-Path \$PluginRoot 'server\.ts'\)\)\) \{\n(?: {12}[^\n]*\n)*? {12}Fail 'plugin-install'\n {8}\}/)
  // an existing folder is removed only after the clone was pinned
  assert.ok(code.indexOf('Remove-Item -Force -ErrorAction SilentlyContinue $PluginRoot') > code.indexOf('--fresh'))
})
