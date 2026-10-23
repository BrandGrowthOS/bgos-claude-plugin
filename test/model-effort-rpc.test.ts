/**
 * Owner model and effort control (Route A): the wire around the transaction
 * (lib/model-effort-rpc.ts).
 *
 * The app's picker sends ONE typed frame, never a slash command or text:
 *
 *   model_effort_rpc { rpcId, op: 'describe' | 'set_model' | 'set_effort',
 *                      assistantId, chatId, chatKind, value,
 *                      sender: { userId, relationship }, isSharedRecipient,
 *                      shareOwnerUserId }
 *
 * and the daemon answers POST integrations/model-effort-rpc/:rpcId/result
 * with { ok: true, payload: { applied, report } } or
 * { ok: false, error: { code, message }, payload: { report } }, and reports
 * the model and effort it CONFIRMED through the existing session settings
 * rail, so the pill shows the truth.
 *
 * The owner rule is the daemon command rule (lib/daemon-command-sender.ts):
 * the sender must be provably the owner, in a main chat; a share recipient
 * and an unreadable sender are refused before the control is consulted.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  MODEL_EFFORT_RPC_EVENT,
  ModelEffortRpcHandler,
  SESSION_REPORT_EFFORT_PATTERN,
  SESSION_REPORT_MODEL_PATTERN,
  normalizeModelEffortRpc,
  sessionSettingsBody,
} from '../lib/model-effort-rpc.ts'
import type { ControlOutcome, ControlRequest } from '../lib/model-effort-control.ts'
import type { ModelEffortReport } from '../lib/model-effort-catalog.ts'

const OWNER = 'user_owner'
const REPORT: ModelEffortReport = {
  model: 'claude-sonnet-5-5',
  modelFamily: 'sonnet',
  modelDisplayName: 'Sonnet',
  effort: 'high',
  runtimeVersion: '2.1.309',
  availableModels: ['fable', 'opus', 'sonnet'],
  availableEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  ultracode: { available: false, reason: 'This host cannot confirm Ultra Code remotely.' },
  canChange: true,
  cannotChangeCode: null,
  cannotChangeReason: null,
  observedAt: '2026-10-24T00:00:00.000Z',
}

function frame(over: Record<string, unknown> = {}) {
  return {
    rpcId: 'rpc-1',
    op: 'set_model',
    assistantId: '42',
    chatId: 'chat-9',
    chatKind: 'main',
    value: 'sonnet',
    sender: { userId: OWNER, relationship: 'owner' },
    ...over,
  }
}

function rig(outcome: ControlOutcome = { ok: true, op: 'set_model', applied: true, report: REPORT }) {
  const calls: ControlRequest[] = []
  const results: Array<{ rpcId: string; body: unknown }> = []
  const reports: Array<{ chatId: string; body: unknown }> = []
  const logs: string[] = []
  let release: (() => void) | null = null
  let hold = false
  const handler = new ModelEffortRpcHandler({
    assistantId: () => '42',
    ownerUserId: () => OWNER,
    control: {
      handle: async (req) => {
        calls.push(req)
        if (hold) await new Promise<void>((r) => { release = r })
        return outcome
      },
    },
    postResult: async (rpcId, body) => { results.push({ rpcId, body }) },
    reportSettings: async (chatId, body) => { reports.push({ chatId, body }) },
    log: (m) => logs.push(m),
    now: () => Date.parse('2026-10-24T00:00:05.000Z'),
  })
  return {
    handler, calls, results, reports, logs,
    holdNext: () => { hold = true },
    releaseHeld: () => release?.(),
  }
}

test('the event name is the typed rail, not a slash command', () => {
  assert.equal(MODEL_EFFORT_RPC_EVENT, 'model_effort_rpc')
})

test('a frame without an rpcId cannot be answered and is dropped', () => {
  assert.equal(normalizeModelEffortRpc(frame({ rpcId: undefined })), null)
  assert.equal(normalizeModelEffortRpc(frame({ rpcId: '' })), null)
  assert.equal(normalizeModelEffortRpc(null), null)
  assert.equal(normalizeModelEffortRpc('set_model sonnet'), null)
})

test('the owner\'s set_model reaches the control, is answered, and is reported on the rail', async () => {
  const r = rig()
  await r.handler.handle(normalizeModelEffortRpc(frame())!)
  assert.deepEqual(r.calls, [{ op: 'set_model', value: 'sonnet' }])
  assert.deepEqual(r.results, [{ rpcId: 'rpc-1', body: { ok: true, payload: { applied: true, report: REPORT } } }])
  assert.deepEqual(r.reports, [{
    chatId: 'chat-9',
    body: { model: 'claude-sonnet-5-5', effort: 'high', serviceTier: null, rerouted: false, reportedAt: '2026-10-24T00:00:05.000Z' },
  }])
})

test('a share recipient is refused before the control is consulted', async () => {
  for (const sender of [
    { sender: { userId: 'user_friend', relationship: 'shared_recipient' }, isSharedRecipient: true, shareOwnerUserId: OWNER },
    { sender: { userId: OWNER, relationship: 'shared_recipient' } },
    { sender: { userId: OWNER }, isSharedRecipient: true },
    { sender: undefined },
    { sender: { userId: '' } },
    { sender: { userId: OWNER }, sender_user_id: 'someone_else' },
  ]) {
    const r = rig()
    await r.handler.handle(normalizeModelEffortRpc(frame(sender))!)
    assert.equal(r.calls.length, 0, JSON.stringify(sender))
    assert.equal(r.reports.length, 0)
    const body = r.results[0]!.body as { ok: boolean; error: { code: string } }
    assert.equal(body.ok, false)
    assert.equal(body.error.code, 'not_owner')
  }
})

test('a side chat, a group or a room is refused; an absent kind is a main chat', async () => {
  for (const chatKind of ['side', 'group', 'room', 'channel']) {
    const r = rig()
    await r.handler.handle(normalizeModelEffortRpc(frame({ chatKind }))!)
    assert.equal(r.calls.length, 0, chatKind)
    assert.equal((r.results[0]!.body as { error: { code: string } }).error.code, 'not_main_chat')
  }
  const r = rig()
  await r.handler.handle(normalizeModelEffortRpc(frame({ chatKind: undefined }))!)
  assert.equal(r.calls.length, 1)
})

test('a frame for another agent gets nothing at all', async () => {
  const r = rig()
  await r.handler.handle(normalizeModelEffortRpc(frame({ assistantId: '43' }))!)
  assert.equal(r.calls.length, 0)
  assert.equal(r.results.length, 0)
})

test('a refusal is answered with its code, its sentence and the true report', async () => {
  const r = rig({ ok: false, op: 'set_model', code: 'composer_not_empty', message: 'The agent has a draft.', report: REPORT })
  await r.handler.handle(normalizeModelEffortRpc(frame())!)
  assert.deepEqual(r.results[0]!.body, {
    ok: false,
    error: { code: 'composer_not_empty', message: 'The agent has a draft.' },
    payload: { report: REPORT },
  })
  assert.equal(r.reports.length, 1, 'the pill is refreshed with what really runs')
})

test('a re sent frame never types twice: a running id is ignored, an answered one is answered again', async () => {
  const r = rig()
  r.holdNext()
  const first = r.handler.handle(normalizeModelEffortRpc(frame())!)
  await r.handler.handle(normalizeModelEffortRpc(frame())!)
  assert.equal(r.calls.length, 1)
  assert.equal(r.results.length, 0, 'still running')
  r.releaseHeld()
  await first
  await r.handler.handle(normalizeModelEffortRpc(frame())!)
  assert.equal(r.calls.length, 1)
  assert.equal(r.results.length, 2)
  assert.deepEqual(r.results[0], r.results[1])
})

test('a control that throws is answered, never left to time out', async () => {
  const r = rig()
  const handler = new ModelEffortRpcHandler({
    assistantId: () => '42',
    ownerUserId: () => OWNER,
    control: { handle: async () => { throw new Error('boom') } },
    postResult: async (rpcId, body) => { r.results.push({ rpcId, body }) },
    reportSettings: async () => {},
    log: () => {},
    now: () => 0,
  })
  await handler.handle(normalizeModelEffortRpc(frame())!)
  assert.equal((r.results[0]!.body as { error: { code: string } }).error.code, 'control_failed')
})

test('the session settings body follows the BGOS route\'s own patterns, and an id they refuse is not sent', () => {
  assert.equal(SESSION_REPORT_MODEL_PATTERN.source, '^[\\w./:-]{1,160}$')
  assert.equal(SESSION_REPORT_EFFORT_PATTERN.source, '^[a-z]{1,20}$')
  assert.deepEqual(sessionSettingsBody(REPORT, 0), {
    model: 'claude-sonnet-5-5', effort: 'high', serviceTier: null, rerouted: false, reportedAt: '1970-01-01T00:00:00.000Z',
  })
  assert.equal(sessionSettingsBody({ ...REPORT, model: 'claude-opus-5-5[1m]' }, 0), null)
  assert.equal(sessionSettingsBody({ ...REPORT, effort: null }, 0)!.effort, null)
  assert.equal(sessionSettingsBody(null, 0), null)
})
