import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  QUIET_BEGIN_WITHIN_MS,
  QUIET_CARD_MAX_WAIT_MS,
  createQuietTurns,
  holdChannelCardsDuringQuietTurn,
  quietCardOf,
} from '../lib/quiet-turn.mjs'
import { createScheduleGrantRuns, holdChannelCardsDuringGrantedRun } from '../lib/schedule-grant-run.mjs'

// A trusted turn is quiet (2026-11-11; option A of the voice call design, KC 2026-11-11, board row 01a1339a). While the
// owner's own turn runs (a stamped voice ask, a typed message, a scheduled wake), every other channel card waits at
// the one choke point all cards pass, unbuilt, so it never reaches the private turn tracker and never ends the turn.
// A card waits five minutes at most; then it is let in and the turn loses its trust exactly as it did before.
// Unit tests of the hold over a tracker double. The real tracker and the real server.ts wiring are in
// test/quiet-turn-threats.test.ts.

const OWNER = 'user_owner'
const TOKEN = '11111111-2222-4333-8444-555555555555'
const OTHER = '99999999-2222-4333-8444-555555555555'
const tag = (id: string) => `<hoai-private-turn id="${id}"/>`

function fakeClock(start = Date.parse('2026-11-11T10:00:00.000Z')) {
  let t = start
  const timers: Array<{ at: number; fn: () => void; done: boolean }> = []
  return {
    now: () => t,
    setTimer: (fn: () => void, ms: number) => { const h = { at: t + ms, fn, done: false }; timers.push(h); return h },
    clearTimer: (h: { done: boolean } | undefined) => { if (h) h.done = true },
    advance(ms: number) { t += ms; for (const h of [...timers]) if (!h.done && h.at <= t) { h.done = true; h.fn() } },
  }
}
const flush = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve() }

type Bound = { chatId: string; askId: string | null; deadline: number | null } | null

/** The hold over a recording sender and a tracker double whose bound turn the test sets. */
function rig(options: { idle?: () => boolean; enabled?: () => boolean } = {}) {
  const clock = fakeClock()
  let bound: Bound = null
  const deliveries = new Map<string, { actingUserId: string | null; replayed: boolean }>()
  const lines: string[] = []
  const quiet = createQuietTurns({
    ...clock,
    ownerUserId: OWNER,
    trusted: () => (bound && bound.deadline != null && clock.now() >= bound.deadline ? null : bound),
    deliveryOf: (card: unknown) => {
      const match = /<hoai-private-turn id="([a-f0-9-]{36})"\/>/.exec(String(card))
      const found = match ? deliveries.get(match[1]!) : undefined
      return found ? { token: match![1]!, ...found } : null
    },
    idle: options.idle ?? (() => true),
    enabled: options.enabled ?? (() => true),
  })
  const sent: string[] = []
  const built: string[] = []
  // The real scheduled run hold sits inside, as in server.ts: it is what builds a card, when the card really goes out.
  const inner = holdChannelCardsDuringGrantedRun(createScheduleGrantRuns(), async (n: { params: { content: string }; quiet?: unknown }) => {
    assert.equal('quiet' in n, false, 'the descriptor never reaches the CLI')
    sent.push(n.params.content)
  })
  const notify = holdChannelCardsDuringQuietTurn(quiet, inner, { log: (line: string) => { lines.push(line) } })
  const card = (content: string, quietCard?: unknown) => ({
    method: 'notifications/claude/channel',
    params: () => { built.push(content); return { content, meta: {} } },
    ...(quietCard ? { quiet: quietCard } : {}),
  })
  return {
    clock, quiet, sent, built, lines, notify, card,
    bind: (turn: Bound) => { bound = turn },
    /** What the tracker recorded for a card with this token. */
    delivered: (token: string, actingUserId: string | null = OWNER, replayed = false) => { deliveries.set(token, { actingUserId, replayed }) },
  }
}

const TYPED = { chatId: '900', askId: null, deadline: null }
const ASK = (deadline: number) => ({ chatId: '900', askId: 'voice_task:41', deadline })

test('quietCardOf: only a card the server stamped for this agent\'s owner can open a quiet turn', () => {
  assert.deepEqual(quietCardOf({ ownerUserId: OWNER, actingUserId: OWNER, senderType: 'user', chatId: 900 }), { opens: 'message', chatId: '900' })
  assert.deepEqual(quietCardOf({ ownerUserId: OWNER, actingUserId: OWNER, senderType: 'system', chatId: '900' }), { opens: 'wake', chatId: '900' })
  assert.deepEqual(quietCardOf({ ownerUserId: OWNER, actingUserId: OWNER, senderType: 'user', chatId: 900, ask: true }), { opens: 'ask', chatId: '900' })
  // A share recipient, a peer agent, an unstamped card, and an agent with no owner named: nothing to hold for.
  assert.equal(quietCardOf({ ownerUserId: OWNER, actingUserId: 'user_member', senderType: 'user', chatId: 900 }), null)
  assert.equal(quietCardOf({ ownerUserId: OWNER, actingUserId: null, senderType: 'assistant', chatId: 900 }), null)
  assert.equal(quietCardOf({ ownerUserId: OWNER, actingUserId: null, senderType: 'system', chatId: 900 }), null)
  assert.equal(quietCardOf({ ownerUserId: null, actingUserId: OWNER, senderType: 'user', chatId: 900 }), null)
  assert.equal(quietCardOf({ ownerUserId: '', actingUserId: '', senderType: 'user', chatId: 900 }), null)
})

test('hold: a card that arrives while the owner\'s turn runs waits, unbuilt, until the turn ends', async () => {
  const { quiet, notify, card, sent, built, bind } = rig()
  bind(TYPED)
  void notify(card('peer message'))
  void notify(card('meeting line'))
  await flush()
  assert.deepEqual(built, [], 'a held card is not even built, so it never reaches the private turn tracker')
  assert.deepEqual(sent, [])
  assert.equal(quiet.waiting(), 2)
  // The turn ends (a Stop, a revoke, the ask answered): the tracker has no bound turn any more.
  bind(null)
  quiet.recheck()
  await flush()
  assert.deepEqual(sent, ['peer message', 'meeting line'], 'released in arrival order')
  assert.equal(quiet.waiting(), 0)
})

test('hold: with no trusted turn live every card goes out at once, exactly as before', async () => {
  const { quiet, notify, card, sent, built } = rig()
  await notify(card('peer message'))
  await notify(card('meeting line'))
  assert.deepEqual(built, ['peer message', 'meeting line'])
  assert.deepEqual(sent, ['peer message', 'meeting line'])
  assert.equal(quiet.waiting(), 0)
})

test('hold: a permission verdict is another method and is never held', async () => {
  const clock = fakeClock()
  const got: unknown[] = []
  const quiet = createQuietTurns({ ...clock, ownerUserId: OWNER, trusted: () => TYPED, deliveryOf: () => null })
  const notify = holdChannelCardsDuringQuietTurn(quiet, async (n: unknown) => { got.push(n) })
  await notify({ method: 'notifications/claude/channel/permission', params: { request_id: 'r', behavior: 'allow' } })
  assert.equal(got.length, 1)
})

test('typed turn: the same owner\'s message in the same chat passes at once; another chat, a wake and anyone else wait', async () => {
  const { notify, card, sent, bind } = rig()
  bind(TYPED)
  await notify(card('owner again, same chat', { opens: 'message', chatId: '900' }))
  assert.deepEqual(sent, ['owner again, same chat'])
  void notify(card('owner, another chat', { opens: 'message', chatId: '901' }))
  void notify(card('the owner\'s own wake', { opens: 'wake', chatId: '900' }))
  void notify(card('a peer'))
  await flush()
  assert.deepEqual(sent, ['owner again, same chat'])
})

test('typed turn: the cards that hold nobody\'s words pass at once, and so do a Stop and the owner\'s stamped ask in that chat', async () => {
  const { notify, card, sent, bind } = rig()
  bind(TYPED)
  await notify(card('peer conversation closed', { carried: true }))
  await notify(card('stop', { stop: true }))
  await notify(card('the owner asks on a call about this chat', { opens: 'ask', chatId: '900' }))
  assert.deepEqual(sent, ['peer conversation closed', 'stop', 'the owner asks on a call about this chat'])
})

test('voice ask: its turn is that ask\'s alone, so everything waits but a Stop', async () => {
  const { clock, notify, card, sent, bind } = rig()
  bind(ASK(clock.now() + 20 * 60_000))
  void notify(card('owner types in the chat', { opens: 'message', chatId: '900' }))
  void notify(card('a second ask of the same call', { opens: 'ask', chatId: '900' }))
  void notify(card('peer conversation closed', { carried: true }))
  void notify(card('a peer'))
  await flush()
  assert.deepEqual(sent, [])
  await notify(card('stop', { stop: true }))
  assert.deepEqual(sent, ['stop'], 'a Stop goes in at once; the tracker ends the trust, as before')
})

test('five minutes at most: a card past it is let in while the turn still runs, and only that card', async () => {
  const { clock, quiet, notify, card, sent, lines, bind } = rig()
  bind(TYPED)
  void notify(card('early'))
  await flush()
  clock.advance(60_000)
  void notify(card('late'))
  await flush()
  clock.advance(QUIET_CARD_MAX_WAIT_MS - 60_000 - 1)
  await flush()
  assert.deepEqual(sent, [])
  clock.advance(1)
  await flush()
  assert.deepEqual(sent, ['early'], 'let in at five minutes; from here the tracker ends the trust exactly as before')
  assert.equal(quiet.waiting(), 1)
  assert.ok(lines.some((line) => /five minutes/.test(line)))
  clock.advance(60_000)
  await flush()
  assert.deepEqual(sent, ['early', 'late'])
  assert.equal(QUIET_CARD_MAX_WAIT_MS, 5 * 60_000)
})

test('five minutes is counted from when the card first arrived, across a release that holds it again', async () => {
  const { clock, quiet, notify, card, sent, bind, delivered } = rig()
  bind(TYPED)
  void notify(card('peer'))
  await flush()
  clock.advance(4 * 60_000)
  // The turn ends and at once another of the owner's begins (the tracker is bound again before the card resends).
  bind(null)
  quiet.recheck()
  bind({ chatId: '901', askId: null, deadline: null })
  await flush()
  assert.deepEqual(sent, [], 'the next trusted turn holds it again')
  clock.advance(60_000)
  await flush()
  assert.deepEqual(sent, ['peer'], 'four minutes plus one: its five minutes are over')
  void delivered
})

test('an ask\'s deadline ends the hold with no other event: what waited goes out', async () => {
  const { clock, notify, card, sent, bind } = rig()
  bind(ASK(clock.now() + 30_000))
  void notify(card('peer'))
  await flush()
  clock.advance(29_000)
  await flush()
  assert.deepEqual(sent, [])
  clock.advance(1_500)
  await flush()
  assert.deepEqual(sent, ['peer'])
})

test('release: the owner\'s own cards go first, each opening its turn, and what was behind waits again', async () => {
  const { quiet, notify, card, sent, bind, delivered } = rig()
  bind(ASK(Date.parse('2026-11-11T10:20:00.000Z')))
  void notify(card('peer A'))
  void notify(card(`the owner's wake ${tag(TOKEN)}`, { opens: 'wake', chatId: '900' }))
  void notify(card('peer B'))
  await flush()
  delivered(TOKEN)
  // The ask ends. The wake is released first, alone, to an idle CLI: it is pending as the next trusted turn.
  bind(null)
  quiet.recheck()
  await flush()
  assert.deepEqual(sent, [`the owner's wake ${tag(TOKEN)}`], 'the wake goes alone, so it is its own prompt')
  assert.equal(quiet.waiting(), 2)
  // Its prompt begins and the tracker admits it; later its turn ends.
  bind({ chatId: '900', askId: null, deadline: null })
  quiet.noteBegin(`the owner's wake ${tag(TOKEN)}`)
  await flush()
  assert.equal(sent.length, 1)
  bind(null)
  quiet.recheck()
  await flush()
  assert.deepEqual(sent.slice(1), ['peer A', 'peer B'], 'the rest in arrival order')
})

test('pending: the owner\'s card handed to an idle CLI holds what comes right behind it, before its prompt is seen', async () => {
  const { clock, quiet, notify, card, sent, delivered } = rig()
  delivered(TOKEN)
  await notify(card(`owner message ${tag(TOKEN)}`, { opens: 'message', chatId: '900' }))
  assert.deepEqual(quiet.live(), { chatId: '900', ask: false, deadline: null })
  void notify(card('peer, 100 ms later'))
  await flush()
  assert.deepEqual(sent, [`owner message ${tag(TOKEN)}`])
  // No prompt of it ever begins (the CLI injected it into a turn that had just started): the hold lets go.
  clock.advance(QUIET_BEGIN_WITHIN_MS)
  await flush()
  assert.deepEqual(sent, [`owner message ${tag(TOKEN)}`, 'peer, 100 ms later'])
  assert.equal(quiet.live(), null)
})

test('pending: only a card the tracker really took as the owner\'s, new, to an idle CLI', async () => {
  // The tracker made it nobody's (a replay, a stamp that did not verify).
  const replay = rig()
  replay.delivered(TOKEN, OWNER, true)
  await replay.notify(replay.card(`replayed wake ${tag(TOKEN)}`, { opens: 'wake', chatId: '900' }))
  assert.equal(replay.quiet.live(), null)
  const nobody = rig()
  nobody.delivered(TOKEN, null)
  await nobody.notify(nobody.card(`unverified ${tag(TOKEN)}`, { opens: 'ask', chatId: '900' }))
  assert.equal(nobody.quiet.live(), null)
  // The CLI is in the middle of a turn: the card is injected or queued, and nothing is held for it yet.
  const busy = rig({ idle: () => false })
  busy.delivered(TOKEN)
  await busy.notify(busy.card(`owner message ${tag(TOKEN)}`, { opens: 'message', chatId: '900' }))
  assert.equal(busy.quiet.live(), null)
  // A card with no descriptor never opens one, whatever its token says.
  const plain = rig()
  plain.delivered(TOKEN)
  await plain.notify(plain.card(`a card ${tag(TOKEN)}`))
  assert.equal(plain.quiet.live(), null)
})

test('pending ends at its own prompt: from there the tracker\'s bound turn decides', async () => {
  const { quiet, notify, card, sent, bind, delivered } = rig()
  delivered(TOKEN)
  await notify(card(`owner message ${tag(TOKEN)}`, { opens: 'message', chatId: '900' }))
  void notify(card('peer'))
  await flush()
  // Another prompt begins first: still pending.
  quiet.noteBegin(`something else ${tag(OTHER)}`)
  await flush()
  assert.deepEqual(sent.length, 1)
  // Its own prompt begins, and the tracker admitted nobody (it ran beside another delivery): nothing to hold for.
  bind(null)
  quiet.noteBegin(`owner message ${tag(TOKEN)}`)
  await flush()
  assert.deepEqual(sent, [`owner message ${tag(TOKEN)}`, 'peer'])
})

test('switched off, or with no private turn hook: nothing is ever held', async () => {
  const { notify, card, sent, bind, quiet, delivered } = rig({ enabled: () => false })
  bind(TYPED)
  delivered(TOKEN)
  await notify(card('peer'))
  await notify(card(`owner message ${tag(TOKEN)}`, { opens: 'message', chatId: '901' }))
  assert.deepEqual(sent, ['peer', `owner message ${tag(TOKEN)}`])
  assert.equal(quiet.live(), null)
})

test('a builder that sends nothing and a send that fails leave no hold behind', async () => {
  const clock = fakeClock()
  const quiet = createQuietTurns({ ...clock, ownerUserId: OWNER, trusted: () => null, deliveryOf: () => ({ token: TOKEN, actingUserId: OWNER, replayed: false }) })
  const over = (send: (n: unknown) => Promise<unknown>) => holdChannelCardsDuringQuietTurn(quiet, holdChannelCardsDuringGrantedRun(createScheduleGrantRuns(), send))
  const failing = over(async () => { throw new Error('transport closed') })
  await assert.rejects(Promise.resolve(failing({ method: 'notifications/claude/channel', params: () => ({ content: `x ${tag(TOKEN)}` }), quiet: { opens: 'message', chatId: '900' } })))
  assert.equal(quiet.live(), null, 'a card that never reached the CLI opens nothing')
  const empty = over(async () => undefined)
  await empty({ method: 'notifications/claude/channel', params: () => null, quiet: { opens: 'message', chatId: '900' } })
  assert.equal(quiet.live(), null)
  // The same card, sent: it does open one.
  const fine = over(async () => undefined)
  await fine({ method: 'notifications/claude/channel', params: () => ({ content: `x ${tag(TOKEN)}` }), quiet: { opens: 'message', chatId: '900' } })
  assert.deepEqual(quiet.live(), { chatId: '900', ask: false, deadline: null })
})

test('a released card keeps its descriptor through the inner hold\'s resend', async () => {
  // The scheduled run hold sits inside this one and resends the card it was handed (without the descriptor).
  const { clock, notify, card, sent, bind } = rig()
  void clock
  let inner: { params: unknown } | null = null
  const quiet = createQuietTurns({ ownerUserId: OWNER, trusted: () => TYPED, deliveryOf: () => null })
  const chain: { notify?: (n: unknown) => unknown } = {}
  chain.notify = holdChannelCardsDuringQuietTurn(quiet, async (n: { params: unknown }) => { inner = n; return undefined }, { resend: (n: unknown) => chain.notify!(n) })
  await chain.notify({ method: 'notifications/claude/channel', params: () => ({ content: 'owner again' }), quiet: { opens: 'message', chatId: '900' } })
  assert.ok(inner, 'passed: the same owner, the same chat')
  // The inner hold resends its own copy later: still the owner's message in that chat, so it passes again.
  const first = inner
  inner = null
  await chain.notify(first)
  assert.ok(inner, 'the descriptor rode along')
  void notify; void card; void sent; void bind
})

// ── The switch, the voice cards, and the real server.ts wiring ────────────────

import { readFileSync } from 'node:fs'
import { quietTurnEnabled, voiceQuietCard } from '../lib/quiet-turn.mjs'

test('BGOS_QUIET_TURN: on unless it says off, 0, false or no', () => {
  for (const value of [undefined, '', 'on', 'true', '1', 'yes', 'anything']) assert.equal(quietTurnEnabled(value), true, String(value))
  for (const value of ['off', ' OFF ', '0', 'false', 'False', 'no']) assert.equal(quietTurnEnabled(value), false, value)
})

test('voice cards: a stamped consult or dispatch can open the owner\'s turn, a Stop passes, an unstamped consult never waits, an unstamped task names nothing', () => {
  const actor = { actingUserId: OWNER, deadline: 1 }
  assert.deepEqual(voiceQuietCard({ ownerUserId: OWNER, consult: { consultId: 'c', chatId: '10', actor }, meta: { event_type: 'voice_consult' } }), { opens: 'ask', chatId: '10' })
  assert.deepEqual(voiceQuietCard({ ownerUserId: OWNER, dispatch: { taskId: '41', chatId: '10', actor }, meta: { event_type: 'voice_task_dispatch' } }), { opens: 'ask', chatId: '10' })
  // An unstamped consult has seconds to be answered: it is never held (review F3). An unstamped task waits.
  assert.deepEqual(voiceQuietCard({ ownerUserId: OWNER, consult: { consultId: 'c', chatId: '10', actor: null }, meta: {} }), { within: 0 })
  assert.equal(voiceQuietCard({ ownerUserId: OWNER, dispatch: { taskId: '41', chatId: '10', actor: null }, meta: {} }), null)
  assert.deepEqual(voiceQuietCard({ ownerUserId: OWNER, consult: { consultId: 'c', chatId: '10', actor: { actingUserId: 'user_other', deadline: 1 } } }), { within: 0 })
  assert.deepEqual(voiceQuietCard({ ownerUserId: OWNER, meta: { event_type: 'stop_turn' } }), { stop: true })
  assert.equal(voiceQuietCard({ ownerUserId: OWNER, meta: { event_type: 'voice_task_dispatch' } }), null)
  assert.equal(voiceQuietCard(), null)
})

const server = readFileSync('server.ts', 'utf8')

test('server: the quiet turn hold sits outside the scheduled run hold (which builds a card) and inside the lock', () => {
  const chain = server.slice(server.indexOf('const sendMcpNotification = mcp.notification.bind(mcp)'), server.indexOf('function publishBrowserPrivateTurn'))
  const rawAt = chain.indexOf('privateTurns.rawCard(')
  const grantAt = chain.indexOf('holdChannelCardsDuringGrantedRun(scheduleGrantRuns,')
  const quietAt = chain.indexOf('holdChannelCardsDuringQuietTurn(quietTurns,')
  const effortAt = chain.indexOf('holdChannelCardsWhileBusy(modelEffortControl,')
  assert.ok(rawAt > 0 && grantAt > rawAt && quietAt > grantAt && effortAt > quietAt, 'raw card < grant hold < quiet hold < effort lock')
  // A released card goes back through the whole chain, from both holds.
  assert.equal((chain.match(/resend: \(notification: [^)]*\) => mcp\.notification\(notification\)/g) ?? []).length, 2)
})

test('server: the hold reads the tracker\'s own bound turn, and is off without the server\'s word, the hook, the lock or the switch', () => {
  assert.match(server, /const quietTurns = createQuietTurns\(\{\n\s*trusted: \(\) => privateTurns\.quiet\(\),\n\s*deliveryOf: \(card: unknown\) => privateTurns\.deliveryOf\(card\),\n\s*ownerUserId: USER_ID,/)
  assert.match(server, /idle: \(\) => !hookTurnLive,/)
  // Review F3: OFF unless the server said on (VOICE_ASK_STAMP, read from its capabilities reply), whatever else holds.
  assert.match(server, /enabled: \(\) => QUIET_TURN_ENABLED && serverQuietTurn && lockHeld && PRIVATE_HOOK\.registered,/)
  assert.match(server, /\nlet serverQuietTurn = false\n/)
  assert.equal((server.match(/serverQuietTurn = /g) ?? []).length, 2, 'declared off, and set in one place only')
  assert.match(server, /const next = serverQuietTurnOf\(data\)/)
  // A fetch that failed, or the bundled copy, reads as off: the argument is the reply itself, null on any error.
  assert.match(server, /noteServerQuietTurn\(data\)/)
  // Review F2: with the switch on, a voice card the server did not stamp is one it refused to call the owner's.
  assert.match(server, /voiceCardsUntrusted: \(\) => serverQuietTurn \}\)/)
  assert.match(server, /const QUIET_TURN_ENABLED = quietTurnEnabled\(process\.env\.BGOS_QUIET_TURN\)/)
})

test('server: every lane names what its card is from the same actor the tracker is given; a steer passes like a Stop', () => {
  for (const lane of ['poll', 'stream', 'ws']) {
    assert.match(server, new RegExp(`scheduleGrant: ${lane}Grant, quiet: steerPlan \\? \\{ stop: true \\} : quietCardOf\\(\\{ ownerUserId: USER_ID, actingUserId: ${lane}Actor,`), lane)
    // The same actor expression feeds the grant, the descriptor and (inside the builder) the delivery.
    assert.match(server, new RegExp(`const ${lane}Actor = privateActor\\(`))
  }
  assert.match(server, /quiet: quietCardOf\(\{ ownerUserId: USER_ID, actingUserId: privateActor\(\{ senderType: 'user', senderUserId: privateSenderUserId\(edited\.raw\) \}\), senderType: 'user', chatId: edited\.chatId \}\)/)
  // The cards that hold nobody's words, and the owner's own tap at every tap site that names a tapper.
  assert.match(server, /quiet: p\.ownerInbound \? \{ carried: true \} : null/)
  assert.match(server, /transport: 'ws',\n\s*\},\n\s*\}\), \{ quiet: \{ carried: true \} \}\)\)\.catch\(\(\) => \{\}\)/)
  assert.equal((server.match(/quiet: (?:readTapperUserId\(payload\)|answer\.tapperUserId) === USER_ID \? \{ carried: true \} : null/g) ?? []).length, 4)
})

test('server: a stamped task is delivered through the tracker on both lanes, an unstamped one exactly as before', () => {
  const ws = server.slice(server.indexOf("realtimeSocket.on('voice_task_dispatch'"), server.indexOf('// One-click updates:'))
  assert.match(ws, /const dispatchActor = voiceDispatchActor\(\{ meta: payload\?\.eventMeta, taskId, frameAssistantId: payload\?\.assistant_id, assistantId: ASSISTANT_ID, ownerUserId: USER_ID, now: Date\.now\(\) \}\)/)
  assert.match(ws, /content: dispatchActor\n\s*\? privateTurns\.deliver\(\{\n\s*content: text,\n\s*actingUserId: dispatchActor\.actingUserId,\n\s*chatId,\n\s*dispatch: \{ taskId: dispatchActor\.taskId, deadline: dispatchActor\.deadline \},\n\s*\}\)\n\s*: text,/)
  // A voice ask carries no reason to send email, on either lane.
  assert.doesNotMatch(ws, /emailBasis:/)
  assert.match(ws, /quiet: quietCardOf\(\{ ownerUserId: USER_ID, actingUserId: dispatchActor\?\.actingUserId \?\? null, senderType: 'user', chatId, ask: true \}\)/)
  // The stamp is never read from anything the model wrote.
  assert.doesNotMatch(ws, /meta: (question|context|payload\?\.args)/)
  const deps = server.slice(server.indexOf('  notify: (content, meta, consult, dispatch) =>'), server.indexOf('  getIdentity: getVoiceIdentity,'))
  assert.match(deps, /: dispatch\?\.actor\n\s*\? privateTurns\.deliver\(\{\n\s*content,\n\s*actingUserId: dispatch\.actor\.actingUserId,\n\s*chatId: dispatch\.chatId,\n\s*dispatch: \{ taskId: dispatch\.taskId, deadline: dispatch\.actor\.deadline \},\n\s*\}\)\n\s*: content,/)
  assert.match(deps, /quiet: voiceQuietCard\(\{ ownerUserId: USER_ID, consult, dispatch, meta \}\)/)
})

test('server: reporting a task ends its turn before the report is posted, and the CLI turn boundaries drive the hold', () => {
  const complete = server.slice(server.indexOf("    case 'complete_voice_task': {"), server.indexOf("    case 'voice_consult_reply': {"))
  const endAt = complete.indexOf('privateTurns.endDispatch(taskId)')
  const postAt = complete.indexOf('await bgosPost(`integrations/voice-tasks/')
  assert.ok(endAt > 0 && postAt > endAt, 'the trust ends first')
  assert.match(complete, /privateTurns\.endDispatch\(taskId\)\n\s*quietTurns\.recheck\(\)\n\s*publishBrowserPrivateTurn\(\)/)
  // After the tracker's begin, and after its end.
  assert.match(server, /const began = privateTurns\.begin\([^\n]*\n\s*scheduleGrantRuns\.noteBegin\(payload\.prompt\)\n[^\n]*\n\s*quietTurns\.noteBegin\(payload\.prompt\)/)
  assert.match(server, /privateTurns\.end\(hookLineAt === null[^\n]*\n[^\n]*\n\s*scheduleGrantRuns\.noteStop\(\)\n[^\n]*\n\s*quietTurns\.recheck\(\)/)
  assert.match(server, /if \(event\.name === 'SessionEnd'\) quietTurns\.recheck\(\)/)
})

test('server (review F1, F3): both lanes put the stamp\'s owner words on the card, and every meeting card names its own limit', () => {
  const ws = server.slice(server.indexOf("realtimeSocket.on('voice_task_dispatch'"), server.indexOf('// One-click updates:'))
  assert.match(ws, /buildVoiceTaskDispatchText\(\{ taskId, question, context, \.\.\.\(dispatchActor \? \{ ownerWords: dispatchActor\.ownerWords \} : \{\}\) \}\)/)
  const rpc = readFileSync('lib/voice-rpc.ts', 'utf8')
  assert.match(rpc, /buildVoiceTaskDispatchText\(\{ taskId, question, context, \.\.\.\(stamp \? \{ ownerWords: stamp\.ownerWords \} : \{\}\) \}\)/)
  assert.match(rpc, /\.\.\.\(stamp\?\.ownerWords \? \{ ownerWords: stamp\.ownerWords \} : \{\}\),/)
  // Five meeting cards (three message lanes, the turn change and the resync), each 150 s at most.
  assert.equal((server.match(/\{ quiet: \{ within: 150_000 \} \}/g) ?? []).length, 5)
})

test('review F3: the hold waits the shorter of five minutes and the card\'s own limit', async () => {
  const { clock, notify, card, sent, lines, bind } = rig()
  bind(TYPED)
  void notify(card('meeting line', { within: 150_000 }))
  void notify(card('peer'))
  void notify(card('consult', { within: 0 }))
  void notify(card('never shorter than nothing', { within: -5 }))
  void notify(card('never longer than five minutes', { within: 60 * 60_000 }))
  await flush()
  assert.deepEqual(sent, ['consult', 'never shorter than nothing'])
  clock.advance(150_000 - 1)
  await flush()
  assert.equal(sent.length, 2)
  clock.advance(1)
  await flush()
  assert.deepEqual(sent.slice(2), ['meeting line'])
  clock.advance(150_000)
  await flush()
  assert.deepEqual(sent.slice(3), ['peer', 'never longer than five minutes'])
  // A card let in at its own limit says so, apart from the five minute line.
  assert.ok(lines.some((line) => /its own time limit/.test(line)))
})

test('review F4: a turn that ended while the CLI still runs keeps holding until the CLI is idle', async () => {
  let idle = false
  const { clock, quiet, notify, card, sent, bind, delivered } = rig({ idle: () => idle })
  bind(ASK(Date.parse('2026-11-11T10:20:00.000Z')))
  void notify(card('peer'))
  void notify(card(`the owner's message ${tag(TOKEN)}`, { opens: 'message', chatId: '900' }))
  await flush()
  delivered(TOKEN)
  // The ask is reported mid turn: the tracker's turn is gone, the CLI turn is not.
  bind(null)
  quiet.recheck()
  await flush()
  assert.deepEqual(sent, [], 'nothing goes into the running turn')
  assert.equal(quiet.waiting(), 2)
  // A card that arrives now waits as well, and a Stop still passes.
  void notify(card('late peer'))
  void notify(card('stop', { stop: true }))
  await flush()
  assert.deepEqual(sent, ['stop'])
  // The CLI turn stops: the owner's own card first, alone.
  idle = true
  quiet.recheck()
  await flush()
  assert.deepEqual(sent.slice(1), [`the owner's message ${tag(TOKEN)}`])
  assert.equal(quiet.waiting(), 2)
  // With nothing ever bound, a busy CLI alone holds nothing.
  const fresh = rig({ idle: () => false })
  void fresh.notify(fresh.card('peer'))
  await flush()
  assert.deepEqual(fresh.sent, ['peer'])
  void clock
})
