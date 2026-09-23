/**
 * The plan card's wiring: /plan, /code, the owner's plan level, and the chip
 * colour tier.
 *
 * These are the pieces that live in shared files rather than in plan-card.ts,
 * and each one has a specific way of being half done. /plan must carry a
 * PROCEDURE or it joins the sixteen commands that produced confident wrong
 * answers. /code must be answered by the daemon or the owner's own close button
 * comes back "unavailable". The plan level must reach all three transports or
 * the agent behaves differently depending on whether the socket was healthy.
 * And the style must survive the reply path or every chip renders neutral,
 * which is where this started.
 *
 * Run with: npx tsx --test test/plan-wiring.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  BUILTIN_COMMANDS,
  buildSlashCommandDelivery,
  isPlanModeOffSlashCommand,
  prepareSlashCommands,
  routeSlashCommand,
} from '../lib/slash-catalog.ts'
import {
  PLAN_POLICY_MARKER_PREFIX,
  buildInboundChannel,
  buildPlanPolicyMarker,
  readPlanPolicyField,
} from '../lib/inbound-channel.ts'
import { REPLY_BUTTON_STYLES, normalizeButtonStyle } from '../lib/message-text.ts'
import { fastScopeChatIds } from '../lib/poll-core.ts'

// Normalized to LF: the working tree is CRLF on a Windows checkout (core.autocrlf)
// and LF in git, so a source assertion written against one of them would pass on
// exactly one operating system.
const SERVER = readFileSync(new URL('../server.ts', import.meta.url), 'utf8').replace(
  /\r\n/g,
  '\n',
)

// ── /plan ────────────────────────────────────────────────────────────────────

test('/plan is advertised and carries a real procedure, not a label', () => {
  // test/slash-catalog.test.ts's rule, restated where the entry lives: the
  // difference between a command that works over this channel and one that
  // produces an invention is whether the model was handed steps.
  const entry = BUILTIN_COMMANDS.find((c) => c.command === '/plan')
  assert.ok(entry, '/plan must be advertised: propose_plan makes it genuinely performable')
  assert.ok(typeof entry!.prompt === 'string' && entry!.prompt.trim().length > 0)
  assert.match(entry!.prompt!, /propose_plan/)
  assert.match(entry!.prompt!, /STOP THERE/)
  assert.match(entry!.prompt!, /supersedes/)
  assert.ok(entry!.description.length <= 100, 'the backend caps a description at 100')
})

test("/plan's procedure says plainly that nothing enforces the wait", () => {
  // The owner is told the same thing on their side. If only one half says it,
  // one of the two is lying.
  const entry = BUILTIN_COMMANDS.find((c) => c.command === '/plan')!
  assert.match(entry.prompt!, /NOTHING IN THIS CHANNEL ENFORCES THAT WAIT/)
  assert.match(entry.prompt!, /permissions skipped/)
})

test('the catalogue stays learnable with /plan on it', () => {
  // The same ceiling test/slash-catalog.test.ts pins: ten was the limit chosen
  // when sixteen unusable names were removed, and /plan takes the tenth slot.
  assert.ok(
    BUILTIN_COMMANDS.length <= 10,
    `advertising ${BUILTIN_COMMANDS.length} builtins is back toward the wall of options`,
  )
})

test('/plan never leaks its procedure onto the backend catalog', () => {
  const { wireCommands } = prepareSlashCommands(BUILTIN_COMMANDS)
  const wire = wireCommands.find((c) => c.command === 'plan')
  assert.ok(wire, '/plan must reach the picker')
  assert.ok(!('prompt' in wire!), 'the body is local; a long field here 400s the whole sync')
})

test('a /plan turn is dispatched as an actionable directive with the procedure inline', () => {
  const { registry } = prepareSlashCommands(BUILTIN_COMMANDS)
  const route = routeSlashCommand({
    payload: { messageType: 'slash_command', commandName: 'plan', commandArgs: 'cache the board' },
    registry,
  })
  assert.equal(route.kind, 'directive')
  assert.ok(route.kind === 'directive')
  assert.equal(route.delivery.meta.command_name, 'plan')
  assert.equal(route.delivery.meta.slash_dispatch, 'actionable_directive')
  assert.equal(route.delivery.meta.registered_command, '/plan')
  assert.match(route.delivery.content, /<registered_command_instructions>/)
  assert.match(route.delivery.content, /propose_plan/)
  assert.match(route.delivery.content, /cache the board/)
})

test('the three transports all arm the verifier off the delivery, not off the raw payload', () => {
  // An alias resolved by the registry has to be recognised the way the MODEL
  // sees it, and all three rails have to do it: a /plan that armed on one
  // transport only would complain or stay silent depending on socket health.
  assert.equal(
    (SERVER.match(/noteSlashPlanDelivery\(/g) ?? []).length,
    4,
    'one declaration plus exactly three call sites (poll, stream, ws)',
  )
  assert.match(SERVER, /delivery\.meta\.command_name !== 'plan'/)
})

// ── /code, the chip's close ──────────────────────────────────────────────────

test('/code is the chip close and is answered by the daemon, never by the model', () => {
  assert.equal(isPlanModeOffSlashCommand('code'), true)
  assert.equal(isPlanModeOffSlashCommand('/CODE'), true)
  assert.equal(isPlanModeOffSlashCommand('codex'), false)
  const { registry } = prepareSlashCommands(BUILTIN_COMMANDS)
  const route = routeSlashCommand({
    payload: { messageType: 'slash_command', commandName: 'code' },
    registry,
  })
  assert.equal(route.kind, 'plan_mode_off')
})

test('a project command named /code cannot shadow the close button', () => {
  // Checked before the registry, the same rule /status already follows. If a
  // local command could take the name, the owner would be left with a chip
  // they cannot dismiss.
  const { registry } = prepareSlashCommands([
    ...BUILTIN_COMMANDS,
    { command: '/code', description: 'write some code', scope: 'all', prompt: 'do it' },
  ])
  const route = routeSlashCommand({
    payload: { messageType: 'slash_command', commandName: 'code' },
    registry,
  })
  assert.equal(route.kind, 'plan_mode_off')
})

test('/code is NOT advertised in the picker: it is a button, not a command', () => {
  assert.ok(!BUILTIN_COMMANDS.some((c) => c.command === '/code'))
})

test('all three transports answer /code', () => {
  assert.equal(
    (SERVER.match(/onPlanModeOff\(/g) ?? []).length,
    4,
    'one declaration plus exactly three call sites (poll, stream, ws)',
  )
  assert.equal((SERVER.match(/slashRoute\.kind === 'plan_mode_off'/g) ?? []).length, 3)
})

test('an UNREGISTERED slash command still answers honestly on a channel that cannot plan', () => {
  // The design leans on this branch for every other channel, so it is pinned
  // here: the model is told to say it is unavailable and not to invent.
  const delivery = buildSlashCommandDelivery({
    commandName: 'plan',
    commandArgs: 'do the thing',
    registry: new Map(),
  })
  assert.equal(delivery.registeredCommand, null)
  assert.match(delivery.content, /No matching command is registered/)
  assert.match(delivery.content, /Do not invent behavior/)
})

// ── The owner's plan level on the envelope ───────────────────────────────────

test('the plan level is read in both spellings, and blanks are absent', () => {
  assert.equal(readPlanPolicyField({ planPolicy: '  Plan first.  ' }), 'Plan first.')
  assert.equal(readPlanPolicyField({ plan_policy: 'Plan first.' }), 'Plan first.')
  assert.equal(readPlanPolicyField({ planPolicy: '   ' }), null)
  assert.equal(readPlanPolicyField({}), null)
  assert.equal(readPlanPolicyField(null), null)
})

test('the level is rendered into the CONTENT the model reads, not only into meta', () => {
  // meta is a bag of channel attributes; a standing instruction that lives only
  // there is one the model reads as a label. The peer and system markers are
  // the precedent for putting the handling rule in the body of the turn.
  const delivery = buildInboundChannel({
    chatId: 1,
    messageId: 2,
    userId: 3,
    assistantId: 4,
    transport: 'poll',
    text: 'refactor the poll loop',
    planPolicy: 'This agent shows a plan first for bigger or risky jobs.',
  })
  assert.ok(delivery.content.startsWith(PLAN_POLICY_MARKER_PREFIX))
  assert.match(delivery.content, /bigger or risky jobs/)
  assert.match(delivery.content, /refactor the poll loop/)
  assert.equal(delivery.meta.plan_policy, 'This agent shows a plan first for bigger or risky jobs.')
})

test('the marker tells the model what the level is AND that nothing enforces it', () => {
  const marker = buildPlanPolicyMarker('This agent shows a plan first, every time.')
  assert.match(marker, /propose_plan/)
  assert.match(marker, /Go ahead/)
  assert.match(marker, /Nothing on this channel enforces that wait/)
})

test('a turn with no level carries nothing new at all', () => {
  const bare = buildInboundChannel({
    chatId: 1,
    messageId: 2,
    userId: 3,
    assistantId: 4,
    transport: 'poll',
    text: 'hello',
  })
  assert.equal(bare.content, 'hello')
  assert.ok(!('plan_policy' in bare.meta))
})

test('a peer or system turn keeps its own marker at the top, with the level above it', () => {
  // The peer marker's position is load bearing (the daemon checks for it byte
  // for byte when it hydrates), so the level is added around it, never inside.
  const peer = buildInboundChannel({
    chatId: 1,
    messageId: 2,
    userId: 3,
    assistantId: 4,
    transport: 'ws',
    text: 'have a look at this',
    agentOrigin: { sourceAssistantId: 8, sourceName: 'Ada' },
    planPolicy: 'Only when asked.',
  })
  assert.ok(peer.content.startsWith(PLAN_POLICY_MARKER_PREFIX))
  assert.match(peer.content, /\[Peer message from agent Ada \(assistant id 8\)/)
  assert.match(peer.content, /have a look at this/)
})

test('all three transports pass the level, so behaviour never depends on socket health', () => {
  assert.equal(
    (SERVER.match(/planPolicy: readPlanPolicyField\(/g) ?? []).length,
    3,
    'poll, stream and ws must each pass the level',
  )
  assert.match(SERVER, /planPolicy: readPlanPolicyField\(msg\.message\)/)
  assert.match(SERVER, /planPolicy: readPlanPolicyField\(view\.raw\)/)
  assert.match(SERVER, /planPolicy: readPlanPolicyField\(payload\)/)
})

test('the daemon never reads the owner level from the server, it renders what it is handed', () => {
  // Stage 1's rule, and the reason the level rides the envelope rather than
  // being fetched: the daemon offers, the server decides.
  const inbound = readFileSync(new URL('../lib/inbound-channel.ts', import.meta.url), 'utf8')
  assert.ok(!/assistants\/\$\{|bgosGet|fetch\(/.test(inbound))
})

// ── The chip colour tier ─────────────────────────────────────────────────────

test('a reply button may ask for a tier, and an unknown one is dropped not refused', () => {
  // A reply that fails to send because a chip wanted a colour that does not
  // exist is a worse outcome than a neutral chip, and neutral is what every app
  // rendered before the tier existed.
  assert.equal(normalizeButtonStyle('success'), 'success')
  assert.equal(normalizeButtonStyle('  DANGER '), 'danger')
  assert.equal(normalizeButtonStyle('neon'), null)
  assert.equal(normalizeButtonStyle(7), null)
  assert.equal(normalizeButtonStyle(undefined), null)
})

test('the tiers are exactly the four the backend DTO accepts', () => {
  // An unlisted value is a 400 on the WHOLE message, not a dropped field.
  assert.deepEqual([...REPLY_BUTTON_STYLES], ['default', 'primary', 'success', 'danger'])
})

test('the reply path carries the tier through to the option it posts', () => {
  assert.match(SERVER, /const style = normalizeButtonStyle\(b\.style\)/)
  assert.match(SERVER, /\.\.\.\(style \? \{ style \} : \{\}\)/)
  assert.match(SERVER, /style\?: string/)
})

// ── The fast scope ───────────────────────────────────────────────────────────

test('a chat with an open plan joins the fast scope beside meetings and prompts', () => {
  assert.deepEqual(
    fastScopeChatIds({
      meetingChatIds: ['1'],
      pendingPermissionChatIds: ['2'],
      buttonPromptChatIds: ['3'],
      pendingPlanChatIds: ['4', '1'],
    }),
    ['1', '2', '3', '4'],
  )
  // And an older caller that passes nothing still works.
  assert.deepEqual(
    fastScopeChatIds({ meetingChatIds: [], pendingPermissionChatIds: ['2'] }),
    ['2'],
  )
})

test('the scheduler actually asks for the plan chats', () => {
  assert.match(SERVER, /pendingPlanChatIds: pendingPlanFastChatIds\(/)
  assert.match(SERVER, /openPlansByChat\.values\(\)/)
})

// ── The answer, end to end through the intake ────────────────────────────────

test('a plan answer settles the wait: status down, scope released, chip reported off', () => {
  // All three are one call, so a future edit cannot half-settle a plan and
  // leave the agent reading "Waiting for your go ahead" forever.
  const fn = SERVER.slice(
    SERVER.indexOf('function settlePlan('),
    SERVER.indexOf('function postPlanVerifierLine('),
  )
  assert.ok(fn.length > 0, 'settlePlan must be declared before postPlanVerifierLine')
  assert.match(fn, /openPlansByChat\.delete\(chatId\)/)
  assert.match(fn, /clearPlanStatusLine\(\)/)
  assert.match(fn, /reportSessionMode\(chatId, 'default'\)/)
  // And the intake calls it on any of the three codes, not just Go ahead.
  assert.match(SERVER, /if \(planChoice !== null\) settlePlan\(chatId\)/)
})

test('the plan wording replaces the generic click wording, and only for plan codes', () => {
  assert.match(SERVER, /const summary =\n\s*planSummary \?\?/)
  assert.match(SERVER, /if \(planChoice !== null\) contentLines\.push\(planAnswerDirective\(planChoice\)\)/)
})

test('a revision retires the old card BEFORE it posts the new one', () => {
  // Reversed, a failed retire leaves two live plan cards in one chat and a tap
  // on the older one approves a plan the agent has already withdrawn. This way
  // a failure costs the new card, which the model can retry.
  const block = SERVER.slice(
    SERVER.indexOf("case 'propose_plan': {"),
    SERVER.indexOf("case 'edit_message': {"),
  )
  assert.ok(block.length > 0)
  const retireAt = block.indexOf('buildPlanSupersedeBody')
  const postAt = block.indexOf('bgosPost(')
  assert.ok(retireAt > 0 && postAt > 0, 'both calls must be present')
  assert.ok(retireAt < postAt, 'the retire PATCH must run before the post')
})
