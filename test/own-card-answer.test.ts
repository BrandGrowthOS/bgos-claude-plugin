import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { OwnCardNotes, noteOwnUnansweredCard, selectClickTransitions } from '../lib/poll-core.ts'
import { decideButtonsAnswered, viewStreamMessage, buildStreamClickMeta } from '../lib/stream-apply.ts'
import { ownerAnnounceRefused, ownerLaneVerdict } from '../lib/lane-core.mjs'

const source = readFileSync(new URL('../server.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
function declaration(name: string): string {
  const start = source.search(new RegExp(`\\n(?:async )?function ${name}\\(`))
  assert.ok(start >= 0, `missing ${name}`)
  const end = source.indexOf('\n}\n', start)
  return source.slice(start, end + 3)
}

const card = (id = 1002, answered = true, chatId = 501) => ({
  message: {
    id, chatId, sender: 'assistant', text: 'Ship it?', messageType: 'standard',
    answeredAt: answered ? '2026-01-01T00:00:00.000Z' : null,
    answerPayload: answered ? { callbackData: 'u:ship', buttonText: 'Ship', answeredByUserId: 'owner' } : null,
  },
  messageOptions: [{ callbackData: 'u:ship', text: 'Ship' }],
})
type Card = ReturnType<typeof card>

/** Execute the actual daemon request, shared delivery gate, receipt ledger and stream intake. */
function rig(read: (path: string, opts: unknown) => Promise<unknown>) {
  const open = new Map<string, Set<number>>()
  const notes = new OwnCardNotes()
  const announced = new Set<number>()
  const notifications: any[] = []
  const logs: string[] = []
  const prompts = new Map([['501', { messageId: 1002 }]])
  const scope = {
    bgosGet: read, USER_ID: 'owner', ASSISTANT_ID: '42',
    chatUnansweredButtons: open, ownCardNotes: notes, announcedClickIds: announced,
    recentButtonPrompts: prompts,
    updateDrainMode: false, lockHeld: true, humanMessageEdits: { isChatDeleted: () => false },
    ownerLaneVerdict, ownerAnnounceRefused, lanesOnForThisAgent: false,
    chatOwnership: { isOthers: () => false }, noteLaneMisroute: () => {},
    log: (line: string) => logs.push(line),
    resolvePermissionClick: () => ({ kind: 'not_permission' }), pendingPermissions: new Map(),
    readTapperUserId: (payload: any) => payload?.answeredByUserId ?? null,
    senderUserIdOf: () => 'owner', senderUserIdCandidate: () => null,
    loginController: { button: () => 'not_login' },
    applyPlanAnswer: () => ({ refused: false }),
    unescapeAgentButtonValue: (value: string) => value.replace(/^u:/, ''),
    postedButtons: { posted: () => false }, privateTurns: {},
    privateTapCard: (input: any) => input.content,
    buildButtonClickedMeta: (input: any) => input,
    trackMessageOperation: (op: () => Promise<unknown>) => op(),
    mcp: { notification: async (n: unknown) => { notifications.push(n) } },
    streamAuthority: null, askTracker: { askIdOf: () => null },
    decideButtonsAnswered, viewStreamMessage, buildStreamClickMeta,
    PERMISSION_CLICK_RE: /^ea:/,
  }
  const js = ts.transpileModule([
    declaration('rememberAnnouncedClick'), declaration('announceCardAnswer'),
    declaration('readOwnPostedCard'), declaration('applyStreamButtonsAnswered'),
  ].join('\n'), { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText
  const api = new Function(...Object.keys(scope), `${js}\nreturn { readOwnPostedCard, announceCardAnswer, applyStreamButtonsAnswered, rememberAnnouncedClick }`)(...Object.values(scope)) as {
    readOwnPostedCard: (chatId: string, id: number) => Promise<void>
    announceCardAnswer: (chatId: string, row: Card) => void
    applyStreamButtonsAnswered: (update: unknown) => void
    rememberAnnouncedClick: (id: number) => void
  }
  return {
    ...api, open, notes, announced, notifications, logs, prompts,
    posted: () => noteOwnUnansweredCard(open, '501', 1002, notes, announced),
    stream: (row = card()) => api.applyStreamButtonsAnswered({ seq: 1, kind: 'buttons_answered', chatId: 501, messageId: row.message.id, payload: row }),
  }
}

test('direct read makes exactly one unconditional request by id and uses the history announce gate', async () => {
  const requests: unknown[] = []
  const h = rig(async (path, opts) => { requests.push({ path, opts }); return { messages: [card()] } })
  h.posted()
  await h.readOwnPostedCard('501', 1002)
  assert.deepEqual(requests, [{ path: 'chats/501/messages?userId=owner&afterId=1001&beforeId=1003&limit=1', opts: { conditional: false } }])
  assert.equal(h.notifications.length, 1)
  assert.equal(h.open.get('501')?.size, 0)
  assert.equal(h.notes.forChat('501'), undefined)
  assert.equal(h.prompts.has('501'), false)
  for (let id = 2000; id < 2600; id++) h.rememberAnnouncedClick(id)
  h.announceCardAnswer('501', card())
  h.stream()
  assert.equal(h.notifications.length, 1, 'neither history nor stream replays an answer after 600 unrelated receipts')
})

test('stream answer before POST returns, then the direct read: one delivery and no reopened card', async () => {
  const h = rig(async () => ({ messages: [card()] }))
  h.stream()
  h.posted()
  await h.readOwnPostedCard('501', 1002)
  assert.equal(h.notifications.length, 1)
  assert.equal(h.open.has('501'), false)
  assert.equal(h.notes.forChat('501'), undefined)
})

test('history answers while a direct read is in flight; its stale unanswered response cannot reopen the card', async () => {
  let release!: (value: unknown) => void
  const h = rig(() => new Promise((resolve) => { release = resolve }))
  h.posted()
  const pending = h.readOwnPostedCard('501', 1002)
  h.announceCardAnswer('501', card())
  release({ messages: [card(1002, false)] })
  await pending
  assert.equal(h.notifications.length, 1)
  assert.equal(h.open.get('501')?.size, 0)
  assert.equal(h.notes.forChat('501'), undefined)
})

test('an unanswered direct result stays open through an excluding history read and a later answer delivers once', async () => {
  const h = rig(async () => ({ messages: [card(1002, false)] }))
  h.posted()
  await h.readOwnPostedCard('501', 1002)
  assert.equal(h.notifications.length, 0)
  const result = selectClickTransitions({
    rows: [{ id: 1003, sender: 'assistant', hasOptions: false, answered: false }],
    prevUnanswered: h.open.get('501')!, ownCardNotes: h.notes.forChat('501'), isFirstPoll: false,
  })
  assert.deepEqual([...result.nextUnanswered], [1002])
  h.open.set('501', result.nextUnanswered)
  h.stream()
  h.announceCardAnswer('501', card())
  assert.equal(h.notifications.length, 1)
  assert.equal(h.notes.forChat('501'), undefined)
})

test('a failed direct read leaves the card open for ordinary history recovery', async () => {
  const h = rig(async () => { throw new Error('fixture read failure') })
  h.posted()
  await h.readOwnPostedCard('501', 1002)
  assert.deepEqual([...h.open.get('501')!], [1002])
  assert.ok(h.logs.some((line) => line.includes('answer read failed')))
  h.announceCardAnswer('501', card())
  assert.equal(h.notifications.length, 1)
})

for (const row of [card(1003), card(1002, true, 502)]) {
  test(`the direct response must match both card and chat (${row.message.id}, ${row.message.chatId})`, async () => {
    const h = rig(async () => ({ messages: [row] }))
    h.posted()
    await h.readOwnPostedCard('501', 1002)
    assert.equal(h.notifications.length, 0)
    assert.deepEqual([...h.open.get('501')!], [1002])
  })
}

test('a retired direct row is consumed without announcing a click', async () => {
  const row = card(1002, false)
  row.messageOptions = []
  const h = rig(async () => ({ messages: [row] }))
  h.posted()
  await h.readOwnPostedCard('501', 1002)
  assert.equal(h.notifications.length, 0)
  assert.equal(h.open.get('501')?.size, 0)
  assert.equal(h.notes.forChat('501'), undefined)
})
