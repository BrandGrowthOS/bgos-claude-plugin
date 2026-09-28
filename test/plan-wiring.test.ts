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
  createPlanPolicyMemo,
  readPlanPolicyField,
} from '../lib/inbound-channel.ts'
import { REPLY_BUTTON_STYLES, normalizeButtonStyle } from '../lib/message-text.ts'
import { planSettlement } from '../lib/plan-card.ts'
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

test('the Plan mode chip belongs to the TYPED door, never to a decided card', () => {
  // Design spec section 4: this channel reports `plan` when it delivers a
  // /plan DIRECTIVE and `default` when the plan is answered or /code arrives.
  // propose_plan reported `plan` for EVERY card, so a plan the agent chose to
  // show under its owner's level wrote a session mode onto an ordinary chat:
  // the composer grew a Plan mode chip and a gold ring the owner never asked
  // for, and an unanswered card left them up until a hand typed /code. Codex
  // gates its own three mode effects on the same distinction (planModeChat).
  const at = SERVER.indexOf("reportSessionMode(planChatId, 'plan')")
  assert.ok(at > 0, 'propose_plan must still report the mode for a typed plan')
  const gate = SERVER.slice(SERVER.lastIndexOf('if (', at), at)
  assert.match(gate, /payload\.door === 'typed'/)
  // AND the door is checked against the daemon's own record of the same fact.
  // `door` is a free field the model fills, so `typed` alone is the model's
  // word for "the owner typed /plan": believed, it PATCHes a persisted session
  // mode and puts a chip, a gold ring and a changed placeholder on a chat
  // nobody switched. The verifier is armed at DELIVERY of a real /plan and is
  // cancelled a few lines below, so it is still armed here on a genuine typed
  // door. Codex resolves the same question from two sources for the same
  // reason (planModeChat reads the payload AND the host's store).
  assert.match(gate, /isPlanVerifierArmed\(planVerifiers, planChatId\)/)
  // The directive delivery is the other half and is unconditional: that is
  // where a typed /plan lights the chip, before any card exists.
  assert.match(SERVER, /reportSessionMode\(chatId, 'plan'\)/)
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

test('the POLL ROW does not carry the level, and a row shaped like a real one proves it', () => {
  // THE FINDING, and the reason the old guard here was a call site count. The
  // poll rail reads `GET /chats/:chatId/messages`, which is the app's chat
  // history projection: GetMessageDto and MessageDto declare no `planPolicy`
  // and no `senderGuardrail`, so the read returned null on EVERY poll delivery
  // and an owner on `risky_jobs` or `always` got an agent planning at the
  // default for every turn the poll won. Counting three call sites and
  // asserting the poll one reads `msg.message` could never see that, because
  // it never asked what `msg.message` can hold.
  const pollRow = {
    // Exactly the fields the daemon reads off one entry of that envelope.
    id: 9001,
    chatId: 12,
    text: 'refactor the uploader',
    sender: 'user',
    sentDate: '2026-09-23T10:00:00.000Z',
    messageType: 'text',
    answeredAt: null,
    eventMeta: null,
  }
  assert.equal(readPlanPolicyField(pollRow), null)
  const delivered = buildInboundChannel({
    chatId: 12,
    messageId: 9001,
    userId: 'u1',
    assistantId: 4,
    transport: 'poll',
    text: pollRow.text,
    planPolicy: readPlanPolicyField(pollRow),
  })
  assert.equal(delivered.content, 'refactor the uploader')
  assert.ok(!('plan_policy' in delivered.meta))
})

test('the memo carries the level onto the poll rail, so one turn is one behaviour', () => {
  const memo = createPlanPolicyMemo()
  // Nothing learned yet: the poll says nothing rather than inventing a level.
  assert.equal(memo.recall(), null)
  // A rail that CARRIES the field teaches it.
  assert.equal(
    memo.learn({ planPolicy: 'This agent shows a plan first, every time.' }),
    'This agent shows a plan first, every time.',
  )
  const pollDelivery = buildInboundChannel({
    chatId: 12,
    messageId: 9002,
    userId: 'u1',
    assistantId: 4,
    transport: 'poll',
    text: 'refactor the uploader',
    planPolicy: readPlanPolicyField({ id: 9002, text: 'x' }) ?? memo.recall(),
  })
  assert.ok(pollDelivery.content.startsWith(PLAN_POLICY_MARKER_PREFIX))
  assert.match(pollDelivery.content, /every time/)
})

test('ABSENCE on a carrying rail is an observation, so a level turned back down stops', () => {
  // The backend OMITS the key at the default level. If absence were treated as
  // "nothing new to learn", an owner who moved from `always` back to the
  // default would keep the old sentence on every poll turn for ever.
  const memo = createPlanPolicyMemo()
  memo.learn({ planPolicy: 'This agent shows a plan first, every time.' })
  assert.equal(memo.learn({ id: 7 }), null)
  assert.equal(memo.recall(), null)
})

test('the poll reads the ROW FIRST, so a backend that ever adds the field wins', () => {
  const memo = createPlanPolicyMemo()
  memo.learn({ planPolicy: 'The stale one.' })
  assert.equal(
    readPlanPolicyField({ id: 1, planPolicy: 'The row is authoritative.' }) ??
      memo.recall(),
    'The row is authoritative.',
  )
})

test('each transport is wired to the reader that suits its rail', () => {
  // Kept as a source assertion because it is about WHICH function each call
  // site uses, which no unit test of a pure function can see. The behaviour of
  // each function is pinned above.
  assert.match(
    SERVER,
    /planPolicy: readPlanPolicyField\(msg\.message\) \?\? planPolicyMemo\.recall\(\)/,
    'the poll rail reads the row, then the memo',
  )
  assert.match(SERVER, /planPolicy: planPolicyMemo\.learn\(view\.raw\)/)
  assert.match(SERVER, /planPolicy: planPolicyMemo\.learn\(payload\)/)
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
    SERVER.indexOf('function applyPlanAnswer('),
  )
  assert.ok(fn.length > 0, 'settlePlan must be declared before applyPlanAnswer')
  assert.match(fn, /openPlansByChat\.delete\(chatId\)/)
  assert.match(fn, /clearPlanStatusLine\(\)/)
  assert.match(fn, /reportSessionMode\(chatId, 'default'\)/)
})

test('the chip only comes DOWN on a chat something could have put it UP on', () => {
  // `shouldReportSessionMode(undefined, 'default')` returns true by design, so
  // an unconditional report here fired a PATCH on the first answer of a
  // DECIDED door card in an ordinary chat and wrote chats.session_mode to the
  // NULL it already held. That is not free: chats_sidebar_bump_trigger carries
  // no column list, so the write bumps the owner's sidebar version and every
  // connected client refetches assistants-with-chats for a field that did not
  // change. The lane's own migration says so in as many words. Codex gates all
  // three of its mode effects the same way (inPlanMode in handlePlanClick).
  const fn = SERVER.slice(
    SERVER.indexOf('function settlePlan('),
    SERVER.indexOf('function applyPlanAnswer('),
  )
  assert.match(fn, /function settlePlan\(chatId: string, wasPlanMode: boolean\)/)
  // The gate itself is pinned behaviourally on planSettlement above. What this
  // asserts is that settlePlan still ASKS it, with both of the inputs the rule
  // needs, rather than reporting on its own.
  assert.match(fn, /wasPlanMode,/)
  assert.match(fn, /lastReportedMode: lastSessionModeByChat\.get\(chatId\)/)
  assert.match(
    fn,
    /if \(settlement\.reportDefaultMode\) reportSessionMode\(chatId, 'default'\)/,
    'the default report must be gated on a door that could have lit the chip',
  )
  // The answer to "could it have" is read off the ANSWERED ROW, so a restarted
  // daemon still takes the chip down: this process's record first, the row's
  // own payload second, which is the pair that survives a restart.
  const caller = SERVER.slice(
    SERVER.indexOf('function applyPlanAnswer('),
    SERVER.indexOf('/** Post the daemon'),
  )
  assert.match(caller, /openPlansByChat\.get\(input\.chatId\)\?\.payload\.door/)
  assert.match(caller, /isPlanCardPayload\(input\.eventMetaPayload\)/)
  assert.match(caller, /settlePlan\(input\.chatId, answeredDoor !== undefined && answeredDoor !== 'decided'\)/)
  // The explicit /code path is NOT gated: there the owner asked for it.
  const off = SERVER.slice(
    SERVER.indexOf('function onPlanModeOff('),
    SERVER.indexOf('function onPlanModeOff(') + 400,
  )
  assert.match(off, /reportSessionMode\(chatId, 'default'\)/)
  assert.ok(!/wasPlanMode/.test(off), '/code reports unconditionally')
})

test('the two reports survive a restart, and the DECISION says so, not a regex', () => {
  // THE FINDING, twice over. `if (!openPlansByChat.delete(chatId)) return`
  // gated the two things the OWNER can see (the status line beside the agent
  // and the session mode the composer chip is drawn from) on a map this
  // process loses on every restart. Then the guard written for it was two
  // source assertions, and a RECORDED MUTATION walked straight through them:
  // `if (!openPlansByChat.has(chatId)) return` as the first statement of
  // settlePlan reproduced the whole regression with the plan suites green,
  // because `return` was not at the start of its line.
  //
  // So the rule is a pure function now and this is a behavioural case: a
  // daemon that holds NO record still takes both of the owner's things down.
  const restarted = planSettlement({ hasLocalRecord: false, wasPlanMode: true })
  assert.equal(restarted.forgetLocalRecord, false, 'there is nothing to delete')
  assert.equal(restarted.clearStatusLine, true, 'the line is server side')
  assert.equal(restarted.reportDefaultMode, true, 'so is the chip')

  // And the gate on the report, which is about the DOOR and nothing local: a
  // `decided` card answered in an ordinary chat writes nothing, because the
  // sidebar bump trigger has no column list and the write is not free.
  assert.equal(
    planSettlement({ hasLocalRecord: true, wasPlanMode: false }).reportDefaultMode,
    false,
  )
  // Unless this process reported `plan` for the chat itself, which is the
  // /plan directive's own chip.
  assert.equal(
    planSettlement({
      hasLocalRecord: true,
      wasPlanMode: false,
      lastReportedMode: 'plan',
    }).reportDefaultMode,
    true,
  )
  assert.equal(
    planSettlement({
      hasLocalRecord: true,
      wasPlanMode: false,
      lastReportedMode: 'default',
    }).reportDefaultMode,
    false,
  )
})

test('settlePlan still has no early return, on a guard a one line return cannot pass', () => {
  const fn = SERVER.slice(
    SERVER.indexOf('function settlePlan('),
    SERVER.indexOf('function applyPlanAnswer('),
  )
  assert.ok(
    !/if \(!openPlansByChat\.delete\(chatId\)\) return/.test(fn),
    'an early return on the local record is what broke the restart case',
  )
  // COMMENTS STRIPPED, then ANY `return` token, not a line anchored one. The
  // anchored version was green on `if (!openPlansByChat.has(chatId)) return`,
  // and the substring version was red on the word "returns" in the prose, so
  // neither half of this can be dropped.
  const body = fn
    .slice(fn.indexOf('{'))
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
  assert.ok(!/\breturn\b/.test(body), 'nothing in settlePlan may bail out early')
})

test('a /plan that produced no plan takes its own chip back down', () => {
  // THE FINDING. onPlanDirectiveDelivered reports `plan` on delivery, which is
  // what lights the composer chip and the gold ring. The only two things that
  // ever cleared it were an answered card (settlePlan) and a typed /code
  // (onPlanModeOff), and neither can happen on this ending: the definition of
  // this ending is that no card exists. So the chat kept a "Plan mode" chip
  // over nothing pending, across restarts, and PLAN_VERIFIER_MESSAGE never
  // mentions /code, so the owner was not told the exit either.
  const fn = SERVER.slice(
    SERVER.indexOf('function onPlanVerifierExpired('),
    SERVER.indexOf("/** Post the daemon's own line"),
  )
  assert.ok(fn.length > 0, 'onPlanVerifierExpired must be declared before postPlanVerifierLine')
  assert.match(fn, /postPlanVerifierLine\(chatId\)/)
  assert.match(
    fn,
    /reportSessionMode\(chatId, 'default'\)/,
    'the directive is spent, so the mode it announced is spent too',
  )
})

test('both verifier fire sites end through that one function', () => {
  // Same reason the click intake has one plan half: the Stop hook settles this
  // where the hook rail is installed and the poll tick settles it where it is
  // not, so a rule written into whichever site somebody was looking at is a
  // chip that clears or does not clear depending on the install.
  assert.equal(
    (SERVER.match(/onPlanVerifierExpired\(due\.chatId\)/g) ?? []).length,
    2,
    'the turn end and the poll tick must both go through onPlanVerifierExpired',
  )
  // And neither of them may reach past it to the bare POST.
  assert.ok(
    !/postPlanVerifierLine\(due\.chatId\)/.test(SERVER),
    'a fire site that posts the line directly leaves the chip up',
  )
})

test('the plan half of a click runs on BOTH transports, from one function', () => {
  // There are two complete click intakes and they are mutually exclusive per
  // click: whichever arrives first marks the id in the shared announced set
  // and the other stays silent. So a plan rule in one of them only is not a
  // dormant duplicate, it is a plan that settles or does not settle depending
  // on whether the socket happened to be healthy. Counted the way
  // noteSlashPlanDelivery is counted, for the same reason.
  assert.equal(
    (SERVER.match(/applyPlanAnswer\(/g) ?? []).length,
    4,
    'one declaration plus exactly three call sites (poll, stream, boot sweep)',
  )
  // And each intake hands it the RAW callbackData plus the row, never the
  // agent-unescaped value.
  assert.match(SERVER, /callbackData,\n\s*customText,\n\s*eventMetaPayload: mm\.eventMeta\?\.payload,/)
  assert.match(
    SERVER,
    /callbackData: answer\.callbackData,\n\s*customText: answer\.customText,\n\s*eventMetaPayload: view\.eventMetaRaw\?\.payload,/,
  )
})

test('the plan classification happens BEFORE the agent unescape, on both rails', () => {
  // The reserved `plan:` namespace protects nothing if the intake unescapes
  // first: every agent button goes out as `u:` + its value, so `u:plan:go`
  // would be turned back into `plan:go` and read as the owner approving a real
  // plan. The permission intake has always classified off the raw value; these
  // two now do the same, and the ORDER is the guard.
  const poll = SERVER.slice(
    SERVER.indexOf('const permOutcome = resolvePermissionClick({'),
    SERVER.indexOf('const kind ='),
  )
  assert.ok(poll.length > 0)
  assert.ok(
    poll.indexOf('applyPlanAnswer({') < poll.indexOf('unescapeAgentButtonValue('),
    'the poll must classify the plan answer before it unescapes',
  )
  const stream = SERVER.slice(
    SERVER.indexOf('const planAnswer = applyPlanAnswer({\n    chatId,'),
    SERVER.indexOf('const contentLines = [\n    `[button_clicked] ${summary}`'),
  )
  assert.ok(stream.length > 0, 'the stream rail must call applyPlanAnswer')
  assert.ok(
    stream.indexOf('applyPlanAnswer({') < stream.indexOf('unescapeAgentButtonValue('),
    'the stream must classify the plan answer before it unescapes',
  )
})

test('the plan wording and the directive replace the generic ones everywhere', () => {
  assert.equal(
    (SERVER.match(/planAnswer\.summary \?\?/g) ?? []).length,
    3,
    'the poll, the stream and the boot sweep must all prefer the plan wording',
  )
  assert.equal(
    (SERVER.match(/if \(planAnswer\.directive\) contentLines\.push\(planAnswer\.directive\)/g) ?? [])
      .length,
    3,
    'the poll, the stream and the boot sweep must all carry the directive',
  )
})

test('all three deliveries put the promised plan code back on the meta', () => {
  // A revision arrives under the __custom__ sentinel, so without this the
  // model would be handed callback_data __custom__ on an event every one of
  // its instructions calls plan:change.
  assert.equal(
    (SERVER.match(/planAnswer\.callbackData \?\?/g) ?? []).length,
    3,
    'the poll, the stream and the boot sweep must all relabel the code',
  )
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

test('a revision retires whenever supersedes is given, record or no record', () => {
  // THE FINDING. Gating the PATCH on `openPlan?.messageId === supersedes`
  // meant that the two cases the retire exists for, a daemon restarted mid
  // wait and a model naming an older card, skipped it silently and posted the
  // new card anyway: two answerable plans in one chat. The fallback strips the
  // chips without the dimmed payload, which is the half that matters.
  const block = SERVER.slice(
    SERVER.indexOf("case 'propose_plan': {"),
    SERVER.indexOf("case 'edit_message': {"),
  )
  assert.match(block, /if \(payload\.supersedes !== undefined\) \{/)
  assert.ok(
    !/payload\.supersedes !== undefined && openPlan\?\.messageId === payload\.supersedes/.test(block),
    'the retire must not be gated on the in-memory record',
  )
  // And the full body is used only for the card this process can actually
  // rebuild, never the other way round.
  assert.match(
    block,
    /openPlan\?\.messageId === payload\.supersedes\n\s*\? buildPlanSupersedeBody\(openPlan\.payload\)\n\s*: buildPlanRetireBody\(\)/,
  )
})

// The answer that landed while nobody was listening -------------------------

test('boot sweeps for plan answers this daemon was not running to hear', () => {
  // A tap is announced only on a live transition, so an answer that landed
  // while the daemon was down reached the model never: no error, no log line,
  // the owner sees Approved. A plan is designed to be answered tomorrow, which
  // is what turns a benign property into the plan wait's main silent failure.
  const fn = SERVER.slice(
    SERVER.indexOf('async function announceMissedPlanAnswers('),
    SERVER.indexOf('function noteSlashPlanDelivery('),
  )
  assert.ok(fn.length > 0, 'the sweep must be declared before noteSlashPlanDelivery')
  assert.match(fn, /missedPlanAnswers\(/)
  assert.match(fn, /createdBefore: DAEMON_START_MS - SWEEP_CLOCK_SKEW_MARGIN_MS/)
  assert.match(fn, /cacheKey: `plan-sweep:\$\{chatId\}`/)
  // The chips come off BEFORE the announce, which is what makes the sweep
  // idempotent across restarts with nothing persisted: a card with no chips is
  // no longer found. A failed announce costs one delivery; a failed strip
  // after a successful announce would repeat it on every boot.
  const retireAt = fn.indexOf('buildPlanRetireBody()')
  const announceAt = fn.indexOf('mcp.notification(')
  assert.ok(retireAt > 0 && announceAt > 0)
  assert.ok(retireAt < announceAt, 'strip the chips before announcing')
  assert.match(fn, /rememberAnnouncedClick\(row\.id\)/)
  // And it is wired into the boot, after discovery, unawaited like the
  // permission sweep it sits beside.
  assert.match(SERVER, /void phase\('plan answer sweep', \(\) => announceMissedPlanAnswers\(\)\)/)
})
