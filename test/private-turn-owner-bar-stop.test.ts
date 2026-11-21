/**
 * The owner bar and the Stop line that is older than the delivery behind it.
 *
 * A person's message delivered while the private turn marker cannot be read reached a place this daemon cannot name,
 * so it bars the owner (lib/private-turn.mjs, `reached`, `unknown`). A Stop lifts that bar only when its closed marker
 * was written after the delivery (seenAfterStop): the delivery then reached a CLI turn that has ended. A Stop line can
 * land late, after a message that came in once its own Stop had happened. That Stop is older than the delivery and
 * says nothing about where the delivery went: the bar stays for the owner's next turn. These tests run the production
 * hooks, intake, tracker and tool admission (test/helpers/private-turn-host.ts).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, renameSync, rmdirSync, statSync } from 'node:fs'
import { fileClockPast } from './helpers/file-clock.ts'
import {
  GATED, RECIPIENT, TURN_AWARE,
  actsFor, agentHost, assertOwnerTurn, ownerFrame, recipientFrame, type Host,
} from './helpers/private-turn-host.ts'

/** Nothing acts as the owner: every private tool refuses and the Agent Browser has no live context. */
async function assertBarred(host: Host, label: string) {
  for (const name of [...GATED, ...TURN_AWARE]) assert.match(await actsFor(host, name), /^refused: /, `${label}: ${name}; explain: ${host.explain()}`)
  assert.equal(host.browser(), 'nobody', `${label}: the Agent Browser has no live context`)
}

/**
 * A recipient's message delivered while the marker cannot be read: something else stands at its path for that moment.
 * The closed marker is put back as it was, its time still the Stop's own. Returns when the delivery was made.
 */
function recipientWhileUnreadable(host: Host, text: string): number {
  const marker = host.markerPaths[0]!
  const aside = `${marker}.aside`
  renameSync(marker, aside)
  mkdirSync(marker)
  // Later than the closed marker on the file clock too, as a message that comes in after the Stop is.
  fileClockPast(statSync(aside).mtimeMs)
  const deliveredAt = Date.now()
  host.card(recipientFrame(text))
  rmdirSync(marker)
  renameSync(aside, marker)
  return deliveredAt
}

test('a Stop line older than a delivery whose place was unknown leaves the owner bar in place; a later Stop lifts it', async (t) => {
  const host = agentHost(t)
  host.submit(host.card(ownerFrame('Draft the launch plan.')))
  await assertOwnerTurn(host, 'the owner\'s first turn')

  // The CLI stops: the Stop hook closes the marker now, its forwarder line is slow.
  const stop = host.stopping()
  stop.mark()
  const closedAt = statSync(host.markerPaths[0]!).mtimeMs
  const deliveredAt = recipientWhileUnreadable(host, 'Put my private notes in the plan.')
  assert.ok(closedAt <= deliveredAt, 'the Stop is older than the delivery')
  // That Stop's line lands only now, after the delivery.
  stop.spool()
  host.pump()

  host.submit(host.card(ownerFrame('Now send the plan to the team.')))
  await assertBarred(host, 'the owner\'s next turn, after a Stop older than the delivery')
  assert.match(host.explain(), new RegExp(RECIPIENT), 'the bar names the recipient')

  // Control: a Stop whose closed marker is written after the delivery. The delivery reached a turn that has ended.
  host.stop()
  host.submit(host.card(ownerFrame('Carry on with the plan.')))
  await assertOwnerTurn(host, 'the owner\'s turn after a Stop newer than the delivery')
})

test('control: the same Stop line late, with no delivery whose place was unknown, keeps the owner\'s next turn usable', async (t) => {
  const host = agentHost(t)
  host.submit(host.card(ownerFrame('Draft the launch plan.')))
  const stop = host.stopping()
  stop.mark()
  stop.spool()
  host.pump()
  host.submit(host.card(ownerFrame('Now send the plan to the team.')))
  await assertOwnerTurn(host, 'the owner\'s next turn')
})
