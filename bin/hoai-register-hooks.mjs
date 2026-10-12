#!/usr/bin/env node
/**
 * hoai-register-hooks: register the HOAI hooks for clone agent workspaces.
 *
 * Run by the daemon's self-updater right after it pulled a new checkout and
 * before it asks for the restart, as a child process of the NEW checkout so the
 * new code writes the entries (the running daemon still holds the old code).
 * See lib/clone-hooks.mjs for why and for the rule.
 *
 *   node bin/hoai-register-hooks.mjs --plugin-dir <checkout> --workdir <dir> [--workdir <dir> ...]
 *
 * Prints one line per workdir. Exit 0 always for a workdir that is not a clone
 * workspace or is already registered; exit 2 when a write failed; exit 1 on bad
 * arguments. The caller treats any non-zero exit as "could not", never as fatal.
 * No em dashes or en dashes in this file.
 */
import { realpathSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { registerCloneHooks } from '../lib/clone-hooks.mjs'

/** @param {readonly string[]} argv */
export function parseArgs(argv) {
  const out = { pluginDir: '', workdirs: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i] ?? '')
    if (arg === '--plugin-dir') out.pluginDir = String(argv[++i] ?? '')
    else if (arg === '--workdir') out.workdirs.push(String(argv[++i] ?? ''))
  }
  return out
}

/** @param {readonly string[]} argv */
export function main(argv) {
  const { pluginDir, workdirs } = parseArgs(argv)
  const dirs = workdirs.filter(Boolean)
  if (!pluginDir || dirs.length === 0) {
    process.stderr.write('usage: hoai-register-hooks --plugin-dir <checkout> --workdir <dir> [--workdir <dir> ...]\n')
    return 1
  }
  let failed = false
  for (const workdir of [...new Set(dirs)]) {
    const result = registerCloneHooks({ workdir, pluginDir })
    if (result.outcome === 'failed') failed = true
    process.stdout.write(`${result.outcome} ${workdir}${result.detail ? ` (${result.detail})` : ''}\n`)
  }
  return failed ? 2 : 0
}

// Real paths on both sides: the launcher may call this through an aliased home.
function isRunAsMain() {
  const argv1 = process.argv[1]
  if (!argv1) return false
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(argv1)
  } catch {
    return import.meta.url === pathToFileURL(argv1).href
  }
}

if (isRunAsMain()) process.exit(main(process.argv.slice(2)))
