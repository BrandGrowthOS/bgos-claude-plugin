/**
 * One pending slot per CARD, and the two writes that proves (stage 8, the fix
 * batch that followed the review).
 *
 * The daemon held ONE pending card state. The mapper emits the repaint of a
 * card a working child outlived AND the live turn's own card in the SAME
 * batch, every time that child runs a tool, so the second assignment threw the
 * first away before the 600 ms coalescer ever fired: the qualifier saying what
 * the helper is doing right now never reached the wire at all, in exactly the
 * lane this stage exists for. The queue below is keyed on the card's own key,
 * so a state can only ever replace the state of the SAME card.
 *
 * The first case drives the REAL gate payloads through the real mapper and
 * then through the queue the way the daemon does, because the defect was never
 * in either half on its own: the mapper emitted both effects and a test could
 * see them, and the daemon dropped one of them where nothing looked.
 *
 * Mutations these tests are proven against:
 *   - one slot for every card        -> the two writes case goes red
 *   - drain newest first             -> the oldest first case goes red
 *   - keep every card for ever       -> the bound case goes red
 *   - keepOnly keeps everything      -> the turn end case goes red
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'

import { PendingCards } from '../lib/hook-card-pending.ts'
import type { HookCardPending } from '../lib/hook-card-body.ts'
import {
  applyHookEventToTurn,
  emptyTurn,
  parseHookEvent,
  type Effect,
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

const feed = (
  state: TurnState,
  raw: Record<string, unknown>,
  now: number,
): { next: TurnState; effects: Effect[] } => {
  const event = parseHookEvent(raw)
  assert.ok(event, `payload should parse: ${String(raw.hook_event_name)}`)
  return applyHookEventToTurn(state, event, now)
}

const CHILD_A = 'ae89978c2d1dd91df'

/** What runHookEffects puts in the queue for one card effect. */
const pendingOf = (effect: Extract<Effect, { kind: 'tool_card' }>): HookCardPending => ({
  state: effect.state,
  tools: effect.tools,
  text: effect.text,
  cardKey: effect.cardKey,
  startedAt: effect.startedAt,
  finishedAt: effect.finishedAt,
})

/** Everything the queue still owes, drained the way the flusher drains it. */
const drain = (queue: PendingCards): HookCardPending[] => {
  const written: HookCardPending[] = []
  for (let pending = queue.take(); pending !== null; pending = queue.take()) written.push(pending)
  return written
}

const card = (key: string, text: string): HookCardPending => ({
  state: 'running',
  tools: [],
  text,
  cardKey: key,
})

test('both cards of one batch are written, because each card has a slot', () => {
  // The real payloads: the owner's prompt, the Agent launch and its async
  // response, the parent Stop that left the card behind, and then the child's
  // own Bash while it goes on working.
  const launch = pick(
    (r) =>
      r.hook === 'PostToolUse' &&
      r.payload.tool_name === 'Agent' &&
      ((r.payload.tool_response as Record<string, unknown>)?.agentId ?? '') === CHILD_A,
    'the Agent launch response',
  )
  const opened = pick(
    (r) =>
      r.hook === 'PreToolUse' &&
      r.payload.tool_name === 'Agent' &&
      r.payload.tool_use_id === launch.tool_use_id,
    'the Agent PreToolUse',
  )
  const prompt = pick(
    (r) =>
      r.hook === 'UserPromptSubmit' &&
      !String(r.payload.prompt ?? '').includes('<task-notification>'),
    'the owner prompt',
  )
  const stop = pick(
    (r) =>
      r.hook === 'Stop' &&
      r.payload.last_assistant_message === 'Waiting for the agents to complete...',
    'the parent Stop that waited for its children',
  )
  const childBash = pick(
    (r) => r.hook === 'PreToolUse' && r.payload.agent_id === CHILD_A && r.payload.tool_name === 'Bash',
    'the child s own Bash',
  )

  let state = feed(emptyTurn(), prompt, 999).next
  state = feed(state, opened, 1_000).next
  state = feed(state, launch, 1_005).next
  state = feed(state, stop, 10_000).next
  const working = feed(state, childBash, 12_000)
  const effects = working.effects.filter(
    (e): e is Extract<Effect, { kind: 'tool_card' }> => e.kind === 'tool_card',
  )
  assert.equal(effects.length, 2, 'one batch, two cards: the carried repaint and the live card')

  const queue = new PendingCards(8)
  for (const effect of effects) queue.put(pendingOf(effect))
  const written = drain(queue)

  assert.equal(written.length, 2, 'a single slot writes one of them and throws the other away')
  const helperCard = written.find((p) => p.tools.some((r) => r.kind === 'subagent'))
  assert.ok(helperCard, 'the card the helper is on has to reach the wire')
  assert.equal(
    helperCard.tools.find((r) => r.kind === 'subagent')!.detail,
    'Bash wc -l hay.txt',
    'carrying what the child is doing right now, which is the whole point of the repaint',
  )
  const liveCard = written.find((p) => p !== helperCard)
  assert.ok(liveCard, "and the child's own row reaches the wire as well")
  assert.notEqual(liveCard.cardKey, helperCard.cardKey, 'two cards, two keys, two messages')
})

test('a new state replaces the state of the SAME card and no other', () => {
  const queue = new PendingCards(8)
  queue.put(card('a', 'first'))
  queue.put(card('b', 'other card'))
  queue.put(card('a', 'second'))
  const written = drain(queue)
  assert.equal(written.length, 2, 'two cards, two writes')
  assert.equal(written[0]!.text, 'second', 'the newest state of a card is the one that goes out')
  assert.equal(written[1]!.text, 'other card')
})

test('the card that has waited longest is written first', () => {
  // Oldest first, so a live card repainting every 600 ms cannot starve the
  // card a working child is on.
  const queue = new PendingCards(8)
  queue.put(card('a', 'first'))
  queue.put(card('b', 'second'))
  queue.put(card('a', 'first again'))
  const written = drain(queue)
  assert.deepEqual(
    written.map((p) => p.cardKey),
    ['a', 'b'],
    'a repaint keeps the place the card already had',
  )
})

test('the queue is bounded, and the oldest card falls out', () => {
  const queue = new PendingCards(2)
  queue.put(card('a', 'first'))
  queue.put(card('b', 'second'))
  queue.put(card('c', 'third'))
  assert.equal(queue.size, 2)
  assert.deepEqual(
    drain(queue).map((p) => p.cardKey),
    ['b', 'c'],
  )
})

test('the turn end keeps the cards a child agent is still working on', () => {
  const queue = new PendingCards(8)
  queue.put(card('turn-1', 'the turn that is ending'))
  queue.put(card('carried:turn-0:900', 'the card a child outlived'))
  queue.keepOnly(['carried:turn-0:900'])
  assert.equal(queue.size, 1, "the ending turn's own state is forgotten")
  assert.equal(queue.get('carried:turn-0:900')!.text, 'the card a child outlived')
  assert.equal(queue.get('turn-1'), null)
  assert.equal(queue.get(null), null, 'a card with no key at all asks for nothing')
})

test('reading a card leaves its state where it is', () => {
  // The turn end reads the state it is about to send; the flusher is what
  // takes it out of the queue.
  const queue = new PendingCards(8)
  queue.put(card('a', 'still owed'))
  assert.equal(queue.get('a')!.text, 'still owed')
  assert.equal(queue.size, 1)
  queue.clear()
  assert.equal(queue.size, 0)
  assert.equal(queue.take(), null)
})
