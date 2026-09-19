/**
 * Regression guard for lib/daemon-command-sender.ts: who may run a
 * daemon-handled slash command.
 *
 * The hole: /compact and /status are acted on by the daemon and never reach
 * the model, and until this gate neither handler asked who sent them. One
 * session serves every chat of the agent, so a share recipient tapping
 * /compact in their own chat compacted the owner's context. The same message
 * arrives over three rails (poll, WebSocket, stream), so the decision lives in
 * one exported pure function and both server.ts handlers call it first. The
 * decision is tested BEHAVIOURALLY below. The wiring is not: the handlers are
 * module-scoped inside server.ts and not exported, so the tests at the bottom
 * are SHAPE PINS over the source (each rail's exact call, each handler's exact
 * refusal block). They catch drift in the text; they cannot prove the gate
 * runs. The section comment above them lists exactly what they miss.
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
  type DaemonCommand,
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

// ── server.ts wiring: SHAPE PINS, not behavioural guards ─────────────────────
//
// The handlers are module-scoped inside server.ts and not exported, so nothing
// below RUNS them. These tests read the source and pin its SHAPE: that each
// rail hands the handler the sender-bearing payload, and that each handler's
// judge call and refusal block are present, verbatim, in the right place. The
// decision itself is tested behaviourally above; the wiring is not, and green
// here must not be read as proof that the gate runs.
//
// What a shape pin catches: a rail that drops the payload (the bare
// single-argument call); a judge call or refusal condition that was edited or
// removed (the condition is matched EXACTLY and anchored to the judge line, so
// `if (false && verdict.kind === 'refuse')` fails, and a decoy copy of the
// text elsewhere does not help); a refusal block that no longer replies or no
// longer returns; a handler that acts before it judges.
//
// Also caught, measured on 2026-09-20: the verdict overwritten between the
// judge line and the condition (`(verdict as any).kind = 'allow'`), because
// the block regex requires the condition IMMEDIATELY after the judge line;
// and the import swapped to a shim that always allows, by the import pin.
//
// What it cannot catch, measured the same day and left green on purpose as
// the documented limit: a rail that performs the action ITSELF before it
// calls the gated handler (the WebSocket compact branch running the tmux
// injection loop, then calling handleRemoteCompact as pinned). Every pin
// here was satisfied and tsc was clean. Also beyond reach, by reasoning:
// sendDaemonText being a no-op (a silent refusal, not a fail-open one), and
// anything that depends on runtime values (USER_ID empty, the reply failing
// to send). Closing that gap needs an exported seam the handlers route
// through, so the enforcement can be driven with injected send and act
// callbacks and the rails reduced to a single pinned call.

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

// The exact condition. Matched verbatim so a neutralised `if (false && ...)`
// or `if (... && false)` cannot pass; anchored to the judge line in the block
// regexes below so a copy of it in a comment cannot stand in for the real one.
const REFUSE_CONDITION = /if \(verdict\.kind === 'refuse'\) \{/

// The whole refusal block for /compact: judge, exact condition, the reply, the
// return, and then IMMEDIATELY the capability check, so nothing can be slipped
// between refusal and action.
const COMPACT_REFUSAL_BLOCK = new RegExp(
  "const verdict = judgeDaemonCommand\\(\\{ command: 'compact', payload, ownerUserId: USER_ID \\}\\)\\n" +
    "  if \\(verdict\\.kind === 'refuse'\\) \\{\\n" +
    '[\\s\\S]{0,300}?await sendDaemonText\\(chatId, verdict\\.reply\\)' +
    '[\\s\\S]{0,200}?\\n    return\\n  \\}\\n' +
    '  if \\(!compactTarget\\) \\{',
)

// The same for /status: judge, exact condition, reply, return.
const STATUS_REFUSAL_BLOCK = new RegExp(
  "const verdict = judgeDaemonCommand\\(\\{ command: 'status', payload, ownerUserId: USER_ID \\}\\)\\n" +
    "  if \\(verdict\\.kind === 'refuse'\\) \\{\\n" +
    '[\\s\\S]{0,200}?await sendDaemonText\\(chatId, verdict\\.reply\\)\\n' +
    '    return\\n  \\}\\n',
)

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
  // The stream rail has no refusal condition of its own: it lands on
  // handleStatusCommand, whose block is pinned below.
})

test('handleRemoteCompact: judge, exact refusal condition, reply, return, then the capability check (shape pin)', () => {
  const body = functionBody('handleRemoteCompact')
  assert.match(body, /async function handleRemoteCompact\(chatId: string, payload: unknown\)/, SHAPE)
  assert.match(
    body,
    REFUSE_CONDITION,
    `the exact condition must be present: a neutralised form such as if (false && ...) fails here; ${SHAPE}`,
  )
  assert.equal(
    (body.match(new RegExp(REFUSE_CONDITION.source, 'g')) ?? []).length,
    1,
    'exactly one refusal condition in the handler (a decoy beside a neutralised one would read as two)',
  )
  assert.match(
    body,
    COMPACT_REFUSAL_BLOCK,
    `the refusal block, verbatim, between the judge and the capability check; ${SHAPE}`,
  )
  const judgeAt = body.indexOf("judgeDaemonCommand({ command: 'compact', payload, ownerUserId: USER_ID })")
  const capabilityAt = body.indexOf('if (!compactTarget)')
  assert.ok(judgeAt >= 0 && capabilityAt >= 0 && judgeAt < capabilityAt, 'judged before the host capability is consulted')
})

test('handleStatusCommand: judge, exact refusal condition, reply, return, then the audience-built answer (shape pin)', () => {
  const body = functionBody('handleStatusCommand')
  assert.match(body, /async function handleStatusCommand\(chatId: string, payload: unknown\)/, SHAPE)
  assert.match(body, REFUSE_CONDITION, `the exact condition; ${SHAPE}`)
  assert.equal((body.match(new RegExp(REFUSE_CONDITION.source, 'g')) ?? []).length, 1)
  assert.match(body, STATUS_REFUSAL_BLOCK, `the refusal block, verbatim; ${SHAPE}`)
  const judgeAt = body.indexOf("judgeDaemonCommand({ command: 'status', payload, ownerUserId: USER_ID })")
  const buildAt = body.indexOf('buildStatusAnswer({')
  assert.ok(judgeAt >= 0 && buildAt >= 0 && judgeAt < buildAt, 'judged before the answer is built')
  assert.match(body.slice(buildAt), /audience: verdict\.audience/, `the verdict decides how much is said; ${SHAPE}`)
})

test('the judge is imported from the real module and called exactly once per handler (shape pin)', () => {
  // Measured 2026-09-20 before this line existed: swapping the import to a
  // shim that always allows left every other pin green, so the module path is
  // pinned too. Same limit as everything here: the text, not the runtime.
  assert.match(
    src,
    /^import \{ judgeDaemonCommand \} from '\.\/lib\/daemon-command-sender\.js'$/m,
    `the judge must come from lib/daemon-command-sender.ts; ${SHAPE}`,
  )
  assert.equal((src.match(/judgeDaemonCommand/g) ?? []).length, 3, 'the import plus one call per handler')
  const calls = src.match(/judgeDaemonCommand\(\{/g) ?? []
  assert.equal(calls.length, 2, `one call in each of the two daemon-handled command handlers; ${SHAPE}`)
})
