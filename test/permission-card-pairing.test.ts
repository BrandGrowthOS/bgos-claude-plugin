/**
 * A permission card needs a paired agent, and the daemon says so before it
 * promises one.
 *
 * The server takes a card with approval buttons in the owner's own chat only
 * from the pairing of the agent its answers reach. A daemon that connects with
 * an account API key is no pairing, so in that chat its card is refused and
 * the request ends in a deny. The writer's rule is the server's and is not
 * changed here; the daemon tells the owner at boot, on each request, and in
 * the README, in one sentence.
 *
 * Run with: npx tsx --test test/permission-card-pairing.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import * as relay from '../lib/permission-relay.ts'

const SRC = readFileSync('server.ts', 'utf8')
const README = readFileSync('README.md', 'utf8')
const notice = (relay as Record<string, unknown>).permissionCardPairingNotice as ((mode: string) => string | null) | undefined

test('an account key install is told a permission card needs a paired agent; a paired one is told nothing', () => {
  assert.ok(notice, 'lib/permission-relay.ts exports permissionCardPairingNotice')
  assert.equal(notice!('pairing'), null)
  const line = notice!('apikey')
  assert.ok(line)
  assert.match(line!, /pair/i)
  assert.match(line!, /denied/)
  assert.match(line!, /Pair the agent/)
})

test('server.ts says it at boot, when requests would go to the owner, and on each request before the card', () => {
  assert.match(SRC, /const permissionCardNotice = AUTO_APPROVE \? null : permissionCardPairingNotice\(AUTH\.mode\)\n\s*if \(permissionCardNotice\) log\(`permissions: \$\{permissionCardNotice\}`\)/)
  const handler = SRC.slice(SRC.indexOf('function handlePermissionRequest('), SRC.indexOf('\n * The interactive path, whole'))
  const told = handler.indexOf('permissionCardPairingNotice(AUTH.mode)')
  const card = handler.lastIndexOf('return relayPermissionToOwner(params)')
  assert.ok(told > 0 && told < card, 'said before the card is posted')
})

test('the README says interactive approval cards need a paired agent', () => {
  const section = README.slice(README.indexOf('### Permission Modes'), README.indexOf('### Always ask before risky actions'))
  assert.match(section, /needs a paired agent/)
})
