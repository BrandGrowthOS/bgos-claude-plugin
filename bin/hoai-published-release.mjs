#!/usr/bin/env node
/**
 * hoai-published-release: what the clone installers ask before they move a
 * plugin checkout (board row 01a0db74, KC 2026-10-30: "Follow the published
 * version"), so bin/bgos-agent (bash) and bin/hoai-bootstrap.sh and .ps1 follow
 * the published release with the SAME code the daemon and bgos-claim use
 * (lib/follow-published.mjs over lib/published-release.mjs) instead of a
 * second copy in shell.
 *
 *   tag
 *       The release tag the marketplace ref names (v<x.y.z>), one line.
 *   follow <checkout> [--fresh]
 *       Move the checkout to the published release when it is newer, never
 *       past it and never back. One line saying what happened. --fresh is for
 *       a clone the caller just made: it goes to the published release
 *       whatever main holds.
 *
 * Exit codes: `tag` 0 with the tag, 1 when the release cannot be read.
 * `follow` 0 when the checkout moved, 10 when it stays by design (at or ahead
 * of the published release), 1 when it stays because something is wrong
 * (the marketplace cannot be read, local changes, a tag that says otherwise).
 * 2 on a usage error.
 *
 * HOAI_PUBLISHED_MANIFEST_URL reads the manifest from another URL than the
 * public marketplace (the tests' stand in). Plain JavaScript, node >= 18 or
 * bun, builtins only.
 */

import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { exitCodeFor, followPublishedRelease } from '../lib/follow-published.mjs'
import { readPublishedReleaseTag } from '../lib/published-release.mjs'

const out = (line) => process.stdout.write(`${line}\n`)
const err = (line) => process.stderr.write(`${line}\n`)

export async function main(argv = process.argv.slice(2), env = process.env) {
  const url = env.HOAI_PUBLISHED_MANIFEST_URL || undefined
  const readPublishedTag = () => readPublishedReleaseTag(url ? { url } : {})
  const [command, ...rest] = argv
  if (command === 'tag' && rest.length === 0) {
    try {
      out(await readPublishedTag())
      return 0
    } catch (error) {
      err(String(error instanceof Error ? error.message : error))
      return 1
    }
  }
  if (command === 'follow') {
    const fresh = rest.includes('--fresh')
    const dirs = rest.filter((a) => a !== '--fresh')
    if (dirs.length === 1 && dirs[0]) {
      const result = await followPublishedRelease({ dir: resolve(dirs[0]), fresh, readPublishedTag })
      out(result.message)
      return exitCodeFor(result.outcome)
    }
  }
  err('hoai-published-release: tag | follow <checkout> [--fresh]')
  return 2
}

// Real paths on both sides: bgos-agent may call this through an aliased home (bin/hoai-select-claude.mjs's rule).
function isRunAsMain() {
  const argv1 = process.argv[1]
  if (!argv1) return false
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(argv1)
  } catch {
    return import.meta.url === pathToFileURL(argv1).href
  }
}

if (isRunAsMain()) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`hoai-published-release: ${String(error?.message ?? error)}\n`)
      process.exit(1)
    },
  )
}
