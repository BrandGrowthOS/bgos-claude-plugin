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
import { MODEL_EFFORT_RPC_EVENT } from '../lib/model-effort-rpc.ts'

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

test('the heartbeat declares from the live answer, so a lost precondition withdraws the token', () => {
  // The heartbeat is the declaration the backend stores (replaced wholesale on
  // every beat). The canon fetch and the mission pause read do not ask about
  // this token, and no site may claim it unconditionally.
  const beat = server.slice(server.indexOf('capabilities: () => ['))
  assert.match(beat.slice(0, 400), /ownerModelEffort: modelEffortDeclared\(\)/)
  assert.doesNotMatch(server, /ownerModelEffort: true/)
  const declared = server.slice(server.indexOf('function modelEffortDeclared(): boolean'))
  const body = declared.slice(0, 1200)
  assert.match(body, /if \(compactTarget === null\) return false/)
  assert.match(body, /readOptIn\(MODEL_CONTROL_DIR/)
  assert.match(body, /MODEL_EFFORT_STALE_MS\) return false/)
})

test('the typed rail is answered by the lock holder only, and never during a drain', () => {
  // A literal frame name, the stand down counting guard's rule
  // (mission-ws-wiring.test.ts), and the same name lib/model-effort-rpc.ts exports.
  assert.equal(MODEL_EFFORT_RPC_EVENT, 'model_effort_rpc')
  const at = server.indexOf("realtimeSocket.on('model_effort_rpc', whenArmed('model_effort_rpc'")
  assert.ok(at > 0, 'registered through whenArmed')
  const body = server.slice(at, at + 800)
  assert.match(body, /if \(updateDrainMode\) return/)
  assert.match(body, /normalizeModelEffortRpc\(payload\)/)
  assert.match(body, /trackMessageOperation\(\(\) => modelEffortRpc\.handle\(frame\)\)/)
})

test('the control lock is part of every other injection\'s busy check', () => {
  assert.match(server, /injectionBusy: \(\): boolean => compactInFlight \|\| goalInjectionsInFlight > 0 \|\| modelEffortControl\.busy/)
  assert.match(server, /otherInjectionBusy: \(\): boolean => compactInFlight \|\| goalInjectionsInFlight > 0 \|\| steerGate\.busy/)
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
  const at = server.indexOf('const modelEffortControl: ModelEffortControl = new ModelEffortControl(')
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

test('the boot refreshes the bridge copy after the plugin root is known, and only through the store', () => {
  const root = server.indexOf('const PLUGIN_ROOT =')
  const refresh = server.indexOf('refreshBridgeCopy(MODEL_CONTROL_DIR, PLUGIN_ROOT)')
  assert.ok(root > 0 && refresh > root, 'after PLUGIN_ROOT, or it reads an uninitialised binding')
  assert.ok(server.indexOf('const MODEL_CONTROL_DIR') < refresh)
  assert.doesNotMatch(server, /installBridge\(|uninstallBridge\(|writeOptIn\(/, 'the daemon never turns the opt in on or edits settings')
})

test('L6: the daemon logs a received rpcId as its short hash, never raw', () => {
  const at = server.indexOf("realtimeSocket.on('model_effort_rpc', whenArmed('model_effort_rpc'")
  const body = server.slice(at, at + 800)
  assert.doesNotMatch(body, /\$\{frame\.rpcId\}/, 'the raw rpcId is the sender\'s text')
  assert.match(body, /model_effort_rpc received \(rpc=\$\{rpcLogTag\(frame\.rpcId\)\}\)/)
})
