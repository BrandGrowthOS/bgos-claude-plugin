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

import { MODEL_EFFORT_PICKER_TOKEN, declaredCapabilities } from '../lib/declared-capabilities.ts'
import { rpcLogOp, rpcLogTag } from '../lib/model-effort-rpc.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const server = readFileSync(join(ROOT, 'server.ts'), 'utf8')

test('model_effort_picker is declared only on a pairing, only when the daemon can control, and never on Windows', () => {
  assert.equal(MODEL_EFFORT_PICKER_TOKEN, 'model_effort_picker')
  const base = { canInjectGoal: true, floorHook: true, authMode: 'pairing' as const, platform: 'darwin' as const }
  assert.ok(declaredCapabilities({ ...base, modelEffortPicker: true }).includes(MODEL_EFFORT_PICKER_TOKEN))
  assert.ok(declaredCapabilities({ ...base, platform: 'linux', modelEffortPicker: true }).includes(MODEL_EFFORT_PICKER_TOKEN))
  assert.ok(!declaredCapabilities({ ...base, modelEffortPicker: false }).includes(MODEL_EFFORT_PICKER_TOKEN))
  assert.ok(!declaredCapabilities(base).includes(MODEL_EFFORT_PICKER_TOKEN), 'absent means not declared')
  assert.ok(!declaredCapabilities({ ...base, authMode: 'apikey', modelEffortPicker: true }).includes(MODEL_EFFORT_PICKER_TOKEN))
  assert.ok(!declaredCapabilities({ ...base, platform: 'win32', modelEffortPicker: true }).includes(MODEL_EFFORT_PICKER_TOKEN), 'a Windows host cannot prove or type into a tmux pane')
  for (const old of ['owner_model_effort_control', 'session_model_control']) {
    assert.ok(!declaredCapabilities({ ...base, modelEffortPicker: true }).includes(old), old)
  }
})

test('the heartbeat declares from the live answer, so a lost precondition withdraws the token', () => {
  // The heartbeat is the declaration the backend stores (replaced wholesale on
  // every beat). No site may claim the token unconditionally.
  const beat = server.slice(server.indexOf('capabilities: () => ['))
  assert.match(beat.slice(0, 400), /modelEffortPicker: modelEffortDeclared\(\)/)
  assert.doesNotMatch(server, /modelEffortPicker: true/)
  const declared = server.slice(server.indexOf('function modelEffortDeclared(): boolean'))
  const body = declared.slice(0, 1200)
  assert.match(body, /if \(compactTarget === null\) return false/)
  assert.match(body, /readOptIn\(MODEL_CONTROL_DIR/)
  assert.match(body, /MODEL_EFFORT_STALE_MS\) return false/)
})

test('the picker rides voice_rpc: the old model_effort_rpc wire and its ops are gone', () => {
  assert.doesNotMatch(server, /model_effort_rpc|owner_model_effort_control|ownerModelEffort/)
  assert.doesNotMatch(server, /integrations\/model-effort-rpc/)
  const at = server.indexOf('const voiceRpc = new VoiceRpcHandler(')
  assert.ok(at > 0)
  const deps = server.slice(at, server.indexOf('\n})\n', at))
  assert.match(deps, /modelEffort: modelEffortPicker,/)
})

test('the picker answers only the owner\'s main chat, from the daemon\'s own chat records', () => {
  const at = server.indexOf('const modelEffortPicker = new ModelEffortPickerHandler(')
  assert.ok(at > 0)
  const body = server.slice(at, at + 1500)
  assert.match(body, /chatAllowed: \(chatId\) =>\s*pickerChatAllowed\(\{ chatId, mainChatIds, isOwners: \(c\) => chatOwnership\.isOwners\(c\), isOthers: \(c\) => chatOwnership\.isOthers\(c\) \}\)/)
  assert.match(body, /control: modelEffortControl,/)
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

// Round 2 on PR #275, Low 2: the other handlers (voice, memory and its person
// lanes, changes, skills, export pack and its manifest, update, watcher
// install) logged the rpcId raw, the sender's text, so a newline in it forged
// daemon log lines exactly as L6 found for model_effort_rpc. The handoff id
// of an export pack and the op of a frame whose op is not checked before it
// is logged are the sender's text too.
test('L2: no daemon log line carries a raw rpcId, handoff id or op; ids are hashed like L6', () => {
  const ids = [...server.matchAll(/\$\{([^{}]*\b(?:rpcId|handoffId)\b[^{}]*)\}/g)].map((m) => m[1]!.trim())
  assert.ok(ids.length > 10, 'the scan sees the interpolations')
  for (const expr of ids) {
    assert.match(expr, /^(?:encodeURIComponent|rpcLogTag)\(/, `raw in a log line: \${${expr}}`)
  }
  const ops = [...server.matchAll(/\$\{([^{}]*\b(?:frame|laneFrame)\.op\b[^{}]*)\}/g)].map((m) => m[1]!.trim())
  assert.ok(ops.length >= 7, 'the scan sees the received lines')
  for (const expr of ops) assert.match(expr, /^rpcLogOp\(/, `raw op in a log line: \${${expr}}`)
  for (const event of ['voice_rpc', 'memory_rpc', 'changes_rpc', 'skills_rpc', 'doctor_rpc', 'export_pack', 'export_pack_manifest', 'update_rpc', 'watcher_install_rpc']) {
    assert.match(server, new RegExp(`${event} received \\([^\\n]*rpc=\\$\\{rpcLogTag\\(frame\\.rpcId\\)\\}`), event)
  }
})

test('L2: rpcLogOp keeps a plain op word and never a forged line', () => {
  assert.equal(rpcLogOp('list'), 'list')
  assert.equal(rpcLogOp('install_bundle'), 'install_bundle')
  for (const bad of ['list\n[2026-10-24T00:00:00Z] forged', '', 'x'.repeat(65), 'a b', 'op\u001b[2J', null, undefined, 7, { op: 'list' }]) {
    const out = rpcLogOp(bad)
    assert.doesNotMatch(out, /[\s\u0000-\u001f\u007f]/u, JSON.stringify(bad))
    assert.notEqual(out, bad)
  }
  assert.equal(rpcLogTag('rpc-7\nforged').length, 12)
})
