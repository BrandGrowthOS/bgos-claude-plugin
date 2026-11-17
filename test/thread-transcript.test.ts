/**
 * THREADCRASH (0.87.1): the thread's transcript work on disk, in pieces
 * (lib/thread-transcript.ts), gives byte for byte what the one string rule
 * gives (lib/thread-lane-args.ts threadLaneTranscript), at any chunk size, and
 * never holds the transcript in memory.
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, openSync, writeSync, closeSync } from 'node:fs'
import { open } from 'node:fs/promises'
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

/**
 * The bytes the search copies in memory (every Buffer.concat and Buffer.from it
 * makes) while it finds the goal under one long last line, read 1 byte at a time.
 * Work, not wall time: a slow runner cannot make this pass or fail. It sees
 * only those two calls: a rewrite that copies with buf.copy or
 * Uint8Array.set needs the spy widened.
 */
async function bytesCopiedBySearch(dir: string, lineLength: number): Promise<number> {
  const path = join(dir, `long-${lineLength}.jsonl`)
  const head = `${goal({ met: false })}\n`
  writeFileSync(path, `${head}${row('z'.repeat(lineLength))}\n`)
  const { concat, from } = Buffer
  let copied = 0
  Buffer.concat = ((...args: Parameters<typeof concat>) => {
    const out = concat(...args)
    copied += out.length
    return out
  }) as typeof concat
  Buffer.from = ((...args: unknown[]) => {
    const out = (from as (...a: unknown[]) => Buffer)(...args)
    copied += out.length
    return out
  }) as typeof from
  try {
    const edit = await findActiveGoalRow(path, 1)
    assert.ok(edit)
    assert.equal(edit.start, 0)
    assert.equal(edit.end, Buffer.byteLength(head) - 1)
  } finally {
    Buffer.concat = concat
    Buffer.from = from
  }
  return copied
}

test('the search costs in proportion to the line: a line 10 times longer copies about 10 times the bytes, not 100 times', () =>
  withDir(async (dir) => {
    const short = await bytesCopiedBySearch(dir, 2_000)
    const long = await bytesCopiedBySearch(dir, 20_000)
    // Joining the growing line again for every chunk read made this 100 times (2,000 squared against 20,000 squared).
    assert.ok(long / short < 20, `a 10 times longer line copied ${(long / short).toFixed(1)} times the bytes (${short} then ${long})`)
    // And in absolute terms: a few copies of the file, not the line's length times itself.
    assert.ok(long < 4 * 20_100, `a 20,000 byte line copied ${long} bytes`)
  }))

test('clearing the goal copies the bytes around it in as few writes at search chunk 1 as at the default chunk', () =>
  withDir(async (dir) => {
    const text = [row('a'.repeat(20_000)), goal({ met: false }), row('b'.repeat(20_000))].join('\n') + '\n'
    const probe = await open(join(dir, 'probe'), 'w')
    const handle = Object.getPrototypeOf(probe) as { write: (...args: unknown[]) => Promise<unknown> }
    await probe.close()
    const { write } = handle
    let writes = 0
    handle.write = function (this: unknown, ...args: unknown[]) {
      writes++
      return write.apply(this, args)
    }
    const writesAt = async (chunk?: number) => {
      const path = join(dir, `fork-${chunk ?? 'default'}.jsonl`)
      writeFileSync(path, text)
      writes = 0
      assert.equal(await clearActiveGoal(path, chunk), true)
      assert.equal(readFileSync(path, 'utf8'), threadLaneTranscript(text))
      return writes
    }
    try {
      const atDefault = await writesAt()
      const atOne = await writesAt(1)
      // A copy one search chunk at a time wrote each of the 40,000 bytes around the row on its own.
      assert.equal(atOne, atDefault, `${atOne} writes at search chunk 1, ${atDefault} at the default chunk`)
    } finally {
      handle.write = write
    }
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
