/**
 * Owner model and effort control (Route A): how server.ts wires it, and what
 * the daemon declares.
 *
 * The transaction and the wire are unit tested on their own; these cases pin
 * the seams that only server.ts can get wrong: the typed rail is answered by
 * the lock holder only, the control lock is held against compact, goal
 * typing, steer and incoming deliveries, nothing in server.ts builds a
 * send-keys argv of its own, and the capability is declared only while every
 * precondition for advertising it holds.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { OWNER_MODEL_EFFORT_TOKEN, declaredCapabilities } from '../lib/declared-capabilities.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const server = readFileSync(join(ROOT, 'server.ts'), 'utf8')

test('the token is declared only on a pairing, and only when the daemon says it can control', () => {
  assert.equal(OWNER_MODEL_EFFORT_TOKEN, 'owner_model_effort_control')
  assert.match(OWNER_MODEL_EFFORT_TOKEN, /^[a-z][a-z0-9_]{0,63}$/)
  const base = { canInjectGoal: true, floorHook: true, authMode: 'pairing' as const }
  assert.ok(declaredCapabilities({ ...base, ownerModelEffort: true }).includes(OWNER_MODEL_EFFORT_TOKEN))
  assert.ok(!declaredCapabilities({ ...base, ownerModelEffort: false }).includes(OWNER_MODEL_EFFORT_TOKEN))
  assert.ok(!declaredCapabilities(base).includes(OWNER_MODEL_EFFORT_TOKEN), 'absent means not declared')
  assert.ok(!declaredCapabilities({ ...base, authMode: 'apikey', ownerModelEffort: true }).includes(OWNER_MODEL_EFFORT_TOKEN))
  assert.ok(!declaredCapabilities({ ...base, ownerModelEffort: true }).includes('session_model_control'), 'never the Codex token: its words promise Codex semantics')
})

test('every declaration site passes the live answer, so a lost precondition withdraws the token', () => {
  const sites = [...server.matchAll(/declaredCapabilities\(\{[^)]*\}\)/g)].map((m) => m[0])
  assert.ok(sites.length >= 2)
  for (const site of sites) assert.match(site, /ownerModelEffort: modelEffortDeclared\(\)/, site)
})

test('the typed rail is answered by the lock holder only, and never during a drain', () => {
  const at = server.indexOf("realtimeSocket.on(MODEL_EFFORT_RPC_EVENT, whenArmed(MODEL_EFFORT_RPC_EVENT")
  assert.ok(at > 0, 'registered through whenArmed')
  const body = server.slice(at, at + 800)
  assert.match(body, /if \(updateDrainMode\) return/)
  assert.match(body, /normalizeModelEffortRpc\(payload\)/)
  assert.match(body, /trackMessageOperation\(\(\) => modelEffortRpc\.handle\(frame\)\)/)
})

test('the control lock is part of every other injection\'s busy check', () => {
  assert.match(server, /injectionBusy: \(\) => compactInFlight \|\| goalInjectionsInFlight > 0 \|\| modelEffortControl\.busy/)
  assert.match(server, /otherInjectionBusy: \(\) => compactInFlight \|\| goalInjectionsInFlight > 0 \|\| steerGate\.busy/)
  const compact = server.slice(server.indexOf('async function compactAsOwner'))
  assert.match(compact.slice(0, 1500), /compactInFlight \|\| modelEffortControl\.busy/)
  const goal = server.slice(server.indexOf('async function runGoalInjection'))
  assert.match(goal.slice(0, 1200), /modelEffortControl\.busy/)
})

test('incoming deliveries wait while a model or effort command is being typed', () => {
  const deliver = server.slice(server.indexOf('function deliverInbound('))
  assert.match(deliver.slice(0, 900), /modelEffortControl\.whenIdle\(\)/)
})

test('the control reads the hook turn signal, the permission dialog and the proven session', () => {
  const at = server.indexOf('const modelEffortControl = new ModelEffortControl(')
  assert.ok(at > 0)
  const body = server.slice(at, at + 2500)
  assert.match(body, /turnState: \(\) =>\s*steerTurnState\(/)
  assert.match(body, /dialogOpen: \(\) => pendingPermissions\.size > 0/)
  assert.match(body, /sessionId: \(\) => provenSessionId\(\)/)
  assert.match(body, /optedIn: \(\) => readOptIn\(MODEL_CONTROL_DIR, String\(ASSISTANT_ID \?\? ''\)\)/)
})

test('server.ts still builds no send-keys argv of its own', () => {
  assert.equal([...server.matchAll(/'send-keys'/g)].length, 0)
  assert.equal([...server.matchAll(/'capture-pane'/g)].length, 0)
})
