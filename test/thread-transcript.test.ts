/**
 * THREADCRASH (0.87.1): the thread's transcript work on disk, in pieces
 * (lib/thread-transcript.ts), gives byte for byte what the one string rule
 * gives (lib/thread-lane-args.ts threadLaneTranscript), at any chunk size, and
 * never holds the transcript in memory.
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, openSync, writeSync, closeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { threadLaneTranscript } from '../lib/thread-lane-args.ts'
import { clearActiveGoal, copyTranscriptClearingGoal, findActiveGoalRow } from '../lib/thread-transcript.ts'

const FIXTURES = join(import.meta.dirname, 'fixtures')

function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'thread-transcript-'))
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }))
}

const goal = (fields: Record<string, unknown>) =>
  JSON.stringify({ type: 'attachment', uuid: 'u1', attachment: { type: 'goal_status', condition: 'ship it', ...fields } })
const row = (text: string) => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })

const CASES: Record<string, string> = {
  'no goal': [row('hello'), row('world')].join('\n') + '\n',
  'active goal last': [row('a'), goal({ met: false }), row('b')].join('\n') + '\n',
  'met goal last wins over an earlier active one': [goal({ met: false }), row('a'), goal({ met: true })].join('\n') + '\n',
  'failed goal last': [goal({ met: false }), goal({ failed: true })].join('\n'),
  'active goal on the first line, no trailing newline': [goal({ met: false }), row('x')].join('\n'),
  'active goal is the only line': goal({ met: false }),
  'unparsable lines and a goal named in text are skipped': [goal({ met: false }), '{"broken": goal_status', row('talks about goal_status'), 'garbage'].join('\n') + '\n',
  'multibyte text around the goal': [row('é\u2014中文 🎯'.repeat(50)), goal({ met: false, note: 'ü→✓' }), row('末尾 \u2013 fin')].join('\n') + '\n',
  'CRLF lines': [row('a'), goal({ met: false }), row('b')].join('\r\n') + '\r\n',
  'a very long line before the goal': [row('L'.repeat(200_000)), goal({ met: false }), row('z'.repeat(70_000))].join('\n') + '\n',
  'empty file': '',
}

for (const fixture of ['goal-status-interactive.jsonl', 'goal-status-stops.jsonl', 'goal-status-stream-json.jsonl']) {
  if (existsSync(join(FIXTURES, fixture))) CASES[`fixture ${fixture}`] = readFileSync(join(FIXTURES, fixture), 'utf8')
}

for (const [name, text] of Object.entries(CASES)) {
  test(`the copy clears a goal exactly as the string rule does: ${name}`, () =>
    withDir(async (dir) => {
      const want = threadLaneTranscript(text)
      for (const chunk of [1, 3, 7, 64, 4096, 1024 * 1024]) {
        const from = join(dir, `main-${chunk}.jsonl`)
        const to = join(dir, `copy-${chunk}.jsonl`)
        writeFileSync(from, text)
        await copyTranscriptClearingGoal(from, to, chunk)
        assert.equal(readFileSync(to, 'utf8'), want, `chunk ${chunk}`)
        assert.equal(readFileSync(from, 'utf8'), text, 'the main transcript is never changed')
        // In place on a fork's own file too.
        const fork = join(dir, `fork-${chunk}.jsonl`)
        writeFileSync(fork, text)
        assert.equal(await clearActiveGoal(fork, chunk), want !== text)
        assert.equal(readFileSync(fork, 'utf8'), want, `in place, chunk ${chunk}`)
        assert.equal(existsSync(`${fork}.thread-goal.tmp`), false, 'no temporary file left')
      }
    }))
}

test('the copy refuses to write over the main transcript itself', () =>
  withDir(async (dir) => {
    const path = join(dir, 'main.jsonl')
    writeFileSync(path, goal({ met: false }))
    await assert.rejects(copyTranscriptClearingGoal(path, path), /main transcript in place/)
    assert.equal(readFileSync(path, 'utf8'), goal({ met: false }))
  }))

test('a large transcript is searched and copied without holding it in memory', () =>
  withDir(async (dir) => {
    // 160 MB of history with the active goal near the start: the whole file is walked.
    const from = join(dir, 'main.jsonl')
    const fd = openSync(from, 'w')
    writeSync(fd, `${goal({ met: false })}\n`)
    const block = `${row('x'.repeat(8_000))}\n`.repeat(200)
    for (let i = 0; i < 100; i++) writeSync(fd, block)
    closeSync(fd)
    globalThis.gc?.()
    const before = process.memoryUsage().rss
    let peak = before
    const sampler = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().rss)
    }, 5)
    try {
      const to = join(dir, 'copy.jsonl')
      await copyTranscriptClearingGoal(from, to)
      peak = Math.max(peak, process.memoryUsage().rss)
      const head = readFileSync(to).subarray(0, 300).toString('utf8')
      assert.match(head, /"sentinel":true/)
    } finally {
      clearInterval(sampler)
    }
    // The string rule needs several times the file (about 4.5 times, measured); this needs about a chunk.
    assert.ok(peak - before < 100 * 1024 * 1024, `memory grew ${Math.round((peak - before) / 1048576)} MB`)
  }))

test('findActiveGoalRow names the exact bytes of the active goal row', () =>
  withDir(async (dir) => {
    const path = join(dir, 't.jsonl')
    const first = `${row('é')}\n`
    writeFileSync(path, `${first}${goal({ met: false })}\n${row('b')}\n`)
    const edit = await findActiveGoalRow(path, 5)
    assert.ok(edit)
    assert.equal(edit.start, Buffer.byteLength(first))
    assert.equal(edit.end, Buffer.byteLength(first) + Buffer.byteLength(goal({ met: false })))
    assert.match(edit.replacement.toString('utf8'), /"met":true,"sentinel":true/)
  }))
