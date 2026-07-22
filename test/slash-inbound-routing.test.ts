/**
 * Behavioral routing tests plus narrow production wiring guards. The shared
 * route is the code both transport handlers execute, so payload classification
 * and directive construction are exercised without starting the daemon.
 */

import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  BUILTIN_COMMANDS,
  prepareSlashCommands,
  routeSlashCommand,
  shouldSkipForwardedSlashCommand,
} from '../lib/slash-catalog.ts'
import { resolveAgentOrigin } from '../lib/a2a-inbound.ts'

const prepared = prepareSlashCommands(BUILTIN_COMMANDS)

function route(payload: Record<string, unknown>, sourceContent = '') {
  return routeSlashCommand({
    payload,
    sourceContent,
    registry: prepared.registry,
    legacyAliases: prepared.legacyAliases,
  })
}

function assertAllStrings(meta: Record<string, string>): void {
  for (const value of Object.values(meta)) assert.equal(typeof value, 'string')
}

test('poll and WebSocket payload shapes reach the same actionable production route', () => {
  const cases = [
    {
      transport: 'poll',
      payload: {
        messageType: 'slash_command',
        commandName: 'help',
        commandArgs: 'topic one',
        text: '/help topic one',
      },
    },
    {
      transport: 'ws snake aliases',
      payload: {
        message_type: 'slash_command',
        command_name: 'help',
        command_args: 'topic one',
        text: '/help topic one',
      },
    },
  ]

  for (const { transport, payload } of cases) {
    const result = route(payload, '/help topic one')
    assert.equal(result.kind, 'directive', `${transport} must dispatch`)
    if (result.kind !== 'directive') continue
    assert.notEqual(result.delivery.content, '/help topic one')
    assert.match(result.delivery.content, /Execute its registered behavior now/)
    assert.equal(result.delivery.meta.command_name, 'help')
    assert.equal(result.delivery.meta.command_args, 'topic one')
    assert.equal(result.delivery.meta.slash_dispatch, 'actionable_directive')
    assertAllStrings(result.delivery.meta)
  }
})

test('structured slash fields dispatch even with empty redundant text', () => {
  const result = route({
    messageType: 'slash_command',
    commandName: 'cost',
    commandArgs: '',
    text: '',
  })

  assert.equal(result.kind, 'directive')
  if (result.kind === 'directive') {
    assert.ok(result.delivery.content.length > 0)
    assert.equal(result.delivery.registeredCommand?.command, '/cost')
  }
})

test('compact routes to the daemon for both transports and never constructs a directive', () => {
  for (const payload of [
    { messageType: 'slash_command', commandName: 'compact', commandArgs: '' },
    { message_type: 'slash_command', text: '/compact' },
  ]) {
    const result = route(payload)
    assert.deepEqual(result, {
      kind: 'compact',
      commandName: 'compact',
      commandArgs: '',
    })
    assert.equal('delivery' in result, false)
  }
})

test('ordinary channel text never enters slash dispatch', () => {
  assert.deepEqual(
    route({ messageType: 'text', text: '/help' }, '/help'),
    { kind: 'not_slash' },
  )
})

test('slash delivery dedupes both poll first and WebSocket first arrival orders', () => {
  const payload = {
    messageType: 'slash_command',
    commandName: 'help',
    commandArgs: '',
  }
  const forwarded = new Set<number>()

  // Poll first claims the id, so the generic WebSocket cache check suppresses
  // the delayed frame.
  assert.equal(shouldSkipForwardedSlashCommand(payload, 41, forwarded), false)
  forwarded.add(41)
  assert.equal(forwarded.has(41), true)

  // WebSocket first records the id, so the production poll guard suppresses
  // the boot replay while the cursor still advances after the batch.
  forwarded.clear()
  forwarded.add(42)
  assert.equal(shouldSkipForwardedSlashCommand(payload, 42, forwarded), true)

  // Ordinary text keeps the existing replay safety behavior.
  assert.equal(
    shouldSkipForwardedSlashCommand({ messageType: 'standard' }, 42, forwarded),
    false,
  )
})

const serverSource = readFileSync(new URL('../server.ts', import.meta.url), 'utf8')

function sliceBetween(start: string, end: string): string {
  const startIndex = serverSource.indexOf(start)
  assert.notEqual(startIndex, -1, `missing source anchor ${start}`)
  const endIndex = serverSource.indexOf(end, startIndex + start.length)
  assert.notEqual(endIndex, -1, `missing source anchor ${end}`)
  return serverSource.slice(startIndex, endIndex)
}

const pollInbound = sliceBetween(
  'for (const msg of newUserMessages)',
  '// Advance the cursor only now',
)
const wsInbound = sliceBetween(
  "realtimeSocket.on('inbound_message'",
  "realtimeSocket.on('peer_conversation_closed'",
)

test('both live handlers call the tested route and send its content and metadata', () => {
  for (const [transport, source] of [
    ['poll', pollInbound],
    ['ws', wsInbound],
  ] as const) {
    assert.match(source, /routeSlashCommand\(\{/,
      `${transport} must call the production route`)
    assert.match(source, /registry: registeredSlashCommands/,
      `${transport} must use the published registry`)
    assert.match(source, /legacyAliases: registeredSlashCommandAliases/,
      `${transport} must preserve upgrade aliases`)
    assert.match(source, /slashDelivery\?\.content \?\? originalContent/,
      `${transport} must send the directive rather than bare slash text`)
    assert.match(source, /\.\.\.\(slashDelivery \? slashDelivery\.meta : \{\}\)/,
      `${transport} must attach the all string slash metadata`)
  }
})

test('compact remains daemon handled after the shared deliverability gate', () => {
  const cases = [
    { transport: 'poll', source: pollInbound, emptyGuard: 'if (!content) continue' },
    { transport: 'ws', source: wsInbound, emptyGuard: 'if (!content) return' },
  ]

  for (const { transport, source, emptyGuard } of cases) {
    const compactIndex = source.indexOf("slashRoute.kind === 'compact'")
    const daemonIndex = source.indexOf('handleRemoteCompact(')
    const deliveryIndex = source.indexOf("slashRoute.kind === 'directive'")
    const emptyIndex = source.indexOf(emptyGuard)
    const actionContentIndex = source.indexOf("'[daemon compact request]'")
    assert.ok(compactIndex >= 0, `${transport} compact check missing`)
    assert.ok(actionContentIndex > deliveryIndex, `${transport} compact must be a deliverable action`)
    assert.ok(emptyIndex > actionContentIndex, `${transport} action must pass the empty guard`)
    assert.ok(daemonIndex > compactIndex, `${transport} compact must call the daemon handler`)
    assert.ok(daemonIndex > emptyIndex, `${transport} compact must run only after validation`)
  }
})

test('poll slash routing bypasses meeting text handling and marks delivery for WS dedupe', () => {
  const classificationIndex = pollInbound.indexOf(
    'const isSlashCommand =',
  )
  const meetingIndex = pollInbound.indexOf(
    'if (meetingId != null && meetingCtx && !isSlashCommand)',
  )
  const skipIndex = pollInbound.indexOf('shouldSkipForwardedSlashCommand(')
  const rememberIndex = pollInbound.indexOf('rememberForwarded(msg.message.id)')
  const routeIndex = pollInbound.indexOf('routeSlashCommand({')
  assert.ok(classificationIndex >= 0)
  assert.ok(skipIndex > classificationIndex)
  assert.ok(meetingIndex > classificationIndex)
  assert.ok(routeIndex > meetingIndex)
  assert.ok(rememberIndex > routeIndex)
  assert.match(wsInbound, /if \(forwardedMessageIds\.has\(messageId\)\) return/)
})

test('agent provenance cannot enter user slash dispatch or reserved compact handling', () => {
  assert.ok(
    resolveAgentOrigin({
      sender: 'user',
      sender_assistant_id: 12,
      sender_name: 'Research Agent',
      messageType: 'slash_command',
      commandName: 'compact',
    }),
    'bare persisted sender_assistant_id must activate the non-user gate',
  )
  assert.match(
    pollInbound,
    /pollAgentOrigin === null && isSlashCommandPayload\(msg\.message\)/,
  )
  assert.match(
    wsInbound,
    /wsAgentOrigin === null && isSlashCommandPayload\(payload \?\? \{\}\)/,
  )
  for (const [transport, source] of [
    ['poll', pollInbound],
    ['ws', wsInbound],
  ] as const) {
    assert.match(
      source,
      /const slashRoute = is(?:Ws)?SlashCommand\s+\? routeSlashCommand\(\{/,
      `${transport} must call slash routing only after the non-agent gate`,
    )
  }
})

function buildPollSlashMeta(input: {
  payload: Record<string, unknown>
  backlog: boolean
  sessionHandle?: unknown
}): Record<string, unknown> {
  const result = route(input.payload, String(input.payload.text ?? ''))
  assert.equal(result.kind, 'directive')
  if (result.kind !== 'directive') return {}

  return {
    chat_id: String(input.payload.chatId),
    message_id: String(input.payload.id),
    user: 'User',
    user_id: String(input.payload.senderUserId),
    assistant_id: String(73),
    ts: String(input.payload.sentDate ?? '2026-07-22T00:00:00.000Z'),
    ...(typeof input.sessionHandle === 'string' && input.sessionHandle
      ? { session_handle: String(input.sessionHandle) }
      : {}),
    ...(input.backlog ? { backlog: 'true' } : {}),
    transport: 'poll',
    ...result.delivery.meta,
  }
}

test('poll native slash envelope has only string metadata and omits absent optionals', () => {
  const basePayload = {
    id: 99,
    chatId: 1001,
    senderUserId: 88,
    sentDate: null,
    text: '/help topic',
    messageType: 'slash_command',
    commandName: 'help',
    commandArgs: 'topic',
  }

  const live = buildPollSlashMeta({
    payload: basePayload,
    backlog: false,
    sessionHandle: null,
  })
  assertAllStrings(live as Record<string, string>)
  assert.equal(live.chat_id, '1001')
  assert.equal(live.message_id, '99')
  assert.equal(live.user_id, '88')
  assert.equal(live.assistant_id, '73')
  assert.equal(live.command_args, 'topic')
  assert.equal('session_handle' in live, false)
  assert.equal('backlog' in live, false)

  const backlog = buildPollSlashMeta({
    payload: basePayload,
    backlog: true,
    sessionHandle: 'session_abc',
  })
  assertAllStrings(backlog as Record<string, string>)
  assert.equal(backlog.backlog, 'true')
  assert.equal(backlog.session_handle, 'session_abc')
})

test('local registry is ready before boot delivery and catalog publishing uses the auth scoped contract', () => {
  const main = sliceBetween('async function main()', 'main().catch((err) =>')
  const registryIndex = main.indexOf('await refreshSlashCommandRegistry()')
  const pollIndex = main.indexOf('await pollAllChats()')
  const wsIndex = main.indexOf('connectWebsocket()')
  assert.ok(registryIndex >= 0)
  assert.ok(pollIndex > registryIndex)
  assert.ok(wsIndex > registryIndex)

  const sync = sliceBetween(
    'const slashCommandSyncRunner',
    '// ── Always-on reconcile',
  )
  assert.match(sync, /bgosPut\(slashCommandSyncPath\(AUTH\.mode, ASSISTANT_ID\)/)
  assert.match(sync, /commands: plan\.wireCommands/)
})
