import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { decideButtonsAnswered, viewStreamMessage, buildStreamClickMeta } from '../lib/stream-apply.ts'
import { ownerAnnounceRefused, ownerLaneVerdict } from '../lib/lane-core.mjs'
import { LOGIN_METHOD_WINDOW_MS } from '../lib/auth-login.ts'

const source = readFileSync(new URL('../server.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
function declaration(name: string): string {
  const start = source.search(new RegExp(`\\n(?:async )?function ${name}\\(`))
  assert.ok(start >= 0, `missing ${name}`)
  const end = source.indexOf('\n}\n', start)
  return source.slice(start, end + 3)
}

const card = (id = 1002, answered = true, chatId = 501, lane?: string) => ({
  message: {
    id, chatId, lane, sender: 'assistant', text: 'Pick how to sign in.', messageType: 'standard',
    answeredAt: answered ? '2026-01-01T00:00:00.000Z' : null,
    answerPayload: answered ? { callbackData: 'login:claudeai', buttonText: 'Claude subscription', answeredByUserId: 'owner' } : null,
  },
  messageOptions: [{ callbackData: 'login:claudeai', text: 'Claude subscription' }],
})
type Card = ReturnType<typeof card>
type Slot = { offerVersion: number; chatId: string; messageId: number | null; settled: boolean; expiresAtMs: number }

/** Execute the daemon's actual sign-in POST, request, delivery gate and stream intake. */
function rig(read: (path: string, opts: unknown) => Promise<unknown>, post = async () => ({ message: { id: 1002 } })) {
  const open = new Map<string, Set<number>>()
  const announced = new Set<number>()
  const deliveries: any[] = []
  const logs: string[] = []
  const refused: unknown[] = []
  const prompts = new Map<string, { messageId: number; sentAtMs: number }>()
  const controller = {
    phase: 'awaiting_method', chatId: '501', methodOfferVersion: 1,
    button: (input: any) => { deliveries.push(input); controller.phase = 'starting'; return 'consumed' },
  }
  const flags = { deleted: false, others: false }
  const scope = {
    bgosGet: read, bgosPost: post, USER_ID: 'owner', ASSISTANT_ID: '42', LOGIN_METHOD_WINDOW_MS,
    chatUnansweredButtons: open, announcedClickIds: announced, FORWARD_CACHE_MAX: 500,
    postedButtonCards: new Map(),
    recentButtonPrompts: prompts,
    updateDrainMode: false, lockHeld: true, humanMessageEdits: { isChatDeleted: () => flags.deleted },
    ownerLaneVerdict, ownerAnnounceRefused, lanesOnForThisAgent: false,
    // No group lanes here: no tap is a group's.
    routeGroupStreamTap: () => false,
    chatOwnership: { isOthers: () => flags.others }, noteLaneMisroute: (...args: unknown[]) => refused.push(args),
    log: (line: string) => logs.push(line),
    resolvePermissionClick: () => ({ kind: 'not_permission' }), pendingPermissions: new Map(),
    senderUserIdOf: () => 'owner', senderUserIdCandidate: (p: any) => p?.senderUserId ?? null,
    loginController: controller,
    streamAuthority: null, askTracker: { askIdOf: () => null },
    decideButtonsAnswered, viewStreamMessage, buildStreamClickMeta,
    PERMISSION_CLICK_RE: /^ea:/,
  }
  const js = ts.transpileModule([
    declaration('rememberAnnouncedClick'), declaration('settlePostedButtonCard'), declaration('settleLoginMethodCard'), declaration('pendingLoginMethodCard'),
    declaration('deliverLoginMethodAnswer'), declaration('announceCardAnswer'),
    declaration('readOwnPostedCard'), declaration('applyStreamButtonsAnswered'), declaration('sendLoginText'),
  ].join('\n'), { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText
  const api = new Function(...Object.keys(scope), `let loginMethodCard = null;\n${js}\nreturn {
    readOwnPostedCard, announceCardAnswer, applyStreamButtonsAnswered, rememberAnnouncedClick, sendLoginText,
    pendingLoginMethodCard, settleLoginMethodCard,
    get slot() { return loginMethodCard },
    set slot(value) { loginMethodCard = value }
  }`)(...Object.values(scope)) as {
    slot: Slot | null
    readOwnPostedCard: (chatId: string, id: number, slot: Slot) => Promise<void>
    announceCardAnswer: (chatId: string, row: Card) => void
    applyStreamButtonsAnswered: (update: unknown) => void
    rememberAnnouncedClick: (id: number) => void
    sendLoginText: (chatId: string, text: string, buttons?: unknown[]) => Promise<number | null>
    pendingLoginMethodCard: (chatId: string) => Slot | null
  }
  return {
    api, open, announced, deliveries, logs, refused, prompts, controller, flags,
    posted: (id = 1002) => {
      controller.phase = 'awaiting_method'
      api.slot = { offerVersion: controller.methodOfferVersion, chatId: '501', messageId: id, settled: false, expiresAtMs: Date.now() + LOGIN_METHOD_WINDOW_MS }
      prompts.set('501', { messageId: id, sentAtMs: Date.now() })
    },
    read: () => api.readOwnPostedCard('501', api.slot!.messageId!, api.slot!),
    history: (row = card()) => api.announceCardAnswer('501', row),
    stream: (row = card()) => api.applyStreamButtonsAnswered({ seq: 1, kind: 'buttons_answered', chatId: row.message.chatId, messageId: row.message.id, payload: row }),
  }
}

test('sign-in makes one unconditional ID-bounded request; history and stream replays stay silent beyond ledger eviction', async () => {
  const requests: unknown[] = []
  const h = rig(async (path, opts) => { requests.push({ path, opts }); return { messages: [card()] } })
  h.posted()
  await h.read()
  assert.deepEqual(requests, [{ path: 'chats/501/messages?userId=owner&afterId=1001&beforeId=1003&limit=1', opts: { conditional: false } }])
  assert.equal(h.deliveries.length, 1)
  assert.equal(h.api.slot?.settled, true)
  assert.equal(h.prompts.has('501'), false)
  for (let id = 2000; id < 2600; id++) h.api.rememberAnnouncedClick(id)
  assert.equal(h.announced.has(1002), false, 'the ordinary receipt was evicted')
  h.history()
  h.stream()
  assert.equal(h.deliveries.length, 1, 'the single sign-in receipt still protects replays')
})

for (const lane of ['person:recipient', 'other:foreign']) {
  test(`review: a nested ${lane} stamp is refused with unknown chat ownership and lanes off`, async () => {
    const h = rig(async () => ({ messages: [card(1002, true, 501, lane)] }))
    h.posted()
    await h.read()
    assert.equal(h.deliveries.length, 0)
    assert.equal(h.announced.has(1002), false)
    assert.equal(h.api.slot?.settled, false, 'refusal happens before claiming')
    assert.equal(h.refused.length, 1)
  })
}

test('review: 100000 clicks keep at most 500 shared receipts', () => {
  const h = rig(async () => ({ messages: [] }))
  for (let id = 1; id <= 100000; id++) h.api.rememberAnnouncedClick(id)
  assert.equal(h.announced.size, 500)
})

test('history wins during a delayed direct read and 600 later receipts cannot replay its answer', async () => {
  let release!: (value: unknown) => void
  const h = rig(() => new Promise((resolve) => { release = resolve }))
  h.posted()
  const pending = h.read()
  h.history()
  for (let id = 2000; id < 2600; id++) h.api.rememberAnnouncedClick(id)
  release({ messages: [card()] })
  await pending
  h.stream()
  assert.equal(h.deliveries.length, 1)
  assert.equal(h.api.slot?.settled, true)
})

test('a superseded direct read cannot settle or deliver a newer sign-in', async () => {
  let release!: (value: unknown) => void
  const h = rig(() => new Promise((resolve) => { release = resolve }))
  h.posted()
  const old = h.api.slot
  const pending = h.read()
  h.posted(1004)
  release({ messages: [card()] })
  await pending
  assert.notEqual(h.api.slot, old)
  assert.equal(h.api.slot?.messageId, 1004)
  assert.equal(h.api.slot?.settled, false)
  assert.equal(h.deliveries.length, 0)
})

test('stream before POST returns cannot reopen the sign-in after 600 unrelated clicks', async () => {
  let release!: (value: { message: { id: number } }) => void
  const h = rig(async () => ({ messages: [card()] }), () => new Promise((resolve) => { release = resolve }))
  const pending = h.api.sendLoginText('501', 'Pick how to sign in.', card().messageOptions)
  h.stream()
  for (let id = 2000; id < 2600; id++) h.api.rememberAnnouncedClick(id)
  release({ message: { id: 1002 } })
  await pending
  h.history()
  h.stream()
  assert.equal(h.deliveries.length, 1)
  assert.equal(h.api.slot?.settled, true)
  assert.equal(h.prompts.has('501'), false)
})

for (const state of ['deleted', 'cancelled', 'expired'] as const) {
  test(`review: an omitted sign-in card stops forcing full reads when ${state}`, async () => {
    const h = rig(async () => ({ messages: [card(1002, false)] }))
    h.posted()
    await h.read()
    assert.notEqual(h.api.pendingLoginMethodCard('501'), null, 'an existing unanswered card stays open')
    if (state === 'deleted') h.flags.deleted = true
    if (state === 'cancelled') h.controller.phase = 'idle'
    if (state === 'expired') h.api.slot!.expiresAtMs = Date.now() - 1
    assert.equal(h.api.pendingLoginMethodCard('501'), null)
    assert.equal(h.api.slot?.settled, true)
    assert.equal(h.prompts.has('501'), false)
    assert.equal(h.open.size, 0, 'no entry remains in generic button tracking')
    h.history()
    assert.equal(h.deliveries.length, 0)
  })
}

for (const kind of ['missing', 'retired'] as const) {
  test(`review: a definitive ${kind} direct result retires the sign-in`, async () => {
    const row = card(1002, false)
    row.messageOptions = []
    const h = rig(async () => ({ messages: kind === 'missing' ? [] : [row] }))
    h.posted()
    await h.read()
    assert.equal(h.api.slot?.settled, true)
    assert.equal(h.api.pendingLoginMethodCard('501'), null)
    assert.equal(h.prompts.has('501'), false)
    assert.equal(h.open.size, 0)
    assert.equal(h.deliveries.length, 0)
  })
}

for (const row of [card(1003), card(1002, true, 502)]) {
  test(`direct response must match card and chat (${row.message.id}, ${row.message.chatId})`, async () => {
    const h = rig(async () => ({ messages: [row] }))
    h.posted()
    await h.read()
    assert.equal(h.deliveries.length, 0)
    assert.equal(h.api.slot?.settled, false)
  })
}

test('10000 actual sign-in posts occupy one slot and leave generic open-card tracking empty', async () => {
  let nextId = 1
  let requests = 0
  const h = rig(async (path) => {
    requests++
    const id = Number(new URL(path, 'http://backend').searchParams.get('afterId')) + 1
    return { messages: [card(id, false)] }
  }, async () => ({ message: { id: nextId++ } }))
  for (let id = 1; id <= 10000; id++) {
    h.controller.methodOfferVersion++
    assert.equal(await h.api.sendLoginText('501', 'Pick how to sign in.', card().messageOptions), id)
  }
  assert.equal(requests, 10000, 'each actual POST started its one direct read')
  assert.equal(h.api.slot?.messageId, 10000)
  assert.equal(h.open.size, 0)
  assert.equal(h.prompts.size, 1)
  assert.equal(h.announced.size, 0)
})

test('cancel and reopen while the next status read waits invalidates the old direct read before a new card posts', async () => {
  let release!: (value: unknown) => void
  const h = rig(() => new Promise((resolve) => { release = resolve }))
  h.posted()
  const pending = h.read()
  h.controller.methodOfferVersion++
  // The new offer is awaiting_method in the same chat, but its status read
  // has not returned yet, so no new POST has replaced the old slot.
  release({ messages: [card()] })
  await pending
  assert.equal(h.deliveries.length, 0)
  assert.equal(h.api.pendingLoginMethodCard('501'), null)
})


test('an evicted old stream receipt cannot pick a reopened offer before its new POST returns', async () => {
  let release!: (value: { message: { id: number } }) => void
  const h = rig(async (path) => {
    const id = Number(new URL(path, 'http://backend').searchParams.get('afterId')) + 1
    return { messages: [card(id)] }
  }, () => new Promise((resolve) => { release = resolve }))
  h.posted()
  await h.read()
  h.controller.phase = 'awaiting_method'
  h.controller.methodOfferVersion++
  const pending = h.api.sendLoginText('501', 'Pick how to sign in.', card().messageOptions)
  for (let id = 2000; id < 2600; id++) h.api.rememberAnnouncedClick(id)
  h.stream(card(1002))
  const beforePostReturned = h.deliveries.length
  release({ message: { id: 1004 } })
  await pending
  assert.equal(beforePostReturned, 1, 'the old method tap cannot choose the replacement offer')
  assert.deepEqual(h.deliveries.map((d) => d.messageId), [1002, 1004], 'each offer chooses only its own card')
})

test('historic sign-in cards never enter generic tracking; ordinary reply and plan rows keep their main inputs', () => {
  const start = source.indexOf('    const { announce, nextUnanswered, askAnswered } = selectClickTransitions(')
  const rowsStart = source.indexOf('rows: ', start) + 'rows: '.length
  const end = source.indexOf('      prevUnanswered,', rowsStart)
  const expression = source.slice(rowsStart, end).trim().replace(/,$/, '')
  const js = ts.transpileModule(`function rowsOf(data, loginMethodCard, chatId) { return ${expression} }`, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText
  const rowsOf = new Function(`${js}; return rowsOf`)() as (data: unknown, slot: unknown, chatId: string) => Array<{ id: number }>
  const reply = card(1005, false)
  reply.messageOptions = [{ callbackData: 'u:login:console', text: 'Agent-authored value' }]
  const plan = card(1006, false)
  plan.messageOptions = [{ callbackData: 'plan:go', text: 'Go ahead' }]
  const selected = rowsOf({ messages: [card(1002, false), card(1003, true), reply, plan] }, { chatId: '501', messageId: 1004 }, '501')
  assert.deepEqual(selected.map((r) => r.id), [1005, 1006])
})
