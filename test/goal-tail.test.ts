/**
 * The cursored tailer over the PROVEN transcript, and nothing else.
 *
 * Three tailers already read the session JSONL in this plugin, and this one is
 * deliberately the narrowest of them: RestingWatcher walks every .jsonl in the
 * project directory because a usage cap is account wide, but a GOAL belongs to
 * one session, and a goal set in a neighbour's session must never be adopted
 * into this owner's mission. So the path comes from
 * sessionBinder.provenTranscriptPath() and from nowhere else, and when the
 * binder has not POSITIVELY proven one, this reads nothing at all.
 *
 * Mutations these tests are proven against (task C1):
 *   - leave the cursor where it was            -> the never re reads test red
 *   - consume the half written trailing line   -> the partial line test red
 *   - keep the cursor after a truncation       -> the truncation test red
 *   - keep the cursor across a path change     -> the path change test red
 *   - fall back to the last path the binder gave -> the unproven test red
 *   - read from the cursor with no cap         -> the capped read test red
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { GoalTail } from '../lib/goal-tail.ts'

const dir = (): string => mkdtempSync(join(tmpdir(), 'goal-tail-'))

let seq = 0
const row = (condition: string): string =>
  JSON.stringify({
    parentUuid: null,
    isSidechain: false,
    type: 'attachment',
    uuid: `row-${seq++}`,
    timestamp: '2026-09-20T19:38:55.042Z',
    attachment: { type: 'goal_status', met: false, sentinel: true, condition },
  })

test('the cursor never re reads a byte it has already read', () => {
  const home = dir()
  const path = join(home, 'session.jsonl')
  writeFileSync(path, `${row('first')}\n`)
  const tail = new GoalTail(() => path)

  const first = tail.read()
  assert.match(first, /"first"/, 'a small file is read whole on the first pass')
  assert.equal(tail.read(), '', 'no new bytes, nothing to hand back')

  appendFileSync(path, `${row('second')}\n`)
  const second = tail.read()
  assert.match(second, /"second"/)
  assert.ok(!second.includes('"first"'), 'the row already handed over is not handed over twice')
  assert.equal(tail.read(), '')
})

test('a half written trailing line is left for the next read', () => {
  const home = dir()
  const path = join(home, 'session.jsonl')
  const whole = row('the file gate.txt exists')
  writeFileSync(path, `${whole.slice(0, 40)}`)
  const tail = new GoalTail(() => path)
  assert.equal(tail.read(), '', 'a line still being appended is not consumed')

  appendFileSync(path, `${whole.slice(40)}\n`)
  const chunk = tail.read()
  assert.equal(chunk, `${whole}\n`, 'and it arrives whole on the next pass')
})

test('a truncated or rotated file restarts at zero', () => {
  const home = dir()
  const path = join(home, 'session.jsonl')
  writeFileSync(path, `${row('one')}\n${row('two')}\n`)
  const tail = new GoalTail(() => path)
  assert.match(tail.read(), /"two"/)

  writeFileSync(path, '')
  assert.equal(tail.read(), '', 'the truncation itself hands back nothing')

  writeFileSync(path, `${row('after')}\n`)
  assert.match(tail.read(), /"after"/, 'the replacement file is read from its first byte')
})

test('a path change resets the cursor', () => {
  const home = dir()
  const a = join(home, 'a.jsonl')
  const b = join(home, 'b.jsonl')
  writeFileSync(a, `${row('in a')}\n`)
  writeFileSync(b, `${row('in b')}\n`)

  let bound = a
  const tail = new GoalTail(() => bound)
  assert.match(tail.read(), /"in a"/)
  assert.equal(tail.read(), '')

  bound = b
  const chunk = tail.read()
  assert.match(chunk, /"in b"/, 'the new session is read from its own start, not from a byte count of the old one')
  assert.ok(!chunk.includes('"in a"'))
})

test('nothing is read while the binder has not proven a transcript', () => {
  const home = dir()
  const path = join(home, 'session.jsonl')
  writeFileSync(path, `${row('a goal on this session')}\n`)

  let proven: string | null = null
  const asked: Array<string | null> = []
  const tail = new GoalTail(() => {
    asked.push(proven)
    return proven
  })

  assert.equal(tail.read(), '', 'an unproven session is not this daemon session')
  assert.equal(tail.boundPath(), null)

  proven = path
  assert.match(tail.read(), /"a goal on this session"/, 'and the proven one is read')
  assert.equal(tail.boundPath(), path)

  // The binder can LOSE its proof: a marker ages out, a hook session ends. The
  // path it used to answer with is not a licence to keep reading that file.
  proven = null
  appendFileSync(path, `${row('written after the proof was lost')}\n`)
  assert.equal(
    tail.read(),
    '',
    'once the binder stops proving a transcript, nothing is read, not even the path it used to give',
  )

  proven = path
  assert.match(tail.read(), /"written after the proof was lost"/, 'and the cursor is where it was left')
  assert.equal(asked.length, 4, 'the path is asked for on every read and never remembered instead')
})

test('one read is capped, so a huge append cannot be pulled into memory whole', () => {
  const home = dir()
  const path = join(home, 'session.jsonl')
  const head = row('the oldest goal on this session')
  const filler = Array.from({ length: 40 }, (_v, i) => row(`filler ${i}`)).join('\n')
  writeFileSync(path, `${head}\n${filler}\n`)

  const tail = new GoalTail(() => path, { readMaxBytes: 400 })
  const chunk = tail.read()
  assert.ok(chunk.length > 0)
  assert.ok(chunk.length <= 400, 'a single read stays inside the cap')
  assert.ok(!chunk.includes('the oldest goal on this session'), 'the head of a long file is skipped, not buffered')
})

test('a missing file answers with nothing rather than throwing', () => {
  const home = dir()
  const tail = new GoalTail(() => join(home, 'never-written.jsonl'))
  assert.equal(tail.read(), '')
  assert.equal(tail.read(), '')
})
