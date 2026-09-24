/**
 * THE DAEMON HOST'S PERMISSION GATE.
 *
 * What these cases are protecting, in one line each: an action never runs
 * without the owner's yes, and an action the owner allowed runs exactly once
 * however many callers were waiting on it.
 *
 * WHY THE FAKES ARE A LITTLE MACHINE AND NOT CANNED ANSWERS. Every branch
 * here is about what the gate does with what the SERVER said, so the fake
 * server holds state the test moves: a card is posted into it, the owner
 * "answers" by changing that state, and the gate's poll reads it. A fake that
 * simply returned `{state:'answered'}` would pass whether or not the gate ever
 * posted a card, and the card post is the half that asks a human at all.
 *
 * Time is real here, just small: see the note on POLL_MS below for why an
 * instant fake clock could not express "the owner answered while it was
 * polling", which is the only interesting moment in the whole file.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  GATE_ATTACH_MS,
  GATE_DEFAULT_WAIT_S,
  GATE_WAIT_MAX_S,
  GateKeeper,
  RELAY_CALL_CAP_MS,
  deniedMessage,
  newGateId,
  remainingWaitSeconds,
  waitSecondsFrom,
} from '../lib/browser-gate.mjs'

/** The backend's BROWSER_GATE_ID_PATTERN, copied so a drift shows up here. */
const GATE_ID_PATTERN = /^g_[A-Za-z0-9_-]{4,64}$/

type Card = Record<string, unknown>

/**
 * A fake HOAI that remembers the card and answers what the test tells it to.
 * `answer()` is the owner tapping a button.
 */
function server({ acceptCard = true }: { acceptCard?: boolean } = {}) {
  const cards: Card[] = []
  const state = new Map<string, { state: string; choice: string | null }>()
  let reads = 0
  let failNextReads = 0
  return {
    cards,
    get reads() {
      return reads
    },
    failReads(n: number) {
      failNextReads = n
    },
    answer(gateId: string, choice: string | null, as = 'answered') {
      state.set(gateId, { state: as, choice })
    },
    forget(gateId: string) {
      state.set(gateId, { state: 'unknown', choice: null })
    },
    postCard: async (card: Card) => {
      if (!acceptCard) return false
      cards.push(card)
      state.set(String(card.gateId), { state: 'open', choice: null })
      return true
    },
    readGate: async (gateId: string) => {
      reads++
      if (failNextReads > 0) {
        failNextReads--
        throw new Error('network')
      }
      return state.get(gateId) ?? { state: 'unknown', choice: null }
    },
  }
}

/**
 * REAL time, in milliseconds instead of minutes.
 *
 * The first version of this file injected an instant clock, and every case
 * that needed the owner to answer WHILE the gate was polling failed: a sleep
 * that resolves at once runs the entire park inside one microtask drain, so
 * the test never got a turn to tap the button and the gate always timed out.
 * Seven of eighteen went red for that reason and none of them was about the
 * product.
 *
 * So the poll interval is 5 ms and the parks are seconds, which keeps the
 * whole file under two seconds while leaving the ORDERING real: a poll is a
 * genuine macrotask, an answer written between two polls is genuinely
 * between them, and the race in `_await` is the one that ships.
 */
const POLL_MS = 5

function keeper(srv: ReturnType<typeof server>, over: Record<string, unknown> = {}) {
  return new GateKeeper({
    postCard: srv.postCard,
    readGate: srv.readGate,
    randomBytes: (n: number) => Buffer.alloc(n, 7),
    sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
    pollMs: POLL_MS,
    ...over,
  })
}

/** Let at least one poll happen, so "the owner answered later" really is later. */
function aPollLater() {
  return new Promise((r) => setTimeout(r, POLL_MS * 2))
}

const ASK = {
  key: '/profiles/a1',
  assistantId: 42,
  kind: 'write' as const,
  origin: 'https://example.com',
  summary: 'Click "Send"',
  waitSeconds: 60,
  // The buttons the owner gets. REQUIRED: the backend DTO is
  // @ArrayMinSize(1), and the host shipped without this field for a round
  // because the fake server took the card anyway.
  choices: ['allow_once', 'allow_session', 'always_allow', 'trust_site', 'deny'],
}

test('ORDERING GUARD: the attach budget sits under the relay cap and OVER the default wait', () => {
  // The numbers are a chain, not three independent constants
  // (agent-browser-relay.service.ts documents it):
  //   backend host deadline 130 s > relay call cap 120 s > attach 110 s > default wait 60 s
  //
  // This guard exists because the middle one shipped at 55 s, UNDER the
  // default wait, so every ordinary gate parked a few seconds before its own
  // deadline and no agent ever got an answer in the call that asked for it.
  // Nothing went red: every other case here passes attachMs explicitly, so
  // the default was the one value no test used.
  assert.ok(GATE_ATTACH_MS < RELAY_CALL_CAP_MS, `attach ${GATE_ATTACH_MS} must stay under the relay cap ${RELAY_CALL_CAP_MS}, or the agent gets host_timeout instead of a gate id`)
  assert.ok(
    GATE_ATTACH_MS > GATE_DEFAULT_WAIT_S * 1000,
    `attach ${GATE_ATTACH_MS} must exceed the default wait ${GATE_DEFAULT_WAIT_S}s, or an ordinary gate parks instead of answering in its own call`,
  )
  // And the ceiling is genuinely longer than the budget, so a long wait is
  // the case that parks rather than the only case that does not.
  assert.ok(GATE_WAIT_MAX_S * 1000 > GATE_ATTACH_MS)
})

test('a DEFAULT gate answers inside its own call rather than parking', async () => {
  // The behaviour the ordering above buys, driven rather than asserted about:
  // no attachMs is passed, so the shipped default decides, and a 60 second
  // wait answered by the owner comes back as an answer, not gate_parked.
  const srv = server()
  const g = keeper(srv)
  let ran = 0
  const raised = g.raise({ ...ASK, waitSeconds: GATE_DEFAULT_WAIT_S, action: () => Promise.resolve(++ran) })
  await Promise.resolve()
  srv.answer(String(srv.cards[0]!.gateId), 'allow_once')
  const out = await raised
  assert.equal(out.parked, undefined, 'an ordinary gate must not park')
  assert.equal(out.allowed, true)
  await out.ran
  assert.equal(ran, 1)
})

test('the gate id is the shape the backend accepts, or the card post 400s', () => {
  assert.match(newGateId((n: number) => Buffer.alloc(n, 3)), GATE_ID_PATTERN)
  // The positive control: the pattern is capable of failing.
  assert.doesNotMatch('not-a-gate', GATE_ID_PATTERN)
})

test('a gate posts ONE card carrying what the owner needs to decide', async () => {
  const srv = server()
  const g = keeper(srv)
  srv.answer('', null) // no effect; the id is not known until raise mints it
  const raised = g.raise(ASK)
  // The card is posted before any poll, so the owner is asked first.
  await Promise.resolve()
  assert.equal(srv.cards.length, 1)
  const card = srv.cards[0]!
  assert.match(String(card.gateId), GATE_ID_PATTERN)
  assert.equal(card.assistantId, 42)
  assert.equal(card.kind, 'write')
  assert.equal(card.origin, 'https://example.com')
  assert.equal(card.summary, 'Click "Send"')
  assert.ok(Number(card.waitSeconds) >= 1 && Number(card.waitSeconds) <= 1800, 'waitSeconds must satisfy the DTO')
  srv.answer(String(card.gateId), 'allow_once')
  assert.equal((await raised).allowed, true)
})

test('an allowed gate runs the held action, and a denied one never does', async () => {
  for (const [choice, shouldRun] of [
    ['allow_once', true],
    ['allow_session', true],
    ['always_allow', true],
    ['trust_site', true],
    ['deny', false],
  ] as const) {
    const srv = server()
    const g = keeper(srv)
    let ran = 0
    const raised = g.raise({ ...ASK, action: () => Promise.resolve(++ran) })
    await Promise.resolve()
    srv.answer(String(srv.cards[0]!.gateId), choice)
    const out = await raised
    if (out.ran) await out.ran
    assert.equal(out.allowed, shouldRun, `${choice} should ${shouldRun ? 'allow' : 'refuse'}`)
    assert.equal(ran, shouldRun ? 1 : 0, `${choice} ran the action ${ran} times`)
  }
})

test('an answered card with a choice the host cannot read is a DENIAL, not a retry', async () => {
  const srv = server()
  const g = keeper(srv)
  let ran = 0
  const raised = g.raise({ ...ASK, action: () => Promise.resolve(++ran) })
  await Promise.resolve()
  srv.answer(String(srv.cards[0]!.gateId), null)
  const out = await raised
  assert.equal(out.allowed, false)
  assert.equal(out.reason, 'denied_by_owner')
  assert.equal(ran, 0, 'an unreadable answer must never run the action')
})

test('a card the server reports EXPIRED refuses, and the action does not run', async () => {
  const srv = server()
  const g = keeper(srv)
  let ran = 0
  const raised = g.raise({ ...ASK, waitSeconds: 600, action: () => Promise.resolve(++ran) })
  await Promise.resolve()
  srv.answer(String(srv.cards[0]!.gateId), null, 'expired')
  const out = await raised
  assert.equal(out.allowed, false)
  assert.equal(out.reason, 'gate_timeout')
  assert.equal(ran, 0)
})

test('an owner who never answers runs out of park, and the action does not run', async () => {
  // The one case that has to spend real time, because running out of park is
  // the thing being tested. One second, with the poll at 5 ms.
  const srv = server()
  const g = keeper(srv)
  let ran = 0
  const out = await g.raise({ ...ASK, waitSeconds: 1, action: () => Promise.resolve(++ran) })
  assert.equal(out.allowed, false)
  assert.equal(out.reason, 'gate_timeout')
  assert.equal(ran, 0)
  assert.ok(srv.reads > 1, `the host should have asked more than once in a park; it asked ${srv.reads} times`)
})

test('a card that could not be posted ends the gate at once rather than parking on nobody', async () => {
  const srv = server({ acceptCard: false })
  const g = keeper(srv)
  let ran = 0
  const out = await g.raise({ ...ASK, waitSeconds: 1800, action: () => Promise.resolve(++ran) })
  assert.equal(out.allowed, false)
  assert.equal(out.reason, 'card_unreachable')
  assert.equal(ran, 0)
  assert.equal(srv.reads, 0, 'nothing should be polled for a gate nobody was asked about')
})

test('a gate the server forgets twice ends, instead of waiting out a park nobody can answer', async () => {
  const srv = server()
  const g = keeper(srv)
  const raised = g.raise({ ...ASK, waitSeconds: 600 })
  await Promise.resolve()
  srv.forget(String(srv.cards[0]!.gateId))
  const out = await raised
  assert.equal(out.allowed, false)
  assert.equal(out.reason, 'gate_lost')
})

test('a transient read failure is retried inside the park, so a blip cannot deny an allow', async () => {
  const srv = server()
  const g = keeper(srv)
  const raised = g.raise({ ...ASK, waitSeconds: 60 })
  await Promise.resolve()
  const gateId = String(srv.cards[0]!.gateId)
  srv.failReads(3)
  srv.answer(gateId, 'allow_session')
  const out = await raised
  assert.equal(out.allowed, true, 'three failed reads inside the park must not decide the gate')
  assert.equal(out.choice, 'allow_session')
})

test('a gate with no choices fails CLOSED, because a card with no buttons cannot be answered', async () => {
  // The real DTO refuses it (@ArrayMinSize(1)), so posting one would 400 and
  // the gate would sit out its whole park on a card nobody can see. Better to
  // refuse here and say so.
  const srv = server()
  const g = keeper(srv)
  let ran = 0
  for (const choices of [undefined, [], 'deny' as never]) {
    const out = await g.raise({ ...ASK, choices: choices as never, action: () => Promise.resolve(++ran) })
    assert.equal(out.allowed, false)
    assert.equal(srv.cards.length, 0)
    assert.equal(ran, 0)
  }
})

test('a kind the card route cannot carry fails CLOSED and posts nothing', async () => {
  // `vision` is a policy gate kind and not a backend card kind, so posting it
  // would 400. Failing closed here is the difference between an action that
  // did not run and an action that ran because the ask bounced.
  const srv = server()
  const g = keeper(srv)
  let ran = 0
  const out = await g.raise({ ...ASK, kind: 'vision' as never, action: () => Promise.resolve(++ran) })
  assert.equal(out.allowed, false)
  assert.equal(out.reason, 'kind_unsupported')
  assert.equal(srv.cards.length, 0)
  assert.equal(ran, 0)
})

test('a call that runs out of budget PARKS with the gate id, and the action has not run', async () => {
  const srv = server()
  const g = keeper(srv)
  let ran = 0
  const out = await g.raise({ ...ASK, waitSeconds: 600, attachMs: 20, action: () => Promise.resolve(++ran) })
  assert.equal(out.parked, true)
  assert.match(String(out.gateId), GATE_ID_PATTERN)
  assert.equal(ran, 0, 'a parked gate has not been answered, so nothing may run')
})

test('THE ONE THAT MATTERS: a parked gate re-attached by two callers runs the action exactly once', async () => {
  const srv = server()
  const g = keeper(srv)
  let ran = 0
  const parked = await g.raise({ ...ASK, waitSeconds: 600, attachMs: 20, action: () => Promise.resolve(++ran) })
  assert.equal(parked.parked, true)
  const gateId = String(parked.gateId)
  srv.answer(gateId, 'allow_once')
  // Two waiters, as an agent that called wait_gate twice would produce.
  const [a, b] = await Promise.all([g.attach(gateId), g.attach(gateId)])
  await Promise.all([a.ran, b.ran])
  assert.equal(a.allowed, true)
  assert.equal(b.allowed, true)
  assert.equal(ran, 1, `the held action ran ${ran} times; the owner allowed it once`)
})

test('a second ask while one is open is refused with the OPEN gate id, not queued behind it', async () => {
  const srv = server()
  const g = keeper(srv)
  const first = await g.raise({ ...ASK, waitSeconds: 600, attachMs: 20 })
  assert.equal(first.parked, true)
  const second = await g.raise({ ...ASK, summary: 'Click "Delete"', waitSeconds: 600, attachMs: 20 })
  assert.equal(second.parked, true)
  assert.equal(second.busy, true)
  assert.equal(second.gateId, first.gateId, 'the agent must be pointed at the gate that is actually open')
  assert.equal(srv.cards.length, 1, 'a second card would ask the owner twice for one decision')
})

test('a gate id nobody raised here is unknown, rather than a silent allow', async () => {
  const g = keeper(server())
  assert.equal((await g.attach('g_neverseen')).unknown, true)
  assert.equal((await g.attach('')).unknown, true)
})

test('closeAll denies every open gate, so a stopping host leaves nothing hanging', async () => {
  const srv = server()
  const g = keeper(srv)
  let ran = 0
  const parked = await g.raise({ ...ASK, waitSeconds: 600, attachMs: 20, action: () => Promise.resolve(++ran) })
  g.closeAll()
  const after = await g.attach(String(parked.gateId))
  assert.equal(after.allowed, false)
  assert.equal(after.reason, 'session_closed')
  assert.equal(ran, 0)
})

test('pending() names the open gate on that browser and nothing on another', async () => {
  const srv = server()
  const g = keeper(srv)
  await g.raise({ ...ASK, waitSeconds: 600, attachMs: 20 })
  assert.equal(g.pending('/profiles/a1')!.summary, 'Click "Send"')
  assert.equal(g.pending('/profiles/other'), null)
})

test('wait_seconds is clamped to what the schema and the DTO allow', () => {
  assert.equal(waitSecondsFrom(undefined), 60)
  assert.equal(waitSecondsFrom(0), 60)
  assert.equal(waitSecondsFrom(-5), 60)
  assert.equal(waitSecondsFrom('nonsense'), 60)
  assert.equal(waitSecondsFrom(90), 90)
  assert.equal(waitSecondsFrom(99999), 1800)
  assert.equal(waitSecondsFrom(1.9), 1)
})

test('the card carries the REMAINING park, never a zero or an over-cap the DTO would reject', () => {
  assert.equal(remainingWaitSeconds(60_000), 60)
  assert.equal(remainingWaitSeconds(0), 1, '@Min(1): a card posted at the deadline must still be valid')
  assert.equal(remainingWaitSeconds(-1), 1)
  assert.equal(remainingWaitSeconds(9_999_999), 1800, '@Max(1800)')
})

test('every refusal reason has its own sentence, so an agent is never told "denied" for a timeout', () => {
  const reasons = ['gate_timeout', 'session_closed', 'card_unreachable', 'gate_lost', 'kind_unsupported', 'denied_by_owner']
  const said = reasons.map((r) => deniedMessage(r, 60))
  assert.equal(new Set(said).size, reasons.length, 'two reasons share a sentence')
  for (const s of said) assert.ok(s.length > 20 && /did not run|denied this action/.test(s), s)
  assert.match(deniedMessage('gate_timeout', 90), /90 seconds/)
})
