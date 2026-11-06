import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PRIVATE_TURN_REFUSAL, TURN_AWARE_REFUSAL } from '../lib/private-turn.mjs'
import {
  GATED, TURN_AWARE, OWNER, actsFor, admitCall, agentHost, emailFrame, peerFrame, personFrame, wakeFrame, type Host,
} from './helpers/private-turn-host.ts'

const A = { id: 'user_shared_a', chat: 7101 }
const B = { id: 'user_shared_b', chat: 7102 }
const frame = (person: typeof A) => ({
  ...personFrame(person.chat, person.id, 'Message.'),
  userId: OWNER,
  sender: { userId: person.id, displayName: 'Recipient', relationship: 'recipient' },
})
const wake = () => {
  const message = wakeFrame(A.chat, 701)
  message.eventMeta.payload.actingUserId = A.id
  message.sender = frame(A).sender
  return message
}

async function assertRecipient(host: Host, person: typeof A) {
  for (const name of [...GATED, ...TURN_AWARE]) assert.equal(await actsFor(host, name), person.id)
  const call = await admitCall(host, 'create_mission')
  assert.ok(!('refused' in call))
  assert.equal((call.privateCall as any).chatId, String(person.chat))
  assert.deepEqual((call.privateCall as any).headers, { 'X-BGOS-Acting-User': person.id })
  assert.equal(host.browser(), person.id)
}

async function assertClosed(host: Host) {
  for (const name of [...GATED, 'boards_query', 'cancel_schedule']) {
    assert.equal(await actsFor(host, name), `refused: ${PRIVATE_TURN_REFUSAL}`)
  }
  for (const name of TURN_AWARE) assert.equal(await actsFor(host, name), `refused: ${TURN_AWARE_REFUSAL}`)
  assert.equal(host.browser(), 'nobody')
}

const sources = [
  () => frame(B),
  () => ({ ...frame(B), sender: undefined }),
  () => emailFrame('Message.'),
  () => peerFrame('Message.'),
]

for (const [recipientIndex, recipient] of [() => frame(A), wake].entries()) {
  for (const [sourceIndex, source] of sources.entries()) {
    for (const recipientFirst of [false, true]) {
      const caseId = 1 + recipientIndex * 8 + sourceIndex * 2 + Number(recipientFirst)
      test(`a turn admits only its own sender (${caseId})`, async (t) => {
        const host = agentHost(t)
        const messages = recipientFirst ? [recipient(), source()] : [source(), recipient()]
        for (const message of messages) host.submit(host.card(message))
        await assertClosed(host)
        host.stop()
        host.submit(host.card(frame(A)))
        await assertRecipient(host, A)
      })
    }
  }
}

for (const [index, recipient] of [() => frame(A), wake].entries()) {
  test(`a verified sender keeps its own turn (${index + 1})`, async (t) => {
    const host = agentHost(t)
    host.submit(host.card(recipient()))
    await assertRecipient(host, A)
    host.submit(host.card(frame(A)))
    await assertRecipient(host, A)
  })
}

for (const lane of ['boot', 'poll', 'stream'] as const) {
  for (const tapperUserId of [B.id, OWNER, null]) {
    test(`a turn retains its sender boundary (${lane}, ${tapperUserId ?? 'unverified'})`, async (t) => {
      const host = agentHost(t)
      host.submit(host.card(frame(A)))
      await assertRecipient(host, A)
      host.laneTap({ lane, tapperUserId, chatId: A.chat, text: 'Acknowledged.' })
      assert.equal(host.published(), 'nobody')
      await assertClosed(host)
    })
  }
}

const notifications = [
  (host: Host) => host.replyOverdue(),
  (host: Host) => host.peerClose(),
  (host: Host) => host.raw('Notification.', { event_type: 'voice_task_dispatch' }),
]
for (const [index, notification] of notifications.entries()) {
  test(`a notification grants no recipient authority (${index + 1})`, async (t) => {
    const host = agentHost(t)
    host.submit(host.card(frame(A)))
    await assertRecipient(host, A)
    const card = notification(host)
    assert.equal(host.published(), 'nobody')
    await assertClosed(host)
    host.submit(card)
    await assertClosed(host)
  })
}
