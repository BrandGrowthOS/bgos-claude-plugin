/**
 * bin/hoai-hook.mjs: the Claude Code hook forwarder.
 *
 * It runs once per hook event, inside the user's session, on every tool call.
 * The four things it must never do are the four things these tests pin:
 *   1. never exit non zero (exit 2 BLOCKS a tool call on PreToolUse)
 *   2. never read stdin in text mode (a Windows console code page cannot
 *      decode a payload carrying a box glyph, and the hook crashed)
 *   3. never grow the spool without bound
 *   4. never throw, whatever arrives on stdin
 *
 * Stage 7 inverted one of them: the tool response is now read by the mapper,
 * so an oversized payload REDUCES it instead of dropping it. Mutations the two
 * new cases are proven against:
 *   - keep tool_response whole, with no reducer -> the Write case goes red
 *   - keep the HEAD of a reduced response       -> the tail case goes red
 *
 * Run: npx tsx --test test/hoai-hook.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Readable } from 'node:stream'

import {
  KEPT_PAYLOAD_KEYS,
  PAYLOAD_MAX_BYTES,
  REDUCED_OUTPUT_MAX,
  SPOOL_MAX_BYTES,
  SPOOL_ROTATED_NAME,
  appendEvent,
  buildSpoolLine,
  clipPayload,
  main,
  nextLineId,
  parseStdinPayload,
  readStdin,
  reduceToolResponse,
  rotateIfFull,
  safeSessionKey,
  spoolPath,
  stateRoot,
} from '../bin/hoai-hook.mjs'
import { safeSessionKey as libSessionKey, sessionSpoolPath, hookStateRoot } from '../lib/hook-intake.ts'

const ENV = { BGOS_PLUGIN_STATE_DIR: '/state' }
const HOME = '/home/kc'

/** An in memory spool fs with the same four operations the real one has. */
function memSpool(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial))
  const dirs = new Set<string>()
  const calls: string[] = []
  return {
    files,
    dirs,
    calls,
    fs: {
      size: (path: string) => Buffer.byteLength(files.get(path) ?? '', 'utf8'),
      rotate: (path: string) => {
        calls.push(`rotate:${path}`)
        const rotated = path.replace(/[^/\\]+$/, SPOOL_ROTATED_NAME)
        files.set(rotated, files.get(path) ?? '')
        files.delete(path)
      },
      mkdir: (dir: string) => {
        dirs.add(dir)
      },
      append: (path: string, text: string) => {
        files.set(path, (files.get(path) ?? '') + text)
      },
    },
  }
}

const payloadOf = (over: Record<string, unknown> = {}) => ({
  session_id: 'sess-1',
  transcript_path: '/home/kc/.claude/projects/-work/sess-1.jsonl',
  cwd: '/work',
  hook_event_name: 'PreToolUse',
  prompt_id: 'p-1',
  tool_name: 'Bash',
  tool_use_id: 'tu-1',
  tool_input: { command: 'ls -la' },
  ...over,
})

// ── stdin is bytes ───────────────────────────────────────────────────────────

test('stdin is read as BYTES and decoded UTF-8, not through the console code page', async () => {
  // The exact class of payload that crashed a text mode hook on Windows: a
  // multi byte glyph, delivered SPLIT across two chunks so a per chunk decode
  // would produce two replacement characters instead of one character.
  const json = JSON.stringify(payloadOf({ tool_input: { command: 'echo "┌ box ┐"' } }))
  const whole = Buffer.from(json, 'utf8')
  const cut = whole.indexOf(Buffer.from('┌', 'utf8')) + 1
  const stream = Readable.from([whole.subarray(0, cut), whole.subarray(cut)])

  const text = await readStdin(stream)
  assert.equal(text, json, 'the two halves must rejoin as bytes before decoding')
  const parsed = parseStdinPayload(text)
  assert.ok(parsed)
  assert.match(String((parsed as any).tool_input.command), /┌ box ┐/)
})

test('readStdin is bounded: a runaway producer cannot exhaust memory', async () => {
  const stream = Readable.from([Buffer.alloc(64, 0x61), Buffer.alloc(64, 0x62)])
  const text = await readStdin(stream, 100)
  assert.ok(text.length <= 64, `bounded read, got ${text.length}`)
})

test('parseStdinPayload refuses junk rather than throwing', () => {
  assert.equal(parseStdinPayload(''), null)
  assert.equal(parseStdinPayload('   '), null)
  assert.equal(parseStdinPayload('not json'), null)
  assert.equal(parseStdinPayload('[1,2,3]'), null, 'an array is not a hook payload')
  assert.equal(parseStdinPayload('"a string"'), null)
  assert.deepEqual(parseStdinPayload('{"a":1}'), { a: 1 })
})

// ── the line shape ───────────────────────────────────────────────────────────

test('one payload becomes one JSON line carrying a MINTED id, never a measured one', () => {
  const spool = memSpool()
  const path = spoolPath('sess-1', ENV, HOME)

  const first = appendEvent(payloadOf(), { fs: spool.fs, env: ENV, home: HOME, now: 1000 })
  assert.equal(typeof first, 'string')
  assert.ok((first as string).length > 0, 'the line id is returned')

  const second = appendEvent(payloadOf({ hook_event_name: 'PostToolUse' }), {
    fs: spool.fs,
    env: ENV,
    home: HOME,
    now: 1001,
  })
  assert.notEqual(second, first, 'each line gets its own id')

  const written = spool.files.get(path) ?? ''
  const lines = written.trim().split('\n')
  assert.equal(lines.length, 2)
  const parsed = JSON.parse(lines[0]!)
  assert.deepEqual(Object.keys(parsed).sort(), ['event', 'id', 'payload', 'receivedAt'])
  assert.equal(parsed.id, first, 'the id on the line is the id the caller got back')
  assert.equal(parsed.event, 'PreToolUse')
  assert.equal(parsed.receivedAt, 1000)
  assert.equal(parsed.payload.tool_use_id, 'tu-1')
  assert.ok(written.endsWith('\n'), 'every line is newline terminated')
})

test('two forwarders appending at the same instant mint DIFFERENT ids', () => {
  // The defect this replaces: the line identity was the file SIZE each process
  // stat'ed. Two hooks firing on one parallel tool call read the same number,
  // both appended, and the daemon treated the second event as a duplicate of
  // the first and dropped it. A per process tag plus a counter cannot collide.
  const spool = memSpool()
  const sameInstant = { fs: spool.fs, env: ENV, home: HOME, now: 7 }
  const a = appendEvent(payloadOf({ tool_use_id: 'tu-a' }), {
    ...sameInstant,
    lineIdTag: 'procA',
  })
  const b = appendEvent(payloadOf({ tool_use_id: 'tu-b' }), {
    ...sameInstant,
    lineIdTag: 'procB',
  })
  assert.notEqual(a, b, 'two processes, two ids, whatever the file size says')
  const ids = (spool.files.get(spoolPath('sess-1', ENV, HOME)) ?? '')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l).id)
  assert.equal(new Set(ids).size, 2, 'both lines survive with their own identity')
  assert.ok(ids[0]!.startsWith('procA'), 'the id carries the process tag')
  assert.ok(ids[1]!.startsWith('procB'))
})

test('nextLineId counts up inside one process', () => {
  const first = nextLineId('tag')
  const second = nextLineId('tag')
  assert.notEqual(first, second)
  assert.ok(first.startsWith('tag-'))
  assert.ok(
    Number(second.split('-').pop()) > Number(first.split('-').pop()),
    'monotonic within the process, so the order of one hook stream is readable',
  )
})

test('the spool path is derived exactly as the daemon derives it', () => {
  assert.equal(stateRoot(ENV, HOME), hookStateRoot(ENV, HOME))
  assert.equal(stateRoot({}, HOME), hookStateRoot({}, HOME))
  assert.equal(spoolPath('sess-1', ENV, HOME), sessionSpoolPath(stateRoot(ENV, HOME), 'sess-1'))
  for (const id of ['sess-1', '../escape', 'a/b\\c', '', 'x'.repeat(200), '...dots']) {
    assert.equal(safeSessionKey(id), libSessionKey(id), `session key drift for ${JSON.stringify(id)}`)
  }
})

test('a session id can never escape the spool root', () => {
  assert.ok(!safeSessionKey('../../etc').includes('.'), 'no dot survives, so no ".." segment can')
  assert.ok(!safeSessionKey('a/b').includes('/'))
  assert.ok(!safeSessionKey('a\\b').includes('\\'))
  assert.equal(safeSessionKey('   '), 'unknown')
  assert.equal(safeSessionKey('..'), '__')
})

test('a payload with no session id is dropped, not filed under a guess', () => {
  const spool = memSpool()
  assert.equal(appendEvent(payloadOf({ session_id: '' }), { fs: spool.fs, env: ENV, home: HOME }), null)
  assert.equal(spool.files.size, 0)
})

// ── rotation and the payload clip ────────────────────────────────────────────

test('the spool rotates at the cap instead of growing forever', () => {
  const path = spoolPath('sess-1', ENV, HOME)
  const spool = memSpool({ [path]: 'x'.repeat(SPOOL_MAX_BYTES) })

  const id = appendEvent(payloadOf(), { fs: spool.fs, env: ENV, home: HOME, now: 5 })
  assert.ok(typeof id === 'string' && id.length > 0, 'the event still lands after a rotation')
  assert.equal(spool.calls.length, 1, 'rotated exactly once')
  const rotated = path.replace(/[^/\\]+$/, SPOOL_ROTATED_NAME)
  assert.equal((spool.files.get(rotated) ?? '').length, SPOOL_MAX_BYTES, 'the old file is kept aside')
  assert.ok((spool.files.get(path) ?? '').endsWith('\n'))
})

test('rotateIfFull drops the event rather than growing the file when rotation fails', () => {
  const failing = {
    size: () => SPOOL_MAX_BYTES + 1,
    rotate: () => {
      throw new Error('EBUSY: a reader holds the file open')
    },
  }
  assert.equal(rotateIfFull('/state/hooks/s/events.jsonl', failing as never), false)
  const roomy = { size: () => 10, rotate: () => assert.fail('nothing to rotate') }
  assert.equal(rotateIfFull('/state/hooks/s/events.jsonl', roomy as never), true)
})

test('an oversized payload is reduced to the fields the mapper reads, and nothing else', () => {
  const huge = payloadOf({
    tool_name: 'Write',
    tool_input: { file_path: '/work/big.ts', content: 'A'.repeat(PAYLOAD_MAX_BYTES + 10) },
    tool_response: {
      type: 'create',
      filePath: '/work/big.ts',
      content: 'A'.repeat(PAYLOAD_MAX_BYTES + 10),
      structuredPatch: [],
      originalFile: null,
    },
  })
  const clipped = clipPayload(huge) as Record<string, any>
  assert.equal(clipped.hoai_clipped, true)
  assert.equal(clipped.session_id, 'sess-1')
  assert.equal(clipped.tool_name, 'Write')
  assert.equal(clipped.tool_use_id, 'tu-1')
  assert.ok(clipped.tool_input.content.length < 300, 'the file body does not reach the spool')
  assert.equal(clipped.tool_input.file_path, '/work/big.ts')
  // Stage 7 INVERTS the old rule: the tool response is now read, so it survives
  // the clip, reduced. What must not survive is the file body inside it.
  assert.deepEqual(clipped.tool_response.content, { lines: 1 }, 'the body becomes its line count')
  assert.equal(clipped.tool_response.structuredPatch, undefined, 'an empty patch says nothing')
  assert.ok(
    Buffer.byteLength(JSON.stringify(clipped), 'utf8') < PAYLOAD_MAX_BYTES,
    'the reduced payload is under the cap',
  )
  for (const key of Object.keys(clipped)) {
    assert.ok(
      key === 'hoai_clipped' ||
        key === 'tool_input' ||
        key === 'background_tasks' ||
        KEPT_PAYLOAD_KEYS.includes(key),
      `unexpected key survived the clip: ${key}`,
    )
  }
})

test('a payload under the cap passes through byte for byte', () => {
  const small = payloadOf()
  assert.equal(clipPayload(small), small, 'the same object, not a rebuilt copy')
})

test('an oversized Write payload keeps a reduced tool_response with its diff counts', () => {
  const body = 'A'.repeat(PAYLOAD_MAX_BYTES + 10)
  const huge = payloadOf({
    hook_event_name: 'PostToolUse',
    tool_name: 'Write',
    tool_input: { file_path: '/work/big.ts', content: body },
    tool_response: {
      type: 'update',
      filePath: '/work/big.ts',
      content: body,
      originalFile: body,
      userModified: false,
      structuredPatch: [
        {
          oldStart: 1,
          oldLines: 2,
          newStart: 1,
          newLines: 3,
          lines: [' one', '-two', '+TWO', '+three', '\\ No newline at end of file'],
        },
      ],
    },
  })
  const clipped = clipPayload(huge) as Record<string, any>

  assert.deepEqual(
    clipped.tool_response.structuredPatch,
    { linesAdded: 2, linesRemoved: 1 },
    'the hunks become the two counts the row draws',
  )
  assert.deepEqual(clipped.tool_response.content, { lines: 1 }, 'and the body becomes one number')
  assert.equal(clipped.tool_response.originalFile, undefined, 'the OTHER side of the change goes too')
  assert.ok(
    !JSON.stringify(clipped).includes('A'.repeat(500)),
    'a megabyte of file body must never reach the spool',
  )
  assert.ok(Buffer.byteLength(JSON.stringify(clipped), 'utf8') < PAYLOAD_MAX_BYTES)
})

test('a reduced tool_response keeps the TAIL of what the command printed', () => {
  const noisy = payloadOf({
    hook_event_name: 'PostToolUse',
    tool_response: {
      stdout: `HEAD${'x'.repeat(PAYLOAD_MAX_BYTES)}TAIL`,
      stderr: `ERRHEAD${'y'.repeat(PAYLOAD_MAX_BYTES)}ERRTAIL`,
      interrupted: false,
      returnCodeInterpretation: 'No matches found',
    },
  })
  const response = (clipPayload(noisy) as Record<string, any>).tool_response
  assert.equal(response.stdout.length, REDUCED_OUTPUT_MAX)
  assert.ok(response.stdout.endsWith('TAIL'), 'the end of the output is what the owner reads')
  assert.ok(!response.stdout.includes('HEAD'))
  assert.ok(response.stderr.endsWith('ERRTAIL'))
  assert.equal(response.interrupted, false)
  assert.equal(response.returnCodeInterpretation, 'No matches found')

  const failure = payloadOf({
    hook_event_name: 'PostToolUseFailure',
    tool_response: `Exit code 2\nHEAD${'z'.repeat(PAYLOAD_MAX_BYTES)}TAIL`,
    error: 'Exit code 2',
    is_interrupt: false,
  })
  const clipped = clipPayload(failure) as Record<string, any>
  assert.ok(
    clipped.tool_response.startsWith('Exit code 2\n'),
    'the first line carries the code, so it is the one line that cannot be cut',
  )
  assert.ok(clipped.tool_response.endsWith('TAIL'))
  assert.equal(clipped.tool_response.length, 'Exit code 2\n'.length + REDUCED_OUTPUT_MAX)
  assert.equal(clipped.error, 'Exit code 2')
  assert.equal(clipped.is_interrupt, false, 'one boolean, read the same on both paths')
  assert.equal(reduceToolResponse('short'), 'short', 'a small string is itself')
})

test('buildSpoolLine is a single line: an embedded newline can never split a record', () => {
  const line = buildSpoolLine({
    id: 'p1-7',
    receivedAt: 1,
    event: 'Stop',
    payload: { note: 'first\nsecond' },
  })
  assert.equal(line.split('\n').length, 2, 'exactly one newline, the terminator')
  assert.deepEqual(JSON.parse(line).payload, { note: 'first\nsecond' })
})

// ── never non zero, never thrown ─────────────────────────────────────────────

const exitPaths: Array<[string, () => Promise<void>]> = [
  ['empty stdin', () => main({ stdin: Readable.from([]) } as never)],
  ['malformed JSON', () => main({ stdin: Readable.from([Buffer.from('{oops')]) } as never)],
  [
    'no session id',
    () =>
      main({
        stdin: Readable.from([Buffer.from(JSON.stringify({ hook_event_name: 'Stop' }))]),
        fs: memSpool().fs,
        env: ENV,
        home: HOME,
      } as never),
  ],
  [
    'an unwritable spool',
    () =>
      main({
        stdin: Readable.from([Buffer.from(JSON.stringify(payloadOf()))]),
        env: ENV,
        home: HOME,
        fs: {
          size: () => 0,
          rotate: () => {},
          mkdir: () => {
            throw new Error('EACCES')
          },
          append: () => {
            throw new Error('EACCES')
          },
        },
      } as never),
  ],
  [
    'an append that throws',
    () =>
      main({
        stdin: Readable.from([Buffer.from(JSON.stringify(payloadOf()))]),
        env: ENV,
        home: HOME,
        fs: {
          size: () => 0,
          rotate: () => {},
          mkdir: () => {},
          append: () => {
            throw new Error('ENOSPC')
          },
        },
      } as never),
  ],
  [
    'a stdin stream that errors mid read',
    () =>
      main({
        stdin: Readable.from(
          (async function* () {
            yield Buffer.from('{"session_id":')
            throw new Error('EPIPE')
          })(),
        ),
      } as never),
  ],
]

for (const [name, run] of exitPaths) {
  test(`exit code stays 0: ${name}`, async () => {
    process.exitCode = 3
    await run()
    assert.equal(process.exitCode, 0, 'a hook that exits non zero can BLOCK a tool call')
    process.exitCode = 0
  })
}

test('the happy path also writes the spool and still exits 0', async () => {
  const spool = memSpool()
  process.exitCode = 3
  await main({
    stdin: Readable.from([Buffer.from(JSON.stringify(payloadOf()))]),
    fs: spool.fs,
    env: ENV,
    home: HOME,
    now: 42,
  } as never)
  assert.equal(process.exitCode, 0)
  process.exitCode = 0
  const written = spool.files.get(spoolPath('sess-1', ENV, HOME)) ?? ''
  assert.match(written, /"hook_event_name":"PreToolUse"/)
})

test('the forwarder is import safe: importing it writes nothing and exits nothing', () => {
  // Proven by the fact that every test above ran after the import with no
  // spool on disk and no thrown process exit. Pinned explicitly so a future
  // top level side effect is caught here rather than in production.
  const source = readSource()
  assert.match(source, /const invokedDirectly =/)
  assert.match(source, /import\.meta\.url === pathToFileURL\(process\.argv\[1\]\)\.href/)
  assert.ok(!/^\s*void main\(\)/m.test(source.replace(/if \(invokedDirectly\) \{[\s\S]*?\}/, '')),
    'main() runs only behind the argv guard')
})

function readSource(): string {
  return readFileSync(new URL('../bin/hoai-hook.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
}
