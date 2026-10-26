/**
 * The owner's model and effort picker on the BGOS wire (lib/model-effort-rpc.ts).
 *
 * BGOS main (#3060) asks over voice_rpc, never a slash command or text:
 *
 *   list_model_effort  payload {}
 *     -> { ok: true, payload: <catalog readModelEffortCatalog accepts> }
 *   apply_model_effort payload { sessionId, model, effort }
 *     -> { ok: true, payload: { current: { model, effort }, sessionId } }
 *   a refusal -> { ok: false, error: { code, message } } with code busy,
 *     not_allowed or failed (the app maps busy and not_allowed; BGOS turns
 *     anything else into switch_failed)
 *
 * The frame carries no sender: BGOS's gate (assistant-sessions.service.ts
 * gate, steps 1 to 3) admits only the signed in owner in this agent's own
 * main chat. The daemon checks again from what it knows: the chat must be one
 * of this agent's main chats and never one known to be a share recipient's.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  APPLY_BUDGET_MS,
  ModelEffortPickerHandler,
  SESSION_REPORT_EFFORT_PATTERN,
  SESSION_REPORT_MODEL_PATTERN,
  pickerChatAllowed,
  sessionSettingsBody,
  type PickerSnapshot,
} from '../lib/model-effort-rpc.ts'
import type { ControlOutcome } from '../lib/model-effort-control.ts'
import { readModelEffortCatalog, type ModelEffortReport } from '../lib/model-effort-catalog.ts'

const SID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const NOW = Date.parse('2026-10-26T00:00:05.000Z')
const REPORT: ModelEffortReport = {
  model: 'claude-sonnet-5-5',
  modelFamily: 'sonnet',
  modelDisplayName: 'Sonnet',
  effort: 'xhigh',
  runtimeVersion: '2.1.310',
  availableModels: ['fable', 'opus', 'sonnet'],
  availableEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  ultracode: { available: false, reason: 'This host cannot confirm Ultra Code remotely.' },
  canChange: true,
  cannotChangeCode: null,
  cannotChangeReason: null,
  observedAt: '2026-10-26T00:00:04.000Z',
}
const SNAPSHOT: PickerSnapshot = {
  optedIn: true,
  sessionId: SID,
  observation: { sessionId: SID, modelId: 'claude-opus-5-5', modelDisplayName: 'Opus', effort: 'high', version: '2.1.310', seq: 3, observedAtMs: NOW - 1000 },
  catalog: { models: ['fable', 'opus', 'sonnet'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
}

function rig(over: { outcome?: ControlOutcome; snapshot?: PickerSnapshot; chatAllowed?: boolean } = {}) {
  const applies: Array<{ selection: unknown; deadlineAtMs: number }> = []
  const reports: Array<{ chatId: string; body: unknown }> = []
  const notes: Array<{ chatId: string; text: string }> = []
  const logs: string[] = []
  const handler = new ModelEffortPickerHandler({
    assistantId: () => '42',
    chatAllowed: () => over.chatAllowed ?? true,
    control: {
      snapshot: async () => over.snapshot ?? SNAPSHOT,
      apply: async (selection, opts) => {
        applies.push({ selection, deadlineAtMs: opts.deadlineAtMs })
        return over.outcome ?? { ok: true, op: 'apply', applied: true, report: REPORT }
      },
    },
    reportSettings: async (chatId, body) => { reports.push({ chatId, body }) },
    sendNote: async (chatId, text) => { notes.push({ chatId, text }) },
    log: (m) => logs.push(m),
    now: () => NOW,
  })
  return { handler, applies, reports, notes, logs }
}

const APPLY = { op: 'apply_model_effort', assistantId: '42', chatId: '9', payload: { sessionId: SID, model: 'sonnet', effort: 'xhigh' } }
const LIST = { op: 'list_model_effort', assistantId: '42', chatId: '9', payload: {} }

test('list answers a catalog BGOS\'s reader accepts, for the proven session', async () => {
  const r = rig()
  const out = await r.handler.answer(LIST)
  assert.equal(out.ok, true, JSON.stringify(out))
  if (!out.ok) return
  const read = readModelEffortCatalog(out.payload)
  assert.ok(read, 'readModelEffortCatalog accepts it')
  assert.equal(read.sessionId, SID)
  assert.deepEqual(read.current, { model: 'opus', effort: 'high' })
  assert.equal(r.applies.length, 0, 'a list types nothing')
})

test('list while not opted in, or with nothing to report, is refused, never an empty catalog', async () => {
  const off = await rig({ snapshot: { ...SNAPSHOT, optedIn: false } }).handler.answer(LIST)
  assert.deepEqual(off.ok ? null : off.code, 'not_allowed')
  const none = await rig({ snapshot: { ...SNAPSHOT, observation: null } }).handler.answer(LIST)
  assert.deepEqual(none.ok ? null : none.code, 'failed')
  const noSession = await rig({ snapshot: { ...SNAPSHOT, sessionId: null } }).handler.answer(LIST)
  assert.deepEqual(noSession.ok ? null : noSession.code, 'failed')
})

test('apply hands the control exactly the selection, under a deadline inside BGOS\'s 20 s', async () => {
  const r = rig()
  const out = await r.handler.answer(APPLY)
  assert.deepEqual(r.applies, [{ selection: { sessionId: SID, model: 'sonnet', effort: 'xhigh' }, deadlineAtMs: NOW + APPLY_BUDGET_MS }])
  assert.ok(APPLY_BUDGET_MS <= 17_000, 'BGOS waits 20 000 ms (assistant-sessions.service.ts:134); the answer must beat it')
  assert.deepEqual(out, { ok: true, payload: { current: { model: 'sonnet', effort: 'xhigh' }, sessionId: SID } })
})

test('apply answers what the session REPORTS, never the selection echoed', async () => {
  // The control said ok but its report does not hold the selection: never claimed.
  const r = rig({ outcome: { ok: true, op: 'apply', applied: true, report: { ...REPORT, effort: 'high' } } })
  const out = await r.handler.answer(APPLY)
  assert.equal(out.ok, false)
  if (!out.ok) assert.equal(out.code, 'failed')
  assert.equal(r.notes.length, 0, 'no switched note for an unconfirmed switch')
})

test('a confirmed switch is reported on the session settings rail and noted in the chat', async () => {
  const r = rig()
  await r.handler.answer(APPLY)
  assert.deepEqual(r.reports, [{
    chatId: '9',
    body: { model: 'claude-sonnet-5-5', effort: 'xhigh', serviceTier: null, rerouted: false, reportedAt: '2026-10-26T00:00:05.000Z' },
  }])
  assert.deepEqual(r.notes, [{ chatId: '9', text: 'Switched to Sonnet, effort Extra high.' }])
})

test('a selection that was already running is answered without a note', async () => {
  const r = rig({ outcome: { ok: true, op: 'apply', applied: false, report: REPORT } })
  const out = await r.handler.answer(APPLY)
  assert.equal(out.ok, true)
  assert.equal(r.notes.length, 0)
})

test('a refusal is answered with the app\'s code and refreshes the pill with what really runs', async () => {
  const r = rig({ outcome: { ok: false, op: 'apply', code: 'busy_turn', message: 'The agent is working on a turn. Try again when it is idle.', report: REPORT } })
  const out = await r.handler.answer(APPLY)
  assert.deepEqual(out, { ok: false, code: 'busy', message: 'The agent is working on a turn. Try again when it is idle.' })
  assert.equal(r.reports.length, 1)
  assert.equal(r.notes.length, 0)
})

test('owner only, main chat only: a chat the daemon cannot place as the owner\'s main chat is refused first', async () => {
  const r = rig({ chatAllowed: false })
  for (const frame of [APPLY, LIST]) {
    const out = await r.handler.answer(frame)
    assert.equal(out.ok, false)
    if (!out.ok) assert.equal(out.code, 'not_allowed')
  }
  assert.equal(r.applies.length, 0)
  assert.equal(r.reports.length, 0)
})

test('pickerChatAllowed: one of this agent\'s main chats, never a recipient\'s, proven on a shared agent', () => {
  const owners = new Set(['9'])
  const others = new Set(['11'])
  const verdict = (chatId: string, mains: string[]) =>
    pickerChatAllowed({ chatId, mainChatIds: mains, isOwners: (c) => owners.has(c), isOthers: (c) => others.has(c) })
  assert.equal(verdict('9', ['9']), true, 'the only main chat')
  assert.equal(verdict('10', ['10']), true, 'an only main chat nobody spoke in yet')
  assert.equal(verdict('12', ['9']), false, 'not a main chat of this agent (a room, a group, another agent\'s)')
  assert.equal(verdict('11', ['11']), false, 'a share recipient\'s chat, even when it is the only one listed')
  assert.equal(verdict('9', ['9', '11']), true, 'shared agent: the chat proven the owner\'s')
  assert.equal(verdict('10', ['10', '11']), false, 'shared agent: a main chat not proven the owner\'s')
  assert.equal(verdict('', ['9']), false)
})

test('a malformed selection is refused without reaching the control', async () => {
  for (const payload of [
    {},
    { sessionId: SID, model: 'sonnet' },
    { sessionId: SID, model: 'sonnet', effort: 7 },
    { sessionId: '', model: 'sonnet', effort: 'high' },
    { sessionId: SID, model: ['sonnet'], effort: 'high' },
    { sessionId: 'x'.repeat(201), model: 'sonnet', effort: 'high' },
  ]) {
    const r = rig()
    const out = await r.handler.answer({ ...APPLY, payload })
    assert.equal(out.ok, false, JSON.stringify(payload))
    if (!out.ok) assert.equal(out.code, 'not_allowed')
    assert.equal(r.applies.length, 0)
  }
})

test('a frame for another agent is not this daemon\'s to answer', () => {
  const r = rig()
  assert.equal(r.handler.mine({ ...APPLY, assistantId: '42' }), true)
  assert.equal(r.handler.mine({ ...APPLY, assistantId: 42 }), true)
  assert.equal(r.handler.mine({ ...APPLY, assistantId: '43' }), false)
  assert.equal(r.handler.mine({ ...APPLY, assistantId: '' }), false)
})

test('a control that throws is answered failed, never left to time out', async () => {
  const handler = new ModelEffortPickerHandler({
    assistantId: () => '42',
    chatAllowed: () => true,
    control: { snapshot: async () => { throw new Error('boom') }, apply: async () => { throw new Error('boom') } },
    reportSettings: async () => {},
    sendNote: async () => {},
    log: () => {},
    now: () => NOW,
  })
  for (const frame of [LIST, APPLY]) {
    const out = await handler.answer(frame)
    assert.equal(out.ok, false)
    if (!out.ok) assert.equal(out.code, 'failed')
  }
})

test('the session settings body follows the BGOS route\'s own patterns, and an id they refuse is not sent', () => {
  assert.equal(SESSION_REPORT_MODEL_PATTERN.source, '^[\\w./:-]{1,160}$')
  assert.equal(SESSION_REPORT_EFFORT_PATTERN.source, '^[a-z]{1,20}$')
  assert.deepEqual(sessionSettingsBody(REPORT, 0), {
    model: 'claude-sonnet-5-5', effort: 'xhigh', serviceTier: null, rerouted: false, reportedAt: '1970-01-01T00:00:00.000Z',
  })
  assert.equal(sessionSettingsBody({ ...REPORT, model: 'claude-opus-5-5[1m]' }, 0), null)
  assert.equal(sessionSettingsBody({ ...REPORT, effort: null }, 0)!.effort, null)
  assert.equal(sessionSettingsBody(null, 0), null)
})
