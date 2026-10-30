/**
 * follow-published: move a clone checkout to the PUBLISHED release, for every
 * clone path that is not the daemon (board row 01a0db74, KC 2026-10-30:
 * "Follow the published version").
 *
 * WHY THIS EXISTS. #268 (board row 84c23fab) made the daemon's self-updater
 * (lib/self-update.ts inspectGitUpdate) and the watcher (lib/watcher-core.mjs
 * observeCloneInstall) take exactly the tag the marketplace ref names. The
 * other ways a clone moves still took plugin main: `hoai-agent update` ran
 * `git fetch origin main` and `git reset --hard origin/main`, `hoai-agent
 * install`, bin/hoai-bootstrap.sh and .ps1 cloned main, and bgos-claim cloned
 * main and later ran `git pull --ff-only`. So a merged change reached clone
 * hosts (kc-server) before anyone published it, and an update moved a host
 * that was ahead of main back to main. Publishing is the one gate, so every
 * one of those paths now comes through here.
 *
 * THE RULES (the same as the daemon's):
 *   - the target is the commit of the published tag (lib/published-release.mjs
 *     says why the marketplace ref and not the newest tag), fetched on its
 *     own, and that tag's package.json must carry the tag's version;
 *   - only a NEWER published version moves the checkout. A checkout at the
 *     published version stays (commits after it included). A checkout AHEAD
 *     of it is never moved back: it says so and stays until a published
 *     release reaches it;
 *   - a release that cannot be read, or a tag that says otherwise, leaves the
 *     checkout where it is, with the reason;
 *   - a checkout with local changes is not touched, and nothing is read for it;
 *     nor is one with commits that no remote branch or tag holds.
 *
 * `fresh` is for a clone this caller made a moment ago (an install): it goes
 * to the published release whatever main holds, because a new install must
 * not start out ahead of what was published. A fresh caller keeps the clone
 * only on `moved`, so a release that cannot be read means no checkout at all
 * rather than a checkout of main.
 *
 * Plain JavaScript, node >= 18 builtins only: bin/hoai-published-release.mjs
 * runs it from bash and PowerShell, and bin/bgos-claim.mjs imports it.
 */

import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { readPublishedReleaseTag, releaseIsNewer, releaseTagRefspec, releaseTagVersion } from './published-release.mjs'

/** One git call; a slow network fetch gets longer than a local read. */
const GIT_TIMEOUT_MS = 120_000
const SHA_RE = /^[0-9a-f]{40}$/i
/** How every message that leaves the checkout alone ends, so a caller can print it as it is. */
const NOT_CHANGED = 'the plugin checkout was not changed'

/**
 * @typedef {'moved' | 'current' | 'ahead' | 'unknown' | 'dirty' | 'failed'} FollowOutcome
 * @typedef {{ outcome: FollowOutcome, from: string | null, to: string | null, tag: string | null, message: string }} FollowResult
 * @typedef {(args: string[]) => Promise<{ code: number, stdout: string, stderr: string }>} GitRun
 */

/**
 * What a shell caller acts on: 0 the checkout moved (an updater hands over to
 * the new files), 10 it stays by design (at or ahead of the release), 1 it
 * stays because something is wrong (the message says what).
 * @param {string} outcome
 * @returns {0 | 10 | 1}
 */
export function exitCodeFor(outcome) {
  if (outcome === 'moved') return 0
  if (outcome === 'current' || outcome === 'ahead') return 10
  return 1
}

/** @param {string} dir @returns {GitRun} */
function gitIn(dir) {
  return (args) =>
    new Promise((resolve) => {
      execFile('git', args, { cwd: dir, timeout: GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0
        resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') || (error && !stderr ? String(error.message) : '') })
      })
    })
}

/** @param {string} raw @returns {string | null} */
function versionOf(raw) {
  try {
    const version = JSON.parse(raw)?.version
    return typeof version === 'string' && releaseTagVersion(`v${version}`) !== null ? version : null
  } catch {
    return null
  }
}

const firstLine = (text) => String(text ?? '').trim().split('\n')[0] ?? ''

/**
 * Move `dir` to the published release when it is newer, and say what happened.
 * Never throws: every outcome is a result with a message a log line can carry.
 * @param {{ dir: string, fresh?: boolean, readPublishedTag?: () => Promise<string>, run?: GitRun }} opts
 * @returns {Promise<FollowResult>}
 */
export async function followPublishedRelease(opts) {
  const dir = opts.dir
  const run = opts.run ?? gitIn(dir)
  const readTag = opts.readPublishedTag ?? (() => readPublishedReleaseTag())
  let from = null
  try {
    from = versionOf(readFileSync(join(dir, 'package.json'), 'utf8'))
  } catch {}
  const at = from ?? 'its current version'
  const result = (outcome, message, extra = {}) => ({ outcome, from, to: null, tag: null, message, ...extra })

  const status = await run(['status', '--porcelain'])
  if (status.code !== 0) return result('failed', `could not inspect the plugin checkout at ${dir}: ${firstLine(status.stderr)}; ${NOT_CHANGED}`)
  if (status.stdout.trim()) return result('dirty', `the plugin checkout at ${dir} has local changes, so it is not overwritten; ${NOT_CHANGED}`)

  let tag
  try {
    tag = await readTag()
  } catch (error) {
    return result('unknown', `${firstLine(error instanceof Error ? error.message : String(error))}; ${NOT_CHANGED} (it stays at ${at})`)
  }
  const to = releaseTagVersion(tag)
  if (to === null) {
    return result('unknown', `the marketplace names no published v<x.y.z> release (it names ${JSON.stringify(firstLine(String(tag)))}); ${NOT_CHANGED} (it stays at ${at})`)
  }
  if (!opts.fresh) {
    if (from === null) return result('failed', `could not read the plugin version from ${join(dir, 'package.json')}; ${NOT_CHANGED}`, { tag })
    const newer = releaseIsNewer(tag, from)
    if (newer === false) {
      if (from === to) return result('current', `the plugin is at the published release ${tag}`, { tag, to })
      return result(
        'ahead',
        `plugin ${from} is ahead of the published release ${tag}; it is not moved back, and stays at ${from} until a published release reaches it`,
        { tag, to },
      )
    }
  }

  // Only that one tag, and no tag auto-following. A depth 1 clone stays depth
  // 1 (otherwise the fetch pulls the tag's whole history); a full clone is not
  // made shallow.
  const shallow = await run(['rev-parse', '--is-shallow-repository'])
  const depth = shallow.code === 0 && shallow.stdout.trim() === 'true' ? ['--depth', '1'] : []
  const fetched = await run(['fetch', '--quiet', '--no-tags', ...depth, 'origin', releaseTagRefspec(tag)])
  if (fetched.code !== 0) return result('failed', `could not fetch the published release ${tag}: ${firstLine(fetched.stderr)}; ${NOT_CHANGED}`, { tag })
  const target = (await run(['rev-parse', `refs/tags/${tag}^{commit}`])).stdout.trim()
  if (!SHA_RE.test(target)) return result('failed', `the published release ${tag} names no commit; ${NOT_CHANGED}`, { tag })
  const shown = await run(['show', `${target}:package.json`])
  const carried = shown.code === 0 ? versionOf(shown.stdout) : null
  if (carried !== to) {
    return result('failed', `the published release ${tag} carries package.json version ${carried ?? 'none'}; ${NOT_CHANGED}`, { tag })
  }
  const head = (await run(['rev-parse', 'HEAD'])).stdout.trim()
  if (head === target) return result('current', `the plugin is at the published release ${tag}`, { tag, to })
  if (!opts.fresh) {
    // The move is a reset, which works on a depth 1 clone where a fast-forward
    // cannot tell ancestry; so first make sure it drops nothing that exists
    // only here. A commit no remote branch or tag holds is someone's work.
    const own = await run(['rev-list', '-1', 'HEAD', '--not', '--remotes', '--tags'])
    if (own.code !== 0 || own.stdout.trim()) {
      return result('failed', `the plugin checkout at ${dir} has commits that no remote branch or tag holds, so it is not reset over them; ${NOT_CHANGED}`, { tag })
    }
  }
  const moved = await run(['reset', '--quiet', '--hard', target])
  if (moved.code !== 0) return result('failed', `could not check out the published release ${tag}: ${firstLine(moved.stderr)}; resolve it in ${dir}`, { tag })
  return result('moved', `plugin moved from ${at} to ${to}, the published release ${tag}`, { tag, to })
}
