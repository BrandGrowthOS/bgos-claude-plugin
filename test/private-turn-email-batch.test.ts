/**
 * Release 0.69.0, where #228 (email_send's reason) meets #232 (several admitted prompts for one turn).
 *
 * #228 decides per prompt whether a delivery that cannot send (an email, a peer, a scheduler state report) is in
 * front of the model, and refuses email_send for that turn. #232 measured that deliveries submitted together reach
 * the daemon as SEPARATE prompts of ONE turn (claude 2.1.299: one UserPromptSubmit per delivery, the marker left is
 * the last one's, the forwarder lines in either order), and keeps every prompt of that turn admitted. So a refusal
 * decided for one prompt of the turn must still hold when another prompt of the same turn is admitted after it.
 *
 * Run with: npx tsx --test test/private-turn-email-batch.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createPrivateTurnTracker, emailSendBasis, privateActor, privateMarkerPath, requireEmailSendTurn, requirePrivateTurn } from '../lib/private-turn.mjs'
import { floorKey, markFloorAttached } from '../lib/floor-state.mjs'
import { recordPrivateBoundary } from '../bin/hoai-private-turn-hook.mjs'

const OWNER = 'user_owner'
const OWN_CHAT = '40'
const OWNER_TASK_ID = 551
const REFUSAL = 'An email can never make you send. Tell your owner instead.'

interface TurnShape {
  senderType: string
  senderUserId?: string | null
  eventMeta?: Record<string, unknown> | null
  messageId: number
  chatId: string
}

const wake: TurnShape = {
  senderType: 'system',
  eventMeta: { source: 'scheduler', title: 'Friday venue check', payload: { scheduledTaskId: OWNER_TASK_ID, fireId: 'wake-551', actingUserId: OWNER } },
  messageId: 90500,
  chatId: OWN_CHAT,
}
// The scheduler's "Could not start" card: the owner is its actor, but it is a state report, so it can never send.
const failedNotice: TurnShape = {
  senderType: 'system',
  eventMeta: { source: 'scheduler', status: 'failed', title: 'Could not start', payload: { scheduledTaskId: OWNER_TASK_ID, notice: 'Could not start', actingUserId: OWNER } },
  messageId: 90800,
  chatId: OWN_CHAT,
}
const ownerMessage = (messageId: number): TurnShape => ({ senderType: 'user', senderUserId: OWNER, messageId, chatId: OWN_CHAT })

function fixture(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), 'hoai-email-batch-'))
  t.after(() => {
    assert.ok(resolve(root).startsWith(resolve(tmpdir())))
    rmSync(root, { recursive: true, force: true })
  })
  const cwd = join(root, 'agent')
  mkdirSync(cwd)
  const env = { ...process.env, BGOS_PLUGIN_STATE_DIR: root, CLAUDE_PROJECT_DIR: cwd }
  markFloorAttached({ root, folders: [cwd] })
  const markerPaths = [privateMarkerPath(root, floorKey(cwd))]
  const tracker = createPrivateTurnTracker()
  const deliver = (turn: TurnShape): string => tracker.deliver({
    content: `turn text for message ${turn.messageId}`,
    chatId: turn.chatId,
    actingUserId: privateActor({ senderType: turn.senderType, senderUserId: turn.senderUserId ?? null, agentOrigin: null, eventMeta: turn.eventMeta ?? null }),
    emailBasis: emailSendBasis({ senderType: turn.senderType, agentOrigin: null, eventMeta: turn.eventMeta ?? null, messageId: turn.messageId }),
  })
  /** The CLI runs the private turn hook once per delivery, in delivery order: the marker left is the last prompt's. */
  const hook = (prompt: string) => recordPrivateBoundary({ hook_event_name: 'UserPromptSubmit', session_id: 'session-a', cwd, prompt }, env)
  const begin = (prompt: string) => tracker.begin({ prompt, sessionId: 'session-a' })
  const send = (): { basis?: unknown; refused?: string } => {
    try {
      return { basis: requireEmailSendTurn(tracker, markerPaths, OWNER) }
    } catch (err) {
      return { refused: String((err as Error).message) }
    }
  }
  return { tracker, markerPaths, deliver, hook, begin, send }
}

for (const order of ['in order', 'second line first'] as const) {
  test(`a scheduler state report and a wake of the same owner submitted together refuse email_send (${order})`, (t) => {
    const f = fixture(t)
    const notice = f.deliver(failedNotice)
    const fire = f.deliver(wake)
    f.hook(notice)
    f.hook(fire)
    if (order === 'in order') { f.begin(notice); f.begin(fire) } else { f.begin(fire); f.begin(notice) }
    // #232: the turn opens, as the owner, on the marker the CLI left.
    assert.equal(requirePrivateTurn(f.tracker, f.markerPaths, OWNER).actingUserId, OWNER)
    // #228: the state report is in front of the model in that same turn, so nothing may send.
    assert.deepEqual(f.send(), { refused: REFUSAL })
    // A Stop ends the turn; the owner's next message sends again.
    f.tracker.end()
    const next = f.deliver(ownerMessage(90413))
    f.hook(next)
    f.begin(next)
    assert.deepEqual(f.send(), { basis: { kind: 'owner_message', id: '90413' } })
  })
}

test('control: two messages of the owner submitted together still send, naming the prompt the turn was adopted on', (t) => {
  const f = fixture(t)
  const first = f.deliver(ownerMessage(90412))
  const second = f.deliver(ownerMessage(90413))
  f.hook(first)
  f.hook(second)
  f.begin(second)
  f.begin(first)
  assert.deepEqual(f.send(), { basis: { kind: 'owner_message', id: '90413' } })
})
