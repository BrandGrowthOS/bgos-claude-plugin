import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import * as plan from '../lib/plan-card.ts'
import * as stream from '../lib/stream-apply.ts'
import * as text from '../lib/message-text.ts'
import * as permission from '../lib/permission-relay.ts'
import * as inbound from '../lib/inbound-channel.ts'
import { BUTTON_PROMPT_FAST_WINDOW_MS, selectClickTransitions } from '../lib/poll-core.ts'
import { ownerAnnounceRefused, ownerLaneVerdict } from '../lib/lane-core.mjs'
import { createPostedButtons, createPrivateTurnTracker, privateTapCard } from '../lib/private-turn.mjs'

// Execute the daemon's real functions without starting its background services.
const source = readFileSync(new URL('../server.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
function declaration(name: string): string {
  const start = source.search(new RegExp(`\\n(?:async )?function ${name}\\(`))
  assert.ok(start >= 0, `missing ${name}`)
  return source.slice(start, source.indexOf('\n}\n', start) + 3)
}
const CHAT = '501'
const ID = 1002
const OWNER = 'sample-owner'
const payload = { kind: plan.PLAN_CARD_KIND, agent_route: plan.PLAN_AGENT_ROUTE, v: 1, title: 'Sample plan', steps: [{ text: 'Update the sample' }], door: 'decided', enforced: false, plan_id: 'sample-plan', revision: 1, state: 'proposed' }
function row(kind: 'reply' | 'plan' = 'reply', lane?: string) {
  return {
    // An envelope stamp must not override the message's own lane.
    lane: 'owner',
    message: {
      id: ID, chatId: Number(CHAT), sender: 'assistant', messageType: 'standard', text: 'Sample question', lane,
      answeredAt: new Date().toISOString(),
      answerPayload: { callbackData: kind === 'plan' ? 'plan:go' : 'u:continue', buttonText: kind === 'plan' ? 'Go ahead' : 'Continue', answeredByUserId: OWNER, senderUserId: OWNER },
      eventMeta: kind === 'plan' ? { payload } : undefined,
    },
    messageOptions: [{ text: 'Continue', callbackData: 'u:continue' }],
  }
}
type Row = ReturnType<typeof row>
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

function rig(read: (path: string, opts: unknown) => Promise<unknown> = async () => ({ messages: [] }), lanesOn = false) {
  const postedButtonCards = new Map<number, { chatId: string; settled: boolean; fresh: boolean }>()
  const announcedClickIds = new Set<number>()
  const prompts = new Map()
  const notes: Array<{ params: { content: string; meta: Record<string, string> } }> = []
  const openPlansByChat = new Map<string, any>()
  const settlements: string[] = []
  const refused: unknown[] = []
  const flags = { deleted: false, others: false }
  const postedButtons = createPostedButtons()
  const scope = {
    ...plan, ...stream, ...text, ...permission, ...inbound,
    BUTTON_PROMPT_FAST_WINDOW_MS, selectClickTransitions,
    USER_ID: OWNER, ASSISTANT_ID: '42', FORWARD_CACHE_MAX: 500,
    postedButtonCards, announcedClickIds, recentButtonPrompts: prompts,
    chatUnansweredButtons: new Map(), postedButtons, openPlansByChat,
    bgosGet: read, updateDrainMode: false, lockHeld: true,
    humanMessageEdits: { isChatDeleted: () => flags.deleted },
    lanesOnForThisAgent: lanesOn, chatOwnership: { isOthers: () => flags.others },
    ownerAnnounceRefused, ownerLaneVerdict, noteLaneMisroute: (...args: unknown[]) => refused.push(args),
    // No group lanes here: no tap is a group's.
    routeGroupStreamTap: () => false,
    log: () => {}, trackMessageOperation: (op: () => Promise<void>) => op(),
    mcp: { notification: async (note: (typeof notes)[number]) => { notes.push(note) } },
    privateTurns: createPrivateTurnTracker({ ownerUserId: OWNER }), privateTapCard,
    settlePlan: (chatId: string) => { settlements.push(chatId); openPlansByChat.delete(chatId) },
    loginMethodCard: null, loginController: { button: () => 'ignored' },
    streamAuthority: null, askTracker: { askIdOf: () => null, trackedMessageIds: () => new Set() },
    pendingLoginMethodCard: () => null, announceCompleteAsks: () => {},
    pendingPermissions: new Map(), senderUserIdOf: () => OWNER,
  }
  const pageStart = source.indexOf('    const prevUnanswered = chatUnansweredButtons.get(chatId)')
  const pageEndLine = '    chatUnansweredButtons.set(chatId, nextUnanswered)'
  const pageEnd = source.indexOf(pageEndLine, pageStart) + pageEndLine.length
  assert.ok(pageStart > 0 && pageEnd > pageStart)
  const js = ts.transpileModule([
    'notePostedButtonCard', 'settlePostedButtonCard', 'hasPendingPostedButtonCard',
    'readPostedButtonCard', 'announcePostedButtonAnswer', 'rememberAnnouncedClick',
    'foreignPlanTap', 'applyPlanAnswer', 'applyStreamButtonsAnswered',
  ].map(declaration).join('\n') + `\nfunction pollPage(data) { const chatId = '${CHAT}'; const lastSeen = 102;\n${source.slice(pageStart, pageEnd)}\n}`,
  { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText
  const api = new Function(...Object.keys(scope), `${js}\nreturn {
    notePostedButtonCard, readPostedButtonCard, announcePostedButtonAnswer,
    applyStreamButtonsAnswered, rememberAnnouncedClick, hasPendingPostedButtonCard, pollPage,
    setLock(value) { lockHeld = value }, setDrain(value) { updateDrainMode = value }
  }`)(...Object.values(scope))
  return {
    api, cards: postedButtonCards, announced: announcedClickIds, prompts, notes, flags, refused, settlements, openPlansByChat,
    unanswered: scope.chatUnansweredButtons,
    post: (kind: 'reply' | 'plan' = 'reply') => {
      postedButtons.note(ID, row(kind).messageOptions, 'Sample question')
      if (kind === 'plan') openPlansByChat.set(CHAT, { chatId: CHAT, messageId: ID, payload, requesterUserId: OWNER })
      api.notePostedButtonCard(CHAT, ID)
    },
    history: (r = row()) => api.announcePostedButtonAnswer(CHAT, r),
    stream: (r = row()) => api.applyStreamButtonsAnswered({ seq: 1, kind: 'buttons_answered', chatId: Number(CHAT), messageId: r.message.id, payload: r }),
  }
}

for (const kind of ['reply', 'plan'] as const) {
  test(`${kind}: one exact unconditional read delivers once across direct, history and stream`, async () => {
    const requests: unknown[] = []
    const h = rig(async (path, opts) => { requests.push({ path, opts }); return { messages: [row(kind)] } })
    h.post(kind)
    await flush()
    h.history(row(kind))
    h.stream(row(kind))
    assert.deepEqual(requests, [{ path: 'chats/501/messages?userId=sample-owner&afterId=1001&beforeId=1003&limit=1', opts: { conditional: false } }])
    assert.equal(h.notes.length, 1)
    assert.equal(h.notes[0].params.meta.callback_data, kind === 'plan' ? 'plan:go' : 'continue')
    assert.doesNotMatch(h.notes[0].params.content, /<hoai-private-turn/, 'a direct history read opens no private turn')
    assert.equal(h.settlements.length, kind === 'plan' ? 1 : 0)
    assert.equal(h.api.hasPendingPostedButtonCard(CHAT), false)
    assert.equal(h.prompts.has(CHAT), false)
  })

  for (const lane of ['person:sample-recipient', 'other:sample-foreign']) {
    test(`${kind}: nested ${lane} is refused before claiming, with lanes off`, async () => {
      const h = rig(async () => ({ messages: [row(kind, lane)] }))
      h.post(kind)
      await flush()
      h.history(row(kind, lane))
      h.stream(row(kind, lane))
      assert.equal(h.notes.length, 0)
      assert.equal(h.announced.has(ID), false)
      assert.equal(h.cards.get(ID)?.settled, false)
      assert.equal(h.settlements.length, 0)
      assert.equal(h.refused.length, 3)
      h.history(row(kind, 'owner'))
      assert.equal(h.notes.length, 1, 'refusal did not consume the card receipt')
    })
  }

  for (const winner of ['history', 'stream'] as const) {
    test(`${kind}: ${winner} wins while direct read waits, even after shared receipt eviction`, async () => {
      let release!: (value: unknown) => void
      const h = rig(() => new Promise((resolve) => { release = resolve }))
      h.post(kind)
      h[winner](row(kind))
      for (let id = 2000; id < 2600; id++) h.api.rememberAnnouncedClick(id)
      assert.equal(h.announced.has(ID), false)
      release({ messages: [row(kind)] })
      await flush()
      h.history(row(kind))
      h.stream(row(kind))
      assert.equal(h.notes.length, 1)
      assert.equal(h.settlements.length, kind === 'plan' ? 1 : 0)
    })
  }
}

test('a stream answer before the POST returns is not reopened by registration', async () => {
  const h = rig(async () => { throw new Error('a settled card needs no direct request') })
  h.stream()
  h.post()
  await flush()
  h.history()
  assert.equal(h.notes.length, 1)
  assert.equal(h.cards.get(ID)?.settled, true)
  assert.equal(h.prompts.has(CHAT), false)
})

for (const bad of ['id', 'chat', 'sender'] as const) {
  test(`a direct response with the wrong ${bad} cannot deliver or settle the card`, async () => {
    const r = row()
    if (bad === 'id') r.message.id++
    if (bad === 'chat') r.message.chatId++
    if (bad === 'sender') r.message.sender = 'user'
    const h = rig(async () => ({ messages: [r] }))
    h.post()
    await flush()
    assert.equal(h.notes.length, 0)
    assert.equal(h.cards.get(ID)?.settled, false)
  })
}

for (const state of ['deleted', 'draining', 'lock lost'] as const) {
  test(`an in-flight answer cannot deliver after ${state}`, async () => {
    let release!: (value: unknown) => void
    const h = rig(() => new Promise((resolve) => { release = resolve }))
    h.post()
    if (state === 'deleted') h.flags.deleted = true
    if (state === 'draining') h.api.setDrain(true)
    if (state === 'lock lost') h.api.setLock(false)
    release({ messages: [row()] })
    await flush()
    assert.equal(h.notes.length, 0)
    assert.equal(h.announced.has(ID), false)
  })
}

test('a failed direct read stays pending for fresh full history recovery', async () => {
  const h = rig(async () => { throw new Error('sample transient failure') })
  h.post()
  await flush()
  assert.equal(h.api.hasPendingPostedButtonCard(CHAT, true), true)
  h.history()
  assert.equal(h.notes.length, 1)
  assert.equal(h.api.hasPendingPostedButtonCard(CHAT, true), false)
})

for (const outcome of ['missing', 'retired'] as const) {
  test(`a definitively ${outcome} direct result retires its fast scope`, async () => {
    const r = row()
    r.message.answeredAt = null as any
    r.messageOptions = []
    const h = rig(async () => ({ messages: outcome === 'missing' ? [] : [r] }))
    h.post()
    await flush()
    assert.equal(h.cards.get(ID)?.settled, true)
    assert.equal(h.prompts.has(CHAT), false)
    assert.equal(h.notes.length, 0)
  })
}

test('the posted-card receipt ledger remains bounded after 10000 posts', async () => {
  const h = rig()
  for (let id = 1; id <= 10000; id++) h.api.notePostedButtonCard(CHAT, id)
  await flush()
  assert.equal(h.cards.size, 500)
  assert.equal(h.prompts.size, 0)
})

test('a plan answer naming another person cannot settle or deliver the plan', async () => {
  const r = row('plan')
  r.message.answerPayload.answeredByUserId = 'sample-other'
  r.message.answerPayload.senderUserId = 'sample-other'
  const h = rig(async () => ({ messages: [r] }))
  h.post('plan')
  await flush()
  assert.equal(h.notes.length, 0)
  assert.equal(h.settlements.length, 0)
  assert.ok(h.openPlansByChat.has(CHAT))
})

test('a recipient chat is refused before claiming once person lanes are enabled', async () => {
  const h = rig(async () => ({ messages: [row()] }), true)
  h.flags.others = true
  h.post()
  await flush()
  assert.equal(h.notes.length, 0)
  assert.equal(h.announced.has(ID), false)
  assert.equal(h.cards.get(ID)?.settled, false)
})

for (const choice of ['no', 'change'] as const) {
  test(`direct plan ${choice} retains its directive and normalized callback`, async () => {
    const r = row('plan')
    r.message.answerPayload.callbackData = choice === 'change' ? '__custom__' : 'plan:no'
    if (choice === 'change') Object.assign(r.message.answerPayload, { customText: 'Use a smaller sample' })
    const h = rig(async () => ({ messages: [r] }))
    h.post('plan')
    await flush()
    assert.equal(h.notes.length, 1)
    assert.equal(h.notes[0].params.meta.callback_data, `plan:${choice}`)
    assert.equal(h.settlements.length, 1)
    if (choice === 'change') assert.match(h.notes[0].params.content, /Use a smaller sample/)
    assert.ok(h.notes[0].params.content.includes(plan.planAnswerDirective(choice)!))
  })
}

test('an agent-authored plan-shaped value is unescaped without settling a plan', async () => {
  const r = row()
  r.message.answerPayload.callbackData = 'u:plan:go'
  const h = rig(async () => ({ messages: [r] }))
  h.post()
  await flush()
  assert.equal(h.notes.length, 1)
  assert.equal(h.notes[0].params.meta.callback_data, 'plan:go')
  assert.equal(h.settlements.length, 0)
  assert.doesNotMatch(h.notes[0].params.content, /approved/i)
})

test('an unanswered card retains ordinary history fallback after 500 newer posts evict its receipt', async () => {
  const open = row()
  open.message.answeredAt = null as any
  const h = rig(async () => ({ messages: [open] }))
  h.post()
  await flush()
  h.api.pollPage({ messages: [open] })
  assert.equal(h.unanswered.get(CHAT)?.has(ID), true, 'the real poll preserves its unanswered baseline')
  for (let id = 10000; id < 10500; id++) h.api.notePostedButtonCard('502', id)
  await flush()
  assert.equal(h.cards.has(ID), false, 'the original card receipt was evicted')
  h.api.pollPage({ messages: [row()] })
  assert.equal(h.notes.length, 1, 'ordinary history transitions still deliver this card')
})

test('special recovery expires after a failed direct read without consuming a later stream answer', async () => {
  const h = rig(async () => { throw new Error('sample failure') })
  h.post()
  await flush()
  assert.equal(h.api.hasPendingPostedButtonCard(CHAT, true), true)
  Object.assign(h.cards.get(ID)!, { recoverUntilMs: Date.now() - 1 })
  assert.equal(h.api.hasPendingPostedButtonCard(CHAT), false)
  assert.equal(h.api.hasPendingPostedButtonCard(CHAT, true), false)
  h.stream()
  assert.equal(h.notes.length, 1)
})

test('a deleted chat no longer requests special history recovery', async () => {
  const open = row()
  open.message.answeredAt = null as any
  const h = rig(async () => ({ messages: [open] }))
  h.post()
  await flush()
  h.flags.deleted = true
  assert.equal(h.api.hasPendingPostedButtonCard(CHAT), false)
})
