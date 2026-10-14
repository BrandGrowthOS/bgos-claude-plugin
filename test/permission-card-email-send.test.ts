/**
 * Release 0.69.0, where #228 (a held email_send card carries the email the owner's tap approves) meets #233 (a
 * permission card goes to the owner's own chat, and a chat that refuses it with the backend's 403 is skipped while
 * THIS request moves on to the next chat).
 *
 *   - The 403 retry re-enters relayPermissionToOwner. It must hand on the floor hook's record, or the retried
 *     email_send card loses the email it binds and is let through to the server with no card at all.
 *   - The held email_send card picks its chat itself (emailSendCardChat, main chats only). It reads the same
 *     ownership and skips the same refused chats as every other card, so it never goes to a chat known to be a
 *     share recipient's and a 403 retry never posts it into one chat twice.
 *
 * Run with: npx tsx --test test/permission-card-email-send.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { createRefusedChats, isPermissionCardOwnerChatOnly, pickPermissionChat } from '../lib/peer-refusal.ts'
import { buildPermissionRequestBody, cardMessageIdFrom, choiceToBehavior, permissionBackstopMs, storedWaitSeconds } from '../lib/permission-relay.ts'
import { createChatOwnership } from '../lib/chat-ownership.ts'
import { isOwnSendingTool } from '../lib/hard-floor.ts'
import { createEmailSendApprovals, emailSendCardBinding, emailSendCardChat, emailSendCardTooLong } from '../lib/email-send-approval.ts'
import { emailCallRefusal } from '../lib/agent-email-tools.ts'
import { buildFloorRecord } from '../lib/floor-state.mjs'

const OWNER = 'user_owner'
const RECIPIENT = 'user_recipient'
const SEND_TOOL = 'mcp__plugin_hoai_bgos__email_send'
const SEND_ARGS = { to: 'sam@harborhall.com', subject: 'Friday venue check', text: 'Hi Sam, could you confirm the Harbor room for Friday?' }
const SEND_BLOCK = {
  to: SEND_ARGS.to,
  subject: SEND_ARGS.subject,
  text: SEND_ARGS.text,
  body_sha256: createHash('sha256').update(SEND_ARGS.text, 'utf8').digest('hex'),
  text_preview: SEND_ARGS.text,
}
const APPROVAL_CLICK = { id: '6f1c2d3e-4b5a-4c7d-8e9f-0a1b2c3d4e5f', expiresAt: '2026-10-15T10:10:00.000Z' }
// The backend half's exact refusal (BGOS permission-card-placement.ts PERMISSION_CARD_OWNER_CHAT_ONLY).
const OWNER_CHAT_ONLY = "A permission card for the owner's machine goes only into the owner's own chat with this agent, never into a chat another person can read."

const previewOf = (args: Record<string, unknown>) =>
  `{ ${Object.entries(args).map(([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)}`).join(', ')} }`

const source = readFileSync('server.ts', 'utf8')
const relaySource = source.slice(source.indexOf('function relayPermissionToOwner('), source.indexOf('\n/**\n * A request the hard floor matched'))

class FakeHttpError extends Error {
  readonly body: string
  constructor(public status: number, message: string) {
    const body = JSON.stringify({ statusCode: status, message, path: '/api/v1/messages', timestamp: '2026-10-15T10:00:00Z' })
    super(`POST ${status}: ${body.slice(0, 200)}`)
    this.body = body
  }
}

function relayRig(opts: { monitored: string[]; main: string[]; refuse?: string[]; turn?: { actingUserId: string; chatId: string } | null }) {
  const posts: Array<{ chatId: string; emailSend: unknown }> = []
  const notes: Array<{ behavior: string; claimed: unknown }> = []
  const store = createEmailSendApprovals()
  const chatOwnership = createChatOwnership(OWNER)
  const permissionCardRefusedChats = createRefusedChats()
  const bindings: Record<string, unknown> = {
    updateDrainMode: false,
    log: () => {},
    mcp: { notification: async (n: { params: { behavior: string } }) => { notes.push({ behavior: n.params.behavior, claimed: store.claim(SEND_ARGS) }) } },
    trackMessageOperation: (fn: () => Promise<unknown>) => fn(),
    isOwnSendingTool, emailSendCardBinding, emailSendCardTooLong, emailSendCardChat, emailCallRefusal,
    AUTH: { mode: 'pairing', pairingToken: 'fake-pairing-token-for-tests-only-0000' },
    emailSendApprovals: store,
    privateTurns: { current: () => opts.turn ?? null },
    PRIVATE_MARKER_PATHS: [],
    USER_ID: OWNER,
    monitoredChatIds: opts.monitored,
    mainChatIds: opts.main,
    hookRailRefusedChats: createRefusedChats(), a2aRouteRefusedChats: createRefusedChats(), permissionCardRefusedChats,
    chatOwnership,
    pickPermissionChat,
    pendingPermissions: new Map(),
    buildPermissionRequestBody, cardMessageIdFrom, storedWaitSeconds, permissionBackstopMs, choiceToBehavior,
    isPermissionCardOwnerChatOnly,
    refuseHookRailChat: () => false,
    bgosPost: async (_path: string, body: { chatId: number | string; approvalMeta?: Record<string, unknown> }) => {
      const chatId = String(body.chatId)
      posts.push({ chatId, emailSend: body.approvalMeta?.email_send ?? null })
      if (opts.refuse?.includes(chatId)) throw new FakeHttpError(403, OWNER_CHAT_ONLY)
      return { id: 9000 + posts.length }
    },
    // The owner taps Allow once; the tap carries the approval the server issued for exactly this email.
    waitForVerdict: async (...args: unknown[]) => {
      const onTapApproval = args[6] as ((approval: unknown) => void) | undefined
      onTapApproval?.(APPROVAL_CLICK)
      return 'once'
    },
  }
  const record = buildFloorRecord({ toolName: SEND_TOOL, toolInput: SEND_ARGS, match: { ruleId: 'acts_on_owners_behalf', rulesVersion: 3, evidence: SEND_TOOL } })
  const relay = (requestId: string) => {
    const js = ts.transpileModule(`${relaySource}\nreturn relayPermissionToOwner(params, 'acts_on_owners_behalf', true, record);`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
    }).outputText
    const all = { ...bindings, record, params: { request_id: requestId, tool_name: SEND_TOOL, description: 'email_send', input_preview: previewOf(SEND_ARGS) } }
    return new Function(...Object.keys(all), js)(...Object.values(all)) as Promise<void>
  }
  return { relay, posts, notes, chatOwnership, permissionCardRefusedChats }
}

test('the 403 retry hands on the hook record: the email_send card posted in the next chat still binds the email, and the Allow carries its approval', async () => {
  // No ownership evidence yet: the main chats in the inbox's order, the recipient's first.
  const r = relayRig({ monitored: ['20', '10'], main: ['20', '10'], refuse: ['20'] })
  await r.relay('abcde')
  assert.deepEqual(r.posts.map((p) => p.chatId), ['20', '10'], 'refused in the recipient chat, then posted in the next main chat')
  assert.deepEqual(r.posts[1]!.emailSend, SEND_BLOCK, 'the retried card still names the exact email')
  assert.deepEqual(r.notes, [{ behavior: 'allow', claimed: { requestId: 'abcde', approval: APPROVAL_CLICK, binding: SEND_BLOCK } }])
  assert.equal(r.permissionCardRefusedChats.has('20'), true)
})

test('a held email_send card never goes to a chat known to be a share recipient\'s, even the chat of the turn', async () => {
  const r = relayRig({ monitored: ['20', '10'], main: ['20', '10'], turn: { actingUserId: OWNER, chatId: '20' } })
  r.chatOwnership.noteAuthor('20', RECIPIENT)
  r.chatOwnership.noteAuthor('10', OWNER)
  await r.relay('bcdef')
  assert.deepEqual(r.posts.map((p) => p.chatId), ['10'])
  assert.deepEqual(r.posts[0]!.emailSend, SEND_BLOCK)
})

test('when every main chat refuses the email_send card with the 403, each is tried once and the request is denied', async () => {
  const r = relayRig({ monitored: ['20', '21'], main: ['20', '21'], refuse: ['20', '21'] })
  await r.relay('cdefg')
  assert.deepEqual(r.posts.map((p) => p.chatId), ['20', '21'])
  assert.deepEqual(r.notes.map((n) => n.behavior), ['deny'])
})

test('emailSendCardChat: the owner\'s main chats first, never one known to be somebody else\'s; with no evidence, as before', () => {
  const none: Array<{ has(chatId: string): boolean }> = []
  const o = createChatOwnership(OWNER)
  const pick = (turn: { actingUserId: string; chatId: string } | null, main: string[], ownership: typeof o | null = o) =>
    emailSendCardChat({ turn, ownerUserId: OWNER, monitored: ['20', '10', '11', '30'], main, refused: none, ownership })
  // No evidence: exactly what #228 picks.
  for (const [turn, main] of [[null, ['20', '10']], [{ actingUserId: OWNER, chatId: '10' }, ['20', '10']], [{ actingUserId: OWNER, chatId: '30' }, []]] as const) {
    assert.equal(pick(turn, [...main]), pick(turn, [...main], null), JSON.stringify([turn, main]))
  }
  o.noteAuthor('20', RECIPIENT)
  o.noteAuthor('10', OWNER)
  o.noteAuthor('11', OWNER)
  assert.equal(pick(null, ['20', '10', '11']), '11', 'the owner main chat confirmed last')
  assert.equal(pick({ actingUserId: OWNER, chatId: '10' }, ['20', '10', '11']), '10', 'the owner turn chat, when it is a main chat')
  assert.equal(pick({ actingUserId: OWNER, chatId: '20' }, ['20', '10']), '10', 'never a recipient chat, even as the turn chat')
  assert.equal(pick(null, ['20']), undefined, 'only a recipient main chat: none here, so the default pick decides')
  assert.equal(pick({ actingUserId: OWNER, chatId: '20' }, []), undefined, 'no chat kinds known: the turn chat only when it is not somebody else\'s')
})
