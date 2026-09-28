/**
 * The vendored browser shim is pinned by hash, not by a sentence.
 *
 * WHY THIS FILE EXISTS. `bin/hoai-browser-mcp.mjs` is a byte-identical COPY of
 * the BGOS source of truth
 * (`frontend/electron-app/agent-browser/shim/hoai-browser-mcp.mjs`), because
 * decision 11.2 of the relay plan keeps the shim framework neutral: it never
 * reads a plugin's files, so every framework ships the same file and hands it
 * env. A copy is only as good as the thing that notices it has drifted, and for
 * one round that thing was prose: the sha256 sat in a commit message and
 * nothing compared it to anything. The BGOS shim was then fixed twice (the
 * relay answer is the body status, not the HTTP code; the pairing lane must
 * name the assistant) and this repo shipped the stale copy, with a dead relay
 * lane, until a review caught it by hand.
 *
 * So the hash now lives in `bin/hoai-browser-mcp.vendor.json` and this test
 * reads it. What each case buys:
 *
 *  - the pin vs the file on disk: a re-vendor can no longer land silently. It
 *    either matches the pin or it fails here, which forces whoever re-vendors
 *    to state the new hash in the tree (and to have looked at the diff).
 *  - LF, and the .gitattributes entry that guarantees it: without that entry
 *    `core.autocrlf` hands a Windows checkout a different byte sequence and the
 *    hash is unverifiable on disk for exactly the people most likely to check.
 *  - the cross-tree case: the BGOS tree is a separate private repo and is NOT
 *    on this repo's CI runner, so this suite cannot compare the two on its own.
 *    It is skipped with a reason unless HOAI_BROWSER_SHIM_SOURCE points at the
 *    BGOS shim, which is what the re-vendor checklist tells you to do on a
 *    machine that has both trees.
 *
 * What this still does NOT buy: nothing here fires when the BGOS shim changes
 * and this copy does not move. That check can only live on the BGOS side. The
 * behavioural cover for that case is `test/hoai-browser-mcp.relay.test.ts`.
 * See docs/vendoring-the-hoai-browser-shim.md and
 * docs/learnings/a-vendored-copy-is-only-as-good-as-its-hash-check.md.
 *
 * Run: npm test, or npx tsx --test test/hoai-browser-mcp.vendor.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const SHIM = join(ROOT, 'bin', 'hoai-browser-mcp.mjs')
const PIN = join(ROOT, 'bin', 'hoai-browser-mcp.vendor.json')
const CHECKLIST = join(ROOT, 'docs', 'vendoring-the-hoai-browser-shim.md')

interface Pin {
  file: string
  source: string
  sha256: string
  vendoredAt: string
  why: string
  howToUpdate: string
  crossTreeCheck: string
}

function pin(): Pin {
  return JSON.parse(readFileSync(PIN, 'utf8')) as Pin
}

/** The hash of a file's BYTES, which is the only claim worth pinning. */
function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

test('THE GUARD. the vendored shim hashes to the pinned sha256', () => {
  const expected = pin().sha256
  const actual = sha256(SHIM)
  assert.equal(
    actual,
    expected,
    `bin/hoai-browser-mcp.mjs is ${actual}, the pin says ${expected}. If you re-vendored the shim on purpose, ` +
      'follow docs/vendoring-the-hoai-browser-shim.md: put the new hash in bin/hoai-browser-mcp.vendor.json and ' +
      'run the relay suite. If you did not, this file has drifted from the BGOS source of truth.',
  )
})

test('the pin names the file it pins, the BGOS source, and a real hash', () => {
  const p = pin()
  assert.equal(p.file, 'bin/hoai-browser-mcp.mjs')
  assert.match(p.sha256, /^[0-9a-f]{64}$/, 'a lowercase hex sha256, so the string can be compared byte for byte')
  assert.match(p.source, /agent-browser[/\\]shim[/\\]hoai-browser-mcp\.mjs/, 'the pin points at the BGOS shim')
  assert.match(p.vendoredAt, /^\d{4}-\d{2}-\d{2}$/)
  assert.equal(p.howToUpdate, 'docs/vendoring-the-hoai-browser-shim.md')
  assert.match(p.crossTreeCheck, /HOAI_BROWSER_SHIM_SOURCE/, 'the pin says how to check the other tree')
})

test('the vendored copy is LF, and .gitattributes is what keeps it that way', () => {
  const bytes = readFileSync(SHIM)
  assert.ok(!bytes.includes(Buffer.from('\r\n')), 'a CRLF copy has a different sha256 and cannot be verified on disk')
  const attributes = readFileSync(join(ROOT, '.gitattributes'), 'utf8')
  assert.match(
    attributes,
    /^bin\/hoai-browser-mcp\.mjs text eol=lf$/m,
    'without this line core.autocrlf hands a Windows checkout CRLF and the pinned hash stops matching',
  )
})

test('the re-vendor checklist exists and names the pin, the guard and the cross-tree check', () => {
  assert.ok(existsSync(CHECKLIST), 'docs/vendoring-the-hoai-browser-shim.md is what the pin tells a maintainer to read')
  const text = readFileSync(CHECKLIST, 'utf8')
  for (const needle of [
    'bin/hoai-browser-mcp.vendor.json',
    'test/hoai-browser-mcp.vendor.test.ts',
    'test/hoai-browser-mcp.relay.test.ts',
    'HOAI_BROWSER_SHIM_SOURCE',
  ]) {
    assert.ok(text.includes(needle), `the checklist must name ${needle}`)
  }
})

// The cross-tree comparison. BGOS is a separate private repo and is not on this
// repo's CI runner, so this is an opt-in case rather than a check this suite can
// make on its own: point HOAI_BROWSER_SHIM_SOURCE at the BGOS shim on a machine
// that has both trees (the re-vendor checklist tells you to) and it runs.
const source = (process.env.HOAI_BROWSER_SHIM_SOURCE ?? '').trim()
const sourceReadable = source !== '' && existsSync(source)
test(
  'the BGOS source of truth hashes to the same pin (opt-in, needs both trees)',
  {
    skip: sourceReadable
      ? false
      : source === ''
        ? 'HOAI_BROWSER_SHIM_SOURCE is not set: the BGOS tree is a separate repo and is not on this runner, so the cross-tree hash cannot be checked here'
        : `HOAI_BROWSER_SHIM_SOURCE points at ${source}, which does not exist on this machine`,
  },
  () => {
    // bun's node:test ignores the skip option and runs the body; this is the same skip.
    if (!sourceReadable) return
    const expected = pin().sha256
    assert.equal(
      sha256(source),
      expected,
      `the BGOS shim at ${source} is not the file this repo vendors; re-vendor it per docs/vendoring-the-hoai-browser-shim.md`,
    )
    assert.equal(sha256(SHIM), expected, 'and the copy still matches, so the two trees agree')
  },
)
