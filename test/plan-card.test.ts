/**
 * The plan card: the wire shape, the three chips, the revision chain, and the
 * one sentence this channel is not allowed to leave out.
 *
 * Every pin here stands for something that would be wrong on the owner's
 * screen rather than merely wrong in the code. The card is an `event` row with
 * options, so an app that has never heard of `plan_card` still shows chips that
 * work; the chips are CODES, so the app relabels them and Arabic comes free;
 * `enforced` is false, because nothing on this channel can stop an edit; and a
 * revision retires the card it replaces, because two live plans in one chat is
 * the failure the supersede exists to prevent.
 *
 * Run with: npx tsx --test test/plan-card.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  PENDING_PLAN_FAST_MAX_MS,
  PLAN_AGENT_ROUTE,
  planCardChatRefusal,
  PLAN_CARD_KIND,
  PLAN_CARD_PAYLOAD_VERSION,
  PLAN_CHIP_CHANGE,
  PLAN_CHIP_GO,
  PLAN_CHIP_NO,
  PLAN_ENFORCED_ON_THIS_CHANNEL,
  PLAN_STATUS_TEXT,
  PLAN_STATUS_TTL_MINUTES,
  PLAN_CHECK_MAX,
  PLAN_STEPS_MAX,
  PLAN_STEP_CHECK_MAX,
  PLAN_STEP_TEXT_MAX,
  PLAN_TITLE_MAX,
  buildPlanCardBody,
  buildPlanCardPayload,
  buildPlanRetireBody,
  buildPlanSupersedeBody,
  describePlanClick,
  isPlanCardPayload,
  missedPlanAnswers,
  nextPlanIdentity,
  parsePlanSupersedes,
  pendingPlanFastChatIds,
  planAnswerDirective,
  planChipFor,
  resolvePlanChoice,
  planCardOptions,
  planCardPeek,
  planCardText,
  planChoiceOf,
  planStatusBody,
  planStatusClearBody,
  type PendingPlan,
  type PlanCardPayload,
} from '../lib/plan-card.ts'
import { escapeAgentButtonValue, unescapeAgentButtonValue } from '../lib/message-text.ts'

const ID = { planId: 'p9-abc-0001', revision: 1 }

function goodInput(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: 'Cache the boards list so it opens warm',
    summary: 'Keep the query and stop unmounting the pane.',
    steps: [
      { text: 'Hoist the board query to the chat root', file: 'src/boards/useBoards.ts' },
      { text: 'Keep the pane mounted when the chat switches', file: 'src/chat/ChatPane.tsx' },
    ],
    files: ['src/boards/useBoards.ts', 'src/chat/ChatPane.tsx'],
    check: 'Open a board, switch chats, come back: no spinner, same scroll position.',
    ...over,
  }
}

function payloadOf(over: Record<string, unknown> = {}): PlanCardPayload {
  const built = buildPlanCardPayload(goodInput(over), ID)
  assert.ok(built.ok, `expected a payload, got ${built.ok ? '' : built.error}`)
  return built.payload
}

// ── The shape on the wire ────────────────────────────────────────────────────

test('the card is an event row with the plan_card kind AND the chips under it', () => {
  // Both halves together are the whole design: the kind is what draws the card,
  // and the options are what an app that does not know the kind falls back to.
  // Drop either and the plan is unanswerable on some installed version.
  const body = buildPlanCardBody({ chatId: 77, payload: payloadOf() })
  assert.ok(body.ok)
  assert.equal(body.body.messageType, 'event')
  assert.equal(body.body.eventMeta.payload.kind, PLAN_CARD_KIND)
  assert.equal(body.body.eventMeta.payload.v, PLAN_CARD_PAYLOAD_VERSION)
  assert.equal(body.body.options.length, 3)
  assert.equal(body.body.renderMode, 'inline')
  assert.equal(body.body.sender, 'assistant')
  assert.equal(body.body.chatId, 77)
})

test('the body never carries assistantId (the route resolves the author from the credential)', () => {
  // The backend whitelist shadow log caught exactly this field arriving from a
  // daemon on the messages route. buildPermissionRequestBody omits it for the
  // same reason and this body follows.
  const body = buildPlanCardBody({ chatId: 77, payload: payloadOf() })
  assert.ok(body.ok)
  assert.ok(!('assistantId' in body.body), 'assistantId must not be sent')
})

test('enforced is FALSE, because nothing on this channel can stop an edit', () => {
  // The app picks the chip's words off this flag. `true` would put "read only
  // until approved" on screen over an agent launched with permissions skipped.
  assert.equal(PLAN_ENFORCED_ON_THIS_CHANNEL, false)
  assert.equal(payloadOf().enforced, false)
})

test('the three chips are codes with tiers, not words the plugin chose', () => {
  const options = planCardOptions()
  assert.deepEqual(
    options.map((o) => o.callbackData),
    [PLAN_CHIP_GO, PLAN_CHIP_CHANGE, PLAN_CHIP_NO],
  )
  assert.deepEqual(
    options.map((o) => o.style),
    ['success', 'default', 'danger'],
  )
  // The English text is only what an app that predates the codes draws, and
  // it is SPEC SECTION 1's three words exactly: an app that cannot relabel
  // must still show the owner the buttons the design names. It read "Do not do
  // this" here, which is nobody's wording but this file's.
  assert.deepEqual(
    options.map((o) => o.text),
    ['Go ahead', 'Change the plan', "Don't do this"],
  )
  // The codes are namespaced so the app can relabel them in the owner's own
  // language.
  for (const option of options) {
    assert.ok(option.callbackData.startsWith('plan:'), option.callbackData)
    assert.ok(option.text.length > 0)
  }
})

test('an agent-authored button can never forge a plan answer', () => {
  // `plan:` is a reserved prefix, so an agent `reply` button whose value is
  // "plan:go" is escaped to "u:plan:go" and cannot be mistaken on the way back
  // for the owner approving a real plan.
  const source = readFileSync(new URL('../lib/message-text.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  assert.match(source, /RESERVED_VALUE_PREFIXES\s*=\s*\[[^\]]*'plan:'/)
})

test('the canonical text carries the plan itself, for every surface without the card', () => {
  const text = planCardText(payloadOf())
  assert.match(text, /Cache the boards list/)
  assert.match(text, /1\. Hoist the board query/)
  assert.match(text, /src\/chat\/ChatPane\.tsx/)
  assert.match(text, /Check\. Open a board/)
  assert.match(text, /Nothing changes until you answer\./)
})

test('the peek counts what the owner is approving', () => {
  assert.equal(
    planCardPeek(payloadOf()),
    '2 steps, 2 files. Nothing changes until you answer.',
  )
  assert.equal(
    planCardPeek(payloadOf({ steps: [{ text: 'One thing' }], files: undefined })),
    '1 step. Nothing changes until you answer.',
  )
})

// ── Validation: structure refuses, prose clamps ──────────────────────────────

test('a plan with no steps is refused, not posted half formed', () => {
  const noSteps = buildPlanCardPayload(goodInput({ steps: [] }), ID)
  assert.equal(noSteps.ok, false)
  const noTitle = buildPlanCardPayload(goodInput({ title: '   ' }), ID)
  assert.equal(noTitle.ok, false)
})

test('more than thirty steps is refused by number, so the model can fix it', () => {
  const many = Array.from({ length: PLAN_STEPS_MAX + 1 }, (_, i) => ({ text: `step ${i}` }))
  const built = buildPlanCardPayload(goodInput({ steps: many }), ID)
  assert.equal(built.ok, false)
  assert.match(built.ok ? '' : built.error, /30 or fewer/)
})

test('prose over its cap is clamped rather than losing the whole plan', () => {
  const payload = payloadOf({
    title: 'x'.repeat(PLAN_TITLE_MAX + 40),
    steps: [{ text: 'y'.repeat(PLAN_STEP_TEXT_MAX + 40) }],
  })
  assert.equal(payload.title.length, PLAN_TITLE_MAX)
  assert.equal(payload.steps[0]!.text.length, PLAN_STEP_TEXT_MAX)
})

test("a STEP's check is clamped at 200, which is not the card's 300", () => {
  // Two caps, and the served schema is where they are decided:
  // backend/src/renderables/renderables-manifest.ts caps steps.items.check at
  // 200 and the card's own check at 300. This file used one number for both,
  // so a long per step check shipped a payload the schema an agent discovers
  // calls invalid. Nothing on screen would have shown it.
  assert.equal(PLAN_STEP_CHECK_MAX, 200)
  assert.equal(PLAN_CHECK_MAX, 300)
  const payload = payloadOf({
    check: 'c'.repeat(PLAN_CHECK_MAX + 80),
    steps: [{ text: 'a', check: 'v'.repeat(PLAN_CHECK_MAX + 80) }],
  })
  assert.equal(payload.steps[0]!.check!.length, PLAN_STEP_CHECK_MAX)
  assert.equal(payload.check!.length, PLAN_CHECK_MAX)
})

test('an unknown step tag is refused, and the three real ones are kept', () => {
  const bad = buildPlanCardPayload(goodInput({ steps: [{ text: 'a', tag: 'maybe' }] }), ID)
  assert.equal(bad.ok, false)
  const good = payloadOf({
    steps: [
      { text: 'a', tag: 'unchanged' },
      { text: 'b', tag: 'CHANGED' },
      { text: 'c', tag: 'dropped' },
    ],
  })
  assert.deepEqual(good.steps.map((s) => s.tag), ['unchanged', 'changed', 'dropped'])
})

test('door "mode" is refused on this channel, because no mode was switched', () => {
  // Codex has a real read only plan mode and sends it. A Claude Code daemon
  // that claimed it would put "Plan mode is on" under a card nothing enforced.
  const built = buildPlanCardPayload(goodInput({ door: 'mode' }), ID)
  assert.equal(built.ok, false)
  assert.equal(payloadOf({ door: 'typed' }).door, 'typed')
  assert.equal(payloadOf().door, 'decided')
})

test('the payload names its own route, so a sweep can tell whose card it is', () => {
  assert.equal(payloadOf().agent_route, PLAN_AGENT_ROUTE)
})

// ── The revision chain ───────────────────────────────────────────────────────

test('supersedes is read before the payload, and a bad one is refused', () => {
  assert.deepEqual(parsePlanSupersedes(undefined), { ok: true })
  assert.deepEqual(parsePlanSupersedes(''), { ok: true })
  assert.deepEqual(parsePlanSupersedes(412), { ok: true, supersedes: 412 })
  assert.equal(parsePlanSupersedes(0).ok, false)
  assert.equal(parsePlanSupersedes('later').ok, false)
})

test('a revision keeps the plan id and counts up', () => {
  const open: PendingPlan = {
    chatId: '5',
    messageId: 900,
    planId: 'p9-first',
    revision: 2,
    postedAtMs: 0,
    payload: payloadOf(),
    requesterUserId: 'owner',
  }
  assert.deepEqual(
    nextPlanIdentity({ supersedes: 900, open, mintPlanId: () => 'MINTED' }),
    { planId: 'p9-first', revision: 3 },
  )
})

test('a revision after a restart starts a new plan, and never claims revision 2', () => {
  // The daemon that posted the first card is gone, so there is nothing to count
  // from. Inventing revision 2 off a number the model supplied would label the
  // card with a history this process cannot vouch for.
  assert.deepEqual(
    nextPlanIdentity({ supersedes: 900, open: null, mintPlanId: () => 'MINTED' }),
    { planId: 'MINTED', revision: 1 },
  )
  // A supersedes that does not match the open card is the same situation.
  const open: PendingPlan = {
    chatId: '5',
    messageId: 901,
    planId: 'p9-first',
    revision: 1,
    postedAtMs: 0,
    payload: payloadOf(),
    requesterUserId: 'owner',
  }
  assert.deepEqual(
    nextPlanIdentity({ supersedes: 900, open, mintPlanId: () => 'MINTED' }),
    { planId: 'MINTED', revision: 1 },
  )
})

test('the supersede PATCH strips the chips AND flips the payload to superseded', () => {
  // Both halves matter: without the empty options the old card stays tappable
  // and a tap approves a plan the agent has withdrawn; without the state the
  // app cannot dim it or say what replaced it.
  const previous = payloadOf()
  const body = buildPlanSupersedeBody(previous)
  assert.deepEqual(body.options, [])
  const meta = body.eventMeta as { payload: PlanCardPayload }
  assert.equal(meta.payload.state, 'superseded')
  assert.equal(meta.payload.kind, PLAN_CARD_KIND)
  // The steps survive: a superseded card keeps what it said.
  assert.deepEqual(meta.payload.steps, previous.steps)
  // And the original object is untouched.
  assert.equal(previous.state, 'proposed')
})

// ── The answer ───────────────────────────────────────────────────────────────

test('only the three plan codes are plan answers', () => {
  assert.equal(planChoiceOf(PLAN_CHIP_GO), 'go')
  assert.equal(planChoiceOf(PLAN_CHIP_CHANGE), 'change')
  assert.equal(planChoiceOf(PLAN_CHIP_NO), 'no')
  assert.equal(planChoiceOf('u:plan:go'), null)
  assert.equal(planChoiceOf('__custom__'), null)
  assert.equal(planChoiceOf(undefined), null)
})

test('an agent authored plan:go button is NOT a plan answer, in the real order', () => {
  // THE ORDER IS THE TEST. An agent CAN author a reply button and give it any
  // value it likes. Every agent value goes out namespaced (`u:` + the value)
  // exactly so it cannot come back as one of this plugin's control codes, and
  // that protection is worth nothing if the intake unescapes BEFORE it
  // classifies: `u:plan:go` becomes `plan:go` and settles a real plan the
  // owner never answered. So this runs the whole wire round trip rather than
  // asserting on a string the intake never produces.
  const onTheWire = escapeAgentButtonValue('plan:go')
  assert.equal(onTheWire, 'u:plan:go')
  assert.equal(
    resolvePlanChoice({ callbackData: onTheWire, onPlanCard: false }),
    null,
    'classified off the RAW value, an agent button is not a plan answer',
  )
  // And the value the agent authored still reaches it intact afterwards.
  assert.equal(unescapeAgentButtonValue(onTheWire), 'plan:go')
  // The mistake this replaces, written out: unescape first and the answer is
  // a real approval.
  assert.equal(planChoiceOf(unescapeAgentButtonValue(onTheWire)), 'go')
})

test('the typed revision arrives as __custom__, so the CARD is what names it', () => {
  // THE WHOLE CHANGE ARM AGAINST THE REAL WIRE. `plan:change` never comes
  // back: the chip arms the composer, and Send posts
  // `{ sentinel: 'custom', customText }` with no optionId, which the backend
  // stores as `__custom__`. Classified on the code alone the revision was read
  // as an ordinary custom reply: no settle, no directive, and the model read
  // `Custom reply: "drop step 2"`.
  assert.equal(resolvePlanChoice({ callbackData: '__custom__', onPlanCard: true }), 'change')
  // And only on the card. Every other message in the app has a Custom reply
  // affordance and none of them is a plan.
  assert.equal(resolvePlanChoice({ callbackData: '__custom__', onPlanCard: false }), null)
  // The two ordinary chips carry their option, so the code alone is enough.
  assert.equal(resolvePlanChoice({ callbackData: PLAN_CHIP_GO, onPlanCard: false }), 'go')
  assert.equal(resolvePlanChoice({ callbackData: PLAN_CHIP_NO, onPlanCard: true }), 'no')
  // A card answered with some other sentinel is not one of the three.
  assert.equal(resolvePlanChoice({ callbackData: '__skip__', onPlanCard: true }), null)
})

test('the answer carries the code the model was promised, not the sentinel', () => {
  // Every surface that tells the model what to expect (the tool description,
  // the instructions, the canon) names plan:go / plan:change / plan:no. Two of
  // the three arrive that way; the revision arrives as __custom__ because the
  // chip arms the composer instead of answering. The daemon puts the promised
  // code back on the meta rather than leaving the model to reconcile the two.
  assert.equal(planChipFor('go'), PLAN_CHIP_GO)
  assert.equal(planChipFor('change'), PLAN_CHIP_CHANGE)
  assert.equal(planChipFor('no'), PLAN_CHIP_NO)
})

test('Change the plan reads as what the owner SAID, not as a button label', () => {
  // The app posts the typed revision as custom_text on the click, so the
  // generic wording would render it `Custom reply: "make it shorter"`, which
  // reads as a label. This is the whole reason the plan wording exists.
  assert.equal(
    describePlanClick({
      choice: 'change',
      customText: 'drop step 2, it is not needed',
    }),
    'Change the plan: drop step 2, it is not needed',
  )
  assert.equal(describePlanClick({ choice: 'change' }), 'Change the plan (no words given)')
})

test('a plan answer is named off the CODE, so a relabelled chip stays readable', () => {
  // The app relabels these chips in the owner's own language, so the
  // button_text that comes back can be Arabic. That is right on screen and
  // useless in a transcript a model reads to decide what to do next, where
  // "Clicked: <arabic>" cannot tell Go ahead from Don't do this.
  assert.equal(describePlanClick({ choice: 'go' }), 'Clicked: Go ahead')
  assert.equal(describePlanClick({ choice: 'no' }), "Clicked: Don't do this")
  assert.equal(describePlanClick({ choice: null }), null)
})

// The answer that landed while nobody was listening -------------------------

test('a plan card is recognised from its own payload, and nothing else is', () => {
  assert.equal(isPlanCardPayload(payloadOf()), true)
  assert.equal(isPlanCardPayload({ ...payloadOf(), agent_route: 'codex' }), false)
  assert.equal(isPlanCardPayload({ kind: 'approval_request', agent_route: PLAN_AGENT_ROUTE }), false)
  assert.equal(isPlanCardPayload(null), false)
  assert.equal(isPlanCardPayload('plan_card'), false)
})

test('a plan answered while the daemon was down is found, once, and only ours', () => {
  // A tap is announced only on a live transition (seen unanswered on a
  // previous poll), and after a restart nothing was seen unanswered, so an
  // answer that landed while this daemon was down reached the model never.
  // A plan is designed to be answered tomorrow, so this is the plan wait's
  // main way of ending in silence.
  const boot = 5_000_000
  const row = (over: Record<string, unknown> = {}) => ({
    id: 11,
    sender: 'assistant',
    messageType: 'event',
    answeredAt: '2026-09-23T09:00:00.000Z',
    createdAt: boot - 60_000,
    hasOptions: true,
    eventMeta: { payload: payloadOf() },
    ...over,
  })
  assert.deepEqual(
    missedPlanAnswers([row()], { createdBefore: boot }).map((r) => r.id),
    [11],
  )
  // Unanswered: the ordinary live path will announce it, this must not.
  assert.deepEqual(missedPlanAnswers([row({ answeredAt: null })], { createdBefore: boot }), [])
  // ALREADY SWEPT. The chips are what make it findable, and the caller strips
  // them as it announces, so no second boot can announce the same answer.
  // That is the idempotence, and it needs no new file on disk.
  assert.deepEqual(missedPlanAnswers([row({ hasOptions: false })], { createdBefore: boot }), [])
  // Another daemon's card, and another kind of card entirely.
  assert.deepEqual(
    missedPlanAnswers([row({ eventMeta: { payload: { kind: 'plan_card', agent_route: 'codex' } } })], {
      createdBefore: boot,
    }),
    [],
  )
  assert.deepEqual(missedPlanAnswers([row({ eventMeta: null })], { createdBefore: boot }), [])
  // Written after this process started: not this process's to speak for.
  assert.deepEqual(missedPlanAnswers([row({ createdAt: boot + 1 })], { createdBefore: boot }), [])
  assert.deepEqual(missedPlanAnswers([row({ createdAt: null })], { createdBefore: boot }), [])
  // And the owner's own message, which carries no cards at all.
  assert.deepEqual(missedPlanAnswers([row({ sender: 'user' })], { createdBefore: boot }), [])
})

test('a retire with no payload to rebuild still takes the chips off', () => {
  // The fallback a revision uses when this process has no record of the card
  // it is replacing (a restart mid wait, or a model naming an older card).
  // Stripping the chips is the half that matters: it is what stops a tap
  // approving a plan the agent has withdrawn.
  assert.deepEqual(buildPlanRetireBody(), { options: [] })
})

test('each answer carries what to do next, because the click is the whole instruction', () => {
  assert.match(planAnswerDirective('go'), /Carry it out now/)
  assert.match(planAnswerDirective('change'), /Do NOT start work/)
  assert.match(planAnswerDirective('change'), /supersedes/)
  assert.match(planAnswerDirective('no'), /wait for new instructions/)
})

// ── The wait ─────────────────────────────────────────────────────────────────

test('the status line asks for the longest TTL the server will store', () => {
  // A plan wait has no end, so the honest choice is the DTO ceiling rather than
  // the two hour default that would leave the line gone and the card live.
  assert.equal(PLAN_STATUS_TTL_MINUTES, 1440)
  assert.deepEqual(planStatusBody(), {
    statusText: PLAN_STATUS_TEXT,
    ttlMinutes: 1440,
  })
  assert.deepEqual(planStatusClearBody(), { statusText: '' })
})

test('a chat with an open plan is fast polled for half an hour, and then is not', () => {
  // The honest asymmetry: a click has one transport on this plugin and it is
  // the poll. Inside the scope a tap lands in seconds, outside it on the five
  // minute sweep. Thirty minutes is the bound and the test says the number.
  assert.equal(PENDING_PLAN_FAST_MAX_MS, 30 * 60_000)
  const now = 10_000_000
  const open = [
    { chatId: '1', postedAtMs: now - 60_000 },
    { chatId: '2', postedAtMs: now - PENDING_PLAN_FAST_MAX_MS - 1 },
    { chatId: '3', postedAtMs: now + 5_000 },
  ]
  assert.deepEqual(pendingPlanFastChatIds(open, now), ['1'])
})

test('the chat id resolves to a number or the body is refused', () => {
  assert.equal(buildPlanCardBody({ chatId: 'handle-abc', payload: payloadOf() }).ok, false)
  assert.equal(buildPlanCardBody({ chatId: 0, payload: payloadOf() }).ok, false)
})

test('a session handle is preferred on the way back when there is one', () => {
  const body = buildPlanCardBody({ chatId: 5, payload: payloadOf(), sessionHandle: 'sh_x' })
  assert.ok(body.ok)
  assert.equal(body.body.sessionHandle, 'sh_x')
  const bare = buildPlanCardBody({ chatId: 5, payload: payloadOf() })
  assert.ok(bare.ok)
  assert.ok(!('sessionHandle' in bare.body))
})

// ── The sentence that cannot be dropped ──────────────────────────────────────

test('the tool description and the instructions both say nothing enforces the wait', () => {
  // This is the claim Kc signed off on and the one a later edit would quietly
  // lose: the card promises "Nothing changes until you answer" and this channel
  // cannot keep that promise for the agent. If either surface stops saying so,
  // the honest framing is gone and only this test notices.
  const server = readFileSync(new URL('../server.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  const toolBlock = server.slice(
    server.indexOf("name: 'propose_plan'"),
    server.indexOf("name: 'edit_message'"),
  )
  assert.ok(toolBlock.length > 0, 'propose_plan must be declared before edit_message')
  const flat = toolBlock.replace(/'\s*\+\s*'/g, '')
  assert.match(flat, /NOTHING IN THIS CHANNEL ENFORCES IT/)
  assert.match(flat, /runs with permissions skipped/)
  assert.match(flat, /The wait is a promise you are making/)
  // And the same sentence in the instructions string the model reads at start.
  const instructions = server.replace(/',\s*'/g, '')
  assert.match(instructions, /NOTHING IN THIS CHANNEL ENFORCES THE WAIT/)
})

test('a plan card is refused in a chat the owner cannot answer it in', () => {
  // THE FINDING. resolveAuthorizedChat answers membership, and the monitored
  // set GROWS with every inbound, so the a2a side thread the model was just
  // handed is an accepted target. Posting there blocked the agent for a day on
  // an answer nobody could give: the owner never opens an a2a chat (it is
  // excluded from the chat list), the needs you queue filters on kind, and the
  // push follows the chat owner. The reachable trigger is the plan LEVEL,
  // which rides a peer turn on purpose.
  const side = planCardChatRefusal({ isPeerSideThread: true, isMeetingRoom: false })
  assert.ok(typeof side === 'string' && side.length > 0)
  assert.match(side!, /side thread/)
  assert.match(side!, /owner/)
  const room = planCardChatRefusal({ isPeerSideThread: false, isMeetingRoom: true })
  assert.ok(typeof room === 'string' && room.length > 0)
  assert.match(room!, /room/)
  // The owner's own chat is neither, and is the only chat a card belongs in.
  assert.equal(
    planCardChatRefusal({ isPeerSideThread: false, isMeetingRoom: false }),
    null,
  )
})

test('the refusal tells the model where the plan belongs, not that an id was bad', () => {
  // The model did nothing wrong: it answered the turn it was given, in the one
  // chat that turn named. An error about ids would read as a bug and be
  // retried; a sentence about where a plan belongs is actionable.
  for (const message of [
    planCardChatRefusal({ isPeerSideThread: true, isMeetingRoom: false })!,
    planCardChatRefusal({ isPeerSideThread: false, isMeetingRoom: true })!,
  ]) {
    assert.match(message, /propose the plan in (their|your owner's) chat/)
    assert.ok(!/chat_id/.test(message), 'not an error about identifiers')
  }
})

test('propose_plan asks the question before it posts anything', () => {
  // A refusal after the POST is not a refusal. The check must sit between the
  // authorization and the payload build, so a refused card leaves no row, no
  // status line and no fast scope entry behind.
  const server = readFileSync(new URL('../server.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  const tool = server.slice(
    server.indexOf("case 'propose_plan': {"),
    server.indexOf('const built = buildPlanCardPayload('),
  )
  assert.ok(tool.length > 0, 'propose_plan must build its payload after the gates')
  assert.match(tool, /planCardChatRefusal\(\{/)
  assert.match(tool, /isPeerSideThread: peerConvByChat\.has\(planChatId\)/)
  assert.match(tool, /isMeetingRoom: meetingChatIds\.has\(planChatId\)/)
  assert.ok(
    tool.indexOf('planCardChatRefusal') < tool.indexOf('nextPlanIdentity('),
    'the chat question is asked before a plan id is minted',
  )
})

test('the stale /clear and /cost advertisement is gone from the instructions', () => {
  // The instructions told the model /clear and /cost were in the catalog. They
  // were removed from BUILTIN_COMMANDS on 2026-08-30 and pinned as removed by
  // test/slash-catalog.test.ts, so the model was being handed a list of
  // commands that would come back "unavailable".
  const server = readFileSync(new URL('../server.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  assert.ok(
    !server.includes("'this plugin syncs on boot (built-in commands like `/help`, `/clear`,'"),
    'the instructions must not advertise /clear as a synced builtin',
  )
  assert.match(server, /`\/clear` and `\/cost` are NOT in that catalog/)
})
