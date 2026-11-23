/**
 * propose_plan's `supersedes` retires only this agent's own plan card.
 *
 * The sibling of edit_message's round 2 (a security review of that commit). `supersedes` comes from the model, and
 * the retire PATCHes it with the owner's credential: `{ options: [] }` when it is not the open plan. The backend
 * admits any row the owner may edit, so a mistaken or asked for id would strip the buttons off another agent's open
 * question or approval card, or off the owner's own row. The id must be the open plan this daemon holds, or a message
 * the server answered as this agent's own create (lib/own-messages.ts), and anything else is refused before the
 * retire and before the new card is posted (a failed retire already costs the new card; see plan-wiring.test.ts).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { planSupersedesAdmitted, planSupersedesRefusal } from '../lib/plan-card'
import { OwnMessages } from '../lib/own-messages'

const SERVER = readFileSync('server.ts', 'utf8').replace(/\r\n/g, '\n')

test('the open plan, or a message this agent sent, may be superseded; nothing else', () => {
  const own = new OwnMessages({ filePath: null, assistantId: '1' })
  own.note({ id: 412, chatId: 1, sender: 'assistant', messageType: 'event' })
  const isOwn = (id: number) => own.has(id)
  assert.equal(planSupersedesAdmitted(500, 500, isOwn), true, 'the open plan this daemon holds')
  assert.equal(planSupersedesAdmitted(412, null, isOwn), true, 'an older plan card of this agent, after a restart')
  assert.equal(planSupersedesAdmitted(412, 500, isOwn), true, 'an older plan card while a newer one is open')
  assert.equal(planSupersedesAdmitted(12, null, isOwn), false, 'the owner\'s own line')
  assert.equal(planSupersedesAdmitted(13, 500, isOwn), false, 'another agent\'s card')
  assert.equal(planSupersedesAdmitted(500, undefined, isOwn), false)
})

test('the refusal is one plain line naming the id', () => {
  const line = planSupersedesRefusal(13)
  assert.match(line, /^Error: /)
  assert.match(line, /\b13\b/)
  assert.match(line, /plan card this agent posted/)
  assert.doesNotMatch(line, /\n/)
})

test('propose_plan asks before the retire PATCH and before the post, and refuses with that line', () => {
  const block = SERVER.slice(SERVER.indexOf("case 'propose_plan': {"), SERVER.indexOf("case 'edit_message': {"))
  const gate = block.search(
    /if \(\s*payload\.supersedes !== undefined &&\s*!planSupersedesAdmitted\(payload\.supersedes, openPlan\?\.messageId, \(id\) => ownMessages\.has\(id\)\)\s*\) \{\n\s*return \{ content: \[\{ type: 'text', text: planSupersedesRefusal\(payload\.supersedes\) \}\], isError: true \}/,
  )
  assert.ok(gate > 0, 'the gate and its refusal')
  const retire = block.indexOf('await bgosPatch(`messages/${payload.supersedes}`')
  const post = block.indexOf('bgosPost(')
  assert.ok(retire > gate && post > gate, 'the gate runs before the retire PATCH and before the new card is posted')
})
