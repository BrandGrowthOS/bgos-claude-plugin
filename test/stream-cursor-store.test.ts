/**
 * Stream cursor persistence (agent-message-routing.md 5.7, 8 phase 2).
 *
 * The stream cursor is keyed to the PAIRING TOKEN's fingerprint so a re-pair
 * starts fresh at the server's state instead of resurrecting another
 * pairing's cursor (the OpenClaw offset-store pattern). Tolerant loads:
 * missing, corrupt, wrong version, and fingerprint mismatch all read as a
 * first run, never a throw. Writes follow lib/cursor-store.ts exactly:
 * atomic tempfile + rename, mode 0600, never throw.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

import {
  STREAM_CURSOR_FILE_NAME,
  loadStreamCursorFile,
  pairingTokenFingerprint,
  resolveStreamCursorFilePath,
  saveStreamCursorFile,
} from '../lib/stream-cursor-store.ts'

const FP = pairingTokenFingerprint('pair_token_a')

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'bgos-stream-cursor-'))
}

test('the fingerprint is sha256 of the pairing token, first 16 hex chars', () => {
  const expected = createHash('sha256')
    .update('pair_token_a')
    .digest('hex')
    .slice(0, 16)
  assert.equal(FP, expected)
  assert.equal(FP.length, 16)
  assert.notEqual(FP, pairingTokenFingerprint('pair_token_b'))
})

test('the cursor file lives beside the chat cursor file in the state dir', () => {
  assert.equal(
    resolveStreamCursorFilePath('/state/900/chat-cursors.json'),
    join('/state/900', STREAM_CURSOR_FILE_NAME),
  )
})

test('save then load round-trips seq, epoch, and fingerprint', () => {
  const filePath = join(freshDir(), 'nested', STREAM_CURSOR_FILE_NAME)
  assert.equal(saveStreamCursorFile(filePath, { seq: 41, epoch: 3 }, FP), true)
  assert.deepEqual(loadStreamCursorFile(filePath, FP), { seq: 41, epoch: 3 })
  const raw = JSON.parse(readFileSync(filePath, 'utf8'))
  assert.equal(raw.v, 1)
  assert.equal(raw.tokenFingerprint, FP)
})

test('the file is written 0600 (owner only), like the chat cursor store', () => {
  const filePath = join(freshDir(), STREAM_CURSOR_FILE_NAME)
  saveStreamCursorFile(filePath, { seq: 1, epoch: 1 }, FP)
  const mode = statSync(filePath).mode & 0o777
  assert.equal(mode, 0o600)
})

test('a missing file loads as first run (null)', () => {
  assert.equal(
    loadStreamCursorFile(join(freshDir(), STREAM_CURSOR_FILE_NAME), FP),
    null,
  )
})

test('a corrupt file loads as first run, never a throw', () => {
  const filePath = join(freshDir(), STREAM_CURSOR_FILE_NAME)
  writeFileSync(filePath, '{ not json')
  assert.equal(loadStreamCursorFile(filePath, FP), null)
})

test('a fingerprint mismatch is a first run: a re-pair never resurrects another pairing cursor', () => {
  const filePath = join(freshDir(), STREAM_CURSOR_FILE_NAME)
  saveStreamCursorFile(filePath, { seq: 500, epoch: 2 }, FP)
  assert.equal(
    loadStreamCursorFile(filePath, pairingTokenFingerprint('pair_token_b')),
    null,
    'a cursor written under another pairing token must not load',
  )
})

test('a wrong version or malformed fields load as first run', () => {
  const dir = freshDir()
  const cases: unknown[] = [
    { v: 2, seq: 10, epoch: 1, tokenFingerprint: FP },
    { v: 1, seq: 'ten', epoch: 1, tokenFingerprint: FP },
    { v: 1, seq: 10.5, epoch: 1, tokenFingerprint: FP },
    { v: 1, seq: -1, epoch: 1, tokenFingerprint: FP },
    { v: 1, seq: 10, epoch: null, tokenFingerprint: FP },
    { v: 1, seq: 10, epoch: 1 },
    [],
    'just a string',
  ]
  for (const [i, body] of cases.entries()) {
    const filePath = join(dir, `case-${i}.json`)
    writeFileSync(filePath, JSON.stringify(body))
    assert.equal(loadStreamCursorFile(filePath, FP), null, `case ${i} must be first run`)
  }
})

test('seq 0 with epoch 0 is a valid persisted cursor', () => {
  const filePath = join(freshDir(), STREAM_CURSOR_FILE_NAME)
  saveStreamCursorFile(filePath, { seq: 0, epoch: 0 }, FP)
  assert.deepEqual(loadStreamCursorFile(filePath, FP), { seq: 0, epoch: 0 })
})

test('a failed save returns false instead of throwing', () => {
  // A directory path cannot be renamed over; the save must swallow it.
  const dir = freshDir()
  assert.equal(saveStreamCursorFile(dir, { seq: 1, epoch: 1 }, FP), false)
})
