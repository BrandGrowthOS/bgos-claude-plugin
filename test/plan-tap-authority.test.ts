/**
 * WHO may answer a plan card, and what happens to a tap from anyone else.
 *
 * THE DEFECT (Data's blocker on #150). `applyPlanAnswer` took no clicker id,
 * while the permission intake beside it has always passed `clickerUserId` and
 * applied #142's rule. So on a SHARED assistant any person who could see the
 * chat could tap Go ahead on a plan proposed to someone else, and the agent was
 * handed "the owner approved your plan, proceed" for a plan its owner never
 * saw. A plan is the permission to do a whole piece of work, so it deserves at
 * least the binding a single tool call already had.
 *
 * THE RULE IS #142's, NULL AWARE, NOT A NEW ONE: a tap that NAMES a different
 * person than the one the plan was proposed to is refused (no directive, the
 * plan stays open, the chip stays up, nothing reaches the model); a tap that
 * names nobody is accepted, because no backend stamps a tapper id on an
 * answer today, and refusing those would refuse every real approval.
 *
 * WHY THE FIRST CASES RUN THE REAL FUNCTION OUT OF server.ts. applyPlanAnswer
 * lives in server.ts, which cannot be imported without booting a daemon, and
 * a source grep is green on exactly the defect it cannot see (settlePlan's own
 * history says so). So the harness below lifts the declared functions out of
 * the source, transpiles them, and runs them against stubs: the assertion is
 * about what the function DOES with a second person's tap, on whatever code
 * is checked out.
 *
 * Run with: npx tsx --test test/plan-tap-authority.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

import * as planCard from '../lib/plan-card.ts'
import * as permissionRelay from '../lib/permission-relay.ts'

// Normalized to LF: the working tree is CRLF on a Windows checkout.
const SERVER = readFileSync(new URL('../server.ts', import.meta.url), 'utf8').replace(
  /\r\n/g,
  '\n',
)

/**
 * A top level `function <name>(` in server.ts, through its closing brace on a
 * line of its own, or '' when server.ts declares no such function. Every top
 * level function in that file ends on a bare `}` line, which is what makes the
 * slice safe without a parser.
 */
function declaredFunction(name: string): string {
  const start = SERVER.indexOf(`\nfunction ${name}(`)
  if (start === -1) return ''
  const end = SERVER.indexOf('\n}\n', start)
  assert.ok(end > start, `${name} must end on a bare closing brace`)
  return SERVER.slice(start + 1, end + 3)
}

const OWNER = 'owner-user'
const A = 'user-a'
const B = 'user-b'
const CHAT = '77'
const CARD = 4242

function planPayload(door: string = 'typed'): Record<string, unknown> {
  return {
    kind: planCard.PLAN_CARD_KIND,
    agent_route: planCard.PLAN_AGENT_ROUTE,
    v: 1,
    title: 'Refactor the thing',
    steps: [{ text: 'do it' }],
    door,
    enforced: false,
    plan_id: 'p1',
    revision: 1,
    state: 'proposed',
  }
}

interface Harness {
  apply: (input: Record<string, unknown>) => {
    summary: string | null
    directive: string | null
    callbackData: string | null
  }
  foreignPlanTap: ((input: Record<string, unknown>) => boolean) | null
  openPlansByChat: Map<string, Record<string, unknown>>
  settled: Array<{ chatId: string; wasPlanMode: boolean }>
  logs: string[]
}

/**
 * The plan answer functions out of server.ts, live. `foreignPlanTap` is the
 * helper the fix declares beside applyPlanAnswer (the boot sweep asks it too,
 * before it strips the chips); on code without it only applyPlanAnswer is
 * lifted, which is exactly the code under test.
 */
function harness(opts: { record?: { requesterUserId?: string } | null } = {}): Harness {
  const source = [declaredFunction('foreignPlanTap'), declaredFunction('applyPlanAnswer')]
    .filter((s) => s !== '')
    .join('\n')
  assert.ok(source.includes('function applyPlanAnswer('), 'applyPlanAnswer must exist')
  const js = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText

  const openPlansByChat = new Map<string, Record<string, unknown>>()
  if (opts.record !== null) {
    openPlansByChat.set(CHAT, {
      chatId: CHAT,
      messageId: CARD,
      planId: 'p1',
      revision: 1,
      postedAtMs: Date.now(),
      payload: planPayload(),
      ...(opts.record ?? { requesterUserId: A }),
    })
  }
  const settled: Array<{ chatId: string; wasPlanMode: boolean }> = []
  const logs: string[] = []
  const scope: Record<string, unknown> = {
    ...permissionRelay,
    ...planCard,
    openPlansByChat,
    // The real settlePlan deletes the record and writes the status line and
    // the chip; the spy records the call and does the one local part.
    settlePlan: (chatId: string, wasPlanMode: boolean) => {
      settled.push({ chatId, wasPlanMode })
      openPlansByChat.delete(chatId)
    },
    log: (line: string) => logs.push(line),
    USER_ID: OWNER,
  }
  const names = Object.keys(scope).filter((k) => /^[A-Za-z_$][\w$]*$/.test(k))
  const factory = new Function(
    ...names,
    `${js}\nreturn { apply: applyPlanAnswer, foreignPlanTap: typeof foreignPlanTap === 'function' ? foreignPlanTap : null }`,
  )
  const built = factory(...names.map((k) => scope[k])) as {
    apply: Harness['apply']
    foreignPlanTap: Harness['foreignPlanTap']
  }
  return { ...built, openPlansByChat, settled, logs }
}

function tap(clickerUserId: string | null, callbackData: string = planCard.PLAN_CHIP_GO) {
  return {
    chatId: CHAT,
    messageId: CARD,
    callbackData,
    eventMetaPayload: planPayload(),
    clickerUserId,
    via: 'poll',
  }
}

// ── The blocker ──────────────────────────────────────────────────────────────

test("a plan proposed to A and approved by B is REFUSED: no directive, the plan still open", () => {
  const h = harness({ record: { requesterUserId: A } })
  const out = h.apply(tap(B))
  assert.equal(
    out.directive,
    null,
    "B's tap was honoured: the agent was told to proceed on a plan proposed to A",
  )
  assert.equal(out.summary, null, 'a refused tap must not be described to the model either')
  assert.equal(out.callbackData, null)
  assert.equal(h.settled.length, 0, 'a refused tap must not settle the plan or take the chip down')
  assert.ok(h.openPlansByChat.has(CHAT), 'the plan keeps waiting for the person it was proposed to')
  assert.ok(
    h.logs.some((l) => l.includes(`from user ${B}`) && l.includes(`belongs to ${A}`)),
    'the refusal is logged in the shape the permission path writes for a foreign click',
  )
})

test("A's own stamped tap is accepted", () => {
  const h = harness({ record: { requesterUserId: A } })
  const out = h.apply(tap(A))
  assert.ok(out.directive, 'the person the plan was proposed to may answer it')
  assert.equal(out.callbackData, planCard.PLAN_CHIP_GO)
  assert.equal(h.settled.length, 1)
  assert.ok(!h.openPlansByChat.has(CHAT))
})

test('an UNSTAMPED tap is accepted, which is every tap on today\'s backend', () => {
  const h = harness({ record: { requesterUserId: A } })
  const out = h.apply(tap(null))
  assert.ok(out.directive, 'refusing a tap nobody named would refuse every real approval')
  assert.equal(h.settled.length, 1)
})

test('B refused on every chip, not only Go ahead', () => {
  for (const code of [planCard.PLAN_CHIP_NO, planCard.PLAN_CUSTOM_SENTINEL]) {
    const h = harness({ record: { requesterUserId: A } })
    const out = h.apply(tap(B, code))
    assert.equal(out.directive, null, `${code} from B must not reach the model`)
    assert.equal(h.settled.length, 0, `${code} from B must not settle the plan`)
  }
})

// ── After a restart: no record, the row alone ────────────────────────────────

test('after a restart the plan belongs to the OWNER, #142\'s direction for an unknown requester', () => {
  // No record survives a restart and nothing on the plan row names its
  // person, so the requester is the configured owner, exactly as the
  // permission post falls back when no inbound user has been seen.
  const unstamped = harness({ record: null })
  assert.ok(unstamped.apply(tap(null)).directive, 'an unstamped tap is still accepted')
  const owner = harness({ record: null })
  assert.ok(owner.apply(tap(OWNER)).directive, "the owner's stamped tap is accepted")
  const other = harness({ record: null })
  const out = other.apply(tap(B))
  assert.equal(out.directive, null, 'a tap naming someone else is refused, never looser')
  assert.equal(other.settled.length, 0)
})

test("a record for a DIFFERENT card in the chat does not lend its person", () => {
  // The map holds the newest plan per chat; a tap on an older card must not be
  // judged against the newer card's person.
  const h = harness({ record: { requesterUserId: B } })
  h.openPlansByChat.get(CHAT)!.messageId = CARD + 1
  const out = h.apply(tap(B))
  assert.equal(out.directive, null, "B proposed the newer plan, not this one; the owner's rule applies")
})

test('a non plan click from anyone passes through untouched', () => {
  const h = harness({ record: { requesterUserId: A } })
  const out = h.apply({
    chatId: CHAT,
    messageId: CARD + 99,
    callbackData: 'u:ship-it',
    clickerUserId: B,
    via: 'stream',
  })
  assert.deepEqual(
    { ...out },
    { summary: null, directive: null, callbackData: null, refused: false },
  )
  assert.equal(h.settled.length, 0)
  assert.deepEqual(h.logs, [])
})

// ── The pure rule ────────────────────────────────────────────────────────────

test('planTapAuthority is #142\'s null aware rule', () => {
  const { planTapAuthority } = planCard
  assert.deepEqual(planTapAuthority({ clickerUserId: null, requesterUserId: A }), {
    kind: 'accept',
  })
  assert.deepEqual(planTapAuthority({ clickerUserId: A, requesterUserId: A }), { kind: 'accept' })
  assert.deepEqual(planTapAuthority({ clickerUserId: B, requesterUserId: A }), {
    kind: 'foreign',
    clickerUserId: B,
    requesterUserId: A,
  })
})

test('planRequesterFor: this card\'s record, else the owner, never anyone else', () => {
  const { planRequesterFor } = planCard
  assert.equal(
    planRequesterFor({ open: { messageId: CARD, requesterUserId: A }, messageId: CARD, ownerUserId: OWNER }),
    A,
  )
  assert.equal(
    planRequesterFor({ open: { messageId: CARD + 1, requesterUserId: A }, messageId: CARD, ownerUserId: OWNER }),
    OWNER,
  )
  assert.equal(planRequesterFor({ open: undefined, messageId: CARD, ownerUserId: OWNER }), OWNER)
})

// ── Every call site hands the tapper in, and drops a refusal ─────────────────

test('the record names the plan\'s person, from the permission relay\'s own source', () => {
  const post = SERVER.slice(
    SERVER.indexOf('openPlansByChat.set(planChatId, {'),
    SERVER.indexOf('sessionBinder.recordReplyMessageId(cardMessageId)'),
  )
  assert.ok(post.length > 0)
  assert.match(post, /requesterUserId: lastInboundUserByChat\.get\(planChatId\) \?\? USER_ID,/)
  // The permission relay's line, so the two stay one source.
  assert.match(SERVER, /const requesterUserId = lastInboundUserByChat\.get\(chatId\) \?\? USER_ID/)
})

test('all three call sites pass a NULL AWARE clicker id and drop a refused tap', () => {
  assert.equal(
    (SERVER.match(/applyPlanAnswer\(\{/g) ?? []).length,
    3,
    'the poll, the stream and the boot sweep, and no other',
  )
  // The poll: the answer payload, through the null aware reader.
  const poll = SERVER.slice(
    SERVER.indexOf('const planAnswer = applyPlanAnswer({\n        chatId,\n        messageId: mm.id,'),
  ).slice(0, 900)
  assert.match(poll, /clickerUserId: senderUserIdCandidate\(payload\),/)
  assert.match(poll, /via: 'poll',/)
  assert.match(poll, /if \(planAnswer\.refused\) continue/)
  // The stream: the answer object, the same reader the permission branch
  // above it reads through senderUserIdOf.
  const stream = SERVER.slice(
    SERVER.indexOf('const planAnswer = applyPlanAnswer({\n    chatId,\n    messageId: view.messageId,'),
  ).slice(0, 900)
  assert.match(stream, /clickerUserId: senderUserIdCandidate\(answer\),/)
  assert.match(stream, /via: 'stream',/)
  assert.match(
    stream,
    /if \(planAnswer\.refused\) \{\n\s*log\(\n\s*`button_clicked DROPPED at plan binding[\s\S]*?\n\s*return\n/,
  )
  // The boot sweep: asked BEFORE the strip, so a refused tap leaves the card
  // exactly as it was.
  const sweep = SERVER.slice(
    SERVER.indexOf('async function announceMissedPlanAnswers('),
    SERVER.indexOf("if (announced === 0) log('Plan boot sweep"),
  )
  assert.ok(sweep.length > 0)
  const ask = sweep.indexOf('foreignPlanTap({')
  const strip = sweep.indexOf('buildPlanRetireBody()')
  assert.ok(ask > 0 && ask < strip, 'the sweep must ask who tapped before it strips the chips')
  assert.match(sweep, /const clickerUserId = senderUserIdCandidate\(payload\)/)
  assert.match(sweep, /clickerUserId,\n\s*via: 'boot sweep',/)
  // And never through the owner fallback, which would make every unstamped
  // tap the owner's and refuse every real approval on a shared assistant.
  for (const site of [poll, stream]) {
    assert.ok(!/clickerUserId: senderUserIdOf\(/.test(site))
  }
})
