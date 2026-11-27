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

test('server.ts says it at boot, when requests would go to the owner', () => {
  assert.match(SRC, /const permissionCardNotice = AUTO_APPROVE \? null : permissionCardPairingNotice\(AUTH\.mode\)\n\s*if \(permissionCardNotice\) log\(`permissions: \$\{permissionCardNotice\}`\)/)
})

test('server.ts says it on each request at the one card post, whichever route reached it, once', () => {
  const handler = SRC.slice(SRC.indexOf('function handlePermissionRequest('), SRC.indexOf('function relayPermissionToOwner('))
  const relay = SRC.slice(SRC.indexOf('function relayPermissionToOwner('), SRC.indexOf('function settleFloorRequest('))
  const floor = SRC.slice(SRC.indexOf('function settleFloorRequest('), SRC.indexOf('function settleElidedFloorRequest('))
  assert.ok(handler.length > 0 && relay.length > 0 && floor.length > 0)
  // Not in a route of its own: the ordinary request and the floor consult
  // both reach the card post through relayPermissionToOwner.
  assert.equal(handler.includes('permissionCardPairingNotice('), false, 'the ordinary route does not say it on its own')
  assert.equal(floor.includes('permissionCardPairingNotice('), false, 'the floor route does not say it on its own')
  assert.match(handler, /\breturn relayPermissionToOwner\(params\)/, 'the ordinary request reaches the card post')
  const routes = (route: string) => floor.slice(floor.indexOf(`case '${route}':`), floor.indexOf('case ', floor.indexOf(`case '${route}':`) + 5))
  assert.match(routes('hold'), /\breturn relayPermissionToOwner\(params, match\.evidence, true, plan\.record\)/, 'a held floor consult reaches it')
  assert.match(routes('owner'), /\breturn relayPermissionToOwner\(params, match\.evidence\)/, "an owner's floor consult reaches it")
  // At the card post: after every exit that posts no card, before the post.
  const told = relay.indexOf('permissionCardPairingNotice(AUTH.mode)')
  assert.ok(told > relay.indexOf('if (!chatId) {'), 'said only once a card is going to be posted')
  assert.ok(told < relay.indexOf('buildPermissionRequestBody({'), 'said before the card is posted')
  // A chat that refuses the card sends the same request to the next chat:
  // the notice is said once per request, not once per chat.
  assert.match(relay.slice(told - 200, told + 200), /pairingNoticeSaid/)
})

test('the README says interactive approval cards need a paired agent', () => {
  const section = README.slice(README.indexOf('### Permission Modes'), README.indexOf('### Always ask before risky actions'))
  assert.match(section, /needs a paired agent/)
})
