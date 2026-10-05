/**
 * Every checkout gets the bytes CI tests, whatever the user's core.autocrlf says.
 *
 * WHY THIS FILE EXISTS. A Windows install of this plugin is a git clone: Claude
 * Code clones the marketplace repo with the user's own git config, and so does
 * hoai-bootstrap.ps1. Git for Windows ships core.autocrlf=true in its SYSTEM
 * config, so before .gitattributes said otherwise every file it did not pin
 * (349 of 361) was checked out CRLF on Windows. CI is Linux and only ever saw
 * LF. The suite read that as 12 red tests that looked like logic bugs, and
 * worse, as some source scans that silently stopped matching anything and
 * passed. The local answer was "clone with core.autocrlf=false", which fixed
 * one machine and nobody else's.
 *
 * The fix is one rule at the top of .gitattributes: every text file is LF in
 * every working tree, except Windows batch files, which are CRLF everywhere
 * (cmd.exe misreads labels in an LF-only batch file). These cases pin that rule
 * so it cannot rot:
 *
 *  - the attributes git resolves for every tracked text file. Runs anywhere,
 *    no Windows needed: a file left to core.autocrlf fails here on Linux CI.
 *  - the bytes a Windows default checkout really writes: a checkout made with
 *    core.autocrlf=true (which converts on any OS, Linux included) into a temp
 *    folder, scanned for CR. It must find CR in the batch files, which proves
 *    the scan reads bytes, and nowhere else.
 *  - the index: no file is committed with CRLF.
 *
 * If git cannot see a repository (an unpacked archive), the cases skip with a
 * reason, except under CI, where a missing .git would make them prove nothing.
 *
 * Run: npm test, or npx tsx --test test/line-endings.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const BATCH = /\.(cmd|bat)$/i

function git(args: string[], input?: string) {
  return spawnSync('git', ['-C', ROOT, ...args], { encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 })
}

/** Tracked files with their `git ls-files --eol` info, or a reason the listing is unavailable. */
function trackedFiles(): { files: { path: string; index: string }[] } | { unavailable: string } {
  const listing = git(['ls-files', '--eol', '-z'])
  if (listing.error || listing.status !== 0) {
    const why = listing.error?.message ?? listing.stderr.trim()
    if (process.env.CI) assert.fail(`git cannot list this checkout under CI, so the line ending rule would go unchecked: ${why}`)
    return { unavailable: `git cannot list this checkout (${why})` }
  }
  const files = listing.stdout
    .split('\0')
    .filter(Boolean)
    .map((entry) => {
      const tab = entry.indexOf('\t')
      return { path: entry.slice(tab + 1), index: entry.slice(0, tab).trim().split(/\s+/)[0]! }
    })
  return { files }
}

/** Text files only: git's own binary detection (i/-text) is what decides. */
function textFiles(files: { path: string; index: string }[]): string[] {
  return files.filter((f) => f.index !== 'i/-text').map((f) => f.path)
}

test('every tracked text file is LF in the working tree, Windows batch files CRLF, none left to core.autocrlf', (t) => {
  const listed = trackedFiles()
  if ('unavailable' in listed) return t.skip(listed.unavailable)
  const files = textFiles(listed.files)
  assert.ok(files.length > 300, `the listing must cover the repo, got ${files.length} text files`)

  const out = git(['check-attr', '-z', '--stdin', 'text', 'eol'], `${files.join('\0')}\0`)
  assert.equal(out.status, 0, out.stderr)
  const fields = out.stdout.split('\0')
  const attrs = new Map<string, Record<string, string>>()
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const [path, name, value] = [fields[i]!, fields[i + 1]!, fields[i + 2]!]
    attrs.set(path, { ...attrs.get(path), [name]: value })
  }

  const wrong: string[] = []
  for (const path of files) {
    const a = attrs.get(path) ?? {}
    const want = BATCH.test(path) ? 'crlf' : 'lf'
    if (!['set', 'auto'].includes(a.text ?? '') || a.eol !== want) {
      wrong.push(`${path}: text=${a.text} eol=${a.eol}, want text and eol=${want}`)
    }
  }
  assert.deepEqual(wrong, [], 'a file left to core.autocrlf checks out CRLF in a Windows user\'s clone, so its bytes are not what CI tested')
})

test('a checkout made with Windows\' default core.autocrlf=true writes LF everywhere except the batch files', (t) => {
  const listed = trackedFiles()
  if ('unavailable' in listed) return t.skip(listed.unavailable)
  const files = textFiles(listed.files)
  const dir = mkdtempSync(join(tmpdir(), 'hoai-eol-'))
  try {
    // checkout-index writes the index through the same conversion a clone uses; the prefix must
    // end in a slash, and git on Windows takes it in forward slash form.
    const prefix = `${dir.replace(/\\/g, '/')}/`
    const checkout = git(['-c', 'core.autocrlf=true', 'checkout-index', '-a', '-f', `--prefix=${prefix}`])
    assert.equal(checkout.status, 0, checkout.stderr)

    const withCr = files.filter((path) => readFileSync(join(dir, path)).includes(0x0d)).sort()
    const batch = files.filter((path) => BATCH.test(path)).sort()
    assert.ok(batch.includes('bin/hoai.cmd'), 'bin/hoai.cmd is the batch file this repo ships')
    assert.deepEqual(withCr, batch, 'only the batch files may carry CR in a Windows default checkout')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('no file is committed with CRLF', (t) => {
  const listed = trackedFiles()
  if ('unavailable' in listed) return t.skip(listed.unavailable)
  const crlfInIndex = listed.files.filter((f) => f.index === 'i/crlf' || f.index === 'i/mixed').map((f) => f.path)
  assert.deepEqual(crlfInIndex, [], 'the index must hold LF; the working tree conversion is the only place CRLF may appear')
})
