/**
 * Three rules of the /login grant that the mutation proof of this change found
 * unpinned: each line could be broken and every other test stayed green, so
 * each is held here on its own, against the REAL exported code, with fakes for
 * the child process, the chat and the clock (no real sign in is ever run).
 *
 *   - The owner's own id is never a recipient of their own share. A payload
 *     that names the owner's id but labels it a share recipient, carrying the
 *     field, is a contradiction and grants nothing: isOwnerSender already says
 *     no (a field claims otherwise), so letting the grant say yes would bind
 *     the sign-in to the owner's id while the sender is unproven
 *     (isLoginGrantedRecipient, `sender.userId === owner`). The poll and
 *     stream shapes carry no shareOwnerUserId, so the share owner check does
 *     not cover for it there.
 *   - A direct method (`/login console`) picks for the open offer only when
 *     its STARTER sends it. The owner can write into a recipient's own chat,
 *     so the chat check alone does not keep the owner from choosing for a
 *     sign-in a recipient started (LoginController.command,
 *     `this.state.starterUserId === by`).
 *   - A verdict for another command never stands in for the starter. The seam
 *     makes every allowed verdict readable while `act` runs, /status's too,
 *     and /status is allowed for anyone; only an owner verdict or one carrying
 *     the login grant may bind a sign-in to its sender (ambientStarter,
 *     `verdict.grant === 'login_recipient'`).
 *
 * Run with: npx tsx --test test/sender-may-login-gaps.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { LoginController, type AuthStatus, type ChildCommand, type LoginChildHandlers } from '../lib/auth-login.ts'
import {
  isLoginGrantedRecipient,
  judgeDaemonCommand,
  readSlashSender,
  runDaemonCommand,
  type DaemonCommand,
} from '../lib/daemon-command-sender.ts'

const OWNER = 'user_2owner000000000000000000000'
const RECIPIENT = 'user_2recip000000000000000000000'
const RECIP_CHAT = '7001'
// The contract's constant, byte for byte.
const MAY_LOGIN =
  "This agent's owner allows the person writing to send /login, to sign this agent back in when its Claude sign in expires."

const WS_OWNER_LOGIN = {
  chatId: 6053,
  messageId: 42,
  userId: OWNER,
  messageType: 'slash_command',
  commandName: 'login',
  commandArgs: '',
  text: '/login',
  sender: { userId: OWNER, relationship: 'owner' },
  isSharedRecipient: false,
  shareOwnerUserId: null,
}
const WS_GRANTED_LOGIN = {
  ...WS_OWNER_LOGIN,
  chatId: 7001,
  sender: { userId: RECIPIENT, relationship: 'shared_recipient' },
  isSharedRecipient: true,
  shareOwnerUserId: OWNER,
  senderMayLogin: MAY_LOGIN,
}
// The owner delivering into the recipient's own chat.
const WS_OWNER_IN_RECIP_CHAT = { ...WS_OWNER_LOGIN, chatId: 7001 }
const STREAM_GRANTED_LOGIN = {
  id: 44,
  text: '/login',
  sender: 'user',
  messageType: 'slash_command',
  commandName: 'login',
  chatKind: 'main',
  senderUserId: RECIPIENT,
  senderRelationship: 'shared_recipient',
  senderMayLogin: MAY_LOGIN,
}

// ── fakes ────────────────────────────────────────────────────────────────────

interface FakeChild {
  cmd: ChildCommand
  handlers: LoginChildHandlers
  writes: string[]
}

function harness() {
  const children: FakeChild[] = []
  const sent: Array<{ chatId: string; text: string }> = []
  let nextMessageId = 500
  const status: AuthStatus = { loggedIn: false, authMethod: 'none', email: null, subscriptionType: null }
  const controller = new LoginController({
    ownerUserId: OWNER,
    executable: () => '/opt/claude/bin/claude',
    spawn: (cmd, handlers) => {
      const child: FakeChild = { cmd, handlers, writes: [] }
      children.push(child)
      return { write: (text) => child.writes.push(text), kill: () => {} }
    },
    readAuthStatus: async () => status,
    send: async (chatId, text) => {
      sent.push({ chatId, text })
      return nextMessageId++
    },
    now: () => 1_000_000,
    setTimer: () => 0,
    clearTimer: () => {},
    log: () => {},
  })
  return { children, sent, controller }
}

const settle = () => new Promise((resolve) => setImmediate(resolve))

/** A command through the real seam, with an act shaped like server.ts's (no starter in opts). */
async function viaSeam(
  h: ReturnType<typeof harness>,
  command: DaemonCommand,
  chatId: string,
  payload: unknown,
  commandArgs = '',
) {
  const outcome = await runDaemonCommand({
    command,
    payload,
    ownerUserId: OWNER,
    chatId,
    send: async () => {},
    log: () => {},
    act: () => h.controller.command(chatId, commandArgs, { inRoom: false }),
  })
  await settle()
  return outcome
}

// ── the owner's own id is never a recipient ──────────────────────────────────

test("a payload naming the owner's own id as a share recipient grants nothing, even with the field", () => {
  const contradictions: Array<[string, unknown]> = [
    ['ws', { ...WS_GRANTED_LOGIN, sender: { userId: OWNER, relationship: 'shared_recipient' } }],
    ['stream', { ...STREAM_GRANTED_LOGIN, senderUserId: OWNER }],
  ]
  for (const [label, payload] of contradictions) {
    const v = judgeDaemonCommand({ command: 'login', payload, ownerUserId: OWNER })
    assert.equal(v.kind, 'refuse', `${label}: the owner's id labelled a recipient is not a recipient`)
    assert.equal(isLoginGrantedRecipient(readSlashSender(payload), OWNER), false, label)
  }
  // No shareOwnerUserId on the stream shape: only the owner id rule holds.
  const streamRecipient = readSlashSender(STREAM_GRANTED_LOGIN)
  assert.equal(streamRecipient.shareOwnerUserId, null)
  assert.equal(isLoginGrantedRecipient(streamRecipient, OWNER), true, 'the real recipient is granted')
  assert.equal(isLoginGrantedRecipient(streamRecipient, RECIPIENT), false, 'and is never a recipient of their own share')
})

// ── a direct method picks only for its starter ───────────────────────────────

test("the owner's direct method in the recipient's own chat does not pick for the recipient's open offer", async () => {
  const h = harness()
  assert.equal(await viaSeam(h, 'login', RECIP_CHAT, WS_GRANTED_LOGIN), 'acted')
  assert.equal(h.controller.phase, 'awaiting_method')
  assert.equal(h.controller.starterUserId, RECIPIENT)

  assert.equal(await viaSeam(h, 'login', RECIP_CHAT, WS_OWNER_IN_RECIP_CHAT, 'console'), 'acted')
  assert.equal(h.children.length, 0, 'the owner chose nothing for a sign-in they did not start')
  assert.equal(h.controller.phase, 'awaiting_method')
  assert.equal(h.controller.starterUserId, RECIPIENT, 'and it is still bound to its starter')
  const busy = h.sent[h.sent.length - 1]!
  assert.equal(busy.chatId, RECIP_CHAT)
  assert.match(busy.text, /^A sign-in is already running/)
  assert.match(busy.text, /Send \/login cancel to stop it/, 'the owner may stop it, so is told how')

  assert.equal(await viaSeam(h, 'login', RECIP_CHAT, WS_GRANTED_LOGIN, 'subscription'), 'acted')
  assert.equal(h.children.length, 1, "the starter's direct method does pick")
  assert.deepEqual(h.children[0]!.cmd.args, ['auth', 'login', '--claudeai'])
})

// ── only a login verdict binds a non owner ───────────────────────────────────

test('a verdict for another command never stands in for the starter, even for a granted recipient', async () => {
  const h = harness()
  // /status is allowed for anyone, so its act runs under a non owner verdict
  // that carries no login grant. Were it read as the starter, a granted
  // recipient would be bound as themselves without their /login ever having
  // been judged.
  assert.equal(await viaSeam(h, 'status', RECIP_CHAT, { ...WS_GRANTED_LOGIN, commandName: 'status' }), 'acted')
  assert.equal(h.controller.phase, 'awaiting_method')
  assert.equal(h.controller.starterUserId, OWNER, 'bound to the owner, never wider')

  // The same sender's /login, judged as one, is bound to them.
  const h2 = harness()
  assert.equal(await viaSeam(h2, 'login', RECIP_CHAT, WS_GRANTED_LOGIN), 'acted')
  assert.equal(h2.controller.starterUserId, RECIPIENT)
})
