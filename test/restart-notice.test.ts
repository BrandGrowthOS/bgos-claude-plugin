/**
 * The restart line (board row b7276b5a). KC pressed Restart on an agent in the Helper on 2026-11-13:
 * the restart was real (the old claude and daemon gone, a new claude resumed the same session), but
 * asked whether it had been restarted the agent said no. A resumed session carries nothing that says
 * it was restarted, so it answers from its transcript.
 *
 * Now whoever restarts the agent on purpose (the owner's Restart, the Helper's check up, the watcher's
 * own restart) leaves ~/.bgos-agent/<id>/restart-notice.json first; the daemon the restart brings up
 * takes it once, and the first channel card it sends carries ONE line:
 *   "[hoai] You were restarted by <the owner | the Helper | the watcher> at <HH:MM> UTC; your conversation continued."
 * A start nobody asked for (a first start, a crash relaunch by the launcher or the service) leaves no
 * file, so it adds nothing. A watcher start of an agent that had stopped says so ("after your session
 * stopped"). Nothing is posted to chat: the line is in the card the session reads, not a message.
 *
 * Run: npx tsx --test test/restart-notice.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  RESTART_NOTICE_FILE_NAME,
  RESTART_NOTICE_MAX_AGE_MS,
  applyRestartLine,
  createRestartLineSlot,
  parseRestartNotice,
  restartLine,
  restartNoticeBody,
  takeRestartNotice,
  withdrawRestartNotice,
  writeRestartNotice,
} from '../lib/restart-notice.mjs'
import { memoryFs } from './helpers/memory-fs.ts'

const STATE_DIR = '/home/agent/.bgos-agent/912'
const NOTICE = `${STATE_DIR}/${RESTART_NOTICE_FILE_NAME}`
const AT = Date.parse('2026-11-13T14:02:41.000Z')
const BOOT = AT + 20_000

/** The wake card contract (wake-card-contract skill): every meta value a string, absent fields omitted. */
function assertAllStrings(meta: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(meta)) {
    assert.equal(typeof v, 'string', `meta.${k} must be a string (got ${v === null ? 'null' : typeof v}); the harness drops the card otherwise`)
  }
}

/** A take over the in-memory HOME, through the same two calls the daemon makes on disk. */
function memoryTake(fs: ReturnType<typeof memoryFs>, bootedAtMs = BOOT) {
  return takeRestartNotice({
    stateDir: STATE_DIR,
    bootedAtMs,
    fs: {
      readFile: (p: string) => fs.readFile(p),
      unlink: (p: string) => {
        if (!fs.files.has(p)) throw new Error(`ENOENT: ${p}`)
        fs.rm(p)
      },
    },
  })
}

// -- the line ---------------------------------------------------------------------------------------

test('the line names who restarted the agent and when, in UTC, and says the conversation continued', () => {
  assert.equal(restartLine({ by: 'owner', atMs: AT }), '[hoai] You were restarted by the owner at 14:02 UTC; your conversation continued.')
  assert.equal(restartLine({ by: 'helper', atMs: AT }), '[hoai] You were restarted by the Helper at 14:02 UTC; your conversation continued.')
  assert.equal(restartLine({ by: 'watcher', atMs: AT }), '[hoai] You were restarted by the watcher at 14:02 UTC; your conversation continued.')
  // The watcher (or a Helper or owner start) that found the session already stopped says so; an
  // update restart says why.
  assert.equal(
    restartLine({ by: 'watcher', atMs: AT, why: 'stopped' }),
    '[hoai] You were restarted by the watcher at 14:02 UTC after your session stopped; your conversation continued.',
  )
  assert.equal(
    restartLine({ by: 'watcher', atMs: AT, why: 'update' }),
    '[hoai] You were restarted by the watcher at 14:02 UTC to load an update; your conversation continued.',
  )
  // Midnight and single digits are zero padded.
  assert.match(restartLine({ by: 'owner', atMs: Date.parse('2026-11-14T00:05:00.000Z') }), / at 00:05 UTC;/)
})

test('one line, no em or en dash, and nothing for a notice that is not one', () => {
  for (const by of ['owner', 'helper', 'watcher']) {
    for (const why of [undefined, 'stopped', 'update']) {
      const line = restartLine({ by, atMs: AT, ...(why ? { why } : {}) })
      assert.equal(line.includes('\n'), false, line)
      assert.equal(/[\u2013\u2014]/.test(line), false, line)
    }
  }
  assert.equal(restartLine(null), '')
  assert.equal(restartLine({ by: 'someone', atMs: AT }), '')
  assert.equal(restartLine({ by: 'owner', atMs: Number.NaN }), '')
})

// -- the file -----------------------------------------------------------------------------------------

test('the body is who, when and (only when known) why; the parser refuses anything else', () => {
  const body = restartNoticeBody({ by: 'owner', atMs: AT })
  assert.ok(body)
  assert.deepEqual(JSON.parse(body!), { by: 'owner', at: '2026-11-13T14:02:41.000Z' }, 'no why key when there is none')
  assert.deepEqual(parseRestartNotice(body), { by: 'owner', atMs: AT })
  assert.deepEqual(parseRestartNotice(restartNoticeBody({ by: 'watcher', atMs: AT, why: 'stopped' })), { by: 'watcher', atMs: AT, why: 'stopped' })
  assert.equal(restartNoticeBody({ by: 'nobody', atMs: AT }), null)
  assert.equal(restartNoticeBody({ by: 'owner', atMs: Number.NaN }), null)
  assert.deepEqual(JSON.parse(restartNoticeBody({ by: 'owner', atMs: AT, why: 'other' })!), { by: 'owner', at: '2026-11-13T14:02:41.000Z' }, 'an unknown why is dropped')
  for (const junk of [null, '', 'x', '{}', '[]', '{"by":"owner"}', '{"by":"owner","at":"soon"}', '{"by":"root","at":"2026-11-13T14:02:41.000Z"}', '{"by":3,"at":"2026-11-13T14:02:41.000Z"}']) {
    assert.equal(parseRestartNotice(junk), null, String(junk))
  }
})

test('the restarter writes it beside the agent state, and withdraws only its own when the restart failed', () => {
  const fs = memoryFs({})
  assert.equal(writeRestartNotice({ fs, stateDir: STATE_DIR, by: 'helper', atMs: AT }), true)
  assert.deepEqual(parseRestartNotice(fs.readFile(NOTICE)), { by: 'helper', atMs: AT })
  assert.equal([...fs.files.keys()].filter((p) => p.startsWith(STATE_DIR)).length, 1, 'no temp file left behind')
  // A later restart's notice is not withdrawn by an earlier restart's failure.
  assert.equal(withdrawRestartNotice({ fs, stateDir: STATE_DIR, atMs: AT - 1 }), false)
  assert.equal(fs.files.has(NOTICE), true)
  assert.equal(withdrawRestartNotice({ fs, stateDir: STATE_DIR, atMs: AT }), true)
  assert.equal(fs.files.has(NOTICE), false)
  // Nothing to write for an unknown restarter, and a broken disk is a false, never a throw.
  assert.equal(writeRestartNotice({ fs, stateDir: STATE_DIR, by: 'nobody', atMs: AT }), false)
  assert.equal(writeRestartNotice({ fs: { ...fs, writeFile: () => { throw new Error('EROFS') } }, stateDir: STATE_DIR, by: 'owner', atMs: AT }), false)
  assert.equal(writeRestartNotice({ fs, stateDir: '', by: 'owner', atMs: AT }), false)
})

// -- the daemon's take --------------------------------------------------------------------------------

test('RED 1: a restart notice yields the line once, then never again', () => {
  const fs = memoryFs({})
  writeRestartNotice({ fs, stateDir: STATE_DIR, by: 'owner', atMs: AT })
  const notice = memoryTake(fs)
  assert.deepEqual(notice, { by: 'owner', atMs: AT })
  assert.equal(fs.files.has(NOTICE), false, 'taken: removed by the daemon')
  // The next daemon (a later crash relaunch, a second boot) finds nothing.
  assert.equal(memoryTake(fs, BOOT + 60_000), null)

  // The daemon's slot: the first card takes the line, every later card goes out as it was.
  const slot = createRestartLineSlot()
  slot.set(restartLine(notice))
  const first = { content: 'hello from KC', meta: { chat_id: '41', message_id: '7' } }
  const step = applyRestartLine(first, slot)
  assert.ok(step)
  assert.equal(first.content, '[hoai] You were restarted by the owner at 14:02 UTC; your conversation continued.\n\nhello from KC')
  assert.equal(step!.before, 'hello from KC')
  assert.equal(step!.after, first.content)
  const second = { content: 'are you back?', meta: { chat_id: '41', message_id: '8' } }
  assert.equal(applyRestartLine(second, slot), null)
  assert.equal(second.content, 'are you back?')
  assert.equal(applyRestartLine({ content: 'and again', meta: {} }, slot), null)
})

test('RED 2: no notice yields no line, whatever the card', () => {
  const fs = memoryFs({})
  assert.equal(memoryTake(fs), null)
  const slot = createRestartLineSlot()
  slot.set(restartLine(null))
  assert.equal(slot.pending(), false, 'an empty line is no line')
  const card = { content: 'hello', meta: { chat_id: '41' } }
  assert.equal(applyRestartLine(card, slot), null)
  assert.deepEqual(card, { content: 'hello', meta: { chat_id: '41' } })
})

test('RED 3: the card meta stays all strings, with nothing added and nothing taken away', () => {
  const slot = createRestartLineSlot()
  // The sparse card (only the event type) and a full inbound one.
  for (const meta of [{ event_type: 'liveness_probe' }, { chat_id: '41', message_id: '7', user_id: 'u1', is_shared_recipient: 'false', sender_display_name: 'KC' }]) {
    slot.set(restartLine({ by: 'helper', atMs: AT }))
    const before = { ...meta }
    const card = { content: 'x', meta }
    assert.ok(applyRestartLine(card, slot))
    assertAllStrings(card.meta)
    assert.deepEqual(card.meta, before)
  }
})

test('a card that did not go out puts the line back for the next one', () => {
  const slot = createRestartLineSlot()
  slot.set(restartLine({ by: 'owner', atMs: AT }))
  const step = applyRestartLine({ content: 'lost', meta: {} }, slot)
  assert.ok(step)
  assert.equal(slot.pending(), false)
  step!.restore()
  assert.equal(slot.pending(), true)
  const card = { content: 'next', meta: {} }
  assert.ok(applyRestartLine(card, slot))
  assert.match(card.content, /^\[hoai\] You were restarted by the owner at 14:02 UTC; your conversation continued\.\n\nnext$/)
  // A restore after the line went out on another card adds nothing twice.
  step!.restore()
  assert.equal(slot.pending(), false)
})

test('a card without text content is left alone and keeps the line for the next card', () => {
  const slot = createRestartLineSlot()
  slot.set(restartLine({ by: 'owner', atMs: AT }))
  assert.equal(applyRestartLine({ meta: {} } as any, slot), null)
  assert.equal(applyRestartLine(null as any, slot), null)
  assert.equal(slot.pending(), true)
})

test('a notice written after this daemon booted is the NEXT session\'s: left in place', () => {
  const fs = memoryFs({})
  writeRestartNotice({ fs, stateDir: STATE_DIR, by: 'owner', atMs: BOOT + 1 })
  assert.equal(memoryTake(fs, BOOT), null)
  assert.equal(fs.files.has(NOTICE), true)
})

test('a stale notice (a restart that never happened) is removed and says nothing', () => {
  const fs = memoryFs({})
  writeRestartNotice({ fs, stateDir: STATE_DIR, by: 'owner', atMs: AT })
  assert.equal(memoryTake(fs, AT + RESTART_NOTICE_MAX_AGE_MS + 1), null)
  assert.equal(fs.files.has(NOTICE), false)
  // Junk is removed too, never read as a restart.
  fs.writeFile(NOTICE, 'not json')
  assert.equal(memoryTake(fs), null)
  assert.equal(fs.files.has(NOTICE), false)
})

test('two daemons racing: only the one whose remove succeeds tells its session', () => {
  const fs = memoryFs({})
  writeRestartNotice({ fs, stateDir: STATE_DIR, by: 'owner', atMs: AT })
  const text = fs.readFile(NOTICE)
  const loser = takeRestartNotice({
    stateDir: STATE_DIR,
    bootedAtMs: BOOT,
    fs: { readFile: () => text, unlink: () => { throw new Error('ENOENT') } },
  })
  assert.equal(loser, null)
})

test('the default fs is the real disk: write, take once, gone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'restart-notice-'))
  try {
    writeFileSync(join(dir, RESTART_NOTICE_FILE_NAME), restartNoticeBody({ by: 'watcher', atMs: AT, why: 'update' })!)
    assert.deepEqual(takeRestartNotice({ stateDir: dir, bootedAtMs: BOOT }), { by: 'watcher', atMs: AT, why: 'update' })
    assert.equal(existsSync(join(dir, RESTART_NOTICE_FILE_NAME)), false)
    assert.equal(takeRestartNotice({ stateDir: dir, bootedAtMs: BOOT }), null)
    // The watcher's own node fs writes the same file the daemon reads.
    assert.equal(writeRestartNotice({ stateDir: dir, by: 'helper', atMs: AT }), true)
    assert.deepEqual(parseRestartNotice(readFileSync(join(dir, RESTART_NOTICE_FILE_NAME), 'utf8')), { by: 'helper', atMs: AT })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
