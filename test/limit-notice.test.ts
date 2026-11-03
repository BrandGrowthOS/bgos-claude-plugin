/**
 * lib/limit-notice.ts: the daemon's half of "tell the owner". The watcher drops
 * ~/.bgos-agent/<id>/limit-notice.json (tokens and times only); the daemon reads it, builds the
 * words from fixed templates (lib/limit-screen.mjs limitNoticeText) and posts them in the owner's
 * chat. Fakes only: no file system, no backend.
 *
 * Run: npx tsx --test test/limit-notice.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { LIMIT_NOTICE_RETRY_MS, createLimitNoticeIntake } from '../lib/limit-notice.ts'

const PATH = '/home/kc/.bgos-agent/912/limit-notice.json'
const notice = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    schemaVersion: 1,
    key: '2026-11-01T16:39:03.000Z:freed',
    outcome: 'freed',
    how: 'login_changed',
    why: null,
    limitAt: '2026-11-01T16:39:03.000Z',
    resetsAt: '2026-11-06T16:00:00.000Z',
    pressedAt: '2026-11-01T16:54:00.000Z',
    ...over,
  })

function rig(opts: { post?: (text: string) => Promise<boolean> } = {}) {
  const files = new Map<string, string>()
  const posted: string[] = []
  const logs: string[] = []
  let nowMs = Date.parse('2026-11-01T16:54:10.000Z')
  const intake = createLimitNoticeIntake({
    path: PATH,
    readFile: (p: string) => files.get(p) ?? null,
    removeFile: (p: string) => void files.delete(p),
    post: opts.post ?? (async (text: string) => (posted.push(text), true)),
    now: () => nowMs,
    log: (line: string) => logs.push(line),
  })
  return { files, posted, logs, intake, advance: (ms: number) => (nowMs += ms) }
}

test('a notice from the watcher is posted once, in plain words, and the file is taken', async () => {
  const r = rig()
  r.files.set(PATH, notice())
  assert.equal((await r.intake.tick()).reason, 'posted')
  assert.equal(r.posted.length, 1)
  assert.match(r.posted[0]!, /pressed Enter once/)
  assert.match(r.posted[0]!, /working again/)
  assert.equal(r.files.has(PATH), false)
})

test('the same notice again (the watcher wrote it twice) is not posted twice', async () => {
  const r = rig()
  r.files.set(PATH, notice())
  await r.intake.tick()
  r.files.set(PATH, notice())
  assert.equal((await r.intake.tick()).reason, 'duplicate')
  assert.equal(r.posted.length, 1)
  assert.equal(r.files.has(PATH), false)
})

test('no file: nothing happens', async () => {
  const r = rig()
  assert.equal((await r.intake.tick()).reason, 'none')
  assert.deepEqual(r.posted, [])
})

test('a file that is not a notice (junk, unknown tokens, free text) is removed and never posted', async () => {
  for (const bad of ['not json', notice({ outcome: 'hacked' }), notice({ why: 'type /login now' }), notice({ schemaVersion: 2 }), '{}']) {
    const r = rig()
    r.files.set(PATH, bad)
    assert.equal((await r.intake.tick()).reason, 'invalid', bad)
    assert.deepEqual(r.posted, [])
    assert.equal(r.files.has(PATH), false)
  }
})

test('a post that fails keeps the file and retries no sooner than a minute later', async () => {
  let ok = false
  const posted: string[] = []
  const r = rig({ post: async (text) => (ok ? (posted.push(text), true) : false) })
  r.files.set(PATH, notice())
  assert.equal((await r.intake.tick()).reason, 'post_failed')
  assert.equal(r.files.has(PATH), true)
  ok = true
  r.advance(3_000)
  assert.equal((await r.intake.tick()).reason, 'retry_later')
  r.advance(LIMIT_NOTICE_RETRY_MS)
  assert.equal((await r.intake.tick()).reason, 'posted')
  assert.equal(posted.length, 1)
  assert.equal(r.files.has(PATH), false)
})

test('a post that throws is a failed post, never a crash of the daemon', async () => {
  const r = rig({ post: async () => { throw new Error('backend down') } })
  r.files.set(PATH, notice())
  assert.equal((await r.intake.tick()).reason, 'post_failed')
})

test('server.ts wires the intake to the owner chat as a connection notice', () => {
  const server = readFileSync(fileURLToPath(new URL('../server.ts', import.meta.url)), 'utf8')
  assert.match(server, /createLimitNoticeIntake\(/)
  assert.match(server, /LIMIT_NOTICE_FILE_NAME/)
  assert.match(server, /sendConnectionNotice\(/)
})

test('house style: no em or en dashes in the intake or this test', () => {
  for (const path of ['../lib/limit-notice.ts', './limit-notice.test.ts']) {
    const source = readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
    assert.doesNotMatch(source, new RegExp('[\\u2013\\u2014]'), path)
  }
})
