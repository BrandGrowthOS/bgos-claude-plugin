/**
 * Persistent chat poll cursors (the restart-replay fix).
 *
 * Bug (Dutify aijvk1h8LM): server.ts held the per-chat last-seen message
 * cursor in a plain in-memory Map, so every daemon restart reset it to
 * empty. The first poll after boot then ran the lastSeen === 0 full-fetch
 * heuristic for EVERY monitored chat and re-forwarded dormant chats'
 * trailing unanswered messages as [backlog]. Observed live 2026-07-18: one
 * restart delivered roughly 40 June-era messages from long-answered threads.
 *
 * lib/cursor-store.ts is the fix: an atomic, per-assistant, corruption
 * tolerant JSON store modeled on the gobot channel's last-id-store (the
 * same replay bug, fixed the same way). This suite drives the real module.
 *
 * Invariants:
 *   1. Roundtrip: cursors written by one process are read back identically.
 *   2. Atomic write: a save never leaves a partial file or stray tempfile;
 *      a failed save leaves the previous file intact.
 *   3. Tolerant load: missing or corrupt files load as an empty map and are
 *      reported as "no file" (first-run gate applies); malformed entries in
 *      an otherwise valid file are skipped, never thrown.
 *   4. Per-assistant keying: two assistant ids resolve to two files with no
 *      cross-talk; a missing id falls back to a per-cwd hash, never a file
 *      shared between daemons.
 *   5. Restart simulation: a fresh process (new Map + load) sees the same
 *      cursors, so old message ids stay behind the cursor and are not
 *      replayed, and the next poll is a delta poll from the restored cursor.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CursorStore,
  loadCursorFile,
  saveCursorFile,
  resolveCursorFilePath,
  CURSOR_FILE_NAME,
} from '../lib/cursor-store.js'
import { buildChatPollRequest } from '../lib/poll-core.js'

function freshDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

// ── 1. Roundtrip ─────────────────────────────────────────────────────────────

test('roundtrip: saved cursors load back identically, fileExisted true', () => {
  const file = join(freshDir('cursor-roundtrip-'), CURSOR_FILE_NAME)
  const cursors = new Map<string, number>([
    ['101', 555],
    ['202', 9],
    ['9007', 123456789],
  ])
  assert.equal(saveCursorFile(file, cursors), true)

  const loaded = loadCursorFile(file)
  assert.equal(loaded.fileExisted, true)
  assert.deepEqual(
    [...loaded.cursors.entries()].sort(),
    [...cursors.entries()].sort(),
  )
})

test('save creates missing parent directories', () => {
  const file = join(freshDir('cursor-mkdir-'), 'deep', 'nested', CURSOR_FILE_NAME)
  assert.equal(saveCursorFile(file, new Map([['1', 2]])), true)
  assert.equal(loadCursorFile(file).cursors.get('1'), 2)
})

// ── 2. Atomic write ──────────────────────────────────────────────────────────

test('atomic write: no tempfile or partial file remains after a save', () => {
  const dir = freshDir('cursor-atomic-')
  const file = join(dir, CURSOR_FILE_NAME)
  saveCursorFile(file, new Map([['1', 10]]))
  saveCursorFile(file, new Map([['1', 20], ['2', 30]]))

  const entries = readdirSync(dir)
  assert.deepEqual(entries, [CURSOR_FILE_NAME], 'only the final file may exist')
  // The file must be complete, valid JSON (a partial write would not parse).
  const parsed = JSON.parse(readFileSync(file, 'utf8'))
  assert.deepEqual(parsed.cursors, { '1': 20, '2': 30 })
})

test('simulated crash: a failed save leaves the previous file intact', () => {
  const dir = freshDir('cursor-crash-')
  const file = join(dir, CURSOR_FILE_NAME)
  saveCursorFile(file, new Map([['1', 10]]))

  // Make the directory unwritable so the tempfile write fails mid-save.
  chmodSync(dir, 0o500)
  try {
    assert.equal(
      saveCursorFile(file, new Map([['1', 99]])),
      false,
      'save must report failure, not throw',
    )
  } finally {
    chmodSync(dir, 0o700)
  }

  const loaded = loadCursorFile(file)
  assert.equal(loaded.fileExisted, true)
  assert.equal(loaded.cursors.get('1'), 10, 'previous cursors must survive')
})

// ── 3. Tolerant load ─────────────────────────────────────────────────────────

test('missing file loads as empty with fileExisted false, never throws', () => {
  const loaded = loadCursorFile(join(freshDir('cursor-missing-'), CURSOR_FILE_NAME))
  assert.equal(loaded.fileExisted, false)
  assert.equal(loaded.cursors.size, 0)
})

test('corrupt file (garbage bytes) loads as empty first run, never throws', () => {
  const file = join(freshDir('cursor-garbage-'), CURSOR_FILE_NAME)
  writeFileSync(file, 'not json {{{[')
  const loaded = loadCursorFile(file)
  assert.equal(loaded.fileExisted, false, 'corrupt = treated as first run')
  assert.equal(loaded.cursors.size, 0)
})

test('valid JSON with the wrong shape loads as empty first run', () => {
  const file = join(freshDir('cursor-shape-'), CURSOR_FILE_NAME)
  writeFileSync(file, JSON.stringify([1, 2, 3]))
  assert.equal(loadCursorFile(file).fileExisted, false)

  writeFileSync(file, JSON.stringify({ v: 99, cursors: { '1': 2 } }))
  assert.equal(loadCursorFile(file).fileExisted, false, 'unknown version is not trusted')
})

test('malformed entries are skipped, valid ones survive', () => {
  const file = join(freshDir('cursor-entries-'), CURSOR_FILE_NAME)
  writeFileSync(
    file,
    JSON.stringify({
      v: 1,
      cursors: {
        '12': 'abc',
        '34': 7.5,
        '56': -3,
        '': 9,
        '78': 42,
      },
    }),
  )
  const loaded = loadCursorFile(file)
  assert.equal(loaded.fileExisted, true)
  assert.deepEqual([...loaded.cursors.entries()], [['78', 42]])
})

// ── 4. Per-assistant keying ──────────────────────────────────────────────────

test('two assistant ids resolve to two distinct files', () => {
  const home = freshDir('cursor-home-')
  const a = resolveCursorFilePath({ assistantId: '7', cwd: '/x', env: {}, home })
  const b = resolveCursorFilePath({ assistantId: '8', cwd: '/x', env: {}, home })
  assert.equal(a, join(home, '.bgos-plugin-state', '7', CURSOR_FILE_NAME))
  assert.equal(b, join(home, '.bgos-plugin-state', '8', CURSOR_FILE_NAME))
  assert.notEqual(a, b)
})

test('missing assistant id falls back to a per-cwd hash, never a shared file', () => {
  const home = freshDir('cursor-home-')
  const a = resolveCursorFilePath({ assistantId: '', cwd: '/work/agent-a', env: {}, home })
  const b = resolveCursorFilePath({ assistantId: undefined, cwd: '/work/agent-b', env: {}, home })
  const a2 = resolveCursorFilePath({ assistantId: '', cwd: '/work/agent-a', env: {}, home })
  assert.ok(a.includes('cwd-'), 'fallback key is cwd-derived')
  assert.notEqual(a, b, 'different cwds must not share a store')
  assert.equal(a, a2, 'the fallback is stable for the same cwd')
})

test('a path-hostile assistant id falls back to the cwd hash', () => {
  const home = freshDir('cursor-home-')
  const p = resolveCursorFilePath({ assistantId: '../evil', cwd: '/w', env: {}, home })
  assert.ok(p.includes('cwd-'), 'traversal-looking ids must not become paths')
  assert.ok(p.startsWith(join(home, '.bgos-plugin-state')))
})

test('BGOS_PLUGIN_STATE_DIR overrides the state root', () => {
  const root = freshDir('cursor-root-')
  const p = resolveCursorFilePath({
    assistantId: '7',
    cwd: '/x',
    env: { BGOS_PLUGIN_STATE_DIR: root },
    home: '/nonexistent-home',
  })
  assert.equal(p, join(root, '7', CURSOR_FILE_NAME))
})

test('two stores keyed by different assistants have no cross-talk', () => {
  const home = freshDir('cursor-xtalk-')
  const fileA = resolveCursorFilePath({ assistantId: '1', cwd: '/x', env: {}, home })
  const fileB = resolveCursorFilePath({ assistantId: '2', cwd: '/x', env: {}, home })

  const storeA = new CursorStore(fileA)
  const mapA = storeA.load().cursors
  mapA.set('900', 111)
  storeA.markDirty()
  assert.equal(storeA.flushIfDirty(), true)

  const storeB = new CursorStore(fileB)
  const loadedB = storeB.load()
  assert.equal(loadedB.fileExisted, false, 'assistant 2 must not see assistant 1 state')
  assert.equal(loadedB.cursors.size, 0)

  assert.ok(existsSync(fileA))
  assert.ok(!existsSync(fileB))
})

// ── 5. Restart simulation (the bug reproduction) ─────────────────────────────

test('restart simulation: cursors survive a new Map + load, old ids are not replayed', () => {
  const file = join(freshDir('cursor-restart-'), CURSOR_FILE_NAME)

  // Process 1: first run, cursors advance as polls process messages.
  const store1 = new CursorStore(file)
  const boot1 = store1.load()
  assert.equal(boot1.fileExisted, false)
  boot1.cursors.set('101', 4200)
  boot1.cursors.set('202', 90)
  store1.markDirty()
  assert.equal(store1.flushIfDirty(), true)
  assert.equal(store1.flushIfDirty(), false, 'clean store must not rewrite')

  // Process 2: the restart. Before the fix this was `new Map()` and every
  // cursor came back 0, sending dormant chat tails as [backlog].
  const store2 = new CursorStore(file)
  const boot2 = store2.load()
  assert.equal(boot2.fileExisted, true)
  assert.equal(boot2.cursors.get('101'), 4200)
  assert.equal(boot2.cursors.get('202'), 90)

  // No replay: every previously seen message id sits at or below the
  // restored cursor, so the steady-state `id > lastSeen` filter excludes it.
  const restored = boot2.cursors.get('101') ?? 0
  const oldIds = [4000, 4100, 4200]
  assert.deepEqual(oldIds.filter((id) => id > restored), [])
})

test('after a restart the next poll is a delta poll from the restored cursor', () => {
  const file = join(freshDir('cursor-delta-'), CURSOR_FILE_NAME)
  const store1 = new CursorStore(file)
  const map1 = store1.load().cursors
  map1.set('101', 4200)
  store1.markDirty()
  store1.flushIfDirty()

  const restored = new CursorStore(file).load().cursors
  const req = buildChatPollRequest({
    chatId: '101',
    userId: 'u1',
    lastSeen: restored.get('101') ?? 0,
    unansweredButtonCount: 0,
  })
  assert.equal(req.mode, 'delta')
  assert.ok(req.path.includes('afterId=4200'), 'afterId must come from the restored cursor')
})

test('flushIfDirty failure keeps the store dirty so a later flush retries', () => {
  const dir = freshDir('cursor-retry-')
  const file = join(dir, CURSOR_FILE_NAME)
  const store = new CursorStore(file)
  const map = store.load().cursors
  map.set('1', 5)
  store.markDirty()

  chmodSync(dir, 0o500)
  try {
    assert.equal(store.flushIfDirty(), false)
    assert.equal(store.isDirty, true, 'failed flush must not clear the dirty flag')
  } finally {
    chmodSync(dir, 0o700)
  }
  assert.equal(store.flushIfDirty(), true)
  assert.equal(loadCursorFile(file).cursors.get('1'), 5)
})
