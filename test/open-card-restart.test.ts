import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { channelNotifyFor } from './helpers/channel-notify.ts'
import { scratchDir } from './helpers/scratch-dirs'
import * as plan from '../lib/plan-card.ts'
import * as stream from '../lib/stream-apply.ts'
import * as text from '../lib/message-text.ts'
import * as permission from '../lib/permission-relay.ts'
import * as inbound from '../lib/inbound-channel.ts'
import * as card from '../lib/card-answer.ts'
import { BUTTON_PROMPT_FAST_WINDOW_MS, selectClickTransitions } from '../lib/poll-core.ts'
import { ownerAnnounceRefused, ownerLaneVerdict } from '../lib/lane-core.mjs'
import { createPostedButtons, createPrivateTurnTracker, privateTapCard } from '../lib/private-turn.mjs'
import { isHumanClick } from '../lib/skill-origins.ts'
import {
  OPEN_CARDS_FILE_NAME,
  OPEN_CARD_MAX_AGE_MS,
  OPEN_CARDS_MAX,
  OpenCardStore,
  loadOpenCards,
  pruneOpenCards,
} from '../lib/open-cards.ts'

// A CARD ANSWERED WHILE THE DAEMON WAS DOWN IS STILL HEARD, ONCE.
//
// The poll announces a tap only when it saw the card unanswered on an earlier
// poll, and the receipts of the cards this daemon posted lived in memory: a
// restart between the question and the answer lost the answer for good, since
// the cursor (kept on disk) starts the next poll above the card. The receipts of
// open cards are now kept on disk (card and chat ids only, dropped once answered
// or 7 days old, at most 500), and at boot each is read once through the same
// exact read and announce path a live card uses, so the stream's replay of the
// same answer is still deduped by card id.
//
// No em or en dashes in this file.

const source = readFileSync(new URL('../server.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
function declaration(name: string): string {
  const start = source.search(new RegExp(`\\n(?:async )?function ${name}\\(`))
  assert.ok(start >= 0, `missing ${name}`)
  return source.slice(start, source.indexOf('\n}\n', start) + 3)
}
const CHAT = '501'
const ID = 1002
const OWNER = 'sample-owner'
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

function answered(lane?: string) {
  return {
    lane: 'owner',
    message: {
      id: ID, chatId: Number(CHAT), sender: 'assistant', messageType: 'standard', text: 'Ship it?', lane,
      answeredAt: new Date().toISOString(),
      answerPayload: { callbackData: 'u:yes', buttonText: 'Yes', answeredByUserId: OWNER, senderUserId: OWNER },
    },
    messageOptions: [{ text: 'Yes', callbackData: 'u:yes' }],
  }
}
function unanswered() {
  const r = answered()
  return { ...r, message: { ...r.message, answeredAt: null, answerPayload: null } }
}

/** One daemon process: its own memory, the shared state folder. */
function daemon(dir: string, read: (path: string) => Promise<unknown>, opts: { lanesOn?: boolean; others?: boolean } = {}) {
  const postedButtonCards = new Map<number, { chatId: string; settled: boolean; fresh: boolean; recoverUntilMs: number }>()
  const announcedClickIds = new Set<number>()
  const notes: Array<{ params: { content: string; meta: Record<string, string> } }> = []
  const reads: string[] = []
  const openCardStore = new OpenCardStore(join(dir, OPEN_CARDS_FILE_NAME))
  const openCardsBoot = openCardStore.load()
  const scope = {
    ...plan, ...stream, ...text, ...permission, ...inbound, ...card,
    BUTTON_PROMPT_FAST_WINDOW_MS, selectClickTransitions,
    USER_ID: OWNER, ASSISTANT_ID: '42', FORWARD_CACHE_MAX: 500,
    postedButtonCards, announcedClickIds, recentButtonPrompts: new Map(),
    chatUnansweredButtons: new Map(), postedButtons: createPostedButtons(), openPlansByChat: new Map(),
    bgosGet: async (path: string) => { reads.push(path); return read(path) },
    updateDrainMode: false, lockHeld: true,
    humanMessageEdits: { isChatDeleted: () => false },
    lanesOnForThisAgent: opts.lanesOn ?? false, chatOwnership: { isOthers: () => opts.others ?? false },
    ownerAnnounceRefused, ownerLaneVerdict, noteLaneMisroute: () => {},
    routeGroupStreamTap: () => false, routeGroupPollTaps: () => undefined,
    log: () => {}, trackMessageOperation: (op: () => Promise<void>) => op(),
    get channelNotify(): ReturnType<typeof channelNotifyFor> { return channelNotifyFor(() => (this as unknown as { mcp: { notification: (n: unknown) => unknown } }).mcp) },
    mcp: { notification: async (note: (typeof notes)[number]) => { notes.push(note) } },
    privateTurns: createPrivateTurnTracker({ ownerUserId: OWNER }), privateTapCardNoting: privateTapCard, isHumanClick,
    settlePlan: () => {}, loginMethodCard: null, loginController: { button: () => 'ignored' },
    streamAuthority: null, askTracker: { askIdOf: () => null, trackedMessageIds: () => new Set() },
    pendingLoginMethodCard: () => null, announceCompleteAsks: () => {},
    pendingPermissions: new Map(), senderUserIdOf: () => OWNER,
    openCardStore, openCardsBoot,
  }
  const js = ts.transpileModule([
    'notePostedButtonCard', 'settlePostedButtonCard', 'hasPendingPostedButtonCard',
    'readPostedButtonCard', 'announcePostedButtonAnswer', 'rememberAnnouncedClick',
    'foreignPlanTap', 'applyPlanAnswer', 'applyStreamButtonsAnswered', 'rehydrateOpenCards',
  ].map(declaration).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText
  const api = new Function(...Object.keys(scope), `${js}\nreturn {
    notePostedButtonCard, announcePostedButtonAnswer, applyStreamButtonsAnswered, rehydrateOpenCards,
  }`)(...Object.values(scope))
  return {
    api, notes, reads, store: openCardStore,
    post: () => api.notePostedButtonCard(CHAT, ID),
    history: (r = answered()) => api.announcePostedButtonAnswer(CHAT, r),
    stream: (r = answered()) => api.applyStreamButtonsAnswered({ seq: 1, kind: 'buttons_answered', chatId: Number(CHAT), messageId: r.message.id, payload: r }),
    stop: () => { openCardStore.flushIfDirty() },
  }
}

test('an open card answered while the daemon was down is announced once at the next boot', async () => {
  const dir = scratchDir('open-cards-')
  let answeredNow = false
  const first = daemon(dir, async () => ({ messages: [answeredNow ? answered() : unanswered()] }))
  first.post()
  await flush()
  assert.equal(first.notes.length, 0, 'still open when the first daemon stops')
  first.stop()
  answeredNow = true
  const second = daemon(dir, async () => ({ messages: [answered()] }))
  second.api.rehydrateOpenCards()
  await flush()
  assert.equal(second.notes.length, 1)
  assert.equal(second.notes[0].params.meta.callback_data, 'yes')
  assert.deepEqual(second.reads, ['chats/501/messages?userId=sample-owner&afterId=1001&beforeId=1003&limit=1'])
  second.stream()
  second.history()
  assert.equal(second.notes.length, 1, 'the stream replay and a later history read are deduped by card id')
  second.stop()
  assert.deepEqual(loadOpenCards(join(dir, OPEN_CARDS_FILE_NAME), Date.now()).cards, [], 'an answered card leaves the file')
})

test('a card already announced before the restart is not announced again', async () => {
  const dir = scratchDir('open-cards-')
  const first = daemon(dir, async () => ({ messages: [unanswered()] }))
  first.post()
  await flush()
  first.history()
  assert.equal(first.notes.length, 1)
  first.stop()
  const second = daemon(dir, async () => ({ messages: [answered()] }))
  second.api.rehydrateOpenCards()
  await flush()
  assert.equal(second.notes.length, 0)
  assert.deepEqual(second.reads, [])
})

test('a card still open at boot stays open and is announced when it is answered', async () => {
  const dir = scratchDir('open-cards-')
  const first = daemon(dir, async () => ({ messages: [unanswered()] }))
  first.post()
  await flush()
  first.stop()
  const second = daemon(dir, async () => ({ messages: [unanswered()] }))
  second.api.rehydrateOpenCards()
  await flush()
  assert.equal(second.notes.length, 0)
  second.history()
  assert.equal(second.notes.length, 1)
})

test('an upgrade boot (a cursor file but no card file) replays nothing', async () => {
  const dir = scratchDir('open-cards-')
  writeFileSync(join(dir, 'chat-cursors.json'), JSON.stringify({ v: 1, cursors: { [CHAT]: 1500 } }))
  const second = daemon(dir, async () => ({ messages: [answered()] }))
  second.api.rehydrateOpenCards()
  await flush()
  assert.equal(second.notes.length, 0)
  assert.deepEqual(second.reads, [])
})

test("with person lanes on, a recipient's chat is still refused to the owner's session at boot", async () => {
  const dir = scratchDir('open-cards-')
  const first = daemon(dir, async () => ({ messages: [unanswered()] }))
  first.post()
  await flush()
  first.stop()
  const second = daemon(dir, async () => ({ messages: [answered()] }), { lanesOn: true, others: true })
  second.api.rehydrateOpenCards()
  await flush()
  assert.equal(second.notes.length, 0)
})

test('rehydrating twice reads each card once', async () => {
  const dir = scratchDir('open-cards-')
  const first = daemon(dir, async () => ({ messages: [unanswered()] }))
  first.post()
  await flush()
  first.stop()
  const second = daemon(dir, async () => ({ messages: [answered()] }))
  second.api.rehydrateOpenCards()
  second.api.rehydrateOpenCards()
  await flush()
  assert.equal(second.reads.length, 1)
  assert.equal(second.notes.length, 1)
})

test('the file keeps card and chat ids only, drops cards older than 7 days, and keeps at most 500', () => {
  const now = Date.parse('2026-11-25T12:00:00Z')
  const old = { id: 1, chatId: '9', postedAtMs: now - OPEN_CARD_MAX_AGE_MS - 1 }
  const fresh = Array.from({ length: OPEN_CARDS_MAX + 20 }, (_, i) => ({ id: 100 + i, chatId: '9', postedAtMs: now - i }))
  const kept = pruneOpenCards([old, ...fresh], now)
  assert.equal(kept.length, OPEN_CARDS_MAX)
  assert.equal(kept.some((c) => c.id === 1), false)
  assert.equal(kept.some((c) => c.id === 100), true, 'the newest are kept')
  const dir = scratchDir('open-cards-')
  const store = new OpenCardStore(join(dir, OPEN_CARDS_FILE_NAME), () => now)
  store.load()
  store.add({ id: 7, chatId: '9', postedAtMs: now })
  assert.equal(store.flushIfDirty(), true)
  const body = JSON.parse(readFileSync(join(dir, OPEN_CARDS_FILE_NAME), 'utf8'))
  assert.deepEqual(Object.keys(body.cards[0]).sort(), ['chatId', 'id', 'postedAtMs'])
})

test('a missing or broken file loads as no cards, never throws', () => {
  const dir = scratchDir('open-cards-')
  const path = join(dir, OPEN_CARDS_FILE_NAME)
  assert.deepEqual(loadOpenCards(path, Date.now()), { cards: [], fileExisted: false })
  writeFileSync(path, '{not json')
  assert.deepEqual(loadOpenCards(path, Date.now()), { cards: [], fileExisted: false })
  writeFileSync(path, JSON.stringify({ v: 1, cards: [{ id: 'x', chatId: 9, postedAtMs: 'y' }] }))
  assert.deepEqual(loadOpenCards(path, Date.now()).cards, [])
  assert.equal(existsSync(path), true)
})

test('the boot path reads the open cards once the first cursors are flushed, and every flush writes them', () => {
  const boot = source.indexOf('    // Answers given while no daemon ran, to the cards the last one posted.\n    rehydrateOpenCards()')
  assert.ok(boot > 0, 'rehydrateOpenCards runs on the boot path')
  assert.ok(source.lastIndexOf('    flushChatCursors()\n', boot) > boot - 200, 'right after the boot flush')
  assert.match(declaration('flushChatCursors'), /openCardStore\.flushIfDirty\(\)/)
  assert.match(declaration('settlePostedButtonCard'), /openCardStore\.remove\(messageId\)/)
  assert.match(declaration('notePostedButtonCard'), /openCardStore\.add\(/)
})
