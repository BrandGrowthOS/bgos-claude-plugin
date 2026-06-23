/**
 * Regression guard for the reply-overdue / closed-peer-conversation interaction.
 *
 * Bug (fixed): a reply_overdue notification kept firing ~2 min after a peer
 * side-thread closed (turn_state:'final' / peer_conversation_closed), pressuring
 * the agent to reply into a dead thread (which wrongly reopened it).
 *
 * The overdue state machine lives module-scoped in server.ts and is not
 * exported, so this suite replicates the EXACT same logic (the same pattern the
 * message-text suite uses for the CommonMark simulator) and asserts the two
 * invariants that must hold together:
 *
 *   1. A closed peer conversation (final inbound, agent's final send, or a
 *      peer_conversation_closed event) NEVER fires an overdue, regardless of the
 *      order those signals arrive in relative to the inbound.
 *   2. A genuine unanswered USER message in the main chat STILL fires the nudge.
 *
 * If server.ts's recordInbound / markConversationClosed contract changes such
 * that either invariant breaks, this mirror should be updated in lockstep.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

const REPLY_OVERDUE_MS = 120_000

// ── Mirror of server.ts overdue state machine ────────────────────────────────
interface PendingInbound {
  messageId: number
  ts: number
  reminded: boolean
}

function makeOverdueMachine() {
  const pendingInbounds = new Map<string, PendingInbound>()
  const peerConvChats = new Map<string, string>()
  const peerConvByChat = new Map<string, string>()
  const closedPeerChats = new Set<string>()

  function rememberPeerConvChat(convId: string | undefined, chatId: string | undefined): void {
    if (!convId || !chatId) return
    peerConvChats.set(convId, chatId)
    peerConvByChat.set(chatId, convId)
  }

  function markConversationClosed(opts: { convId?: string | null; chatId?: string | null }): void {
    let chatId = opts.chatId ? String(opts.chatId) : undefined
    const convId = opts.convId != null && opts.convId !== '' ? String(opts.convId) : undefined
    if (!chatId && convId) chatId = peerConvChats.get(convId)
    if (!chatId) return
    pendingInbounds.delete(chatId)
    closedPeerChats.add(chatId)
    const resolvedConv = convId ?? peerConvByChat.get(chatId)
    if (resolvedConv) {
      peerConvChats.delete(resolvedConv)
      peerConvByChat.set(chatId, resolvedConv)
    }
  }

  function recordInbound(chatId: string, messageId: number, turnState?: string): void {
    if (!chatId) return
    if (!Number.isFinite(messageId)) return
    if (closedPeerChats.has(chatId)) return
    if (turnState === 'final') {
      markConversationClosed({ chatId })
      return
    }
    const existing = pendingInbounds.get(chatId)
    if (existing && existing.messageId >= messageId) return
    pendingInbounds.set(chatId, { messageId, ts: Date.now(), reminded: false })
  }

  // Mirror of the WS inbound_message overdue-relevant branch.
  function onWsInbound(chatId: string, messageId: number, convId?: string, turnState?: string): void {
    if (convId != null && chatId) {
      const priorConv = peerConvByChat.get(chatId)
      if (closedPeerChats.has(chatId) && priorConv !== convId) {
        closedPeerChats.delete(chatId)
      }
      rememberPeerConvChat(convId, chatId)
    }
    recordInbound(chatId, messageId, turnState)
  }

  // Returns the chat ids that WOULD fire an overdue if the sweep ran `afterMs`
  // after each pending entry was armed.
  function sweepFires(afterMs = REPLY_OVERDUE_MS): string[] {
    const fired: string[] = []
    const now = Date.now()
    for (const [chatId, p] of pendingInbounds.entries()) {
      if (p.reminded) continue
      // Simulate the timer having elapsed by checking the age threshold with a
      // forced now offset.
      if (now + afterMs - p.ts < REPLY_OVERDUE_MS) continue
      fired.push(chatId)
    }
    return fired
  }

  return { recordInbound, markConversationClosed, onWsInbound, sweepFires, closedPeerChats, pendingInbounds }
}

// ── Closed peer conversations must NOT fire overdue ──────────────────────────

test('overdue: a final-turn peer inbound does not arm an overdue (chat 1092/msg 14757)', () => {
  const m = makeOverdueMachine()
  // Peer sends its closing turn as a normal inbound carrying turn_state:'final'.
  m.onWsInbound('1092', 14757, 'conv-a', 'final')
  assert.deepEqual(m.sweepFires(), [], 'a final peer message must owe no reply')
  assert.ok(m.closedPeerChats.has('1092'), 'the side-thread chat is pinned closed')
})

test('overdue: peer_conversation_closed AFTER a non-final inbound clears the tracker (chat 1093)', () => {
  const m = makeOverdueMachine()
  m.onWsInbound('1093', 14758, 'conv-b', 'expecting_reply')
  assert.deepEqual(m.sweepFires(), ['1093'], 'before close, a live peer message is overdue-eligible')
  // The close event arrives (the agent or peer ended it).
  m.markConversationClosed({ convId: 'conv-b' })
  assert.deepEqual(m.sweepFires(), [], 'after close, no overdue fires')
})

test('overdue: close that RACES ahead of the inbound still suppresses it (ordering-proof, chat 1083)', () => {
  const m = makeOverdueMachine()
  // peer_conversation_closed arrives FIRST, while we only know the conv id from
  // a prior association; here we associate then close, then a late inbound for
  // the same conv lands.
  m.onWsInbound('1083', 14700, 'conv-c', 'expecting_reply') // establishes conv↔chat
  m.markConversationClosed({ convId: 'conv-c' })             // close
  m.onWsInbound('1083', 14705, 'conv-c', 'expecting_reply')  // late re-delivery, same conv
  assert.deepEqual(m.sweepFires(), [], 'a late inbound on a closed conv must not re-arm')
})

test('overdue: agent send_to_peer turn_state:final pins the thread closed (chat 1090/msg 14755)', () => {
  const m = makeOverdueMachine()
  m.onWsInbound('1090', 14755, 'conv-d', 'expecting_reply')
  assert.deepEqual(m.sweepFires(), ['1090'], 'peer asked; overdue-eligible until answered')
  // Agent replies AND closes via send_to_peer turn_state:'final'.
  m.markConversationClosed({ convId: 'conv-d', chatId: '1090' })
  assert.deepEqual(m.sweepFires(), [], 'agent final send clears + pins closed')
})

// ── The genuine case must STILL fire ─────────────────────────────────────────

test('overdue: a real unanswered USER message in the main chat STILL nudges (chat 1048)', () => {
  const m = makeOverdueMachine()
  // Main user chat inbound: no peer conversation id, no turn_state.
  m.recordInbound('1048', 99001)
  assert.deepEqual(m.sweepFires(), ['1048'], 'user message must still fire the overdue nudge')
  assert.ok(!m.closedPeerChats.has('1048'), 'a user chat is never marked closed')
})

test('overdue: a reopened side-thread (new conv id) can nudge again', () => {
  const m = makeOverdueMachine()
  m.onWsInbound('1090', 1, 'conv-old', 'final') // closed
  assert.ok(m.closedPeerChats.has('1090'))
  // Peer opens a FRESH conversation in the same side-thread chat.
  m.onWsInbound('1090', 2, 'conv-new', 'expecting_reply')
  assert.equal(m.closedPeerChats.has('1090'), false, 'a new conv id lifts the closed guard')
  assert.deepEqual(m.sweepFires(), ['1090'], 'the fresh conversation is overdue-eligible again')
})
