/**
 * A turn's helpers: the child agents an agent spawns, as rows on its own card
 * (stage 8 of the BGOS Mission program, task C1).
 *
 * Every payload below is REAL. They come out of the stage 8 feasibility gate,
 * one live interactive turn on 2026-09-21 that spawned two general purpose
 * subagents in parallel, and they are copied into
 * test/fixtures/stage8-hooks.jsonl with the scratchpad paths scrubbed. Four of
 * them (the two SubagentStart payloads and the two Agent launch responses)
 * survived only in the raw driver log, because they interleaved with a
 * concurrent write and did not parse into the probe's own table; they are in
 * the fixture too, in the order the wire really had them. Invented payload
 * shapes are how a mapper ends up passing its tests and reading nothing in the
 * field, which is test/hook-events.test.ts's own standing rule.
 *
 * Mutations these tests are proven against (task C1):
 *   - close the row on the launch response   -> the still running case goes red
 *   - write the launch's 5 ms duration_ms    -> the same case goes red
 *   - branch the launch detection on the tool name -> the plain response case red
 *   - drop the child's ordinary tool rows    -> the "still draws its own row" case red
 *   - act on every SubagentStop              -> the suggestion generator case red
 *   - let a child's task tool reach Steps     -> the parent's Steps case goes red
 *   - read the task notification's duration  -> the receipt difference case red
 *   - clear carried on a prompt submit        -> the late stop case goes red
 *   - drop the running child exemption        -> the 50 row cap case goes red
 *   - send an over long agent id as the row id -> the wire cap case goes red
 *
 * And the mutations of the fix batch that followed the review:
 *   - mint the carried key from the turn's own key -> the two keys case red
 *   - hold one carried card at a time          -> the two cards case goes red
 *   - a constant fallback card key             -> the two anonymous turns red
 *   - leave a card open at a new prompt        -> the settle case goes red
 *
 * And the mutation of the orchestrator decision that followed that batch, that
 * one delegating turn is ONE card:
 *   - route a child's post Stop tools to a live -> the whole sequence case,
 *     card again                                   and both halves of it, red
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'

import {
  CARRIED_CARDS_MAX,
  TOOL_ROWS_MAX,
  applyHookEventToTurn,
  clipToolRows,
  emptyTurn,
  parseHookEvent,
  type CarriedCard,
  type Effect,
  type ToolRow,
  type TurnState,
} from '../lib/hook-events.ts'

const PROBE = readFileSync(new URL('./fixtures/stage8-hooks.jsonl', import.meta.url), 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line !== '')
  .map((line) => JSON.parse(line) as { hook: string; payload: Record<string, unknown> })

const pick = (
  match: (record: { hook: string; payload: Record<string, unknown> }) => boolean,
  what: string,
): Record<string, unknown> => {
  const record = PROBE.find(match)
  assert.ok(record, `the probe has no ${what}`)
  return record.payload
}

const pickAll = (
  match: (record: { hook: string; payload: Record<string, unknown> }) => boolean,
): Array<Record<string, unknown>> => PROBE.filter(match).map((record) => record.payload)

/** The two children, by the ids the launch responses minted. */
const CHILD_A = 'ae89978c2d1dd91df'
const CHILD_B = 'a4d889afb590641fd'

const agentCall = (child: string) => {
  const launch = pick(
    (r) =>
      r.hook === 'PostToolUse' &&
      r.payload.tool_name === 'Agent' &&
      ((r.payload.tool_response as Record<string, unknown>)?.agentId ?? '') === child,
    `an Agent launch response for ${child}`,
  )
  const opened = pick(
    (r) =>
      r.hook === 'PreToolUse' &&
      r.payload.tool_name === 'Agent' &&
      r.payload.tool_use_id === launch.tool_use_id,
    `the Agent PreToolUse for ${child}`,
  )
  return { opened, launch }
}

const childTool = (hook: string, child: string) =>
  pick(
    (r) => r.hook === hook && r.payload.agent_id === child && r.payload.tool_name === 'Bash',
    `a ${hook} for ${child}`,
  )

const stopFor = (child: string) =>
  pick((r) => r.hook === 'SubagentStop' && r.payload.agent_id === child, `a stop for ${child}`)

/** The composer's suggestion generator: two per turn, agent_type empty, and one
 *  of them with no last_assistant_message key at all. */
const SUGGESTION_STOPS = pickAll((r) => r.hook === 'SubagentStop' && r.payload.agent_type === '')

const PARENT_STOP = pick(
  (r) => r.hook === 'Stop' && r.payload.last_assistant_message === 'Waiting for the agents to complete...',
  'the parent Stop that waited for its children',
)

const NOTIFICATION = pick(
  (r) => r.hook === 'UserPromptSubmit' && String(r.payload.prompt ?? '').includes('<task-notification>'),
  'a task notification prompt',
)

/** The OTHER child's completion notification. Two arrived in a row on the
 *  probe, which is what lets the case below interrupt a turn with a real
 *  payload rather than an invented one. */
const NOTIFICATION_B = pick(
  (r) =>
    r.hook === 'UserPromptSubmit' &&
    String(r.payload.prompt ?? '').includes('<task-notification>') &&
    r.payload.prompt_id !== NOTIFICATION.prompt_id,
  'a second task notification prompt',
)

/** The parent's OWN Bash, the one it ran after its children reported: no
 *  agent_id on it at all, which is how a parent's work is told from a
 *  child's. */
const PARENT_TOOL = pick(
  (r) => r.hook === 'PreToolUse' && r.payload.tool_name === 'Bash' && r.payload.agent_id === undefined,
  "the parent's own Bash",
)

const SESSION_END = pick((r) => r.hook === 'SessionEnd', 'a SessionEnd')

const feed = (
  state: TurnState,
  raw: Record<string, unknown>,
  now: number,
): { next: TurnState; effects: Effect[] } => {
  const event = parseHookEvent(raw)
  assert.ok(event, `payload should parse: ${String(raw.hook_event_name)}`)
  return applyHookEventToTurn(state, event, now)
}

const cardsOf = (effects: Effect[]): Array<Extract<Effect, { kind: 'tool_card' }>> =>
  effects.filter((e): e is Extract<Effect, { kind: 'tool_card' }> => e.kind === 'tool_card')

const lastCardOf = (effects: Effect[]): Extract<Effect, { kind: 'tool_card' }> => {
  const cards = cardsOf(effects)
  assert.ok(cards.length > 0, 'expected a tool_card effect')
  return cards[cards.length - 1]!
}

const helperRow = (rows: ToolRow[]): ToolRow => {
  const row = rows.find((r) => r.kind === 'subagent')
  assert.ok(row, 'expected a helper row on the card')
  return row
}

/** Every card the turns of this state left behind for a working child, in the
 *  order they were left. */
const carriedOf = (state: TurnState): CarriedCard[] => [...state.carried.values()]

/** The ONE card this state is holding, so a case about a single carried card
 *  cannot quietly pass while a second one is there. */
const theCarried = (state: TurnState): CarriedCard => {
  const cards = carriedOf(state)
  assert.equal(cards.length, 1, 'expected exactly one carried card')
  return cards[0]!
}

/** The launch and its response, fed into a turn that is already open. */
const launchInto = (state: TurnState, child: string, openedAt: number, respondedAt: number) => {
  const call = agentCall(child)
  const opened = feed(state, call.opened, openedAt)
  const responded = feed(opened.next, call.launch, respondedAt)
  return { call, opened, responded }
}

/** The prompt, the launch and the launch response: the state every case below
 *  starts from, with the child's row open and linked to its agent id. */
const launched = (child: string, openedAt: number, respondedAt: number) => {
  const prompt = feed(emptyTurn(), pick((r) => r.hook === 'UserPromptSubmit' && !String(r.payload.prompt ?? '').includes('<task-notification>'), 'the owner prompt'), openedAt - 1)
  return launchInto(prompt.next, child, openedAt, respondedAt)
}

// ── The launch ───────────────────────────────────────────────────────────────

test('the Agent PreToolUse opens a helper row named by the kind of child it is', () => {
  const { opened } = launched(CHILD_A, 1_000, 1_005)
  const row = helperRow(lastCardOf(opened.effects).tools)
  assert.equal(row.kind, 'subagent')
  assert.equal(row.name, 'general-purpose', 'the row is named by the subagent_type')
  assert.equal(row.args, 'Run wc -l on hay.txt', 'and the one line description is its args')
  assert.equal(row.detail, undefined, 'detail is free for the qualifier the child fills in')
  assert.equal(row.status, 'running')
  assert.equal(row.startedAt, 1_000, "the row's own start is the receipt of the line that opened it")
  assert.equal(row.result, undefined)
})

test('the launch response leaves the row RUNNING and writes no duration', () => {
  // The real numbers: this response arrived 5 ms after the call, and the child
  // it started ran for 4612 ms. A mapper that closes the row here reports a
  // five millisecond helper.
  const { call, responded } = launched(CHILD_A, 1_000, 1_005)
  assert.equal(call.launch.duration_ms, 5, 'the fixture must really carry the launch duration')
  const row = helperRow(lastCardOf(responded.effects).tools)
  assert.equal(row.status, 'running')
  assert.equal(row.durationMs, undefined, 'a launch is not a finish')
  assert.equal(row.id, CHILD_A, "the row takes the child's own id from the response")
  assert.equal(
    responded.next.agentRows.get(CHILD_A),
    call.launch.tool_use_id,
    'and the link every later child event resolves through is recorded',
  )
})

test('an agent id too long for the wire is dropped, and the row is still linked', () => {
  // The wire caps a row id at 64 characters and the backend refuses the WHOLE
  // card over a field longer than that, so one strange id would cost the owner
  // every row on it. Half an identity is no use either, so it is dropped rather
  // than cut, and the link this daemon resolves through is unaffected.
  const { call, opened } = launched(CHILD_A, 1_000, 1_005)
  const long = 'z'.repeat(100)
  const wide = {
    ...call.launch,
    tool_response: { ...(call.launch.tool_response as Record<string, unknown>), agentId: long },
  }
  const responded = feed(opened.next, wide, 1_005)
  assert.equal(cardsOf(responded.effects).length, 0, 'and nothing on the wire changed, so nothing repaints')
  const row = helperRow([...responded.next.tools.values()])
  assert.equal(row.id, undefined, 'nothing is sent that the card would be refused for')
  assert.equal(row.status, 'running')
  assert.equal(responded.next.agentRows.get(long), call.launch.tool_use_id)

  const stopped = feed(responded.next, { ...stopFor(CHILD_A), agent_id: long }, 9_000)
  assert.equal(helperRow(lastCardOf(stopped.effects).tools).status, 'done')
})

test('an Agent response that is NOT an async launch closes its row exactly as before', () => {
  // The launch is detected off the RESPONSE, never off the tool name: an Agent
  // call that really did answer is a finished call and must keep the shipped
  // behaviour. The envelope is the real one; only the response is replaced,
  // because the gate's turn contained no synchronous Agent call.
  const { call, opened } = launched(CHILD_A, 1_000, 1_005)
  const plain = { ...call.launch, tool_response: { content: 'the child answered here' } }
  const closed = feed(opened.next, plain, 4_000)
  const row = helperRow(lastCardOf(closed.effects).tools)
  assert.equal(row.status, 'done')
  assert.equal(row.durationMs, 5, 'a finished call keeps the duration the runtime reported')
  assert.equal(row.id, undefined, 'and there is no child to link')
  assert.equal(closed.next.agentRows.size, 0)
})

// ── What a child does while it runs ──────────────────────────────────────────

test("a child's own tool still draws its own row, AND names the helper's qualifier", () => {
  // Both halves matter. The child's rows are what 0.43.0 draws, with the
  // command, its output and its exit code, and taking them away would be a
  // visible loss for anyone who delegates heavily.
  const { responded } = launched(CHILD_A, 1_000, 1_005)
  const childPre = feed(responded.next, childTool('PreToolUse', CHILD_A), 2_000)
  const rows = lastCardOf(childPre.effects).tools
  assert.equal(rows.length, 2, "the child's Bash keeps a row of its own")
  assert.equal(rows[1]!.name, 'Bash')
  assert.equal(rows[1]!.kind, undefined, "a child's tool row is an ordinary tool row")
  assert.equal(rows[1]!.args, 'wc -l hay.txt')
  assert.equal(helperRow(rows).detail, 'Bash wc -l hay.txt', 'the helper says what it is doing')

  const childPost = feed(childPre.next, childTool('PostToolUse', CHILD_A), 2_300)
  const after = lastCardOf(childPost.effects).tools
  assert.equal(after[1]!.status, 'done')
  assert.equal(after[1]!.output, '3 hay.txt', "and what it printed is still on the child's own row")
})

test("a child this daemon never saw launched draws its row and touches no helper", () => {
  const { responded } = launched(CHILD_A, 1_000, 1_005)
  const stranger = feed(responded.next, childTool('PreToolUse', CHILD_B), 2_000)
  const rows = lastCardOf(stranger.effects).tools
  assert.equal(rows.length, 2, 'the ordinary row path runs alone, exactly as today')
  assert.equal(helperRow(rows).detail, undefined, 'and the helper we DO know is untouched')
})

test("a child's task tools write nothing into the PARENT's Steps", () => {
  const { responded } = launched(CHILD_A, 1_000, 1_005)
  const create = {
    ...childTool('PostToolUse', CHILD_A),
    tool_name: 'TaskCreate',
    tool_use_id: 'toolu_child_task',
    tool_input: { subject: 'the child plans its own work', activeForm: 'planning' },
    tool_response: { task: { id: 't-1', subject: 'the child plans its own work' } },
  }
  const childTask = feed(responded.next, create, 2_000)
  assert.deepEqual(childTask.effects, [], 'a child planning is not the parent planning')
  assert.equal(childTask.next.tasks.size, 0)

  // The control: the same call from the PARENT does reach Steps.
  const parents: Record<string, unknown> = { ...create }
  delete parents.agent_id
  const parentTask = feed(responded.next, parents, 2_000)
  assert.ok(parentTask.effects.some((e) => e.kind === 'steps'))
  assert.equal(parentTask.next.tasks.size, 1)
})

// ── The stop ─────────────────────────────────────────────────────────────────

test('the matching SubagentStop closes the row with the receipt difference and a result', () => {
  // The notification for this child says <duration_ms>4612</duration_ms> and
  // carries a token count too. Neither is read: the elapsed is the difference
  // between two of this host's own receipts, and tokens were never promised.
  const { responded } = launched(CHILD_A, 1_000, 1_005)
  const stopped = feed(responded.next, stopFor(CHILD_A), 9_000)
  const row = helperRow(lastCardOf(stopped.effects).tools)
  assert.equal(row.status, 'done')
  assert.equal(row.durationMs, 8_000, 'the difference between the two receipts')
  assert.notEqual(row.durationMs, 4_612, "and not the number the notification quotes")
  assert.equal(row.result, '3', "the child's last message is the result line")
  assert.equal(row.detail, undefined, 'the qualifier said what it WAS doing, and it is not any more')
  assert.ok(!stopped.effects.some((e) => e.kind === 'goal_poll'), "a child's stop is not a verdict")
})

test('a long last message keeps its HEAD, at 240 characters', () => {
  const { responded } = launched(CHILD_A, 1_000, 1_005)
  const long = 'A'.repeat(300) + 'TAIL'
  const stopped = feed(responded.next, { ...stopFor(CHILD_A), last_assistant_message: long }, 9_000)
  const result = helperRow(lastCardOf(stopped.effects).tools).result ?? ''
  assert.ok(result.length <= 240, 'the wire cap is 240')
  assert.ok(result.startsWith('AAA'), 'an answer is worth reading from the start')
  assert.ok(!result.includes('TAIL'))
})

test('the suggestion generator stops, both of them real, produce no effects at all', () => {
  assert.equal(SUGGESTION_STOPS.length, 2, 'the probe carries both of them')
  assert.equal(
    SUGGESTION_STOPS.filter((p) => p.last_assistant_message === undefined).length,
    1,
    'and one of them has no last message key at all',
  )
  const { responded } = launched(CHILD_A, 1_000, 1_005)
  for (const stop of SUGGESTION_STOPS) {
    const ignored = feed(responded.next, stop, 9_000)
    assert.deepEqual(ignored.effects, [], `${String(stop.agent_id)} was never launched here`)
    assert.equal(helperRow([...ignored.next.tools.values()]).status, 'running')
  }
})

// ── A child that outlives its parent's turn ──────────────────────────────────

test('a Stop with a live helper keeps the card running and carries it', () => {
  const { responded } = launched(CHILD_A, 1_000, 1_005)
  const stopped = feed(responded.next, PARENT_STOP, 10_000)
  const card = lastCardOf(stopped.effects)
  assert.equal(card.state, 'running', 'a card folds when it is over, and this one is not')
  assert.equal(card.finishedAt, undefined)

  const ended = stopped.effects.find((e) => e.kind === 'turn_end')
  assert.deepEqual(ended, { kind: 'turn_end', keepCard: true })

  const carried = theCarried(stopped.next)
  assert.equal(carried.turnKey, card.cardKey, 'the card this turn drew is the card it leaves behind')
  assert.notEqual(
    carried.cardKey,
    card.cardKey,
    'and it answers to a key of its OWN from here on, or the next turn reaches it',
  )
  assert.ok(carried.cardKey.startsWith('carried:'), 'a key no turn state can ever mint')
  assert.equal(carried.startedAt, 999, "and it keeps the turn's own start")
  assert.equal(carried.agentRows.get(CHILD_A), agentCall(CHILD_A).launch.tool_use_id)

  // The live fields are cleared exactly as they are today: leaving them set is
  // how a turn inherits the previous turn's start.
  assert.equal(stopped.next.turnId, null)
  assert.deepEqual(stopped.next.toolOrder, [])
  assert.equal(stopped.next.tools.size, 0)
  assert.equal(stopped.next.agentRows.size, 0)
  assert.equal(stopped.next.startedAt, 0)
})

test('a Stop with no live helper settles the card and carries nothing', () => {
  const { responded } = launched(CHILD_A, 1_000, 1_005)
  const closed = feed(responded.next, stopFor(CHILD_A), 9_000)
  const stopped = feed(closed.next, PARENT_STOP, 10_000)
  const card = lastCardOf(stopped.effects)
  assert.equal(card.state, 'done')
  assert.equal(card.finishedAt, 10_000)
  assert.equal(stopped.next.carried.size, 0)
  assert.deepEqual(
    stopped.effects.find((e) => e.kind === 'turn_end'),
    { kind: 'turn_end', keepCard: false },
  )
})

test('a stop AFTER the turn ended patches the same card, with the turn s own clock', () => {
  const { responded } = launched(CHILD_A, 1_000, 1_005)
  const stopped = feed(responded.next, PARENT_STOP, 10_000)
  const late = feed(stopped.next, stopFor(CHILD_A), 20_000)
  const card = lastCardOf(late.effects)
  assert.equal(card.cardKey, theCarried(stopped.next).cardKey, 'the same message, not a second card')
  assert.equal(card.startedAt, 999, "the turn's ORIGINAL start, not the time of the stop")
  assert.equal(card.state, 'done', 'the last helper settled, so now the card is over')
  assert.equal(card.finishedAt, 20_000)
  const row = helperRow(card.tools)
  assert.equal(row.status, 'done')
  assert.equal(row.durationMs, 19_000)
  assert.equal(row.result, '3')
  assert.equal(late.next.carried.size, 0, 'nothing is left to wait for')
})

test('the prompt a completion notification opens must NOT clear the carried card', () => {
  // Every finished child is delivered to its parent as a prompt carrying a
  // <task-notification> block, and a prompt resets the live turn. If it reset
  // the carried card too, the child's own stop would land on a card that is
  // about the notification.
  const { responded } = launched(CHILD_A, 1_000, 1_005)
  const stopped = feed(responded.next, PARENT_STOP, 10_000)
  const prompted = feed(stopped.next, NOTIFICATION, 12_000)
  assert.equal(carriedOf(prompted.next).length, 1, 'the carried card survives a prompt')
  assert.deepEqual(prompted.next.carried, stopped.next.carried)
  assert.equal(prompted.next.turnId, NOTIFICATION.prompt_id, 'and a fresh live turn opens')
  assert.equal(prompted.next.startedAt, 12_000)
  assert.equal(prompted.next.tools.size, 0)

  const late = feed(prompted.next, stopFor(CHILD_A), 20_000)
  assert.equal(lastCardOf(late.effects).cardKey, theCarried(stopped.next).cardKey)
})

test("a child's tool after the turn ended draws on the card its helper is on", () => {
  // ONE delegating turn is ONE card. Every hook event a child sends carries
  // the PARENT's prompt id, so the turn those events re open mints the very
  // key the carried card answers to; giving the child's own rows a card of
  // their own kept them off that message and cost the owner a SECOND card in
  // the chat for one turn. They belong on the card the child's row is on.
  const { responded } = launched(CHILD_A, 1_000, 1_005)
  const stopped = feed(responded.next, PARENT_STOP, 10_000)
  const carriedKey = theCarried(stopped.next).cardKey
  const working = feed(stopped.next, childTool('PreToolUse', CHILD_A), 12_000)
  const cards = cardsOf(working.effects)
  assert.equal(cards.length, 1, 'one turn, one card')
  assert.equal(cards[0]!.cardKey, carriedKey, 'and it is the card the helper row is on')
  assert.equal(cards[0]!.state, 'running')
  assert.equal(cards[0]!.startedAt, 999, "which still carries the turn's own start")
  assert.equal(cards[0]!.finishedAt, undefined, 'and is not over while its helper works')

  const rows = cards[0]!.tools
  assert.equal(rows.length, 2, "the helper row, and the child's own Bash beside it")
  assert.equal(helperRow(rows).detail, 'Bash wc -l hay.txt', 'the helper says what it is doing')
  assert.equal(rows[1]!.name, 'Bash')
  assert.equal(rows[1]!.kind, undefined, "a child's tool row is an ordinary tool row")
  assert.equal(rows[1]!.args, 'wc -l hay.txt')
  assert.equal(rows[1]!.status, 'running')

  // And no live turn opened for it. A pseudo turn here mints a key of its own,
  // posts that second message, and takes the dead prompt id with it.
  assert.equal(working.next.turnId, null, "a child's tool is not the parent's next turn")
  assert.deepEqual(working.next.toolOrder, [])
  assert.equal(working.next.tools.size, 0)
  assert.equal(working.next.startedAt, 0)
  assert.deepEqual(
    carriedOf(working.next)[0]!.toolOrder.length,
    2,
    'the row is kept on the carried card, so the next repaint still has it',
  )
})

test("a child's finished tool lands on that same card, with what it printed", () => {
  // The same route on the PostToolUse path, which reads the dead prompt id at
  // a second site and would otherwise open the second card on its own.
  const { responded } = launched(CHILD_A, 1_000, 1_005)
  const stopped = feed(responded.next, PARENT_STOP, 10_000)
  const carriedKey = theCarried(stopped.next).cardKey
  const working = feed(stopped.next, childTool('PreToolUse', CHILD_A), 12_000)
  const finished = feed(working.next, childTool('PostToolUse', CHILD_A), 12_313)
  const cards = cardsOf(finished.effects)
  assert.equal(cards.length, 1)
  assert.equal(cards[0]!.cardKey, carriedKey, 'the same card the Pre half drew on')
  const rows = cards[0]!.tools
  assert.equal(rows.length, 2, 'the same two rows, one of them now closed')
  assert.equal(rows[1]!.status, 'done')
  assert.equal(rows[1]!.output, '3 hay.txt', "what the child's command printed")
  assert.equal(rows[1]!.durationMs, 313, 'the duration the runtime reported for that call')
  assert.equal(helperRow(rows).status, 'running', 'and the helper is still working')
  assert.equal(finished.next.tools.size, 0, 'nothing opened a live turn')
  assert.equal(carriedOf(finished.next).length, 1, 'the card is still waiting for its child')
})

test('the whole sequence the probe recorded lands on ONE card', () => {
  // In the order the wire really had it: the Agent call, the async launch
  // response, the parent Stop while the child is still running, the child's
  // own Bash opening and closing, and the child's stop. From the launch to the
  // result, the owner reads one card.
  const { call, responded } = launched(CHILD_A, 1_000, 1_005)
  const response = call.launch.tool_response as Record<string, unknown>
  assert.equal(response.status, 'async_launched', 'the fixture must really be an async launch')
  const stopped = feed(responded.next, PARENT_STOP, 10_000)
  const carriedKey = theCarried(stopped.next).cardKey

  const opened = feed(stopped.next, childTool('PreToolUse', CHILD_A), 12_000)
  const closed = feed(opened.next, childTool('PostToolUse', CHILD_A), 12_313)
  const between = [...opened.effects, ...closed.effects]
  assert.deepEqual(
    cardsOf(between)
      .map((c) => c.cardKey)
      .filter((key) => key !== carriedKey),
    [],
    'between the parent Stop and the child stop, no card but the carried one is opened',
  )
  assert.equal(cardsOf(between).length, 2, 'and it repaints once as the row opens and once as it closes')

  const running = cardsOf(opened.effects)[0]!
  assert.equal(running.tools.length, 2)
  assert.equal(running.tools[1]!.status, 'running', "the child's Bash opens on the carried card")
  assert.equal(helperRow(running.tools).detail, 'Bash wc -l hay.txt', 'and the child row reads it')

  const done = cardsOf(closed.effects)[0]!
  assert.equal(done.state, 'running', 'the card is not over: its helper is still working')
  assert.equal(done.tools[1]!.status, 'done')
  assert.equal(done.tools[1]!.durationMs, 313)

  const settled = feed(closed.next, stopFor(CHILD_A), 20_000)
  const last = lastCardOf(settled.effects)
  assert.equal(last.cardKey, carriedKey, 'the same message all the way through')
  assert.equal(last.state, 'done')
  assert.equal(last.finishedAt, 20_000)
  assert.equal(last.startedAt, 999)
  assert.equal(last.tools.length, 2, "the child's own row is still there beside its helper")
  const helper = helperRow(last.tools)
  assert.equal(helper.status, 'done')
  assert.equal(helper.result, '3', "the child's last message is the result line")
  assert.equal(helper.detail, undefined, 'the qualifier said what it WAS doing')
  assert.equal(helper.durationMs, 19_000, 'the difference between the two receipts')
  assert.equal(settled.next.carried.size, 0, 'nothing is left to wait for')
})

test('SessionEnd settles a child that never reported as an error, and clears the carried card', () => {
  const { responded } = launched(CHILD_A, 1_000, 1_005)
  const stopped = feed(responded.next, PARENT_STOP, 10_000)
  const ended = feed(stopped.next, SESSION_END, 30_000)
  const card = cardsOf(ended.effects).find((c) => c.cardKey === theCarried(stopped.next).cardKey)
  assert.ok(card, 'the carried card settles too, or it ticks forever')
  assert.equal(card!.state, 'done')
  const row = helperRow(card!.tools)
  assert.equal(row.status, 'error')
  assert.equal(row.result, undefined, 'it never said anything, so there is nothing to show')
  assert.equal(
    row.durationMs,
    undefined,
    'and no moment to measure to: the child never stopped, the session did',
  )
  assert.equal(ended.next.carried.size, 0)
  assert.deepEqual(
    ended.effects.find((e) => e.kind === 'turn_end'),
    { kind: 'turn_end', keepCard: false },
  )
})


// ── More than one card at once ───────────────────────────────────────────────

test('a second turn that ends with a live helper keeps the FIRST card as well', () => {
  // One slot for the carried card threw the older one away with no settle at
  // all: its child's stop then resolved nothing, returned no effects, and the
  // card it was on ticked on "Working" until the app's own 24 hour cut off.
  const first = launched(CHILD_A, 1_000, 1_005)
  const stopped1 = feed(first.responded.next, PARENT_STOP, 10_000)
  const firstKey = theCarried(stopped1.next).cardKey
  const prompted = feed(stopped1.next, NOTIFICATION, 11_000)
  const second = launchInto(prompted.next, CHILD_B, 12_000, 12_005)
  const stopped2 = feed(second.responded.next, PARENT_STOP, 13_000)

  const cards = carriedOf(stopped2.next)
  assert.equal(cards.length, 2, 'both children are still working, so both cards are still open')
  assert.equal(cards[0]!.cardKey, firstKey, 'the first card is still the first card')
  assert.notEqual(cards[1]!.cardKey, firstKey)
  assert.equal(cards[0]!.agentRows.get(CHILD_A), agentCall(CHILD_A).launch.tool_use_id)
  assert.equal(cards[1]!.agentRows.get(CHILD_B), agentCall(CHILD_B).launch.tool_use_id)

  // The FIRST child stops, and it settles the FIRST card, under its own key.
  const late1 = feed(stopped2.next, stopFor(CHILD_A), 20_000)
  const settled1 = lastCardOf(late1.effects)
  assert.equal(settled1.cardKey, firstKey, 'a stop reaches the card its own child is on')
  assert.equal(settled1.state, 'done')
  assert.equal(settled1.startedAt, 999, "the FIRST turn's own start, not the second turn's")
  assert.equal(helperRow(settled1.tools).status, 'done')
  assert.equal(helperRow(settled1.tools).durationMs, 19_000)
  assert.equal(carriedOf(late1.next).length, 1, 'and only the card still waiting is left')

  const late2 = feed(late1.next, stopFor(CHILD_B), 21_000)
  const settled2 = lastCardOf(late2.effects)
  assert.equal(settled2.cardKey, cards[1]!.cardKey)
  assert.equal(settled2.state, 'done')
  assert.equal(settled2.startedAt, 11_000, "the SECOND turn's own start")
  assert.equal(carriedOf(late2.next).length, 0, 'nothing is left to wait for')
})

test("a child's tool finds ITS card among the cards left behind", () => {
  const first = launched(CHILD_A, 1_000, 1_005)
  const stopped1 = feed(first.responded.next, PARENT_STOP, 10_000)
  const firstKey = theCarried(stopped1.next).cardKey
  const prompted = feed(stopped1.next, NOTIFICATION, 11_000)
  const second = launchInto(prompted.next, CHILD_B, 12_000, 12_005)
  const stopped2 = feed(second.responded.next, PARENT_STOP, 13_000)

  const working = feed(stopped2.next, childTool('PreToolUse', CHILD_A), 14_000)
  assert.equal(cardsOf(working.effects).length, 1, 'one card, and the child picks WHICH one')
  const repainted = cardsOf(working.effects).find((c) => c.cardKey === firstKey)
  assert.ok(repainted, "the older card is the one this child's row belongs on")
  assert.equal(helperRow(repainted.tools).detail, 'Bash wc -l hay.txt')
  assert.equal(repainted.tools.length, 2, "and the child's own row goes on it too")
  const other = carriedOf(working.next).find((c) => c.cardKey !== firstKey)
  assert.ok(other, 'and the newer card is untouched')
  assert.equal([...other.tools.values()].find((r) => r.kind === 'subagent')!.detail, undefined)
})

test('the cards a turn leaves behind are bounded, oldest first', () => {
  // A map that only ever grows is a leak in a process that runs for weeks, and
  // the daemon's own card id map is bounded for the same reason. Losing the
  // oldest costs that one card its settle, which is what a single slot did to
  // every card but the newest.
  const call = agentCall(CHILD_A)
  const response = call.launch.tool_response as Record<string, unknown>
  let state = emptyTurn()
  const keys: string[] = []
  for (let i = 0; i < CARRIED_CARDS_MAX + 1; i += 1) {
    const at = 100_000 * (i + 1)
    const prompt = feed(state, { ...NOTIFICATION, prompt_id: `prompt-${i}` }, at)
    const opened = feed(prompt.next, call.opened, at + 10)
    const responded = feed(opened.next, {
      ...call.launch,
      tool_response: { ...response, agentId: `child-${i}` },
    }, at + 20)
    const stopped = feed(responded.next, PARENT_STOP, at + 100)
    const cards = carriedOf(stopped.next)
    keys.push(cards[cards.length - 1]!.cardKey)
    state = stopped.next
  }
  const held = carriedOf(state)
  assert.equal(held.length, CARRIED_CARDS_MAX)
  assert.ok(!held.some((c) => c.cardKey === keys[0]), 'the oldest card fell out')
  assert.equal(held[held.length - 1]!.cardKey, keys[keys.length - 1], 'the newest is still held')
})

test('SessionEnd settles EVERY card that is still waiting', () => {
  const first = launched(CHILD_A, 1_000, 1_005)
  const stopped1 = feed(first.responded.next, PARENT_STOP, 10_000)
  const prompted = feed(stopped1.next, NOTIFICATION, 11_000)
  const second = launchInto(prompted.next, CHILD_B, 12_000, 12_005)
  const stopped2 = feed(second.responded.next, PARENT_STOP, 13_000)

  const ended = feed(stopped2.next, SESSION_END, 30_000)
  const settled = cardsOf(ended.effects)
  assert.equal(settled.length, 2, 'a card left unsettled here ticks for ever')
  for (const card of settled) {
    assert.equal(card.state, 'done')
    assert.equal(card.finishedAt, 30_000)
    assert.equal(helperRow(card.tools).status, 'error')
  }
  assert.equal(ended.next.carried.size, 0)
})

test('two turns with no prompt and no start of their own get different card keys', () => {
  // The fallback key used to be the constant "turn:none", so two turns that
  // opened on a tool the mapper could not date shared one key and the second
  // turn's rows patched the first turn's message.
  const bare = (id: string): Record<string, unknown> => {
    const payload: Record<string, unknown> = { ...childTool('PostToolUse', CHILD_A), tool_use_id: id }
    delete payload.prompt_id
    delete payload.agent_id
    return payload
  }
  const first = feed(emptyTurn(), bare('toolu_anon_1'), 5_000)
  const firstKey = lastCardOf(first.effects).cardKey
  const ended = feed(first.next, PARENT_STOP, 5_500)
  assert.equal(ended.next.startedAt, 0, 'the turn end clears what little clock there was')
  const second = feed(ended.next, bare('toolu_anon_2'), 6_000)
  const secondKey = lastCardOf(second.effects).cardKey
  assert.notEqual(firstKey, secondKey, 'two cards, two keys, or the second overwrites the first')
  assert.ok(!firstKey.includes('none'), 'and neither of them is a constant')
  assert.ok(!secondKey.includes('none'))
})

test('a prompt settles a card that no Stop is coming for', () => {
  // The turn the owner interrupted: rows still open, no Stop ever coming, and
  // the next prompt about to throw those rows away. Settling the card here is
  // what stops it reading "Working" for the rest of the session, and the card
  // a working child is on is deliberately left alone.
  const { responded } = launched(CHILD_A, 1_000, 1_005)
  const stopped = feed(responded.next, PARENT_STOP, 10_000)
  const carriedKey = theCarried(stopped.next).cardKey
  const resumed = feed(stopped.next, NOTIFICATION, 12_000)
  const working = feed(resumed.next, PARENT_TOOL, 12_500)
  const live = lastCardOf(working.effects)
  assert.notEqual(live.cardKey, carriedKey, "the parent's own next turn draws a card of its own")

  const prompted = feed(working.next, NOTIFICATION_B, 13_000)
  const settled = cardsOf(prompted.effects)
  assert.equal(settled.length, 1, 'the card still open is settled, and nothing else is touched')
  assert.equal(settled[0]!.cardKey, live.cardKey)
  assert.equal(settled[0]!.state, 'done')
  assert.equal(settled[0]!.finishedAt, 13_000)
  assert.equal(carriedOf(prompted.next).length, 1, 'a prompt never settles a carried card')
  assert.equal(prompted.next.toolOrder.length, 0)
})

// ── The 50 row cap ───────────────────────────────────────────────────────────

test('the front drop never takes a helper that is still working', () => {
  const live: ToolRow = {
    icon: '🔀',
    name: 'general-purpose',
    args: 'Run wc -l on hay.txt',
    status: 'running',
    kind: 'subagent',
    startedAt: 1_000,
  }
  const filler = (index: number): ToolRow => ({ icon: '💻', name: `Bash ${index}`, status: 'done' })
  const rows = [live, ...Array.from({ length: 60 }, (_, i) => filler(i))]
  const clipped = clipToolRows(rows)
  assert.equal(clipped.length, TOOL_ROWS_MAX, 'the backend refuses a card with 51 rows')
  assert.ok(clipped.some((r) => r.kind === 'subagent' && r.status === 'running'), 'the helper stayed')
  assert.equal(clipped[0]!.name, 'earlier', 'and the drop is still announced')
  assert.equal(clipped[1]!.kind, 'subagent', 'in the order it happened in')
  assert.equal(clipped[clipped.length - 1]!.name, 'Bash 59', 'the newest rows are still the tail')

  const settled = clipToolRows([{ ...live, status: 'done' }, ...Array.from({ length: 60 }, (_, i) => filler(i))])
  assert.ok(
    !settled.some((r) => r.kind === 'subagent'),
    'a helper that has already reported is an ordinary old row',
  )
})
