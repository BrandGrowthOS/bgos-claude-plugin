/**
 * The pure hook mapper: rows, pairs, the skip list, subagents, Steps, markers.
 *
 * Every payload below is a REAL one, copied from the stage 4 feasibility gate
 * (docs/reports/2026-09-20-agent-activity-events/probe/ in the BGOS repo:
 * hooks-interactive.jsonl, hooks-headless.jsonl, hooks-compact.jsonl), trimmed
 * only of the scratchpad paths. Invented payload shapes are how a mapper ends
 * up passing its tests and reading nothing in the field.
 *
 * Mutations these tests are proven against (task C1):
 *   - map in_progress to pending  -> the TaskUpdate case goes red
 *   - let the reply tool through  -> the skip case goes red
 *   - a Stop with background tasks emits no marker -> the marker case goes red
 *   - clipToolRows keeps the front rather than the tail -> the clip case red
 * Stage 6 added one line to that ledger:
 *   - emit goal_poll from PostToolUse too -> the "and nothing else" case red
 * Stage 7 added three, on payloads copied from its own probe into
 * test/fixtures/stage7-hooks.jsonl:
 *   - branch on the event name alone      -> the Bash row case goes red
 *   - derive the command fields for EVERY tool -> the Read case goes red
 *   - drop clipCardOutput from cardEffect -> the card budget case goes red
 * Task C2 added the turn's own clock, and six more:
 *   - a PostToolUse card carries a finish -> the "only when the turn is over" case red
 *   - the start reads lastActivityAt      -> the same case goes red
 *   - drop the first PreToolUse fallback  -> the attached mid turn case goes red
 *   - a turn end leaves the start set     -> the "cannot inherit it" case goes red
 *   - a SessionEnd sends no finish        -> the SessionEnd case goes red
 *   - a Stop always emits a done card     -> the "no tools" case goes red
 * Stage 8 gave the Agent tool a child of its own to report on, and added three:
 *   - keep 0.43.0's naming (the type in name, the description in detail)
 *     -> the subagent row case goes red
 *   - leave SubagentStop out of HOOK_EVENT_NAMES -> the parse case goes red
 *   - emit a goal_poll from a child's stop -> the "and nothing else" case red
 * The child row lifecycle itself lives in test/hook-subagent-rows.test.ts, on
 * the payloads of the stage 8 probe.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'

import {
  CARD_OUTPUT_BUDGET,
  COMPACT_DEDUPE_MS,
  HOOK_EVENT_NAMES,
  SKIPPED_TOOLS,
  STEPS_MAX_ROWS,
  STEPS_MAX_TEXT,
  TOOL_ARGS_MAX,
  TOOL_OUTPUT_LINES_MAX,
  TOOL_OUTPUT_MAX,
  TOOL_ROWS_MAX,
  applyHookEventToTurn,
  buildCardText,
  clipToolRows,
  emptyTurn,
  iconForToolName,
  isSkippedTool,
  parseHookEvent,
  pathForTool,
  shortenPath,
  summarizeToolArgs,
  type Effect,
  type HookEvent,
  type ToolRow,
  type TurnState,
} from '../lib/hook-events.ts'

const SESSION = '1d52be32-ee6f-4288-ae3b-361f27f63e00'
const PROMPT = '83084291-a919-4a83-b203-1d9326942469'
const CWD = '/home/karim/work/bgos'
const TRANSCRIPT = `/home/karim/.claude/projects/-home-karim-work-bgos/${SESSION}.jsonl`

const base = (name: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  session_id: SESSION,
  transcript_path: TRANSCRIPT,
  cwd: CWD,
  prompt_id: PROMPT,
  permission_mode: 'bypassPermissions',
  hook_event_name: name,
  ...extra,
})

const parsed = (raw: Record<string, unknown>): HookEvent => {
  const event = parseHookEvent(raw)
  assert.ok(event, `payload should parse: ${JSON.stringify(raw).slice(0, 80)}`)
  return event
}

const feed = (
  state: TurnState,
  raw: Record<string, unknown>,
  now = 1_000,
): { next: TurnState; effects: Effect[] } => applyHookEventToTurn(state, parsed(raw), now)

const cardsOf = (effects: Effect[]): Array<Extract<Effect, { kind: 'tool_card' }>> =>
  effects.filter((e): e is Extract<Effect, { kind: 'tool_card' }> => e.kind === 'tool_card')

const stepsOf = (effects: Effect[]): Array<Extract<Effect, { kind: 'steps' }>> =>
  effects.filter((e): e is Extract<Effect, { kind: 'steps' }> => e.kind === 'steps')

const markersOf = (effects: Effect[]): Array<Extract<Effect, { kind: 'marker' }>> =>
  effects.filter((e): e is Extract<Effect, { kind: 'marker' }> => e.kind === 'marker')

const lastCard = (effects: Effect[]): ToolRow[] => {
  const cards = cardsOf(effects)
  assert.ok(cards.length > 0, 'expected a tool_card effect')
  return cards[cards.length - 1]!.tools
}

/** The stage 7 probe: one live turn on 2026-09-21, copied verbatim out of
 *  docs/reports/2026-09-21-turn-summary-card/probe/hooks.jsonl with the paths
 *  scrubbed. The Pre and the Post of one call share a tool_use_id, so feeding
 *  the pair is feeding the real thing. */
const PROBE = readFileSync(new URL('./fixtures/stage7-hooks.jsonl', import.meta.url), 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line !== '')
  .map((line) => JSON.parse(line) as { hook: string; payload: Record<string, unknown> })

const probeRecord = (
  match: (record: { hook: string; payload: Record<string, unknown> }) => boolean,
  what: string,
): Record<string, unknown> => {
  const record = PROBE.find(match)
  assert.ok(record, `the probe has no ${what}`)
  return record.payload
}

/** The Pre and the Post of the one call whose input carries this fragment. */
const probeCall = (fragment: string): [Record<string, unknown>, Record<string, unknown>] => [
  probeRecord(
    (r) => r.hook === 'PreToolUse' && JSON.stringify(r.payload.tool_input ?? {}).includes(fragment),
    `PreToolUse for ${fragment}`,
  ),
  probeRecord(
    (r) =>
      r.hook.startsWith('PostToolUse') &&
      JSON.stringify(r.payload.tool_input ?? {}).includes(fragment),
    `PostToolUse for ${fragment}`,
  ),
]

/** The Pre and the Post of the turn's one call to this tool. */
const probeToolCall = (name: string): [Record<string, unknown>, Record<string, unknown>] => [
  probeRecord((r) => r.hook === 'PreToolUse' && r.payload.tool_name === name, `PreToolUse for ${name}`),
  probeRecord(
    (r) => r.hook.startsWith('PostToolUse') && r.payload.tool_name === name,
    `PostToolUse for ${name}`,
  ),
]

/** The one row a Pre and Post pair from the probe leaves on the card. */
const probeRow = (pair: [Record<string, unknown>, Record<string, unknown>]): ToolRow => {
  const opened = feed(emptyTurn(), pair[0])
  const closed = feed(opened.next, pair[1])
  const rows = lastCard(closed.effects)
  assert.equal(rows.length, 1, 'the Post closes the row the Pre opened')
  return rows[0]!
}

// ── parseHookEvent ───────────────────────────────────────────────────────────

test('parseHookEvent accepts every payload the gate actually saw', () => {
  const sessionStart = parsed({
    session_id: SESSION,
    transcript_path: TRANSCRIPT,
    cwd: CWD,
    hook_event_name: 'SessionStart',
    source: 'startup',
    model: 'claude-haiku-4-5-20251001',
  })
  assert.equal(sessionStart.name, 'SessionStart')
  assert.equal(sessionStart.promptId, null, 'SessionStart carries no prompt_id')

  const pre = parsed(
    base('PreToolUse', {
      tool_name: 'TaskCreate',
      tool_input: { subject: 'Say hello', description: 'Say hello' },
      tool_use_id: 'toolu_01J72VWJxcDBkP5zXknAx1oT',
    }),
  )
  assert.equal(pre.sessionId, SESSION)
  assert.equal(pre.promptId, PROMPT)
  assert.equal(pre.cwd, CWD)
  assert.equal(pre.transcriptPath, TRANSCRIPT)

  const stop = parsed(
    base('Stop', {
      stop_hook_active: false,
      last_assistant_message: 'done',
      background_tasks: [],
      session_crons: [],
    }),
  )
  assert.equal(stop.name, 'Stop')

  const precompact = parsed(
    base('PreCompact', { trigger: 'manual', custom_instructions: null }),
  )
  assert.equal(precompact.name, 'PreCompact')
})

test('parseHookEvent returns null for junk instead of throwing', () => {
  for (const junk of [null, undefined, 7, 'PostToolUse', [], {}, { hook_event_name: 'Stop' }]) {
    assert.equal(parseHookEvent(junk), null, `should refuse ${JSON.stringify(junk)}`)
  }
  assert.equal(
    parseHookEvent(base('SubagentStart')),
    null,
    'an event this release does not register is refused, not half mapped',
  )
  assert.ok(
    parseHookEvent(base('SubagentStop', { agent_id: 'ae89978c2d1dd91df' })),
    'and the one it does register parses, which is the other half of the rule',
  )
  assert.equal(parseHookEvent({ ...base('Stop'), session_id: '  ' }), null)
})

test('the declared event set is the set the manifest registers', () => {
  const manifest = JSON.parse(
    readFileSync(new URL('../hooks/hooks.json', import.meta.url), 'utf8'),
  ) as { hooks: Record<string, unknown> }
  assert.deepEqual([...HOOK_EVENT_NAMES].sort(), Object.keys(manifest.hooks).sort())
})

// ── Tool rows ────────────────────────────────────────────────────────────────

test('a Pre then Post pair on one tool_use_id is ONE row, running then done', () => {
  const id = 'toolu_pairA'
  const afterPre = feed(emptyTurn(), base('PreToolUse', {
    tool_name: 'Read',
    tool_input: { file_path: `${CWD}/backend/src/main.ts` },
    tool_use_id: id,
  }))
  let rows = lastCard(afterPre.effects)
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.status, 'running')
  assert.equal(rows[0]!.name, 'Read')
  assert.equal(rows[0]!.path, 'backend/src/main.ts', 'the path is relative to the session cwd')
  assert.equal(rows[0]!.icon, '📖')

  const afterPost = feed(afterPre.next, base('PostToolUse', {
    tool_name: 'Read',
    tool_input: { file_path: `${CWD}/backend/src/main.ts` },
    tool_response: { ok: true },
    tool_use_id: id,
    duration_ms: 42,
  }))
  rows = lastCard(afterPost.effects)
  assert.equal(rows.length, 1, 'the Post closes the row the Pre opened, it does not add one')
  assert.equal(rows[0]!.status, 'done')
  assert.equal(rows[0]!.durationMs, 42)
})

test('a PostToolUseFailure marks the row error, an unmatched Post opens a done row', () => {
  const failed = feed(
    feed(emptyTurn(), base('PreToolUse', {
      tool_name: 'Bash',
      tool_input: { command: 'yarn test' },
      tool_use_id: 'toolu_fail',
    })).next,
    base('PostToolUseFailure', {
      tool_name: 'Bash',
      tool_input: { command: 'yarn test' },
      tool_use_id: 'toolu_fail',
      error: 'exit 1',
      error_type: 'tool_error',
    }),
  )
  assert.equal(lastCard(failed.effects)[0]!.status, 'error')

  const orphan = feed(emptyTurn(), base('PostToolUse', {
    tool_name: 'Grep',
    tool_input: { pattern: 'TODO' },
    tool_use_id: 'toolu_orphan',
    duration_ms: 3,
  }))
  const rows = lastCard(orphan.effects)
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.status, 'done', 'a Post with no Pre still tells the owner it happened')
})

test('a repeated Post changes nothing and emits nothing', () => {
  const id = 'toolu_repeat'
  const one = feed(emptyTurn(), base('PostToolUse', {
    tool_name: 'Write',
    tool_input: { file_path: `${CWD}/a.ts` },
    tool_use_id: id,
    duration_ms: 5,
  }))
  const two = feed(one.next, base('PostToolUse', {
    tool_name: 'Write',
    tool_input: { file_path: `${CWD}/a.ts` },
    tool_use_id: id,
    duration_ms: 5,
  }))
  assert.equal(two.effects.length, 0, 'an idempotent repeat must not re-PATCH the card')
  assert.equal(two.next.toolOrder.length, 1)
})

test('the mapper never mutates the state it is handed', () => {
  const state = emptyTurn()
  const snapshot = JSON.stringify({ order: state.toolOrder, turnId: state.turnId })
  feed(state, base('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'x' }))
  assert.equal(JSON.stringify({ order: state.toolOrder, turnId: state.turnId }), snapshot)
  assert.equal(state.tools.size, 0)
})

// ── The skip list ────────────────────────────────────────────────────────────

test("the channel's own tools and the task tools never draw a row", () => {
  for (const name of ['reply', 'mcp__bgos__reply', 'ask_user_input', 'show_component',
    'rename_chat', 'set_status', 'create_mission', 'tick_mini_goal', 'complete_mission',
    'boards_query', 'ToolSearch', 'TaskGet', 'TaskList']) {
    const out = feed(emptyTurn(), base('PreToolUse', {
      tool_name: name,
      tool_input: { text: 'hello' },
      tool_use_id: `toolu_${name}`,
    }))
    assert.equal(out.effects.length, 0, `${name} is plumbing, not work`)
    assert.equal(out.next.toolOrder.length, 0, `${name} left a row behind`)
    assert.equal(isSkippedTool(name), true)
  }
  assert.equal(isSkippedTool('Bash'), false)
  assert.equal(isSkippedTool('Agent'), false)
})

test('every tool this daemon declares is in SKIPPED_TOOLS (drift guard)', () => {
  const server = readFileSync(new URL('../server.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  const boards = readFileSync(new URL('../lib/boards-tools.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  const declared = new Set<string>()
  for (const m of server.matchAll(/^ {6}name: '([a-z][a-z0-9_]*)',$/gm)) declared.add(m[1]!)
  for (const m of boards.matchAll(/^ {4}name: '(boards_[a-z_]+)',$/gm)) declared.add(m[1]!)
  assert.ok(declared.size >= 40, `expected the tool declarations to parse, got ${declared.size}`)
  assert.ok(declared.has('reply') && declared.has('boards_query'), 'the scan found the wrong lines')
  const missing = [...declared].filter((name) => !SKIPPED_TOOLS.includes(name))
  assert.deepEqual(missing, [], 'a new owner facing tool must join SKIPPED_TOOLS or it draws a row')
})

// ── Subagents ────────────────────────────────────────────────────────────────

test('the Agent tool is a subagent row named by subagent_type, with the job in args', () => {
  // Stage 8 moved the description out of `detail` and into `args`, because a
  // helper's `detail` is now what it is doing RIGHT NOW. The full lifecycle,
  // on the real payloads, is test/hook-subagent-rows.test.ts.
  const opened = feed(emptyTurn(), base('PreToolUse', {
    tool_name: 'Agent',
    tool_input: {
      subagent_type: 'code-reviewer',
      description: 'Review the diff on the activity branch',
      prompt: 'long prompt that never reaches the wire',
    },
    tool_use_id: 'toolu_agent',
  }))
  const row = lastCard(opened.effects)[0]!
  assert.equal(row.kind, 'subagent')
  assert.equal(row.name, 'code-reviewer')
  assert.equal(row.args, 'Review the diff on the activity branch')
  assert.equal(row.detail, undefined, 'detail is the running qualifier now, and it has not run yet')
  assert.equal(row.status, 'running')
  assert.equal(row.startedAt, 1_000, 'and the row carries its own start')

  const launched = feed(opened.next, base('PostToolUse', {
    tool_name: 'Agent',
    tool_input: { subagent_type: 'code-reviewer', description: 'Review the diff' },
    tool_response: { isAsync: true, status: 'async_launched', agentId: 'agent-1' },
    tool_use_id: 'toolu_agent',
    duration_ms: 5,
  }))
  const live = lastCard(launched.effects)[0]!
  assert.equal(live.kind, 'subagent', 'the pair keeps the row it opened, it does not retype it')
  assert.equal(live.status, 'running', 'the child is only just starting')
  assert.equal(live.durationMs, undefined, 'and 5 ms is how long the LAUNCH took')
  assert.equal(live.id, 'agent-1')
})

// ── Steps, from the task tools ───────────────────────────────────────────────

test('TaskCreate and TaskUpdate feed the Steps snapshot, never the card', () => {
  let state = emptyTurn()
  const create = (id: string, subject: string, toolUseId: string) =>
    base('PostToolUse', {
      tool_name: 'TaskCreate',
      tool_input: { subject, description: subject },
      tool_response: { task: { id, subject } },
      tool_use_id: toolUseId,
      duration_ms: 7,
    })

  let out = feed(state, create('1', 'Say hello', 'toolu_c1'))
  state = out.next
  assert.equal(cardsOf(out.effects).length, 0, 'a task tool never draws a tool row')
  assert.deepEqual(stepsOf(out.effects)[0]!.steps, [{ text: 'Say hello', status: 'pending' }])

  out = feed(state, create('2', 'Say goodbye', 'toolu_c2'))
  state = out.next
  assert.deepEqual(stepsOf(out.effects)[0]!.steps.map((s) => s.text), ['Say hello', 'Say goodbye'])

  out = feed(state, base('PostToolUse', {
    tool_name: 'TaskUpdate',
    tool_input: { taskId: '1', status: 'in_progress' },
    tool_response: { success: true, taskId: '1', statusChange: { from: 'pending', to: 'in_progress' } },
    tool_use_id: 'toolu_u1',
    duration_ms: 6,
  }))
  state = out.next
  assert.deepEqual(
    stepsOf(out.effects)[0]!.steps,
    [{ text: 'Say hello', status: 'running' }, { text: 'Say goodbye', status: 'pending' }],
    'in_progress is the RUNNING step, not a pending one',
  )

  out = feed(state, base('PostToolUse', {
    tool_name: 'TaskUpdate',
    tool_input: { taskId: '1', status: 'completed' },
    tool_response: { success: true, taskId: '1', statusChange: { from: 'in_progress', to: 'completed' } },
    tool_use_id: 'toolu_u2',
    duration_ms: 9,
  }))
  state = out.next
  assert.equal(stepsOf(out.effects)[0]!.steps[0]!.status, 'done')

  out = feed(state, base('PostToolUse', {
    tool_name: 'TaskUpdate',
    tool_input: { taskId: '2', status: 'deleted' },
    tool_response: { success: true, taskId: '2' },
    tool_use_id: 'toolu_u3',
  }))
  assert.deepEqual(stepsOf(out.effects)[0]!.steps.map((s) => s.text), ['Say hello'])
  assert.equal(stepsOf(out.effects)[0]!.turnId, PROMPT, 'the Steps record is keyed on the turn')
})

test('activeForm wins over the subject, and the step text is clipped to 200', () => {
  const long = 'x'.repeat(400)
  const out = feed(emptyTurn(), base('PostToolUse', {
    tool_name: 'TaskCreate',
    tool_input: { subject: 'short subject', activeForm: long },
    tool_response: { task: { id: '1', subject: 'short subject' } },
    tool_use_id: 'toolu_long',
  }))
  const step = stepsOf(out.effects)[0]!.steps[0]!
  assert.equal(step.text.length, STEPS_MAX_TEXT)
  assert.ok(step.text.startsWith('xxx'), 'activeForm is what the owner reads while it runs')
})

test('the Steps list is clipped to 30 rows', () => {
  let state = emptyTurn()
  for (let i = 1; i <= 40; i++) {
    state = feed(state, base('PostToolUse', {
      tool_name: 'TaskCreate',
      tool_input: { subject: `Task ${i}` },
      tool_response: { task: { id: String(i), subject: `Task ${i}` } },
      tool_use_id: `toolu_t${i}`,
    })).next
  }
  const out = feed(state, base('PostToolUse', {
    tool_name: 'TaskUpdate',
    tool_input: { taskId: '1', status: 'in_progress' },
    tool_response: { success: true, taskId: '1' },
    tool_use_id: 'toolu_last',
  }))
  assert.equal(stepsOf(out.effects)[0]!.steps.length, STEPS_MAX_ROWS)
})

// ── Stop, and the markers ────────────────────────────────────────────────────

test('Stop settles the card, clears the Steps and ends the turn, in that order', () => {
  let state = feed(emptyTurn(), base('PreToolUse', {
    tool_name: 'Bash', tool_input: { command: 'yarn test' }, tool_use_id: 'toolu_s1',
  })).next
  state = feed(state, base('PostToolUse', {
    tool_name: 'TaskCreate',
    tool_input: { subject: 'Ship it' },
    tool_response: { task: { id: '1', subject: 'Ship it' } },
    tool_use_id: 'toolu_s2',
  })).next

  const out = feed(state, base('Stop', {
    stop_hook_active: false,
    last_assistant_message: 'done',
    background_tasks: [],
    session_crons: [],
  }))
  assert.deepEqual(out.effects.map((e) => e.kind), ['tool_card', 'steps', 'goal_poll', 'turn_end'])
  const card = cardsOf(out.effects)[0]!
  assert.equal(card.state, 'done')
  assert.deepEqual(stepsOf(out.effects)[0]!.steps, [], 'the turn end clear is an EMPTY list')
  assert.equal(out.next.toolOrder.length, 0)
  assert.equal(out.next.turnId, null)
})

test('a Stop with background tasks posts the turn_continues marker exactly once', () => {
  const state = feed(emptyTurn(), base('PreToolUse', {
    tool_name: 'Bash', tool_input: { command: 'yarn build' }, tool_use_id: 'toolu_b1',
  })).next
  const out = feed(state, base('Stop', {
    stop_hook_active: false,
    last_assistant_message: 'building in the background',
    background_tasks: [{ id: 'bg1', description: 'yarn build --watch keeps running' }],
    session_crons: [],
  }))
  const markers = markersOf(out.effects)
  assert.equal(markers.length, 1)
  assert.equal(markers[0]!.markerKind, 'turn_continues')
  assert.equal(markers[0]!.payload.kind, 'turn_continues')
  assert.equal(markers[0]!.payload.what, 'yarn build --watch keeps running')
  assert.ok(markers[0]!.text.includes('yarn build'), 'an old client reads the text, not the payload')
  assert.equal(out.effects[out.effects.length - 1]!.kind, 'turn_end')
})

test('an empty background_tasks list posts no marker', () => {
  const out = feed(emptyTurn(), base('Stop', { background_tasks: [], session_crons: [] }))
  assert.equal(markersOf(out.effects).length, 0)
})

test('one compaction is one marker, whichever hooks report it', () => {
  const pre = feed(emptyTurn(), base('PreCompact', { trigger: 'manual', custom_instructions: null }), 10_000)
  const markers = markersOf(pre.effects)
  assert.equal(markers.length, 1)
  assert.equal(markers[0]!.markerKind, 'context_compacted')
  assert.equal(markers[0]!.payload.kind, 'context_compacted')
  assert.equal(markers[0]!.payload.reason, 'manual /compact')

  const restart = feed(pre.next, base('SessionStart', { source: 'compact' }), 10_500)
  assert.equal(markersOf(restart.effects).length, 0, 'the compact SessionStart confirms, it does not repeat')

  const post = feed(restart.next, base('PostCompact', {
    trigger: 'manual',
    compact_summary: 'a long summary that must never leave the machine',
  }), 11_000)
  assert.equal(markersOf(post.effects).length, 0)

  const later = feed(post.next, base('PreCompact', { trigger: 'auto' }), 11_000 + COMPACT_DEDUPE_MS + 1)
  assert.equal(markersOf(later.effects).length, 1, 'a second, real compaction marks again')
  assert.equal(markersOf(later.effects)[0]!.payload.reason, 'the context filled up')
})

test('the compaction summary never reaches the wire', () => {
  const summary = 'SECRET-SUMMARY-BODY that belongs to the session alone'
  const out = feed(emptyTurn(), base('PostCompact', { trigger: 'auto', compact_summary: summary }), 5)
  const marker = markersOf(out.effects)[0]!
  assert.ok(!JSON.stringify(marker).includes('SECRET-SUMMARY-BODY'))
})

test('a compact SessionStart on its own still marks, and a plain one resets the turn', () => {
  const alone = feed(emptyTurn(), base('SessionStart', { source: 'compact' }), 1)
  assert.equal(markersOf(alone.effects).length, 1, 'PreCompact can be blocked; the marker still lands')

  const withRow = feed(emptyTurn(), base('PreToolUse', {
    tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'toolu_r',
  })).next
  const restarted = feed(withRow, base('SessionStart', { source: 'startup' }))
  assert.equal(restarted.next.toolOrder.length, 0)
  assert.deepEqual(
    restarted.effects.map((e) => e.kind),
    ['goal_poll'],
    'a resume re reads the goal and does nothing else',
  )
})

test('goal_poll is emitted on Stop and on SessionStart, and on nothing else', () => {
  // The verdict is in NO hook payload: the Stop input schema carries
  // hook_event_name, stop_hook_active, last_assistant_message, background_tasks
  // and session_crons and nothing else, and the goal checker runs as a SECOND
  // hook in the same Stop batch. So the mapper decides nothing about the goal.
  // It only says "now is a moment when a verdict may exist", and the shell goes
  // and reads the session transcript, which is the only place a verdict is.
  const payloads: Record<string, Record<string, unknown>> = {
    SessionStart: base('SessionStart', { source: 'startup' }),
    UserPromptSubmit: base('UserPromptSubmit', { prompt: 'keep going' }),
    PreToolUse: base('PreToolUse', {
      tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'toolu_g1',
    }),
    PostToolUse: base('PostToolUse', {
      tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: { ok: true }, tool_use_id: 'toolu_g1',
    }),
    PostToolUseFailure: base('PostToolUseFailure', {
      tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'toolu_g2',
    }),
    Stop: base('Stop', { stop_hook_active: false, background_tasks: [], session_crons: [] }),
    PreCompact: base('PreCompact', { trigger: 'manual', custom_instructions: null }),
    PostCompact: base('PostCompact', { trigger: 'manual' }),
    SessionEnd: base('SessionEnd', { reason: 'clear' }),
    SubagentStop: base('SubagentStop', {
      agent_id: 'ae89978c2d1dd91df',
      agent_type: 'general-purpose',
      last_assistant_message: '3',
    }),
  }
  assert.deepEqual(
    Object.keys(payloads).sort(),
    [...HOOK_EVENT_NAMES].sort(),
    'every registered event is exercised, so a new one cannot quietly start polling',
  )

  const polled: string[] = []
  for (const [name, payload] of Object.entries(payloads)) {
    if (feed(emptyTurn(), payload).effects.some((e) => e.kind === 'goal_poll')) polled.push(name)
  }
  assert.deepEqual(polled.sort(), ['SessionStart', 'Stop'])

  // A compact SessionStart is a resume too, so it re reads as well.
  const compacted = feed(emptyTurn(), base('SessionStart', { source: 'compact' }))
  assert.ok(compacted.effects.some((e) => e.kind === 'goal_poll'))

  const stop = feed(emptyTurn(), payloads.Stop!)
  assert.equal(
    stop.effects.filter((e) => e.kind === 'goal_poll').length,
    1,
    'one wake per Stop, not one per row',
  )
})

// ── Stage 7: what the call did ───────────────────────────────────────────────

test('a Bash row carries what the command printed and its exit code', () => {
  const failed = probeRow(probeCall('exit 3'))
  assert.equal(failed.status, 'error')
  assert.equal(failed.exitCode, 3)
  assert.equal(failed.output, undefined, 'exit 3 printed nothing, so there is nothing to open')
  assert.equal(failed.durationMs, 310, 'a failure carries a duration too')

  const printed = probeRow(probeCall('err line 1>&2'))
  assert.equal(printed.exitCode, 2)
  assert.equal(printed.output, 'out line\nerr line', 'the runtime merged the streams already')

  const big = probeRow(probeCall('seq 1 3000'))
  assert.equal(big.exitCode, 0)
  assert.ok(big.output!.endsWith('3000'), 'the TAIL of 3000 lines is what survives')
  assert.ok(big.output!.length <= TOOL_OUTPUT_MAX)
  assert.ok(big.output!.split('\n').length <= TOOL_OUTPUT_LINES_MAX)

  const quiet = probeRow(probeCall('grep zzz hay.txt'))
  assert.equal(quiet.exitCode, undefined, 'grep exited 1 and the payload says no code at all')
  assert.equal(quiet.detail, 'No matches found', 'the runtime\'s own reading goes to the qualifier')
  assert.equal(quiet.output, undefined, 'it printed nothing')
})

test('an edit row carries its counts, and a Read row carries nothing new at all', () => {
  const created = probeRow(probeToolCall('Write'))
  assert.equal(created.linesAdded, 3, 'a create has no patch, so the content is the addition')
  assert.equal(created.linesRemoved, undefined, 'a create removes nothing')
  assert.equal(created.output, undefined)
  assert.equal(created.exitCode, undefined, 'an edit is not a command')

  const edited = probeRow(probeToolCall('Edit'))
  assert.equal(edited.linesAdded, 1)
  assert.equal(edited.linesRemoved, 1)

  const seen = probeRow(probeToolCall('Read'))
  assert.equal(seen.linesAdded, undefined)
  assert.equal(seen.linesRemoved, undefined)
  assert.equal(seen.output, undefined)
  assert.equal(seen.exitCode, undefined, 'a Read draws exactly as it did yesterday')
})

test('the card output budget drops the OLDEST outputs and keeps the newest rows', () => {
  let state = emptyTurn()
  let rows: ToolRow[] = []
  for (let n = 1; n <= 5; n++) {
    const id = `toolu_out${n}`
    const command = `echo ${n}`
    state = feed(state, base('PreToolUse', {
      tool_name: 'Bash',
      tool_input: { command },
      tool_use_id: id,
    })).next
    const closed = feed(state, base('PostToolUse', {
      tool_name: 'Bash',
      tool_input: { command },
      tool_use_id: id,
      duration_ms: 5,
      tool_response: {
        stdout: `${n} `.repeat(TOOL_OUTPUT_MAX),
        stderr: '',
        interrupted: false,
      },
    }))
    state = closed.next
    rows = lastCard(closed.effects)
  }

  assert.equal(rows.length, 5, 'the budget spends output, it never drops a row')
  assert.equal(rows[0]!.output, undefined, 'the oldest output is the one that goes')
  assert.equal(rows[0]!.exitCode, 0, 'and its exit code stays')
  for (const index of [1, 2, 3, 4]) {
    assert.equal(rows[index]!.output?.length, TOOL_OUTPUT_MAX, `row ${index} kept its output`)
  }
  const total = rows.reduce((sum, row) => sum + (row.output?.length ?? 0), 0)
  assert.ok(total <= CARD_OUTPUT_BUDGET, `${total} characters of output rode the PATCH`)
})

// ── The turn's own clock (stage 7, task C2) ──────────────────────────────────

test('the card carries the turn start, and a finish only when the turn is over', () => {
  const prompt = feed(emptyTurn(), base('UserPromptSubmit', { prompt: 'run the tests' }), 1_000)
  assert.equal(prompt.next.startedAt, 1_000, 'the prompt opens the turn')

  const opened = feed(prompt.next, base('PreToolUse', {
    tool_name: 'Bash', tool_input: { command: 'yarn test' }, tool_use_id: 'toolu_c1',
  }), 2_000)
  const running = cardsOf(opened.effects)[0]!
  assert.equal(running.state, 'running')
  assert.equal(running.startedAt, 1_000, 'the running card already knows when the turn began')
  assert.equal(running.finishedAt, undefined, 'a turn that is still running has no finish')

  const closed = feed(opened.next, base('PostToolUse', {
    tool_name: 'Bash',
    tool_input: { command: 'yarn test' },
    tool_use_id: 'toolu_c1',
    duration_ms: 12,
    tool_response: { stdout: 'ok', stderr: '', interrupted: false },
  }), 3_000)
  assert.equal(cardsOf(closed.effects)[0]!.finishedAt, undefined, 'a closed ROW is not a closed TURN')

  const stopped = feed(closed.next, base('Stop', {
    stop_hook_active: false, background_tasks: [], session_crons: [],
  }), 5_000)
  const done = cardsOf(stopped.effects)[0]!
  assert.equal(done.state, 'done')
  assert.equal(done.startedAt, 1_000, 'the start is the prompt receipt, never the Stop')
  assert.equal(done.finishedAt, 5_000, 'and the finish is the Stop receipt')
})

test('a turn that opened with a tool takes that first PreToolUse as its start', () => {
  // The daemon attached mid turn, so no UserPromptSubmit ever opened it. The
  // start is still a moment the runtime reported, never a message timestamp.
  const opened = feed(emptyTurn(), base('PreToolUse', {
    tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'toolu_c2',
  }), 7_000)
  assert.equal(opened.next.startedAt, 7_000)
  assert.equal(cardsOf(opened.effects)[0]!.startedAt, 7_000)
})

test('a SessionStart opens no clock: the card dates the TURN, not the session', () => {
  // The moment a session opened is not a moment any turn started. While
  // SessionStart set the clock, a daemon that attached at boot and saw its
  // first tool fifteen minutes later drew "Worked 15 min" for a turn that took
  // seconds, and the PreToolUse fallback below could never run for the first
  // turn of a session that had no prompt hook. The two sources are the prompt
  // receipt and the first tool of the turn.
  const started = feed(emptyTurn(), base('SessionStart', { source: 'startup' }), 1_000)
  assert.equal(started.next.startedAt, 0, 'a session opening is not a turn opening')

  const opened = feed(started.next, base('PreToolUse', {
    tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'toolu_c5',
  }), 901_000)
  assert.equal(opened.next.startedAt, 901_000)
  assert.equal(
    cardsOf(opened.effects)[0]!.startedAt,
    901_000,
    'the start is the first tool of the turn, not the fifteen minutes before it',
  )
})

test('a turn end clears the start, so the next turn cannot inherit it', () => {
  // Without this a turn the owner pushed from their phone (no prompt hook of
  // its own) would report the minutes since the LAST typed prompt.
  const prompt = feed(emptyTurn(), base('UserPromptSubmit', { prompt: 'first' }), 1_000)
  const stopped = feed(prompt.next, base('Stop', {
    stop_hook_active: false, background_tasks: [], session_crons: [],
  }), 5_000)
  assert.equal(stopped.next.startedAt, 0, 'the clock is the TURN\'s, not the session\'s')

  const next = feed(stopped.next, base('PreToolUse', {
    tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'toolu_c3',
  }), 900_000)
  assert.equal(cardsOf(next.effects)[0]!.startedAt, 900_000, 'the new turn starts when it started')
})

test('a SessionEnd settles the card with the same two numbers', () => {
  const prompt = feed(emptyTurn(), base('UserPromptSubmit', { prompt: 'go' }), 1_000)
  const opened = feed(prompt.next, base('PreToolUse', {
    tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'toolu_c4',
  }), 2_000)
  const ended = feed(opened.next, base('SessionEnd', { reason: 'exit' }), 4_000)
  const done = cardsOf(ended.effects)[0]!
  assert.equal(done.state, 'done')
  assert.equal(done.startedAt, 1_000)
  assert.equal(done.finishedAt, 4_000)
})

test('a turn with no tools emits no done card, so it carries no clock either', () => {
  const prompt = feed(emptyTurn(), base('UserPromptSubmit', { prompt: 'just answer me' }), 1_000)
  const stopped = feed(prompt.next, base('Stop', {
    stop_hook_active: false, background_tasks: [], session_crons: [],
  }), 5_000)
  assert.equal(cardsOf(stopped.effects).length, 0, 'no tools ran, so there is no card to date')
})

// ── The card text, the clip, the icons ───────────────────────────────────────

test('buildCardText is byte identical to the Codex summary', () => {
  const row = (name: string): ToolRow => ({ icon: '🔧', name, status: 'done' })
  assert.equal(buildCardText([], false), 'Working…')
  assert.equal(buildCardText([], true), 'No tools used')
  assert.equal(buildCardText([row('Bash')], false), 'Working… · Bash')
  assert.equal(buildCardText([row('Bash')], true), 'Used 1 tool · Bash')
  assert.equal(
    buildCardText(['a', 'b', 'c', 'd', 'e', 'f'].map(row), true),
    'Used 6 tools · a, b, c, d, +2 more',
  )
})

test('the 50 row cap drops from the FRONT: the end is what the owner is looking at', () => {
  const rows: ToolRow[] = Array.from({ length: 120 }, (_v, i) => ({
    icon: '🔧',
    name: `tool${i}`,
    status: 'done',
  }))
  const clipped = clipToolRows(rows)
  assert.equal(clipped.length, TOOL_ROWS_MAX)
  assert.equal(clipped[0]!.name, 'earlier')
  assert.equal(clipped[0]!.args, '71 earlier tools not shown')
  assert.equal(clipped[1]!.name, 'tool71', 'the kept window starts where the dropped block ends')
  assert.equal(clipped[clipped.length - 1]!.name, 'tool119', 'the NEWEST row must survive the clip')
  assert.equal(clipToolRows(rows.slice(0, 50)).length, 50)
  assert.equal(clipToolRows(rows.slice(0, 3))[0]!.name, 'tool0', 'a short list is untouched')
})

test('iconForToolName carries the Codex vocabulary over unchanged', () => {
  assert.equal(iconForToolName('Bash'), '💻')
  assert.equal(iconForToolName('Read'), '📖')
  assert.equal(iconForToolName('Edit'), '📝')
  assert.equal(iconForToolName('Write'), '📝')
  assert.equal(iconForToolName('Grep'), '🔎')
  assert.equal(iconForToolName('Glob'), '📂')
  assert.equal(iconForToolName('WebFetch'), '🔧')
})

// ── Arguments and paths ──────────────────────────────────────────────────────

test('args are clipped to 120 without leaving a lone surrogate at the cut', () => {
  const long = `echo ${'a'.repeat(200)}`
  const args = summarizeToolArgs('Bash', { command: long }, CWD)
  assert.equal(args.length, TOOL_ARGS_MAX)
  assert.ok(args.endsWith('…'))

  const emoji = `echo ${'🙂'.repeat(200)}`
  const clipped = summarizeToolArgs('Bash', { command: emoji }, CWD)
  assert.ok(clipped.length <= TOOL_ARGS_MAX)
  const last = clipped.charCodeAt(clipped.length - 2)
  assert.ok(!(last >= 0xd800 && last <= 0xdbff), 'a lone high surrogate was left at the cut')
})

test('paths are relative to the cwd, or a basename plus one parent', () => {
  assert.equal(shortenPath(`${CWD}/frontend/expo-app/app.json`, CWD), 'frontend/expo-app/app.json')
  assert.equal(shortenPath('/home/someone/.ssh/config', CWD), '.ssh/config', 'no home directory, no username')
  assert.equal(shortenPath('C:\\Users\\kc\\work\\repo\\a.ts', 'C:\\Users\\kc\\work\\repo'), 'a.ts')
  assert.deepEqual(pathForTool('Grep', { pattern: 'TODO' }, CWD), {}, 'no path field, no path')
  assert.equal(pathForTool('NotebookEdit', { notebook_path: `${CWD}/nb.ipynb` }, CWD).path, 'nb.ipynb')
  const many = pathForTool('Read', { file_paths: [`${CWD}/a.ts`, `${CWD}/b.ts`, `${CWD}/c.ts`] }, CWD)
  assert.equal(many.path, 'a.ts')
  assert.equal(many.pathCount, 3)
})
