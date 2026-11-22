/**
 * A yes or no question to the owner is always two buttons to tap, never a
 * question typed in plain text.
 *
 * What this pins:
 *  - the sentence that says so (YES_NO_RULE) is in every place the agent
 *    reads about asking: the reply and ask_user_input tool descriptions, the
 *    MCP instructions that are always in context, and the offline guide;
 *  - the instructions no longer steer a confirmation away from the card
 *    ("pure confirmations (use the permission-request flow)");
 *  - `reply` takes `yes_no: true`, and that call IS an ask_user_input card of
 *    one question with the options Yes and No (values yes and no), posted
 *    pending: the same card and the same answer event, no new answer path;
 *  - the shorthand never guesses: without `yes_no: true` a reply is a reply,
 *    whatever its text says;
 *  - the card is for the agent's own chat with its owner only: in a group
 *    or a channel reply buttons name who tapped, a meeting takes
 *    text only and a side thread is read by another agent, so yes_no is
 *    refused there, with nothing posted and one plain sentence; so is any chat
 *    this connection has not proven the owner's own, before the chats load
 *    included, with a sentence that never says it is not; a session that
 *    does not hold the connection is refused with a sentence of its own
 *    that a reply can act on, never the card's "leave wait_seconds out";
 *  - those are behaviour tests of routeYesNoReply, the dispatcher's one door,
 *    plus one source check that server.ts hands it its real
 *    chat records.
 *
 * server.ts is a monolith no test can import, so its parts are read from the
 * source, CRLF normalised, as test/bundled-instructions.test.ts does.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'

import { askQuestionsError } from '../lib/ask-tracker.ts'
import { BGOS_CAPABILITIES_FALLBACK } from '../lib/capabilities.ts'
import { pickerChatAllowed } from '../lib/model-effort-rpc.ts'
import {
  REPLY_YES_NO_SHORTHAND,
  YES_NO_PASSIVE_REFUSAL,
  YES_NO_REFUSED,
  YES_NO_RULE,
  replyYesNoAsk,
  routeYesNoReply,
  yesNoRefusedKind,
  type YesNoChatRecords,
} from '../lib/yes-no-ask.ts'

const server = readFileSync(new URL('../server.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

const OPEN = '    instructions: [\n'
const CLOSE = "\n    ].join('\\n'),"

/** The instructions string exactly as server.ts hands it to the MCP Server. */
function bundledInstructions(): string {
  const open = server.indexOf(OPEN)
  assert.ok(open >= 0, 'the instructions array moved')
  const close = server.indexOf(CLOSE, open)
  assert.ok(close > open, 'the end of the instructions array moved')
  return server
    .slice(open + OPEN.length, close)
    .split('\n')
    .map((line) => (line.match(/^\s*'((?:[^'\\]|\\.)*)',$/)?.[1] ?? '').replace(/\\(.)/g, '$1'))
    .join('\n')
}

/** One tool's declaration in the ListTools answer, from its name to the next tool. */
function toolDeclaration(name: string): string {
  const at = server.indexOf(`      name: '${name}',\n      description:`)
  assert.ok(at > 0, `the ${name} tool declaration moved`)
  const next = server.indexOf('\n    {\n      name: ', at + 10)
  return server.slice(at, next > 0 ? next : undefined)
}

test('the yes or no sentence names ask_user_input, two options, Yes and No, and plain text', () => {
  assert.match(YES_NO_RULE, /yes or no/)
  assert.match(YES_NO_RULE, /ask_user_input/)
  assert.match(YES_NO_RULE, /Yes and No/)
  assert.match(YES_NO_RULE, /values yes and no/)
  assert.match(YES_NO_RULE, /never .*plain text/)
  // Only the agent's own chat with its owner, never a dangerous command.
  assert.match(YES_NO_RULE, /^In your own chat with your owner, /)
  assert.match(YES_NO_RULE, /except a dangerous command, which stays on the approval/)
  assert.match(YES_NO_RULE, /In a group or a channel, ask with reply buttons instead\.$/)
  // Injected into prompts: no em or en dashes.
  assert.doesNotMatch(YES_NO_RULE + REPLY_YES_NO_SHORTHAND, /[–—]/)
})

test('the reply and ask_user_input tool descriptions carry it, and reply names its shorthand', () => {
  const reply = toolDeclaration('reply')
  const ask = toolDeclaration('ask_user_input')
  assert.match(reply.slice(0, reply.indexOf('inputSchema')), /YES_NO_RULE/)
  assert.match(reply.slice(0, reply.indexOf('inputSchema')), /REPLY_YES_NO_SHORTHAND/)
  assert.match(ask.slice(0, ask.indexOf('inputSchema')), /YES_NO_RULE/)
  // The reply schema takes yes_no as a boolean.
  assert.match(reply, /\n {10}yes_no: \{\n {12}type: 'boolean',/)
})

test('the instructions always in context carry it, and no longer send a confirmation elsewhere', () => {
  const text = bundledInstructions()
  const section = text.slice(text.indexOf('## Asking Your Owner Questions'), text.indexOf('## Inline Buttons'))
  assert.ok(section.length > 0, 'the asking section moved')
  assert.ok(section.includes(YES_NO_RULE), 'the asking section must carry YES_NO_RULE word for word')
  assert.ok(section.includes(REPLY_YES_NO_SHORTHAND), 'the asking section must name the reply shorthand')
  assert.doesNotMatch(text, /pure confirmations/)
})

test('the offline guide carries it', () => {
  assert.ok(BGOS_CAPABILITIES_FALLBACK.includes(YES_NO_RULE))
})

test('reply with yes_no: true is one ask_user_input question with Yes and No, posted pending', () => {
  const made = replyYesNoAsk({ chat_id: '42', text: '  Should I deploy the hotfix now?  ', yes_no: true })
  assert.ok(made && 'args' in made)
  assert.deepEqual(made.args, {
    chat_id: '42',
    questions: [
      {
        text: 'Should I deploy the hotfix now?',
        options: [
          { label: 'Yes', value: 'yes' },
          { label: 'No', value: 'no' },
        ],
      },
    ],
    wait_seconds: 0,
  })
  // The card's own checks take it as it is.
  assert.equal(askQuestionsError(made.args.questions), null)
})

test('without yes_no: true a reply stays a reply, whatever its words', () => {
  assert.equal(replyYesNoAsk({ chat_id: '42', text: 'Should I go ahead?' }), null)
  assert.equal(replyYesNoAsk({ chat_id: '42', text: 'Should I go ahead?', yes_no: false }), null)
  assert.equal(replyYesNoAsk(undefined), null)
})

test('yes_no is refused, with nothing posted, when it cannot be one plain card', () => {
  for (const args of [
    { chat_id: '42', yes_no: true },
    { chat_id: '42', text: '   ', yes_no: true },
    { chat_id: '42', text: 'Ship it?', yes_no: 'true' },
    { chat_id: '42', text: 'Ship it?', yes_no: true, buttons: [{ label: 'A', value: 'a' }] },
    { chat_id: '42', text: 'Ship it?', yes_no: true, files: [{ path: '/tmp/a.png' }] },
    { chat_id: '42', text: 'Ship it?', yes_no: true, reply_to_id: 7 },
  ]) {
    const made = replyYesNoAsk(args)
    assert.ok(made && 'error' in made, `refused: ${JSON.stringify(args)}`)
    assert.match(made.error, /^Error: /)
    assert.match(made.error, /Nothing was posted/)
  }
})

/** One function body of server.ts, from its signature to the next top level close. */
function serverFunction(signature: string): string {
  const at = server.indexOf(signature)
  assert.ok(at > 0, `${signature} moved`)
  return server.slice(at, server.indexOf('\n}\n', at))
}

/** A daemon's chat records. The owner's own chat, 42, is in none of them. */
/**
 * The owner's main chats on a shared agent, as the daemon's records hold
 * them: 42 proven the owner's, 43 a share recipient's own main chat, 44 a
 * second main chat nobody has proven the owner's. 801 is in no record (an
 * email chat, or a room or a channel the daemon knows with no kind mark).
 */
const OWNERS = new Set(['42'])
const OTHERS = new Set(['43'])
function ownersOwnChat(mainChatIds: readonly string[]) {
  return (chatId: string) =>
    pickerChatAllowed({ chatId, mainChatIds, isOwners: (c) => OWNERS.has(c), isOthers: (c) => OTHERS.has(c) })
}
function records(mainChatIds: readonly string[] = ['42', '43', '44']): YesNoChatRecords {
  return {
    ownersOwnChat: ownersOwnChat(mainChatIds),
    groups: [new Set(['501'])],
    meetings: [new Map([['601', 9]]), new Set(['602'])],
    sideThreads: [
      new Set(['701']),
      new Map([['702', 'conversation']]),
      new Set(['703']),
      { has: (id: string) => id === '704' },
      { has: (id: string) => id === '705' },
    ],
  }
}

function facts(connected = true, mainChatIds?: readonly string[]) {
  return { connected, refusedKind: (chatId: unknown) => yesNoRefusedKind(String(chatId), records(mainChatIds)) }
}

function yesNoReply(chatId: string, extra: Record<string, unknown> = {}) {
  return { name: 'reply', arguments: { chat_id: chatId, text: 'Should I deploy the hotfix now?', yes_no: true, ...extra } }
}

/** Every refusal is one plain sentence that says nothing was posted. */
function assertOneSentence(refusal: string) {
  assert.match(refusal, /^Error: nothing was posted, because /)
  assert.ok(refusal.endsWith('.'))
  assert.equal(refusal.slice(0, -1).includes('. '), false, `one sentence: ${refusal}`)
  assert.doesNotMatch(refusal, /[–—]/)
}

test("in the owner's own chat a yes_no reply is sent on as the ask_user_input call", () => {
  const routed = routeYesNoReply(yesNoReply('42'), facts())
  assert.ok('params' in routed, 'not refused')
  assert.equal(routed.params.name, 'ask_user_input')
  assert.deepEqual(routed.params.arguments, {
    chat_id: '42',
    questions: [
      {
        text: 'Should I deploy the hotfix now?',
        options: [
          { label: 'Yes', value: 'yes' },
          { label: 'No', value: 'no' },
        ],
      },
    ],
    wait_seconds: 0,
  })
})

test("the owner's own main chat still posts: proven on a shared agent, or the agent's only main chat", () => {
  for (const [chatId, mains] of [['42', ['42', '43', '44']], ['42', ['42']], ['44', ['44']]] as const) {
    const routed = routeYesNoReply(yesNoReply(chatId), facts(true, mains))
    assert.ok('params' in routed, `chat ${chatId} of ${mains.join(',')} is not refused`)
    assert.equal(routed.params.name, 'ask_user_input')
  }
})

test("a share recipient's own main chat is refused, nothing posted, with the own chat sentence", () => {
  assert.deepEqual(routeYesNoReply(yesNoReply('43'), facts()), { refusal: YES_NO_REFUSED.not_own_chat })
  assert.equal(
    YES_NO_REFUSED.not_own_chat,
    "Error: nothing was posted, because yes_no is only for a chat this connection has proven is your owner's own, so ask with reply buttons here instead.",
  )
  assertOneSentence(YES_NO_REFUSED.not_own_chat)
})

test('a second main chat not proven the owner\'s is refused, nothing posted: fail closed', () => {
  assert.deepEqual(routeYesNoReply(yesNoReply('44'), facts()), { refusal: YES_NO_REFUSED.not_own_chat })
})

test('a chat in no record (an email chat, a room or a channel with no kind mark) is refused, nothing posted', () => {
  assert.deepEqual(routeYesNoReply(yesNoReply('801'), facts()), { refusal: YES_NO_REFUSED.not_own_chat })
  // Even on an agent with one main chat: only that chat is the owner's.
  assert.deepEqual(routeYesNoReply(yesNoReply('801'), facts(true, ['42'])), { refusal: YES_NO_REFUSED.not_own_chat })
})

test('before the chats load (no main chat yet) yes_no is refused, nothing posted, with the proven chat sentence', () => {
  for (const chatId of ['42', '44', '801']) {
    assert.deepEqual(routeYesNoReply(yesNoReply(chatId), facts(true, [])), { refusal: YES_NO_REFUSED.not_own_chat })
  }
  // A false refusal there (or in a brand new chat) never claims the chat is not the owner's:
  // it says the connection has not proven it yet.
  assert.match(YES_NO_REFUSED.not_own_chat, /a chat this connection has proven is your owner's own/)
  assert.doesNotMatch(YES_NO_REFUSED.not_own_chat, /not your owner|not the owner/)
})

test('no refusal says who could tap where', () => {
  for (const refusal of [...Object.values(YES_NO_REFUSED), YES_NO_PASSIVE_REFUSAL]) {
    assert.doesNotMatch(refusal, /anyone|any member|could tap/)
  }
})

test('in a group or a channel yes_no is refused, nothing posted, and the sentence names reply buttons', () => {
  assert.deepEqual(routeYesNoReply(yesNoReply('501'), facts()), { refusal: YES_NO_REFUSED.group })
  assertOneSentence(YES_NO_REFUSED.group)
  assert.equal(
    YES_NO_REFUSED.group,
    'Error: nothing was posted, because yes_no is only for your own chat with your owner, and reply buttons there name who tapped, so ask with reply buttons there instead.',
  )
})

test('in a meeting yes_no is refused, nothing posted, whichever record knows the meeting', () => {
  for (const chatId of ['601', '602']) {
    assert.deepEqual(routeYesNoReply(yesNoReply(chatId), facts()), { refusal: YES_NO_REFUSED.meeting })
  }
  assertOneSentence(YES_NO_REFUSED.meeting)
  assert.match(YES_NO_REFUSED.meeting, /text only/)
})

test('in a peer side thread yes_no is refused, nothing posted, whichever record knows the thread', () => {
  for (const chatId of ['701', '702', '703', '704', '705']) {
    assert.deepEqual(routeYesNoReply(yesNoReply(chatId), facts()), { refusal: YES_NO_REFUSED.side_thread })
  }
  assertOneSentence(YES_NO_REFUSED.side_thread)
  assert.match(YES_NO_REFUSED.side_thread, /another agent/)
})

test('a session that does not hold the connection is refused with a reply sentence, never "leave wait_seconds out"', () => {
  assert.deepEqual(routeYesNoReply(yesNoReply('42'), facts(false)), { refusal: YES_NO_PASSIVE_REFUSAL })
  assertOneSentence(YES_NO_PASSIVE_REFUSAL)
  assert.match(YES_NO_PASSIVE_REFUSAL, /yes_no/)
  assert.doesNotMatch(YES_NO_PASSIVE_REFUSAL, /wait_seconds/)
})

test('a reply without yes_no is left alone in any chat, and no other tool is ever touched', () => {
  const plain = { name: 'reply', arguments: { chat_id: '501', text: 'Should I go ahead?' } }
  const routed = routeYesNoReply(plain, facts(false))
  assert.ok('params' in routed)
  assert.equal(routed.params, plain)
  const ask = { name: 'ask_user_input', arguments: { chat_id: '501', yes_no: true, text: 'x' } }
  const same = routeYesNoReply(ask, facts())
  assert.ok('params' in same)
  assert.equal(same.params, ask)
})

test('a call that cannot be one plain card is refused for that first, wherever it was sent', () => {
  const routed = routeYesNoReply(yesNoReply('501', { buttons: [{ label: 'A', value: 'a' }] }), facts(false))
  assert.ok('refusal' in routed)
  assert.match(routed.refusal, /cannot carry buttons/)
})

test("server.ts asks routeYesNoReply for a reply before the dispatch, with its real chat records and the owner's main chat rule", () => {
  const route = server.indexOf("if (req.params.name === 'reply') {\n    const yesNo = routeYesNoReply(req.params, { connected: lockHeld, refusedKind: yesNoRefusedKindOf })")
  const swap = server.indexOf('req.params = yesNo.params', route)
  const dispatch = server.indexOf('\n  return trackMessageOperation(async () => {\n  const rawArgs', route)
  const sw = server.indexOf('switch (req.params.name) {', route)
  assert.ok(route > 0, 'the dispatcher must ask routeYesNoReply')
  assert.ok(swap > route && dispatch > swap && sw > dispatch, 'and use what it answers before the dispatch and the tool switch')
  const kindOf = serverFunction('function yesNoRefusedKindOf(rawChatId: unknown): YesNoRefusedKind | null {')
  assert.match(kindOf, /groups: \[groupChatIds\]/)
  assert.match(kindOf, /meetings: \[meetingIdByChatId, meetingChatIds\]/)
  assert.match(kindOf, /sideThreads: \[peerSideThreadChats, peerConvByChat, closedPeerChats, peerReplyRefusedChats, a2aRouteRefusedChats\]/)
  // The owner's own main chat, by the picker's one rule (pickerChatAllowed): owner only, main only.
  assert.match(kindOf, /ownersOwnChat: modelEffortChatAllowed,/)
  // Fail closed: a chat this daemon does not know, or cannot resolve, is refused. Only a
  // known chat is resolved, so resolveAuthorizedChat never logs a refusal twice.
  assert.match(kindOf, /if \(!monitoredChatSet\.has\(raw\) && !knownSessionHandles\.has\(raw\)\) return 'not_own_chat'/)
  assert.match(kindOf, /if \(!auth\.ok\) return 'not_own_chat'/)
})
