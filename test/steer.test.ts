/**
 * /steer (0.64.0): interrupt the running turn, then deliver the text.
 *
 * The two paths the brief names, both driven with spies through the one
 * function server.ts uses (runSteer): a running turn gets ONE Escape and then
 * the text; an idle session gets the text and no key at all. Around them, the
 * pieces that decide which path a message takes (planSteer, isFreshSteer,
 * steerTurnState), the router and catalog that make `steer` reachable only
 * where it can interrupt, the fixed Escape argv, the wake card contract for
 * the steer card, and a source guard that every inbound rail goes through
 * deliverInbound.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  CLAUDE_STEER_CONTRACT_SHA256,
  CLAUDE_STEER_SINCE,
  STEER_ESCAPE_COOLDOWN_MS,
  STEER_FRESH_MS,
  STEER_INTERRUPTED_META,
  SteerGate,
  buildSteerDelivery,
  isFreshSteer,
  planSteer,
  steerContent,
  steerContractSha256,
  steerContractString,
  steerTurnState,
  type SteerPlan,
} from '../lib/steer.ts'
import { buildInterruptSteps, type TmuxTarget } from '../lib/compact-inject.ts'
import {
  DAEMON_STEER_COMMAND,
  catalogForCapabilities,
  mergeSlashCommandCatalog,
  prepareSlashCommands,
  routeSlashCommand,
  type SlashCommandEntry,
} from '../lib/slash-catalog.ts'
import { finalInboundMeta } from '../lib/inbound-channel.ts'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }

// ── The cross repo pin ──────────────────────────────────────────────────────

test('the steer contract hash matches the pin BGOS carries', () => {
  assert.equal(steerContractString(), 'steer;slash_command;/steer {text};0.64.0')
  assert.equal(steerContractSha256(), CLAUDE_STEER_CONTRACT_SHA256)
  assert.equal(
    CLAUDE_STEER_CONTRACT_SHA256,
    '1e45af97de1641d775f0adfbac45765f7e2ded2c4f7426bd55b78822c5174be0',
  )
})

test('the floor the app reads is not above this release', () => {
  const [a, b, c] = pkg.version.split('.').map((n) => Number.parseInt(n, 10))
  const [x, y, z] = CLAUDE_STEER_SINCE.split('.').map(Number)
  const at = a! * 1e6 + b! * 1e3 + c!
  assert.ok(at >= x! * 1e6 + y! * 1e3 + z!, `${pkg.version} is below the steer floor`)
})

// ── The two paths (SteerGate, driven with spies) ────────────────────────────

function harness(opts: { busy?: boolean; failInterrupt?: boolean } = {}) {
  const calls: string[] = []
  let clock = 1_000_000
  const gate = new SteerGate({
    now: () => clock,
    injectionBusy: () => opts.busy === true,
    interrupt: async () => {
      calls.push('interrupt')
      if (opts.failInterrupt) throw new Error('tmux gone')
    },
    sleep: async (ms: number) => {
      calls.push(`sleep:${ms}`)
    },
    log: () => {},
    settleMs: 5,
  })
  const deliver = (label: string) => async (interrupted: boolean) => {
    calls.push(`deliver:${label}:${interrupted}`)
  }
  return { gate, calls, deliver, advance: (ms: number) => (clock += ms) }
}

const RUNNING: SteerPlan = { interrupt: true, reason: 'turn_live' }
const IDLE: SteerPlan = { interrupt: false, reason: 'idle' }

test('a running turn: ONE interrupt, a settle beat, then the text, marked interrupted', async () => {
  const h = harness()
  const outcome = await h.gate.steer({ messageId: '1', plan: RUNNING, deliver: h.deliver('s') })
  assert.equal(outcome, 'interrupted')
  assert.deepEqual(h.calls, ['interrupt', 'sleep:5', 'deliver:s:true'])
})

test('an idle session: the text is delivered as a plain message, no key pressed, no marker', async () => {
  const h = harness()
  const outcome = await h.gate.steer({ messageId: '1', plan: IDLE, deliver: h.deliver('s') })
  assert.equal(outcome, 'plain')
  assert.deepEqual(h.calls, ['deliver:s:false'])
})

test('a failed interrupt still delivers the text (never dropped), with no marker', async () => {
  const h = harness({ failInterrupt: true })
  const outcome = await h.gate.steer({ messageId: '1', plan: RUNNING, deliver: h.deliver('s') })
  assert.equal(outcome, 'interrupt_failed')
  assert.deepEqual(h.calls, ['interrupt', 'deliver:s:false'])
})

test('two steers at once press ONE Escape: they run in order and the second is inside the cooldown', async () => {
  const h = harness()
  const a = h.gate.steer({ messageId: '1', plan: RUNNING, deliver: h.deliver('a') })
  const b = h.gate.steer({ messageId: '2', plan: RUNNING, deliver: h.deliver('b') })
  assert.deepEqual(await Promise.all([a, b]), ['interrupted', 'cooldown'])
  assert.deepEqual(h.calls, ['interrupt', 'sleep:5', 'deliver:a:true', 'deliver:b:false'])
})

test('after the cooldown a new steer presses again', async () => {
  const h = harness()
  await h.gate.steer({ messageId: '1', plan: RUNNING, deliver: h.deliver('a') })
  h.advance(STEER_ESCAPE_COOLDOWN_MS)
  assert.equal(await h.gate.steer({ messageId: '2', plan: RUNNING, deliver: h.deliver('b') }), 'interrupted')
  assert.equal(h.calls.filter((c) => c === 'interrupt').length, 2)
})

test('no Escape while the daemon is typing /compact or /goal itself', async () => {
  const h = harness({ busy: true })
  assert.equal(await h.gate.steer({ messageId: '1', plan: RUNNING, deliver: h.deliver('s') }), 'injection_busy')
  assert.deepEqual(h.calls, ['deliver:s:false'])
})

test('a retried delivery of the same steer never presses a second time', async () => {
  const h = harness()
  await h.gate
    .steer({
      messageId: '7',
      plan: RUNNING,
      deliver: async () => {
        throw new Error('handoff failed')
      },
    })
    .catch(() => {})
  h.advance(STEER_ESCAPE_COOLDOWN_MS * 10)
  assert.equal(await h.gate.steer({ messageId: '7', plan: RUNNING, deliver: h.deliver('retry') }), 'already_pressed')
  assert.equal(h.calls.filter((c) => c === 'interrupt').length, 1)
})

test('a message arriving behind an in-flight steer is delivered after it, never before', async () => {
  const h = harness()
  const s1 = h.gate.steer({ messageId: '1', plan: RUNNING, deliver: h.deliver('steer') })
  const m = h.gate.ordinary(() => h.deliver('message')(false))
  await Promise.all([s1, m])
  assert.deepEqual(h.calls, ['interrupt', 'sleep:5', 'deliver:steer:true', 'deliver:message:false'])
})

test('with no steer in flight an ordinary message is delivered at once', async () => {
  const h = harness()
  let delivered = false
  const p = h.gate.ordinary(async () => {
    delivered = true
  })
  assert.equal(delivered, true, 'synchronously started, not queued')
  await p
})

// ── Which path (planSteer) ──────────────────────────────────────────────────

const due = { hasTerminal: true, isOwner: true, fresh: true, text: 'stop, do X', turn: 'live' } as const

test('planSteer interrupts a fresh owner steer while a turn runs', () => {
  assert.deepEqual(planSteer(due), { interrupt: true, reason: 'turn_live' })
})

test('planSteer interrupts when the hook rail cannot say (unknown)', () => {
  assert.deepEqual(planSteer({ ...due, turn: 'unknown' }), { interrupt: true, reason: 'turn_unknown' })
})

test('planSteer never interrupts an idle session', () => {
  assert.deepEqual(planSteer({ ...due, turn: 'idle' }), { interrupt: false, reason: 'idle' })
})

test('planSteer never interrupts without a terminal', () => {
  assert.deepEqual(planSteer({ ...due, hasTerminal: false }), { interrupt: false, reason: 'no_terminal' })
})

test('planSteer never lets a non owner interrupt the owner session', () => {
  assert.deepEqual(planSteer({ ...due, isOwner: false }), { interrupt: false, reason: 'not_owner' })
})

test('planSteer never interrupts for a stale steer', () => {
  assert.deepEqual(planSteer({ ...due, fresh: false }), { interrupt: false, reason: 'stale' })
})

test('planSteer never interrupts another chat\'s running turn', () => {
  assert.deepEqual(planSteer({ ...due, otherChatTurn: true }), { interrupt: false, reason: 'other_chat' })
})

test('planSteer never presses into a relayed permission prompt', () => {
  assert.deepEqual(planSteer({ ...due, dialogOpen: true }), { interrupt: false, reason: 'dialog_open' })
})

test('planSteer never interrupts with nothing to say', () => {
  assert.deepEqual(planSteer({ ...due, text: '   ' }), { interrupt: false, reason: 'empty' })
})

test('isFreshSteer: inside the window, outside it, and unreadable', () => {
  const now = Date.parse('2026-10-09T12:00:00Z')
  assert.equal(isFreshSteer('2026-10-09T11:59:30Z', now), true)
  assert.equal(isFreshSteer(new Date(now - STEER_FRESH_MS - 1).toISOString(), now), false)
  assert.equal(isFreshSteer(now, now), true)
  assert.equal(isFreshSteer(undefined, now), false)
  assert.equal(isFreshSteer('not a date', now), false)
})

test('steerTurnState: hooks report live or idle, no hooks is unknown', () => {
  assert.equal(steerTurnState({ signal: 'hooks', live: true }), 'live')
  assert.equal(steerTurnState({ signal: 'hooks', live: false }), 'idle')
  assert.equal(steerTurnState({ signal: 'none', live: false }), 'unknown')
})

// ── The key (fixed, one Escape) ─────────────────────────────────────────────

test('the interrupt is ONE Escape key name, no literal text, no Enter', () => {
  const t: TmuxTarget = { target: '%3', socketArgs: ['-S', '/tmp/tmux-501/default'], source: 'tmux-pane' }
  const steps = buildInterruptSteps(t)
  assert.equal(steps.length, 1)
  assert.deepEqual(steps[0]!.argv, ['tmux', '-S', '/tmp/tmux-501/default', 'send-keys', '-t', '%3', 'Escape'])
  assert.equal(steps[0]!.argv.includes('-l'), false, 'a key name, never typed text')
})

// ── Routing and the catalog ─────────────────────────────────────────────────

test('/steer routes to a steer whose delivery is the TEXT, from slash text', () => {
  const route = routeSlashCommand({
    payload: { messageType: 'slash_command', text: '/steer   use the staging db instead  ' },
    registry: new Map(),
  })
  assert.equal(route.kind, 'steer')
  if (route.kind !== 'steer') return
  assert.equal(route.delivery.content, 'use the staging db instead')
  assert.deepEqual(route.delivery.meta, {}, 'the marker is added only when the Escape was pressed')
})

test('a steer keeps what the channel put around its words (attachments, prefixes)', () => {
  assert.equal(
    steerContent('[backlog - arrived offline]\n/steer look at this\n[Attached image: a.png]', 'look at this'),
    '[backlog - arrived offline]\nlook at this\n[Attached image: a.png]',
  )
  assert.equal(steerContent('/steer\n[Attached image: a.png]', ''), '[Attached image: a.png]')
  assert.equal(steerContent('', 'from args'), 'from args')
  assert.equal(steerContent('/steering wheel', 'x'), '/steering wheel', 'only the whole /steer token')
})

test('/steer routes from structured fields too', () => {
  const route = routeSlashCommand({
    payload: { messageType: 'slash_command', commandName: 'steer', commandArgs: 'stop and summarize' },
    registry: new Map(),
  })
  assert.equal(route.kind, 'steer')
  if (route.kind === 'steer') assert.equal(route.delivery.content, 'stop and summarize')
})

test('a user command called /steer cannot shadow the daemon steer', () => {
  const user: SlashCommandEntry = { command: '/steer', description: 'mine', scope: 'all', prompt: 'do $ARGUMENTS' }
  const { registry } = prepareSlashCommands([user])
  const route = routeSlashCommand({
    payload: { messageType: 'slash_command', text: '/steer hello' },
    registry,
  })
  assert.equal(route.kind, 'steer')
})

test('steer is advertised only when the daemon can interrupt', () => {
  const names = (opts: Parameters<typeof catalogForCapabilities>[0]) =>
    catalogForCapabilities(opts).map((e) => e.command)
  assert.ok(names({ remoteCompact: true, steer: true }).includes('/steer'))
  assert.equal(names({ remoteCompact: false, steer: false }).includes('/steer'), false)
  assert.equal(names({ remoteCompact: false }).includes('/steer'), false)
  assert.equal(DAEMON_STEER_COMMAND.prompt, undefined, 'no prompt: the text goes as a message')
})

test('a discovered /steer never enters the catalog (an install without tmux shows no steer)', () => {
  const user: SlashCommandEntry = { command: '/steer', description: 'mine', scope: 'all', prompt: 'x' }
  const merged = mergeSlashCommandCatalog(catalogForCapabilities({ remoteCompact: false }), [[user]])
  assert.equal(merged.some((e) => e.command === '/steer'), false)
})

// ── The wake card contract ──────────────────────────────────────────────────

function assertAllStrings(meta: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(meta)) {
    assert.equal(typeof v, 'string', `meta.${k} must be a string (got ${v === null ? 'null' : typeof v})`)
  }
}

test('the steer card meta is all string, sparse and merged, marked and unmarked', () => {
  const steer = buildSteerDelivery({ commandArgs: 'x' })
  assertAllStrings(steer.meta)
  assertAllStrings(STEER_INTERRUPTED_META)
  assert.equal(STEER_INTERRUPTED_META.steer, 'true')
  assertAllStrings(finalInboundMeta({ chat_id: '1', message_id: '2' }, steer.meta, null, null))
  assertAllStrings(
    finalInboundMeta(
      { chat_id: '1', message_id: '2', user_id: '9', sender_display_name: 'K' },
      steer.meta,
      STEER_INTERRUPTED_META,
    ),
  )
})

// ── Wiring: every inbound rail goes through deliverInbound ─────────────────

test('server.ts routes poll, stream and ws delivery through the steer gate', () => {
  const server = readFileSync(new URL('../server.ts', import.meta.url), 'utf8')
  const count = (re: RegExp) => (server.match(re) ?? []).length
  assert.equal(count(/const steerPlan = slashRoute\.kind === 'steer'/g), 3, 'one steer plan per rail')
  assert.equal(count(/deliverInbound\(steerPlan, \(interrupted\) => mcp\.notification\(/g), 3)
  assert.equal(count(/interrupted \? STEER_INTERRUPTED_META : null,/g), 3, 'the marker only when pressed')
  assert.equal(count(/slashRoute\.kind === 'directive' \|\| slashRoute\.kind === 'steer'/g), 3)
  assert.match(server, /messageId: msg\.message\.id,\n\s*payload: msg\.message,\n\s*sentDate: msg\.message\.sentDate,\n\s*backlog: isBacklog,/)
  assert.match(server, /steer: compactTarget !== null,\n  \}\)/, 'boot catalog advertises steer with the tmux target')
  assert.match(server, /injectionBusy: \(\) => compactInFlight \|\| goalInjectionsInFlight > 0,/)
  assert.match(server, /dialogOpen: pendingPermissions\.size > 0,/)
  assert.match(
    server,
    /otherChatTurn: turnChat\.live\(\) && \(turnChat\.current\(Date\.now\(\)\)\?\.chatId \?\? input\.chatId\) !== input\.chatId,/,
  )
  assert.match(server, /live: hookTurnLive \|\| hookTurn\.carried\.size > 0,/)
})
