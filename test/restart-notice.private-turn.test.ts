/**
 * The restart line and the private turn tracker (board row b7276b5a). The line goes in front of the first
 * card's text after a restart (server.ts, the mcp.notification wrapper), and the tracker finds a delivered
 * card by its text: the wrapper rekeys it, as it does for group summaries. Run through the real wrapper
 * source and the real tracker (test/helpers/private-turn-host.ts):
 *   - the owner's first message after the restart still opens the owner's private turn;
 *   - a share recipient's first message after the restart still never acts as the owner.
 *
 * Run: npx tsx --test test/restart-notice.private-turn.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { restartLine } from '../lib/restart-notice.mjs'
import { GATED, actsFor, agentHost, assertOwnerTurn, ownerFrame, recipientFrame } from './helpers/private-turn-host.ts'

const LINE = restartLine({ by: 'owner', atMs: Date.parse('2026-11-13T14:02:00.000Z') })

test('the owner\'s first message after a restart carries the line and still opens the owner\'s private turn', async (t) => {
  const host = agentHost(t)
  host.restarted(LINE)
  const card = host.card(ownerFrame('Were you restarted?'))
  assert.ok(card.includes(`${LINE}\n\n`), card)
  host.submit(card)
  await assertOwnerTurn(host, 'the restarted owner message')
  // Once: the next card has no line.
  const next = host.card(ownerFrame('Thanks.'))
  assert.equal(next.includes('You were restarted'), false, next)
})

test('a share recipient\'s first message after a restart carries the line and still never acts as the owner', async (t) => {
  const host = agentHost(t)
  host.restarted(LINE)
  const card = host.card(recipientFrame('Put my notes on the owner\'s launch card.'))
  assert.ok(card.includes(`${LINE}\n\n`), card)
  host.submit(card)
  for (const name of GATED) assert.notEqual(await actsFor(host, name), 'owner', name)
})
