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
  createOpenCardWatch,
  loadOpenCards,
  pruneOpenCards,
  readFailureStatus,
  OPEN_CARD_STALE_ANSWER_MS,
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

function answered(lane?: string, answeredAt = new Date().toISOString()) {
  return {
    lane: 'owner',
    message: {
      id: ID, chatId: Number(CHAT), sender: 'assistant', messageType: 'standard', text: 'Ship it?', lane,
      answeredAt,
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
type DaemonOpts = { lanesOn?: boolean; others?: boolean; firstRun?: boolean; groupLanes?: boolean; groupTap?: boolean; monitored?: string[] }
function daemon(dir: string, read: (path: string) => Promise<unknown>, opts: DaemonOpts = {}) {
  const postedButtonCards = new Map<number, { chatId: string; settled: boolean; fresh: boolean; recoverUntilMs: number }>()
  const announcedClickIds = new Set<number>()
  const notes: Array<{ params: { content: string; meta: Record<string, string> } }> = []
  const reads: string[] = []
  const openCardStore = new OpenCardStore(join(dir, OPEN_CARDS_FILE_NAME))
  openCardStore.load()
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
    routeGroupStreamTap: () => opts.groupTap ?? false, routeGroupPollTaps: () => undefined,
    groupLanesOn: () => opts.groupLanes ?? false,
    monitoredChatIds: opts.monitored ?? [],
    cursorBoot: { fileExisted: !opts.firstRun },
    openCardWatch: createOpenCardWatch({ random: () => 0 }),
    openCardRehydrated: new Set<number>(),
    readFailureStatus, OPEN_CARD_STALE_ANSWER_MS,
    log: () => {}, trackMessageOperation: (op: () => Promise<void>) => op(),
    get channelNotify(): ReturnType<typeof channelNotifyFor> { return channelNotifyFor(() => (this as unknown as { mcp: { notification: (n: unknown) => unknown } }).mcp) },
    mcp: { notification: async (note: (typeof notes)[number]) => { notes.push(note) } },
    privateTurns: createPrivateTurnTracker({ ownerUserId: OWNER }), privateTapCardNoting: privateTapCard, isHumanClick,
    settlePlan: () => {}, loginMethodCard: null, loginController: { button: () => 'ignored' },
    streamAuthority: null, askTracker: { askIdOf: () => null, trackedMessageIds: () => new Set() },
    pendingLoginMethodCard: () => null, announceCompleteAsks: () => {},
    pendingPermissions: new Map(), senderUserIdOf: () => OWNER,
    openCardStore,
  }
  const js = ts.transpileModule([
    'notePostedButtonCard', 'settlePostedButtonCard', 'hasPendingPostedButtonCard',
    'readPostedButtonCard', 'announcePostedButtonAnswer', 'rememberAnnouncedClick',
    'foreignPlanTap', 'applyPlanAnswer', 'applyStreamButtonsAnswered', 'rehydrateOpenCards', 'watchOpenCards',
  ].map(declaration).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText
  const api = new Function(...Object.keys(scope), `${js}\nreturn {
    notePostedButtonCard, announcePostedButtonAnswer, applyStreamButtonsAnswered, rehydrateOpenCards, watchOpenCards,
    rememberAnnouncedClick,
  }`)(...Object.values(scope))
  let clock = Date.now()
  // The watch's tick: a card first seen is scheduled, then read (random 0).
  const tick = async () => { api.watchOpenCards(clock); api.watchOpenCards(clock); await flush() }
  return {
    api, notes, reads, store: openCardStore, announced: announcedClickIds, cards: postedButtonCards,
    post: (id = ID) => api.notePostedButtonCard(CHAT, id),
    boot: async () => { api.rehydrateOpenCards('boot'); await tick() },
    rearm: async () => { api.rehydrateOpenCards('rearm'); await tick() },
    tick,
    later: (ms: number) => { clock += ms },
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
  await second.boot()
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
  await second.boot()
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
  await second.boot()
  assert.equal(second.notes.length, 0)
  second.history()
  assert.equal(second.notes.length, 1)
})

test('an upgrade boot (a cursor file but no card file) replays nothing', async () => {
  const dir = scratchDir('open-cards-')
  writeFileSync(join(dir, 'chat-cursors.json'), JSON.stringify({ v: 1, cursors: { [CHAT]: 1500 } }))
  const second = daemon(dir, async () => ({ messages: [answered()] }))
  await second.boot()
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
  await second.boot()
  assert.equal(second.notes.length, 0)
})

test('rehydrating twice reads each card once', async () => {
  const dir = scratchDir('open-cards-')
  const first = daemon(dir, async () => ({ messages: [unanswered()] }))
  first.post()
  await flush()
  first.stop()
  const second = daemon(dir, async () => ({ messages: [answered()] }))
  second.api.rehydrateOpenCards('boot')
  await second.boot()
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
  const boot = source.indexOf("    // Answers given while no daemon ran, to the cards the last one posted.\n    rehydrateOpenCards('boot')")
  assert.ok(boot > 0, 'rehydrateOpenCards runs on the boot path')
  assert.ok(source.lastIndexOf('    flushChatCursors()\n', boot) > boot - 200, 'right after the boot flush')
  assert.match(declaration('flushChatCursors'), /openCardStore\.flushIfDirty\(\)/)
  assert.match(declaration('settlePostedButtonCard'), /openCardStore\.remove\(messageId\)/)
  assert.match(declaration('notePostedButtonCard'), /openCardStore\.add\(/)
})

// Review of #417 (R1, R2, R4, R5, R6).

test('R1: a tap the stream hands to a group lane is claimed, so no other route announces it in the main session', async () => {
  const dir = scratchDir('open-cards-')
  let tapped = false
  const d = daemon(dir, async () => ({ messages: [tapped ? answered() : unanswered()] }), { groupTap: true })
  d.post()
  await flush()
  tapped = true
  d.stream()
  assert.equal(d.notes.length, 0, 'the group lane took it')
  assert.equal(d.announced.has(ID), true, 'and the id is claimed')
  d.history()
  await d.tick()
  assert.equal(d.notes.length, 0)
})

test('R1: with group lanes on, a chat the poll does not watch is not read by the watch', async () => {
  const dir = scratchDir('open-cards-')
  const d = daemon(dir, async () => ({ messages: [unanswered()] }), { groupLanes: true })
  d.post()
  await flush()
  const before = d.reads.length
  d.later(10 * 60_000)
  await d.tick()
  assert.equal(d.reads.length, before)
})

test('R2: a daemon promoted later reads the file as it is then, not as it was at its boot', async () => {
  const dir = scratchDir('open-cards-')
  const holder = daemon(dir, async () => ({ messages: [unanswered()] }))
  holder.post()
  await flush()
  holder.stop()
  const passive = daemon(dir, async () => ({ messages: [answered()] }))
  holder.history()
  assert.equal(holder.notes.length, 1)
  await passive.boot()
  assert.equal(passive.notes.length, 0, 'the holder already announced it')
  assert.deepEqual(passive.reads, [])
})

test("R2: a daemon's write keeps the cards another daemon added meanwhile", async () => {
  const dir = scratchDir('open-cards-')
  const passive = daemon(dir, async () => ({ messages: [unanswered()] }))
  const holder = daemon(dir, async () => ({ messages: [unanswered()] }))
  holder.post(2002)
  await flush()
  holder.stop()
  passive.post(3003)
  await flush()
  passive.stop()
  const ids = loadOpenCards(join(dir, OPEN_CARDS_FILE_NAME), Date.now()).cards.map((c) => c.id).sort()
  assert.deepEqual(ids, [2002, 3003])
})

test('R4: an answered card leaves the file at once, before any timed flush', async () => {
  const dir = scratchDir('open-cards-')
  const d = daemon(dir, async () => ({ messages: [unanswered()] }))
  d.post()
  await flush()
  d.stop()
  d.history()
  assert.equal(d.notes.length, 1)
  assert.deepEqual(loadOpenCards(join(dir, OPEN_CARDS_FILE_NAME), Date.now()).cards, [], 'no flush called, already gone')
})

test('R5: a boot the cursor store calls a first run reads no card back', async () => {
  const dir = scratchDir('open-cards-')
  const first = daemon(dir, async () => ({ messages: [unanswered()] }))
  first.post()
  await flush()
  first.stop()
  const second = daemon(dir, async () => ({ messages: [answered()] }), { firstRun: true })
  await second.boot()
  assert.deepEqual(second.reads, [])
  assert.equal(second.notes.length, 0)
})

test('R5: an answer older than a day is settled, never announced as fresh', async () => {
  const dir = scratchDir('open-cards-')
  const first = daemon(dir, async () => ({ messages: [unanswered()] }))
  first.post()
  await flush()
  first.stop()
  const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString()
  const second = daemon(dir, async () => ({ messages: [answered(undefined, old)] }))
  await second.boot()
  assert.equal(second.reads.length, 1)
  assert.equal(second.notes.length, 0)
  assert.equal(second.cards.get(ID)?.settled, true)
})

test('R6: a card already answered when its post returns is never kept in the file', async () => {
  const dir = scratchDir('open-cards-')
  const d = daemon(dir, async () => ({ messages: [answered()] }))
  d.api.rememberAnnouncedClick(ID)
  d.post()
  await flush()
  d.stop()
  assert.deepEqual(loadOpenCards(join(dir, OPEN_CARDS_FILE_NAME), Date.now()).cards, [])
})

test('R6: a card this daemon already announced is not read back at boot', async () => {
  const dir = scratchDir('open-cards-')
  const first = daemon(dir, async () => ({ messages: [unanswered()] }))
  first.post()
  await flush()
  first.stop()
  const second = daemon(dir, async () => ({ messages: [answered()] }))
  second.api.rememberAnnouncedClick(ID)
  await second.boot()
  assert.deepEqual(second.reads, [])
})

test('R6: a card older than 7 days is dropped even when it is not the oldest of many', () => {
  const now = Date.parse('2026-11-25T12:00:00Z')
  const kept = pruneOpenCards(
    [
      { id: 1, chatId: '9', postedAtMs: now - 1000 },
      { id: 2, chatId: '9', postedAtMs: now - OPEN_CARD_MAX_AGE_MS - 1 },
    ],
    now,
  )
  assert.deepEqual(kept.map((c) => c.id), [1])
})

test('R6: a flush with nothing new writes nothing', () => {
  const dir = scratchDir('open-cards-')
  const store = new OpenCardStore(join(dir, OPEN_CARDS_FILE_NAME))
  store.load()
  store.add({ id: 5, chatId: '9', postedAtMs: Date.now() })
  assert.equal(store.flushIfDirty(), true)
  assert.equal(store.flushIfDirty(), false)
})

// A DAEMON THAT STOOD DOWN AND RE-ARMS READS THE FILE AGAIN (review of #417
// round 2, F1). While it was passive the holder announced and settled its
// cards and posted new ones. The re-arm reads the file as it is then: a card
// the holder settled is settled here, never announced twice, and a card the
// holder posted is watched here. A daemon that booted as a first run re-arms
// with the holder's file too, so the first run gate is the boot's alone.
for (const firstRun of [false, true]) {
  test(`F1: a re-arm settles what the holder settled and watches what it posted (${firstRun ? 'a first run boot' : 'a normal boot'})`, async () => {
    const dir = scratchDir('open-cards-')
    const reArmer = daemon(dir, async (path) => ({ messages: [path.includes(String(ID)) ? answered() : unanswered()] }), { firstRun })
    reArmer.post()
    await flush()
    reArmer.stop()
    // The holder, while the first daemon stood down: it announces and settles
    // the first card, then posts a second.
    const holder = daemon(dir, async () => ({ messages: [answered()] }))
    await holder.boot()
    assert.equal(holder.notes.length, 1, 'the holder announced the tap')
    holder.post(2002)
    await flush()
    holder.stop()
    await reArmer.rearm()
    assert.equal(reArmer.notes.length, 0, 'a tap the holder announced is not announced again')
    assert.equal(reArmer.cards.get(ID)?.settled, true, 'the card the holder settled is settled here')
    assert.equal(reArmer.cards.get(2002)?.settled, false, 'the card the holder posted is watched here')
  })
}

test('F1: both arm paths read the open cards, the re-arm before delivery resumes', () => {
  const start = source.indexOf('  const armDelivery = async (): Promise<void> => {')
  assert.ok(start > 0, 'armDelivery exists')
  const reArm = source.slice(start, source.indexOf('\n    deliveryLoopsStarted = true\n', start))
  assert.ok(reArm.includes('if (deliveryLoopsStarted) {'), 'the re-arm branch is read')
  const read = reArm.indexOf("rehydrateOpenCards('rearm')")
  assert.ok(read > 0, 'the re-arm reads the open cards')
  assert.ok(read < reArm.indexOf('      channelArmed = true\n'), 'before delivery resumes')
  assert.ok(source.includes("    rehydrateOpenCards('boot')\n"), 'the first arm reads them too')
  assert.match(declaration('rehydrateOpenCards'), /if \(reason === 'boot' && !cursorBoot\.fileExisted\) return/)
})

// REVIEW OF #417 ROUND 2, F2, F3 AND F5.
test('F2: a card the server refuses for good (403, 404, 410) is closed unread, the agent is told once, and it is not read for a week', async () => {
  for (const status of [403, 404, 410]) {
    const dir = scratchDir('open-cards-')
    const first = daemon(dir, async () => ({ messages: [unanswered()] }))
    first.post()
    await flush()
    first.stop()
    const second = daemon(dir, async () => { throw new Error(`GET ${status}: refused`) })
    await second.boot()
    assert.equal(second.reads.length, 1, `${status}: read once`)
    assert.equal(second.cards.get(ID)?.settled, true, `${status}: settled`)
    // Never a silent lost tap (Data, round 3): the agent is told once that the
    // card is closed unread, and nothing is announced as an answer.
    assert.equal(second.notes.length, 1, `${status}: one line the agent sees`)
    const [note] = second.notes
    assert.equal(note.params.meta.event_type, 'card_unreadable')
    assert.equal(note.params.meta.message_id, String(ID))
    assert.equal(note.params.meta.status, String(status))
    for (const [key, value] of Object.entries(note.params.meta)) assert.equal(typeof value, 'string', `meta.${key} is a string`)
    assert.match(note.params.content, /not (counted as )?answered/)
    assert.doesNotMatch(note.params.content, /\[button_clicked\]/)
    second.later(OPEN_CARD_MAX_AGE_MS / 2)
    await second.tick()
    assert.equal(second.reads.length, 1, `${status}: never read again`)
    assert.equal(second.notes.length, 1, `${status}: and told once`)
  }
})

test('F3: a read back that fails is read again by the watch, in a chat the poll watches', async () => {
  const dir = scratchDir('open-cards-')
  const first = daemon(dir, async () => ({ messages: [unanswered()] }))
  first.post()
  await flush()
  first.stop()
  let fail = true
  const second = daemon(dir, async () => {
    if (fail) { fail = false; throw new Error('GET 502: bad gateway') }
    return { messages: [answered()] }
  }, { monitored: [CHAT] })
  await second.boot()
  assert.equal(second.reads.length, 1)
  assert.equal(second.notes.length, 0)
  second.later(5 * 60_000)
  await second.tick()
  assert.equal(second.reads.length, 2, 'read again after the failure')
  assert.equal(second.notes.length, 1, 'and the answer is heard')
})

test('F5: removing a card the store never held writes nothing', () => {
  const dir = scratchDir('open-cards-')
  const store = new OpenCardStore(join(dir, OPEN_CARDS_FILE_NAME))
  store.load()
  store.remove(999)
  assert.equal(store.isDirty, false)
  assert.equal(store.flushIfDirty(), false)
})
