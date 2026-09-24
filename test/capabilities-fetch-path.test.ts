/**
 * The canon fetch carries this daemon's declared list (0.47.0).
 *
 * The BGOS canon tells the permission request card sentence only to a
 * connection that DECLARES `permission_card`, with no version floor (BGOS
 * #1624), from the union of the pairing's stored list (refreshed on the
 * heartbeat) and the list on the fetch itself. The fetch at connect can run
 * before the first heartbeat has stored the declaration, and a fetch that
 * carried nothing would then be served the canon without the sentence until
 * the next fetch. So the fetch carries the list.
 *
 * `capabilitiesFetchPath` is the SAME function, byte for byte, that the
 * Kanban PR (#149) adds for `boards_playbook`: the same name, signature,
 * grammar filter, cap and percent encoding, and the same one line call in
 * server.ts, so the merge of the two branches takes one copy of each without
 * a conflict. These cases live in their own file (not appended to
 * capabilities.test.ts, where #149 appends its own) for the same reason.
 *
 * MUTATION PROOF (applied to lib/capabilities.ts, confirmed red, restored):
 * returned the base path without `&capabilities=` -> four red: "the fetch
 * path carries the channel, the version and the declared list", "the
 * daemon's own base declaration reaches the fetch", the version case and "a
 * malformed token is dropped": the
 * agent would never be told about the card it posts until a heartbeat landed
 * and the canon was fetched again.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { capabilitiesFetchPath } from '../lib/capabilities.ts'
import { declaredCapabilities } from '../lib/declared-capabilities.ts'

test('the fetch path carries the channel, the version and the declared list', () => {
  assert.equal(
    capabilitiesFetchPath('0.47.0', ['mission_events', 'permission_card']),
    'integrations/capabilities?channel=claude&daemonVersion=0.47.0&capabilities=mission_events%2Cpermission_card',
  )
})

test('the daemon\'s own base declaration reaches the fetch, permission_card included', () => {
  const path = capabilitiesFetchPath('0.47.0', declaredCapabilities({ canInjectGoal: false }))
  const query = new URLSearchParams(path.slice(path.indexOf('?') + 1))
  assert.equal(query.get('channel'), 'claude')
  assert.equal(query.get('daemonVersion'), '0.47.0')
  assert.ok(query.get('capabilities')!.split(',').includes('permission_card'))
})

test('the plan card token reaches the fetch too (0.48.0)', () => {
  // The canon's plan card sentences are gated on plan_card exactly as the
  // permission card sentence is on permission_card, so the fetch at connect
  // must carry it for the same reason.
  const path = capabilitiesFetchPath('0.48.0', declaredCapabilities({ canInjectGoal: false }))
  const query = new URLSearchParams(path.slice(path.indexOf('?') + 1))
  assert.ok(query.get('capabilities')!.split(',').includes('plan_card'))
})

test('the version is encoded, and a missing one reads as 0.0.0 as it always has', () => {
  assert.ok(
    capabilitiesFetchPath('0.47.0-rc.1+build 7', ['permission_card']).includes(
      'daemonVersion=0.47.0-rc.1%2Bbuild%207&',
    ),
  )
  assert.ok(capabilitiesFetchPath(null, ['permission_card']).includes('daemonVersion=0.0.0&'))
})

test('an empty declaration sends no capabilities key, exactly the old path', () => {
  assert.equal(
    capabilitiesFetchPath('0.46.0', []),
    'integrations/capabilities?channel=claude&daemonVersion=0.46.0',
  )
})

test('a malformed token is dropped rather than costing the whole canon, and the list is capped at 32', () => {
  // The backend's capabilities query DTO refuses the WHOLE fetch on a
  // malformed list, and a refused fetch costs the agent the live canon.
  assert.equal(
    capabilitiesFetchPath('0.47.0', ['permission_card', 'Bad Token', 'a,b', '9lives']),
    'integrations/capabilities?channel=claude&daemonVersion=0.47.0&capabilities=permission_card',
  )
  const many = Array.from({ length: 40 }, (_, i) => `cap_${i}`)
  const path = capabilitiesFetchPath('0.47.0', many)
  const query = new URLSearchParams(path.slice(path.indexOf('?') + 1))
  const sent = query.get('capabilities')!.split(',')
  assert.equal(sent.length, 32)
  assert.equal(sent[0], 'cap_0')
  assert.equal(sent[31], 'cap_31')
})

// The ONE caller. Every case above tests the pure helper; the call that runs
// it at boot is in server.ts, which no pure test imports, so the call is
// pinned as a source contract (the house style, test/startup-reaches-poll).
//
// MUTATION PROOF (applied to server.ts, confirmed red, restored): the fetch
// path back to the hand built
// `integrations/capabilities?channel=claude&daemonVersion=${...}` template ->
// this test fails.
test('the canon fetch at connect carries the declared list', () => {
  const server = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'server.ts'),
    'utf8',
  ).replace(/\r\n/g, '\n')
  const start = server.indexOf('async function loadServedCapabilities(')
  assert.ok(start > 0, 'loadServedCapabilities is gone from server.ts')
  const end = server.indexOf('\n}\n', start)
  const body = server.slice(start, end)
  assert.match(
    body,
    /capabilitiesFetchPath\(\s*RUNNING_VERSION \?\? '0\.0\.0',\s*declaredCapabilities\(\{ canInjectGoal: false \}\)\s*,?\s*\)/,
  )
  assert.equal(body.includes('integrations/capabilities?'), false, 'a hand built fetch path is back')
  assert.ok(declaredCapabilities({ canInjectGoal: false }).includes('permission_card'))
})
