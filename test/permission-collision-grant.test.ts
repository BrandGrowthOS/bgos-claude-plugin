/**
 * A request another request collided with records no email grant.
 *
 * When a second request claims an open request's id, the open request ends
 * in a deny (lib/permission-request-ids.ts): its id no longer says which
 * request an allow would reach. The relay records a local email send grant
 * before it sends an allow, and the grant store keeps that entry for a later
 * matching call. So the relay asks the reservation for the verdict it may
 * send first (permissionBehaviorToSend), and records a grant only for an
 * allow it really sends. The notification wrapper's deny for a collided id
 * stays behind it.
 *
 * Run with: npx tsx --test test/permission-collision-grant.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import * as ids from '../lib/permission-request-ids.ts'
import { createEmailSendApprovals } from '../lib/email-send-approval.ts'

const SRC = readFileSync('server.ts', 'utf8')
const toSend = (ids as Record<string, unknown>).permissionBehaviorToSend as
  | ((opts: {
      ids: ids.PermissionRequestIds
      requestId: string
      behavior: 'allow' | 'deny'
      recordAllow?: () => void
    }) => 'allow' | 'deny')
  | undefined

const SEND_TOOL = 'mcp__plugin_hoai_bgos__email_send'
const SEND_ARGS = { to: 'sam@harborhall.com', subject: 'Friday venue check', text: 'Hi Sam, could you confirm the Harbor room for Friday?' }
const previewOf = (args: Record<string, unknown>) =>
  `{ ${Object.entries(args).map(([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)}`).join(', ')} }`
const REQUEST = 'abcde'

function held() {
  const registry = ids.createPermissionRequestIds()
  const claim = registry.claim(REQUEST, 'cli', ids.permissionRequestFingerprint({ tool_name: SEND_TOOL, description: 'Send', input_preview: previewOf(SEND_ARGS) }))
  assert.equal(claim.kind, 'reserved')
  const store = createEmailSendApprovals()
  const record = () => {
    store.allow(SEND_TOOL, previewOf(SEND_ARGS), { requestId: REQUEST, approval: null, binding: null })
  }
  return { registry, store, record }
}

test('a collided reservation: the allow is sent as a deny and the grant store stays empty', () => {
  assert.ok(toSend, 'lib/permission-request-ids.ts exports permissionBehaviorToSend')
  const { registry, store, record } = held()
  // Another request claims the same id while the email request is open.
  assert.equal(registry.claim(REQUEST, 'cli', 'another request').kind, 'collision')
  const behavior = toSend!({ ids: registry, requestId: REQUEST, behavior: 'allow', recordAllow: record })
  assert.equal(behavior, 'deny')
  assert.equal(store.claim(SEND_ARGS), null, 'no grant waits for a later matching call')
})

test('control: an open request no one collided with sends its allow and records its grant', () => {
  assert.ok(toSend, 'lib/permission-request-ids.ts exports permissionBehaviorToSend')
  const { registry, store, record } = held()
  const behavior = toSend!({ ids: registry, requestId: REQUEST, behavior: 'allow', recordAllow: record })
  assert.equal(behavior, 'allow')
  assert.notEqual(store.claim(SEND_ARGS), null, 'the grant the allow relies on is there')
})

test('a deny records nothing, collided or not', () => {
  assert.ok(toSend, 'lib/permission-request-ids.ts exports permissionBehaviorToSend')
  for (const collide of [false, true]) {
    const { registry, store, record } = held()
    if (collide) registry.claim(REQUEST, 'cli', 'another request')
    assert.equal(toSend!({ ids: registry, requestId: REQUEST, behavior: 'deny', recordAllow: record }), 'deny')
    assert.equal(store.claim(SEND_ARGS), null)
  }
})

test('server.ts: every email grant in the relay is recorded only for the allow the reservation lets it send', () => {
  const relay = SRC.slice(SRC.indexOf('function relayPermissionToOwner('), SRC.indexOf('function settleFloorRequest('))
  assert.ok(relay.length > 0)
  const grants: number[] = []
  for (let at = relay.indexOf('emailSendApprovals.allow('); at >= 0; at = relay.indexOf('emailSendApprovals.allow(', at + 1)) grants.push(at)
  // The card that is too long or names no email, the one no chat of the
  // owner can take, and the held card's verdict.
  assert.equal(grants.length, 3, `the relay's email grants (${grants.length})`)
  for (const at of grants) {
    const before = relay.slice(0, at)
    const asked = before.lastIndexOf('permissionBehaviorToSend({')
    assert.ok(asked >= 0, 'asked of the reservation')
    const between = before.slice(asked)
    assert.ok(!between.includes('mcp.notification('), 'before any verdict is sent')
    assert.ok(between.includes('recordAllow: () =>'), "recorded inside the reservation's allow")
    // And the verdict that follows is the one the reservation returned.
    const after = relay.slice(at)
    const sent = after.slice(after.indexOf('mcp.notification('), after.indexOf('mcp.notification(') + 160)
    assert.match(sent, /params: \{ request_id, behavior \}/, 'the CLI hears the reservation\'s verdict')
  }
  // The deny the wrapper sends for a collided request stays, as the belt.
  assert.match(SRC, /params\.behavior === 'allow' && permissionRequestIds\.collided\(params\.request_id\)/)
})
