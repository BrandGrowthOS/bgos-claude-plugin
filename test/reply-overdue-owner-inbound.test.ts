/**
 * Data's review of #261 (M1): a reply reminder keeps an owner's private turn (lib/private-turn.mjs rawCard,
 * PRIVATE_CARRIED_CARDS) only when the unanswered message it names was the owner's own. server.ts keeps who sent the
 * pending inbound (the lane's privateActor, recordInbound) and marks the reminder card `owner_inbound` only then; a
 * reminder about a share recipient's or a peer agent's message carries no mark and ends the owner's turn as any card
 * with no delivery does.
 *
 * Runs recordInbound and checkReplyOverdue out of server.ts (it cannot be imported), as test/peer-403-loop.test.ts does.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { inboundOwesReply } from '../lib/channel-liveness.ts'

const SRC = readFileSync(new URL('../server.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const OWNER = 'user_owner900'
const RECIPIENT = 'user_recipient900'

function serverSlice(open: string, close: string): string {
  const start = SRC.indexOf(open)
  assert.ok(start >= 0, `${open.trim()} exists in server.ts`)
  const stop = SRC.indexOf(close, start)
  assert.ok(stop > start, `${close.trim()} ends it`)
  return SRC.slice(start, stop + close.length)
}

type Card = { content: string; meta: Record<string, string> }

/** server.ts's inbound tracker and reply-overdue sweep, with the overdue window at 0 so a sweep fires at once. */
function overdueSweep() {
  const cards: Card[] = []
  // The sweep's deaf session branch names import.meta, which is not legal outside a module; it never runs here.
  const source = [serverSlice('function recordInbound(', '\n}\n'), serverSlice('function checkReplyOverdue(', '\n}\n')].join('\n')
    .replace(/import\.meta\.url/g, 'IMPORT_META_URL')
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
  const known: Record<string, unknown> = {
    pendingInbounds: new Map(),
    meetingChatIds: new Set<string>(),
    closedPeerChats: new Set<string>(),
    peerReplyRefusedChats: new Set<string>(),
    noteMonitoredChat: () => undefined,
    markConversationClosed: () => undefined,
    inboundOwesReply,
    updateDrainMode: false,
    REPLY_OVERDUE_MS: 0,
    deafSessionAction: () => null,
    unansweredProbe: () => null,
    channelLiveness: { lastToolCallAt: 0, recentlyLive: () => true },
    deafProbeSentAt: null,
    deafEscalationDone: false,
    USER_ID: OWNER,
    log: () => undefined,
    trackMessageOperation: (op: () => Promise<unknown>) => op(),
    mcp: { notification: async (n: { params: Card }) => { cards.push(n.params) } },
  }
  const scope = new Proxy(known, {
    has: (target, key) => key in target || !(key in globalThis),
    get: (target, key) => (typeof key === 'symbol' ? undefined : target[key as string]),
    set: (target, key, value) => {
      target[key as string] = value
      return true
    },
  })
  // eslint-disable-next-line no-new-func
  const lifted = new Function('scope', `with (scope) {\n${js}\nreturn { recordInbound, checkReplyOverdue }\n}`)(scope) as {
    recordInbound(chatId: string, messageId: number, turnState?: string, senderKind?: string | null, actingUserId?: string | null): void
    checkReplyOverdue(): void
  }
  return { ...lifted, cards }
}

test('Data\'s review (M1): the reminder for the owner\'s own unanswered message is marked owner_inbound', () => {
  const sweep = overdueSweep()
  sweep.recordInbound('9001', 501, undefined, 'user', OWNER)
  sweep.checkReplyOverdue()
  assert.equal(sweep.cards.length, 1)
  assert.equal(sweep.cards[0].meta.event_type, 'reply_overdue')
  assert.equal(sweep.cards[0].meta.owner_inbound, 'true')
})

test('Data\'s review control (M1): the reminder for a share recipient\'s, a peer agent\'s or an unknown sender\'s message carries no owner_inbound', () => {
  for (const [label, senderKind, actor] of [['a share recipient', 'user', RECIPIENT], ['a peer agent', 'agent', null], ['no actor', 'user', undefined]] as const) {
    const sweep = overdueSweep()
    sweep.recordInbound('9003', 502, undefined, senderKind, actor)
    sweep.checkReplyOverdue()
    assert.equal(sweep.cards.length, 1, label)
    assert.equal('owner_inbound' in sweep.cards[0].meta, false, `${label}: no owner_inbound`)
  }
})

test('Data\'s review control (M1): a later message of someone else in the same chat replaces the owner\'s, so its reminder carries no owner_inbound', () => {
  const sweep = overdueSweep()
  sweep.recordInbound('9001', 501, undefined, 'user', OWNER)
  sweep.recordInbound('9001', 502, undefined, 'user', RECIPIENT)
  sweep.checkReplyOverdue()
  assert.equal(sweep.cards.length, 1)
  assert.equal(sweep.cards[0].meta.message_id, '502')
  assert.equal('owner_inbound' in sweep.cards[0].meta, false)
})

test('Data\'s review (M1): every lane hands recordInbound the same actor it hands privateTurns.deliver', () => {
  const actorOf = (line: string): string | null => {
    const at = line.indexOf('actingUserId: privateActor(')
    if (at < 0) return null
    const start = at + 'actingUserId: '.length
    let depth = 0
    for (let i = start; i < line.length; i++) {
      if (line[i] === '(') depth++
      else if (line[i] === ')' && --depth === 0) return line.slice(start, i + 1)
    }
    return null
  }
  const actors = SRC.split('\n').filter((line) => line.includes('content: privateTurns.deliver(')).map(actorOf)
  assert.equal(actors.length, 3, 'the poll, the stream and the socket')
  // The tracker's last argument is whether the message addressed this agent
  // (board row 59a6d097); the actor is the argument before it.
  const calls = [...SRC.matchAll(/\n\s*recordInbound\(([\s\S]*?)\)\n/g)]
    .map((m) => m[1].replace(/\s+/g, ' ').trim().replace(/,? inboundAddressesAgent\(\{[^}]*\}\),?$/, ''))
  assert.equal(calls.length, 3, 'one recordInbound per lane')
  for (const [index, actor] of actors.entries()) {
    assert.ok(actor, `lane ${index}: its deliver names an actor`)
    assert.ok(calls[index].endsWith(`, ${actor},`) || calls[index].endsWith(`, ${actor}`), `lane ${index}: recordInbound(${calls[index]}) ends with ${actor}`)
  }
})
