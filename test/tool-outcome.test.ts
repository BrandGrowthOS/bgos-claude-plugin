/**
 * What a tool call actually did: the exit code, what it printed, the counts.
 *
 * Every payload below is a REAL one, copied verbatim out of the stage 7 probe
 * (docs/reports/2026-09-21-turn-summary-card/probe/hooks.jsonl in the BGOS
 * repo, one live interactive turn on 2026-09-21) into
 * test/fixtures/stage7-hooks.jsonl with the paths scrubbed. Invented payload
 * shapes are how a mapper ends up passing its tests and reading nothing in the
 * field, which is test/hook-events.test.ts's own standing rule.
 *
 * Mutations these tests are proven against (task C1):
 *   - require the "Error: " prefix          -> the exit code test goes red
 *   - read tool_response on a failure       -> the failure output test red
 *   - add a stderr: line to a failure        -> the same test goes red
 *   - send exitCode 0 on an interpretation  -> the grep test goes red
 *   - Number() the string with no match     -> the NaN test goes red
 *   - reverse stdout and stderr             -> the stderr: order test red
 *   - take the head instead of the tail     -> the seq 1 3000 test goes red
 *   - drop the low surrogate guard          -> the surrogate test goes red
 *   - count the backslash marker as removed -> the Edit test goes red
 *   - count hunks instead of lines          -> the Edit test goes red
 *   - report zero and zero for a create     -> the Write test goes red
 *   - read content with no create gate      -> the empty patch update test red
 *   - skip a hunk line starting +++ or ---  -> the ++i; test goes red
 *   - default a missing count to zero       -> the Read test goes red
 *   - spend the card budget from the FRONT  -> the budget test goes red
 *
 * Run: npx tsx --test test/tool-outcome.test.ts
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'

import {
  clipCardOutput,
  clipOutputTail,
  editCountsFor,
  exitCodeFor,
  interpretationFor,
  outputFor,
} from '../lib/tool-outcome.ts'
import {
  CARD_OUTPUT_BUDGET,
  TOOL_OUTPUT_LINES_MAX,
  TOOL_OUTPUT_MAX,
  type ToolRow,
} from '../lib/hook-events.ts'

interface ProbeRecord {
  hook: string
  payload: Record<string, unknown>
}

const RECORDS: ProbeRecord[] = readFileSync(
  new URL('./fixtures/stage7-hooks.jsonl', import.meta.url),
  'utf8',
)
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line !== '')
  .map((line) => JSON.parse(line) as ProbeRecord)

const isClosing = (record: ProbeRecord): boolean =>
  record.hook === 'PostToolUse' || record.hook === 'PostToolUseFailure'

/** The record that CLOSED the call whose input carries this fragment. */
const closing = (fragment: string): Record<string, unknown> => {
  const record = RECORDS.find(
    (r) => isClosing(r) && JSON.stringify(r.payload.tool_input ?? {}).includes(fragment),
  )
  assert.ok(record, `the probe has no closing record for ${fragment}`)
  return record.payload
}

/** The record that closed the turn's one call to this tool. */
const closingTool = (name: string): Record<string, unknown> => {
  const record = RECORDS.find((r) => isClosing(r) && r.payload.tool_name === name)
  assert.ok(record, `the probe has no closing record for ${name}`)
  return record.payload
}

const EXIT3 = closing('exit 3')
const GREP = closing('grep zzz hay.txt')
const PYTHON = closing('raise SystemExit(1)')
const SEQ = closing('seq 1 3000')
const BOTH_STREAMS = closing('err line 1>&2')
const WRITE_CREATE = closingTool('Write')
const EDIT = closingTool('Edit')
const READ = closingTool('Read')

const responseOf = (payload: Record<string, unknown>): Record<string, unknown> =>
  payload.tool_response as Record<string, unknown>

const bashSuccess = (stdout: string, stderr: string): Record<string, unknown> => ({
  ...SEQ,
  tool_response: {
    stdout,
    stderr,
    interrupted: false,
    isImage: false,
    noOutputExpected: false,
  },
})

const row = (over: Partial<ToolRow> = {}): ToolRow => ({
  icon: '💻',
  name: 'Bash',
  status: 'done',
  ...over,
})

// ── The three exit code arms ─────────────────────────────────────────────────

test('the exit code comes off the error string, with or without the Error: prefix', () => {
  assert.equal(EXIT3.error, 'Exit code 3', 'the live payload carries no prefix')
  assert.equal(exitCodeFor(EXIT3), 3)
  assert.equal(
    exitCodeFor({ ...EXIT3, error: 'Error: Exit code 3' }),
    3,
    "this machine's older transcripts do carry the prefix, so both are read",
  )
  assert.equal(exitCodeFor(PYTHON), 1)
  assert.equal(exitCodeFor(BOTH_STREAMS), 2)
})

test('a benign non zero exit gives NO exit code and hands over its interpretation', () => {
  assert.equal(responseOf(GREP).returnCodeInterpretation, 'No matches found')
  assert.equal(exitCodeFor(GREP), null, 'claiming 0 would be a lie and 1 would be a guess')
  assert.equal(interpretationFor(GREP), 'No matches found')
  assert.equal(outputFor(GREP), '', 'grep printed nothing at all')
  assert.equal(interpretationFor(SEQ), '', 'an ordinary success interprets nothing')
})

test('a plain success is 0, and a failure with no exit code line is nothing at all', () => {
  assert.equal(exitCodeFor(SEQ), 0)
  const blocked = { ...EXIT3, error: 'Blocked: sleep 60 followed by: rm -rf /tmp' }
  assert.equal(exitCodeFor(blocked), null, 'a NaN would draw "exit NaN" on the card')
  assert.equal(
    exitCodeFor({ ...SEQ, tool_response: { ...responseOf(SEQ), interrupted: true } }),
    null,
    'an interrupted command reported no code',
  )
  assert.equal(exitCodeFor({}), null)
  assert.equal(exitCodeFor(null), null)
})

// ── What the command printed ─────────────────────────────────────────────────

test("a failure's output is the error minus its exit code line, with no stderr: line", () => {
  assert.equal(BOTH_STREAMS.error, 'Exit code 2\nout line\nerr line')
  assert.equal(
    outputFor(BOTH_STREAMS),
    'out line\nerr line',
    'the runtime already merged the streams, so a boundary we draw sits in the wrong place',
  )
  assert.ok(!outputFor(BOTH_STREAMS).includes('stderr:'))
  assert.equal(outputFor(EXIT3), '', 'a failure that printed nothing has no output')
  assert.equal(
    outputFor({ ...EXIT3, error: 'Blocked: sleep 60' }),
    'Blocked: sleep 60',
    'nothing is dropped when the first line is not an exit code line',
  )
})

test('a success puts stdout first, then a line reading exactly stderr:, then stderr', () => {
  assert.equal(outputFor(bashSuccess('out line\n', 'err line\n')), 'out line\nstderr:\nerr line')
  assert.equal(outputFor(bashSuccess('', 'err line\n')), 'stderr:\nerr line')
  assert.equal(outputFor(bashSuccess('out line\n', '')), 'out line')
  assert.equal(outputFor(bashSuccess('', '')), '')
})

test('the seq 1 3000 stdout is kept by its TAIL: the end is what the owner is looking at', () => {
  const printed = outputFor(SEQ)
  assert.equal(printed.length, 13892, 'the probe carried the whole 3000 lines inline')
  const tail = clipOutputTail(printed, TOOL_OUTPUT_MAX, TOOL_OUTPUT_LINES_MAX)
  assert.ok(tail.endsWith('3000'), 'the last line the command printed must survive')
  assert.ok(!tail.startsWith('1\n2\n'), 'the head is the museum')
  assert.ok(tail.split('\n').length <= TOOL_OUTPUT_LINES_MAX)
  assert.ok(tail.length <= TOOL_OUTPUT_MAX)
  assert.equal(tail.split('\n')[0], '2801', 'the last 200 lines, exactly')

  const oneLine = 'z'.repeat(3000)
  assert.equal(clipOutputTail(oneLine, TOOL_OUTPUT_MAX, TOOL_OUTPUT_LINES_MAX).length, TOOL_OUTPUT_MAX)
  assert.equal(clipOutputTail('', TOOL_OUTPUT_MAX, TOOL_OUTPUT_LINES_MAX), '')
})

test('the tail clip never leaves a lone low surrogate at the front', () => {
  // 4001 code units, so the cut at 2048 from the END lands on the SECOND half
  // of an emoji. Without the guard that half ships on its own.
  const emoji = `${'🙂'.repeat(2000)}a`
  assert.equal(emoji.length, 4001)
  assert.ok(
    emoji.charCodeAt(emoji.length - TOOL_OUTPUT_MAX) >= 0xdc00,
    'the fixture only proves the guard if the cut really does land mid character',
  )
  const tail = clipOutputTail(emoji, TOOL_OUTPUT_MAX, TOOL_OUTPUT_LINES_MAX)
  assert.ok(tail.length <= TOOL_OUTPUT_MAX)
  const first = tail.charCodeAt(0)
  assert.ok(
    !(first >= 0xdc00 && first <= 0xdfff),
    'a lone half character is refused by the JSONB column, and the whole card with it',
  )
  assert.ok(tail.endsWith('a'))
})

// ── How many lines an edit changed ───────────────────────────────────────────

test("an Edit's hunk lines count one added and one removed, and the marker is not a line", () => {
  const hunks = responseOf(EDIT).structuredPatch as Array<{ lines: string[] }>
  assert.deepEqual(hunks[0]?.lines, [' one', '-two', '+TWO', ' three', '\\ No newline at end of file'])
  assert.deepEqual(editCountsFor(EDIT), { linesAdded: 1, linesRemoved: 1 })
  assert.deepEqual(
    editCountsFor({ tool_response: { structuredPatch: { linesAdded: 9, linesRemoved: 2 } } }),
    { linesAdded: 9, linesRemoved: 2 },
    "the forwarder's reduced pair is read straight through",
  )

  // Two hunks, the shape a Write that UPDATES carries: the answer is the LINES
  // across every hunk, which is why it cannot be the hunk count.
  const twoHunks = {
    tool_response: {
      structuredPatch: [
        { oldStart: 1, oldLines: 3, newStart: 1, newLines: 4, lines: [' one', '-two', '+TWO', '+two and a half'] },
        { oldStart: 20, oldLines: 1, newStart: 21, newLines: 2, lines: [' twenty', '+twenty one'] },
      ],
    },
  }
  assert.deepEqual(editCountsFor(twoHunks), { linesAdded: 3, linesRemoved: 1 })
})

test('a changed line whose own text begins with ++ or -- is still a changed line', () => {
  // A hunk entry is the file's own line with ONE + or - prepended, and it can
  // never be the `+++ a/file` / `--- b/file` header of a unified diff, because
  // structuredPatch has no file headers at all. Skipping those prefixes here
  // only ever ate real content: `++i;` arrives as `+++i;` and `--count;` as
  // `---count;`, and a SQL or YAML edit lost its counts the same way.
  const hunks = {
    tool_response: {
      structuredPatch: [
        {
          oldStart: 1,
          oldLines: 3,
          newStart: 1,
          newLines: 3,
          lines: [' for (;;) {', '---count;', '+++i;', '\\ No newline at end of file'],
        },
      ],
    },
  }
  assert.deepEqual(editCountsFor(hunks), { linesAdded: 1, linesRemoved: 1 })
})

test('a Write that CREATES counts the lines of content, because its patch is empty', () => {
  assert.deepEqual(responseOf(WRITE_CREATE).structuredPatch, [])
  assert.equal(responseOf(WRITE_CREATE).content, 'one\ntwo\nthree')
  assert.deepEqual(editCountsFor(WRITE_CREATE), { linesAdded: 3 })

  const created = (content: string): Record<string, unknown> => ({
    tool_response: { type: 'create', filePath: '/work/a.md', content, structuredPatch: [], originalFile: null },
  })
  assert.deepEqual(editCountsFor(created('one\ntwo\nthree\n')), { linesAdded: 3 }, 'a trailing newline is not a fourth line')
  assert.deepEqual(editCountsFor(created('')), { linesAdded: 0 })
  assert.deepEqual(
    editCountsFor({ tool_response: { type: 'create', content: { lines: 12 } } }),
    { linesAdded: 12 },
    "the forwarder's reduced content is read straight through",
  )
  assert.deepEqual(
    editCountsFor({ tool_response: { content: { lines: 12 } } }),
    {},
    'and it is read under the same gate: one rule, both paths',
  )
})

test('a Write whose patch is empty because NOTHING changed claims no lines', () => {
  // The runtime reports an UPDATE with an empty structuredPatch in three real
  // cases: the content written matched the file on disk, the diff timed out,
  // and the previous content was too large to diff. The last of those carries
  // originalFile null, which is why the gate is the type and not a missing
  // original. Reading content on any of them drew "1 file changed +40" for a
  // turn that changed nothing.
  const body = Array.from({ length: 40 }, (_value, i) => `line ${i}`).join('\n')
  const update = (over: Record<string, unknown>): Record<string, unknown> => ({
    tool_response: { type: 'update', filePath: '/work/a.ts', content: body, structuredPatch: [], ...over },
  })
  assert.deepEqual(editCountsFor(update({ originalFile: body })), {}, 'nothing changed, so nothing is claimed')
  assert.deepEqual(
    editCountsFor(update({ originalFile: null })),
    {},
    'too large to diff is still an update, so a null original is not a create',
  )
  assert.deepEqual(
    editCountsFor({ tool_response: { filePath: '/work/a.ts', content: body, structuredPatch: [] } }),
    {},
    'a response that never says it created anything proves nothing',
  )
})

test('a Read and a response with nothing derivable carry NEITHER count', () => {
  assert.deepEqual(editCountsFor(READ), {}, 'a Read is neither a command nor an edit')
  assert.deepEqual(editCountsFor(GREP), {})
  assert.deepEqual(editCountsFor({ tool_response: { structuredPatch: [] } }), {})
  assert.deepEqual(editCountsFor({}), {})
  assert.deepEqual(editCountsFor(null), {})
})

// ── The per card output budget ───────────────────────────────────────────────

test('clipCardOutput keeps the NEWEST rows output and never drops a row', () => {
  const rows: ToolRow[] = [1, 2, 3, 4, 5].map((n) =>
    row({ name: `Bash${n}`, output: `${n}`.repeat(TOOL_OUTPUT_MAX), exitCode: n - 1 }),
  )
  const kept = clipCardOutput(rows, CARD_OUTPUT_BUDGET)

  assert.equal(kept.length, 5, 'the budget spends output, it never drops a row')
  assert.equal(kept[0]?.output, undefined, 'the oldest output is the one that goes')
  assert.equal(kept[0]?.exitCode, 0, 'and its exit code stays')
  for (const index of [1, 2, 3, 4]) {
    assert.equal(kept[index]?.output?.length, TOOL_OUTPUT_MAX, `row ${index} kept its output`)
  }
  const total = kept.reduce((sum, r) => sum + (r.output?.length ?? 0), 0)
  assert.ok(total <= CARD_OUTPUT_BUDGET, `${total} characters of output rode the PATCH`)

  assert.equal(rows[0]?.output?.length, TOOL_OUTPUT_MAX, 'the rows handed in are never mutated')
  const short = clipCardOutput([row({ output: 'ok' })], CARD_OUTPUT_BUDGET)
  assert.equal(short[0]?.output, 'ok', 'a card under the budget is untouched')
  assert.deepEqual(clipCardOutput([], CARD_OUTPUT_BUDGET), [])
})
