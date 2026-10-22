/**
 * A REAL git origin with releases on it, for the tests that pin which commit a
 * clone install updates to (board row 84c23fab).
 *
 * A bare repository stands for GitHub, a working copy publishes to it the way
 * main moves (one commit per change, package.json carrying the version), and
 * tags are lightweight, exactly as .github/workflows/release-tag.yml makes them.
 * Clones are made the way the field makes them: `git clone` of main, or
 * `git clone --depth 1` over a file URL (bin/hoai-bootstrap.sh, .ps1 and
 * bin/bgos-agent all clone with --depth 1).
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** git in `cwd`, stdout trimmed; throws on a non-zero exit. */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

/** The identity and settings a commit needs, set on the repository so no machine's own config leaks in. */
function quietIdentity(dir: string): void {
  git(dir, 'config', 'user.email', 'release-origin@example.com')
  git(dir, 'config', 'user.name', 'release-origin')
  git(dir, 'config', 'commit.gpgsign', 'false')
  git(dir, 'config', 'core.autocrlf', 'false')
}

function writeVersion(dir: string, version: string, note: string): void {
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name: 'claude-channel-bgos', version }, null, 2)}\n`)
  writeFileSync(join(dir, 'notes.md'), `${note}\n`)
}

export function releaseOrigin(prefix = 'release-origin-') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  const bare = join(root, 'origin.git')
  const work = join(root, 'work')
  git(root, 'init', '--quiet', '--bare', '--initial-branch=main', bare)
  git(root, 'init', '--quiet', '--initial-branch=main', work)
  quietIdentity(work)
  git(work, 'remote', 'add', 'origin', bare)
  let n = 0
  return {
    root,
    bare,
    /** One commit on main carrying `version`, pushed; returns its sha. */
    commit(version: string, note = `change ${n + 1}`): string {
      n += 1
      writeVersion(work, version, note)
      git(work, 'add', '-A')
      git(work, 'commit', '--quiet', '-m', note)
      git(work, 'push', '--quiet', 'origin', 'main')
      return git(work, 'rev-parse', 'HEAD')
    },
    /** A lightweight tag on `sha`, pushed, the way release-tag.yml makes one. */
    tag(name: string, sha: string): void {
      git(work, 'tag', name, sha)
      git(work, 'push', '--quiet', 'origin', `refs/tags/${name}`)
    },
    /** A clone of main as it is now; `shallow` is the field's `--depth 1` over a file URL. */
    clone(opts: { shallow?: boolean } = {}): string {
      n += 1
      const dir = join(root, `clone-${n}`)
      // autocrlf off from the first checkout, or a Windows runner's default would leave the tree dirty.
      if (opts.shallow) git(root, 'clone', '--quiet', '--config', 'core.autocrlf=false', '--depth', '1', pathToFileURL(bare).href, dir)
      else git(root, 'clone', '--quiet', '--config', 'core.autocrlf=false', bare, dir)
      quietIdentity(dir)
      return dir
    },
    /** A local commit in a clone that is never pushed: a developer's checkout. */
    localCommit(dir: string, version: string, note = 'local work'): string {
      writeVersion(dir, version, note)
      git(dir, 'add', '-A')
      git(dir, 'commit', '--quiet', '-m', note)
      return git(dir, 'rev-parse', 'HEAD')
    },
  }
}

/** The marketplace manifest as hoai-marketplace serves it, publishing `ref`. */
export function marketplaceManifest(ref: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    $schema: 'https://json.schemastore.org/claude-code-marketplace.json',
    name: 'hoai',
    owner: { name: 'BrandGrowthOS' },
    plugins: [
      {
        name: 'hoai',
        displayName: 'HOAI (Home of Agents)',
        source: { source: 'url', url: 'https://github.com/BrandGrowthOS/bgos-claude-plugin.git', ref },
        ...extra,
      },
    ],
  })
}
