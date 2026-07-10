/**
 * Deterministic STORED zip writer/reader tests (Agent Packs).
 *
 * Coverage: CRC32 known vectors, byte-identical determinism (input order
 * and wall clock never matter, only entries + packagedAt), manifest.json
 * pinned first with the rest sorted, fixed DOS timestamp derived from
 * packagedAt, round trips (including UTF-8 names and empty files),
 * writer-level path validation, and reader corruption detection.
 *
 * Run: npm test (node --test) or bun test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  crc32,
  toDosDateTime,
  isValidEntryPath,
  comparePackPaths,
  buildStoredZip,
  readStoredZip,
  MANIFEST_ENTRY_NAME,
} from '../lib/pack-zip.ts'

const enc = new TextEncoder()
const dec = new TextDecoder()

function entry(path: string, text: string): { path: string; data: Uint8Array } {
  return { path, data: enc.encode(text) }
}

const PACKAGED_AT = new Date('2026-07-10T12:34:56.789Z')

// ── CRC32 ────────────────────────────────────────────────────────────────────

test('crc32 matches the published IEEE test vectors', () => {
  assert.equal(crc32(enc.encode('')), 0)
  assert.equal(crc32(enc.encode('123456789')), 0xcbf43926)
  assert.equal(
    crc32(enc.encode('The quick brown fox jumps over the lazy dog')),
    0x414fa339,
  )
})

// ── DOS date/time ────────────────────────────────────────────────────────────

test('toDosDateTime uses UTC fields with 2 second resolution', () => {
  const { dosTime, dosDate } = toDosDateTime(PACKAGED_AT)
  // 2026-07-10 -> ((2026-1980)<<9) | (7<<5) | 10
  assert.equal(dosDate, ((2026 - 1980) << 9) | (7 << 5) | 10)
  // 12:34:56 -> (12<<11) | (34<<5) | (56>>1)
  assert.equal(dosTime, (12 << 11) | (34 << 5) | (56 >> 1))
})

test('toDosDateTime clamps the pre-1980 underflow', () => {
  const { dosTime, dosDate } = toDosDateTime(new Date('1975-01-01T00:00:00Z'))
  assert.equal(dosDate, ((1980 - 1980) << 9) | (1 << 5) | 1)
  assert.equal(dosTime, 0)
})

// ── Path validation + ordering ───────────────────────────────────────────────

test('isValidEntryPath rejects traversal, absolute, backslash, empty', () => {
  assert.equal(isValidEntryPath('agent/CLAUDE.md'), true)
  assert.equal(isValidEntryPath('memory/notes.md'), true)
  assert.equal(isValidEntryPath(''), false)
  assert.equal(isValidEntryPath('/etc/passwd'), false)
  assert.equal(isValidEntryPath('../escape.md'), false)
  assert.equal(isValidEntryPath('agent/../escape.md'), false)
  assert.equal(isValidEntryPath('agent/./x.md'), false)
  assert.equal(isValidEntryPath('agent//x.md'), false)
  assert.equal(isValidEntryPath('agent\\x.md'), false)
})

test('comparePackPaths pins manifest.json first, then code-unit order', () => {
  const paths = ['memory/a.md', 'agent/CLAUDE.md', MANIFEST_ENTRY_NAME, 'agent/rules/r.md']
  paths.sort(comparePackPaths)
  assert.deepEqual(paths, [
    MANIFEST_ENTRY_NAME,
    'agent/CLAUDE.md',
    'agent/rules/r.md',
    'memory/a.md',
  ])
})

// ── Determinism ──────────────────────────────────────────────────────────────

test('same entries in any input order produce byte-identical zips', () => {
  const a = buildStoredZip(
    [
      entry('memory/notes.md', 'remember me'),
      entry(MANIFEST_ENTRY_NAME, '{"schema_version":1}'),
      entry('agent/CLAUDE.md', '# Agent'),
    ],
    PACKAGED_AT,
  )
  const b = buildStoredZip(
    [
      entry('agent/CLAUDE.md', '# Agent'),
      entry(MANIFEST_ENTRY_NAME, '{"schema_version":1}'),
      entry('memory/notes.md', 'remember me'),
    ],
    new Date(PACKAGED_AT.getTime()),
  )
  assert.deepEqual(Buffer.from(a), Buffer.from(b))
})

test('the zip depends on packagedAt, not the wall clock', () => {
  const entries = [entry(MANIFEST_ENTRY_NAME, '{}'), entry('agent/CLAUDE.md', 'x')]
  const a = buildStoredZip(entries, new Date('2026-07-10T12:00:00Z'))
  const b = buildStoredZip(entries, new Date('2026-07-10T12:00:00Z'))
  const c = buildStoredZip(entries, new Date('2027-01-02T03:04:06Z'))
  assert.deepEqual(Buffer.from(a), Buffer.from(b))
  assert.notDeepEqual(Buffer.from(a), Buffer.from(c))
})

test('manifest.json is the first entry and the rest are sorted', () => {
  const zip = buildStoredZip(
    [
      entry('memory/z.md', 'z'),
      entry('agent/skills/research/SKILL.md', 's'),
      entry(MANIFEST_ENTRY_NAME, '{}'),
      entry('agent/CLAUDE.md', 'c'),
    ],
    PACKAGED_AT,
  )
  const paths = readStoredZip(zip).map((e) => e.path)
  assert.deepEqual(paths, [
    MANIFEST_ENTRY_NAME,
    'agent/CLAUDE.md',
    'agent/skills/research/SKILL.md',
    'memory/z.md',
  ])
})

// ── Round trip ───────────────────────────────────────────────────────────────

test('round trip preserves every path and every byte', () => {
  const inputs = [
    entry(MANIFEST_ENTRY_NAME, JSON.stringify({ schema_version: 1 }, null, 2)),
    entry('agent/CLAUDE.md', '# My Agent\n\nBe helpful.\n'),
    entry('agent/rules/style.md', 'No tables.\n'),
    entry('memory/empty.md', ''),
    { path: 'memory/binary.bin', data: new Uint8Array([0, 255, 1, 254, 127]) },
  ]
  const out = readStoredZip(buildStoredZip(inputs, PACKAGED_AT))
  assert.equal(out.length, inputs.length)
  const byPath = new Map(out.map((e) => [e.path, e.data]))
  for (const input of inputs) {
    const data = byPath.get(input.path)
    assert.ok(data, `missing ${input.path}`)
    assert.deepEqual(Buffer.from(data!), Buffer.from(input.data))
  }
})

test('UTF-8 entry names round trip', () => {
  const out = readStoredZip(
    buildStoredZip([entry('memory/ملاحظات.md', 'مرحبا')], PACKAGED_AT),
  )
  assert.equal(out[0]!.path, 'memory/ملاحظات.md')
  assert.equal(dec.decode(out[0]!.data), 'مرحبا')
})

test('an empty entry list still produces a readable zip', () => {
  assert.deepEqual(readStoredZip(buildStoredZip([], PACKAGED_AT)), [])
})

// ── Writer guards ────────────────────────────────────────────────────────────

test('writer rejects duplicate and invalid paths', () => {
  assert.throws(
    () =>
      buildStoredZip(
        [entry('agent/CLAUDE.md', 'a'), entry('agent/CLAUDE.md', 'b')],
        PACKAGED_AT,
      ),
    /duplicate/,
  )
  assert.throws(() => buildStoredZip([entry('../x', 'a')], PACKAGED_AT), /invalid/)
  assert.throws(() => buildStoredZip([entry('/abs', 'a')], PACKAGED_AT), /invalid/)
  assert.throws(() => buildStoredZip([entry('a\\b', 'a')], PACKAGED_AT), /invalid/)
})

// ── Reader corruption detection ──────────────────────────────────────────────

test('reader detects corrupted entry data via CRC', () => {
  const zip = buildStoredZip(
    [entry(MANIFEST_ENTRY_NAME, '{}'), entry('agent/CLAUDE.md', 'hello world')],
    PACKAGED_AT,
  )
  // Flip one byte inside the CLAUDE.md data region (find it after its name).
  const nameOffset = Buffer.from(zip).indexOf(Buffer.from('agent/CLAUDE.md'))
  const corrupted = Uint8Array.from(zip)
  corrupted[nameOffset + 'agent/CLAUDE.md'.length] ^= 0xff
  assert.throws(() => readStoredZip(corrupted), /crc mismatch/)
})

test('reader rejects truncated and non-zip input', () => {
  const zip = buildStoredZip([entry(MANIFEST_ENTRY_NAME, '{}')], PACKAGED_AT)
  assert.throws(() => readStoredZip(zip.subarray(0, 10)), /too short/)
  assert.throws(
    () => readStoredZip(enc.encode('this is not a zip file at all, sorry........')),
    /end of central directory/,
  )
})
