/**
 * An answer to a permission request counts only on the card this daemon
 * posted for it.
 *
 * A request id is five letters the CLI mints, and nothing on the server makes
 * it unique to one card: any approval card in a chat this daemon reads can
 * carry buttons naming the same id. So the pending request remembers the
 * message id of the card it posted, and a click settles it only when the row
 * the click was given on is that card. The watch's own card read
 * (`answeredOn` in waitForVerdict) is bound to that row too, so a tap the
 * intakes refuse while the post is in flight is read there a tick later.
 *
 * Run with: npx tsx --test test/permission-card-binding.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

import {
  PERMISSION_CLICK_RE,
  resolvePermissionClick,
  type PendingPermissionLike,
  type PermissionChoice,
} from '../lib/permission-relay.ts'
import { decideButtonsAnswered, viewStreamMessage, buildStreamClickMeta, streamCardRowId } from '../lib/stream-apply.ts'
import { ownerAnnounceRefused, ownerLaneVerdict } from '../lib/lane-core.mjs'
import { LOGIN_METHOD_WINDOW_MS } from '../lib/auth-login.ts'

const REQ = 'abcde'
const OWNER = 'user-owner'
const CARD = 501
const OTHER_CARD = 777

function held(cardMessageId?: number | null): {
  pending: Map<string, PendingPermissionLike>
  answered: PermissionChoice[]
} {
  const answered: PermissionChoice[] = []
  const entry: PendingPermissionLike = { requesterUserId: OWNER, resolve: (c) => answered.push(c) }
  if (cardMessageId !== undefined) entry.cardMessageId = cardMessageId
  return { pending: new Map([[REQ, entry]]), answered }
}

// ── The shared resolver ──────────────────────────────────────────────────────

test('a yes given on another card that names the same request id settles nothing', () => {
  const { pending, answered } = held(CARD)
  const outcome = resolvePermissionClick({
    callbackData: `ea:once:${REQ}`,
    clickerUserId: OWNER,
    pending,
    cardMessageId: OTHER_CARD,
  })
  assert.equal(outcome.kind, 'other_card')
  assert.deepEqual(answered, [], 'the request is not settled')
  assert.equal(pending.has(REQ), true, 'the request keeps waiting for its own card')
  if (outcome.kind === 'other_card') {
    assert.equal(outcome.cardMessageId, OTHER_CARD)
    assert.equal(outcome.expectedCardMessageId, CARD)
  }
})

test('the same answer given on the card this daemon posted settles the request', () => {
  for (const [callbackData, choice] of [
    [`ea:once:${REQ}`, 'once'],
    [`ea:deny:${REQ}`, 'deny'],
  ] as const) {
    const { pending, answered } = held(CARD)
    const outcome = resolvePermissionClick({ callbackData, clickerUserId: OWNER, pending, cardMessageId: CARD })
    assert.equal(outcome.kind, 'resolved')
    assert.deepEqual(answered, [choice])
    assert.equal(pending.has(REQ), false)
  }
})

test('a deny given on another card is refused too: only the posted card answers its request', () => {
  const { pending, answered } = held(CARD)
  const outcome = resolvePermissionClick({
    callbackData: `ea:deny:${REQ}`,
    clickerUserId: OWNER,
    pending,
    cardMessageId: OTHER_CARD,
  })
  assert.equal(outcome.kind, 'other_card')
  assert.deepEqual(answered, [])
  assert.equal(pending.has(REQ), true)
})

test('a legacy perm: click on another card settles nothing either', () => {
  const { pending, answered } = held(CARD)
  const outcome = resolvePermissionClick({
    callbackData: `perm:once:${REQ}`,
    clickerUserId: OWNER,
    pending,
    cardMessageId: OTHER_CARD,
  })
  assert.equal(outcome.kind, 'other_card')
  assert.deepEqual(answered, [])
})

test('a click that names no card row, or an unreadable one, settles nothing', () => {
  for (const cardMessageId of [undefined, null, Number.NaN, 0, -1, 1.5, 'x501', '', {}] as unknown[]) {
    const { pending, answered } = held(CARD)
    const outcome = resolvePermissionClick({
      callbackData: `ea:once:${REQ}`,
      clickerUserId: OWNER,
      pending,
      cardMessageId,
    } as never)
    assert.equal(outcome.kind, 'other_card', `card id ${String(cardMessageId)}`)
    assert.deepEqual(answered, [])
    assert.equal(pending.has(REQ), true)
  }
})

test('a card row id read as a decimal string is the same row', () => {
  const { pending, answered } = held(CARD)
  const outcome = resolvePermissionClick({
    callbackData: `ea:once:${REQ}`,
    clickerUserId: OWNER,
    pending,
    cardMessageId: String(CARD),
  } as never)
  assert.equal(outcome.kind, 'resolved')
  assert.deepEqual(answered, ['once'])
})

test('before the card is posted, or when its post returned no id, no click settles the request', () => {
  // The entry exists before the post returns, and a post can come back with no
  // numeric id. Neither knows which card is its own, so neither can be settled
  // by a click: the card read in waitForVerdict takes the tap once the id is
  // known, and with no id the request ends on the typed reply or the backstop.
  for (const unknownCard of [undefined, null]) {
    const { pending, answered } = held(unknownCard)
    const outcome = resolvePermissionClick({
      callbackData: `ea:once:${REQ}`,
      clickerUserId: OWNER,
      pending,
      cardMessageId: CARD,
    })
    assert.equal(outcome.kind, 'other_card', `entry card ${String(unknownCard)}`)
    assert.deepEqual(answered, [])
    assert.equal(pending.has(REQ), true)
  }
})

test('a click for a request this daemon does not hold still reads as stale, whatever card it names', () => {
  const { pending, answered } = held(CARD)
  const outcome = resolvePermissionClick({
    callbackData: 'ea:once:zyxwv',
    clickerUserId: OWNER,
    pending,
    cardMessageId: CARD,
  })
  assert.equal(outcome.kind, 'stale')
  assert.deepEqual(answered, [])
})

test('the requester binding still holds on the posted card', () => {
  const { pending, answered } = held(CARD)
  const outcome = resolvePermissionClick({
    callbackData: `ea:once:${REQ}`,
    clickerUserId: 'someone-else',
    pending,
    cardMessageId: CARD,
  })
  assert.equal(outcome.kind, 'foreign')
  assert.deepEqual(answered, [])
})

// ── The wiring in server.ts ──────────────────────────────────────────────────

const SRC = readFileSync(new URL('../server.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

function declaration(name: string): string {
  const start = SRC.search(new RegExp(`\\n(?:async )?function ${name}\\(`))
  assert.ok(start >= 0, `missing ${name}`)
  const end = SRC.indexOf('\n}\n', start)
  return SRC.slice(start, end + 3)
}

test('the request remembers the id of the card it posted, as soon as the post returns', () => {
  const handler = SRC.slice(
    SRC.indexOf('const cardMessageId = cardMessageIdFrom(posted)'),
    SRC.indexOf('const choice = await Promise.race<PermissionChoice>(['),
  )
  assert.ok(handler.length > 0)
  // On this operation's own entry, once it is known to still hold it.
  assert.match(handler, /if \(!holdsOwn\(\)\) \{[\s\S]*?return\n\s*\}\n\s*own\.waitMs = permissionBackstopMs\(storedWait\)[\s\S]*?own\.cardMessageId = cardMessageId/)
})

test('both click intakes hand the resolver the row the click was given on', () => {
  const poll = SRC.slice(SRC.indexOf('const permOutcome = resolvePermissionClick({'))
  assert.match(poll.slice(0, poll.indexOf('})')), /cardMessageId: mm\.id,/)
  const stream = SRC.slice(SRC.indexOf('resolvePermissionClick({', SRC.indexOf("  if (decision === 'permission') {")))
  assert.match(stream.slice(0, stream.indexOf('})')), /cardMessageId: streamCardRowId\(update\),/)
  assert.equal((SRC.match(/resolvePermissionClick\(/g) ?? []).length, 2)
})

test('both click intakes say why a click on another card settled nothing', () => {
  const poll = SRC.slice(SRC.indexOf('const permOutcome = resolvePermissionClick({'))
  const pollArm = poll.slice(0, poll.indexOf('const kind =') > 0 ? poll.indexOf('const kind =') : 4000)
  assert.match(pollArm, /permOutcome\.kind === 'other_card'/)
  const streamArm = SRC.slice(SRC.indexOf("  if (decision === 'permission') {"))
  assert.match(streamArm.slice(0, streamArm.indexOf('via stream: ${outcome.choice}')), /outcome\.kind === 'other_card'/)
})

/** The daemon's real stream intake, run out of server.ts with the real resolver. */
function streamRig(pending: Map<string, PendingPermissionLike>) {
  const logs: string[] = []
  const scope = {
    bgosGet: async () => ({ messages: [] }), bgosPost: async () => ({}), USER_ID: OWNER, ASSISTANT_ID: '42', LOGIN_METHOD_WINDOW_MS,
    chatUnansweredButtons: new Map(), announcedClickIds: new Set<number>(), FORWARD_CACHE_MAX: 500,
    postedButtonCards: new Map(),
    openCardStore: { add: () => {}, remove: () => {}, flushIfDirty: () => false },
    OPEN_CARD_STALE_ANSWER_MS: 24 * 60 * 60 * 1000,
    recentButtonPrompts: new Map(),
    updateDrainMode: false, lockHeld: true, humanMessageEdits: { isChatDeleted: () => false },
    ownerLaneVerdict, ownerAnnounceRefused, lanesOnForThisAgent: false,
    routeGroupStreamTap: () => false,
    chatOwnership: { isOthers: () => false }, noteLaneMisroute: () => {},
    log: (line: string) => logs.push(line),
    resolvePermissionClick, pendingPermissions: pending,
    senderUserIdOf: (p: any) => p?.senderUserId ?? OWNER, senderUserIdCandidate: (p: any) => p?.senderUserId ?? null,
    loginController: { button: () => 'not_mine' },
    streamAuthority: null, askTracker: { askIdOf: () => null },
    decideButtonsAnswered, viewStreamMessage, buildStreamClickMeta, streamCardRowId,
    PERMISSION_CLICK_RE,
  }
  const js = ts.transpileModule([
    declaration('rememberAnnouncedClick'), declaration('settlePostedButtonCard'), declaration('settleLoginMethodCard'), declaration('pendingLoginMethodCard'),
    declaration('deliverLoginMethodAnswer'), declaration('announceCardAnswer'),
    declaration('readOwnPostedCard'), declaration('applyStreamButtonsAnswered'), declaration('sendLoginText'),
  ].join('\n'), { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText
  const api = new Function(...Object.keys(scope), `let loginMethodCard = null;\n${js}\nreturn { applyStreamButtonsAnswered }`)(
    ...Object.values(scope),
  ) as { applyStreamButtonsAnswered: (update: unknown) => void }
  const tap = (messageId: number, callbackData: string) =>
    api.applyStreamButtonsAnswered({
      seq: 1,
      kind: 'buttons_answered',
      chatId: 40,
      messageId,
      payload: {
        message: {
          id: messageId, chatId: 40, sender: 'assistant', text: 'Allow this?', messageType: 'approval_request',
          answeredAt: '2026-11-26T10:00:00.000Z',
          answerPayload: { callbackData, buttonText: 'Yes, this once', answeredByUserId: OWNER },
        },
        messageOptions: [{ callbackData, text: 'Yes, this once' }],
      },
    })
  return { tap, logs }
}

test('stream: an answer on another card is not taken for the posted card, and the posted card still answers', () => {
  const { pending, answered } = held(CARD)
  const rig = streamRig(pending)
  rig.tap(OTHER_CARD, `ea:once:${REQ}`)
  assert.deepEqual(answered, [], 'the other card settles nothing')
  assert.equal(pending.has(REQ), true)
  assert.ok(rig.logs.some((line) => line.includes(`message ${OTHER_CARD}`) && line.includes(`card ${CARD}`)), rig.logs.join('\n'))
  assert.equal(rig.logs.some((line) => line.includes('Permission inline-button click via stream')), false)
  rig.tap(CARD, `ea:once:${REQ}`)
  assert.deepEqual(answered, ['once'], 'the posted card settles its request')
  assert.equal(pending.has(REQ), false)
})
