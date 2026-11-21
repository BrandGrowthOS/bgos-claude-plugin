#!/usr/bin/env node
/**
 * No tracked file names one of our own machines' home folders (board row a633fb9c).
 *
 * This repository is public. Lane reports, evidence logs and code comments had
 * carried the home folders of the machines the plugin is built on: at 0.87.4
 * this check finds 173 tracked files outside test/ (845 lines), where a plain
 * slash-only search found 160. test/no-home-paths.test.ts runs this check in
 * the suite, so a new one fails CI instead of shipping.
 *
 * What counts: a path segment Users/<name> or home/<name> for each account name
 * on our machines, and the shared Linux home root mnt/data/home,
 * with either slash (a Windows path, and the doubled backslash a JSON string
 * writes), a percent encoded slash (%2F, %5C), or the dash a Claude Code
 * project folder name puts for every slash (-Users-<name>-repo), and in any
 * letter case. The names are kept apart from the slashes in
 * this file so the check never spells a hit itself. Use a placeholder instead:
 * /Users/you, /home/you, C:\Users\you.
 *
 * What is exempt, and why, is EXEMPT below. Nothing else is.
 *
 * Run: node scripts/check-home-paths.mjs [repo]  (exit 1 and one line per hit)
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// The account names on our machines. Any of them under either home root is ours.
const NAMES = ['kc', 'bgos', 'fitecho', 'karim', 'leonidus']
// A slash, a backslash, or either one percent encoded (a URL query, a file:// link).
const SLASH = String.raw`(?:[\\/]|%2F|%5C)+`
// A name ends the segment: /Users/<name>x is someone else's folder.
const END = '(?![A-Za-z0-9_-])'
// Claude Code names a project folder by its cwd with every slash a dash
// (~/.claude/projects/-Users-<name>-repo). The dash after the name is that encoding's
// next slash, so here only a letter, digit or underscore makes it someone else's name.
const DASH_END = '(?![A-Za-z0-9_])'

export const HOME_PATH = new RegExp(
  [
    `${SLASH}(?:Users|home)${SLASH}(?:${NAMES.join('|')})${END}`,
    `${SLASH}mnt${SLASH}data${SLASH}home${END}`,
    `-(?:Users|home)-(?:${NAMES.join('|')})${DASH_END}`,
    `${['', 'mnt', 'data', 'home'].join('-')}${DASH_END}`,
  ].join('|'),
  'gi',
)

/** Tracked paths this check skips. Each one says why; a new entry needs a reason as good. */
export const EXEMPT = [
  {
    prefix: 'test/',
    why: 'the tests and their fixtures model these hosts on purpose (the a633fb9c scope is everything but the tests)',
  },
]

export function isExempt(path) {
  return EXEMPT.some((rule) => (rule.prefix ? path.startsWith(rule.prefix) : path === rule.path))
}

/** The tracked files of the repository at root, or throws: a check that cannot list the files proved nothing. */
export function trackedFiles(root) {
  const listing = spawnSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (listing.error || listing.status !== 0) {
    throw new Error(`git cannot list the tracked files of ${root}: ${listing.error?.message ?? listing.stderr.trim()}`)
  }
  return listing.stdout.split('\0').filter(Boolean)
}

/** Every hit in the working tree bytes of the tracked, non-exempt files: { file, line, text }. */
export function findHomePaths(root) {
  const hits = []
  for (const file of trackedFiles(root)) {
    if (isExempt(file)) continue
    let bytes
    try {
      bytes = readFileSync(join(root, file))
    } catch (error) {
      // A tracked file deleted in the working tree carries nothing; a folder (a submodule) is not text.
      if (error.code === 'ENOENT' || error.code === 'EISDIR') continue
      throw error
    }
    // latin1 maps every byte to one character, so a binary log is read too and nothing throws.
    const lines = bytes.toString('latin1').split('\n')
    lines.forEach((text, index) => {
      HOME_PATH.lastIndex = 0
      const match = HOME_PATH.exec(text)
      if (!match) return
      const from = Math.max(0, match.index - 40)
      hits.push({ file, line: index + 1, text: text.slice(from, match.index + match[0].length + 40).trim() })
    })
  }
  return hits
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = resolve(process.argv[2] ?? join(fileURLToPath(new URL('.', import.meta.url)), '..'))
  const hits = findHomePaths(root)
  for (const hit of hits) console.log(`${hit.file}:${hit.line}: ${hit.text}`)
  if (hits.length > 0) {
    console.error(`[check-home-paths] ${hits.length} lines name one of our home folders; use /Users/you, /home/you or C:\\Users\\you`)
    process.exitCode = 1
  } else console.log('[check-home-paths] no tracked file outside test/ names one of our home folders')
}
