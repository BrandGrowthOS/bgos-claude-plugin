/**
 * Regression guard for lib/daemon-command-sender.ts: who may run a
 * daemon-handled slash command.
 *
 * The hole: /compact and /status are acted on by the daemon and never reach
 * the model, and until this gate neither handler asked who sent them. One
 * session serves every chat of the agent, so a share recipient tapping
 * /compact in their own chat compacted the owner's context. The same message
 * arrives over three rails (poll, WebSocket, stream), so the decision lives in
 * one exported pure function, judgeDaemonCommand, and the ENFORCEMENT lives
 * in one exported seam, runDaemonCommand: both server.ts handlers are a
 * single call to it with their real work passed as `act`. Two kinds of test
 * below, kept apart on purpose:
 *   BEHAVIOURAL: the decision, and the seam driven with spies (a refused
 *     sender never reaches act, the refusal is sent once, the owner reaches
 *     act with the owner audience, a failed reply is still a refusal).
 *   SHAPE: the server.ts wiring, whose handlers and rails are module-scoped
 *     and not exported, so nothing here runs them. Those pins read the
 *     source. Green there is text, not runtime; the section comment above
 *     them lists what they cannot catch.
 *
 * Fixtures below copy the REAL wire shapes, verified against the backend:
 * the WS inbound_message carries a nested `sender` block plus mirror share
 * fields, and its top level `userId` is the OWNER (the socket room); the poll
 * and stream rows carry flat `sender_user_id` / `sender_relationship`, and
 * their top level `user_id` is the OWNER too. The fail-closed tests rely on
 * that: a payload with the owner's id at the top level and NO sender field
 * must still refuse, or the owner-id fallback that server.ts's senderUserIdOf
 * uses for attribution would have leaked into an authorization decision.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  isOwnerSender,
  judgeDaemonCommand,
  readSlashSender,
  runDaemonCommand,
  type DaemonCommand,
  type DaemonCommandAllowed,
} from '../lib/daemon-command-sender.ts'

const OWNER = 'user_2owner000000000000000000000'
const RECIPIENT = 'user_2recip000000000000000000000'
const COMMANDS: DaemonCommand[] = ['compact', 'status']

// WS inbound_message, as SendMessageService emits it for a human turn.
const WS_OWNER = {
  chatId: 6053,
  messageId: 42,
  userId: OWNER,
  assistantId: 900,
  messageType: 'slash_command',
  commandName: 'compact',
  commandArgs: '',
  text: '/compact',
  sender: { userId: OWNER, displayName: 'Ava Chen', relationship: 'owner' },
  isSharedRecipient: false,
  shareOwnerUserId: null,
}

const WS_RECIPIENT = {
  ...WS_OWNER,
  chatId: 7001,
  sender: { userId: RECIPIENT, displayName: 'Ben Ruiz', relationship: 'shared_recipient' },
  isSharedRecipient: true,
  shareOwnerUserId: OWNER,
}

// REST poll row (also the stream replay row), as the integrations controller
// projects it: flat sender fields, `sender` is the role string, `user_id` is
// the owner.
const POLL_OWNER = {
  id: 42,
  message_id: 42,
  chat_id: 6053,
  text: '/compact',
  sender: 'user',
  message_type: 'slash_command',
  command_name: 'compact',
  command_args: '',
  user_id: OWNER,
  assistant_id: 900,
  chat_kind: 'main',
  sender_user_id: OWNER,
  sender_display_name: 'Ava Chen',
  sender_relationship: 'owner',
}

const POLL_RECIPIENT = {
  ...POLL_OWNER,
  chat_id: 7001,
  sender_user_id: RECIPIENT,
  sender_display_name: 'Ben Ruiz',
  sender_relationship: 'shared_recipient',
}

function judge(command: DaemonCommand, payload: unknown, ownerUserId = OWNER) {
  return judgeDaemonCommand({ command, payload, ownerUserId })
}

function stripKeys<T extends Record<string, unknown>>(obj: T, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = { ...obj }
  for (const k of keys) delete out[k]
  return out
}

// ── the owner ────────────────────────────────────────────────────────────────

test('the owner is allowed on both transports, for both commands', () => {
  for (const command of COMMANDS) {
    for (const [transport, payload] of [['ws', WS_OWNER], ['poll', POLL_OWNER]] as const) {
      const v = judge(command, payload)
      assert.equal(v.kind, 'allow', `${transport} ${command}: owner must be allowed`)
      if (v.kind === 'allow') assert.equal(v.audience, 'owner', `${transport} ${command}`)
    }
  }
})

test('the owner typing inside a room is still the owner (identity is the id, not the room role)', () => {
  // A persistent group answers room_member for everyone and carries no share keys.
  const ws = stripKeys(
    { ...WS_OWNER, sender: { userId: OWNER, displayName: 'Ava Chen', relationship: 'room_member' } },
    ['isSharedRecipient', 'shareOwnerUserId'],
  )
  const poll = { ...POLL_OWNER, chat_kind: 'room', sender_relationship: 'room_member' }
  for (const payload of [ws, poll]) {
    const v = judge('compact', payload)
    assert.equal(v.kind, 'allow')
  }
})

// ── a share recipient ────────────────────────────────────────────────────────

test('a share recipient is refused /compact on both transports, with a reply they will see', () => {
  for (const [transport, payload] of [['ws', WS_RECIPIENT], ['poll', POLL_RECIPIENT]] as const) {
    const v = judge('compact', payload)
    assert.equal(v.kind, 'refuse', `${transport}: a recipient must not compact the owner's session`)
    if (v.kind !== 'refuse') continue
    assert.equal(v.reason, 'not_owner')
    assert.match(v.reply, /\/compact was not run/)
    assert.match(v.reply, /owner/)
    assert.equal(v.sender.userId, RECIPIENT, 'the verdict names who was refused')
  }
})

test('a share recipient gets the reduced /status answer, not a refusal and not the owner answer', () => {
  for (const [transport, payload] of [['ws', WS_RECIPIENT], ['poll', POLL_RECIPIENT]] as const) {
    const v = judge('status', payload)
    assert.equal(v.kind, 'allow', `${transport}: /status mutates nothing, so it is answered`)
    if (v.kind === 'allow') assert.equal(v.audience, 'non_owner', `${transport}`)
  }
})

test('a room member who is not the owner is treated like a recipient', () => {
  const ws = stripKeys(
    { ...WS_OWNER, sender: { userId: RECIPIENT, displayName: 'Ben Ruiz', relationship: 'room_member' } },
    ['isSharedRecipient', 'shareOwnerUserId'],
  )
  const poll = { ...POLL_RECIPIENT, chat_kind: 'room', sender_relationship: 'room_member' }
  for (const payload of [ws, poll]) {
    assert.equal(judge('compact', payload).kind, 'refuse')
    const s = judge('status', payload)
    assert.equal(s.kind, 'allow')
    if (s.kind === 'allow') assert.equal(s.audience, 'non_owner')
  }
})

test('both transports reach the same verdict for the same person', () => {
  for (const command of COMMANDS) {
    const ws = judge(command, WS_RECIPIENT)
    const poll = judge(command, POLL_RECIPIENT)
    assert.equal(ws.kind, poll.kind, command)
    if (ws.kind === 'refuse' && poll.kind === 'refuse') {
      assert.equal(ws.reason, poll.reason, command)
      assert.equal(ws.reply, poll.reply, command)
    }
    if (ws.kind === 'allow' && poll.kind === 'allow') assert.equal(ws.audience, poll.audience, command)
  }
})

// ── fail closed: missing sender ──────────────────────────────────────────────

test('a payload with NO sender field refuses /compact even though the owner id sits at the top level', () => {
  // This is the case that makes the owner-id fallback a hole: on both wires
  // the top level id IS the owner's, for every sender.
  const wsNoSender = stripKeys(WS_OWNER, ['sender', 'isSharedRecipient', 'shareOwnerUserId'])
  const pollNoSender = stripKeys(POLL_OWNER, [
    'sender_user_id',
    'sender_display_name',
    'sender_relationship',
  ])
  assert.equal(wsNoSender.userId, OWNER, 'fixture: the owner id is still on the payload')
  assert.equal(pollNoSender.user_id, OWNER, 'fixture: the owner id is still on the row')
  for (const [transport, payload] of [['ws', wsNoSender], ['poll', pollNoSender]] as const) {
    const v = judge('compact', payload)
    assert.equal(v.kind, 'refuse', `${transport}: no sender means no proof of ownership`)
    if (v.kind === 'refuse') {
      assert.equal(v.reason, 'sender_unknown')
      assert.match(v.reply, /no sender identity/)
    }
    const s = judge('status', payload)
    assert.equal(s.kind, 'allow')
    if (s.kind === 'allow') assert.equal(s.audience, 'non_owner', `${transport}: an unknown asker is a stranger`)
  }
})

test('a payload that is not an object refuses /compact', () => {
  for (const payload of [null, undefined, 'string', 42, true, []]) {
    const v = judge('compact', payload)
    assert.equal(v.kind, 'refuse', `payload ${JSON.stringify(payload)}`)
    if (v.kind === 'refuse') assert.equal(v.reason, 'sender_unknown')
  }
})

test('the poll row role string in `sender` is not mistaken for a sender block', () => {
  const s = readSlashSender({ ...POLL_OWNER })
  assert.equal(s.userId, OWNER)
  assert.equal(s.malformed, false, "'user' is the role, not a malformed block")
})

// ── fail closed: malformed sender ────────────────────────────────────────────

test('a malformed sender field refuses /compact', () => {
  const cases: Array<[string, unknown]> = [
    ['a sender block that names nobody', { ...WS_OWNER, sender: { displayName: 'x', relationship: 'owner' } }],
    ['a sender block with a numeric id', { ...WS_OWNER, sender: { userId: 42, relationship: 'owner' } }],
    ['a sender block with an empty id', { ...WS_OWNER, sender: { userId: '   ', relationship: 'owner' } }],
    ['a flat id that is a number', { ...POLL_OWNER, sender_user_id: 42 }],
    ['a flat id that is empty', { ...POLL_OWNER, sender_user_id: '' }],
    ['nested and flat ids that disagree', { ...WS_OWNER, sender_user_id: RECIPIENT }],
    ['a share flag that is not a boolean', { ...WS_OWNER, isSharedRecipient: 'yes' }],
    ['a relationship that is not a string', { ...POLL_OWNER, sender_relationship: 7 }],
    ['a relationship that is empty', { ...POLL_OWNER, sender_relationship: '' }],
  ]
  for (const [label, payload] of cases) {
    assert.equal(readSlashSender(payload).malformed, true, `${label}: reads as malformed`)
    const v = judge('compact', payload)
    assert.equal(v.kind, 'refuse', `${label}: must refuse`)
    if (v.kind === 'refuse') {
      assert.equal(v.reason, 'sender_malformed', label)
      assert.match(v.reply, /could not be read/)
    }
    const s = judge('status', payload)
    assert.equal(s.kind, 'allow', label)
    if (s.kind === 'allow') assert.equal(s.audience, 'non_owner', label)
  }
})

// ── the relationship fields can only take ownership away ─────────────────────

test('an owner id contradicted by a recipient marker is refused', () => {
  const cases: Array<[string, unknown]> = [
    ['relationship shared_recipient', { ...WS_OWNER, sender: { userId: OWNER, relationship: 'shared_recipient' } }],
    ['isSharedRecipient true', { ...WS_OWNER, isSharedRecipient: true }],
    ['shareOwnerUserId set', { ...WS_OWNER, shareOwnerUserId: OWNER }],
    ['flat sender_relationship shared_recipient', { ...POLL_OWNER, sender_relationship: 'shared_recipient' }],
  ]
  for (const [label, payload] of cases) {
    const v = judge('compact', payload)
    assert.equal(v.kind, 'refuse', label)
    if (v.kind === 'refuse') assert.equal(v.reason, 'not_owner', label)
  }
})

test('a relationship the backend does not use today never grants ownership on its own', () => {
  const stranger = { ...WS_OWNER, sender: { userId: RECIPIENT, relationship: 'org_member' } }
  assert.equal(readSlashSender(stranger).relationship, 'unrecognised')
  assert.equal(judge('compact', stranger).kind, 'refuse')
  // ...but it does not take ownership away from the owner either: the id decides.
  const owner = { ...WS_OWNER, sender: { userId: OWNER, relationship: 'org_member' } }
  assert.equal(judge('compact', owner).kind, 'allow')
})

test('a relationship of owner with a different id is not the owner', () => {
  const impostor = { ...WS_OWNER, sender: { userId: RECIPIENT, relationship: 'owner' } }
  const v = judge('compact', impostor)
  assert.equal(v.kind, 'refuse')
  if (v.kind === 'refuse') assert.equal(v.reason, 'not_owner')
})

test('an empty owner id matches nobody', () => {
  assert.equal(isOwnerSender(readSlashSender(WS_OWNER), ''), false)
  assert.equal(isOwnerSender(readSlashSender(WS_OWNER), '   '), false)
  assert.equal(judge('compact', WS_OWNER, '').kind, 'refuse')
})

// ── the refusal text ─────────────────────────────────────────────────────────

test('every refusal reply is short, names the command, and carries no em or en dash', () => {
  const payloads: unknown[] = [
    WS_RECIPIENT,
    stripKeys(WS_OWNER, ['sender', 'isSharedRecipient', 'shareOwnerUserId']),
    { ...WS_OWNER, sender: { userId: 42 } },
  ]
  const seen = new Set<string>()
  for (const payload of payloads) {
    const v = judge('compact', payload)
    assert.equal(v.kind, 'refuse')
    if (v.kind !== 'refuse') continue
    seen.add(v.reason)
    assert.ok(v.reply.length > 0 && v.reply.length < 220, `reply length ${v.reply.length}`)
    assert.match(v.reply, /^\/compact was not run/)
    assert.doesNotMatch(v.reply, /[\u2013\u2014]/, 'no en dash or em dash in user-facing copy')
  }
  assert.deepEqual([...seen].sort(), ['not_owner', 'sender_malformed', 'sender_unknown'])
})

// ── runDaemonCommand: the enforcement, driven with spies (BEHAVIOURAL) ───────
//
// Both server.ts handlers are one call to runDaemonCommand with their real
// work passed as `act`. So "a refused sender never reaches the action" is code
// that RUNS here, against the real exported seam, with injected send and act.

function spy<A extends unknown[]>(impl?: (...args: A) => Promise<void>) {
  const calls: A[] = []
  const fn = async (...args: A): Promise<void> => {
    calls.push(args)
    if (impl) await impl(...args)
  }
  return { calls, fn }
}

async function drive(
  command: DaemonCommand,
  payload: unknown,
  opts: { sendFails?: boolean; actFails?: boolean } = {},
) {
  const send = spy<[string, string]>(
    opts.sendFails
      ? async () => {
          throw new Error('send failed')
        }
      : undefined,
  )
  const act = spy<[DaemonCommandAllowed]>(
    opts.actFails
      ? async () => {
          throw new Error('act failed')
        }
      : undefined,
  )
  const lines: string[] = []
  const outcome = await runDaemonCommand({
    command,
    payload,
    ownerUserId: OWNER,
    chatId: '7001',
    send: send.fn,
    act: act.fn,
    log: (l) => lines.push(l),
  })
  return { outcome, send, act, lines }
}

test('a share recipient never reaches the /compact action; the refusal is sent once, to their chat', async () => {
  for (const [transport, payload] of [['ws', WS_RECIPIENT], ['poll', POLL_RECIPIENT]] as const) {
    const r = await drive('compact', payload)
    assert.equal(r.outcome, 'refused', transport)
    assert.equal(r.act.calls.length, 0, `${transport}: act must not run for a recipient`)
    assert.equal(r.send.calls.length, 1, `${transport}: exactly one refusal reply`)
    assert.equal(r.send.calls[0]?.[0], '7001', 'sent to the chat the command came from')
    assert.match(String(r.send.calls[0]?.[1]), /^\/compact was not run/)
    assert.ok(r.lines.some((l) => /refused/.test(l)), `${transport}: the refusal is logged`)
  }
})

test('a missing, malformed or non-object sender never reaches the /compact action', async () => {
  const cases: unknown[] = [
    stripKeys(WS_OWNER, ['sender', 'isSharedRecipient', 'shareOwnerUserId']),
    stripKeys(POLL_OWNER, ['sender_user_id', 'sender_display_name', 'sender_relationship']),
    { ...WS_OWNER, sender: { userId: 42 } },
    { ...POLL_OWNER, sender_user_id: '' },
    null,
    'string',
  ]
  for (const payload of cases) {
    const r = await drive('compact', payload)
    assert.equal(r.outcome, 'refused', JSON.stringify(payload))
    assert.equal(r.act.calls.length, 0, `act must not run for ${JSON.stringify(payload)}`)
    assert.equal(r.send.calls.length, 1)
  }
})

test('the owner reaches the /compact action exactly once, with no refusal sent', async () => {
  for (const [transport, payload] of [['ws', WS_OWNER], ['poll', POLL_OWNER]] as const) {
    const r = await drive('compact', payload)
    assert.equal(r.outcome, 'acted', transport)
    assert.equal(r.act.calls.length, 1, `${transport}: the work runs once`)
    assert.equal(r.act.calls[0]?.[0].audience, 'owner')
    assert.equal(r.send.calls.length, 0, `${transport}: nothing is sent by the seam on allow`)
    assert.equal(r.lines.length, 0, 'nothing to log on allow')
  }
})

test('/status reaches its action for everyone, carrying the audience the answer is built for', async () => {
  const owner = await drive('status', WS_OWNER)
  assert.equal(owner.outcome, 'acted')
  assert.equal(owner.act.calls[0]?.[0].audience, 'owner')
  assert.equal(owner.send.calls.length, 0)
  const strangers: unknown[] = [
    WS_RECIPIENT,
    POLL_RECIPIENT,
    stripKeys(WS_OWNER, ['sender', 'isSharedRecipient', 'shareOwnerUserId']),
    { ...WS_OWNER, sender: { userId: 42 } },
  ]
  for (const payload of strangers) {
    const r = await drive('status', payload)
    assert.equal(r.outcome, 'acted')
    assert.equal(r.act.calls.length, 1)
    assert.equal(r.act.calls[0]?.[0].audience, 'non_owner', 'a stranger gets the reduced answer, not a refusal')
    assert.equal(r.send.calls.length, 0)
  }
})

test('a refusal whose reply fails to send is still a refusal: act stays unreached and nothing throws', async () => {
  const r = await drive('compact', WS_RECIPIENT, { sendFails: true })
  assert.equal(r.outcome, 'refused')
  assert.equal(r.act.calls.length, 0)
  assert.equal(r.send.calls.length, 1)
  assert.ok(r.lines.some((l) => /refusal reply failed/.test(l)))
})

test('a failure inside the action propagates, so the rail still logs a failed command', async () => {
  await assert.rejects(() => drive('compact', WS_OWNER, { actFails: true }), /act failed/)
})

test('the action is awaited: the seam resolves only after act has resolved', async () => {
  let settled = false
  await runDaemonCommand({
    command: 'compact',
    payload: WS_OWNER,
    ownerUserId: OWNER,
    chatId: '1',
    send: async () => {},
    act: async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      settled = true
    },
  })
  assert.equal(settled, true)
})

// ── server.ts wiring: SHAPE PINS ─────────────────────────────────────────────
//
// The enforcement above is behavioural. What remains beyond a test's reach is
// the wiring in server.ts, whose handlers and rails are module-scoped and not
// exported, so nothing here runs them. These pins read the source and pin its
// SHAPE: that each rail calls the handler with the sender-bearing payload,
// that each handler is a single runDaemonCommand call whose act is the real
// work, that the real work is invoked nowhere else, that the tmux injection
// exists in exactly one place, and that the seam comes from the real module.
// Green here is text, not runtime.
//
// Measured on 2026-09-20, before the appears-once pin existed: the WS compact
// branch running the tmux injection loop itself before calling the gated
// handler satisfied every other pin with tsc clean. The pin that
// `buildInjectionSteps(` appears exactly once in server.ts is what turns that
// red, and it is a count of text, not a behaviour. What no pin here can
// catch: a rail doing the work by some other means, sendDaemonText being a
// no-op (a silent refusal, not a fail-open one), and anything that depends on
// runtime values (USER_ID empty, the reply failing to send).

const src = readFileSync(new URL('../server.ts', import.meta.url), 'utf8')

const SHAPE = 'pins SHAPE only: the source text, not that this code runs'

function functionBody(name: string): string {
  const start = src.indexOf(`async function ${name}(`)
  assert.ok(start >= 0, `${name} exists in server.ts`)
  const nextAsync = src.indexOf('\nasync function ', start + 10)
  const nextPlain = src.indexOf('\nfunction ', start + 10)
  const ends = [nextAsync, nextPlain].filter((i) => i >= 0)
  const end = ends.length ? Math.min(...ends) : src.length
  return src.slice(start, end)
}

function count(re: RegExp): number {
  return (src.match(new RegExp(re.source, 'g')) ?? []).length
}

test('no rail calls a daemon-handled command without the sender-bearing payload (shape pin)', () => {
  assert.doesNotMatch(
    src,
    /handle(RemoteCompact|StatusCommand)\(chatId\)/,
    `a bare single-argument call is an ungated rail; ${SHAPE}`,
  )
  // Poll: the row itself carries the flat sender fields.
  assert.match(src, /remote compact requested via poll[\s\S]{0,160}?handleRemoteCompact\(chatId, msg\.message\)/, SHAPE)
  assert.match(src, /status requested via poll[\s\S]{0,160}?handleStatusCommand\(chatId, msg\.message\)/, SHAPE)
  // WebSocket: the inbound_message payload with its nested sender block.
  assert.match(src, /remote compact requested via ws[\s\S]{0,160}?handleRemoteCompact\(chatId, payload \?\? \{\}\)/, SHAPE)
  assert.match(src, /status requested via ws[\s\S]{0,160}?handleStatusCommand\(chatId, payload \?\? \{\}\)/, SHAPE)
})

test('the stream rail hands /status the raw replayed row, inside its status branch (shape pin)', () => {
  const body = functionBody('forwardStreamInbound')
  const statusAt = body.indexOf("slashRoute.kind === 'status'")
  assert.ok(statusAt >= 0, 'the stream rail routes status at all')
  const branch = body.slice(statusAt, body.indexOf('\n  }\n', statusAt) + 4)
  assert.match(branch, /handleStatusCommand\(chatId, view\.raw\)/, `the exact call; ${SHAPE}`)
  assert.equal((branch.match(/handleStatusCommand\(/g) ?? []).length, 1, 'one call, with the payload')
})

test('each handler is one runDaemonCommand call whose act is the real work, invoked nowhere else (shape pin)', () => {
  assert.equal(count(/runDaemonCommand\(\{/), 2, `one seam call per handler; ${SHAPE}`)
  assert.equal(count(/act: \(\) => compactAsOwner\(chatId\)/), 1, SHAPE)
  assert.equal(count(/act: \(verdict\) => answerStatus\(chatId, verdict\.audience\)/), 1, SHAPE)
  assert.equal(count(/compactAsOwner\(/), 2, 'its declaration and the act lambda, nothing else')
  assert.equal(count(/answerStatus\(/), 2, 'its declaration and the act lambda, nothing else')
  assert.equal(count(/judgeDaemonCommand/), 0, 'server.ts never judges on its own; the seam does')
  assert.match(
    src,
    /async function compactAsOwner\(chatId: string\): Promise<void> \{\n  if \(!compactTarget\) \{/,
    'the work starts with the capability check, which the seam therefore sits in front of',
  )
  for (const name of ['handleRemoteCompact', 'handleStatusCommand']) {
    const body = functionBody(name)
    assert.equal((body.match(/\bawait\b/g) ?? []).length, 1, `${name}: exactly one await, the seam call`)
    assert.doesNotMatch(body, /sendDaemonText\(chatId,/, `${name}: sends nothing on its own`)
  }
})

test('the tmux injection exists in exactly one place, inside compactAsOwner (shape pin)', () => {
  // The measured bypass: a rail running the injection itself before calling
  // the gated handler. This count is what makes it red.
  assert.equal(
    count(/buildInjectionSteps\(/),
    1,
    `a rail running the injection itself would make this two; ${SHAPE}`,
  )
  assert.match(functionBody('compactAsOwner'), /buildInjectionSteps\(compactTarget, 'compact'\)/)
})

test('the seam is imported from the real module (shape pin)', () => {
  assert.match(
    src,
    /^import \{ runDaemonCommand, type DaemonCommandAudience \} from '\.\/lib\/daemon-command-sender\.js'$/m,
    `the seam must come from lib/daemon-command-sender.ts; ${SHAPE}`,
  )
})
