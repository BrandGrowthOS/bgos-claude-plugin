#!/usr/bin/env node
/**
 * hoai-select-claude: print the `claude` an always-on install may bake.
 *
 *   node bin/hoai-select-claude.mjs
 *
 * Reads PATH and HOME from the environment of the installer that calls it, asks
 * each candidate whether it knows --dangerously-load-development-channels (see
 * lib/claude-binary.mjs for the rule), and prints ONE line on stdout:
 *
 *   HOAI_CLAUDE_OK <TAB> <path> <TAB> <version>
 *   HOAI_CLAUDE_REFUSED <TAB> <reason> <TAB> <message>
 *
 * Exit 0 for OK, 1 for a refusal. Every candidate that was skipped is named on
 * stderr, so an install can say which stale claude it stepped over. Board row
 * 84296679. No em dashes or en dashes in this file.
 */
import { realpathSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { chooseClaude, describeSkipped, DEV_CHANNELS_FLAG } from '../lib/claude-binary.mjs'

/**
 * @param {{ choose?: typeof chooseClaude, write?: (s: string) => void, writeErr?: (s: string) => void }} [io]
 * @returns {number} the exit code
 */
export function main({ choose = chooseClaude, write = (s) => process.stdout.write(s), writeErr = (s) => process.stderr.write(s) } = {}) {
  const chosen = choose()
  for (const entry of chosen.skipped) writeErr(`skipping ${describeSkipped(entry)}\n`)
  if (chosen.ok) {
    write(`HOAI_CLAUDE_OK\t${chosen.path}\t${chosen.version}\n`)
    return 0
  }
  const tried = chosen.skipped.map((entry) => `${entry.path}${entry.version ? ` ${entry.version}` : ''}`).join(', ')
  const message =
    chosen.reason === 'no-claude'
      ? 'no claude was found in ~/.local/bin or on PATH. Install Claude Code (claude.ai/code), then run this again.'
      : `every claude found (${tried}) is too old to know ${DEV_CHANNELS_FLAG}, which every agent launch carries, ` +
        'so each launch would exit at once. Update Claude Code (claude update, or reinstall it), ' +
        'then run this again.'
  write(`HOAI_CLAUDE_REFUSED\t${chosen.reason}\t${message}\n`)
  return 1
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

if (isRunAsMain()) process.exit(main())
